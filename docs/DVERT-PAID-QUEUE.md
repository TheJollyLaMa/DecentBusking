# DVert paid advert requests

This is separate from campaign purchases, ordinary advert rotation, and DJuke
song payments. Campaigns remain **$5 USDC for one week** of ordinary rotation.
Priority payments are optional extras for an existing active approved campaign;
they never purchase, renew or extend the campaign itself.

## Deployment status

- Replacement Base v0.2 queue: [`0xe54609f022A8D760417E7cc0Eea6360b6E1D11Bb`](https://basescan.org/address/0xe54609f022A8D760417E7cc0Eea6360b6E1D11Bb#code), source verified.
- Replacement deployment: [`0x48e8c5ce12cefc8a735e9af016d5475ac290db50e2924bba9d54fd9fc58b5240`](https://basescan.org/tx/0x48e8c5ce12cefc8a735e9af016d5475ac290db50e2924bba9d54fd9fc58b5240), block 52723789.
- Legacy v0.1 queue: [`0x9ebf98367319E6c8b15b5517d808CCfEb3dddA61`](https://basescan.org/address/0x9ebf98367319E6c8b15b5517d808CCfEb3dddA61#code). Its pending count and USDC reserves were verified empty before replacement deployment.
- Admin: `0x807061DF657A7697c04045dA7d16D941861cAABc`.
- Fulfiller: `0x4894698f2B5cAF13Fad4Aa8fbaFE3618b960909F`.
- Fork rehearsal passed against deployed USDC, campaign source and settlement router.
- The deployed v0.1 single-tier contract passed controlled mainnet acceptance,
  but its priority timing did not match the clarified two-tier policy below.
- Public checkout was disabled on 2026-10-17 with
  `DEVERT_QUEUE_PAYMENTS_ENABLED=false`. Regular campaigns and radio continue.
- Replacement v0.2 supports separate normal-break bumps and double-price
  immediate requests. It is deployed **read-only**, pending separately approved
  live acceptance of both tiers. Do not enable checkout against v0.1.

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
a completed refund. Periodic reconciliation retries even during protected
shows. Payers must wait for confirmed on-chain removal to claim.

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

The public endpoint is `GET /api/devert/queue`. Snapshots use a fixed Base block
with at least two confirmations, verify price/count/token, and detect reorgs.
Recent refunds cover a bounded recent history; any older refund can still be
claimed using its numeric request ID from the payer's transaction receipt.
The checkout includes a receipt link and request ID after confirmation.

No mainnet deployment or payments are performed by the implementation tests.
