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
    { trackId: 'attachment-2', likes: 2, dislikes: 1, messageId: 'rating-message-1' },
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
  store.applyRating('attachment-2', 3, 1, 'rating-message-1');
  assert.equal(rated.likes, 4);
  store.applyRating('attachment-2', 3, 1, 'rating-message-1');
  assert.equal(rated.likes, 4);
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
    getAttachmentTitle,
  } = await import(moduleUrl.href);

  assert.equal(getAttachmentTitle({ name: 'performance.mp4', title: 'Performance.mp4' }), 'Performance');

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

test('site MP4 submissions stay out of radio until owner-approved mint completion', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'decent-video-queue-'));
  process.env.JUKELOOP_PLAYLIST_PATH = path.join(temp, 'playlist.json');
  t.after(() => { delete process.env.JUKELOOP_PLAYLIST_PATH; fs.rmSync(temp, { recursive: true, force: true }); });
  const moduleUrl = pathToFileURL(path.join(__dirname, '../discord-bot/playlist-store.js'));
  moduleUrl.searchParams.set('video-queue', Date.now());
  const store = await import(moduleUrl.href);
  store.loadPlaylist([]);
  const media = { address: '0x1111111111111111111111111111111111111111', title: 'Video', artist: 'Artist',
    recipient: '0x1111111111111111111111111111111111111111', ipfsCid: 'bafy-video',
    mediaType: 'video/mp4', filename: 'video.mp4', parentTokenId: 3, artworkCid: 'bafy-art' };
  const track = store.submitMediaTrack(media);
  assert.equal(track.mintStatus, 'requested');
  assert.equal(store.getMintRequests().length, 1);
  assert.equal(store.getLatestMessageId(), null);
  assert.equal(store.submitMediaTrack({ ...media, title: 'Duplicate' }).trackId, track.trackId);
  assert.equal(store.getPlaylist().length, 1);
  assert.equal(store.getWeightedShuffledPlaylist().length, 0);
  const { buildRadioState } = await import(pathToFileURL(path.join(__dirname, '../discord-bot/jukeloop.js')).href);
  assert.equal(buildRadioState({ playlist: store.getPlaylist(), nowPlaying: null }).recent.length, 0);
  store.completeTrackMint(track.trackId, { tokenId: '42', txHash: '0xmint' });
  assert.ok(store.getWeightedShuffledPlaylist().every(entry => entry.mediaType === 'video/mp4'));
  const recent = buildRadioState({ playlist: store.getPlaylist(), nowPlaying: null }).recent;
  assert.equal(recent[0].mediaType, 'video/mp4');
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
    mediaType: 'audio/mp4',
    ipfsCid: 'bafy-song',
    startedAt: 40_000,
    positionMs: 60_000,
  });
  assert.deepEqual(state.recent.map((track) => [track.trackId, track.ipfsCid]), [['new', null], ['old', 'bafy-old']]);
  assert.equal('uploaderId' in state.recent[1], false);
  assert.equal(buildRadioState({ nowPlaying: null, playlist: [] }).nowPlaying, null);
});

test('Discord and site votes update one track ledger without bot votes or duplicate plays', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'decent-master-votes-'));
  process.env.JUKELOOP_PLAYLIST_PATH = path.join(temp, 'playlist.json');
  t.after(() => { delete process.env.JUKELOOP_PLAYLIST_PATH; fs.rmSync(temp, { recursive: true, force: true }); });
  const storeUrl = pathToFileURL(path.join(__dirname, '../discord-bot/playlist-store.js'));
  storeUrl.searchParams.set('master-votes', Date.now());
  const store = await import(storeUrl.href);
  const { synchronizeDiscordRating, parseNowPlayingMessage, buildNowPlayingMessage } = await import(pathToFileURL(path.join(__dirname, '../discord-bot/jukeloop.js')).href);
  const synchronize = (message, options) => synchronizeDiscordRating(message, 'bot', { ...options, store });
  store.loadPlaylist([{ trackId: 'track', title: 'Song', uploader: 'Artist', uploaderId: 'artist', messageId: 'upload',
    mintRecipient: '0x1111111111111111111111111111111111111111', likes: 0, dislikes: 0, plays: 0 }]);
  const content = buildNowPlayingMessage(store.getPlaylist()[0], { queueIndex: 1, totalTracks: 1, playId: 'play-1', votingOpen: false });
  assert.equal(parseNowPlayingMessage(content).playId, 'play-1');
  const reactions = new Map([
    ['up', { emoji: { name: '👍' }, count: 2, me: true }],
    ['tone', { emoji: { name: '👍🏻' }, count: 1, me: false }],
    ['down', { emoji: { name: '👎' }, count: 1, me: true }],
  ]);
  const message = { id: 'announcement', author: { id: 'bot', bot: true }, content, reactions: { cache: reactions } };
  synchronize(message);
  synchronize(message);
  store.applySiteVote('track', 1);
  assert.equal(store.getPlaylist()[0].likes, 3);
  assert.equal(store.getPlaylist()[0].plays, 0);
  reactions.get('up').count = 3;
  synchronize(message, { change: 1, emoji: '👍' });
  assert.equal(store.getPlaylist()[0].likes, 4);
  reactions.get('up').count = 2;
  synchronize(message, { change: -1, emoji: '👍' });
  assert.equal(store.getPlaylist()[0].likes, 3);
  synchronize({ id: 'upload', author: { id: 'artist', bot: false }, content: '',
    reactions: { cache: new Map([['up', { emoji: { name: '👍' }, count: 1, me: false }]]) } }, { change: 1, emoji: '👍' });
  assert.equal(store.getPlaylist()[0].likes, 4);
  store.recordAudiblePlay('track', { playId: 'play-1', announcementId: 'announcement', startedAt: 0, endedAt: 60000, audibleMs: 60000 });
  const plays = store.getPlaylist()[0].plays;
  store.reconcileRatings([{ trackId: 'track', messageId: 'announcement', playId: 'play-1', likes: 2, dislikes: 0 }]);
  assert.equal(store.getPlaylist()[0].plays, plays);
});

test('historical printed totals restore one master floor and never create qualified weekly playbacks', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'decent-master-history-'));
  process.env.JUKELOOP_PLAYLIST_PATH = path.join(temp, 'playlist.json');
  t.after(() => { delete process.env.JUKELOOP_PLAYLIST_PATH; fs.rmSync(temp, { recursive: true, force: true }); });
  const url = pathToFileURL(path.join(__dirname, '../discord-bot/playlist-store.js'));
  url.searchParams.set('master-history', Date.now());
  const store = await import(url.href);
  store.loadPlaylist([{ trackId: 'track', title: 'Song', uploader: 'Artist', likes: 2, dislikes: 0, plays: 5 }]);
  const events = [{ trackId: 'track', messageId: 'old', likes: 0, dislikes: 0, legacyTotals: { likes: 14, dislikes: 2, plays: 30 } }];
  store.reconcileRatings(events);
  store.reconcileRatings(events);
  const track = store.getPlaylist()[0];
  assert.equal(track.likes, 14);
  assert.equal(track.dislikes, 2);
  assert.equal(track.plays, 30);
  assert.equal(track.weeklyPlays, undefined);
  store.applyRating('track', 1, 0, 'old');
  assert.equal(track.likes, 15);
  store.reconcileRatings([{ trackId: 'track', messageId: 'new-modern', playId: 'short-play', likes: 0, dislikes: 0 }]);
  assert.equal(track.plays, 30);
  store.recordAudiblePlay('track', { playId: 'completed', announcementId: 'abandoned', startedAt: 0, endedAt: 60000, audibleMs: 60000 });
  store.reconcileRatings([{ trackId: 'track', messageId: 'abandoned', likes: 0, dislikes: 0 }]);
  assert.equal(track.plays, 31);
  assert.equal(track.weeklyPlays['1970-W01'], 1);
  store.loadPlaylist([{ trackId: 'visible', title: 'Visible', likes: 1, dislikes: 0, plays: 4 }]);
  const visible = [{ trackId: 'visible', messageId: 'old-visible', likes: 8, dislikes: 1,
    legacyTotals: { likes: 2, dislikes: 0, plays: 4 } }];
  store.reconcileRatings(visible);
  store.reconcileRatings(visible);
  assert.equal(store.getPlaylist()[0].likes, 8);
  assert.equal(store.getPlaylist()[0].dislikes, 1);
  assert.equal(store.getPlaylist()[0].plays, 4);
});

test('historic MP4 discovery accepts exactly 10 MB, skips larger attachments, and remains wallet-unassigned', async () => {
  const { backfillFromChannel } = await import(pathToFileURL(path.join(__dirname, '../discord-bot/jukeloop.js')).href);
  const { DISCORD_UPLOAD_MAX_BYTES, isDiscordAttachmentWithinLimit } = await import(pathToFileURL(path.join(__dirname, '../discord-bot/media.js')).href);
  assert.equal(DISCORD_UPLOAD_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(isDiscordAttachmentWithinLimit({ size: DISCORD_UPLOAD_MAX_BYTES }), true);
  assert.equal(isDiscordAttachmentWithinLimit({ size: DISCORD_UPLOAD_MAX_BYTES + 1 }), false);
  const attachments = new Map([
    ['small', { id: 'small', name: 'Performance.MP4', size: DISCORD_UPLOAD_MAX_BYTES }],
    ['large', { id: 'large', name: 'TooLarge.mp4', size: DISCORD_UPLOAD_MAX_BYTES + 1 }],
  ]);
  const message = { id: '123', author: { bot: false, id: 'artist', username: 'Artist' }, attachments };
  const batch = new Map([['123', message]]);
  batch.last = () => message;
  const tracks = [];
  const channel = { id: 'channel', messages: { fetch: async () => batch } };
  const added = await backfillFromChannel(channel, {
    addTrack: track => { tracks.push(track); return true; }, restoreTrackTitles: () => 0,
  });
  assert.equal(added, 1);
  assert.equal(tracks[0].attachmentId, 'small');
  assert.equal(tracks[0].uploaderId, 'artist');
  assert.equal(tracks[0].mintRecipient, undefined);
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

test('Discord reaction synchronization preserves the event timestamp for payroll-week attribution', async () => {
  const { synchronizeDiscordRating } = await import(pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'jukeloop.js')).href);
  const eventAt = Date.parse('2026-10-12T03:59:59Z');
  let ratingOptions;
  const store = {
    getPlaylist: () => [{ trackId: 'weekly-track' }],
    applyRating: (_trackId, _likes, _dislikes, _messageId, options) => { ratingOptions = options; return {}; },
  };
  synchronizeDiscordRating({
    id: 'announcement',
    author: { id: 'bot', bot: true },
    content: '🎵 Now playing: **Song** by *Artist*\nTrack ID: ||weekly-track||',
    reactions: { cache: new Map([['up', { emoji: { name: '👍' }, count: 2, me: true }]]) },
  }, 'bot', { change: 1, emoji: '👍', now: eventAt, store });
  assert.equal(ratingOptions.now, eventAt);
});

test('scheduled live performance blocks paid picks and resumes the queue when cancelled', async (t) => {
  const { JukeLoopSession } = await import(pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'jukeloop.js')).href);
  const notices = [];
  let paidPicks = 0;
  const session = new JukeLoopSession({
    voiceChannel: { guild: { id: 'live-schedule-test' } },
    textChannel: { send: async message => notices.push(message) },
    client: {},
    djuke: { nextPaid: async () => { paidPicks++; return null; } },
  });
  t.after(() => session.destroy());
  session._started = true;
  const resume = session._playNext;
  let resumeCalls = 0;
  session._playNext = async () => { resumeCalls++; };
  const now = Date.now();
  session.setLivePerformanceEvents([{
    id: 'live-test-event', title: 'Live Test Set',
    startUtc: new Date(now - 1000).toISOString(),
    endUtc: new Date(now + 60_000).toISOString(),
  }]);
  session._playNext = resume;
  await session._playNext();
  assert.equal(paidPicks, 0);
  assert.equal(session._liveEventId, 'live-test-event');
  session._playNext = async () => { resumeCalls++; };
  session.setLivePerformanceEvents([]);
  assert.equal(session._liveEventId, null);
  assert.equal(resumeCalls, 1);
  assert.match(notices[0], /Live performance block: Live Test Set/);
});

test('JukeLoop announces the Top 10 final voting hour and its close', async (t) => {
  const { JukeLoopSession } = await import(pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'jukeloop.js')).href);
  const notices = [];
  const session = new JukeLoopSession({
    voiceChannel: { guild: { id: 'top-ten-schedule-test' } },
    textChannel: { send: async message => notices.push(message) },
    client: {},
  });
  t.after(() => session.destroy());
  const now = new Date();
  session._started = true;
  session.schedule = [
    { id: 'friday-top10-hype', type: 'weekly_top10', label: 'Friday Top 10 Hype Hour',
      weekday: now.getUTCDay(), startHourUtc: now.getUTCHours(), endHourUtc: now.getUTCHours() + 1 },
    { id: 'normal-rotation', type: 'normal_rotation', label: 'Normal Rotation' },
  ];
  session._activeShowKey = 'normal_rotation:normal-rotation';
  session._syncScheduledShow();
  assert.match(notices[0], /Friday Top 10 Hype Hour/);
  assert.match(notices[0], /React/);
  session.schedule = [{ id: 'normal-rotation', type: 'normal_rotation', label: 'Normal Rotation' }];
  session._syncScheduledShow();
  assert.match(notices[1], /Top 10 hype hour has ended/i);
});
