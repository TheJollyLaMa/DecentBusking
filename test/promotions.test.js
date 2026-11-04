const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet, Interface, id, ZeroHash } = require('../discord-bot/node_modules/ethers');
const owner = Wallet.createRandom();
const alice = Wallet.createRandom();
const bob = Wallet.createRandom();
const carol = Wallet.createRandom();
const routerAddress = '0x' + 'ab'.repeat(20);
const txHash = '0x' + 'ab'.repeat(32);
const blockHash = '0x' + '12'.repeat(32);
const origin = 'https://busking.example';
const epoch = Date.parse('2026-10-30T18:00:00Z');
const input = (extra = {}) => ({ template: 'album', title: 'Bring an album', criteria: 'Approved album with delivery proof',
  terms: 'One reward, public rights, encrypted evidence, admin review, no stacking. Disputes reviewed by steward.',
  rewardUnits: '10000000', budgetUnits: '10000000', maxAwards: 1,
  startsAt: '2026-10-30T17:00:00Z', endsAt: '2026-11-06T18:00:00Z',
  claimDeadline: '2026-11-13T18:00:00Z', ...extra });

async function fixture(options = {}) {
  const { createPromotions } = await import('../discord-bot/promotions.js');
  const shared = await import('../js/promotions.mjs');
  let stored = null, clock = epoch, balance = 100000000n, receipt = null;
  const provider = { getNetwork: async () => ({ chainId: 8453n }), getTransactionReceipt: async () => receipt,
    getBlockNumber: async () => 100, getBlock: async () => ({ hash: blockHash }) };
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
  const join = (c, who = alice, referrer = '') => exec({ action: 'join', campaignId: c.id, referrer }, who);
  const claim = async (c, who = alice) => {
    const result = await exec({ action: 'claim', campaignId: c.id, evidence: 'Catalog and approved delivery proof' }, who);
    return result.claims.at(-1);
  };
  return { service, cfg, exec, view, body, create, publish, join, claim, shared,
    stored: () => stored, setTime: t => { clock = t; }, setBalance: b => { balance = b; },
    setReceipt: r => { receipt = r ? { blockHash, ...r } : r; } };
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
test('failed radio votes cannot create qualification and anonymous votes are not silently attributed', async () => {
  const f = await fixture({ voteOnRadio: async () => { throw new Error('Song ended'); } });
  const c = await f.create(); await f.publish(c); await f.join(c);
  await assert.rejects(f.exec({ action: 'vote', campaignId: c.id, voterId: 'browser_alice_0000', playId: 'ended', vote: 1 }, alice), /Song ended/);
  assert.equal((await f.view(alice)).activity.voted, false);
  assert.equal(f.stored().votes.length, 0);
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
  const makeReceipt = (extra = {}) => ({ status: 1, blockNumber: 99, logs: [{
    address: source, ...iface.encodeEventLog('CampaignCreated', [1n, carol.address, 1n, 'Ad', 'ipfs://ad', 20000000n,
      BigInt(epoch / 1000), BigInt(epoch / 1000 + 86400)]),
  }], ...extra });
  const command = { action: 'claim', campaignId: c.id, evidence: 'Sponsor campaign proof',
    purchaseHash: txHash, purchaser: carol.address, advertId: '1' };
  await assert.rejects(f.exec(command, alice), /two confirmed/);
  f.setReceipt(makeReceipt({ blockNumber: 100 }));
  await assert.rejects(f.exec(command, alice), /two confirmed/);
  f.setReceipt(makeReceipt({ blockHash: txHash }));
  await assert.rejects(f.exec(command, alice), /canonical/);
  f.setReceipt(makeReceipt());
  await assert.rejects(f.exec({ ...command, purchaser: bob.address }, alice), /No matching/);
  await assert.rejects(f.exec({ ...command, advertId: '2' }, alice), /No matching/);
  const claimed = (await f.exec(command, alice)).claims[0];
  assert.equal(claimed.qualification.amountUnits, '20000000');
  await assert.rejects(f.exec(command, bob), /already claimed/);
  f.setReceipt(makeReceipt({ logs: [] }));
  await assert.rejects(f.exec({ action: 'review', claimId: claimed.id, decision: 'approved', reason: 'Reviewed conversion' }), /No matching/);
  f.setReceipt(makeReceipt());
  await f.exec({ action: 'review', claimId: claimed.id, decision: 'approved', reason: 'Reviewed conversion' });
});
test('approvals recheck real funding and do not stack participant rewards across offers', async () => {
  const f = await fixture(); const c = await f.create(); await f.publish(c); await f.join(c);
  const a = await f.claim(c);
  f.setBalance(1n);
  await assert.rejects(f.exec({ action: 'review', claimId: a.id, decision: 'approved', reason: 'Reviewed' }), /balance/);
  assert.equal((await f.view()).claims[0].status, 'submitted');
  f.setBalance(100000000n);
  await f.exec({ action: 'review', claimId: a.id, decision: 'approved', reason: 'Reviewed' });
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
  await f.exec({ action: 'reconcile', claimId: claim.id, txHash });
  assert.equal((await f.view()).claims[0].status, 'approved');
  const fail = await fixture({ save: async () => { throw new Error('Storage down'); } });
  await assert.rejects(fail.create(), /Writes stopped/);
  await assert.rejects(fail.create(), /Writes stopped/);
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
test('real checkpoint transport encrypts daily payload/history and refuses stale fallback', async t => {
  const { createPinataStateStore } = await import('../discord-bot/ipfs-state.js');
  const { promotionCheckpointCodec } = await import('../discord-bot/promotions.js');
  const codec = promotionCheckpointCodec('11'.repeat(32));
  const name = 'decentbusking-promotions-encrypted.json';
  const tags = { app: 'decentbusking', kind: 'promotions-encrypted', schema: '1' };
  const state = { wallet: alice.address, evidence: 'private-test-evidence' };
  let uploaded, files = [], unavailable = false;
  const requests = [];
  const store = createPinataStateStore({ pinataJwt: 'test', name, tags, ...codec,
    restoreLatestOnly: true, groupId: 'promotion-group', retentionDays: 7, now: () => epoch,
    fetchImpl: async (url, options = {}) => {
      requests.push(url);
      if (options.method === 'POST') {
        const bytes = await options.body.get('file').text();
        assert.ok(!bytes.toLowerCase().includes(alice.address.toLowerCase()));
        assert.ok(!bytes.includes('private-test-evidence'));
        uploaded = JSON.parse(bytes);
        assert.deepEqual(uploaded._checkpoint.events, []);
        files = [{ id: 'latest', cid: 'latest-cid', name, group_id: 'promotion-group',
          created_at: new Date(epoch).toISOString(), keyvalues: JSON.parse(options.body.get('keyvalues')) }];
        return Response.json({ data: { cid: 'latest-cid' } });
      }
      if (url.includes('/gateways')) return Response.json({ data: { rows: [] } });
      if (url.includes('/files')) return Response.json({ data: { files } });
      assert.match(url, /\/ipfs\/latest-cid/);
      return unavailable ? new Response('', { status: 503 }) : Response.json(uploaded);
    } });
  t.after(() => store.close());
  await store.save(state);
  assert.deepEqual(await store.restore(), state);
  files.push({ ...files[0], id: 'older', cid: 'older-cid', created_at: new Date(epoch - 1000).toISOString() });
  unavailable = true;
  await assert.rejects(store.restore(), /restore failed/);
  assert.equal(requests.some(url => url.includes('/ipfs/older-cid')), false);
  const runtime = require('node:fs').readFileSync(require('node:path').join(__dirname, '../discord-bot/index.js'), 'utf8');
  assert.match(runtime, /kind: 'promotions-encrypted'[\s\S]{0,80}restoreLatestOnly: true/);
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
