const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const ethers = createRequire(path.join(__dirname, '../discord-bot/package.json'))('ethers');

test('active payroll is Base-only and radio drafts cannot send transactions', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/payroll.js'), 'utf8');
  assert.doesNotMatch(source, /Optimism|optimism|legacy-payroll|sendTransaction|_payEthEntry/);
  const preview = source.slice(source.indexOf('function _previewRadioPayroll()'), source.indexOf('// ─── Initialise'));
  assert.doesNotMatch(preview, /signMessage|sendTransaction|await router\.payout|_getSigner/);
  assert.match(preview, /Preview only; settlement uses the frozen reviewed receipt/);
});

test('Base payroll excludes retired legacy entries without sending or verifying payments', async () => {
  const { createLegacyReceiptStore, verifyLegacyPayment } = await import(pathToFileURL(path.join(__dirname, '../js/legacy-payroll.mjs')).href);
  const owner = '0x807061DF657A7697c04045dA7d16D941861cAABc';
  const recipient = `0x${'1'.repeat(40)}`;
  const paid = { issueRef: 'owner/repo#1', contributor: recipient, contributorGithub: 'artist', amount: '0.00001' };
  const unpaid = { ...paid, issueRef: 'owner/repo#2' };
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  createLegacyReceiptStore(storage).set(paid, { status: 'pending', txHash: `0x${'1'.repeat(64)}`, owner });
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', innerHTML: '', style: {}, querySelectorAll: () => [] });
    return nodes.get(id);
  };
  const context = vm.createContext({ owner, localStorage: storage, createLegacyReceiptStore, verifyLegacyPayment,
    isAdminWallet: address => address === owner,
    window: { _wallet: { address: owner } }, document: { getElementById: node }, URL,
    ethers: { ...ethers, JsonRpcProvider: class {
      async getNetwork() { return { chainId: 10 }; }
      async getTransaction() { return { from: owner, to: recipient, value: ethers.parseEther('0.00001'), chainId: 10 }; }
      async getTransactionReceipt() { return { status: 1 }; }
    } },
    fetch: async url => ({ ok: true, json: async () => url.includes('payroll-assets') ? {} : { pending: [paid, unpaid] } }),
  });
  const source = fs.readFileSync(path.join(__dirname, '../js/payroll.js'), 'utf8').replace(/^import .*;\n/gm, '')
    .replace('new URL(\'../payroll-assets.json\', import.meta.url).toString()', "'https://site.example/payroll-assets.json'")
    .replace(/export /g, '');
  vm.runInContext(`${source}\n_ownerAddress = owner; globalThis.refresh = loadPayrollQueue; globalThis.rows = () => _pendingEntries;`, context);
  await context.refresh();
  assert.equal(context.rows().length, 0);
  assert.equal(node('payroll-settle-all-btn').disabled, true);
  assert.doesNotMatch(node('payroll-table-body').innerHTML, /class="payroll-pay-btn"/);
  assert.doesNotMatch(node('payroll-table-body').innerHTML, /Verify Existing Payment/);
  await context.refresh();
  assert.equal(context.rows().length, 0);
});

test('invalid custom slug changes disable deposits and invalidate earlier fund responses', async () => {
  const funds = await import(pathToFileURL(path.join(__dirname, '../js/settlement-funds.mjs')).href);
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', dataset: {}, style: {}, listeners: new Map(),
      addEventListener(name, listener) { this.listeners.set(name, listener); }, setCustomValidity(message) { this.validationMessage = message; } });
    return nodes.get(id);
  };
  node('router-fund-select').value = funds.CUSTOM_FUND_OPTION;
  node('router-custom-fund-slug').value = 'referral-prizes';
  node('router-fund-metadata').value = 'https://site.example/referrals.json';
  let releaseRole;
  let roleRequested;
  const requested = new Promise(resolve => { roleRequested = resolve; });
  const router = { DEFAULT_ADMIN_ROLE: async () => 'admin', funds: async () => ({ exists: true, active: true }),
    hasRole: () => { roleRequested(); return new Promise(resolve => { releaseRole = resolve; }); }, fundBalances: async () => 0n };
  const context = vm.createContext({ ...funds, URL, ethers, isAdminWallet: () => true,
    window: { _wallet: { address: '0xowner' } }, document: { getElementById: node },
    localStorage: { getItem: () => null }, router });
  const source = fs.readFileSync(path.join(__dirname, '../js/payroll.js'), 'utf8').replace(/^import .*;\n/gm, '')
    .replace('new URL(\'../payroll-assets.json\', import.meta.url).toString()', "'https://site.example/payroll-assets.json'")
    .replace(/export /g, '');
  const handler = source.slice(source.indexOf("  document.getElementById('router-custom-fund-slug')?.addEventListener"),
    source.indexOf("  document.getElementById('router-fund-metadata')?.addEventListener"));
  vm.runInContext(`${source}\n_payrollAssetConfig = { routerAddress: '0xrouter', chainId: 8453 };
    _isRouterConfigured = () => true; _readOnlyRouter = () => router; _getAssetConfig = () => null;
    globalThis.refreshFund = _refreshSettlementFund;\n${handler}`, context);
  const pending = context.refreshFund();
  await requested;
  node('router-deposit-usdc').disabled = false;
  node('router-custom-fund-slug').value = 'invalid--slug';
  node('router-custom-fund-slug').listeners.get('input')();
  assert.equal(node('router-create-fund').disabled, true);
  assert.equal(node('router-deposit-usdc').disabled, true);
  releaseRole(true);
  await pending;
  assert.equal(node('router-create-fund').disabled, true);
  assert.equal(node('router-deposit-usdc').disabled, true);
  assert.match(node('router-fund-status').textContent, /Fund slug must be/);
});

test('fund purpose saves JSON to IPFS, fills its URI, and rejects failed or stale uploads without creating funds', async () => {
  const funds = await import(pathToFileURL(path.join(__dirname, '../js/settlement-funds.mjs')).href);
  const owner = `0x${'1'.repeat(40)}`;
  const routerAddress = `0x${'2'.repeat(40)}`;
  const source = fs.readFileSync(path.join(__dirname, '../js/payroll.js'), 'utf8').replace(/^import .*;\n/gm, '')
    .replace('new URL(\'../payroll-assets.json\', import.meta.url).toString()', "'https://site.example/payroll-assets.json'")
    .replace(/export /g, '');
  const fixture = () => {
    const nodes = new Map();
    const node = id => {
      if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', dataset: {}, style: {}, reportValidity: () => true });
      return nodes.get(id);
    };
    node('router-fund-select').value = funds.CUSTOM_FUND_OPTION;
    node('router-custom-fund-slug').value = 'referral-prizes';
    node('router-fund-name').value = 'Referral Prizes';
    node('router-fund-purpose').value = 'Rewards for verified referrals.';
    const uploaded = [];
    const router = { DEFAULT_ADMIN_ROLE: async () => 'admin', hasRole: async () => true, funds: async () => ({ exists: false }),
      createFund: () => { throw new Error('Saving metadata must not create a fund'); } };
    const signer = { getAddress: async () => owner, provider: { getNetwork: async () => ({ chainId: 8453 }), getCode: async () => '0x1234' } };
    const window = { _wallet: { address: owner }, DecentConfig: { ipfsUploadServiceUrl: 'https://worker.example' }, location: { origin: 'https://site.example' } };
    const context = vm.createContext({ ...funds, owner, routerAddress, signer, URL, File, window,
      ethers: { ...ethers, Contract: class { constructor() { return router; } } }, document: { getElementById: node },
      isAdminWallet: () => window._wallet?.address === owner,
      createBrowserIpfsUploader: options => async file => { uploaded.push({ options, file }); return context.uploadResult(file); } });
    context.uploadResult = async () => 'ipfs://bafy-fund-purpose';
    vm.runInContext(`${source}\n_ownerAddress = owner; _payrollAssetConfig = { routerAddress };
      _getSigner = async () => signer; _refreshSettlementFund = async () => {};
      globalThis.saveMetadata = _saveFundMetadata; globalThis.invalidateMetadata = _invalidateFundMetadata;`, context);
    return { context, node, uploaded, router, signer, window };
  };
  const success = fixture();
  await success.context.saveMetadata();
  assert.equal(success.uploaded.length, 1);
  const { options, file } = success.uploaded[0];
  assert.equal(options.address, owner);
  assert.equal(options.serviceUrl, 'https://worker.example');
  assert.equal(file.name, 'referral-prizes-fund.json');
  assert.equal(file.type, 'application/json');
  const metadata = JSON.parse(await file.text());
  assert.equal(metadata.name, 'Referral Prizes');
  assert.equal(metadata.description, 'Rewards for verified referrals.');
  assert.equal(metadata.fundId, ethers.id('referral-prizes'));
  assert.equal(metadata.routerAddress, routerAddress);
  assert.equal(metadata.owner, owner);
  assert.equal(metadata.chainId, 8453);
  assert.equal(success.node('router-fund-metadata').value, 'ipfs://bafy-fund-purpose');
  success.context.invalidateMetadata();
  assert.equal(success.node('router-fund-metadata').value, '');

  for (const scenario of ['upload-failure', 'changed-details', 'changed-wallet', 'wrong-chain', 'missing-role', 'existing-fund', 'invalid-purpose', 'invalid-uri']) {
    const probe = fixture();
    if (scenario === 'missing-role') probe.router.hasRole = async () => false;
    if (scenario === 'existing-fund') probe.router.funds = async () => ({ exists: true });
    if (scenario === 'wrong-chain') probe.signer.provider.getNetwork = async () => ({ chainId: 10 });
    if (scenario === 'invalid-purpose') probe.node('router-fund-purpose').value = '   ';
    if (scenario === 'upload-failure') probe.context.uploadResult = async () => { throw new Error('Pinata unavailable'); };
    if (scenario === 'invalid-uri') probe.context.uploadResult = async () => 'https://not-ipfs.example';
    if (scenario === 'changed-details' || scenario === 'changed-wallet') {
      let finishUpload;
      let startedUpload;
      const started = new Promise(resolve => { startedUpload = resolve; });
      probe.context.uploadResult = () => { startedUpload(); return new Promise(resolve => { finishUpload = resolve; }); };
      const pending = probe.context.saveMetadata();
      await started;
      await probe.context.saveMetadata();
      assert.equal(probe.uploaded.length, 1, 'concurrent saves must not upload twice');
      if (scenario === 'changed-details') {
        probe.node('router-fund-purpose').value = 'A different purpose';
        probe.context.invalidateMetadata();
      } else probe.window._wallet.address = `0x${'3'.repeat(40)}`;
      finishUpload('ipfs://bafy-stale-purpose');
      await pending;
    } else await probe.context.saveMetadata();
    assert.equal(probe.node('router-fund-metadata').value, '', scenario);
    assert.ok(probe.node('router-metadata-status').textContent, scenario);
    if (['wrong-chain', 'missing-role', 'existing-fund', 'invalid-purpose'].includes(scenario)) assert.equal(probe.uploaded.length, 0, scenario);
    if (scenario === 'upload-failure') {
      probe.context.uploadResult = async () => 'ipfs://bafy-retry';
      await probe.context.saveMetadata();
      assert.equal(probe.node('router-fund-metadata').value, 'ipfs://bafy-retry');
    }
  }
});

test('Left Ankh has public tally first and owner-only NFT Admin and Payroll in order', () => {
  const wallet = { address: null };
  const events = new Map();
  const owner = '0x807061DF657A7697c04045dA7d16D941861cAABc';
  const makeNode = () => ({ dataset: {}, style: {}, children: [], listeners: new Map(),
    appendChild(child) { this.children.push(child); }, addEventListener(name, listener) { this.listeners.set(name, listener); },
    querySelector: () => null });
  const menu = makeNode();
  menu.querySelector = selector => selector === '[data-payroll-item]' ? menu.children.find(item => item.dataset.payrollItem) : null;
  const root = { querySelector: selector => selector === '.ankh-left .dropdown-menu' ? menu : null,
    querySelectorAll: () => menu.children.filter(item => item.dataset.adminOnly), appendChild() {} };
  const title = { shadowRoot: root };
  class AppTitle { render() {} }
  const context = vm.createContext({ isAdminWallet: () => wallet.address?.toLowerCase() === owner.toLowerCase(),
    customElements: { get: () => AppTitle },
    document: { createElement: makeNode, querySelectorAll: selector => selector === 'app-title' ? [title] : [],
      addEventListener: (name, callback) => events.set(name, callback), dispatchEvent() {} },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/components/header-payroll-inject.js'), 'utf8').replace(/^import .*;\n/gm, ''), context);
  assert.deepEqual(menu.children.map(item => item.textContent), ['Playback Tally', 'Admin Nft Mint', 'Payroll']);
  assert.equal(menu.children[0].hidden, undefined);
  assert.equal(menu.children[1].hidden, true);
  assert.equal(menu.children[2].hidden, true);
  wallet.address = owner;
  events.get('wallet-connected')();
  assert.equal(menu.children[1].hidden, false);
  assert.equal(menu.children[2].hidden, false);
  wallet.address = `0x${'1'.repeat(40)}`;
  events.get('wallet-connected')();
  assert.equal(menu.children[1].hidden, true);
  assert.equal(menu.children[2].hidden, true);
});