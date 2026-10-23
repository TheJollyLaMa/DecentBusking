const BATCH_EVENTS = ['PlaylistBatchRequested', 'PlaylistBatchFeeSettled', 'PlaylistBatchFeeRefunded', 'PlaylistSongRefunded', 'PlaylistSongDelivered'];

export function djukePlaylistReadiness({ configured, contractAddress, batchEventsDurable, workerReady, paymentsEnabled, mirrorAvailable, version = '0.4' }) {
  const reason = !configured ? 'DJuke v0.4 playlist checkout is not configured'
    : !batchEventsDurable ? 'Durable playlist event storage and an explicit start block are required'
    : !workerReady ? 'Playlist worker permissions and playback journals are not ready'
    : !paymentsEnabled ? 'DJuke payments are disabled'
    : !mirrorAvailable ? 'Local checkpoint mirror is offline' : '';
  return { ready: !reason, version, configured, contractAddress: configured ? contractAddress : '',
    batchEventsDurable, maxSongs: 24, laneModel: true,
    radioPricing: { tierSize: 8, baseUsdc: 0.25, platformFeeUsdc: 3, feeBlockSize: 12, split: [25, 25, 25, 25] },
    cutIn: 'Main paid requests always precede playlist lane songs', reason };
}

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
    const uri = await save({ schemaVersion: 2, nextBlock, batches: [...batches.values()] });
    if (typeof uri !== 'string' || !uri.startsWith('ipfs://')) throw new Error('Playlist batch checkpoint is not durable');
  };
  function apply(log) {
    const { name, args } = log;
    if (!BATCH_EVENTS.includes(name)) return;
    if (name === 'PlaylistSongRefunded' || name === 'PlaylistSongDelivered') {
      const laneId = BigInt(args.laneId).toString();
      for (const batch of batches.values()) if (batch.laneIds.includes(laneId)) {
        const field = name === 'PlaylistSongDelivered' ? 'deliveredLaneIds' : 'refundedLaneIds';
        batch[field] ||= [];
        if (!batch[field].includes(laneId)) {
          batch[field].push(laneId);
          if (name === 'PlaylistSongRefunded') {
            batch.refundedSongUnits = (BigInt(batch.refundedSongUnits || '0') + args.amount).toString();
          }
        }
      }
      return;
    }
    const key = String(args.batchId);
    if (name === 'PlaylistBatchRequested') {
      const ids = [...args.songIds];
      if (!ids.length || ids.length > 24) throw new Error('Invalid on-chain playlist batch event');
      const firstLaneId = BigInt(args.firstLaneId);
      batches.set(key, { batchId: key, payer: args.payer, songIds: ids, firstLaneId: firstLaneId.toString(),
        laneIds: ids.map((_, index) => (firstLaneId + BigInt(index)).toString()),
        subtotalUnits: args.subtotal.toString(), feeUnits: (args.platformFee ?? args.fee).toString(),
        refundedSongUnits: '0', refundedFeeUnits: '0',
        status: 'pending', blockNumber: Number(log.blockNumber), transactionHash: log.transactionHash });
    } else {
      const batch = batches.get(key);
      if (batch) {
        batch.status = name === 'PlaylistBatchFeeSettled' ? 'settled' : 'refunded';
        batch.resolutionTransactionHash = log.transactionHash;
        if (name === 'PlaylistBatchFeeRefunded') {
          batch.feeRefunded = true;
          batch.refundedFeeUnits = args.fee.toString();
        }
      }
    }
  }
  async function initialize() {
    const snapshot = await restore();
    if (snapshot && (snapshot.schemaVersion !== 2 || !Number.isSafeInteger(snapshot.nextBlock) || !Array.isArray(snapshot.batches))) {
      throw new Error('Invalid DJuke playlist batch checkpoint');
    }
    nextBlock = snapshot?.nextBlock ?? startBlock;
    if (snapshot?.batches.some(batch => batch.subtotalUnits === undefined ||
        batch.feeUnits === undefined || batch.refundedSongUnits === undefined ||
        (batch.status !== 'pending' && !batch.resolutionTransactionHash))) nextBlock = startBlock;
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
        const events = [];
        for (const name of BATCH_EVENTS) {
          const filter = contract.filters[name]();
          const logs = await contract.queryFilter(filter, nextBlock, endBlock);
          for (const log of logs) events.push({ name, args: log.args, blockNumber: log.blockNumber, index: log.index ?? 0, transactionHash: log.transactionHash });
        }
        if (!events.length) {
          nextBlock = endBlock + 1;
          continue;
        }
        const previousBatches = new Map([...batches].map(([key, value]) => [key, structuredClone(value)]));
        const previousBlock = nextBlock;
        try {
          events.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index).forEach(apply);
          nextBlock = endBlock + 1;
          await commit();
        } catch (error) {
          batches = previousBatches;
          nextBlock = previousBlock;
          throw error;
        }
      }
      return [...batches.values()].map(batch => structuredClone(batch));
    }),
    forLane(laneId) {
      const id = BigInt(laneId).toString();
      for (const batch of batches.values()) if (batch.laneIds.includes(id)) return structuredClone(batch);
      return null;
    },
    getState: () => [...batches.values()].map(batch => structuredClone(batch)),
  };
}

export function playlistBatchEventAbi() {
  return [
    'event PlaylistBatchRequested(uint256 indexed batchId,address indexed payer,bytes32[] songIds,uint256 subtotal,uint256 platformFee,uint256 firstLaneId)',
    'event PlaylistSongDelivered(uint256 indexed laneId,uint256 indexed batchId,bytes32 indexed songId,uint256 amount,bytes32 playbackProof)',
    'event PlaylistBatchFeeSettled(uint256 indexed batchId,uint256 fee,uint256 playback,uint256 topTen,uint256 pinners,uint256 repoDev)',
    'event PlaylistBatchFeeRefunded(uint256 indexed batchId,address indexed payer,uint256 fee)',
    'event PlaylistSongRefunded(uint256 indexed laneId,uint256 indexed batchId,uint256 amount)',
  ];
}

export function legacyPlaylistReceipts(json, activeContract) {
  if (!json) return [];
  const receipts = JSON.parse(json);
  const address = value => /^0x[0-9a-fA-F]{40}$/.test(value || '');
  const hash = value => /^0x[0-9a-fA-F]{64}$/.test(value || '');
  const units = value => typeof value === 'string' && /^\d+$/.test(value);
  const seen = new Set();
  if (!Array.isArray(receipts) || receipts.length > 50) throw new Error('Invalid legacy playlist receipts');
  return receipts.map(batch => {
    const key = `${batch.contractAddress}:${batch.batchId}`.toLowerCase();
    if (!address(batch.contractAddress) || batch.contractAddress.toLowerCase() === activeContract?.toLowerCase() ||
        !address(batch.payer) || !/^\d+$/.test(batch.batchId) || seen.has(key) ||
        !['settled', 'refunded'].includes(batch.status) || batch.workerGasSponsored !== false ||
        !hash(batch.transactionHash) || !hash(batch.resolutionTransactionHash) ||
        !units(batch.subtotalUnits) || !units(batch.feeUnits) || !units(batch.refundedUnits) ||
        BigInt(batch.refundedUnits) > BigInt(batch.subtotalUnits) + BigInt(batch.feeUnits) ||
        !Array.isArray(batch.songs) || batch.songs.length < 1 || batch.songs.length > 24 ||
        batch.songs.some(song => !hash(song.songId) || !['delivered', 'refunded'].includes(song.status))) {
      throw new Error('Legacy playlist receipts must be resolved, exact and from a different contract');
    }
    seen.add(key);
    return { ...batch, playing: false };
  });
}
