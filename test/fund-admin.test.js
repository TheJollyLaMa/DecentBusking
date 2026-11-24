const test = require('node:test');
const assert = require('node:assert/strict');
const ethers = require('../discord-bot/node_modules/ethers');

async function fixture() {
  const module = await import('../js/fund-admin.mjs');
  const { SETTLEMENT_ROUTER_ADDRESS: address } = await import('../js/fund-contribution.mjs');
  const owner = `0x${'2'.repeat(40)}`, hash = `0x${'3'.repeat(64)}`;
  const operation = { kind: 'status', slug: 'dbusk-referrals', address: owner, active: false };
  const iface = new ethers.Interface([...module.FUND_ADMIN_ABI,
    'event FundRecovered(bytes32 indexed fundId,address indexed asset,address indexed recipient,uint256 amount)']);
  const log = (name, args, emitter = address) => ({ address: emitter, ...iface.encodeEventLog(iface.getEvent(name), args) });
  let receipt = { status: 1, logs: [log('FundStatusUpdated', [ethers.id(operation.slug), false])] };
  const calls = [];
  const action = name => Object.assign(async (...args) => {
    calls.push([name, ...args]);
    return { hash, wait: async () => receipt };
  }, { staticCall: async () => { calls.push(['preflight']); } });
  const router = { target: address, interface: iface, DEFAULT_ADMIN_ROLE: async () => 'admin', hasRole: async () => true,
    funds: async () => ({ exists: true, active: true }), fundBalances: async () => 10n ** 18n,
    setFundActive: action('status'), recoverFund: action('recover') };
  const signer = { getAddress: async () => owner, provider: { getNetwork: async () => ({ chainId: 8453 }),
    getCode: async () => '0x1234', getBalance: async () => 10n ** 18n } };
  return { ...module, owner, hash, router, signer, operation, ethers, calls, log,
    receipt: () => receipt, setReceipt: value => { receipt = value; } };
}

test('admin archive preflights before journaling/broadcast and verifies the exact lifecycle event', async () => {
  const f = await fixture();
  const result = await f.sendFundAdminAction({ ...f, onStage: () => f.calls.push(['journal']),
    onBroadcast: hash => f.calls.push(['hash', hash]) });
  assert.equal(result, f.hash);
  assert.deepEqual(f.calls, [['preflight'], ['journal'],
    ['status', ethers.id('dbusk-referrals'), false], ['hash', f.hash]]);
  f.router.funds = async () => ({ exists: true, active: false });
  f.operation.active = true;
  f.setReceipt({ status: 1, logs: [f.log('FundStatusUpdated', [ethers.id(f.operation.slug), true])] });
  await f.sendFundAdminAction(f);
});

test('owner, Base, deployed fixed router, role, existence and stale status failures never journal or send', async () => {
  for (const change of [
    f => { f.owner = `0x${'4'.repeat(40)}`; },
    f => { f.signer.provider.getNetwork = async () => ({ chainId: 1 }); },
    f => { f.router.target = `0x${'4'.repeat(40)}`; },
    f => { f.signer.provider.getCode = async () => '0x'; },
    f => { f.router.hasRole = async () => false; },
    f => { f.router.funds = async () => ({ exists: false }); },
    f => { f.router.funds = async () => ({ exists: true, active: false }); },
    f => { f.router.setFundActive.staticCall = async () => { throw new Error('RPC preflight failed'); }; },
  ]) {
    const f = await fixture();
    change(f);
    await assert.rejects(f.sendFundAdminAction({ ...f, onStage: () => f.calls.push(['journal']) }));
    assert.deepEqual(f.calls, []);
  }
});

test('archived allocation ETH recovery is owner-only and verifies exact native amount and recipient', async () => {
  const f = await fixture();
  f.operation = { kind: 'recover', slug: 'dbusk-referrals', address: f.owner, amountUnits: '1000000000000001' };
  f.router.funds = async () => ({ exists: true, active: false });
  f.setReceipt({ status: 1, logs: [f.log('FundRecovered',
    [ethers.id(f.operation.slug), ethers.ZeroAddress, f.owner, BigInt(f.operation.amountUnits)])] });
  await f.sendFundAdminAction(f);
  assert.deepEqual(f.calls.at(-1), ['recover', ethers.id('dbusk-referrals'), ethers.ZeroAddress, f.owner, 1000000000000001n]);
  for (const getBalance of ['fundBalances', 'getBalance']) {
    const small = async () => 1n;
    if (getBalance === 'fundBalances') f.router.fundBalances = small;
    else { f.router.fundBalances = async () => 10n ** 18n; f.signer.provider.getBalance = small; }
    await assert.rejects(f.sendFundAdminAction(f), /exceeds available ETH/);
  }
});

test('wrong lifecycle and recovery proofs never count as confirmation', async () => {
  const f = await fixture();
  for (const [fund, active, emitter] of [
    ['another-fund', false], [f.operation.slug, true], [f.operation.slug, false, f.owner],
  ]) {
    assert.throws(() => f.verifyFundAdminReceipt({ ...f, receipt: { status: 1,
      logs: [f.log('FundStatusUpdated', [ethers.id(fund), active], emitter)] } }), /does not prove/);
  }
  f.operation = { kind: 'recover', slug: 'dbusk-referrals', address: f.owner, amountUnits: '100' };
  for (const [asset, recipient, amount] of [
    [f.owner, f.owner, 100n], [ethers.ZeroAddress, f.router.target, 100n], [ethers.ZeroAddress, f.owner, 99n],
  ]) {
    assert.throws(() => f.verifyFundAdminReceipt({ ...f, receipt: { status: 1,
      logs: [f.log('FundRecovered', [ethers.id(f.operation.slug), asset, recipient, amount])] } }), /does not prove/);
  }
  assert.throws(() => f.verifyFundAdminReceipt({ ...f, receipt: { status: 0, logs: [] } }), /successful/);
});

test('referral allocation creation followed by precise native funding needs no ERC20 approval', async () => {
  const f = await fixture();
  const { createConfiguredSettlementFund } = await import('../js/settlement-funds.mjs');
  const { createContributionController, contributionJournalKey } = await import('../js/fund-contribution.mjs');
  let exists = false;
  f.router.funds = async () => ({ exists, active: true });
  f.router.createFund = Object.assign(async () => ({ hash: f.hash, wait: async () => { exists = true; return { status: 1 }; } }),
    { staticCall: async () => {} });
  await createConfiguredSettlementFund({ ...f, fundId: ethers.id(f.operation.slug), metadataUri: 'ipfs://referral-metadata' });
  const iface = new ethers.Interface(['event FundFunded(bytes32 indexed fundId,address indexed asset,address indexed funder,uint256 amount)']);
  const receipt = { status: 1, logs: [{ address: f.router.target, ...iface.encodeEventLog(iface.getEvent('FundFunded'),
    [ethers.id(f.operation.slug), ethers.ZeroAddress, f.owner, 1000000000000001n]) }] };
  f.router.paused = async () => false;
  f.router.approvedAssets = async () => true;
  f.router.fundNative = Object.assign(async (id, value) => {
    assert.equal(id, ethers.id('dbusk-referrals'));
    assert.deepEqual(value, { value: 1000000000000001n });
    return { hash: f.hash, wait: async () => receipt };
  }, { staticCall: async () => {} });
  f.signer.provider.getTransactionReceipt = async () => receipt;
  const data = new Map(), storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  await f.verifyFundAdmin(f);
  const controller = createContributionController({ storage, ethers });
  await controller.contribute({ ...f, slug: f.operation.slug, asset: 'eth', amount: '0.001000000000000001' });
  assert.equal(storage.getItem(contributionJournalKey(f.owner, f.operation.slug, 'eth')), undefined);
});

test('admin catalog includes inactive project funds and actual ETH; public rotation excludes them and foreign metadata', async () => {
  const f = await fixture();
  const { loadContributionFunds } = await import('../js/fund-contribution.mjs');
  const { buildSettlementFundMetadata } = await import('../js/settlement-funds.mjs');
  const metadata = buildSettlementFundMetadata({ slug: 'community-grants', name: 'Community grants', description: 'Reviewed community rewards.',
    owner: f.owner, routerAddress: f.router.target, fundId: ethers.id('community-grants'), createdAt: '2026-11-24T00:00:00Z' });
  const records = new Map([
    [ethers.id('dbusk-playback'), { exists: true, active: false, metadataUri: 'https://app.test/playback' }],
    [ethers.id('community-grants'), { exists: true, active: false, metadataUri: 'ipfs://grants' }],
    [ethers.id('foreign-fund'), { exists: true, active: true, metadataUri: 'ipfs://foreign' }],
  ]);
  f.router.allFundIds = async () => [...records.keys()];
  f.router.funds = async id => records.get(id);
  f.router.fundBalances = async (_id, asset) => asset === ethers.ZeroAddress ? 123n : 456n;
  const options = { ...f, readMetadata: async uri => uri === 'ipfs://grants' ? metadata : { schema: 'other-app/fund' } };
  assert.deepEqual(await loadContributionFunds(options), []);
  const admin = await loadContributionFunds({ ...options, includeInactive: true });
  assert.deepEqual(admin.map(fund => [fund.slug, fund.active, fund.nativeBalanceUnits]), [
    ['dbusk-playback', false, '123'], ['community-grants', false, '123'],
  ]);
});
