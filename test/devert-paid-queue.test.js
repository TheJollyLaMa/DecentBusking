const test = require('node:test');
const assert = require('node:assert/strict');

const buyer = `0x${'1'.repeat(40)}`;
const advertiser = `0x${'2'.repeat(40)}`;
const queueAddress = `0x${'3'.repeat(40)}`;
const request = (n = 0) => ({ requestId: `8453:${queueAddress}:${n}`, chainRequestId: String(n),
  campaignId: '9', payer: buyer, amountUnits: '1000000', title: 'Approved advert', audioURI: 'ipfs://approved-ad',
  advertiser, songId: `0x${'4'.repeat(64)}`, revision: '0', trackId: `devert-paid:${n}`, playable: true });

test('paid advert pricing doubles per seven pending requests and rejects invalid counts', async () => {
  const { quoteDevertRequest } = await import('../js/devert-queue.mjs');
  for (const [count, price] of [[0, 1000000n], [6, 1000000n], [7, 2000000n], [14, 4000000n], [128, 262144000000n]]) {
    assert.equal(quoteDevertRequest(count), price);
    assert.equal(quoteDevertRequest(count, 1), price * 2n);
  }
  for (const count of [-1, 0.1, 129, NaN]) assert.throws(() => quoteDevertRequest(count), /count/);
  for (const tier of [-1, 2, '1']) assert.throws(() => quoteDevertRequest(0, tier), /tier/);
});

test('paid advert snapshot verifies Base confirmation, count, price and immutable media; removed requests remain refundable', async () => {
  const { createDevertQueueReader } = await import('../discord-bot/devert-queue.js');
  const { DEVERT_QUEUE_USDC } = await import('../js/devert-queue.mjs');
  const tags = [];
  const raw = { campaignId: 9n, payer: buyer, amount: 1000000n, status: 0n,
    title: 'Approved advert', audioURI: 'ipfs://approved-ad', advertiser, tier: 0n };
  let removed = false;
  let count = 1n;
  let reorg = false;
  let blockReads = 0;
  const provider = { getNetwork: async () => ({ chainId: 8453n }), getBlockNumber: async () => 20,
    getBlock: async () => ({ hash: reorg && ++blockReads > 1 ? 'changed' : 'stable' }) };
  const contract = { headRequestId: async () => removed ? 1n : 0n, nextRequestId: async () => 1n,
    pendingCount: async () => count, quote: async () => 1000000n, paused: async () => false,
    paymentToken: async () => DEVERT_QUEUE_USDC, removedCampaigns: async () => removed,
    queueVersion: async () => 2n, headRequestIdForTier: async tier => !removed && tier === 0 ? 0n : 1n,
    quoteForTier: async tier => tier === 1 ? 2000000n : 1000000n,
    approvedCampaigns: async (_, options) => { tags.push(options.blockTag); return true; },
    getRequest: async (_, options) => { tags.push(options.blockTag); return raw; } };
  const read = createDevertQueueReader({ provider, contract, contractAddress: queueAddress, paymentsEnabled: true, version: 2,
    getApprovedCampaignIds: () => ['9'] });
  const state = await read();
  assert.equal(state.blockNumber, 19);
  assert.equal(state.requests[0].audioURI, 'ipfs://approved-ad');
  assert.equal(state.paymentsEnabled, true);
  assert.equal(state.requests[0].tier, 0);
  assert.equal(state.immediatePriceUnits, '2000000');
  assert.deepEqual(state.approvedCampaignIds, ['9']);
  assert.ok(tags.every(tag => tag === 19));
  removed = true; count = 0n;
  const afterRemoval = await read();
  assert.equal(afterRemoval.requests.length, 0);
  assert.equal(afterRemoval.recentRefunds.length, 1);
  assert.deepEqual(afterRemoval.approvedCampaignIds, []);
  removed = false; count = 2n;
  await assert.rejects(read(), /Invalid paid advert queue snapshot/);
  count = 1n; reorg = true; blockReads = 0;
  await assert.rejects(read(), /changed during verification/);
  reorg = false;
  const legacy = await createDevertQueueReader({ provider, contract, contractAddress: queueAddress, paymentsEnabled: true })();
  assert.equal(legacy.paymentsEnabled, false);
  assert.equal(legacy.requests[0].tier, 1);
});

test('paid advert checkout reserves exact Base USDC, simulates before send and requires a request receipt', async () => {
  const { purchaseDevertRequest, DEVERT_QUEUE_USDC } = await import('../js/devert-queue.mjs');
  const calls = [];
  const signer = { provider: { getNetwork: async () => ({ chainId: 8453n }) }, getAddress: async () => buyer };
  let allowance = 0n;
  const usdc = { target: DEVERT_QUEUE_USDC, decimals: async () => 6, balanceOf: async () => 2000000n,
    allowance: async () => allowance, approve: async (_, value) => {
      calls.push(['approve', value]); allowance = value;
      return { wait: async () => ({ status: 1 }) };
    } };
  const queue = { target: queueAddress, paymentToken: async () => DEVERT_QUEUE_USDC,
    queueVersion: async () => 2n, quoteForTier: async tier => tier === 1 ? 2000000n : 1000000n,
    requestAd: Object.assign(async (campaign, tier, maxPrice) => {
      calls.push(['send', campaign, tier, maxPrice]);
      return { hash: '0xtx', wait: async () => ({ status: 1, logs: [{ address: queueAddress }] }) };
    }, { staticCall: async (...args) => calls.push(['simulate', ...args]) }),
    interface: { parseLog: () => ({ name: 'AdRequested', args: { requestId: 8n } }) } };
  const result = await purchaseDevertRequest({ signer, queue, usdc, campaignId: '9', maxPriceUnits: 1000000n });
  assert.deepEqual(calls.map(call => call[0]), ['approve', 'simulate', 'send']);
  assert.equal(calls[0][1], 1000000n);
  assert.deepEqual(calls[2], ['send', 9n, 0, 1000000n]);
  assert.equal(result.requestId, '8');
  calls.length = 0;
  await purchaseDevertRequest({ signer, queue, usdc, campaignId: '9', tier: 1, maxPriceUnits: 2000000n });
  assert.equal(calls[0][1], 2000000n);
  assert.deepEqual(calls[2], ['send', 9n, 1, 2000000n]);
  queue.quoteForTier = async () => 2000000n;
  await assert.rejects(purchaseDevertRequest({ signer, queue, usdc, campaignId: '9', maxPriceUnits: 1000000n }), /increased/);
  queue.queueVersion = async () => 1n;
  await assert.rejects(purchaseDevertRequest({ signer, queue, usdc, campaignId: '9', maxPriceUnits: 2000000n }), /replacement/);
  signer.provider.getNetwork = async () => ({ chainId: 1n });
  await assert.rejects(purchaseDevertRequest({ signer, queue, usdc, campaignId: '9', maxPriceUnits: 2000000n }), /Base/);
});

test('removal refund requires the paying wallet, removed campaign and confirmed receipt', async () => {
  const { claimDevertRefund } = await import('../js/devert-queue.mjs');
  const signer = { provider: { getNetwork: async () => ({ chainId: 8453n }) }, getAddress: async () => buyer };
  let removed = false;
  const queue = { getRequest: async () => ({ payer: buyer, status: 0n, campaignId: 9n }),
    removedCampaigns: async () => removed, claimRefund: async () => ({ hash: '0xrefund', wait: async () => ({ status: 1 }) }) };
  await assert.rejects(claimDevertRefund({ signer, queue, requestId: '3' }), /no removal refund/);
  removed = true;
  assert.equal(await claimDevertRefund({ signer, queue, requestId: '3' }), '0xrefund');
  signer.getAddress = async () => advertiser;
  await assert.rejects(claimDevertRefund({ signer, queue, requestId: '3' }), /paying wallet/);
});

test('paid ad runtime checkpoints natural playback before settling, retries failures and preserves expired purchased media', async () => {
  const { createDevertQueueRuntime } = await import('../discord-bot/devert-queue.js');
  let saved = null;
  let requests = [request()];
  const events = [];
  const runtime = createDevertQueueRuntime({
    readState: async () => ({ paused: false, requests }),
    store: { restore: async () => saved, save: async state => { saved = structuredClone(state); events.push('checkpoint'); return 'ipfs://journal'; } },
    contract: { fulfill: async () => {
      events.push('settle');
      assert.equal(saved.records[0].state, 'played');
      requests = [];
      return { hash: '0xpaid', wait: async () => ({ status: 1 }) };
    } },
    resolveCampaignMedia: () => ({ mediaType: 'audio/mpeg', filename: 'ad.mp3' }),
  });
  const first = await runtime.nextPaid();
  assert.equal(first.record.kind, 'devert');
  assert.equal(first.track.isDevertAd, true);
  assert.equal(first.track.videoUrl, '');
  assert.equal(saved.records[0].state, 'playing');
  await runtime.complete(first.record, { playId: 'interrupted', audibleMs: 60000, finished: false });
  assert.equal(saved.records[0].state, 'pending');
  assert.ok(!events.includes('settle'));
  const retry = await runtime.nextPaid();
  await runtime.complete(retry.record, { playId: 'natural', audibleMs: 20000, finished: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.includes('settle'), true);
  assert.equal(saved.records[0].state, 'fulfilled');
  assert.equal(await runtime.nextPaid(), null);
});

test('paid advert runtime defers while paused and reconciles removed requests before playing', async () => {
  const { createDevertQueueRuntime, combinePaidQueues } = await import('../discord-bot/devert-queue.js');
  let paused = true;
  const runtime = createDevertQueueRuntime({ readState: async () => ({ paused, requests: [request()] }),
    store: { restore: async () => null, save: async () => 'ipfs://state' },
    contract: { removeCampaign: async () => ({ hash: '0xremoved', wait: async () => ({ status: 1 }) }) },
    isCampaignRemoved: () => true });
  assert.equal(await runtime.nextPaid(), null);
  paused = false;
  await assert.rejects(runtime.nextPaid(), /awaiting the refreshed queue/);
  const calls = [];
  const combined = combinePaidQueues({ adverts: { nextPaid: async () => ({ record: { kind: 'devert' } }), complete: async () => calls.push('ad-complete') },
    songs: { nextPaid: async () => { calls.push('song'); return {}; } } });
  assert.equal((await combined.nextPaid()).record.kind, 'devert');
  assert.deepEqual(calls, []);
  await combined.complete({ kind: 'devert' }, {});
  assert.deepEqual(calls, ['ad-complete']);
});

test('checkout snapshot rejects a different contract or a manipulated quote and allows disabled configuration', async () => {
  const { validateDevertPaidSnapshot } = await import('../js/devert-paid-queue.mjs');
  assert.deepEqual(validateDevertPaidSnapshot({ configured: false }), { configured: false });
  const state = { version: 2, chainId: 8453, contractAddress: queueAddress, requests: [], recentRefunds: [], pendingCount: 0,
    priceUnits: '1000000', immediatePriceUnits: '2000000' };
  assert.equal(validateDevertPaidSnapshot(state, queueAddress), state);
  assert.throws(() => validateDevertPaidSnapshot(state, buyer), /configuration/);
  assert.throws(() => validateDevertPaidSnapshot({ ...state, priceUnits: '1' }, queueAddress), /configuration/);
  assert.throws(() => validateDevertPaidSnapshot({ ...state, immediatePriceUnits: '1000000' }, queueAddress), /tier quote/);
  assert.throws(() => validateDevertPaidSnapshot({ ...state, version: 1, paymentsEnabled: true }, queueAddress), /Legacy/);
});

test('catalog approval requires advert metadata, matching recording and advertiser; failures retry without skipping removal', async () => {
  const { createDevertQueueCatalogSync } = await import('../discord-bot/devert-queue.js');
  const { resolveApprovedDevertCampaignMedia } = await import('../discord-bot/mint-sync.js');
  const campaign = { campaignId: '9', advertiser, audioURI: 'ipfs://approved-ad' };
  const metadata = { name: 'Ordinary song', artist: advertiser, audioUrl: campaign.audioURI };
  assert.equal(resolveApprovedDevertCampaignMedia(campaign, 'approved-ad', { nfts: [metadata] }), null);
  metadata.isDevertAd = true;
  assert.ok(resolveApprovedDevertCampaignMedia(campaign, 'approved-ad', { nfts: [metadata] }));
  assert.equal(resolveApprovedDevertCampaignMedia({ ...campaign, advertiser: buyer }, 'approved-ad', { nfts: [metadata] }), null);
  assert.equal(resolveApprovedDevertCampaignMedia(campaign, 'another-recording', { nfts: [metadata] }), null);
  const events = [];
  let removed = [];
  let fail = true;
  const sync = createDevertQueueCatalogSync({
    contract: {
      removedCampaigns: async () => false, approvedCampaigns: async () => false,
      approveCampaign: async id => { events.push(`approve:${id}`); return { hash: '0xapproval',
        wait: async confirmations => { assert.equal(confirmations, 2); return { status: fail ? 0 : 1 }; } }; },
      removeCampaign: async id => { events.push(`remove:${id}`); return { wait: async () => ({ status: 1 }) }; },
    },
    removals: { list: () => removed },
    readCampaigns: async () => ({ campaigns: [campaign, { ...campaign, campaignId: '10', audioURI: 'ipfs://unmatched' }] }),
    resolveApprovedMedia: (value, cid) => resolveApprovedDevertCampaignMedia(value, cid, { nfts: [metadata] }),
  });
  await assert.rejects(sync(), /approval failed/);
  fail = false;
  assert.deepEqual(await sync(), ['9']);
  assert.deepEqual(await sync(), ['9']);
  assert.deepEqual(events, ['approve:9', 'approve:9']);
  removed = [{ campaignId: '9' }];
  assert.deepEqual(await sync(), []);
  assert.equal(events.at(-1), 'remove:9');
});

test('paid adverts recover FIFO across restarts, retry settlement without replay, and recheck removal before start', async () => {
  const { createDevertQueueRuntime } = await import('../discord-bot/devert-queue.js');
  let saved;
  let requests = [request(0), request(1)];
  let removed = false;
  let paused = false;
  let rejectSettlement = true;
  const fulfilled = [];
  const store = { restore: async () => saved, save: async state => { saved = structuredClone(state); return 'ipfs://checkpoint'; } };
  const contract = {
    paused: async () => paused, removedCampaigns: async () => removed,
    getRequest: async () => ({ campaignId: 9n, status: 0n }),
    fulfill: async id => {
      if (rejectSettlement) throw new Error('Router temporarily unavailable');
      fulfilled.push(Number(id));
      requests = requests.filter(row => row.chainRequestId !== String(id));
      return { hash: '0xpaid', wait: async () => ({ status: 1 }) };
    },
  };
  const makeRuntime = () => createDevertQueueRuntime({ readState: async () => ({ paused, requests }), store, contract,
    log: { warn() {} } });
  let runtime = makeRuntime();
  const first = await runtime.nextPaid();
  assert.equal(first.record.chainRequestId, '0');
  assert.equal(await runtime.canPlay(first.record), true);
  paused = true;
  assert.equal(await runtime.canPlay(first.record), false);
  paused = false; removed = true;
  assert.equal(await runtime.canPlay(first.record), false);
  removed = false;
  runtime = makeRuntime();
  const recovered = await runtime.nextPaid();
  assert.equal(recovered.record.chainRequestId, '0');
  await runtime.complete(recovered.record, { playId: 'recovered-play', audibleMs: 5000, finished: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved.records[0].state, 'played');
  rejectSettlement = false;
  runtime = makeRuntime();
  const second = await runtime.nextPaid();
  assert.deepEqual(fulfilled, [0]);
  assert.equal(second.record.chainRequestId, '1');
});

test('paid advert API distinguishes disabled checkout, confirmed state and explicit failure', async () => {
  const http = require('node:http');
  const { createWorkerRequestHandler } = await import('../discord-bot/ipfs-worker.js');
  async function serve(getDevertQueue, callback) {
    const server = http.createServer(createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: buyer, getDevertQueue }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try { await callback(`http://127.0.0.1:${server.address().port}/api/devert/queue`); }
    finally { await new Promise(resolve => server.close(resolve)); }
  }
  await serve(undefined, async url => {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { configured: false, paymentsEnabled: false, requests: [], recentRefunds: [] });
  });

  test('two-tier runtime keeps bumps for normal slots, prioritizes immediate FIFO and restores both tiers without replay', async () => {
    const { createDevertQueueRuntime } = await import('../discord-bot/devert-queue.js');
    let requests = [{ ...request(0), tier: 0 }, { ...request(1), tier: 1 },
      { ...request(2), tier: 0 }, { ...request(3), tier: 1 }];
    let saved;
    const fulfilled = [];
    const store = { restore: async () => saved, save: async state => { saved = structuredClone(state); return 'ipfs://journal'; } };
    const contract = {
      fulfill: async id => {
        fulfilled.push(Number(id));
        requests = requests.filter(row => row.chainRequestId !== String(id));
        return { hash: '0xpaid', wait: async () => ({ status: 1 }) };
      },
      getRequest: async id => ({ campaignId: 9n, status: 0n, tier: requests.find(row => row.chainRequestId === String(id)).tier }),
      headRequestIdForTier: async tier => BigInt(requests.find(row => row.tier === tier)?.chainRequestId ?? 4),
      nextRequestId: async () => 4n, paused: async () => false, removedCampaigns: async () => false,
    };
    const make = () => createDevertQueueRuntime({ readState: async () => ({ paused: false, requests }), store, contract });
    let runtime = make();
    let paid = await runtime.nextPaid({ allowBump: true });
    assert.equal(paid.record.chainRequestId, '1');
    await runtime.complete(paid.record, { playId: 'immediate-1', audibleMs: 5000, finished: true });
    await new Promise(resolve => setImmediate(resolve));
    runtime = make();
    paid = await runtime.nextPaid({ allowBump: true });
    assert.equal(paid.record.chainRequestId, '3');
    await runtime.complete(paid.record, { playId: 'immediate-3', audibleMs: 5000, finished: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await runtime.nextPaid(), null, 'bumps cannot create extra breaks');
    paid = await runtime.nextPaid({ allowBump: true });
    assert.equal(paid.record.chainRequestId, '0');
    assert.equal(paid.record.tier, 0);
    assert.equal(await runtime.canPlay(paid.record), true);
    requests.push({ ...request(4), tier: 1 });
    contract.nextRequestId = async () => 5n;
    assert.equal(await runtime.canPlay(paid.record), false, 'new immediate request preempts a bump before it starts');
    requests.pop();
    await runtime.complete(paid.record, { playId: 'bump-0', audibleMs: 5000, finished: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(fulfilled, [1, 3, 0]);
    assert.equal(await runtime.nextPaid(), null);
    paid = await runtime.nextPaid({ allowBump: true });
    assert.equal(paid.record.chainRequestId, '2');
  });
  const snapshot = { chainId: 8453, requests: [request()], approvedCampaignIds: ['9'], paymentsEnabled: true };
  await serve(async () => snapshot, async url => {
    const response = await fetch(url);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await response.json(), { configured: true, ...snapshot });
  });
  await serve(async () => { throw new Error('Confirmation block unavailable'); }, async url => {
    const response = await fetch(url);
    assert.ok(response.status >= 400);
    assert.match((await response.json()).error, /Confirmation block unavailable/);
  });
});
