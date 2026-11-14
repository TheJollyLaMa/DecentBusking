import * as ethers from 'ethers';
import { TIP_ABI, decodeTipReceipt } from '../js/tip-protocol.mjs';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const iface = new ethers.Interface(TIP_ABI);

export function createTipLedger({ provider, routerAddress, startBlock, resolveContext,
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
  const run = operation => {
    const result = task.then(operation);
    task = result.catch(() => {});
    return result;
  };
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
    const decoded = decodeTipReceipt({ receipt, routerAddress: router, ethers });
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
        const logs = await provider.getLogs({ address: router, topics: [iface.getEvent('TipSent').topicHash],
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
    let state = await compareNow();
    for (let windows = 1; windows < maxWindowsPerRun && scannedThrough < head - 1; windows += 1) state = await compareNow();
    return state;
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
                !ADDRESS.test(entry.recipient || '') || !HASH.test(entry.blockHash || '') ||
                !/^[1-9][0-9]{0,77}$/.test(entry.amountWei || '')) {
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
  function getState({ wallet, offset = 0, limit = 100 } = {}) {
    if (wallet && !ADDRESS.test(wallet)) throw new Error('Invalid tip wallet filter');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Invalid tip ledger page');
    }
    const selected = [...entries.values()].filter(entry => !wallet || entry.recipient?.toLowerCase() === wallet.toLowerCase())
      .sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
    let attributedWei = 0n, unattributedWei = 0n;
    for (const entry of selected) {
      if (!entry.chainVerified || entry.sender === entry.recipient) continue;
      if (entry.sourceVerification.status === 'verified') attributedWei += BigInt(entry.amountWei);
      else unattributedWei += BigInt(entry.amountWei);
    }
    return { configured: true, ready: initialized && lastCheckedAt !== null && !lastError, chainId: 8453, routerAddress: router,
      startBlock, scannedThrough, caughtUp: head !== null && scannedThrough >= head - 1,
      lastCheckedAt, lastError, snapshotUri, recovery: save ? 'IPFS checkpoint and chain replay' : 'chain replay',
      restoringCount: [...entries.values()].filter(entry => !entry.chainVerified).length,
      attributedWei: attributedWei.toString(), unattributedWei: unattributedWei.toString(),
      entries: selected.slice(offset, offset + limit), total: selected.length,
      nextOffset: offset + limit < selected.length ? offset + limit : null };
  }
  return { initialize, compare: () => run(() => {
    if (!initialized) throw new Error('Tip ledger is not initialized');
    return compareWindows();
  }), getState };
}
