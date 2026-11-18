const fs = require('node:fs');
const path = require('node:path');
const { githubRequest, repositoryCoordinates } = require('./githubApi');
const { amountToUnits, unitsToAmount, normalizeCurrency, SUPPORTED_CURRENCIES } = require('./payroll');

const MARKER = '<!-- decentbusking-repo-payroll-backlog -->';

function buildPayrollAlert(queue, repoSlug, owner) {
  if (!Array.isArray(queue.pending)) throw new Error('Payroll pending queue is invalid');
  const pending = queue.pending.filter(entry => SUPPORTED_CURRENCIES.includes(normalizeCurrency(entry)) && !entry.retainedInFund);
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
    `## Repo-dev payroll: ${pending.length} queued entr${pending.length === 1 ? 'y' : 'ies'}`,
    pending.length ? `@${owner}: review queued repository rewards in **Admin -> Payroll -> Repo Dev Bot Payouts**.` : 'No queued Base repository rewards.',
    ...[...totals].sort().map(([currency, units]) => `- Total queued: **${unitsToAmount(units, currency)} ${currency}**`),
    '',
    ...rows,
    '',
    `[Open payroll ledger](https://github.com/${repoSlug}/blob/main/payroll-queue.json)`,
    'These are queued ledger records, not proof of unpaid on-chain balances. Review exact Base work references before paying. Retained bot credits and historical ETH are excluded.',
    'Owner approval and wallet confirmation are required. This alert never sends money or marks anything settled.',
  ].join('\n\n');
  if (body.length > 60000) throw new Error('Payroll alert exceeds GitHub limits; review the ledger manually');
  return { title: `Repo-dev payroll: ${pending.length} queued for owner review`, body, count: pending.length };
}

async function notifyPayrollPending({ queue, owner, repo, request = githubRequest }) {
  const alert = buildPayrollAlert(queue, `${owner}/${repo}`, owner);
  const base = `/repos/${owner}/${repo}/issues`;
  let existing = null;
  for (let page = 1; ; page++) {
    const issues = await request(`${base}?state=all&creator=github-actions%5Bbot%5D&per_page=100&page=${page}`);
    existing = issues.find(issue => !issue.pull_request && issue.user?.login === 'github-actions[bot]' && issue.body?.startsWith(MARKER));
    if (existing || issues.length < 100) break;
  }
  if (existing?.body === alert.body && existing.state === 'open') return { changed: false };
  if (!existing && !alert.count) return { changed: false };
  const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!existing) {
    await request(base, json({ title: alert.title, body: alert.body, assignees: [owner] }));
  } else {
    await request(`${base}/${existing.number}`, { ...json({ title: alert.title, body: alert.body, state: 'open' }), method: 'PATCH' });
    if (alert.count) await request(`${base}/${existing.number}/comments`, json({
      body: `@${owner}: the repo-dev payroll backlog changed (${alert.count} queued entries). Review the updated checklist above; no payment was made.`,
    }));
  }
  return { changed: true };
}

async function main() {
  const { owner, repo } = repositoryCoordinates();
  const queue = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'payroll-queue.json'), 'utf8'));
  await notifyPayrollPending({ queue, owner, repo });
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildPayrollAlert, notifyPayrollPending };
