const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const vm = require('node:vm');

const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'js', 'admin-mint-queue.js')).href;

test('signs and fetches the owner mint queue', async () => {
  const { buildAdminAuthorizationMessage, fetchMintQueue } = await import(moduleUrl);
  const signed = [];
  let request;
  const queue = await fetchMintQueue({
    serviceUrl: 'https://worker.example/',
    signer: { signMessage: async (message) => { signed.push(message); return '0xsigned'; } },
    address: '0x1111111111111111111111111111111111111111',
    origin: 'https://busking.example',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ requests: [{ trackId: 'track-1' }] }), { status: 200 });
    },
  });

  assert.deepEqual(queue, [{ trackId: 'track-1' }]);
  assert.equal(request.url, 'https://worker.example/api/mint-queue');
  const authorization = JSON.parse(request.options.body);
  assert.equal(authorization.signature, '0xsigned');
  assert.equal(signed[0], buildAdminAuthorizationMessage(authorization));
});

test('admin DOM initialization can bind every queue handler', async (t) => {
  let readyHandler;
  const element = {
    addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
    querySelectorAll: () => [],
  };
  global.document = {
    addEventListener(event, handler) {
      if (event === 'DOMContentLoaded') readyHandler = handler;
    },
    getElementById: () => element,
  };
  global.window = {};
  t.after(() => {
    delete global.document;
    delete global.window;
  });

  const adminUrl = pathToFileURL(path.join(__dirname, '..', 'js', 'admin.js'));
  adminUrl.searchParams.set('test', String(Date.now()));
  await import(adminUrl.href);
  assert.equal(typeof readyHandler, 'function');
  assert.doesNotThrow(() => readyHandler());
});

test('queue refreshes reuse a short-lived authorization and clear it on account changes or failures', async () => {
  const { fetchMintQueue, clearMintQueueAuthorization } = await import(moduleUrl);
  clearMintQueueAuthorization();
  let time = Date.parse('2026-10-05T12:00:00Z');
  let signatures = 0;
  const requests = [];
  const options = { serviceUrl: 'https://worker.example', address: '0x1111111111111111111111111111111111111111',
    origin: 'https://site.example', signer: { signMessage: async () => `signature-${++signatures}` }, now: () => time,
    fetchImpl: async (_url, request) => { requests.push(JSON.parse(request.body)); return new Response(JSON.stringify({ requests: [] })); } };
  await Promise.all([fetchMintQueue(options), fetchMintQueue(options)]);
  assert.equal(signatures, 1);
  assert.equal(requests[0].signature, requests[1].signature);
  time += 3 * 60 * 1000;
  await fetchMintQueue(options);
  assert.equal(signatures, 1);
  time += 60 * 1000;
  await fetchMintQueue(options);
  assert.equal(signatures, 2);
  await fetchMintQueue({ ...options, address: '0x2222222222222222222222222222222222222222' });
  assert.equal(signatures, 3);
  clearMintQueueAuthorization();
  await fetchMintQueue(options);
  assert.equal(signatures, 4);
  await assert.rejects(fetchMintQueue({ ...options, fetchImpl: async () => new Response(JSON.stringify({ error: 'Expired' }), { status: 400 }) }), /Expired/);
  await fetchMintQueue(options);
  assert.equal(signatures, 5);
  clearMintQueueAuthorization();
});

test('Admin reuses the header signer, checks roles without reconnecting, and clears state on disconnect', async () => {
  const events = new Map();
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '',
      classList: { add() {}, remove() {}, toggle() {} }, replaceChildren() { this.innerHTML = ''; },
      addEventListener() {}, querySelectorAll: () => [] });
    return elements.get(id);
  };
  const signer = {};
  const address = '0x1111111111111111111111111111111111111111';
  let queueCalls = 0;
  let allowed = true;
  const context = vm.createContext({
    window: { _wallet: { signer, address, chainId: 8453 }, DecentConfig: { chainId: 8453, contractAddress: 'contract' }, location: { origin: 'https://site.example' } },
    document: { getElementById: element, addEventListener: (name, callback) => events.set(name, callback) },
    ethers: { BrowserProvider: class { constructor() { throw new Error('Must not reconnect'); } },
      Contract: class { constructor(_address, _abi, runner) { assert.equal(runner, signer); }
        async DEFAULT_ADMIN_ROLE() { return 'admin'; } async hasRole() { return allowed; } } },
    fetchMintQueue: async options => { assert.equal(options.signer, signer); queueCalls++; return []; }, clearMintQueueAuthorization() {},
    isAdminWallet: () => true,
  });
  const source = fs.readFileSync(path.join(__dirname, '../js/admin.js'), 'utf8').replace(/^import .*;\n/gm, '');
  vm.runInContext(`${source}\nglobalThis.checkWallet = _connectWallet; globalThis.getSigner = () => _adminSigner;`, context);
  events.get('DOMContentLoaded')();
  await events.get('open-admin')();
  assert.equal(queueCalls, 1);
  assert.equal(context.getSigner(), signer);
  events.get('wallet-disconnected')();
  assert.equal(context.getSigner(), null);
  assert.equal(element('admin-connected-addr').textContent, '');
  allowed = false;
  await context.checkWallet();
  assert.equal(queueCalls, 1);
  assert.equal(context.getSigner(), null);
});