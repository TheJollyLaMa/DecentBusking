# Live Performance — operator runbook

Refs #210, Refs #223. First target: **Friday October 23, 2026, 9–10 pm America/New_York (EDT)** = **October 24, 01:00–02:00 UTC**. Occurrence ID: `friday-live-performance:2026-10-23`.

**This document and PR do not authorize production booking writes, pinning, signing, deployment, deposits, payouts, refunds or schedule changes. No such actions were performed.** An owner must approve and perform tomorrow’s operations. Do not run the bot in this worktree against production secrets.

## Phase 0 — required for tomorrow

Use only deployed Base settlement router `0x8ecca903e2a6Daa8CCbB933700e4F2C58C44A4B5` and Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. Its fund is **earmarked, NOT escrowed**; admin can still `recoverFund`. There is **no performer claim** in Phase 0. Admin push-payment after review is the explicitly temporary deployed-contract path, not a competing Phase 1 design.

### Before the show (owner actions, in this order)

1. Deploy reviewed site/worker software through the normal separately authorized release process. Phase 1 escrow is deployed at `0x20C08F2e877389D68cFbcF49664211E8CE9554Ec` (start block 52942855) and configured on the worker, so the admin panel shows **Phase 1 configured**. Phase 0 bookings still use the router and remain **earmarked, NOT escrowed**; choose the mode deliberately per booking. Ensure booking and schedule Pinata checkpoint restore works and required mirror is online. Public GET `/api/live-bookings` must be ready. Worker enforces `MINT_OWNER_WALLET`, allowed origin, signed command, timestamp and durable revision server-side; hiding the panel is not authorization.
2. Resolve **jose.metagame.wtf** again through existing `discord-bot/ens-resolver.js` / worker `/api/ens/resolve?name=jose.metagame.wtf`. Observed via that resolver on **2026-10-22 11:09 UTC**: `0x29185eB8cfD22Aa719529217bFbadE61677e0Ad2`. This is an observation, **not a hard-coded booking recipient**; verify the current forward resolution and confirm it with the performer before signing. Discord handle: **joseacabrerav**. Agree the public display name with Jose.
3. Steward must approve the precise per-booking agreement (below remains **DRAFT v1**). Set review window, cancellation window/kill fee, deadline, rights and remainder handling explicitly. Phase 0 text must replace any statement promising locked escrow with honest earmarking/recoverFund disclosure. Do not treat draft 72h/25% as agreed policy. Owner separately authorizes pinning exact terms JSON/text to IPFS, records its keccak256 hash, immutable `ipfs://` URI and version.
4. In **Admin → Live Performance**, create a draft by ENS, public name, Discord handle, fee **20 USDC** (`20000000` units), Base **8453**, title, terms/version/hash/URI, agreed parameters, and the exact occurrence above with New York **2026-10-23 21:00–22:00**. This creates a durable booking only, **not a financial transaction**. Owner signs the explicit `DecentBusking Live Performance authorization v1` personal-sign command. Draft is public; do not enter private notes.
5. Use **Show acknowledgement message**. Jose personally signs that exact `DecentBusking Live Performance agreement v1` message using the verified performer wallet. It includes booking/occurrence, slot, units, mode, terms hash/link, policy and claim deadline. This is a message, not a token approval or transaction; never ask for a seed/private key. After steward approval, owner uses **Record approved terms + performer acknowledgement**, pastes Jose’s signature, confirms exact terms approved, and signs the owner command. Funding is rejected without both acknowledgements.
6. Separately approve/pin fund metadata JSON including slug `dbusk-live-performers`, occurrence/booking ID, title, resolved wallet and ENS, Discord handle if public, fee/asset/network, slot, terms hash/version/URI, and **earmarked, NOT escrowed; admin recoverFund remains possible**. No automatic production pin occurs in this panel. Record its immutable `ipfs://` URI.
7. **Owner transaction #1** (only if absent): **Create Live Performers fund** → `createFund(id('dbusk-live-performers'), pinnedMetadataUri)`. Check Base, router, fund ID and URI in the wallet. Existing fund: do not create again or assume metadata can be overwritten; publish new booking metadata separately.
8. **Owner transaction #2** (only if necessary): exact USDC `approve(router, 20000000)` if current allowance is insufficient. Never unlimited approval. **Owner transaction #3:** **Fund booking** → `fundToken(id('dbusk-live-performers'), USDC, 20000000)`. The browser records the tx hash immediately for recovery. Each transaction may also require a separate owner personal-sign reconciliation command. Wait for **two Base confirmations** and matching router FundFunded evidence before the booking says **funded**. Pending/reverted/mismatched receipts are not funded. Never click fund again because the page timed out; use **Reconcile transaction** with the original hash.
9. **Link / retry schedule occurrence** (owner signs schedule-link booking command). This writes the dated high-priority occurrence with the booked performer in the title through the shared durable schedule. Confirm `/api/radio/schedule`, public calendar, booking schedule status **synced**, and public **left ankh → Community Funds → 🎤 Live Performers** show Jose, date, 20 USDC, honest earmarked label and tx proof. No recurring series is replaced/deleted. Verify the next Friday still exists.
10. Soundcheck and run the show. A funding tx and schedule checkpoint are independent: the panel exposes incomplete linkage/retries, not a fictional atomic cross-system transaction.

### After the show

11. Prepare/pin public completion report (slot, performance, decision, reason, terms/booking references, exact approved amount and remainder disposition). In admin choose **Approve full**, **Approve partial**, or **Withhold / reject**. A report URI, public reason and explicit remainder disposition are required for every decision. Partial amount uses integer basis points and floors to six-decimal units. A recorded decision is **not payment**.
12. For tomorrow’s agreed **full $20 fee**, approve **10000 bps**. Verify Jose is an approved contributor in existing payroll/contributor registry; register only through the normal owner-approved payroll flow if needed (additional owner transaction). Use the verified contributor ID hash; do not invent one.
13. **Owner payout transaction:** **Execute recorded payment decision** uses deployed router `payout` (or existing payroll panel/batch with identical fields) from `id('dbusk-live-performers')`, USDC, resolved performer wallet, `20000000`, with exact work reference:
    `decentbusking:live:v1:8453:friday-live-performance:2026-10-23:<verified-lowercase-wallet>`
    Hash the string with `id()` for `workReference`. `completedWorkReferences` is checked before sending and prevents duplicate payment on-chain. Repository/contributor hashes must match the existing approved registry and report metadata hash must describe the actual pinned report. Wait for two confirmations; reconcile PayrollPaid matching fund, asset, wallet, work reference and approved amount. Pending approval/decision is never shown as received funds. Receipt appears in performer earnings **Live performances** with BaseScan proof.
14. For partial/withheld fees, publish the reason and exact approved/remainder units. Earmarked remainder is not an automatic refund. Owner separately approves any `recoverFund`/return or future earmark (the panel’s **Recover agreed remainder** sends only the recorded remainder back to the original owner/funder and requires confirmation); never claim a recovery occurred without chain proof. No unrequested financial operation is sent automatically.

### Cancellation / incident procedure

- **Cancel live performance** requires a public reason and explicit confirmation, then signs an owner command. It invokes the existing #227 dated-occurrence cancellation mechanism; the public cancellation retains artist/title, original time and reason. Normal radio continues; future Fridays remain. Verify public schedule and admin schedule **synced**. Refresh/reopen clients; existing calendar polling receives the shared schedule update.
- Financial consequences are **separate**. Panel displays the agreed proposed kill-fee amount and pending financial reconciliation. Phase 0 has no automatic contract kill fee or refund; **Reconcile financial cancellation** records a report/reason/disposition and the agreed fee, then **Execute recorded payment decision** and **Recover agreed remainder** each require a separate explicit owner transaction. Review agreed terms and actual deposits before authorizing either. No refund is fabricated.
- If a checkpoint fails, cancellation intent remains durable with **schedule failed**; retry linkage with **Link / retry schedule occurrence**, then verify public calendar/radio. Do not claim cancellation succeeded while schedule sync failed. During a slot, schedule cancellation works; Phase 1 pre-show cancel does not, so review/reject after end is required.
- Wrong network/account: signing is blocked. On a wallet/network change or failed signature, refresh and reconcile the original hash. Transactions that were submitted can still mine after UI errors. Local pending hashes survive reload; backend revisions and unique occurrence/booking/tx IDs prevent duplicate records; router completed work references prevent double payout.
- Worker restore errors disable mutations instead of seeding over unknown state. Never erase checkpoints or manually edit production state to “fix” a pending transaction.

## Phase 1 — capability-gated, no deployment authorization

Contract source/test companion: [DecentMarket PR #61](https://github.com/TheJollyLaMa/DecentMarket/pull/61), lives in **DecentMarket** because that repository already owns Hardhat/OpenZeppelin and DJuke/DVert sources. New `LivePerformanceEscrow` is **not deployed** by this work. After separately authorized review/deployment/verification only, configure worker `LIVE_PERFORMANCE_ESCROW_ADDRESS` **and deployment** `LIVE_PERFORMANCE_ESCROW_START_BLOCK`; register that address in Alchemy’s dashboard. Worker read proxy/webhook registration and event indexing are gated on that configuration. Browser learns the capability from `/api/live-bookings`, not an invented address.

Phase 1 owner approves exact USDC allowance then `createBooking` with all acknowledged parameters; confirmed BookingFunded evidence funds the booking. After end, owner `approve(id,bps,reportUri)` or `reject`/`markNoShow` before review-end. Partial remainder returns to original funder on-chain. Performer alone signs `claim`; undecided funds become automatically claimable after the agreed review window, before the agreed deadline. `expire` after the deadline returns only unclaimed funds to original funder. Late admin decisions cannot race auto-claim. Before start, platform cancellation may reserve agreed late kill fee for performer claim; performer cancellation fully refunds. Pausing blocks claims/refunds too: disclose this emergency liveness risk. No arbitrary admin withdrawal exists.

## Live Performance Agreement — **DRAFT v1, pending steward approval**

These are issue #210’s proposals, **not binding policy or acknowledgement**. Publish the precisely approved per-booking text and hash it; configure each parameter rather than silently adopting examples.

1. Slot: stated New York date/time, duration (proposed 60 minutes, 9–10pm) and Discord stage/voice stream target.
2. Minimum: proposed 45 audible live minutes of 60; start within proposed 10 minutes.
3. Content: original/licensed work; no hate, harassment or illegal content; Discord ToS; flag explicit content beforehand.
4. Technical: proposed soundcheck at least 15 minutes before; reasonable audio. Platform/Discord/bot outages do not reduce pay.
5. Recording/rights: proposed non-exclusive stream/archive/promotional clips permission with recording opt-out; performer retains ownership.
6. Payment: Phase 0 explicitly earmarked, NOT escrowed, recoverable by admin; Phase 1 genuinely escrowed. Proposed review window 72 hours followed by auto-claim; agree exact deadline and emergency pause/expiry effects.
7. Partial/no-show: proposed pro-rating below minimum; unnotified no-show refund to funder; proposed performer cancellation at least 24 hours ahead without penalty. State exact approved amount/reason/remainder.
8. Platform cancellation: proposed less-than-48-hour late window and 25% kill fee. Both configurable/agreed per booking; Phase 0 cannot enforce them on-chain.
9. Disputes: proposed public review using archive; raise in Discord within proposed 7 days.
10. Tips: listener tips/DJuke play earnings separate from fee and payable to performer.
11. Taxes: performer responsibility; on-chain payments public.

## Validation

`node --test test/*.test.js` (full DecentBusking suite). Focused lifecycle/API/claim/cancellation tests: `node --test test/live-bookings.test.js test/settlement-funds.test.js test/fund-ledger.test.js test/creator-profiles.test.js test/approval-safety.test.js`. Contract suite: `npx hardhat test test/*.test.js` in DecentMarket. See PR for exact results and inherited baseline failures. No tests use production writes/signers.

### Verification results for this change

- Focused booking/fund/profile/approval regression selector above: **52 passed**.
- Full DecentBusking suite: **818 tests, 816 passed, 2 inherited failures**. The unchanged DVert test expects obsolete `devert-paid-queue.mjs?v=20261017-mercury-release` while baseline already uses `20261019-radio-recovery`; unchanged Top10-hype fixture fails current-New-York-week chart validation before its expected checkpoint error. Both also fail in the isolated existing selector; related source/tests are unchanged.
- Full Solidity suite: **118 passed, 4 existing optional fork cases pending**; new escrow lifecycle/adversarial suite: **14 passed**.
- Worker/new-module syntax and `git diff --check` pass. No production state/signatures/pins/funds were created by validation.
