export const TIP_SOURCE_KINDS = Object.freeze({ live: 0, radio: 1, archive: 2 });
export const TIP_ABI = Object.freeze([
  'function tip(address recipient,uint8 sourceKind,string contextRef) payable',
  'event TipSent(address indexed sender,address indexed recipient,bytes32 indexed contextId,uint8 sourceKind,uint256 amount,string contextRef)',
]);
export const TIP_SPLIT_ABI = Object.freeze([
  ...TIP_ABI,
  'function tipSplit(address[] recipients,uint16[] sharesBps,uint8 sourceKind,string contextRef) payable',
]);
export const TIP_ASSET_ABI = Object.freeze([
  ...TIP_SPLIT_ABI,
  'function allowedTokens(address token) view returns (bool)',
  'function tipToken(address token,address recipient,uint256 amount,uint8 sourceKind,string contextRef)',
  'function tipTokenSplit(address token,address[] recipients,uint16[] sharesBps,uint256 amount,uint8 sourceKind,string contextRef)',
  'function giftNfts((address collection,uint8 standard,uint256 tokenId,uint256 amount,address recipient)[] gifts,uint8 sourceKind,string contextRef)',
  'event TokenTipSent(address indexed sender,address indexed recipient,bytes32 indexed contextId,address token,uint8 sourceKind,uint256 amount,string contextRef)',
  'event NftGiftSent(address indexed sender,address indexed recipient,bytes32 indexed contextId,address collection,uint8 standard,uint256 tokenId,uint256 amount,uint8 sourceKind,string contextRef)',
]);
export const NFT_STANDARDS = Object.freeze({ erc721: 0, erc1155: 1 });
export const MAX_NFT_GIFTS = 32;
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

function eventContext(sourceKind, contextRef) {
  try { return { context: parseTipContext({ sourceKind, contextRef }), contextError: '' }; }
  catch (error) { return { context: null, contextError: error.message }; }
}

// Decodes v0.2 TokenTipSent (kind 'token') and NftGiftSent (kind 'nft') events from one router.
export function decodeAssetTipReceipt({ receipt, routerAddress, ethers }) {
  if (!ADDRESS.test(routerAddress || '') || /^0x0{40}$/i.test(routerAddress)) throw new Error('Invalid tip contract');
  if (receipt?.status !== 1 || !Array.isArray(receipt.logs)) throw new Error('Tip transaction is not confirmed successfully');
  const txHash = receipt.hash || receipt.transactionHash;
  if (!HASH.test(txHash || '')) throw new Error('Tip transaction hash is unavailable');
  const iface = new ethers.Interface(TIP_ASSET_ABI);
  const topics = { [iface.getEvent('TokenTipSent').topicHash.toLowerCase()]: 'token', [iface.getEvent('NftGiftSent').topicHash.toLowerCase()]: 'nft' };
  return receipt.logs.filter(log => log.address?.toLowerCase() === routerAddress.toLowerCase() && topics[log.topics?.[0]?.toLowerCase()])
    .map(log => {
      const kind = topics[log.topics[0].toLowerCase()];
      const args = iface.parseLog(log).args;
      const logIndex = log.index ?? log.logIndex;
      if (!Number.isSafeInteger(logIndex) || logIndex < 0 || args.amount <= 0n ||
          args.contextId !== ethers.id(args.contextRef)) throw new Error('Invalid on-chain tip event');
      const sourceKind = Number(args.sourceKind);
      const base = {
        kind, txHash, logIndex, routerAddress: routerAddress.toLowerCase(),
        sender: args.sender.toLowerCase(), recipient: args.recipient.toLowerCase(), sourceKind,
        contextId: args.contextId, contextRef: args.contextRef, ...eventContext(sourceKind, args.contextRef),
      };
      if (kind === 'token') return { ...base, token: args.token.toLowerCase(), amountUnits: args.amount.toString() };
      const standard = Number(args.standard);
      if (standard !== NFT_STANDARDS.erc721 && standard !== NFT_STANDARDS.erc1155) throw new Error('Invalid on-chain NFT gift event');
      return { ...base, collection: args.collection.toLowerCase(), standard, tokenId: args.tokenId.toString(), amount: args.amount.toString() };
    });
}

// `intent.splits` (shared song) or `intent.recipient` (one owner); `intent.amountUnits` in token base units.
export function verifyTokenTipReceipt({ receipt, routerAddress, intent, ethers }) {
  const context = createTipContext(intent);
  const parts = intent.splits
    ? splitTipAmounts(intent.amountUnits, intent.splits).map((amount, index) => ({ recipient: intent.splits[index].recipient, amount }))
    : [{ recipient: intent.recipient, amount: BigInt(intent.amountUnits) }];
  const events = decodeAssetTipReceipt({ receipt, routerAddress, ethers }).filter(event => event.kind === 'token' &&
    event.sender === intent.payer.toLowerCase() && event.token === intent.token.toLowerCase() &&
    event.sourceKind === context.sourceKind && event.contextRef === context.contextRef);
  if (events.length !== parts.length) throw new Error('The token tip receipt does not match every song owner');
  return parts.map(part => {
    const matches = events.filter(event => event.recipient === part.recipient.toLowerCase() && event.amountUnits === part.amount.toString());
    if (matches.length !== 1) throw new Error('The token tip receipt does not match every song owner');
    return matches[0];
  });
}

const giftKey = gift => [gift.recipient, gift.collection, gift.standard, gift.tokenId, gift.amount].map(v => String(v).toLowerCase()).join('|');

// Validates a gift batch against the song's owners. Returns contract-ready gifts.
export function normalizeNftGifts(gifts, owners) {
  const allowed = new Set((owners || []).map(owner => String(owner).toLowerCase()));
  if (!Array.isArray(gifts) || !gifts.length || gifts.length > MAX_NFT_GIFTS) throw new Error(`Choose 1 to ${MAX_NFT_GIFTS} NFT gifts`);
  const seen721 = new Set();
  return Object.freeze(gifts.map(gift => {
    const collection = String(gift?.collection || '');
    const standard = Number(gift?.standard);
    let tokenId, amount;
    try { tokenId = BigInt(gift.tokenId); amount = BigInt(gift.amount); } catch { throw new Error('Enter a whole-number token ID and amount'); }
    if (!ADDRESS.test(collection) || /^0x0{40}$/i.test(collection)) throw new Error('Enter a valid NFT collection address');
    if (standard !== NFT_STANDARDS.erc721 && standard !== NFT_STANDARDS.erc1155) throw new Error('Unsupported NFT standard');
    if (tokenId < 0n || tokenId > UINT256_MAX || amount <= 0n || amount > UINT256_MAX) throw new Error('Enter a valid token ID and amount');
    if (standard === NFT_STANDARDS.erc721) {
      if (amount !== 1n) throw new Error('An ERC-721 NFT can only be gifted once');
      const key = `${collection.toLowerCase()}:${tokenId}`;
      if (seen721.has(key)) throw new Error('The same ERC-721 NFT cannot be gifted twice');
      seen721.add(key);
    }
    if (!allowed.has(String(gift.recipient || '').toLowerCase())) throw new Error('Each NFT must go to one of this song\'s owners');
    return Object.freeze({ collection, standard, tokenId: tokenId.toString(), amount: amount.toString(), recipient: String(gift.recipient) });
  }));
}

export function verifyNftGiftReceipt({ receipt, routerAddress, intent, ethers }) {
  const context = createTipContext(intent);
  const events = decodeAssetTipReceipt({ receipt, routerAddress, ethers }).filter(event => event.kind === 'nft' &&
    event.sender === intent.payer.toLowerCase() && event.sourceKind === context.sourceKind && event.contextRef === context.contextRef);
  const expected = intent.gifts.map(giftKey).sort();
  const actual = events.map(giftKey).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new Error('The NFT gift receipt does not match the gifts you sent');
  }
  return events;
}
