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
