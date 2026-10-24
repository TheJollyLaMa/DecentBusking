# DVert paid advert requests

## Standalone controller boundary

The cloneable DVert product is maintained at
<https://github.com/A-Decent-Agency/DVert> (display identity:
`DVert.decentagency.eth`). This is not a new backend or contract deployment.
Its source lock records an exact DecentBusking commit and per-file hashes.

`devert-site.mjs` is the production site's sole DVert startup module. It passes
the existing radio adapter to the same campaign, two-tier queue and history
controllers. The controllers are import-safe: importing them does not initialize
the site player, connect a wallet or mount a second header. Optional environment
arguments scope DOM lookup, event listeners, timers, fetch, payment notifications
and wallet signing to an embedding host. Without those arguments the existing
site behavior, services, prices, settlement and refund eligibility are unchanged.
Each initializer returns a cleanup controller; an embedding lifecycle must also
abort its injected listeners/requests and clear its timers.

The standalone wrapper consumes DecentHead's existing wallet session. Signer
acquisition is an explicit checkout/submission/removal action, never a mount
effect. Binary ad upload requires an explicit host capability: DecentHead's JSON
backup `upload()` API must not receive a File or Blob. Missing capabilities and
backend availability remain errors, not simulated successful purchases.

This is separate from campaign purchases, ordinary advert rotation, and DJuke
song payments. Campaigns remain **$5 USDC for one week** of ordinary rotation.
Priority payments are optional extras for an existing active approved campaign;
they never purchase, renew or extend the campaign itself.

## Panel controls

DVert follows the DJuke machine layout: a two-price LCD, paid queue, advert
search/selection, and **Queue Ad** / **After This Song** buttons. Search matches
active approved campaign titles, creator names when available, advertiser
addresses, and campaign IDs. The first button uses the next normal ad break;
the second costs twice as much for after-song priority. Detailed terms stay
in the information dialog; ordinary rotation, wallet ads, campaign tools and
the price model are collapsed until requested.
Wallet connection uses the page header, not a second connect control in DVert.
Campaign and priority checkout follow that shared wallet and its network changes.

The orangutan/TV icon toggles the live 24/7 VertLoop audio/video feed, hushing
main radio only for this listener. Its hover/focus help explains the switch.
Clicking again or closing DVert returns to main radio. Video and voting
controls appear only while listening to VertLoop.

Refund claim controls are intentionally absent from this simplified panel.
Removal refund eligibility, contract claims and the exported
`claimDevertRefund` helper remain unchanged for later recovery tooling.
Payment receipts still identify the request and transaction.
Confirmed purchases refresh the panel automatically. The shared next-ad notice
identifies paid queued adverts, after-song priority, protected-show deferrals,
and playback delays. The radio audio graph is reused across audio/video advert
handoffs, so regular radio resumes without a page refresh.

Checkout is temporarily disabled when the main radio or required local checkpoint
mirror is offline. Existing on-chain requests remain queued and retry automatically
when service returns; they must not be purchased a second time. Run the configured
local mirror with `cd discord-bot && npm run checkpoint-mirror -- --watch`, keeping
local Kubo running. A disconnected mirror deliberately blocks playback rather than
bypassing the durable payment journal. For a $2 completed paid play, the existing
router distributes $0.90 to Top 10, $0.90 to playback, $0.16 to pinners, and $0.04
to repo development. Those are confirmed fund deposits only after settlement,
not at checkout.

The green and teal priority buttons have a staggered shimmer (disabled for
reduced-motion preferences). Both tiers use the shared payment celebrations
after the Base transaction confirms and its request event is decoded, with the
actual USDC charge and a transaction link. Token approvals, pending payments
and failed/reconciliation-needed receipts do not trigger a celebration.
Weekly campaign purchases already use the same celebration system.

**Ad Funding History** is a collapsed, public, read-only ledger view. It groups
confirmed advert fund deposits by transaction, shows exact indexed allocations
and their fund IDs, and links to the transaction event logs and Base settlement
router. Campaign purchases and paid-play settlements are labeled separately;
missing historical advert titles are not guessed. Totals exclude queue escrow,
non-advert funding and final fund-beneficiary payouts. It loads on demand from
`/api/funds`, with ten transactions per page and explicit indexing/error states.

## Deployment status

- Replacement Base v0.2 queue: [`0xe54609f022A8D760417E7cc0Eea6360b6E1D11Bb`](https://basescan.org/address/0xe54609f022A8D760417E7cc0Eea6360b6E1D11Bb#code), source verified.
- Replacement deployment: [`0x48e8c5ce12cefc8a735e9af016d5475ac290db50e2924bba9d54fd9fc58b5240`](https://basescan.org/tx/0x48e8c5ce12cefc8a735e9af016d5475ac290db50e2924bba9d54fd9fc58b5240), block 52723789.
- Legacy v0.1 queue: [`0x9ebf98367319E6c8b15b5517d808CCfEb3dddA61`](https://basescan.org/address/0x9ebf98367319E6c8b15b5517d808CCfEb3dddA61#code). Its pending count and USDC reserves were verified empty before replacement deployment.
- Admin: `0x807061DF657A7697c04045dA7d16D941861cAABc`.
- Fulfiller: `0x4894698f2B5cAF13Fad4Aa8fbaFE3618b960909F`.
- Fork rehearsal passed against deployed USDC, campaign source and settlement router.
- The deployed v0.1 single-tier contract passed controlled mainnet acceptance,
  but its priority timing did not match the clarified two-tier policy below.
- Public checkout was initially disabled on 2026-10-17 with
  `DEVERT_QUEUE_PAYMENTS_ENABLED=false`. Regular campaigns and radio continued.
- Replacement v0.2 supports separate normal-break bumps and double-price
  immediate requests. The owner subsequently authorized public rollout with
  `DEVERT_QUEUE_PAYMENTS_ENABLED=true`, explicitly waiving the two controlled
  live acceptance purchases. Automated checkout, scheduling, playback and
  recovery checks passed. No acceptance purchases were made for that rollout.
  A subsequent real $2 immediate request completed the live playback-to-settlement
  path on 2026-10-19 after the offline local mirror was restored (details below).
  Do not enable checkout against v0.1.

### v0.2 paid-request recovery - 2026-10-19

Request #0 for campaign #2 was confirmed on-chain as a $2 immediate-tier request,
but could not reserve playback while the required local checkpoint client was
offline. Restoring that client allowed the existing scheduler to pick it up
without a second purchase or manual fulfillment.

- Worker playback began at 13:43:19 UTC; regular music resumed at 13:43:55 UTC.
- [Automatic settlement](https://basescan.org/tx/0x1ee0c8c9921ba8582dc0ffe5d5b5b1799e941792bcef0db073fed433e16676df), block 52814043.
- All four public fund ledgers confirmed $0.90 playback, $0.90 Top 10,
  $0.16 pinners and $0.04 repo development, attributed to request #0.
- The on-chain pending queue was verified empty afterward.

This verifies recovery and settlement on the existing live worker. The new
checkout availability gate, paid countdown notices and browser audio handoff fix
still require deploying the updated worker and static site together.

### Historical v0.1 live acceptance - 2026-10-17

One authorized $1 USDC request purchased campaign #2 as request #0:

- [Purchase transaction](https://basescan.org/tx/0xd85a0f75fac058a88506aa421aeeb70ce4b2d11810fae7a501942c19eef32cf0), block 52722687.
- The current song finished before the paid advert started. The worker recorded
  26,189 ms of naturally completed audible playback, then regular music resumed.
- [Automatic settlement](https://basescan.org/tx/0xd3bb497a52c16d3854710e453ffe5f62c4e8a5229cc06b04a6129adf74e936cd), block 52722839.
- The receipt and all four public fund ledgers confirmed exactly 0.45 USDC to
  playback, 0.45 to Top 10, 0.08 to pinners, and 0.02 to repo development.
- The fulfilled playback journal was verified in both Pinata and the operator's
  recursive local IPFS pins at
  `bafkreicg644a6ume35sonabso6h3bnxomfbdsibc7dishn5oo2qa4adsue`.
  Its play ID hashes to the settlement's unique playback proof.
- The request is fulfilled and the pending queue is empty. No manual fulfillment
  or second paid request was used.

Refunds passed unit tests and a Base-fork rehearsal using the deployed USDC,
campaign source and router. No live campaign was removed for refund testing;
that would require separately authorized disposable campaign funding.

## Agreed policy

- Native USDC on Base. Anyone may request an active, approved campaign.
- Base queue price: $1 times `2 ** floor(pendingCount / 7)`, counting both tiers.
  A **queue bump** costs that quote and replaces the first available slot at a
  normally scheduled main-radio advert break, without adding another break.
  A displaced ordinary advert remains eligible for subsequent rotation.
- **Play after this song** costs exactly **2x the current queue price** and buys
  an extra break after the current recording. It preserves ordinary advert
  reservations and does not reset the normal-break cadence.
- Immediate requests take priority over bumps; each tier remains FIFO. A new
  immediate request can preempt a bump being prepared, but never interrupt
  audio already playing. Multiple immediate requests wait in FIFO order.
  Both tiers defer throughout protected Top 10/live programming.
- At most 128 outstanding queue positions; the ID scan window is also bounded
  to 128, so an old pending bump can temporarily fill the window even if later
  immediate requests settle. Checkout approves only the current exact tier
  price; the contract enforces the payer's maximum price.
- Purchased title, advertiser and media URI are immutable request snapshots.
  Campaign expiry does not invalidate a purchased play.
- USDC remains reserved in the queue until the radio fulfiller reports a
  naturally finished audible play. Then 45% goes to Top 10, 45% playback, 8%
  pinners and 2% repo development through the existing router.
- Removed campaigns leave the playable queue. Only each original payer can
  claim their full unplayed request payment. Refunds work while paused.
  No general admin withdrawal is available.

## Trust and failure behavior

The fulfiller is trusted to attest radio playback, approve catalog-matched
campaigns, and mirror authorized campaign removals on-chain. An on-chain
transaction cannot independently prove Discord audio delivery. This follows
DJuke's worker-attestation model; it is not trustless proof of listening.
Approval matches the existing verified NFT/advert catalog before the worker
marks a campaign queueable.

The worker checkpoints reservation and completed playback to Pinata and the
checkpoint mirror before settling. A unique proof and on-chain FIFO head
prevent duplicate/out-of-order settlement. Failed fetches, interruption,
reverted settlement, or worker restart do not release the payment. A lost
playback checkpoint can result in replay, not a second charge.

The paid-ad journal explicitly requires local mirroring before publishing each
checkpoint. If the mirror is offline, fails to pin, or returns a different CID,
the journal save fails and the paid request does not advance. Other existing
checkpoint stores retain their normal best-effort community mirror behavior.
Run `node checkpoint-mirror-client.js --watch` from `discord-bot` on the operator
Mac, with IPFS Desktop running and the same `CHECKPOINT_MIRROR_SECRET` as Render.
The helper accepts playlist checkpoints and validated paid-playback journals.
It must remain running for paid-ad playback and settlement.
The replacement journal's filename and metadata kind include its contract
address, so request #0 from the new deployment cannot reuse the old journal.

Removal is cross-system: the durable campaign-removal ledger is updated first,
then the queue contract is reconciled. Failure is reported rather than showing
a completed refund. The worker blocks new starts for the campaign and defers
on-chain removal while its paid request is playing or has finished but is not
yet settled. Interrupted playback returns to the queue; naturally completed
playback is settled before removal can make an unplayed request refundable.
Periodic reconciliation retries even during protected shows. Payers must wait
for confirmed on-chain removal to claim.

There is no automatic timeout refund for a stalled worker: paid plays survive
campaign expiry by agreement. Admin must remove a campaign to authorize
unplayed refunds if service cannot be delivered. Worker gas is operator-funded
in this version; there is no extra ETH contribution charged to buyers.

## Deployment checklist (separate authorization required)

Contract sources and tests live in the sibling **DecentMarket** repository:

- `contracts/DeVertQueue_v0.2.sol` (v0.1 is retained unchanged for verification)
- `test/DeVertQueue_v02.test.js`
- `scripts/deploy_devert_queue.js`

Do not modify or redeploy the existing campaign contract. Its deployed ABI is
the queue's read-only campaign source.

1. Run `npx hardhat test test/DeVertQueue_v01.test.js test/DeVertQueue_v02.test.js` in DecentMarket.
2. Rehearse against a Base fork and review roles, native USDC, campaign address,
   router, four active fund IDs, splits, approvals, refunds and settlement.
   Run `BASE_FORK_RPC=https://mainnet.base.org npx hardhat test test/DeVertQueue_base_fork.test.js`.
   The test mines a local block before contract calls to avoid historical-block
   execution limitations in the installed Hardhat/EDR runtime.
3. Run the deploy script on Base with `DEVERT_QUEUE_VERSION=2` and **without**
   `CONFIRM_DEPLOY=yes` for dry-run
   checks. Set `DBUSK_ADMIN` to the intended admin's public address; dry runs
   require no signing key. Only after separate approval, broadcast with that
   flag and a matching admin signer. Use a separate worker wallet in
   `DBUSK_FULFILLER`, with sufficient Base ETH.
   Drain the v0.1 queue before switching contracts; do not migrate unpaid
   promises or strand refunds. The script checks the legacy pending count and
   reserved USDC and writes a separate `devert-queue-v02-base.json` record.
4. Publish/verify the new source on Basescan/Sourcify using the recorded compiler
   settings and constructor arguments. Record its deployment address/block in
   contract documentation.
   Use `ETHERSCAN_API_KEY` for Etherscan V2; legacy explorer-specific keys use
   deprecated V1 endpoints.
5. Worker: set the replacement `DEVERT_QUEUE_CONTRACT_ADDRESS`,
   `DEVERT_QUEUE_VERSION=2`, and keep
   `DEVERT_QUEUE_PAYMENTS_ENABLED=false` initially. The queue worker uses
   `DEVERT_SCHEDULER_PRIVATE_KEY` (or existing `DJUKE_FULFILLER_PRIVATE_KEY`),
   `PINATA_JWT`, and the checkpoint mirror. Missing durable storage leaves the
   queue read-only. The worker verifies its fulfiller role and campaign source.
   Version 1 remains supported only for fulfilling already-purchased legacy
   requests; it can never enable new public checkout. The fund ledger retains
   the legacy contract so the first live acceptance settlement stays labelled
   as an advert, not a generic sponsor.
6. Website: set `devertQueueContractAddress` in the public configuration.
   No key belongs in the website. The new address is included in the worker's
   read-only RPC allow-list from its environment configuration.
7. Confirm catalog approval and removal reconciliation. Verify a controlled
   live paid request in each tier, natural completion, 45/45/8/2 funding, durable mirrored
   playback evidence and an empty queue after settlement. Protected-show
   deferral, interruption/restart recovery and removal refunds must also pass
   the automated unit/fork checks. A live removal/refund rehearsal requires
   separate authorization for a disposable campaign; do not remove a real
   campaign for testing. Then enable `DEVERT_QUEUE_PAYMENTS_ENABLED=true`,
   redeploy, and confirm checkout readiness and no replay of the settled request.
   The earlier $1 v0.1 live test is historical evidence, not acceptance of the
   new two-tier scheduling contract. Additional live spending requires approval.
   For the 2026-10-17 public rollout, the owner explicitly waived the controlled
   live purchases; retain this acceptance gap in the rollout record rather than
   marking those tests passed.

The public endpoint is `GET /api/devert/queue`. Snapshots use a fixed Base block
with at least two confirmations, verify price/count/token, and detect reorgs.
Recent refunds cover a bounded recent history; any older refund can still be
claimed using its numeric request ID from the payer's transaction receipt.
The checkout includes a receipt link and request ID after confirmation.

No mainnet deployment or payments are performed by the implementation tests.
