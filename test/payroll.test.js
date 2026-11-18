const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BOUNTY_LABEL_RE,
  TEST_BOUNTY_LABEL_RE,
  applyAccountAccrual,
  applyRetainedAccrual,
  blockedPayoutReason,
  createBountyEntries,
  extractIssueNumbers,
  isDuplicate,
  normalizeCurrency,
  normalizeAmount,
  parseAmountLabel,
  parseAmountLabels,
  parseBugCatcherCredit,
  pickWhitelistedTester,
  settleEntries,
  splitBugCatcherCredit,
  splitIdeaCredit,
} = require('../scripts/payroll');

const owner = {
  github: 'TheJollyLaMa',
  walletAddress: '0x807061DF657A7697c04045dA7d16D941861cAABc',
};

function fixture(overrides = {}) {
  return {
    issue: {
      number: 14,
      labels: [{ name: 'bounty: 100 ART' }],
      assignees: [{ login: owner.github }],
      ...overrides.issue,
    },
    pr: { number: 15, user: { login: 'copilot-swe-agent[bot]' }, ...overrides.pr },
    accounts: { contributors: [{ ...owner }], ...overrides.accounts },
    queue: { pending: [], settled: [], ...overrides.queue },
    repoSlug: 'TheJollyLaMa/DecentBusking',
    queuedAt: '2026-09-16T00:00:00.000Z',
    queuedBy: 'github-actions[bot]',
  };
}

test('accepts configured token labels and rejects unconfigured currencies or trailing text', () => {
  assert.equal(parseAmountLabel({ labels: ['bounty: 100 ART'] }).amount, '100');
  assert.equal(parseAmountLabel({ labels: ['bounty: 2.50 $ART'] }).amount, '2.5');
  assert.deepEqual(
    [
      parseAmountLabel({ labels: ['test-bounty: 10 ART'] }, TEST_BOUNTY_LABEL_RE).amount,
      parseAmountLabel({ labels: ['test-bounty: 0.5 USDC'] }, TEST_BOUNTY_LABEL_RE).currency,
    ],
    ['10', 'USDC']
  );
  assert.match('bounty: 1 ART', BOUNTY_LABEL_RE);
  assert.equal(parseAmountLabel({ labels: ['bounty: 1 ETH'] }), null);
  assert.equal(parseAmountLabel({ labels: ['bounty: 1 DJUKE'] }), null);
  assert.equal(parseAmountLabel({ labels: ['bounty: 1 ART bonus'] }), null);
});

test('a configured future ERC-20 symbol works from its bounty label', () => {
  const futureAssets = { DJUKE: { decimals: 18, ledgerDecimals: 4 } };
  const issue = {
    number: 42,
    labels: ['bounty: 12.3456 DJUKE'],
    assignees: [{ login: owner.github }],
  };
  assert.deepEqual(parseAmountLabels(issue, BOUNTY_LABEL_RE, futureAssets), [
    { label: 'bounty: 12.3456 DJUKE', amount: '12.3456', currency: 'DJUKE' },
  ]);
  assert.throws(
    () => parseAmountLabels({ ...issue, labels: ['bounty: 1.23456 DJUKE'] }, BOUNTY_LABEL_RE, futureAssets),
    /DJUKE payouts support at most 4 decimal places/
  );

  const result = createBountyEntries({
    ...fixture({ issue }),
    assetRegistry: futureAssets,
  });
  assert.equal(result.entries[0].currency, 'DJUKE');
  assert.equal(result.entries[0].fund, 'dbusk-repo-dev');
});

test('USDC labels and account balances use six-decimal precision', () => {
  const bounty = parseAmountLabel({ labels: ['bounty: 12.345678 USDC'] });
  assert.deepEqual([bounty.amount, bounty.currency], ['12.345678', 'USDC']);
  assert.throws(() => normalizeAmount('1.0000001', 'USDC'), /at most 6 decimal places/);

  const accounts = { contributors: [{ ...owner }] };
  const entry = {
    issueRef: 'TheJollyLaMa/DecentBusking#43',
    contributorGithub: owner.github,
    contributor: owner.walletAddress,
    amount: '12.345678',
    currency: 'USDC',
    fund: 'dbusk-repo-dev',
    role: 'contributor',
  };
  applyAccountAccrual(accounts, [entry]);
  assert.equal(accounts.contributors[0].usdcPending, 12.345678);

  const queue = { pending: [entry], settled: [] };
  settleEntries({ queue, accounts, currency: 'USDC', settledAt: 'now', settledBy: owner.github });
  assert.equal(accounts.contributors[0].usdcPending, 0);
  assert.equal(accounts.contributors[0].usdcEarned, 12.345678);
});

test('combines manual, body, title, and linked issue references', () => {
  assert.deepEqual(extractIssueNumbers({
    body: 'Closes #14 and resolves TheJollyLaMa/DecentBusking#18',
    title: 'Finish #14 and #22',
    linked: [18, 30],
    override: ['31'],
  }), [31, 14, 18, 22, 30]);
});

test('creates only ART entries and falls back from bot author to whitelisted assignee', () => {
  const result = createBountyEntries(fixture());
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].currency, 'ART');
  assert.equal(result.entries[0].fund, 'dbusk-repo-dev');
  assert.equal(result.entries[0].contributorGithub, owner.github);
});

test('splits idea credit exactly 80/20 at eight decimal places', () => {
  assert.deepEqual(splitIdeaCredit('100'), { implementer: '80', originator: '20' });
  assert.deepEqual(splitIdeaCredit('0.00000005'), {
    implementer: '0.00000004',
    originator: '0.00000001',
  });
  assert.throws(() => splitIdeaCredit('0.00000001'), /cannot be split exactly at 8 decimal places/);
  assert.throws(() => splitIdeaCredit('0.000000009'), /at most 8 decimal places/);

  const result = createBountyEntries(fixture({
    issue: {
      number: 14,
      labels: ['bounty: 100 ART', `idea-credit: @${owner.github}`],
      assignees: [{ login: owner.github }],
    },
  }));
  assert.deepEqual(result.entries.map(entry => [entry.role, entry.amount]), [
    ['implementer', '80'],
    ['idea-originator', '20'],
  ]);
});

test('bug-catcher credit requires maintainer approval and preserves the 20% idea policy', () => {
  const reporter = {
    github: 'withinthevacuum',
    walletAddress: '0x405Bb3Cdf23833bb27BAD6629b7cd4f01688235f',
  };
  const ideaOriginator = {
    github: 'idea-originator',
    walletAddress: '0x2222222222222222222222222222222222222222',
  };
  const pendingIssue = {
    number: 402,
    user: { login: reporter.github },
    labels: ['bounty: 100 ART', 'bug-catcher-pending', 'bug-catcher: @withinthevacuum'],
    assignees: [{ login: owner.github }],
  };
  assert.equal(parseBugCatcherCredit(pendingIssue), null);
  const pending = createBountyEntries(fixture({
    issue: pendingIssue,
    accounts: { contributors: [{ ...owner }, reporter, ideaOriginator] },
  }));
  assert.deepEqual(pending.entries, []);
  assert.equal(pending.reason, 'bug-report-pending-review');

  assert.deepEqual(splitBugCatcherCredit('100', 'ART'), {
    implementer: '50',
    bugCatcher: '50',
  });
  assert.deepEqual(splitBugCatcherCredit('100', 'ART', { hasIdea: true }), {
    implementer: '30',
    bugCatcher: '50',
    originator: '20',
  });
  assert.throws(() => splitBugCatcherCredit('0.00000001'), /cannot be split exactly/);
  assert.throws(() => splitBugCatcherCredit('0.00000005', 'ART', { hasIdea: true }), /cannot be split exactly/);

  const approvedIssue = {
    ...pendingIssue,
    labels: [
      ...pendingIssue.labels.filter(label => label !== 'bug-catcher-pending'),
      'bug-catcher',
      'bug-catcher-approved',
      'idea-credit: @idea-originator',
    ],
  };
  const approved = createBountyEntries(fixture({
    issue: approvedIssue,
    accounts: { contributors: [{ ...owner }, reporter, ideaOriginator] },
  }));
  assert.deepEqual(approved.entries.map(entry => [entry.role, entry.amount]), [
    ['implementer', '30'],
    ['bug-catcher', '50'],
    ['idea-originator', '20'],
  ]);
  const reporterAccount = { contributors: [{ ...owner }, reporter, ideaOriginator] };
  applyAccountAccrual(reporterAccount, approved.entries.filter(entry => entry.role === 'bug-catcher'));
  assert.deepEqual(reporterAccount.contributors.find(account => account.github === reporter.github).bugsCaught, [
    'TheJollyLaMa/DecentBusking#402',
  ]);
  assert.throws(() => parseBugCatcherCredit({
    ...approvedIssue,
    labels: [...approvedIssue.labels, 'bug-catcher: @another-contributor'],
  }), /exactly one/);

  const repeated = createBountyEntries(fixture({
    issue: {
      ...approvedIssue,
      user: { login: 'another-contributor' },
      labels: approvedIssue.labels.map(label =>
        label === 'bug-catcher: @withinthevacuum' ? 'bug-catcher: @another-contributor' : label
      ),
    },
    accounts: {
      contributors: [{ ...owner }, reporter, ideaOriginator, {
        github: 'another-contributor',
        walletAddress: '0x3333333333333333333333333333333333333333',
      }],
    },
    queue: { pending: approved.entries, settled: [], retained: [] },
  }));
  assert.equal(repeated.entries.length, 0);
  assert.equal(repeated.skippedDuplicates, 3);

  const retainedReporter = { github: 'copilot', payoutMode: 'retain-in-fund' };
  const retainedResult = createBountyEntries(fixture({
    issue: {
      ...approvedIssue,
      number: 403,
      user: { login: 'copilot', type: 'Bot' },
      labels: approvedIssue.labels
        .filter(label => !label.startsWith('idea-credit:'))
        .map(label => label === 'bug-catcher: @withinthevacuum' ? 'bug-catcher: @copilot' : label),
    },
    pr: { number: 15, user: { login: 'other-bot' } },
    accounts: { contributors: [{ ...owner }, retainedReporter] },
  }));
  assert.deepEqual(retainedResult.entries.map(entry => [entry.role, entry.amount]), [['implementer', '50']]);
  assert.deepEqual(retainedResult.retained.map(entry => [entry.role, entry.amount]), [['bug-catcher', '50']]);
  const retainedAccounts = { contributors: [{ ...retainedReporter }] };
  applyRetainedAccrual(retainedAccounts, retainedResult.retained);
  assert.deepEqual(retainedAccounts.contributors[0].bugsCaught, ['TheJollyLaMa/DecentBusking#403']);
});

test('currency-aware dedup allows ART beside a historical currency-less ETH entry', () => {
  const legacy = {
    issueRef: 'TheJollyLaMa/DecentBusking#14',
    contributorGithub: owner.github,
    contributor: owner.walletAddress,
    amount: '0.00001',
  };
  const art = { ...legacy, amount: '10', currency: 'ART' };
  const queue = { pending: [legacy], settled: [] };

  assert.equal(normalizeCurrency(legacy), 'ETH');
  assert.equal(isDuplicate(queue, art), false);
  assert.equal(isDuplicate(queue, { ...legacy, currency: 'ETH' }), true);
});

test('bug review holds unlabelled structured reports and refuses conflicting, self or spoofed credit', () => {
  const reporter = { github: 'reporter', walletAddress: '0x1111111111111111111111111111111111111111' };
  const base = fixture({ issue: { user: { login: reporter.github } }, accounts: { contributors: [{ ...owner }, reporter] } });
  const labels = ['bounty: 100 ART', 'bug-catcher', 'bug-catcher: @reporter', 'bug-catcher-approved'];
  assert.equal(createBountyEntries({ ...base, issue: { ...base.issue, body: '## Bug report\n\nDetails' } }).reason, 'bug-report-pending-review');
  assert.equal(createBountyEntries({ ...base, issue: { ...base.issue, labels: ['bug', 'bounty: 100 ART'] } }).reason, 'bug-report-pending-review');
  for (const excluded of ['duplicate', 'rejected', 'spam', 'self-reported', 'maintainer-discovered']) {
    assert.throws(() => parseBugCatcherCredit({ labels: [...labels, `bug-catcher-${excluded}`] }), /Excluded/);
  }
  for (const excluded of ['duplicate', 'rejected', 'spam']) {
    assert.equal(createBountyEntries({ ...base, issue: { ...base.issue, labels: ['bounty: 100 ART', `bug-catcher-${excluded}`] } }).reason, 'bug-report-ineligible');
  }
  assert.throws(() => createBountyEntries({ ...base, issue: { ...base.issue, labels }, pr: { ...base.pr, user: { login: 'reporter' } } }), /Self-reported/);
  assert.throws(() => createBountyEntries({ ...base, issue: { ...base.issue, labels, user: { login: 'other' } } }), /authenticated issue author/);
  assert.throws(() => createBountyEntries({ ...base, issue: { ...base.issue, labels, user: undefined } }), /authenticated issue author/);
  assert.throws(() => createBountyEntries({
    ...base, pr: { ...base.pr, user: { login: reporter.github } },
    issue: { ...base.issue, user: { login: owner.github }, labels: labels.map(label => label.replace('@reporter', `@${owner.github}`)) },
  }), /Maintainer-discovered/);
  assert.throws(() => createBountyEntries({ ...base, issue: { ...base.issue, labels, user: { login: 'reporter', type: 'Bot' } } }), /retain-in-fund/);
});

test('bug bounty allocation is frozen across all ledger sections and does not collide with separate testing credit', () => {
  const reporter = { github: 'reporter', walletAddress: '0x1111111111111111111111111111111111111111' };
  const base = fixture({
    accounts: { contributors: [{ ...owner }, reporter] },
    issue: { user: { login: reporter.github }, labels: ['bounty: 100 ART', 'bug-catcher', 'bug-catcher: @reporter', 'bug-catcher-approved'] },
  });
  const result = createBountyEntries(base);
  assert.deepEqual(result.entries.map(entry => entry.amount), ['50', '50']);
  for (const section of ['pending', 'settled', 'retained']) {
    assert.deepEqual(createBountyEntries({ ...base, queue: { [section]: result.entries } }).entries, []);
    assert.throws(() => createBountyEntries({ ...base, queue: { [section]: [{ ...result.entries[0], amount: '100' }] } }), /already allocated/);
  }
  const tester = { ...result.entries[1], role: 'tester', amount: '10' };
  assert.equal(isDuplicate({ pending: [tester] }, result.entries[1]), false);
  assert.equal(isDuplicate({ settled: [result.entries[1]] }, tester), false);
});

test('tester selection honors a completed tester and rejects ambiguity', () => {
  const accounts = { contributors: [
    { github: 'alice', walletAddress: '0x1111111111111111111111111111111111111111' },
    { github: 'bob', walletAddress: '0x2222222222222222222222222222222222222222' },
  ] };
  assert.equal(pickWhitelistedTester({ assigneeLogins: ['alice', 'bob'], accounts, commenter: 'bob' }).github, 'bob');
  assert.throws(
    () => pickWhitelistedTester({ assigneeLogins: ['alice', 'bob'], accounts }),
    /Multiple assigned testers/
  );
});

test('ART accrual lazily adds ART fields without changing ETH totals', () => {
  const accounts = { contributors: [{ ...owner, ethPending: 7, ethEarned: 3 }] };
  applyAccountAccrual(accounts, [{
    issueRef: 'TheJollyLaMa/DecentBusking#14',
    contributorGithub: owner.github,
    amount: '20',
    currency: 'ART',
    role: 'idea-originator',
  }]);
  assert.equal(accounts.contributors[0].artPending, 20);
  assert.equal(accounts.contributors[0].ethPending, 7);
  assert.equal(accounts.contributors[0].ethEarned, 3);
});

test('currency-filtered settlement updates only matching account fields', () => {
  const legacyEth = {
    issueRef: 'TheJollyLaMa/DecentBusking#14',
    contributorGithub: owner.github,
    contributor: owner.walletAddress,
    amount: '2',
  };
  const art = { ...legacyEth, amount: '10', currency: 'ART' };
  const queue = { pending: [legacyEth, art], settled: [] };
  const accounts = { contributors: [{ ...owner, ethPending: 2, ethEarned: 4, artPending: 10, artEarned: 1 }] };

  const settled = settleEntries({
    queue,
    accounts,
    currency: 'ART',
    settledAt: '2026-09-16T01:00:00.000Z',
    settledBy: owner.github,
  });

  assert.equal(settled.length, 1);
  assert.equal(queue.pending.length, 1);
  assert.equal(normalizeCurrency(queue.pending[0]), 'ETH');
  assert.deepEqual(
    [accounts.contributors[0].ethPending, accounts.contributors[0].ethEarned],
    [2, 4]
  );
  assert.deepEqual(
    [accounts.contributors[0].artPending, accounts.contributors[0].artEarned],
    [0, 11]
  );
});

test('role-filtered settlement touches only the selected work credit', () => {
  const implementer = {
    issueRef: 'TheJollyLaMa/DecentBusking#44',
    contributorGithub: owner.github,
    contributor: owner.walletAddress,
    amount: '80',
    currency: 'ART',
    role: 'implementer',
  };
  const originator = { ...implementer, amount: '20', role: 'idea-originator' };
  const queue = { pending: [implementer, originator], settled: [] };
  const accounts = { contributors: [{ ...owner, artPending: 100, artEarned: 0 }] };

  const settled = settleEntries({
    queue,
    accounts,
    contributorGithub: owner.github,
    issueRef: implementer.issueRef,
    role: 'implementer',
    currency: 'ART',
    txHash: `0x${'a'.repeat(64)}`,
    settledAt: 'now',
    settledBy: owner.github,
  });

  assert.equal(settled.length, 1);
  assert.equal(queue.pending[0].role, 'idea-originator');
  assert.equal(accounts.contributors[0].artPending, 20);
  assert.equal(accounts.contributors[0].artEarned, 80);
});
const copilot = { github: 'copilot', payoutMode: 'retain-in-fund' };

test('retain-in-fund contributors get credit but no payable entry', () => {
  const result = createBountyEntries(fixture({
    issue: { number: 50, labels: ['bounty: 1 USDC'], assignees: [{ login: 'copilot' }] },
    accounts: { contributors: [{ ...owner }, { ...copilot }] },
  }));
  assert.equal(result.entries.length, 0);
  assert.equal(result.retained.length, 1);
  assert.equal(result.retained[0].contributorGithub, 'copilot');
  assert.equal(result.retained[0].retainedInFund, true);
  assert.equal(result.retained[0].contributor, undefined);

  const accounts = { contributors: [{ ...copilot }] };
  applyRetainedAccrual(accounts, result.retained);
  assert.equal(accounts.contributors[0].usdcRetainedInFund, 1);
  assert.equal(accounts.contributors[0].usdcPending, undefined);
  assert.deepEqual(accounts.contributors[0].issuesClosed, ['TheJollyLaMa/DecentBusking#50']);

  const again = createBountyEntries(fixture({
    issue: { number: 50, labels: ['bounty: 1 USDC'], assignees: [{ login: 'copilot' }] },
    accounts: { contributors: [{ ...owner }, { ...copilot }] },
    queue: { pending: [], settled: [], retained: result.retained },
  }));
  assert.equal(again.retained.length, 0);
});

test('idea credit pays the human originator while the retained implementer share stays in the fund', () => {
  const result = createBountyEntries(fixture({
    issue: { number: 51, labels: ['bounty: 1 USDC', `idea-credit: @${owner.github}`], assignees: [{ login: 'copilot' }] },
    accounts: { contributors: [{ ...owner }, { ...copilot }] },
  }));
  assert.deepEqual(result.entries.map(entry => [entry.contributorGithub, entry.amount]), [[owner.github, '0.2']]);
  assert.deepEqual(result.retained.map(entry => [entry.contributorGithub, entry.amount]), [['copilot', '0.8']]);
});

test('blocked payout addresses are refused when queueing', () => {
  const escrow = '0x23A457AD3C33d68E4fAd2FCa7c5d9a511E0C350e';
  assert.match(blockedPayoutReason(escrow.toLowerCase()), /Optimism/);
  assert.equal(blockedPayoutReason(owner.walletAddress), null);
  assert.throws(() => createBountyEntries(fixture({
    issue: { number: 52, labels: ['bounty: 1 USDC'], assignees: [{ login: 'legacy' }] },
    accounts: { contributors: [{ github: 'legacy', walletAddress: escrow }] },
  })), /Refusing to queue a payout for @legacy/);
});
