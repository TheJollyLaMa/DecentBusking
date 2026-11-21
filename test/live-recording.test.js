const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet } = require('../discord-bot/node_modules/ethers');
const { createHash } = require('node:crypto');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { liveRecordingRelease } = require('./helpers/live-recording-release.js');
const playlistDir = join(__dirname, `.live-recording-fixtures-${process.pid}`);
require('node:fs').mkdirSync(playlistDir, { recursive: true });
process.env.JUKELOOP_PLAYLIST_PATH = join(playlistDir, 'playlist.json');
test.after(() => rm(playlistDir, { recursive: true, force: true }));

const START = Date.parse('2026-11-14T02:00:00Z'), ORIGIN = 'https://radio.example';
const artist = Wallet.createRandom();
const booking = { id: 'synthetic-recording-test', wallet: artist.address, title: 'Synthetic fixture',
  startUtc: new Date(START).toISOString(), endUtc: new Date(START + 20000).toISOString() };
const frame = () => ({ sampleRate: 48000, channels: 1, data: new Int16Array(48000), samplesPerChannel: 48000 });

async function setup(options = {}) {
  const { createLiveRecorder } = await import('../discord-bot/live-recording.js');
  const { liveRecordingConsentMessage } = await import('../js/live-recording-consent.mjs');
  const { recordingReleaseApprovalMessage } = await import('../js/live-recording-edit.mjs');
  let time = START - 1000, state = { version: 1, recordings: [] }, submissions = [];
  const blobs = new Map(), errors = [];
  const store = { restore: async () => structuredClone(state), save: async next => { state = structuredClone(next); } };
  const upload = async bytes => {
    const cid = createHash('sha256').update(bytes).digest('hex');
    blobs.set(cid, Buffer.from(bytes)); return `ipfs://${cid}`;
  };
  const args = { enabled: true, store, upload, download: async cid => blobs.get(cid),
    ingest: async value => { submissions.push(value); return { trackId: `fixture:${value.release.releaseId}` }; },
    encode: async () => Buffer.from('encoded-fixture'), segmentSeconds: 1, persistFrameTimes: false, now: () => time,
    log: { error: (...args) => errors.push(args.join(' ')) }, ...options };
  const recorder = createLiveRecorder(args);
  const approve = async (choice = 'full', signer = artist, target = recorder) => {
    const edit = await target.editState(booking), issuedAt = time, draft = choice === 'defer' ? null : edit.draft;
    const message = recordingReleaseApprovalMessage({ bookingId: booking.id, wallet: booking.wallet,
      origin: ORIGIN, sourceCid: edit.sourceCid, sourceSamples: edit.sourceSamples,
      choice, draft, issuedAt, incomplete: edit.incomplete });
    const signature = await signer.signMessage(message);
    return target.approveEdit(booking, { choice, issuedAt, signature }, signer.address, ORIGIN);
  };
  const permission = async (enabled = true, signer = artist, issuedAt = time, origin = ORIGIN, b = booking) => ({
    enabled, issuedAt, signature: await signer.signMessage(liveRecordingConsentMessage({
      bookingId: b.id, wallet: b.wallet, origin, issuedAt, enabled })),
  });
  await recorder.initialize();
  return { recorder, args, permission, blobs, errors, submissions, store, approve,
    at: value => { time = value; }, state: () => state };
}

test('recording is off by default, excludes private audio and requires exact performer permission', async () => {
  const s = await setup();
  s.recorder.capture(booking, frame()); await s.recorder.flush();
  assert.equal(s.blobs.size, 0); assert.equal(s.recorder.status(booking).consented, false);
  await assert.rejects(s.recorder.consent(booking, await s.permission(true, Wallet.createRandom()), artist.address, ORIGIN), /signature/);
  await assert.rejects(s.recorder.consent(booking, await s.permission(), Wallet.createRandom().address, ORIGIN), /performer/);
  await assert.rejects(s.recorder.consent(booking, await s.permission(), artist.address, 'https://other.example'), /signature/);
  await s.recorder.consent(booking, await s.permission(), artist.address, ORIGIN);
  s.recorder.capture(booking, frame()); await s.recorder.flush();
  assert.equal(s.blobs.size, 0, 'consent never authorizes soundchecks');
  s.at(START);
  const audio = frame(); audio.data[0] = 1234;
  s.recorder.capture(booking, audio); audio.data[0] = 4321;
  await s.recorder.flush();
  assert.equal([...s.blobs.values()][0].readInt16LE(44), 1234, 'native frame memory copied before reuse');
  assert.equal(s.recorder.deploymentState().ready, false);
  s.at(START + 20000); s.recorder.capture(booking, frame());
  await s.recorder.tick([booking]);
  assert.equal(s.submissions.length, 0, 'finalization does not create a mint request');
  assert.equal(s.recorder.status(booking).status, 'ready');
  assert.equal(s.recorder.status(booking).editAvailable, true);
  const releaseState = await s.approve('full');
  assert.equal(s.submissions.length, 1);
  assert.equal(s.submissions[0].source.durationSamples, 48000);
  assert.equal(s.submissions[0].incomplete, true);
  assert.equal(releaseState.releases[0].choice, 'full');
  assert.equal(s.recorder.deploymentState().ready, true);
  await s.recorder.tick([booking]); assert.equal(s.submissions.length, 1);
});

test('revocation is durable, rejects replay and does not publish an opted-out recording', async () => {
  const s = await setup();
  const old = await s.permission();
  await s.recorder.consent(booking, old, artist.address, ORIGIN);
  s.at(START); s.recorder.capture(booking, frame()); await s.recorder.flush();
  s.at(START + 1000);
  await s.recorder.consent(booking, await s.permission(false), artist.address, ORIGIN);
  await assert.rejects(s.recorder.consent(booking, old, artist.address, ORIGIN), /expired/);
  s.recorder.capture(booking, frame()); s.at(START + 20000); await s.recorder.tick([booking]);
  assert.equal(s.submissions.length, 0); assert.equal(s.state().recordings[0].consent.enabled, false);
  assert.equal(s.recorder.deploymentState().ready, true);
});

test('private maintenance release preserves opt-out across deployment and accepts fresh allocated recording consent', async () => {
  const s = await setup();
  const b = { ...booking, acknowledged: true, status: 'funded', broadcast: {
    actualStartedAt: null, actualEndedAt: null, plannedStartAt: START + 60000, accessUntil: START + 180000,
  } };
  s.at(START + 30000);
  await s.recorder.consent(b, await s.permission(true, artist, START + 30000, ORIGIN, b), artist.address, ORIGIN);
  s.at(START + 31000);
  await s.recorder.consent(b, await s.permission(false, artist, START + 31000, ORIGIN, b), artist.address, ORIGIN);
  const lease = { id: 'preflight-maintenance', expiresAt: START + 150000, bookings: [b] };
  assert.deepEqual(await s.recorder.prepareDeployment(lease), { ready: false }, 'Open allocated slot still prevents replacement');
  b.broadcast.actualEndedAt = START + 31000;
  assert.deepEqual(await s.recorder.prepareDeployment(lease), { ready: true, recordingCheckpointVerified: true });
  const { createLiveRecorder } = await import('../discord-bot/live-recording.js');
  const { liveRecordingConsentMessage, LIVE_RECORDING_ALLOCATED_CONSENT_VERSION } = await import('../js/live-recording-consent.mjs');
  const replacement = createLiveRecorder(s.args);
  await replacement.initialize();
  b.broadcast.actualEndedAt = null;
  assert.equal(replacement.status(b).consented, false);
  s.at(START + 32000);
  const input = { enabled: true, issuedAt: START + 32000, consentVersion: LIVE_RECORDING_ALLOCATED_CONSENT_VERSION };
  input.signature = await artist.signMessage(liveRecordingConsentMessage({ bookingId: b.id, wallet: b.wallet,
    origin: ORIGIN, issuedAt: input.issuedAt, enabled: true, version: input.consentVersion }));
  await replacement.consent(b, input, artist.address, ORIGIN);
  replacement.capture(b, frame()); await replacement.flush();
  assert.equal(s.blobs.size, 0, 'Reopened private audio is still not recorded');
  b.broadcast.actualStartedAt = START + 32000;
  b.broadcast.authorizedEndAt = START + 52000;
  replacement.capture(b, frame()); await replacement.flush();
  assert.equal(s.blobs.size, 1, 'Fresh consent records the actually started delayed set');
  assert.equal(s.submissions.length, 0);
  s.at(START + 33000);
  b.broadcast.actualEndedAt = START + 33000;
  b.broadcast.endReason = 'producer-finished';
  await replacement.tick([b]);
  assert.equal(replacement.status(b).editAvailable, true, 'The recovered recording opens in the afterparty editor');
  assert.equal(s.submissions.length, 0, 'Finishing still requires a separate performer release approval');
  await s.approve('full', artist, replacement);
  assert.equal(s.submissions.length, 1);
});

test('failed consent persistence captures nothing; failed finalization retries without duplicate ingestion', async () => {
  const s = await setup();
  const original = s.store.save;
  s.store.save = async () => { throw Error('journal offline'); };
  await assert.rejects(s.recorder.consent(booking, await s.permission(), artist.address, ORIGIN), /offline/);
  s.at(START); s.recorder.capture(booking, frame()); await s.recorder.flush();
  assert.equal(s.blobs.size, 0);
  s.store.save = original;
  await s.recorder.consent(booking, await s.permission(), artist.address, ORIGIN);
  s.recorder.capture(booking, frame()); await s.recorder.flush();
  let attempts = 0;
  const { createLiveRecorder } = await import('../discord-bot/live-recording.js');
  const restarted = createLiveRecorder({ ...s.args, ingest: async value => {
    if (++attempts === 1) throw Error('playlist unavailable');
    return s.args.ingest(value);
  } });
  await restarted.initialize();
  s.at(START + 20000);
  await restarted.tick([booking]); assert.equal(restarted.status(booking).status, 'ready');
  assert.equal(restarted.deploymentState().ready, true);
  await assert.rejects(s.approve('full', artist, restarted), /playlist unavailable/);
  await s.approve('full', artist, restarted);
  assert.equal(attempts, 2); assert.equal(s.submissions.length, 1); assert.equal(s.submissions[0].incomplete, true);
});

test('twenty-minute real PCM finalizes to a playable MP3 with measured duration and bounded segments', async t => {
  const { pcmWav, encodeRecording } = await import('../discord-bot/live-recording.js');
  const pcm = Buffer.alloc(48000 * 2 * 30);
  for (let n = 0; n < pcm.length / 2; n++) pcm.writeInt16LE(Math.round(Math.sin(n / 48000 * 440 * 2 * Math.PI) * 4000), n * 2);
  const wav = pcmWav(pcm), start = Date.now();
  const result = await encodeRecording(Array.from({ length: 40 }, () => ({ cid: 'fixture', bytes: pcm.length })),
    async () => wav, { workDirectory: playlistDir });
  const elapsedMs = Date.now() - start;
  const dir = await mkdtemp(join(playlistDir, 'dbusk-encode-test-'));
  try {
    const file = join(dir, 'fixture.mp3'); await writeFile(file, result);
    const probe = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    assert.match(probe.stderr, /Duration: 00:20:00\.\d+/);
    assert.ok(result.length > 20000000 && result.length < 35000000);
    assert.ok(elapsedMs < 120000, `finalization took ${elapsedMs}ms`);
    t.diagnostic(`20-minute audio: ${result.length} bytes, encoded in ${elapsedMs}ms; full decode succeeded`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('preserved consented recording retries an authenticated segment failure once without duplicate mint intake', async () => {
  const { createLiveRecorder, downloadRecordingSegment } = await import('../discord-bot/live-recording.js');
  const s = await setup();
  await s.recorder.consent(booking, await s.permission(), artist.address, ORIGIN);
  s.at(START); s.recorder.capture(booking, frame()); await s.recorder.flush();
  const saved = structuredClone(s.state().recordings[0]);
  let unauthorized = true, uploads = 0;
  const recorder = createLiveRecorder({ ...s.args,
    download: cid => downloadRecordingSegment(cid, {
      gateway: 'https://recording.example/ipfs/?pinataGatewayToken=fixture-token',
      fetchImpl: async url => {
        const target = new URL(url);
        assert.equal(target.searchParams.get('pinataGatewayToken'), 'fixture-token');
        assert.equal(target.pathname, `/ipfs/${cid}`);
        return unauthorized ? new Response('', { status: 401 }) : new Response(s.blobs.get(cid));
      },
    }),
    encode: async (segments, download) => {
      for (const segment of segments) assert.equal((await download(segment.cid)).length, segment.bytes + 44);
      return Buffer.from('verified-encoded-fixture');
    },
    upload: async bytes => { uploads++; return s.args.upload(bytes); },
  });
  await recorder.initialize(); s.at(START + 20000);
  await recorder.tick([booking]);
  assert.equal(recorder.status(booking).status, 'processing');
  assert.equal(s.submissions.length, 0);
  assert.equal(uploads, 0);
  assert.deepEqual(s.state().recordings[0].consent, saved.consent);
  assert.deepEqual(s.state().recordings[0].segments, saved.segments);
  assert.match(recorder.status(booking).error, /401/);
  unauthorized = false;
  await recorder.tick([booking]); await recorder.tick([booking]);
  assert.equal(recorder.status(booking).status, 'ready');
  await s.approve('full', artist, recorder);
  assert.equal(s.submissions.length, 1);
  assert.equal(uploads, 1);
  assert.equal(recorder.deploymentState().ready, true);
});

test('replacement recorder preserves the original and only queues the full set after performer approval', async () => {
  const { createLiveRecorder } = await import('../discord-bot/live-recording.js');
  const s = await setup();
  await s.recorder.consent(booking, await s.permission(), artist.address, ORIGIN);
  s.at(START); s.recorder.capture(booking, frame()); await s.recorder.flush();
  const preserved = structuredClone(s.state().recordings[0]);
  let encodes = 0, uploads = 0;
  const old = createLiveRecorder({ ...s.args,
    encode: async () => { encodes++; return Buffer.from('encoded-before-handoff'); },
    upload: async bytes => { uploads++; return s.args.upload(bytes); },
    ingest: async () => { throw Error('No mint intake is allowed before explicit approval'); },
  });

  await old.initialize(); s.at(START + 20000); await old.tick([booking]);
  assert.equal(old.deploymentState().ready, true);
  assert.equal(s.state().recordings[0].status, 'ready');
  assert.ok(s.state().recordings[0].result);
  assert.deepEqual(s.state().recordings[0].consent, preserved.consent);
  assert.deepEqual(s.state().recordings[0].segments, preserved.segments);
  const replacement = createLiveRecorder({ ...s.args,
    ingest: async value => {
      s.submissions.push(value);
      return { trackId: `fixture:${value.release.releaseId}` };
    },
    encode: async () => { throw Error('Already-checkpointed MP3 must not be re-encoded'); },
    upload: async () => { throw Error('Already-checkpointed MP3 must not be uploaded again'); },
  });
  await replacement.initialize();
  assert.equal(replacement.deploymentState().ready, true);
  await s.approve('full', artist, replacement);
  assert.equal(replacement.deploymentState().ready, true);
  assert.equal(s.submissions.length, 1);
  assert.equal(encodes, 1); assert.equal(uploads, 1);
});

test('a finalization outage does not mark fully captured audio incomplete or block the next performer capture', async () => {
  let fail = true;
  const s = await setup({ encode: async () => {
    if (fail) throw Error('fixture download outage');
    return Buffer.from('encoded');
  } });
  await s.recorder.consent(booking, await s.permission(), artist.address, ORIGIN);
  for (let second = 0; second < 20; second++) {
    s.at(START + second * 1000);
    s.recorder.capture(booking, frame());
    await s.recorder.flush();
  }
  s.at(START + 20000); await s.recorder.tick([booking]);
  assert.match(s.recorder.status(booking).error, /download outage/);
  fail = false;
  await s.recorder.tick([booking]);
  assert.equal(s.submissions.length, 0, 'successful finalization still waits for performer approval');
  await s.approve('full');
  assert.equal(s.submissions[0].incomplete, false, 'Delivery failure is not missing captured audio');
  assert.equal(s.recorder.status(booking).error, '');
  const next = { ...booking, id: 'second-performer', startUtc: new Date(START + 30000).toISOString(),
    endUtc: new Date(START + 50000).toISOString() };
  await s.recorder.consent(next, await s.permission(true, artist, START + 20000, ORIGIN, next), artist.address, ORIGIN);
  s.at(START + 30000); s.recorder.capture(next, frame()); await s.recorder.flush();
  assert.equal(s.state().recordings.find(r => r.bookingId === next.id).segments.length, 1);
});

test('timed segments exclude a quiet producer ending but retain real capture gaps and abnormal endings', async t => {
  for (const [label, gap, reason, incomplete, spacing = 1000] of [
    ['quiet ending', 0, 'producer-finished', false],
    ['lost audio mid-song', 3, 'producer-finished', true],
    ['repeated short capture gaps', 0, 'producer-finished', true, 1500],
    ['cancelled set', 0, 'audio-loss', true],
  ]) await t.test(label, async () => {
    const s = await setup({ persistFrameTimes: true, segmentSeconds: 2 });
    const b = { ...booking, endUtc: new Date(START + 60000).toISOString(),
      broadcast: { actualStartedAt: START, actualEndedAt: null, authorizedEndAt: START + 60000 } };
    await s.recorder.consent(b, await s.permission(true, artist, START - 1000, ORIGIN, b), artist.address, ORIGIN);
    for (let second = 0; second < 20; second++) {
      s.at(START + second * spacing + (second >= 10 ? gap * 1000 : 0));
      s.recorder.capture(b, frame());
      await s.recorder.flush();
    }
    const segments = structuredClone(s.state().recordings[0].segments);
    assert.equal(segments[0].firstFrameAt, START);
    assert.equal(segments.at(-1).lastFrameAt, START + 19 * spacing + (gap + 1) * 1000);
    const audioEndedAt = segments.at(-1).lastFrameAt;
    b.broadcast.actualEndedAt = audioEndedAt + 30000;
    b.broadcast.endReason = reason;
    s.at(b.broadcast.actualEndedAt);
    await s.recorder.tick([b]);
    assert.equal(s.state().recordings[0].incomplete, incomplete);
    assert.equal(s.state().recordings[0].result.durationSamples, 20 * 48000);
    assert.deepEqual(s.state().recordings[0].segments, segments, 'source samples and capture bounds survive finalization');
    assert.equal(s.submissions.length, 0, 'timing never grants publication permission');
    await s.approve('full');
    assert.equal(s.submissions[0].incomplete, incomplete, 'radio handoff uses the same partial label');
  });
});

test('legacy and mixed segment journals retain room-window fallback, independent of the writer flag', async t => {
  const { createLiveRecorder, validateRecordingState } = await import('../discord-bot/live-recording.js');
  for (const mixed of [false, true]) await t.test(mixed ? 'mixed journal' : 'legacy journal', async () => {
    const s = await setup({ persistFrameTimes: mixed });
    await s.recorder.consent(booking, await s.permission(), artist.address, ORIGIN);
    for (let second = 0; second < 2; second++) {
      s.at(START + second * 1000); s.recorder.capture(booking, frame()); await s.recorder.flush();
    }
    const checkpoint = structuredClone(s.state());
    delete checkpoint.recordings[0].segments[0].firstFrameAt;
    delete checkpoint.recordings[0].segments[0].lastFrameAt;
    checkpoint.recordings[0].status = 'waiting';
    validateRecordingState(checkpoint);
    await s.store.save(checkpoint);
    const replacement = createLiveRecorder({ ...s.args, persistFrameTimes: true });
    await replacement.initialize();
    s.at(START + 20000); await replacement.tick([booking]);
    assert.equal(s.state().recordings[0].incomplete, true, 'unknown capture bounds cannot imply a complete recording');
  });
});

test('capture gaps remain partial when an earlier segment checkpoint finishes during capture', async () => {
  const s = await setup({ persistFrameTimes: true, segmentSeconds: 2 });
  const b = { ...booking, endUtc: new Date(START + 60000).toISOString(),
    broadcast: { actualStartedAt: START, actualEndedAt: null, authorizedEndAt: START + 60000 } };
  await s.recorder.consent(b, await s.permission(true, artist, START - 1000, ORIGIN, b), artist.address, ORIGIN);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const saving = new Promise(resolve => { entered = resolve; });
  const save = s.store.save;
  s.store.save = async next => {
    if (next.recordings[0].segments.length === 1) { entered(); await gate; }
    await save(next);
  };
  s.at(START); s.recorder.capture(b, frame());
  s.at(START + 1000); s.recorder.capture(b, frame());
  await saving;
  s.at(START + 5000); s.recorder.capture(b, frame());
  release();
  await new Promise(setImmediate);
  await s.recorder.flush();
  b.broadcast.actualEndedAt = START + 36000;
  b.broadcast.endReason = 'producer-finished';
  s.at(b.broadcast.actualEndedAt);
  await s.recorder.tick([b]);
  assert.equal(s.state().recordings[0].incomplete, true);
  assert.equal(s.state().recordings[0].result.durationSamples, 3 * 48000);
});

test('frame timing readers validate paired bounds and writers remain disabled unless enabled', async () => {
  const { validateRecordingState } = await import('../discord-bot/live-recording.js');
  const s = await setup({ persistFrameTimes: undefined });
  await s.recorder.consent(booking, await s.permission(), artist.address, ORIGIN);
  s.at(START); s.recorder.capture(booking, frame()); await s.recorder.flush();
  const checkpoint = structuredClone(s.state()), segment = checkpoint.recordings[0].segments[0];
  assert.equal(segment.firstFrameAt, undefined);
  assert.equal(segment.lastFrameAt, undefined);
  segment.firstFrameAt = START; segment.lastFrameAt = START + 1000;
  assert.doesNotThrow(() => validateRecordingState(checkpoint), 'reader accepts new metadata before writer rollout');
  for (const bounds of [
    { firstFrameAt: START }, { lastFrameAt: START + 1000 },
    { firstFrameAt: -1, lastFrameAt: START }, { firstFrameAt: START, lastFrameAt: START - 1 },
    { firstFrameAt: START, lastFrameAt: START },
    { firstFrameAt: START, lastFrameAt: Infinity }, { firstFrameAt: 'now', lastFrameAt: START },
  ]) {
    const invalid = structuredClone(checkpoint), target = invalid.recordings[0].segments[0];
    delete target.firstFrameAt; delete target.lastFrameAt;
    Object.assign(target, bounds);
    assert.throws(() => validateRecordingState(invalid), /Invalid recording journal/);
  }
});

test('a replacement worker waits out deploy overlap before resuming a processing checkpoint', async () => {
  const { createLiveRecorder } = await import('../discord-bot/live-recording.js');
  const s = await setup({ encode: async () => { throw Error('Previous worker download outage'); } });
  await s.recorder.consent(booking, await s.permission(), artist.address, ORIGIN);
  s.at(START); s.recorder.capture(booking, frame()); await s.recorder.flush();
  s.at(START + 20000); await s.recorder.tick([booking]);
  assert.equal(s.state().recordings[0].status, 'processing');
  const replacement = createLiveRecorder({ ...s.args, resumeDelayMs: 180000, encode: async () => Buffer.from('encoded') });
  await replacement.initialize();
  await replacement.tick([booking]);
  assert.equal(s.submissions.length, 0, 'Old worker may still be retrying during overlap');
  s.at(START + 20000 + 180000); await replacement.tick([booking]);
  assert.equal(s.submissions.length, 0, 'Resumed capture is only staged for the performer');
  await s.approve('full', artist, replacement);
  assert.equal(s.submissions.length, 1);
  assert.equal(s.state().recordings[0].status, 'ready');
  assert.equal(replacement.deploymentState().ready, true);
});

test('ended processing handoff verifies canonical readback, pauses retries, remains exclusive and resumes on cancel', async () => {
  const s = await setup({ encode: async () => { throw Error('Fixture encode offline'); } });
  await s.recorder.consent(booking, await s.permission(), artist.address, ORIGIN);
  s.at(START); s.recorder.capture(booking, frame()); await s.recorder.flush();
  s.at(START + 20000); await s.recorder.tick([booking]);
  const before = structuredClone(s.state());
  let reads = 0;
  const restore = s.store.restore;
  s.store.restore = async () => { reads++; return restore(); };
  const lease = { id: 'repair-1', expiresAt: START + 20000 + 120000, bookings: [booking] };
  assert.deepEqual(await s.recorder.prepareDeployment(lease), { ready: true, recordingCheckpointVerified: true });
  assert.equal(reads, 1);
  assert.equal(s.recorder.deploymentPaused(), true);
  assert.equal(s.recorder.deploymentState().ready, false, 'Strict legacy completion state is not rewritten');
  const errors = s.errors.length;
  await s.recorder.tick([booking]); assert.equal(s.errors.length, errors);
  assert.deepEqual(s.state(), before, 'No journal status rewrite to fake completion');
  await assert.rejects(s.recorder.prepareDeployment({ ...lease, id: 'repair-2' }), /Another deployment/);
  assert.throws(() => s.recorder.cancelDeployment('repair-2'), /Another deployment/);
  await s.recorder.prepareDeployment({ ...lease, expiresAt: START + 20000 + 900000 });
  assert.equal(reads, 2, 'Lease extension re-verifies readback');
  s.recorder.cancelDeployment('repair-1');
  assert.equal(s.recorder.deploymentPaused(), false);
  await s.recorder.tick([booking]); assert.ok(s.errors.length > errors, 'Retries resume after cancellation');
});

test('recording handoff blocks active capture, in-flight encoding, unknown/changed bookings and imminent shows', async () => {
  const s = await setup();
  await s.recorder.consent(booking, await s.permission(), artist.address, ORIGIN);
  s.at(START); s.recorder.capture(booking, frame()); await s.recorder.flush();
  assert.deepEqual(await s.recorder.prepareDeployment({ id: 'repair', expiresAt: START + 120000, bookings: [booking] }), { ready: false });
  s.at(START + 20000);
  const { createLiveRecorder } = await import('../discord-bot/live-recording.js');
  const restarted = createLiveRecorder({ ...s.args, encode: async () => { throw Error('fixture'); } });
  await restarted.initialize(); await restarted.tick([booking]);
  const lease = { id: 'repair', expiresAt: START + 140000, bookings: [booking] };
  assert.deepEqual(await restarted.prepareDeployment({ ...lease, bookings: [] }), { ready: false });
  assert.deepEqual(await restarted.prepareDeployment({ ...lease, bookings: [{ ...booking, wallet: Wallet.createRandom().address }] }), { ready: false });
  assert.deepEqual(await restarted.prepareDeployment({ ...lease, bookings: [booking, {
    ...booking, id: 'next', acknowledged: true, status: 'funded',
    startUtc: new Date(START + 60000).toISOString(), endUtc: new Date(START + 120000).toISOString(),
  }] }), { ready: false });
  await assert.rejects(restarted.prepareDeployment({ ...lease, bookings: [{ ...booking, status: 'funded', acknowledged: true, endUtc: 'invalid' }] }), /Booking times unavailable/);
  assert.equal(restarted.deploymentPaused(), false);
  let finish;
  const busy = createLiveRecorder({ ...s.args, encode: () => new Promise(resolve => { finish = resolve; }) });
  await busy.initialize();
  const ticking = busy.tick([booking]);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await busy.prepareDeployment(lease), { ready: false });
  finish(Buffer.from('fixture')); await ticking;
});

test('failed or expired recording readback never grants handoff, while lease expiry resumes canonical retry', async () => {
  const s = await setup({ encode: async () => { throw Error('fixture encode'); } });
  await s.recorder.consent(booking, await s.permission(), artist.address, ORIGIN);
  s.at(START); s.recorder.capture(booking, frame()); await s.recorder.flush();
  s.at(START + 20000); await s.recorder.tick([booking]);
  const restore = s.store.restore;
  const lease = { id: 'repair', expiresAt: START + 140000, bookings: [booking] };
  s.store.restore = async () => ({ version: 1, recordings: [] });
  await assert.rejects(s.recorder.prepareDeployment(lease), /does not match/);
  assert.equal(s.recorder.deploymentPaused(), true, 'Failed verification stays paused until cancel or expiry');
  s.recorder.cancelDeployment('repair'); s.store.restore = restore;
  await s.recorder.prepareDeployment(lease);
  s.at(lease.expiresAt + 1);
  assert.equal(s.recorder.deploymentPaused(), false);
  const errors = s.errors.length;
  await s.recorder.tick([booking]); assert.ok(s.errors.length > errors);
  await assert.rejects(s.recorder.prepareDeployment(lease), /Invalid recording deployment lease/);
  s.store.restore = async () => {
    s.at(START + 400000);
    return restore();
  };
  await assert.rejects(s.recorder.prepareDeployment({ ...lease, expiresAt: START + 280000 }), /expired during verification/);
});

test('finalized recording uses existing mint requests, survives restore and only replays after genuine mint completion', async () => {
  const p = await import('../discord-bot/playlist-store.js');
  try {
    let remote;
    p.loadPlaylist([]); p.configureRemotePersistence(async state => { remote = structuredClone(state); });
    const input = liveRecordingRelease({ booking, cid: 'a'.repeat(46),
      consent: { enabled: true, signature: 'fixture-proof-kept-in-encrypted-journal', issuedAt: START - 1000 },
      durationSeconds: 20 });
    const track = await p.submitLiveRecordingRelease(input);
    assert.equal(p.getMintRequests().length, 1); assert.equal(track.mintRecipient, artist.address);
    assert.equal(track.tipWallet, artist.address);
    assert.equal(track.albumId, booking.id); assert.equal(track.trackNumber, 1);
    assert.equal(track.liveRecording.replayStatus, 'pending');
    assert.equal(p.pendingLiveRecordingReplay(START + 400000), undefined);
    await p.submitLiveRecordingRelease(input); assert.equal(p.getMintRequests().length, 1);
    p.completeTrackMint(track.trackId, { tokenId: '999', txHash: 'verified-fixture', contractAddress: artist.address });
    await p.waitForRemotePersistence(); p.loadPlaylist(remote);
    assert.equal(p.pendingLiveRecordingReplay(START + 319999), undefined, 'outro is protected');
    assert.equal(p.pendingLiveRecordingReplay(START + 320000).trackId, track.trackId);
    await p.completeLiveRecordingReplay(track.trackId, { trackId: track.trackId, finished: false, audibleMs: 20000 });
    assert.ok(p.pendingLiveRecordingReplay(START + 400000));
    await p.completeLiveRecordingReplay(track.trackId, { trackId: track.trackId, finished: true, audibleMs: 1000 });
    assert.ok(p.pendingLiveRecordingReplay(START + 400000), 'short or interrupted attempts are not marked played');
    await p.completeLiveRecordingReplay(track.trackId, { trackId: track.trackId, playId: 'real-completion', finished: true, audibleMs: 20000 });
    p.loadPlaylist(remote);
    assert.equal(p.pendingLiveRecordingReplay(START + 400000), undefined);
    assert.equal(p.liveRecordingReleaseState(booking.id).state, 'minted', 'the older receipt does not distinguish public website and private playback');
    assert.equal(p.liveRecordingReleaseState(booking.id).firstStartedAt, undefined, 'legacy completion never invents a start time');
  } finally { p.configureRemotePersistence(null); }
});

test('release facts stay private until mint, then require a durable audible start and retain the first milestone across retries', async () => {
  const p = await import('../discord-bot/playlist-store.js');
  let saved;
  try {
    p.loadPlaylist([]);
    p.configureRemotePersistence(async state => { saved = structuredClone(state); });
    const track = await p.submitLiveRecordingRelease(liveRecordingRelease({ booking, cid: 'd'.repeat(46),
      consent: { enabled: true, signature: 'private-consent-proof', issuedAt: START - 1000 }, durationSeconds: 20 }));
    assert.deepEqual(p.liveRecordingReleaseState(booking.id), { known: false });
    p.completeTrackMint(track.trackId, { tokenId: '51', txHash: 'verified-fixture', contractAddress: artist.address });
    await p.waitForRemotePersistence();
    assert.equal(p.liveRecordingReleaseState(booking.id).state, 'minted');
    const play = { trackId: track.trackId, playId: 'first-real-play', startedAt: START + 400000, audible: true };
    await p.startLiveRecordingReplay(track.trackId, { ...play, audible: false });
    assert.equal(p.liveRecordingReleaseState(booking.id, play).state, 'minted', 'preparation is not audible playback');
    await p.startLiveRecordingReplay(track.trackId, play);
    assert.equal(p.liveRecordingReleaseState(booking.id, play).state, 'airing');
    await p.completeLiveRecordingReplay(track.trackId, { ...play, endedAt: play.startedAt + 1000,
      finished: false, audibleMs: 1000 });
    p.loadPlaylist(saved);
    assert.equal(p.liveRecordingReleaseState(booking.id).state, 'retrying');
    const retry = { ...play, playId: 'retry-play', startedAt: play.startedAt + 60000 };
    await p.startLiveRecordingReplay(track.trackId, retry);
    assert.equal(p.liveRecordingReleaseState(booking.id, retry).firstPlayId, play.playId);
    await p.completeLiveRecordingReplay(track.trackId, { ...retry, endedAt: retry.startedAt + 20000,
      finished: true, audibleMs: 20000 });
    p.loadPlaylist(saved);
    const result = p.liveRecordingReleaseState(booking.id);
    assert.equal(result.state, 'aired');
    assert.equal(result.firstPlayId, play.playId);
    assert.equal(result.title, track.title);
    assert.ok(!JSON.stringify(result).includes('private-consent-proof'));
    assert.equal(result.releases[0].contractAddress, artist.address);
  } finally { p.configureRemotePersistence(null); }
});

test('a failed radio-start checkpoint cannot certify an aired milestone, and a later successful retry repairs it', async () => {
  const p = await import('../discord-bot/playlist-store.js');
  try {
    p.loadPlaylist([]);
    p.configureRemotePersistence(async () => {});
    const track = await p.submitLiveRecordingRelease(liveRecordingRelease({ booking, cid: 'e'.repeat(46),
      consent: { enabled: true, signature: 'private-proof', issuedAt: START - 1000 }, durationSeconds: 20 }));
    p.completeTrackMint(track.trackId, { tokenId: '52', txHash: 'verified-fixture' });
    await p.waitForRemotePersistence();
    const play = { trackId: track.trackId, playId: 'real-play', startedAt: START + 400000, audible: true };
    p.configureRemotePersistence(async () => { throw new Error('fixture checkpoint unavailable'); });
    await assert.rejects(p.startLiveRecordingReplay(track.trackId, play), /checkpoint unavailable/);
    assert.equal(p.liveRecordingReleaseState(booking.id, play).state, 'minted');
    assert.equal(p.liveRecordingReleaseState(booking.id, play).playbackKnown, false);
    p.configureRemotePersistence(async () => {});
    await p.startLiveRecordingReplay(track.trackId, play);
    assert.equal(p.liveRecordingReleaseState(booking.id, play).state, 'airing');
  } finally { p.configureRemotePersistence(null); }
});

test('an earlier start checkpoint cannot certify a newer in-flight radio attempt', async () => {
  const p = await import('../discord-bot/playlist-store.js');
  const writes = [];
  try {
    p.loadPlaylist([]);
    p.configureRemotePersistence(async () => {});
    const track = await p.submitLiveRecordingRelease(liveRecordingRelease({ booking, cid: 'f'.repeat(46),
      consent: { enabled: true, signature: 'private-proof', issuedAt: START - 1000 }, durationSeconds: 20 }));
    p.completeTrackMint(track.trackId, { tokenId: '53', txHash: 'verified-fixture' });
    await p.waitForRemotePersistence();
    p.configureRemotePersistence(() => new Promise(resolve => writes.push(resolve)));
    const play = { trackId: track.trackId, playId: 'first-play', startedAt: START + 400000, audible: true };
    const first = p.startLiveRecordingReplay(track.trackId, play);
    await new Promise(setImmediate);
    const retry = { ...play, playId: 'newer-play', startedAt: play.startedAt + 1000 };
    const second = p.startLiveRecordingReplay(track.trackId, retry);
    writes[0]();
    await first;
    await new Promise(setImmediate);
    assert.equal(p.liveRecordingReleaseState(booking.id, retry).state, 'minted');
    writes[1]();
    await second;
    assert.equal(p.liveRecordingReleaseState(booking.id, retry).state, 'airing');
    assert.equal(p.liveRecordingReleaseState(booking.id, retry).firstPlayId, play.playId);
  } finally { p.configureRemotePersistence(null); }
});

test('a repeated approved release retries remote queue persistence before claiming it queued', async () => {
  const p = await import('../discord-bot/playlist-store.js');
  let attempts = 0, remote;
  p.loadPlaylist([]);
  p.configureRemotePersistence(async state => {
    if (++attempts === 1) throw Error('fixture remote checkpoint unavailable');
    remote = structuredClone(state);
  });
  const input = liveRecordingRelease({ booking, cid: 'b'.repeat(46),
    consent: { enabled: true, signature: 'fixture-proof-kept-in-encrypted-journal', issuedAt: START - 1000 },
    durationSeconds: 20 });
  try {
    await assert.rejects(p.submitLiveRecordingRelease(input), /fixture remote checkpoint unavailable/);
    assert.equal(p.getMintRequests().length, 1, 'local candidate is idempotently retained while remote storage recovers');
    const retried = await p.submitLiveRecordingRelease(input);
    assert.equal(retried.mintStatus, 'requested');
    assert.equal(attempts, 2);
    assert.equal(remote.filter(track => track.trackId === retried.trackId).length, 1);
  } finally { p.configureRemotePersistence(null); p.loadPlaylist([]); }
});

test('recording journal is encrypted, readback-verified, rejects token fields and restores signed consent', async () => {
  const { createLiveRecordingStore, validateRecordingState } = await import('../discord-bot/live-recording.js');
  const { checkpointContentCid } = await import('../discord-bot/checkpoint-mirror.js');
  const s = await setup({ persistFrameTimes: true });
  await s.recorder.consent(booking, await s.permission(), artist.address, ORIGIN);
  s.at(START); s.recorder.capture(booking, frame()); await s.recorder.flush();
  const files = [], envelopes = [];
  let serial = 0, gatewayOffline = false;
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url);
    if (init.method === 'POST') {
      const bytes = Buffer.from(await init.body.get('file').arrayBuffer());
      const cid = await checkpointContentCid(bytes);
      envelopes.push(bytes.toString());
      files.unshift({ id: String(++serial), cid, bytes, name: init.body.get('name'),
        keyvalues: JSON.parse(init.body.get('keyvalues')), created_at: new Date(START + serial * 1000).toISOString() });
      return Response.json({ data: { cid } });
    }
    if (target.pathname.endsWith('/public')) return Response.json({ data: { files: files.map(({ bytes, ...file }) => file) } });
    if (target.pathname === '/v3/gateways') return Response.json({ data: { rows: [] } });
    const file = files.find(file => target.pathname.endsWith(`/ipfs/${file.cid}`));
    return file && !gatewayOffline ? new Response(file.bytes) : new Response('unavailable', { status: 504 });
  };
  const args = { storageKey: 'a'.repeat(64), pinataJwt: 'fixture-only', gateway: 'https://gateway.example', fetchImpl };
  const first = createLiveRecordingStore(args);
  try {
    assert.deepEqual(await first.restore(), { version: 1, recordings: [] });
    await first.save(s.state());
    assert.equal(envelopes[0].includes(booking.id), false);
    assert.equal(envelopes[0].includes(s.state().recordings[0].consent.signature), false);
    const second = createLiveRecordingStore(args);
    try { assert.deepEqual(await second.restore(), s.state()); } finally { second.close(); }
    const invalid = structuredClone(s.state()); invalid.recordings[0].token = 'must-never-persist';
    assert.throws(() => validateRecordingState(invalid), /Invalid/);
    const tampered = structuredClone(s.state()); tampered.recordings[0].consent.enabled = false;
    assert.throws(() => validateRecordingState(tampered), /signature/);
    gatewayOffline = true;
    await assert.rejects(first.save(s.state()), /restore failed/);
  } finally { first.close(); }
});

test('automatic replay selects only safe normal rotation, yields to paid songs and survives failed media', async t => {
  const { verifiedRecording } = require('./helpers/verified-recording');
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const p = await import('../discord-bot/playlist-store.js');
  const { JukeLoopSession } = await import('../discord-bot/jukeloop.js');
  const streams = [];
  let show = { type: 'normal_rotation', id: 'normal' }, activePlaylist = false, paid;
  const player = new EventEmitter(); player.state = { status: 'idle' }; player.stop = () => {};
  const session = new JukeLoopSession({ client: {}, audioPlayer: player,
    djuke: { hasActivePlaylist: () => activePlaylist, nextPaid: async () => paid, release: async () => {} },
    createStream: () => { const stream = new PassThrough(); stream.write(Buffer.from('ready')); streams.push(stream);
      return { stream, ffmpegProcess: { kill() {} } }; } });
  t.mock.method(Date, 'now', () => START + 400000);
  session._resolveShow = () => show;
  session.getShowState = () => ({ activeShow: show });
  session._getFreshUrl = async () => 'https://fixture.example/recording.mp3';
  session._sendPlaybackNotice = () => {};
  session._queue = [verifiedRecording({ trackId: 'ordinary-song', title: 'Ordinary music' })];
  try {
    p.loadPlaylist([]); p.configureRemotePersistence(async () => {});
    const track = await p.submitLiveRecordingRelease(liveRecordingRelease({ booking, cid: 'c'.repeat(46),
      consent: { enabled: true, signature: 'fixture', issuedAt: START - 1000 }, durationSeconds: 20 }));
    p.completeTrackMint(track.trackId, { tokenId: '1000', txHash: 'verified-fixture' });
    const replay = await session._prepareNextPlayback();
    assert.equal(replay.track.trackId, track.trackId); assert.equal(replay.liveReplay, true);
    assert.equal(replay.queueIndex, null);
    activePlaylist = true;
    assert.notEqual((await session._prepareNextPlayback()).track.trackId, track.trackId, 'active playlist owns the lane');
    assert.equal(session._startPrepared(replay), false, 'late paid playlist cannot be preempted by a prefetched replay');
    activePlaylist = false;
    paid = { record: { requestId: 'paid-song', kind: 'song' }, track: verifiedRecording({ trackId: 'paid-song', title: 'Paid song' }) };
    assert.equal((await session._prepareNextPlayback()).track.trackId, 'paid-song');
    paid = null; show = { type: 'weekly_top10', id: 'top10' };
    assert.notEqual((await session._prepareNextPlayback()).track.trackId, track.trackId);
    assert.equal(session._startPrepared(replay), false, 'late protected shows also retain priority');
    show = { type: 'normal_rotation', id: 'normal' };
    session._getFreshUrl = async selected => selected.trackId === track.trackId ? null : 'https://fixture.example/ordinary.mp3';
    assert.equal((await session._prepareNextPlayback()).track.trackId, 'ordinary-song', 'failed replay media never silences ordinary rotation');
    assert.ok(p.pendingLiveRecordingReplay(Date.now()), 'failed preparation retains durable replay intent');
  } finally {
    session.destroy(); streams.forEach(stream => stream.destroy()); p.configureRemotePersistence(null);
  }
});

test('catalog release retains source identity, artist-only defaults and exact sample-range duration', async () => {
  const { verifiedRecordingDuration, recordingDurationReason } = await import('../js/radio-duration.mjs');
  const p = await import('../discord-bot/playlist-store.js');
  const nftId = `8453:0x${'1'.repeat(40)}:7`;
  const sourceCid = 'a'.repeat(46), artistWallet = `0x${'2'.repeat(40)}`;
  const catalogSource = {
    nftId, chainId: 8453, contractAddress: `0x${'1'.repeat(40)}`, tokenId: 7,
    artistWallet, sourceCid, mediaType: 'audio/wav', tipWallet: `0x${'3'.repeat(40)}`,
  };
  const durationSamples = 28_800_048;
  const common = {
    booking: { id: 'catalog-release-test', wallet: artistWallet },
    catalogSource,
    source: { cid: sourceCid, segments: [
      ...Array.from({ length: 20 }, (_, index) => ({ cid: String(index).padEnd(46, 'd'), bytes: 2_880_000 })),
      { cid: 'x'.repeat(46), bytes: 96 },
    ],
      sampleRate: 48_000, durationSamples },
  };
  p.loadPlaylist([]); p.configureRemotePersistence(async () => {});
  try {
    const full = await p.submitCatalogRecordingRelease({ ...common, release: {
      releaseId: 'e'.repeat(64), choice: 'full', cid: sourceCid, sourceCid,
      title: 'Untouched full recording', albumTitle: 'Original album', trackNumber: 1,
      startSample: 0, endSample: durationSamples, durationSamples,
      approvalSignature: 'fixture', approvalMessageHash: 'f'.repeat(64), approvedAt: Date.now(),
    } });
    assert.equal(full.mediaType, 'audio/wav');
    assert.match(full.filename, /\.wav$/);
    assert.equal(full.tipWallet, artistWallet, 'catalog collaborator tip metadata is not inferred');
    assert.equal(full.mintRecipient, artistWallet);
    assert.equal(full.parentTokenId, undefined, 'no royalty-chain parent is inferred from the source NFT');
    assert.equal(full.catalogRecording.sourceCid, sourceCid);
    assert.equal(verifiedRecordingDuration(full), durationSamples / 48_000);
    assert.equal(recordingDurationReason(full), 'Recording over 10 minutes waits for designated long-form hours');
    assert.equal(recordingDurationReason(full, { longForm: true }), null);

    const cut = await p.submitCatalogRecordingRelease({ ...common, release: {
      releaseId: 'a'.repeat(64), choice: 'split', cid: 'b'.repeat(46), sourceCid,
      title: 'Named cut', albumTitle: 'Original album', trackNumber: 1,
      startSample: 0, endSample: 48_000, durationSamples: 48_000,
      approvalSignature: 'fixture', approvalMessageHash: 'f'.repeat(64), approvedAt: Date.now(),
    } });
    assert.equal(cut.mediaType, 'audio/mpeg');
    assert.match(cut.filename, /\.mp3$/);
    assert.equal(verifiedRecordingDuration(cut), 1);
    assert.equal(cut.catalogRecording.sourceNftId, nftId);
  } finally { p.configureRemotePersistence(null); }
});
