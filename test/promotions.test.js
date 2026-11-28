const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet, Interface, id, ZeroHash } = require('../discord-bot/node_modules/ethers');
const owner = Wallet.createRandom();
const alice = Wallet.createRandom();
const bob = Wallet.createRandom();
const carol = Wallet.createRandom();
const dave = Wallet.createRandom();
const routerAddress = '0x' + 'ab'.repeat(20);
const txHash = '0x' + 'ab'.repeat(32);
const blockHash = '0x' + '12'.repeat(32);
const origin = 'https://busking.example';
const epoch = Date.parse('2026-10-30T18:00:00Z');
const input = (extra = {}) => ({ template: 'album', title: 'Bring an album', criteria: 'Approved album with delivery proof',
  terms: 'One reward, public evidence and activity on IPFS, admin review, no stacking. Disputes reviewed by steward.',
  rewardUnits: '10000000', budgetUnits: '10000000', maxAwards: 1, minOriginalTracks: 3, minPurchaseUnits: '5000000',
  requiredReferrals: 2, activityWindow: 'current-week',
  startsAt: '2026-10-30T17:00:00Z', endsAt: '2026-11-06T18:00:00Z',
  claimDeadline: '2026-11-13T18:00:00Z', ...extra });

async function fixture(options = {}) {
  const { createPromotions } = await import('../discord-bot/promotions.js');
  const shared = await import('../js/promotions.mjs');
  let stored = null, clock = epoch, balance = 100000000n, receipt = null, transaction = null;
  const provider = { getNetwork: async () => ({ chainId: 8453n }), getTransactionReceipt: async () => receipt,
    getTransaction: async () => transaction, getBlockNumber: async () => 100, getBlock: async () => ({ hash: blockHash }) };
  const cfg = { restore: async () => stored, save: async next => { stored = structuredClone(next); return 'ipfs://checkpoint'; },
    provider, routerAddress, ownerWallet: owner.address, readFunding: async () => balance,
    voteOnRadio: async v => ({ playId: v.playId, vote: v.vote }), now: () => clock, ...options };
  const service = createPromotions(cfg);
  const body = async (command, who = owner, overrides = {}) => {
    const b = { command, address: who.address, origin, issuedAt: new Date(clock).toISOString(), ...overrides };
    b.signature = await who.signMessage(shared.promotionAuthorization(b));
    return b;
  };
  const view = async (who = owner) => service.execute(await body({ action: 'view' }, who), origin);
  const exec = async (c, who = owner) => service.execute(await body({ revision: (await view(who)).revision, ...c }, who), origin);
  const create = async campaign => {
    const snapshot = await exec({ action: 'save', campaign: campaign || input() });
    return snapshot.campaigns.at(-1);
  };
  const publish = c => exec({ action: 'status', campaignId: c.id, status: 'published' });
  const join = (c, who = alice, referrer = '') => exec({ action: 'join', campaignId: c.id, referrer,
    acceptTerms: true, termsVersion: c.version }, who);
  const claim = async (c, who = alice) => {
    const result = await exec({ action: 'claim', campaignId: c.id, evidence: 'Catalog and approved delivery proof' }, who);
    return result.claims.at(-1);
  };
  return { service, cfg, exec, view, body, create, publish, join, claim, shared,
    stored: () => stored, setTime: t => { clock = t; }, setBalance: b => { balance = b; },
    setReceipt: r => { receipt = r ? { blockHash, ...r } : r; }, setTransaction: tx => { transaction = tx; } };
}
test('pinner pilot persists only as a capped ETH draft with an unconfigured NFT and cannot be published', async () => {
  const f = await fixture();
  const draftQuote = { ethUsdMicros: '4000000000', quotedAt: new Date(epoch).toISOString() };
  const amounts = f.shared.pinnerPromotionAmounts(draftQuote.ethUsdMicros);
  assert.equal(amounts.rewardUnits, '1250000000000000');
  assert.equal(amounts.budgetUnits, '6250000000000000');
  const campaign = await f.create(input({ template: 'pinner', asset: 'eth', maxAwards: 5, draftQuote, ...amounts }));
  assert.equal(campaign.status, 'draft');
  assert.equal(campaign.asset, 'eth');
  assert.equal(campaign.pinnerPilot.qualifyingDays, 30);
  assert.equal(campaign.pinnerPilot.nftReward, null);
  const { validatePromotionCheckpoint } = await import('../discord-bot/promotions.js');
  assert.doesNotThrow(() => validatePromotionCheckpoint(f.stored()));
  await assert.rejects(f.publish(campaign), /draft-only/);
  const publicState = await f.service.publicState();
  assert.equal(publicState.campaigns[0].status, 'draft', 'draft records remain public under the existing IPFS policy');
  const { publicCalendarData } = await import('../js/dbusk-calendar-core.mjs');
  assert.equal(publicCalendarData({}, publicState).campaigns.length, 0, 'drafts are not advertised on the public calendar');
  const invalid = structuredClone(f.stored());
  invalid.campaigns[0].status = 'published';
  assert.throws(() => validatePromotionCheckpoint(invalid), /Invalid promotions checkpoint/);
  await assert.rejects(f.create(input({ template: 'pinner', asset: 'eth', maxAwards: 6, draftQuote, ...amounts })), /five.*25/);
});

test('custom campaign drafts reuse the promotion checkpoint and are publicly browsable without approving rewards or copying settlement state', async () => {
  const f = await fixture();
  const custom = await f.create(input({ template: 'custom', title: 'Community workshop', criteria: 'Workshop evidence reviewed by steward' }));
  assert.equal(custom.status, 'draft');
  const publicState = await f.service.publicState();
  assert.equal(publicState.campaigns.find(c => c.id === custom.id).template, 'custom');
  const { validatePromotionCheckpoint, createPromotions } = await import('../discord-bot/promotions.js');
  assert.doesNotThrow(() => validatePromotionCheckpoint(f.stored()));
  const restored = createPromotions({ ...f.cfg, restore: async () => f.stored() });
  assert.equal((await restored.publicState()).campaigns.find(c => c.id === custom.id).criteria, custom.criteria);
  const duplicate = await f.create(input({ template: 'custom', title: custom.title, criteria: custom.criteria }));
  assert.notEqual(duplicate.id, custom.id);
  assert.equal(duplicate.status, 'draft');
  assert.equal(duplicate.paidUnits, '0');
  await assert.rejects(f.exec({ action: 'save', campaign: input({ template: 'custom' }) }, alice), /owner|admin/i);
});
test('pinning campaigns publish funded fixed bonuses with editable timeboxes, no implicit NFT and immutable terms', async () => {
  const f = await fixture({ readPinnerProgress: () => ({ status: 'not-enrolled', days: [], completedDays: 0 }) });
  const campaignInput = input({ template: 'pinner', qualificationVersion: f.shared.PINNER_CAMPAIGN_VERSION,
    asset: 'eth', maxAwards: 5, qualifyingDays: 3, supporterRewards: [], fund: 'dbusk-promotionals',
    rewardUsdCents: 500, draftQuote: { ethUsdMicros: '4000000000', quotedAt: new Date(epoch).toISOString() },
    ...f.shared.pinnerEthAmounts('2000000000000000', 5) });
  const c = await f.create(campaignInput);
  assert.equal(c.fund, f.shared.PINNER_CAMPAIGN_FUND, 'pinner bonuses always draw from their own allocation');
  assert.equal(c.rewardUnits, '2000000000000000');
  assert.equal(c.budgetUnits, '10000000000000000');
  assert.equal(c.draftQuote, undefined);
  assert.equal(c.rewardUsdCents, undefined);
  assert.match(c.terms, /0\.002 ETH per approved participant\. The ETH amount is fixed/);
  assert.match(c.terms, /from dbusk-pinner-campaigns/);
  await assert.rejects(f.create({ ...campaignInput, budgetUnits: '20000000000000000' }), /Invalid fixed bonus/);
  const huge = f.shared.pinnerEthAmounts('100000000000000000000', 1);
  await assert.rejects(f.create({ ...campaignInput, maxAwards: 1, rewardUnits: `${huge.rewardUnits}1`, budgetUnits: `${huge.budgetUnits}1` }), /at most 100 ETH/);
  await assert.rejects(f.create(input({ fund: f.shared.PINNER_CAMPAIGN_FUND })), /dedicated/);
  assert.match(c.terms, /3 qualifying full New York calendar days/);
  assert.match(c.terms, /No NFT gift is promised/);
  assert.match(c.terms, /separately from ordinary weekly USDC/);
  f.setBalance(BigInt(c.budgetUnits) - 1n);
  await assert.rejects(f.publish(c), /Fund balance/);
  f.setBalance(BigInt(c.budgetUnits));
  await f.publish(c);
  const { publicCalendarData } = await import('../js/dbusk-calendar-core.mjs');
  const publicState = await f.service.publicState();
  assert.equal(publicCalendarData({}, publicState).campaigns[0].portal.id, c.id);
  assert.deepEqual(f.shared.supporterRewardQueue(publicState.campaigns), []);
  await assert.rejects(f.exec({ action: 'save', campaignId: c.id, campaign: campaignInput }), /immutable/);
  const later = await f.create(campaignInput);
  f.setTime(epoch + 3600000);
  f.setBalance(BigInt(c.budgetUnits) * 2n);
  await f.publish(later);
  assert.equal((await f.view()).campaigns.find(x => x.id === later.id).status, 'published', 'fixed ETH bonuses need no quote refresh');
  f.setTime(epoch);
  await assert.rejects(f.create({ ...campaignInput, qualifyingDays: 30 }), /fit inside/);
  const unconfigured = await fixture();
  const missing = await unconfigured.create(campaignInput);
  await assert.rejects(unconfigured.publish(missing), /qualification is not configured/);
  const { validatePromotionCheckpoint } = await import('../discord-bot/promotions.js');
  const invalid = structuredClone(f.stored());
  invalid.campaigns[0].rewardUnits = '1';
  assert.throws(() => validatePromotionCheckpoint(invalid), /Invalid promotions checkpoint/);
});

test('pinning campaigns can promise a fixed USDC bonus from the same pinner fund without changing ETH terms', async () => {
  const f = await fixture({ readPinnerProgress: () => ({ status: 'not-enrolled', days: [], completedDays: 0 }) });
  assert.deepEqual((await f.view()).features.pinnerCampaignAssets, ['eth', 'usdc']);
  const usdc = input({ template: 'pinner', qualificationVersion: f.shared.PINNER_CAMPAIGN_VERSION,
    asset: 'usdc', maxAwards: 4, qualifyingDays: 3, supporterRewards: [],
    ...f.shared.pinnerCampaignAmounts('5000000', 4, 'usdc') });
  const c = await f.create(usdc);
  assert.equal(c.asset, 'usdc');
  assert.equal(c.fund, f.shared.PINNER_CAMPAIGN_FUND);
  assert.equal(c.budgetUnits, '20000000');
  assert.match(c.terms, /5\.00 USDC per approved participant\. The USDC amount is fixed\./);
  assert.doesNotMatch(c.terms, /live estimate/);
  await assert.rejects(f.create({ ...usdc, asset: 'dai' }), /ETH or USDC/);
  await assert.rejects(f.create({ ...usdc, budgetUnits: '20000001' }), /Invalid fixed bonus/);
  f.setBalance(20000000n);
  await f.publish(c);
  assert.equal((await f.view()).campaigns.find(x => x.id === c.id).status, 'published');
  const eth = { ...usdc, asset: 'eth', ...f.shared.pinnerEthAmounts('2000000000000000', 4) };
  assert.match((await f.create(eth)).terms, /0\.002 ETH per approved participant\. The ETH amount is fixed; any USD value shown is a live estimate/);
  const { validatePromotionCheckpoint } = await import('../discord-bot/promotions.js');
  assert.doesNotThrow(() => validatePromotionCheckpoint(structuredClone(f.stored())));
});

test('pinning requirements default to about 90% of the full New York days in the timebox', async () => {
  const shared = await import('../js/promotions.mjs');
  assert.equal(shared.pinnerCampaignFullDays('2026-11-28T17:00:00.000Z', '2026-12-05T17:00:00.000Z'), 6);
  assert.equal(shared.pinnerDefaultQualifyingDays('2026-11-28T17:00:00.000Z', '2026-12-05T17:00:00.000Z'), 6);
  assert.equal(shared.pinnerDefaultQualifyingDays('2026-12-01T05:00:00.000Z', '2026-12-31T05:00:00.000Z'), 27);
  assert.equal(shared.pinnerDefaultQualifyingDays('2026-12-01T05:00:00.000Z', '2026-12-11T05:00:00.000Z'), 9);
  assert.equal(shared.pinnerDefaultQualifyingDays('2026-12-01T05:00:00.000Z', '2026-12-01T12:00:00.000Z'), 1);
});

test('pinning bonuses use first-finisher order, deduplicate identities, expose profile stats and permit separate repeat campaigns', async () => {
  const { newYorkDayPeriod } = await import('../js/payroll-week.mjs');
  const wallets = [alice, bob, carol, dave, Wallet.createRandom(), Wallet.createRandom()];
  const progress = new Map();
  let unavailable = false;
  const f = await fixture({ readPinnerProgress: request => {
    if (unavailable) throw new Error('Node evidence unavailable');
    const row = progress.get(request.wallet);
    return row ? { ...row, participantKey: id(`${request.campaignId}:${row.identity}`) } :
      { status: 'not-enrolled', completedDays: 0, days: [], completedAt: null };
  } });
  const c = await f.create(input({ template: 'pinner', qualificationVersion: f.shared.PINNER_CAMPAIGN_VERSION,
    asset: 'eth', maxAwards: 5, qualifyingDays: 1, supporterRewards: [],
    ...f.shared.pinnerEthAmounts('1250000000000000', 5) }));
  f.setBalance(1000000000000000000n);
  await f.publish(c);
  for (const who of wallets) await f.join(c, who);
  await assert.rejects(f.claim(c), /Finish the required/);
  for (const [index, who] of wallets.entries()) {
    const day = { ...newYorkDayPeriod(new Date(Date.UTC(2026, 9, 31 + index)).toISOString().slice(0, 10)),
      successfulChecks: 18, failedChecks: 2, qualified: true };
    progress.set(who.address.toLowerCase(), { status: 'active', identity: who.address.toLowerCase(),
      completedDays: 1, completedAt: day.endAt, days: [day] });
  }
  f.setTime(Date.parse('2026-11-06T05:00:00Z'));
  const rankedWallets = wallets;
  const winner = rankedWallets[0], last = rankedWallets.at(-1);
  const profiles = (await f.service.publicState()).participantProfiles;
  assert.equal(profiles.find(p => p.wallet === winner.address.toLowerCase()).rank, 1);
  assert.equal(profiles.find(p => p.wallet === last.address.toLowerCase()).eligible, false);
  await assert.rejects(f.claim(c, last), /first campaign bonus slots/);
  const claim = await f.claim(c, winner);
  const approved = await f.exec({ action: 'review', claimId: claim.id, decision: 'approved', reason: 'Verified daily probe journal' });
  assert.equal(approved.claims[0].fund, 'dbusk-pinner-campaigns');
  assert.equal((await f.view(winner)).participantStats.find(p => p.campaignId === c.id).approvedUnits, claim.amountUnits);
  assert.deepEqual(f.shared.supporterRewardQueue(approved.campaigns), []);
  unavailable = true;
  assert.equal((await f.service.publicState()).participantProfiles[0].nodeStatus, 'unavailable');
  await assert.rejects(f.claim(c, rankedWallets[1]), /Node evidence unavailable/);
  unavailable = false;
  // Another wallet for one Discord identity cannot win a second slot.
  progress.get(rankedWallets[1].address.toLowerCase()).identity = winner.address.toLowerCase();
  assert.equal((await f.service.publicState()).participantProfiles.find(p =>
    p.wallet === rankedWallets[1].address.toLowerCase()).eligible, false);
  const { validatePromotionCheckpoint, createPromotions } = await import('../discord-bot/promotions.js');
  assert.doesNotThrow(() => validatePromotionCheckpoint(f.stored()));
  const restored = createPromotions({ ...f.cfg, restore: async () => f.stored() });
  assert.equal((await restored.publicState()).participantProfiles.find(p => p.wallet === winner.address.toLowerCase()).approvedUnits, claim.amountUnits);
  // A second campaign is a new offer, not another draw from weekly pinning USDC.
  const next = await f.create({ ...c, id: undefined, title: 'Second pinning campaign',
    startsAt: '2026-11-06T05:00:00Z', endsAt: '2026-11-09T05:00:00Z', claimDeadline: '2026-11-16T05:00:00Z' });
  await f.publish(next); await f.join(next, winner);
  const day = { ...newYorkDayPeriod('2026-11-07'), successfulChecks: 20, failedChecks: 0, qualified: true };
  progress.set(winner.address.toLowerCase(), { status: 'active', identity: winner.address.toLowerCase(),
    completedDays: 1, completedAt: day.endAt, days: [day] });
  f.setTime(Date.parse(day.endAt));
  const second = await f.claim(next, winner);
  await f.exec({ action: 'review', claimId: second.id, decision: 'approved', reason: 'Separate campaign qualification' });
  assert.doesNotThrow(() => validatePromotionCheckpoint(f.stored()));
});

test('optional pinning NFTs require sufficient inventory and enter the existing protected delivery queue only after approval', async () => {
  const { newYorkDayPeriod } = await import('../js/payroll-week.mjs');
  let stock = 4n;
  const day = { ...newYorkDayPeriod('2026-10-31'), successfulChecks: 20, failedChecks: 0, qualified: true };
  const f = await fixture({ readSupporterInventory: async () => ({ erc1155: true, balanceUnits: stock }),
    readPinnerProgress: ({ wallet }) => ({ status: 'active', participantKey: id(wallet),
      completedDays: 1, completedAt: day.endAt, days: [day] }) });
  const c = await f.create(input({ template: 'pinner', qualificationVersion: f.shared.PINNER_CAMPAIGN_VERSION,
    asset: 'eth', maxAwards: 5, qualifyingDays: 1,
    supporterRewards: [f.shared.SUPPORTER_REWARD], ...f.shared.pinnerEthAmounts('1250000000000000', 5) }));
  f.setBalance(BigInt(c.budgetUnits));
  await assert.rejects(f.publish(c), /inventory cannot cover 5/);
  stock = 5n;
  await f.publish(c); await f.join(c);
  f.setTime(Date.parse(day.endAt));
  const claim = await f.claim(c);
  assert.deepEqual(f.shared.supporterRewardQueue((await f.view()).campaigns), []);
  const approved = await f.exec({ action: 'review', claimId: claim.id, decision: 'approved', reason: 'Verified node campaign' });
  assert.equal(f.shared.supporterRewardQueue(approved.campaigns)[0].token.tokenId, '75');
  await f.exec({ action: 'prepare-supporter', campaignId: c.id, wallet: alice.address,
    tokenKey: f.shared.supporterRewardKey() });
  await assert.rejects(f.exec({ action: 'review', claimId: claim.id, decision: 'rejected', reason: 'Cannot reverse pending NFT' }), /NFT transfer/);
});
test('pinning campaigns can add fixed USDC and Ommm extras with per-asset funding and their own payout ledger', async () => {
  const { newYorkDayPeriod } = await import('../js/payroll-week.mjs');
  const balances = { eth: 0n, usdc: 0n, ommm: 0n };
  const day = { ...newYorkDayPeriod('2026-10-31'), successfulChecks: 20, failedChecks: 0, qualified: true };
  const f = await fixture({ readFunding: async (_, asset) => balances[asset],
    readPinnerProgress: ({ wallet }) => ({ status: 'active', participantKey: id(wallet), completedDays: 1, completedAt: day.endAt, days: [day] }) });
  assert.deepEqual((await f.view()).features.pinnerExtraRewards, ['eth', 'usdc', 'ommm']);
  const base = input({ template: 'pinner', qualificationVersion: f.shared.PINNER_CAMPAIGN_VERSION, asset: 'eth', maxAwards: 2,
    qualifyingDays: 1, supporterRewards: [], ...f.shared.pinnerEthAmounts('1000000000000000', 2) });
  const ommm = '500000000000000000000';
  const extraRewards = [{ asset: 'usdc', rewardUnits: '3000000' }, { asset: 'ommm', rewardUnits: ommm }];
  await assert.rejects(f.create({ ...base, extraRewards: [{ asset: 'eth', rewardUnits: '1' }] }), /once/);
  const c = await f.create({ ...base, extraRewards });
  assert.deepEqual(c.extraRewards.map(x => x.budgetUnits), ['6000000', '1000000000000000000000']);
  assert.match(c.terms, /Plus 3\.00 USDC and 500 Ommm per approved participant; these amounts are also fixed\./);
  assert.doesNotMatch((await f.create(base)).terms, /Plus/, 'terms without extras stay unchanged');
  Object.assign(balances, { eth: 2000000000000000n, usdc: 6000000n, ommm: 999n });
  await assert.rejects(f.publish(c), /Ommm fund balance/);
  balances.ommm = 1000000000000000000000n;
  await f.publish(c); await f.join(c);
  f.setTime(Date.parse(day.endAt));
  const claim = await f.claim(c);
  const approved = await f.exec({ action: 'review', claimId: claim.id, decision: 'approved', reason: 'Verified node campaign' });
  const awards = approved.campaigns.find(x => x.id === c.id).bonusAwards;
  assert.deepEqual(awards.map(a => [a.id, a.asset, a.amountUnits, a.status]),
    [[`usdc-${claim.id}`, 'usdc', '3000000', 'approved'], [`ommm-${claim.id}`, 'ommm', ommm, 'approved']]);
  const stats = (await f.view(alice)).participantStats.find(p => p.campaignId === c.id);
  assert.deepEqual(stats.extraRewards.map(x => [x.asset, x.status]), [['usdc', 'approved'], ['ommm', 'approved']]);
  const { validatePromotionCheckpoint } = await import('../discord-bot/promotions.js');
  assert.doesNotThrow(() => validatePromotionCheckpoint(f.stored()));
  const tampered = structuredClone(f.stored());
  tampered.campaigns.find(x => x.id === c.id).bonusAwards[1].amountUnits = '1';
  assert.throws(() => validatePromotionCheckpoint(tampered), /Invalid promotions checkpoint/);
  balances.ommm = 1n;
  await assert.rejects(f.exec({ action: 'prepare-gift', campaignId: c.id, giftId: `ommm-${claim.id}`, wallet: alice.address }), /cover/);
  balances.ommm = 1000000000000000000000n;
  await f.exec({ action: 'prepare-gift', campaignId: c.id, giftId: `ommm-${claim.id}`, wallet: alice.address });
  await assert.rejects(f.exec({ action: 'review', claimId: claim.id, decision: 'rejected', reason: 'Too late' }), /extra bonus payment/);
});
async function matchFixture({ slots = 1, gifts = [], rewards, stock = 11n } = {}) {
  const musician = Wallet.createRandom();
  const f = await fixture({ readPlaylist: () => [{ trackId: 'match-track', title: 'Trial song', mintStatus: 'minted', tokenId: '7',
    mintRecipient: musician.address }], readSupporterInventory: async () => ({ erc1155: true, balanceUnits: stock }) });
  const share = '200000000000000';
  const campaignInput = input({ template: 'musician-referral', asset: 'eth', rewardUnits: '800000000000000',
    budgetUnits: (800000000000000n * BigInt(slots)).toString(), maxAwards: slots, requiredVotes: 10,
    legAmounts: { referrer: share, musician: share, 'dbusk-top10': share, 'dbusk-playback': share },
    curatedReferrers: [alice.address], gifts, settlementVersion: f.shared.REFERRAL_SETTLEMENT_VERSION,
    supporterRewards: rewards || [f.shared.SUPPORTER_REWARD],
    fundMatchQuote: { ethUsdMicros: '4000000000', quotedAt: new Date(epoch).toISOString() } });
  f.setBalance(950000000000000n * BigInt(slots));
  const campaign = (await f.exec({ action: 'run', campaign: campaignInput })).campaigns[0];
  const qualify = async () => {
    await f.join(campaign, alice);
    await f.exec({ action: 'join', campaignId: campaign.id, referrer: alice.address, trackId: 'match-track',
      acceptTerms: true, termsVersion: campaign.version }, musician);
    for (let i = 0; i < 10; i++) await f.exec({ action: 'vote', campaignId: campaign.id, playId: `match-song-${i}`,
      voterId: `match-browser-${i}-0000000000`, subjectWallet: musician.address, vote: 1 }, musician);
    const claim = (await f.exec({ action: 'claim', campaignId: campaign.id, musicianWallet: musician.address,
      evidence: 'Minted track and ten votes' }, alice)).claims[0];
    return (await f.exec({ action: 'review', claimId: claim.id, decision: 'approved', reason: 'Verified newcomer' })).claims[0];
  };
  const iface = new Interface([
    'event PayrollPaid(bytes32 indexed fundId,address indexed asset,address indexed recipient,uint256 amount,bytes32 workReference,bytes32 repositoryIdHash,bytes32 contributorIdHash,string metadataUri,bytes32 metadataHash)',
    'event FundFunded(bytes32 indexed fundId,address indexed asset,address indexed funder,uint256 amount)',
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  ]);
  const payoutReceipt = (claim, legId, recipient, extra = {}) => {
    const event = iface.encodeEventLog('PayrollPaid', [id(f.shared.REFERRALS_FUND), f.shared.CAMPAIGN_ASSETS.eth.address,
      recipient, BigInt(share), id(f.shared.promotionWorkReference(claim, legId)), id('repo'), id('recipient'), '', ZeroHash]);
    return { status: 1, to: routerAddress, blockNumber: 99, logs: [{ ...event, address: routerAddress }], ...extra };
  };
  const depositReceipt = (fund, extra = {}) => {
    const funded = iface.encodeEventLog('FundFunded', [id(fund), f.shared.PROMOTIONS_USDC, owner.address, 800000n]);
    const transfer = iface.encodeEventLog('Transfer', [owner.address, routerAddress, 800000n]);
    return { status: 1, to: routerAddress, blockNumber: 99, logs: [
      { ...funded, address: routerAddress }, { ...transfer, address: f.shared.PROMOTIONS_USDC }], ...extra };
  };
  return { ...f, campaign, campaignInput, musician, qualify, iface, payoutReceipt, depositReceipt };
}

test('four-way 0.0008 ETH trial debits the referral fund and settles only after both exact receipts', async () => {
  const f = await matchFixture();
  const queue = async () => f.shared.referralFundMatchQueue((await f.view()).campaigns, (await f.view()).claims, epoch);
  assert.deepEqual(await queue(), []);
  const claim = await f.qualify();
  const target = legId => ({ claimId: claim.id, legId });
  assert.deepEqual((await queue()).map(item => [item.fund, item.amountUnits, item.usdcUnits]), [
    ['dbusk-top10', '200000000000000', '800000'], ['dbusk-playback', '200000000000000', '800000']]);
  await assert.rejects(f.exec({ action: 'prepare-fund-match-deposit', ...target('dbusk-top10') }), /source payout/);
  await assert.rejects(f.exec({ action: 'reconcile-funding-leg', ...target('dbusk-top10'), txHash }), /two-stage/);
  let balance = 950000000000000n;
  f.setTime(Date.parse(f.campaign.endsAt) + 1000);
  for (const [i, legId, recipient] of [[1, 'referrer', alice.address], [2, 'musician', f.musician.address]]) {
    await f.exec({ action: 'prepare-payment', ...target(legId) });
    f.setReceipt(f.payoutReceipt(claim, legId, recipient));
    await f.exec({ action: 'reconcile', ...target(legId), txHash: `0x${String(i).repeat(64)}` });
    balance -= 200000000000000n; f.setBalance(balance);
  }
  assert.deepEqual((await f.view()).campaigns[0].supporterToken.eligibleWallets, [alice.address.toLowerCase()],
    'post-campaign fund matching must not prevent the earned Supporter basket');
  f.setTime(Date.parse(f.campaign.endsAt) + 1000);
  await f.exec({ action: 'prepare-fund-match-source', ...target('dbusk-top10') });
  await assert.rejects(f.exec({ action: 'prepare-fund-match-source', ...target('dbusk-top10') }), /unresolved/);
  for (const wrong of [
    f.payoutReceipt(claim, 'dbusk-top10', alice.address),
    f.payoutReceipt(claim, 'dbusk-playback', owner.address),
    f.payoutReceipt(claim, 'dbusk-top10', owner.address, { to: alice.address }),
  ]) {
    f.setReceipt(wrong);
    await assert.rejects(f.exec({ action: 'reconcile-fund-match-source', ...target('dbusk-top10'), txHash }), /proofs|target/);
  }
  f.setReceipt(f.payoutReceipt(claim, 'dbusk-top10', owner.address, { blockNumber: 100 }));
  await f.exec({ action: 'reconcile-fund-match-source', ...target('dbusk-top10'), txHash });
  await assert.rejects(f.exec({ action: 'release-fund-match-preparation', ...target('dbusk-top10'),
    phase: 'source', confirmNoBroadcast: true, reason: 'Not authorized with a recorded hash' }), /unbroadcast/);
  f.setReceipt(f.payoutReceipt(claim, 'dbusk-top10', owner.address));
  let state = await f.exec({ action: 'reconcile-fund-match-source', ...target('dbusk-top10'), txHash });
  balance -= 200000000000000n; f.setBalance(balance);
  assert.equal(state.campaigns[0].paidUnits, '600000000000000');
  assert.equal(state.claims[0].legs[2].status, 'funding-needed');
  const { referralFundAvailability } = await import('../js/referral-campaign-editor.mjs');
  assert.equal(referralFundAvailability({ balanceUnits: balance, campaigns: state.campaigns, asset: 'eth', budgetUnits: 0n }).available, 150000000000000n);
  await assert.rejects(f.exec({ action: 'review', claimId: claim.id, decision: 'rejected', reason: 'Do not undo a source payment' }), /reverse/);
  await assert.rejects(f.exec({ action: 'amend', campaignId: f.campaign.id, budgetIncreaseUnits: '800000000000000',
    reason: 'Late amendment' }), /after fund matching starts/);
  const originalGetBlock = f.cfg.provider.getBlock;
  f.cfg.provider.getBlock = async () => ({ hash: ZeroHash });
  await assert.rejects(f.exec({ action: 'prepare-fund-match-deposit', ...target('dbusk-top10') }), /no longer canonical/);
  f.cfg.provider.getBlock = originalGetBlock;
  await f.exec({ action: 'prepare-fund-match-deposit', ...target('dbusk-top10') });
  const depositHash = '0x' + 'cd'.repeat(32);
  for (const wrong of [
    f.depositReceipt('dbusk-playback'),
    f.depositReceipt('dbusk-top10', { logs: f.depositReceipt('dbusk-top10').logs.slice(0, 1) }),
    f.depositReceipt('dbusk-top10', { to: alice.address }),
  ]) {
    f.setReceipt(wrong);
    await assert.rejects(f.exec({ action: 'reconcile-fund-match-deposit', ...target('dbusk-top10'), txHash: depositHash }), /proofs|target/);
  }
  for (const args of [
    [id('dbusk-top10'), f.shared.PROMOTIONS_ETH, owner.address, 800000n],
    [id('dbusk-top10'), f.shared.PROMOTIONS_USDC, alice.address, 800000n],
    [id('dbusk-top10'), f.shared.PROMOTIONS_USDC, owner.address, 800001n],
  ]) {
    const event = f.iface.encodeEventLog('FundFunded', args);
    f.setReceipt(f.depositReceipt('dbusk-top10', { logs: [
      { ...event, address: routerAddress }, f.depositReceipt('dbusk-top10').logs[1]] }));
    await assert.rejects(f.exec({ action: 'reconcile-fund-match-deposit', ...target('dbusk-top10'), txHash: depositHash }), /proofs/);
  }
  const originalDepositHash = '0x' + '78'.repeat(32);
  f.setReceipt(null);
  await f.exec({ action: 'reconcile-fund-match-deposit', ...target('dbusk-top10'), txHash: originalDepositHash });
  f.setReceipt(f.depositReceipt('dbusk-top10'));
  const routerIface = new Interface(f.shared.PROMOTIONS_ROUTER_ABI);
  const data = routerIface.encodeFunctionData('fundToken', [id('dbusk-top10'), f.shared.PROMOTIONS_USDC, 800000n]);
  f.cfg.provider.getTransaction = async hash => ({ from: owner.address, to: routerAddress, data, value: 0n,
    nonce: hash === originalDepositHash ? 9 : 10 });
  await assert.rejects(f.exec({ action: 'reconcile-fund-match-deposit', ...target('dbusk-top10'), txHash: depositHash }), /replaces the original/);
  f.cfg.provider.getTransaction = async () => ({ from: owner.address, to: routerAddress, data, value: 0n, nonce: 9 });
  f.setReceipt(f.depositReceipt('dbusk-top10'));
  state = await f.exec({ action: 'reconcile-fund-match-deposit', ...target('dbusk-top10'), txHash: depositHash });
  assert.equal(state.claims[0].legs[2].status, 'paid');
  await f.exec({ action: 'prepare-fund-match-source', ...target('dbusk-playback') });
  await assert.rejects(f.exec({ action: 'reconcile-fund-match-source', ...target('dbusk-playback'), txHash }), /already assigned/);
  f.setReceipt(f.payoutReceipt(claim, 'dbusk-playback', owner.address));
  await f.exec({ action: 'reconcile-fund-match-source', ...target('dbusk-playback'), txHash: '0x' + '34'.repeat(32) });
  balance -= 200000000000000n; f.setBalance(balance);
  assert.equal(balance, 150000000000000n);
  await f.exec({ action: 'prepare-fund-match-deposit', ...target('dbusk-playback') });
  await assert.rejects(f.exec({ action: 'reconcile-fund-match-deposit', ...target('dbusk-playback'), txHash: depositHash }), /already assigned/);
  f.setReceipt(f.depositReceipt('dbusk-playback'));
  state = await f.exec({ action: 'reconcile-fund-match-deposit', ...target('dbusk-playback'), txHash: '0x' + '56'.repeat(32) });
  assert.equal(state.claims[0].status, 'paid');
  assert.equal(state.campaigns[0].paidUnits, '800000000000000');
  const { validatePromotionCheckpoint, createPromotions } = await import('../discord-bot/promotions.js');
  validatePromotionCheckpoint(f.stored());
  const damaged = structuredClone(f.stored()); damaged.claims[0].legs[2].match.usdcUnits = '900000';
  assert.throws(() => validatePromotionCheckpoint(damaged), /Invalid promotions checkpoint/);
  const restarted = createPromotions({ ...f.cfg, restore: async () => f.stored() });
  assert.equal((await restarted.publicState()).claims[0].legs[2].match.source.txHash, txHash);
});

test('unfilled slots create no fund-match obligations and stale quotes or missing Supporters block publication', async () => {
  const f = await matchFixture({ slots: 2 });
  const claim = await f.qualify();
  assert.deepEqual(f.shared.referralFundMatchQueue((await f.view()).campaigns, (await f.view()).claims, epoch), []);
  await assert.rejects(f.exec({ action: 'prepare-fund-match-source', claimId: claim.id, legId: 'dbusk-top10' }), /after the campaign/);
  f.setTime(Date.parse(f.campaign.endsAt) + 1000);
  assert.equal(f.shared.referralFundMatchQueue((await f.view()).campaigns, (await f.view()).claims,
    Date.parse(f.campaign.endsAt) + 1000).length, 2);
  await assert.rejects(f.exec({ action: 'run', campaign: f.campaignInput }), /Refresh the publication quote/);
  await assert.rejects(matchFixture({ stock: 0n }), /Admin must hold/);
});

test('Supporter basket delivery binds contract, token, recipient and receipt identity and restores per-token status', async () => {
  const { SUPPORTER_REWARD, supporterRewardKey } = await import('../js/promotions.mjs');
  const custom = { ...SUPPORTER_REWARD, contract: '0x' + 'cd'.repeat(20), tokenId: '123', name: 'Other Supporter' };
  const f = await matchFixture({ rewards: [SUPPORTER_REWARD, custom],
    gifts: [{ trigger: 'participation', amountUnits: '0', supporter: true }] });
  await f.qualify();
  const target = token => ({ campaignId: f.campaign.id, wallet: alice.address, tokenKey: supporterRewardKey(token) });
  await assert.rejects(f.exec({ action: 'prepare-supporter', ...target({ ...custom, tokenId: '124' }) }), /not in the published/);
  await f.exec({ action: 'prepare-supporter', ...target(custom) });
  await f.exec({ action: 'prepare-supporter', ...target(SUPPORTER_REWARD) });
  const iface = new Interface(f.shared.SUPPORTER_REWARD_ABI);
  const receipt = (token, recipient = alice.address, quantity = 1n) => {
    const event = iface.encodeEventLog('TransferSingle', [owner.address, owner.address, recipient, BigInt(token.tokenId), quantity]);
    return { status: 1, to: token.contract, blockNumber: 99, logs: [{ ...event, address: token.contract }] };
  };
  for (const wrong of [receipt(SUPPORTER_REWARD), receipt(custom, bob.address), receipt(custom, alice.address, 2n)]) {
    f.setReceipt(wrong);
    await assert.rejects(f.exec({ action: 'reconcile-supporter', ...target(custom), txHash }), /target|exactly/);
  }
  f.setReceipt(receipt(custom));
  await f.exec({ action: 'reconcile-supporter', ...target(custom), txHash });
  await assert.rejects(f.exec({ action: 'reconcile-supporter', ...target(SUPPORTER_REWARD), txHash }), /already assigned/);
  f.setReceipt(receipt(SUPPORTER_REWARD));
  await f.exec({ action: 'reconcile-supporter', ...target(SUPPORTER_REWARD), txHash: '0x' + 'ef'.repeat(32) });
  const { createPromotions } = await import('../discord-bot/promotions.js');
  const restarted = createPromotions({ ...f.cfg, restore: async () => f.stored() });
  const queue = f.shared.supporterRewardQueue((await restarted.publicState()).campaigns);
  assert.deepEqual(queue.map(item => [item.token.tokenId, item.status]), [['75', 'delivered'], ['123', 'delivered']]);
});
test('drafts, evidence and attribution are public without a wallet and recover after restart', async () => {
  const f = await fixture();
  const c = await f.create();
  assert.equal((await f.service.publicState()).campaigns[0].status, 'draft');
  await f.publish(c); await f.join(c); const claim = await f.claim(c);
  assert.equal((await f.view(bob)).claims[0].id, claim.id);
  const publicState = await f.service.publicState();
  assert.equal(publicState.claims[0].evidence, claim.evidence);
  assert.equal(publicState.members[0].wallet, alice.address.toLowerCase());
  assert.match(publicState.notice, /public.*IPFS/);
  publicState.claims[0].evidence = 'Changed outside the service';
  assert.equal((await f.service.publicState()).claims[0].evidence, claim.evidence);
  const { createPromotions } = await import('../discord-bot/promotions.js');
  const restarted = createPromotions({ ...f.cfg, restore: async () => f.stored() });
  assert.equal((await restarted.execute(await f.body({ action: 'view' }, alice), origin)).claims[0].id, claim.id);
  assert.equal((await f.view()).claims[0].status, 'submitted');
});
test('campaign totals distinguish review, approval and pending payment', async () => {
  const f = await fixture(); const c = await f.create(); await f.publish(c); await f.join(c);
  const claim = await f.claim(c);
  let summary = (await f.view()).campaigns[0];
  assert.equal(summary.awaitingReview, 1);
  assert.equal(summary.remainingUnits, '10000000');
  await f.exec({ action: 'review', claimId: claim.id, decision: 'approved', reason: 'Reviewed' });
  summary = (await f.view()).campaigns[0];
  assert.equal(summary.awaitingReview, 0);
  assert.equal(summary.approvedUnits, '10000000');
  assert.equal(summary.paymentPendingUnits, '0');
  await f.exec({ action: 'prepare-payment', claimId: claim.id });
  summary = (await f.view()).campaigns[0];
  assert.equal(summary.approvedUnits, '0');
  assert.equal(summary.paymentPendingUnits, '10000000');
  assert.equal(summary.remainingUnits, '0');
});
test('authorization binds wallet, origin, exact command and expiry; only admin can edit or pay', async () => {
  const f = await fixture(); const c = await f.create();
  await assert.rejects(f.exec({ action: 'status', campaignId: c.id, status: 'published' }, alice), /admin/);
  const b = await f.body({ action: 'view' });
  b.command.action = 'save';
  await assert.rejects(f.service.execute(b, origin), /authorization/);
  const b2 = await f.body({ action: 'view' });
  await assert.rejects(f.service.execute(b2, 'https://evil.example'), /authorization/);
  f.setTime(epoch + 301000);
  await assert.rejects(f.service.execute(await f.body({ action: 'view' }, owner, { issuedAt: new Date(epoch).toISOString() }), origin), /expired/);
});
test('invalid caps, money, dates and terms fail; publishing requires budget and freezes terms', async () => {
  const f = await fixture();
  for (const change of [{ maxAwards: 0 }, { rewardUnits: '-1' }, { budgetUnits: '1' }, { criteria: '' },
    { terms: '' }, { endsAt: '2026-10-01' }, { template: 'fake' }]) {
    await assert.rejects(f.create(input(change)));
  }
  const c = await f.create();
  f.setBalance(1n);
  await assert.rejects(f.publish(c), /balance/);
  f.setBalance(10000000n);
  await f.publish(c);
  await assert.rejects(f.exec({ action: 'save', campaignId: c.id, campaign: input() }), /immutable/);
  const c2 = await f.create();
  await assert.rejects(f.publish(c2), /earmarked/);
});
test('registration signs the exact published terms and respects opening, closing and claim boundaries', async () => {
  const f = await fixture(); const c = await f.create(); await f.publish(c);
  f.setTime(Date.parse(c.startsAt) - 1);
  await assert.rejects(f.join(c), /not accepting/);
  f.setTime(Date.parse(c.startsAt));
  await assert.rejects(f.exec({ action: 'join', campaignId: c.id, acceptTerms: false, termsVersion: c.version }, alice), /Accept/);
  await assert.rejects(f.exec({ action: 'join', campaignId: c.id, acceptTerms: true, termsVersion: 999 }, alice), /Accept/);
  await f.join(c);
  const member = (await f.view(alice)).members[0];
  assert.equal(member.termsVersion, c.version);
  assert.equal(member.acceptedAt, c.startsAt);
  f.setTime(Date.parse(c.endsAt));
  await assert.rejects(f.join(c, bob), /not accepting/);
  f.setTime(Date.parse(c.claimDeadline));
  assert.equal((await f.claim(c)).status, 'submitted');
  await assert.rejects(f.create(input({ startsAt: '2026-02-31T12:00:00Z' })), /Invalid/);
  await assert.rejects(f.create(input({ startsAt: '2026-10-30T12:00' })), /timezone/);
});
test('dedicated promotional sources have separate budget accounting and exclude payroll funds', async () => {
  const f = await fixture({ readFunding: async () => 10000000n });
  await assert.rejects(f.create(input({ fund: 'dbusk-playback' })), /dedicated/);
  const one = await f.create(input({ fund: 'dbusk-promotionals-album' }));
  const two = await f.create(input({ fund: 'dbusk-promotionals-referral' }));
  await f.publish(one); await f.publish(two);
  await f.join(one, alice); await f.join(two, bob);
  const a = await f.claim(one, alice), b = await f.claim(two, bob);
  await f.exec({ action: 'review', claimId: a.id, decision: 'approved', reason: 'Reviewed' });
  await f.exec({ action: 'review', claimId: b.id, decision: 'approved', reason: 'Reviewed' });
  assert.deepEqual(new Set((await f.view()).claims.map(c => c.fund)), new Set([one.fund, two.fund]));
});
test('first-sponsor matching is a bounded draft and cannot publish an unsupported fund transfer', async () => {
  const f = await fixture();
  const c = await f.create(input({ template: 'sponsor-match', matchTargetFund: 'dbusk-playback',
    minContributionUnits: '5000000' }));
  assert.equal(c.status, 'draft');
  assert.equal(c.matchTargetFund, 'dbusk-playback');
  await assert.rejects(f.publish(c), /draft-only/);
  await assert.rejects(f.create(input({ template: 'sponsor-match', matchTargetFund: 'dbusk-promotionals',
    minContributionUnits: '5000000' })), /different/);
});
test('referral qualification needs two registered new wallets voting this New York week, either direction', async () => {
  const f = await fixture(); const c = await f.create(input({ template: 'referral' }));
  await f.publish(c); await f.join(c, alice);
  await assert.rejects(f.join(c, bob, bob.address), /Referrer/);
  await f.join(c, bob, alice.address);
  await assert.rejects(f.claim(c), /Two registered/);
  await f.exec({ action: 'vote', campaignId: c.id, playId: 'live-song', voterId: 'browser_bob_000000', vote: -1 }, bob);
  await f.join(c, carol, alice.address);
  await assert.rejects(f.exec({ action: 'vote', campaignId: c.id, playId: 'live-song', voterId: 'browser_bob_000000', vote: 1 }, carol), /browser/);
  await f.exec({ action: 'vote', campaignId: c.id, playId: 'live-song', voterId: 'browser_carol_0000', vote: 1 }, carol);
  const claim = await f.claim(c);
  assert.deepEqual(new Set(claim.qualification.wallets), new Set([bob.address.toLowerCase(), carol.address.toLowerCase()]));
  assert.ok(claim.qualification.activity.every(vote => vote.playId === 'live-song' && vote.at && vote.week === claim.qualification.week));
  f.setTime(Date.parse('2026-11-02T05:00:00Z'));
  await assert.rejects(f.exec({ action: 'review', claimId: claim.id, decision: 'approved', reason: 'Reviewed people and evidence' }), /this New York week/);
  await f.exec({ action: 'vote', campaignId: c.id, playId: 'new-song', voterId: 'browser_bob_000000', vote: 1 }, bob);
  await f.exec({ action: 'vote', campaignId: c.id, playId: 'new-song', voterId: 'browser_carol_0000', vote: -1 }, carol);
  const approved = await f.exec({ action: 'review', claimId: claim.id, decision: 'approved', reason: 'Reviewed' });
  assert.equal(approved.claims[0].status, 'approved');
  assert.ok(approved.claims[0].qualification.activity.every(vote => vote.playId === 'new-song'));
  const { createPromotions } = await import('../discord-bot/promotions.js');
  const corrupt = structuredClone(f.stored());
  corrupt.claims[0].qualification.activity[0].playId = 'forged';
  await assert.rejects(createPromotions({ ...f.cfg, restore: async () => corrupt }).publicState(), /checkpoint/);
});
test('referral count and activity window are editable, published, and enforced at review', async () => {
  const f = await fixture();
  await assert.rejects(f.create(input({ template: 'referral', requiredReferrals: 1 })), /referral/);
  await assert.rejects(f.create(input({ template: 'referral', activityWindow: 'unknown' })), /activity window/);
  const c = await f.create(input({ template: 'referral', requiredReferrals: 3, activityWindow: 'offer-window',
    endsAt: '2026-11-13T18:00:00Z', claimDeadline: '2026-11-20T18:00:00Z' }));
  await f.publish(c); await f.join(c, alice);
  for (const [person, browser] of [[bob, 'browser_bob_000000'], [carol, 'browser_carol_0000'], [dave, 'browser_dave_00000']]) {
    await f.join(c, person, alice.address);
    await f.exec({ action: 'vote', campaignId: c.id, playId: 'song', voterId: browser, vote: 1 }, person);
    if (person === carol) await assert.rejects(f.claim(c), /3 registered referrals/);
  }
  f.setTime(Date.parse('2026-11-02T05:00:00Z'));
  const participation = (await f.view(alice)).participation[0];
  assert.equal(participation.activeThisWeek, 0);
  assert.equal(participation.activeDuringOffer, 3);
  const claim = await f.claim(c);
  assert.equal(claim.qualification.wallets.length, 3);
  assert.equal(claim.qualification.window, 'offer-window');
  await f.exec({ action: 'review', claimId: claim.id, decision: 'approved', reason: 'Reviewed people and activity' });
  assert.equal((await f.view()).claims[0].status, 'approved');
  await assert.rejects(f.exec({ action: 'save', campaignId: c.id,
    campaign: input({ template: 'referral', requiredReferrals: 2, activityWindow: 'current-week' }) }), /immutable/);
});
test('activity and referral counts are scoped to each offer, including later registrations', async () => {
  const f = await fixture();
  const first = await f.create(), second = await f.create(input({ template: 'referral' }));
  await f.publish(first); await f.publish(second);
  await f.join(first, alice); await f.join(second, alice);
  await f.join(first, bob, alice.address); await f.join(second, carol, alice.address);
  await f.exec({ action: 'vote', campaignId: first.id, playId: 'song', voterId: 'browser_bob_000000', vote: 1 }, bob);
  await f.exec({ action: 'vote', campaignId: second.id, playId: 'song', voterId: 'browser_carol_0000', vote: -1 }, carol);
  await f.join(first, dave);
  await f.exec({ action: 'vote', campaignId: first.id, playId: 'song', voterId: 'browser_dave_00000', vote: 1 }, dave);
  f.setTime(epoch + 1000);
  await f.join(second, dave);
  assert.equal((await f.view(dave)).participation.find(p => p.campaignId === second.id).voted, false);
  await f.exec({ action: 'vote', campaignId: second.id, playId: 'song', voterId: 'browser_dave_00000', vote: 1 }, dave);
  assert.equal((await f.view(dave)).participation.find(p => p.campaignId === second.id).voted, true);
  const participation = (await f.view(alice)).participation;
  for (const offer of [first, second]) {
    const result = participation.find(p => p.campaignId === offer.id);
    assert.equal(result.registered, 1);
    assert.equal(result.activeThisWeek, 1);
  }
  await assert.rejects(f.claim(second, alice), /Two registered/);
});
test('the admin can audit attribution corrections but cannot rewrite reserved referral evidence', async () => {
  const f = await fixture(); const c = await f.create(input({ template: 'referral' }));
  await f.publish(c); await f.join(c, alice); await f.join(c, dave); await f.join(c, bob, alice.address);
  const correction = { action: 'correct-attribution', campaignId: c.id, memberWallet: bob.address,
    referrer: dave.address, reason: 'Reviewed original invitation' };
  await assert.rejects(f.exec(correction, alice), /admin/);
  await f.exec(correction);
  assert.equal((await f.view()).members.find(m => m.wallet === bob.address.toLowerCase()).attributionHistory.length, 1);
  await f.join(c, carol, dave.address);
  await f.exec({ action: 'vote', campaignId: c.id, playId: 'song', voterId: 'browser_bob_000000', vote: 1 }, bob);
  await f.exec({ action: 'vote', campaignId: c.id, playId: 'song', voterId: 'browser_carol_0000', vote: -1 }, carol);
  const claim = await f.claim(c, dave);
  await f.exec({ action: 'review', claimId: claim.id, decision: 'approved', reason: 'Reviewed' });
  await assert.rejects(f.exec({ ...correction, referrer: alice.address, reason: 'Dispute' }), /frozen evidence/);
});
test('buddy claims distinguish helper and musician and cannot duplicate a reserved referral', async () => {
  const f = await fixture(); const referral = await f.create(input({ template: 'referral' }));
  await f.publish(referral); await f.join(referral, alice);
  await f.join(referral, bob, alice.address); await f.join(referral, carol, alice.address);
  await f.exec({ action: 'vote', campaignId: referral.id, playId: 'song', voterId: 'browser_bob_000000', vote: 1 }, bob);
  await f.exec({ action: 'vote', campaignId: referral.id, playId: 'song', voterId: 'browser_carol_0000', vote: -1 }, carol);
  const referred = await f.claim(referral, alice);
  await f.exec({ action: 'review', claimId: referred.id, decision: 'approved', reason: 'Reviewed' });
  const buddy = await f.create(input({ template: 'buddy' })); await f.publish(buddy);
  await f.join(buddy, dave); await f.join(buddy, bob);
  const command = { action: 'claim', campaignId: buddy.id, evidence: 'Approved recording', subjectWallet: bob.address };
  await assert.rejects(f.exec({ ...command, subjectWallet: dave.address }, dave), /different wallets/);
  const claimed = (await f.exec(command, dave)).claims.find(c => c.campaignId === buddy.id);
  await assert.rejects(f.exec({ ...command, subjectWallet: bob.address }, bob), /different wallets/);
  await assert.rejects(f.exec({ action: 'review', claimId: claimed.id, decision: 'approved', reason: 'Reviewed' }), /already counted/);
});
test('failed radio votes cannot create qualification and anonymous votes are not silently attributed', async () => {
  const f = await fixture({ voteOnRadio: async () => { throw new Error('Song ended'); } });
  const c = await f.create(); await f.publish(c); await f.join(c);
  await assert.rejects(f.exec({ action: 'vote', campaignId: c.id, voterId: 'browser_alice_0000', playId: 'ended', vote: 1 }, alice), /Song ended/);
  assert.equal((await f.view(alice)).activity.voted, false);
  assert.equal(f.stored().votes.length, 0);
});
test('a previously anonymous vote cannot become qualifying activity after registration', async () => {
  let duplicate = true;
  const f = await fixture({ voteOnRadio: async v => ({ ...v, duplicate }) });
  const c = await f.create(); await f.publish(c); await f.join(c);
  const vote = { action: 'vote', campaignId: c.id, voterId: 'browser_alice_0000', playId: 'song', vote: 1 };
  await assert.rejects(f.exec(vote, alice), /earlier anonymous/);
  assert.equal(f.stored().votes.length, 0);
  duplicate = false;
  await f.exec({ ...vote, playId: 'next-song' }, alice);
  duplicate = true;
  await f.exec({ ...vote, playId: 'next-song' }, alice);
  assert.equal(f.stored().votes.length, 1);
});
test('active-listener week changes exactly at New York midnight after DST fallback', async () => {
  const f = await fixture(); const c = await f.create(); await f.publish(c); await f.join(c);
  f.setTime(Date.parse('2026-11-02T04:59:59.999Z'));
  await f.exec({ action: 'vote', campaignId: c.id, playId: 'live-song', voterId: 'browser_alice_0000', vote: -1 }, alice);
  assert.deepEqual((await f.view(alice)).activity, { week: 'NY-2026-10-26', voted: true });
  f.setTime(Date.parse('2026-11-02T05:00:00Z'));
  assert.deepEqual((await f.view(alice)).activity, { week: 'NY-2026-11-02', voted: false });
});
test('sponsor rewards require a confirmed positive matching DVert conversion and reject duplicate claims', async () => {
  const source = '0x' + 'cd'.repeat(20);
  const f = await fixture({ devertContractAddress: source });
  const c = await f.create(input({ template: 'sponsor', budgetUnits: '20000000', maxAwards: 2 }));
  await f.publish(c); await f.join(c); await f.join(c, bob);
  const iface = new Interface(['event CampaignCreated(uint256 indexed campaignId,address indexed advertiser,uint64 indexed weekId,string title,string audioURI,uint128 offerUnits,uint64 startedAt,uint64 expiresAt)']);
  const transferInterface = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const purchaseLogs = (campaignId = 1n, amount = 20000000n, startedAt = BigInt(epoch / 1000)) => [{
    address: f.shared.PROMOTIONS_USDC, ...transferInterface.encodeEventLog('Transfer', [carol.address, source, amount]),
  }, {
    address: source, ...iface.encodeEventLog('CampaignCreated', [campaignId, carol.address, 1n, 'Ad', 'ipfs://ad', amount,
      startedAt, startedAt + 86400n]),
  }];
  const makeReceipt = (extra = {}) => ({ status: 1, blockNumber: 99, logs: purchaseLogs(), ...extra });
  const command = { action: 'claim', campaignId: c.id, evidence: 'Sponsor campaign proof',
    purchaseHash: txHash, purchaser: carol.address, advertId: '1' };
  await assert.rejects(f.exec({ ...command, purchaser: alice.address }, alice), /self-referrals/);
  await assert.rejects(f.exec(command, alice), /two confirmed/);
  f.setReceipt(makeReceipt({ blockNumber: 100 }));
  await assert.rejects(f.exec(command, alice), /two confirmed/);
  f.setReceipt(makeReceipt({ blockHash: txHash }));
  await assert.rejects(f.exec(command, alice), /canonical/);
  f.setReceipt(makeReceipt({ logs: [makeReceipt().logs[1]] }));
  await assert.rejects(f.exec(command, alice), /purchase transfer/);
  f.setReceipt(makeReceipt({ logs: purchaseLogs(1n, 4999999n) }));
  await assert.rejects(f.exec(command, alice), /below the published minimum/);
  f.setReceipt(makeReceipt({ logs: purchaseLogs(1n, 20000000n, BigInt(Date.parse(c.endsAt) / 1000)) }));
  await assert.rejects(f.exec(command, alice), /No matching/);
  f.setReceipt(makeReceipt({ logs: [...purchaseLogs(), purchaseLogs(2n)[1]] }));
  await assert.rejects(f.exec({ ...command, advertId: '2' }, alice), /purchase transfer/);
  f.setReceipt(makeReceipt());
  await assert.rejects(f.exec({ ...command, purchaser: bob.address }, alice), /No matching/);
  await assert.rejects(f.exec({ ...command, advertId: '2' }, alice), /No matching/);
  const claimed = (await f.exec(command, alice)).claims[0];
  assert.equal(claimed.qualification.amountUnits, '20000000');
  const { createPromotions } = await import('../discord-bot/promotions.js');
  const corrupt = structuredClone(f.stored());
  corrupt.claims[0].qualification.amountUnits = '1';
  const damaged = createPromotions({ ...f.cfg, restore: async () => corrupt });
  await assert.rejects(damaged.publicState(), /checkpoint/);
  await assert.rejects(f.exec(command, bob), /already claimed/);
  f.setReceipt(makeReceipt({ logs: [] }));
  await assert.rejects(f.exec({ action: 'review', claimId: claimed.id, decision: 'approved', reason: 'Reviewed conversion',
    confirmNewAdvertiser: true, confirmRefundAndDisputeReview: true }), /No matching/);
  f.setReceipt(makeReceipt());
  await assert.rejects(f.exec({ action: 'review', claimId: claimed.id, decision: 'approved', reason: 'Reviewed conversion' }), /refund/);
  await f.exec({ action: 'review', claimId: claimed.id, decision: 'approved', reason: 'Reviewed conversion',
    confirmNewAdvertiser: true, confirmRefundAndDisputeReview: true });
  await assert.rejects(f.exec({ action: 'prepare-payment', claimId: claimed.id }), /Recheck refund/);
});
test('approvals recheck real funding and do not stack participant rewards across offers', async () => {
  const f = await fixture(); const c = await f.create(); await f.publish(c); await f.join(c);
  const a = await f.claim(c);
  f.setBalance(1n);
  await assert.rejects(f.exec({ action: 'review', claimId: a.id, decision: 'approved', reason: 'Reviewed' }), /balance/);
  assert.equal((await f.view()).claims[0].status, 'submitted');
  f.setBalance(100000000n);
  await f.exec({ action: 'review', claimId: a.id, decision: 'approved', reason: 'Reviewed' });
  f.setBalance(1n);
  await assert.rejects(f.exec({ action: 'prepare-payment', claimId: a.id }), /balance/);
  assert.equal((await f.view()).claims[0].status, 'approved');
  f.setBalance(100000000n);
  const c2 = await f.create(); await f.publish(c2); await f.join(c2);
  const a2 = await f.claim(c2);
  await assert.rejects(f.exec({ action: 'review', claimId: a2.id, decision: 'approved', reason: 'Reviewed' }), /another approved/);
});
test('restoration rejects inconsistent finances, duplicate identities and malformed checkpoint records', async () => {
  const { createPromotions } = await import('../discord-bot/promotions.js');
  const f = await fixture(); const c = await f.create(); await f.publish(c); await f.join(c); await f.claim(c);
  for (const corrupt of [
    v => { v.revision = -1; },
    v => { v.campaigns[0].rewardUnits = '0'; },
    v => { v.campaigns[0].maxAwards = 0; },
    v => { v.claims[0].amountUnits = '99999999'; },
    v => { v.claims[0].status = 'paid'; },
    v => { v.claims[0].status = 'paid'; v.claims[0].txHash = txHash; },
    v => { v.claims[0].history = null; },
    v => { v.members.push(v.members[0]); },
    v => { v.campaigns[0].id = '<unsafe>'; },
    v => { v.campaigns = []; },
  ]) {
    const checkpoint = structuredClone(f.stored()); corrupt(checkpoint);
    const restored = createPromotions({ ...f.cfg, restore: async () => checkpoint });
    await assert.rejects(restored.publicState());
    await assert.rejects(restored.execute(await f.body({ action: 'view' }), origin));
  }
});
test('concurrent last-slot approvals serialize with revision and capacity checks; duplicate claims fail', async () => {
  const f = await fixture(); const c = await f.create(); await f.publish(c);
  await f.join(c, alice); await f.join(c, bob);
  const a = await f.claim(c, alice), b = await f.claim(c, bob);
  await assert.rejects(f.claim(c, alice), /One claim/);
  const revision = (await f.view()).revision;
  const results = await Promise.allSettled([a, b].map(async claim => f.service.execute(await f.body({
    action: 'review', revision, claimId: claim.id, decision: 'approved', reason: 'Reviewed unique participant',
  }), origin)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(f.exec({ action: 'review', claimId: b.id, decision: 'approved', reason: 'Retry' }), /capacity/);
  const snapshot = await f.view();
  assert.equal(snapshot.campaigns[0].remainingAwards, 0);
  assert.equal(snapshot.campaigns[0].committedUnits, '10000000');
});
test('pause/close block new registrations, preserve existing claims and enforce deadlines/archive commitments', async () => {
  const f = await fixture(); const c = await f.create(); await f.publish(c); await f.join(c);
  await f.exec({ action: 'status', campaignId: c.id, status: 'paused' });
  await assert.rejects(f.join(c, bob), /not accepting/);
  const claim = await f.claim(c);
  await f.exec({ action: 'status', campaignId: c.id, status: 'closed' });
  await assert.rejects(f.exec({ action: 'status', campaignId: c.id, status: 'archived' }), /outstanding/);
  await f.exec({ action: 'review', claimId: claim.id, decision: 'needs-evidence', reason: 'Supply delivery proof' });
  await f.exec({ action: 'evidence', claimId: claim.id, evidence: 'Updated delivery evidence' }, alice);
  assert.equal((await f.view()).claims[0].status, 'submitted');
  f.setTime(Date.parse('2026-11-14T00:00:00Z'));
  await assert.rejects(f.claim(c, bob), /closed/);
});
test('payment proof must match fund, token, amount, reference, recipient and actual USDC transfer', async () => {
  const f = await fixture(); const c = await f.create(); await f.publish(c); await f.join(c);
  const claim = await f.claim(c);
  await f.exec({ action: 'review', claimId: claim.id, decision: 'approved', reason: 'Delivery verified' });
  await f.exec({ action: 'prepare-payment', claimId: claim.id });
  const iface = new Interface([
    'event PayrollPaid(bytes32 indexed fundId,address indexed asset,address indexed recipient,uint256 amount,bytes32 workReference,bytes32 repositoryIdHash,bytes32 contributorIdHash,string metadataUri,bytes32 metadataHash)',
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  ]);
  const payout = iface.encodeEventLog('PayrollPaid', [id(f.shared.PROMOTIONS_FUND), f.shared.PROMOTIONS_USDC,
    alice.address, 10000000n, id(f.shared.promotionWorkReference(claim)), id('repo'), id('alice'), '', ZeroHash]);
  const transfer = iface.encodeEventLog('Transfer', [routerAddress, alice.address, 10000000n]);
  const receipt = { status: 1, to: routerAddress, blockNumber: 99,
    logs: [{ ...payout, address: routerAddress }, { ...transfer, address: f.shared.PROMOTIONS_USDC }] };
  f.setReceipt(null);
  assert.equal((await f.exec({ action: 'reconcile', claimId: claim.id, txHash })).claims[0].status, 'payment-pending');
  f.setReceipt({ status: 0, to: routerAddress, blockNumber: 99 });
  await assert.rejects(f.exec({ action: 'reconcile', claimId: claim.id, txHash: '0x' + 'cd'.repeat(32) }), /Original payment/);
  assert.equal((await f.view()).claims[0].txHash, txHash);
  f.setReceipt({ ...receipt, logs: [receipt.logs[0]] });
  await assert.rejects(f.exec({ action: 'reconcile', claimId: claim.id, txHash }), /proofs/);
  f.setReceipt({ ...receipt, to: alice.address });
  await assert.rejects(f.exec({ action: 'reconcile', claimId: claim.id, txHash }), /target/);
  f.setReceipt({ ...receipt, blockHash: txHash });
  await assert.rejects(f.exec({ action: 'reconcile', claimId: claim.id, txHash }), /canonical/);
  for (const change of [{ fundId: id('another-fund') }, { asset: bob.address }, { recipient: bob.address },
    { amount: 1n }, { reference: id('wrong-reference') }]) {
    const wrong = iface.encodeEventLog('PayrollPaid', [change.fundId || id(f.shared.PROMOTIONS_FUND),
      change.asset || f.shared.PROMOTIONS_USDC, change.recipient || alice.address, change.amount || 10000000n,
      change.reference || id(f.shared.promotionWorkReference(claim)), id('repo'), id('alice'), '', ZeroHash]);
    f.setReceipt({ ...receipt, logs: [{ ...wrong, address: routerAddress }, receipt.logs[1]] });
    await assert.rejects(f.exec({ action: 'reconcile', claimId: claim.id, txHash }), /proofs/);
  }
  f.setReceipt(receipt);
  const paid = await f.exec({ action: 'reconcile', claimId: claim.id, txHash });
  assert.equal(paid.claims[0].status, 'paid');
  assert.equal(paid.campaigns[0].paidUnits, '10000000');
  await assert.rejects(f.exec({ action: 'prepare-payment', claimId: claim.id }), /not approved/);
});
test('reverted payments release only their own hash; failed storage stops further writes', async () => {
  const f = await fixture(); const c = await f.create(); await f.publish(c); await f.join(c);
  const claim = await f.claim(c);
  await f.exec({ action: 'review', claimId: claim.id, decision: 'approved', reason: 'Verified' });
  f.setReceipt({ status: 0, to: routerAddress, blockNumber: 99 });
  f.setTransaction({ to: routerAddress, from: bob.address, data: '0x' });
  await assert.rejects(f.exec({ action: 'reconcile', claimId: claim.id, txHash }), /exact owner-authorized/);
  assert.equal((await f.view()).claims[0].status, 'approved');
  const router = new Interface(f.shared.PROMOTIONS_ROUTER_ABI);
  f.setTransaction({ to: routerAddress, from: owner.address, data: router.encodeFunctionData('payout', [
    id(f.shared.PROMOTIONS_FUND), f.shared.PROMOTIONS_USDC, alice.address, 10000000n,
    id(f.shared.promotionWorkReference(claim)), id('repo'), id('alice'), '', ZeroHash,
  ]) });
  await f.exec({ action: 'reconcile', claimId: claim.id, txHash });
  assert.equal((await f.view()).claims[0].status, 'approved');
  const fail = await fixture({ save: async () => { throw new Error('Storage down'); } });
  await assert.rejects(fail.create(), /Writes stopped/);
  await assert.rejects(fail.create(), /Writes stopped/);
});

test('musician conversion reconciles direct legs separately and never marks funding allocations paid', async () => {
  const musician = Wallet.createRandom();
  const playlist = [{ trackId: 'track', title: 'Minted', mintStatus: 'minted', tokenId: '7',
    mintRecipient: musician.address }];
  const f = await fixture({ readPlaylist: () => playlist });
  const c = await f.create(input({ template: 'musician-referral', rewardUnits: '25000000',
    budgetUnits: '150000000', maxAwards: 6 }));
  f.setBalance(150000000n); await f.publish(c); await f.join(c, alice);
  await f.exec({ action: 'join', campaignId: c.id, referrer: alice.address, trackId: 'track',
    acceptTerms: true, termsVersion: c.version }, musician);
  for (let index = 0; index < 10; index++) await f.exec({ action: 'vote', campaignId: c.id,
    playId: `leg-song-${index}`, subjectWallet: musician.address,
    voterId: `browser-leg-${index}-00000000`, vote: 1 }, musician);
  const conversion = (await f.exec({ action: 'claim', campaignId: c.id, musicianWallet: musician.address,
    evidence: 'Minted playlist evidence' }, alice)).claims[0];
  const approved = await f.exec({ action: 'review', claimId: conversion.id, decision: 'approved', reason: 'All evidence present' });
  assert.equal(approved.claims[0].legs.filter(leg => leg.status === 'approved').length, 2);
  await assert.rejects(f.exec({ action: 'prepare-payment', claimId: conversion.id, legId: 'dbusk-top10' }),
    /funding-needed/);
  await f.exec({ action: 'prepare-payment', claimId: conversion.id, legId: 'referrer' });
  const iface = new Interface([
    'event PayrollPaid(bytes32 indexed fundId,address indexed asset,address indexed recipient,uint256 amount,bytes32 workReference,bytes32 repositoryIdHash,bytes32 contributorIdHash,string metadataUri,bytes32 metadataHash)',
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  ]);
  const payout = iface.encodeEventLog('PayrollPaid', [id(f.shared.REFERRALS_FUND), f.shared.PROMOTIONS_USDC,
    alice.address, 10000000n, id(f.shared.promotionWorkReference(conversion, 'referrer')), id('repo'), id('alice'), '', ZeroHash]);
  const transfer = iface.encodeEventLog('Transfer', [routerAddress, alice.address, 10000000n]);
  f.setReceipt({ status: 1, to: routerAddress, blockNumber: 99,
    logs: [{ ...payout, address: routerAddress }, { ...transfer, address: f.shared.PROMOTIONS_USDC }] });
  const reconciled = await f.exec({ action: 'reconcile', claimId: conversion.id, legId: 'referrer', txHash });
  assert.equal(reconciled.claims[0].legs.find(leg => leg.id === 'referrer').status, 'paid');
  assert.equal(reconciled.claims[0].legs.find(leg => leg.id === 'musician').status, 'approved');
  assert.deepEqual(reconciled.claims[0].legs.filter(leg => leg.kind === 'funding-needed').map(leg => leg.status),
    ['funding-needed', 'funding-needed']);
  assert.equal(reconciled.campaigns[0].paidUnits, '10000000');
  assert.equal(reconciled.campaigns[0].fundingNeededUnits, '10000000');
  const fundingHash = '0x' + 'cd'.repeat(32);
  const fundInterface = new Interface([
    'event FundFunded(bytes32 indexed fundId,address indexed asset,address indexed funder,uint256 amount)',
  ]);
  const funded = fundInterface.encodeEventLog('FundFunded', [id('dbusk-top10'),
    f.shared.PROMOTIONS_USDC, owner.address, 5000000n]);
  f.setReceipt({ status: 1, to: routerAddress, blockNumber: 98,
    logs: [{ ...funded, address: routerAddress }] });
  const fundedState = await f.exec({ action: 'reconcile-funding-leg', claimId: conversion.id,
    legId: 'dbusk-top10', txHash: fundingHash });
  assert.equal(fundedState.claims[0].legs.find(leg => leg.id === 'dbusk-top10').status, 'paid');
  assert.equal(fundedState.campaigns[0].fundingNeededUnits, '5000000');
  assert.equal(fundedState.campaigns[0].supporterToken?.eligibleWallets?.includes(alice.address.toLowerCase()) || false, false);
  f.setBalance(140000000n);
  await f.exec({ action: 'prepare-payment', claimId: conversion.id, legId: 'musician' });
});

test('first upload records its owned track on registration for retroactive musician referral', async () => {
  const musician = Wallet.createRandom();
  const f = await fixture({ readPlaylist: () => [{ trackId: 'first-upload', mintStatus: 'requested',
    tokenId: null, mintRecipient: musician.address }] });
  const c = await f.create(input({ template: 'musician-referral', rewardUnits: '25000000',
    budgetUnits: '150000000', maxAwards: 6 }));
  await f.exec({ action: 'curate-referrer', campaignId: c.id, referrer: alice.address, reason: 'Launch referrer' });
  f.setBalance(150000000n); await f.publish(c);
  await f.exec({ action: 'join', campaignId: c.id, referrer: alice.address, trackId: 'first-upload',
    acceptTerms: true, termsVersion: c.version }, musician);
  const member = f.stored().members.find(item => item.wallet === musician.address.toLowerCase());
  assert.deepEqual(member.uploadTrackIds, ['first-upload']);
  assert.equal(member.referrer, alice.address.toLowerCase());
});
test('an uncertain payment preparation locks all browsers until an audited no-broadcast review', async () => {
  const f = await fixture(); const c = await f.create(); await f.publish(c); await f.join(c);
  const claim = await f.claim(c);
  await f.exec({ action: 'review', claimId: claim.id, decision: 'approved', reason: 'Verified' });
  await f.exec({ action: 'prepare-payment', claimId: claim.id });
  await assert.rejects(f.exec({ action: 'prepare-payment', claimId: claim.id }), /unresolved/);
  await assert.rejects(f.exec({ action: 'release-payment-preparation', claimId: claim.id,
    reason: 'Looked at wallet history' }), /wallet-history/);
  await f.exec({ action: 'release-payment-preparation', claimId: claim.id,
    confirmNoBroadcast: true, reason: 'Wallet history shows the request was rejected before broadcast' });
  const released = (await f.view()).claims[0];
  assert.equal(released.status, 'approved');
  assert.equal(released.paymentHistory[0].action, 'no-broadcast-confirmed');
});
test('Discord requires an exact owner preview, journals before send, and suppresses duplicates', async () => {
  let sends = 0, f;
  const delivery = { messageId: '333', messageUrl: 'https://discord.com/channels/111/222/333',
    announcedAt: new Date(epoch).toISOString() };
  const announcements = {
    check: async () => {},
    send: async (draft, pending) => {
      sends++;
      assert.equal(f.stored().campaigns[0].announcement.status, 'pending');
      assert.equal(pending.draft.posterUrl, draft.posterUrl);
      return delivery;
    },
    reconcile: async () => delivery,
  };
  f = await fixture({ announcements, siteUrl: 'https://site.example/DecentBusking/' });
  const c = await f.create(); await f.publish(c);
  const previewCommand = { action: 'preview-discord', campaignId: c.id,
    posterUrl: 'https://site.example/poster.png', sentence: 'Come hear the new album.' };
  await assert.rejects(f.exec(previewCommand, alice), /admin/);
  await assert.rejects(f.exec({ ...previewCommand, sentence: '@everyone join' }), /sentence/);
  await assert.rejects(f.exec({ ...previewCommand, sentence: 'First sentence. Second sentence.' }), /sentence/);
  const preview = (await f.exec(previewCommand)).announcementPreview;
  assert.equal(sends, 0);
  assert.match(preview.link, /\/DecentBusking\/\?promotion=/);
  await assert.rejects(f.exec({ action: 'send-discord', campaignId: c.id,
    preview: { ...preview, link: 'https://evil.example/' } }), /preview changed/);
  const sent = await f.exec({ action: 'send-discord', campaignId: c.id, preview });
  assert.equal(sent.campaigns[0].announcement.status, 'sent');
  assert.equal((await f.service.publicState()).campaigns[0].announcement.status, 'sent');
  assert.equal((await f.exec({ action: 'send-discord', campaignId: c.id, preview })).announcementDuplicate, true);
  assert.equal(sends, 1);
});
test('uncertain Discord sends recover their journal after restart instead of sending again', async () => {
  let sends = 0;
  const delivery = { messageId: '333', messageUrl: 'https://discord.com/channels/111/222/333',
    announcedAt: new Date(epoch).toISOString() };
  const announcements = { check: async () => {}, send: async () => { sends++; throw new Error('Timeout'); },
    reconcile: async pending => { assert.match(pending.marker, /^Promotion /); return delivery; } };
  const f = await fixture({ announcements, siteUrl: 'https://site.example/' });
  const c = await f.create(); await f.publish(c);
  const preview = (await f.exec({ action: 'preview-discord', campaignId: c.id,
    posterUrl: 'https://site.example/poster.png', sentence: 'See the offer.' })).announcementPreview;
  await assert.rejects(f.exec({ action: 'send-discord', campaignId: c.id, preview }), /uncertain/);
  assert.equal(f.stored().campaigns[0].announcement.status, 'pending');
  const { createPromotions } = await import('../discord-bot/promotions.js');
  const restarted = createPromotions({ ...f.cfg, restore: async () => f.stored() });
  const revision = (await restarted.execute(await f.body({ action: 'view' }), origin)).revision;
  const result = await restarted.execute(await f.body({ action: 'reconcile-discord', campaignId: c.id, revision }), origin);
  assert.equal(result.campaigns[0].announcement.status, 'sent');
  assert.equal(sends, 1);
});
test('Discord poster delivery disables mentions and obeys cooldown', async () => {
  const { createPromotionAnnouncements } = await import('../discord-bot/promotion-announcements.js');
  let cooldown = false, payload;
  const message = { id: '333', url: 'https://discord.com/channels/111/222/333', createdTimestamp: epoch,
    author: { id: 'bot' }, embeds: [{ footer: { text: 'Promotion ' + 'ab'.repeat(16) } }] };
  const channel = { guild: {}, isTextBased: () => true, permissionsFor: () => ({ has: () => true }),
    send: async value => { payload = value; return message; }, messages: { fetch: async () => new Map([['333', message]]) } };
  const client = { user: { id: 'bot' }, isReady: () => true, channels: { fetch: async () => channel } };
  const service = createPromotionAnnouncements({ getClient: () => client, channelId: '222', canAnnounce: () => !cooldown });
  const draft = { posterUrl: 'https://site.example/poster.png', sentence: 'See the offer.', link: 'https://site.example/?promotion=abc' };
  const pending = { marker: message.embeds[0].footer.text, createdAt: new Date(epoch).toISOString() };
  await service.send(draft, pending);
  assert.deepEqual(payload.allowedMentions, { parse: [], roles: [], users: [], repliedUser: false });
  assert.equal(payload.content, `${draft.sentence}\n${draft.link}`);
  assert.equal(payload.embeds[0].image.url, draft.posterUrl);
  assert.equal((await service.reconcile(pending)).messageId, '333');
  cooldown = true;
  await assert.rejects(service.send(draft, pending), /cooldown/);
});
test('durable storage serializes competing services and recovers reservations after restart', async t => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { randomUUID } = require('node:crypto');
  const { initializePromotionStore, createPromotionStore } = await import('../discord-bot/promotions-store.js');
  const file = path.join(__dirname, `.promotions-${randomUUID()}.sqlite`);
  let remote = null;
  const checkpoint = { restore: async () => structuredClone(remote),
    getLatestSnapshotUri: () => 'ipfs://public-checkpoint',
    save: async value => { remote = structuredClone(value); return 'ipfs://public-checkpoint'; } };
  const opened = [];
  t.after(() => {
    for (const store of opened) store.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  });
  await assert.rejects(createPromotionStore({ file, checkpoint }));
  assert.equal(fs.existsSync(file), false);
  await initializePromotionStore({ file });
  await assert.rejects(initializePromotionStore({ file }), /exist/i);
  await assert.rejects(createPromotionStore({ file }), /Pinata/);
  const first = await createPromotionStore({ file, checkpoint });
  const second = await createPromotionStore({ file, checkpoint });
  opened.push(first, second);
  const a = await fixture({ restore: first.restore, save: first.save });
  const b = await fixture({ restore: second.restore, save: second.save });
  const c = await a.create(); await a.publish(c); await a.join(c, alice); await a.join(c, bob);
  const one = await a.claim(c, alice), two = await a.claim(c, bob);
  const revision = (await a.view()).revision;
  assert.equal((await b.view()).revision, revision);
  const results = await Promise.allSettled([
    a.service.execute(await a.body({ action: 'review', revision, claimId: one.id, decision: 'approved', reason: 'Reviewed' }), origin),
    b.service.execute(await b.body({ action: 'review', revision, claimId: two.id, decision: 'approved', reason: 'Reviewed' }), origin),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /changed|capacity/);
  const after = await b.view();
  assert.equal(after.claims.filter(claim => claim.status === 'approved').length, 1);
  assert.equal(after.campaigns[0].remainingAwards, 0);
  const restartedStore = await createPromotionStore({ file, checkpoint });
  opened.push(restartedStore);
  const restarted = await fixture({ restore: restartedStore.restore, save: restartedStore.save });
  assert.equal((await restarted.view()).claims.filter(claim => claim.status === 'approved').length, 1);
  assert.equal(remote.claims.filter(c => c.status === 'approved').length, 1);
  assert.ok(JSON.stringify(remote).includes(alice.address.toLowerCase()));
  assert.ok(JSON.stringify(remote).includes('Catalog and approved delivery proof'));
});
test('HTTP public listing includes claimant data without signing; mutations still require allowed origin', async () => {
  const http = require('node:http');
  const { createWorkerRequestHandler } = await import('../discord-bot/ipfs-worker.js');
  const f = await fixture(); const c = await f.create(); await f.publish(c); await f.join(c); await f.claim(c);
  const server = http.createServer(createWorkerRequestHandler({ ownerWallet: owner.address, allowedOrigins: [origin], promotions: f.service }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/promotions`;
    const result = await fetch(url);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal((await result.json()).claims[0].wallet, alice.address.toLowerCase());
    const denied = await fetch(url, { method: 'POST', headers: { origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify(await f.body({ action: 'view' })) });
    assert.equal(denied.status, 400);
    const allowed = await fetch(url, { method: 'POST', headers: { origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(await f.body({ action: 'view' }, bob)) });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).claims[0].wallet, alice.address.toLowerCase());
    server.removeAllListeners('request');
    server.on('request', createWorkerRequestHandler({ ownerWallet: owner.address, allowedOrigins: [origin] }));
    const unavailable = await fetch(url);
    assert.equal(unavailable.status, 400);
    assert.match((await unavailable.json()).error, /Promotions unavailable/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('musician pilot is $150 / six conversions with four explicit legs and all-or-nothing playlist evidence', async () => {
  const musicians = Array.from({ length: 7 }, () => Wallet.createRandom());
  const playlist = musicians.map((wallet, index) => ({ trackId: `track-${index}`, title: `Minted ${index}`,
    mintStatus: 'minted', tokenId: String(index + 1), mintRecipient: wallet.address }));
  const f = await fixture({ readPlaylist: () => playlist });
  const campaignInput = input({ template: 'musician-referral', title: 'First musician referral pilot',
    rewardUnits: '25000000', budgetUnits: '150000000', maxAwards: 6,
    endsAt: '2026-11-13T18:00:00Z', claimDeadline: '2026-11-20T18:00:00Z' });
  await assert.rejects(f.create(input({ template: 'musician-referral' })), /exact multiple|must match the breakdown/);
  const c = await f.create(campaignInput);
  assert.equal(c.rewardUnits, '25000000');
  assert.equal(BigInt(c.rewardUnits) * BigInt(c.maxAwards), 150000000n);
  f.setBalance(150000000n);
  await f.publish(c); await f.join(c, alice);
  for (const [index, musician] of musicians.slice(0, 6).entries()) {
    await f.exec({ action: 'join', campaignId: c.id, referrer: alice.address, trackId: `track-${index}`,
      acceptTerms: true, termsVersion: c.version }, musician);
    for (let vote = 0; vote < 10; vote++) {
      const playId = `song-${index}-${vote}`;
      await f.exec({ action: 'vote', campaignId: c.id, playId, subjectWallet: musician.address,
        voterId: `browser_${index}_${vote}_000000`, vote: 1 }, musician);
    }
    if (index === 0) {
      const missing = structuredClone(musicians[1]);
      void missing;
      const view = (await f.view(alice)).participantStats[0];
      const progress = view.referred.find(item => item.wallet === musician.address.toLowerCase());
      assert.equal(progress.voteProgress, 10);
      assert.equal(progress.trackState, 'minted');
      const musicianStats = (await f.view(musician)).participantStats[0];
      assert.equal(musicianStats.maxEarningsUnits, '65000000');
    }
    const claim = (await f.exec({ action: 'claim', campaignId: c.id, musicianWallet: musician.address,
      evidence: `Playlist mint token ${index + 1}` }, alice)).claims.find(item => item.subjectWallet === musician.address.toLowerCase());
    assert.deepEqual(claim.legs.map(leg => [leg.id, leg.amountUnits, leg.status]), [
      ['referrer', '10000000', 'pending'], ['musician', '5000000', 'pending'],
      ['dbusk-top10', '5000000', 'funding-needed'], ['dbusk-playback', '5000000', 'funding-needed'],
    ]);
    assert.equal(claim.qualification.playIds.length, 10);
  }
  assert.equal(f.stored().claims.length, 6);
  assert.equal(f.stored().claims.reduce((sum, claim) => sum + BigInt(claim.amountUnits), 0n), 150000000n);
  await f.join(c, musicians[6], alice.address);
  await assert.rejects(f.exec({ action: 'claim', campaignId: c.id, musicianWallet: musicians[6].address,
    evidence: 'Seventh conversion attempt' }, alice), /conversion slots/i);
});

test('musician conversion rejects nine votes, an unminted track and duplicate play IDs', async () => {
  const musician = Wallet.createRandom();
  const f = await fixture({ readPlaylist: () => [{ trackId: 'track', title: 'No mint', mintStatus: 'requested',
    tokenId: '9', mintRecipient: musician.address }] });
  const c = await f.create(input({ template: 'musician-referral', rewardUnits: '25000000',
    budgetUnits: '150000000', maxAwards: 6 }));
  f.setBalance(150000000n); await f.publish(c); await f.join(c, alice);
  await f.exec({ action: 'join', campaignId: c.id, referrer: alice.address, trackId: 'track',
    acceptTerms: true, termsVersion: c.version }, musician);
  await f.join(c, bob);
  await assert.rejects(f.exec({ action: 'vote', campaignId: c.id, playId: 'forged-for-musician',
    subjectWallet: musician.address, voterId: 'browser-forged-00000000', vote: 1 }, bob),
    /own wallet/);
  for (let index = 0; index < 9; index++) await f.exec({ action: 'vote', campaignId: c.id,
    playId: `song-${index}`, subjectWallet: musician.address, voterId: `browser-nine-${index}-0000`, vote: 1 }, musician);
  await f.exec({ action: 'vote', campaignId: c.id, playId: 'song-8', subjectWallet: musician.address,
    voterId: 'browser-nine-8-0000', vote: -1 }, musician);
  assert.equal(f.stored().votes.length, 9);
  await assert.rejects(f.exec({ action: 'claim', campaignId: c.id, musicianWallet: musician.address, evidence: 'pilot' }, alice), /9\/10/);
  await f.exec({ action: 'vote', campaignId: c.id, playId: 'song-9', subjectWallet: musician.address,
    voterId: 'browser-ten-00000000', vote: 1 }, musician);
  await assert.rejects(f.exec({ action: 'claim', campaignId: c.id, musicianWallet: musician.address, evidence: 'pilot' }, alice), /minted track/);
});

test('musician referrer curation, participant correction, and explicit immutable amendments persist', async () => {
  const musician = Wallet.createRandom();
  const f = await fixture({ readPlaylist: () => [{ trackId: 'track', title: 'Minted', mintStatus: 'minted',
    tokenId: '9', mintRecipient: musician.address }] });
  const c = await f.create(input({ template: 'musician-referral', rewardUnits: '25000000',
    budgetUnits: '150000000', maxAwards: 6, endsAt: '2026-11-13T18:00:00Z', claimDeadline: '2026-11-20T18:00:00Z' }));
  await f.exec({ action: 'curate-referrer', campaignId: c.id, referrer: alice.address, reason: 'Steward pilot outreach' });
  f.setBalance(250000000n); await f.publish(c); await f.join(c, alice); await f.join(c, musician);
  await f.exec({ action: 'correct-my-attribution', campaignId: c.id, referrer: alice.address,
    reason: 'I followed the curated invite before registration' }, musician);
  await f.exec({ action: 'correct-my-attribution', campaignId: c.id, referrer: alice.address,
    trackId: 'track', reason: 'Attach the first submitted track after upload' }, musician);
  assert.equal((await f.view()).members.find(m => m.wallet === musician.address.toLowerCase()).referrer, alice.address.toLowerCase());
  assert.deepEqual((await f.view()).members.find(m => m.wallet === musician.address.toLowerCase()).uploadTrackIds, ['track']);
  const corrected = await f.exec({ action: 'amend', campaignId: c.id, budgetIncreaseUnits: '25000000',
    endsAt: '2026-11-20T18:00:00Z', claimDeadline: '2026-11-27T18:00:00Z', reason: 'One explicit steward-approved top-up and extension' });
  const amended = corrected.campaigns.find(item => item.id === c.id);
  assert.equal(amended.budgetUnits, '175000000');
  assert.equal(amended.amendments.length, 1);
  assert.equal(amended.amendments[0].before.endsAt, c.endsAt);
  assert.equal(amended.amendments[0].after.endsAt, '2026-11-20T18:00:00.000Z');
  await assert.rejects(f.exec({ action: 'amend', campaignId: c.id, budgetIncreaseUnits: '0',
    endsAt: '2026-11-10T18:00:00Z', claimDeadline: amended.claimDeadline, reason: 'Silent shortening' }), /only extend/);
});

test('musician attribution freezes once that conversion has a submitted claim', async () => {
  const musician = Wallet.createRandom();
  const f = await fixture({ readPlaylist: () => [{ trackId: 'track', title: 'Track', mintStatus: 'minted',
    tokenId: '9', mintRecipient: musician.address }] });
  const c = await f.create(input({ template: 'musician-referral', rewardUnits: '25000000',
    budgetUnits: '150000000', maxAwards: 6 }));
  f.setBalance(150000000n); await f.publish(c); await f.join(c, alice); await f.join(c, bob);
  await f.exec({ action: 'join', campaignId: c.id, referrer: alice.address, trackId: 'track',
    acceptTerms: true, termsVersion: c.version }, musician);
  for (let index = 0; index < 10; index++) await f.exec({ action: 'vote', campaignId: c.id,
    playId: `freeze-${index}`, subjectWallet: musician.address,
    voterId: `freeze-browser-${index}-0000`, vote: 1 }, musician);
  await f.exec({ action: 'claim', campaignId: c.id, musicianWallet: musician.address,
    evidence: 'Mint and ten votes' }, alice);
  await assert.rejects(f.exec({ action: 'correct-my-attribution', campaignId: c.id, referrer: bob.address,
    reason: 'Cannot redirect a submitted conversion' }, musician), /already has a claim/);
});

test('pilot amendment checks every other campaign commitment on the same promotional fund', async () => {
  const f = await fixture();
  const pilot = await f.create(input({ template: 'musician-referral', rewardUnits: '25000000',
    budgetUnits: '150000000', maxAwards: 6 }));
  const other = await f.create(input({ template: 'album', rewardUnits: '10000000',
    budgetUnits: '50000000', maxAwards: 5, fund: f.shared.REFERRALS_FUND }));
  f.setBalance(200000000n);
  await f.publish(pilot); await f.publish(other);
  f.setBalance(175000000n);
  await assert.rejects(f.exec({ action: 'amend', campaignId: pilot.id, budgetIncreaseUnits: '25000000',
    endsAt: '2026-11-07T18:00:00Z', claimDeadline: '2026-11-14T18:00:00Z',
    reason: 'Cannot overcommit the shared fund' }), /other campaign commitments/);
});
test('Run Campaign saves and publishes a funded referral campaign in one signed command', async () => {
  const f = await fixture({ readSupporterInventory: async () => ({ erc1155: true, balanceUnits: 11n }) });
  const pilot = input({ template: 'musician-referral', title: 'Jose', rewardUnits: '25000000',
    budgetUnits: '150000000', maxAwards: 6, fund: 'dbusk-promotionals', curatedReferrers: [alice.address],
    settlementVersion: f.shared.REFERRAL_SETTLEMENT_VERSION, supporterRewards: [f.shared.SUPPORTER_REWARD] });
  await assert.rejects(f.exec({ action: 'run', campaign: { ...pilot, settlementVersion: undefined } }), /Update the calendar editor/);
  f.setBalance(149999999n);
  await assert.rejects(f.exec({ action: 'run', campaign: pilot }), /Fund balance cannot cover/);
  assert.equal((await f.service.publicState()).campaigns.length, 0);
  f.setBalance(150000000n);
  const [campaign] = (await f.exec({ action: 'run', campaign: pilot })).campaigns;
  assert.equal(campaign.status, 'published');
  assert.equal(campaign.title, 'Jose Referral Campaign');
  assert.equal(campaign.fund, 'dbusk-referrals');
  assert.deepEqual(campaign.curatedReferrers, [alice.address.toLowerCase()]);
  await assert.rejects(f.exec({ action: 'run', campaign: pilot }), /Fund balance cannot cover/);
  await assert.rejects(f.exec({ action: 'run', campaign: input() }), /new musician referral campaign/);
});

test('Run Campaign accepts a custom budget, leg breakdown, vote count and referrer names', async () => {
  const f = await fixture({ readSupporterInventory: async () => ({ erc1155: true, balanceUnits: 11n }) });
  const legAmounts = { referrer: '20000000', musician: '10000000', 'dbusk-top10': '0', 'dbusk-playback': '10000000' };
  const custom = input({ template: 'musician-referral', title: 'Spring', rewardUnits: '40000000',
    budgetUnits: '200000000', maxAwards: 5, legAmounts, requiredVotes: 5,
    curatedReferrers: [alice.address], curatedReferrerNames: { [alice.address]: 'Alice', [bob.address]: 'Not curated' },
    settlementVersion: f.shared.REFERRAL_SETTLEMENT_VERSION, supporterRewards: [f.shared.SUPPORTER_REWARD] });
  await assert.rejects(f.exec({ action: 'run', campaign: { ...custom, budgetUnits: '210000000' } }), /exact multiple/);
  await assert.rejects(f.exec({ action: 'run', campaign: { ...custom, maxAwards: 6 } }), /must match the breakdown/);
  await assert.rejects(f.exec({ action: 'run', campaign: { ...custom, legAmounts: { ...legAmounts, referrer: '0' }, rewardUnits: '20000000', maxAwards: 10 } }), /referrer reward/);
  f.setBalance(200000000n);
  const [campaign] = (await f.exec({ action: 'run', campaign: custom })).campaigns;
  assert.equal(campaign.status, 'published');
  assert.deepEqual(campaign.legAmounts, legAmounts);
  assert.equal(campaign.requiredVotes, 5);
  assert.equal(campaign.maxAwards, 5);
  assert.deepEqual(campaign.curatedReferrerNames, { [alice.address.toLowerCase()]: 'Alice' });
  const profile = (await f.service.publicState()).participantProfiles.find(item => item.wallet === alice.address.toLowerCase());
  assert.equal(profile.invited, true);
  assert.equal(profile.registered, false);
  assert.equal(profile.maxEarningsUnits, '100000000');
  assert.equal(profile.requiredVotes, 5);
});
test('inviters are recorded once, reject self and loops, and survive restart; admin corrections are audited', async () => {
  const f = await fixture();
  const set = (who, referrer) => f.exec({ action: 'set-inviter', referrer: referrer.address, source: 'vote' }, who);
  await assert.rejects(set(alice, alice), /yourself/);
  await set(alice, bob);
  await assert.rejects(set(alice, carol), /already recorded/);
  await set(bob, carol);
  await assert.rejects(set(carol, alice), /loop/);
  let state = await f.service.publicState();
  assert.deepEqual(state.inviters.map(i => [i.wallet, i.referrer, i.source]), [
    [alice.address.toLowerCase(), bob.address.toLowerCase(), 'vote'],
    [bob.address.toLowerCase(), carol.address.toLowerCase(), 'vote']]);
  await assert.rejects(f.exec({ action: 'correct-inviter', wallet: alice.address, referrer: dave.address, reason: 'x' }, bob), /Only the configured admin/);
  await assert.rejects(f.exec({ action: 'correct-inviter', wallet: carol.address, referrer: alice.address, reason: 'loop' }), /loop/);
  await f.exec({ action: 'correct-inviter', wallet: alice.address, referrer: dave.address, reason: 'Met at the open mic' });
  const { createPromotions } = await import('../discord-bot/promotions.js');
  state = await createPromotions({ ...f.cfg, restore: async () => f.stored() }).publicState();
  assert.equal(state.inviters[0].referrer, dave.address.toLowerCase());
  assert.equal(state.inviters[0].history[0].from, bob.address.toLowerCase());
  const { validatePromotionCheckpoint } = await import('../discord-bot/promotions.js');
  const looped = structuredClone(f.stored());
  looped.inviters[1].referrer = alice.address.toLowerCase();
  looped.inviters.push({ wallet: dave.address.toLowerCase(), referrer: bob.address.toLowerCase(), at: looped.inviters[0].at, source: 'vote', history: [] });
  assert.throws(() => validatePromotionCheckpoint(looped), /Invalid promotions checkpoint/);
});
test('a referred campaign join also records the app-level inviter', async () => {
  const f = await fixture();
  const c = await f.create(); await f.publish(c);
  await f.join(c, bob);
  await f.join(c, alice, bob.address);
  assert.deepEqual((await f.service.publicState()).inviters.map(i => [i.wallet, i.referrer, i.source]),
    [[alice.address.toLowerCase(), bob.address.toLowerCase(), 'join']]);
});

test('wallet-pass radio votes count toward joined musician campaigns with the signed-vote rules', async () => {
  const musician = Wallet.createRandom();
  const f = await fixture({ readPlaylist: () => [{ trackId: 'track', mintStatus: 'minted', tokenId: '1', mintRecipient: musician.address }] });
  const c = await f.create(input({ template: 'musician-referral', rewardUnits: '25000000', budgetUnits: '150000000', maxAwards: 6 }));
  f.setBalance(150000000n); await f.publish(c); await f.join(c, alice);
  await f.exec({ action: 'join', campaignId: c.id, referrer: alice.address, trackId: 'track', acceptTerms: true, termsVersion: c.version }, musician);
  const voterId = 'browser-musician-0000';
  assert.deepEqual(await f.service.recordRadioVote({ wallet: bob.address, voterId: 'browser-bob-00000000', playId: 'song-0' }), []);
  assert.equal((await f.service.recordRadioVote({ wallet: musician.address, voterId, playId: 'song-0', duplicate: true }))[0].outcome, 'stale');
  const [first] = await f.service.recordRadioVote({ wallet: musician.address, voterId, playId: 'song-1' });
  assert.deepEqual([first.outcome, first.progress, first.required], ['counted', 1, 10]);
  assert.equal((await f.service.recordRadioVote({ wallet: musician.address, voterId, playId: 'song-1', duplicate: true }))[0].outcome, 'already');
  await f.join(c, carol);
  assert.equal((await f.service.recordRadioVote({ wallet: carol.address, voterId, playId: 'song-2' }))[0].outcome, 'other-wallet');
  assert.deepEqual(f.stored().votes.map(v => [v.wallet, v.subjectWallet, v.playId]), [[musician.address.toLowerCase(), musician.address.toLowerCase(), 'song-1']]);
});

test('ETH campaigns fund, reserve gifts and reconcile native gift payouts separately from USDC', async () => {
  const musician = Wallet.createRandom();
  const playlist = [{ trackId: 'eth-track', title: 'Minted', mintStatus: 'minted', tokenId: '9', mintRecipient: musician.address }];
  const balances = { usdc: 0n, eth: 0n };
  const assets = [];
  const f = await fixture({ readPlaylist: () => playlist,
    readFunding: async (slug, asset) => { assets.push(asset); return balances[asset]; } });
  const wei = '1000000000000000';
  const legAmounts = { referrer: wei, musician: wei, 'dbusk-top10': '0', 'dbusk-playback': '0' };
  const gifts = [{ trigger: 'participation', amountUnits: wei, supporter: false },
    { trigger: 'top', amountUnits: '3000000000000000', supporter: true }];
  const pilot = input({ template: 'musician-referral', title: 'Ether', asset: 'eth', legAmounts, requiredVotes: 1,
    rewardUnits: '2000000000000000', budgetUnits: '4000000000000000', maxAwards: 2, gifts,
    curatedReferrers: [alice.address, bob.address] });
  await assert.rejects(f.create({ ...pilot, asset: 'doge' }), /USDC or ETH/);
  await assert.rejects(f.create({ ...pilot, gifts: [...gifts, gifts[0]] }), /one entry per trigger/);
  const campaign = await f.create(pilot);
  // Budget 0.004 + participation 2 × 0.001 + top 0.003 = 0.009 ETH; USDC balance never counts.
  balances.usdc = 10n ** 30n; balances.eth = 8999999999999999n;
  await assert.rejects(f.publish(campaign), /cannot cover campaign budgets and gifts/);
  assert.equal(assets.at(-1), 'eth');
  balances.eth = 9000000000000000n;
  const [published] = (await f.publish(campaign)).campaigns;
  assert.equal(published.asset, 'eth');
  assert.equal(published.giftReserveUnits, '5000000000000000');
  await f.join(campaign, alice);
  await f.exec({ action: 'join', campaignId: campaign.id, referrer: alice.address, trackId: 'eth-track',
    acceptTerms: true, termsVersion: campaign.version }, musician);
  await f.exec({ action: 'vote', campaignId: campaign.id, playId: 'eth-song', subjectWallet: musician.address,
    voterId: 'browser-eth-000000000', vote: 1 }, musician);
  const conversion = (await f.exec({ action: 'claim', campaignId: campaign.id, musicianWallet: musician.address,
    evidence: 'Minted playlist evidence' }, alice)).claims[0];
  await f.exec({ action: 'review', claimId: conversion.id, decision: 'approved', reason: 'Verified' });
  await assert.rejects(f.exec({ action: 'award-gifts', campaignId: campaign.id }), /fills or its claim window closes/);
  f.setTime(Date.parse(campaign.claimDeadline) + 1);
  const awarded = (await f.exec({ action: 'award-gifts', campaignId: campaign.id })).campaigns[0];
  assert.deepEqual(awarded.giftAwards.map(a => [a.id, a.wallet, a.amountUnits, a.status]), [
    ['gift-participation', alice.address.toLowerCase(), wei, 'approved'],
    ['gift-top', alice.address.toLowerCase(), '3000000000000000', 'approved']]);
  assert.equal(awarded.giftReserveUnits, '4000000000000000');
  assert.ok(awarded.supporterToken.eligibleWallets.includes(alice.address.toLowerCase()));
  await assert.rejects(f.exec({ action: 'award-gifts', campaignId: campaign.id }), /already awarded/);
  const pendingCommand = { campaignId: campaign.id, giftId: 'gift-participation', wallet: alice.address };
  await f.exec({ action: 'prepare-gift', ...pendingCommand });
  await assert.rejects(f.exec({ action: 'release-gift-preparation', ...pendingCommand,
    confirmNoBroadcast: true }), /Wallet-history review reason/);
  const released = (await f.exec({ action: 'release-gift-preparation', ...pendingCommand,
    confirmNoBroadcast: true, reason: 'Wallet history confirms no broadcast' })).campaigns[0];
  assert.equal(released.giftAwards.find(a => a.id === 'gift-participation').status, 'approved');
  assert.equal(released.giftAwards.find(a => a.id === 'gift-participation').paymentHistory[0].reason,
    'Wallet history confirms no broadcast');
  const giftCommand = { campaignId: campaign.id, giftId: 'gift-top', wallet: alice.address };
  await f.exec({ action: 'prepare-gift', ...giftCommand });
  const iface = new Interface(['event PayrollPaid(bytes32 indexed fundId,address indexed asset,address indexed recipient,uint256 amount,bytes32 workReference,bytes32 repositoryIdHash,bytes32 contributorIdHash,string metadataUri,bytes32 metadataHash)']);
  const reference = id(f.shared.promotionWorkReference({ campaignId: campaign.id, wallet: alice.address }, 'gift-top'));
  const usdcPayout = iface.encodeEventLog('PayrollPaid', [id(f.shared.REFERRALS_FUND), f.shared.PROMOTIONS_USDC,
    alice.address, 3000000000000000n, reference, id('repo'), id('alice'), '', ZeroHash]);
  f.setReceipt({ status: 1, to: routerAddress, blockNumber: 99, logs: [{ ...usdcPayout, address: routerAddress }] });
  await assert.rejects(f.exec({ action: 'reconcile-gift', ...giftCommand, txHash }), /ETH transfer proofs/);
  const ethPayout = iface.encodeEventLog('PayrollPaid', [id(f.shared.REFERRALS_FUND), f.shared.PROMOTIONS_ETH,
    alice.address, 3000000000000000n, reference, id('repo'), id('alice'), '', ZeroHash]);
  f.setReceipt({ status: 1, to: routerAddress, blockNumber: 99, logs: [{ ...ethPayout, address: routerAddress }] });
  const paid = (await f.exec({ action: 'reconcile-gift', ...giftCommand, txHash })).campaigns[0];
  assert.equal(paid.giftAwards.find(a => a.id === 'gift-top').status, 'paid');
  assert.equal(paid.giftPaidUnits, '3000000000000000');
  const profile = (await f.service.publicState()).participantProfiles.find(p => p.wallet === alice.address.toLowerCase());
  assert.equal(profile.asset, 'eth');
  assert.equal(profile.giftAwards.length, 2);
});

test('earned Supporter tokens queue for admin delivery and settle only on an exact canonical transfer', async () => {
  const musician = Wallet.createRandom();
  const playlist = [{ trackId: 'sup-track', title: 'Minted', mintStatus: 'minted', tokenId: '9', mintRecipient: musician.address }];
  const f = await fixture({ readPlaylist: () => playlist });
  const { SUPPORTER_REWARD, SUPPORTER_REWARD_ABI, supporterRewardQueue } = f.shared;
  const legAmounts = { referrer: '1000000', musician: '1000000', 'dbusk-top10': '0', 'dbusk-playback': '0' };
  const pilot = input({ template: 'musician-referral', title: 'Supporters', legAmounts, requiredVotes: 1,
    rewardUnits: '2000000', budgetUnits: '2000000', maxAwards: 1,
    gifts: [{ trigger: 'top', amountUnits: '0', supporter: true }], curatedReferrers: [alice.address, bob.address] });
  const campaign = await f.create(pilot);
  await f.publish(campaign);
  await f.join(campaign, alice);
  await f.exec({ action: 'join', campaignId: campaign.id, referrer: alice.address, trackId: 'sup-track',
    acceptTerms: true, termsVersion: campaign.version }, musician);
  await f.exec({ action: 'vote', campaignId: campaign.id, playId: 'sup-song', subjectWallet: musician.address,
    voterId: 'browser-sup-000000000', vote: 1 }, musician);
  const conversion = (await f.exec({ action: 'claim', campaignId: campaign.id, musicianWallet: musician.address,
    evidence: 'Minted playlist evidence' }, alice)).claims[0];
  await f.exec({ action: 'review', claimId: conversion.id, decision: 'approved', reason: 'Verified' });
  assert.equal(supporterRewardQueue((await f.service.publicState()).campaigns).length, 0,
    'top-referrer gifts are not owed until the winners are finalized');
  const awarded = (await f.exec({ action: 'award-gifts', campaignId: campaign.id })).campaigns[0];
  assert.equal(awarded.supporterToken.status, 'payroll-queue');
  assert.deepEqual(supporterRewardQueue([awarded]).map(item => [item.wallet, item.status]),
    [[alice.address.toLowerCase(), 'owed']]);

  const target = { campaignId: campaign.id, wallet: alice.address };
  await assert.rejects(f.exec({ action: 'prepare-supporter', campaignId: campaign.id, wallet: bob.address }), /No Supporter token is owed/);
  await assert.rejects(f.exec({ action: 'prepare-supporter', ...target }, alice), /Only the configured admin/);
  await f.exec({ action: 'prepare-supporter', ...target });
  await assert.rejects(f.exec({ action: 'prepare-supporter', ...target }), /already pending or delivered/);
  await assert.rejects(f.exec({ action: 'release-supporter-preparation', ...target, confirmNoBroadcast: true }), /review reason/);
  const released = (await f.exec({ action: 'release-supporter-preparation', ...target, confirmNoBroadcast: true,
    reason: 'Wallet history shows no transfer' })).campaigns[0];
  assert.equal(supporterRewardQueue([released])[0].status, 'owed');

  await f.exec({ action: 'prepare-supporter', ...target });
  const iface = new Interface(SUPPORTER_REWARD_ABI);
  const transfer = (to, tokenId, value, from = owner.address) => ({ address: SUPPORTER_REWARD.contract,
    ...iface.encodeEventLog('TransferSingle', [owner.address, from, to, tokenId, value]) });
  const exact = transfer(alice.address, 75n, 1n);
  f.setReceipt({ status: 1, to: routerAddress, blockNumber: 99, logs: [exact] });
  await assert.rejects(f.exec({ action: 'reconcile-supporter', ...target, txHash }), /Wrong Supporter transfer target/);
  for (const log of [transfer(bob.address, 75n, 1n), transfer(alice.address, 74n, 1n), transfer(alice.address, 75n, 2n),
    transfer(alice.address, 75n, 1n, bob.address)]) {
    f.setReceipt({ status: 1, to: SUPPORTER_REWARD.contract, blockNumber: 99, logs: [log] });
    await assert.rejects(f.exec({ action: 'reconcile-supporter', ...target, txHash }), /Missing a transfer of exactly 1 Supporter #75/);
  }
  const revertHash = '0x' + 'cd'.repeat(32);
  f.setReceipt({ status: 0, to: SUPPORTER_REWARD.contract, blockNumber: 99, logs: [] });
  f.setTransaction({ to: SUPPORTER_REWARD.contract, from: owner.address, value: 0n,
    data: iface.encodeFunctionData('safeTransferFrom', [owner.address, alice.address, 75n, 1n, '0x']) });
  const reverted = (await f.exec({ action: 'reconcile-supporter', ...target, txHash: revertHash })).campaigns[0];
  assert.equal(reverted.supporterToken.deliveries[0].lastRevertedHash, revertHash);
  assert.equal(supporterRewardQueue([reverted])[0].status, 'owed');

  await f.exec({ action: 'prepare-supporter', ...target });
  f.setReceipt(null);
  const pending = (await f.exec({ action: 'reconcile-supporter', ...target, txHash })).campaigns[0];
  assert.equal(supporterRewardQueue([pending])[0].txHash, txHash);
  f.setReceipt({ status: 1, to: SUPPORTER_REWARD.contract, blockNumber: 99, logs: [exact] });
  const delivered = (await f.exec({ action: 'reconcile-supporter', ...target, txHash })).campaigns[0];
  assert.equal(supporterRewardQueue([delivered])[0].status, 'delivered');
  await assert.rejects(f.exec({ action: 'reconcile-supporter', ...target, txHash }), /does not need transfer reconciliation/);
  await assert.rejects(f.exec({ action: 'reconcile', claimId: conversion.id, legId: 'referrer', txHash }), /already assigned/);
  const profile = (await f.service.publicState()).participantProfiles.find(p => p.wallet === alice.address.toLowerCase());
  assert.equal(profile.supporterToken.delivery, 'delivered');
  const restarted = (await import('../discord-bot/promotions.js')).createPromotions(f.cfg);
  assert.equal(supporterRewardQueue((await restarted.publicState()).campaigns)[0].status, 'delivered');
});

test('approved Supporter gifts enter payroll immediately, deduplicate, and survive preparation', async () => {
  const musicians = [Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()];
  const playlist = musicians.map((musician, index) => ({ trackId: `early-${index}`, title: 'Minted',
    mintStatus: 'minted', tokenId: String(index + 1), mintRecipient: musician.address }));
  const f = await fixture({ readPlaylist: () => playlist });
  const { supporterRewardQueue } = f.shared;
  const legAmounts = { referrer: '1000000', musician: '1000000', 'dbusk-top10': '0', 'dbusk-playback': '0' };
  const pilot = input({ template: 'musician-referral', title: 'Early gifts', legAmounts, requiredVotes: 1,
    rewardUnits: '2000000', budgetUnits: '4000000', maxAwards: 2, curatedReferrers: [alice.address],
    gifts: ['participation', 'completion', 'top'].map(trigger => ({ trigger, amountUnits: '0', supporter: true })) });
  const campaign = await f.create(pilot);
  await f.publish(campaign);
  await f.join(campaign, alice);
  const submit = async index => {
    const musician = musicians[index];
    await f.exec({ action: 'join', campaignId: campaign.id, referrer: alice.address, trackId: `early-${index}`,
      acceptTerms: true, termsVersion: campaign.version }, musician);
    await f.exec({ action: 'vote', campaignId: campaign.id, playId: `early-song-${index}`, subjectWallet: musician.address,
      voterId: `browser-early-00000${index}`, vote: 1 }, musician);
    const result = await f.exec({ action: 'claim', campaignId: campaign.id, musicianWallet: musician.address,
      evidence: 'Minted playlist evidence' }, alice);
    return result.claims.find(claim => claim.subjectWallet === musician.address.toLowerCase());
  };
  const first = await submit(0), second = await submit(1);
  assert.equal(supporterRewardQueue((await f.service.publicState()).campaigns).length, 0);
  const review = (claim, decision) => f.exec({ action: 'review', claimId: claim.id, decision, reason: 'Reviewed evidence' });
  await review(first, 'approved');
  let state = await f.service.publicState();
  assert.deepEqual(supporterRewardQueue(state.campaigns).map(entry => [entry.wallet, entry.status]),
    [[alice.address.toLowerCase(), 'owed']]);
  assert.deepEqual(f.stored().campaigns[0].supporterToken.eligibleWallets, []);
  const restarted = (await import('../discord-bot/promotions.js')).createPromotions(f.cfg);
  assert.equal(supporterRewardQueue((await restarted.publicState()).campaigns).length, 1);
  await review(second, 'approved');
  assert.equal(supporterRewardQueue((await f.service.publicState()).campaigns).length, 1);
  await review(second, 'rejected');
  assert.equal(supporterRewardQueue((await f.service.publicState()).campaigns).length, 1);
  await review(first, 'rejected');
  assert.equal(supporterRewardQueue((await f.service.publicState()).campaigns).length, 0);

  const third = await submit(2);
  await review(third, 'approved');
  await f.exec({ action: 'prepare-supporter', campaignId: campaign.id, wallet: alice.address });
  assert.deepEqual(f.stored().campaigns[0].supporterToken.eligibleWallets, [alice.address.toLowerCase()]);
  await f.exec({ action: 'release-supporter-preparation', campaignId: campaign.id, wallet: alice.address,
    confirmNoBroadcast: true, reason: 'Wallet history shows no transfer' });
  await review(third, 'rejected');
  await f.exec({ action: 'status', campaignId: campaign.id, status: 'closed' });
  await f.exec({ action: 'status', campaignId: campaign.id, status: 'archived' });
  state = await f.service.publicState();
  assert.equal(supporterRewardQueue(state.campaigns)[0].status, 'owed');
  assert.equal(state.participantProfiles.find(profile => profile.wallet === alice.address.toLowerCase()).supporterToken.delivery, 'owed');
});
