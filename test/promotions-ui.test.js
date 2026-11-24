const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { id, ZeroHash, ZeroAddress } = require('../discord-bot/node_modules/ethers');
const owner = '0x807061DF657A7697c04045dA7d16D941861cAABc';
const routerAddress = '0x' + 'ab'.repeat(20);
const txHash = '0x' + 'ab'.repeat(32);

async function fixture(t) {
  const { payPromotion, enablePromotionRecipient } = await import('../js/promotions-ui.mjs');
  const previous = global.window;
  t.after(() => { if (previous === undefined) delete global.window; else global.window = previous; });
  let sends = 0, prepared = 0, reconciled = 0;
  let sendError;
  const entries = new Map();
  const storage = { getItem: key => entries.get(key) || null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
  const claim = { id: 'claim-1', campaignId: 'offer-1', wallet: '0x' + '12'.repeat(20),
    fund: 'dbusk-promotionals', amountUnits: '10000000', status: 'approved' };
  let expectedRecipient = claim.wallet, expectedAmount = claim.amountUnits, expectedLeg = '';
  const router = {
    completedWorkReferences: async () => false, DEFAULT_ADMIN_ROLE: async () => ZeroHash, PAYROLL_ROLE: async () => ZeroHash,
    hasRole: async () => true, paused: async () => false, funds: async () => ({ exists: true, active: true }),
    fundBalances: async () => 10000000n, approvedAssets: async () => true,
    contributors: async () => ({ approved: true }),
  };
  router.payout = async (...args) => {
    sends++;
    assert.ok(entries.size, 'journal must exist before wallet broadcast');
    assert.equal(prepared, 1, 'server payment reservation must be persisted first');
    assert.equal(args[0], id(claim.fund));
    assert.equal(args[2], expectedRecipient);
    assert.equal(args[3], BigInt(expectedAmount));
    assert.equal(args[4], id(`decentbusking:promotions:v1:8453:${claim.campaignId}:${claim.wallet}${expectedLeg ? `:${expectedLeg}` : ''}`));
    if (sendError) throw sendError;
    return { hash: txHash, wait: async confirmations => { assert.equal(confirmations, 2); return { status: 1 }; } };
  };
  router.payout.staticCall = async () => {};
  const signer = { provider: { getNetwork: async () => ({ chainId: 8453n }) } };
  global.window = { _wallet: { address: owner, signer }, ethers: { id, ZeroHash, Contract: function () { return router; } } };
  const command = async c => {
    if (c.action === 'prepare-payment') prepared++;
    if (c.action === 'reconcile') { assert.equal(c.txHash, txHash); reconciled++; }
    return { claims: [{ ...claim, status: reconciled === 2 ? 'paid' : 'payment-pending',
      ...(expectedLeg ? { legs: [{ id: expectedLeg, status: reconciled === 2 ? 'paid' : 'payment-pending' }] } : {}) }] };
  };
  const execute = () => payPromotion({ claim, snapshot: { routerAddress }, command, status: {}, storage });
  const enable = confirmAction => enablePromotionRecipient({ claim, snapshot: { routerAddress }, status: {}, confirmAction });
  return { execute, router, claim, entries, storage, signer, sends: () => sends,
    executeLeg: leg => payPromotion({ claim, leg, snapshot: { routerAddress }, command, status: {}, storage }),
    expectLeg: leg => { expectedRecipient = leg.recipient; expectedAmount = leg.amountUnits; expectedLeg = leg.id; },
    enable, prepared: () => prepared, reconciled: () => reconciled, error: e => { sendError = e; } };
}
test('payment UI reserves, journals before broadcast, uses fixed fund/reference and reconciles twice', async t => {
  const f = await fixture(t);
  await f.execute();
  assert.equal(f.sends(), 1);
  assert.equal(f.reconciled(), 2);
  assert.equal(f.entries.size, 0);
});
test('unresolved journals and completed references cannot start another payment', async t => {
  const f = await fixture(t);
  f.entries.set('decentbusking:promotion-payment:claim-1', JSON.stringify({ status: 'unknown' }));
  await assert.rejects(f.execute(), /unresolved/);
  assert.equal(f.prepared(), 0);
  f.entries.clear();
  f.router.completedWorkReferences = async () => true;
  await assert.rejects(f.execute(), /already paid/);
  assert.equal(f.sends(), 0);
});
test('wallet changes, inadequate balance or storage failures stop before a wallet payment', async t => {
  const f = await fixture(t);
  f.router.fundBalances = async () => 1n;
  await assert.rejects(f.execute(), /underfunded/);
  f.router.fundBalances = async () => 10000000n;
  f.router.payout.staticCall = async () => { window._wallet.address = '0x' + '22'.repeat(20); };
  await assert.rejects(f.execute(), /Wallet or network changed/);
  assert.equal(f.sends(), 0);
  window._wallet.address = owner;
  f.router.payout.staticCall = async () => {};
  f.storage.setItem = () => { throw new Error('Storage unavailable'); };
  await assert.rejects(f.execute(), /Storage unavailable/);
  assert.equal(f.sends(), 0);
});
test('definite wallet rejection releases the browser lock', async t => {
  const f = await fixture(t);
  f.error(Object.assign(new Error('Rejected'), { code: 'ACTION_REJECTED' }));
  await assert.rejects(f.execute(), /Rejected/);
  assert.equal(f.entries.size, 0);
});
test('ambiguous broadcast failure retains the browser lock', async t => {
  const f = await fixture(t);
  f.error(new Error('Network failed after signing'));
  await assert.rejects(f.execute(), /Network failed/);
  assert.equal(f.entries.size, 1);
});
test('post-broadcast journal failure surfaces the known transaction hash without resending', async t => {
  const f = await fixture(t);
  const write = f.storage.setItem;
  f.storage.setItem = (key, value) => {
    if (JSON.parse(value).hash) throw new Error('Storage full');
    write(key, value);
  };
  await assert.rejects(f.execute(), error => error.message.includes(txHash) && /do not send again/.test(error.message));
  assert.equal(f.sends(), 1);
  assert.equal(f.entries.size, 1);
});
test('wrong wallet, chain, role and paused router cannot send payment', async t => {
  for (const scenario of ['wallet', 'chain', 'role', 'paused']) await t.test(scenario, async t => {
    const f = await fixture(t);
    if (scenario === 'wallet') window._wallet.address = '0x' + '22'.repeat(20);
    if (scenario === 'chain') f.signer.provider.getNetwork = async () => ({ chainId: 1n });
    if (scenario === 'role') f.router.hasRole = async () => false;
    if (scenario === 'paused') f.router.paused = async () => true;
    await assert.rejects(f.execute(), /admin|role|network changed/);
    assert.equal(f.sends(), 0);
    assert.equal(f.prepared(), 0);
  });
});
test('a wallet change during the asynchronous network check is caught before any payment preparation', async t => {
  const f = await fixture(t);
  f.signer.provider.getNetwork = async () => {
    window._wallet.address = '0x' + '22'.repeat(20);
    return { chainId: 8453n };
  };
  await assert.rejects(f.execute(), /Wallet or network changed/);
  assert.equal(f.prepared(), 0);
  assert.equal(f.sends(), 0);
});
test('recipient enablement is a separately confirmed action and preserves existing router identity', async t => {
  const f = await fixture(t);
  let enabled = false, calls = 0;
  const existing = id('existing-identity');
  f.router.CONTRIBUTOR_ADMIN_ROLE = async () => ZeroHash;
  f.router.contributors = async () => ({ githubIdHash: existing, approved: enabled });
  f.router.setContributorApproved = async (wallet, identity, approved) => {
    calls++;
    assert.equal(wallet, f.claim.wallet);
    assert.equal(identity, existing);
    assert.equal(approved, true);
    return { hash: txHash, wait: async () => { enabled = true; return { status: 1 }; } };
  };
  f.router.setContributorApproved.staticCall = async () => {};
  await assert.rejects(f.enable(() => false), /canceled/);
  assert.equal(calls, 0);
  await f.enable(() => true);
  assert.equal(calls, 1);
  await f.enable(() => { throw new Error('Already enabled must not prompt'); });
  assert.equal(calls, 1);
});
test('ambiguous and nonexistent New York wall times cannot silently change campaign windows', async () => {
  const { promotionInputToUtc } = await import('../js/promotions-ui.mjs');
  assert.equal(promotionInputToUtc('2026-11-01T02:30'), '2026-11-01T07:30:00.000Z');
  assert.throws(() => promotionInputToUtc('2026-11-01T01:30'), /occurs twice/);
  assert.throws(() => promotionInputToUtc('2026-03-08T02:30'), /does not exist/);
});

test('public audit records show evidence, attribution, review and receipts with escaped untrusted content', async () => {
  const { publicPromotionRecords } = await import('../js/promotions-ui.mjs');
  const result = publicPromotionRecords({
    campaigns: [{ id: 'offer-1' }], checkpointUri: 'ipfs://bafypublic',
    claims: [{ campaignId: 'offer-1', wallet: '<wallet>', amountUnits: '10000000', status: 'paid',
      evidence: '<script>private-looking but public evidence</script>', txHash,
      history: [{ at: '2026-11-16', reviewer: owner, action: 'approved', reason: 'Reviewed rights' }] }],
    members: [{ campaignId: 'offer-1', wallet: 'referee', referrer: 'referrer' }],
    votes: [{ campaignId: 'offer-1', playId: 'song', wallet: 'referee' }],
  }, 'offer-1');
  assert.match(result, /public evidence/);
  assert.match(result, /referrer/);
  assert.match(result, /song/);
  assert.match(result, /Reviewed rights/);
  assert.match(result, new RegExp(`basescan.org/tx/${txHash}`));
  assert.match(result, /dweb.link\/ipfs\/bafypublic/);
  assert.doesNotMatch(result, /<script>|<wallet>/);
  assert.match(result, /&lt;script&gt;/);
});
test('money preserves six-decimal amounts and invite links keep the deployment subpath', async () => {
  const { promotionUnits, promotionMoney, promotionLink, PROMOTION_TEMPLATES } = await import('../js/promotions.mjs');
  assert.equal(promotionUnits('10.000001'), '10000001');
  assert.equal(promotionMoney('10000001'), '10.000001 USDC');
  assert.equal(promotionMoney('10000000'), '10.00 USDC');
  assert.throws(() => promotionUnits('0'), /positive/);
  assert.throws(() => promotionUnits('1e3'), /USDC amount/);
  assert.equal(promotionLink('offer', owner, 'https://site.example/DecentBusking/?tutorial=splits#old'),
    `https://site.example/DecentBusking/?promotion=offer&ref=${owner}`);
  assert.equal(PROMOTION_TEMPLATES.length, 7);
  assert.ok(PROMOTION_TEMPLATES.some(template => template.id === 'musician-referral'));
});
test('conversion UI pays one wallet leg with its own amount and work reference', async t => {
  const f = await fixture(t);
  const leg = { id: 'musician', recipient: '0x' + '34'.repeat(20), amountUnits: '5000000', kind: 'wallet',
    status: 'approved' };
  f.expectLeg(leg);
  await f.executeLeg(leg);
  assert.equal(f.sends(), 1);
});
test('entry points expose the admin section and public offer while suppressing automatic tutorial interference', () => {
  const root = require('node:path').join(__dirname, '..');
  const html = fs.readFileSync(root + '/index.html', 'utf8');
  const admin = fs.readFileSync(root + '/js/admin.js', 'utf8');
  const leftAnkh = fs.readFileSync(root + '/js/components/header-admin-inject.js', 'utf8');
  const ui = fs.readFileSync(root + '/js/promotions-ui.mjs', 'utf8');
  const tutorial = fs.readFileSync(root + '/js/tutorial.js', 'utf8');
  assert.match(html, /id="admin-promotions"/);
  assert.match(admin, /mountAdminPromotions/);
  assert.match(admin, /mountPublicPromotion\(\)/);
  assert.match(leftAnkh, /📻 Radio Programming/);
  assert.match(leftAnkh, /new CustomEvent\('open-radio-programming'\)/);
  assert.match(admin, /document\.addEventListener\('open-radio-programming'/);
  assert.match(admin, /_radioModal\.showModal\(\)/);
  assert.match(tutorial, /\.has\('promotion'\)\) return/);
  assert.match(ui, /newYorkInputToUtc/);
  assert.match(ui, /data-promo-curated/);
  assert.match(ui, /\['referral', 'musician-referral'\]\.includes/);
  assert.match(ui, /calendarOptions\.campaignId/);
  assert.match(ui, /calendarOptions\.endsAt\) input\('claimDeadline'\)/);
  assert.doesNotMatch(ui, /channels\/.*messages|api\/radio\/announcements\/send/);
  assert.match(ui, /target.type === 'submit'/);
  const payrollVersions = [...html.matchAll(/js\/payroll\.js\?v=([a-z0-9-]+)/g)].map(match => match[1]);
  assert.equal(payrollVersions.length, 2);
  assert.equal(new Set(payrollVersions).size, 1);
});

test('referral campaign blob titles, reuses templates and checks the referrals fund', async () => {
  const { referralCampaignPayload, referralFundAvailability, referralTemplateFrom, dollarsToUnits } = await import('../js/referral-campaign-editor.mjs');
  const startsAt = new Date(Date.now() + 86400000).toISOString();
  const endsAt = new Date(Date.now() + 15 * 86400000).toISOString();
  const claimDeadline = new Date(Date.now() + 22 * 86400000).toISOString();
  const wallet = '0x' + '12'.repeat(20);
  const payload = referralCampaignPayload({ title: ' Jose ', startsAt, endsAt, claimDeadline, referrers: [wallet] });
  assert.equal(payload.title, 'Jose Referral Campaign');
  assert.equal(payload.fund, 'dbusk-referrals');
  assert.equal(payload.budgetUnits, '150000000');
  assert.equal(referralCampaignPayload({ title: '', startsAt, endsAt, claimDeadline, referrers: [] }).title, 'Referral Campaign');
  assert.throws(() => referralCampaignPayload({ title: '', startsAt: endsAt, endsAt: startsAt, claimDeadline, referrers: [] }), /End must be after start/);
  const legAmounts = { referrer: '20000000', musician: '10000000', 'dbusk-top10': '5000000', 'dbusk-playback': '5000000' };
  const custom = referralCampaignPayload({ title: 'Jose', startsAt, endsAt, claimDeadline, referrers: [wallet],
    names: { [wallet]: 'Jose', ['0x' + '34'.repeat(20)]: 'Dropped' }, legAmounts, budgetUnits: '200000000', requiredVotes: 5 });
  assert.equal(custom.rewardUnits, '40000000');
  assert.equal(custom.maxAwards, 5);
  assert.deepEqual(custom.curatedReferrerNames, { [wallet]: 'Jose' });
  assert.throws(() => referralCampaignPayload({ title: '', startsAt, endsAt, claimDeadline, referrers: [], legAmounts, budgetUnits: '210000000' }), /exact multiple/);
  assert.deepEqual(referralTemplateFrom({ ...custom, curatedReferrers: [wallet.toUpperCase().replace('0X', '0x')] }),
    { title: 'Jose', durationMs: 14 * 86400000, claimGraceMs: 7 * 86400000, referrers: [wallet], names: { [wallet]: 'Jose' },
      legAmounts, budgetUnits: '200000000', requiredVotes: 5, asset: 'usdc', gifts: [] });
  assert.equal(dollarsToUnits('$12.5'), '12500000');
  assert.equal(dollarsToUnits('150'), '150000000');
  assert.equal(dollarsToUnits('1.234'), null);
  const campaigns = [{ fund: 'dbusk-referrals', status: 'published', budgetUnits: '150000000', paidUnits: '50000000' },
    { fund: 'dbusk-promotionals', status: 'published', budgetUnits: '999000000' },
    { fund: 'dbusk-referrals', status: 'draft', budgetUnits: '150000000' }];
  assert.deepEqual(referralFundAvailability({ balanceUnits: 200000000n, campaigns }),
    { balance: 200000000n, committed: 100000000n, available: 100000000n, shortfall: 50000000n });
  assert.equal(referralFundAvailability({ balanceUnits: 250000000n, campaigns }).shortfall, 0n);
  assert.deepEqual(referralFundAvailability({ balanceUnits: 100000000n, budgetUnits: 1n, campaigns: [
    { fund: 'dbusk-referrals', status: 'published', budgetUnits: '100000000', giftReserveUnits: '20000000',
      paidUnits: '50000000', giftPaidUnits: '20000000' },
  ] }), { balance: 100000000n, committed: 50000000n, available: 50000000n, shortfall: 0n });
});

test('ETH campaigns keep their own fund bucket, reserve gifts and convert amounts at the spot rate', async () => {
  const { referralCampaignPayload, referralFundAvailability, referralTemplateFrom, convertCampaignUnits } = await import('../js/referral-campaign-editor.mjs');
  const startsAt = new Date(Date.now() + 86400000).toISOString();
  const endsAt = new Date(Date.now() + 15 * 86400000).toISOString();
  const claimDeadline = new Date(Date.now() + 22 * 86400000).toISOString();
  const wallet = '0x' + '12'.repeat(20);
  const legAmounts = { referrer: '3000000000000000', musician: '1000000000000000', 'dbusk-top10': '1000000000000000', 'dbusk-playback': '0' };
  const gifts = [{ trigger: 'top', amountUnits: '10000000000000000', supporter: true }, { trigger: 'participation', amountUnits: '0', supporter: true }];
  const payload = referralCampaignPayload({ title: 'Ether', startsAt, endsAt, claimDeadline, referrers: [wallet], legAmounts,
    budgetUnits: '50000000000000000', asset: 'eth', gifts });
  assert.equal(payload.asset, 'eth');
  assert.equal(payload.maxAwards, 10);
  assert.deepEqual(payload.gifts.map(g => g.trigger), ['participation', 'top']);
  assert.throws(() => referralCampaignPayload({ startsAt, endsAt, claimDeadline, referrers: [], gifts: [{ trigger: 'top', amountUnits: '0', supporter: false }] }), /amount or/);
  assert.equal(referralTemplateFrom(payload).asset, 'eth');
  const campaigns = [{ fund: 'dbusk-referrals', status: 'published', asset: 'eth', budgetUnits: '50000000000000000', giftReserveUnits: '10000000000000000', paidUnits: '0' },
    { fund: 'dbusk-referrals', status: 'published', budgetUnits: '150000000', paidUnits: '0' }];
  assert.equal(referralFundAvailability({ balanceUnits: 100000000000000000n, campaigns, budgetUnits: 50000000000000000n, asset: 'eth' }).available, 40000000000000000n);
  assert.equal(referralFundAvailability({ balanceUnits: 150000000n, campaigns }).available, 0n);
  assert.equal(convertCampaignUnits('10000000', 'usdc', 'eth', 4000), '2500000000000000');
  assert.equal(convertCampaignUnits('2500000000000000', 'eth', 'usdc', 4000), '10000000');
  assert.equal(convertCampaignUnits('10000000', 'usdc', 'eth', null), null);
});
test('campaign gifts pay native ETH from the campaign fund with their own work reference', async t => {
  const { sendCampaignGift } = await import('../js/promotions-ui.mjs');
  const previous = global.window;
  t.after(() => { if (previous === undefined) delete global.window; else global.window = previous; });
  const winner = '0x' + '56'.repeat(20);
  const campaign = { id: 'offer-eth', fund: 'dbusk-referrals', asset: 'eth' };
  const award = { id: 'gift-top', trigger: 'top', wallet: winner, amountUnits: '10000000000000000', status: 'approved' };
  const actions = [];
  let paid;
  const router = { completedWorkReferences: async () => false, PAYROLL_ROLE: async () => ZeroHash, CONTRIBUTOR_ADMIN_ROLE: async () => ZeroHash,
    hasRole: async () => true, paused: async () => false, approvedAssets: async asset => asset === ZeroAddress,
    contributors: async () => ({ approved: true }), funds: async () => ({ exists: true, active: true }),
    fundBalances: async (_, asset) => asset === ZeroAddress ? 10n ** 17n : 0n };
  router.payout = async (...args) => { paid = args; return { hash: txHash, wait: async () => ({ status: 1 }) }; };
  router.payout.staticCall = async () => {};
  const signer = { provider: { getNetwork: async () => ({ chainId: 8453n }) } };
  global.window = { _wallet: { address: owner, signer }, ethers: { id, ZeroHash, Contract: function () { return router; } } };
  const entries = new Map();
  const storage = { getItem: key => entries.get(key) || null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
  const command = async c => {
    actions.push(c.action);
    assert.equal(c.giftId, 'gift-top');
    const reconciled = actions.filter(a => a === 'reconcile-gift').length;
    return { campaigns: [{ ...campaign, giftAwards: [{ ...award, status: reconciled === 2 ? 'paid' : 'payment-pending' }] }] };
  };
  await sendCampaignGift({ campaign, award, snapshot: { routerAddress }, command, status: {}, storage });
  assert.deepEqual(actions, ['prepare-gift', 'reconcile-gift', 'reconcile-gift']);
  assert.equal(paid[1], ZeroAddress);
  assert.equal(paid[3], 10000000000000000n);
  assert.equal(paid[4], id(`decentbusking:promotions:v1:8453:offer-eth:${winner}:gift-top`));
  assert.equal(entries.size, 0);
});

test('gift payment recovery reconciles a journal hash and releases only a confirmed no-broadcast preparation', async () => {
  const { reconcileCampaignGift, releaseCampaignGiftPreparation } = await import('../js/promotions-ui.mjs');
  const campaign = { id: 'offer-eth' };
  const award = { id: 'gift-top', wallet: '0x' + '56'.repeat(20) };
  const key = `decentbusking:promotion-gift:${campaign.id}:${award.id}:${award.wallet}`;
  const entries = new Map([[key, JSON.stringify({ hash: txHash })]]);
  const storage = { getItem: k => entries.get(k) || null, removeItem: k => entries.delete(k) };
  const actions = [];
  const command = async input => {
    actions.push(input);
    if (input.action === 'reconcile-gift') return { campaigns: [{ id: campaign.id,
      giftAwards: [{ ...award, status: 'paid' }] }] };
    return { campaigns: [{ id: campaign.id, giftAwards: [{ ...award, status: 'approved' }] }] };
  };
  await reconcileCampaignGift({ campaign, award, command, storage });
  assert.equal(actions[0].txHash, txHash);
  assert.equal(entries.has(key), false);
  await assert.rejects(releaseCampaignGiftPreparation({ campaign, award, command, storage, reason: ' ' }), /Record why/);
  await releaseCampaignGiftPreparation({ campaign, award, command, storage, reason: 'Wallet history shows no broadcast' });
  assert.deepEqual(actions[1], { action: 'release-gift-preparation', campaignId: campaign.id, giftId: award.id,
    wallet: award.wallet, confirmNoBroadcast: true, reason: 'Wallet history shows no broadcast' });
});
