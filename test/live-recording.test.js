const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet } = require('../discord-bot/node_modules/ethers');
const { createHash } = require('node:crypto');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const playlistDir = require('node:fs').mkdtempSync(join(tmpdir(), 'dbusk-recording-playlist-'));
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
  let time = START - 1000, state = { version: 1, recordings: [] }, submissions = [];
  const blobs = new Map(), errors = [];
  const store = { restore: async () => structuredClone(state), save: async next => { state = structuredClone(next); } };
  const upload = async bytes => {
    const cid = createHash('sha256').update(bytes).digest('hex');
    blobs.set(cid, Buffer.from(bytes)); return `ipfs://${cid}`;
  };
  const args = { enabled: true, store, upload, download: async cid => blobs.get(cid),
    ingest: async value => { submissions.push(value); return { trackId: 'fixture-track' }; },
    encode: async () => Buffer.from('encoded-fixture'), segmentSeconds: 1, now: () => time,
    log: { error: (...args) => errors.push(args.join(' ')) }, ...options };
  const recorder = createLiveRecorder(args);
  const permission = async (enabled = true, signer = artist, issuedAt = time, origin = ORIGIN, b = booking) => ({
    enabled, issuedAt, signature: await signer.signMessage(liveRecordingConsentMessage({
      bookingId: b.id, wallet: b.wallet, origin, issuedAt, enabled })),
  });
  await recorder.initialize();
  return { recorder, args, permission, blobs, errors, submissions, store,
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
  assert.equal(s.submissions.length, 1); assert.equal(s.submissions[0].durationSeconds, 1);
  assert.equal(s.submissions[0].incomplete, true);
  assert.equal(s.recorder.status(booking).status, 'submitted');
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
  await restarted.tick([booking]); assert.equal(restarted.status(booking).status, 'processing');
  assert.equal(restarted.deploymentState().ready, false);
  await restarted.tick([booking]); await restarted.tick([booking]);
  assert.equal(attempts, 2); assert.equal(s.submissions.length, 1); assert.equal(s.submissions[0].incomplete, true);
});

test('twenty-minute real PCM finalizes to a playable MP3 with measured duration and bounded segments', async t => {
  const { pcmWav, encodeRecording } = await import('../discord-bot/live-recording.js');
  const pcm = Buffer.alloc(48000 * 2 * 30);
  for (let n = 0; n < pcm.length / 2; n++) pcm.writeInt16LE(Math.round(Math.sin(n / 48000 * 440 * 2 * Math.PI) * 4000), n * 2);
  const wav = pcmWav(pcm), start = Date.now();
  const result = await encodeRecording(Array.from({ length: 40 }, () => ({ cid: 'fixture', bytes: pcm.length })), async () => wav);
  const elapsedMs = Date.now() - start;
  const dir = await mkdtemp(join(tmpdir(), 'dbusk-encode-test-'));
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
  assert.equal(recorder.status(booking).status, 'submitted');
  assert.equal(s.submissions.length, 1);
  assert.equal(uploads, 1);
  assert.equal(recorder.deploymentState().ready, true);
});

test('replacement recorder resumes a durable processing checkpoint without recapture or a second final upload', async () => {
  const { createLiveRecorder } = await import('../discord-bot/live-recording.js');
  const s = await setup();
  await s.recorder.consent(booking, await s.permission(), artist.address, ORIGIN);
  s.at(START); s.recorder.capture(booking, frame()); await s.recorder.flush();
  const preserved = structuredClone(s.state().recordings[0]);
  let encodes = 0, uploads = 0;
  const old = createLiveRecorder({ ...s.args,
    encode: async () => { encodes++; return Buffer.from('encoded-before-handoff'); },
    upload: async bytes => { uploads++; return s.args.upload(bytes); },
    ingest: async () => { throw Error('Fixture mint intake unavailable'); },
  });
  await old.initialize(); s.at(START + 20000); await old.tick([booking]);
  assert.equal(old.deploymentState().ready, false, 'Current gate must still block pending finalization');
  assert.equal(s.state().recordings[0].status, 'processing');
  assert.ok(s.state().recordings[0].result);
  assert.deepEqual(s.state().recordings[0].consent, preserved.consent);
  assert.deepEqual(s.state().recordings[0].segments, preserved.segments);
  const replacement = createLiveRecorder({ ...s.args,
    encode: async () => { throw Error('Already-checkpointed MP3 must not be re-encoded'); },
    upload: async () => { throw Error('Already-checkpointed MP3 must not be uploaded again'); },
  });
  await replacement.initialize();
  assert.equal(replacement.deploymentState().ready, false);
  await replacement.tick([booking]); await replacement.tick([booking]);
  assert.equal(replacement.deploymentState().ready, true);
  assert.equal(s.submissions.length, 1);
  assert.equal(encodes, 1); assert.equal(uploads, 1);
});

test('finalized recording uses existing mint requests, survives restore and only replays after genuine mint completion', async () => {
  const p = await import('../discord-bot/playlist-store.js');
  try {
    let remote;
    p.loadPlaylist([]); p.configureRemotePersistence(async state => { remote = structuredClone(state); });
    const input = { booking, cid: 'a'.repeat(46), artworkCid: 'b'.repeat(46),
      consent: { enabled: true, signature: 'fixture-proof-kept-in-encrypted-journal', issuedAt: START - 1000 },
      durationSeconds: 20, incomplete: false };
    const track = await p.submitLiveRecording(input);
    assert.equal(p.getMintRequests().length, 1); assert.equal(track.mintRecipient, artist.address);
    assert.equal(track.tipWallet, artist.address);
    assert.equal(p.pendingLiveRecordingReplay(START + 400000), undefined);
    await p.submitLiveRecording(input); assert.equal(p.getMintRequests().length, 1);
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
  } finally { p.configureRemotePersistence(null); }
});

test('recording journal is encrypted, readback-verified, rejects token fields and restores signed consent', async () => {
  const { createLiveRecordingStore, validateRecordingState } = await import('../discord-bot/live-recording.js');
  const { checkpointContentCid } = await import('../discord-bot/checkpoint-mirror.js');
  const s = await setup();
  await s.recorder.consent(booking, await s.permission(), artist.address, ORIGIN);
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
  session._queue = [{ trackId: 'ordinary-song', title: 'Ordinary music' }];
  try {
    p.loadPlaylist([]); p.configureRemotePersistence(async () => {});
    const track = await p.submitLiveRecording({ booking, cid: 'c'.repeat(46), artworkCid: 'b'.repeat(46),
      consent: { enabled: true, signature: 'fixture', issuedAt: START - 1000 }, durationSeconds: 20, incomplete: false });
    p.completeTrackMint(track.trackId, { tokenId: '1000', txHash: 'verified-fixture' });
    const replay = await session._prepareNextPlayback();
    assert.equal(replay.track.trackId, track.trackId); assert.equal(replay.liveReplay, true);
    assert.equal(replay.queueIndex, null);
    activePlaylist = true;
    assert.notEqual((await session._prepareNextPlayback()).track.trackId, track.trackId, 'active playlist owns the lane');
    assert.equal(session._startPrepared(replay), false, 'late paid playlist cannot be preempted by a prefetched replay');
    activePlaylist = false;
    paid = { record: { requestId: 'paid-song', kind: 'song' }, track: { trackId: 'paid-song', title: 'Paid song' } };
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
