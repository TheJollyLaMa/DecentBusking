const test = require('node:test');
const assert = require('node:assert/strict');

test('pill and chart budgets use the latest ledger balance minus reservations, not the older payroll balance', async () => {
  const { fundBudgetFor } = await import('../js/fund-budget.mjs');
  const state = {
    funds: { 'dbusk-top10': { balanceUnits: '21000000', balanceAvailable: true } },
    weekly: { fundShareBps: 10000, funds: { top10: {
      balanceUnits: '11000000', reservedUnits: '1000000', budgetUnits: '10000000',
    } } },
  };
  assert.deepEqual(fundBudgetFor(state, 'dbusk-top10'),
    { balanceUnits: '21000000', reservedUnits: '1000000', budgetUnits: '20000000' });
  state.weekly.fundShareBps = 5000;
  assert.equal(fundBudgetFor(state, 'dbusk-top10').budgetUnits, '10000000');
  state.funds['dbusk-top10'].balanceUnits = '500000';
  assert.equal(fundBudgetFor(state, 'dbusk-top10').budgetUnits, '0', 'unpaid old prizes remain reserved');
  state.funds['dbusk-top10'].balanceUnits = '21000000';
  state.funds['dbusk-top10'].balanceAvailable = false;
  assert.equal(fundBudgetFor(state, 'dbusk-top10').budgetUnits, null);
  state.funds['dbusk-top10'].balanceUnits = null;
  assert.equal(fundBudgetFor(state, 'dbusk-top10').budgetUnits, null);
  assert.equal(fundBudgetFor({ funds: state.funds }, 'dbusk-top10').budgetUnits, null, 'no fabricated budget without current payroll');
  assert.equal(fundBudgetFor({}, 'dbusk-top10', '7').balanceUnits, '7');
});
