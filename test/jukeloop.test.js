const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('playlist tracks each attachment and persists its IPFS pin state', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decent-jukeloop-'));
  const storePath = path.join(tempDir, 'playlist.json');
  process.env.JUKELOOP_PLAYLIST_PATH = storePath;
  t.after(() => {
    delete process.env.JUKELOOP_PLAYLIST_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const storeUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'playlist-store.js'));
  storeUrl.searchParams.set('test', String(Date.now()));
  const store = await import(storeUrl.href);
  store.loadPlaylist();

  const common = {
    messageId: 'message-1',
    channelId: 'channel-1',
    title: 'Track',
    uploader: 'artist',
    uploaderId: 'user-1',
    pinStatus: 'pending',
  };
  assert.equal(store.addTrack({ ...common, attachmentId: 'attachment-1', filename: 'one.mp3' }), true);
  assert.equal(store.addTrack({ ...common, attachmentId: 'attachment-2', filename: 'two.mp3' }), true);
  assert.equal(store.addTrack({ ...common, attachmentId: 'attachment-1', filename: 'one.mp3' }), false);

  store.updateTrackPin('attachment-1', { status: 'pinned', ipfsCid: 'bafy-audio' });
  const persisted = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.equal(persisted.length, 2);
  assert.deepEqual(
    persisted.map((track) => track.trackId),
    ['attachment-1', 'attachment-2'],
  );
  assert.equal(persisted[0].pinStatus, 'pinned');
  assert.equal(persisted[0].ipfsCid, 'bafy-audio');
  assert.equal(persisted[0].mintStatus, 'unminted');
  assert.equal(store.getMintBacklog('user-1').length, 2);

  assert.equal(store.requestTrackMint('attachment-1', 'another-user', '0x1111111111111111111111111111111111111111'), null);
  const request = store.requestTrackMint(
    'attachment-1',
    'user-1',
    '0x1111111111111111111111111111111111111111',
    'bafy-artwork',
  );
  assert.equal(request.mintStatus, 'requested');
  assert.equal(request.artworkCid, 'bafy-artwork');
  assert.equal(store.getMintRequests().length, 1);

  const minted = store.completeTrackMint('attachment-1', {
    tokenId: 42,
    txHash: '0xabc',
  });
  assert.equal(minted.mintStatus, 'minted');
  assert.equal(minted.tokenId, '42');
  assert.equal(store.getMintBacklog('user-1').length, 1);

  const rated = store.applyRating('attachment-2', 2, 1, 'rating-message-1');
  assert.deepEqual(
    { likes: rated.likes, dislikes: rated.dislikes, plays: rated.plays },
    { likes: 2, dislikes: 1, plays: 0 },
  );
  store.applyRating('attachment-2', 2, 1, 'rating-message-1');
  assert.deepEqual(
    { likes: rated.likes, dislikes: rated.dislikes, plays: rated.plays },
    { likes: 2, dislikes: 1, plays: 0 },
  );
  assert.equal(store.reconcileRatings([
    { trackId: 'attachment-2', likes: 1, dislikes: 0, messageId: 'rating-message-1' },
    { trackId: 'attachment-2', likes: 1, dislikes: 0, messageId: 'rating-message-2' },
  ]), 1);
  assert.deepEqual(
    { likes: rated.likes, dislikes: rated.dislikes, plays: rated.plays },
    { likes: 3, dislikes: 1, plays: 1 },
  );
  const audible = store.recordAudiblePlay('attachment-2', {
    playId: 'play-attachment-2-1',
    startedAt: Date.parse('2026-10-05T12:00:00Z'),
    endedAt: Date.parse('2026-10-05T12:04:00Z'),
    audibleMs: 240_000,
  });
  assert.equal(audible.counted, true);
  assert.equal(audible.week, '2026-W41');
  assert.equal(rated.plays, 2);
  assert.equal(store.recordAudiblePlay('attachment-2', {
    playId: 'play-attachment-2-1', startedAt: 0, endedAt: 240_000, audibleMs: 240_000,
  }).reason, 'duplicate');

  const snapshots = [];
  store.configureRemotePersistence(async (playlist) => {
    snapshots.push(playlist.map((track) => track.pinStatus));
  });
  store.updateTrackPin('attachment-2', { status: 'failed', error: 'temporary' });
  store.updateTrackPin('attachment-2', { status: 'pinned', ipfsCid: 'bafy-two' });
  await store.waitForRemotePersistence();
  assert.deepEqual(snapshots, [
    ['pinned', 'failed'],
    ['pinned', 'pinned'],
  ]);
  const beforeVote = { likes: rated.likes, dislikes: rated.dislikes, plays: rated.plays };
  store.applySiteVote('attachment-2', 1);
  store.applySiteVote('attachment-2', -1);
  assert.equal(rated.likes, beforeVote.likes + 1);
  assert.equal(rated.dislikes, beforeVote.dislikes + 1);
  assert.equal(rated.plays, beforeVote.plays);
});

test('JukeLoop builds canonical IPFS gateway URLs and cumulative rating messages', async () => {
  const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'jukeloop.js'));
  const {
    buildIpfsGatewayUrl,
    buildNowPlayingMessage,
    getVoiceRetryDelay,
    parseNowPlayingMessage,
  } = await import(moduleUrl.href);

  assert.equal(
    buildIpfsGatewayUrl('https://w3s.link', 'bafy-audio'),
    'https://w3s.link/ipfs/bafy-audio',
  );
  assert.equal(
    buildIpfsGatewayUrl('https://dweb.link/ipfs/', 'bafy-audio'),
    'https://dweb.link/ipfs/bafy-audio',
  );

  const message = buildNowPlayingMessage({
    trackId: 'attachment-1',
    title: 'Track', uploader: 'artist', ipfsCid: 'bafy-audio', likes: 12, dislikes: 3, plays: 8,
  }, {
    queueIndex: 2,
    totalTracks: 10,
    url: 'https://gateway.example/ipfs/bafy-audio',
  });
  assert.match(message, /All-time:\*\* 👍 12 · 👎 3 · ▶️ 8/);
  assert.match(message, /React 👍 to boost it/);
  assert.match(message, /Track ID: \|\|attachment-1\|\|/);
  assert.deepEqual(parseNowPlayingMessage(
    '🎵 Now playing: **Track** by *artist* (1/10)\nTrack ID: ||attachment-1||',
  ), { title: 'Track', uploader: 'artist', trackId: 'attachment-1' });
  assert.deepEqual(parseNowPlayingMessage(
    '🎵 Now playing: **Legacy Track** by *legacy_artist* (1/10) — rate this track!',
  ), { title: 'Legacy Track', uploader: 'legacy_artist', trackId: null });
  assert.equal(getVoiceRetryDelay(1), 15_000);
  assert.equal(getVoiceRetryDelay(2), 30_000);
  assert.equal(getVoiceRetryDelay(10), 5 * 60_000);
});
test('radio state publishes the audible track position and newest uploads', async () => {
  const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'jukeloop.js'));
  const { buildRadioState } = await import(moduleUrl.href);

  const state = buildRadioState({
    now: 100_000,
    nowPlaying: {
      trackId: 'track-1', title: 'Song', uploader: 'artist', filename: 'song.m4a',
      ipfsCid: 'bafy-song', startedAt: 40_000, audible: true,
    },
    playlist: [
      { trackId: 'old', title: 'Old', uploader: 'a', filename: 'old.mp3', ipfsCid: 'bafy-old', addedAt: '2026-10-01T00:00:00.000Z', uploaderId: 'secret' },
      { trackId: 'new', title: 'New', uploader: 'b', filename: 'new.mp3', addedAt: '2026-10-02T00:00:00.000Z' },
    ],
  });

  assert.deepEqual(state.nowPlaying, {
    playId: 'track-1:40000',
    trackId: 'track-1',
    title: 'Song',
    uploader: 'artist',
    filename: 'song.m4a',
    ipfsCid: 'bafy-song',
    startedAt: 40_000,
    positionMs: 60_000,
  });
  assert.deepEqual(state.recent.map((track) => [track.trackId, track.ipfsCid]), [['new', null], ['old', 'bafy-old']]);
  assert.equal('uploaderId' in state.recent[1], false);
  assert.equal(buildRadioState({ nowPlaying: null, playlist: [] }).nowPlaying, null);
});

test('JukeLoop falls back to Pinata when the configured IPFS gateway cannot stream', async () => {
  const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'jukeloop.js'));
  const { resolveStreamableIpfsUrl } = await import(moduleUrl.href);
  const requested = [];
  const fetchImpl = async (url, options) => {
    requested.push(url);
    assert.equal(options.headers.range, 'bytes=0-0');
    return new Response('x', { status: url.startsWith('https://dweb.link') ? 429 : 206 });
  };

  assert.equal(
    await resolveStreamableIpfsUrl('https://dweb.link', 'bafy-song', fetchImpl),
    'https://gateway.pinata.cloud/ipfs/bafy-song',
  );
  assert.deepEqual(requested, ['https://dweb.link/ipfs/bafy-song', 'https://gateway.pinata.cloud/ipfs/bafy-song']);
  assert.equal(await resolveStreamableIpfsUrl('https://dweb.link', 'bafy-song', async () => new Response('', { status: 429 })), null);
});

test('admin batch queue requests every archived unminted upload by one artist, oldest first', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decent-queue-'));
  process.env.JUKELOOP_PLAYLIST_PATH = path.join(tempDir, 'playlist.json');
  t.after(() => {
    delete process.env.JUKELOOP_PLAYLIST_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const storeUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'playlist-store.js'));
  storeUrl.searchParams.set('queue-test', String(Date.now()));
  const store = await import(storeUrl.href);
  store.loadPlaylist([
    { trackId: 'newer', uploaderId: 'artist', pinStatus: 'pinned', ipfsCid: 'bafy-2', mintStatus: 'unminted', addedAt: '2026-10-02T00:00:00Z' },
    { trackId: 'older', uploaderId: 'artist', pinStatus: 'pinned', ipfsCid: 'bafy-1', mintStatus: 'unminted', addedAt: '2026-10-01T00:00:00Z' },
    { trackId: 'not-archived', uploaderId: 'artist', pinStatus: 'failed', mintStatus: 'unminted', addedAt: '2026-10-01T00:00:00Z' },
    { trackId: 'minted', uploaderId: 'artist', pinStatus: 'pinned', ipfsCid: 'bafy-m', mintStatus: 'minted', addedAt: '2026-09-01T00:00:00Z' },
    { trackId: 'already-requested', uploaderId: 'artist', pinStatus: 'pinned', ipfsCid: 'bafy-r', mintStatus: 'requested', mintRecipient: '0xabc', mintRequestedAt: '2026-09-02T00:00:00Z', addedAt: '2026-09-01T00:00:00Z' },
    { trackId: 'someone-else', uploaderId: 'other', pinStatus: 'pinned', ipfsCid: 'bafy-o', mintStatus: 'unminted', addedAt: '2026-10-01T00:00:00Z' },
  ]);

  const wallet = '0x1111111111111111111111111111111111111111';
  const { queued, skipped } = store.queueUploaderMints('artist', wallet, { artworkCid: 'bafy-avatar', now: Date.parse('2026-10-03T00:00:00Z') });
  assert.deepEqual(queued.map((track) => track.trackId), ['older', 'newer']);
  assert.equal(skipped, 1);
  assert.deepEqual(
    store.getMintRequests().map((track) => [track.trackId, track.artworkCid ?? null]),
    [['already-requested', 'bafy-avatar'], ['older', 'bafy-avatar'], ['newer', 'bafy-avatar']],
  );
  assert.deepEqual(store.getMintRequests().map((track) => [track.trackId, track.mintRecipient]), [
    ['already-requested', '0xabc'],
    ['older', wallet],
    ['newer', wallet],
  ]);
  assert.equal(store.queueUploaderMints('artist', wallet).queued.length, 0);
});

test('track titles keep the emoji and accents Discord strips from filenames', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decent-titles-'));
  process.env.JUKELOOP_PLAYLIST_PATH = path.join(tempDir, 'playlist.json');
  t.after(() => {
    delete process.env.JUKELOOP_PLAYLIST_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const { getAttachmentTitle } = await import(pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'jukeloop.js')).href);
  assert.equal(getAttachmentTitle({ name: '561_.m4a', title: '561 🐄 🐮 🐄' }), '561 🐄 🐮 🐄');
  assert.equal(getAttachmentTitle({ name: '576_deja_vu.m4a', title: '576 déjà vu.m4a' }), '576 déjà vu');
  assert.equal(getAttachmentTitle({ name: 'old_track-name.mp3', title: null }), 'old track name');

  const storeUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'playlist-store.js'));
  storeUrl.searchParams.set('title-test', String(Date.now()));
  const store = await import(storeUrl.href);
  store.loadPlaylist([
    { trackId: 'attachment-561', title: '561', addedAt: '2026-10-01T00:00:00Z' },
    { trackId: 'message-1:592_i_cant_dance.m4a', title: '592 i cant dance', addedAt: '2026-10-01T00:00:00Z' },
  ]);
  assert.equal(store.restoreTrackTitles([
    { trackId: 'attachment-561', title: '561 🐄 🐮 🐄' },
    { trackId: 'attachment-592', legacyTrackId: 'message-1:592_i_cant_dance.m4a', title: '592 i can’t dance' },
    { trackId: 'missing', title: 'Nope' },
  ]), 2);
  assert.deepEqual(store.getPlaylist().map((track) => track.title), ['561 🐄 🐮 🐄', '592 i can’t dance']);
  assert.equal(store.restoreTrackTitles([{ trackId: 'attachment-561', title: '561 🐄 🐮 🐄' }]), 0);
});

test('radio play ID stays stable when the audible start time is refined', async () => {
  const { buildRadioState } = await import(pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'jukeloop.js')).href);
  const playing = { playId: 'track-1:1000', trackId: 'track-1', title: 'Song', uploader: 'artist', startedAt: 1000 };
  const before = buildRadioState({ nowPlaying: playing, playlist: [], now: 1500 });
  const after = buildRadioState({ nowPlaying: { ...playing, startedAt: 1800, audible: true }, playlist: [], now: 2000 });
  assert.equal(before.nowPlaying.playId, 'track-1:1000');
  assert.equal(after.nowPlaying.playId, 'track-1:1000');
  assert.equal(after.nowPlaying.positionMs, 200);
});

test('site radio waits until Discord is audible instead of playing a premature intro', async () => {
  const { buildRadioState } = await import(pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'jukeloop.js')).href);
  const track = { playId: 'track:1000', trackId: 'track', title: 'Song', uploader: 'Artist', startedAt: 1000, audible: false };
  assert.equal(buildRadioState({ nowPlaying: track, playlist: [], now: 6000 }).nowPlaying, null);
  const started = buildRadioState({ nowPlaying: { ...track, audible: true, startedAt: 6000 }, playlist: [], now: 6100 });
  assert.equal(started.nowPlaying.playId, 'track:1000');
  assert.equal(started.nowPlaying.positionMs, 100);
});

test('anonymous site votes are idempotent per browser and only accepted for the active play', async (t) => {
  const { createJukeLoopSession, submitJukeLoopVote } = await import(pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'jukeloop.js')).href);
  const session = createJukeLoopSession('site-vote-test', { voiceChannel: { guild: { id: 'site-vote-test' } }, textChannel: {}, client: {} });
  t.after(() => session.destroy());
  session._nowPlaying = { playId: 'track:1000', trackId: 'track', audible: true };
  const calls = [];
  const saveVote = (...args) => calls.push(args);
  const ballot = { playId: 'track:1000', voterId: 'anonymous-browser-123', vote: 1 };
  assert.equal(submitJukeLoopVote(ballot, saveVote).duplicate, false);
  assert.deepEqual(submitJukeLoopVote({ ...ballot, vote: -1 }, saveVote), { playId: 'track:1000', vote: 1, duplicate: true });
  assert.equal(calls.length, 1);
  assert.throws(() => submitJukeLoopVote({ ...ballot, playId: 'old-play' }, saveVote), /ended/);
  assert.throws(() => submitJukeLoopVote({ ...ballot, vote: 0 }, saveVote), /Invalid/);
  session._nowPlaying = { playId: 'track:2000', trackId: 'track', audible: true };
  assert.equal(submitJukeLoopVote({ ...ballot, playId: 'track:2000', vote: -1 }, saveVote).duplicate, false);
  assert.deepEqual(calls, [['track', 1], ['track', -1]]);
});
