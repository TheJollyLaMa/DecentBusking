const fs = require('node:fs');
const path = require('node:path');
const { githubRequest, repositoryCoordinates } = require('./githubApi');
const { findAccount, isRetainInFund, blockedPayoutReason } = require('./payroll');

const OUTCOMES = ['approved', 'duplicate', 'rejected', 'spam', 'self-reported', 'maintainer-discovered'];
const REVIEW_LABELS = [
  'bug-catcher-pending', 'bug-catcher', 'bug-catcher-approved',
  ...OUTCOMES.filter(value => value !== 'approved').map(value => `bug-catcher-${value}`),
];

function reviewBugReport({ issue, accounts, queue, outcome, duplicateOf, repositoryOwner, repoSlug }) {
  if (!OUTCOMES.includes(outcome)) throw new Error('Choose a supported review outcome');
  if (issue.pull_request || !Number.isInteger(issue.number)) throw new Error('Review requires an issue, not a pull request');
  const author = issue.user?.login;
  if (!/^[-\w]+(?:\[bot\])?$/.test(author || '')) throw new Error('Issue reporter identity is unavailable');
  if (outcome === 'duplicate' && (!Number.isInteger(duplicateOf) || duplicateOf <= 0 || duplicateOf === issue.number)) {
    throw new Error('A duplicate report requires a different, valid original issue number');
  }
  const prior = [...(queue.pending || []), ...(queue.settled || []), ...(queue.retained || [])]
    .filter(entry => entry.issueRef === `${repoSlug}#${issue.number}`);
  if (prior.length) throw new Error('Payroll already exists for this issue. Review it manually; attribution and splits cannot be changed after allocation.');
  if (outcome === 'approved') {
    if (author.toLowerCase() === repositoryOwner.toLowerCase()) {
      throw new Error('Maintainer-discovered reports do not qualify for bug-catcher rewards');
    }
    const account = findAccount(accounts, author);
    if (!account) throw new Error('Reporter must complete contributor onboarding before approval');
    if ((issue.user.type === 'Bot' || /bot\]$|^(?:copilot|dbusker)$/i.test(author)) && !isRetainInFund(account)) {
      throw new Error('AI/bot bug-catcher rewards must retain-in-fund; no human payout policy is approved');
    }
    if (!isRetainInFund(account) &&
        (!/^0x[0-9a-f]{40}$/i.test(account.walletAddress || '') || blockedPayoutReason(account.walletAddress))) {
      throw new Error('Reporter requires a valid, maintainer-verified registered Base payout wallet');
    }
  }
  const preserved = (issue.labels || []).map(label => typeof label === 'string' ? label : label.name)
    .filter(label => !REVIEW_LABELS.includes(label.toLowerCase()) && !/^bug-catcher:/i.test(label));
  const labels = outcome === 'approved'
    ? [...preserved, 'bug-catcher', `bug-catcher: @${author}`, 'bug-catcher-approved']
    : [...preserved, `bug-catcher-${outcome}`];
  return { labels, body: [
    `Bug report review by @${repositoryOwner}: **${outcome}**.`,
    `Reporter: @${author} (authenticated GitHub issue author).`,
    ...(outcome === 'duplicate' ? [`Original issue: #${duplicateOf}. No bug-catcher payout.`] : []),
    outcome === 'approved'
      ? 'First unique report and attribution verified by the maintainer. Bug catcher: 50% of the approved bounty; existing idea credit: 20% if present; remaining share to implementer. A qualifying merged fix is required; owner settlement remains manual.'
      : 'No bug-catcher credit or payout is approved. This review does not close the issue.',
    '<!-- bug-catcher-review -->',
  ].join('\n\n') };
}

async function main() {
  const { owner, repo } = repositoryCoordinates();
  if (process.env.GITHUB_ACTOR?.toLowerCase() !== owner.toLowerCase()) throw new Error('Only the repository owner may approve bug-catcher attribution');
  const number = Number(process.env.INPUT_ISSUE_NUMBER);
  if (!Number.isInteger(number) || number <= 0) throw new Error('Invalid issue number');
  const route = `/repos/${owner}/${repo}/issues/${number}`;
  const issue = await githubRequest(route);
  const duplicateOf = Number(process.env.INPUT_DUPLICATE_OF);
  if (process.env.INPUT_OUTCOME === 'duplicate') {
    const original = await githubRequest(`/repos/${owner}/${repo}/issues/${duplicateOf}`);
    if (original.pull_request) throw new Error('The original duplicate target must be an issue');
  }
  const root = path.join(__dirname, '..');
  const accounts = JSON.parse(fs.readFileSync(path.join(root, 'contributor-accounts.json'), 'utf8'));
  const queue = JSON.parse(fs.readFileSync(path.join(root, 'payroll-queue.json'), 'utf8'));
  const review = reviewBugReport({ issue, accounts, queue, outcome: process.env.INPUT_OUTCOME,
    duplicateOf, repositoryOwner: owner, repoSlug: `${owner}/${repo}` });
  for (const name of review.labels.filter(label => /^bug-catcher/.test(label))) {
    try {
      await githubRequest(`/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`);
    } catch (error) {
      if (error.status !== 404) throw error;
      await githubRequest(`/repos/${owner}/${repo}/labels`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color: name === 'bug-catcher-approved' ? '0e8a16' : 'd93f0b' }) });
    }
  }
  await githubRequest(`${route}/labels`, { method: 'PUT',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ labels: review.labels }) });
  await githubRequest(`${route}/comments`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: review.body }) });
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { reviewBugReport, OUTCOMES };
