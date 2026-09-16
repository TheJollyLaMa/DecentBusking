const fs = require('fs');
const path = require('path');

const { renderArtFiComment } = require('./commentArt');
const { postIssueComment, repositoryCoordinates } = require('./githubApi');
const { settleEntries } = require('./payroll');

const ROOT = path.resolve(__dirname, '..');
const QUEUE_PATH = path.join(ROOT, 'payroll-queue.json');
const ACCOUNTS_PATH = path.join(ROOT, 'contributor-accounts.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function buildSettlementComment({ settledCount, actor, txHash, issueNumber, currency }) {
  const body = [
    `✅ Settled ${settledCount} ${currency || ''} payroll entr${settledCount === 1 ? 'y' : 'ies'} by @${actor}.`.replace('  ', ' '),
    txHash ? `🔗 Tx: ${txHash}` : '',
  ].filter(Boolean).join('\n');
  return renderArtFiComment(body, issueNumber, 'settlement');
}

async function main() {
  const { owner, repo } = repositoryCoordinates();
  const contributorGithub = String(process.env.INPUT_CONTRIBUTOR_GITHUB || '').trim();
  const issueRef = String(process.env.INPUT_ISSUE_REF || '').trim();
  const currency = String(process.env.INPUT_CURRENCY || '').trim().toUpperCase();
  const txHash = String(process.env.INPUT_TX_HASH || '').trim();
  if (currency && !['ART', 'ETH'].includes(currency)) throw new Error('currency must be ART, ETH, or blank');

  const queue = readJson(QUEUE_PATH);
  const accounts = readJson(ACCOUNTS_PATH);
  const settled = settleEntries({
    queue,
    accounts,
    contributorGithub,
    issueRef,
    currency,
    txHash,
    settledAt: new Date().toISOString(),
    settledBy: process.env.GITHUB_ACTOR || 'github-actions[bot]',
  });
  if (settled.length === 0) {
    console.log('No matching pending entries found.');
    return;
  }

  writeJson(QUEUE_PATH, queue);
  writeJson(ACCOUNTS_PATH, accounts);
  const issueMatch = issueRef.match(/#(\d+)$/);
  if (issueMatch) {
    const issueNumber = Number(issueMatch[1]);
    await postIssueComment(owner, repo, issueNumber, buildSettlementComment({
      settledCount: settled.length,
      actor: process.env.GITHUB_ACTOR || 'github-actions[bot]',
      txHash,
      issueNumber,
      currency,
    }));
  }
  console.log(`Settled ${settled.length} payroll entries${currency ? ` in ${currency}` : ''}.`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildSettlementComment };