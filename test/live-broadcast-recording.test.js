const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet } = require('../discord-bot/node_modules/ethers');
const { createHash } = require('node:crypto');
const { join } = require('node:path');
const { liveRecordingRelease } = require('./helpers/live-recording-release.js');
const fixtureDirectory = join(__dirname, `.live-broadcast-recording-fixtures-${process.pid}`);
require('node:fs').mkdirSync(fixtureDirectory, { recursive: true });
process.env.JUKELOOP_PLAYLIST_PATH = join(fixtureDirectory, 'playlist.json');
test.after(() => require('node:fs/promises').rm(fixtureDirectory, { recursive: true, force: true }));
const START = Date.parse('2026-11-20T02:00:00Z'), ORIGIN = 'https://radio.example';
const performer = Wallet.createRandom();
const pcm = () => ({ sampleRate: 48000, channels: 1, data: new Int16Array(48000), samplesPerChannel: 48000 });

async function fixture(options = {}) {
  const { createLiveRecorder } = await import('../discord-bot/live-recording.js');
  const consent = await import('../js/live-recording-consent.mjs');
  const { recordingReleaseApprovalMessage } = await import('../js/live-recording-edit.mjs');
  let time = START - 1000, saved = { version: 1, recordings: [] };
  const blobs = [], submissions = [], errors = [];
  const store = { restore: async () => structuredClone(saved), save: async s => { saved = structuredClone(s); } };
  const args = { enabled: true, store, now: () => time, segmentSeconds: 1,
    upload: async (bytes, name) => { blobs.push({ bytes, name }); return `ipfs://${createHash('sha256').update(bytes).digest('hex')}`; },
    download: async () => Buffer.from('unused'), encode: async () => Buffer.from('final audio'),
    ingest: async value => { submissions.push(value); return { trackId: `track:${value.booking.id}:${value.release.releaseId}` }; },
    log: { error: (...args) => errors.push(args.join(' ')) }, ...options };
  const recorder = createLiveRecorder(args);
  await recorder.initialize();
  const booking = { id: 'allocated-recording', wallet: performer.address, title: 'Recorded set',
    startUtc: new Date(START).toISOString(), endUtc: new Date(START + 20000).toISOString(),
    broadcast: { allocationId: 'allocation:recording', actualStartedAt: START + 10000, plannedStartAt: START + 10000,
      authorizedEndAt: START + 40000, actualEndedAt: null, accessUntil: START + 100000,
      endReason: null, outroEndsAt: START + 340000 } };
  const permission = async (b = booking, version, enabled = true) => ({
    enabled, issuedAt: time,
    ...(version === undefined ? {} : { consentVersion: version }),
    signature: await performer.signMessage(consent.liveRecordingConsentMessage({
      bookingId: b.id, wallet: b.wallet, origin: ORIGIN, issuedAt: time, enabled, ...(version === undefined ? {} : { version }),
    })),
  });
  const approve = async (choice = 'full', target = recorder) => {
    const edit = await target.editState(booking), issuedAt = time, draft = choice === 'defer' ? null : edit.draft;
    const message = recordingReleaseApprovalMessage({ bookingId: booking.id, wallet: booking.wallet,
      origin: ORIGIN, sourceCid: edit.sourceCid, sourceSamples: edit.sourceSamples,
      choice, draft, issuedAt, incomplete: edit.incomplete });
    const signature = await performer.signMessage(message);
    return target.approveEdit(booking, { choice, issuedAt, signature }, performer.address, ORIGIN);
  };
  return { recorder, args, booking, permission, blobs, submissions, errors, store,
    v1: consent.LIVE_RECORDING_CONSENT_VERSION, v2: consent.LIVE_RECORDING_ALLOCATED_CONSENT_VERSION, approve,
    at: n => { time = n; }, saved: () => structuredClone(saved) };
}

test('legacy recording consent stays scheduled-only; explicit V2 renewal permits allocated audio and survives restore', async () => {
  const f = await fixture();
  await f.recorder.consent(f.booking, await f.permission(), performer.address, ORIGIN);
  assert.equal(f.recorder.status(f.booking).consentVersion, f.v1);
  assert.equal(f.recorder.status(f.booking).scopeLimited, true);
  f.at(START + 11000); f.recorder.capture(f.booking, pcm()); await f.recorder.flush();
  assert.equal(f.blobs.length, 1);
  f.at(START + 21000); f.recorder.capture(f.booking, pcm()); await f.recorder.flush();
  assert.equal(f.blobs.length, 1, 'legacy consent never broadens when the allocation does');
  assert.equal(f.recorder.status(f.booking).canChange, true);
  await f.recorder.consent(f.booking, await f.permission(f.booking, f.v2), performer.address, ORIGIN);
  assert.equal(f.recorder.status(f.booking).consentScope, 'allocated-set');
  assert.equal(f.recorder.status(f.booking).scopeLimited, false);
  f.recorder.capture(f.booking, pcm()); await f.recorder.flush();
  assert.equal(f.blobs.length, 2);
  const { validateRecordingState, createLiveRecorder } = await import('../discord-bot/live-recording.js');
  assert.equal(validateRecordingState(f.saved()).recordings[0].consent.version, f.v2);
  const restarted = createLiveRecorder(f.args); await restarted.initialize();
  assert.equal(restarted.status(f.booking).consentVersion, f.v2);
});

test('V2 cannot be inferred from a V1 signature, invalid version or private waiting-room audio', async () => {
  const f = await fixture();
  const old = await f.permission();
  await assert.rejects(f.recorder.consent(f.booking, { ...old, consentVersion: f.v2 }, performer.address, ORIGIN), /signature/);
  await assert.rejects(f.recorder.consent(f.booking, { ...old, consentVersion: 'future-version' }, performer.address, ORIGIN), /permission/);
  await assert.rejects(f.recorder.consent(f.booking, { ...old, consentVersion: null }, performer.address, ORIGIN), /permission/);
  await f.recorder.consent(f.booking, await f.permission(f.booking, f.v2), performer.address, ORIGIN);
  f.at(START + 15000);
  f.recorder.capture({ ...f.booking, broadcast: { ...f.booking.broadcast, actualStartedAt: null } }, pcm());
  await f.recorder.flush();
  assert.equal(f.blobs.length, 0);
});

test('explicit early airtime never broadens existing V2 recording permission before the original start', async () => {
  const f = await fixture({ persistFrameTimes: true });
  f.booking.broadcast.actualStartedAt = START - 10000;
  f.booking.broadcast.authorizedEndAt = START + 10000;
  f.at(START - 11000);
  await f.recorder.consent(f.booking, await f.permission(f.booking, f.v2), performer.address, ORIGIN);
  f.at(START - 1000); f.recorder.capture(f.booking, pcm()); await f.recorder.flush();
  assert.equal(f.blobs.length, 0);
  assert.equal(f.recorder.status(f.booking).earlyCaptureExcluded, true);
  f.at(START); f.recorder.capture(f.booking, pcm()); await f.recorder.flush();
  assert.equal(f.blobs.length, 1);
  f.booking.broadcast.actualEndedAt = START + 1000; f.booking.broadcast.endReason = 'producer-finished';
  f.at(START + 1000); await f.recorder.tick([f.booking]);
  assert.equal(f.saved().recordings[0].incomplete, true);
  assert.equal(f.submissions.length, 0);
});

test('actual end finalizes once without mint intake; performer approval queues the durable source once', async () => {
  let encodes = 0;
  const f = await fixture({ encode: async () => {
    if (++encodes === 1) throw Error('encoder offline');
    return Buffer.from('final audio');
  } });
  await f.recorder.consent(f.booking, await f.permission(f.booking, f.v2), performer.address, ORIGIN);
  f.at(START + 11000); f.recorder.capture(f.booking, pcm()); await f.recorder.flush();
  f.at(START + 21000); await f.recorder.tick([f.booking]);
  assert.equal(f.recorder.status(f.booking).status, 'recording', 'original end does not finalize an allocated set');
  f.booking.broadcast.actualEndedAt = START + 22000; f.booking.broadcast.endReason = 'producer-finished';
  f.at(START + 22000); await f.recorder.tick([f.booking]);
  assert.equal(f.recorder.status(f.booking).status, 'processing');
  assert.equal(f.recorder.status(f.booking).canChange, false);
  await f.recorder.tick([f.booking]); await f.recorder.tick([f.booking]);
  assert.equal(encodes, 2);
  assert.equal(f.blobs.filter(b => b.name === 'live-performance.mp3').length, 1);
  assert.equal(f.submissions.length, 0, 'completed capture is held for performer release choice');
  await f.approve();
  assert.equal(f.submissions.length, 1);
  assert.equal(f.recorder.status(f.booking).status, 'ready');
});

test('a stuck prior finalizer cannot hold the next performer consent or capture queue', async () => {
  let release, entered;
  const encoding = new Promise(resolve => { entered = resolve; });
  const f = await fixture({ encode: async () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  await f.recorder.consent(f.booking, await f.permission(f.booking, f.v2), performer.address, ORIGIN);
  f.at(START + 11000); f.recorder.capture(f.booking, pcm()); await f.recorder.flush();
  f.booking.broadcast.actualEndedAt = START + 12000; f.booking.broadcast.endReason = 'producer-finished';
  f.at(START + 12000);
  const finalizing = f.recorder.tick([f.booking]); await encoding;
  const next = { ...f.booking, id: 'next-recording', broadcast: { ...f.booking.broadcast,
    actualStartedAt: START + 12000, actualEndedAt: null, endReason: null, authorizedEndAt: START + 60000 } };
  let timer;
  try {
    await Promise.race([(async () => {
      await f.recorder.consent(next, await f.permission(next, f.v2), performer.address, ORIGIN);
      f.recorder.capture(next, pcm()); await f.recorder.flush();
      assert.equal(f.recorder.status(next).status, 'recording');
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Next capture was blocked by prior encoding')), 1000); })]);
  } finally {
    clearTimeout(timer); release(Buffer.from('finished')); await finalizing;
  }
});

test('finalization timeout is explicit and leaves a retryable journal, not a locked live room', async () => {
  let encodes = 0;
  const f = await fixture({ encode: () => { encodes++; return new Promise(() => {}); }, finalizationTimeoutMs: 10 });
  await f.recorder.consent(f.booking, await f.permission(f.booking, f.v2), performer.address, ORIGIN);
  f.at(START + 11000); f.recorder.capture(f.booking, pcm()); await f.recorder.flush();
  f.booking.broadcast.actualEndedAt = START + 12000; f.booking.broadcast.endReason = 'operator-cut';
  f.at(START + 12000); await f.recorder.tick([f.booking]);
  assert.equal(f.recorder.status(f.booking).status, 'processing');
  assert.match(f.recorder.status(f.booking).error, /timed out/);
  await f.recorder.tick([f.booking]);
  assert.equal(encodes, 1, 'a pending external finalizer is never launched again on retry');
  assert.equal(f.recorder.deploymentState().ready, false);
});

test('late mint intake success after an approval timeout is reconciled without a duplicate request', async () => {
  let resolveIntake, intakes = 0;
  const f = await fixture({ ingest: () => { intakes++; return new Promise(resolve => { resolveIntake = resolve; }); },
    finalizationTimeoutMs: 10 });
  await f.recorder.consent(f.booking, await f.permission(f.booking, f.v2), performer.address, ORIGIN);
  f.at(START + 11000); f.recorder.capture(f.booking, pcm()); await f.recorder.flush();
  f.booking.broadcast.actualEndedAt = START + 12000; f.booking.broadcast.endReason = 'producer-finished';
  f.at(START + 12000); await f.recorder.tick([f.booking]);
  assert.equal(f.recorder.status(f.booking).status, 'ready');
  assert.equal(intakes, 0, 'capture finalization does not call the mint queue');
  await assert.rejects(f.approve(), /timed out/);
  assert.equal(intakes, 1);
  resolveIntake({ trackId: 'late-once' });
  await new Promise(resolve => setImmediate(resolve));
  const recovered = await f.approve();
  assert.equal(intakes, 1);
  assert.equal(recovered.releases[0].trackId, 'late-once');
});

test('allocated recording replay waits for actual-end outro, not the original financial end', async () => {
  const p = await import('../discord-bot/playlist-store.js');
  const f = await fixture();
  try {
    let saved;
    p.loadPlaylist([]); p.configureRemotePersistence(async s => { saved = structuredClone(s); });
    const input = liveRecordingRelease({ booking: { ...f.booking, broadcast: { ...f.booking.broadcast, outroEndsAt: START + 700000 } },
      cid: 'a'.repeat(46), consent: { enabled: true, signature: 'private-consent-proof', issuedAt: START - 1000 },
      durationSeconds: 20 });
    const track = await p.submitLiveRecordingRelease(input);
    p.completeTrackMint(track.trackId, { tokenId: '1001', txHash: 'verified-fixture', contractAddress: performer.address });
    await p.waitForRemotePersistence(); p.loadPlaylist(saved);
    assert.equal(p.pendingLiveRecordingReplay(START + 320000), undefined);
    assert.equal(p.pendingLiveRecordingReplay(START + 699999), undefined);
    assert.equal(p.pendingLiveRecordingReplay(START + 700000).trackId, track.trackId);
    await p.submitLiveRecordingRelease(input);
    assert.equal(p.getPlaylist().length, 1);
    assert.doesNotMatch(JSON.stringify(saved), /private-consent-proof/);
    assert.equal(saved[0].liveRecording.consentVersion, 'dbusk-live-recording-v2');
    assert.equal(saved[0].liveRecording.performerApproval.signature, 'fixture-performer-approval');
  } finally { p.configureRemotePersistence(null); p.loadPlaylist([]); }
});
