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
    { likes: 2, dislikes: 1, plays: 1 },
  );
  store.applyRating('attachment-2', 2, 1, 'rating-message-1');
  assert.deepEqual(
    { likes: rated.likes, dislikes: rated.dislikes, plays: rated.plays },
    { likes: 2, dislikes: 1, plays: 1 },
  );
  assert.equal(store.reconcileRatings([
    { trackId: 'attachment-2', likes: 1, dislikes: 0, messageId: 'rating-message-1' },
    { trackId: 'attachment-2', likes: 1, dislikes: 0, messageId: 'rating-message-2' },
  ]), 1);
  assert.deepEqual(
    { likes: rated.likes, dislikes: rated.dislikes, plays: rated.plays },
    { likes: 3, dislikes: 1, plays: 2 },
  );

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
  const { queued, skipped } = store.queueUploaderMints('artist', wallet, Date.parse('2026-10-03T00:00:00Z'));
  assert.deepEqual(queued.map((track) => track.trackId), ['older', 'newer']);
  assert.equal(skipped, 1);
  assert.deepEqual(store.getMintRequests().map((track) => [track.trackId, track.mintRecipient]), [
    ['already-requested', '0xabc'],
    ['older', wallet],
    ['newer', wallet],
  ]);
  assert.equal(store.queueUploaderMints('artist', wallet).queued.length, 0);
});
