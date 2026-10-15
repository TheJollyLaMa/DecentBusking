const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const url = pathToFileURL(path.join(__dirname, '../discord-bot/rpc-proxy.js')).href;
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const call = (method, params = [], id = 1) => ({ jsonrpc: '2.0', id, method, params });

async function proxy(options = {}) {
  const { createRpcProxy } = await import(url);
  const seen = [];
  const handler = createRpcProxy({
    request: async (method, params) => { seen.push([method, params]); return { result: '0x1' }; },
    allowedContracts: [USDC],
    ...options,
  });
  return { handler, seen };
}

test('rpc proxy forwards allow-listed reads and rejects everything else without touching the paid RPC', async () => {
  const { handler, seen } = await proxy();
  const ok = await handler.handle([
    call('eth_blockNumber', [], 1),
    call('eth_call', [{ to: USDC.toLowerCase(), data: '0x70a08231' }, 'latest'], 2),
    call('eth_getTransactionReceipt', ['0x' + 'a'.repeat(64)], 3),
    call('eth_getBlockByNumber', ['latest', false], 4),
  ], '1.1.1.1');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.map(item => item.result), ['0x1', '0x1', '0x1', '0x1']);
  const rejected = await handler.handle([
    call('eth_sendRawTransaction', ['0x00'], 1),
    call('eth_getLogs', [{}], 2),
    call('eth_call', [{ to: '0x' + '1'.repeat(40), data: '0x' }], 3),
    call('eth_getBlockByNumber', ['latest', true], 4),
    call('eth_call', [{ to: USDC, data: '0x' + '0'.repeat(9000) }], 5),
  ], '1.1.1.1');
  assert.ok(rejected.body.every(item => item.error && item.result === undefined));
  assert.equal(seen.length, 4);
});

test('rpc proxy limits batch size and per-IP request rate', async () => {
  let clock = 0;
  const { handler } = await proxy({ perIpPerMinute: 3, now: () => clock });
  assert.equal((await handler.handle([], 'a')).status, 400);
  assert.equal((await handler.handle(Array.from({ length: 11 }, (_, index) => call('eth_blockNumber', [], index)), 'a')).status, 400);
  assert.equal((await handler.handle([call('eth_blockNumber'), call('eth_chainId')], 'a')).status, 200);
  const limited = await handler.handle([call('eth_blockNumber'), call('eth_chainId')], 'a');
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, -32005);
  assert.equal((await handler.handle(call('eth_blockNumber'), 'b')).status, 200, 'other visitors are unaffected');
  clock = 60_000;
  assert.equal((await handler.handle(call('eth_blockNumber'), 'a')).status, 200, 'limits reset each minute');
});

test('rpc proxy enforces a global ceiling across all visitors', async () => {
  const { handler } = await proxy({ globalPerMinute: 2, now: () => 0 });
  assert.equal((await handler.handle(call('eth_blockNumber'), 'a')).status, 200);
  assert.equal((await handler.handle(call('eth_blockNumber'), 'b')).status, 200);
  assert.equal((await handler.handle(call('eth_blockNumber'), 'c')).status, 429);
});

test('rpc proxy passes upstream reverts through and hides upstream failures behind a generic error', async () => {
  const { createRpcProxy } = await import(url);
  const handler = createRpcProxy({
    request: async method => {
      if (method === 'eth_call') return { error: { code: 3, message: 'execution reverted', data: '0x08c379a0' } };
      throw new Error('all endpoints down');
    },
    allowedContracts: [USDC],
  });
  const result = await handler.handle([call('eth_call', [{ to: USDC, data: '0x' }], 1), call('eth_blockNumber', [], 2)], 'a');
  assert.equal(result.body[0].error.code, 3);
  assert.equal(result.body[0].error.data, '0x08c379a0');
  assert.equal(result.body[1].error.code, -32603);
});

test('worker /api/rpc serves allowed site origins only and uses the forwarded client IP for rate limits', async () => {
  const http = require('node:http');
  const { createRpcProxy } = await import(url);
  const { createWorkerRequestHandler } = await import(pathToFileURL(path.join(__dirname, '../discord-bot/ipfs-worker.js')).href);
  const ips = [];
  const rpcProxy = createRpcProxy({ request: async () => ({ result: '0x2a' }), allowedContracts: [USDC] });
  const handler = createWorkerRequestHandler({
    allowedOrigins: ['https://site.example'],
    ownerWallet: '0x807061DF657A7697c04045dA7d16D941861cAABc',
    rpcProxy: { handle: (body, ip) => { ips.push(ip); return rpcProxy.handle(body, ip); } },
  });
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (origin, body) => fetch(`${base}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.9, 10.0.0.1', ...(origin ? { origin } : {}) },
      body: JSON.stringify(body),
    });
    const ok = await post('https://site.example', call('eth_blockNumber'));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://site.example');
    assert.equal((await ok.json()).result, '0x2a');
    assert.deepEqual(ips, ['9.9.9.9']);
    assert.ok((await post('https://evil.example', call('eth_blockNumber'))).status >= 400);
    assert.ok((await post('', call('eth_blockNumber'))).status >= 400);
    assert.equal(ips.length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
