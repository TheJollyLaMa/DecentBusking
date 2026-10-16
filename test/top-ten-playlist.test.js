const test = require('node:test');
const assert = require('node:assert/strict');

test('chart plus resolves exact media and saves through the existing profile watchlist', async () => {
  const { addChartSongToPlaylist } = await import('../js/top-ten-playlist.mjs');
  const wallet = { address: 'connected', signer: {} };
  const nft = { tokenId: '12', audioUrl: 'ipfs://song' };
  let saved = null;
  const result = await addChartSongToPlaylist({ title: 'Song', artist: 'Artist', ipfsCid: 'song' }, {
    wallet,
    resolveNFT: async detail => { assert.equal(detail.audioUrl, 'ipfs://song'); assert.equal(detail.title, 'Song'); return nft; },
    save: async value => { saved = value; },
  });
  assert.equal(saved, nft);
  assert.equal(result, nft);
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
