# DecentBusking Payroll

## Legacy Optimism Payment Review

Legacy ETH payments are direct wallet transfers, not replay-protected router payouts. Paying did not update the repository JSON automatically, so previously paid rows could reappear on Refresh. Do not send another transfer solely because a row is visible.

The panel now requires explicit unpaid review for legacy rows. To reconcile an existing payment, enter its Optimism transaction hash in the matching row and verify it. Verification requires chain 10, the registered owner as sender, the exact recipient and value, and a successful receipt. A confirmed row is hidden on refresh, a pending/unresolved broadcast stays locked, and the same transaction cannot be assigned to two entries in that browser's receipt log. Matching value/recipient alone does not prove which issue was paid when multiple bounties have identical amounts; the owner must make that assignment.

Receipt assignments are stored in this browser's local storage, not a global on-chain paid-reference mapping. Record each verified transaction through the existing Settle Payroll workflow to update the repository ledger for other devices and contributors. Clearing browser storage or changing devices loses local assignments; legacy entries start locked again until reviewed. Base router payouts continue to use their on-chain `completedWorkReferences` protection.

The panel is ordered Playback Payroll, Top 10 Prize Payouts, then Repo Dev Bot Payouts. Playback and prize allocations remain unconfigured and cannot send payments yet. The public Left Ankh entry is Playback Tally; Admin Nft Mint and Payroll are visible only for the configured admin wallet in this release. UI visibility is not a substitute for transaction-level role and owner checks.

DecentBusking follows the ArtFi contribution-payroll model. GitHub Actions records bounty credits in the repository ledger; the repo owner sends configured ERC-20 rewards through the existing ArtFi Settlement Router on Base. DecentBusking uses its own `dbusk-repo-dev` fund on that shared router and does not deploy a second router.

## Labels

Use exact labels whose symbol is present in `payroll-assets.json`:

- `bounty: 100 ART` or `bounty: 100 $ART`
- `bounty: 25 USDC` or `bounty: 25 $USDC`
- `test-bounty: 10 SYMBOL` or `test-bounty: 10 $SYMBOL`
- `idea-credit: @username` for an exact 80% implementer / 20% originator split

New queue entries include the token symbol in `currency` and `fund: dbusk-repo-dev`. `payroll-assets.json` is shared by the Node automation and browser panel. Each asset entry defines its Base ERC-20 address, contract decimals, and maximum ledger precision. ART uses eight ledger decimals and USDC uses six. Idea-credit splits that cannot be represented exactly at the selected token's precision are rejected rather than rounded.

To add a future token such as DJuke or DBusk, add its uppercase symbol, Base ERC-20 address, on-chain `decimals`, and `ledgerDecimals` to `payroll-assets.json`, then approve that token on the shared router. After that, labels using the symbol are parsed and settled by the existing flow; no currency-specific code path is required.

## One-Time Fund Setup

The fund must be created and funded on the already-deployed shared router before token payouts can succeed. Use ArtFi's Treasury Admin on Base with the router and asset addresses from `payroll-assets.json`:

1. Create the `dbusk-repo-dev` fund with IPFS metadata describing DecentBusking repo payroll.
2. Deposit the token(s) you intend to pay into that fund. The queue can accrue credits while the allocation is empty, but payments require enough available balance for the selected token.
3. Confirm the repo owner wallet has `PAYROLL_ROLE` and `CONTRIBUTOR_ADMIN_ROLE` on the shared router.

The fund ID is `keccak256(UTF-8("dbusk-repo-dev"))`. Do not deploy a router or remove contributors from its shared allowlist; other repositories use the same contract.

## Merge And Recovery

The Bounty Bot runs when a pull request merges into `main`. It combines closing references in the PR body, references in the title, and GitHub-linked closing issues. Manual recovery accepts only a PR that is already merged.

Contributors request access using the Contributor Request issue form. After the maintainer verifies their GitHub handle and wallet, the maintainer adds the account to `contributor-accounts.json`. A known bot login falls back to a registered issue assignee. Duplicate checks include currency, so rewards in different configured tokens can coexist for the same issue and contributor, as can a new token reward and a historical ETH reward.

## Testing Rewards

An assigned tester posts `/test-complete`. The repository owner posts `/test-approved`, optionally followed by `@tester`. With no explicit tester, the latest assigned tester who posted `/test-complete` is selected. Ambiguous assignments fail instead of choosing a wallet silently. Approved test rewards also use `dbusk-repo-dev`.

## Settlement

From the payroll panel, the owner connects the registered wallet and settles configured tokens on Base. The panel checks the shared router, selected token approval, fund balance, contributor allowlist, and work-reference replay status before sending the transaction. If the wallet is not yet approved on the shared router, the panel adds that contributor by GitHub-ID hash; it never revokes other repositories' contributors. The router's `PayrollPaid` event and `completedWorkReferences` mapping are the on-chain source of truth, and already-paid entries are hidden on refresh.

After a confirmed transaction, run the Settle Payroll workflow to mirror the specific entry in `payroll-queue.json` and update account totals. The workflow requires the contributor, issue, role, currency, and transaction hash, and is restricted to the repository owner. Do not use it to mark a payment before the transaction confirms.

The settlement workflow supports these required filters:

- Contributor GitHub username
- Issue reference such as `TheJollyLaMa/DecentBusking#14`
- Role (`contributor`, `implementer`, `idea-originator`, or `tester`)
- Currency (an asset in `payroll-assets.json`, or legacy `ETH`)
- Confirmed transaction hash

Settlements update per-currency `<symbol>Pending` and `<symbol>Earned` account fields using that asset's configured ledger precision. Legacy ETH settlement updates `ethPending` and `ethEarned`.

## Legacy ETH Compatibility

Historical queue entries are preserved exactly. An entry without `currency` is interpreted as legacy ETH in validation, deduplication, settlement, and the browser. Those entries continue to send native ETH on Optimism. Configured ERC-20 entries are paid only through the Base router and are never sent through the ETH path.

## Contributor Requests

Use the Contributor Request issue form. It asks only for a GitHub handle, wallet, technical area, and optional work links. Opening the form posts a GitHub mention and Actions summary for the maintainer; there is no interview, biography, SMTP secret, or third-party notification dependency. After approval, being assigned to a bounty and opening a linked PR is enough to earn the issue's configured token credit when the PR merges.

## Local Verification

```bash
node scripts/validatePayrollQueue.js
node --test test/payroll.test.js test/commentArt.test.js test/automation.test.js
```