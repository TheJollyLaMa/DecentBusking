const test = require('node:test');
const assert = require('node:assert/strict');

const campaign = (campaignId, offerUnits = '1000000', overrides = {}) => ({
  campaignId, advertiser: `0x${campaignId.charCodeAt(0).toString(16).padStart(2, '0').repeat(20)}`,
  title: campaignId, audioURI: `ipfs://${campaignId}`, offerUnits,
  startedAt: new Date(0).toISOString(), expiresAt: new Date(7 * 24 * 60 * 60 * 1000).toISOString(),
  mainRadioPlays: 0, devertPlays: 0, djukeBoosts: 0, ...overrides,
});

test('DeVert weekly minimum is one USDC and occupied main slots require an overbid', async () => {
  const { quoteDevertCampaign } = await import('../js/devert-scheduler.mjs');
  assert.equal(quoteDevertCampaign({ campaigns: [], mainRadioSlots: 2 }).minimumOfferUnits, 1000000n);
  const quote = quoteDevertCampaign({ campaigns: [campaign('a'), campaign('b', '7000000')], mainRadioSlots: 2 });
  assert.equal(quote.minimumOfferUnits, 1010000n);
  assert.equal(quote.bumpedCampaignId, 'a');
  assert.equal(quoteDevertCampaign({ campaigns: [], mainRadioSlots: 0 }).minimumOfferUnits, 1000000n);
});

test('main-radio ads consume at most one slot per ten music plays and rank active campaigns for those slots', async () => {
  const { planDevertQueues } = await import('../js/devert-scheduler.mjs');
  const campaigns = [campaign('a'), campaign('b', '8000000'), campaign('c', '6000000'),
    campaign('expired', '9000000', { startedAt: new Date(-8 * 86400000).toISOString(), expiresAt: new Date(-86400000).toISOString() })];
  const plan = planDevertQueues({ campaigns, completedSongPlays: 20, now: 1000 });
  assert.deepEqual(plan.mainRadio.map(ad => ad.campaignId), ['b', 'c']);
  assert.deepEqual(plan.mainRadioOverflow.map(ad => ad.campaignId), ['a']);
  assert.equal(plan.songsPerMainAd, 10);
});

test('one DJuke bump improves main-radio rank once without refunding or expiring the weekly campaign', async () => {
  const { applyDevertDjukeBump, planDevertQueues } = await import('../js/devert-scheduler.mjs');
  const campaigns = [campaign('a', '9000000'), campaign('b', '8000000'), campaign('c', '7000000')];
  const next = applyDevertDjukeBump(campaigns, 'c', { purchaseId: 'djuke:8453:33', at: new Date(1000).toISOString() });
  const queues = planDevertQueues({ campaigns: next, completedSongPlays: 20, now: 2000 });
  assert.deepEqual(queues.mainRadio.map(ad => ad.campaignId), ['c', 'a']);
  assert.equal(next[2].offerUnits, '7000000');
  assert.equal(next[2].expiresAt, campaigns[2].expiresAt);
  assert.throws(() => applyDevertDjukeBump(next, 'c', { purchaseId: 'djuke:8453:33' }), /already applied/);
});

test('DeVert rejects malformed campaigns and campaign terms longer than one week', async () => {
  const { planDevertQueues } = await import('../js/devert-scheduler.mjs');
  assert.throws(() => planDevertQueues({ campaigns: [campaign('bad', '999999')], completedSongPlays: 10, now: 1 }), /Invalid DeVert campaign/);
  assert.throws(() => planDevertQueues({ campaigns: [campaign('long', '1000000', { expiresAt: new Date(8 * 86400000).toISOString() })], completedSongPlays: 10, now: 1 }), /seven days/);
});

test('advertiser checkout quotes on Base, caps the offer and approves only the exact USDC amount', async () => {
  const { purchaseDevertCampaign } = await import('../js/devert-tab.mjs');
  const calls = [];
  const signer = { provider: { getNetwork: async () => ({ chainId: 8453n }), getBlock: async () => ({ timestamp: 1234 }),
    getFeeData: async () => ({ gasPrice: 1_000_000_000n }), getBalance: async () => 1_000_000_000_000_000_000n },
    getAddress: async () => `0x${'11'.repeat(20)}` };
  const createCampaign = async (...args) => {
    calls.push(['purchase', ...args]);
    return { hash: '0xcampaign', wait: async () => ({ status: 1 }) };
  };
  createCampaign.staticCall = async (...args) => calls.push(['static', ...args]);
  const contract = { target: `0x${'22'.repeat(20)}`, campaignWeek: async timestamp => { assert.equal(timestamp, 1234); return 8n; },
    quoteCampaign: async weekId => { assert.equal(weekId, 8n); return { minimumOfferUnits: 1_010_000n }; },
    quoteSchedulerGasTopUp: async gasPrice => 500_000n * gasPrice, createCampaign };
  const usdc = { target: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: async () => 6,
    balanceOf: async () => 10_000_000n, allowance: async () => 0n,
    approve: async (target, amount) => { calls.push(['approve', target, amount]); return { wait: async () => ({ status: 1 }) }; } };
  const hash = await purchaseDevertCampaign({ signer, contract, usdc, title: 'Set announcement', audioURI: 'ipfs://bafy-audio',
    offerUnits: 1_010_000n, maxPaymentUnits: 6_000_000n });
  assert.equal(hash, '0xcampaign');
  assert.deepEqual(calls.map(call => call[0]), ['approve', 'static', 'purchase']);
  assert.equal(calls[0][2], 1_010_000n);
  assert.equal(calls[1][4], 6_000_000n);
  await assert.rejects(purchaseDevertCampaign({ signer, contract, usdc, title: 'Set announcement', audioURI: 'ipfs://bafy-audio',
    offerUnits: 1_000_000n, maxPaymentUnits: 6_000_000n }), /Current minimum offer/);
  assert.equal(calls.length, 3);
});

test('advertiser checkout refuses wrong chain and non-IPFS audio before token approval', async () => {
  const { purchaseDevertCampaign } = await import('../js/devert-tab.mjs');
  const signer = { provider: { getNetwork: async () => ({ chainId: 1n }) } };
  const contract = { target: `0x${'22'.repeat(20)}` };
  const usdc = { target: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: async () => 6 };
  await assert.rejects(purchaseDevertCampaign({ signer, contract, usdc, title: 'A', audioURI: 'ipfs://a', offerUnits: 1_000_000n, maxPaymentUnits: 1_000_000n }), /Base/);
  signer.provider.getNetwork = async () => ({ chainId: 8453n });
  await assert.rejects(purchaseDevertCampaign({ signer, contract, usdc, title: 'A', audioURI: 'https://example.invalid/ad.mp3', offerUnits: 1_000_000n, maxPaymentUnits: 1_000_000n }), /IPFS/);
});
