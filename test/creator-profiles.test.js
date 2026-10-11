const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { Wallet } = createRequire(require('node:path').join(__dirname, '../discord-bot/package.json'))('ethers');

test('creator profiles require wallet signatures and verified Discord confirmation before linking', async () => {
  const { createCreatorProfiles } = await import('../discord-bot/creator-profiles.js');
  const { buildCreatorAuthorizationMessage } = await import('../js/creator-profile-data.mjs');
  const wallet = Wallet.createRandom();
  const origin = 'https://busking.example';
  let snapshot = null;
  const store = createCreatorProfiles({ restore: async () => snapshot, save: async next => { snapshot = next; return 'ipfs://profile'; } });
  await store.initialize();
  const sign = async (action, profile = {}) => {
    const body = { action, profile, address: wallet.address, origin, nonce: require('node:crypto').randomUUID(), issuedAt: new Date().toISOString() };
    return { ...body, signature: await wallet.signMessage(buildCreatorAuthorizationMessage(body)) };
  };
  const body = await sign('save', { displayName: 'Creator', avatarURI: 'ipfs://bafyimage' });
  await store.update(body, origin);
  await assert.rejects(store.update(body, origin), /already used/);
  await assert.rejects(store.update({ ...await sign('save'), address: Wallet.createRandom().address }, origin), /does not match/);
  const link = store.startLink(await sign('link-discord'), origin);
  assert.equal(store.get(wallet.address).discord, undefined);
  await store.confirmDiscord(link.code, { id: '735090955560157185', username: 'creator', displayAvatarURL: () => 'https://cdn.discordapp.com/avatar.png' });
  assert.equal(store.get(wallet.address).discord.id, '735090955560157185');
  await assert.rejects(store.confirmDiscord(link.code, {}), /expired or invalid/);
  const reloaded = createCreatorProfiles({ restore: async () => snapshot, save: async () => 'ipfs://profile' });
  await reloaded.initialize();
  assert.equal(reloaded.get(wallet.address).displayName, 'Creator');
});

test('creator images prefer uploaded IPFS, then verified ENS, then Discord', async () => {
  const { creatorPresentation, creatorImageURL, resolveCreatorENS } = await import('../js/creator-profile-data.mjs');
  const discord = { displayName: 'Discord', avatarURI: 'https://cdn.discordapp.com/avatar.png' };
  const ens = { name: 'thejollylama.eth', avatarURI: 'https://example.com/ens.png', bannerURI: 'https://example.com/banner.png' };
  assert.equal(creatorPresentation({ discord }, ens).avatarURI, ens.avatarURI);
  assert.equal(creatorPresentation({ discord, avatarURI: 'ipfs://bafyimage' }, ens).avatarURI, 'ipfs://bafyimage');
  assert.equal(creatorPresentation({ discord }).avatarURI, discord.avatarURI);
  assert.equal(creatorImageURL('javascript:alert(1)'), '');
  assert.equal(creatorImageURL('ipfs://bafyimage'), 'https://gateway.pinata.cloud/ipfs/bafyimage');
  const address = Wallet.createRandom().address;
  assert.equal(await resolveCreatorENS(address, { lookupAddress: async () => 'fake.eth', resolveName: async () => Wallet.createRandom().address }), null);
});

test('ENS profile reads avatar and optional banner only after forward verification', async () => {
  const { resolveCreatorENS } = await import('../js/creator-profile-data.mjs');
  const address = Wallet.createRandom().address;
  const records = [];
  const profile = await resolveCreatorENS(address, { lookupAddress: async () => 'thejollylama.eth', resolveName: async () => address,
    getResolver: async () => ({ getAvatar: async () => ({ url: 'https://example.com/avatar.png' }),
      getText: async key => { records.push(key); return key === 'banner' ? 'ipfs://bafybanner' : ''; } }) });
  assert.equal(profile.name, 'thejollylama.eth');
  assert.equal(profile.bannerURI, 'ipfs://bafybanner');
  assert.deepEqual(records, ['banner', 'header']);
});

test('collaborator editor validates exact basis points, duplicate wallets and credit titles', async () => {
  const { parseCreatorSplits } = await import('../js/creator-profile.mjs');
  const first = Wallet.createRandom().address, second = Wallet.createRandom().address;
  assert.deepEqual(parseCreatorSplits(`${first}, 70.25, Performer\n${second}, 29.75, Producer`).shares, [7025, 2975]);
  assert.throws(() => parseCreatorSplits(`${first}, 50, Performer\n${first}, 50, Producer`), /distinct/);
  assert.throws(() => parseCreatorSplits(`${first}, 99.999, Performer`), /wallet, percentage/);
});

test('creator HTTP endpoints enforce allowed origins and signed updates without exposing link challenges publicly', async () => {
  const { createCreatorProfiles } = await import('../discord-bot/creator-profiles.js');
  const { createWorkerRequestHandler } = await import('../discord-bot/ipfs-worker.js');
  const { buildCreatorAuthorizationMessage } = await import('../js/creator-profile-data.mjs');
  const wallet = Wallet.createRandom(), origin = 'https://busking.example';
  const profiles = createCreatorProfiles({ restore: async () => null, save: async () => 'ipfs://saved' });
  await profiles.initialize();
  const server = require('node:http').createServer(createWorkerRequestHandler({ allowedOrigins: [origin], ownerWallet: wallet.address, creatorProfiles: profiles }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const authorization = { address: wallet.address, origin, action: 'save', nonce: require('node:crypto').randomUUID(),
      issuedAt: new Date().toISOString(), profile: { displayName: 'Creator' } };
    const signature = await wallet.signMessage(buildCreatorAuthorizationMessage(authorization));
    const body = JSON.stringify({ ...authorization, signature });
    const blocked = await fetch(`${base}/api/creator/profile`, { method: 'POST', headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' }, body });
    assert.equal(blocked.status, 400);
    const saved = await fetch(`${base}/api/creator/profile`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body });
    assert.equal(saved.status, 200);
    assert.equal(saved.headers.get('access-control-allow-origin'), origin);
    const response = await fetch(`${base}/api/creator/profile?address=${wallet.address}`);
    const profile = await response.json();
    assert.equal(profile.displayName, 'Creator');
    assert.equal(profile.code, undefined);
    assert.equal(profile.signature, undefined);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});