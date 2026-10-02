const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const gatewayUrl = pathToFileURL(path.join(__dirname, '..', 'js', 'ipfs-gateway.js')).href;
const loaderUrl = pathToFileURL(path.join(__dirname, '..', 'js', 'nft-loader.js')).href;

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