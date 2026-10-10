const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const vm = require('node:vm');

const gatewayUrl = pathToFileURL(path.join(__dirname, '..', 'js', 'ipfs-gateway.js')).href;
const loaderUrl = pathToFileURL(path.join(__dirname, '..', 'js', 'nft-loader.js')).href;

test('NFT identities and caches distinguish identical token IDs across collections', async () => {
  const { loadMintedToken, nftIdentity, configuredNftCollections } = await import(loaderUrl);
  const oldAddress = `0x${'1'.repeat(40)}`;
  const newAddress = `0x${'2'.repeat(40)}`;
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const contract = { totalMinted: async () => 1n, uri: async () => 'ipfs://metadata', creatorOf: async () => '' };
  const tokens = [];
  for (const contractAddress of [oldAddress, newAddress]) {
    tokens.push(await loadMintedToken({ contract, tokenId: 0, contractAddress, storage,
      cacheKey: `8453:${contractAddress}`, fetchMetadata: async () => ({ name: contractAddress }) }));
  }
  assert.notEqual(tokens[0].nftId, tokens[1].nftId);
  assert.equal(tokens[0].contractAddress, oldAddress);
  assert.equal(tokens[1].contractAddress, newAddress);
  assert.equal(values.size, 2);
  assert.throws(() => nftIdentity({ contractAddress: 'invalid', tokenId: 0 }));
  assert.deepEqual(configuredNftCollections({ contractAddress: oldAddress,
    additionalNftContractAddresses: [oldAddress, newAddress] }).map(entry => entry.contractAddress), [oldAddress, newAddress]);
});

test('falls back to the Pinata browser gateway for IPFS metadata', async () => {
  const { fetchIpfsJson } = await import(gatewayUrl);
  const requested = [];
  const metadata = await fetchIpfsJson('ipfs://bafymeta', {
    primaryGateway: 'https://dweb.link/ipfs/',
    fetchImpl: async (url) => {
      requested.push(url);
      if (url.includes('dweb.link')) throw new Error('CORS blocked');
      return new Response(JSON.stringify({ name: 'Track' }), { status: 200 });
    },
  });

  assert.deepEqual(metadata, { name: 'Track' });
  assert.deepEqual(requested, [
    'https://dweb.link/ipfs/bafymeta',
    'https://gateway.pinata.cloud/ipfs/bafymeta',
  ]);
});

test('loads a minted token when creatorOf reverts', async () => {
  const { loadMintedToken } = await import(loaderUrl);
  const nft = await loadMintedToken({
    tokenId: 4,
    contract: {
      totalMinted: async () => 1n,
      uri: async () => 'ipfs://bafymeta',
      creatorOf: async () => { throw new Error('execution reverted'); },
    },
    fetchMetadata: async () => ({
      name: '669 counting flowers',
      audioUrl: 'ipfs://bafyaudio',
      artist: '0x1111111111111111111111111111111111111111',
    }),
  });

  assert.equal(nft.tokenId, 4);
  assert.equal(nft.creator, '0x1111111111111111111111111111111111111111');
  assert.equal(nft.audioUrl, 'ipfs://bafyaudio');
});

test('caches minted metadata and hashes by chain and contract without repeated RPC reads', async () => {
  const { loadMintedToken, readCachedMintedTokens } = await import(loaderUrl);
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  let reads = 0;
  const contract = {
    totalMinted: async () => { reads++; return 1n; },
    uri: async () => 'ipfs://metadata',
    creatorOf: async () => 'artist',
  };
  const options = { contract, tokenId: 12, storage, cacheKey: '8453:contract', now: 1000,
    fetchMetadata: async () => ({ name: 'Song', audioUrl: 'ipfs://audio' }) };
  const first = await loadMintedToken(options);
  assert.deepEqual(await loadMintedToken({ ...options, now: 2000 }), first);
  assert.equal(reads, 1);
  assert.equal(first.metadataUri, 'ipfs://metadata');
  assert.deepEqual(readCachedMintedTokens(options), [first]);
  assert.deepEqual(readCachedMintedTokens({ ...options, cacheKey: '8453:other' }), []);
  await loadMintedToken({ ...options, now: 3601001 });
  assert.equal(reads, 2);
});

test('archive loading survives corrupted or unavailable browser storage', async () => {
  const { loadMintedToken, readCachedMintedTokens } = await import(loaderUrl);
  const storage = { getItem: () => { throw new Error('disabled'); }, setItem: () => { throw new Error('quota'); } };
  assert.deepEqual(readCachedMintedTokens({ cacheKey: 'contract', storage }), []);
  const nft = await loadMintedToken({ tokenId: 4, cacheKey: 'contract', storage,
    contract: { totalMinted: async () => 1n, uri: async () => 'ipfs://meta', creatorOf: async () => '' },
    fetchMetadata: async () => ({ name: 'Song' }) });
  assert.equal(nft.name, 'Song');
});

test('archive retries transient RPC errors instead of silently dropping a track', async () => {
  const { loadMintedToken } = await import(loaderUrl);
  let calls = 0;
  const nft = await loadMintedToken({ tokenId: 12,
    contract: {
      totalMinted: async () => { if (++calls === 1) throw new Error('over rate limit'); return 1n; },
      uri: async () => 'ipfs://metadata', creatorOf: async () => 'artist',
    }, fetchMetadata: async () => ({ name: 'Song' }) });
  assert.equal(calls, 2);
  assert.equal(nft.name, 'Song');
});

test('NFT details open an accessible dialog with artwork and escaped metadata without another audio player', () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/nft-card.js'), 'utf8')
    .replace(/^import .*;$/gm, '').replace(/export /g, '');
  const classes = new Set(['hidden']);
  const panel = {
    open: false,
    classList: { remove: (name) => classes.delete(name), add: (name) => classes.add(name) },
    showModal() { this.open = true; },
    close() { this.open = false; this.onclose(); },
  };
  const content = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  const close = {};
  const elements = { 'nft-panel': panel, 'nft-panel-content': content, 'nft-panel-close': close };
  const context = vm.createContext({
    document: { getElementById: (id) => elements[id] },
    window: { DecentConfig: { chainName: 'Base Mainnet', contractAddress: '0xcontract' } }, URL,
  });
  vm.runInContext(source, context);
  context.renderNFTCard({ tokenId: 12, contractAddress: '0xsecondcollection', name: '<script>bad</script>', image: 'ipfs://artwork',
    audioUrl: 'ipfs://audio', metadataUri: 'ipfs://metadata', artist: '0xartist', description: '<b>description</b>' });
  assert.equal(panel.open, true);
  assert.equal(classes.has('hidden'), false);
  assert.match(content.innerHTML, /nft-detail-image/);
  assert.match(content.innerHTML, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.match(content.innerHTML, /ipfs:\/\/metadata/);
  assert.match(content.innerHTML, /Base Mainnet/);
  assert.match(content.innerHTML, /token\/0xsecondcollection\?a=12/);
  assert.doesNotMatch(content.innerHTML, /token\/0xcontract\?/);
  assert.doesNotMatch(content.innerHTML, /<audio/);
  close.onclick();
  assert.equal(panel.open, false);
  assert.equal(classes.has('hidden'), true);
});

test('artist filtering hides other artists in both the 3D scene and archive', () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/space.js'), 'utf8')
    .replace(/^import .*;$/gm, '').replace(/export /g, '');
  const first = { tokenId: 1, artist: '0xArtistA', description: 'Shared through DecentJukebox by Alice' };
  const second = { tokenId: 2, artist: '0xArtistB', description: 'Shared through DecentJukebox by Bob' };
  const rows = { 1: {}, 2: {} };
  const summary = {};
  const entries = [first, second].map((nft) => ({ nft, mesh: { userData: { nft, ageDays: 0 } } }));
  const context = vm.createContext({
    entries,
    document: {
      querySelector: (selector) => rows[selector.match(/data-token-id="(\d+)"/)?.[1]],
      getElementById: (id) => id === 'artist-filter-count' ? summary : null,
    },
  });
  vm.runInContext(`${source}\n_allNFTs = entries; _activeArtist = '0xartista'; _updateVisibility();`, context);
  assert.equal(entries[0].mesh.visible, true);
  assert.equal(entries[1].mesh.visible, false);
  assert.equal(rows[1].hidden, false);
  assert.equal(rows[2].hidden, true);
  assert.equal(summary.textContent, '1 track');
  assert.match(context._artistLabel(first), /^Alice/);
  vm.runInContext("_activeArtist = ''; _updateVisibility();", context);
  assert.equal(rows[2].hidden, false);
  assert.equal(entries[1].mesh.visible, true);
  assert.notEqual(context._nftSpreadSeed({ tokenId: 0, contractAddress: `0x${'1'.repeat(40)}` }),
    context._nftSpreadSeed({ tokenId: 0, contractAddress: `0x${'2'.repeat(40)}` }));
  assert.equal(context._nftSpreadSeed({ tokenId: 12, contractAddress: '0xe63EC9f8228720bAAC2fD528C0A6d06B3Dc5439B' }), 12);
});

test('coin face clips translucent artwork to a circle and draws song, artist, and mint date', () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/space.js'), 'utf8')
    .replace(/^import .*;$/gm, '').replace(/export /g, '');
  const labels = [];
  const arcs = [];
  const imageOpacities = [];
  const drawing = {
    globalAlpha: 1, clearRect() {}, save() {}, restore() {}, beginPath() {}, clip() {}, fillRect() {}, stroke() {},
    arc(...args) { arcs.push(args); },
    measureText: (text) => ({ width: text.length * 12 }),
    fillText(text) { labels.push(text); },
    drawImage() { imageOpacities.push(this.globalAlpha); },
  };
  const canvas = { getContext: () => drawing };
  class Image {
    constructor() { this.width = 512; this.height = 512; }
    set src(value) { this.onload(); }
  }
  const context = vm.createContext({ document: { createElement: () => canvas }, window: { DecentConfig: {} }, Image,
    buildIpfsGatewayUrls: () => ['https://gateway.example/ipfs/image'],
    THREE: { CanvasTexture: class { constructor(image) { this.image = image; } } } });
  vm.runInContext(source, context);
  context._makeNFTTexture({ tokenId: 12, name: 'Coin Song', artist: '0xartist',
    description: 'Shared through DecentJukebox by Alice', image: 'ipfs://image', mintedAt: '2026-10-03T00:00:00Z' });
  assert.equal(canvas.width, 512);
  assert.equal(canvas.height, 512);
  assert.ok(arcs.some((args) => args[0] === 256 && args[1] === 256 && args[2] === 246));
  assert.deepEqual(imageOpacities, [.55]);
  assert.ok(labels.includes('Coin Song'));
  assert.ok(labels.includes('Alice'));
  assert.ok(labels.includes(new Date('2026-10-03T00:00:00Z').toLocaleDateString()));
});