const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewBugReport } = require('../scripts/reviewBugReport');
const { buildPayrollAlert, notifyPayrollPending } = require('../scripts/notifyPayrollPending');

const account = { github: 'reporter', walletAddress: '0x1111111111111111111111111111111111111111' };
const issue = { number: 402, user: { login: 'reporter', type: 'User' }, labels: ['bug', 'bug-catcher-pending', 'bug-catcher: @spoof', 'bounty: 100 ART'] };
const args = { issue, accounts: { contributors: [account] }, queue: { pending: [], retained: [], settled: [] },
  repoSlug: 'TheJollyLaMa/DecentBusking', repositoryOwner: 'TheJollyLaMa', outcome: 'approved' };

test('owner review uses authenticated whitelisted author, preserves bounty and rejects ineligible attribution', () => {
  const result = reviewBugReport(args);
  assert.deepEqual(result.labels, ['bug', 'bounty: 100 ART', 'bug-catcher', 'bug-catcher: @reporter', 'bug-catcher-approved']);
  assert.match(result.body, /50%.*20%/);
  assert.throws(() => reviewBugReport({ ...args, accounts: { contributors: [] } }), /onboarding/);
  assert.throws(() => reviewBugReport({ ...args, issue: { ...issue, pull_request: {} } }), /not a pull request/);
  assert.throws(() => reviewBugReport({ ...args, repositoryOwner: 'reporter' }), /Maintainer-discovered/);
  for (const section of ['pending', 'settled', 'retained']) {
    assert.throws(() => reviewBugReport({ ...args, queue: { [section]: [{ issueRef: 'TheJollyLaMa/DecentBusking#402' }] } }), /already exists/);
  }
  assert.throws(() => reviewBugReport({ ...args, accounts: { contributors: [{ ...account, walletAddress: 'invalid' }] } }), /registered Base/);
  assert.throws(() => reviewBugReport({ ...args, issue: { ...issue, user: { login: 'reporter', type: 'Bot' } } }), /retain-in-fund/);
  assert.ok(reviewBugReport({ ...args, issue: { ...issue, user: { login: 'reporter', type: 'Bot' } },
    accounts: { contributors: [{ github: 'reporter', payoutMode: 'retain-in-fund' }] } }).labels.includes('bug-catcher-approved'));
});

test('review exclusions remove candidate and approval labels, and duplicates require a different original', () => {
  assert.throws(() => reviewBugReport({ ...args, outcome: 'duplicate', duplicateOf: 402 }), /different/);
  assert.throws(() => reviewBugReport({ ...args, outcome: 'duplicate' }), /different/);
  for (const outcome of ['duplicate', 'rejected', 'spam', 'self-reported', 'maintainer-discovered']) {
    const result = reviewBugReport({ ...args, outcome, duplicateOf: 176 });
    assert.deepEqual(result.labels, ['bug', 'bounty: 100 ART', `bug-catcher-${outcome}`]);
    assert.match(result.body, /No bug-catcher/);
    assert.ok(!result.labels.includes('bug-catcher-approved'));
  }
});

const pending = [
  { issueRef: 'TheJollyLaMa/DecentBusking#402', contributorGithub: 'reporter', role: 'bug-catcher', currency: 'ART', amount: '50' },
  { issueRef: 'TheJollyLaMa/DecentBusking#402', contributorGithub: 'implementer', currency: 'USDC', amount: '0.1' },
  { issueRef: 'TheJollyLaMa/DecentBusking#403', contributorGithub: 'reporter', currency: 'USDC', amount: '0.2' },
];
const status = { verified: true, pending, completed: [], blockNumber: 123 };
test('backlog notifications total exact supported payable tokens and avoid duplicate issues and unchanged pings', async () => {
  const alert = buildPayrollAlert(status, args.repoSlug, args.repositoryOwner);
  assert.equal(alert.count, 3);
  assert.match(alert.body, /0\.3 USDC/);
  assert.ok(!alert.body.includes('50 ETH'));
  const writes = [];
  const request = async (route, options) => {
    if (!options) return [];
    writes.push({ route, ...JSON.parse(options.body) });
  };
  await notifyPayrollPending({ status, owner: 'TheJollyLaMa', repo: 'DecentBusking', request });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].assignees, ['TheJollyLaMa']);
  const existing = { number: 999, body: alert.body, user: { login: 'github-actions[bot]' }, state: 'open' };
  const unchanged = await notifyPayrollPending({ status, owner: 'TheJollyLaMa', repo: 'DecentBusking',
    request: async () => [existing] });
  assert.equal(unchanged.changed, false);
  writes.length = 0;
  await notifyPayrollPending({ status: { ...status, pending: [], completed: pending }, owner: 'TheJollyLaMa', repo: 'DecentBusking',
    request: async (route, options) => {
      if (!options) return [existing];
      writes.push(JSON.parse(options.body));
    } });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].state, 'closed');
  assert.match(writes[0].body, /No unpaid Base/);
});

test('verification failures invalidate stale counts and unchanged work never pings on a new checked block', async () => {
  const alert = buildPayrollAlert(status, args.repoSlug, args.repositoryOwner);
  const existing = { number: 999, body: alert.body, user: { login: 'github-actions[bot]' }, state: 'open' };
  const writes = [];
  const request = async (route, options) => {
    if (!options) return [existing];
    writes.push({ route, ...JSON.parse(options.body) });
  };
  await notifyPayrollPending({ status: { ...status, blockNumber: 124 }, owner: 'TheJollyLaMa', repo: 'DecentBusking', request });
  assert.equal(writes.length, 1);
  assert.ok(!writes[0].route.endsWith('/comments'));
  writes.length = 0;
  await notifyPayrollPending({ status: { error: true }, owner: 'TheJollyLaMa', repo: 'DecentBusking', request });
  assert.equal(writes.length, 1);
  assert.match(writes[0].title, /unavailable/);
  assert.ok(!writes[0].body.includes('0 unpaid'));
  assert.equal(writes[0].state, 'open');
  assert.throws(() => buildPayrollAlert({ pending }, args.repoSlug, args.repositoryOwner), /Verified/);
});

test('verified zero never closes a reported bug or another author’s issue', async () => {
  const alert = buildPayrollAlert(status, args.repoSlug, args.repositoryOwner);
  let writes = 0;
  await notifyPayrollPending({ status: { ...status, pending: [] }, owner: 'TheJollyLaMa', repo: 'DecentBusking',
    request: async (route, options) => {
      if (options) { writes++; return; }
      return [
        { number: 402, body: 'A reported bug', user: { login: 'github-actions[bot]' }, state: 'open' },
        { number: 999, body: alert.body, user: { login: 'another-author' }, state: 'open' },
      ];
    } });
  assert.equal(writes, 0);
});
