export const TIP_SOURCE_KINDS = Object.freeze({ live: 0, radio: 1, archive: 2 });
export const TIP_ABI = Object.freeze([
  'function tip(address recipient,uint8 sourceKind,string contextRef) payable',
  'event TipSent(address indexed sender,address indexed recipient,bytes32 indexed contextId,uint8 sourceKind,uint256 amount,string contextRef)',
]);
export const TIP_SPLIT_ABI = Object.freeze([
  ...TIP_ABI,
  'function tipSplit(address[] recipients,uint16[] sharesBps,uint8 sourceKind,string contextRef) payable',
]);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const UINT256_MAX = (1n << 256n) - 1n;

export function createTipContext({ source, bookingId, nftId }) {
  if (!Object.hasOwn(TIP_SOURCE_KINDS, source)) throw new Error('Unsupported tip source');
  let reference;
  if (source === 'live') {
    if (typeof bookingId !== 'string' || !/^[a-zA-Z0-9:_-]{1,200}$/.test(bookingId)) {
      throw new Error('A verified live booking is required for tip attribution');
    }
    reference = bookingId;
  } else {
    const match = typeof nftId === 'string' && nftId.match(/^([1-9][0-9]*):(0x[0-9a-fA-F]{40}):(0|[1-9][0-9]*)$/);
    if (!match || /^0x0{40}$/i.test(match[2]) || match[1].length > 78 || match[3].length > 78 ||
        BigInt(match[1]) > UINT256_MAX || BigInt(match[3]) > UINT256_MAX) {
      throw new Error('A verified recording NFT identity is required for tip attribution');
    }
    reference = `${match[1]}:${match[2].toLowerCase()}:${match[3]}`;
  }
  const contextRef = `decentbusking:${source}:${reference}`;
  if (contextRef.length > 256) throw new Error('Tip context is too long');
  return Object.freeze({ sourceKind: TIP_SOURCE_KINDS[source], contextRef });
}

export function parseTipContext({ sourceKind, contextRef }) {
  const source = Object.keys(TIP_SOURCE_KINDS).find(key => TIP_SOURCE_KINDS[key] === sourceKind);
  if (!source || typeof contextRef !== 'string' || contextRef.length > 256 ||
      !contextRef.startsWith(`decentbusking:${source}:`)) throw new Error('Tip source context is not recognized');
  const reference = contextRef.slice(`decentbusking:${source}:`.length);
  const context = source === 'live' ? { source, bookingId: reference } : { source, nftId: reference };
  if (createTipContext(context).contextRef !== contextRef) throw new Error('Tip source context is not canonical');
  return Object.freeze(context);
}

export function decodeTipReceipt({ receipt, routerAddress, ethers }) {
  if (!ADDRESS.test(routerAddress || '') || /^0x0{40}$/i.test(routerAddress)) throw new Error('Invalid tip contract');
  if (receipt?.status !== 1 || !Array.isArray(receipt.logs)) throw new Error('Tip transaction is not confirmed successfully');
  const txHash = receipt.hash || receipt.transactionHash;
  if (!HASH.test(txHash || '')) throw new Error('Tip transaction hash is unavailable');
  const iface = new ethers.Interface(TIP_ABI);
  const topic = iface.getEvent('TipSent').topicHash.toLowerCase();
  return receipt.logs.filter(log => log.address?.toLowerCase() === routerAddress.toLowerCase() &&
    log.topics?.[0]?.toLowerCase() === topic).map(log => {
    const event = iface.parseLog(log), args = event.args;
    const logIndex = log.index ?? log.logIndex;
    if (!Number.isSafeInteger(logIndex) || logIndex < 0 || args.amount <= 0n ||
        args.contextId !== ethers.id(args.contextRef)) throw new Error('Invalid on-chain tip event');
    const sourceKind = Number(args.sourceKind);
    let context = null, contextError = '';
    try { context = parseTipContext({ sourceKind, contextRef: args.contextRef }); }
    catch (error) { contextError = error.message; }
    return {
      txHash, logIndex, routerAddress: routerAddress.toLowerCase(),
      sender: args.sender.toLowerCase(), recipient: args.recipient.toLowerCase(),
      amountWei: args.amount.toString(), sourceKind, contextId: args.contextId,
      contextRef: args.contextRef, context, contextError,
    };
  });
}

export function verifyAttributedTipReceipt({ receipt, routerAddress, intent, ethers }) {
  const context = createTipContext(intent);
  const matches = decodeTipReceipt({ receipt, routerAddress, ethers }).filter(event =>
    event.sender === intent.payer.toLowerCase() && event.recipient === intent.recipient.toLowerCase() &&
    event.amountWei === String(intent.amountWei) && event.sourceKind === context.sourceKind &&
    event.contextRef === context.contextRef);
  if (matches.length !== 1) throw new Error('No single exact DecentBusking tip event matches this payment');
  return matches[0];
}

export function normalizeTipSplit(recipients, sharesBps) {
  if (!Array.isArray(recipients) || !Array.isArray(sharesBps) || recipients.length < 2 ||
      recipients.length > 16 || recipients.length !== sharesBps.length) throw new Error('This song split cannot receive a shared tip');
  const seen = new Set();
  let total = 0;
  const parts = recipients.map((recipient, index) => {
    const wallet = String(recipient || '');
    const shareBps = Number(sharesBps[index]);
    if (!ADDRESS.test(wallet) || /^0x0{40}$/i.test(wallet) || seen.has(wallet.toLowerCase()) ||
        !Number.isSafeInteger(shareBps) || shareBps <= 0 || shareBps > 10000) throw new Error('This song split cannot receive a shared tip');
    seen.add(wallet.toLowerCase());
    total += shareBps;
    return Object.freeze({ recipient: wallet, shareBps });
  });
  if (total !== 10000) throw new Error('This song split cannot receive a shared tip');
  return Object.freeze(parts);
}

// Mirrors DecentBuskingTipRouter v0.2: each part rounds down and the last payee receives the remainder.
export function splitTipAmounts(amountWei, splits) {
  const total = BigInt(amountWei);
  let remaining = total;
  return splits.map((part, index) => {
    const amount = index === splits.length - 1 ? remaining : total * BigInt(part.shareBps) / 10000n;
    if (amount <= 0n) throw new Error('Tip is too small to split between every owner');
    remaining -= amount;
    return amount;
  });
}

export function verifySplitTipReceipt({ receipt, routerAddress, intent, ethers }) {
  const context = createTipContext(intent);
  const amounts = splitTipAmounts(intent.amountWei, intent.splits);
  const events = decodeTipReceipt({ receipt, routerAddress, ethers }).filter(event =>
    event.sender === intent.payer.toLowerCase() && event.sourceKind === context.sourceKind &&
    event.contextRef === context.contextRef);
  if (events.length !== intent.splits.length) throw new Error('The shared tip receipt does not match every song owner');
  return intent.splits.map((part, index) => {
    const matches = events.filter(event => event.recipient === part.recipient.toLowerCase() &&
      event.amountWei === amounts[index].toString());
    if (matches.length !== 1) throw new Error('The shared tip receipt does not match every song owner');
    return matches[0];
  });
}
