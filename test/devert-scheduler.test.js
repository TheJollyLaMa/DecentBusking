const test = require('node:test');
const assert = require('node:assert/strict');

const campaign = (campaignId, offerUnits = '5000000', overrides = {}) => ({
  campaignId, advertiser: `0x${campaignId.charCodeAt(0).toString(16).padStart(2, '0').repeat(20)}`,
  title: campaignId, audioURI: `ipfs://${campaignId}`, offerUnits,
  startedAt: new Date(0).toISOString(), expiresAt: new Date(7 * 24 * 60 * 60 * 1000).toISOString(),
  mainRadioPlays: 0, devertPlays: 0, djukeBoosts: 0, ...overrides,
});

test('DeVert weekly minimum is five USDC and occupied main slots require an overbid', async () => {
  const { quoteDevertCampaign } = await import('../js/devert-scheduler.mjs');
  assert.equal(quoteDevertCampaign({ campaigns: [], mainRadioSlots: 2 }).minimumOfferUnits, 5000000n);
  const quote = quoteDevertCampaign({ campaigns: [campaign('a'), campaign('b', '7000000')], mainRadioSlots: 2 });
  assert.equal(quote.minimumOfferUnits, 5010000n);
  assert.equal(quote.bumpedCampaignId, 'a');
  assert.equal(quoteDevertCampaign({ campaigns: [], mainRadioSlots: 0 }).minimumOfferUnits, 5000000n);
});

test('main-radio ads consume at most one slot per ten music plays; displaced paid campaigns continue in DeVert', async () => {
  const { planDevertQueues } = await import('../js/devert-scheduler.mjs');
  const campaigns = [campaign('a'), campaign('b', '8000000'), campaign('c', '6000000'),
    campaign('expired', '9000000', { startedAt: new Date(-8 * 86400000).toISOString(), expiresAt: new Date(-86400000).toISOString() })];
  const plan = planDevertQueues({ campaigns, completedSongPlays: 20, now: 1000 });
  assert.deepEqual(plan.mainRadio.map(ad => ad.campaignId), ['b', 'c']);
  assert.deepEqual(plan.mainRadioOverflow.map(ad => ad.campaignId), ['a']);
  assert.deepEqual(plan.devertBroadcast.map(ad => ad.campaignId), ['b', 'c', 'a']);
  assert.equal(plan.songsPerMainAd, 10);
});

test('one DJuke bump improves both queue ranks once without refunding or expiring the weekly campaign', async () => {
  const { applyDevertDjukeBump, planDevertQueues } = await import('../js/devert-scheduler.mjs');
  const campaigns = [campaign('a', '9000000'), campaign('b', '8000000'), campaign('c', '7000000')];
  const next = applyDevertDjukeBump(campaigns, 'c', { purchaseId: 'djuke:8453:33', at: new Date(1000).toISOString() });
  const queues = planDevertQueues({ campaigns: next, completedSongPlays: 20, now: 2000 });
  assert.deepEqual(queues.mainRadio.map(ad => ad.campaignId), ['c', 'a']);
  assert.deepEqual(queues.devertBroadcast.map(ad => ad.campaignId), ['c', 'a', 'b']);
  assert.equal(next[2].offerUnits, '7000000');
  assert.equal(next[2].expiresAt, campaigns[2].expiresAt);
  assert.throws(() => applyDevertDjukeBump(next, 'c', { purchaseId: 'djuke:8453:33' }), /already applied/);
});

test('DeVert rejects malformed campaigns and campaign terms longer than one week', async () => {
  const { planDevertQueues } = await import('../js/devert-scheduler.mjs');
  assert.throws(() => planDevertQueues({ campaigns: [campaign('bad', '4999999')], completedSongPlays: 10, now: 1 }), /Invalid DeVert campaign/);
  assert.throws(() => planDevertQueues({ campaigns: [campaign('long', '5000000', { expiresAt: new Date(8 * 86400000).toISOString() })], completedSongPlays: 10, now: 1 }), /seven days/);
});
