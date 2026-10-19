const test = require('node:test');
const assert = require('node:assert/strict');

function documentFixture() {
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.value = ''; this.listeners = new Map(); }
    set textContent(value) { this.value = value; this.children = []; }
    get textContent() { return this.value + this.children.map(child => child.textContent).join(' '); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.value = ''; this.children = nodes; }
    setAttribute() {}
    addEventListener(event, listener) { this.listeners.set(event, listener); }
    querySelector(selector) { return this.children.find(child => `.${child.className}` === selector); }
  }
  const body = new Node('body');
  return { body, createElement: tag => new Node(tag), getElementById: id => body.children.find(child => child.id === id) };
}

test('gas accounting includes execution, Base L1 data and optional operator fees without rounding', async () => {
  const { payrollTransactionFee } = await import('../js/payroll-confirmations.mjs');
  let calls = 0;
  const provider = { send: async (method, args) => {
    calls++;
    assert.equal(method, 'eth_getTransactionReceipt');
    assert.deepEqual(args, ['hash']);
    return { l1Fee: '0x0a', operatorFee: '0x02' };
  } };
  assert.deepEqual(await payrollTransactionFee({ fee: 100n }, provider, 'hash'), { wei: 112n, error: null });
  assert.equal(calls, 1);
  assert.deepEqual(await payrollTransactionFee({ gasUsed: 21000n, gasPrice: 2n, l1Fee: '3' }, provider, 'hash'),
    { wei: 42003n, error: null });
  assert.equal(calls, 1);
  assert.deepEqual(await payrollTransactionFee({ fee: 0n, l1Fee: '0x0' }, provider, 'hash'), { wei: 0n, error: null });
});

test('one persistent panel combines categories, approvals and reverted costs without double-counting', async () => {
  const { recordPayrollConfirmation, setPayrollConfirmationStatus } = await import('../js/payroll-confirmations.mjs');
  const document = documentFixture();
  globalThis.document = document;
  const week = 'NY-panel-test';
  const record = (number, kind, category, amountUnits, entries = 1) => recordPayrollConfirmation({
    week, kind, category, amountUnits, entries, wallet: '0xartist',
    txHash: `0x${String(number).padStart(64, '0')}`, receipt: { fee: 1000000000000n, l1Fee: 2000000000000n },
  });
  try {
    setPayrollConfirmationStatus(week, 'playback', 'In progress');
    assert.equal(document.body.children.length, 0);
    await record(1, 'approval', 'playback', '0', 0);
    const panel = document.getElementById('payroll-confirmations');
    assert.ok(panel);
    assert.equal(panel.hidden, false);
    await record(2, 'payout', 'playback', '15670000');
    await record(3, 'payout', 'top10', '12900000', 2);
    await record(4, 'failed', 'top10', '999000000');
    await record(3, 'payout', 'top10', '12900000', 2);
    setPayrollConfirmationStatus(week, 'playback', 'Complete');
    setPayrollConfirmationStatus(week, 'top10', 'Stopped: Wallet rejected');
    assert.equal(document.body.children.length, 1);
    assert.match(panel.textContent, /2 payments.*Playback 15.67 USDC.*Top 10 12.90 USDC.*Total paid 28.57 USDC/);
    assert.match(panel.textContent, /Gas spent: 0.000012 ETH/);
    assert.match(panel.textContent, /Reverted transaction.*no payment/);
    assert.match(panel.textContent, /2 prizes/);
    assert.match(panel.textContent, /Stopped: Wallet rejected/);
    const content = panel.querySelector('.payroll-confirmations-content');
    const list = content.children.find(node => node.tag === 'ol');
    assert.equal(list.children.length, 4);
    assert.equal(list.children[0].children[0].href, `https://basescan.org/tx/0x${'1'.padStart(64, '0')}`);
    panel.children[0].listeners.get('click')();
    assert.equal(panel.hidden, true);
    await record(5, 'payout', 'top10', '1000000');
    assert.equal(panel.hidden, false);
    setPayrollConfirmationStatus(week, 'top10', 'Complete');
    assert.match(panel.textContent, /Total paid 29.57 USDC/);
    assert.match(panel.textContent, /Top 10: Complete/);
    assert.equal(document.body.children.length, 1);
  } finally {
    delete globalThis.document;
  }
});

test('missing fee data explicitly marks totals incomplete and retains the confirmed payout', async () => {
  const { recordPayrollConfirmation } = await import('../js/payroll-confirmations.mjs');
  const document = documentFixture();
  globalThis.document = document;
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    await recordPayrollConfirmation({ week: 'NY-missing-fees', category: 'top10', kind: 'payout',
      wallet: 'artist', txHash: `0x${'a'.repeat(64)}`, amountUnits: '1000000', entries: 1,
      receipt: { fee: 20n }, provider: { send: async () => { throw new Error('RPC offline'); } } });
    const panel = document.getElementById('payroll-confirmations');
    assert.match(panel.textContent, /Total paid 1.00 USDC/);
    assert.match(panel.textContent, /Gas unavailable: RPC offline/);
    assert.match(panel.textContent, /known subtotal.*total incomplete/);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = warn;
    delete globalThis.document;
  }
});
