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
  parseAmountLabel,
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

test('accepts exact ART labels and rejects other currencies or trailing text', () => {
  assert.equal(parseAmountLabel({ labels: ['bounty: 100 ART'] }).amount, '100');
  assert.equal(parseAmountLabel({ labels: ['bounty: 2.50 $ART'] }).amount, '2.5');
  assert.equal(parseAmountLabel({ labels: ['test-bounty: 10 ART'] }, TEST_BOUNTY_LABEL_RE).amount, '10');
  assert.match('bounty: 1 ART', BOUNTY_LABEL_RE);
  assert.equal(parseAmountLabel({ labels: ['bounty: 1 ETH'] }), null);
  assert.equal(parseAmountLabel({ labels: ['bounty: 1 ART bonus'] }), null);
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
  assert.equal(result.entries[0].contributorGithub, owner.github);
});

test('splits idea credit exactly 80/20, including precision expansion', () => {
  assert.deepEqual(splitIdeaCredit('100'), { implementer: '80', originator: '20' });
  assert.deepEqual(splitIdeaCredit('0.00000001'), {
    implementer: '0.000000008',
    originator: '0.000000002',
  });

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