const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

async function fixture() {
  const { createDjukeRuntime, createDjukePlaybackJournal } = await import('../discord-bot/djuke.js');
  const item = { requestId: 'playlist:3', playlistLaneId: '3', playlistBatchId: '1',
    songId: `0x${'a'.repeat(64)}`, trackId: 'third-song', revision: '0', playable: true };
  let snapshot = null, requests = [item], refunds = 0, settlements = 0;
  const store = { restore: async () => structuredClone(snapshot),
    save: async value => { snapshot = structuredClone(value); return 'ipfs://durable'; } };
  const make = () => {
    const journal = createDjukePlaybackJournal(store);
    const runtime = createDjukeRuntime({ journal,
      readState: async () => ({ requests, playlistPending: requests.length }),
      getTrack: trackId => ({ trackId, title: 'Third playlist song' }),
      fulfill: async () => { settlements++; requests = []; },
      refundPlaylistBatch: async batchId => { assert.equal(batchId, '1'); refunds++; requests = []; },
      log: { warn() {} } });
    return { journal, runtime };
  };
  return { make, get refunds() { return refunds; }, get settlements() { return settlements; } };
}

test('three media retries survive restarts; scheduling releases do not use the budget; only the fourth failure refunds', async () => {
  const f = await fixture();
  for (let failure = 1; failure <= 4; failure++) {
    const { runtime, journal } = f.make();
    const selection = await runtime.nextPaid();
    if (failure === 1) {
      await runtime.release(selection.record, new Error('Scheduled show starts'));
      assert.equal(journal.getState()[0].mediaFailures, undefined);
    }
    const current = failure === 1 ? await runtime.nextPaid() : selection;
    const result = await runtime.retryMedia(current.record, new Error('Temporary audio preparation timeout'));
    assert.equal(journal.getState()[0].mediaFailures, failure);
    assert.equal(result.retrying, failure <= 3);
    assert.equal(f.refunds, failure <= 3 ? 0 : 1);
    assert.equal(f.settlements, 0, 'unheard recordings never settle');
  }
});

test('partial playlist audio is retried, not falsely settled even when more than thirty seconds were audible', async () => {
  const f = await fixture();
  const { runtime, journal } = f.make();
  const selection = await runtime.nextPaid();
  const result = await runtime.complete(selection.record, { playId: 'interrupted',
    audibleMs: 120000, finished: false });
  assert.equal(result.retrying, true);
  assert.equal(journal.getState()[0].state, 'pending');
  assert.equal(journal.getState()[0].mediaFailures, 1);
  assert.equal(f.settlements, 0);
  assert.equal(f.refunds, 0);
});

test('failure evidence follows the latest attempt and distinguishes clean EOF from sufficient audible time', async () => {
  const f = await fixture();
  const { runtime, journal } = f.make();
  const first = await runtime.nextPaid();
  await runtime.complete(first.record, { playId: 'too-short', audibleMs: 100,
    finished: true, media: { reason: 'clean_eof', exitCode: 0 } });
  assert.equal(journal.getState()[0].lastMedia.reason, 'insufficient_audible_time');
  const second = await runtime.nextPaid();
  await runtime.retryMedia(second.record, new Error('Preparation timed out'));
  assert.equal(journal.getState()[0].lastMedia, undefined, 'a preparation failure must not inherit a previous EOF diagnosis');
  assert.equal(journal.getState()[0].mediaFailures, 2);
  assert.equal(f.settlements, 0);
});

test('an exhausted song is not replayed after a refund failure or worker restart', async () => {
  const { createDjukeRuntime, createDjukePlaybackJournal } = await import('../discord-bot/djuke.js');
  const item = { requestId: 'playlist:4', playlistLaneId: '4', playlistBatchId: '0',
    songId: `0x${'a'.repeat(64)}`, trackId: 'fifth', revision: '0', playable: true };
  let snapshot, refundAttempts = 0;
  const make = () => createDjukeRuntime({
    journal: createDjukePlaybackJournal({ restore: async () => structuredClone(snapshot),
      save: async value => { snapshot = structuredClone(value); return 'ipfs://durable'; } }),
    readState: async () => ({ requests: [item], playlistPending: 1 }),
    getTrack: trackId => ({ trackId }), fulfill: async () => assert.fail('must not settle'),
    refundPlaylistBatch: async () => { refundAttempts++; if (refundAttempts === 1) throw new Error('RPC unavailable'); },
    log: { warn() {} },
  });
  const runtime = make();
  for (let failure = 1; failure <= 4; failure++) {
    const selection = await runtime.nextPaid();
    const result = runtime.retryMedia(selection.record, new Error('Decoder failed'), { reason: 'decoder_failed', exitCode: 1 });
    if (failure === 4) await assert.rejects(result, /RPC unavailable/);
    else await result;
  }
  const restarted = make();
  assert.equal(await restarted.nextPaid(), null, 'only retry the refund, not a fifth media attempt');
  assert.equal(refundAttempts, 2);
  assert.equal(snapshot.records[0].attempts, 4);
  assert.equal(snapshot.records[0].mediaFailures, 4);
  assert.equal(snapshot.records[0].lastMedia.reason, 'decoder_failed');
});

test('real preparation timeouts hold rotation, back off, and recover on the third retry without refund or new payment', async t => {
  const { JukeLoopSession } = await import('../discord-bot/jukeloop.js');
  const { combinePaidQueues } = await import('../discord-bot/devert-queue.js');
  const f = await fixture();
  const { runtime, journal } = f.make();
  await runtime.reconcile();
  let preparations = 0;
  const session = new JukeLoopSession({ voiceChannel: { guild: { id: 'playlist-retry-recovery' } }, client: {},
    schedule: [], djuke: combinePaidQueues({ songs: runtime }), audioReadyTimeoutMs: 5,
    createStream: () => {
      preparations++;
      const stream = new PassThrough(), ffmpegProcess = new EventEmitter();
      ffmpegProcess.kill = () => { stream.destroy(); };
      if (preparations === 4) stream.write(Buffer.from('ready audio'));
      return { stream, ffmpegProcess };
    } });
  t.after(() => session.destroy());
  session._queue = [{ trackId: 'ordinary', title: 'Must not cut in' }];
  session._getFreshUrl = async () => 'https://media.example/third-song';
  for (let retry = 1; retry <= 3; retry++) {
    session._djukeCooldownUntil = 0;
    const before = Date.now();
    assert.equal(await session._prepareNextPlayback(), null);
    assert.match(session.getPlaybackStatus().reason, new RegExp(`retry ${retry}/3`));
    assert.ok(session._djukeCooldownUntil >= before + 5000 * 2 ** (retry - 1));
    assert.equal(f.refunds, 0);
    assert.equal(journal.getState()[0].state, 'pending');
    assert.equal(await session._prepareNextPlayback(), null, 'cooldown holds ordinary rotation too');
  }
  session._djukeCooldownUntil = 0;
  const recovered = await session._prepareNextPlayback();
  assert.equal(recovered.track.trackId, 'third-song');
  assert.equal(preparations, 4, 'initial attempt plus three retries');
  await runtime.complete(recovered.paid.record, { playId: 'finished', audibleMs: 180000, finished: true });
  await runtime.reconcile();
  assert.equal(f.refunds, 0);
  assert.equal(f.settlements, 1);
  session._disposePrepared({ ...recovered, paid: null });
});

test('unavailable media URLs use the same durable playlist retry budget rather than refunding immediately', async t => {
  const { JukeLoopSession } = await import('../discord-bot/jukeloop.js');
  const { combinePaidQueues } = await import('../discord-bot/devert-queue.js');
  const f = await fixture();
  const { runtime, journal } = f.make();
  const session = new JukeLoopSession({ voiceChannel: { guild: { id: 'playlist-url-retry' } },
    client: {}, schedule: [], djuke: combinePaidQueues({ songs: runtime }) });
  t.after(() => session.destroy());
  session._queue = [{ trackId: 'ordinary' }];
  session._getFreshUrl = async () => null;
  assert.equal(await session._prepareNextPlayback(), null);
  assert.equal(journal.getState()[0].mediaFailures, 1);
  assert.equal(f.refunds, 0);
  session._djukeCooldownUntil = 0;
  session._getFreshUrl = async () => { throw new Error('Gateway request timed out'); };
  assert.equal(await session._prepareNextPlayback(), null);
  assert.equal(journal.getState()[0].mediaFailures, 2, 'thrown lookup errors also release the reservation for retry');
  assert.equal(f.refunds, 0);
});
