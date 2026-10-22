const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { Wallet, verifyMessage } = createRequire(require('node:path').join(__dirname, '../discord-bot/package.json'))('ethers');

const song = index => `0x${index.toString(16).padStart(64, '0')}`;

test('named playlist model enforces the 1–10 cap, unique tracks and explicit flat pricing', async () => {
  const { normalizeNamedPlaylist } = await import('../js/creator-profile-data.mjs');
  const { quoteNamedPlaylist, matchesPlaylistRevision } = await import('../js/djuke-playlists.mjs');
  const maker = Wallet.createRandom().address;
  assert.equal(normalizeNamedPlaylist({ id: 'a'.repeat(32), maker, name: ' Night drive ', revision: 1, songIds: [song(1)] }).name, 'Night drive');
  assert.throws(() => normalizeNamedPlaylist({ id: 'a'.repeat(32), maker, name: 'Mix', revision: 1, songIds: Array.from({ length: 11 }, (_, i) => song(i)) }), /1–10/);
  assert.throws(() => normalizeNamedPlaylist({ id: 'a'.repeat(32), maker, name: 'Mix', revision: 1, songIds: [song(1), song(1)] }), /unique/);
  assert.deepEqual(quoteNamedPlaylist(10, 'private'), { songCount: 10, subtotalUnits: 2500000n, feeUnits: 0n, totalUnits: 2500000n });
  assert.deepEqual(quoteNamedPlaylist(10, 'radio'), { songCount: 10, subtotalUnits: 2500000n, feeUnits: 5000000n, totalUnits: 7500000n });
  assert.throws(() => quoteNamedPlaylist(11, 'radio'), /1–10/);
  const revision = { songIds: [song(1), song(2)] };
  assert.equal(matchesPlaylistRevision(revision, [song(1), song(2)]), true);
  assert.equal(matchesPlaylistRevision(revision, [song(2), song(1)]), false);
  assert.equal(matchesPlaylistRevision(revision, [song(1)]), false);
});

test('playlist wallet signatures bind action, full revision, origin, nonce and expiry; wallet switches abort', async () => {
  const { buildCreatorPlaylistAuthorizationMessage } = await import('../js/creator-profile-data.mjs');
  const { createNamedPlaylistClient } = await import('../js/djuke-playlists.mjs');
  const wallet = Wallet.createRandom();
  let current = { address: wallet.address, signer: wallet };
  let posted;
  const client = createNamedPlaylistClient({ origin: 'https://busking.example', getWallet: () => current,
    newNonce: () => 'nonce-1234567890abcdef', now: () => 1000,
    fetchImpl: async (_url, options) => { posted = JSON.parse(options.body); return { ok: true, json: async () => ({ ok: true }) }; } });
  const playlist = { id: 'a'.repeat(32), maker: wallet.address, name: 'Road mix', revision: 1, songIds: [song(1), song(2)] };
  await client.saveOriginal(playlist);
  const message = buildCreatorPlaylistAuthorizationMessage({ ...posted, origin: 'https://busking.example', playlist });
  assert.equal(verifyMessage(message, posted.signature).toLowerCase(), wallet.address.toLowerCase());
  assert.notEqual(buildCreatorPlaylistAuthorizationMessage({ ...posted, origin: 'https://other.example', playlist }), message);
  assert.notEqual(buildCreatorPlaylistAuthorizationMessage({ ...posted, origin: 'https://busking.example', playlist: { ...playlist, revision: 2 } }), message);
  assert.notEqual(buildCreatorPlaylistAuthorizationMessage({ ...posted, origin: 'https://busking.example', playlist: { ...playlist, songIds: [song(2), song(1)] } }), message);
  for (const field of ['action', 'nonce', 'expiresAt']) {
    const altered = { ...posted, [field]: `${posted[field]}-altered` };
    assert.notEqual(buildCreatorPlaylistAuthorizationMessage({ ...altered, origin: 'https://busking.example', playlist }), message);
  }
  const other = Wallet.createRandom();
  const switchingClient = createNamedPlaylistClient({ origin: 'https://busking.example', getWallet: () => current,
    fetchImpl: async () => { throw new Error('should not submit after wallet switch'); } });
  current = { address: wallet.address, signer: { signMessage: async text => { current = { address: other.address, signer: other }; return wallet.signMessage(text); } } };
  await assert.rejects(switchingClient.saveOriginal({ ...playlist, id: 'b'.repeat(32) }), /Wallet changed/);
});

test('playlist capability gate stays closed until a versioned compatible address is enabled', async () => {
  const { supportsDJukePlaylistBatch } = await import('../js/djuke-playlists.mjs');
  assert.equal(supportsDJukePlaylistBatch({}), false);
  assert.equal(supportsDJukePlaylistBatch({ djukePlaylistBatchVersion: '0.3', djukePlaylistBatchAddress: `0x${'1'.repeat(40)}` }), false);
  assert.equal(supportsDJukePlaylistBatch({ djukePlaylistBatchVersion: '0.3', djukePlaylistBatchAddress: `0x${'1'.repeat(40)}`, djukePlaylistBatchEnabled: true }), true);
  assert.equal(supportsDJukePlaylistBatch({ djukePlaylistBatchVersion: '0.2', djukePlaylistBatchAddress: `0x${'1'.repeat(40)}`, djukePlaylistBatchEnabled: true }), false);
});

test('watchlist presentation groups bookmarks by artist without converting them to playlists', async () => {
  const { groupWatchlistByArtist } = await import('../js/djuke-playlists.mjs');
  assert.deepEqual(groupWatchlistByArtist([{ artist: 'B', title: 'Song 2' }, { artist: 'A', title: 'Song' }, { artist: 'B', title: 'Song 1' }]), [
    { artist: 'A', entries: [{ artist: 'A', title: 'Song' }] },
    { artist: 'B', entries: [{ artist: 'B', title: 'Song 1' }, { artist: 'B', title: 'Song 2' }] },
  ]);
});

test('profile playlist library preserves immutable saved revisions, maker authorization and stable discovery identity', async () => {
  const { createCreatorProfiles } = await import('../discord-bot/creator-profiles.js');
  const { buildCreatorPlaylistAuthorizationMessage, buildCreatorPlaylistCopyAuthorizationMessage } = await import('../js/creator-profile-data.mjs');
  let snapshot = null;
  const store = createCreatorProfiles({ restore: async () => snapshot, save: async next => { snapshot = next; return 'ipfs://profile-playlists'; } });
  await store.initialize();
  const maker = Wallet.createRandom();
  const listener = Wallet.createRandom();
  const origin = 'https://busking.example';
  const issue = async (wallet, payload, copy = false) => {
    const body = { address: wallet.address, origin, ...payload, nonce: require('node:crypto').randomUUID(), expiresAt: new Date(Date.now() + 120000).toISOString() };
    const message = copy ? buildCreatorPlaylistCopyAuthorizationMessage(body) : buildCreatorPlaylistAuthorizationMessage(body);
    return { ...body, signature: await wallet.signMessage(message) };
  };
  const first = { id: 'a'.repeat(32), maker: maker.address, name: 'Shared name', revision: 1, songIds: [song(1), song(2)] };
  const firstSigned = await issue(maker, { action: 'create-playlist', playlist: first });
  await store.savePlaylist(firstSigned, origin);
  await assert.rejects(store.savePlaylist(firstSigned, origin), /already used/);
  const sameName = { id: 'b'.repeat(32), maker: Wallet.createRandom().address, name: 'Shared name', revision: 1, songIds: [song(3)] };
  const otherMaker = new Wallet(Wallet.createRandom().privateKey);
  const second = { ...sameName, maker: otherMaker.address };
  await store.savePlaylist(await issue(otherMaker, { action: 'create-playlist', playlist: second }), origin);
  const found = store.discoverPlaylists('shared');
  assert.equal(found.length, 2);
  assert.notEqual(found[0].id, found[1].id);
  assert.ok(found.every(item => item.maker && item.songCount));

  const copy = await issue(listener, { action: 'save-playlist-copy', playlistId: first.id, revision: 1 }, true);
  await store.savePlaylistCopy(copy, origin);
  await assert.rejects(store.savePlaylistCopy(copy, origin), /already used/);
  const updated = { ...first, name: 'Revised name', revision: 2, songIds: [song(2), song(1)] };
  await store.savePlaylist(await issue(maker, { action: 'update-playlist', playlist: updated }), origin);
  const listenerProfile = store.get(listener.address);
  assert.equal(listenerProfile.playlists.length, 1);
  assert.equal(listenerProfile.playlists[0].revision, 1);
  assert.equal(listenerProfile.playlists[0].songIds[0], song(1));
  assert.equal(listenerProfile.playlists[0].attribution.maker, maker.address.toLowerCase());
  assert.equal(store.discoverPlaylists('revised')[0].revision, 2);
  await assert.rejects(store.savePlaylist(await issue(listener, { action: 'update-playlist', playlist: { ...updated, maker: listener.address } }), origin), /Only the maker/);

  const reloaded = createCreatorProfiles({ restore: async () => snapshot, save: async () => 'ipfs://profile-playlists' });
  await reloaded.initialize();
  assert.equal(reloaded.get(listener.address).playlists[0].revision, 1);
  assert.equal(reloaded.discoverPlaylists('shared').length, 1);
  await assert.rejects(reloaded.savePlaylistCopy(copy, origin), /already used/);
});

test('profile limits original and saved playlists to 20 combined and rejects expired/invalid playlist signatures', async () => {
  const { createCreatorProfiles } = await import('../discord-bot/creator-profiles.js');
  const { buildCreatorPlaylistAuthorizationMessage, buildCreatorPlaylistCopyAuthorizationMessage } = await import('../js/creator-profile-data.mjs');
  let snapshot = null;
  const store = createCreatorProfiles({ restore: async () => snapshot, save: async next => { snapshot = next; return 'ipfs://profile-playlists'; } });
  await store.initialize();
  const wallet = Wallet.createRandom();
  const origin = 'https://busking.example';
  const create = async i => {
    const playlist = { id: i.toString(16).padStart(32, '0'), maker: wallet.address, name: `Mix ${i}`, revision: 1, songIds: [song(i + 1)] };
    const body = { address: wallet.address, origin, action: 'create-playlist', playlist,
      nonce: require('node:crypto').randomUUID(), expiresAt: new Date(Date.now() + 120000).toISOString() };
    return { ...body, signature: await wallet.signMessage(buildCreatorPlaylistAuthorizationMessage(body)) };
  };
  for (let i = 1; i <= 20; i++) await store.savePlaylist(await create(i), origin);
  await assert.rejects(store.savePlaylist(await create(21), origin), /at most 20/);
  const otherMaker = Wallet.createRandom();
  const otherPlaylist = { id: 'f'.repeat(32), maker: otherMaker.address, name: 'Outside mix', revision: 1, songIds: [song(90)] };
  const otherBody = { address: otherMaker.address, origin, action: 'create-playlist', playlist: otherPlaylist,
    nonce: require('node:crypto').randomUUID(), expiresAt: new Date(Date.now() + 120000).toISOString() };
  await store.savePlaylist({ ...otherBody, signature: await otherMaker.signMessage(buildCreatorPlaylistAuthorizationMessage(otherBody)) }, origin);
  const signCopy = async (wallet, playlistId) => {
    const body = { address: wallet.address, origin, action: 'save-playlist-copy', playlistId, revision: 1,
      nonce: require('node:crypto').randomUUID(), expiresAt: new Date(Date.now() + 120000).toISOString() };
    return { ...body, signature: await wallet.signMessage(buildCreatorPlaylistCopyAuthorizationMessage(body)) };
  };
  await assert.rejects(store.savePlaylistCopy(await signCopy(wallet, otherPlaylist.id), origin), /at most 20/);
  const saver = Wallet.createRandom();
  for (let i = 1; i <= 20; i++) await store.savePlaylistCopy(await signCopy(saver, i.toString(16).padStart(32, '0')), origin);
  await assert.rejects(store.savePlaylistCopy(await signCopy(saver, otherPlaylist.id), origin), /at most 20/);
  const stale = await create(22);
  stale.expiresAt = new Date(Date.now() - 1000).toISOString();
  await assert.rejects(store.savePlaylist(stale, origin), /expired/);
  const malformed = await create(23);
  malformed.playlist = { ...malformed.playlist, songIds: Array.from({ length: 11 }, (_, i) => song(i + 1)) };
  await assert.rejects(store.savePlaylist(malformed, origin), /1–10/);
});

test('worker exposes public name search and only accepts signed playlist mutations from allowed origins', async () => {
  const { createCreatorProfiles } = await import('../discord-bot/creator-profiles.js');
  const { createWorkerRequestHandler } = await import('../discord-bot/ipfs-worker.js');
  const { buildCreatorPlaylistAuthorizationMessage } = await import('../js/creator-profile-data.mjs');
  const http = require('node:http');
  const wallet = Wallet.createRandom();
  const origin = 'https://busking.example';
  let snapshot = null;
  const profiles = createCreatorProfiles({ restore: async () => snapshot, save: async next => { snapshot = next; return 'ipfs://profile'; } });
  await profiles.initialize();
  const server = http.createServer(createWorkerRequestHandler({ allowedOrigins: [origin], ownerWallet: wallet.address, creatorProfiles: profiles }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const playlist = { id: 'c'.repeat(32), maker: wallet.address, name: 'Radio rides', revision: 1, songIds: [song(99)] };
    const body = { address: wallet.address, origin, action: 'create-playlist', playlist,
      nonce: require('node:crypto').randomUUID(), expiresAt: new Date(Date.now() + 120000).toISOString() };
    const signed = { ...body, signature: await wallet.signMessage(buildCreatorPlaylistAuthorizationMessage(body)) };
    const blocked = await fetch(`${base}/api/creator/playlists`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify(signed) });
    assert.equal(blocked.status, 400);
    const created = await fetch(`${base}/api/creator/playlists`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(signed) });
    assert.equal(created.status, 200);
    const discovery = await fetch(`${base}/api/creator/playlists?query=rides`);
    assert.equal(discovery.status, 200);
    assert.equal((await discovery.json()).playlists[0].id, playlist.id);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
