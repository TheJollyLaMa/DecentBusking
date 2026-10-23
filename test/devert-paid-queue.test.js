const test = require('node:test');
const assert = require('node:assert/strict');

const buyer = `0x${'1'.repeat(40)}`;
const advertiser = `0x${'2'.repeat(40)}`;
const queueAddress = `0x${'3'.repeat(40)}`;
const request = (n = 0) => ({ requestId: `8453:${queueAddress}:${n}`, chainRequestId: String(n),
  campaignId: '9', payer: buyer, amountUnits: '1000000', title: 'Approved advert', audioURI: 'ipfs://approved-ad',
  advertiser, songId: `0x${'4'.repeat(64)}`, revision: '0', trackId: `devert-paid:${n}`, playable: true });

test('a hung paid queue stays bounded without overlapping or discarding a late durable selection', async () => {
  const { combinePaidQueues } = await import('../discord-bot/devert-queue.js');
  let resolveAd;
  let adCalls = 0;
  let songCalls = 0;
  const released = [];
  const warnings = [];
  const record = { requestId: 'late-paid-ad', kind: 'devert' };
  const adverts = {
    nextPaid: () => { adCalls++; return new Promise(resolve => { resolveAd = resolve; }); },
    release: async selected => released.push(selected.requestId),
    fail: async () => assert.fail('A late queue selection is not a playback failure'),
  };
  const queues = combinePaidQueues({ adverts, songs: { nextPaid: async () => { songCalls++; return null; } },
    timeoutMs: 5, log: { warn: message => warnings.push(message) } });
  assert.equal(await queues.nextPaid(), null);
  assert.equal(await queues.nextPaid(), null);
  assert.equal(adCalls, 1, 'do not start another reservation while the old one is unresolved');
  assert.equal(songCalls, 2);
  assert.match(warnings[0], /timed out; music rotation continues/);
  resolveAd({ record, track: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(released, []);
  assert.equal((await queues.nextPaid()).record, record);
  assert.equal(adCalls, 1, 'consume the prepared reservation instead of paying for another checkpoint');
});

test('a late playlist selection stays paid and queued instead of refunding the batch', async () => {
  const { combinePaidQueues } = await import('../discord-bot/devert-queue.js');
  const { createDjukeRuntime, createDjukePlaybackJournal } = await import('../discord-bot/djuke.js');
  let finishRead;
  let firstRead = true;
  let refunds = 0;
  const journal = createDjukePlaybackJournal({ restore: async () => null, save: async () => 'ipfs://journal' });
  const item = { requestId: 'playlist:1', playlistLaneId: '1', playlistBatchId: '0',
    songId: `0x${'a'.repeat(64)}`, trackId: 'second-song', revision: '0', playable: true };
  const runtime = createDjukeRuntime({ journal, timeoutMs: 1000,
    readState: async () => {
      if (firstRead) { firstRead = false; await new Promise(resolve => { finishRead = resolve; }); }
      return { requests: [item] };
    },
    getTrack: trackId => ({ trackId }), fulfill: async () => assert.fail('No unheard song can settle'),
    refundPlaylistBatch: async () => { refunds++; } });
  const queues = combinePaidQueues({ songs: runtime, timeoutMs: 10, log: { warn() {} } });
  assert.equal(await queues.nextPaid(), null);
  finishRead();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refunds, 0);
  assert.equal(journal.getState()[0].state, 'playing');
  const retried = await queues.nextPaid();
  assert.equal(retried.record.requestId, item.requestId);
  assert.equal(retried.record.attempts, 1);
  assert.equal(refunds, 0);
  await queues.release(retried.record, new Error('Scheduled handoff'));
  assert.equal(journal.getState()[0].state, 'pending');
  assert.equal(refunds, 0);
  const failed = await queues.nextPaid();
  await queues.fail(failed.record, new Error('Recording unavailable'));
  assert.equal(refunds, 1, 'real playback failures must retain the refund safety net');
});

test('public advert search matches titles, creators, addresses and campaign IDs without changing the catalog', async () => {
  const { filterDevertCampaigns } = await import('../js/devert-paid-queue.mjs');
  const catalog = [{ campaignId: '12', title: 'Moon Festival', advertiser, artist: 'Luna' },
    { campaignId: '34', title: 'Jazz Night', advertiser: buyer }];
  for (const query of ['  MOON ', 'luna', advertiser, '12']) {
    assert.deepEqual(filterDevertCampaigns(catalog, query), [catalog[0]]);
  }
  assert.deepEqual(filterDevertCampaigns(catalog, ''), catalog);
  assert.deepEqual(filterDevertCampaigns(catalog, 'not found'), []);
  assert.equal(catalog.length, 2);
});

test('compact paid panel keeps tier order, filters eligible adverts, handles failure, and needs no refund elements', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const helpers = await import('../js/devert-paid-queue.mjs');
  const { quoteDevertRequest } = await import('../js/devert-queue.mjs');
  const { formatUsdcUnits } = await import('../js/usdc-format.mjs');
  const ids = ['devert-paid-queue-button', 'devert-paid-immediate-button', 'devert-paid-price',
    'devert-paid-immediate-price', 'devert-paid-campaign', 'devert-search', 'devert-search-state',
    'devert-paid-count', 'devert-paid-requests', 'devert-paid-status', 'devert-paid-receipt', 'devert-paid-refresh'];
  const makeElement = () => ({
    children: [], textContent: '', value: '', listeners: {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(event, callback) { this.listeners[event] = callback; },
  });
  const nodes = Object.fromEntries(ids.map(id => [id, makeElement()]));
  const select = nodes['devert-paid-campaign'];
  let chosen = '';
  Object.defineProperty(select, 'value', {
    get() { return this.children.some(child => child.value === chosen) ? chosen : this.children[0]?.value || ''; },
    set(value) { chosen = value; },
  });
  const listeners = {};
  const document = {
    getElementById: id => nodes[id] || null, createElement: makeElement,
    addEventListener(event, callback) { listeners[event] = callback; },
  };
  const state = { configured: true, version: 2, chainId: 8453, contractAddress: queueAddress,
    paymentsEnabled: false, paused: false, pendingCount: 2, priceUnits: '1000000',
    immediatePriceUnits: '2000000', approvedCampaignIds: ['1', '2'], recentRefunds: [],
    requests: [{ ...request(0), tier: 0 }, { ...request(1), tier: 1, amountUnits: '2000000' }] };
  const catalog = { chainId: 8453, campaigns: [
    { campaignId: '1', title: 'Moon Festival', advertiser, artist: 'Luna',
      startedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() },
    { campaignId: '2', title: 'Expired', advertiser, startedAt: new Date(0).toISOString(), expiresAt: new Date(1).toISOString() },
  ] };
  let offline = false;
  const purchases = [];
  const context = vm.createContext({
    ...helpers, quoteDevertRequest, formatUsdcUnits, document, AbortSignal,
    devertQueueAbi: () => [], DEVERT_QUEUE_USDC: buyer, USDC_BROWSER_ABI: [],
    ethers: { Contract: class {} },
    purchaseDevertRequest: async options => {
      purchases.push(options);
      return { requestId: '5', txHash: `0x${'a'.repeat(64)}` };
    },
    window: { DecentConfig: { devertQueueContractAddress: queueAddress, ipfsUploadServiceUrl: 'https://service.example' } },
    setInterval() {},
    fetch: async url => {
      if (offline) throw new Error('service offline');
      return { ok: true, json: async () => url.endsWith('/queue') ? state : catalog };
    },
  });
  const source = fs.readFileSync(path.join(__dirname, '../js/devert-paid-queue.mjs'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export /g, '');
  vm.runInContext(`${source}\ninitDevertPaidQueue();`, context);
  listeners['left-drawer-open']({ detail: 'devert' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nodes['devert-paid-price'].textContent, '1.00');
  assert.equal(nodes['devert-paid-immediate-price'].textContent, '2.00');
  assert.equal(nodes['devert-paid-count'].textContent, '2');
  assert.match(nodes['devert-paid-requests'].children[0].children[1].textContent, /After this song/);
  assert.match(nodes['devert-paid-requests'].children[1].children[1].textContent, /Next ad break/);
  assert.equal(select.children.length, 1);
  assert.equal(select.value, '1');
  assert.equal(nodes['devert-paid-queue-button'].disabled, true);
  assert.equal(nodes['devert-paid-immediate-button'].disabled, true);
  const search = nodes['devert-search'];
  search.value = 'not found';
  search.listeners.input();
  assert.equal(select.disabled, true);
  assert.equal(select.value, '');
  assert.equal(nodes['devert-search-state'].textContent, '0 matching adverts');
  search.value = 'LUNA';
  search.listeners.input();
  assert.equal(select.disabled, false);
  assert.equal(select.value, '1');
  state.paymentsEnabled = true;
  context.window._wallet = { address: buyer, signer: {}, chainId: 8453 };
  await nodes['devert-paid-refresh'].listeners.click();
  assert.equal(nodes['devert-paid-queue-button'].disabled, false);
  await nodes['devert-paid-queue-button'].listeners.click();
  await nodes['devert-paid-refresh'].listeners.click();
  await nodes['devert-paid-immediate-button'].listeners.click();
  assert.deepEqual(purchases.map(item => [item.campaignId, item.tier, item.maxPriceUnits]),
    [['1', 0, 1000000n], ['1', 1, 2000000n]]);
  assert.match(nodes['devert-paid-receipt'].textContent, /Request #5 queued/);
  assert.match(nodes['devert-paid-receipt'].textContent, /distributed automatically after completed playback/);
  assert.equal(nodes['devert-paid-immediate-button'].disabled, false, 'confirmed checkout refreshes without a manual reload');
  state.playbackReady = false;
  state.playbackReason = 'Local checkpoint mirror is offline';
  state.paymentsEnabled = false;
  await nodes['devert-paid-refresh'].listeners.click();
  assert.equal(nodes['devert-paid-immediate-button'].disabled, true);
  assert.match(nodes['devert-paid-status'].textContent, /Local checkpoint mirror is offline/);
  assert.match(nodes['devert-paid-status'].textContent, /Existing payments remain queued/);
  offline = true;
  await nodes['devert-paid-refresh'].listeners.click();
  assert.equal(nodes['devert-paid-price'].textContent, 'Unavailable');
  assert.equal(nodes['devert-paid-count'].textContent, '—');
  assert.equal(nodes['devert-paid-requests'].children.length, 0);
  assert.equal(select.disabled, true);
  assert.equal(nodes['devert-paid-status'].textContent, 'service offline');
});

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
  let ready = false;
  const cached = createDevertQueueReader({ provider, contract, contractAddress: queueAddress, version: 2,
    paymentsEnabled: true, cacheMs: 60_000,
    getPlaybackStatus: () => ({ ready, reason: ready ? null : 'Local checkpoint mirror is offline' }) });
  const offline = await cached();
  assert.equal(offline.paymentsEnabled, false);
  assert.equal(offline.playbackReady, false);
  assert.equal(offline.requests.length, 1, 'pending funds remain visible during an outage');
  ready = true;
  assert.equal((await cached()).paymentsEnabled, true, 'availability is checked even for cached chain data');
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

test('both DVert priority payments celebrate only decoded confirmed requests, never approvals or failures', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const base = await import('../js/base-chain.mjs');
  const { formatUsdcUnits } = await import('../js/usdc-format.mjs');
  const { DEVERT_QUEUE_USDC } = await import('../js/devert-queue.mjs');
  const celebrations = [];
  const context = vm.createContext({
    ...base, formatUsdcUnits, announcePaymentCelebration: detail => celebrations.push(detail),
  });
  const source = fs.readFileSync(path.join(__dirname, '../js/devert-queue.mjs'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export /g, '');
  vm.runInContext(source, context);
  const signer = { provider: { getNetwork: async () => ({ chainId: 8453n }) }, getAddress: async () => buyer };
  let allowance = 0n;
  const usdc = { target: DEVERT_QUEUE_USDC, decimals: async () => 6, balanceOf: async () => 4000000n,
    allowance: async () => allowance, approve: async (_, amount) => {
      allowance = amount;
      assert.equal(celebrations.length, 0);
      return { wait: async () => ({ status: 1 }) };
    } };
  let confirm;
  let receipt = { status: 1, logs: [{ address: queueAddress }] };
  const hashes = [`0x${'a'.repeat(64)}`, `0x${'b'.repeat(64)}`];
  const queue = { target: queueAddress, paymentToken: async () => DEVERT_QUEUE_USDC,
    queueVersion: async () => 2n, quoteForTier: async tier => tier ? 2000000n : 1000000n,
    requestAd: Object.assign(async (_, tier) => ({
      hash: hashes[tier], wait: () => new Promise(resolve => { confirm = () => resolve(receipt); }),
    }), { staticCall: async () => {} }),
    interface: { parseLog: () => ({ name: 'AdRequested', args: { requestId: 12n } }) } };
  for (const tier of [0, 1]) {
    celebrations.length = 0;
    const pending = context.purchaseDevertRequest({ signer, queue, usdc, campaignId: '9', tier, maxPriceUnits: 4000000n });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(celebrations.length, 0, 'pending payments and approvals must not celebrate');
    confirm();
    await pending;
    assert.equal(celebrations.length, 1);
    assert.equal(celebrations[0].chainId, 8453);
    assert.equal(celebrations[0].txHash, hashes[tier]);
    assert.equal(celebrations[0].amountText, tier ? '2.00' : '1.00');
    assert.equal(celebrations[0].assetText, 'USDC');
    assert.match(celebrations[0].summary, tier ? /after-song priority/ : /queue bump/);
    assert.match(celebrations[0].txLabel, /request #12 confirmed/);
  }
  for (const failed of [{ status: 0, logs: [] }, { status: 1, logs: [] }]) {
    celebrations.length = 0;
    receipt = failed;
    const pending = context.purchaseDevertRequest({ signer, queue, usdc, campaignId: '9', maxPriceUnits: 1000000n });
    const rejected = assert.rejects(pending, /failed|reconciliation/);
    await new Promise(resolve => setImmediate(resolve));
    confirm();
    await rejected;
    assert.equal(celebrations.length, 0);
  }
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
  let removals = 0;
  const runtime = createDevertQueueRuntime({ readState: async () => ({ paused, requests: [request()] }),
    store: { restore: async () => null, save: async () => 'ipfs://state' },
    contract: { removeCampaign: async () => { removals++; return { hash: '0xremoved', wait: async () => ({ status: 1 }) }; } },
    isCampaignRemoved: () => true });
  assert.equal(await runtime.nextPaid(), null);
  paused = false;
  assert.equal(await runtime.nextPaid(), null);
  assert.equal(removals, 0);
  const calls = [];
  const combined = combinePaidQueues({ adverts: { nextPaid: async () => ({ record: { kind: 'devert' } }), complete: async () => calls.push('ad-complete') },
    songs: { nextPaid: async () => { calls.push('song'); return {}; } } });
  assert.equal((await combined.nextPaid()).record.kind, 'devert');
  assert.deepEqual(calls, []);
  await combined.complete({ kind: 'devert' }, {});
  assert.deepEqual(calls, ['ad-complete']);
});

test('campaign removal waits for active paid playback and settles completed playback before enabling refunds', async () => {
  const { createDevertQueueCatalogSync, createDevertQueueRuntime } = await import('../discord-bot/devert-queue.js');
  const removals = { list: () => [{ campaignId: '9' }] };

  {
    let removed = false;
    const requests = [request()];
    const calls = [];
    const runtime = createDevertQueueRuntime({
      readState: async () => ({ paused: false, requests, recentRefunds: [] }),
      store: { restore: async () => null, save: async () => 'ipfs://journal' },
      contract: { fulfill: async () => { throw new Error('Unexpected settlement'); } },
    });
    const sync = createDevertQueueCatalogSync({
      contract: {
        removedCampaigns: async () => removed,
        removeCampaign: async () => {
          calls.push('remove');
          removed = true;
          return { hash: '0xremoved', wait: async () => ({ status: 1 }) };
        },
      },
      removals, readCampaigns: async () => ({ campaigns: [] }),
      resolveApprovedMedia: () => null,
      beforeRemove: campaignId => runtime.prepareCampaignRemoval(campaignId),
    });
    const selection = await runtime.nextPaid();
    await assert.rejects(sync(), /deferred until paid request .* finishes or settles/);
    assert.deepEqual(calls, []);
    await runtime.fail(selection.record, new Error('Removal requested'));
    await sync();
    assert.deepEqual(calls, ['remove']);
    assert.equal(removed, true);
  }

  {
    let removed = false;
    let requests = [request()];
    const calls = [];
    const runtime = createDevertQueueRuntime({
      readState: async () => ({ paused: false, requests, recentRefunds: [] }),
      store: { restore: async () => null, save: async () => 'ipfs://journal' },
      contract: { fulfill: async () => {
        calls.push('settle');
        requests = [];
        return { hash: '0xpaid', wait: async () => ({ status: 1 }) };
      } },
    });
    const sync = createDevertQueueCatalogSync({
      contract: {
        removedCampaigns: async () => removed,
        removeCampaign: async () => {
          calls.push('remove');
          removed = true;
          return { hash: '0xremoved', wait: async () => ({ status: 1 }) };
        },
      },
      removals, readCampaigns: async () => ({ campaigns: [] }),
      resolveApprovedMedia: () => null,
      beforeRemove: campaignId => runtime.prepareCampaignRemoval(campaignId),
    });
    const selection = await runtime.nextPaid();
    await runtime.complete(selection.record, { playId: 'natural', audibleMs: 5000, finished: true });
    await new Promise(resolve => setImmediate(resolve));
    await sync();
    assert.deepEqual(calls, ['settle', 'remove']);
    assert.equal(removed, true);
  }
});

test('played paid requests remain checkpointed when removal has made them refundable', async () => {
  const { createDevertQueueRuntime } = await import('../discord-bot/devert-queue.js');
  const refundable = request();
  let saved;
  let settlements = 0;
  const runtime = createDevertQueueRuntime({
    readState: async () => ({ paused: false, requests: [], recentRefunds: [refundable] }),
    store: {
      restore: async () => ({ schemaVersion: 1, records: [{
        ...refundable, state: 'played', playId: 'already-played', attempts: 1,
      }] }),
      save: async state => { saved = structuredClone(state); return 'ipfs://journal'; },
    },
    contract: {
      getRequest: async () => ({ status: 0, campaignId: BigInt(refundable.campaignId) }),
      removedCampaigns: async () => true,
      fulfill: async () => { settlements++; },
    },
  });
  assert.equal(await runtime.nextPaid(), null);
  assert.equal(settlements, 0);
  assert.equal(saved.records[0].state, 'played');
});

test('removed unplayed requests leave the pending paid queue journal', async () => {
  const { createDevertQueueRuntime } = await import('../discord-bot/devert-queue.js');
  const refundable = request();
  let saved;
  const runtime = createDevertQueueRuntime({
    readState: async () => ({ paused: false, requests: [], recentRefunds: [refundable] }),
    store: {
      restore: async () => ({ schemaVersion: 1, records: [{
        ...refundable, state: 'pending', attempts: 0,
      }] }),
      save: async state => { saved = structuredClone(state); return 'ipfs://journal'; },
    },
    contract: {
      getRequest: async () => ({ status: 0, campaignId: BigInt(refundable.campaignId) }),
      removedCampaigns: async () => true,
    },
  });
  assert.equal(await runtime.nextPaid(), null);
  assert.equal(saved.records[0].state, 'fulfilled');
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
