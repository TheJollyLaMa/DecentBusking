const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet } = require('../discord-bot/node_modules/ethers');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { liveRecordingConsentMessage } = require('../js/live-recording-consent.mjs');
const { catalogRecordingAuthorizationMessage, catalogRecordingReleaseApprovalMessage,
  canEditCatalogRecording, moveRecordingBoundary, recordingReleaseApprovalMessage,
  validateCatalogRecordingDraft, validateRecordingDraft } = require('../js/live-recording-edit.mjs');

const ORIGIN = 'https://radio.example';
const performer = Wallet.createRandom(), owner = Wallet.createRandom(), sourceCid = 'a'.repeat(46);
const booking = { id: 'release-room-test', wallet: performer.address, title: 'After the rain',
  status: 'paid', acknowledged: true, payoutPolicy: 'pilot-guaranteed-v1', cancelled: false,
  startUtc: new Date(1_700_000_000_000).toISOString(), endUtc: new Date(1_700_001_200_000).toISOString() };

test('dragging a shared cut moves both songs, clamps minimum length and preserves a valid draft', () => {
  const rate = 48_000;
  const draft = { revision: 1, albumTitle: 'Studio', songs: [
    { title: 'One', startSample: 0, endSample: 10 * rate },
    { title: 'Two', startSample: 10 * rate, endSample: 20 * rate },
    { title: 'Three', startSample: 20 * rate, endSample: 30 * rate },
  ] };
  const moved = moveRecordingBoundary(draft, 30 * rate, 0, 'endSample', 15 * rate + .3);
  assert.equal(moved.songs[0].endSample, 15 * rate);
  assert.equal(moved.songs[1].startSample, 15 * rate);
  assert.equal(draft.songs[0].endSample, 10 * rate);
  assert.doesNotThrow(() => validateCatalogRecordingDraft(moved, 30 * rate));
  const clamped = moveRecordingBoundary(moved, 30 * rate, 0, 'endSample', 30 * rate);
  assert.equal(clamped.songs[0].endSample, 19.5 * rate);
  assert.equal(clamped.songs[1].endSample - clamped.songs[1].startSample, .5 * rate);
  assert.doesNotThrow(() => validateCatalogRecordingDraft(clamped, 30 * rate));
});

test('independent cut edges cannot cross neighbors, exceed export bounds or leave source audio', () => {
  const rate = 48_000;
  const draft = { revision: 1, albumTitle: 'Studio', songs: [
    { title: 'One', startSample: 0, endSample: 10 * rate },
    { title: 'Two', startSample: 20 * rate, endSample: 30 * rate },
  ] };
  const moved = moveRecordingBoundary(draft, 40 * rate, 1, 'startSample', -1000);
  assert.equal(moved.songs[1].startSample, 10 * rate);
  assert.equal(moved.songs[0].endSample, 10 * rate);
  const long = { ...draft, songs: [{ title: 'Long song', startSample: 0, endSample: 60 * rate }] };
  assert.equal(moveRecordingBoundary(long, 3600 * rate, 0, 'endSample', 3600 * rate).songs[0].endSample, 1800 * rate);
  assert.throws(() => moveRecordingBoundary(draft, 40 * rate, 0, 'endSample', NaN), /Invalid recording cut/);
});

test('studio access follows credited audio artists, not holders or collaborator-only credits', () => {
  const nft = { artist: performer.address, creator: owner.address, owner: owner.address,
    contractAddress: `0x${'1'.repeat(40)}`, tokenId: 1, audioUrl: `ipfs://${sourceCid}`, mediaType: 'audio/mpeg' };
  assert.equal(canEditCatalogRecording(nft, performer.address), true);
  assert.equal(canEditCatalogRecording(nft, owner.address), false);
  assert.equal(canEditCatalogRecording({ ...nft, creatorSplits: [{ wallet: owner.address }] }, owner.address), false);
  assert.equal(canEditCatalogRecording({ ...nft, mediaType: 'video/mp4' }, performer.address), false);
});

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

test('catalog cuts require artist-bound NFT source evidence, three named cuts and separate approval', async () => {
  const { createLiveRecorder } = await import('../discord-bot/live-recording.js');
  const nftId = `8453:0x${'1'.repeat(40)}:7`;
  const catalogSource = {
    nftId, chainId: 8453, contractAddress: `0x${'1'.repeat(40)}`, tokenId: 7,
    artistWallet: performer.address.toLowerCase(), sourceCid, title: 'L'.repeat(200), mediaType: 'audio/mpeg',
  };
  const nonce = 'b'.repeat(64), expiresAt = Date.now() + 120_000;
  const authMessage = catalogRecordingAuthorizationMessage({
    nftId, wallet: performer.address, origin: ORIGIN, nonce, expiresAt, sourceCid,
  });
  const authorization = { origin: ORIGIN, nonce, expiresAt, signature: await performer.signMessage(authMessage) };
  const stored = { version: 1, recordings: [] }, submissions = [], releases = new Map();
  let releaseNumber = 0;
  const recorder = createLiveRecorder({
    enabled: true,
    store: { restore: async () => structuredClone(stored), save: async next => { stored.recordings = next.recordings; } },
    upload: async () => `ipfs://${String(++releaseNumber).padEnd(46, 'c')}`,
    download: async () => Buffer.alloc(576_000),
    decodeSource: async () => ({ sourceSamples: 288_000,
      segments: [{ cid: 'd'.repeat(46), bytes: 576_000, waveform: [[-.5, .5]] }] }),
    encodeRange: async () => Buffer.from('encoded catalog cut'),
    submitRelease: async ({ release }) => {
      submissions.push(release);
      const trackId = `catalog-fixture:${release.releaseId}`;
      releases.set(trackId, { mintStatus: 'requested' });
      return { trackId };
    },
    getRelease: trackId => releases.get(trackId) || null,
    now: Date.now,
  });
  await recorder.initialize();
  const edit = await recorder.prepareCatalogEdit(catalogSource, authorization);
  assert.equal(edit.available, true);
  assert.equal(edit.sourceType, 'catalog');
  assert.equal(edit.catalogSource.nftId, nftId);
  assert.equal(edit.draft.songs.length, 3);
  assert.equal(edit.draft.albumTitle.length, 120);
  assert.ok(edit.draft.songs.every(song => song.title.length <= 100));
  assert.deepEqual(validateCatalogRecordingDraft(edit.draft, edit.sourceSamples), edit.draft);
  await assert.rejects(recorder.prepareCatalogEdit({ ...catalogSource, sourceCid: 'e'.repeat(46) }, authorization),
    /authorization is invalid/);
  await assert.rejects(recorder.saveCatalogEdit(catalogSource, edit.draft, owner.address), /Only the artist may edit/);

  const shortDraft = { ...edit.draft, revision: 1, songs: edit.draft.songs.slice(0, 2) };
  await recorder.saveCatalogEdit(catalogSource, shortDraft, performer.address);
  const issuedAt = Date.now();
  const shortApproval = catalogRecordingReleaseApprovalMessage({
    nftId, wallet: performer.address, origin: ORIGIN, sourceCid, sourceSamples: edit.sourceSamples,
    choice: 'split', draft: shortDraft, issuedAt,
  });
  await assert.rejects(recorder.approveCatalogEdit(catalogSource, {
    choice: 'split', issuedAt, signature: await performer.signMessage(shortApproval),
  }, performer.address, ORIGIN), /three or four named cuts/);
  assert.equal(submissions.length, 0);

  const validDraft = { ...edit.draft, revision: 2, songs: edit.draft.songs.map((song, index) => ({
    ...song, title: `Named cut ${index + 1}`,
  })) };
  await recorder.saveCatalogEdit(catalogSource, validDraft, performer.address);
  const fullAt = Date.now();
  const approval = catalogRecordingReleaseApprovalMessage({
    nftId, wallet: performer.address, origin: ORIGIN, sourceCid, sourceSamples: edit.sourceSamples,
    choice: 'full', draft: validDraft, issuedAt: fullAt,
  });
  const full = await recorder.approveCatalogEdit(catalogSource, {
    choice: 'full', issuedAt: fullAt, signature: await performer.signMessage(approval),
  }, performer.address, ORIGIN);
  assert.equal(full.releases.filter(release => release.choice === 'full').length, 1);
  assert.equal(full.releases[0].cid, sourceCid, 'the source remains unchanged for a separately approved full-set release');
  assert.equal(submissions.length, 1);
  releases.get(full.releases[0].trackId).mintStatus = 'minted';

  const splitAt = Date.now();
  const splitApproval = catalogRecordingReleaseApprovalMessage({
    nftId, wallet: performer.address, origin: ORIGIN, sourceCid, sourceSamples: edit.sourceSamples,
    choice: 'split', draft: validDraft, issuedAt: splitAt,
  });
  const result = await recorder.approveCatalogEdit(catalogSource, {
    choice: 'split', issuedAt: splitAt, signature: await performer.signMessage(splitApproval),
  }, performer.address, ORIGIN);
  const cuts = result.releases.filter(release => release.choice === 'split');
  assert.equal(cuts.length, 3);
  assert.ok(cuts.every(release => release.status === 'queued' && release.parentReleaseId === full.releases[0].releaseId));
  assert.equal(submissions.length, 4);
  assert.ok(submissions.every(release => release.approvalSignature));
});

test('unsigned catalog preview makes no writes; one final signature binds cuts, survives restore and cannot duplicate releases', async () => {
  const { createLiveRecorder } = await import('../discord-bot/live-recording.js');
  const source = { nftId: `8453:0x${'1'.repeat(40)}:9`, chainId: 8453,
    contractAddress: `0x${'1'.repeat(40)}`, tokenId: 9, artistWallet: performer.address.toLowerCase(),
    sourceCid, title: 'Public original', mediaType: 'audio/mpeg' };
  let state = { version: 1, recordings: [] }, writes = 0, uploads = 0, decodes = 0;
  const submitted = [], tracks = new Map();
  const options = { enabled: true,
    store: { restore: async () => structuredClone(state), save: async next => { writes++; state = structuredClone(next); } },
    upload: async () => { uploads++; return `ipfs://${'d'.repeat(46)}`; },
    download: async () => Buffer.alloc(576_000),
    decodeSource: async (_source, { previewOnly, upload }) => {
      decodes++;
      if (previewOnly) assert.equal(upload, undefined);
      else await upload(Buffer.from('decoded PCM'));
      return { sourceSamples: 288_000, segments: [{ cid: 'd'.repeat(46), bytes: 576_000, waveform: [[-.5, .5]] }] };
    },
    encodeRange: async () => Buffer.from('encoded cut'),
    submitRelease: async ({ release }) => {
      submitted.push(release);
      const trackId = `unsigned:${release.releaseId}`;
      tracks.set(trackId, { mintStatus: 'requested' });
      return { trackId };
    },
    getRelease: id => tracks.get(id) || null,
  };
  const recorder = createLiveRecorder(options);
  const preview = await recorder.previewCatalogEdit(source);
  assert.equal(preview.journalRevision, 0);
  assert.equal(writes, 0);
  assert.equal(uploads, 0);
  assert.equal(submitted.length, 0);
  await recorder.previewCatalogEdit(source);
  assert.equal(decodes, 1, 'read-only analysis is cached');
  const draft = { ...preview.draft, revision: 1, albumTitle: 'Artist final edit' };
  const command = { choice: 'split', sourceCid, sourceSamples: preview.sourceSamples, draft, issuedAt: Date.now() };
  command.signature = await performer.signMessage(catalogRecordingReleaseApprovalMessage({
    ...command, nftId: source.nftId, wallet: performer.address, origin: ORIGIN,
  }));
  await assert.rejects(recorder.publishCatalogEdit(source, { ...command, draft: { ...draft, albumTitle: 'Changed' } },
    performer.address, ORIGIN), /Only the credited artist/);
  await assert.rejects(recorder.publishCatalogEdit(source, command, owner.address, ORIGIN), /invalid or expired/);
  await assert.rejects(recorder.publishCatalogEdit(source, command, performer.address, 'https://other.example'),
    /Only the credited artist/);
  const resign = async changes => {
    const updated = { ...command, ...changes };
    updated.signature = await performer.signMessage(catalogRecordingReleaseApprovalMessage({
      ...updated, nftId: source.nftId, wallet: performer.address, origin: ORIGIN,
    }));
    return updated;
  };
  await assert.rejects(recorder.publishCatalogEdit(source,
    await resign({ sourceSamples: command.sourceSamples + 48000 }), performer.address, ORIGIN), /original recording changed/);
  await assert.rejects(recorder.publishCatalogEdit(source,
    await resign({ draft: { ...draft, revision: 3 } }), performer.address, ORIGIN), /Another edit changed the journal/);
  assert.equal(writes, 0);
  assert.equal(uploads, 0);
  const result = await recorder.publishCatalogEdit(source, command, performer.address, ORIGIN);
  assert.equal(result.releases.length, 3);
  assert.ok(result.releases.every(release => release.status === 'queued'));
  assert.equal(submitted.length, 3);
  assert.equal(state.recordings[0].catalogSource.authorization.kind, 'publication');
  await recorder.publishCatalogEdit(source, command, performer.address, ORIGIN);
  assert.equal(submitted.length, 3, 'identical signed retries must reuse queued releases');
  const restored = createLiveRecorder(options);
  await restored.initialize();
  const anonymousPreview = await restored.previewCatalogEdit(source);
  assert.equal(anonymousPreview.journalRevision, 1);
  assert.equal(anonymousPreview.draft.albumTitle, source.title, 'private saved drafts are not exposed by previews');
  assert.deepEqual(anonymousPreview.releases, []);
  await restored.publishCatalogEdit(source, command, performer.address, ORIGIN);
  assert.equal(submitted.length, 3);
});

test('gateway source download preserves gateway tokens, falls back on denial and redacts network failures', async () => {
  const { fetchCatalogRecordingSource } = await import('../discord-bot/live-recording.js');
  const urls = [], warnings = [];
  const result = await fetchCatalogRecordingSource(sourceCid, {
    gateways: ['https://private.example/ipfs/?pinataGatewayToken=fixture-secret', 'https://public.example'],
    fetchImpl: async (url, options) => {
      urls.push(new URL(url));
      assert.equal(options.redirect, 'error');
      return urls.length === 1 ? new Response('denied', { status: 401 }) : new Response('audio');
    },
    log: { warn: (...args) => warnings.push(args.join(' ')) },
  });
  assert.equal(await result.text(), 'audio');
  assert.equal(urls[0].searchParams.get('pinataGatewayToken'), 'fixture-secret');
  assert.equal(urls[1].pathname, `/ipfs/${sourceCid}`);
  assert.ok(warnings.some(line => line.includes('401')));
  assert.ok(warnings.every(line => !line.includes('fixture-secret')));
  await assert.rejects(fetchCatalogRecordingSource(sourceCid, {
    gateways: ['https://private.example/ipfs/?token=fixture-secret'],
    fetchImpl: async () => { throw Error('provider URL contains fixture-secret'); },
    log: { warn: (...args) => warnings.push(args.join(' ')) },
  }), /could not be downloaded/);
  assert.ok(warnings.every(line => !line.includes('fixture-secret')));
});

test('live recordings also accept a single final approval without an access session', async () => {
  const f = await fixture();
  const preview = await f.recorder.previewEdit(booking);
  assert.equal(preview.previewOnly, true);
  const command = { choice: 'split', sourceCid, sourceSamples: preview.sourceSamples, draft: splitDraft(), issuedAt: Date.now() };
  command.signature = await performer.signMessage(recordingReleaseApprovalMessage({
    ...command, bookingId: booking.id, wallet: performer.address, origin: ORIGIN, incomplete: false,
  }));
  const result = await f.recorder.publishEdit(booking, command, performer.address, ORIGIN);
  assert.equal(result.releases.length, 2);
  await f.recorder.publishEdit(booking, command, performer.address, ORIGIN);
  assert.equal(f.submitted.length, 2);
});

test('catalog source decoding uses bounded PCM segments and exact sample counts', async () => {
  const { createLiveRecorder, pcmWav } = await import('../discord-bot/live-recording.js');
  const nftId = `8453:0x${'2'.repeat(40)}:8`, catalogCid = 'f'.repeat(46);
  const catalogSource = {
    nftId, chainId: 8453, contractAddress: `0x${'2'.repeat(40)}`, tokenId: 8,
    artistWallet: performer.address.toLowerCase(), sourceCid: catalogCid,
    title: 'Synthetic WAV', mediaType: 'audio/wav',
  };
  const nonce = 'c'.repeat(64), expiresAt = Date.now() + 120_000;
  const authMessage = catalogRecordingAuthorizationMessage({
    nftId, wallet: performer.address, origin: ORIGIN, nonce, expiresAt, sourceCid: catalogCid,
  });
  const uploaded = [];
  const recorder = createLiveRecorder({
    enabled: true,
    store: { restore: async () => ({ version: 1, recordings: [] }), save: async () => {} },
    upload: async bytes => {
      uploaded.push(Buffer.from(bytes));
      return `ipfs://${'d'.repeat(46)}`;
    },
    download: async () => Buffer.alloc(96_000),
    downloadSource: async () => new Response(pcmWav(Buffer.alloc(48_000 * 2 * 6)), {
      status: 200, headers: { 'content-type': 'audio/wav' },
    }),
    submitRelease: async () => ({ trackId: 'unused' }),
  });
  await recorder.initialize();
  const preview = await recorder.previewCatalogEdit(catalogSource);
  assert.equal(preview.sourceSamples, 48_000 * 6);
  assert.equal(preview.previewOnly, true);
  assert.ok(preview.waveform.length > 0);
  assert.equal(uploaded.length, 0, 'unsigned waveform analysis must not upload decoded PCM');
  const result = await recorder.prepareCatalogEdit(catalogSource, {
    origin: ORIGIN, nonce, expiresAt, signature: await performer.signMessage(authMessage),
  });
  assert.equal(result.available, true);
  assert.equal(result.sourceSamples, 48_000 * 6);
  assert.equal(result.sampleRate, 48_000);
  assert.equal(uploaded.length, 1);
  assert.equal(result.waveform.at(-1).endSample, 48_000 * 6);
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
