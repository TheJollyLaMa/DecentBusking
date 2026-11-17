const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { verifiedRecording } = require('./helpers/verified-recording');

test('radio completion diagnostics distinguish normal, truncated, unknown and boundary durations', async () => {
  const { expectedRecordingMs, radioCompletionDiagnostics } = await import('../js/radio-duration.mjs');
  const track = verifiedRecording({ trackId: 'incident', ipfsCid: 'recording' }, 240);
  const expectedMs = expectedRecordingMs(track);
  assert.equal(expectedMs, 240000);
  for (const [audibleMs, short] of [[221858, true], [237999, true], [238000, false],
    [240000, false], [241000, false], [0, true]]) {
    const result = radioCompletionDiagnostics(audibleMs, expectedMs);
    assert.deepEqual(result, { expectedMs, completionRatio: audibleMs / expectedMs, short, shortToleranceMs: 2000 });
  }
  for (const invalid of [undefined, null, 0, -1, NaN, Infinity, '240000', Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(radioCompletionDiagnostics(221858, invalid),
      { expectedMs: null, completionRatio: null, short: null, shortToleranceMs: 2000 });
  }
  for (const audibleMs of [undefined, NaN, Infinity, -1]) {
    const result = radioCompletionDiagnostics(audibleMs, expectedMs);
    assert.equal(result.completionRatio, null);
    assert.equal(result.short, null);
  }
  assert.equal(expectedRecordingMs({ ...track, ipfsCid: 'different-media' }), null);
  assert.equal(expectedRecordingMs({ ...track, durationSeconds: 239 }), null);
  assert.equal(expectedRecordingMs({ durationSeconds: 240 }), null, 'unverified metadata is not evidence');
  assert.equal(expectedRecordingMs(verifiedRecording({ trackId: 'long-set' }, 1200)), 1200000);
  assert.equal(radioCompletionDiagnostics(0, 1500).short, false, 'the fixed diagnostic tolerance also applies to tiny clips');
});

test('real FFmpeg decodes exact audio durations on both sides of the ten-minute boundary', async t => {
  const { probeMediaDuration } = await import('../discord-bot/media-duration.js');
  const { recordingDurationProof, verifiedRecordingDuration, recordingDurationReason } = await import('../js/radio-duration.mjs');
  const server = createServer((request, response) => {
    const samples = Number(request.url.slice(1).split('?')[0]);
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(1000, 24); wav.writeUInt32LE(2000, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
    const media = request.url.includes('?truncated') ? wav.subarray(0, 1000) : wav;
    response.writeHead(200, { 'content-type': 'audio/wav', 'content-length': media.length });
    response.end(media);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  for (const seconds of [599.999, 600, 600.001, 1200]) {
    const measured = await probeMediaDuration(`http://127.0.0.1:${server.address().port}/${Math.round(seconds * 1000)}`);
    assert.equal(measured, seconds);
    const track = { trackId: String(seconds), durationSeconds: measured };
    track.durationVerification = recordingDurationProof(track, measured, 'ffmpeg-decode');
    assert.equal(verifiedRecordingDuration(track), seconds);
    assert.equal(recordingDurationReason(track) === null, seconds <= 600);
  }
  await assert.rejects(probeMediaDuration(`http://127.0.0.1:${server.address().port}/600000?truncated`), /probe failed/);
});

test('sample-range duration proof is source-bound and keeps the strict 600-second threshold', async () => {
  const { recordingSampleRangeProof, verifiedRecordingDuration, recordingDurationReason } =
    await import('../js/radio-duration.mjs');
  for (const [samples, longForm] of [[28_800_000, false], [28_800_048, true]]) {
    const track = {
      ipfsCid: 'cut-output-cid', durationSamples: samples, sampleRate: 48_000,
      durationSeconds: samples / 48_000,
      catalogRecording: { sourceCid: 'original-source-cid', startSample: 120, endSample: 120 + samples },
    };
    track.durationVerification = recordingSampleRangeProof(track, {
      sourceCid: 'original-source-cid', startSample: 120, endSample: 120 + samples,
    });
    assert.equal(verifiedRecordingDuration(track), samples / 48_000);
    assert.equal(recordingDurationReason(track, { longForm: true }) === null, longForm);
    assert.equal(recordingDurationReason(track, { longForm: false }) === null, !longForm);
    assert.equal(verifiedRecordingDuration({ ...track, durationSamples: samples - 1 }), null);
    assert.throws(() => recordingSampleRangeProof(track, {
      sourceCid: 'other-source-cid', startSample: 120, endSample: 120 + samples,
    }), /Invalid sample-derived/);
  }
});

test('backfill is bounded, serialized, persistent and retryable; failed probes never create short eligibility', async () => {
  const { createDurationBackfill } = await import('../discord-bot/media-duration.js');
  const { recordingDurationProof, verifiedRecordingDuration } = await import('../js/radio-duration.mjs');
  let now = 100000;
  const tracks = [{ trackId: 'broken' }, { trackId: 'long' }, verifiedRecording({ trackId: 'known' })];
  const writes = [], errors = [];
  let calls = 0, broken = true;
  const worker = createDurationBackfill({ getTracks: () => tracks, now: () => now, batchSize: 1,
    resolveUrl: async track => `https://example.test/${track.trackId}`,
    probe: async url => { calls++; if (url.endsWith('broken') && broken) throw new Error('Corrupt media'); return 1200; },
    save: async (id, result) => {
      writes.push(result.status);
      const track = tracks.find(t => t.trackId === id);
      track.durationProbe = result;
      if (result.status === 'verified') {
        track.durationSeconds = result.seconds;
        track.durationVerification = recordingDurationProof(track, result.seconds, 'ffmpeg-decode', now);
      }
    }, log: { warn: (...args) => errors.push(args) } });
  const first = worker.run();
  assert.equal(worker.run(), first);
  await first;
  assert.equal(calls, 1);
  assert.equal(verifiedRecordingDuration(tracks[0]), null);
  assert.equal(errors.length, 1);
  await worker.run();
  assert.equal(verifiedRecordingDuration(tracks[1]), 1200);
  await worker.run();
  assert.equal(calls, 2, 'failed item is held until its recorded retry time');
  now += 60000; broken = false;
  await worker.run();
  assert.equal(verifiedRecordingDuration(tracks[0]), 1200);
  assert.deepEqual(writes, ['pending', 'failed', 'pending', 'verified', 'pending', 'verified']);
  worker.close();
});

test('lookup deadlines and storage failures are explicit, bounded and do not verify an unresolved recording', async t => {
  const { createDurationBackfill } = await import('../discord-bot/media-duration.js');
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  const writes = [], errors = [];
  const worker = createDurationBackfill({ getTracks: () => [{ trackId: 'stuck' }],
    resolveUrl: () => new Promise(() => {}), timeoutMs: 10,
    probe: () => assert.fail('an unresolved URL cannot be probed'),
    save: async (_, result) => writes.push(result), log: { warn: (...args) => errors.push(args) } });
  t.after(() => worker.close());
  await worker.run();
  assert.deepEqual(writes.map(item => item.status), ['pending', 'failed']);
  assert.match(writes[1].error, /deadline/);
  assert.equal(errors.length, 1);
  const unavailable = createDurationBackfill({ getTracks: () => [{ trackId: 'unpersisted' }],
    resolveUrl: () => assert.fail('do not probe without recording the attempt'),
    save: async () => { throw new Error('Checkpoint unavailable'); } });
  await assert.rejects(unavailable.run(), /Checkpoint unavailable/);
  unavailable.close();
});
