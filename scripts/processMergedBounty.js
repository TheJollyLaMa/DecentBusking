const fs = require('fs');
const path = require('path');

const { applyAccountAccrual, createBountyEntries, extractIssueNumbers } = require('./payroll');
const { renderArtFiComment } = require('./commentArt');
const { githubRequest, postIssueComment, repositoryCoordinates } = require('./githubApi');

const ROOT = path.resolve(__dirname, '..');
const QUEUE_PATH = path.join(ROOT, 'payroll-queue.json');
const ACCOUNTS_PATH = path.join(ROOT, 'contributor-accounts.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function buildMergedPayrollComment({ entries, isManual, prNumber, issueNumber }) {
  const lines = entries.map(entry =>
    `- **${entry.amount} ART** to @${entry.contributorGithub}${entry.role ? ` (${entry.role})` : ''}`
  );
  return renderArtFiComment([
    `✅ Payroll queued from ${isManual ? 'manual recovery for' : 'merged'} PR #${prNumber}:`,
    '',
    ...lines,
    '',
    'The entries are ledger-only until an administrator completes ART settlement.',
  ].join('\n'), issueNumber, 'merged-payroll');
}

async function linkedIssueNumbers(owner, repo, prNumber) {
  const data = await githubRequest('/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query($owner: String!, $repo: String!, $pr: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            closingIssuesReferences(first: 50) { nodes { number } }
          }
        }
      }`,
      variables: { owner, repo, pr: prNumber },
    }),
  });
  if (data.errors) throw new Error(`GitHub GraphQL failed: ${JSON.stringify(data.errors)}`);
  return data.data.repository.pullRequest.closingIssuesReferences.nodes.map(node => node.number);
}

async function main() {
  const { owner, repo } = repositoryCoordinates();
  const event = readJson(process.env.GITHUB_EVENT_PATH);
  const manualPrNumber = Number(process.env.INPUT_PR_NUMBER || 0);
  const manualIssueNumbers = String(process.env.INPUT_ISSUE_NUMBER || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const isManual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  const pr = event.pull_request || (manualPrNumber
    ? await githubRequest(`/repos/${owner}/${repo}/pulls/${manualPrNumber}`)
    : null);

  if (!pr) throw new Error('A pull request payload or pr_number input is required');
  if (!isManual && !pr.merged) {
    console.log(`PR #${pr.number} was closed without merge; no payout was queued.`);
    return;
  }

  let linked = [];
  try {
    linked = await linkedIssueNumbers(owner, repo, pr.number);
  } catch (error) {
    console.warn(`Could not load GitHub-linked closing issues: ${error.message}`);
  }
  const issueNumbers = extractIssueNumbers({
    body: pr.body || '',
    title: pr.title || '',
    linked,
    override: manualIssueNumbers,
  });
  if (issueNumbers.length === 0) {
    console.log(`PR #${pr.number} has no issue references in its body, title, or GitHub closing links.`);
    return;
  }

  const queue = readJson(QUEUE_PATH);
  const accounts = readJson(ACCOUNTS_PATH);
  if (!Array.isArray(queue.pending)) queue.pending = [];
  if (!Array.isArray(queue.settled)) queue.settled = [];
  if (!Array.isArray(accounts.contributors)) accounts.contributors = [];

  const planned = [];
  const results = [];
  for (const issueNumber of issueNumbers) {
    const issue = await githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}`);
    if (issue.pull_request) continue;
    const result = createBountyEntries({
      issue,
      pr,
      accounts,
      queue: { pending: [...queue.pending, ...planned], settled: queue.settled },
      repoSlug: `${owner}/${repo}`,
      queuedAt: new Date().toISOString(),
      queuedBy: process.env.GITHUB_ACTOR || 'github-actions[bot]',
    });
    if (result.reason === 'missing-bounty-label') {
      console.log(`Skipping issue #${issueNumber}: no label matching "bounty: <amount> ART".`);
      continue;
    }
    if (isManual) result.entries.forEach(entry => { entry.retroactive = true; });
    planned.push(...result.entries);
    results.push({ issueNumber, result });
  }

  if (planned.length === 0) {
    console.log('No new payroll entries were needed.');
    return;
  }
  queue.pending.push(...planned);
  applyAccountAccrual(accounts, planned);
  writeJson(QUEUE_PATH, queue);
  writeJson(ACCOUNTS_PATH, accounts);

  for (const { issueNumber, result } of results) {
    if (result.entries.length === 0) continue;
    await postIssueComment(owner, repo, issueNumber, buildMergedPayrollComment({
      entries: result.entries,
      isManual,
      prNumber: pr.number,
      issueNumber,
    }));
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Payroll queue updated\n\nQueued ${planned.length} ART payout entries from PR #${pr.number}.\n`);
  }
  console.log(`Queued ${planned.length} ART payout entries from PR #${pr.number}.`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildMergedPayrollComment };