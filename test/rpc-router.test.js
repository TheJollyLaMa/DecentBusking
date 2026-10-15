const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'rpc-router.js')).href;
const PAID = 'https://base-mainnet.g.alchemy.com/v2/SECRETKEY';
const PUBLIC = 'https://mainnet.base.org';

function mockFetch(handlers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, method: body.method, params: body.params });
    const reply = await handlers[url](body);
    if (reply.status) return { ok: false, status: reply.status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, ...reply }) };
  };
  return { fetchImpl, calls };
}

test('env endpoints: Alchemy overrides become the paid tier and public URLs stay as fallback', async () => {
  const { baseRpcEndpointsFromEnv } = await import(moduleUrl);
  const assets = { rpcUrl: 'https://base-rpc.publicnode.com', rpcFallbackUrls: ['https://mainnet.base.org'] };
  const { publicUrls, paidUrls } = baseRpcEndpointsFromEnv({ BASE_RPC_URL: PAID, BASE_LOGS_RPC_URL: PAID, PAYROLL_ARCHIVE_RPC_URL: PUBLIC }, assets);
  assert.deepEqual(paidUrls, [PAID]);
  assert.deepEqual(publicUrls, ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.drpc.org']);
  assert.deepEqual(baseRpcEndpointsFromEnv({ BASE_PUBLIC_RPC_URLS: 'https://a.example, https://b.example' }).publicUrls,
    ['https://a.example', 'https://b.example']);
});

test('reads go public-first, fail over to paid on rate limits, and trip the breaker', async () => {
  const { createRpcRouter } = await import(moduleUrl);
  let time = 1_000_000;
  const { fetchImpl, calls } = mockFetch({
    [PUBLIC]: () => ({ error: { code: -32011, message: 'request limit reached' } }),
    [PAID]: () => ({ result: '0x2a' }),
  });
  const router = createRpcRouter({ publicUrls: [PUBLIC], paidUrls: [PAID], fetchImpl, now: () => time });
  assert.deepEqual(await router.request('read', 'eth_call', [{ to: '0x1' }, 'latest']), { result: '0x2a' });
  assert.deepEqual(calls.map(call => call.url), [PUBLIC, PAID]);
  calls.length = 0;
  await router.request('read', 'eth_call', [{ to: '0x2' }, 'latest']);
  assert.deepEqual(calls.map(call => call.url), [PAID, PUBLIC].slice(0, 1), 'open breaker skips the rate-limited public endpoint');
  time += 31_000;
  calls.length = 0;
  await router.request('read', 'eth_call', [{ to: '0x3' }, 'latest']);
  assert.equal(calls[0].url, PUBLIC, 'breaker closes after the cooldown');
  const health = router.health();
  assert.equal(JSON.stringify(health).includes('SECRETKEY'), false);
  assert.equal(health.endpoints.find(endpoint => endpoint.tier === 'public').rateLimited, 2);
});

test('logs and critical calls go paid-first; paid outages fall back to public', async () => {
  const { createRpcRouter } = await import(moduleUrl);
  const { fetchImpl, calls } = mockFetch({ [PUBLIC]: () => ({ result: [] }), [PAID]: () => ({ status: 503 }) });
  const router = createRpcRouter({ publicUrls: [PUBLIC], paidUrls: [PAID], fetchImpl });
  assert.deepEqual(await router.request('read', 'eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x7d0' }]), { result: [] });
  assert.deepEqual(calls.map(call => call.url), [PAID, PUBLIC]);
  const small = mockFetch({ [PUBLIC]: () => ({ result: [] }), [PAID]: () => ({ result: [] }) });
  const smallRouter = createRpcRouter({ publicUrls: [PUBLIC], paidUrls: [PAID], fetchImpl: small.fetchImpl });
  await smallRouter.request('logs', 'eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x10' }]);
  assert.equal(small.calls[0].url, PUBLIC, 'small tail scans try public first');
  await smallRouter.request('read', 'eth_estimateGas', [{}]);
  assert.equal(small.calls.at(-1).url, PAID, 'estimateGas is critical');
});

test('getLogs ranges that are too large are split and merged', async () => {
  const { createRpcRouter } = await import(moduleUrl);
  const { fetchImpl, calls } = mockFetch({
    [PAID]: ({ params: [filter] }) => {
      const from = Number.parseInt(filter.fromBlock, 16);
      const to = Number.parseInt(filter.toBlock, 16);
      if (to - from + 1 > 500) return { error: { code: -32600, message: 'eth_getLogs is limited to a 500 block range' } };
      return { result: [{ blockNumber: filter.fromBlock }] };
    },
  });
  const router = createRpcRouter({ paidUrls: [PAID], fetchImpl });
  const outcome = await router.request('logs', 'eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x7cf' }]);
  assert.equal(outcome.result.length, 4);
  assert.deepEqual(outcome.result.map(log => log.blockNumber), ['0x0', '0x1f4', '0x3e8', '0x5dc']);
  assert.equal(router.health().endpoints[0].breaker.open, false, 'range errors do not trip the breaker');
  assert.ok(calls.length >= 5);
});

test('reverts are returned as-is without failover', async () => {
  const { createRpcRouter } = await import(moduleUrl);
  const { fetchImpl, calls } = mockFetch({ [PUBLIC]: () => ({ error: { code: 3, message: 'execution reverted', data: '0x' } }), [PAID]: () => ({ result: '0x' }) });
  const router = createRpcRouter({ publicUrls: [PUBLIC], paidUrls: [PAID], fetchImpl });
  assert.equal((await router.request('read', 'eth_call', [{}, 'latest'])).error.message, 'execution reverted');
  assert.equal(calls.length, 1);
});

test('a resent transaction reported as already known resolves to its hash', async () => {
  const { createRpcRouter } = await import(moduleUrl);
  const { keccak256 } = require(path.join(__dirname, '..', 'discord-bot', 'node_modules', 'ethers'));
  const raw = '0x02f86a';
  const { fetchImpl } = mockFetch({
    [PAID]: () => { throw new Error('socket hang up'); },
    [PUBLIC]: () => ({ error: { code: -32000, message: 'already known' } }),
  });
  const router = createRpcRouter({ publicUrls: [PUBLIC], paidUrls: [PAID], fetchImpl });
  assert.deepEqual(await router.request('critical', 'eth_sendRawTransaction', [raw]), { result: keccak256(raw) });
});

test('identical in-flight reads are coalesced and blockNumber is cached briefly', async () => {
  const { createRpcRouter } = await import(moduleUrl);
  let time = 0;
  const { fetchImpl, calls } = mockFetch({ [PUBLIC]: async () => ({ result: '0x10' }) });
  const router = createRpcRouter({ publicUrls: [PUBLIC], fetchImpl, now: () => time });
  await Promise.all([router.request('read', 'eth_call', [{ to: '0x1' }]), router.request('read', 'eth_call', [{ to: '0x1' }])]);
  assert.equal(calls.length, 1);
  await router.request('read', 'eth_blockNumber', []);
  await router.request('read', 'eth_blockNumber', []);
  assert.equal(calls.length, 2);
  time += 2500;
  await router.request('read', 'eth_blockNumber', []);
  assert.equal(calls.length, 3);
});

test('CU budget guard moves large log scans to public once the soft limit is hit', async () => {
  const { createRpcRouter } = await import(moduleUrl);
  const { fetchImpl, calls } = mockFetch({ [PUBLIC]: () => ({ result: [] }), [PAID]: () => ({ result: [] }) });
  const router = createRpcRouter({ publicUrls: [PUBLIC], paidUrls: [PAID], fetchImpl, dailyCuSoftLimit: 100 });
  await router.request('logs', 'eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x7d0' }]);
  await router.request('logs', 'eth_getLogs', [{ fromBlock: '0x7d1', toBlock: '0xfa0' }]);
  assert.deepEqual(calls.map(call => call.url), [PAID, PAID]);
  await router.request('logs', 'eth_getLogs', [{ fromBlock: '0xfa1', toBlock: '0x1770' }]);
  assert.equal(calls.at(-1).url, PUBLIC);
  assert.equal(router.health().computeUnits.overBudget, true);
  await router.request('critical', 'eth_call', [{ to: '0x9' }, 'latest']);
  assert.equal(calls.at(-1).url, PUBLIC, 'critical-tier reads also go public once over budget');
  await router.request('critical', 'eth_sendRawTransaction', ['0x01']);
  assert.equal(calls.at(-1).url, PAID, 'critical calls are never throttled');
});

test('router providers work as ethers providers', async () => {
  const { createRpcRouter } = await import(moduleUrl);
  const { fetchImpl } = mockFetch({ [PUBLIC]: ({ method }) => ({ result: method === 'eth_blockNumber' ? '0x64' : '0x' }) });
  const router = createRpcRouter({ publicUrls: [PUBLIC], fetchImpl });
  const provider = router.provider('read', 'test-consumer');
  assert.equal(await provider.getBlockNumber(), 100);
  assert.equal(router.provider('read'), provider);
  assert.match(router.describe(), /test-consumer=read/);
});

test('range errors delivered with non-200 HTTP status still trigger splitting', async () => {
  const { createRpcRouter } = await import(moduleUrl);
  const fetchImpl = async (url, init) => {
    const { id, params: [filter] } = JSON.parse(init.body);
    const span = Number.parseInt(filter.toBlock, 16) - Number.parseInt(filter.fromBlock, 16) + 1;
    if (span > 10000) return { ok: false, status: 400, json: async () => ({ id, error: { code: 35, message: 'ranges over 10000 blocks are not supported on free plan' } }) };
    return { ok: true, status: 200, json: async () => ({ id, result: [filter.fromBlock] }) };
  };
  const router = createRpcRouter({ publicUrls: [PUBLIC], fetchImpl });
  const outcome = await router.request('logs', 'eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x4e1f' }]);
  assert.equal(outcome.result.length, 2);
});
