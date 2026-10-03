const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'mint-sync.js')).href;

test('extracts the audio CID from DecentNFT metadata', async () => {
  const { audioCidFromMetadata } = await import(moduleUrl);
  assert.equal(audioCidFromMetadata({ animation_url: 'ipfs://bafy-audio' }), 'bafy-audio');
  assert.equal(audioCidFromMetadata({ audioUrl: 'https://gateway.pinata.cloud/ipfs/bafy-http' }), 'bafy-http');
  assert.equal(audioCidFromMetadata({ name: 'Achievement' }), null);
});

test('marks tracks minted from Base so lost state cannot re-queue an existing NFT', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decent-mint-sync-'));
  process.env.JUKELOOP_PLAYLIST_PATH = path.join(tempDir, 'playlist.json');
  t.after(() => {
    delete process.env.JUKELOOP_PLAYLIST_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const storeUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'playlist-store.js'));
  storeUrl.searchParams.set('mint-sync-test', String(Date.now()));
  const store = await import(storeUrl.href);
  store.loadPlaylist([
    { trackId: 'flowers', ipfsCid: 'bafy-flowers', mintStatus: 'requested', addedAt: '2026-10-01T00:00:00Z' },
    { trackId: 'party', ipfsCid: 'bafy-party', mintStatus: 'minted', tokenId: '8', addedAt: '2026-10-01T00:00:00Z' },
    { trackId: 'fresh', ipfsCid: 'bafy-fresh', mintStatus: 'unminted', addedAt: '2026-10-01T00:00:00Z' },
  ]);

  const supply = { 0: 0, 4: 1, 5: 1, 8: 1 };
  const metadata = {
    'ipfs://meta-0': { name: 'Unminted achievement' },
    'ipfs://meta-4': { animation_url: 'ipfs://bafy-flowers' },
    'ipfs://meta-5': { animation_url: 'ipfs://bafy-flowers' },
    'ipfs://meta-8': { audioUrl: 'ipfs://bafy-party' },
  };
  const contract = {
    nextTokenId: async () => 9n,
    totalMinted: async (tokenId) => BigInt(supply[tokenId] || 0),
    uri: async (tokenId) => `ipfs://meta-${tokenId}`,
  };
  const fetchImpl = async (url) => {
    const key = `ipfs://${url.split('/ipfs/')[1]}`;
    return metadata[key] ? new Response(JSON.stringify(metadata[key])) : new Response('', { status: 404 });
  };
  const { syncMintedTracksFromChain } = await import(moduleUrl);

  const changed = await syncMintedTracksFromChain({ contract, fetchImpl, store, log: { log() {} }, pauseMs: 0 });
  assert.equal(changed, 1);
  assert.deepEqual(store.getPlaylist().map((track) => [track.trackId, track.mintStatus, track.tokenId ?? null]), [
    ['flowers', 'minted', '4'],
    ['party', 'minted', '8'],
    ['fresh', 'unminted', null],
  ]);
  assert.equal(store.getMintRequests().length, 0);
});
