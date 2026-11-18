const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { githubRequest, repositoryCoordinates } = require('./githubApi');
const { amountToUnits, unitsToAmount, normalizeCurrency, SUPPORTED_CURRENCIES } = require('./payroll');

const MARKER = '<!-- decentbusking-repo-payroll-backlog -->';

function buildPayrollAlert(status, repoSlug, owner) {
  if (!status.error && (status.verified !== true || !Array.isArray(status.pending))) throw new Error('Verified payroll status is required');
  const pending = status.error ? [] : status.pending.filter(entry => SUPPORTED_CURRENCIES.includes(normalizeCurrency(entry)) && !entry.retainedInFund);
  const totals = new Map();
  for (const entry of pending) {
    const currency = normalizeCurrency(entry);
    totals.set(currency, (totals.get(currency) || 0n) + amountToUnits(entry.amount, currency));
  }
  const rows = pending.map(entry => {
    if (!/^[-\w]+(?:\[bot\])?$/.test(entry.contributorGithub || '') ||
        !/^[^/]+\/[^/]+#\d+$/.test(entry.issueRef || '') ||
        !/^[a-z-]+$/.test(entry.role || 'contributor')) throw new Error('Invalid public payroll entry');
    return `- ${entry.issueRef} | @${entry.contributorGithub} | ${entry.role || 'contributor'} | ${entry.amount} ${normalizeCurrency(entry)}`;
  }).sort();
  const body = [
    MARKER,
    status.error ? '## Repo-dev payroll status unavailable' : `## Repo-dev payroll: ${pending.length} unpaid entr${pending.length === 1 ? 'y' : 'ies'}`,
    status.error ? `@${owner}: Base completion could not be verified. No unpaid count is being asserted; rerun Repo Payroll Alerts.`
      : pending.length ? `@${owner}: review unpaid repository rewards in **Admin -> Payroll -> Repo Dev Bot Payouts**.` : 'No unpaid Base repository rewards.',
    ...[...totals].sort().map(([currency, units]) => `- Total unpaid: **${unitsToAmount(units, currency)} ${currency}**`),
    '',
    ...rows,
    '',
    `[Open payroll ledger](https://github.com/${repoSlug}/blob/main/payroll-queue.json)`,
    ...(status.error ? [] : [`Verified against Base router completion flags at block ${status.blockNumber ?? 'not needed (empty ledger)'}. Already-completed work is excluded even when its ledger row still says pending.`]),
    'Retained bot credits and historical ETH are excluded. This check does not rewrite ledger settlement records or invent payment receipts.',
    'Owner approval and wallet confirmation are required. This alert never sends money or marks anything settled.',
  ].join('\n\n');
  if (body.length > 60000) throw new Error('Payroll alert exceeds GitHub limits; review the ledger manually');
  return { title: status.error ? 'Repo-dev payroll: verification unavailable' : `Repo-dev payroll: ${pending.length} unpaid for owner review`,
    body, count: status.error ? null : pending.length, state: !status.error && !pending.length ? 'closed' : 'open' };
}

async function notifyPayrollPending({ status, owner, repo, request = githubRequest }) {
  const alert = buildPayrollAlert(status, `${owner}/${repo}`, owner);
  const base = `/repos/${owner}/${repo}/issues`;
  let existing = null;
  for (let page = 1; ; page++) {
    const issues = await request(`${base}?state=all&creator=github-actions%5Bbot%5D&per_page=100&page=${page}`);
    existing = issues.find(issue => !issue.pull_request && issue.user?.login === 'github-actions[bot]' && issue.body?.startsWith(MARKER));
    if (existing || issues.length < 100) break;
  }
  if (existing?.body === alert.body && existing.state === alert.state) return { changed: false };
  if (!existing && alert.count === 0) return { changed: false };
  const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!existing) {
    await request(base, json({ title: alert.title, body: alert.body, assignees: [owner] }));
  } else {
    const previouslyUnpaid = [...String(existing.body || '').matchAll(/^- (?:Total (?:unpaid|queued):|\S+\/\S+#\d+ \|).*$/gm)].map(match => match[0]).sort().join('\n');
    const nowUnpaid = [...alert.body.matchAll(/^- (?:Total (?:unpaid|queued):|\S+\/\S+#\d+ \|).*$/gm)].map(match => match[0]).sort().join('\n');
    await request(`${base}/${existing.number}`, { ...json({ title: alert.title, body: alert.body, state: alert.state }), method: 'PATCH' });
    if (alert.count && (previouslyUnpaid !== nowUnpaid || existing.state !== 'open')) await request(`${base}/${existing.number}/comments`, json({
      body: `@${owner}: the verified repo-dev payroll backlog changed (${alert.count} unpaid entries). Review the updated checklist above; no payment was made.`,
    }));
  }
  return { changed: true };
}

async function main() {
  const { owner, repo } = repositoryCoordinates();
  let status;
  let verificationError;
  try {
    const queue = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'payroll-queue.json'), 'utf8'));
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'payroll-assets.json'), 'utf8'));
    const ethers = createRequire(path.join(__dirname, '..', 'discord-bot', 'package.json'))('ethers');
    const { getRepositoryPayrollStatus } = await import('../js/repository-payroll-status.mjs');
    status = await getRepositoryPayrollStatus({ queue, config, ethers });
  } catch (error) {
    verificationError = error;
    status = { error: true };
  }
  await notifyPayrollPending({ status, owner, repo });
  if (verificationError) throw verificationError;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildPayrollAlert, notifyPayrollPending };
