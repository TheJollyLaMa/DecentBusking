const test = require('node:test');
const assert = require('node:assert/strict');
const ethers = require('../discord-bot/node_modules/ethers');

test('DMTv joins the shared drawer group and does not steal focus when displaced', async t => {
  const { initDmtv } = await import('../js/dmtv.mjs');
  const original = { document: global.document, window: global.window };
  class Element extends EventTarget {
    attributes = {};
    classList = { toggle() {} };
    inert = true;
    pauses = 0;
    focused = false;
    setAttribute(name, value) { this.attributes[name] = value; }
    pause() { this.pauses++; }
    focus() { this.focused = true; }
  }
  const elements = new Map();
  const doc = new EventTarget();
  doc.body = new Element();
  doc.getElementById = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  global.document = doc;
  global.window = { DecentConfig: {} };
  const opened = [];
  doc.addEventListener('left-drawer-open', event => opened.push(event.detail));
  const cleanup = initDmtv();
  t.after(() => {
    try { cleanup(); }
    finally { Object.assign(global, original); }
  });
  const tab = elements.get('dmtv-tab');
  const panel = elements.get('dmtv-panel');
  const player = elements.get('dmtv-video-player');
  for (const neighbor of ['top-ten', 'djuke', 'devert']) {
    tab.dispatchEvent(new Event('click'));
    assert.equal(opened.at(-1), 'dmtv');
    assert.equal(tab.attributes['aria-expanded'], 'true');
    assert.equal(panel.inert, false);
    doc.dispatchEvent(new CustomEvent('left-drawer-open', { detail: neighbor }));
    assert.equal(tab.attributes['aria-expanded'], 'false');
    assert.equal(panel.inert, true);
    assert.equal(tab.focused, false);
  }
  assert.equal(player.pauses, 3);
  tab.dispatchEvent(new Event('click'));
  elements.get('dmtv-close').dispatchEvent(new Event('click'));
  assert.equal(tab.focused, true);
});

test('escrow worker restores completed evidence and does not settle interrupted playback', async () => {
  const { createDmtvEscrowRuntime } = await import('../discord-bot/dmtv-escrow.js');
  const creator = '0x1111111111111111111111111111111111111111';
  const track = { trackId: 'track', videoUrl: 'ipfs://example', creator };
  const request = { status: 1, refundAt: 2000, videoId: ethers.id('nft'), mediaHash: ethers.id(track.videoUrl), creator };
  let saved;
  let sends = 0;
  const make = () => createDmtvEscrowRuntime({
    reader: { paused: async () => false, head: async () => 0n, tail: async () => 1n, requests: async () => request,
      videos: async () => ({ ...request, lanes: 3 }) },
    writer: { fulfill: async (lane, requestId, proof) => {
      assert.deepEqual(saved.entries[0], { lane, requestId, proof });
      if (++sends === 1) throw new Error('RPC unavailable');
      return { wait: async () => { request.status = 2; return { status: 1 }; } };
    } },
    provider: { getBlockNumber: async () => 10, getBlock: async () => ({ timestamp: 1000 }) },
    store: { restore: async () => saved, save: async snapshot => { saved = snapshot; return true; } },
    resolveTrack: async () => track,
  }).forLane(1);
  const queue = make();
  const { record } = await queue.nextPaid();
  await queue.release(record);
  assert.equal(sends, 0);
  const retry = await queue.nextPaid();
  await assert.rejects(queue.complete(retry.record,
    { trackId: track.trackId, playId: 'clean', expectedMs: 2000, audibleMs: 2000, finished: true }), /RPC unavailable/);
  assert.equal(saved.entries.length, 1);
  assert.equal(await make().nextPaid(), null);
  assert.deepEqual(saved.entries, []);
  assert.equal(sends, 2);
});

test('terminal playback failure journals a refund and retries it after restart without settling', async () => {
  const { createDmtvEscrowRuntime } = await import('../discord-bot/dmtv-escrow.js');
  const track = { trackId: 'test', videoUrl: 'ipfs://test', creator: ethers.ZeroAddress };
  const request = { status: 1, refundAt: 2000, videoId: ethers.id('nft'), mediaHash: ethers.id(track.videoUrl), creator: track.creator };
  let saved, attempts = 0;
  const make = () => createDmtvEscrowRuntime({
    reader: { paused: async () => false, head: async () => 0n, tail: async () => 1n,
      requests: async () => request, videos: async () => ({ ...request, lanes: 3 }) },
    writer: {
      fulfill: async () => assert.fail('failed playback cannot settle'),
      cancelAndRefund: async (lane, requestId) => {
        assert.deepEqual(saved.entries[0], { lane, requestId, proof: ethers.ZeroHash });
        if (++attempts === 1) throw new Error('RPC unavailable');
        return { wait: async () => { request.status = 4; return { status: 1 }; } };
      },
    },
    provider: { getBlockNumber: async () => 10, getBlock: async () => ({ timestamp: 1000 }) },
    store: { restore: async () => saved, save: async snapshot => { saved = snapshot; return true; } },
    resolveTrack: async () => track,
  }).forLane(1);
  const queue = make();
  const { record } = await queue.nextPaid();
  await assert.rejects(queue.complete(record, {
    finished: true, trackId: track.trackId, playId: 'partial', expectedMs: 2000, audibleMs: 800,
  }), /RPC unavailable/);
  assert.equal(await make().nextPaid(), null);
  assert.equal(attempts, 2);
  assert.deepEqual(saved.entries, []);
});
test('escrow checkout rejects a changed video before any approval or payment', async () => {
  const { reserveDmtvVideo } = await import('../js/dmtv-escrow.mjs');
  const creator = '0x1111111111111111111111111111111111111111';
  await assert.rejects(reserveDmtvVideo({
    escrow: { paused: async () => false, quote: async () => 2_000_000n,
      videos: async () => ({ mediaHash: ethers.id('changed'), creator, lanes: 1 }) },
    usdc: { allowance: () => assert.fail('Checkout must refuse before accessing the allowance') },
    lane: 0, videoId: ethers.id('nft'), mediaHash: ethers.id('selected'), creator,
  }), /no longer available/);
});

test('shared station publishes real video segments before recording paid completion', { timeout: 20_000 }, async t => {
  const { spawnSync } = require('node:child_process');
  if (spawnSync('ffmpeg', ['-version']).error?.code === 'ENOENT') return t.skip('ffmpeg unavailable');
  const { createServer } = require('node:http');
  const { createDmtvStation } = await import('../discord-bot/dmtv-station.js');
  const { probeDmtvVideo } = await import('../discord-bot/dmtv-catalog.js');
  const { resolveStreamableIpfsUrl } = await import('../discord-bot/jukeloop.js');
  const video = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=160x90:r=24:d=6',
    '-c:v', 'libx264', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1']);
  assert.equal(video.status, 0, video.stderr.toString());
  const gateway = createServer((request, response) => {
    if (request.url !== '/ipfs/fixture?pinataGatewayToken=fixture-token') {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': video.stdout.length });
    response.end(video.stdout);
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  let published;
  let resolveCompletion;
  const completion = new Promise(resolve => { resolveCompletion = resolve; });
  const station = createDmtvStation({
     resolveMediaUrl: cid => resolveStreamableIpfsUrl(
       `http://127.0.0.1:${gateway.address().port}/ipfs?pinataGatewayToken=fixture-token`, cid),
    queue: { nextPaid: async () => ({ record: {}, track: { title: 'Fixture', videoUrl: 'ipfs://fixture' } }),
      release: async () => {}, completePublished: async (record, playId) => resolveCompletion(playId) },
    nextFree: async () => null,
  });
  try {
    assert.deepEqual(await probeDmtvVideo(
      `http://127.0.0.1:${gateway.address().port}/ipfs/fixture?pinataGatewayToken=fixture-token`),
    { video: true, radio: false });
    station.start();
    for (let i = 0; i < 50 && !published; i++) {
      await new Promise(resolve => setTimeout(resolve, 125));
      published = station.state().current;
    }
    assert.ok(published, 'worker should publish a current HLS stream');
    const manifest = (await station.media(published.playId, 'live.m3u8')).toString();
    const segment = manifest.match(/^live\d+\.ts$/m)?.[0];
    assert.ok(segment);
    assert.ok((await station.media(published.playId, segment)).length > 1000);
    const playbackId = await Promise.race([completion, new Promise(resolve => setTimeout(resolve, 5000, null).unref())]);
    assert.equal(playbackId, published.playId);
    assert.match((await station.media(playbackId, 'live.m3u8')).toString(), /#EXT-X-ENDLIST/);
  } finally {
    station.stop();
    await new Promise(resolve => gateway.close(resolve));
  }
});

const type = 'video/mp4';
const ad = { title: 'DVert', audioURI: 'ipfs://ad-cid', startedAt: '2026-01-01', expiresAt: '2026-02-01' };
const nfts = [
  { nftId: 'v', name: 'Visual', artistName: 'Artist', mediaType: type, animation_url: 'ipfs://video-cid' },
  { nftId: 'a', name: 'Audio', mediaType: 'audio/mp4', animation_url: 'ipfs://audio-cid' },
  { nftId: 'ad', name: 'Campaign copy', mediaType: type, animation_url: 'https://ipfs.io/ipfs/ad-cid' },
  { nftId: 'house', name: 'Subvertisement', mediaType: type, animation_url: 'ipfs://house-cid' },
  { nftId: 'unknown', name: 'Unknown', animation_url: 'ipfs://unknown-cid' },
];

test('only archive videos are selectable; matching active DVert videos are separate', async () => {
  const { dmtvArchiveItems, dmtvVideoAds } = await import('../js/dmtv.mjs');
  assert.deepEqual(dmtvArchiveItems(nfts, [ad]).map(x => [x.title, x.artist]), [['Visual', 'Artist']]);
  const now = Date.parse('2026-01-15');
  assert.deepEqual(dmtvVideoAds([ad, ad, { ...ad, audioURI: 'ipfs://audio-cid' }], nfts, now)
    .map(x => x.videoUrl), [ad.audioURI]);
  assert.deepEqual(dmtvVideoAds([ad, { ...ad, removed: true }], nfts, Date.parse('2026-02-01')), []);
});

test('rotation prioritizes paid spots but only inserts an ad after ten completed videos', async () => {
  const { createDmtvRotation } = await import('../js/dmtv.mjs');
  const rotation = createDmtvRotation();
  const archive = [{ nftId: 'a' }, { nftId: 'b' }];
  const paid = [{ nftId: 'paid', fundTx: 'hash' }];
  assert.equal(rotation.next(archive, paid, [ad]).nftId, 'paid');
  for (let i = 0; i < 10; i++) {
    const item = rotation.next(archive, [], [ad]);
    assert.equal(item.nftId, archive[i % 2].nftId);
    rotation.complete(item);
  }
  const advert = rotation.next(archive, paid, [ad]);
  assert.equal(advert.kind, 'ad');
  rotation.complete(advert);
  assert.equal(rotation.next(archive, paid, [ad]).nftId, 'paid');
  for (let i = 0; i < 10; i++) rotation.complete(rotation.next(archive, [], []));
  assert.equal(rotation.next(archive, [], []).kind, 'house-ad');
  assert.equal(rotation.next(archive, [], []).kind, 'video');
});

test('DMTv requires both an exact fund event and the actual USDC transfer', async () => {
  const { verifyDmtvFundReceipt } = await import('../js/dmtv.mjs');
  const { SETTLEMENT_ROUTER_ADDRESS: router } = await import('../js/fund-contribution.mjs');
  const { BASE_USDC_ADDRESS: token } = await import('../js/settlement-funds.mjs');
  const payer = '0x1111111111111111111111111111111111111111';
  const iface = new ethers.Interface([
    'event FundFunded(bytes32 indexed fundId,address indexed asset,address indexed funder,uint256 amount)',
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  ]);
  const funded = { address: router, ...iface.encodeEventLog('FundFunded', [ethers.id('dbusk-playback'), token, payer, 1000000n]) };
  const transfer = { address: token, ...iface.encodeEventLog('Transfer', [payer, router, 1000000n]) };
  assert.equal(verifyDmtvFundReceipt({ status: 1, logs: [funded, transfer] }, payer, ethers), 1000000n);
  for (const receipt of [
    { status: 1, logs: [funded] },
    { status: 1, logs: [transfer] },
    { status: 1, logs: [{ ...funded, address: payer }, transfer] },
    { status: 0, logs: [funded, transfer] },
  ]) assert.throws(() => verifyDmtvFundReceipt(receipt, payer, ethers));
});

test('main-radio checkout persists one wallet-authorized request across restarts', async () => {
  const { createDmtvRadioQueue } = await import('../discord-bot/dmtv-queue.js');
  const { dmtvRadioAuthorization } = await import('../js/dmtv-radio.mjs');
  const { SETTLEMENT_ROUTER_ADDRESS: router } = await import('../js/fund-contribution.mjs');
  const { BASE_USDC_ADDRESS: token } = await import('../js/settlement-funds.mjs');
  const wallet = ethers.Wallet.createRandom();
  const track = { nftId: 'nft', creator: ethers.Wallet.createRandom().address, ipfsCid: 'test-cid', title: 'Video' };
  const iface = new ethers.Interface([
    'event FundFunded(bytes32 indexed fundId,address indexed asset,address indexed funder,uint256 amount)',
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  ]);
  const creatorTx = ethers.id('creator');
  const fundTx = ethers.id('fund');
  const creatorReceipt = { status: 1, blockNumber: 11, from: wallet.address, to: token, logs: [
    { address: token, ...iface.encodeEventLog('Transfer', [wallet.address, track.creator, 1000000n]) },
  ] };
  const fundReceipt = { status: 1, blockNumber: 12, from: wallet.address, to: router, logs: [
    { address: token, ...iface.encodeEventLog('Transfer', [wallet.address, router, 2000000n]) },
    { address: router, ...iface.encodeEventLog('FundFunded', [ethers.id('dbusk-playback'), token, wallet.address, 2000000n]) },
  ] };
  let latest = 10;
  let saved;
  let enabled = true;
  const create = () => createDmtvRadioQueue({
    provider: {
      getBlockNumber: async () => latest,
      getTransactionReceipt: async hash => hash === creatorTx ? creatorReceipt : hash === fundTx ? fundReceipt : null,
    },
    store: { restore: async () => structuredClone(saved), save: async snapshot => { saved = structuredClone(snapshot); return 'ipfs://checkpoint'; } },
    secret: 'test-only',
    findTrack: async () => track,
    enabled: () => enabled,
  });
  const queue = create();
  const { ticket } = await queue.quote({ payer: wallet.address, nftId: track.nftId });
  const other = await queue.quote({ payer: wallet.address, nftId: track.nftId });
  const body = { ticket, creatorTx, fundTx, signature: await wallet.signMessage(dmtvRadioAuthorization(ticket, creatorTx, fundTx)) };
  latest = 12;
  await assert.rejects(queue.submit(body), /two Base confirmations/);
  latest = 13;
  const completeLogs = fundReceipt.logs;
  fundReceipt.logs = completeLogs.slice(0, 1);
  await assert.rejects(queue.submit(body), /receipts do not prove/);
  fundReceipt.logs = completeLogs;
  enabled = false;
  const queued = await queue.submit(body);
  assert.equal(queued.state, 'pending');
  const restarted = create();
  assert.deepEqual(await restarted.submit(body), queued);
  await assert.rejects(restarted.submit({
    ...body, ticket: other.ticket, signature: await wallet.signMessage(dmtvRadioAuthorization(other.ticket, creatorTx, fundTx)),
  }), /already assigned/);
  const claimed = await restarted.nextPaid();
  assert.equal(claimed.track.ipfsCid, track.ipfsCid);
  assert.equal(await restarted.nextPaid(), null);
  const afterRestart = create();
  assert.equal((await afterRestart.nextPaid()).record.requestId, queued.requestId);
  await afterRestart.complete(claimed.record, { playId: 'play', finished: true, audibleMs: 2000 });
  assert.equal(await create().nextPaid(), null);
  assert.equal((await create().submit(body)).state, 'played');
});

test('one scheduler alternates DJuke and DMTv without bypassing DVert priority', async () => {
  const { combinePaidQueues } = await import('../discord-bot/devert-queue.js');
  const outcomes = [];
  function source(kind, ids) {
    return {
      async nextPaid() { return ids.length ? { record: { kind, requestId: ids.shift() } } : null; },
      async complete(record) { outcomes.push(`${kind}:${record.requestId}`); },
    };
  }
  const scheduler = combinePaidQueues({
    songs: source('djuke', ['song1', 'song2']), videos: source('dmtv', ['video1', 'video2']),
    adverts: source('devert', ['ad']),
  });
  for (let i = 0; i < 5; i++) await scheduler.complete((await scheduler.nextPaid()).record);
  assert.deepEqual(outcomes, ['devert:ad', 'djuke:song1', 'dmtv:video1', 'djuke:song2', 'dmtv:video2']);
  assert.equal(await scheduler.nextPaid(), null);
});
