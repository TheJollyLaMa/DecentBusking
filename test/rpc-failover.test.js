const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modulePath = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'rpc-failover.js')).href;

test('failover provider retries refused RPCs but not deterministic errors', async t => {
  const { FailoverJsonRpcProvider, rpcUrlsFromConfig } = await import(modulePath);
  assert.deepEqual(
    rpcUrlsFromConfig({ rpcUrl: 'https://a', rpcFallbackUrls: ['https://b', 'https://a', ''] }),
    ['https://a', 'https://b']
  );

  const provider = new FailoverJsonRpcProvider(['https://a', 'https://b', 'https://c']);
  const calls = [];
  const primary = async () => { calls.push('a'); throw new Error('server response 403 Forbidden'); };
  const base = Object.getPrototypeOf(FailoverJsonRpcProvider.prototype);
  const originalSend = base._send;
  base._send = function (payload) { return this === provider ? primary(payload) : originalSend.call(this, payload); };
  t.after(() => { base._send = originalSend; provider.destroy(); });
  provider.backups[0]._send = async payload => { calls.push('b'); return [{ id: payload.id, error: { code: -32602, message: 'Archive requests require a personal token' } }]; };
  provider.backups[1]._send = async payload => { calls.push('c'); return [{ id: payload.id, result: '0x1' }]; };
  assert.deepEqual(await provider._send({ id: 1, method: 'eth_blockNumber' }), [{ id: 1, result: '0x1' }]);
  assert.deepEqual(calls, ['a', 'b', 'c']);

  calls.length = 0;
  provider.backups[0]._send = async payload => { calls.push('b'); return [{ id: payload.id, error: { code: 3, message: 'execution reverted' } }]; };
  const reverted = await provider._send({ id: 2, method: 'eth_call' });
  assert.equal(reverted[0].error.message, 'execution reverted');
  assert.deepEqual(calls, ['a', 'b']);
});
