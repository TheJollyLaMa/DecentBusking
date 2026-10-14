const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const vm = require('node:vm');

const gatewayUrl = pathToFileURL(path.join(__dirname, '..', 'js', 'ipfs-gateway.js')).href;
const loaderUrl = pathToFileURL(path.join(__dirname, '..', 'js', 'nft-loader.js')).href;

test('NFT identities and caches distinguish identical token IDs across collections', async () => {
  const { loadMintedToken, nftIdentity, configuredNftCollections, buildNftShareUrl, parseNftIdentitySearch } = await import(loaderUrl);
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
  const shareUrl = buildNftShareUrl({ chainId: 8453, contractAddress: oldAddress, tokenId: 9 }, 'https://busking.example/app/index.html?foo=bar');
  assert.equal(shareUrl, 'https://busking.example/app/index.html?chainId=8453&contract=0x1111111111111111111111111111111111111111&tokenId=9');
  assert.deepEqual(parseNftIdentitySearch(new URL(shareUrl).search), {
    chainId: 8453,
    contractAddress: oldAddress,
    tokenId: 9,
  });
  assert.throws(() => parseNftIdentitySearch('?chainId=8453&contract=bad&tokenId=9'));
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

test('NFT details open an accessible dialog with artwork and escaped metadata without another audio player', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/nft-card.js'), 'utf8')
    .replace(/^import .*;$/gm, '').replace(/export /g, '');
  const { buildNftShareUrl } = await import(loaderUrl);
  const classes = new Set(['hidden']);
  const events = [];
  const shareCalls = [];
  const copiedLinks = [];
  const listeners = new Map();
  const contractAddress = `0x${'2'.repeat(40)}`;
  const makeButton = () => ({
    textContent: '',
    title: '',
    attributes: {},
    listeners: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name]; },
    addEventListener(type, handler) { this.listeners[type] = handler; },
  });
  const previewBtn = makeButton();
  const listenBtn = makeButton();
  const muteBtn = makeButton();
  const playlistBtn = makeButton();
  const shareBtn = makeButton();
  const listenStatus = { textContent: '' };
  const shareStatus = { innerHTML: '', textContent: '', querySelector: () => null };
  const panel = {
    open: false,
    classList: { remove: (name) => classes.delete(name), add: (name) => classes.add(name) },
    showModal() { this.open = true; },
    close() { this.open = false; this.onclose(); },
  };
  const content = {
    innerHTML: '',
    querySelector(selector) {
      if (selector === '.nft-preview-btn') return previewBtn;
      if (selector === '.nft-listen-btn') return listenBtn;
      if (selector === '.nft-mute-btn') return muteBtn;
      if (selector === '.nft-playlist-btn') return playlistBtn;
      if (selector === '.nft-share-btn') return shareBtn;
      if (selector === '.nft-listen-status') return listenStatus;
      if (selector === '.nft-share-status') return shareStatus;
      return null;
    },
    querySelectorAll: () => [],
  };
  const close = {};
  const elements = { 'nft-panel': panel, 'nft-panel-content': content, 'nft-panel-close': close };
  const context = vm.createContext({
    returnToRadio: () => { events.push('returnToRadio'); },
    document: {
      getElementById: (id) => elements[id],
      addEventListener: (type, handler) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(handler);
      },
      dispatchEvent: (event) => {
        events.push(event.type);
        for (const handler of listeners.get(event.type) || []) handler(event);
        return !event.defaultPrevented;
      },
    },
    window: { DecentConfig: { chainName: 'Base Mainnet', contractAddress: '0xcontract' },
      location: { href: 'https://busking.example/app/?foo=bar' } },
    URL,
    buildNftShareUrl,
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) { this.type = type; this.detail = init.detail; this.cancelable = Boolean(init.cancelable); this.defaultPrevented = false; }
      preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
    },
    navigator: {
      canShare: () => true,
      share: async (payload) => { shareCalls.push(payload); },
      clipboard: { writeText: async (value) => copiedLinks.push(value) },
    },
  });
  vm.runInContext(source, context);
  context.renderNFTCard({ tokenId: 12, contractAddress, name: '<script>bad</script>', image: 'ipfs://artwork',
    audioUrl: 'ipfs://audio', metadataUri: 'ipfs://metadata', artist: '0xartist', description: '<b>description</b>' });
  assert.equal(panel.open, true);
  assert.equal(classes.has('hidden'), false);
  assert.match(content.innerHTML, /nft-detail-image/);
  assert.match(content.innerHTML, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.match(content.innerHTML, /ipfs:\/\/metadata/);
  assert.match(content.innerHTML, /Base Mainnet/);
  assert.match(content.innerHTML, new RegExp(`token\\/${contractAddress}\\?a=12`));
  assert.doesNotMatch(content.innerHTML, /token\/0xcontract\?/);
  assert.doesNotMatch(content.innerHTML, /<audio/);
  assert.match(content.innerHTML, /▶ Preview/);
  assert.match(content.innerHTML, /🎧 Listen \(0\.25 USDC\)/);
  assert.match(content.innerHTML, /Share/);
  assert.equal(events.includes('dbusk-listen'), false);
  await shareBtn.listeners.click();
  assert.equal(shareCalls[0].title, '<script>bad</script>');
  assert.equal(shareCalls[0].text, '<script>bad</script> by 0xartist');
  assert.equal(shareCalls[0].url, `https://busking.example/app/?chainId=8453&contract=${contractAddress}&tokenId=12`);
  assert.equal(shareStatus.textContent, 'Shared.');
  context.navigator.share = undefined;
  await shareBtn.listeners.click();
  assert.equal(copiedLinks[0], `https://busking.example/app/?chainId=8453&contract=${contractAddress}&tokenId=12`);
  assert.equal(shareStatus.textContent, 'Link copied.');
  previewBtn.listeners.click();
  assert.equal(events.at(-1), 'dbusk-listen');
  context.document.dispatchEvent(new context.CustomEvent('dbusk-listen-started', {
    detail: { mode: 'preview', song: { audioUrl: 'ipfs://audio' } },
  }));
  assert.equal(previewBtn.textContent, '⏹ Stop preview');
  context.document.dispatchEvent(new context.CustomEvent('dbusk-preview-ended', {
    cancelable: true,
    detail: { song: { audioUrl: 'ipfs://audio' } },
  }));
  assert.equal(events.includes('returnToRadio'), true);
  assert.equal(previewBtn.textContent, '▶ Preview');
  close.onclick();
  assert.equal(panel.open, false);
  assert.equal(classes.has('hidden'), true);
});

test('artist filtering hides other artists in both the 3D scene and archive', async () => {
  const { nftArtistKey } = await import(loaderUrl);
  const source = fs.readFileSync(path.join(__dirname, '../js/space.js'), 'utf8')
    .replace(/^import .*;$/gm, '').replace(/export /g, '');
  const first = { tokenId: 1, artist: '0xArtistA', description: 'Shared through DecentJukebox by Alice' };
  const second = { tokenId: 2, artist: '0xArtistB', description: 'Shared through DecentJukebox by Bob' };
  const rows = { 1: {}, 2: {} };
  const summary = {};
  const entries = [first, second].map((nft) => ({ nft, mesh: { userData: { nft, ageDays: 0 } } }));
  const context = vm.createContext({
    entries,
    nftArtistKey,
    document: {
      querySelector: (selector) => rows[selector.match(/data-token-id="(\d+)"/)?.[1]],
      getElementById: (id) => id === 'artist-filter-count' ? summary : null,
    },
  });

  test('indexed archive returns latest 25 only, searches older titles and artists, and pages artist collections', async () => {
    const { nftCatalogPage } = await import(loaderUrl);
    const address = `0x${'1'.repeat(40)}`;
    const nfts = Array.from({ length: 60 }, (_, tokenId) => ({ tokenId, contractAddress: address, chainId: 8453,
      name: tokenId === 0 ? 'Forgotten Song' : `Song ${tokenId}`, artist: tokenId < 30 ? 'Alice' : 'Bob',
      mintedAt: new Date(Date.UTC(2026, 9, 1, 0, tokenId)).toISOString(), audioUrl: `ipfs://audio-${tokenId}` }));
    const first = nftCatalogPage(nfts);
    assert.equal(first.nfts.length, 25);
    assert.equal(first.nfts[0].tokenId, 59);
    assert.equal(first.nfts[24].tokenId, 35);
    assert.equal(first.nextOffset, 25);
    assert.equal(first.total, 60);
    assert.deepEqual(nftCatalogPage(nfts, { query: 'forgotten alice' }).nfts.map(nft => nft.tokenId), [0]);
    const artist = nftCatalogPage(nfts, { artist: 'alice' });
    assert.equal(artist.total, 30);
    assert.equal(artist.nfts.length, 25);
    assert.equal(nftCatalogPage(nfts, { artist: 'alice', offset: artist.nextOffset }).nfts.length, 5);
    assert.equal(nftCatalogPage(nfts, { artist: 'alice', offset: 25 }).nextOffset, null);
    assert.equal(nftCatalogPage(nfts, { after: nfts[10].mintedAt, before: nfts[15].mintedAt }).total, 5);
    for (const page of [{ limit: 26 }, { limit: 0 }, { offset: -1 }, { offset: 0.5 }, { after: 'invalid' }]) {
      assert.throws(() => nftCatalogPage(nfts, page));
    }
  });

  test('browser archive validates collection identity, page bounds and service errors', async () => {
    const { nftCatalogPage, fetchNftCatalogPage } = await import(loaderUrl);
    const address = `0x${'2'.repeat(40)}`;
    const config = { contractAddress: address, chainId: 8453, ipfsUploadServiceUrl: 'https://worker.example' };
    const page = nftCatalogPage([{ tokenId: 1, contractAddress: address, chainId: 8453, name: 'Song', audioUrl: 'ipfs://audio' }]);
    const options = { config, fetchImpl: async url => {
      assert.equal(new URL(url).searchParams.get('limit'), '25');
      return new Response(JSON.stringify(page));
    } };
    assert.equal((await fetchNftCatalogPage(options)).nfts.length, 1);
    await assert.rejects(fetchNftCatalogPage({ ...options, fetchImpl: async () =>
      new Response(JSON.stringify({ error: 'Catalog restoring' }), { status: 503 }) }), /Catalog restoring/);
    await assert.rejects(fetchNftCatalogPage({ ...options, fetchImpl: async () =>
      new Response(JSON.stringify({ ...page, nfts: Array(26).fill(page.nfts[0]) })) }), /Invalid NFT catalog page/);
    await assert.rejects(fetchNftCatalogPage({ ...options, config: { ...config, contractAddress: `0x${'3'.repeat(40)}` } }), /Invalid catalog NFT/);
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