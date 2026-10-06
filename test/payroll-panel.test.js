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
  assert.match(preview, /No claims or transfers enabled/);
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