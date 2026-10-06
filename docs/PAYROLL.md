# DecentBusking Payroll

## Base Payroll Panel

Active payroll is Base-only. Historical records are preserved outside the active queue; see [retired payroll history](LEGACY-PAYROLL.md). The public Left Ankh entry is Playback Tally; Admin Nft Mint and Payroll are visible only to the configured admin wallet. UI visibility does not replace transaction-level owner and role checks.

The panel includes Settlements Router, Playback Payroll, Top 10 Prize Payouts, Reviewed Weekly Settlement, then Repo Dev Bot Payouts. Budgets start at zero and require owner input. Opening or previewing the panel never moves funds. Current-week previews are provisional; only completed UTC weeks can produce reviewed receipts and owner-authorized payouts.

Playback drafts group qualified weekly plays by verified artist wallet and distribute the selected budget proportionally with exact six-decimal token-unit rounding. Amounts below the selected minimum and rounding remainder stay unallocated. Unverified wallets are excluded. Current weeks remain provisional.

The v1 Top 10 policy ranks unique artist wallets by qualified weekly plays, ties by wallet address, and shares the reviewed prize budget equally among up to ten artists. One artist receives at most one rank. Likes, historical announcement counts, and all-time totals are not used for allocation. The owner must review the actual recipients and amounts before finalization.

Read-only treasury status checks USDC approval, fund existence/activity and balances, plus the owner's Base ETH gas balance. Separate fund slugs are `dbusk-playback` and `dbusk-top10`; the development fund is not used as the radio budget. Funds are never automatically created or funded.

### USDC Deposits

Select an existing active fund in Settlements Router, enter the deposit amount, and confirm the deposit action. The app verifies native Base USDC, six decimals, asset approval, wallet balance, and Base network. It requests an ERC-20 approval only if the current allowance is insufficient, for the exact intended amount rather than an unlimited allowance; then it requests the `fundToken` transaction. Approval is not a deposit. Depositing into a fund is not an artist payout.

Pending approval/deposit stages and hashes are kept in browser storage. An unresolved operation locks another deposit to that fund. Check its receipt or supply the replacement transaction hash; unlocking requires a successful matching Approval/FundFunded event, or the exact recorded reverted transaction. An approval cannot unlock an operation already marked as a deposit. Unknown broadcasts remain locked for wallet-history review. This journal is browser-local: changing devices or clearing storage loses it, so always check wallet history before retrying an uncertain deposit.

### Reviewed Radio Settlement

1. Select a completed UTC week and review qualified plays, verified wallets, category budgets and minimum payout.
2. Finalize the selected positive-budget categories. The app freezes the allocation JSON to IPFS, including exact amounts, fund/router/asset, category and week. This signs an upload authorization, not a payout. Budgets or live counters changing later do not change the saved receipt.
3. Export the receipt backup. It contains the IPFS URI and metadata hash and can be imported on another browser after validation. Keep using the same receipt when resuming a partial settlement.
4. Confirm any missing recipient allowlist approvals separately. Enter the verified identity; the app does not infer identities from artist display names, overwrite another registered identity, or revoke other apps' recipients. Existing approved recipients need no approval transaction. The owner needs `CONTRIBUTOR_ADMIN_ROLE` for new approvals.
5. Settle the reviewed Playback or Top 10 receipt. Each unpaid recipient uses a separate router payout transaction. The app checks Base owner, `PAYROLL_ROLE`, native USDC approval, router pause state, active fund, exact reviewed totals and sufficient balance, then static-preflights each payout.
6. Refresh and resume the same receipt after any interruption. `completedWorkReferences` skips confirmed payments on-chain. References identify station/version/chain, week, category and recipient, not the amount or budget, so changing those does not permit paying that recipient twice for the same category/week.

Receipts are owner-reviewed, not trustless claims: the bot attests playback and the owner controls treasury/roles. The shared router enforces per-reference replay protection but does not freeze a station-wide weekly budget/root. Never finalize a different receipt for the same week/category on another device after partial payment; import the original backup. Different new recipients can otherwise create additional owner-authorized obligations. Amounts below the minimum remain in the fund as unallocated capital, not automatic artist arrears. Current-week and historical all-time counts cannot be paid through this flow.

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

The fund must be created and funded on the already-deployed shared router before token payouts can succeed. The Payroll panel's collapsible **Settlements Router** section can create this app's configured funds directly on Base:

1. Select Playback Payroll (`dbusk-playback`), Top 10 Prize Payouts (`dbusk-top10`), or Repo Dev Bot Payouts (`dbusk-repo-dev`). The fund ID is derived from that exact configured slug.
2. Review the metadata URI. It defaults to this site's payroll configuration with a fund-specific fragment; a valid HTTPS or IPFS URI can be supplied instead.
3. Refresh the fund status. Creation is enabled only when the connected configured admin wallet holds the router's `DEFAULT_ADMIN_ROLE` and the fund does not exist.
4. Click **Create Fund on Base** and confirm the transaction in the wallet. The panel rechecks the chain, account, deployed router, role, and existence, performs a static preflight, then waits for a successful receipt and verifies the created fund.
5. Use the USDC deposit controls to fund an existing active allocation. Creation itself deposits nothing and grants no roles.
6. For existing repo payouts, confirm the owner also has `PAYROLL_ROLE` and `CONTRIBUTOR_ADMIN_ROLE` on the shared router.

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