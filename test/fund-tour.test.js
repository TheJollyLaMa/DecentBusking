const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('Discord proof links preserve the deployed site subpath and select a closed-week payroll tutorial', async () => {
  const { payrollTutorialUrl } = await import('../discord-bot/weekly-payroll-report.js');
  const { payrollTourWeek } = await import('../js/fund-tour.mjs');
  const link = new URL(payrollTutorialUrl('https://example.org/DecentBusking/?old=value#old', 'NY-2026-10-12'));
  assert.equal(link.pathname, '/DecentBusking/');
  assert.equal(link.hash, '');
  assert.equal(link.searchParams.get('old'), null);
  assert.equal(payrollTourWeek(link.search), 'NY-2026-10-12');
  assert.equal(payrollTourWeek('?tutorial=payroll'), '');
  assert.equal(payrollTourWeek('?other=value'), null);
  assert.throws(() => payrollTourWeek('?tutorial=payroll&week=NY-2026-10-13'));
  assert.throws(() => payrollTourWeek('?tutorial=payroll&week=%3Cscript%3E'));
  assert.throws(() => payrollTutorialUrl('javascript:alert(1)', 'NY-2026-10-12'));
});

test('guide covers both pills, separate fund panels, weekly archive, DVert and explicit sponsorship', async () => {
  const { FUND_TOUR_STEPS } = await import('../js/fund-tour.mjs');
  assert.deepEqual(FUND_TOUR_STEPS[0].selectors, ['#dbusk-top10-button', '#dbusk-playback-button']);
  assert.ok(FUND_TOUR_STEPS.some(step => step.fund === 'dbusk-top10' && step.archive));
  assert.ok(FUND_TOUR_STEPS.some(step => step.fund === 'dbusk-playback' && step.archive));
  assert.ok(FUND_TOUR_STEPS.some(step => step.action === 'devert'));
  assert.match(FUND_TOUR_STEPS.at(-1).body, /\$5, \$10, \$1,000/);
  assert.match(FUND_TOUR_STEPS.at(-1).body, /No payment is requested by this tour/);
});

test('payroll deep link suppresses the unrelated first-visit tutorial without marking it completed', () => {
  const source = fs.readFileSync('js/tutorial.js', 'utf8')
    .replace(/^import .*split-tutorial-surfaces.*;\n/m, '').replace(/^export /gm, '');
  const timers = [];
  const context = vm.createContext({ URLSearchParams, window: { location: { search: '?tutorial=payroll' } },
    setTimeout: fn => timers.push(fn) });
  vm.runInContext(`${source}\n_autoLaunch();`, context);
  assert.equal(timers.length, 0);
});
