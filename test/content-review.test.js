const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet } = require('../discord-bot/node_modules/ethers');
const { EventEmitter } = require('node:events');

const owner = Wallet.createRandom();
const listener = Wallet.createRandom();
const collection = '0x' + 'ab'.repeat(20);
const epoch = Date.parse('2026-11-07T20:00:00Z');
const track = { trackId: 'song-1', title: 'A recording', ipfsCid: 'bafytestrecording',
  isDevertAd: false, source: 'site', mintStatus: 'minted', mintRecipient: listener.address,
  nftReferences: [{ chainId: 8453, contractAddress: collection, tokenId: '7' }], plays: 12, likes: 8 };
const nft = { contractAddress: collection, tokenId: '7', title: track.title, audioUrl: `ipfs://${track.ipfsCid}` };

async function fixture(options = {}) {
  const { createContentReview } = await import('../discord-bot/content-review.js');
  const shared = await import('../js/content-review.mjs');
  let saved, changes = 0, clock = epoch;
  const store = { restore: async () => saved, save: async value => { saved = structuredClone(value); return 'ipfs://review'; } };
  const config = { store, getItems: async () => [track, nft], ownerWallet: owner.address, now: () => clock,
    onChange: async () => { changes++; }, ...options };
  const service = createContentReview(config);
  await service.initialize();
  const body = async (command, wallet = owner) => {
    const body = { command, address: wallet.address, origin: 'https://example.org', issuedAt: new Date(clock).toISOString() };
    body.signature = await wallet.signMessage(shared.contentAuthorization(body));
    return body;
  };
  const exec = async (command, wallet = owner) => service.execute(await body({
    revision: (await service.adminState()).revision, ...command }, wallet), 'https://example.org');
  const policy = (extra = {}) => exec({ action: 'policy', target: shared.contentTarget(nft),
    scope: 'music-only', classification: 'original', reason: 'Steward review', stopNow: true, ...extra });
  return { service, shared, config, body, exec, policy, saved: () => saved, changes: () => changes,
    setTime: value => { clock = value; } };
}

test('signed reports request review without changing eligibility; Other requires an explanation', async () => {
  const f = await fixture();
  await assert.rejects(f.exec({ action: 'report', target: { trackId: track.trackId }, reason: 'other', note: '' }, listener), /Explanation/);
  for (const reason of f.shared.CONTENT_REASONS) {
    await f.exec({ action: 'report', target: { trackId: track.trackId }, reason, note: 'Please review' }, listener);
  }
  assert.equal(f.saved().reports.length, 4);
  assert.equal(f.service.apply(track).contentReview.scope, 'none');
  assert.equal(f.changes(), 0);
  assert.equal((await f.service.adminState()).items.length, 1, 'NFT and track reports group under one recording');
  await assert.rejects(f.exec({ action: 'view' }, listener), /Only the admin/);
});

test('moderation-blocked paid playlist retains its request without an automatic refund', async () => {
  const { createDjukeRuntime, createDjukePlaybackJournal } = await import('../discord-bot/djuke.js');
  let stored, refunds = 0;
  const request = { requestId: 'paid-1', playlistLaneId: '1', playlistBatchId: '1',
    trackId: track.trackId, songId: '0x' + '11'.repeat(32), playable: false, moderationBlocked: true };
  let requests = [request];
  const runtime = createDjukeRuntime({
    journal: createDjukePlaybackJournal({ restore: async () => stored, save: async next => { stored = next; return 'ipfs://journal'; } }),
    readState: async () => ({ requests, playlistPending: requests.filter(item => item.playlistLaneId !== undefined).length }),
    getTrack: () => track, fulfill: async () => { throw new Error('Should not fulfill'); },
    refundPlaylistBatch: async () => { refunds++; }, canPlayRequest: request => !request.moderationBlocked,
  });
  assert.equal(await runtime.nextPaid({}), null);
  assert.equal(refunds, 0);
  assert.equal(stored.records[0].state, 'pending');
  assert.equal(runtime.hasPendingPlaylist(), false, 'Blocked paid content does not silence free music rotation');
  requests = [request, { ...request, requestId: 'paid-2', playlistLaneId: '2', moderationBlocked: false, playable: true }];
  assert.equal(await runtime.nextPaid({}), null, 'Later playlist lanes do not leapfrog the blocked head');
  assert.equal(runtime.hasPendingPlaylist(), false, 'Waiting later lanes do not hold free rotation');
  requests = [{ ...request, requestId: 'blocked-main', playlistLaneId: undefined, playlistBatchId: undefined },
    { ...request, requestId: 'healthy-main', playlistLaneId: undefined, playlistBatchId: undefined, moderationBlocked: false, playable: true }];
  assert.equal((await runtime.nextPaid({})).record.requestId, 'healthy-main', 'Blocked main requests do not starve eligible ones');
  assert.equal(refunds, 0);
});

test('authorization binds origin, wallet, command, age and admin role', async () => {
  const f = await fixture();
  await assert.rejects(f.exec({ action: 'policy', target: { trackId: track.trackId } }, listener), /Only the admin/);
  const body = await f.body({ action: 'view' });
  body.command.action = 'report';
  await assert.rejects(f.service.execute(body, body.origin), /authorization/);
  const otherOrigin = await f.body({ action: 'view' });
  await assert.rejects(f.service.execute(otherOrigin, 'https://evil.org'), /authorization/);
  const stale = await f.body({ action: 'view' });
  f.setTime(epoch + 300001);
  await assert.rejects(f.service.execute(stale, stale.origin), /expired/);
});

test('unknown targets and invalid scopes are rejected without saving', async () => {
  const f = await fixture();
  await assert.rejects(f.policy({ target: { trackId: 'unknown' } }), /not in the platform catalog/);
  await assert.rejects(f.policy({ scope: 'delete' }), /Invalid classification/);
  assert.equal(f.saved(), undefined);
});

test('NFT moderation reaches its track and campaign media, restores, and is reversible without changing raw accounting', async () => {
  const f = await fixture();
  await f.policy({ classification: 'advert' });
  assert.equal(f.service.apply(track).isDevertAd, true);
  assert.equal(f.shared.radioContentAllowed(f.service.apply(track)), false);
  assert.equal(f.shared.radioContentAllowed(f.service.apply({ audioURI: `ipfs://${track.ipfsCid}` }), true), true);
  assert.equal(track.isDevertAd, false);
  assert.equal(track.plays, 12);
  assert.equal(track.likes, 8);
  const { createContentReview } = await import('../discord-bot/content-review.js');
  const restarted = createContentReview({ ...f.config, store: { restore: async () => f.saved(), save: f.config.store.save } });
  await restarted.initialize();
  assert.equal(restarted.apply(nft).isDevertAd, true);
  await f.policy({ scope: 'all-radio' });
  assert.equal(f.shared.radioContentAllowed(f.service.apply({ audioURI: `ipfs://${track.ipfsCid}` }), true), false);
  await f.policy({ scope: 'none', classification: 'original' });
  assert.equal(f.shared.radioContentAllowed(f.service.apply(track)), true);
  assert.equal(f.saved().history.length, 3);
});

test('review revisions reject concurrent stale changes and reports cannot replay after dismissal', async () => {
  const f = await fixture();
  const body = await f.body({ action: 'report', target: { trackId: track.trackId }, reason: 'copyright', note: '' }, listener);
  await f.service.execute(body, body.origin);
  const report = f.saved().reports[0];
  await f.exec({ action: 'review-report', reportId: report.id, status: 'dismissed', reason: 'Reviewed rights' });
  await assert.rejects(f.service.execute(body, body.origin), /already used/);
  const revision = (await f.service.adminState()).revision;
  await f.policy();
  await assert.rejects(f.exec({ action: 'policy', revision, target: { trackId: track.trackId },
    scope: 'none', classification: 'song', stopNow: false, reason: 'Stale' }), /Review changed/);
});

test('checkpoint failures leave explicit unavailable state; corrupted restoration fails closed', async () => {
  const f = await fixture({ store: { restore: async () => null, save: async () => { throw new Error('offline'); } } });
  await assert.rejects(f.policy(), /checkpoint is uncertain/);
  assert.throws(() => f.service.apply(track), /checkpoint is uncertain/);
  await assert.rejects(f.policy(), /checkpoint is uncertain/);
  const { createContentReview } = await import('../discord-bot/content-review.js');
  const bad = createContentReview({ ...f.config, store: { restore: async () => ({ schemaVersion: 1, items: [] }) } });
  await assert.rejects(bad.initialize(), /Invalid content review checkpoint/);
  assert.throws(() => bad.apply(track), /restoring/);
});

test('private report checkpoint is authenticated and contains no plaintext evidence', async () => {
  const { contentReviewCodec } = await import('../discord-bot/content-review.js');
  const codec = contentReviewCodec('12'.repeat(32));
  const value = { note: 'private evidence', reporter: listener.address };
  const encrypted = codec.serialize(value);
  assert.doesNotMatch(JSON.stringify(encrypted), /private evidence/);
  assert.deepEqual(codec.deserialize(encrypted), value);
  assert.throws(() => contentReviewCodec('13'.repeat(32)).deserialize(encrypted));
  assert.throws(() => codec.deserialize({ ...encrypted, tag: '00'.repeat(16) }));
});

test('effective music exclusion gates playlist shows and DJuke catalogs but not raw history', async () => {
  const f = await fixture();
  const { isEligibleRadioMusic } = await import('../js/radio-playlists.mjs');
  const { djukeCatalog } = await import('../discord-bot/djuke.js');
  assert.equal(isEligibleRadioMusic(track), true);
  await f.policy();
  const effective = f.service.apply(track);
  assert.equal(isEligibleRadioMusic(effective), false);
  assert.equal(djukeCatalog([effective]).length, 0);
});

test('playlist overlay excludes weighted rotation but preserves raw records and exposes relabeled ads', async () => {
  const f = await fixture();
  const fs = require('node:fs');
  const path = require('node:path');
  const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dbusk-review-'));
  const previous = process.env.JUKELOOP_PLAYLIST_PATH;
  process.env.JUKELOOP_PLAYLIST_PATH = path.join(temp, 'playlist.json');
  const url = require('node:url').pathToFileURL(path.join(__dirname, '../discord-bot/playlist-store.js'));
  url.searchParams.set('test', 'content-review');
  const store = await import(url.href);
  store.loadPlaylist([track]);
  store.configureContentOverlay(item => f.service.apply(item));
  try {
    await f.policy();
    assert.equal(store.getWeightedShuffledPlaylist().some(item => item.trackId === track.trackId), false);
    assert.equal(store.getPlaylist().find(item => item.trackId === track.trackId).plays, 12);
    await f.policy({ classification: 'advert' });
    assert.equal(store.getDevertAdsForWallet(listener.address).some(item => item.trackId === track.trackId), true);
  } finally {
    store.configureContentOverlay(item => item);
    if (previous === undefined) delete process.env.JUKELOOP_PLAYLIST_PATH;
    else process.env.JUKELOOP_PLAYLIST_PATH = previous;
    fs.unlinkSync(path.join(temp, 'playlist.json'));
    fs.rmdirSync(temp);
  }
});

test('prepared and current excluded playback are invalidated without paid delivery credit', async t => {
  const { JukeLoopSession } = await import('../discord-bot/jukeloop.js');
  const player = new EventEmitter();
  player.state = { status: 'playing' };
  let stops = 0, killed = 0, released = 0;
  player.stop = () => { stops++; };
  const session = new JukeLoopSession({ audioPlayer: player, client: {}, isContentAllowed: () => false,
    djuke: { release: async () => { released++; }, fail: async () => { released++; } } });
  session._playNext = async () => {};
  session._primeNext = () => {};
  session._refreshQueue = () => {};
  session._preparedNext = { track, paid: { record: { requestId: 'paid-1' } }, ffmpegProcess: { kill: () => { killed++; } } };
  session._currentTrack = track;
  session._currentPaid = { requestId: 'paid-2' };
  session._nowPlaying = { trackId: track.trackId };
  t.after(() => session.destroy());
  assert.equal(session._startPrepared({ track, resource: {} }), false);
  await session.refreshContentReview({ stopNow: true });
  assert.equal(stops, 1);
  assert.equal(killed, 1);
  assert.equal(released, 2);
  assert.equal(session._nowPlaying, null);
  session._currentTrack = track;
  session._currentPaid = { requestId: 'paid-3' };
  session.djuke.fail = async () => { throw new Error('Journal unavailable'); };
  await assert.rejects(session.refreshContentReview({ stopNow: true }), /Journal unavailable/);
  assert.equal(stops, 2, 'Audio stops even when returning the payment to pending fails');
  assert.equal(session._currentTrack, null);
  assert.equal(session._currentPaid, null);
});

test('report HTTP endpoint requires configured service and allowed origin', async () => {
  const http = require('node:http');
  const { createWorkerRequestHandler } = await import('../discord-bot/ipfs-worker.js');
  const f = await fixture();
  const server = http.createServer(createWorkerRequestHandler({ ownerWallet: owner.address,
    allowedOrigins: ['https://example.org'], contentReview: f.service }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/content-review`;
    const send = (origin, body) => fetch(url, { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await send('https://evil.org', await f.body({ action: 'view' }))).status, 400);
    const response = await send('https://example.org', await f.body({ action: 'view' }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok((await response.json()).items.length);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('paid adverts use advert eligibility at preparation and current-play moderation', async t => {
  const { JukeLoopSession } = await import('../discord-bot/jukeloop.js');
  const player = new EventEmitter();
  player.state = { status: 'playing' };
  player.stop = () => {};
  const contexts = [];
  const session = new JukeLoopSession({ audioPlayer: player, client: {},
    isContentAllowed: (_track, advert) => { contexts.push(advert); return false; },
    djuke: { release: async () => {}, fail: async () => {} } });
  t.after(() => session.destroy());
  session._refreshQueue = () => {};
  session._primeNext = () => {};
  session._playNext = async () => {};
  const advert = { ...track, isDevertAd: true };
  session._startPrepared({ track: advert, paid: { record: { requestId: 'ad-1', kind: 'devert' } } });
  session._currentTrack = advert;
  session._currentPaid = { requestId: 'ad-2', kind: 'devert' };
  await session.refreshContentReview({ stopNow: true });
  assert.deepEqual(contexts, [true, true], 'Paid priority ads are adverts, not excluded music');
});
