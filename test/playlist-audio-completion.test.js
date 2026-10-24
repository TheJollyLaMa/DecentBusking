const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createServer } = require('node:http');
const fs = require('node:fs');

async function decodedFixture({ bytes = 192000, code = null, end = true } = {}) {
  const { monitorAudioCompletion } = await import('../discord-bot/jukeloop.js');
  const input = new PassThrough(), child = new EventEmitter();
  child.exitCode = code;
  child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  const completion = monitorAudioCompletion(input, child);
  const consumed = (async () => { for await (const chunk of completion.stream) void chunk; })();
  if (end) { input.end(Buffer.alloc(bytes)); await consumed; }
  else { input.write(Buffer.alloc(bytes)); }
  return { completion, child, input, consumed };
}

test('clean PCM EOF waits for the matching delayed decoder exit instead of spending a media retry', async () => {
  const { completion, child } = await decodedFixture();
  assert.equal(child.exitCode === 0, false, 'the old Idle snapshot would classify this as unfinished');
  setTimeout(() => child.emit('exit', 0, null), 15);
  const result = await completion.finish({ playbackDuration: 1000 }, 100);
  assert.equal(result.finished, true);
  assert.equal(result.reason, 'clean_eof');
  assert.equal(result.decodedBytes, 192000);
  assert.equal(result.playedMs, result.decodedMs);
  assert.equal(child.killed, undefined);
});

test('readiness allows a successful process exit before its final stdout bytes arrive', async () => {
  const { waitForAudioReady } = await import('../discord-bot/jukeloop.js');
  const stream = new PassThrough(), child = new EventEmitter();
  child.kill = () => assert.fail('valid audio must not be killed');
  const ready = waitForAudioReady(stream, child, 100);
  child.emit('exit', 0, null);
  stream.end(Buffer.alloc(3840));
  await ready;
  stream.destroy();
});

test('completion rejects decoder errors, signals, missing exit evidence and unconsumed decoded audio', async () => {
  for (const [code, signal, played, expected] of [[1, null, 1000, 'decoder_failed'],
    [null, 'SIGTERM', 1000, 'decoder_signaled'], [null, null, 1000, 'decoder_exit_timeout'],
    [0, null, 900, 'decoded_audio_not_fully_played']]) {
    const { completion, child } = await decodedFixture({ code });
    if (signal) child.emit('exit', code, signal);
    const before = Date.now();
    const result = await completion.finish({ playbackDuration: played }, 20);
    assert.equal(result.finished, false);
    assert.equal(result.reason, expected);
    assert.ok(Date.now() - before < 500, 'an unknown process exit cannot hang the queue');
    assert.equal(child.killed, true);
  }
});

test('early Idle is not clean completion even if the decoder has exited successfully', async () => {
  const { completion, input, consumed } = await decodedFixture({ code: 0, end: false, bytes: 100 });
  assert.equal((await completion.finish({ playbackDuration: 1000 })).reason, 'audio_stream_incomplete');
  input.end();
  await consumed;
});

test('decoder diagnostics retain categories, never URLs or credential-bearing stderr', async () => {
  const { completion, child } = await decodedFixture({ code: 1 });
  child.stderr.write('HTTP error https://secret.example/ipfs/song?token=private-token; corrupt packet\n');
  const result = await completion.finish({ playbackDuration: 1000 });
  assert.deepEqual(result.warnings, ['network', 'decode']);
  assert.doesNotMatch(JSON.stringify(result), /secret\.example|private-token|https:/);
});

test('a scheduled stop releases the reservation without consuming media retries', async t => {
  const { JukeLoopSession } = await import('../discord-bot/jukeloop.js');
  const player = new EventEmitter();
  player.state = { status: 'idle' };
  player.play = resource => {
    const previous = player.state;
    player.state = { status: 'playing', resource };
    player.emit('stateChange', previous, player.state);
  };
  player.stop = () => { player.state = { status: 'idle' }; player.emit('idle'); };
  const releases = [], completions = [];
  const session = new JukeLoopSession({ audioPlayer: player, websitePlayback: true, client: {},
    schedule: [], djuke: { release: async (...args) => releases.push(args), complete: async (...args) => completions.push(args) },
    createStream: () => {
      const stream = new PassThrough(), child = new EventEmitter();
      stream.write(Buffer.alloc(192000));
      child.kill = () => { stream.destroy(); };
      return { stream, ffmpegProcess: child };
    } });
  t.after(() => session.destroy());
  session._primeNext = () => {};
  session._getFreshUrl = async () => 'https://media.example/song';
  const record = { requestId: 'playlist:1', playlistBatchId: '0', playlistLaneId: '1',
    trackId: 'paid', payer: `0x${'1'.repeat(40)}`, amountUnits: '250000' };
  const prepared = await session._prepareNextPlayback({ record, track: { trackId: 'paid', title: 'Paid song' } });
  session._startPrepared(prepared);
  const now = Date.now();
  session.setLivePerformanceEvents([{ id: 'live', title: 'Live rehearsal',
    startUtc: new Date(now - 1000).toISOString(), endUtc: new Date(now + 60000).toISOString() }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 1);
  assert.equal(releases[0][0], record);
  assert.match(releases[0][1].message, /scheduled_handoff/);
  assert.equal(completions.length, 0);
});

function wav(seconds = 0.16) {
  const pcm = Buffer.alloc(Math.round(48000 * seconds) * 4);
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(48000, 24); header.writeUInt32LE(192000, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function serveMedia(req, res, bytes) {
  res.setHeader('Accept-Ranges', 'bytes');
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if (range) {
    const start = Number(range[1]), end = Math.min(bytes.length - 1, range[2] ? Number(range[2]) : bytes.length - 1);
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
    bytes = bytes.subarray(start, end + 1);
  }
  res.setHeader('Content-Length', bytes.length);
  res.end(bytes);
}

test('real FFmpeg rejects a truncated recording before it can be classified as delivered', async t => {
  const { createFFmpegStream, monitorAudioCompletion } = await import('../discord-bot/jukeloop.js');
  const full = wav(1), truncated = full.subarray(0, 10045);
  const server = createServer((req, res) => { res.end(truncated); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const source = createFFmpegStream(`http://127.0.0.1:${server.address().port}/truncated.wav`);
  t.after(() => source.ffmpegProcess.kill());
  const completion = monitorAudioCompletion(source.stream, source.ffmpegProcess);
  for await (const chunk of completion.stream) void chunk;
  const result = await completion.finish({ playbackDuration: 1000 });
  assert.equal(result.finished, false);
  assert.equal(result.reason, 'decoder_failed');
  assert.ok(result.warnings.includes('decode'));
});

test('twelve real player EOFs settle once in order, with incident media optionally in the fifth slot', { timeout: 240000 }, async t => {
  const { JukeLoopSession } = await import('../discord-bot/jukeloop.js');
  const { createDjukeRuntime, createDjukePlaybackJournal } = await import('../discord-bot/djuke.js');
  const { combinePaidQueues } = await import('../discord-bot/devert-queue.js');
  const incident = process.env.DJUKE_INCIDENT_MEDIA ? fs.readFileSync(process.env.DJUKE_INCIDENT_MEDIA) : null;
  const short = wav();
  const server = createServer((req, res) => serveMedia(req, res, incident && req.url === '/paid-4' ? incident : short));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  let requests = Array.from({ length: 12 }, (_, i) => ({
    requestId: `playlist:${i}`, playlistLaneId: String(i), playlistBatchId: '0',
    songId: `0x${String(i + 1).padStart(64, '0')}`, revision: '0', trackId: `paid-${i}`,
    payer: `0x${'1'.repeat(40)}`, amountUnits: '250000', playable: true,
  }));
  const journal = createDjukePlaybackJournal({ restore: async () => null, save: async () => 'ipfs://test-checkpoint' });
  const deliveries = [], starts = [], evidence = [];
  let refunds = 0, resolveAll, rejectAll;
  const all = new Promise((resolve, reject) => { resolveAll = resolve; rejectAll = reject; });
  const runtime = createDjukeRuntime({ journal, minAudibleMs: 1,
    readState: async () => ({ requests: structuredClone(requests.slice(0, 1)), playlistPending: requests.length }),
    getTrack: trackId => ({ trackId, title: trackId }),
    fulfill: async ({ playlistLaneId }) => {
      deliveries.push(playlistLaneId);
      requests = requests.filter(request => request.playlistLaneId !== playlistLaneId);
      if (!requests.length) resolveAll();
    },
    refundPlaylistBatch: async () => { refunds++; rejectAll(new Error('A clean recording must never trigger a refund')); } });
  await runtime.reconcile();
  const paid = combinePaidQueues({ songs: runtime });
  const complete = paid.complete;
  paid.complete = async (record, play) => {
    evidence.push({ record, play });
    return complete(record, play);
  };
  const session = new JukeLoopSession({ websitePlayback: true, client: { isReady: () => false }, schedule: [], djuke: paid });
  t.after(() => session.destroy());
  session._getFreshUrl = async track => `http://127.0.0.1:${server.address().port}/${track.trackId}`;
  session._primeNext = () => {};
  session._sleep = async () => {};
  const start = session._startPrepared.bind(session);
  session._startPrepared = prepared => { starts.push(prepared.track.trackId); return start(prepared); };
  await session._playNext();
  await all;
  await runtime.reconcile();
  session.destroy();
  assert.deepEqual(deliveries, Array.from({ length: 12 }, (_, i) => String(i)));
  assert.deepEqual(starts, Array.from({ length: 12 }, (_, i) => `paid-${i}`));
  assert.equal(new Set(evidence.map(({ play }) => play.playId)).size, 12);
  assert.ok(evidence.every(({ play }) => play.finished && play.media.reason === 'clean_eof'));
  assert.equal(journal.getState().filter(record => record.state === 'fulfilled').length, 12);
  assert.equal(refunds, 0);
  if (incident) {
    assert.ok(evidence[4].play.audibleMs >= 160000, 'the incident recording must be consumed in real time');
    assert.ok(evidence[4].play.media.decodedMs >= 167000);
    t.diagnostic(JSON.stringify(evidence[4].play.media));
  }
});
