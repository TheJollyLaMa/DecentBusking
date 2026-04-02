#!/usr/bin/env node
/**
 * scripts/validatePayrollQueue.js
 * DecentBusking — Payroll Queue Validator
 *
 * Validates payroll-queue.json and contributor-accounts.json for consistency.
 *
 * Checks:
 *   1. Required fields present on every entry
 *   2. issueRef follows canonical format (<owner>/<repo>#<number>)
 *   3. contributor is a valid Ethereum address (or empty string if pending registration)
 *   4. amount is a positive number (ETH, supports decimals like 0.00001)
 *   5. No duplicate (issueRef, contributorGithub) pairs within pending or settled
 *   6. contributorGithub exists in contributor-accounts.json
 *   7. Wallet addresses in queue match registrations in contributor-accounts.json
 *
 * Exit code 0 = valid, exit code 1 = invalid (with error details printed).
 */

const fs = require('fs');
const path = require('path');

const QUEUE_PATH    = path.join(__dirname, '..', 'payroll-queue.json');
const ACCOUNTS_PATH = path.join(__dirname, '..', 'contributor-accounts.json');

const ISSUE_REF_RE  = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/;
const ETH_ADDR_RE   = /^0x[0-9a-fA-F]{40}$/;

let errors = 0;

function fail(msg) {
  console.error(`  ❌ ${msg}`);
  errors++;
}

function info(msg) {
  console.log(`  ℹ️  ${msg}`);
}

// ── Load files ────────────────────────────────────────────────────────────────

let queue    = { pending: [], settled: [] };
let accounts = { contributors: [] };

if (!fs.existsSync(QUEUE_PATH)) {
  console.log('payroll-queue.json not found — nothing to validate.');
  process.exit(0);
}

try {
  queue = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
} catch (e) {
  console.error(`❌ Failed to parse payroll-queue.json: ${e.message}`);
  process.exit(1);
}

if (fs.existsSync(ACCOUNTS_PATH)) {
  try {
    accounts = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
  } catch (e) {
    console.error(`❌ Failed to parse contributor-accounts.json: ${e.message}`);
    process.exit(1);
  }
}

const contributors = accounts.contributors || [];

// Build lookup maps
const walletByGithub = new Map(
  contributors.map(c => [c.github.toLowerCase(), (c.walletAddress || '').toLowerCase()])
);
const registeredGithubs = new Set(contributors.map(c => c.github.toLowerCase()));

// ── Validate a list of entries ────────────────────────────────────────────────

function validateEntries(entries, section) {
  console.log(`\nValidating ${section} (${entries.length} entries)…`);
  const seen = new Set();

  for (const [i, entry] of entries.entries()) {
    const prefix = `[${section}][${i}]`;

    // 1. Required fields
    const required = ['issueRef', 'contributorGithub', 'amount', 'queuedAt', 'queuedBy'];
    for (const field of required) {
      if (entry[field] === undefined || entry[field] === null || entry[field] === '') {
        fail(`${prefix} Missing required field: "${field}"`);
      }
    }

    // 2. issueRef format
    if (entry.issueRef && !ISSUE_REF_RE.test(entry.issueRef)) {
      fail(`${prefix} issueRef "${entry.issueRef}" does not match expected format <owner>/<repo>#<number>`);
    }

    // 3. contributor address (can be empty string if wallet not yet registered)
    if (entry.contributor && entry.contributor !== '' && !ETH_ADDR_RE.test(entry.contributor)) {
      fail(`${prefix} contributor "${entry.contributor}" is not a valid Ethereum address`);
    }

    // 4. amount must be a positive number (ETH supports decimals)
    const amt = parseFloat(entry.amount);
    if (isNaN(amt) || amt <= 0) {
      fail(`${prefix} amount "${entry.amount}" must be a positive number (ETH)`);
    }

    // 5. No duplicate (issueRef, contributorGithub[, role]) pairs
    const dupKey = `${entry.issueRef}::${entry.contributorGithub}::${entry.role || ''}`;
    if (seen.has(dupKey)) {
      fail(`${prefix} Duplicate entry for issueRef="${entry.issueRef}", contributorGithub="${entry.contributorGithub}", role="${entry.role || ''}"`);
    }
    seen.add(dupKey);

    // 6. contributorGithub must exist in contributor-accounts.json
    if (entry.contributorGithub && !registeredGithubs.has(entry.contributorGithub.toLowerCase())) {
      fail(`${prefix} contributorGithub "@${entry.contributorGithub}" is not in contributor-accounts.json`);
    }

    // 7. Wallet address must match contributor-accounts.json (if both are set)
    if (entry.contributor && entry.contributor !== '' && entry.contributorGithub) {
      const registered = walletByGithub.get(entry.contributorGithub.toLowerCase());
      if (registered && registered !== '' && registered !== entry.contributor.toLowerCase()) {
        fail(`${prefix} Wallet mismatch for @${entry.contributorGithub}: queue has "${entry.contributor}", accounts has "${registered}"`);
      }
    }
  }
}

// ── Run validation ────────────────────────────────────────────────────────────

if (!Array.isArray(queue.pending)) {
  fail('payroll-queue.json missing or invalid "pending" array');
} else {
  validateEntries(queue.pending, 'pending');
}

if (!Array.isArray(queue.settled)) {
  fail('payroll-queue.json missing or invalid "settled" array');
} else {
  validateEntries(queue.settled, 'settled');
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('');
if (errors === 0) {
  console.log(`✅ payroll-queue.json is valid (${(queue.pending || []).length} pending, ${(queue.settled || []).length} settled).`);
  process.exit(0);
} else {
  console.error(`❌ payroll-queue.json has ${errors} error(s). Fix them before merging.`);
  process.exit(1);
}
