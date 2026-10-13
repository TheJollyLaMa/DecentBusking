const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'mint-sync.js')).href;

test('metadata retries transient gateway failures and falls back for HTTP IPFS URLs', async () => {
  const { fetchMintMetadata } = await import(moduleUrl);
  let requests = 0;
  const delays = [];
  const metadata = await fetchMintMetadata('ipfs://retry-metadata', async () => {
    requests++;
    return requests <= 3 ? new Response('', { status: 429 }) : new Response(JSON.stringify({ audioUrl: 'ipfs://song' }));
  }, { wait: async delay => delays.push(delay) });
  assert.equal(metadata.audioUrl, 'ipfs://song');
  assert.deepEqual(delays, [1000]);
  const urls = [];
  assert.deepEqual(await fetchMintMetadata('https://unavailable.example/ipfs/metadata', async url => {
    urls.push(url);
    return url.includes('unavailable.example') ? new Response('', { status: 503 }) : new Response(JSON.stringify({ name: 'Recovered' }));
  }), { name: 'Recovered' });
  assert.equal(urls[1], 'https://ipfs.orbitor.dev/ipfs/metadata');
  await assert.rejects(fetchMintMetadata('ipfs://missing', async () => new Response('', { status: 404 })),
    /ipfs:\/\/missing.*404.*duplicate mints/);
  let bestEffortCalls = 0;
  await assert.rejects(fetchMintMetadata('ipfs://best-effort', async () => { bestEffortCalls++; return new Response('', { status: 503 }); },
    { attempts: 1 }), /ipfs:\/\/best-effort/);
  assert.equal(bestEffortCalls, 3);
});

test('discovers the account dedicated Pinata gateway without exposing the JWT to content requests', async () => {
  const { discoverPinataMetadataGateway } = await import(moduleUrl);
  let request;
  const gateway = await discoverPinataMetadataGateway({ pinataJwt: 'secret-jwt', fetchImpl: async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ data: { rows: [{ domain: 'account-gateway' }] } }));
  } });
  assert.equal(gateway, 'https://account-gateway.mypinata.cloud/ipfs/');
  assert.equal(request.url, 'https://api.pinata.cloud/v3/gateways?pageSize=1');
  assert.equal(request.options.headers.Authorization, 'Bearer secret-jwt');

  const gatedGateway = await discoverPinataMetadataGateway({ pinataJwt: 'secret-jwt', fetchImpl: async (url, options) => {
    if (url.endsWith('pageSize=1')) {
      return new Response(JSON.stringify({ data: { rows: [{ id: 'gate-id', domain: 'account-gateway' }] } }));
    }
    return new Response(JSON.stringify({ data: { settings: { restriction_policies: { accessTokens: [{ value: 'test-token' }] } } } }));
  } });
  assert.equal(gatedGateway, 'https://account-gateway.mypinata.cloud/ipfs/?pinataGatewayToken=test-token');

  await assert.rejects(discoverPinataMetadataGateway({ pinataJwt: 'secret-jwt',
    fetchImpl: async () => new Response('{}') }), /no valid domain/);
});

test('on-chain ad library recovers wallet-owned DecentAdvert NFTs from legacy metadata', async () => {
  const { readOwnedDevertAds } = await import(moduleUrl);
  const owner = `0x${'1'.repeat(40)}`;
  const mediaCid = 'bafybeidbdge6db6zq2pulyi34tk4pra6zl7hiccwfts4zie5mg7rcqczxq';
  const collection = { contractAddress: `0x${'2'.repeat(40)}`, contract: {
    nextTokenId: async () => 3n,
    balanceOf: async (address, tokenId) => address === owner && tokenId === 1 ? 1n : 0n,
    uri: async tokenId => `ipfs://metadata-${tokenId}`,
  } };
  const result = await readOwnedDevertAds({ collections: [collection], address: owner, pauseMs: 0,
    metadataReader: async () => ({ name: 'DecentAdvert0001', videoUrl: `ipfs://${mediaCid}`, mediaType: 'video/mp4' }),
    log: { warn() {} } });
  const ads = result.ads;
  assert.equal(ads.length, 1);
  assert.equal(result.metadataUnavailable, 0);
  assert.equal(ads[0].tokenId, '1');
  assert.equal(ads[0].state, 'ready');
  assert.equal(ads[0].ipfsCid, mediaCid);
  assert.equal(ads[0].mediaType, 'video/mp4');
});

test('wallet ad recovery checks newest owned tokens first', async () => {
  const { readOwnedDevertAds } = await import(moduleUrl);
  const owner = `0x${'1'.repeat(40)}`;
  const checked = [];
  const collection = { contractAddress: `0x${'2'.repeat(40)}`, contract: {
    nextTokenId: async () => 3n,
    balanceOf: async () => 1n,
    uri: async tokenId => { checked.push(Number(tokenId)); return `ipfs://metadata-${tokenId}`; },
  } };
  await readOwnedDevertAds({ collections: [collection], address: owner, pauseMs: 0,
    metadataReader: async () => ({ name: 'Song', audioUrl: 'ipfs://song' }), log: { warn() {} } });
  assert.deepEqual(checked, [2, 1, 0]);
});

test('wallet ad recovery checks ownership concurrently and reports failed checks', async () => {
  const { readOwnedDevertAds } = await import(moduleUrl);
  const owner = `0x${'1'.repeat(40)}`;
  let activeChecks = 0;
  let peakChecks = 0;
  const collection = { contractAddress: `0x${'2'.repeat(40)}`, contract: {
    nextTokenId: async () => 8n,
    balanceOf: async (_address, tokenId) => {
      activeChecks++;
      peakChecks = Math.max(peakChecks, activeChecks);
      await new Promise(resolve => setTimeout(resolve, 2));
      activeChecks--;
      if (tokenId === 3) throw new Error('temporary RPC failure');
      return 0n;
    },
  } };
  const result = await readOwnedDevertAds({ collections: [collection], address: owner, pauseMs: 0,
    ownershipConcurrency: 4, retry: { attempts: 1 }, log: { warn() {} } });
  assert.ok(peakChecks > 1);
  assert.equal(result.ownershipUnavailable, 1);
  assert.equal(result.metadataUnavailable, 0);
});

test('wallet ad recovery uses a batched ownership reader', async () => {
  const { readOwnedDevertAds } = await import(moduleUrl);
  const owner = `0x${'1'.repeat(40)}`;
  const batches = [];
  const progress = [];
  const collection = { contractAddress: `0x${'2'.repeat(40)}`, contract: {
    nextTokenId: async () => 3n,
    uri: async tokenId => `ipfs://metadata-${tokenId}`,
  } };
  const result = await readOwnedDevertAds({ collections: [collection], address: owner, pauseMs: 0,
    ownershipConcurrency: 2,
    ownershipReader: async (_collection, address, tokenIds) => {
      assert.equal(address, owner);
      batches.push(tokenIds);
      return tokenIds.map(tokenId => ({ balance: tokenId === 2 ? 1n : 0n }));
    },
    metadataReader: async () => ({ name: 'DecentAdvert', audioUrl: 'ipfs://devert-ad-cid' }),
    onProgress: result => progress.push(result.ads.map(ad => ad.tokenId)),
    log: { warn() {} },
  });
  assert.deepEqual(batches, [[2, 1], [0]]);
  assert.deepEqual(progress, [['2'], ['2']]);
  assert.equal(result.ads[0].tokenId, '2');
  assert.equal(result.ownershipUnavailable, 0);
});

test('wallet ad recovery reports metadata gaps instead of treating the library as empty', async () => {
  const { readOwnedDevertAds } = await import(moduleUrl);
  const owner = `0x${'1'.repeat(40)}`;
  const collection = { contractAddress: `0x${'2'.repeat(40)}`, contract: {
    nextTokenId: async () => 1n, balanceOf: async () => 1n, uri: async () => 'ipfs://unavailable',
  } };
  const result = await readOwnedDevertAds({ collections: [collection], address: owner, pauseMs: 0,
    metadataReader: async () => { throw new Error('gateway rate limit'); }, log: { warn() {} } });
  assert.deepEqual(result.ads, []);
  assert.equal(result.metadataUnavailable, 1);
});

test('extracts the audio CID from DecentNFT metadata', async () => {
  const { audioCidFromMetadata } = await import(moduleUrl);
  assert.equal(audioCidFromMetadata({ animation_url: 'ipfs://bafy-audio' }), 'bafy-audio');
  assert.equal(audioCidFromMetadata({ audioUrl: 'https://gateway.pinata.cloud/ipfs/bafy-http' }), 'bafy-http');
  assert.equal(audioCidFromMetadata({ name: 'Achievement' }), null);
  const root = 'bafybeidxx4rufx7xrn5lmt3npyaej6doupxajyh53ibb4fp43whdvgfm2u';
  assert.equal(audioCidFromMetadata({ audioUrl: `ipfs://${root}/one.mp3` }), `${root}/one.mp3`);
  assert.equal(audioCidFromMetadata({ audioUrl: `https://ipfs.io/ipfs/${root}/two.mp3?download=1` }), `${root}/two.mp3`);
  assert.notEqual(audioCidFromMetadata({ audioUrl: `ipfs://${root}/one.mp3` }),
    audioCidFromMetadata({ audioUrl: `ipfs://${root}/two.mp3` }));
});

test('mint completion is idempotent for the same reconciled token and rejects a conflicting token', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decent-mint-idempotent-'));
  process.env.JUKELOOP_PLAYLIST_PATH = path.join(tempDir, 'playlist.json');
  t.after(() => { delete process.env.JUKELOOP_PLAYLIST_PATH; fs.rmSync(tempDir, { recursive: true, force: true }); });
  const url = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'playlist-store.js'));
  url.searchParams.set('mint-idempotent', String(Date.now()));
  const store = await import(url.href);
  store.loadPlaylist([{ trackId: 'ad-track', mintStatus: 'requested', ipfsCid: 'bafy-ad', mintRecipient: '0x1111111111111111111111111111111111111111' }]);
  const first = store.completeTrackMint('ad-track', { tokenId: '41', txHash: '0xfirst', contractAddress: '0x2222222222222222222222222222222222222222' });
  assert.equal(first.tokenId, '41');
  assert.equal(store.completeTrackMint('ad-track', { tokenId: '41', txHash: '0xfirst', contractAddress: '0x2222222222222222222222222222222222222222' }), first);
  assert.equal(store.completeTrackMint('ad-track', { tokenId: '42', txHash: '0xother', contractAddress: '0x2222222222222222222222222222222222222222' }), null);
});

test('multi-collection reconciliation preserves contract identity and waits for every scan', async () => {
  const { readMintedCollections, syncMintedTracksFromChain } = await import(moduleUrl);
  const oldAddress = `0x${'1'.repeat(40)}`;
  const newAddress = `0x${'2'.repeat(40)}`;
  const contract = suffix => ({ nextTokenId: async () => 1n, totalMinted: async () => 1n,
    uri: async () => `ipfs://meta-${suffix}` });
  const collections = [{ contractAddress: oldAddress, contract: contract('old') },
    { contractAddress: newAddress, contract: contract('new') }];
  const fetchImpl = async () => new Response(JSON.stringify({ audioUrl: 'ipfs://same-recording' }));
  const result = await readMintedCollections({ collections, fetchImpl, pauseMs: 0 });
  assert.equal(result.minted.get('same-recording'), '0');
  assert.deepEqual(result.tokenReferencesByAudioCid.get('same-recording'), [
    { chainId: 8453, contractAddress: oldAddress, tokenId: '0' },
    { chainId: 8453, contractAddress: newAddress, tokenId: '0' },
  ]);
  let applied = false;
  const broken = [...collections.slice(0, 1), { contractAddress: newAddress,
    contract: { ...contract('new'), uri: async () => 'ipfs://unavailable' } }];
  await assert.rejects(syncMintedTracksFromChain({ collections: broken, pauseMs: 0,
    fetchImpl: async url => url.includes('unavailable') ? new Response('', { status: 503 }) : fetchImpl(),
    store: { applyOnChainMints: () => { applied = true; } },
  }), /metadata could not be verified/);
  assert.equal(applied, false);
  await assert.rejects(readMintedCollections({ collections: [collections[0], collections[0]], pauseMs: 0, fetchImpl }),
    /duplicate NFT collection/);
});

test('collection cache retains verified tokens when a later cold batch fails', async () => {
  const { readMintedCollections } = await import(moduleUrl);
  const address = `0x${'2'.repeat(40)}`;
  const tokenCaches = new Map();
  const metadataReads = new Map();
  let failLast = true;
  const collection = { contractAddress: address, contract: {
    nextTokenId: async () => 4n,
    totalMinted: async () => 1n,
    uri: async tokenId => `ipfs://metadata-${tokenId}`,
  } };
  const fetchImpl = async url => {
    const tokenId = Number(url.split('-').pop());
    metadataReads.set(tokenId, (metadataReads.get(tokenId) || 0) + 1);
    if (tokenId === 3 && failLast) return new Response('', { status: 404 });
    return new Response(JSON.stringify({ audioUrl: `ipfs://audio-${tokenId}` }));
  };
  await assert.rejects(readMintedCollections({ collections: [collection], tokenCaches, fetchImpl,
    pauseMs: 0, metadataGateways: ['https://metadata.example/ipfs/'] }), /metadata-3/);
  assert.equal(tokenCaches.get(address).size, 3);
  failLast = false;
  const result = await readMintedCollections({ collections: [collection], tokenCaches, fetchImpl,
    pauseMs: 0, metadataGateways: ['https://metadata.example/ipfs/'] });
  assert.equal(result.nfts.length, 4);
  assert.deepEqual([...metadataReads.entries()], [[0, 1], [1, 1], [2, 1], [3, 2]]);
});

test('collection cache reloads metadata when a token URI changes after the cache TTL', async () => {
  const { readMintedCollections } = await import(moduleUrl);
  const address = `0x${'2'.repeat(40)}`;
  const tokenCaches = new Map();
  let now = 1_000;
  let metadataCid = 'metadata-old';
  let uriReads = 0;
  const collection = { contractAddress: address, contract: {
    nextTokenId: async () => 1n,
    totalMinted: async () => 1n,
    uri: async () => { uriReads++; return `ipfs://${metadataCid}`; },
  } };
  const fetchImpl = async url => new Response(JSON.stringify({
    audioUrl: 'ipfs://audio', image: url.includes('updated') ? 'ipfs://new-image' : '',
  }));
  const options = { collections: [collection], tokenCaches, fetchImpl, pauseMs: 0,
    metadataGateways: ['https://metadata.example/ipfs/'], metadataCacheMs: 300_000, now: () => now };
  const first = await readMintedCollections(options);
  assert.equal(first.nfts[0].image, '');
  metadataCid = 'metadata-updated';
  now += 299_999;
  const cached = await readMintedCollections(options);
  assert.equal(cached.nfts[0].image, '');
  assert.equal(uriReads, 1);
  now += 2;
  const refreshed = await readMintedCollections(options);
  assert.equal(refreshed.nfts[0].image, 'ipfs://new-image');
  assert.equal(uriReads, 2);
  assert.equal(Object.hasOwn(refreshed.nfts[0], '_metadataCheckedAt'), false);
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
    { trackId: 'video', ipfsCid: 'bafy-video', filename: 'performance.mp4', mintStatus: 'requested', addedAt: '2026-10-01T00:00:00Z' },
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
    ['video', 'requested', null],
  ]);
  assert.deepEqual(store.getMintRequests().map(track => track.trackId), ['video']);
});

test('CLI mint metadata matches the Admin panel format', async () => {
  const { buildTrackMetadata } = await import(pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'mint-queue.js')).href);
  const track = { title: '561 🐄 🐮 🐄', uploader: 'thejollylama', ipfsCid: 'bafy-audio', recipient: '0xabc' };
  assert.deepEqual(buildTrackMetadata(track, '0xowner', new Date('2026-10-03T00:00:00Z')), {
    name: '561 🐄 🐮 🐄',
    description: 'Shared through DecentJukebox by thejollylama',
    animation_url: 'ipfs://bafy-audio',
    audioUrl: 'ipfs://bafy-audio',
    artist: '0xabc',
    creator: '0xabc',
    tipWallet: '0xabc',
    registeredBy: '0xowner',
    mintedAt: '2026-10-03T00:00:00.000Z',
  });
  assert.equal(buildTrackMetadata({ ...track, artworkCid: 'bafy-art' }, '0xowner').image, 'ipfs://bafy-art');
  const video = buildTrackMetadata({ ...track, filename: 'performance.mp4', mediaType: 'video/mp4',
    tipWallet: '0xtip', parentTokenId: 12 }, '0xowner');
  assert.equal(video.videoUrl, 'ipfs://bafy-audio');
  assert.equal(video.mediaType, 'video/mp4');
  assert.equal(video.tipWallet, '0xtip');
  assert.deepEqual(video.royaltyChain, { parentTokenId: 12 });
});

test('unavailable minted metadata fails reconciliation instead of treating minted content as new', async () => {
  const { syncMintedTracksFromChain } = await import(moduleUrl);
  let applied = false;
  const contract = { nextTokenId: async () => 1n, totalMinted: async () => 1n, uri: async () => 'ipfs://unavailable' };
  await assert.rejects(syncMintedTracksFromChain({ contract, pauseMs: 0,
    fetchImpl: async () => new Response('', { status: 503 }),
    store: { applyOnChainMints: () => { applied = true; } },
  }), /metadata could not be verified/);
  assert.equal(applied, false);
});

test('reconciliation restores missing artist wallets, including already-minted tracks, without guessing from creator', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'decent-artist-restore-'));
  process.env.JUKELOOP_PLAYLIST_PATH = path.join(temp, 'playlist.json');
  t.after(() => { delete process.env.JUKELOOP_PLAYLIST_PATH; fs.rmSync(temp, { recursive: true, force: true }); });
  const url = pathToFileURL(path.join(__dirname, '../discord-bot/playlist-store.js'));
  url.searchParams.set('artist-restore', Date.now());
  const store = await import(url.href);
  const wallet = `0x${'1'.repeat(40)}`;
  const knownWallet = `0x${'2'.repeat(40)}`;
  store.loadPlaylist([
    { trackId: 'missing', ipfsCid: 'bafy-a', mintStatus: 'minted', tokenId: '0', plays: 12, likes: 3 },
    { trackId: 'known', ipfsCid: 'bafy-b', mintStatus: 'minted', tokenId: '1', mintRecipient: knownWallet },
    { trackId: 'admin-creator', ipfsCid: 'bafy-c', mintStatus: 'minted', tokenId: '2' },
  ]);
  const contract = { nextTokenId: async () => 3n, totalMinted: async () => 1n, uri: async tokenId => `ipfs://meta-${tokenId}` };
  const metadata = [{ audioUrl: 'ipfs://bafy-a', artist: wallet }, { audioUrl: 'ipfs://bafy-b', artist: wallet },
    { audioUrl: 'ipfs://bafy-c', creator: wallet }];
  const { syncMintedTracksFromChain } = await import(moduleUrl);
  const changed = await syncMintedTracksFromChain({ contract, store, pauseMs: 0, log: { log() {} },
    fetchImpl: async uri => new Response(JSON.stringify(metadata[Number(uri.split('meta-')[1])])) });
  assert.equal(changed, 1);
  const tracks = store.getPlaylist();
  assert.equal(tracks[0].mintRecipient, wallet);
  assert.equal(tracks[0].plays, 12);
  assert.equal(tracks[0].likes, 3);
  assert.equal(tracks[1].mintRecipient, knownWallet);
  assert.equal(tracks[2].mintRecipient, undefined);
});

test('private queue waits for reconciliation, shares in-flight work, and rejects stale state on failure', async () => {
  const { createVerifiedMintQueueReader } = await import(moduleUrl);
  let complete;
  let scans = 0;
  let queueReads = 0;
  const read = createVerifiedMintQueueReader({
    reconcile: () => { scans++; return new Promise(resolve => { complete = resolve; }); },
    getRequests: () => { queueReads++; return [{ trackId: 'video' }]; },
  });
  const first = read();
  const second = read();
  await Promise.resolve();
  assert.equal(scans, 1);
  assert.equal(queueReads, 0);
  complete();
  assert.deepEqual(await first, [{ trackId: 'video' }]);
  assert.deepEqual(await second, [{ trackId: 'video' }]);
  const failed = createVerifiedMintQueueReader({ reconcile: async () => { throw new Error('Base RPC unavailable'); },
    getRequests: () => { throw new Error('Must not expose unverified requests'); } });
  await assert.rejects(failed(), /Base RPC unavailable/);
});

test('CLI retries lagging mint estimates at the confirmed registration block without broadcasting', async () => {
  const { estimateRegisteredMint } = await import(pathToFileURL(path.join(__dirname, '../discord-bot/mint-queue.js')).href);
  let calls = 0;
  const contract = { mintProduct: { estimateGas: async (recipient, tokenId, amount, options) => {
    assert.equal(options.blockTag, 123);
    assert.equal(tokenId, '12');
    assert.equal(amount, 1);
    if (++calls === 1) throw new Error('DecentNFT: token not registered');
    return 100000n;
  } } };
  assert.equal(await estimateRegisteredMint({ contract, recipient: '0xartist', tokenId: '12', blockNumber: 123, delayMs: 0 }), 100000n);
  assert.equal(calls, 2);
});

test('CLI resumes only an unminted registration matching the queued audio, recipient, and owner', async () => {
  const { validateResumeToken } = await import(pathToFileURL(path.join(__dirname, '../discord-bot/mint-queue.js')).href);
  const contract = { totalMinted: async () => 0n, uri: async () => 'ipfs://metadata' };
  const track = { ipfsCid: 'bafy-audio', recipient: '0xartist' };
  const fetchImpl = async () => new Response(JSON.stringify({ audioUrl: 'ipfs://bafy-audio', artist: '0xartist', registeredBy: '0xowner' }));
  await validateResumeToken({ contract, tokenId: '12', track, owner: '0xowner', fetchImpl });
  await assert.rejects(validateResumeToken({ contract, tokenId: '12', track: { ...track, ipfsCid: 'different' }, owner: '0xowner', fetchImpl }), /does not match/);
  await assert.rejects(validateResumeToken({ contract: { ...contract, totalMinted: async () => 1n }, tokenId: '12', track, owner: '0xowner', fetchImpl }), /already minted/);
});

test('CLI resume checks recover from transient RPC errors before any mint', async () => {
  const { validateResumeToken } = await import(pathToFileURL(path.join(__dirname, '../discord-bot/mint-queue.js')).href);
  const calls = { totalMinted: 0, uri: 0 };
  const contract = {
    totalMinted: async () => {
      if (++calls.totalMinted === 1) throw new Error('missing revert data');
      return 0n;
    },
    uri: async () => {
      if (++calls.uri === 1) throw new Error('over rate limit');
      return 'ipfs://metadata';
    },
  };
  const options = {
    contract, tokenId: '12', track: { ipfsCid: 'bafy-audio', recipient: '0xartist' }, owner: '0xowner',
    retry: { baseDelayMs: 0 },
    fetchImpl: async () => new Response(JSON.stringify({ audioUrl: 'ipfs://bafy-audio', artist: '0xartist', registeredBy: '0xowner' })),
  };
  await validateResumeToken(options);
  assert.deepEqual(calls, { totalMinted: 2, uri: 2 });
  await assert.rejects(validateResumeToken({
    ...options,
    contract: { totalMinted: async () => { throw new Error('missing revert data'); } },
    retry: { attempts: 2, baseDelayMs: 0 },
  }), /Resume token #12: totalMinted lookup failed after retries.*No mint was sent/);
});
