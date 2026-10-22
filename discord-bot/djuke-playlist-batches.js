const BATCH_EVENTS = ['PlaylistBatchRequested', 'PlaylistBatchFeeSettled', 'PlaylistBatchFeeRefunded', 'RequestRefunded'];

export function createDjukePlaylistBatchReconciler({ provider, contract, restore, save, startBlock, confirmations = 2,
  chunkSize = 2000 }) {
  if (!provider || !contract || typeof restore !== 'function' || typeof save !== 'function' || !Number.isSafeInteger(startBlock) || startBlock < 0) {
    throw new Error('Durable DJuke playlist batch reconciliation requires a contract, start block, and checkpoint store');
  }
  let nextBlock = startBlock;
  let batches = new Map();
  let initialized = false;
  let task = Promise.resolve();
  const run = operation => { const pending = task.then(operation); task = pending.catch(() => {}); return pending; };
  const commit = async () => {
    const uri = await save({ schemaVersion: 1, nextBlock, batches: [...batches.values()] });
    if (typeof uri !== 'string' || !uri.startsWith('ipfs://')) throw new Error('Playlist batch checkpoint is not durable');
  };
  function apply(log) {
    const { name, args } = log;
    if (!BATCH_EVENTS.includes(name)) return;
    if (name === 'RequestRefunded') {
      const requestId = BigInt(args.requestId).toString();
      for (const batch of batches.values()) if (batch.requestIds.includes(requestId)) {
        batch.refundedRequestIds ||= [];
        if (!batch.refundedRequestIds.includes(requestId)) batch.refundedRequestIds.push(requestId);
      }
      return;
    }
    const key = String(args.batchId);
    if (name === 'PlaylistBatchRequested') {
      const ids = [...args.songIds];
      if (!ids.length || ids.length > 10) throw new Error('Invalid on-chain playlist batch event');
      const firstRequestId = BigInt(args.firstRequestId);
      batches.set(key, { batchId: key, payer: args.payer, songIds: ids, firstRequestId: firstRequestId.toString(),
        requestIds: ids.map((_, index) => (firstRequestId + BigInt(index)).toString()),
        status: 'pending', blockNumber: Number(log.blockNumber), transactionHash: log.transactionHash });
    } else {
      const batch = batches.get(key);
      if (batch) {
        batch.status = name === 'PlaylistBatchFeeSettled' ? 'settled' : 'refunded';
        if (name === 'PlaylistBatchFeeRefunded') batch.feeRefunded = true;
      }
    }
  }
  async function initialize() {
    const snapshot = await restore();
    if (snapshot && (snapshot.schemaVersion !== 1 || !Number.isSafeInteger(snapshot.nextBlock) || !Array.isArray(snapshot.batches))) {
      throw new Error('Invalid DJuke playlist batch checkpoint');
    }
    nextBlock = snapshot?.nextBlock ?? startBlock;
    batches = new Map((snapshot?.batches || []).map(batch => [String(batch.batchId), structuredClone(batch)]));
    await commit();
    initialized = true;
  }
  return {
    initialize: () => run(initialize),
    reconcile: () => run(async () => {
      if (!initialized) throw new Error('DJuke playlist batch journal is not restored');
      const confirmedHead = await provider.getBlockNumber() - confirmations;
      if (confirmedHead < nextBlock) return [...batches.values()].map(batch => structuredClone(batch));
      while (nextBlock <= confirmedHead) {
        const endBlock = Math.min(confirmedHead, nextBlock + chunkSize - 1);
        for (const name of BATCH_EVENTS) {
          const filter = contract.filters[name]();
          const logs = await contract.queryFilter(filter, nextBlock, endBlock);
          for (const log of logs) apply({ name, args: log.args, blockNumber: log.blockNumber, transactionHash: log.transactionHash });
        }
        nextBlock = endBlock + 1;
        await commit();
      }
      return [...batches.values()].map(batch => structuredClone(batch));
    }),
    forRequest(requestId) {
      const id = BigInt(requestId).toString();
      for (const batch of batches.values()) if (batch.requestIds.includes(id)) return structuredClone(batch);
      return null;
    },
    getState: () => [...batches.values()].map(batch => structuredClone(batch)),
  };
}

export function playlistBatchEventAbi() {
  return [
    'event PlaylistBatchRequested(uint256 indexed batchId,address indexed payer,bytes32[] songIds,uint256 baseSubtotal,uint256 radioFee,uint256 firstRequestId)',
    'event PlaylistBatchFeeSettled(uint256 indexed batchId,uint256 fee,uint256 playback,uint256 topTen,uint256 pinners,uint256 repoDev)',
    'event PlaylistBatchFeeRefunded(uint256 indexed batchId,address indexed payer,uint256 fee)',
    'event RequestRefunded(uint256 indexed requestId,bytes32 indexed songId,address indexed payer,uint256 amount)',
  ];
}
