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
  terms: 'One reward, public rights, encrypted evidence, admin review, no stacking. Disputes reviewed by steward.',
  rewardUnits: '10000000', budgetUnits: '10000000', maxAwards: 1, minOriginalTracks: 3, minPurchaseUnits: '5000000',
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
test('drafts stay private; published claims are wallet-scoped and recover after restart', async () => {
  const f = await fixture();
  const c = await f.create();
  assert.equal((await f.service.publicState()).campaigns.length, 0);
  await f.publish(c); await f.join(c); const claim = await f.claim(c);
  assert.equal((await f.view(bob)).claims.length, 0);
  const publicState = await f.service.publicState();
  assert.equal(publicState.claims, undefined);
  assert.equal(publicState.campaigns[0].evidence, undefined);
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
  f.setTime(Date.parse('2026-11-02T05:00:00Z'));
  await assert.rejects(f.exec({ action: 'review', claimId: claim.id, decision: 'approved', reason: 'Reviewed people and evidence' }), /this New York week/);
  await f.exec({ action: 'vote', campaignId: c.id, playId: 'new-song', voterId: 'browser_bob_000000', vote: 1 }, bob);
  await f.exec({ action: 'vote', campaignId: c.id, playId: 'new-song', voterId: 'browser_carol_0000', vote: -1 }, carol);
  const approved = await f.exec({ action: 'review', claimId: claim.id, decision: 'approved', reason: 'Reviewed' });
  assert.equal(approved.claims[0].status, 'approved');
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
  assert.equal((await f.service.publicState()).campaigns[0].announcement, undefined);
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
test('private checkpoint uses authenticated encryption, rejects wrong keys/tampering, and no wallet plaintext', async () => {
  const { promotionCheckpointCodec } = await import('../discord-bot/promotions.js');
  const codec = promotionCheckpointCodec('11'.repeat(32));
  const data = { wallet: alice.address, evidence: 'private evidence' };
  const encoded = codec.serialize(data);
  assert.doesNotMatch(JSON.stringify(encoded), /private evidence/);
  assert.deepEqual(codec.deserialize(encoded), data);
  assert.throws(() => promotionCheckpointCodec('bad'), /32 random/);
  assert.throws(() => promotionCheckpointCodec('22'.repeat(32)).deserialize(encoded));
  assert.throws(() => codec.deserialize({ ...encoded, tag: '00'.repeat(16) }));
});
test('durable storage serializes competing services and recovers reservations after restart', async t => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { randomUUID } = require('node:crypto');
  const { initializePromotionStore, createPromotionStore } = await import('../discord-bot/promotions-store.js');
  const file = path.join(__dirname, `.promotions-${randomUUID()}.sqlite`);
  const keyHex = '31'.repeat(32);
  const opened = [];
  t.after(() => {
    for (const store of opened) store.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  });
  await assert.rejects(createPromotionStore({ file, keyHex }));
  assert.equal(fs.existsSync(file), false);
  await initializePromotionStore({ file, keyHex });
  await assert.rejects(initializePromotionStore({ file, keyHex }), /exist/i);
  await assert.rejects(createPromotionStore({ file, keyHex: '32'.repeat(32) }));
  const first = await createPromotionStore({ file, keyHex });
  const second = await createPromotionStore({ file, keyHex });
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
  const restartedStore = await createPromotionStore({ file, keyHex });
  opened.push(restartedStore);
  const restarted = await fixture({ restore: restartedStore.restore, save: restartedStore.save });
  assert.equal((await restarted.view()).claims.filter(claim => claim.status === 'approved').length, 1);
  for (const suffix of ['', '-wal']) {
    const bytes = fs.existsSync(file + suffix) ? fs.readFileSync(file + suffix) : Buffer.alloc(0);
    assert.equal(bytes.includes(Buffer.from(alice.address.toLowerCase())), false);
    assert.equal(bytes.includes(Buffer.from('Catalog and approved delivery proof')), false);
  }
});
test('HTTP public listing omits claimant data, private operations require allowed origin, unavailable is explicit', async () => {
  const http = require('node:http');
  const { createWorkerRequestHandler } = await import('../discord-bot/ipfs-worker.js');
  const f = await fixture(); const c = await f.create(); await f.publish(c); await f.join(c); await f.claim(c);
  const server = http.createServer(createWorkerRequestHandler({ ownerWallet: owner.address, allowedOrigins: [origin], promotions: f.service }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/promotions`;
    const result = await fetch(url);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal((await result.json()).claims, undefined);
    const denied = await fetch(url, { method: 'POST', headers: { origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify(await f.body({ action: 'view' })) });
    assert.equal(denied.status, 400);
    const allowed = await fetch(url, { method: 'POST', headers: { origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(await f.body({ action: 'view' }, bob)) });
    assert.equal(allowed.status, 200);
    assert.deepEqual((await allowed.json()).claims, []);
    server.removeAllListeners('request');
    server.on('request', createWorkerRequestHandler({ ownerWallet: owner.address, allowedOrigins: [origin] }));
    const unavailable = await fetch(url);
    assert.equal(unavailable.status, 400);
    assert.match((await unavailable.json()).error, /Promotions unavailable/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
