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
