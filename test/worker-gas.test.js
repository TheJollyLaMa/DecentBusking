const test = require('node:test');
const assert = require('node:assert/strict');

test('worker balance checks use the configured threshold on Base; errors never imply an empty wallet', async () => {
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

test('sponsored warning precedes checkout pause and errors remain actionable', async () => {
  const { readWorkerGasState, workerAlertAction, SPONSORED_WORKER_WARNING_WEI, SPONSORED_WORKER_TARGET_WEI } =
    await import('../js/worker-gas.mjs');
  assert.equal(SPONSORED_WORKER_WARNING_WEI, 2_000_000_000_000_000n);
  assert.equal(SPONSORED_WORKER_TARGET_WEI, 3_000_000_000_000_000n);
  for (const balance of [0n, 1_000_000_000_000_000n, SPONSORED_WORKER_WARNING_WEI - 1n, SPONSORED_WORKER_WARNING_WEI]) {
    const state = await readWorkerGasState({ workerAddress: `0x${'1'.repeat(40)}`,
      provider: { getNetwork: async () => ({ chainId: 8453n }), getBalance: async () => balance },
      minBalanceWei: SPONSORED_WORKER_WARNING_WEI });
    assert.equal(!!workerAlertAction(state), balance < SPONSORED_WORKER_WARNING_WEI);
  }
  assert.match(workerAlertAction(null, true).label, /unavailable/);
  assert.equal(workerAlertAction(null), null);
});

test('admin monitor refreshes without automatic funding and discards disconnected reads', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const listeners = new Map(), timers = [], reads = [], actions = [];
  let admin = false, destroyed = 0;
  const alert = { hidden: true, textContent: '' };
  const address = { textContent: '' }, link = {};
  const notice = { after() {}, querySelector: selector => selector === 'code' ? address : link };
  const document = {
    hidden: false,
    querySelectorAll: () => [notice],
    getElementById: () => alert,
    createElement: () => ({ setAttribute() {} }),
    addEventListener(name, fn) { listeners.set(name, fn); },
    dispatchEvent(event) {
      actions.push(event.detail.action);
    },
  };
  const context = vm.createContext({
    document, window: { DecentConfig: { djukeContractAddress: 'configured', djukeContractVersion: '0.5' } },
    isAdminWallet: () => admin,
    getBaseReadProvider: () => ({
      getNetwork: async () => ({ chainId: 8453n }),
      getBalance: () => new Promise(resolve => reads.push(resolve)),
      destroy: () => destroyed++,
    }),
    ethers: { Contract: function() { return { gasWorker: async () => `0x${'1'.repeat(40)}` }; } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    setTimeout, clearTimeout, setInterval: (fn, ms) => timers.push({ fn, ms }), console,
  });
  const source = fs.readFileSync(require('node:path').join(__dirname, '../js/worker-gas.mjs'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(source, context);
  listeners.get('DOMContentLoaded')();
  assert.equal(reads.length, 0, 'non-admins do not poll the funding wallet');
  admin = true;
  listeners.get('wallet-connected')();
  await new Promise(resolve => setImmediate(resolve));
  reads[0](1_500_000_000_000_000n);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(alert.hidden, false);
  assert.match(alert.textContent, /Top up/);
  assert.equal(notice.open, true);
  assert.equal(link.href, `https://basescan.org/address/0x${'1'.repeat(40)}`);
  assert.equal(timers[0].ms, 60000);
  listeners.get('wallet-connected')();
  await new Promise(resolve => setImmediate(resolve));
  admin = false;
  listeners.get('wallet-disconnected')();
  reads[1](0n);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(alert.hidden, true);
  assert.equal(actions.at(-1), null, 'stale balance cannot resurrect a disconnected alert');
  assert.equal(destroyed, 2);
});
