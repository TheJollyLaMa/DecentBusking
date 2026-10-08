const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const url = pathToFileURL(path.join(__dirname, '../js/payroll-week.mjs')).href;

test('payroll rolls Monday at midnight New York time rather than UTC midnight', async () => {
  const { currentPayrollPeriod, payrollPeriodFromKey } = await import(url);
  assert.equal(currentPayrollPeriod(Date.parse('2026-10-12T03:59:59Z')).week, 'NY-2026-10-05');
  assert.equal(currentPayrollPeriod(Date.parse('2026-10-12T04:00:00Z')).week, 'NY-2026-10-12');
  assert.equal(payrollPeriodFromKey('NY-2026-10-05').endAt, '2026-10-12T04:00:00.000Z');
  assert.throws(() => payrollPeriodFromKey('NY-2026-10-06'), /Monday/);
  assert.throws(() => payrollPeriodFromKey('NY-2026-02-30'));
});

test('New York payroll accounts for short and long DST weeks and year rollover', async () => {
  const { payrollPeriodFromKey, currentPayrollPeriod, payrollPeriods } = await import(url);
  const spring = payrollPeriodFromKey('NY-2026-03-02');
  const fall = payrollPeriodFromKey('NY-2026-10-26');
  assert.equal((Date.parse(spring.endAt) - Date.parse(spring.startAt)) / 3600000, 167);
  assert.equal((Date.parse(fall.endAt) - Date.parse(fall.startAt)) / 3600000, 169);
  assert.equal(currentPayrollPeriod(Date.parse('2027-01-01T12:00:00Z')).week, 'NY-2026-12-28');
  assert.equal(payrollPeriods(2, Date.parse('2026-10-08T12:00:00Z'))[0].week, 'NY-2026-09-28');
});

test('a paid overlapping UTC receipt blocks New York payments instead of paying twice', async () => {
  const { finalizeRadioAllocation, radioWorkReferenceText, settleRadioAllocation } = await import(pathToFileURL(path.join(__dirname, '../js/radio-payroll.mjs')).href);
  const wallet = `0x${'1'.repeat(40)}`;
  const owner = `0x${'2'.repeat(40)}`;
  const allocation = finalizeRadioAllocation({ report: { week: 'NY-2026-09-28', current: false, tracks: [{ wallet, plays: 1 }] }, category: 'playback',
    budgetUnits: 1000000n, minimumUnits: 1n, fundSlug: 'dbusk-playback', routerAddress: owner,
    assetAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', now: Date.parse('2026-10-06T00:00:00Z') });
  const legacy = radioWorkReferenceText({ week: '2026-W40', category: 'playback', wallet });
  const router = { target: owner, paused: async () => false, PAYROLL_ROLE: async () => 'role', hasRole: async () => true,
    approvedAssets: async () => true, funds: async () => ({ exists: true, active: true }), completedWorkReferences: async reference => reference === legacy };
  await assert.rejects(settleRadioAllocation({ allocation, router, owner, hashReference: value => value,
    signer: { getAddress: async () => owner, provider: { getNetwork: async () => ({ chainId: 8453 }) } },
    metadataUri: 'ipfs://receipt', metadataHash: `0x${'3'.repeat(64)}` }), /paid legacy UTC receipt overlaps/);
});

test('New York receipts freeze the correct period and keep legacy references separate', async () => {
  const { finalizeRadioAllocation, radioWorkReferenceText, validateRadioReceipt } = await import(pathToFileURL(path.join(__dirname, '../js/radio-payroll.mjs')).href);
  const wallet = `0x${'1'.repeat(40)}`;
  const config = { routerAddress: `0x${'2'.repeat(40)}`, assetAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', funds: { playback: 'dbusk-playback' } };
  const input = { report: { week: 'NY-2026-09-28', current: false, partial: true, tracks: [{ wallet, plays: 1 }] }, category: 'playback',
    budgetUnits: 1000000n, minimumUnits: 1n, fundSlug: 'dbusk-playback', ...config, now: Date.parse('2026-10-05T04:00:00Z') };
  const receipt = finalizeRadioAllocation(input);
  assert.equal(receipt.schemaVersion, 3);
  assert.equal(receipt.partial, true);
  assert.equal(receipt.endAt, '2026-10-05T04:00:00.000Z');
  assert.equal(validateRadioReceipt(receipt, config), receipt);
  assert.notEqual(receipt.entries[0].workReferenceText, radioWorkReferenceText({ week: '2026-W40', category: 'playback', wallet }));
  assert.throws(() => finalizeRadioAllocation({ ...input, now: Date.parse('2026-10-05T03:59:59Z') }), /not completed/);
  assert.throws(() => validateRadioReceipt({ ...receipt, endAt: '2026-10-05T00:00:00Z' }, config), /boundaries/);
});