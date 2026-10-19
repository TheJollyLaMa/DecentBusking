const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('js/payroll.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');

function fixture() {
  const entry = (number, amount = '1000000') => ({ workReferenceText: `reference-${number}`, amountUnits: amount });
  const allocation = { entries: [entry(1), entry(2, '2000000')], allocatedUnits: '3000000' };
  const context = vm.createContext({
    _radioReviews: { playback: { allocation } },
    _radioRecipientStates: new Map(allocation.entries.map(entry => [entry.workReferenceText, { paid: false, approved: true }])),
    _weeklyPayflow: { ready: true, lastError: '', backupPending: false },
    _radioBalances: { approved: true, playback: { active: true, available: 5000000n } },
    _settling: false,
    radioAllocationMatchesReport: () => true,
  });
  const start = source.indexOf('function _radioBatchState(');
  vm.runInContext(source.slice(start, source.indexOf('function _renderRadioOverview(', start)), context);
  return { context, report: { week: 'NY-2026-10-12', current: false },
    state() { context.report = this.report; return vm.runInContext('_radioBatchState("playback", report)', context); } };
}

test('ready batches require checked wallets, with missing approvals handled during Pay', () => {
  const value = fixture();
  assert.equal(value.state().tone, 'ready');
  assert.equal(value.state().ready, true);
  assert.equal(value.state().remainingUnits, 3000000n);
  value.context._radioRecipientStates.delete('reference-1');
  assert.equal(value.state().label, 'Checking Base');
  assert.equal(value.state().checking, true);
  assert.equal(value.state().ready, false);
  value.context._radioRecipientStates.set('reference-1', { paid: false, approved: false });
  assert.equal(value.state().label, 'Ready to pay');
  assert.equal(value.state().ready, true);
  assert.match(value.state().reason, /one-time approval/);
});

test('partial payment only offers remaining entries and a completed batch cannot pay again', () => {
  const value = fixture();
  value.context._radioRecipientStates.set('reference-1', { paid: true, approved: true });
  assert.equal(value.state().paid, 1);
  assert.equal(value.state().unpaid.length, 1);
  assert.equal(value.state().remainingUnits, 2000000n);
  value.context._radioRecipientStates.set('reference-2', { paid: true, approved: false });
  assert.equal(value.state().tone, 'paid');
  assert.equal(value.state().remainingUnits, 0n);
  assert.equal(value.state().ready, false);
});

test('Top 10 Pay counts distinct unpaid wallets rather than song prizes', () => {
  const value = fixture();
  const entries = value.context._radioReviews.playback.allocation.entries;
  entries[0].wallet = '0xAbC';
  entries[1].wallet = '0xabc';
  assert.equal(value.state().walletPayments, 1);
  entries[1].wallet = '0xdef';
  assert.equal(value.state().walletPayments, 2);
  value.context._radioRecipientStates.set('reference-1', { paid: true, approved: true });
  assert.equal(value.state().walletPayments, 1);
  value.context._radioRecipientStates.set('reference-2', { paid: true, approved: true });
  assert.equal(value.state().walletPayments, 0);
  assert.match(source, /batch\.walletPayments \|\| ''/);
  assert.match(source, /wallet payments remaining/);
});

test('missing receipts, open weeks and excluded rollout weeks never appear as payable zero-dollar batches', () => {
  const value = fixture();
  value.context._radioReviews = {};
  assert.equal(value.state().label, 'Waiting for receipt');
  assert.equal(value.state().ready, false);
  value.report.current = true;
  assert.equal(value.state().label, 'Week in progress');
  value.report.current = false;
  value.context._weeklyPayflow.ignoredWeeks = [value.report.week];
  assert.equal(value.state().label, 'Excluded week');
  assert.match(source, /zero is not a confirmed payout amount/);
});

test('mismatched receipts, unhealthy backups, underfunding and active settlement block pay with next-step guidance', () => {
  for (const [modify, label] of [
    [context => { context.radioAllocationMatchesReport = () => false; }, 'Receipt needs review'],
    [context => { context._weeklyPayflow = null; }, 'Preparation unavailable'],
    [context => { context._weeklyPayflow.backupPending = true; }, 'Preparation unavailable'],
    [context => { context._weeklyPayflow.lastError = 'RPC unavailable'; }, 'Preparation unavailable'],
    [context => { context._radioBalances.playback.available = 2999999n; }, 'Check fund balance'],
    [context => { context._radioBalances.approved = false; }, 'Check fund balance'],
  ]) {
    const value = fixture();
    modify(value.context);
    assert.equal(value.state().label, label);
    assert.equal(value.state().ready, false);
    assert.ok(value.state().reason.length > 20);
  }
  const value = fixture();
  value.context._settling = true;
  assert.equal(value.state().ready, false);
});

test('technical details and previews start collapsed and category buttons retain their original identity', () => {
  assert.match(html, /<details id="payroll-estimates" class="payroll-secondary-flow">/);
  assert.match(source, /disclosure\.className = 'payroll-reference-disclosure'/);
  assert.match(source, /const buttons = new Map/);
  assert.match(source, /card\.append\(button\)/);
  assert.match(source, /weeklySection\.after\(treasurySection\)/);
  for (const id of ['radio-settle-playback', 'radio-settle-top10', 'radio-playback-budget', 'radio-prize-budget', 'radio-minimum-payout']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1);
  }
});

test('recipient reviews stay expanded without manual identity or approval controls', () => {
  assert.match(source, /recipients\.open = expanded\.has\(category\)/);
  assert.doesNotMatch(source, /Verified contributor identity|Approve Recipient|_approveRadioRecipient/);
  assert.match(source, /wallet enabled during Pay/);
});

test('unchanged review polling leaves the existing DOM untouched', () => {
  const target = { dataset: {}, querySelectorAll() { throw new Error('render required'); } };
  const report = { week: 'NY-2026-10-12', tracks: [] };
  const batch = { remainingUnits: 1n, ready: true };
  target.dataset.renderKey = JSON.stringify({
    report, positiveBudget: true, settling: false,
    batches: [batch, batch], recipients: [],
  }, (_, value) => typeof value === 'bigint' ? value.toString() : value);
  const context = vm.createContext({
    document: { getElementById: id => id === 'radio-reviewed-receipts' ? target : { value: id === 'radio-payroll-week' ? report.week : '1' } },
    _radioReports: [report], _settling: false, _radioRecipientStates: new Map(),
    _radioBatchState: () => batch,
  });
  const start = source.indexOf('function _renderRadioReviews()');
  vm.runInContext(source.slice(start, source.indexOf('async function _finalizeRadioPayroll()', start)), context);
  assert.doesNotThrow(() => vm.runInContext('_renderRadioReviews()', context));
  batch.ready = false;
  assert.throws(() => vm.runInContext('_renderRadioReviews()', context), /render required/);
});

test('recipient checks retain verified states until results arrive, and failures clear readiness', async () => {
  let complete;
  let fail = false;
  const states = new Map([['ref', { paid: false, approved: true }]]);
  const errors = [];
  const context = vm.createContext({
    _recipientCheckId: 0, _recipientCheckTask: null, _ownerAddress: 'owner', _radioRecipientStates: states,
    _radioReviews: { playback: { allocation: { entries: [{ workReferenceText: 'ref', wallet: 'wallet' }] } } },
    _renderRadioReviews() {}, isAdminWallet: () => true,
    ethers: { id: value => value }, document: { getElementById: () => ({}) },
    _setStatus: (_, text) => errors.push(text),
    _readOnlyRouter: () => ({
      completedWorkReferences: () => new Promise((resolve, reject) => { complete = () => fail ? reject(new Error('RPC offline')) : resolve(true); }),
      contributors: async () => ({ approved: true }),
    }),
  });
  const start = source.indexOf('async function _checkRadioRecipients()');
  vm.runInContext(source.slice(start, source.indexOf('function _loadRadioReviews()', start)), context);
  const pending = vm.runInContext('_checkRadioRecipients()', context);
  const overlapping = vm.runInContext('_checkRadioRecipients()', context);
  assert.equal(context._recipientCheckId, 1);
  assert.equal(states.get('ref').approved, true);
  complete();
  await pending;
  await overlapping;
  assert.equal(vm.runInContext('_radioRecipientStates.get("ref").paid', context), true);
  fail = true;
  const failed = vm.runInContext('_checkRadioRecipients()', context);
  complete();
  await failed;
  assert.equal(vm.runInContext('_radioRecipientStates.size', context), 0);
  assert.match(errors[0], /Recipient checks failed: RPC offline/);
});

test('empty receipts have nothing payable, while legacy reviewed batches remain usable without the New York worker', () => {
  const value = fixture();
  value.context._radioReviews.playback.allocation.entries = [];
  assert.equal(value.state().label, 'Nothing to pay');
  assert.equal(value.state().ready, false);
  const legacy = fixture();
  legacy.report.week = '2026-09-28';
  legacy.context._weeklyPayflow = null;
  assert.equal(legacy.state().ready, true);
});

test('history refresh and wallet disconnect rerender instead of deleting the live payment buttons', () => {
  for (const [start, end] of [
    ['async function _refreshRadioPayroll(', 'async function _refreshWeeklyPayflow()'],
    ['function _onWalletDisconnected()', 'export async function loadPayrollQueue()'],
  ]) {
    const section = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
    assert.match(section, /_renderRadioReviews\(\)/);
    assert.doesNotMatch(section, /getElementById\('radio-reviewed-receipts'\)\?\.replaceChildren\(\)/);
  }
});

test('background history refresh keeps the display while loading but blocks payments on failure', async () => {
  let reject;
  let renders = 0;
  const statuses = [];
  const context = vm.createContext({
    Date, _weeklyHistoryRefreshedAt: 0, _radioRefreshId: 0,
    _radioReports: [{ week: 'NY-2026-10-12' }], _radioBalances: { approved: true }, _radioReviews: { playback: {} },
    document: { getElementById: () => ({ value: 'NY-2026-10-12' }) },
    isAdminWallet: () => true, window: { DecentConfig: { ipfsUploadServiceUrl: 'https://worker.example' } },
    fetch: () => new Promise((_, fail) => { reject = fail; }),
    _renderRadioReviews: () => { renders++; },
    _setStatus: (_, text) => statuses.push(text),
  });
  const start = source.indexOf('async function _refreshRadioPayroll(');
  vm.runInContext(source.slice(start, source.indexOf('function _applyScheduledBudgets()', start)), context);
  const pending = vm.runInContext('_refreshRadioPayroll({ background: true })', context);
  assert.equal(renders, 0);
  assert.equal(vm.runInContext('_radioReports.length', context), 1);
  assert.equal(vm.runInContext('_radioBalances.approved', context), true);
  reject(new Error('History offline'));
  await pending;
  assert.equal(vm.runInContext('_radioBalances', context), null);
  assert.equal(renders, 1);
  assert.match(statuses[0], /History offline.*Refresh before finalizing or settling/);
});
