const test = require('node:test');
const assert = require('node:assert/strict');
const ethers = require('../discord-bot/node_modules/ethers');

async function fixture() {
  const module = await import('../js/fund-contribution.mjs');
  const { BASE_USDC_ADDRESS } = await import('../js/settlement-funds.mjs');
  const address = `0x${'2'.repeat(40)}`;
  const slug = 'dbusk-playback';
  const hash = `0x${'3'.repeat(64)}`;
  const data = new Map();
  const storage = { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key) };
  const iface = new ethers.Interface([
    'event FundFunded(bytes32 indexed fundId,address indexed asset,address indexed funder,uint256 amount)',
    'event Transfer(address indexed from,address indexed to,uint256 value)',
    'event Approval(address indexed owner,address indexed spender,uint256 value)',
  ]);
  const log = (name, args, emitter) => ({ ...iface.encodeEventLog(iface.getEvent(name), args), address: emitter });
  let receipt = { status: 1, logs: [
    log('FundFunded', [ethers.id(slug), BASE_USDC_ADDRESS, address, 5000000n], module.SETTLEMENT_ROUTER_ADDRESS),
    log('Transfer', [address, module.SETTLEMENT_ROUTER_ADDRESS, 5000000n], BASE_USDC_ADDRESS),
  ] };
  const signer = { getAddress: async () => address, provider: {
    getNetwork: async () => ({ chainId: 8453 }), getCode: async () => '0x123',
    getTransactionReceipt: async () => receipt,
  } };
  const calls = [];
  let allowance = 0n;
  const approve = async (spender, amount) => {
    calls.push(['approve', spender, amount]);
    allowance = amount;
    return { hash: `0x${'4'.repeat(64)}`, wait: async () => ({ status: 1, logs: [
      log('Approval', [address, spender, amount], BASE_USDC_ADDRESS),
    ] }) };
  };
  const fundToken = async (...args) => {
    calls.push(['fundToken', ...args]);
    return { hash, wait: async () => receipt };
  };
  fundToken.staticCall = async () => {};
  const router = { target: module.SETTLEMENT_ROUTER_ADDRESS, paused: async () => false,
    funds: async () => ({ exists: true, active: true }), approvedAssets: async () => true, fundToken };
  const token = { target: BASE_USDC_ADDRESS, decimals: async () => 6, balanceOf: async () => 2000000000n,
    allowance: async () => allowance, approve };
  const options = { signer, router, token, slug, amount: '5' };
  const controller = module.createContributionController({ storage, ethers });
  return { ...module, BASE_USDC_ADDRESS, address, slug, hash, log, storage, signer, router, token, options,
    calls, data, controller, receipt: () => receipt, setReceipt: value => { receipt = value; },
    key: module.contributionJournalKey(address, slug) };
}

test('public contribution parses suggested and precise amounts without floating point or permissive fallbacks', async () => {
  const { contributionUnits } = await fixture();
  for (const [input, expected] of [['5', 5000000n], ['10', 10000000n], ['1000', 1000000000n], ['0.000001', 1n], ['2.123456', 2123456n]]) {
    assert.equal(contributionUnits(input), expected);
  }
  for (const input of ['0', '-5', '1e3', '5.1234567', '', '5foo', ' 5', '0x10', 'Infinity', '1,000']) {
    assert.throws(() => contributionUnits(input), /positive USDC/);
  }
});

test('custom percentages allocate every micro-USDC and reject invalid or dust splits', async () => {
  const { contributionPlan, contributionAmount, contributionFunds } = await fixture();
  assert.equal(contributionFunds().length, 7);
  const plan = contributionPlan('1.000001', [
    { slug: 'dbusk-playback', percent: '33.33' },
    { slug: 'dbusk-top10', percent: '33.33' },
    { slug: 'dbusk-repo-dev', percent: '33.34' },
  ]);
  assert.deepEqual(plan.map(leg => leg.amountUnits), ['333300', '333300', '333401']);
  assert.equal(plan.reduce((sum, leg) => sum + BigInt(leg.amountUnits), 0n), 1000001n);
  assert.equal(contributionAmount(333401n), '0.333401');
  assert.throws(() => contributionPlan('5', [{ slug: 'dbusk-top10', percent: '99' }]), /100%/);
  assert.throws(() => contributionPlan('5', [{ slug: 'bad--slug', percent: '100' }]), /valid fund/);
  assert.throws(() => contributionPlan('5', [
    { slug: 'dbusk-top10', percent: '50' }, { slug: 'dbusk-top10', percent: '50' },
  ]), /at most once/);
  assert.throws(() => contributionPlan('0.000001', [
    { slug: 'dbusk-playback', percent: '50' }, { slug: 'dbusk-top10', percent: '50' },
  ]), /at least 0.000001/);
});

test('a partially cancelled split resumes only unfinished funds and retains proven receipts', async () => {
  const value = await fixture();
  let rejectSecond = true;
  const calls = [];
  const controller = value.createContributionController({ storage: value.storage, ethers, deposit: async options => {
    const slug = options.fundId === ethers.id('dbusk-playback') ? 'dbusk-playback' : 'dbusk-top10';
    calls.push(slug);
    options.onStage('deposit');
    if (slug === 'dbusk-top10' && rejectSecond) throw Object.assign(new Error('Rejected second payment'), { code: 4001 });
    options.onBroadcast({ stage: 'deposit', txHash: value.hash });
    value.setReceipt({ status: 1, logs: [
      value.log('FundFunded', [ethers.id(slug), value.BASE_USDC_ADDRESS, value.address, options.amountUnits], value.SETTLEMENT_ROUTER_ADDRESS),
      value.log('Transfer', [value.address, value.SETTLEMENT_ROUTER_ADDRESS, options.amountUnits], value.BASE_USDC_ADDRESS),
    ] });
    return { txHash: value.hash };
  } });
  const plan = value.contributionPlan('5', [
    { slug: 'dbusk-playback', percent: '50' }, { slug: 'dbusk-top10', percent: '50' },
  ]);
  const options = { ...value.options, plan };
  await assert.rejects(controller.contributeSplit(options), /Rejected second/);
  const journal = JSON.parse([...value.data.values()][0]);
  assert.equal(journal.legs[0].status, 'confirmed');
  assert.equal(journal.legs[0].txHash, value.hash);
  await assert.rejects(controller.contributeSplit(options), /unfinished/);
  rejectSecond = false;
  const result = await controller.contributeSplit({ ...options, resume: true });
  assert.deepEqual(calls, ['dbusk-playback', 'dbusk-top10', 'dbusk-top10']);
  assert.ok(result.every(leg => leg.status === 'confirmed'));
  assert.equal(value.data.size, 0);
});

test('split cancellation cannot unlock an uncertain transaction, and single receipt recovery updates the split before unlocking', async () => {
  const value = await fixture();
  const planKey = `decentbusking:fund-split:8453:${value.SETTLEMENT_ROUTER_ADDRESS.toLowerCase()}:${value.address.toLowerCase()}`;
  const legs = [{ slug: value.slug, amountUnits: '5000000', status: 'pending', txHash: '' }];
  value.storage.setItem(planKey, JSON.stringify({ address: value.address, legs }));
  value.storage.setItem(value.key, JSON.stringify({ address: value.address, slug: value.slug,
    amountUnits: '5000000', stage: 'deposit', txHash: value.hash }));
  await assert.rejects(value.controller.abandonSplit(value.options), /unresolved/);
  assert.equal((await value.controller.check(value.options)).stage, 'deposit');
  assert.equal(JSON.parse(value.storage.getItem(planKey)).legs[0].status, 'confirmed');
  assert.equal(value.storage.getItem(value.key), null);
  const results = await value.controller.abandonSplit(value.options);
  assert.equal(results[0].txHash, value.hash);
  assert.equal(value.data.size, 0);
});

test('any connected contributor can fund the selected pool with exact USDC approval and verified deposit', async () => {
  const value = await fixture();
  const result = await value.controller.contribute(value.options);
  assert.equal(result.txHash, value.hash);
  assert.deepEqual(value.calls, [
    ['approve', value.SETTLEMENT_ROUTER_ADDRESS, 5000000n],
    ['fundToken', ethers.id('dbusk-playback'), value.BASE_USDC_ADDRESS, 5000000n],
  ]);
  assert.equal(value.data.size, 0);
});

test('a second unresolved deposit is blocked across reload and isolated by wallet/fund', async () => {
  const value = await fixture();
  value.setReceipt(null);
  await assert.rejects(value.controller.contribute(value.options), /did not confirm/);
  assert.equal(JSON.parse(value.storage.getItem(value.key)).stage, 'deposit');
  const restored = value.createContributionController({ storage: value.storage, ethers });
  await assert.rejects(restored.contribute(value.options), /earlier contribution is unresolved/);
  assert.equal(value.calls.length, 2);
  assert.notEqual(value.key, value.contributionJournalKey(value.address, 'dbusk-top10'));
  assert.notEqual(value.key, value.contributionJournalKey(`0x${'5'.repeat(40)}`, value.slug));
  assert.throws(() => value.contributionJournalKey(value.address, 'bad--slug'), /Invalid/);
});

test('pending deposits require exact fund, token, sender, amount and token-transfer proofs', async () => {
  const value = await fixture();
  const operation = { address: value.address, slug: value.slug, amountUnits: '5000000', stage: 'deposit' };
  const good = value.receipt();
  assert.equal(value.verifyContributionReceipt({ receipt: good, operation, ethers }), 'deposit');
  for (const receipt of [
    { ...good, logs: [good.logs[0]] }, { ...good, logs: [good.logs[1]] },
    { ...good, logs: good.logs.map(log => ({ ...log, address: `0x${'9'.repeat(40)}` })) },
    { status: 0, logs: good.logs },
  ]) assert.throws(() => value.verifyContributionReceipt({ receipt, operation, ethers }));
  for (const changed of [{ slug: 'dbusk-top10' }, { amountUnits: '10000000' }, { address: `0x${'8'.repeat(40)}` }, { stage: 'approval' }]) {
    assert.throws(() => value.verifyContributionReceipt({ receipt: good, operation: { ...operation, ...changed }, ethers }));
  }
});

test('receipt recovery distinguishes approval from deposit and unlocks only the recorded successful stage or revert', async () => {
  const value = await fixture();
  const operation = { address: value.address, slug: value.slug, amountUnits: '5000000', stage: 'deposit', txHash: value.hash };
  value.storage.setItem(value.key, JSON.stringify(operation));
  value.setReceipt({ status: 1, logs: [value.log('Approval', [value.address, value.SETTLEMENT_ROUTER_ADDRESS, 5000000n], value.BASE_USDC_ADDRESS)] });
  await assert.rejects(value.controller.check(value.options), /does not prove/);
  assert.ok(value.storage.getItem(value.key));
  value.storage.setItem(value.key, JSON.stringify({ ...operation, stage: 'approval' }));
  assert.equal((await value.controller.check(value.options)).stage, 'approval');
  assert.equal(value.storage.getItem(value.key), null);
  value.storage.setItem(value.key, JSON.stringify(operation));
  value.setReceipt({ status: 0, logs: [] });
  assert.equal((await value.controller.check(value.options)).stage, 'reverted');
  assert.equal(value.storage.getItem(value.key), null);
});

test('uncertain broadcasts remain locked; wallet rejection before broadcast is safe to retry', async () => {
  const value = await fixture();
  value.router.fundToken = async () => { throw Object.assign(new Error('Rejected'), { code: 4001 }); };
  value.router.fundToken.staticCall = async () => {};
  await assert.rejects(value.controller.contribute(value.options), /Rejected/);
  assert.equal(value.storage.getItem(value.key), null);
  value.router.fundToken = async () => { throw new Error('Disconnected during broadcast'); };
  value.router.fundToken.staticCall = async () => {};
  await assert.rejects(value.controller.contribute(value.options), /Disconnected/);
  assert.ok(value.storage.getItem(value.key));
  await assert.rejects(value.controller.check(value.options), /Broadcast status is unknown/);
});

test('disabled storage, wrong network, insufficient USDC and unavailable funds never send money', async () => {
  for (const modify of [
    value => { value.storage.setItem = () => { throw new Error('Storage unavailable'); }; },
    value => { value.signer.provider.getNetwork = async () => ({ chainId: 10 }); },
    value => { value.token.balanceOf = async () => 0n; },
    value => { value.router.funds = async () => ({ exists: false }); },
    value => { value.router.paused = async () => true; },
  ]) {
    const value = await fixture();
    modify(value);
    await assert.rejects(value.controller.contribute(value.options));
    assert.equal(value.calls.length, 0);
  }
});

test('receipt recovery verifies a confirmed deposit and refuses pending or wrong-chain receipts', async () => {
  const value = await fixture();
  const operation = { address: value.address, slug: value.slug, amountUnits: '5000000', stage: 'deposit', txHash: value.hash };
  value.storage.setItem(value.key, JSON.stringify(operation));
  const good = value.receipt();
  value.setReceipt(null);
  await assert.rejects(value.controller.check(value.options), /still pending/);
  value.signer.provider.getNetwork = async () => ({ chainId: 10 });
  await assert.rejects(value.controller.check(value.options), /Switch your wallet to Base/);
  value.signer.provider.getNetwork = async () => ({ chainId: 8453 });
  value.setReceipt(good);
  assert.equal((await value.controller.check(value.options)).stage, 'deposit');
  assert.equal(value.storage.getItem(value.key), null);
});

test('only created active funds are offered, including empty funds, with balances read from the router', async () => {
  const { loadContributionFunds, BASE_USDC_ADDRESS } = await fixture();
  const balances = new Map([
    [ethers.id('dbusk-playback'), 1234567n], [ethers.id('dbusk-referrals'), 0n],
  ]);
  const reads = [];
  const router = {
    allFundIds: async () => [...balances.keys(), ethers.id('dbusk-top10')],
    funds: async id => ({ exists: balances.has(id) || id === ethers.id('dbusk-top10'), active: balances.has(id) }),
    fundBalances: async (id, asset) => { reads.push(id); return asset === BASE_USDC_ADDRESS ? balances.get(id) : 1n; },
  };
  assert.deepEqual((await loadContributionFunds({ ethers, router })).map(fund => [fund.slug, fund.balanceUnits]),
    [['dbusk-playback', '1234567'], ['dbusk-referrals', '0']]);
  assert.equal(reads.length, 3);
  router.funds = async () => { throw new Error('RPC offline'); };
  await assert.rejects(loadContributionFunds({ ethers, router }), /RPC offline/);
});

test('ETH uses exact wei, amount splits match independent totals, and radio funds cannot receive ETH', async () => {
  const { contributionPlan, contributionUnits, contributionAmount, contributionJournalKey, address } = await fixture();
  assert.equal(contributionUnits('0.000000000000000001', 'eth'), 1n);
  assert.equal(contributionAmount(1000000000000001n, 'eth'), '0.001000000000000001');
  const shares = [{ slug: 'dbusk-repo-dev', amount: '0.001' }, { slug: 'dbusk-pinners', amount: '0.002' }];
  const plan = contributionPlan('0.003', shares, { asset: 'eth', mode: 'amount' });
  assert.deepEqual(plan.map(leg => leg.amountUnits), ['1000000000000000', '2000000000000000']);
  assert.ok(plan.every(leg => leg.asset === 'eth'));
  assert.throws(() => contributionPlan('0.004', shares, { asset: 'eth', mode: 'amount' }), /match its total/);
  for (const slug of ['dbusk-top10', 'dbusk-playback']) {
    assert.throws(() => contributionPlan('0.01', [{ slug, percent: '100' }], { asset: 'eth' }), /USDC only/);
    assert.throws(() => contributionJournalKey(address, slug, 'eth'), /USDC only/);
  }
  assert.notEqual(contributionJournalKey(address, 'dbusk-repo-dev'), contributionJournalKey(address, 'dbusk-repo-dev', 'eth'));
  assert.throws(() => contributionUnits('0.0000000000000000001', 'eth'), /18/);
});

test('registry discovery progressively includes a new verified Busking fund, never another project or an inactive fund', async () => {
  const { loadContributionFunds, SETTLEMENT_ROUTER_ADDRESS } = await fixture();
  const slug = 'community-studio';
  const metadata = { schema: 'decentbusking/settlement-fund/v1', fundSlug: slug, fundId: ethers.id(slug),
    name: '<Studio & friends>', description: 'Support rehearsals.', earningRules: 'Apply for an approved rehearsal.',
    chainId: 8453, routerAddress: SETTLEMENT_ROUTER_ADDRESS };
  const records = new Map([
    [ethers.id('dbusk-playback'), ['https://example.test/known', true, true]],
    [ethers.id(slug), ['ipfs://studio', true, true]],
    [ethers.id('foreign-one'), ['ipfs://foreign', true, true]],
    [ethers.id('foreign-two'), ['ipfs://foreign', true, true]],
    [ethers.id('dbusk-inactive'), ['ipfs://inactive', false, true]],
  ]);
  const reads = [], updates = [], warnings = [];
  const router = {
    allFundIds: async () => [...records.keys()],
    funds: async id => ethers.Result.fromItems(records.get(id), ['metadataUri', 'active', 'exists']),
    fundBalances: async () => 0n,
  };
  const funds = await loadContributionFunds({ ethers, router, onUpdate: rows => updates.push(rows),
    onWarning: warning => warnings.push(warning), readMetadata: async uri => {
      assert.deepEqual(updates[0].map(fund => fund.slug), ['dbusk-playback']);
      reads.push(uri);
      return uri === 'ipfs://studio' ? metadata : { schema: 'another-project/v1', name: 'Foreign' };
    } });
  assert.deepEqual(funds.map(fund => fund.slug), ['dbusk-playback', slug]);
  assert.equal(funds[1].earningRules, metadata.earningRules);
  const { contributionPlan } = await fixture();
  assert.equal(contributionPlan('1', [{ slug: funds[1].slug, percent: '100' }])[0].slug, slug);
  assert.deepEqual(reads, ['ipfs://studio', 'ipfs://foreign']);
  assert.deepEqual(warnings, []);
});

test('unreadable or mismatched fund metadata reports incomplete discovery, preserving known balances and retrying next time', async () => {
  const { loadContributionFunds, SETTLEMENT_ROUTER_ADDRESS } = await fixture();
  const known = ethers.id('dbusk-playback'), custom = ethers.id('dbusk-new');
  const warnings = [];
  const router = { allFundIds: async () => [known, custom],
    funds: async id => ({ metadataUri: `ipfs://${id}`, active: true, exists: true }), fundBalances: async () => 12n };
  let attempts = 0;
  for (const metadata of [null, { schema: 'decentbusking/settlement-fund/v1', fundSlug: 'dbusk-new',
    fundId: custom, chainId: 8453, routerAddress: `0x${'9'.repeat(40)}`, name: 'Wrong router', description: 'Mismatch' }]) {
    const funds = await loadContributionFunds({ ethers, router, readMetadata: async () => { attempts++; return metadata; },
      onWarning: warning => warnings.push(warning) });
    assert.deepEqual(funds.map(fund => [fund.slug, fund.balanceUnits]), [['dbusk-playback', '12']]);
  }
  assert.equal(attempts, 2);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /may be missing/);
  assert.match(warnings[1], /does not match/);
  const { discoveredFund } = await import('../js/fund-discovery.mjs');
  const valid = { schema: 'decentbusking/settlement-fund/v1', fundSlug: 'dbusk-new', fundId: custom,
    chainId: 8453, routerAddress: SETTLEMENT_ROUTER_ADDRESS, name: 'New', description: 'Purpose' };
  for (const change of [{ chainId: 1 }, { fundId: known }, { schema: 'other/v1' }, { earningRules: {} }]) {
    assert.throws(() => discoveredFund({ ...valid, ...change }, { fundId: custom, routerAddress: SETTLEMENT_ROUTER_ADDRESS, ethers }));
  }
});

test('a newly discovered fund retains uncertain ETH receipt recovery across reload without resending', async () => {
  const value = await fixture(), slug = 'community-studio';
  const amountUnits = '1000000000000000';
  const key = value.contributionJournalKey(value.address, slug, 'eth');
  const planKey = `decentbusking:fund-split:8453:${value.SETTLEMENT_ROUTER_ADDRESS.toLowerCase()}:${value.address.toLowerCase()}`;
  value.storage.setItem(planKey, JSON.stringify({ address: value.address,
    legs: [{ slug, asset: 'eth', amountUnits, status: 'pending', txHash: '' }] }));
  value.storage.setItem(key, JSON.stringify({ address: value.address, slug, asset: 'eth', amountUnits, stage: 'deposit', txHash: value.hash }));
  value.setReceipt({ status: 1, logs: [
    value.log('FundFunded', [ethers.id(slug), ethers.ZeroAddress, value.address, amountUnits], value.SETTLEMENT_ROUTER_ADDRESS),
  ] });
  const restored = value.createContributionController({ storage: value.storage, ethers });
  assert.equal(restored.recovery(value.address).operations[0].slug, slug);
  await restored.check({ signer: value.signer, slug, asset: 'eth' });
  assert.equal(JSON.parse(value.storage.getItem(planKey)).legs[0].status, 'confirmed');
  assert.deepEqual(value.calls, []);
});

test('bunny copy distinguishes verified pinner rewards and unpublished rules; chart identities and labels remain escaped', async () => {
  const { fundGuideCopy } = await import('../js/fund-guide.mjs');
  const { renderFundBalanceChart } = await import('../js/fund-visual.mjs');
  assert.match(fundGuideCopy({ slug: 'dbusk-pinners' }).earning, /independent checks/);
  assert.match(fundGuideCopy({ slug: 'dbusk-pinners' }).earning, /pin click alone does not qualify/);
  assert.match(fundGuideCopy({ slug: 'dbusk-new' }).earning, /No earning schedule/);
  assert.equal(fundGuideCopy({ slug: 'dbusk-new', description: 'Purpose', earningRules: 'Published terms' }).earning, 'Published terms');
  const html = renderFundBalanceChart([{ slug: 'dbusk-new', label: '<img onerror=alert(1)>', units: '1', amountText: '$0.01' }]);
  assert.match(html, /data-fund-chart-slug="dbusk-new"/);
  assert.ok(!html.includes('<img'));
});

test('native contribution proof requires the exact native FundFunded event, not an unrelated USDC receipt', async () => {
  const value = await fixture();
  const operation = { address: value.address, slug: 'dbusk-repo-dev', asset: 'eth', amountUnits: '1000000000000000', stage: 'deposit' };
  const receipt = { status: 1, logs: [value.log('FundFunded',
    [ethers.id(operation.slug), ethers.ZeroAddress, value.address, BigInt(operation.amountUnits)], value.SETTLEMENT_ROUTER_ADDRESS)] };
  assert.equal(value.verifyContributionReceipt({ receipt, operation, ethers }), 'deposit');
  assert.throws(() => value.verifyContributionReceipt({ receipt: value.receipt(), operation, ethers }), /does not prove/);
  assert.throws(() => value.verifyContributionReceipt({ receipt, operation: { ...operation, amountUnits: '2' }, ethers }), /does not prove/);
});

test('a mixed-currency series approves the USDC total once and resumes only its unconfirmed ETH leg', async () => {
  const value = await fixture();
  const sent = [];
  let rejectEth = true;
  const fundedReceipt = (id, asset, units) => ({ status: 1, logs: [
    value.log('FundFunded', [id, asset, value.address, units], value.SETTLEMENT_ROUTER_ADDRESS),
    ...(asset === ethers.ZeroAddress ? [] : [value.log('Transfer',
      [value.address, value.SETTLEMENT_ROUTER_ADDRESS, units], value.BASE_USDC_ADDRESS)]),
  ] });
  const fundToken = async (id, asset, units) => {
    sent.push(['usdc', id, units]);
    value.setReceipt(fundedReceipt(id, asset, units));
    return { hash: value.hash, wait: async () => value.receipt() };
  };
  fundToken.staticCall = async () => {};
  value.router.fundToken = fundToken;
  const fundNative = async (id, { value: units }) => {
    if (rejectEth) throw Object.assign(new Error('ETH rejected'), { code: 4001 });
    sent.push(['eth', id, units]);
    value.setReceipt(fundedReceipt(id, ethers.ZeroAddress, units));
    return { hash: value.hash, wait: async () => value.receipt() };
  };
  fundNative.staticCall = async () => {};
  value.router.fundNative = fundNative;
  value.signer.provider.getBalance = async () => 10n ** 18n;
  const plan = [
    ...value.contributionPlan('3', [{ slug: 'dbusk-repo-dev', amount: '1' }, { slug: 'dbusk-pinners', amount: '2' }], { mode: 'amount' }),
    ...value.contributionPlan('0.001', [{ slug: 'dbusk-repo-dev', percent: '100' }], { asset: 'eth' }),
  ];
  await assert.rejects(value.controller.contributeSplit({ ...value.options, plan }), /ETH rejected/);
  assert.equal(value.calls.filter(call => call[0] === 'approve').length, 1);
  assert.equal(value.calls[0][2], 3000000n);
  const saved = value.controller.recovery(value.address);
  assert.deepEqual(saved.split.legs.map(leg => leg.status), ['confirmed', 'confirmed', 'pending']);
  assert.equal(saved.operations.length, 0);
  rejectEth = false;
  const results = await value.controller.contributeSplit({ ...value.options, resume: true });
  assert.deepEqual(sent.map(row => row[0]), ['usdc', 'usdc', 'eth']);
  assert.equal(sent[2][2], 1000000000000000n);
  assert.equal(value.calls.filter(call => call[0] === 'approve').length, 1);
  assert.ok(results.every(leg => leg.status === 'confirmed'));
  assert.equal(value.data.size, 0);
});

test('fund charts retain exact labels, escape text, distinguish zero balances and use the selected shape', async () => {
  const { renderFundBalanceChart } = await import('../js/fund-visual.mjs');
  const rows = [{ label: 'A <fund>', units: '1', amountText: '0.000001 USDC' },
    { label: 'B', units: '3', amountText: '0.000003 USDC' }];
  const bars = renderFundBalanceChart(rows);
  assert.match(bars, /A &lt;fund&gt;/);
  assert.match(bars, /0\.000001 USDC/);
  assert.match(bars, /--fund-width:33\.33%/);
  const pie = renderFundBalanceChart(rows, 'pie');
  assert.match(pie, /conic-gradient\(#91ddd3 0% 25%,#ddbc7b 25% 100%\)/);
  assert.doesNotMatch(pie, /fund-chart-track/);
  assert.match(renderFundBalanceChart([{ label: 'Empty', units: '0', amountText: '0 ETH' }], 'pie'), /No balance in this currency/);
});
