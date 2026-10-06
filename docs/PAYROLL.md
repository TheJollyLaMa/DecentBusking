# DecentBusking Payroll

## Base Payroll Panel

Active payroll is Base-only. Historical records are preserved outside the active queue; see [retired payroll history](LEGACY-PAYROLL.md). The public Left Ankh entry is Playback Tally; Admin Nft Mint and Payroll are visible only to the configured admin wallet. UI visibility does not replace transaction-level owner and role checks.

The panel is ordered Playback Payroll, Top 10 Prize Payouts, then Repo Dev Bot Payouts. The first two sections are USDC allocation previews, not claimable rewards or enabled payouts. Budgets start at zero and require owner input; no funds are deposited and no contracts are deployed by opening or previewing the panel.

Playback drafts group qualified weekly plays by verified artist wallet and distribute the selected budget proportionally with exact six-decimal token-unit rounding. Amounts below the selected minimum and rounding remainder stay unallocated. Unverified wallets are excluded. Current weeks remain provisional.

The proposed Top 10 policy ranks unique artist wallets by qualified weekly plays, ties by wallet address, and shares the prize budget equally among up to ten artists. It is explicitly a draft, not an adopted contractual promise. One artist receives at most one rank. Likes, historical announcement counts, and all-time totals are not used for allocation.

Read-only treasury status checks USDC approval, fund existence/activity and balances, plus the owner's Base ETH gas balance. Separate proposed fund slugs are `dbusk-playback` and `dbusk-top10`; the existing development fund is not used as the radio budget. These fund IDs are configuration only and are not automatically created or funded. Fund setup, eligibility review, finalized weekly receipts, replay protection, and artist payout authorization are required before enabling radio settlement.

For a $10 start, a conservative example is $3 for a playback pilot and $7 retained for gas/operations, with no cash Top 10 budget yet. Preserve free radio; seek supporter tips, small fixed-price sponsor slots, or optional paid requests before committing recurring cash rewards. Paid queues and sponsorship fulfillment need reviewed contracts and clear refund/service rules; neither is implemented by this payroll preview.

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
- Currency (a configured Base asset in `payroll-assets.json`)
- Confirmed transaction hash

Settlements update per-currency `<symbol>Pending` and `<symbol>Earned` account fields using that asset's configured ledger precision. Retired accounting is documented separately in the historical audit notes.

## Historical Records

Historical queue entries and account totals are preserved exactly for audit. Entries without currency remain historical ETH records in offline tooling, but are excluded from the active panel. They are not converted to USDC or paid again. Configured ERC-20 development rewards continue through the Base router.

## Contributor Requests

Use the Contributor Request issue form. It asks only for a GitHub handle, wallet, technical area, and optional work links. Opening the form posts a GitHub mention and Actions summary for the maintainer; there is no interview, biography, SMTP secret, or third-party notification dependency. After approval, being assigned to a bounty and opening a linked PR is enough to earn the issue's configured token credit when the PR merges.

## Local Verification

```bash
node scripts/validatePayrollQueue.js
node --test test/payroll.test.js test/commentArt.test.js test/automation.test.js
```