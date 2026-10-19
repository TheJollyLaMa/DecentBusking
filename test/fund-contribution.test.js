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
  const approve = async (spender, amount) => {
    calls.push(['approve', spender, amount]);
    return { hash: `0x${'4'.repeat(64)}`, wait: async () => ({ status: 1 }) };
  };
  const fundToken = async (...args) => {
    calls.push(['fundToken', ...args]);
    return { hash, wait: async () => receipt };
  };
  fundToken.staticCall = async () => {};
  const router = { target: module.SETTLEMENT_ROUTER_ADDRESS, paused: async () => false,
    funds: async () => ({ exists: true, active: true }), approvedAssets: async () => true, fundToken };
  const token = { target: BASE_USDC_ADDRESS, decimals: async () => 6, balanceOf: async () => 2000000000n,
    allowance: async () => 0n, approve };
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
  assert.throws(() => value.contributionJournalKey(value.address, 'dbusk-repo-dev'), /Invalid/);
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

test('contribution UI never opens a wallet on load or preset selection and confirms the exact custom amount', async context => {
  const value = await fixture();
  const { initFundContributions } = await import('../js/fund-contribution.mjs');
  const node = () => ({ dataset: {}, value: '', textContent: '', disabled: false, listeners: {},
    addEventListener(type, callback) { this.listeners[type] = callback; }, focus() {}, append() {} });
  const form = node();
  const amount = node();
  const slug = node();
  slug.value = 'dbusk-top10';
  const preset = node();
  preset.dataset.contributionAmount = '1000';
  const check = node();
  const status = node();
  const controls = [amount, slug, preset, check];
  form.querySelectorAll = selector => selector === '[data-contribution-amount]' ? [preset] : controls;
  const nodes = { 'fund-contribution-form': form, 'fund-contribution-status': status,
    'fund-contribution-slug': slug, 'fund-contribution-amount': amount, 'fund-contribution-check': check };
  const previousWindow = global.window;
  const previousDocument = global.document;
  context.after(() => { global.window = previousWindow; global.document = previousDocument; });
  const confirmations = [];
  let walletRequests = 0;
  global.window = { ethers, localStorage: value.storage, confirm: message => { confirmations.push(message); return false; },
    _wallet: { connect: async () => { walletRequests++; } } };
  global.document = { getElementById: id => nodes[id] };
  initFundContributions();
  assert.equal(walletRequests, 0);
  preset.listeners.click();
  assert.equal(amount.value, '1000');
  assert.equal(walletRequests, 0);
  amount.value = '2.123456';
  form.listeners.submit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.match(confirmations[0], /Add 2\.123456 USDC to dbusk-top10 on Base/);
  assert.equal(walletRequests, 0);
  assert.equal(value.calls.length, 0);
  assert.equal(value.data.size, 0);
  assert.ok(controls.every(control => !control.disabled));
});
