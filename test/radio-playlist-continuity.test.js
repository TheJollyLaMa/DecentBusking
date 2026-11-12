const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('all 12 paid songs beat rotation with production head-only reads and checkpoints slower than both deadlines', async t => {
  const { createDjukeRuntime, createDjukePlaybackJournal } = await import('../discord-bot/djuke.js');
  const { combinePaidQueues } = await import('../discord-bot/devert-queue.js');
  const { JukeLoopSession } = await import('../discord-bot/jukeloop.js');
  let requests = Array.from({ length: 12 }, (_, i) => ({
    requestId: `playlist:${i}`, playlistLaneId: String(i), playlistBatchId: '1',
    songId: `0x${String(i + 1).padStart(64, '0')}`, revision: '0',
    trackId: `paid-${i}`, playable: true,
  }));
  const journal = createDjukePlaybackJournal({ restore: async () => null,
    save: async () => { await delay(12); return 'ipfs://durable'; } });
  let refunds = 0;
  const runtime = createDjukeRuntime({ journal, timeoutMs: 2, minAudibleMs: 1,
    readState: async () => ({ requests: structuredClone(requests.slice(0, 1)), playlistPending: requests.length }),
    getTrack: trackId => ({ trackId, title: trackId }),
    fulfill: async ({ playlistLaneId }) => { requests = requests.filter(item => item.playlistLaneId !== playlistLaneId); },
    refundPlaylistBatch: async () => { refunds++; }, log: { warn() {} } });
  await runtime.reconcile();
  const paid = combinePaidQueues({ songs: runtime, timeoutMs: 3, log: { warn() {} } });
  const session = new JukeLoopSession({
    voiceChannel: { guild: { id: 'durable-playlist-continuity' } }, client: {}, schedule: [], djuke: paid,
    createStream: () => {
      const stream = new PassThrough();
      stream.write(Buffer.from('ready audio'));
      const ffmpegProcess = new EventEmitter();
      ffmpegProcess.kill = () => {};
      return { stream, ffmpegProcess };
    },
  });
  t.after(() => session.destroy());
  session._queue = [{ trackId: 'ordinary', title: 'Must wait for the purchased playlist' }];
  session._getFreshUrl = async track => `https://media.example/${track.trackId}`;
  const delivered = [];
  for (let i = 0; i < 12; i++) {
    let prepared;
    const deadline = Date.now() + 3000;
    while (!prepared && Date.now() < deadline) {
      prepared = await session._prepareNextPlayback();
      if (!prepared) await delay(4);
    }
    assert.ok(prepared, `song ${i + 1} becomes playable despite slow checkpoints`);
    assert.equal(prepared.track.trackId, `paid-${i}`, 'ordinary rotation must never cut into the batch');
    assert.equal(prepared.paid.record.attempts, 1, 'a late reservation is consumed, not released and recreated');
    assert.equal(await paid.canPlay(prepared.paid.record), true);
    delivered.push(prepared.track.trackId);
    await paid.complete(prepared.paid.record, { playId: `proof-${i}`, trackId: `paid-${i}`,
      revision: '0', audibleMs: 1000, finished: true });
    session._disposePrepared({ ...prepared, paid: null });
  }
  await runtime.reconcile();
  assert.equal(delivered.length, 12);
  assert.equal(refunds, 0);
  assert.equal(paid.hasPendingPlaylist(), false);
  const ordinary = await session._prepareNextPlayback();
  assert.equal(ordinary.track.trackId, 'ordinary', 'normal rotation resumes after the final delivery');
  session._disposePrepared(ordinary);
});

test('stale prefetched rotation is discarded at a paid-playlist handoff instead of starting a full unrelated song', async t => {
  const { JukeLoopSession } = await import('../discord-bot/jukeloop.js');
  const player = new EventEmitter();
  player.state = { status: 'idle' };
  player.stop = () => {};
  const session = new JukeLoopSession({ voiceChannel: { guild: { id: 'prefetched-rotation' } }, client: {},
    schedule: [], audioPlayer: player, djuke: { hasPendingPlaylist: () => true } });
  t.after(() => session.destroy());
  let disposed = false, refreshed = false;
  session._preparedNext = { track: { trackId: 'ordinary' }, ffmpegProcess: { kill() { disposed = true; } } };
  session._prepareNextPlayback = async () => { refreshed = true; return null; };
  await session._playNext();
  assert.equal(disposed, true);
  assert.equal(refreshed, true);
  assert.equal(session._nowPlaying, null);
  assert.match(session.getPlaybackStatus().reason, /paid playlist/);
});

test('remaining on-chain lanes keep the playlist hold after the only journaled head has fulfilled', async () => {
  const { createDjukeRuntime, createDjukePlaybackJournal } = await import('../discord-bot/djuke.js');
  const items = [0, 1].map(i => ({ requestId: `lane:${i}`, playlistLaneId: String(i), playlistBatchId: '1',
    songId: `0x${String(i + 1).padStart(64, '0')}`, trackId: `track-${i}`, revision: '0', playable: true }));
  let requests = items;
  const journal = createDjukePlaybackJournal({ restore: async () => null, save: async () => 'ipfs://durable' });
  const runtime = createDjukeRuntime({ journal, minAudibleMs: 1,
    readState: async () => ({ requests: requests.slice(0, 1), playlistPending: requests.length }),
    getTrack: trackId => ({ trackId }),
    fulfill: async () => { requests = requests.slice(1); } });
  const first = await runtime.nextPaid();
  await runtime.complete(first.record, { playId: 'first', audibleMs: 100, finished: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(journal.getState().length, 1, 'production only journals the exposed lane head');
  assert.equal(journal.getState()[0].state, 'fulfilled');
  assert.equal(runtime.hasPendingPlaylist(), true, 'remaining lane count holds rotation before the next head enters the journal');
  assert.equal((await runtime.nextPaid()).record.requestId, items[1].requestId);
});

test('a prepared playlist reservation is revalidated against refunds, changed recordings and newer main requests', async () => {
  const { createDjukeRuntime, createDjukePlaybackJournal } = await import('../discord-bot/djuke.js');
  const item = { requestId: 'playlist:1', playlistLaneId: '1', playlistBatchId: '0',
    songId: `0x${'a'.repeat(64)}`, revision: '0', trackId: 'paid', playable: true };
  let requests = [item];
  const journal = createDjukePlaybackJournal({ restore: async () => null, save: async () => 'ipfs://durable' });
  const runtime = createDjukeRuntime({ journal, readState: async () => ({ requests }),
    getTrack: trackId => ({ trackId }), fulfill: async () => {} });
  const selection = await runtime.nextPaid();
  assert.equal(await runtime.canPlay(selection.record), true);
  requests = [item, { requestId: 'main:0', playable: true }];
  assert.equal(await runtime.canPlay(selection.record), false, 'main paid FIFO still cuts in');
  requests = [{ ...item, revision: '1' }];
  assert.equal(await runtime.canPlay(selection.record), false);
  requests = [];
  assert.equal(await runtime.canPlay(selection.record), false, 'a refunded reservation must not play');
});

test('a started playlist owns the song and advert queues through its last delivery, including journal restart', async () => {
  const { createDjukeRuntime, createDjukePlaybackJournal } = await import('../discord-bot/djuke.js');
  const { combinePaidQueues } = await import('../discord-bot/devert-queue.js');
  const lanes = [0, 1, 2].map(i => ({ requestId: `lane:${i}`, playlistLaneId: String(i), playlistBatchId: '5',
    trackId: `song-${i}`, songId: `hash-${i}`, revision: '0', playable: true }));
  let requests = [...lanes], snapshot;
  const make = async () => {
    const journal = createDjukePlaybackJournal({ restore: async () => snapshot,
      save: async value => { snapshot = structuredClone(value); return 'ipfs://durable'; } });
    const runtime = createDjukeRuntime({ journal, minAudibleMs: 1, getTrack: trackId => ({ trackId }),
      readState: async () => ({ requests: structuredClone(requests) }),
      fulfill: async ({ playlistLaneId, chainRequestId }) => {
        requests = requests.filter(r => playlistLaneId !== undefined
          ? r.playlistLaneId !== playlistLaneId : r.chainRequestId !== chainRequestId);
      } });
    await runtime.reconcile();
    return runtime;
  };
  let runtime = await make();
  const first = await runtime.nextPaid();
  await runtime.start(first.record);
  assert.equal(snapshot.activePlaylistBatchId, '5', 'ownership is durable before first audio');
  requests.unshift({ requestId: 'single:later', chainRequestId: '8', songId: 'single-hash',
    trackId: 'later-single', revision: '0', playable: true });
  runtime = await make();
  assert.equal(runtime.hasActivePlaylist(), true, 'restart must not hand the active batch to later singles');
  const replay = await runtime.nextPaid();
  assert.equal(replay.record.requestId, first.record.requestId, 'an unfinished crash play is retried, never marked paid');
  await runtime.complete(replay.record, { playId: 'first-completed', audibleMs: 100, finished: true });
  let advertCalls = 0;
  const queue = combinePaidQueues({ songs: runtime, adverts: { nextPaid: async () => { advertCalls++; return null; } } });
  const second = await queue.nextPaid({ allowBump: true });
  assert.equal(second.record.requestId, 'lane:1');
  assert.equal(await queue.canPlay(second.record), true, 'later single cannot invalidate prefetched playlist audio');
  const third = await queue.nextPaid();
  assert.equal(await queue.canPlay(third.record), false, 'preloading is not permission to skip an unfinished lane');
  assert.equal(advertCalls, 0, 'not even an immediate advert is selected during the owned batch');
  await queue.complete(second.record, { playId: 'second-completed', audibleMs: 100, finished: true });
  assert.equal(await queue.canPlay(third.record), true);
  await queue.complete(third.record, { playId: 'third-completed', audibleMs: 100, finished: true });
  await runtime.reconcile();
  assert.equal(runtime.hasActivePlaylist(), false);
  assert.equal((await queue.nextPaid()).record.requestId, 'single:later', 'later community purchase plays after the complete batch');
  assert.equal(advertCalls, 1);
});

test('actual JukeLoop preloads an owned playlist while audio plays, without selecting adverts or an intentional song gap', async t => {
  const { JukeLoopSession } = await import('../discord-bot/jukeloop.js');
  const player = new EventEmitter();
  player.state = { status: 'playing' };
  player.stop = () => {};
  const session = new JukeLoopSession({ voiceChannel: { guild: { id: 'exclusive-prefetch' } }, client: {}, schedule: [],
    audioPlayer: player, djuke: { hasActivePlaylist: () => true, getActivePlaylistBatchId: () => '5',
      hasPendingPlaylist: () => true, release: async () => {}, nextPaid: async () => ({ record: { playlistBatchId: '5', playlistLaneId: '2',
        playlist: { batchId: '5', position: 2 } }, track: { trackId: 'paid-next', title: 'Paid next', ipfsCid: 'fixture' } }) },
    devertPlayback: { recordCompletedMusicPlay: async () => {},
      nextMainRadioAd: async () => { throw Error('Must not interrupt playlist'); } },
    createStream: () => { const stream = new PassThrough(); stream.write(Buffer.alloc(100));
      const ffmpegProcess = new EventEmitter(); ffmpegProcess.kill = () => stream.destroy();
      return { stream, ffmpegProcess }; } });
  t.after(() => { session._currentPaid = null; session.destroy(); });
  session._musicSinceAd = 20;
  session._getFreshUrl = async () => 'https://fixture.example/next';
  session._currentPaid = { playlistBatchId: '5' };
  session._primeNext();
  await session._prepareTask;
  assert.equal(session.getUpNext().trackId, 'paid-next', 'next paid recording is ready before current audio ends');
  assert.equal(session.getUpNext().djukePlaylist.position, 2, 'browsers can preload the actual next playlist file');
  const { buildRadioState } = await import('../discord-bot/jukeloop.js');
  assert.equal(buildRadioState({ upNext: session.getUpNext(), playlist: [] }).upNext.djukePlaylist.position, 2,
    'the public API preserves the preload playlist metadata');
  assert.ok(session._paidPollTimer, 'fresh playback authorization is checked while audio plays, without priority replacement');
  session._nowPlaying = { audible: true, playId: 'current', trackId: 'current', startedAt: Date.now() - 60000 };
  session._playNext = async () => {};
  session._collectReactions = async () => {};
  const before = Date.now();
  player.emit('idle', {});
  assert.ok(session._changeoverAt >= before && session._changeoverAt <= Date.now(),
    'no deliberate 2500ms dead space inside paid playlists');
});

test('preflight refresh moves canonical queue reads ahead of the song boundary but never reuses stale or failed verification', async t => {
  const { createDjukeRuntime, createDjukePlaybackJournal } = await import('../discord-bot/djuke.js');
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  let reads = 0, accountingReads = 0, fail = false;
  const request = { requestId: 'lane:1', playlistLaneId: '1', playlistBatchId: '1',
    trackId: 'song', songId: 'hash', revision: '0', playable: true };
  const runtime = createDjukeRuntime({ playbackStateCacheMs: 2000,
    journal: createDjukePlaybackJournal({ restore: async () => null, save: async () => 'ipfs://durable' }),
    readState: async () => { accountingReads++; return { requests: [request] }; },
    readPlaybackState: async () => { reads++; if (fail) throw Error('RPC unavailable'); return { requests: [request] }; },
    getTrack: trackId => ({ trackId }), fulfill: async () => {} });
  const selection = await runtime.nextPaid();
  await runtime.refreshPlaybackState();
  const before = reads;
  assert.equal(await runtime.canPlay(selection.record), true);
  assert.equal(reads, before, 'transition uses the recent confirmed preflight rather than a full RPC round trip');
  assert.equal(accountingReads, 1, 'preflight does not serialize behind financial event-checkpoint writes');
  t.mock.timers.tick(2001);
  assert.equal(await runtime.canPlay(selection.record), true); assert.equal(reads, before + 1);
  fail = true;
  await assert.rejects(runtime.refreshPlaybackState(), /RPC unavailable/);
  await assert.rejects(runtime.canPlay(selection.record), /RPC unavailable/, 'no success-shaped fallback to a previous snapshot');
});
