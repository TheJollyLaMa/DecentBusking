const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');

test('playlist counters schedule routine writes while pin/mint changes and persistence barriers remain durable', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decent-playlist-checkpoint-'));
  process.env.JUKELOOP_PLAYLIST_PATH = path.join(tempDir, 'playlist.json');
  t.after(() => { delete process.env.JUKELOOP_PLAYLIST_PATH; fs.rmSync(tempDir, { recursive: true, force: true }); });
  const storeUrl = pathToFileURL(path.join(__dirname, '../discord-bot/playlist-store.js'));
  storeUrl.searchParams.set('test', 'routine-checkpoint');
  const store = await import(storeUrl.href);
  store.loadPlaylist([]);
  const saved = [];
  const history = [];
  let pending;
  store.configureRemotePersistence(async (state, { events }) => { saved.push(state); history.push(...events); pending = null; }, {
    schedule: (state, { events }) => { pending = state; history.push(...events); },
    flush: async () => { if (pending) { saved.push(pending); pending = null; } },
  });
  store.addTrack({ messageId: 'message', attachmentId: 'song', filename: 'song.mp3' });
  await store.waitForRemotePersistence();
  assert.equal(saved.length, 1);
  assert.equal(history[0].type, 'submission');
  for (let count = 0; count < 100; count++) store.applySiteVote('song', 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved.length, 1);
  assert.equal(pending[0].likes, 100);
  assert.equal(history.filter(event => event.type === 'vote').length, 100);
  assert.equal(new Set(history.map(event => event.id)).size, 101);
  assert.ok(history.every(event => Number.isFinite(Date.parse(event.observedAt))));
  await store.waitForRemotePersistence();
  assert.equal(saved.length, 2);
  assert.equal(saved[1][0].likes, 100);
  store.updateTrackPin('song', { status: 'pinned', ipfsCid: 'bafyaudio' });
  await store.waitForRemotePersistence();
  assert.equal(saved.length, 3);
  assert.equal(saved[2][0].ipfsCid, 'bafyaudio');
  const now = Date.now();
  const play = { playId: 'audible-play', startedAt: now - 60000, endedAt: now, audibleMs: 60000 };
  assert.equal(store.recordAudiblePlay('song', play).counted, true);
  assert.equal(store.recordAudiblePlay('song', play).reason, 'duplicate');
  store.applyRating('song', 2, 0, 'announcement');
  store.applyRating('song', 2, 0, 'announcement');
  await store.waitForRemotePersistence();
  assert.equal(history.filter(event => event.type === 'play').length, 1);
  assert.equal(history.filter(event => event.source === 'discord' && event.type === 'vote').length, 1);
  const playEvent = history.find(event => event.type === 'play');
  assert.equal(playEvent.occurredAt, new Date(now).toISOString());
  assert.equal(playEvent.audibleMs, 60000);
  store.configureRemotePersistence(async () => { throw new Error('IPFS offline'); });
  store.requestTrackMint('song', undefined, `0x${'1'.repeat(40)}`, 'bafyart');
  await assert.rejects(store.waitForRemotePersistence(), /IPFS offline/);
});

test('main-radio removal discards prepared and persisted queued ads and blocks in-flight removed media', async () => {
  const { JukeLoopSession } = await import('../discord-bot/jukeloop.js');
  const session = Object.create(JukeLoopSession.prototype);
  let stops = 0;
  let disposals = 0;
  let saves = 0;
  const ad = { campaignId: '1' };
  Object.assign(session, { _pendingDevertAds: [ad, { campaignId: '2' }],
    _preparedDevertAd: ad, _preparedNext: { devertAd: ad }, _currentDevertAd: ad,
    _persistMainRadioAdState: async () => { saves++; },
    _disposePrepared: () => { disposals++; }, player: { stop: () => { stops++; } },
    devertPlayback: { isCampaignRemoved: campaignId => campaignId === '1' } });
  await session.removeDevertCampaign('1');
  assert.equal(saves, 1);
  assert.equal(stops, 1);
  assert.equal(disposals, 1);
  assert.equal(session._preparedNext, null);
  assert.equal(session._preparedDevertAd, null);
  assert.deepEqual(session._pendingDevertAds, [{ campaignId: '2' }]);
  assert.equal(session._startPrepared({ devertAd: ad }), false);
  assert.equal(disposals, 2);
});

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

test('archived payroll recovery merges week counters once without replacing current playlist data', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decent-payroll-recovery-'));
  const storePath = path.join(tempDir, 'playlist.json');
  process.env.JUKELOOP_PLAYLIST_PATH = storePath;
  t.after(() => {
    delete process.env.JUKELOOP_PLAYLIST_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const storeUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'playlist-store.js'));
  storeUrl.searchParams.set('payroll-recovery', String(Date.now()));
  const store = await import(storeUrl.href);
  store.loadPlaylist([{ trackId: 'track-1', title: 'Current title', payrollPlays: { 'NY-2026-10-12': 4 },
    payrollVotes: { 'NY-2026-10-12': 1 }, payrollTrackingStartedAt: '2026-10-12T15:40:00.000Z' }]);
  const cid = 'bafybeiamfpzoadbpbjbu4usncdlxpgbg3p5besebug7tofsipmp2g2mply';
  const archived = [{ trackId: 'track-1', title: 'Old title', payrollPlays: { 'NY-2026-10-05': 125, 'NY-2026-10-12': 1 },
    payrollVotes: { 'NY-2026-10-05': 0, 'NY-2026-10-12': 2 }, payrollTrackingStartedAt: '2026-10-11T19:14:41.819Z' },
  { trackId: 'removed-track', payrollPlays: { 'NY-2026-10-05': 2 } }];
  const merged = store.mergePayrollHistorySnapshot(archived, cid, { snapshotSavedAt: '2026-10-12T15:37:06.715Z' });
  assert.deepEqual(merged, { mergedTracks: 1, addedPlays: 126, addedVotes: 2, correctedPlays: 0, correctedVotes: 0 });
  const [track] = store.getPlaylist();
  assert.equal(track.title, 'Current title');
  assert.deepEqual(track.payrollPlays, { 'NY-2026-10-05': 125, 'NY-2026-10-12': 5 });
  assert.deepEqual(track.payrollVotes, { 'NY-2026-10-05': 0, 'NY-2026-10-12': 3 });
  assert.equal(track.payrollTrackingStartedAt, '2026-10-11T19:14:41.819Z');
  assert.equal(store.hasPayrollHistoryRecovery(cid), true);
  assert.deepEqual(store.mergePayrollHistorySnapshot(archived, cid), { mergedTracks: 0, addedPlays: 0, addedVotes: 0, correctedPlays: 0, correctedVotes: 0 });
  assert.equal(JSON.parse(fs.readFileSync(storePath, 'utf8'))[0].payrollPlays['NY-2026-10-12'], 5);
});

test('archived payroll checkpoint seeds an empty playlist and marks its CID as consumed', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decent-payroll-seed-'));
  const storePath = path.join(tempDir, 'playlist.json');
  process.env.JUKELOOP_PLAYLIST_PATH = storePath;
  t.after(() => { delete process.env.JUKELOOP_PLAYLIST_PATH; fs.rmSync(tempDir, { recursive: true, force: true }); });
  const storeUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'playlist-store.js'));
  storeUrl.searchParams.set('payroll-seed', String(Date.now()));
  const store = await import(storeUrl.href);
  store.loadPlaylist();
  const cid = 'bafybeiamfpzoadbpbjbu4usncdlxpgbg3p5besebug7tofsipmp2g2mply';
  const tracks = store.seedPlaylistFromPayrollSnapshot([{ trackId: 'recovered', title: 'Recovered song',
    payrollPlays: { 'NY-2026-10-05': 125 }, payrollTrackingStartedAt: '2026-10-11T19:14:41.819Z' }],
  cid, '2026-10-12T15:37:06.715Z');
  assert.equal(tracks, 1);
  assert.equal(store.getPlaylist()[0].payrollPlays['NY-2026-10-05'], 125);
  assert.equal(store.hasPayrollHistoryRecovery(cid), true);
  assert.ok(store.getPlaylist()[0].payrollLiveTrackingStartedAt);
  assert.equal(JSON.parse(fs.readFileSync(storePath, 'utf8'))[0].payrollPlays['NY-2026-10-05'], 125);
});

test('archived payroll recovery does not double-count history already in the current playlist', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decent-payroll-recovery-existing-'));
  process.env.JUKELOOP_PLAYLIST_PATH = path.join(tempDir, 'playlist.json');
  t.after(() => { delete process.env.JUKELOOP_PLAYLIST_PATH; fs.rmSync(tempDir, { recursive: true, force: true }); });
  const storeUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'playlist-store.js'));
  storeUrl.searchParams.set('payroll-recovery-existing', String(Date.now()));
  const store = await import(storeUrl.href);
  store.loadPlaylist([{ trackId: 'track-1', payrollPlays: { 'NY-2026-10-05': 125 },
    payrollTrackingStartedAt: '2026-10-11T19:14:41.819Z' }]);
  const cid = 'bafybeiamfpzoadbpbjbu4usncdlxpgbg3p5besebug7tofsipmp2g2mply';
  const archived = [{ trackId: 'track-1', payrollPlays: { 'NY-2026-10-05': 125 }, payrollTrackingStartedAt: '2026-10-11T19:14:41.819Z' }];
  const result = store.mergePayrollHistorySnapshot(archived, cid, { snapshotSavedAt: '2026-10-12T15:37:06.715Z' });
  assert.equal(result.addedPlays, 0);
  assert.equal(result.correctedPlays, 0);
  assert.equal(store.getPlaylist()[0].payrollPlays['NY-2026-10-05'], 125);
});

test('versioned recovery corrects a stale closed-week counter from an earlier merge', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decent-payroll-recovery-v2-'));
  process.env.JUKELOOP_PLAYLIST_PATH = path.join(tempDir, 'playlist.json');
  t.after(() => { delete process.env.JUKELOOP_PLAYLIST_PATH; fs.rmSync(tempDir, { recursive: true, force: true }); });
  const storeUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'playlist-store.js'));
  storeUrl.searchParams.set('payroll-recovery-v2', String(Date.now()));
  const store = await import(storeUrl.href);
  const cid = 'bafybeiamfpzoadbpbjbu4usncdlxpgbg3p5besebug7tofsipmp2g2mply';
  store.loadPlaylist([{ trackId: 'track-1', payrollPlays: { 'NY-2026-10-05': 2, 'NY-2026-10-12': 115 },
    payrollTrackingStartedAt: '2026-10-11T19:14:41.819Z',
    payrollRecoverySnapshotAt: '2026-10-12T16:19:48.703Z', payrollRecoveryCids: [cid, `v1:${cid}`] }]);
  const archived = [{ trackId: 'track-1', payrollPlays: { 'NY-2026-10-05': 1, 'NY-2026-10-12': 111 },
    payrollTrackingStartedAt: '2026-10-11T19:14:41.819Z' }];
  const result = store.mergePayrollHistorySnapshot(archived, cid, { snapshotSavedAt: '2026-10-12T15:37:06.715Z' });
  const track = store.getPlaylist()[0];
  assert.equal(track.payrollPlays['NY-2026-10-05'], 1);
  assert.equal(track.payrollPlays['NY-2026-10-12'], 115);
  assert.equal(result.correctedPlays, 1);
  assert.equal(result.addedPlays, 0);
  assert.equal(store.hasPayrollHistoryRecovery(cid), true);
});

test('later disjoint recovery snapshots add current-week plays after the older closed-week baseline', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decent-payroll-recovery-sequence-'));
  process.env.JUKELOOP_PLAYLIST_PATH = path.join(tempDir, 'playlist.json');
  t.after(() => { delete process.env.JUKELOOP_PLAYLIST_PATH; fs.rmSync(tempDir, { recursive: true, force: true }); });
  const storeUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'playlist-store.js'));
  storeUrl.searchParams.set('payroll-recovery-sequence', String(Date.now()));
  const store = await import(storeUrl.href);
  store.loadPlaylist([
    { trackId: 'old-week-track', payrollPlays: {}, payrollTrackingStartedAt: '2026-10-12T16:27:00.000Z' },
    { trackId: 'new-week-track', payrollPlays: {}, payrollTrackingStartedAt: '2026-10-12T16:27:00.000Z' },
  ]);
  const earlierCid = 'bafybeiamfpzoadbpbjbu4usncdlxpgbg3p5besebug7tofsipmp2g2mply';
  const laterCid = 'bafkreigl2kr22jpet5emu4umwuoznzyzth7gsm7vzld74seammdbqoakjm';
  store.mergePayrollHistorySnapshot([{ trackId: 'old-week-track', payrollPlays: { 'NY-2026-10-05': 125 },
    payrollTrackingStartedAt: '2026-10-11T19:14:41.819Z' }], earlierCid, { snapshotSavedAt: '2026-10-12T15:37:06.715Z' });
  store.mergePayrollHistorySnapshot([{ trackId: 'new-week-track', payrollPlays: { 'NY-2026-10-12': 11 },
    payrollTrackingStartedAt: '2026-10-12T15:40:00.000Z' }], laterCid, { snapshotSavedAt: '2026-10-12T16:19:48.703Z' });
  const tracks = store.getPlaylist();
  assert.equal(tracks[0].payrollPlays['NY-2026-10-05'], 125);
  assert.equal(tracks[1].payrollPlays['NY-2026-10-12'], 11);
  assert.equal(tracks[1].payrollTrackingStartedAt, '2026-10-12T15:40:00.000Z');
  assert.equal(tracks[1].payrollLiveTrackingStartedAt, '2026-10-12T16:27:00.000Z');
});

test('recovery uses the archived maximum for a week that closed before live tracking restarted', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decent-payroll-recovery-closed-week-'));
  process.env.JUKELOOP_PLAYLIST_PATH = path.join(tempDir, 'playlist.json');
  t.after(() => { delete process.env.JUKELOOP_PLAYLIST_PATH; fs.rmSync(tempDir, { recursive: true, force: true }); });
  const storeUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'playlist-store.js'));
  storeUrl.searchParams.set('payroll-recovery-closed-week', String(Date.now()));
  const store = await import(storeUrl.href);
  store.loadPlaylist([{ trackId: 'track-1', payrollPlays: { 'NY-2026-10-05': 1 },
    payrollTrackingStartedAt: '2026-10-12T16:27:00.000Z' }]);
  const cid = 'bafybeiamfpzoadbpbjbu4usncdlxpgbg3p5besebug7tofsipmp2g2mply';
  store.mergePayrollHistorySnapshot([{ trackId: 'track-1', payrollPlays: { 'NY-2026-10-05': 1 },
    payrollTrackingStartedAt: '2026-10-11T19:14:41.819Z' }], cid, { snapshotSavedAt: '2026-10-12T15:37:06.715Z' });
  const result = store.mergePayrollHistorySnapshot([{ trackId: 'track-1', payrollPlays: { 'NY-2026-10-05': 129 },
    payrollTrackingStartedAt: '2026-10-11T19:14:41.819Z' }], 'bafkreigl2kr22jpet5emu4umwuoznzyzth7gsm7vzld74seammdbqoakjm',
  { snapshotSavedAt: '2026-10-12T16:19:48.703Z' });
  assert.equal(result.addedPlays, 128);
  assert.equal(store.getPlaylist()[0].payrollPlays['NY-2026-10-05'], 129);
});

test('DeVert ad library is scoped to wallet and reports mint/campaign state', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decent-devert-library-'));
  process.env.JUKELOOP_PLAYLIST_PATH = path.join(tempDir, 'playlist.json');
  t.after(() => { delete process.env.JUKELOOP_PLAYLIST_PATH; fs.rmSync(tempDir, { recursive: true, force: true }); });
  const moduleUrl = pathToFileURL(path.join(__dirname, '../discord-bot/playlist-store.js'));
  moduleUrl.searchParams.set('ad-library', String(Date.now()));
  const store = await import(moduleUrl.href);
  const owner = '0x1111111111111111111111111111111111111111';
  const other = '0x2222222222222222222222222222222222222222';
  store.loadPlaylist([
    { trackId: 'pending', title: 'Pending Ad', ipfsCid: 'cid-pending', artworkCid: 'ipfs://art-pending',
      isDevertAd: true, mintRecipient: owner, mintStatus: 'requested' },
    { trackId: 'ready', title: 'Ready Ad', ipfsCid: 'cid-ready', artworkCid: 'ipfs://art-ready',
      isDevertAd: true, mintRecipient: owner, mintStatus: 'minted', tokenId: '41' },
    { trackId: 'active', title: 'Active Ad', ipfsCid: 'cid-active', artworkCid: 'ipfs://art-active',
      isDevertAd: true, mintRecipient: owner, mintStatus: 'minted', tokenId: '42' },
    { trackId: 'other', title: 'Other Wallet Ad', ipfsCid: 'cid-other', isDevertAd: true, mintRecipient: other, mintStatus: 'requested' },
    { trackId: 'song', title: 'Song', ipfsCid: 'cid-song', mintRecipient: owner, mintStatus: 'requested' },
  ]);
  const now = Date.parse('2026-10-11T12:00:00Z');
  const ads = store.getDevertAdsForWallet(owner, [{ campaignId: '9', advertiser: owner,
    audioURI: 'ipfs://cid-active', startedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString() }], now);
  assert.deepEqual(ads.map(ad => [ad.trackId, ad.state]), [['active', 'active'], ['pending', 'pending'], ['ready', 'ready']]);
  assert.equal(ads[0].campaignId, '9');
  assert.equal(ads[0].secondsRemaining, 3600);
  assert.equal(ads.find(ad => ad.trackId === 'pending').image, 'ipfs://art-pending');
  assert.equal(ads.find(ad => ad.trackId === 'ready').artworkCid, 'ipfs://art-ready');
  assert.equal(ads[2].tokenId, '41');
});

test('DeVert library prefers owned minted NFTs over stale pending rows for duplicate media and keeps the highest token', async () => {
  const storeUrl = pathToFileURL(path.join(__dirname, '../discord-bot/playlist-store.js'));
  storeUrl.searchParams.set('ad-library-merge', String(Date.now()));
  const { mergeDevertAdsForWallet } = await import(storeUrl.href);
  const cid = 'bafy-ad-media';
  const merged = mergeDevertAdsForWallet([
    { trackId: 'site:owner:media', title: 'DecentAdvert0001', ipfsCid: cid, artworkCid: 'ipfs://pending-art',
      mintStatus: 'requested', state: 'pending' },
  ], [
    { trackId: 'nft:collection:40', title: 'DecentAdvert0001', ipfsCid: cid, artworkCid: 'ipfs://art-40',
      mintStatus: 'minted', tokenId: '40', state: 'ready' },
    { trackId: 'nft:collection:41', title: 'DecentAdvert0001', ipfsCid: cid, artworkCid: 'ipfs://art-41',
      mintStatus: 'minted', tokenId: '41', state: 'ready' },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].tokenId, '41');
  assert.equal(merged[0].state, 'ready');
  assert.equal(merged[0].artworkCid, 'ipfs://art-41');
});

test('JukeLoop sends DeVert main-radio votes to the campaign vote journal', async () => {
  const { createJukeLoopSession, submitJukeLoopVote } = await import('../discord-bot/jukeloop.js');
  const adVotes = [];
  const session = createJukeLoopSession('devert-vote-test', {
    voiceChannel: { guild: { id: 'devert-vote-test' } }, textChannel: {}, client: {}, ipfsGateway: 'https://dweb.link',
    devertPlayback: { recordMainRadioAdVote: async vote => { adVotes.push(vote); return { duplicate: false }; } },
  });
  session._nowPlaying = { playId: 'devert:7:play', trackId: 'devert:7', audible: true, isDevert: true };
  session._currentDevertAd = { campaignId: '7', mainRadio: true };
  try {
    assert.deepEqual(await submitJukeLoopVote({ playId: 'devert:7:play', voterId: 'anonymous-browser-123', vote: 1 }),
      { playId: 'devert:7:play', vote: 1, duplicate: false });
    assert.deepEqual(adVotes, [{ campaignId: '7', radioPlayId: 'devert:7:play', voterId: 'anonymous-browser-123', vote: 1 }]);
  } finally { session.destroy(); }
});

test('JukeLoop reports the durable prior ad vote after a session restart', async () => {
  const { createJukeLoopSession, submitJukeLoopVote } = await import('../discord-bot/jukeloop.js');
  let persistedVote;
  const devertPlayback = { recordMainRadioAdVote: async ({ vote }) => {
    if (persistedVote !== undefined) return { vote: persistedVote, duplicate: true };
    persistedVote = vote;
    return { vote, duplicate: false };
  } };
  const options = { voiceChannel: { guild: { id: 'devert-vote-restart' } }, textChannel: {}, client: {}, devertPlayback };
  const first = createJukeLoopSession('devert-vote-restart', options);
  first._nowPlaying = { playId: 'devert:8:play', trackId: 'devert:8', audible: true, isDevert: true };
  first._currentDevertAd = { campaignId: '8', mainRadio: true };
  assert.deepEqual(await submitJukeLoopVote({ playId: 'devert:8:play', voterId: 'anonymous-browser-7654321', vote: 1 }),
    { playId: 'devert:8:play', vote: 1, duplicate: false });
  first.destroy();

  const restarted = createJukeLoopSession('devert-vote-restart', options);
  restarted._nowPlaying = { playId: 'devert:8:play', trackId: 'devert:8', audible: true, isDevert: true };
  restarted._currentDevertAd = { campaignId: '8', mainRadio: true };
  try {
    assert.deepEqual(await submitJukeLoopVote({ playId: 'devert:8:play', voterId: 'anonymous-browser-7654321', vote: -1 }),
      { playId: 'devert:8:play', vote: 1, duplicate: true });
  } finally { restarted.destroy(); }
});

test('JukeLoop player errors discard the active DeVert ad before an Idle event can record an impression', async () => {
  const { createJukeLoopSession } = await import('../discord-bot/jukeloop.js');
  const impressions = [];
  const session = createJukeLoopSession('devert-error-test', {
    voiceChannel: { guild: { id: 'devert-error-test' } }, textChannel: {}, client: {}, ipfsGateway: 'https://dweb.link',
    devertPlayback: { recordCampaignImpression: async impression => impressions.push(impression) },
  });
  session._destroyed = true;
  session._currentDevertAd = { campaignId: '42', mainRadio: true };
  session._currentTrack = { trackId: 'devert:42' };
  session._nowPlaying = { playId: 'devert:42:failed', trackId: 'devert:42', audible: true, startedAt: Date.now() - 60_000 };

  session.player.emit('error', new Error('stream failed'));
  session.player.emit('idle');

  assert.deepEqual(impressions, []);
  assert.equal(session._currentDevertAd, null);
  assert.equal(session._nowPlaying, null);
  assert.ok(session._failedDevertCampaigns.has('42'));
  session.destroy();
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
  assert.match(message, /Track `attachment-1`/);
  assert.doesNotMatch(message, /\|\|/);
  assert.deepEqual(parseNowPlayingMessage(
    '🎵 Now playing: **Track** by *artist* (1/10)\nTrack `attachment-1`',
  ), { title: 'Track', uploader: 'artist', trackId: 'attachment-1' });
  assert.deepEqual(parseNowPlayingMessage(
    '🎵 Now playing: **Track** by *artist* (1/10)\nTrack ID: ||attachment-1||\nPlay ID: ||play-1||',
  ), { title: 'Track', uploader: 'artist', trackId: 'attachment-1', playId: 'play-1' });
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
      sponsor: { kind: 'djuke', wallet: '0x1111111111111111111111111111111111111111', amountUnits: '1000000', requestId: '8453:0xabc:1' },
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
    isDevert: false,
    sponsor: { kind: 'djuke', wallet: '0x1111111111111111111111111111111111111111', amountUnits: '1000000', requestId: '8453:0xabc:1' },
    startedAt: 40_000,
    positionMs: 60_000,
  });
  assert.deepEqual(state.recent.map((track) => [track.trackId, track.ipfsCid]), [['new', null], ['old', 'bafy-old']]);
  assert.equal('uploaderId' in state.recent[1], false);
  assert.equal(buildRadioState({ nowPlaying: null, playlist: [] }).nowPlaying, null);
});

test('radio state keeps video MIME for main-radio ads even when the filename looks audio-only', async () => {
  const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'jukeloop.js'));
  const { buildRadioState } = await import(moduleUrl.href);

  const state = buildRadioState({
    nowPlaying: {
      trackId: 'devert:video',
      title: 'Sponsored Video',
      uploader: 'Advertiser',
      filename: 'sponsored-ad.mp3',
      mediaType: 'video/mp4',
      videoUrl: 'ipfs://bafy-video',
      ipfsCid: 'bafy-video',
      startedAt: 40_000,
      audible: true,
      isDevert: true,
    },
    playlist: [],
    adVotes: { up: 4, down: 2, net: 2 },
    now: 100_000,
  });

  assert.equal(state.nowPlaying.mediaType, 'video/mp4');
  assert.equal(state.nowPlaying.videoUrl, 'ipfs://bafy-video');
  assert.deepEqual(state.nowPlaying.adVotes, { up: 4, down: 2, net: 2 });
});

test('radio state omits sponsor metadata for regular rotation', async () => {
  const moduleUrl = pathToFileURL(path.join(__dirname, '../discord-bot/jukeloop.js'));
  const { buildRadioState } = await import(moduleUrl.href);
  const state = buildRadioState({
    now: 100_000,
    nowPlaying: {
      trackId: 'track-2',
      title: 'Song',
      uploader: 'artist',
      filename: 'song.mp3',
      startedAt: 40_000,
      audible: true,
    },
    playlist: [],
  });
  assert.equal('sponsor' in state.nowPlaying, false);
});

test('main-radio ad countdown reports shared scheduler state without browser-side guesses', async () => {
  const { defaultRadioSchedule } = await import(pathToFileURL(path.join(__dirname, '..', 'js', 'radio-schedule.mjs')).href);
  const source = fs.readFileSync(path.join(__dirname, '..', 'discord-bot', 'jukeloop.js'), 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace(/export /g, '');
  const radioSchedule = await import(pathToFileURL(path.join(__dirname, '..', 'js', 'radio-schedule.mjs')).href);
  const context = vm.createContext({
    process,
    console,
    resolveActiveShow: radioSchedule.resolveActiveShow,
    DEVERT_SONGS_PER_MAIN_AD: 10,
  });
  vm.runInContext(source, context);

  const countdown = await context.buildMainRadioAdCountdown({
    now: 100_000,
    session: {
      schedule: defaultRadioSchedule(),
      livePerformanceEvents: [],
      _musicSinceAd: 7,
      _currentDevertAd: null,
      _getActiveFailedDevertCampaignIds: () => [],
      devertPlayback: {
        nextMainRadioAd: async () => { throw new Error('should not be queried before the threshold'); },
      },
    },
  });

  assert.equal(countdown.updatedAt, 100_000);
  assert.equal(countdown.activeShow.type, 'normal_rotation');
  assert.equal(typeof countdown.activeShow.label, 'string');
  assert.equal(countdown.includesCurrentSong, false);
  assert.equal(countdown.status, 'countdown');
  assert.equal(countdown.remainingSongs, 3);
  assert.equal(countdown.mainRadio, true);

  const playing = await context.buildMainRadioAdCountdown({
    now: 100_000,
    session: {
      schedule: defaultRadioSchedule(),
      livePerformanceEvents: [],
      _musicSinceAd: 10,
      _currentDevertAd: {
        campaignId: '42',
        track: { title: 'Spotlight' },
      },
      _nowPlaying: { audible: true },
      _getActiveFailedDevertCampaignIds: () => [],
      devertPlayback: {
        nextMainRadioAd: async () => null,
      },
    },
  });

  assert.equal(playing.status, 'playing');

  const failingSession = error => ({
    schedule: defaultRadioSchedule(),
    livePerformanceEvents: [],
    _musicSinceAd: 10,
    _currentDevertAd: null,
    _getActiveFailedDevertCampaignIds: () => [],
    _setMainRadioAdSkip(reason, campaignId) {
      this._lastMainRadioAdSkip = { reason, campaignId, at: 100_000 };
    },
    devertPlayback: { nextMainRadioAd: async () => { throw error; } },
  });
  const rawRpcError = Object.assign(new Error('insufficient funds for intrinsic transaction cost (transaction="0x02f8d1")'),
    { code: 'INSUFFICIENT_FUNDS' });
  const gasLow = await context.buildMainRadioAdCountdown({ now: 100_000, session: failingSession(rawRpcError) });
  assert.equal(gasLow.status, 'unavailable');
  assert.equal(gasLow.reason, 'worker gas low');
  assert.equal(gasLow.lastSkip.reason, 'worker gas low');
  context.console = { ...console, warn: () => {} };
  const otherFailure = await context.buildMainRadioAdCountdown({ now: 100_000,
    session: failingSession(new Error('could not coalesce error (data="0xdeadbeef")')) });
  context.console = console;
  assert.equal(otherFailure.reason, 'main-radio scheduler unavailable');
  assert.equal(otherFailure.lastSkip.reason, 'main-radio scheduler unavailable');
  assert.equal(playing.campaignId, '42');
  assert.equal(playing.title, 'Spotlight');

  const paused = await context.buildMainRadioAdCountdown({
    now: Date.parse('2026-10-10T00:30:00Z'),
    session: {
      schedule: defaultRadioSchedule(),
      livePerformanceEvents: [{
        id: 'live-1',
        title: 'Live set',
        startUtc: '2026-10-10T00:00:00Z',
        endUtc: '2026-10-10T01:00:00Z',
      }],
      _musicSinceAd: 10,
      _currentDevertAd: null,
      _getActiveFailedDevertCampaignIds: () => [],
      devertPlayback: {
        nextMainRadioAd: async () => null,
      },
    },
  });

  assert.equal(paused.status, 'paused');
  assert.match(paused.reason, /Live set|live_performance/);
});

test('JukeLoop restores a queued main-radio ad after restart and surfaces the last skip reason', async () => {
  const { createJukeLoopSession } = await import('../discord-bot/jukeloop.js');
  const saved = [];
  const snapshot = {
    schemaVersion: 1,
    musicSinceAd: 10,
    musicPlayCount: 4,
    preparedDevertAd: {
      campaignId: '7',
      mainRadio: true,
      track: { trackId: 'devert:7', title: 'Restored Ad', uploader: 'Advertiser', messageId: 'ad-message', channelId: 'ad-channel' },
    },
    pendingDevertAds: [{
      campaignId: '8',
      mainRadio: true,
      track: { trackId: 'devert:8', title: 'Next Ad', uploader: 'Advertiser', messageId: 'next-message', channelId: 'ad-channel' },
    }],
    failedDevertCampaigns: [],
    lastSkip: { reason: 'ad file could not be fetched', campaignId: '7', at: 1000 },
  };
  const store = {
    async restore() { return structuredClone(snapshot); },
    async save(value) {
      saved.push(structuredClone(value));
      snapshot.schemaVersion = value.schemaVersion;
      snapshot.musicSinceAd = value.musicSinceAd;
      snapshot.musicPlayCount = value.musicPlayCount;
      snapshot.preparedDevertAd = value.preparedDevertAd;
      snapshot.pendingDevertAds = value.pendingDevertAds;
      snapshot.failedDevertCampaigns = value.failedDevertCampaigns;
      snapshot.lastSkip = value.lastSkip;
      return 'ipfs://jukeloop-state';
    },
  };

  const session = createJukeLoopSession('main-radio-restart', {
    voiceChannel: { guild: { id: 'main-radio-restart' } },
    textChannel: { send: async () => ({}) },
    client: {},
    mainRadioAdStateStore: store,
  });
  session._getFreshUrl = async () => 'https://example.test/ad.mp3';
  session._createStream = () => {
    const stream = new PassThrough();
    stream.write(Buffer.from([0]));
    return { stream, ffmpegProcess: { kill() {} } };
  };

  try {
    const countdown = await session.getMainRadioAdCountdown();
    assert.equal(countdown.status, 'up_next');
    assert.equal(countdown.campaignId, '7');
    assert.equal(countdown.lastSkip.reason, 'ad file could not be fetched');

    const prepared = await session._prepareNextPlayback();
    assert.equal(prepared.devertAd.campaignId, '7');
    assert.equal(prepared.track.trackId, 'devert:7');
    assert.equal(saved.length, 0, 'preparing a restored ad does not change the journal');

    session.player.play = () => {};
    assert.equal(session._startPrepared(prepared), true);
    await session._mainRadioAdStateSaveTask;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].preparedDevertAd, null, 'a started ad is cleared so a restart does not replay it');
    assert.deepEqual(saved[0].pendingDevertAds.map(ad => ad.campaignId), ['8']);
    assert.equal(saved[0].lastSkip.reason, 'ad file could not be fetched');
  } finally {
    session.destroy();
  }
});

test('stale failed main-radio campaigns are retried after enough songs pass', async () => {
  const { createJukeLoopSession } = await import('../discord-bot/jukeloop.js');
  const excluded = [];
  const session = createJukeLoopSession('main-radio-expiry', {
    voiceChannel: { guild: { id: 'main-radio-expiry' } },
    textChannel: { send: async () => ({}) },
    client: {},
    devertPlayback: {
      nextMainRadioAd: async ({ excludeCampaignIds }) => {
        excluded.push(...excludeCampaignIds);
        return null;
      },
    },
  });
  session._musicSinceAd = 10;
  session._musicPlayCount = 20;
  session._failedDevertCampaigns = new Map([
    ['42', { failedAt: Date.now() - 11 * 60_000, musicPlayCount: 9 }],
  ]);

  try {
    await session.getMainRadioAdCountdown();
    assert.equal(excluded.includes('42'), false);
  } finally {
    session.destroy();
  }
});

test('JukeLoop rechecks overdue adverts before starting prefetched music without dropping paid requests', async t => {
  const { JukeLoopSession } = await import('../discord-bot/jukeloop.js');
  for (const scenario of ['due', 'not-due', 'paid', 'advert', 'no-replacement', 'lookup-error']) {
    await t.test(scenario, async () => {
      const session = new JukeLoopSession({
        voiceChannel: { guild: { id: `ad-transition-${scenario}` } },
        textChannel: {}, client: {}, devertPlayback: {},
      });
      const original = { track: { title: 'Prefetched music' },
        paid: scenario === 'paid' ? { record: { requestId: 'paid-1' } } : null,
        devertAd: scenario === 'advert' ? { campaignId: '1' } : null };
      const replacement = { track: { title: 'Video advert', mediaType: 'video/mp4' }, devertAd: { campaignId: '1' } };
      const disposed = [];
      let started;
      let selections = 0;
      session._musicSinceAd = scenario === 'not-due' ? 9 : 10;
      session._preparedNext = original;
      session._prepareNextPlayback = async () => {
        selections++;
        if (scenario === 'lookup-error') throw new Error('scheduler unavailable');
        return scenario === 'no-replacement' ? null : replacement;
      };
      session._disposePrepared = value => disposed.push(value);
      session._startPrepared = value => { started = value; };
      try {
        await session._playNext();
        assert.equal(started, scenario === 'due' ? replacement : original);
        assert.deepEqual(disposed, scenario === 'due' ? [original] : []);
        assert.equal(selections, ['due', 'no-replacement', 'lookup-error'].includes(scenario) ? 1 : 0);
      } finally {
        session.destroy();
      }
    });
  }
});

test('paid DJuke requests still let the queued main-radio ad play next', async () => {
  const { createJukeLoopSession } = await import('../discord-bot/jukeloop.js');
  const nextPaid = [{ track: { trackId: 'paid:1', title: 'Paid Song', uploader: 'Buyer', messageId: 'paid-message', channelId: 'paid-channel' },
    record: { requestId: 'request-1' } }, null];
  let adCalls = 0;
  const session = createJukeLoopSession('main-radio-paid', {
    voiceChannel: { guild: { id: 'main-radio-paid' } },
    textChannel: { send: async () => ({}) },
    client: {},
    djuke: {
      nextPaid: async () => nextPaid.shift(),
      fail: async () => {},
    },
    devertPlayback: {
      nextMainRadioAd: async () => {
        adCalls++;
        return {
          campaignId: '9',
          mainRadio: true,
          track: { trackId: 'devert:9', title: 'Paid-After Ad', uploader: 'Advertiser', messageId: 'ad-message', channelId: 'ad-channel' },
        };
      },
    },
  });

  test('paid adverts create an extra break without consuming ordinary ads and settle only their own queue', async t => {
    const { createJukeLoopSession } = await import('../discord-bot/jukeloop.js');
    t.mock.method(Date, 'now', () => Date.parse('2026-10-17T12:00:00Z'));
    const completed = [];
    const selection = { record: { requestId: 'paid-ad-1', kind: 'devert', payer: `0x${'1'.repeat(40)}`, amountUnits: '1000000' },
      track: { trackId: 'devert-paid:1', campaignId: '9', title: 'Paid advert', advertiser: `0x${'2'.repeat(40)}`, isDevertAd: true } };
    const session = createJukeLoopSession('paid-ad-extra', {
      voiceChannel: { guild: { id: 'paid-ad-extra' } }, textChannel: { send: async () => ({}) }, client: {},
      audioPlayer: { on() {}, play() {}, stop() {}, state: { status: 'idle' } },
      djuke: { nextPaid: async () => selection, fail: async () => {},
        complete: async (...args) => completed.push(args) },
      devertPlayback: { isCampaignRemoved: () => false, nextMainRadioAd: async () => { throw new Error('Ordinary ad rotation should not be consumed'); } },
    });
    t.after(() => session.destroy());
    session._musicSinceAd = 0;
    const ordinary = { campaignId: 'ordinary' };
    session._preparedDevertAd = ordinary;
    session._getFreshUrl = async () => 'https://example.test/ad.mp3';
    session._createStream = () => { const stream = new PassThrough(); stream.write(Buffer.from([0]));
      return { stream, ffmpegProcess: { exitCode: 0, kill() {} } }; };
    session._announcePrepared = async () => {};
    const prepared = await session._prepareNextPlayback();
    assert.equal(prepared.paid.record.kind, 'devert');
    assert.equal(prepared.devertAd.paidRequest, true);
    assert.equal(prepared.queueIndex, null);
    session._startPrepared(prepared);
    assert.equal(session._nowPlaying.isDevert, true);
    assert.equal(session._nowPlaying.sponsor.kind, 'devert');
    assert.equal(session._preparedDevertAd, ordinary);
    session._completedPlay = { trackId: selection.track.trackId, playId: 'paid-ad-play', audibleMs: 20000, finished: true };
    await session._collectReactions();
    assert.equal(completed.length, 1);
    assert.equal(completed[0][0].kind, 'devert');
    assert.equal(completed[0][1].finished, true);
    session.livePerformanceEvents = [{ id: 'live', title: 'Live', startUtc: '2026-10-17T11:59:00Z', endUtc: '2026-10-17T13:00:00Z' }];
    assert.equal(await session._prepareNextPlayback(), undefined);
  });
  session._musicSinceAd = 10;
  session._getFreshUrl = async () => 'https://example.test/audio.mp3';
  session._createStream = () => {
    const stream = new PassThrough();
    stream.write(Buffer.from([0]));
    return { stream, ffmpegProcess: { kill() {} } };
  };

  try {
    const paid = await session._prepareNextPlayback();
    assert.equal(paid.paid.record.requestId, 'request-1');
    const ad = await session._prepareNextPlayback();
    assert.equal(ad.devertAd.campaignId, '9');
    assert.equal(adCalls, 1);
  } finally {
    session.destroy();
  }
});

test('main-radio ads keep video MIME when the source is a video URL with an audio-looking filename', async () => {
  const { createJukeLoopSession } = await import('../discord-bot/jukeloop.js');
  const session = createJukeLoopSession('main-radio-video-mime', {
    voiceChannel: { guild: { id: 'main-radio-video-mime' } },
    textChannel: { send: async () => ({}) },
    client: {},
    audioPlayer: { on() {}, play() {}, stop() {}, state: { status: 'idle' } },
  });
  session._createStream = () => {
    const stream = new PassThrough();
    stream.write(Buffer.from([0]));
    return { stream, ffmpegProcess: { kill() {} } };
  };
  try {
    session._startPrepared({
      track: {
        trackId: 'devert:video',
        title: 'Video Ad',
        uploader: 'Advertiser',
        filename: 'video-ad.mp3',
        mediaType: 'audio/mpeg',
        videoUrl: 'ipfs://bafy-video',
        ipfsCid: 'bafy-video',
      },
      devertAd: { campaignId: '44', mainRadio: true, track: { trackId: 'devert:video' } },
      resource: {},
      ffmpegProcess: { kill() {} },
      queueIndex: null,
      paid: null,
      url: 'https://example.test/video.mp4',
    });
    assert.equal(session._nowPlaying.mediaType, 'video/mp4');
    assert.equal(session._nowPlaying.videoUrl, 'ipfs://bafy-video');
  } finally {
    session.destroy();
  }
});

test('radio state preserves video metadata for video now-playing tracks', async () => {
  const moduleUrl = pathToFileURL(path.join(__dirname, '../discord-bot/jukeloop.js'));
  const { buildRadioState } = await import(moduleUrl.href);

  const state = buildRadioState({
    now: 100_000,
    nowPlaying: {
      trackId: 'track-video',
      title: 'Video',
      uploader: 'artist',
      filename: '',
      mediaType: '',
      videoUrl: 'ipfs://bafy-video',
      ipfsCid: 'bafy-video',
      startedAt: 40_000,
      audible: true,
    },
    playlist: [],
  });

  assert.deepEqual(state.nowPlaying, {
    playId: 'track-video:40000',
    trackId: 'track-video',
    title: 'Video',
    uploader: 'artist',
    filename: null,
    mediaType: 'video/mp4',
    videoUrl: 'ipfs://bafy-video',
    ipfsCid: 'bafy-video',
    isDevert: false,
    startedAt: 40_000,
    positionMs: 60_000,
  });
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
  assert.match(content, /Track `track` · Play `play-1`/);
  assert.doesNotMatch(content, /\|\|/);
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

test('JukeLoop streams from the dedicated Pinata gateway when public gateways rate-limit', async () => {
  const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'jukeloop.js'));
  const { resolveStreamableIpfsUrl, buildIpfsGatewayUrl } = await import(moduleUrl.href);
  const dedicated = 'https://peach.mypinata.cloud/ipfs/?pinataGatewayToken=secret';
  assert.equal(buildIpfsGatewayUrl(dedicated, 'bafy-song'), 'https://peach.mypinata.cloud/ipfs/bafy-song?pinataGatewayToken=secret');
  const requested = [];
  const fetchImpl = async url => {
    requested.push(url);
    return new Response('x', { status: url.includes('mypinata.cloud') ? 206 : 429 });
  };
  assert.equal(await resolveStreamableIpfsUrl('https://dweb.link', 'bafy-song', fetchImpl, [dedicated]),
    'https://peach.mypinata.cloud/ipfs/bafy-song?pinataGatewayToken=secret');
  assert.equal(requested.length, 3);
});

test('an unfetchable paid request stays queued while free rotation keeps the radio playing', async (t) => {
  const { JukeLoopSession } = await import('../discord-bot/jukeloop.js');
  const sent = [];
  const failed = [];
  let paidChecks = 0;
  const paidTrack = { trackId: 'album:paid', title: 'Paid Song', ipfsCid: 'bafy-paid' };
  const session = new JukeLoopSession({
    voiceChannel: { guild: { id: 'djuke-unfetchable-test' } },
    textChannel: { send: async message => { sent.push(message.content); return {}; } },
    client: {},
    djuke: {
      nextPaid: async () => { paidChecks++; return { record: { requestId: 'req-1' }, track: paidTrack }; },
      fail: async (record, error) => { failed.push([record.requestId, error.message]); },
    },
  });
  t.after(() => session.destroy());
  session._queue = [{ trackId: 'regular-track', title: 'Regular Track' }];
  session._queueIndex = 0;
  session._getFreshUrl = async track => {
    if (track.trackId === 'regular-track') throw new Error('stop after selection');
    return null;
  };

  await assert.rejects(session._prepareNextPlayback(), /stop after selection/);
  assert.deepEqual(failed, [['req-1', 'Paid recording could not be fetched']]);
  assert.equal(paidChecks, 1);
  assert.ok(session._djukeCooldownUntil > Date.now());
  assert.equal(sent.length, 1);
  assert.match(sent[0], /stays queued/);

  await assert.rejects(session._prepareNextPlayback(), /stop after selection/);
  assert.equal(paidChecks, 1, 'paid picks pause during the cooldown');
  session._djukeCooldownUntil = 0;
  await assert.rejects(session._prepareNextPlayback(), /stop after selection/);
  assert.equal(paidChecks, 2);
  assert.equal(sent.length, 1, 'the channel is notified once per request');
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
  assert.equal((await submitJukeLoopVote(ballot, saveVote)).duplicate, false);
  assert.deepEqual(await submitJukeLoopVote({ ...ballot, vote: -1 }, saveVote), { playId: 'track:1000', vote: 1, duplicate: true });
  assert.equal(calls.length, 1);
  await assert.rejects(submitJukeLoopVote({ ...ballot, playId: 'old-play' }, saveVote), /ended/);
  await assert.rejects(submitJukeLoopVote({ ...ballot, vote: 0 }, saveVote), /Invalid/);
  session._nowPlaying = { playId: 'track:2000', trackId: 'track', audible: true };
  assert.equal((await submitJukeLoopVote({ ...ballot, playId: 'track:2000', vote: -1 }, saveVote)).duplicate, false);
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
  assert.match(notices[0].content, /Live performance block: Live Test Set/);
  assert.equal(notices[0].flags, 4096);
});

test('JukeLoop prepares the next paid request and starts it before prior-play bookkeeping finishes', async (t) => {
  const { JukeLoopSession } = await import('../discord-bot/jukeloop.js');
  const player = new EventEmitter();
  const played = [];
  player.play = resource => played.push(resource);
  player.stop = () => {};
  let finishCompletion;
  const completionPending = new Promise(resolve => { finishCompletion = resolve; });
  const firstPaid = { id: 'paid-1' };
  const secondPaid = { id: 'paid-2' };
  const paidTrack = {
    trackId: 'paid-track-2',
    title: 'Paid Track Two',
    uploader: 'Paid Artist',
    messageId: 'paid-message-2',
  };
  let paidPicks = 0;
  const session = new JukeLoopSession({
    voiceChannel: { guild: { id: 'djuke-gap-test' } },
    textChannel: { send: async () => ({}) },
    client: {},
    audioPlayer: player,
    createStream: () => {
      const stream = new PassThrough();
      const process = new EventEmitter();
      process.kill = () => {};
      stream.write(Buffer.from('first audio frame'));
      return { stream, ffmpegProcess: process };
    },
    djuke: {
      nextPaid: async () => {
        paidPicks++;
        return { record: secondPaid, track: paidTrack };
      },
      complete: async record => {
        assert.equal(record, firstPaid);
        await completionPending;
      },
      fail: async () => {},
    },
  });
  t.after(() => {
    finishCompletion();
    session.destroy();
  });
  session._getFreshUrl = async () => 'https://audio.example/paid-two.mp3';
  session._queue = [{ trackId: 'regular-track', title: 'Regular Track' }];
  session._queueIndex = 0;
  session._currentPaid = firstPaid;
  session._currentTrack = { trackId: 'paid-track-1', title: 'Paid Track One' };
  session._nowPlaying = {
    playId: 'paid-track-1:1000',
    trackId: 'paid-track-1',
    title: 'Paid Track One',
    startedAt: Date.now() - 35_000,
    audible: true,
  };

  session._primeNext();
  await session._prepareTask;
  assert.equal(session._preparedNext.paid.record, secondPaid);
  assert.equal(session._queueIndex, 0);

  const gaps = [];
  session._sleep = async ms => { gaps.push(ms); };
  player.emit('idle');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(gaps.length, 1);
  assert.ok(gaps[0] > 2_000 && gaps[0] <= 2_500, `changeover gap was ${gaps[0]}ms`);
  assert.equal(played.length, 1);
  assert.equal(session._currentPaid, secondPaid);
  assert.equal(session._currentTrack, paidTrack);
  assert.equal(paidPicks, 1);
  assert.equal(session._queueIndex, 0);
  finishCompletion();
});

test('JukeLoop audio readiness preserves the first prebuffered bytes', async () => {
  const { waitForAudioReady } = await import('../discord-bot/jukeloop.js');
  const stream = new PassThrough();
  const process = new EventEmitter();
  stream.write(Buffer.from('intro'));

  await waitForAudioReady(stream, process);

  assert.equal(stream.read(5).toString(), 'intro');
});

test('JukeLoop does not fall back to regular rotation when the paid queue is unavailable', async (t) => {
  const { JukeLoopSession } = await import('../discord-bot/jukeloop.js');
  const session = new JukeLoopSession({
    voiceChannel: { guild: { id: 'djuke-priority-test' } },
    textChannel: { send: async () => ({}) },
    client: {},
    djuke: { nextPaid: async () => { throw new Error('DJuke queue timed out'); } },
  });
  t.after(() => session.destroy());
  session._queue = [{ trackId: 'regular-track', title: 'Regular Track' }];
  session._queueIndex = 0;

  await assert.rejects(session._prepareNextPlayback(), /timed out/);
  assert.equal(session._queueIndex, 0);
});

test('JukeLoop counts qualified music toward the next ad and resets after an audible ad', async (t) => {
  const { JukeLoopSession } = await import('../discord-bot/jukeloop.js');
  const session = new JukeLoopSession({ voiceChannel: { guild: { id: 'ad-cadence-test' } },
    textChannel: {}, client: {} });
  t.after(() => session.destroy());
  session._destroyed = true;
  session._nowPlaying = { audible: true, playId: 'short', startedAt: Date.now() - 1000 };
  session.player.emit('idle');
  assert.equal(session._musicSinceAd, 0);
  for (let index = 0; index < 10; index++) {
    session._nowPlaying = { audible: true, playId: `music-${index}`, startedAt: Date.now() - 35_000 };
    session.player.emit('idle');
  }
  assert.equal(session._musicSinceAd, 10);
  session._currentDevertAd = { campaignId: '17' };
  session._nowPlaying = { audible: true, playId: 'ad-17', startedAt: Date.now() - 35_000 };
  session.player.emit('idle');
  assert.equal(session._musicSinceAd, 0);
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
  assert.match(notices[0].content, /Friday Top 10 Hype Hour/);
  assert.match(notices[0].content, /React/);
  assert.equal(notices[0].flags, 4096);
  session.schedule = [{ id: 'normal-rotation', type: 'normal_rotation', label: 'Normal Rotation' }];
  session._syncScheduledShow();
  assert.match(notices[1].content, /Top 10 hype hour has ended/i);
});

test('radio state publishes the prepared next item with its changeover start time for browser preloading', async () => {
  const { buildRadioState } = await import('../discord-bot/jukeloop.js');
  const waiting = buildRadioState({
    nowPlaying: null,
    playlist: [],
    now: 10_000,
    upNext: { trackId: 'devert:7', title: 'Video Ad', uploader: 'Advertiser', filename: 'ad.mp4',
      mediaType: 'video/mp4', ipfsCid: 'bafy-ad', isDevert: true, startsAt: 11_500 },
  });
  assert.deepEqual(waiting.upNext, {
    trackId: 'devert:7', title: 'Video Ad', uploader: 'Advertiser', filename: 'ad.mp4', mediaType: 'video/mp4',
    videoUrl: 'ipfs://bafy-ad', ipfsCid: 'bafy-ad', isDevert: true, startsAt: 11_500, startsInMs: 1_500,
  });
  const prepared = buildRadioState({ nowPlaying: null, playlist: [], upNext: { trackId: 't', title: 'Song', filename: 'song.mp3', ipfsCid: 'bafy-song' } });
  assert.equal(prepared.upNext.mediaType, 'audio/mpeg');
  assert.equal('startsAt' in prepared.upNext, false);
  assert.equal(buildRadioState({ nowPlaying: null, playlist: [] }).upNext, null);
});

test('JukeLoop waits out the changeover gap while publishing the next item, and drops it if the show changes', async (t) => {
  const { JukeLoopSession, CHANGEOVER_GAP_MS } = await import('../discord-bot/jukeloop.js');
  for (const scenario of ['starts-after-gap', 'show-changed']) {
    await t.test(scenario, async () => {
      const session = new JukeLoopSession({ voiceChannel: { guild: { id: `changeover-${scenario}` } }, textChannel: {}, client: {} });
      const prepared = { track: { trackId: 'next', title: 'Next Song', uploader: 'Artist', ipfsCid: 'bafy-next', filename: 'next.m4a' } };
      const started = [];
      const disposed = [];
      let release;
      session._preparedNext = prepared;
      session._changeoverAt = Date.now() + CHANGEOVER_GAP_MS;
      session._sleep = () => new Promise(resolve => { release = resolve; });
      session._startPrepared = value => { started.push(value); return true; };
      session._disposePrepared = value => disposed.push(value);
      try {
        assert.equal(session.getUpNext().startsAt, undefined, 'prepared items have no start time until the song ends');
        const transition = session._playNext();
        await new Promise(resolve => setImmediate(resolve));
        const upNext = session.getUpNext();
        assert.equal(upNext.ipfsCid, 'bafy-next');
        assert.equal(upNext.startsAt, session._changeoverAt);
        assert.equal(started.length, 0, 'the next song waits for the gap');
        if (scenario === 'show-changed') session._preparationEpoch++;
        release();
        await transition;
        assert.equal(session.getUpNext(), null);
        assert.deepEqual(started, scenario === 'starts-after-gap' ? [prepared] : []);
        assert.deepEqual(disposed, scenario === 'show-changed' ? [prepared] : []);
      } finally {
        session.destroy();
      }
    });
  }
});

test('JukeLoop selects a due advert during the unlocking song and keeps it queued if that song does not count', async (t) => {
  const { JukeLoopSession } = await import('../discord-bot/jukeloop.js');
  const { DEVERT_SONGS_PER_MAIN_AD } = await import('../js/devert-scheduler.mjs');
  for (const scenario of ['song-counted', 'song-too-short']) {
    await t.test(scenario, async () => {
      const ad = { campaignId: '9', mainRadio: true,
        track: { trackId: 'devert:9', title: 'Video Ad', uploader: 'Advertiser', ipfsCid: 'bafy-ad', mediaType: 'video/mp4' } };
      let selections = 0;
      const session = new JukeLoopSession({
        voiceChannel: { guild: { id: `anticipated-${scenario}` } },
        textChannel: { send: async () => ({}) },
        client: {},
        devertPlayback: { nextMainRadioAd: async () => { selections++; return [ad]; } },
        createStream: () => {
          const stream = new PassThrough();
          const ffmpegProcess = new EventEmitter();
          ffmpegProcess.kill = () => {};
          stream.write(Buffer.from('audio'));
          return { stream, ffmpegProcess };
        },
      });
      const started = [];
      session._getFreshUrl = async track => `https://media.example/${track.trackId}`;
      session._persistMainRadioAdState = async () => {};
      session._sleep = async () => {};
      session._startPrepared = value => { started.push(value); return true; };
      session._queue = [{ trackId: 'music-next', title: 'Music Next', ipfsCid: 'bafy-music' }];
      session._queueIndex = 0;
      session._musicSinceAd = DEVERT_SONGS_PER_MAIN_AD - 1;
      try {
        session._primeNext();
        await session._prepareTask;
        assert.equal(selections, 1);
        assert.equal(session.getUpNext().ipfsCid, 'bafy-ad', 'the selected advert is published before its turn');
        assert.equal(session.getUpNext().isDevert, true);

        if (scenario === 'song-counted') session._musicSinceAd = DEVERT_SONGS_PER_MAIN_AD;
        await session._playNext();
        assert.equal(started.length, 1);
        if (scenario === 'song-counted') {
          assert.equal(started[0].devertAd, ad);
        } else {
          assert.equal(started[0].devertAd, null);
          assert.equal(started[0].track.trackId, 'music-next');
          assert.equal(session._preparedDevertAd, ad, 'the advert waits for its real slot');
        }
        assert.equal(selections, 1, 'no second selection at the changeover');
      } finally {
        session.destroy();
      }
    });
  }

  await t.test('restart before the unlocking song counts', async () => {
    const ad = { campaignId: '9', mainRadio: true,
      track: { trackId: 'devert:9', title: 'Video Ad', uploader: 'Advertiser', ipfsCid: 'bafy-ad', mediaType: 'video/mp4' } };
    const makeSession = (id) => {
      const session = new JukeLoopSession({
        voiceChannel: { guild: { id } },
        textChannel: { send: async () => ({}) },
        client: {},
        devertPlayback: { nextMainRadioAd: async () => [ad] },
        createStream: () => {
          const stream = new PassThrough();
          const ffmpegProcess = new EventEmitter();
          ffmpegProcess.kill = () => {};
          stream.write(Buffer.from('audio'));
          return { stream, ffmpegProcess };
        },
      });
      session._getFreshUrl = async track => `https://media.example/${track.trackId}`;
      session._persistMainRadioAdState = async () => {};
      session._sleep = async () => {};
      session._queue = [{ trackId: 'music-next', title: 'Music Next', ipfsCid: 'bafy-music' }];
      session._queueIndex = 0;
      return session;
    };
    const before = makeSession('anticipated-restart-a');
    before._musicSinceAd = DEVERT_SONGS_PER_MAIN_AD - 1;
    let snapshot;
    try {
      before._primeNext();
      await before._prepareTask;
      snapshot = before._snapshotMainRadioAdState();
      assert.equal(snapshot.breakAwaitingUnlock, true);
    } finally {
      before.destroy();
    }

    const after = makeSession('anticipated-restart-b');
    const started = [];
    after._startPrepared = value => { started.push(value); return true; };
    after._applyMainRadioAdState(snapshot);
    try {
      await after._playNext();
      assert.equal(started.length, 1);
      assert.equal(started[0].devertAd, null, 'a restored early pick still waits for its slot');
      assert.equal(after._preparedDevertAd?.campaignId, '9');
    } finally {
      after.destroy();
    }
  });
});
