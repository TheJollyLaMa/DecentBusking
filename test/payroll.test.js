const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BOUNTY_LABEL_RE,
  TEST_BOUNTY_LABEL_RE,
  applyAccountAccrual,
  createBountyEntries,
  extractIssueNumbers,
  isDuplicate,
  normalizeCurrency,
  normalizeAmount,
  parseAmountLabel,
  parseAmountLabels,
  pickWhitelistedTester,
  settleEntries,
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