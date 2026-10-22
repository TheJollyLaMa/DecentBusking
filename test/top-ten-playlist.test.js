const test = require('node:test');
const assert = require('node:assert/strict');

test('chart plus dispatches the verified song to the named-playlist draft, never the Watchlist', async () => {
  const { addChartSongToPlaylist } = await import('../js/top-ten-playlist.mjs');
  const wallet = { address: 'connected', signer: {} };
  const nft = { tokenId: '12', audioUrl: 'ipfs://song' };
  let dispatched = null;
  const originalDocument = global.document;
  const originalCustomEvent = global.CustomEvent;
  global.CustomEvent = class { constructor(type, options) { this.type = type; this.defaultPrevented = false; Object.assign(this, options); } preventDefault() { this.defaultPrevented = true; } };
  global.document = { dispatchEvent(value) { dispatched = value; value.preventDefault(); return !value.defaultPrevented; } };
  try {
    const result = await addChartSongToPlaylist({ title: 'Song', artist: 'Artist', ipfsCid: 'song' }, {
      wallet,
      resolveNFT: async detail => { assert.equal(detail.audioUrl, 'ipfs://song'); assert.equal(detail.title, 'Song'); return nft; },
    });
    assert.equal(dispatched.type, 'dbusk-playlist-add');
    assert.equal(dispatched.cancelable, true);
    assert.equal(dispatched.detail.nft, nft);
    assert.equal(result, nft);
  } finally {
    global.document = originalDocument;
    global.CustomEvent = originalCustomEvent;
  }
});

test('chart plus connects a wallet and reports missing media, unmatched NFTs and failed saves explicitly', async () => {
  const { addChartSongToPlaylist } = await import('../js/top-ten-playlist.mjs');
  const song = { title: 'Song', ipfsCid: 'song' };
  const wallet = { connect: async () => { wallet.address = 'connected'; wallet.signer = {}; } };
  await assert.rejects(addChartSongToPlaylist(song, { wallet, resolveNFT: async () => null }), /No verified NFT/);
  assert.equal(wallet.address, 'connected');
  await assert.rejects(addChartSongToPlaylist({}, { wallet }), /verified media/);
  await assert.rejects(addChartSongToPlaylist(song, { wallet: {} }), /Connect your wallet/);
  await assert.rejects(addChartSongToPlaylist(song, { wallet, resolveNFT: async () => ({}),
    save: async () => { throw new Error('Signature rejected'); } }), /Signature rejected/);
});

test('chart eyes saves the verified NFT to Watchlist once, independently of playlist additions', async () => {
  const { saveChartSongToWatchlist } = await import('../js/top-ten-playlist.mjs');
  const nft = { tokenId: '1', audioUrl: 'ipfs://song' };
  let saved = false, saves = 0;
  const options = { wallet: { address: 'connected', signer: {} }, resolveNFT: async () => nft,
    watchlist: async () => ({ isCreatorWatchlisted: item => { assert.equal(item, nft); return saved; },
      saveCreatorWatchlist: async item => { assert.equal(item, nft); saved = true; saves++; } }) };
  assert.equal(await saveChartSongToWatchlist({ ipfsCid: 'song' }, options), nft);
  await saveChartSongToWatchlist({ ipfsCid: 'song' }, options);
  assert.equal(saves, 1);
  await assert.rejects(saveChartSongToWatchlist({ ipfsCid: 'song' }, { ...options, resolveNFT: async () => null }), /No verified NFT/);
});

test('named selector appends ordered unique songs with a clear 24-song cap', async () => {
  const { appendPlaylistSong } = await import('../js/playlist-selector.mjs');
  const songs = Array.from({ length: 24 }, (_, index) => ({ songId: `0x${index.toString(16).padStart(64, '0')}` }));
  assert.deepEqual(appendPlaylistSong(songs.slice(0, 23), songs[23]), songs);
  assert.deepEqual(appendPlaylistSong(songs, songs[0]), songs);
  assert.throws(() => appendPlaylistSong(songs, { songId: 'another' }), /24 songs/);
});

test('selector exposes draft, saved destinations and inline new name without a prompt', async t => {
  const originals = { document: global.document, window: global.window };
  t.after(() => Object.assign(global, originals));
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.hidden = false; this.style = {}; this.value = ''; this.offsetHeight = 220; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    querySelector() { return this.children.find(node => node.tag === 'button'); }
    focus() { this.focused = true; }
    remove() { this.removed = true; }
  }
  global.document = { querySelector: () => null, createElement: tag => new Node(tag), body: new Node('body') };
  global.window = { innerWidth: 800, innerHeight: 600 };
  const { openPlaylistSelector } = await import('../js/playlist-selector.mjs');
  const chosen = [];
  const saved = { name: 'Night drive', songIds: ['a'] };
  const panel = openPlaylistSelector({ playlists: [saved], choose: async (...args) => chosen.push(args) });
  const button = label => panel.children.find(node => node.textContent === label);
  assert.equal(panel['aria-label'], 'Add song to playlist');
  await button('➕ New playlist…').listeners.click();
  assert.equal(panel.removed, undefined, 'inline name entry keeps the selector open');
  const input = panel.children.find(node => node.tag === 'input');
  assert.equal(input.hidden, false);
  input.value = 'My new list';
  await button('Create playlist').listeners.click();
  assert.deepEqual(chosen[0], [null, 'My new list']);
  await button('Night drive · 1/24').listeners.click();
  assert.deepEqual(chosen[1], [saved]);
  await button('Current draft').listeners.click();
  assert.deepEqual(chosen[2], [null]);
});
