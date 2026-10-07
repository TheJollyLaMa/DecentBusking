const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const url = pathToFileURL(path.join(__dirname, '../js/settlement-funds.mjs')).href;

function fixture() {
  let exists = false;
  let sent = 0;
  const createFund = async () => { sent++; return { hash: `0x${'1'.repeat(64)}`, wait: async () => { exists = true; return { status: 1 }; } }; };
  createFund.staticCall = async () => {};
  return { owner: '0xowner', fundId: `0x${'2'.repeat(64)}`, metadataUri: 'https://site.example/payroll-assets.json',
    signer: { getAddress: async () => '0xowner', provider: { getNetwork: async () => ({ chainId: 8453 }), getCode: async () => '0x1234' } },
    router: { target: '0xrouter', DEFAULT_ADMIN_ROLE: async () => 'admin', hasRole: async () => true,
      funds: async () => ({ exists }), createFund }, sent: () => sent };
}

test('fund creation requires owner, Base, router admin, metadata, and confirmed existence', async () => {
  const { createConfiguredSettlementFund } = await import(url);
  const options = fixture();
  const result = await createConfiguredSettlementFund(options);
  assert.equal(result.alreadyExists, false);
  assert.equal(options.sent(), 1);
  assert.equal((await createConfiguredSettlementFund(options)).alreadyExists, true);
  assert.equal(options.sent(), 1);
});

test('fund preflight rejects wrong owners, chains, roles, addresses, and URI without a transaction', async () => {
  const { createConfiguredSettlementFund } = await import(url);
  for (const modify of [
    options => { options.owner = '0xother'; },
    options => { options.signer.provider.getNetwork = async () => ({ chainId: 10 }); },
    options => { options.router.hasRole = async () => false; },
    options => { options.signer.provider.getCode = async () => '0x'; },
    options => { options.metadataUri = 'javascript:alert(1)'; },
    options => { options.fundId = `0x${'0'.repeat(64)}`; },
  ]) {
    const options = fixture();
    modify(options);
    await assert.rejects(createConfiguredSettlementFund(options));
    assert.equal(options.sent(), 0);
  }
});

test('fund selector uses only this app configured radio and repository allocations', async () => {
  const { configuredSettlementFunds, validateSettlementFundSlug, resolveSettlementFundSlug } = await import(url);
  assert.deepEqual(configuredSettlementFunds({ radioFunds: { playback: 'dbusk-playback', topTen: 'dbusk-top10' }, fundSlug: 'dbusk-repo-dev' })
    .map(fund => fund.slug), ['dbusk-playback', 'dbusk-top10', 'dbusk-repo-dev']);
  assert.equal(configuredSettlementFunds({ fundSlug: 'wrong#slug' }).length, 0);
  assert.equal(resolveSettlementFundSlug('__custom_fund__', 'dmtv-referrals', { fundSlug: 'dbusk-repo-dev' }), 'dmtv-referrals');
  assert.equal(resolveSettlementFundSlug('dmtv-referrals', '', {}, ['dmtv-referrals']), 'dmtv-referrals');
  assert.throws(() => validateSettlementFundSlug('DMTV Referrals'), /Fund slug must be/);
  assert.throws(() => resolveSettlementFundSlug('__custom_fund__', 'dbusk-repo-dev', { fundSlug: 'dbusk-repo-dev' }), /configured fund/);
});

test('custom fund slugs allow purpose names while rejecting malformed and configured names', async () => {
  const { resolveSettlementFundSlug } = await import(url);
  const config = { radioFunds: { playback: 'dbusk-playback', topTen: 'dbusk-top10' }, fundSlug: 'dbusk-repo-dev' };
  for (const slug of ['jukebox-sponsors', 'dmtv-referrals', 'community-grants', 'art-sales']) {
    assert.equal(resolveSettlementFundSlug('__custom_fund__', slug, config), slug);
  }
  for (const slug of ['dbusk-playback', 'dbusk-top10', 'dbusk-repo-dev']) {
    assert.throws(() => resolveSettlementFundSlug('__custom_fund__', slug, config), /configured fund/);
  }
  assert.equal(resolveSettlementFundSlug('__custom_fund__', 'UPPER', config), 'upper');
  for (const slug of ['two--hyphens', '-leading', 'trailing-', 'with spaces', 'a'.repeat(65)]) {
    assert.throws(() => resolveSettlementFundSlug('__custom_fund__', slug, config));
  }
});

test('purpose metadata includes validated Base fund identity and optional HTTPS website', async () => {
  const { buildSettlementFundMetadata } = await import(url);
  const input = { slug: 'referral-prizes', name: ' Referral Prizes ', description: ' Rewards for verified referrals. ',
    routerAddress: `0x${'1'.repeat(40)}`, owner: `0x${'2'.repeat(40)}`, fundId: `0x${'3'.repeat(64)}`, createdAt: '2026-10-07T12:00:00Z' };
  const metadata = buildSettlementFundMetadata(input);
  assert.equal(metadata.name, 'Referral Prizes');
  assert.equal(metadata.description, 'Rewards for verified referrals.');
  assert.equal(metadata.fundSlug, input.slug);
  assert.equal(metadata.chainId, 8453);
  assert.equal(metadata.routerAddress, input.routerAddress);
  assert.equal(metadata.owner, input.owner);
  assert.equal(metadata.fundId, input.fundId);
  assert.equal(metadata.createdAt, '2026-10-07T12:00:00.000Z');
  assert.equal(metadata.external_url, undefined);
  assert.equal(buildSettlementFundMetadata({ ...input, website: 'https://example.org/referrals' }).external_url, 'https://example.org/referrals');
  for (const invalid of [{ name: '' }, { name: 'x'.repeat(121) }, { description: '' }, { description: 'x'.repeat(2001) },
    { website: 'javascript:alert(1)' }, { website: 'https://user:password@example.org' }, { routerAddress: 'wrong' },
    { owner: '' }, { fundId: 'wrong' }, { createdAt: 'not-a-date' }, { slug: 'bad--slug' }]) {
    assert.throws(() => buildSettlementFundMetadata({ ...input, ...invalid }));
  }
});

test('failed creation receipts do not report a created fund', async () => {
  const { createConfiguredSettlementFund } = await import(url);
  const options = fixture();
  const createFund = async () => ({ hash: `0x${'1'.repeat(64)}`, wait: async () => ({ status: 0 }) });
  createFund.staticCall = async () => {};
  options.router.createFund = createFund;
  await assert.rejects(createConfiguredSettlementFund(options), /not confirmed successfully/);
});

test('USDC deposits approve only the exact shortfall-needed amount and skip sufficient allowances', async () => {
  const { depositSettlementUsdc, BASE_USDC_ADDRESS } = await import(url);
  for (const allowance of [0n, 3000000n]) {
    const options = fixture();
    let approvals = 0;
    let deposits = 0;
    const fundToken = async (_fund, asset, amount) => {
      assert.equal(asset, BASE_USDC_ADDRESS); assert.equal(amount, 3000000n); deposits++;
      return { hash: 'deposit', wait: async () => ({ status: 1 }) };
    };
    fundToken.staticCall = async () => {};
    options.router = { ...options.router, paused: async () => false, approvedAssets: async () => true,
      funds: async () => ({ exists: true, active: true }), fundToken };
    options.token = { target: BASE_USDC_ADDRESS, decimals: async () => 6, balanceOf: async () => 10000000n,
      allowance: async () => allowance, approve: async (_spender, amount) => {
        assert.equal(amount, 3000000n); approvals++; return { wait: async () => ({ status: 1 }) };
      } };
    await depositSettlementUsdc({ ...options, amountUnits: 3000000n });
    assert.equal(approvals, allowance === 0n ? 1 : 0);
    assert.equal(deposits, 1);
  }
});

test('USDC deposit rejects unfunded wallets and missing funds before approval', async () => {
  const { depositSettlementUsdc, BASE_USDC_ADDRESS } = await import(url);
  const options = fixture();
  options.router.paused = async () => false;
  options.token = { target: BASE_USDC_ADDRESS, decimals: async () => 6, approve: async () => { throw new Error('Must not approve'); } };
  await assert.rejects(depositSettlementUsdc({ ...options, amountUnits: 1n }), /Create and activate/);
  await assert.rejects(depositSettlementUsdc({ ...options, amountUnits: 0n }), /positive/);
});

test('deposit failures block approvals and transfers for wrong chain/token/owner, pause, or insufficient balance', async () => {
  const { depositSettlementUsdc, BASE_USDC_ADDRESS } = await import(url);
  for (const modify of [
    options => { options.owner = '0xother'; },
    options => { options.signer.provider.getNetwork = async () => ({ chainId: 10 }); },
    options => { options.token.target = '0xother'; },
    options => { options.router.paused = async () => true; },
    options => { options.router.approvedAssets = async () => false; },
    options => { options.token.balanceOf = async () => 0n; },
  ]) {
    const options = fixture();
    let approvals = 0;
    let deposits = 0;
    options.router = { ...options.router, paused: async () => false, approvedAssets: async () => true,
      funds: async () => ({ exists: true, active: true }), fundToken: async () => { deposits++; } };
    options.token = { target: BASE_USDC_ADDRESS, decimals: async () => 6, balanceOf: async () => 1000000n,
      allowance: async () => 0n, approve: async () => { approvals++; } };
    modify(options);
    await assert.rejects(depositSettlementUsdc({ ...options, amountUnits: 1000000n }));
    assert.equal(approvals, 0);
    assert.equal(deposits, 0);
  }
});