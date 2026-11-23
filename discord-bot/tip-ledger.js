import * as ethers from 'ethers';
import { TIP_ASSET_ABI, TIP_SOURCE_KINDS, createTipContext, decodeAssetTipReceipt, decodeTipReceipt } from '../js/tip-protocol.mjs';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const iface = new ethers.Interface(TIP_ASSET_ABI);
const UNITS = /^[1-9][0-9]{0,77}$/;
const TOKEN_ID = /^(0|[1-9][0-9]{0,77})$/;
const LIVE_TIP_NOTICE_LIMIT = 20;
const LIVE_TIP_FRESH_MS = 60_000;

// `assets: true` (v0.2 router) also indexes ERC-20 tips (kind 'token') and NFT gifts (kind 'nft'); ETH entries have no kind.
export function createTipLedger({ provider, routerAddress, startBlock, resolveContext, assets = false,
  restore = async () => null, save, now = Date.now, maxWindowsPerRun = 1,
  onSourceError = error => console.warn('[tip-ledger] Source verification:', error.shortMessage || error.message) }) {
  if (!ADDRESS.test(routerAddress || '') || /^0x0{40}$/i.test(routerAddress)) throw new Error('Invalid tip contract address');
  if (!Number.isSafeInteger(startBlock) || startBlock < 0) throw new Error('TIP_START_BLOCK must be the nonnegative deployment block');
  if (typeof resolveContext !== 'function') throw new Error('Tip source verification is required');
  if (!Number.isSafeInteger(maxWindowsPerRun) || maxWindowsPerRun < 1 || maxWindowsPerRun > 100) {
    throw new Error('Tip ledger windows per run must be a whole number from 1 to 100');
  }
  const router = routerAddress.toLowerCase(), entries = new Map();
  let initialized = false, scannedThrough = startBlock - 1, anchorHash = null;
  let head = null, lastCheckedAt = null, lastError = '', snapshotUri = '', lastSavedAt = null;
  let dirty = false, comparisonOffset = 0, task = Promise.resolve();
  let liveTips = new Map(), liveIndexReady = false;
  const run = operation => {
    const result = task.then(operation);
    task = result.catch(() => {});
    return result;
  };
  const topics = [iface.getEvent('TipSent').topicHash,
    ...(assets ? [iface.getEvent('TokenTipSent').topicHash, iface.getEvent('NftGiftSent').topicHash] : [])];
  const isEth = entry => !entry.kind;
  const entryKey = entry => `8453:${router}:${entry.txHash.toLowerCase()}:${entry.logIndex}`;
  const snapshot = () => ({ schemaVersion: 1, chainId: 8453, routerAddress: router, startBlock,
    scannedThrough, anchorHash, entries: [...entries.values()] });

  async function sourceProof(event, blockNumber) {
    if (!event.context) return { status: 'mismatch', error: event.contextError };
    try {
      const proof = await resolveContext({ ...event, blockNumber });
      if (!proof || !['verified', 'mismatch', 'unavailable'].includes(proof.status)) throw new Error('Invalid tip source verification response');
      return { status: proof.status, label: String(proof.label || '').slice(0, 200), error: String(proof.error || '').slice(0, 300) };
    } catch (error) {
      onSourceError(error);
      return { status: 'unavailable', error: 'Historical source verification is temporarily unavailable' };
    }
  }
  async function verifyTransaction(txHash) {
    if (!HASH.test(txHash || '')) throw new Error('Invalid tip transaction hash');
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1 || receipt.hash?.toLowerCase() !== txHash.toLowerCase()) {
      throw new Error('Tip receipt is unavailable or unsuccessful');
    }
    if (!Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < startBlock ||
        head - receipt.blockNumber + 1 < 2) throw new Error('Tip needs two successful Base confirmations after deployment');
    const block = await provider.getBlock(receipt.blockNumber);
    if (!block || block.hash !== receipt.blockHash) throw new Error('Tip receipt is not canonical');
    const decoded = [...decodeTipReceipt({ receipt, routerAddress: router, ethers }),
      ...(assets ? decodeAssetTipReceipt({ receipt, routerAddress: router, ethers }) : [])];
    if (!decoded.length) throw new Error('No tip event from the configured DecentBusking contract');
    const verified = [];
    for (const event of decoded) verified.push({ ...event, chainId: 8453, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
      paidAt: new Date(Number(block.timestamp) * 1000).toISOString(), chainVerified: true,
      sourceVerification: await sourceProof(event, receipt.blockNumber) });
    if ((await provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash) throw new Error('Tip chain changed during source verification');
    const validKeys = new Set(verified.map(entryKey));
    for (const [key, entry] of entries) {
      if (entry.txHash.toLowerCase() === txHash.toLowerCase() && !validKeys.has(key)) {
        entries.delete(key);
        dirty = true;
      }
    }
    for (const entry of verified) {
      const key = entryKey(entry);
      if (JSON.stringify(entries.get(key)) !== JSON.stringify(entry)) {
        entries.set(key, entry);
        dirty = true;
      }
    }
  }
  async function persist() {
    if (!save || (!dirty && lastSavedAt !== null && now() - lastSavedAt < 300000)) return;
    const uri = await save(snapshot());
    if (!/^ipfs:\/\//.test(uri || '')) throw new Error('Tip ledger backup did not return an IPFS URI');
    snapshotUri = uri;
    lastSavedAt = now();
    dirty = false;
  }
  function rebuildLiveTips() {
    const next = new Map();
    for (const [key, entry] of entries) {
      if (!isEth(entry) || entry.context?.source !== 'live' || typeof entry.context.bookingId !== 'string') continue;
      const booking = next.get(entry.context.bookingId) || [];
      booking.push({ key, entry });
      next.set(entry.context.bookingId, booking);
    }
    for (const booking of next.values()) {
      booking.sort((a, b) => a.entry.blockNumber - b.entry.blockNumber || a.entry.logIndex - b.entry.logIndex);
    }
    liveTips = next;
  }
  async function compareNow() {
    try {
      if (Number((await provider.getNetwork()).chainId) !== 8453) throw new Error('Tip ledger is Base-only');
      head = await provider.getBlockNumber();
      if (anchorHash && (await provider.getBlock(scannedThrough))?.hash !== anchorHash) {
        entries.clear();
        scannedThrough = startBlock - 1;
        anchorHash = null;
        dirty = true;
      }
      const end = Math.min(head - 1, scannedThrough + 1000);
      let comparisonEnd = scannedThrough, comparisonHash = anchorHash;
      if (end >= startBlock && end >= scannedThrough) {
        const anchor = await provider.getBlock(end);
        if (!HASH.test(anchor?.hash || '')) throw new Error('Tip ledger comparison block is unavailable');
        comparisonEnd = end;
        comparisonHash = anchor.hash;
        const from = Math.max(startBlock, scannedThrough - 11);
        const logs = await provider.getLogs({ address: router, topics: [topics],
          fromBlock: from, toBlock: end });
        const hashes = new Set(logs.map(log => log.transactionHash.toLowerCase()));
        for (const txHash of hashes) await verifyTransaction(txHash);
        // Compare overlap as well as new logs so a removed event never remains an earning.
        for (const [key, entry] of entries) {
          if (entry.blockNumber >= from && entry.blockNumber <= end && !hashes.has(entry.txHash.toLowerCase())) {
            entries.delete(key);
            dirty = true;
          }
        }
      }
      const waiting = [...entries.values()].filter(entry => !entry.chainVerified || entry.sourceVerification?.status === 'unavailable');
      const batch = waiting.slice(comparisonOffset, comparisonOffset + 25);
      comparisonOffset = comparisonOffset + 25 >= waiting.length ? 0 : comparisonOffset + 25;
      for (const txHash of new Set(batch.map(entry => entry.txHash))) await verifyTransaction(txHash);
      if (comparisonHash && (await provider.getBlock(comparisonEnd))?.hash !== comparisonHash) {
        throw new Error('Tip chain changed during comparison; retry');
      }
      scannedThrough = comparisonEnd;
      anchorHash = comparisonHash;
      lastCheckedAt = new Date(now()).toISOString();
      await persist();
      lastError = '';
      return getState();
    } catch (error) {
      lastError = 'Tip chain verification or checkpoint backup is unavailable; retry shortly';
      throw error;
    }
  }
  // Base makes about 432,000 blocks a day, so one 1,000-block window per poll would take hours to reach the head.
  async function compareWindows() {
    liveIndexReady = false;
    let result = await compareNow();
    for (let windows = 1; windows < maxWindowsPerRun && scannedThrough < head - 1; windows += 1) result = await compareNow();
    rebuildLiveTips();
    liveIndexReady = true;
    return result;
  }
  async function initialize() {
    return run(async () => {
      if (initialized) return compareWindows();
      try {
        if (Number((await provider.getNetwork()).chainId) !== 8453) throw new Error('Tip ledger is Base-only');
        if (await provider.getCode(router, startBlock) === '0x') throw new Error('Tip contract is not deployed at TIP_START_BLOCK');
        if (startBlock > 0 && await provider.getCode(router, startBlock - 1) !== '0x') {
          throw new Error('TIP_START_BLOCK must be the exact contract deployment block, not a later scan window');
        }
        const saved = await restore();
        if (saved) {
          if (saved.schemaVersion !== 1 || saved.chainId !== 8453 || saved.routerAddress !== router ||
              saved.startBlock !== startBlock || !Number.isSafeInteger(saved.scannedThrough) ||
              saved.scannedThrough < startBlock - 1 || !Array.isArray(saved.entries) ||
              (saved.scannedThrough >= startBlock && !HASH.test(saved.anchorHash || ''))) {
            throw new Error('Invalid tip ledger checkpoint');
          }
          for (const entry of saved.entries) {
            if (!HASH.test(entry.txHash || '') || !Number.isSafeInteger(entry.logIndex) || entry.logIndex < 0 ||
                !Number.isSafeInteger(entry.blockNumber) || entry.blockNumber < startBlock || entry.blockNumber > saved.scannedThrough ||
                entry.chainId !== 8453 || entry.routerAddress !== router || !ADDRESS.test(entry.sender || '') ||
                !ADDRESS.test(entry.recipient || '') || !HASH.test(entry.blockHash || '') || !validAmount(entry)) {
              throw new Error('Invalid tip ledger checkpoint entry');
            }
          }
          entries.clear();
          for (const entry of saved.entries) entries.set(entryKey(entry), { ...entry, chainVerified: false,
            sourceVerification: { status: 'unavailable', error: 'Restored tip awaits chain comparison' } });
          scannedThrough = saved.scannedThrough;
          anchorHash = saved.anchorHash;
          snapshotUri = saved.snapshotUri || '';
        }
        initialized = true;
        return await compareWindows();
      } catch (error) {
        lastError = 'Tip ledger initialization or recovery is unavailable; check operator configuration';
        throw error;
      }
    });
  }
  function validAmount(entry) {
    if (isEth(entry)) return UNITS.test(entry.amountWei || '');
    if (!assets) return false;
    if (entry.kind === 'token') return ADDRESS.test(entry.token || '') && UNITS.test(entry.amountUnits || '');
    return entry.kind === 'nft' && ADDRESS.test(entry.collection || '') && [0, 1].includes(entry.standard) &&
      TOKEN_ID.test(entry.tokenId || '') && UNITS.test(entry.amount || '') && (entry.standard === 1 || entry.amount === '1');
  }
  function getLiveTips({ bookingId, recipient, startedAt, endsAt, limit = LIVE_TIP_NOTICE_LIMIT } = {}) {
    createTipContext({ source: 'live', bookingId });
    if (!ADDRESS.test(recipient || '') || /^0x0{40}$/i.test(recipient) ||
        !Number.isSafeInteger(startedAt) || !Number.isSafeInteger(endsAt) || startedAt <= 0 || endsAt <= startedAt ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > LIVE_TIP_NOTICE_LIMIT) {
      throw new Error('Invalid live tip feedback scope');
    }
    const checkedAt = Date.parse(lastCheckedAt || ''), time = now();
    const ready = initialized && liveIndexReady && !lastError && Number.isFinite(checkedAt) &&
      time >= checkedAt && time - checkedAt <= LIVE_TIP_FRESH_MS;
    if (!ready) return { ready: false };
    const matching = (liveTips.get(bookingId) || []).filter(({ entry }) => {
      const paidAt = Date.parse(entry.paidAt);
      return entry.sourceKind === TIP_SOURCE_KINDS.live && entry.context?.bookingId === bookingId &&
        entry.recipient?.toLowerCase() === recipient.toLowerCase() && entry.sender !== entry.recipient &&
        Number.isFinite(paidAt) && paidAt >= startedAt && paidAt < endsAt && paidAt <= time;
    });
    const verified = matching.filter(({ entry }) => entry.chainVerified === true && entry.sourceVerification?.status === 'verified');
    const totalWei = verified.reduce((total, { entry }) => total + BigInt(entry.amountWei), 0n);
    const complete = head !== null && scannedThrough >= head - 1 &&
      !matching.some(({ entry }) => !entry.chainVerified || entry.sourceVerification?.status === 'unavailable');
    return { ready: true, checkedAt: lastCheckedAt, complete, count: verified.length, totalWei: totalWei.toString(),
      entries: verified.slice(-limit).map(({ key, entry }) => ({
        eventKey: key, amountWei: entry.amountWei, paidAt: Date.parse(entry.paidAt),
      })) };
  }
  function getState({ wallet, offset = 0, limit = 100 } = {}) {
    if (wallet && !ADDRESS.test(wallet)) throw new Error('Invalid tip wallet filter');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Invalid tip ledger page');
    }
    const selected = [...entries.values()].filter(entry => !wallet || entry.recipient?.toLowerCase() === wallet.toLowerCase())
      .sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
    let attributedWei = 0n, unattributedWei = 0n;
    const tokenTotals = {}, nftGifts = { attributed: 0, unattributed: 0 };
    for (const entry of selected) {
      if (!entry.chainVerified || entry.sender === entry.recipient) continue;
      const attributed = entry.sourceVerification.status === 'verified';
      if (entry.kind === 'nft') nftGifts[attributed ? 'attributed' : 'unattributed'] += 1;
      else if (entry.kind === 'token') {
        const total = tokenTotals[entry.token] ||= { attributedUnits: 0n, unattributedUnits: 0n };
        total[attributed ? 'attributedUnits' : 'unattributedUnits'] += BigInt(entry.amountUnits);
      } else if (attributed) attributedWei += BigInt(entry.amountWei);
      else unattributedWei += BigInt(entry.amountWei);
    }
    return { configured: true, ready: initialized && lastCheckedAt !== null && !lastError, chainId: 8453, routerAddress: router,
      startBlock, scannedThrough, caughtUp: head !== null && scannedThrough >= head - 1,
      lastCheckedAt, lastError, snapshotUri, recovery: save ? 'IPFS checkpoint and chain replay' : 'chain replay',
      restoringCount: [...entries.values()].filter(entry => !entry.chainVerified).length,
      attributedWei: attributedWei.toString(), unattributedWei: unattributedWei.toString(),
      ...(assets ? { assets: true, nftGifts, tokenTotals: Object.fromEntries(Object.entries(tokenTotals).map(([token, total]) =>
        [token, { attributedUnits: total.attributedUnits.toString(), unattributedUnits: total.unattributedUnits.toString() }])) } : {}),
      entries: selected.slice(offset, offset + limit), total: selected.length,
      nextOffset: offset + limit < selected.length ? offset + limit : null };
  }
  return { initialize, compare: () => run(() => {
    if (!initialized) throw new Error('Tip ledger is not initialized');
    return compareWindows();
  }), getState, getLiveTips };
}
