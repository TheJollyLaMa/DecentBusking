const fs = require('fs');
const path = require('path');
const { normalizeCurrency } = require('./payroll');

const QUEUE_PATH = path.join(__dirname, '..', 'payroll-queue.json');
const ACCOUNTS_PATH = path.join(__dirname, '..', 'contributor-accounts.json');
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const ISSUE_REF_RE = /^[^/]+\/[^/]+#\d+$/;
const SUPPORTED_CURRENCIES = new Set(['ART', 'ETH']);
const SUPPORTED_ROLES = new Set(['contributor', 'implementer', 'idea-originator', 'tester']);
const LEGACY_CUTOFF = Date.parse('2026-09-16T00:00:00.000Z');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

if (!fs.existsSync(QUEUE_PATH)) fail('payroll-queue.json is missing');
if (!fs.existsSync(ACCOUNTS_PATH)) fail('contributor-accounts.json is missing');

let queue;
let accounts;
try { queue = readJson(QUEUE_PATH); } catch (error) { fail(`payroll-queue.json is not valid JSON: ${error.message}`); }
try { accounts = readJson(ACCOUNTS_PATH); } catch (error) { fail(`contributor-accounts.json is not valid JSON: ${error.message}`); }

if (!queue || typeof queue !== 'object' || Array.isArray(queue)) fail('payroll-queue.json must be a JSON object');
if (!Array.isArray(queue.pending)) fail('payroll-queue.json.pending must be an array');
if (!Array.isArray(queue.settled)) fail('payroll-queue.json.settled must be an array');
if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) fail('contributor-accounts.json must be a JSON object');
if (!Array.isArray(accounts.contributors)) fail('contributor-accounts.json.contributors must be an array');

const contributors = new Map();
for (const [index, contributor] of accounts.contributors.entries()) {
  if (!contributor || typeof contributor !== 'object' || Array.isArray(contributor)) {
    fail(`contributor-accounts.json.contributors[${index}] must be an object`);
  }
  const github = String(contributor.github || '').trim();
  const wallet = String(contributor.walletAddress || '').trim();
  if (!github) fail(`contributor-accounts.json.contributors[${index}].github is required`);
  if (!ADDRESS_RE.test(wallet)) fail(`contributor-accounts.json.contributors[${index}].walletAddress must be a valid Ethereum address`);
  const key = github.toLowerCase();
  if (contributors.has(key)) fail(`duplicate contributor GitHub handle: ${github}`);
  contributors.set(key, wallet.toLowerCase());
}

const seen = new Set();
function validateEntry(entry, section, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`${section}[${index}] must be an object`);
  const issueRef = String(entry.issueRef || '').trim();
  const github = String(entry.contributorGithub || '').trim();
  const wallet = String(entry.contributor || '').trim();
  const amount = String(entry.amount || '').trim();
  const currency = normalizeCurrency(entry);
  const role = String(entry.role || 'contributor').trim().toLowerCase();
  const queuedAt = String(entry.queuedAt || '').trim();

  if (!ISSUE_REF_RE.test(issueRef)) fail(`${section}[${index}].issueRef must look like owner/repo#123`);
  if (!github) fail(`${section}[${index}].contributorGithub is required`);
  if (!ADDRESS_RE.test(wallet)) fail(`${section}[${index}].contributor must be a valid Ethereum address`);
  if (!amount || !Number.isFinite(Number(amount)) || Number(amount) <= 0) fail(`${section}[${index}].amount must be positive`);
  if (!SUPPORTED_CURRENCIES.has(currency)) fail(`${section}[${index}].currency must be ART or ETH`);
  if (!entry.currency && Date.parse(queuedAt) >= LEGACY_CUTOFF) fail(`${section}[${index}].currency is required for new entries`);
  if (!SUPPORTED_ROLES.has(role)) fail(`${section}[${index}].role is not supported: ${role}`);

  const key = `${issueRef}:${github.toLowerCase()}:${role}:${currency}`;
  if (seen.has(key)) fail(`duplicate payroll entry detected for ${issueRef} / ${github} / ${currency}`);
  seen.add(key);
  const registeredWallet = contributors.get(github.toLowerCase());
  if (!registeredWallet) fail(`${section}[${index}].contributorGithub is not registered in contributor-accounts.json`);
  if (registeredWallet !== wallet.toLowerCase()) fail(`${section}[${index}].contributor does not match the registered wallet for ${github}`);

  if (!queuedAt) fail(`${section}[${index}].queuedAt is required`);
  if (!String(entry.queuedBy || '').trim()) fail(`${section}[${index}].queuedBy is required`);
  if (section === 'settled') {
    if (!String(entry.settledAt || '').trim()) fail(`${section}[${index}].settledAt is required`);
    if (!String(entry.settledBy || '').trim()) fail(`${section}[${index}].settledBy is required`);
  }
}

queue.pending.forEach((entry, index) => validateEntry(entry, 'pending', index));
queue.settled.forEach((entry, index) => validateEntry(entry, 'settled', index));
console.log(`✅ payroll-queue.json and contributor-accounts.json validated (${queue.pending.length} pending, ${queue.settled.length} settled; currency-less entries treated as legacy ETH)`);
