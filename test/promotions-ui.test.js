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
  assert.ok(PROMOTION_TEMPLATES.some(template => template.id === 'musician-referral'));
});

test('pinning profile cards show verified progress and ETH bonuses without referral fields or success-shaped unavailable stats', async () => {
  const { pinnerCampaignStatsCard } = await import('../js/promotions-ui.mjs');
  const stats = { campaignId: 'pin-test', title: '<Pin & earn>', asset: 'eth', startsAt: '2026-11-27T22:00:00Z',
    endsAt: '2026-12-29T22:00:00Z', qualifyingDays: 30, completedDays: 1, nodeStatus: 'active',
    maxAwards: 5, eligible: false, claimStatus: 'not-submitted', rewardUnits: '1250000000000000',
    pendingUnits: '0', approvedUnits: '0', paidUnits: '0', nftGifts: [],
    days: [{ day: '2026-11-28', successfulChecks: 18, failedChecks: 2, qualified: true }] };
  const html = pinnerCampaignStatsCard(stats);
  assert.match(html, /1 \/ 30 qualifying days/);
  assert.match(html, /0\.00125 ETH/);
  assert.match(html, /18\/20 passed.*90%/);
  assert.match(html, /Weekly USDC pinning rewards are separate/);
  assert.match(html, /&lt;Pin &amp; earn&gt;/);
  assert.doesNotMatch(html, /Referral|voteProgress|<Pin/);
  const unavailable = pinnerCampaignStatsCard({ ...stats, completedDays: null, nodeStatus: 'unavailable',
    error: 'Checkpoint timed out' });
  assert.match(unavailable, /Verification unavailable: Checkpoint timed out/);
  assert.doesNotMatch(unavailable, /<progress|Qualified for bonus review/);
  const { promotionMoney, CAMPAIGN_ASSETS } = await import('../js/promotions.mjs');
  assert.equal(promotionMoney('1250123456789012', CAMPAIGN_ASSETS.eth), '0.001250123456789012 ETH',
    'the fixed bonus must display the exact payable wei, not silently truncate to six decimals');
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
  assert.match(html, /id="admin-programming-calendar"/);
  assert.match(admin, /mountRadioProgrammingCalendar/);
  assert.match(admin, /mountPublicPromotion\(\)/);
  assert.match(leftAnkh, /⚸ 🗓️ Admin DCal ⨘ 🜐/);
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
      legAmounts, budgetUnits: '200000000', requiredVotes: 5, asset: 'usdc', gifts: [], supporterRewards: custom.supporterRewards });
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
  const gifts = [{ trigger: 'top', amountUnits: '0', supporter: true }, { trigger: 'participation', amountUnits: '0', supporter: true }];
  const payload = referralCampaignPayload({ title: 'Ether', startsAt, endsAt, claimDeadline, referrers: [wallet], legAmounts,
    budgetUnits: '50000000000000000', asset: 'eth', gifts,
    fundMatchQuote: { ethUsdMicros: '4000000000', quotedAt: new Date().toISOString() } });
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
test('publication match rounding is integer-exact and basket identities reject malformed or repeated tokens', async () => {
  const { referralFundMatchUnits, campaignSupporterRewards, SUPPORTER_REWARD } = await import('../js/promotions.mjs');
  const quote = { ethUsdMicros: '4025000000', quotedAt: new Date().toISOString() };
  assert.equal(referralFundMatchUnits('200000000000000', quote), '810000', 'half cent rounds upward');
  assert.equal(referralFundMatchUnits('199999999999999', quote), '800000', 'just below half rounds downward');
  assert.throws(() => referralFundMatchUnits('200000000000000', { ...quote, ethUsdMicros: '0' }), /fixed publication/);
  assert.throws(() => referralFundMatchUnits('-1', quote), /Invalid ETH share/);
  assert.equal(campaignSupporterRewards([{ ...SUPPORTER_REWARD, tokenId: 75 }]), null);
  assert.equal(campaignSupporterRewards([{ ...SUPPORTER_REWARD, quantity: 2 }]), null);
  assert.equal(campaignSupporterRewards([SUPPORTER_REWARD, { ...SUPPORTER_REWARD, contract: SUPPORTER_REWARD.contract.toUpperCase().replace('0X', '0x') }]), null);
  const { referralCampaignPayload } = await import('../js/referral-campaign-editor.mjs');
  const config = { startsAt: new Date(Date.now() + 86400000).toISOString(),
    endsAt: new Date(Date.now() + 2 * 86400000).toISOString(), claimDeadline: new Date(Date.now() + 3 * 86400000).toISOString(), referrers: [] };
  assert.throws(() => referralCampaignPayload({ ...config, gifts: [{ trigger: 'top', amountUnits: '1000000', supporter: true }] }), /DNFTs only/);
});

test('Payroll resumes the USDC phase without re-paying the source and never treats approval as a deposit', async t => {
  const { createReferralMatchPayroll } = await import('../js/referral-match-payroll.mjs');
  const { REFERRAL_SETTLEMENT_VERSION } = await import('../js/promotions.mjs');
  const previous = global.window;
  t.after(() => { if (previous === undefined) delete global.window; else global.window = previous; });
  global.window = { _wallet: { address: owner } };
  const node = tag => ({ tag, children: [], listeners: [], classList: { toggle() {} },
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
    addEventListener(_, fn) { this.listeners.push(fn); }, setAttribute() {} });
  const root = { ...node('section'), ownerDocument: { createElement: node } };
  const walk = n => [n, ...(n.children || []).flatMap(walk)];
  const button = label => walk(root).find(n => n.tag === 'button' && n.textContent === label);
  const leg = { id: 'dbusk-top10', fund: 'dbusk-top10', kind: 'funding-needed', amountUnits: '200000000000000',
    status: 'funding-needed', match: { usdcUnits: '800000', source: { status: 'approved', recipient: owner.toLowerCase() }, deposit: { status: 'owed' } } };
  const claim = { id: 'claim-match', campaignId: 'campaign-match', subjectWallet: '0x' + '12'.repeat(20), status: 'approved', legs: [leg] };
  let state = { revision: 1, routerAddress, claims: [claim], campaigns: [{
    id: claim.campaignId, title: 'Trial', settlementVersion: REFERRAL_SETTLEMENT_VERSION, asset: 'eth', status: 'closed',
    maxAwards: 1, endsAt: new Date(Date.now() - 1000).toISOString() }] };
  const entries = new Map(), actions = [];
  const storage = { getItem: k => entries.get(k) || null, setItem: (k, v) => entries.set(k, v), removeItem: k => entries.delete(k) };
  const sign = async command => {
    actions.push(command.action);
    assert.equal(command.revision, state.revision); state.revision++;
    if (command.action === 'prepare-fund-match-deposit') leg.match.deposit.status = 'deposit-pending';
    if (command.action === 'release-fund-match-preparation') leg.match.deposit.status = 'owed';
    if (command.action === 'reconcile-fund-match-deposit') {
      assert.equal(command.txHash, txHash);
      leg.match.deposit.txHash = txHash;
      if (actions.filter(a => a === command.action).length === 2) { leg.match.deposit.status = 'paid'; leg.status = 'paid'; claim.status = 'paid'; }
    }
    return state;
  };
  let sourceSends = 0, deposits = 0, acceptDeposit = false, failDeposit = true, locked = false;
  const view = createReferralMatchPayroll({ root, fetchState: async () => state, sign, storage,
    setBusy: value => { locked = value; }, isBusy: () => locked,
    confirmAction: () => acceptDeposit, ask: () => 'Wallet history shows approval only; no deposit sent',
    getWallet: async () => ({ address: owner, signer: {}, check: async () => {},
      ethers: { id, Contract: function () { return {}; } } }),
    paySource: async () => { sourceSends++; leg.match.source.status = 'paid'; leg.match.source.txHash = '0x' + '34'.repeat(32); },
    deposit: async config => {
      deposits++; assert.equal(config.amountUnits, 800000n); assert.equal(config.confirmations, 2);
      assert.equal(config.fundId, id('dbusk-top10'));
      await config.onBroadcast({ stage: 'approval', txHash: '0x' + '56'.repeat(32) });
      if (failDeposit) throw new Error('Wallet refused deposit');
      await config.onBroadcast({ stage: 'deposit', txHash });
      return { txHash };
    } });
  await view.load();
  await button('Release & match').listeners[0]();
  assert.equal(sourceSends, 1); assert.equal(deposits, 0); assert.ok(button('Deposit USDC')); assert.equal(locked, false);
  acceptDeposit = true;
  await button('Deposit USDC').listeners[0]();
  assert.equal(sourceSends, 1); assert.equal(leg.match.deposit.status, 'deposit-pending');
  assert.equal(JSON.parse([...entries.values()][0]).hash, undefined, 'approval hash is never a deposit hash');
  assert.ok(button('Review unsent'));
  await button('Review unsent').listeners[0]();
  assert.equal(entries.size, 0); assert.equal(leg.match.source.status, 'paid');
  failDeposit = false;
  await button('Deposit USDC').listeners[0]();
  assert.equal(sourceSends, 1); assert.equal(deposits, 2); assert.equal(claim.status, 'paid');
  assert.equal(entries.size, 0); assert.equal(locked, false);
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

test('Supporter payroll sends one #75 from the admin wallet only after a journaled preparation, then settles', async t => {
  const { createSupporterPayroll } = await import('../js/supporter-payroll.mjs');
  const previous = global.window;
  t.after(() => { if (previous === undefined) delete global.window; else global.window = previous; });
  global.window = { _wallet: { address: owner } };
  const node = tag => ({ tag, children: [], listeners: [], classList: { add() {}, remove() {}, toggle() {} },
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
    addEventListener(_, fn) { this.listeners.push(fn); } });
  const doc = { createElement: node };
  const root = { ...node('section'), ownerDocument: doc };
  const walk = n => [n, ...(n.children || []).flatMap(walk)];
  const buttons = () => walk(root).filter(n => n.tag === 'button');
  const statusText = () => walk(root).find(n => n.className?.includes('supporter-payroll-status')).textContent;
  const winner = '0x' + '56'.repeat(20);
  let delivery = null, revision = 4, balance = 1n, sent = null, settleAfter = 2, waits = 0;
  const entries = new Map();
  const storage = { getItem: k => entries.get(k) || null, setItem: (k, v) => entries.set(k, v), removeItem: k => entries.delete(k) };
  const state = () => ({ revision, campaigns: [{ id: 'offer-1', title: 'Spring', curatedReferrerNames: { [winner]: 'Within' },
    supporterToken: { eligibleWallets: [winner], deliveries: delivery ? [delivery] : [] } }] });
  const actions = [];
  const sign = async c => {
    actions.push(c);
    assert.equal(c.revision, revision);
    revision++;
    if (c.action === 'prepare-supporter') delivery = { wallet: winner, status: 'transfer-pending' };
    if (c.action === 'reconcile-supporter') delivery = { ...delivery, txHash: c.txHash,
      status: actions.filter(a => a.action === 'reconcile-supporter').length >= settleAfter ? 'delivered' : 'transfer-pending' };
    if (c.action === 'release-supporter-preparation') delivery = { ...delivery, status: 'owed' };
    return state();
  };
  const token = { balanceOf: async () => balance };
  token.safeTransferFrom = async (...args) => {
    assert.equal(actions.at(-1).action, 'prepare-supporter', 'server preparation must be persisted first');
    assert.ok(entries.size, 'journal must exist before wallet broadcast');
    sent = args;
    return { hash: txHash, wait: async confirmations => { waits++; assert.equal(confirmations, 2); } };
  };
  token.safeTransferFrom.staticCall = async () => {};
  const getWallet = async () => ({ address: owner, signer: {}, check: async () => {}, ethers: { Contract: function () { return token; } } });
  let answer = 'Wallet history shows nothing sent', promptDefault;
  const view = createSupporterPayroll({ root, fetchState: async () => state(), sign, getWallet, storage,
    ask: (_, initial) => { promptDefault = initial; return answer; }, confirmAction: () => true });
  await view.load();
  assert.deepEqual(buttons().map(b => b.textContent), ['🎖 Send']);

  balance = 0n;
  await buttons()[0].listeners[0]();
  assert.match(statusText(), /holds no Supporter #75/);
  assert.equal(actions.length, 0);

  balance = 1n;
  await buttons()[0].listeners[0]();
  assert.deepEqual(actions.map(a => a.action), ['prepare-supporter', 'reconcile-supporter', 'reconcile-supporter']);
  assert.deepEqual(sent, [owner, winner, 75n, 1n, '0x']);
  assert.equal(entries.size, 0);
  assert.deepEqual(buttons(), []);

  actions.length = 0;
  delivery = { wallet: winner, status: 'transfer-pending' };
  await view.load();
  assert.deepEqual(buttons().map(b => b.textContent), ['🔎 Check', '↩']);
  await buttons()[1].listeners[0]();
  assert.deepEqual(actions.map(a => [a.action, a.reason, a.confirmNoBroadcast]),
    [['release-supporter-preparation', answer, true]]);
  assert.deepEqual(buttons().map(b => b.textContent), ['🎖 Send']);

  actions.length = 0;
  delivery = { wallet: winner, status: 'transfer-pending', txHash };
  entries.set(`decentbusking:supporter-delivery:offer-1:${winner}`, JSON.stringify({ hash: txHash }));
  const replacementHash = '0x' + 'cd'.repeat(32);
  answer = replacementHash;
  await view.load();
  await buttons()[0].listeners[0]();
  assert.equal(promptDefault, txHash);
  assert.equal(actions[0].txHash, replacementHash);
  assert.equal(JSON.parse([...entries.values()][0]).hash, replacementHash);
  assert.match(statusText(), /still confirming/);

  actions.length = 0;
  entries.clear();
  delivery = null;
  settleAfter = 1;
  await view.load();
  await buttons()[0].listeners[0]();
  assert.deepEqual(actions.map(action => action.action), ['prepare-supporter', 'reconcile-supporter']);
  assert.equal(waits, 1, 'an already confirmed first reconciliation must not wait or reconcile again');
  assert.equal(entries.size, 0);
  assert.deepEqual(buttons(), []);
});

test('earned Supporter notifications remain after campaign closure until delivery', async () => {
  const { activeReferralInvites, renderReferralInviteCard } = await import('../js/profile-inbox.mjs');
  const wallet = '0x' + '12'.repeat(20);
  const now = Date.parse('2026-11-15T00:00:00Z');
  const profile = { wallet, campaignId: 'offer-1', title: 'Referral', status: 'archived',
    endsAt: '2026-11-10T00:00:00Z', claimDeadline: '2026-11-11T00:00:00Z',
    supporterToken: { eligible: true, delivery: 'owed' },
    gifts: [{ trigger: 'participation', amountUnits: '0', supporter: true }],
    giftAwards: [{ trigger: 'participation', amountUnits: '0', status: 'supporter-only' }] };
  assert.deepEqual(activeReferralInvites({ participantProfiles: [profile] }, wallet, now), [profile]);
  const node = tag => ({ tag, children: [], dataset: {}, style: { setProperty() {} },
    classList: { add() {}, remove() {} }, append(...items) { this.children.push(...items); },
    setAttribute() {}, addEventListener() {} });
  const doc = { createElement: node };
  const walk = n => [n, ...(n.children || []).flatMap(walk)];
  const card = renderReferralInviteCard(profile, { wallet, doc, now });
  assert.ok(walk(card).some(n => n.textContent === '🎖 awaiting delivery'));
  assert.match(walk(card).find(n => n.className?.includes('inbox-gift')).textContent, /🎁$/);
  profile.supporterToken.delivery = 'delivered';
  assert.deepEqual(activeReferralInvites({ participantProfiles: [profile] }, wallet, now), []);
  const deliveredCard = renderReferralInviteCard(profile, { wallet, doc, now });
  assert.match(walk(deliveredCard).find(n => n.className?.includes('inbox-gift')).textContent, /✅$/);
});

test('fixed ETH amounts show a live USD estimate only when a quote is available', async () => {
  const { ethWithUsd } = await import('../js/eth-usd-quote.mjs');
  assert.equal(ethWithUsd('2000000000000000', 3350), '0.002 ETH ($6.70)');
  assert.equal(ethWithUsd('1500000000000000000', null), '1.5 ETH');
});

test('For You pinner cards show verified day progress until owed rewards settle', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  t.after(() => previous ? Object.defineProperty(globalThis, 'sessionStorage', previous) : delete globalThis.sessionStorage);
  const quote = JSON.stringify({ rate: 3000, savedAt: Date.now() });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => quote, setItem() {} } });
  const { activePinnerCampaigns, renderPinnerCampaignCard } = await import('../js/profile-inbox.mjs');
  const wallet = '0x' + '34'.repeat(20);
  const now = Date.parse('2026-12-10T00:00:00Z');
  const stats = { wallet, campaignId: 'pin-1', template: 'pinner', title: 'Pin Reward', status: 'published', asset: 'eth',
    startsAt: '2026-11-28T05:00:00Z', endsAt: '2026-12-28T05:00:00Z', qualifyingDays: 3, maxAwards: 5,
    rewardUnits: '1000000000000000', completedDays: 2, nodeStatus: 'active', eligible: false, rank: null,
    claimStatus: 'not-submitted', pendingUnits: '0', approvedUnits: '0', paidUnits: '0', nftGifts: [],
    days: [{ day: '2026-11-29', successfulChecks: 24, failedChecks: 0, qualified: true },
      { day: '2026-11-30', successfulChecks: 3, failedChecks: 9, qualified: false },
      { day: '2026-12-01', successfulChecks: 22, failedChecks: 1, qualified: true }] };
  const other = { ...stats, wallet: '0x' + '56'.repeat(20) };
  assert.deepEqual(activePinnerCampaigns({ participantProfiles: [stats, other] }, wallet, now), [stats]);
  const node = tag => ({ tag, children: [], dataset: {}, style: { setProperty() {} },
    classList: { add() {}, remove() {} }, append(...items) { this.children.push(...items); },
    setAttribute() {}, addEventListener() {} });
  const walk = n => [n, ...(n.children || []).flatMap(walk)];
  const card = renderPinnerCampaignCard(stats, { doc: { createElement: node }, now, site: 'https://example.test/' });
  const nodes = walk(card);
  assert.ok(nodes.some(n => n.textContent === '2/3'));
  assert.equal(nodes.filter(n => n.className === 'is-done').length, 2);
  assert.ok(nodes.some(n => n.textContent === 'Keep pinning · 1 days to go'));
  assert.ok(nodes.some(n => n.textContent === '🎁 Pin 3 days → get 0.001 ETH ($3.00)'));
  const ended = Date.parse('2027-01-10T00:00:00Z');
  assert.deepEqual(activePinnerCampaigns({ participantProfiles: [stats] }, wallet, ended), []);
  const owed = { ...stats, approvedUnits: '1000000000000000' };
  assert.deepEqual(activePinnerCampaigns({ participantProfiles: [owed] }, wallet, ended), [owed]);
});

test('Supporter queue reports blocked browser storage without breaking the payroll panel', async t => {
  const { loadSupporterPayroll } = await import('../js/supporter-payroll.mjs');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  t.after(() => previous ? Object.defineProperty(globalThis, 'localStorage', previous) : delete globalThis.localStorage);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
  const root = { textContent: '' };
  await loadSupporterPayroll({ getElementById: () => root });
  assert.match(root.textContent, /Supporter queue unavailable: Storage blocked/);
});

test('pinner campaign popout keeps a draft in place, separates requirements and steps through one funding button', async () => {
  const editor = await import('../js/pinner-campaign-editor.mjs');
  const shared = await import('../js/promotions.mjs');
  const draft = { id: 'draft-1', status: 'draft', template: 'pinner', title: 'Test Pilot Pin Reward Campaign', asset: 'eth',
    qualificationVersion: shared.PINNER_CAMPAIGN_VERSION, rewardUnits: '100000000000000', maxAwards: 5, qualifyingDays: 1,
    startsAt: '2026-11-28T17:00:00.000Z', endsAt: '2026-12-05T17:00:00.000Z', claimDeadline: '2027-01-05T17:00:00.000Z',
    supporterRewards: [{ chainId: 8453, contract: '0xe63ec9f8228720baac2fd528c0a6d06b3dc5439b', tokenId: '77', quantity: 1 }] };
  const values = editor.pinnerEditorValues({ campaign: draft });
  assert.equal(values.id, 'draft-1');
  assert.equal(values.qualifyingDays, 1);
  assert.equal(values.daysTouched, true);
  assert.equal(editor.pinnerEditorValues({ source: { ...draft, qualifyingDays: 30 }, startsAt: '2030-01-01T05:00:00.000Z' }).qualifyingDays, 7);

  const usdc = editor.pinnerCampaignPayload({ ...values, asset: 'usdc', rewardUnits: '5000000', qualifyingDays: 6 });
  assert.equal(usdc.asset, 'usdc');
  assert.equal(usdc.budgetUnits, '25000000');
  assert.equal(usdc.fund, shared.PINNER_CAMPAIGN_FUND);
  assert.match(usdc.terms, /first to complete 6 qualifying/);
  assert.throws(() => editor.pinnerCampaignPayload({ ...values, qualifyingDays: 7 }), /Required days must be 1–6/);
  const multi = editor.pinnerCampaignPayload({ ...values, qualifyingDays: 6, extras: { ommm: '1000000000000000000', usdc: '2000000' } });
  assert.deepEqual(multi.extraRewards.map(x => [x.asset, x.budgetUnits]), [['usdc', '10000000'], ['ommm', '5000000000000000000']]);
  assert.match(multi.terms, /Plus 2\.00 USDC and 1 Ommm per approved participant/);
  assert.equal(editor.pinnerCampaignPayload({ ...values, qualifyingDays: 6 }).extraRewards, undefined);
  assert.deepEqual(editor.pinnerEditorValues({ campaign: { ...draft, extraRewards: multi.extraRewards } }).extras,
    { usdc: '2000000', ommm: '1000000000000000000' });

  const campaigns = [
    { id: 'other', fund: shared.PINNER_CAMPAIGN_FUND, status: 'published', asset: 'eth', budgetUnits: '300', paidUnits: '100' },
    { id: 'usdc', fund: shared.PINNER_CAMPAIGN_FUND, status: 'published', asset: 'usdc', budgetUnits: '999' },
    { id: 'draft-1', fund: shared.PINNER_CAMPAIGN_FUND, status: 'draft', asset: 'eth', budgetUnits: '500' },
  ];
  assert.deepEqual(editor.pinnerFundAvailability({ balanceUnits: '450', campaigns, campaignId: 'draft-1', asset: 'eth', needUnits: 500n }),
    { balance: 450n, others: 200n, free: 250n, shortfall: 250n });

  const step = state => editor.pinnerNextStep({ money: units => `${units}u`, ...state });
  assert.equal(step({ fund: { exists: false } }).step, 'create');
  assert.equal(step({ fund: { exists: true, active: false } }).step, 'restore');
  assert.deepEqual(step({ fund: { exists: true, active: true }, shortfallUnits: 250n }), { step: 'fund', label: '▶ Fund 250u & Activate' });
  assert.deepEqual(step({ fund: { exists: true, active: true } }), { step: 'activate', label: '▶ Sign & Activate' });
  assert.equal(step({ fund: { exists: true, active: true }, shortfallText: 'Ξ0.01 + $5.00' }).label, '▶ Fund Ξ0.01 + $5.00 & Activate');
  assert.equal(editor.pinnerFundAvailability({ balanceUnits: '100', asset: 'usdc', needUnits: 50n, campaigns: [{ id: 'x',
    fund: shared.PINNER_CAMPAIGN_FUND, status: 'published', asset: 'eth', budgetUnits: '1', extraRewards: [{ asset: 'usdc', budgetUnits: '80' }],
    bonusAwards: [{ asset: 'usdc', status: 'paid', amountUnits: '20' }] }] }).others, 60n);
  assert.equal(step({ valid: false, fund: { exists: false } }).step, 'blocked');
});
