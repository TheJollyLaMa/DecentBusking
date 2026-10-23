const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { Wallet } = createRequire(require('node:path').join(__dirname, '../discord-bot/package.json'))('ethers');

test('playlist batch event journal reconciles ordered lane IDs and fee/refund events across restart', async () => {
  const { createDjukePlaylistBatchReconciler } = await import('../discord-bot/djuke-playlist-batches.js');
  let snapshot;
  let head = 30;
  const events = {
    PlaylistBatchRequested: [{ blockNumber: 11, transactionHash: '0xabc', args: { batchId: 4n, payer: Wallet.createRandom().address,
      songIds: [`0x${'a'.repeat(64)}`, `0x${'b'.repeat(64)}`], firstLaneId: 7n } }],
    PlaylistSongRefunded: [{ blockNumber: 12, transactionHash: '0xdef', args: { laneId: 8n, batchId: 4n, songId: `0x${'b'.repeat(64)}` } }],
    PlaylistBatchFeeRefunded: [{ blockNumber: 13, transactionHash: '0xdef', args: { batchId: 4n } }],
    PlaylistBatchFeeSettled: [], PlaylistSongDelivered: [],
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
  assert.deepEqual(batches[0].laneIds, ['7', '8']);
  assert.deepEqual(batches[0].refundedLaneIds, ['8']);
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

test('lane reader and runtime always play main paid requests before playlist head, including late cut-ins', async () => {
  const { createDjukeQueueReader, createDjukePlaybackJournal, createDjukeRuntime, createDjukeFulfiller } = await import('../discord-bot/djuke.js');
  const { id } = createRequire(require('node:path').join(__dirname, '../discord-bot/package.json'))('ethers');
  const payer = `0x${'2'.repeat(40)}`, address = `0x${'1'.repeat(40)}`;
  let main = false;
  let laneHead = 4n;
  const tracks = ['main', 'lane'].map(trackId => ({ trackId, title: trackId, ipfsCid: trackId, mintRecipient: payer }));
  const options = [];
  const contract = {
    headRequestId: async () => 0n, nextRequestId: async () => main ? 1n : 0n,
    getRequest: async () => ({ songId: id('main'), payer, amount: 250000n, revision: 0n, fulfilled: false }),
    playlistHeadId: async option => { options.push(option); return laneHead; }, playlistNextId: async () => 6n, playlistPendingCount: async () => laneHead === 6n ? 0n : 1n,
    getPlaylistItem: async laneId => ({ batchId: 8n, songId: id('lane'), payer, amount: 250000n, status: laneId === 5 ? 2 : 0 }),
    getSong: async songId => ({ audioURI: `ipfs://${songId === id('main') ? 'main' : 'lane'}`, enabled: true }),
  };
  const provider = { getNetwork: async () => ({ chainId: 8453n }), getBlockNumber: async () => 50, getBlock: async () => ({ hash: 'confirmed' }) };
  const read = createDjukeQueueReader({ provider, contract, contractAddress: address, getPlaylist: () => tracks, playlistLaneEnabled: true });
  const first = await read();
  assert.equal(first.mainPending, 0);
  assert.equal(first.requests[0].playlistLaneId, '4');
  assert.equal(first.requests[0].playlistBatchId, '8');
  assert.equal(first.requests.length, 1, 'refunded lane item is skipped');
  assert.deepEqual(options[0], { blockTag: 49 });
  let snapshot;
  const journal = createDjukePlaybackJournal({ restore: async () => snapshot, save: async value => { snapshot = value; return 'ipfs://journal'; } });
  await journal.initialize();
  await journal.synchronize(first.requests); // Lane was journaled before a main request arrives.
  main = true;
  const state = await read();
  assert.deepEqual(state.requests.map(request => request.trackId), ['main', 'lane']);
  const fulfilled = [];
  const fulfill = createDjukeFulfiller({
    fulfill: async (...args) => { fulfilled.push(['main', ...args]); return { hash: 'main', wait: async () => ({ status: 1 }) }; },
    fulfillPlaylistSong: async (...args) => { fulfilled.push(['lane', ...args]); return { hash: 'lane', wait: async () => ({ status: 1 }) }; },
  });
  const runtime = createDjukeRuntime({ readState: read, journal, fulfill, getTrack: trackId => tracks.find(track => track.trackId === trackId) });
  assert.equal((await runtime.nextPaid()).track.trackId, 'main');
  main = false;
  assert.equal((await runtime.nextPaid()).track.trackId, 'lane');
  await fulfill({ playlistLaneId: '4', songId: id('lane'), revision: '0', playId: 'audible-proof' });
  assert.deepEqual(fulfilled[0], ['lane', 4n, id('lane'), 0n, id('audible-proof')]);
  laneHead = 6n;
  assert.equal((await read()).requests.length, 0);
});

test('played playlist proof waits for late main requests before lane settlement', async () => {
  const { createDjukePlaybackJournal, createDjukeRuntime } = await import('../discord-bot/djuke.js');
  const lane = { requestId: 'lane:0', playlistLaneId: '0', playlistBatchId: '1', songId: `0x${'a'.repeat(64)}`, revision: '0', trackId: 'lane', playable: true };
  let requests = [lane];
  let snapshot;
  const journal = createDjukePlaybackJournal({ restore: async () => snapshot, save: async value => { snapshot = value; return 'ipfs://journal'; } });
  const calls = [];
  const runtime = createDjukeRuntime({ readState: async () => ({ requests }), journal,
    fulfill: async value => calls.push(value), getTrack: trackId => ({ trackId }), minAudibleMs: 1 });
  const claim = await runtime.nextPaid();
  requests = [{ requestId: 'main:0', chainRequestId: '0', songId: `0x${'b'.repeat(64)}`, revision: '0', trackId: 'main', playable: true }, lane];
  await runtime.complete(claim.record, { playId: 'proof', audibleMs: 2 });
  await runtime.reconcile();
  assert.equal(calls.length, 0, 'late main request prevents playlist settlement');
  requests = [lane];
  await runtime.reconcile();
  assert.equal(calls[0].playlistLaneId, '0');
  assert.equal(calls[0].playId, 'proof');
});
test('playlist readiness requires explicit configuration, durable events, verified runtime, payments, and live mirror', async () => {
  const { djukePlaylistReadiness } = await import('../discord-bot/djuke-playlist-batches.js');
  const enabled = { configured: true, contractAddress: `0x${'12'.repeat(20)}`, batchEventsDurable: true,
    workerReady: true, paymentsEnabled: true, mirrorAvailable: true };
  assert.equal(djukePlaylistReadiness(enabled).ready, true);
  assert.equal(djukePlaylistReadiness(enabled).reason, '');
  for (const key of ['configured', 'batchEventsDurable', 'workerReady', 'paymentsEnabled', 'mirrorAvailable']) {
    const closed = djukePlaylistReadiness({ ...enabled, [key]: false });
    assert.equal(closed.ready, false, key);
    assert.ok(closed.reason, key);
  }
  assert.equal(djukePlaylistReadiness({ ...enabled, configured: false }).contractAddress, '');
});

test('playlist worker verifies Base, on-chain v0.4, quote identity and fulfiller permissions', async () => {
  const { verifyDjukePlaylistWorker } = await import('../discord-bot/djuke.js');
  const workerAddress = `0x${'12'.repeat(20)}`;
  const contract = { CONTRACT_VERSION: async () => '0.4', gasWorker: async () => workerAddress.toUpperCase(),
    FULFILLER_ROLE: async () => 'fulfiller', hasRole: async (role, address) => role === 'fulfiller' && address === workerAddress };
  const provider = { getNetwork: async () => ({ chainId: 8453n }) };
  await verifyDjukePlaylistWorker({ provider, contract, workerAddress });
  await assert.rejects(verifyDjukePlaylistWorker({ provider: { getNetwork: async () => ({ chainId: 1n }) },
    contract, workerAddress }), /Base-only/);
  await assert.rejects(verifyDjukePlaylistWorker({ provider,
    contract: { ...contract, CONTRACT_VERSION: async () => '0.3' }, workerAddress }), /v0.4/);
  await assert.rejects(verifyDjukePlaylistWorker({ provider,
    contract: { ...contract, gasWorker: async () => `0x${'34'.repeat(20)}` }, workerAddress }), /does not match/);
  await assert.rejects(verifyDjukePlaylistWorker({ provider,
    contract: { ...contract, hasRole: async () => false }, workerAddress }), /fulfiller role/);
});

test('production playlist quote wiring stays closed before runtime restore and for missing rollout prerequisites', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const { djukePlaylistReadiness } = await import('../discord-bot/djuke-playlist-batches.js');
  const source = fs.readFileSync(require('node:path').join(__dirname, '../discord-bot/index.js'), 'utf8');
  assert.ok(source.indexOf('if (initializePlaylistWorker) void initializePlaylistWorker()') > source.lastIndexOf('playlistReady = true;'),
    'runtime initialization must start only after catalog restoration');
  assert.ok(source.indexOf('if (initializePlaylistWorker) void initializePlaylistWorker()') > source.indexOf('http.createServer(requestHandler).listen'),
    'durable journal initialization must start only after the HTTP mirror heartbeat endpoint is available');
  const code = source.slice(source.indexOf('  const djukeAddress ='), source.indexOf('  let readDjukeState ='));
  const address = `0x${'12'.repeat(20)}`;
  const enabled = { DJUKE_CONTRACT_ADDRESS: address, DJUKE_CONTRACT_VERSION: '0.4', DJUKE_FULFILLER_PRIVATE_KEY: 'local-fixture',
    DJUKE_PLAYLIST_BATCH_ADDRESS: address, DJUKE_PLAYLIST_BATCH_VERSION: '0.4', DJUKE_PLAYLIST_BATCH_ENABLED: 'true',
    DJUKE_PLAYLIST_BATCH_START_BLOCK: '10', DJUKE_PAYMENTS_ENABLED: 'true' };
  async function wiring(overrides = {}) {
    let signed = 0;
    const context = vm.createContext({
      process: { env: { ...enabled, ...overrides } }, config: { pinataJwt: 'local-fixture' },
      checkpointMirror: { status: () => ({ available: true }) },
      Wallet: class { constructor(_key, provider) { this.provider = provider; } },
      Contract: class { constructor(_address, _abi, provider) { this.runner = { provider }; } },
      supportsDjukeAlbumsAndGas: version => ['0.3', '0.4'].includes(version),
      getRpcRouter: () => ({ provider: () => ({}) }),
      createDjukeGasQuoteReader: () => async () => ({}),
      createDjukePlaylistGasQuoteReader: () => async () => { signed++; return { signature: 'fixture' }; },
      createPinataStateStore: () => ({ restore: async () => undefined, save: async () => 'ipfs://fixture' }),
      createDjukePlaylistBatchReconciler: () => ({ initialize: async () => {} }),
      initializeDevertPlaybackWithRetry: ({ initialize }) => initialize(),
      playlistBatchEventAbi: () => [], createDjukeQueueReader: () => async () => ({}),
      djukePlaylistReadiness, DJUKE_ABI: [], DJUKE_GAS_ABI: [], DJUKE_PLAYLIST_GAS_ABI: [],
    });
    const result = await vm.runInContext(`(async () => { ${code}
      return { readiness: getDjukePlaylistReadiness, quote: getDjukePlaylistGasQuote,
        eventsRestored: () => { playlistBatchEventsReady = true; },
        runtimeRestored: () => { playlistBatchEventsReady = true; playlistWorkerReady = true; } }; })()`, context);
    return { ...result, signed: () => signed };
  }
  const live = await wiring();
  assert.equal((await live.readiness()).ready, false);
  await assert.rejects(live.quote({}), /required/);
  live.eventsRestored();
  await assert.rejects(live.quote({}), /not ready/);
  assert.equal(live.signed(), 0);
  live.runtimeRestored();
  assert.equal((await live.readiness()).ready, true);
  assert.equal((await live.quote({})).signature, 'fixture');
  assert.equal(live.signed(), 1);
  for (const overrides of [{ DJUKE_PLAYLIST_BATCH_START_BLOCK: '' }, { DJUKE_PLAYLIST_BATCH_START_BLOCK: undefined },
    { DJUKE_PLAYLIST_BATCH_START_BLOCK: '-1' }, { DJUKE_PAYMENTS_ENABLED: 'false' }]) {
    const closed = await wiring(overrides);
    closed.runtimeRestored();
    assert.equal((await closed.readiness()).ready, false);
    await assert.rejects(closed.quote({}));
    assert.equal(closed.signed(), 0);
  }
  for (const overrides of [{ DJUKE_PLAYLIST_BATCH_ENABLED: 'false' }, { DJUKE_CONTRACT_VERSION: '0.3' },
    { DJUKE_PLAYLIST_BATCH_ADDRESS: `0x${'34'.repeat(20)}` }]) {
    const closed = await wiring(overrides);
    assert.equal((await closed.readiness()).ready, false);
    assert.equal(closed.quote, null);
  }
});
