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

test('split songs pay the contract-matching split wallet, fail closed without one and migrate the escrow payee', async () => {
  const ethers = require('../discord-bot/node_modules/ethers');
  const { dmtvCatalogEntries, createDmtvCatalogRegistrar } = await import('../discord-bot/dmtv-catalog.js');
  const { songSplitPayeeResolver } = await import('../js/song-split-wallet.mjs');
  // Vector from DecentSongSplitWalletFactory_v0_1.walletFor on a Hardhat deployment.
  const splitPayee = songSplitPayeeResolver({ factory: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    implementation: '0xa16E02E87b7454126E5E10d957A927A7F5B5d2be' }, ethers);
  const wallet = '0x5022047f4f0FC36D5339bd52C5bf1E6DACbac882';
  const creatorSplits = [{ wallet: '0x807061DF657A7697c04045dA7d16D941861cAABc', shareBps: 5000 },
    { wallet: '0xde21D925ee48fFAeD8939AE8B75dD6E82310f8Ea', shareBps: 5000 }];
  const playlist = [{ ...track, creatorSplits }];
  const [entry] = dmtvCatalogEntries({ nfts: [nft], playlist, splitPayee });
  assert.equal(entry.creator, wallet);
  assert.equal(entry.nft.djukeSongId, id('radio'));
  assert.deepEqual(entry.owners, creatorSplits);
  assert.equal(dmtvCatalogEntries({ nfts: [nft], playlist })[0].creator, '');

  const writes = [];
  const prepared = [];
  const run = createDmtvCatalogRegistrar({
    getEntries: () => [entry],
    contract: {
      videos: async () => ({ creator, mediaHash: entry.mediaHash, lanes: 3 }),
      configureVideo: async (...args) => ({ wait: async () => { writes.push(args); return { status: 1 }; } }),
    },
    getCreator: async () => wallet,
    preparePayee: async (_, payee) => prepared.push(payee),
    resolveMediaUrl: async () => assert.fail('configured lanes need no probe'),
    log: { log() {}, warn() {} },
  });
  assert.equal(await run(), 1);
  assert.deepEqual(prepared, [wallet]);
  assert.deepEqual(writes, [[entry.videoId, entry.mediaHash, wallet, 3]]);
});

test('split wallets distribute after settlement and retry when distribution fails', async () => {
  const { createSongSplitPayouts } = await import('../discord-bot/song-split-payouts.js');
  const wallet = '0x5022047f4f0FC36D5339bd52C5bf1E6DACbac882';
  const payouts = createSongSplitPayouts({ token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', signer: null,
    factory: { isWallet: async address => address === wallet }, djuke: {}, log: { log() {}, warn() {} } });
  await payouts.settled(creator);
  assert.deepEqual(payouts.pending(), []);
  await payouts.settled(wallet);
  assert.deepEqual(payouts.pending(), [wallet]);
});
