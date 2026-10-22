const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { Wallet } = createRequire(require('node:path').join(__dirname, '../discord-bot/package.json'))('ethers');

test('playlist batch event journal reconciles ordered request IDs and fee/refund events across restart', async () => {
  const { createDjukePlaylistBatchReconciler } = await import('../discord-bot/djuke-playlist-batches.js');
  let snapshot;
  let head = 30;
  const events = {
    PlaylistBatchRequested: [{ blockNumber: 11, transactionHash: '0xabc', args: { batchId: 4n, payer: Wallet.createRandom().address,
      songIds: [`0x${'a'.repeat(64)}`, `0x${'b'.repeat(64)}`], firstRequestId: 7n } }],
    RequestRefunded: [{ blockNumber: 12, transactionHash: '0xdef', args: { requestId: 8n, songId: `0x${'b'.repeat(64)}` } }],
    PlaylistBatchFeeRefunded: [{ blockNumber: 13, transactionHash: '0xdef', args: { batchId: 4n } }],
    PlaylistBatchFeeSettled: [],
  };
  const contract = { filters: Object.fromEntries(Object.keys(events).map(name => [name, () => name])),
    queryFilter: async (name, from, to) => events[name].filter(event => event.blockNumber >= from && event.blockNumber <= to) };
  const provider = { getBlockNumber: async () => head };
  const create = () => createDjukePlaylistBatchReconciler({ provider, contract, startBlock: 10, confirmations: 2,
    restore: async () => snapshot, save: async state => { snapshot = structuredClone(state); return 'ipfs://batch-state'; } });
  const journal = create();
  await journal.initialize();
  const batches = await journal.reconcile();
  assert.equal(batches[0].batchId, '4');
  assert.deepEqual(batches[0].requestIds, ['7', '8']);
  assert.deepEqual(batches[0].refundedRequestIds, ['8']);
  assert.equal(batches[0].status, 'refunded');
  head = 32;
  const restarted = create();
  await restarted.initialize();
  assert.equal((await restarted.reconcile())[0].transactionHash, '0xabc');
  assert.equal(snapshot.nextBlock, 31);
});

test('paid DJuke runtime refunds an undeliverable playlist head through the batch callback', async () => {
  const { createDjukePlaybackJournal, createDjukeRuntime } = await import('../discord-bot/djuke.js');
  let snapshot;
  let refunds = 0;
  const request = { requestId: '8453:0xcontract:7', chainRequestId: '7', songId: `0x${'a'.repeat(64)}`,
    revision: '0', trackId: 'djuke:missing', payer: Wallet.createRandom().address, amountUnits: '250000',
    playable: false, playlistBatchId: '4' };
  const journal = createDjukePlaybackJournal({ restore: async () => snapshot,
    save: async state => { snapshot = structuredClone(state); return 'ipfs://journal'; } });
  const runtime = createDjukeRuntime({ readState: async () => ({ requests: [request] }), journal,
    fulfill: async () => {}, getTrack: () => null, refundPlaylistBatch: async id => { assert.equal(id, '4'); refunds++; } });
  assert.equal(await runtime.nextPaid(), null);
  assert.equal(refunds, 1);
  assert.equal(journal.getState()[0].playlistBatchId, '4');
  assert.equal(journal.getState()[0].state, 'pending');
});
