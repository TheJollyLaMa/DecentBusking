const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet } = require('../discord-bot/node_modules/ethers');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { liveRecordingConsentMessage } = require('../js/live-recording-consent.mjs');
const { recordingReleaseApprovalMessage, validateRecordingDraft } = require('../js/live-recording-edit.mjs');

const ORIGIN = 'https://radio.example';
const performer = Wallet.createRandom(), owner = Wallet.createRandom(), sourceCid = 'a'.repeat(46);
const booking = { id: 'release-room-test', wallet: performer.address, title: 'After the rain',
  status: 'paid', acknowledged: true, payoutPolicy: 'pilot-guaranteed-v1', cancelled: false,
  startUtc: new Date(1_700_000_000_000).toISOString(), endUtc: new Date(1_700_001_200_000).toISOString() };

function splitDraft(revision = 1) {
  return { revision, albumTitle: 'After the rain', songs: [
    { title: 'First song', startSample: 0, endSample: 24_000 },
    { title: 'Second song', startSample: 24_000, endSample: 48_000 },
  ] };
}

async function fixture(options = {}) {
  const consentIssuedAt = Date.now() - 10_000;
  const consent = { enabled: true, issuedAt: consentIssuedAt, version: 'dbusk-live-recording-v2',
    origin: ORIGIN, signature: await performer.signMessage(liveRecordingConsentMessage({
      bookingId: booking.id, wallet: booking.wallet, origin: ORIGIN, issuedAt: consentIssuedAt,
      enabled: true, version: 'dbusk-live-recording-v2',
    })) };
  let state = { version: 1, recordings: [{
    bookingId: booking.id, wallet: booking.wallet.toLowerCase(), consent,
    segments: [{ cid: 's'.repeat(46), bytes: 96_000, waveform: [[-.5, .5], [0, .75]] }],
    status: 'ready', result: { cid: sourceCid, durationSamples: 48_000, sampleRate: 48_000, durationSeconds: 1 },
    incomplete: false,
  }] };
  const store = { restore: async () => structuredClone(state), save: async next => { state = structuredClone(next); } };
  const submitted = [], tracks = new Map(), blobs = new Map();
  const upload = async bytes => {
    const cid = createHash('sha256').update(bytes).digest('hex');
    blobs.set(cid, Buffer.from(bytes)); return `ipfs://${cid}`;
  };
  const args = { enabled: true, store, upload, download: async () => Buffer.alloc(96_044),
    encode: async () => Buffer.from('original'), encodeRange: async () => Buffer.from('segment'),
    submitRelease: async value => {
      submitted.push(value);
      const trackId = `live:${booking.id}:${value.release.releaseId}`;
      const track = { trackId, mintStatus: 'requested', mintRecipient: booking.wallet, ipfsCid: value.release.cid,
        tipWallet: booking.wallet, albumId: booking.id };
      tracks.set(trackId, track);
      return track;
    },
    getRelease: id => tracks.get(id) || null, now: Date.now, ...options };
  const { createLiveRecorder } = await import('../discord-bot/live-recording.js');
  const recorder = createLiveRecorder(args);
  await recorder.initialize();
  const approve = async (choice = 'split', draft = splitDraft(), signer = performer) => {
    if (draft) {
      const current = await recorder.editState(booking);
      if (draft.revision > current.draft.revision) await recorder.saveEdit(booking, draft, performer.address);
      else if (draft.revision < current.draft.revision) draft = current.draft;
    }
    const edit = await recorder.editState(booking), issuedAt = Date.now(), signedDraft = choice === 'defer' ? null : edit.draft;
    const message = recordingReleaseApprovalMessage({ bookingId: booking.id, wallet: performer.address,
      origin: ORIGIN, sourceCid: edit.sourceCid, sourceSamples: edit.sourceSamples,
      choice, draft: signedDraft, issuedAt, incomplete: edit.incomplete });
    const signature = await signer.signMessage(message);
    return recorder.approveEdit(booking, { choice, issuedAt, signature }, signer.address, ORIGIN);
  };
  return { recorder, approve, submitted, tracks, blobs, state: () => state };
}

test('split drafts use exact sample boundaries and reject empty, overlapping, duplicate or out-of-range exports', () => {
  assert.deepEqual(validateRecordingDraft(splitDraft(), 48_000), splitDraft());
  for (const songs of [
    [{ title: 'Empty', startSample: 0, endSample: 0 }],
    [{ title: 'One', startSample: 0, endSample: 30_000 }, { title: 'Two', startSample: 29_999, endSample: 48_000 }],
    [{ title: 'One', startSample: 0, endSample: 24_000 }, { title: 'One', startSample: 24_000, endSample: 48_000 }],
    [{ title: 'One', startSample: 0, endSample: 48_001 }],
  ]) assert.throws(() => validateRecordingDraft({ ...splitDraft(), songs }, 48_000));
  assert.throws(() => validateRecordingDraft({ ...splitDraft(), songs: [] }, 48_000));
});

test('defer creates no release; full set and split tracks can coexist idempotently', async () => {
  const f = await fixture();
  const deferred = await f.approve('defer', null);
  assert.equal(deferred.decision, 'deferred');
  assert.equal(f.submitted.length, 0);

  const full = await f.approve('full', splitDraft());
  assert.equal(full.releases.length, 1);
  assert.equal(full.releases[0].cid, sourceCid, 'full release uses the unchanged original CID');
  assert.equal(f.submitted.length, 1);
  f.tracks.get(full.releases[0].trackId).mintStatus = 'minted';
  const split = await f.approve('split', splitDraft(2));
  assert.equal(split.releases.length, 3);
  assert.equal(f.submitted.length, 3);
  assert.equal(split.releases[1].startSample, 0);
  assert.equal(split.releases[1].endSample, 24_000);
  assert.equal(split.releases[2].startSample, 24_000);
  assert.equal(split.releases[2].endSample, 48_000);
  assert.notEqual(split.releases[1].cid, sourceCid);
  assert.equal(split.releases[1].parentReleaseId, full.releases[0].releaseId,
    'post-mint cuts are new releases linked to the immutable full-set release');
  await f.approve('split', splitDraft(3));
  assert.equal(f.submitted.length, 3, 'replaying the same content approval does not create duplicate queue entries');
  assert.equal(f.state().recordings[0].segments[0].cid, 's'.repeat(46));
  assert.equal(f.state().recordings[0].result.cid, sourceCid);
});

test('failed export remains recoverable and wrong performer cannot save or approve', async () => {
  let exports = 0;
  const f = await fixture({ encodeRange: async () => {
    if (++exports === 1) throw Error('fixture encoder offline');
    return Buffer.from('recovered song');
  } });
  await assert.rejects(f.recorder.saveEdit(booking, splitDraft(), owner.address), /booked performer/);
  const edit = await f.recorder.editState(booking);
  const issuedAt = Date.now();
  const message = recordingReleaseApprovalMessage({ bookingId: booking.id, wallet: performer.address,
    origin: ORIGIN, sourceCid: edit.sourceCid, sourceSamples: edit.sourceSamples,
    choice: 'split', draft: splitDraft(), issuedAt, incomplete: false });
  await assert.rejects(f.recorder.approveEdit(booking, { choice: 'split', issuedAt,
    signature: await owner.signMessage(message) }, owner.address, ORIGIN), /performer/);
  await assert.rejects(f.approve('split'), /fixture encoder offline/);
  assert.equal(f.state().recordings[0].releases[0].status, 'failed');
  const completed = await f.approve('split');
  assert.equal(exports, 3);
  assert.equal(completed.releases.filter(release => release.status === 'queued').length, 2);
  assert.equal(f.submitted.length, 2);
});

test('bounded server export trims across original PCM segment boundaries without intermediate files', async () => {
  const { encodeRecordingRange, pcmWav } = await import('../discord-bot/live-recording.js');
  const samples = 48_000;
  const makeSegment = frequency => {
    const pcm = Buffer.alloc(samples * 2);
    for (let index = 0; index < samples; index++) {
      pcm.writeInt16LE(Math.round(Math.sin(index / samples * frequency * 2 * Math.PI) * 28_000), index * 2);
    }
    return pcmWav(pcm);
  };
  const wavs = [makeSegment(220), makeSegment(330), makeSegment(440)];
  const segments = wavs.map((_, index) => ({ cid: `seg-${index}`.padEnd(24, 'a'), bytes: samples * 2 }));
  const mp3 = await encodeRecordingRange(segments,
    async cid => wavs[Number(cid.slice(4, 5))], samples / 2, samples * 2 + samples / 2);
  assert.ok(mp3.length > 10_000 && mp3.length < 45 * 1024 * 1024);
  const decoded = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0', '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'],
  { input: mp3, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  const decodedSeconds = decoded.stdout.length / 2 / samples;
  assert.ok(Math.abs(decodedSeconds - 2) < .1, `expected a 2s export, got ${decodedSeconds}s`);
  assert.ok(decoded.stdout.some(byte => byte !== 0), 'export contains playable audio');
  await assert.rejects(encodeRecordingRange(segments, async cid => wavs[Number(cid.slice(4, 5))],
    0, 48_000 * 60 * 31), /outside the allowed bounds/);
});
