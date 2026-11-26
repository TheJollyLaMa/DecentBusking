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

const ETH = 1_000_000_000_000_000_000n;
const milli = value => BigInt(Math.round(value * 1e6)) * 1_000_000_000_000n;
const WORKER = `0x${'1'.repeat(40)}`;
const ADMIN = `0x${'a'.repeat(40)}`;
const tick = () => new Promise(resolve => setImmediate(resolve));

test('gauge levels, tank multiples and fill-to amounts follow the sponsored tank', async () => {
  const { readWorkerGasState, workerGauge, topUpToTanksWei, SPONSORED_WORKER_WARNING_WEI, SPONSORED_WORKER_TARGET_WEI } =
    await import('../js/worker-gas.mjs');
  assert.equal(SPONSORED_WORKER_WARNING_WEI, 2_000_000_000_000_000n);
  assert.equal(SPONSORED_WORKER_TARGET_WEI, 3_000_000_000_000_000n);
  const read = balance => readWorkerGasState({ workerAddress: WORKER, minBalanceWei: SPONSORED_WORKER_WARNING_WEI,
    provider: { getNetwork: async () => ({ chainId: 8453n }), getBalance: async () => balance } });
  assert.deepEqual(workerGauge(null), { level: 'unknown', fill: 0, multiplier: 0 });
  const low = await read(milli(0.001914));
  assert.deepEqual(workerGauge(low), { level: 'low', fill: 0.638, multiplier: 0 });
  assert.equal(workerGauge(await read(SPONSORED_WORKER_WARNING_WEI)).level, 'reserve');
  assert.deepEqual(workerGauge(await read(SPONSORED_WORKER_TARGET_WEI)), { level: 'full', fill: 1, multiplier: 0 });
  assert.equal(workerGauge(await read(milli(0.0065))).multiplier, 2);
  assert.equal(workerGauge(await read(milli(0.0099))).multiplier, 3);
  const odd = await read(milli(0.001914) + 1n);
  assert.equal(topUpToTanksWei(odd, 1), milli(0.001086), 'fill rounds up so the tank actually reaches full');
  assert.equal(topUpToTanksWei(odd, 2), milli(0.004086));
  assert.equal(topUpToTanksWei(await read(milli(0.004)), 1), 0n);
  assert.equal(topUpToTanksWei(null, 1), 0n);
});

test('top-up amounts parse exact ETH and block empty, malformed and oversized entries', async () => {
  const { parseTopUpWei, MAX_WORKER_TOP_UP_WEI } = await import('../js/worker-gas.mjs');
  assert.equal(MAX_WORKER_TOP_UP_WEI, ETH / 10n);
  assert.equal(parseTopUpWei('0.003'), milli(0.003));
  assert.equal(parseTopUpWei(' .0015 '), milli(0.0015));
  assert.equal(parseTopUpWei('0.1'), MAX_WORKER_TOP_UP_WEI);
  assert.equal(parseTopUpWei('0.000000000000000001'), 1n);
  for (const [text, error] of [['', /Enter an ETH amount/], ['.', /Enter an ETH amount/], ['abc', /Enter an ETH amount/],
    ['1e-3', /Enter an ETH amount/], ['-1', /Enter an ETH amount/], ['0', /more than 0/],
    ['0.0000000000000000001', /18 decimals/], ['3', /capped at 0\.1 ETH/], ['0.1000001', /capped/]]) {
    assert.throws(() => parseTopUpWei(text), error, text);
  }
});

test('top-ups send the exact amount to the verified worker on Base and handle replaced transactions', async () => {
  const { sendWorkerTopUp } = await import('../js/worker-gas.mjs');
  const sent = [], steps = [];
  const signer = wait => ({ sendTransaction: async tx => { sent.push(tx); return { hash: '0xabc', wait }; } });
  const ok = await sendWorkerTopUp({ signer: signer(async () => ({ status: 1, hash: '0xabc' })), workerAddress: WORKER,
    amountWei: milli(0.003), onStep: (step, hash) => steps.push([step, hash]) });
  assert.equal(ok.hash, '0xabc');
  assert.deepEqual(sent[0], { to: WORKER, value: milli(0.003), chainId: 8453 });
  assert.deepEqual(steps, [['confirm', undefined], ['pending', '0xabc']]);
  const replaced = await sendWorkerTopUp({ signer: signer(async () => {
    throw Object.assign(new Error('replaced'), { code: 'TRANSACTION_REPLACED', cancelled: false, receipt: { status: 1, hash: '0xdef' } });
  }), workerAddress: WORKER, amountWei: 1n });
  assert.equal(replaced.hash, '0xdef', 'a repriced replacement still counts');
  await assert.rejects(sendWorkerTopUp({ signer: signer(async () => {
    throw Object.assign(new Error('replaced'), { code: 'TRANSACTION_REPLACED', cancelled: true, receipt: { status: 1 } });
  }), workerAddress: WORKER, amountWei: 1n }), /cancelled or replaced/);
  await assert.rejects(sendWorkerTopUp({ signer: signer(async () => ({ status: 0 })), workerAddress: WORKER, amountWei: 1n }), /not confirmed/);
  const before = sent.length;
  await assert.rejects(sendWorkerTopUp({ signer: signer(), workerAddress: WORKER, amountWei: ETH }), /valid top-up/);
  await assert.rejects(sendWorkerTopUp({ signer: signer(), workerAddress: 'nope', amountWei: 1n }), /not verified/);
  assert.equal(sent.length, before, 'invalid requests never reach the wallet');
});

function gaugeFixture() {
  const fs = require('node:fs'), vm = require('node:vm');
  const listeners = new Map(), timers = [], reads = [], sent = [], switched = [];
  const env = { admin: false, now: 1_000_000, worker: WORKER };
  const node = (extra = {}) => ({ hidden: false, dataset: {}, style: {}, attrs: {}, listeners: {}, textContent: '', value: '',
    disabled: false, children: [], setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(name, fn) { this.listeners[name] = fn; }, querySelector: () => null, querySelectorAll: () => [],
    append(child) { this.children.push(child); }, ...extra });
  const parts = Object.fromEntries(['preview', 'reading', 'form', 'amount', 'slider', 'explorer', 'status', 'send', 'info', 'help']
    .map(name => [name, node()]));
  const gaugeParts = () => Object.fromEntries(['fill', 'after', 'needle', 'times', 'balance'].map(name => [`.wg-${name}`, node()]));
  const previewParts = gaugeParts(), buttonParts = gaugeParts();
  parts.preview.querySelector = selector => previewParts[selector];
  parts.help.hidden = true;
  const presets = ['1', '2', '3', '5'].map(tanks => node({ dataset: { workerGasPreset: tanks } }));
  const dialog = node({ open: false, querySelector: selector => parts[/data-worker-gas-(\w+)/.exec(selector)[1]],
    querySelectorAll: selector => selector.includes('preset') ? presets : [],
    showModal() { this.open = true; }, close() { this.open = false; } });
  const button = node({ querySelector: selector => buttonParts[selector] }), calendar = { open: false };
  const ids = { 'worker-gas-gauge': button, 'worker-gas-dialog': dialog, 'radio-programming-modal': calendar };
  const signer = { getAddress: async () => ADMIN,
    sendTransaction: async tx => { sent.push(tx); return { hash: '0xfeed', wait: async () => ({ status: 1, hash: '0xfeed' }) }; } };
  const context = vm.createContext({
    document: { hidden: false, getElementById: id => ids[id], createElement: () => node(),
      addEventListener: (name, fn) => listeners.set(name, fn) },
    window: { ethereum: {}, DecentConfig: { djukeContractAddress: 'configured', djukeContractVersion: '0.5' } },
    isAdminWallet: address => env.admin && (address === undefined || address === ADMIN),
    getBaseReadProvider: () => ({ getNetwork: async () => ({ chainId: 8453n }), destroy() {},
      getBalance: address => new Promise(resolve => reads.push({ address, resolve })) }),
    ensureBaseNetwork: async provider => { switched.push(provider); },
    BASE_CHAIN_ID: 8453,
    ethers: { Contract: function () { return { gasWorker: async () => env.worker }; },
      BrowserProvider: function (ethereum, network) { this.network = network; this.getSigner = async () => signer; } },
    Date: { now: () => env.now },
    setTimeout, clearTimeout, setInterval: (fn, ms) => timers.push({ fn, ms }), console: { warn() {} },
  });
  const source = fs.readFileSync(require('node:path').join(__dirname, '../js/worker-gas.mjs'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(source, context);
  listeners.get('DOMContentLoaded')();
  return { env, listeners, timers, reads, sent, switched, parts, presets, dialog, button, calendar, previewParts, buttonParts,
    emit: name => listeners.get(name)() };
}

test('calendar gauge reads only for admins while the calendar is open and paints a low tank', async () => {
  const f = gaugeFixture();
  assert.equal(f.button.hidden, true);
  f.emit('open-radio-programming');
  assert.equal(f.reads.length, 0, 'non-admins never poll the worker wallet');
  f.env.admin = true;
  f.emit('wallet-connected');
  assert.equal(f.button.hidden, false);
  assert.equal(f.reads.length, 0, 'no balance reads while the calendar is closed');
  f.calendar.open = true;
  f.emit('open-radio-programming');
  await tick();
  f.reads[0].resolve(milli(0.001914));
  await tick();
  assert.equal(f.button.dataset.level, 'low');
  assert.match(f.button.attrs['aria-label'], /0\.001914 ETH · ~22 days · 64% of a 0\.003 ETH tank · low/);
  assert.equal(f.timers[0].ms, 60000);
  f.timers[0].fn();
  assert.equal(f.reads.length, 1, 'a fresh reading is reused');
  f.env.now += 60000;
  f.calendar.open = false;
  f.timers[0].fn();
  assert.equal(f.reads.length, 1, 'no polling after the calendar closes');
  f.calendar.open = true;
  f.timers[0].fn();
  await tick();
  assert.equal(f.reads.length, 2);
  f.env.admin = false;
  f.emit('wallet-disconnected');
  f.reads[1].resolve(milli(0.01));
  await tick();
  assert.equal(f.button.hidden, true);
  assert.equal(f.button.dataset.level, 'unknown', 'a stale read cannot repaint a disconnected gauge');
});

test('top-up dialog suggests a fill, re-verifies the worker, and sends the chosen amount', async () => {
  const f = gaugeFixture();
  f.env.admin = true;
  f.calendar.open = true;
  f.emit('open-radio-programming');
  await tick();
  f.reads[0].resolve(milli(0.001914));
  await tick();
  f.button.listeners.click();
  assert.equal(f.dialog.open, true);
  assert.equal(f.parts.amount.value, '0.001086', 'opens on the amount that fills the tank');
  await tick();
  f.reads[1].resolve(milli(0.001914));
  await tick();
  assert.equal(f.parts.send.disabled, false);
  assert.equal(f.parts.send.textContent, 'Send 0.001086 ETH');
  assert.equal(f.parts.explorer.href, `https://basescan.org/address/${WORKER}`);
  assert.equal(f.parts.preview.dataset.afterLevel, 'full');
  assert.equal(f.previewParts['.wg-times'].textContent, '', 'a proposed addition never changes actual tank multiples');
  assert.equal(f.previewParts['.wg-balance'].textContent, '0.001914 ETH');
  f.parts.info.listeners.click();
  assert.equal(f.parts.help.hidden, false);
  assert.equal(f.parts.info.attrs['aria-expanded'], 'true');
  f.presets[1].listeners.click();
  assert.equal(f.parts.amount.value, '0.004086', '2× fills to two tanks');
  f.parts.amount.value = '0.009';
  f.parts.amount.listeners.input();
  assert.equal(f.parts.send.textContent, 'Send 0.009 ETH');
  assert.equal(f.parts.preview.dataset.afterLevel, 'full');
  assert.equal(f.previewParts['.wg-times'].textContent, '', 'even a large addition does not appear as already held');
  f.parts.amount.value = '3';
  f.parts.amount.listeners.input();
  assert.equal(f.parts.send.disabled, true);
  assert.match(f.parts.status.textContent, /capped/);
  f.parts.amount.value = '0.009';
  f.parts.amount.listeners.input();

  f.env.worker = `0x${'2'.repeat(40)}`;
  const changed = f.parts.form.listeners.submit({ preventDefault() {} });
  await tick();
  f.reads[2].resolve(milli(0.001914));
  await changed;
  assert.equal(f.sent.length, 0, 'a changed worker wallet is never paid without review');
  assert.match(f.parts.status.textContent, /worker wallet changed/);

  const sending = f.parts.form.listeners.submit({ preventDefault() {} });
  await tick();
  f.reads[3].resolve(milli(0.001914));
  await tick();
  await tick();
  assert.equal(f.switched.length, 1, 'switches the wallet to Base first');
  assert.equal(f.sent.length, 1);
  assert.deepEqual({ ...f.sent[0] }, { to: f.env.worker, value: milli(0.009), chainId: 8453 });
  await tick();
  f.reads[4].resolve(milli(0.010914));
  await sending;
  assert.match(f.parts.status.textContent, /✓ Added 0\.009 ETH/);
  assert.equal(f.parts.status.children[0].href, 'https://basescan.org/tx/0xfeed');
  assert.equal(f.parts.amount.value, '', 'the amount clears so a second click cannot resend');
  assert.equal(f.parts.send.disabled, true);
  assert.equal(f.button.dataset.level, 'full');
  assert.match(f.button.attrs['aria-label'], /3 tanks/);
  assert.equal(f.buttonParts['.wg-times'].textContent, '3×');
  assert.equal(f.previewParts['.wg-times'].textContent, '3×');
  assert.equal(f.previewParts['.wg-balance'].textContent, '0.010914 ETH');
});
