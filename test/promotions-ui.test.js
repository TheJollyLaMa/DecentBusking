const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { id, ZeroHash } = require('../discord-bot/node_modules/ethers');
const owner = '0x807061DF657A7697c04045dA7d16D941861cAABc';
const routerAddress = '0x' + 'ab'.repeat(20);
const txHash = '0x' + 'ab'.repeat(32);

async function fixture(t) {
  const { payPromotion } = await import('../js/promotions-ui.mjs');
  const previous = global.window;
  t.after(() => { if (previous === undefined) delete global.window; else global.window = previous; });
  let sends = 0, prepared = 0, reconciled = 0;
  let sendError;
  const entries = new Map();
  const storage = { getItem: key => entries.get(key) || null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
  const claim = { id: 'claim-1', campaignId: 'offer-1', wallet: '0x' + '12'.repeat(20), amountUnits: '10000000', status: 'approved' };
  const router = {
    completedWorkReferences: async () => false, DEFAULT_ADMIN_ROLE: async () => ZeroHash,
    hasRole: async () => true, paused: async () => false, funds: async () => ({ exists: true, active: true }),
    fundBalances: async () => 10000000n,
  };
  router.payout = async (...args) => {
    sends++;
    assert.ok(entries.size, 'journal must exist before wallet broadcast');
    assert.equal(prepared, 1, 'server payment reservation must be persisted first');
    assert.equal(args[2], claim.wallet);
    assert.equal(args[3], 10000000n);
    assert.equal(args[4], id(`decentbusking:promotions:v1:8453:${claim.campaignId}:${claim.wallet}`));
    if (sendError) throw sendError;
    return { hash: txHash, wait: async confirmations => { assert.equal(confirmations, 2); return { status: 1 }; } };
  };
  router.payout.staticCall = async () => {};
  const signer = { provider: { getNetwork: async () => ({ chainId: 8453n }) } };
  global.window = { _wallet: { address: owner, signer }, ethers: { id, ZeroHash, Contract: function () { return router; } } };
  const command = async c => {
    if (c.action === 'prepare-payment') prepared++;
    if (c.action === 'reconcile') { assert.equal(c.txHash, txHash); reconciled++; }
    return { claims: [{ ...claim, status: reconciled === 2 ? 'paid' : 'payment-pending' }] };
  };
  const execute = () => payPromotion({ claim, snapshot: { routerAddress }, command, status: {}, storage });
  return { execute, router, claim, entries, storage, signer, sends: () => sends,
    prepared: () => prepared, reconciled: () => reconciled, error: e => { sendError = e; } };
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
    await assert.rejects(f.execute(), /admin|network changed/);
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
test('money preserves six-decimal amounts and invite links keep the deployment subpath', async () => {
  const { promotionUnits, promotionMoney, promotionLink, PROMOTION_TEMPLATES } = await import('../js/promotions.mjs');
  assert.equal(promotionUnits('10.000001'), '10000001');
  assert.equal(promotionMoney('10000001'), '10.000001 USDC');
  assert.equal(promotionMoney('10000000'), '10.00 USDC');
  assert.throws(() => promotionUnits('0'), /positive/);
  assert.throws(() => promotionUnits('1e3'), /USDC amount/);
  assert.equal(promotionLink('offer', owner, 'https://site.example/DecentBusking/?tutorial=splits#old'),
    `https://site.example/DecentBusking/?promotion=offer&ref=${owner}`);
  assert.equal(PROMOTION_TEMPLATES.length, 6);
});
test('entry points expose the admin section and public offer while suppressing automatic tutorial interference', () => {
  const root = require('node:path').join(__dirname, '..');
  const html = fs.readFileSync(root + '/index.html', 'utf8');
  const admin = fs.readFileSync(root + '/js/admin.js', 'utf8');
  const ui = fs.readFileSync(root + '/js/promotions-ui.mjs', 'utf8');
  const tutorial = fs.readFileSync(root + '/js/tutorial.js', 'utf8');
  assert.match(html, /id="admin-promotions"/);
  assert.match(admin, /mountAdminPromotions/);
  assert.match(admin, /mountPublicPromotion\(\)/);
  assert.match(tutorial, /\.has\('promotion'\)\) return/);
  assert.match(ui, /newYorkInputToUtc/);
  assert.doesNotMatch(ui, /channels\/.*messages|api\/radio\/announcements\/send/);
  assert.match(ui, /target.type === 'submit'/);
});
