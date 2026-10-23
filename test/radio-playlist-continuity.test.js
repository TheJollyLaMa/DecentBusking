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
