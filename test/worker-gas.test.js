const test = require('node:test');
const assert = require('node:assert/strict');

test('worker warning is only eligible at zero ETH on Base; errors never imply an empty wallet', async () => {
  const { readWorkerGasState } = await import('../js/worker-gas.mjs');
  const workerAddress = `0x${'1'.repeat(40)}`;
  const provider = { getNetwork: async () => ({ chainId: 8453n }), getBalance: async () => 0n };
  const zero = await readWorkerGasState({ provider, workerAddress, minBalanceWei: 1n, estimatedDailyBurnWei: 1n });
  assert.equal(zero.empty, true);
  assert.equal(zero.lowBalance, true);
  assert.equal(zero.runwayDays, 0);
  for (const balance of [1n, 102336629037513n]) {
    const result = await readWorkerGasState({
      provider: { ...provider, getBalance: async () => balance },
      workerAddress,
      minBalanceWei: 1n,
      estimatedDailyBurnWei: 1n,
    });
    assert.equal(result.empty, false);
    assert.equal(result.lowBalance, false);
  }
  await assert.rejects(readWorkerGasState({ provider: { ...provider, getNetwork: async () => ({ chainId: 1n }) }, workerAddress }), /Base/);
  await assert.rejects(readWorkerGasState({ provider: { ...provider, getBalance: async () => { throw new Error('RPC offline'); } }, workerAddress }), /RPC offline/);
});
