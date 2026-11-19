const test = require('node:test');
const assert = require('node:assert/strict');
const { id, ZeroAddress, ZeroHash } = require('../discord-bot/node_modules/ethers');

const creator = '0x1111111111111111111111111111111111111111';
const contractAddress = '0x2222222222222222222222222222222222222222';
const ipfsCid = 'bafybeidjt2fmxyu5xoukcglzwnbshkrm5s5ykeqitdaewzhlcxzzyahjem';
const nft = { tokenId: 7, contractAddress, creator, mediaType: 'video/mp4', videoUrl: `ipfs://${ipfsCid}` };
const track = { trackId: 'radio', ipfsCid, mediaType: 'video/mp4', durationSeconds: 240,
  durationVerification: { seconds: 240, source: 'ffmpeg-decode', longForm: false,
    verifiedAt: '2026-01-01', mediaIdentity: `ipfs:${ipfsCid}` } };

test('raw minted metadata, the public catalog and paid playback resolve the same canonical ID', async () => {
  const { dmtvCatalogEntries } = await import('../discord-bot/dmtv-catalog.js');
  const { nftCatalogPage } = await import('../js/nft-loader.js');
  const [entry] = dmtvCatalogEntries({ nfts: [{ ...nft, nftId: 'metadata-spoof' }], playlist: [track] });
  const [publicNft] = nftCatalogPage([nft], { media: 'video' }).nfts;
  assert.equal(entry.videoId, id(publicNft.nftId));
  assert.equal(entry.mediaHash, id(publicNft.videoUrl));
  assert.equal(entry.radioTrack, track);
  assert.equal(dmtvCatalogEntries({ nfts: [nft], playlist: [] })[0].radioTrack, null);
  assert.equal(dmtvCatalogEntries({ nfts: [nft], playlist: [{ ...track, durationVerification: null }] })[0].radioTrack, null);
  for (const excluded of [{ isDevertAd: true }, { name: 'DecentAdvert0001' }, { contentReview: { scope: 'all-radio' } },
    { mediaType: 'audio/mpeg' }, { videoUrl: `https://example.test/ipfs/${ipfsCid}` }]) {
    assert.deepEqual(dmtvCatalogEntries({ nfts: [{ ...nft, ...excluded }], playlist: [] }), []);
  }
  assert.deepEqual(dmtvCatalogEntries({ nfts: [nft], playlist: [{ ...track, isDevertAd: true }] }), []);
});

test('registrar backfills, picks up a later video mint and adds radio without duplicate writes', async () => {
  const { dmtvCatalogEntries, createDmtvCatalogRegistrar } = await import('../discord-bot/dmtv-catalog.js');
  const configured = new Map();
  const sent = [];
  let now = 0;
  let nfts = [nft];
  let playlist = [];
  const run = createDmtvCatalogRegistrar({
    now: () => now,
    getEntries: () => dmtvCatalogEntries({ nfts, playlist }),
    contract: {
      videos: async key => configured.get(key) || { creator: ZeroAddress, mediaHash: ZeroHash, lanes: 0 },
      configureVideo: async (key, mediaHash, creator, lanes) => ({ wait: async confirmations => {
        assert.equal(confirmations, 2);
        sent.push([key, lanes]);
        configured.set(key, { creator, mediaHash, lanes });
        return { status: 1 };
      } }),
    },
    getCreator: async () => creator,
    resolveMediaUrl: async () => 'https://gateway.test/video',
    probe: async () => ({ radio: true, video: true }),
    log: { log() {}, warn() {} },
  });
  const initial = run();
  assert.equal(run(), initial);
  assert.equal(await initial, 1);
  assert.equal(await run(), 0);
  playlist = [track];
  nfts = [...nfts, { ...nft, tokenId: 8 }];
  assert.equal(await run(), 2);
  now += 360_000;
  assert.equal(await run(), 0);
  assert.deepEqual(sent[0], [id(`8453:${contractAddress}:7`), 1]);
  assert.deepEqual(new Map(sent.slice(1)), new Map([
    [id(`8453:${contractAddress}:7`), 3], [id(`8453:${contractAddress}:8`), 3],
  ]));
});

test('keeps disabled entries, rejects creator mismatches and never grants radio to incompatible media', async () => {
  const { dmtvCatalogEntries, createDmtvCatalogRegistrar } = await import('../discord-bot/dmtv-catalog.js');
  const entries = dmtvCatalogEntries({ nfts: [nft, { ...nft, tokenId: 8 }, { ...nft, tokenId: 9 }], playlist: [track] });
  const seen = [];
  const run = createDmtvCatalogRegistrar({
    getEntries: () => entries,
    contract: {
      videos: async key => key === entries[0].videoId
        ? { creator, mediaHash: entries[0].mediaHash, lanes: 0 }
        : { creator: ZeroAddress, mediaHash: ZeroHash, lanes: 0 },
      configureVideo: async (key, hash, wallet, lanes) => ({ wait: async () => {
        seen.push([key, lanes]);
        return { status: 1 };
      } }),
    },
    getCreator: async nft => nft.tokenId === 8 ? ZeroAddress : creator,
    resolveMediaUrl: async () => 'https://gateway.test/video',
    probe: async () => ({ radio: false, video: true }),
    log: { log() {}, warn() {} },
  });
  assert.equal(await run(), 1);
  assert.deepEqual(seen, [[entries[2].videoId, 1]]);
});
