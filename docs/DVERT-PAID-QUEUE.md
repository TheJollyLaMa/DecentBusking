# DVert paid advert requests

This is separate from campaign purchases, ordinary advert rotation, and DJuke
song payments. The implementation is not enabled on mainnet until a new queue
contract is deployed, verified, funded with worker gas, and explicitly configured.

## Deployment status

- Base queue: [`0x9ebf98367319E6c8b15b5517d808CCfEb3dddA61`](https://basescan.org/address/0x9ebf98367319E6c8b15b5517d808CCfEb3dddA61#code), source verified.
- Deployment transaction: [`0x787351b818b6621bd1ced2606d825aab6b8d18fc40c6a455d370c14a5b0706bf`](https://basescan.org/tx/0x787351b818b6621bd1ced2606d825aab6b8d18fc40c6a455d370c14a5b0706bf), block 52722248.
- Admin: `0x807061DF657A7697c04045dA7d16D941861cAABc`.
- Fulfiller: `0x4894698f2B5cAF13Fad4Aa8fbaFE3618b960909F`.
- Fork rehearsal passed against deployed USDC, campaign source and settlement router.
- Public checkout remains disabled pending controlled live acceptance.

## Agreed policy

- Native USDC on Base. Anyone may request an active, approved campaign.
- Price: $1 times `2 ** floor(pendingCount / 7)`. At most 128 outstanding queue
  positions. Checkout approves only the current exact price; the contract
  enforces the payer's maximum price.
- FIFO paid adverts take an extra break after the current recording, without
  consuming an ordinary advert's reserved position. They never interrupt audio
  or protected Top 10/live programming. A paid item already being prepared is
  not preempted by a later purchase.
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

- `contracts/DeVertQueue_v0.1.sol`
- `test/DeVertQueue_v01.test.js`
- `scripts/deploy_devert_queue.js`

Do not modify or redeploy the existing campaign contract. Its deployed ABI is
the queue's read-only campaign source.

1. Run `npx hardhat test test/DeVertQueue_v01.test.js` in DecentMarket.
2. Rehearse against a Base fork and review roles, native USDC, campaign address,
   router, four active fund IDs, splits, approvals, refunds and settlement.
   Run `BASE_FORK_RPC=https://mainnet.base.org npx hardhat test test/DeVertQueue_base_fork.test.js`.
   The test mines a local block before contract calls to avoid historical-block
   execution limitations in the installed Hardhat/EDR runtime.
3. Run the deploy script on Base **without** `CONFIRM_DEPLOY=yes` for dry-run
   checks. Set `DBUSK_ADMIN` to the intended admin's public address; dry runs
   require no signing key. Only after separate approval, broadcast with that
   flag and a matching admin signer. Use a separate worker wallet in
   `DBUSK_FULFILLER`, with sufficient Base ETH.
4. Publish/verify the new source on Basescan/Sourcify using the recorded compiler
   settings and constructor arguments. Record its deployment address/block in
   contract documentation.
   Use `ETHERSCAN_API_KEY` for Etherscan V2; legacy explorer-specific keys use
   deprecated V1 endpoints.
5. Worker: set `DEVERT_QUEUE_CONTRACT_ADDRESS` and keep
   `DEVERT_QUEUE_PAYMENTS_ENABLED=false` initially. The queue worker uses
   `DEVERT_SCHEDULER_PRIVATE_KEY` (or existing `DJUKE_FULFILLER_PRIVATE_KEY`),
   `PINATA_JWT`, and the checkpoint mirror. Missing durable storage leaves the
   queue read-only. The worker verifies its fulfiller role and campaign source.
6. Website: set `devertQueueContractAddress` in the public configuration.
   No key belongs in the website. The new address is included in the worker's
   read-only RPC allow-list from its environment configuration.
7. Confirm catalog approval and removal reconciliation; verify a controlled
   paid request, protected-show deferral, natural completion, 45/45/8/2 funding,
   restart recovery and a removed-request refund. Then enable
   `DEVERT_QUEUE_PAYMENTS_ENABLED=true`.

The public endpoint is `GET /api/devert/queue`. Snapshots use a fixed Base block
with at least two confirmations, verify price/count/token, and detect reorgs.
Recent refunds cover a bounded recent history; any older refund can still be
claimed using its numeric request ID from the payer's transaction receipt.
The checkout includes a receipt link and request ID after confirmation.

No mainnet deployment or payments are performed by the implementation tests.
