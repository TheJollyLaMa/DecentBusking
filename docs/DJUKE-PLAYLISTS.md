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
DJuke v0.4 address/version; the current configuration remains disabled. The batch-aware gas-quote signer and durable batch-event/refund reconciler are implemented behind explicit v0.4 environment gates. The worker reports radio readiness false and does not expose playlist gas quotes until the end-to-end worker rehearsal and reviewed deployment are complete; radio checkout therefore remains hidden. There is
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
