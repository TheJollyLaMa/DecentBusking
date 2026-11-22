const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const ethers = require('../discord-bot/node_modules/ethers');
const router = `0x${'12'.repeat(20)}`, sender = `0x${'34'.repeat(20)}`, wallet = `0x${'56'.repeat(20)}`;
const state = { ready: true, chainId: 8453, routerAddress: router, attributedWei: '10000000000000001',
  unattributedWei: '0', total: 1, nextOffset: null, caughtUp: true, lastCheckedAt: '2026-11-14T10:00:00Z',
  entries: [{ chainId: 8453, routerAddress: router, sender, recipient: wallet, amountWei: '10000000000000001',
    sourceKind: 0, contextRef: 'decentbusking:live:show', txHash: ethers.id('tip'), logIndex: 3, chainVerified: true,
    sourceVerification: { status: 'verified', label: 'Show' } }] };

test('tip ledger API is separate, paginated, no-store and explicitly unavailable during recovery', async () => {
  const { createWorkerRequestHandler } = await import('../discord-bot/ipfs-worker.js');
  let result = state, options;
  const server = http.createServer(createWorkerRequestHandler({
    ownerWallet: wallet, allowedOrigins: ['https://site.test'],
    getTipLedger: input => { options = input; return result; },
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/api/tips/ledger?wallet=${wallet}&offset=25&limit=25`;
  try {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(options, { wallet, offset: 25, limit: 25 });
    assert.equal((await response.json()).attributedWei, state.attributedWei);
    result = { ...state, ready: false, lastError: 'Historical RPC unavailable' };
    const unavailable = await fetch(url);
    assert.equal(unavailable.status, 503);
    assert.match((await unavailable.json()).error, /RPC unavailable/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('tip ledger browser reader rejects wrong routes, recipients, numeric amounts and failed index responses', async () => {
  const { fetchTipLedger } = await import('../js/tip-ledger-ui.mjs');
  const options = { serviceUrl: 'https://worker.test/', routerAddress: router, address: wallet };
  const valid = await fetchTipLedger({ ...options, fetchImpl: async (url, init) => {
    assert.equal(new URL(url).searchParams.get('limit'), '25');
    assert.equal(new URL(url).searchParams.get('wallet'), wallet);
    assert.equal(init.cache, 'no-store');
    return { ok: true, json: async () => state };
  } });
  assert.equal(valid.attributedWei, '10000000000000001');
  for (const bad of [
    { ...state, routerAddress: sender }, { ...state, attributedWei: 1 },
    { ...state, entries: [{ ...state.entries[0], recipient: sender }] },
    { ...state, entries: [{ ...state.entries[0], amountWei: 10000000000000001 }] },
    { ...state, entries: [{ ...state.entries[0], txHash: 'javascript:alert(1)' }] },
  ]) await assert.rejects(fetchTipLedger({ ...options, fetchImpl: async () => ({ ok: true, json: async () => bad }) }), /Invalid tip ledger/);
  await assert.rejects(fetchTipLedger({ ...options, fetchImpl: async () => ({ ok: false, status: 503,
    json: async () => ({ error: 'RPC offline' }) }) }), /RPC offline/);
});

test('native-tip Profile disclosure stays separate from USDC and does not fetch before the user opens it', async () => {
  const { renderTipLedger } = await import('../js/tip-ledger-ui.mjs');
  const document = { createElement(tag) {
    return { tag, ownerDocument: document, children: [], style: {}, listeners: {},
      setAttribute() {}, append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      addEventListener(name, callback) { this.listeners[name] = callback; } };
  } };
  const container = document.createElement('section');
  renderTipLedger({ container, address: wallet, ethers, config: { tipRouterAddress: '' } });
  assert.match(container.children[0].children[1].children[0].textContent, /Earlier direct wallet transfers are not included/);
  assert.equal(container.children[0].className, 'creator-dropdown');
  renderTipLedger({ container, address: wallet, ethers, config: { tipRouterAddress: router, ipfsUploadServiceUrl: 'https://worker.test' } });
  assert.equal(container.children[0].children[0].children[0].textContent, 'Native ETH tips');
  assert.equal(typeof container.children[0].listeners.toggle, 'function');
  assert.equal(container.children.length, 1);
  renderTipLedger({ container, address: wallet, ethers, config: { tipRouterAddress: router,
    tipSplitRouterAddress: `0x${'cd'.repeat(20)}`, ipfsUploadServiceUrl: 'https://worker.test' } });
  assert.equal(container.children[1].children[0].children[0].textContent, 'Shared-song ETH tips');
});
