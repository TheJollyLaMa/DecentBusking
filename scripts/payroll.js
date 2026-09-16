const BOUNTY_LABEL_RE = /^bounty:\s*(\d+(?:\.\d+)?)\s*\$?ART$/i;
const TEST_BOUNTY_LABEL_RE = /^test-bounty:\s*(\d+(?:\.\d+)?)\s*\$?ART$/i;
const IDEA_CREDIT_LABEL_RE = /^idea-credit:\s*@?([-\w]+)$/i;
const CLOSING_ISSUE_RE = /(?:closes?|fixes?|resolves?)\s+(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#(\d+)/gi;
const TITLE_ISSUE_RE = /#(\d+)/g;
const AMOUNT_RE = /^\d+(?:\.\d+)?$/;

const CONTRIBUTOR_ALIASES = {
  'copilot-swe-agent': 'copilot',
  'copilot-swe-agent[bot]': 'copilot',
};

function normalizeLogin(login) {
  const value = String(login || '').trim();
  return CONTRIBUTOR_ALIASES[value.toLowerCase()] || value;
}

function normalizeCurrency(entryOrCurrency) {
  const value = typeof entryOrCurrency === 'object'
    ? entryOrCurrency && entryOrCurrency.currency
    : entryOrCurrency;
  return String(value || 'ETH').trim().toUpperCase();
}

function labelNames(issue) {
  return (issue.labels || []).map(label => typeof label === 'string' ? label : label.name);
}

function normalizeAmount(value) {
  const input = String(value).trim();
  if (!AMOUNT_RE.test(input)) throw new Error(`Invalid payout amount: ${value}`);

  let [whole, fraction = ''] = input.split('.');
  whole = whole.replace(/^0+(?=\d)/, '');
  fraction = fraction.replace(/0+$/, '');
  if (BigInt(`${whole}${fraction}` || '0') <= 0n) throw new Error(`Invalid payout amount: ${value}`);
  return fraction ? `${whole}.${fraction}` : whole;
}

function parseAmountLabel(issue, pattern = BOUNTY_LABEL_RE) {
  for (const label of labelNames(issue)) {
    const match = String(label || '').match(pattern);
    if (match) return { label, amount: normalizeAmount(match[1]) };
  }
  return null;
}

function parseIdeaCredit(issue) {
  for (const label of labelNames(issue)) {
    const match = String(label || '').match(IDEA_CREDIT_LABEL_RE);
    if (match) return normalizeLogin(match[1]);
  }
  return null;
}

function extractIssueNumbers({ body = '', title = '', linked = [], override = [] } = {}) {
  const numbers = new Set();
  for (const value of override) {
    const number = Number(value);
    if (Number.isInteger(number) && number > 0) numbers.add(number);
  }
  for (const match of String(body).matchAll(CLOSING_ISSUE_RE)) numbers.add(Number(match[1]));
  for (const match of String(title).matchAll(TITLE_ISSUE_RE)) numbers.add(Number(match[1]));
  for (const value of linked) {
    const number = Number(value);
    if (Number.isInteger(number) && number > 0) numbers.add(number);
  }
  return [...numbers];
}

function decimalParts(value) {
  const normalized = normalizeAmount(value);
  const [whole, fraction = ''] = normalized.split('.');
  return { units: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function formatDecimal(units, scale) {
  const digits = units.toString().padStart(scale + 1, '0');
  if (scale === 0) return digits;
  return normalizeAmount(`${digits.slice(0, -scale)}.${digits.slice(-scale)}`);
}

function splitIdeaCredit(amount) {
  let { units, scale } = decimalParts(amount);
  while (units % 5n !== 0n && scale < 18) {
    units *= 10n;
    scale += 1;
  }
  if (units % 5n !== 0n) throw new Error(`Payout amount cannot be split exactly at 18 decimals: ${amount}`);
  const originatorUnits = units / 5n;
  return {
    implementer: formatDecimal(units - originatorUnits, scale),
    originator: formatDecimal(originatorUnits, scale),
  };
}

function findAccount(accounts, login) {
  const normalized = normalizeLogin(login).toLowerCase();
  return (accounts.contributors || []).find(
    account => String(account.github || '').trim().toLowerCase() === normalized
  );
}

function requireWhitelistedAccount(accounts, candidates, description) {
  for (const login of candidates) {
    const account = findAccount(accounts, login);
    if (account && String(account.walletAddress || '').trim()) return account;
  }
  throw new Error(`No whitelisted wallet found for ${description}: ${candidates.filter(Boolean).join(', ') || 'none'}`);
}

function entryRole(entry) {
  return String(entry.role || 'contributor').toLowerCase();
}

function isDuplicate(queue, candidate) {
  const candidateIssueRef = String(candidate.issueRef || '').trim();
  const candidateGithub = String(candidate.contributorGithub || '').trim().toLowerCase();
  const candidateRole = entryRole(candidate);
  const candidateCurrency = normalizeCurrency(candidate);

  return [...(queue.pending || []), ...(queue.settled || [])].some(entry => {
    if (String(entry.issueRef || '').trim() !== candidateIssueRef) return false;
    if (normalizeCurrency(entry) !== candidateCurrency) return false;

    const entryGithub = String(entry.contributorGithub || '').trim().toLowerCase();
    const entryRoleName = entryRole(entry);
    if (entryGithub === candidateGithub) return true;
    if (candidateRole === 'contributor') return false;
    return (entryRoleName === 'implementer' || entryRoleName === 'idea-originator') &&
      (candidateRole === 'implementer' || candidateRole === 'idea-originator');
  });
}

function pickWhitelistedTester({ assigneeLogins = [], accounts, commenter = '' } = {}) {
  const eligible = assigneeLogins
    .map(login => normalizeLogin(login))
    .filter(Boolean)
    .map(login => findAccount(accounts, login))
    .filter(account => account && String(account.walletAddress || '').trim());

  if (eligible.length === 0) throw new Error('No assigned tester on this issue has a whitelisted wallet.');

  const commenterKey = normalizeLogin(commenter).toLowerCase();
  const commenterMatch = eligible.find(
    account => String(account.github || '').trim().toLowerCase() === commenterKey
  );
  if (commenterMatch) return commenterMatch;
  if (eligible.length > 1) {
    throw new Error(`Multiple assigned testers have whitelisted wallets: ${eligible.map(account => account.github).join(', ')}`);
  }
  return eligible[0];
}

function createBountyEntries({ issue, pr, accounts, queue, repoSlug, queuedAt, queuedBy }) {
  const bounty = parseAmountLabel(issue);
  if (!bounty) return { entries: [], reason: 'missing-bounty-label' };

  const prAuthor = normalizeLogin(pr.user && pr.user.login);
  const assignees = (issue.assignees || []).map(assignee => normalizeLogin(assignee.login));
  const implementer = requireWhitelistedAccount(
    accounts,
    [...new Set([prAuthor, ...assignees].filter(Boolean))],
    'PR author or issue assignee'
  );
  const ideaOriginatorLogin = parseIdeaCredit(issue);
  const issueRef = `${repoSlug}#${issue.number}`;
  const common = {
    issueRef,
    currency: 'ART',
    queuedAt,
    queuedBy,
    prNumber: pr.number,
  };

  let entries;
  if (ideaOriginatorLogin) {
    const originator = requireWhitelistedAccount(accounts, [ideaOriginatorLogin], 'idea originator');
    const split = splitIdeaCredit(bounty.amount);
    entries = [
      {
        ...common,
        contributor: implementer.walletAddress,
        contributorGithub: implementer.github,
        amount: split.implementer,
        role: 'implementer',
      },
      {
        ...common,
        contributor: originator.walletAddress,
        contributorGithub: originator.github,
        amount: split.originator,
        role: 'idea-originator',
      },
    ];
  } else {
    entries = [{
      ...common,
      contributor: implementer.walletAddress,
      contributorGithub: implementer.github,
      amount: bounty.amount,
    }];
  }

  const newEntries = entries.filter(entry => !isDuplicate(queue, entry));
  return {
    entries: newEntries,
    skippedDuplicates: entries.length - newEntries.length,
    bountyLabel: bounty.label,
  };
}

function accountField(currency, suffix) {
  return `${currency.toLowerCase()}${suffix}`;
}

function updateAccountTotal(account, field, delta, floorAtZero = false) {
  const next = Number(((Number(account[field]) || 0) + Number(delta)).toFixed(8));
  account[field] = floorAtZero ? Math.max(0, next) : next;
}

function applyAccountAccrual(accounts, entries) {
  for (const entry of entries) {
    const account = findAccount(accounts, entry.contributorGithub);
    if (!account) continue;
    const currency = normalizeCurrency(entry);
    updateAccountTotal(account, accountField(currency, 'Pending'), entry.amount);
    if (!Array.isArray(account.issuesClosed)) account.issuesClosed = [];
    if (!account.issuesClosed.includes(entry.issueRef)) account.issuesClosed.push(entry.issueRef);
    if (entry.role === 'idea-originator') {
      if (!Array.isArray(account.ideasCredited)) account.ideasCredited = [];
      if (!account.ideasCredited.includes(entry.issueRef)) account.ideasCredited.push(entry.issueRef);
    }
  }
}

function settleEntries({
  queue,
  accounts,
  contributorGithub = '',
  issueRef = '',
  currency = '',
  txHash = '',
  settledAt,
  settledBy,
}) {
  const contributorFilter = String(contributorGithub).trim().toLowerCase();
  const issueFilter = String(issueRef).trim();
  const currencyFilter = String(currency).trim().toUpperCase();
  const matches = entry =>
    (!contributorFilter || String(entry.contributorGithub || '').trim().toLowerCase() === contributorFilter) &&
    (!issueFilter || String(entry.issueRef || '').trim() === issueFilter) &&
    (!currencyFilter || normalizeCurrency(entry) === currencyFilter);
  const selected = (queue.pending || []).filter(matches);
  queue.pending = (queue.pending || []).filter(entry => !matches(entry));

  const settled = selected.map(entry => ({
    ...entry,
    settledAt,
    settledBy,
    ...(txHash ? { txHash } : {}),
  }));
  if (!Array.isArray(queue.settled)) queue.settled = [];
  queue.settled.push(...settled);

  for (const entry of settled) {
    const account = findAccount(accounts, entry.contributorGithub);
    if (!account) continue;
    const entryCurrency = normalizeCurrency(entry);
    updateAccountTotal(account, accountField(entryCurrency, 'Pending'), -Number(entry.amount), true);
    updateAccountTotal(account, accountField(entryCurrency, 'Earned'), entry.amount);
  }
  return settled;
}

module.exports = {
  BOUNTY_LABEL_RE,
  TEST_BOUNTY_LABEL_RE,
  applyAccountAccrual,
  createBountyEntries,
  extractIssueNumbers,
  findAccount,
  isDuplicate,
  normalizeAmount,
  normalizeCurrency,
  normalizeLogin,
  parseAmountLabel,
  parseIdeaCredit,
  pickWhitelistedTester,
  settleEntries,
  splitIdeaCredit,
};