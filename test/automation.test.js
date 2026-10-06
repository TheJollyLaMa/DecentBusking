const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseIssueForm } = require('../scripts/sendContributorAlert');
const { canQueueMergedPullRequest } = require('../scripts/processMergedBounty');
const { approvedTesterFromCommand, latestCompletedTester } = require('../scripts/processTestingBounty');

test('parses contributor request forms without interview or biography fields', () => {
  const fields = parseIssueForm('### GitHub username\n\nalice\n\n### Wallet address\n\n0x123\n');
  assert.equal(fields['GitHub username'], 'alice');
  assert.equal(fields['Wallet address'], '0x123');
  assert.equal(fields.Interview, undefined);
  assert.equal(fields.Biography, undefined);
});

test('tester approval supports explicit tester and latest assigned completion', () => {
  assert.equal(approvedTesterFromCommand('/test-approved @alice'), 'alice');
  assert.equal(approvedTesterFromCommand('/test-approved'), '');
  assert.equal(latestCompletedTester([
    { body: '/test-complete', user: { login: 'alice' } },
    { body: '/test-complete notes', user: { login: 'bob' } },
  ], ['alice', 'bob']), 'bob');
});

test('manual bounty recovery only accepts pull requests that were merged', () => {
  assert.equal(canQueueMergedPullRequest({ merged: true }), true);
  assert.equal(canQueueMergedPullRequest({ merged: false }), false);
  assert.equal(canQueueMergedPullRequest({ state: 'open' }), false);
});

test('frontend routes configured tokens through the shared Base router', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'payroll.js'), 'utf8');
  assert.match(source, /_getAssetConfig/);
  assert.match(source, /_payTokenEntry/);
  assert.match(source, /Active payroll settlement is Base-only/);
  assert.doesNotMatch(source, /OPTIMISM_CHAIN_ID|_payEthEntry|sendTransaction/);
});