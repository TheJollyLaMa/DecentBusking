const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createTimerHarness() {
  let nextId = 1;
  const timers = [];
  return {
    timers,
    setTimeout(callback, delay) {
      const timer = { id: nextId++, callback, delay, cancelled: false };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout(id) {
      const timer = timers.find(entry => entry.id === id);
      if (timer) timer.cancelled = true;
    },
    runNext() {
      while (timers.length) {
        const timer = timers.shift();
        if (!timer.cancelled) {
          timer.callback();
          return timer;
        }
      }
      return null;
    },
    runAll() {
      while (this.runNext());
    },
    lastDelay() {
      const timer = [...timers].reverse().find(entry => !entry.cancelled);
      return timer?.delay;
    },
  };
}

function createCelebrationFixture({ reducedMotion = false } = {}) {
  const timers = createTimerHarness();
  const listeners = new Map();
  const stage = {
    hidden: false,
    dataset: {},
    innerHTML: '',
    replaceChildren() { this.innerHTML = ''; },
    addEventListener() {},
  };
  const title = { textContent: '' };
  const summary = { textContent: '' };
  const subtitle = { textContent: '' };
  const link = { href: '', textContent: '' };
  const dismiss = {
    listeners: new Map(),
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    click() { this.listeners.get('click')?.({ target: dismiss }); },
  };
  const root = {
    hidden: true,
    dataset: {},
    className: '',
    innerHTML: '',
    removeCalled: false,
    querySelector(selector) {
      return {
        '.payment-celebration-title': title,
        '.payment-celebration-summary': summary,
        '.payment-celebration-subtitle': subtitle,
        '.payment-celebration-link': link,
        '.payment-celebration-dismiss': dismiss,
        '.payment-celebration-stage': stage,
      }[selector] || null;
    },
    setAttribute() {},
    remove() { this.removeCalled = true; },
  };
  const document = {
    hidden: false,
    readyState: 'complete',
    body: { appendChild() {} },
    head: { appendChild() {} },
    getElementById() { return null; },
    createElement(tag) {
      if (tag === 'style') return { id: '', textContent: '' };
      return root;
    },
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name, callback) {
      if (listeners.get(name) === callback) listeners.delete(name);
    },
  };
  const window = {
    matchMedia: () => ({ matches: reducedMotion }),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  };
  return { timers, document, window, root, stage, title, summary, subtitle, link, dismiss };
}

test('payment celebrations rotate through 12 distinct effects before repeating', async () => {
  const { announcePaymentCelebration, resetPaymentCelebrationState } = await import('../js/payment-celebration.mjs');
  resetPaymentCelebrationState();
  const effects = [];
  for (let index = 0; index < 13; index++) {
    const result = announcePaymentCelebration({
      chainId: 8453,
      txHash: `0x${String(index + 1).padStart(64, '0')}`,
      amountText: '0.25',
      assetText: 'USDC',
    });
    assert.equal(result.accepted, true);
    effects.push(result.effectId);
  }
  assert.equal(new Set(effects.slice(0, 12)).size, 12);
  assert.equal(effects[12], effects[0]);
});

test('payment celebrations keep a compact confirmation and queued link after the animated phase', async () => {
  const { announcePaymentCelebration, initPaymentCelebrations, resetPaymentCelebrationState } = await import('../js/payment-celebration.mjs');
  resetPaymentCelebrationState();
  const ui = createCelebrationFixture();
  const controller = initPaymentCelebrations({ document: ui.document, window: ui.window });
  try {
    const first = {
      chainId: 8453,
      txHash: `0x${'1'.repeat(64)}`,
      title: 'First payment',
      summary: 'First summary',
      amountText: '0.10',
      assetText: 'USDC',
    };
    const second = {
      chainId: 8453,
      txHash: `0x${'2'.repeat(64)}`,
      title: 'Second payment',
      summary: 'Second summary',
      amountText: '0.20',
      assetText: 'USDC',
    };
    assert.equal(announcePaymentCelebration(first).accepted, true);
    assert.equal(announcePaymentCelebration(second).accepted, true);
    assert.equal(ui.root.hidden, false);
    assert.equal(ui.root.dataset.phase, 'celebrating');
    assert.equal(ui.title.textContent, 'First payment');
    assert.equal(ui.summary.textContent, 'First summary · 0.10 USDC');
    assert.equal(ui.link.href, `https://basescan.org/tx/${first.txHash}`);
    assert.equal(ui.timers.lastDelay(), 5400);

    ui.timers.runNext();
    assert.equal(ui.root.hidden, false);
    assert.equal(ui.root.dataset.phase, 'compact');
    assert.equal(ui.stage.hidden, true);
    assert.equal(ui.stage.innerHTML, '');
    assert.equal(ui.title.textContent, 'First payment');
    assert.equal(ui.link.href, `https://basescan.org/tx/${first.txHash}`);

    ui.timers.runNext();
    assert.equal(ui.root.hidden, false);
    assert.equal(ui.root.dataset.phase, 'celebrating');
    assert.equal(ui.title.textContent, 'Second payment');
    assert.equal(ui.summary.textContent, 'Second summary · 0.20 USDC');
    assert.equal(ui.link.href, `https://basescan.org/tx/${second.txHash}`);
  } finally {
    controller.destroy();
  }
});

test('reduced-motion confirmations stay readable without animation', async () => {
  const { announcePaymentCelebration, initPaymentCelebrations, resetPaymentCelebrationState } = await import('../js/payment-celebration.mjs');
  resetPaymentCelebrationState();
  const ui = createCelebrationFixture({ reducedMotion: true });
  const controller = initPaymentCelebrations({ document: ui.document, window: ui.window });
  try {
    const result = announcePaymentCelebration({
      chainId: 8453,
      txHash: `0x${'a'.repeat(64)}`,
      title: 'Reduced motion payment',
      summary: 'Readable summary',
      amountText: '1.25',
      assetText: 'ETH',
    });
    assert.equal(result.accepted, true);
    assert.equal(ui.root.dataset.phase, 'reduced');
    assert.match(ui.stage.innerHTML, /pc-static-row/);
    assert.equal(ui.title.textContent, 'Reduced motion payment');
    assert.equal(ui.summary.textContent, 'Readable summary · 1.25 ETH');
    assert.equal(ui.timers.lastDelay(), 6200);
    ui.timers.runNext();
    assert.equal(ui.root.hidden, true);
  } finally {
    controller.destroy();
  }
});

test('duplicate confirmed transfers are ignored', async () => {
  const { announcePaymentCelebration, resetPaymentCelebrationState } = await import('../js/payment-celebration.mjs');
  resetPaymentCelebrationState();
  const detail = { chainId: 8453, txHash: `0x${'a'.repeat(64)}`, amountText: '1.00', assetText: 'USDC' };
  assert.equal(announcePaymentCelebration(detail).accepted, true);
  assert.equal(announcePaymentCelebration(detail).accepted, false);
});

test('confirmed payment links use the transaction chain and amounts show currency once', () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/payment-celebration.mjs'), 'utf8')
    .replace(/export /g, '');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  const hash = `0x${'c'.repeat(64)}`;
  assert.equal(context.normalize({ chainId: 8453, txHash: hash }).explorerUrl, `https://basescan.org/tx/${hash}`);
  assert.equal(context.normalize({ chainId: 10, txHash: hash }).explorerUrl, `https://optimistic.etherscan.io/tx/${hash}`);
  assert.equal(context.paymentLine({ amountText: '0.01', assetText: 'ETH', summary: 'Tip confirmed' }),
    'Tip confirmed · 0.01 ETH');
});
