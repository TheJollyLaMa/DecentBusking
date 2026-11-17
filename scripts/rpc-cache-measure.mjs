// Offline comparison against the issue's base commit, using identical virtual-time screen requests.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createRpcRouter as current } from '../discord-bot/rpc-router.js';

const require = createRequire(new URL('../discord-bot/rpc-router.js', import.meta.url));
const ethersUrl = pathToFileURL(require.resolve('ethers')).href;
const source = execFileSync('git', ['show', 'ec8f930bb7be606c1f965d91c5f04d84506ff247:discord-bot/rpc-router.js'], { encoding: 'utf8' })
  .replace("from 'ethers'", `from '${ethersUrl}'`);
const { createRpcRouter: baseline } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

async function run(createRouter) {
  let time = Date.UTC(2026, 10, 14);
  const calls = {};
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    calls[request.method] = (calls[request.method] || 0) + 1;
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: request.id, result: request.method === 'eth_getCode' ? '0x1234' : { number: '0x10' } }) };
  };
  const router = createRouter({ paidUrls: ['https://paid.invalid'], fetchImpl, now: () => time });
  const results = [];
  for (let second = 0; second < 60; second++) {
    results.push(await Promise.all([
      router.request('fallback', 'eth_getCode', ['0xaaa', 'finalized']),
      router.request('fallback', 'eth_getCode', ['0xaaa', 'finalized']),
      router.request('fallback', 'eth_getCode', ['0xbbb', 'finalized']),
      router.request('fallback', 'eth_getBlockByNumber', ['finalized', false]),
      router.request('fallback', 'eth_getBlockByNumber', ['finalized', false]),
    ]));
    time += 1000;
  }
  return { calls, cu: router.health().computeUnits.today, results };
}

const before = await run(baseline);
const after = await run(current);
assert.deepEqual(after.results, before.results);
console.log(JSON.stringify({ workload: '60 virtual seconds, 300 finalized screen requests per run; mock paid RPC only',
  before: { calls: before.calls, estimatedCu: before.cu },
  after: { calls: after.calls, estimatedCu: after.cu },
  reductionPercent: Number(((before.cu - after.cu) / before.cu * 100).toFixed(1)) }, null, 2));
