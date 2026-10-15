const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ethers = require('../discord-bot/node_modules/ethers');

const url = pathToFileURL(path.join(__dirname, '../js/base-chain.mjs')).href;

function reply(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function echo(payload, result = '0x10') {
  return Array.isArray(payload) ? payload.map(item => ({ jsonrpc: '2.0', id: item.id, result })) : { jsonrpc: '2.0', id: payload.id, result };
}

test('baseReadEndpoints puts configured public RPCs first and derives the worker fallback', async () => {
  const { baseReadEndpoints, DEFAULT_PUBLIC_BASE_RPC_URLS } = await import(url);
  const endpoints = baseReadEndpoints({ rpcUrl: 'https://custom.example', rpcFallbackUrls: ['http://insecure.example', 'https://mainnet.base.org'], ipfsUploadServiceUrl: 'https://worker.example/' });
  assert.equal(endpoints.publicUrls[0], 'https://custom.example');
  assert.ok(!endpoints.publicUrls.includes('http://insecure.example'));
  assert.equal(endpoints.publicUrls.length, 1 + DEFAULT_PUBLIC_BASE_RPC_URLS.length);
  assert.equal(endpoints.workerUrl, 'https://worker.example/api/rpc');
});

test('read transport skips rate-limited public endpoints and only uses the worker when every public endpoint fails', async () => {
  const { createBaseRpcTransport } = await import(url);
  const hits = [];
  let clock = 0;
  let publicDown = true;
  const transport = createBaseRpcTransport({
    publicUrls: ['https://a.example', 'https://b.example'],
    workerUrl: 'https://worker.example/api/rpc',
    now: () => clock,
    fetchImpl: async (target, init) => {
      hits.push(new URL(target).host);
      const payload = JSON.parse(init.body);
      if (target.startsWith('https://a.')) return reply(429, { error: { code: 429, message: 'Too many requests' } });
      if (target.startsWith('https://b.') && publicDown) return reply(200, [{ jsonrpc: '2.0', id: payload[0].id, error: { code: -32005, message: 'request limit exceeded' } }]);
      return reply(200, echo(payload));
    },
  });
  const first = await transport.send([{ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }]);
  assert.equal(first[0].result, '0x10');
  assert.deepEqual(hits, ['a.example', 'b.example', 'worker.example']);
  hits.length = 0;
  await transport.send([{ jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] }]);
  assert.deepEqual(hits, ['worker.example'], 'tripped endpoints are skipped while their breaker is open');
  publicDown = false;
  clock = 31_000;
  hits.length = 0;
  await transport.send([{ jsonrpc: '2.0', id: 3, method: 'eth_blockNumber', params: [] }]);
  assert.deepEqual(hits, ['a.example', 'b.example'], 'public endpoints are retried after the breaker cools down');
  assert.equal(transport.health().find(entry => entry.host === 'b.example').open, false);
});

test('read transport passes contract reverts through instead of failing over', async () => {
  const { createBaseRpcTransport } = await import(url);
  const hits = [];
  const transport = createBaseRpcTransport({
    publicUrls: ['https://a.example'],
    workerUrl: 'https://worker.example/api/rpc',
    fetchImpl: async (target, init) => {
      hits.push(target);
      const [item] = JSON.parse(init.body);
      return reply(200, [{ jsonrpc: '2.0', id: item.id, error: { code: 3, message: 'execution reverted', data: '0x' } }]);
    },
  });
  const [result] = await transport.send([{ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: '0x' + '1'.repeat(40) }, 'latest'] }]);
  assert.equal(result.error.code, 3);
  assert.equal(hits.length, 1);
});

test('getBaseReadProvider reads through the transport without a chainId round trip', async () => {
  const { getBaseReadProvider } = await import(url);
  const methods = [];
  const provider = getBaseReadProvider({
    ethers,
    config: { rpcUrl: 'https://a.example', ipfsUploadServiceUrl: 'https://worker.example' },
    fetchImpl: async (target, init) => {
      const payload = JSON.parse(init.body);
      (Array.isArray(payload) ? payload : [payload]).forEach(item => methods.push(item.method));
      if (target.startsWith('https://a.')) return reply(503, null);
      return reply(200, echo(payload, '0x2a'));
    },
  });
  assert.equal(await provider.getBlockNumber(), 42);
  assert.equal((await provider.getNetwork()).chainId, 8453n);
  assert.ok(!methods.includes('eth_chainId'));
  provider.destroy();
});
