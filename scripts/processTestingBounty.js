const fs = require('fs');
const path = require('path');

const { renderArtFiComment } = require('./commentArt');
const { githubRequest, postIssueComment, repositoryCoordinates } = require('./githubApi');
const {
  TEST_BOUNTY_LABEL_RE,
  applyAccountAccrual,
  isDuplicate,
  normalizeLogin,
  parseAmountLabel,
  pickWhitelistedTester,
} = require('./payroll');

const ROOT = path.resolve(__dirname, '..');
const QUEUE_PATH = path.join(ROOT, 'payroll-queue.json');
const ACCOUNTS_PATH = path.join(ROOT, 'contributor-accounts.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function buildTestingComment(message, issueNumber, commentType) {
  return renderArtFiComment(message, issueNumber, commentType);
}

function approvedTesterFromCommand(command) {
  const match = String(command).match(/^\/test-approved(?:\s+@?([-\w]+))?\s*$/i);
  return match && match[1] ? normalizeLogin(match[1]) : '';
}

function latestCompletedTester(comments, assigneeLogins) {
  const assigned = new Set(assigneeLogins.map(login => normalizeLogin(login).toLowerCase()));
  return [...comments].reverse().map(comment => ({
    body: String(comment.body || '').trim(),
    login: normalizeLogin(comment.user && comment.user.login),
  })).find(comment =>
    /^\/test-complete(?:\s|$)/i.test(comment.body) && assigned.has(comment.login.toLowerCase())
  )?.login || '';
}

async function main() {
  const { owner, repo } = repositoryCoordinates();
  const event = readJson(process.env.GITHUB_EVENT_PATH);
  const command = String(event.comment && event.comment.body || '').trim();
  const commenter = normalizeLogin(event.comment && event.comment.user && event.comment.user.login);
  const issueNumber = Number(event.issue && event.issue.number);
  const issue = await githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}`);
  const bounty = parseAmountLabel(issue, TEST_BOUNTY_LABEL_RE);
  if (!bounty) {
    console.log(`Issue #${issueNumber} has no label matching "test-bounty: <amount> ART".`);
    return;
  }

  const assigneeLogins = (issue.assignees || []).map(assignee => normalizeLogin(assignee.login));
  if (/^\/test-complete(?:\s|$)/i.test(command)) {
    if (!assigneeLogins.some(login => login.toLowerCase() === commenter.toLowerCase())) {
      await postIssueComment(owner, repo, issueNumber, buildTestingComment(
        '⚠️ Only assigned testers can use `/test-complete`.', issueNumber, 'test-rejected'
      ));
      return;
    }
    await postIssueComment(owner, repo, issueNumber, buildTestingComment(
      `✅ Thanks @${commenter} - your testing work has been noted. Awaiting \`/test-approved\` from the maintainer.`,
      issueNumber,
      'test-complete'
    ));
    return;
  }

  if (!/^\/test-approved(?:\s|$)/i.test(command)) return;
  if (commenter.toLowerCase() !== owner.toLowerCase()) {
    await postIssueComment(owner, repo, issueNumber, buildTestingComment(
      '⚠️ Only the repository owner can approve testing payouts.', issueNumber, 'test-rejected'
    ));
    return;
  }

  const queue = readJson(QUEUE_PATH);
  const accounts = readJson(ACCOUNTS_PATH);
  const comments = await githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`);
  const completedTester = approvedTesterFromCommand(command) || latestCompletedTester(comments, assigneeLogins);
  const tester = pickWhitelistedTester({ assigneeLogins, accounts, commenter: completedTester });
  const entry = {
    issueRef: `${owner}/${repo}#${issueNumber}`,
    contributor: tester.walletAddress,
    contributorGithub: tester.github,
    amount: bounty.amount,
    currency: 'ART',
    role: 'tester',
    queuedAt: new Date().toISOString(),
    queuedBy: process.env.GITHUB_ACTOR || commenter,
  };
  if (isDuplicate(queue, entry)) {
    console.log(`Testing payout already exists for ${entry.issueRef} / @${entry.contributorGithub}.`);
    return;
  }

  queue.pending.push(entry);
  applyAccountAccrual(accounts, [entry]);
  writeJson(QUEUE_PATH, queue);
  writeJson(ACCOUNTS_PATH, accounts);
  await postIssueComment(owner, repo, issueNumber, buildTestingComment(
    `✅ Queued ${entry.amount} ART testing bounty for @${entry.contributorGithub}, pending administrator settlement.`,
    issueNumber,
    'test-approved'
  ));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { approvedTesterFromCommand, buildTestingComment, latestCompletedTester };