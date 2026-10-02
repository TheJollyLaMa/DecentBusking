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

  const rated = store.applyRating('attachment-2', 2, 1);
  assert.deepEqual(
    { likes: rated.likes, dislikes: rated.dislikes, plays: rated.plays },
    { likes: 2, dislikes: 1, plays: 1 },
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
  const { buildIpfsGatewayUrl, buildNowPlayingMessage, getVoiceRetryDelay } = await import(moduleUrl.href);

  assert.equal(
    buildIpfsGatewayUrl('https://w3s.link', 'bafy-audio'),
    'https://w3s.link/ipfs/bafy-audio',
  );
  assert.equal(
    buildIpfsGatewayUrl('https://dweb.link/ipfs/', 'bafy-audio'),
    'https://dweb.link/ipfs/bafy-audio',
  );

  const message = buildNowPlayingMessage({
    title: 'Track', uploader: 'artist', ipfsCid: 'bafy-audio', likes: 12, dislikes: 3, plays: 8,
  }, {
    queueIndex: 2,
    totalTracks: 10,
    url: 'https://gateway.example/ipfs/bafy-audio',
  });
  assert.match(message, /All-time:\*\* 👍 12 · 👎 3 · ▶️ 8/);
  assert.match(message, /React 👍 to boost it/);
  assert.equal(getVoiceRetryDelay(1), 15_000);
  assert.equal(getVoiceRetryDelay(2), 30_000);
  assert.equal(getVoiceRetryDelay(10), 5 * 60_000);
});