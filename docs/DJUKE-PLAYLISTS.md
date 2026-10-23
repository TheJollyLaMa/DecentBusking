# Named DJuke playlists — rollout decisions

Issue #241 adds a profile-backed playlist library. Names are 1–60 characters;
playlist IDs are stable 128-bit hex IDs, names need not be globally unique, and
results identify the maker and full ID. A playlist contains 1–24 distinct
registered DJuke song IDs in a user-reviewed order. Each profile may make and/or
save at most 20 playlists. A maker may append an immutable revision; other
wallets pin the exact revision and ordered song IDs, never a moving pointer.
Only the maker can publish a new revision. A saved copy preserves maker, ID,
revision, and attribution.

Every profile-library write is wallet-signed over the action, exact playlist ID/name/maker/song
order/revision (or copy ID/revision), requesting origin, one-time nonce, and an
expiry no more than five minutes away. The worker validates the allowed origin,
wallet, signature, expiry, nonce, maker ownership, revision sequence, and profile
cap before checkpointing. Discovery is public and read-only. Watchlist entries
remain separate NFT bookmarks and are grouped by artist; adding to a playlist
never silently changes Watchlist content. Top 10 has two distinct actions: **+**
opens a compact selector for the current draft, saved named playlists, or an inline
new-playlist name; **👀** saves the verified song/artist NFT to the watchlist.
Music-card `dbusk-playlist-add` events use the same selector. Draft-only additions
are local; a saved original appends a new immutable revision through the existing
signed profile save API and loads it into the draft. A saved copy is never edited:
adding creates a new original owned by the current wallet, retaining the old copy.
These saves require wallet authorization, not a payment. The legacy personal-listen
cart retains its 50-song cap; only named saves and named checkouts require 1–24.

## Prices and settlement

Private checkout sums each song's normal creator/album listen price (0.25 USDC
default), with no platform fee and no radio request. Radio subtotal is the sum of
`250000 << floor(i / 8)` USDC base units for zero-based playlist index i: songs
1–8 cost $0.25 each, 9–16 $0.50 each, 17–24 $1 each. Radio platform fee is
**$3 × ceil(n / 12)**, split equally 25/25/25/25 across Playback, Top10, Pinners,
and Repo funds (rounding remainder to Repo). Examples: 8 songs $2 + $3; 12 songs
$4 + $3; 24 songs $14 + $6 = **$20**. Pricing is independent of queue depth.
The UI mirrors this formula for display and prefers on-chain `quotePlaylist`
when a configured contract and provider are available; checkout always quotes
on-chain (radio via the signed worker endpoint). Private creator prices may differ
from the local default estimate.

Each delivered radio song settles 90% directly to artists/collaborators, 8% to
pinners, and 2% to Repo, separately from the platform fee. The entire platform fee
is reserved until every song is delivered, then settled once to the four funds.
`refundUndeliveredPlaylist(batchId)` refunds pending song amounts and the entire
reserved fee; delivered songs retain their settlement. Refunded lane items advance
the lane head rather than blocking later batches. Durable events track
`PlaylistBatchRequested(..., firstLaneId)`, `PlaylistSongDelivered`,
`PlaylistSongRefunded`, `PlaylistBatchFeeSettled`, and `PlaylistBatchFeeRefunded`.
Lane journals use schema 2; old FIFO-batch schema 1 must not be silently replayed
as lane IDs. UI/worker must use confirmed events, never transaction submission,
for settled/refunded state.

Worker gas remains separate: the EIP-712 `PlaylistGasQuote` uses domain
DecentJukeBox / 0.2 and binds listener, ordered-song hash, max total, per-song
fulfillment cost, nonce, and deadline. Checkout forwards exactly
`fulfillmentCostWei * 2 * n` native ETH to the gas worker immediately. This is
not refunded by a later USDC batch refund. The endpoint sizes a
`fulfillPlaylistSong` transaction, returns on-chain subtotal/fee, and accepts
1–24 distinct songs. The UI shows this full contribution before confirmation;
initial USDC allowance may require a separate approval.

## Playback and scheduling

Radio playlists occupy a **separate playlist lane**, never the main paid FIFO.
Normal paid requests always cut in before pending playlist songs. The worker reads
main requests first and `playlistHeadId` / `playlistNextId` / `getPlaylistItem` at
the same confirmed block. It claims only the playlist lane head when main pending
is zero, and calls `fulfillPlaylistSong(laneId, expectedSongId, expectedRevision,
playbackProof)` only after audible completion. Lane recordings are immutable
(expected revision 0). If a main request arrives during playback, settlement waits
until the main queue clears; proof is retained durably, not discarded or replayed.
The contract independently enforces the same cut-in rule. Refund recovery calls
`refundUndeliveredPlaylist(batchId)`, not a main-request refund. Main request IDs
and playlist lane IDs have distinct durable journal identities. `pendingCount`
remains main-only; main quote tiering uses main + playlist pending. This does not
interrupt current audio or preempt protected Top 10, live, or scheduled shows;
existing DVert break policy remains unchanged.

## Rollout and safety

Named private and radio checkout are capability-gated on an explicitly configured compatible
DJuke v0.4 address/version; the current configuration remains disabled. The batch-aware gas-quote signer and durable batch-event/refund reconciler are implemented behind explicit v0.4 environment gates. Readiness requires matching main/batch v0.4 configuration, an explicit nonnegative batch start block, durable batch events and audible-playback journals, verified Base/v0.4/gas-worker/fulfiller permissions, enabled payments, and an available local checkpoint mirror. Signing rejects requests until those checks pass. The browser also requires its own explicit radio-ready flag and matching worker readiness/address; radio checkout therefore remains hidden on the current deployment. There is
no fallback to repeated tier-priced requests, private listens plus unpaid radio
items, or creator-price overrides. Existing single-song checkout, creator-priced
personal listens/albums, Watchlist, and DeVert behavior remain on their current
paths.

**No deployment, migration, allowance, or fund movement is approved here.**
Before enabling any feature, obtain separate steward approval, independently
review the new module and DJuke deployment, verify all four router fund IDs and
token decimals, publish matching compiler/optimizer settings and ABIs, test on a
fork, configure the exact deployed version/address, verify the durable event reconciler and restart recovery, and validate one controlled private and radio batch plus full refund. Do not enable radio checkout until the worker has
verified batch receipts, lane cut-in scheduling, durable audible-completion
proofs, fee settlement, and the lane refund path. Rehearse migration with zero
live writes; no existing queue or creator-set price is changed by this code.

## Rehearsing the worker before review

From the matching DecentMarket review checkout, set `BUSKING_WORKTREE` to this
DecentBusking checkout and run:

```sh
BUSKING_WORKTREE=/absolute/path/to/DecentBusking \
  npx hardhat run scripts/rehearse_djuke_v04_worker.js
```

This deploys the real v0.4/module bytecode to an in-process Base-chain-ID fixture,
with mock token/router/L1-fee oracle and Hardhat's synthetic gas schedule. It calls
the actual HTTP request handler, quote signer, confirmed queue reader, playback
journal, runtime, fulfiller, and batch-event reconciler. Assertions cover a
12-song $7 checkout in order, direct collaborator payouts, all four funds,
restart before playback completion, retained audible proof across a main-request
cut-in and restart, a full $3.50 refund, and a $3.25 suffix-plus-fee refund after
short playback (the delivered prefix remains paid).

For the live-catalog migration and real USDC/router/L1 oracle on a local fork:

```sh
BASE_FORK_RPC=https://mainnet.base.org \
BUSKING_WORKTREE=/absolute/path/to/DecentBusking \
  npx hardhat run scripts/rehearse_djuke_v04_fork.js
```

The existing source preflight requires payments disabled unless
`REHEARSE_WITH_PAYMENTS_ENABLED=1` explicitly permits a **read-only source
snapshot** while payments are enabled. It still refuses a nonempty source
queue. All deployments, approvals, payments, pauses, and refunds execute only on
the in-process fork. The fork uses the upstream RPC's read-only fee recommendation
instead of Hardhat's synthetic priority fee; contract state and L1-fee estimation
remain on the fork. Neither command connects a Discord client, submits real Base
transactions, changes production configuration, or proves real audio delivery.
A controlled playback smoke test and steward approval are still required before
production activation.

Public DJuke catalog/queue reads never wait for mirrored batch-event writes.
Only paid playback reconciliation requires those writes, and empty block scans
advance the in-memory cursor without uploading another checkpoint. Failed event
writes restore the prior cursor/state so the next attempt replays the events.
The local checkpoint mirror client must include schema-2 playlist-batch journal
support; older clients reject these jobs and cannot enable reliable paid playback.
The same authenticated queue also carries booking, scheduled-playlist, Friday
Top 10 and radio-announcement checkpoints. The client validates these supported
formats too, so an unrelated scheduled-production job cannot starve paid journals.
All accepted jobs still require matching content CIDs and verified recursive
local pins before acknowledgment.
