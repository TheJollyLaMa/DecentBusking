const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { Wallet } = createRequire(require('node:path').join(__dirname, '../discord-bot/package.json'))('ethers');

test('earnings and payment sections reuse collapsed profile dropdowns with padded bodies', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  for (const attribute of ['data-profile-earnings', 'data-song-section', 'data-album-section']) {
    const section = html.match(new RegExp(`<details class="creator-dropdown" ${attribute}[^>]*>[\\s\\S]*?</details>`))?.[0];
    assert.ok(section, `${attribute} uses the existing profile dropdown`);
    assert.doesNotMatch(section.split('>')[0], /\bopen\b/);
    assert.match(section, /<summary><span[^>]*class="creator-dropdown-title"/);
    assert.match(section, /<div class="creator-dropdown-body/);
    if (attribute !== 'data-profile-earnings') assert.match(section, /creator-payment-body/);
  }
  assert.match(html, /<strong class="creator-earnings-total" data-earnings-total>—<\/strong><\/summary>/);
  const profile = fs.readFileSync(path.join(__dirname, '../js/creator-profile.mjs'), 'utf8');
  const reveal = profile.indexOf('songSplitForm.hidden = false;');
  const expand = profile.indexOf("dialog.querySelector('[data-song-section]').open = true;", reveal);
  const scroll = profile.indexOf('songSplitForm.scrollIntoView', reveal);
  assert.ok(reveal >= 0 && expand > reveal && scroll > expand, 'song selection expands the editor before scrolling to it');
});

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
  assert.equal(store.getByDiscordId('735090955560157185').address, wallet.address.toLowerCase());
  assert.equal(store.getByDiscordId('123'), null);
  assert.equal(store.getByDiscordId('735090955560157185').address, wallet.address.toLowerCase());
  assert.equal(store.getByDiscordId('123'), null);
  await assert.rejects(store.confirmDiscord(link.code, {}), /expired or invalid/);
  const reloaded = createCreatorProfiles({ restore: async () => snapshot, save: async () => 'ipfs://profile' });
  await reloaded.initialize();
  assert.equal(reloaded.get(wallet.address).displayName, 'Creator');
});

test('creator profiles keep watchlists separate from profile updates and reject replayed watchlist signatures', async () => {
  const { createCreatorProfiles } = await import('../discord-bot/creator-profiles.js');
  const { buildCreatorAuthorizationMessage, buildCreatorWatchlistAuthorizationMessage } = await import('../js/creator-profile-data.mjs');
  const wallet = Wallet.createRandom();
  const origin = 'https://busking.example';
  let snapshot = null;
  const store = createCreatorProfiles({ restore: async () => snapshot, save: async next => { snapshot = next; return 'ipfs://profile'; } });
  await store.initialize();
  const sign = async body => ({
    ...body,
    signature: await wallet.signMessage(body.action.includes('watchlist')
      ? buildCreatorWatchlistAuthorizationMessage(body)
      : buildCreatorAuthorizationMessage(body)),
  });
  const profileBody = await sign({ address: wallet.address, origin, action: 'save', profile: { displayName: 'Listener' },
    nonce: require('node:crypto').randomUUID(), issuedAt: new Date().toISOString() });
  await store.update(profileBody, origin);
  const entry = { chainId: 8453, contractAddress: `0x${'1'.repeat(40)}`, tokenId: 17, title: 'Moonlit Signal', artist: 'Synth Artist', artworkURI: 'ipfs://art' };
  const add = await sign({ address: wallet.address, origin, action: 'save-watchlist', entry,
    nonce: require('node:crypto').randomUUID(), issuedAt: new Date().toISOString() });
  await store.updateWatchlist(add, origin);
  await assert.rejects(store.updateWatchlist(add, origin), /already used/);
  assert.equal(store.get(wallet.address).displayName, 'Listener');
  assert.equal(store.get(wallet.address).watchlist.length, 1);
  assert.equal(store.get(wallet.address).watchlist[0].title, 'Moonlit Signal');
  const duplicate = await sign({ address: wallet.address, origin, action: 'save-watchlist', entry,
    nonce: require('node:crypto').randomUUID(), issuedAt: new Date().toISOString() });
  await store.updateWatchlist(duplicate, origin);
  assert.equal(store.get(wallet.address).watchlist.length, 1);
  const remove = await sign({ address: wallet.address, origin, action: 'remove-watchlist', entry,
    nonce: require('node:crypto').randomUUID(), issuedAt: new Date().toISOString() });
  await store.updateWatchlist(remove, origin);
  assert.equal(store.get(wallet.address).watchlist.length, 0);
  await assert.rejects(store.updateWatchlist({ ...await sign({ address: Wallet.createRandom().address, origin, action: 'save-watchlist', entry,
    nonce: require('node:crypto').randomUUID(), issuedAt: new Date().toISOString() }), address: Wallet.createRandom().address }, origin), /does not match/);
  const reloaded = createCreatorProfiles({ restore: async () => snapshot, save: async () => 'ipfs://profile' });
  await reloaded.initialize();
  assert.equal(reloaded.get(wallet.address).displayName, 'Listener');
  assert.equal(reloaded.get(wallet.address).watchlist.length, 0);
});

test('creator images prefer verified ENS, then uploaded IPFS, then Discord', async () => {
  const { creatorPresentation, creatorImageURL, resolveCreatorENS } = await import('../js/creator-profile-data.mjs');
  const discord = { displayName: 'Discord', avatarURI: 'https://cdn.discordapp.com/avatar.png' };
  const ens = { name: 'thejollylama.eth', avatarURI: 'https://example.com/ens.png', bannerURI: 'https://example.com/banner.png' };
  assert.equal(creatorPresentation({}).name, 'Profile');
  assert.equal(creatorPresentation({}, ens).name, 'thejollylama.eth');
  assert.equal(creatorPresentation({ discord }, ens).avatarURI, ens.avatarURI);
  assert.deepEqual(creatorPresentation({ discord, avatarURI: 'ipfs://bafyimage' }, ens).avatars,
    { ens: ens.avatarURI, discord: discord.avatarURI, uploaded: 'ipfs://bafyimage' });
  assert.equal(creatorPresentation({ discord, avatarURI: 'ipfs://bafyimage' }, ens).avatarURI, ens.avatarURI);
  assert.equal(creatorPresentation({ discord, avatarURI: 'ipfs://bafyimage' }, { name: 'thejollylama.eth', avatarURI: 'javascript:alert(1)' }).avatarURI, 'ipfs://bafyimage');
  assert.equal(creatorPresentation({ discord }).avatarURI, discord.avatarURI);
  assert.deepEqual(creatorPresentation({ discord, avatarURI: 'ipfs://bafyimage' }, { name: 'x.eth', avatarURI: 'javascript:alert(1)' }).avatarCandidates,
    ['ipfs://bafyimage', discord.avatarURI]);
  assert.deepEqual(creatorPresentation({ bannerURI: 'ipfs://bafybanner' }, ens).bannerCandidates, [ens.bannerURI, 'ipfs://bafybanner']);
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
    getResolver: async () => ({ getAvatar: async () => 'https://example.com/avatar.png',
      getText: async key => { records.push(key); return key === 'banner' ? 'ipfs://bafybanner' : ''; } }) });
  assert.equal(profile.name, 'thejollylama.eth');
  assert.equal(profile.avatarURI, 'https://example.com/avatar.png');
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

test('creator earnings loading prefers the worker index before the on-chain log fallback', async () => {
  const { collectCreatorEarnings } = await import('../js/creator-profile.mjs');
  const order = [];
  const result = await collectCreatorEarnings({
    ethers: { Contract: class {}, Interface: class {} },
    address: '0x' + '1'.repeat(40),
    serviceUrl: 'https://worker.example',
    publicProvider: {},
    fetchImpl: async () => { order.push('worker'); throw new Error('offline'); },
    readContracts: async () => [{ label: 'Base proof', status: 'paid', asset: 'USDC', units: 1n }],
    fetchWorker: async () => { order.push('worker'); throw new Error('offline'); },
    scanLogs: async () => { order.push('logs'); return { complete: true, entries: [] }; },
  });
  assert.deepEqual(order, ['worker', 'logs']);
  assert.equal(result.logs.complete, true);
  assert.equal(result.viewEntries.length, 1);
});

test('creator earnings still show indexed payouts when DJuke balance reads fail', async () => {
  const { collectCreatorEarnings } = await import('../js/creator-profile.mjs');
  const result = await collectCreatorEarnings({
    ethers: { Contract: class {}, Interface: class {} },
    address: '0x' + '1'.repeat(40),
    serviceUrl: 'https://worker.example',
    publicProvider: {},
    readContracts: async () => { throw new Error('contract is not allow-listed'); },
    fetchWorker: async () => ({ ready: true, entries: [] }),
    scanLogs: async () => { throw new Error('should not scan'); },
  });
  assert.deepEqual(result.viewEntries, []);
  assert.equal(result.logs.complete, true);
  assert.match(result.note, /DJuke song-play balances could not be read/);
});
test('song-play receipts replace the aggregate artistLedger line and receipts add up row by row', async () => {
  const { mergeLedgerReceipts, buildEarningsReceipt } = await import('../js/creator-profile.mjs');
  const contract = '0x5d07489163feBCdB39C9F579CCC36dff5A067FF9';
  const view = [
    { key: `${contract}:ledger`, label: 'DJuke v0.3 song plays', status: 'paid', asset: 'USDC', units: 450000n, proofLabel: 'artistLedger' },
    { key: `${contract}:credits`, label: 'DJuke v0.3 song plays', status: 'unclaimed', asset: 'USDC', units: 1n },
  ];
  const receipts = { kind: 'song-play', contract, label: 'DJuke v0.3 song plays', asset: 'USDC', units: 450000n, transactions: [
    { hash: '0x' + '2'.repeat(64), units: '225000', blockNumber: 20, url: 'https://basescan.org/tx/0x2', title: 'Second' },
    { hash: '0x' + '1'.repeat(64), units: '225000', blockNumber: 10, url: 'https://basescan.org/tx/0x1', title: 'First' },
  ] };
  const merged = mergeLedgerReceipts(view, [receipts]);
  assert.deepEqual(merged.viewEntries.map(entry => entry.status), ['unclaimed']);
  assert.equal(merged.note, '');
  assert.match(mergeLedgerReceipts(view, [{ ...receipts, units: 225000n }]).note, /contract ledger reports 0\.45 USDC/);

  const make = tag => {
    const el = { tag, children: [], _text: '', append(...nodes) { this.children.push(...nodes.map(node => typeof node === 'string' ? { _text: node, children: [] } : node)); } };
    Object.defineProperty(el, 'textContent', { get() { return this._text + this.children.map(child => child.textContent ?? child._text).join(''); }, set(value) { this._text = value; } });
    return el;
  };
  const find = (node, tag) => [...(node.tag === tag ? [node] : []), ...node.children.flatMap(child => find(child, tag))];
  const receipt = buildEarningsReceipt(receipts, { createElement: make });
  const [body] = find(receipt, 'tbody');
  const rows = find(body, 'tr').map(row => row.children.map(cell => cell.textContent));
  assert.deepEqual(rows.map(row => [row[0], row[2], row[3], row[4]]), [
    ['2', 'Second', '0.23 USDC', '0.45 USDC'],
    ['1', 'First', '0.23 USDC', '0.23 USDC'],
  ]);
  assert.equal(find(body, 'a')[0].href, 'https://basescan.org/tx/0x2');
  assert.match(find(receipt, 'tfoot')[0].textContent, /Total · 2 payouts0\.45 USDC/);
});
