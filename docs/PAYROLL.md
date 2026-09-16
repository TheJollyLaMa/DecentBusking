# DecentBusking Payroll

DecentBusking records new contributor rewards in ART. GitHub Actions manages an off-chain ledger only; it does not hold keys or send tokens.

## Labels

Only exact labels are payable:

- `bounty: 100 ART` or `bounty: 100 $ART`
- `test-bounty: 10 ART` or `test-bounty: 10 $ART`
- `idea-credit: @username` for the exact 80% implementer / 20% originator split

ETH bounty labels are ignored by new automation. Every newly generated queue entry includes `"currency": "ART"`.

## Merge And Recovery

The Bounty Bot runs when a pull request merges into `main`. It combines closing references in the PR body, references in the title, and GitHub-linked closing issues. The manual workflow dispatch accepts a PR number and optional comma-separated issue numbers for recovery.

Contributors must already have a wallet in `contributor-accounts.json`. A known bot login falls back to a whitelisted issue assignee. Duplicate checks include currency, so an ART reward can coexist with an old ETH reward for the same issue and contributor.

## Testing Rewards

An assigned tester posts `/test-complete`. The repository owner posts `/test-approved`, optionally followed by `@tester`. With no explicit tester, the latest assigned tester who posted `/test-complete` is selected. Ambiguous assignments fail instead of choosing a wallet silently.

## Settlement

Run the Settle Payroll workflow after external settlement. Filters are optional:

- Contributor GitHub username
- Issue reference such as `TheJollyLaMa/DecentBusking#14`
- Currency: `ART` or `ETH`
- Transaction hash or external payment reference

A blank currency filter matches both currencies. Prefer an explicit currency when recording a payment batch. ART settlement updates `artPending` and `artEarned`; legacy ETH settlement updates `ethPending` and `ethEarned`. ART fields are added lazily and default to zero in calculations.

## Legacy ETH Compatibility

Historical queue entries are preserved exactly. An entry without `currency` is interpreted as legacy ETH in validation, deduplication, settlement, and the browser. The existing browser payroll panel can continue sending legacy or explicit ETH entries on Optimism. ART entries are displayed as ledger-only and are blocked from every ETH transaction path.

## Contributor Requests

Use the Contributor Request issue form. It asks only for a GitHub handle, wallet, technical area, and optional work links. Opening the form posts a GitHub mention and Actions summary for the maintainer; there is no interview, biography, SMTP secret, or third-party notification dependency.

## Local Verification

```bash
node scripts/validatePayrollQueue.js
node --test test/payroll.test.js test/commentArt.test.js test/automation.test.js
```