# Named DJuke playlists — rollout decisions

Queue-selection timeouts are scheduling deferrals, not playback failures. A
slow durable reservation remains in flight and is retained for the next selection
instead of repeatedly releasing and recreating its checkpoint. Before playback,
the worker revalidates its recording, pending status, and main-request priority.
Unheard selections discarded for a scheduled handoff or priority change are
released back to pending without refunding or settling the batch.
Permanently unavailable recordings and exhausted media retries still use
the refund safety net. A successful purchase is not evidence that the entire
playlist played; confirm delivery and refund events before reporting completion.

Paid playlists use the public radio's existing player, next-resource prefetcher,
changeover gap and priority checks, not a separate per-song payment/player loop.
The confirmed queue snapshot includes up to 24 consecutive playlist lane slots
(one maximum-sized playlist window). The next purchased song can be reserved
and prepared while the current song plays. Preparing it does not create a purchase
or settle its payment. It may start only after every preceding pending lane in the
window has a durable `played` or `fulfilled` journal record. A new main paid request,
refund, replacement or protected show still invalidates a prepared selection.

Settlement is single-flight and runs independently of playback selection. A slow
transaction no longer blocks preparation or the next song once clean playback
evidence is durable. Contract fulfillment remains head-only and ordered. A suffix
refund waits until preceding delivered songs have settled, so it cannot refund
their already-heard playback. The same guard applies when the next recording is
unplayable or missing locally, not just when media retries are exhausted.
Completed but unsettled journal records are not
replayed on restart.

Before decoding a paid playlist recording, the worker downloads its entire source
into a temporary local file. This avoids holding a backpressured HTTP connection
open for the duration of a song (or while its decoder is prefetched), which exposed
playback to gateway disconnects and repeated partial plays. Transfers have a
90-second deadline, a 256 MiB limit, and checks for empty/partial HTTP responses and
declared length mismatches. Failed downloads never start audio. Shutdown cancels
downloads; decoder closure removes each temporary file. Clean decoder EOF and
full PCM consumption are still required; buffering does not label damaged media
as delivered.

The standalone radio widget also preloads the published next source using the
same bounded blob downloader as the main website (80 MiB browser limit). It
finishes the current recording before handing off, consumes the prepared blob,
and will not restart an ended play ID just because polling repeats that state.
Preloads are cancelled on pause, station change, failure or destruction and are
disabled on data-saver/2G connections. An unavailable preload is logged and the
normal source remains available; it does not count as a paid delivery failure.

Failed journal completion, release and media-failure writes are retained in the
runtime and retried before queue selection and playback authorization. A transient
mirror failure therefore cannot strand a `playing` reservation after its radio
session loses the local reference, or replay an already-completed song merely
because its checkpoint needs retrying. Validation failures are not retained as
retryable writes. A process crash before evidence becomes durable still cannot
prove delivery; the existing conservative restart behavior remains.

While a known paid playlist remains unfinished, ordinary rotation is held rather
than starting unrelated music. The hold uses the verified remaining-lane count as
well as the journal; stale prefetched rotation is discarded at the handoff.
Status shows preparation/retry state and elapsed idle time, becoming recovering
when the existing watchdog threshold is exceeded instead of claiming preparation
indefinitely. The website distinguishes an incomplete-playback retry from preparing
the next song, and explicitly labels a paid hold longer than 30 seconds as delayed.
Slow durable storage or failed media can still introduce gaps;
this is not a promise of gapless streaming under failures.
Main paid requests, eligible advert breaks, and protected scheduled/live shows
retain their existing priority. Once the final paid delivery settles, ordinary
rotation resumes. A controlled worker shutdown releases reservations without
refunding the remaining batch.

Transient playlist media lookup errors, preparation timeouts, and interrupted or
insufficiently audible playback receive **three retries after the initial attempt**
before refunding the remaining batch (four failed media attempts total). Retry
counters are per song and durably stored in the playback journal, so restarts do
not reset the budget. Scheduling deferrals and slow checkpoint selection do not
consume it. Preparation retries back off for 5, 10, then 20 seconds and keep
ordinary rotation held; radio status explains the retry without requesting a new
payment. A partial recording is not settled as delivered, even if it ran for more
than 30 seconds. The fourth media failure invokes the existing version-specific
suffix/fee refund; v0.4 refunds the full reserved platform fee, not worker ETH or
wallet network gas. Refunds already completed are final and are not requeued.

### Verified audio completion (#274)

Paid delivery is no longer inferred from a mutable session-wide FFmpeg exit code
at the instant the player becomes Idle. Each prepared resource owns a PCM byte
counter and decoder lifecycle monitor. A clean completion requires consumed source
EOF, a successful matching decoder exit with no stream error or termination signal,
and consumption of all decoded PCM (within one 20 ms encoding frame). An EOF that
arrives just before the process exit notification waits at most one second for that
exit; missing evidence remains a failure, never an assumed delivery.
FFmpeg stops on decode errors instead of silently returning success for damaged
packets. Early player stops, incomplete streams and unconsumed decoded audio cannot
settle a playlist song. Scheduled handoffs and controlled shutdowns release a
reservation without spending its media retry budget. After four media failures,
recovery retries the suffix refund, not a fifth playback attempt, including after
a failed refund or restart.

Completion logs identify the play, track, paid request/attempt and decoder PID,
exit code/signal, source EOF/error, decoded PCM bytes/duration, consumed duration
and wall-clock audible time. Decoder stderr is drained but retained only as bounded
network/decode/timing categories and a byte count; raw media URLs or credentials
are not included. Playback checkpoint, settlement and deferred-selection timings
make bookkeeping gaps distinguishable from audio failures. Duration evidence is
decoded PCM, not an assumed trustworthy duration from a gateway response.

Profile → Playlists receipts include the failed song, sanitized failure category,
failed-attempt count and exhausted-retry status alongside the existing exact
on-chain delivered/refunded amounts. An already-refunded purchase is final; the
repair does not replay or recharge it.

The regression in `test/playlist-audio-completion.test.js` drives twelve actual
HTTP download → local FFmpeg → PCM → Opus → player → Idle completions through the
paid journal/runtime and the normal radio prefetcher. It blocks settlement until
all twelve songs have played and fails the fifth song's first completion checkpoint.
It checks twelve starts/deliveries exactly once and in order, one source download
per song, no refund, and transitions below two seconds with the intentional
2.5-second radio changeover sleep stubbed out. It does not inject successful audio
completion verdicts or establish production latency under slow durable storage.
Separate tests cover broken/oversized/timed-out downloads, retryable checkpoint
failures, main-request priority and safe suffix refunds.
A real player regression severs a preload's first HTTP transfer, verifies that no
partial audio starts, retains one preparation failure and its retry backoff, then
completes and settles the retried recording exactly once without a refund.
By default the playback regression uses short local WAV fixtures served over HTTP.
To repeat the incident-media check, download the
public CID `bafybeicgdqwqww2frcnmvjmitt5zvqivtg3vemyekr7johxlkkdllea4di`
and run:

```sh
DJUKE_INCIDENT_MEDIA=/path/to/recording.m4a node --test \
  --test-name-pattern='twelve real player EOFs' test/playlist-audio-completion.test.js
```

The file is served locally with byte-range support (required for seekable M4A)
and occupies the fifth slot. The October 24 check completed all twelve once, in
order, without a refund: the incident recording decoded 32,149,248 PCM bytes
(167,444 ms) and the player consumed 167,440 ms, within its 20 ms frame boundary.
This verifies the actual recording/player lifecycle, not a new production payment.
Successful local decoding does not identify the original gateway/network failure.
The latest production diagnostics below distinguish incomplete source consumption
from a successful EOF that only needs to wait for a decoder exit notification.

### October 24 refunded-attempt assessment

The latest BoogieNight attempt on v0.5
(`0xf51D2F7892cF9D49e14DF4afDf227a59ee170A51`, batch 1) reached the seventh
song, but only its first six songs were delivered. The deployed worker remained
at `abb78288f1cd8c1ff19f5163d1004f4b0c563f52`; the continuity changes above were
not deployed during this attempt.

- Lane 16, "Algorhythm", eventually completed cleanly at 12:42:24 UTC after
  incomplete attempts. Its completion checkpoint took 7.8 seconds and settlement
  another 16.2 seconds; the next song started 55.2 seconds after completion.
- Lane 17, "JollyBlueShadows", completed cleanly at 12:45:52 UTC. Its checkpoint
  took 3.1 seconds and settlement another 26.7 seconds; the next song started
  85.2 seconds after completion.
- Lane 18, "605 subterranean homesick blues", started at 12:47:18, 12:50:00,
  12:52:42 and 12:55:25 UTC. Each attempt failed `audio_stream_incomplete`, with
  network/decode warning categories, no source EOF and no decoder exit observed
  at the verdict. Decoded durations were 127231, 123903, 125993 and 127231 ms.
  The gaps before retries were approximately 35-38 seconds.
- At 12:57:35 UTC the fourth failure exhausted the existing retry budget. Lane 18
  and the five following songs were refunded, along with the unreleased 2 USDC
  of the original 3 USDC platform fee.
  Seven USDC Transfer logs in successful refund transaction
  `0xd4ad5bde2d723528061421073b252f75d57a7ecaf59226f1fca7c1b8fc78410d`
  total **4.50 USDC** returned to the payer: 2.50 USDC for six undelivered songs
  plus the unreleased 2 USDC fee. The first four deliveries had already released
  1 USDC to the funds, leaving 1.50 USDC in delivered-song payments and that
  1 USDC fee retained. This is partial completion followed by a suffix refund,
  not seven delivered songs or a new debit on every retry.

The exact seventh source,
`bafybeidvnpd2ossyprlglczisp7r2ynrrypkvcvh7keqw5sutw4jdld25i`, downloaded
successfully afterward: 1,131,222 bytes, mono 48 kHz AAC, container duration
127.722667 seconds. Local FFmpeg with `-xerror` decoded it without warnings or
errors into exactly 24,514,304 stereo PCM bytes (127,679 ms). The container duration
includes time not present in the decoded PCM, so the incident regression checks
the independently measured byte count rather than assuming container duration.
The production evidence supports a streaming-path failure; it does not
identify the exact gateway/network mechanism or prove that a partially heard
attempt was a clean delivery. Do not weaken EOF checks, increase the audible
replay budget, or recharge/requeue this refunded purchase as a workaround.

To include both actual incident recordings in the twelve-song regression, use
`DJUKE_INCIDENT_MEDIA` for Algorhythm (fifth slot) and `DJUKE_REFUND_MEDIA` for
the refunded seventh song (seventh slot). The other ten sources remain short
WAV fixtures, and the player consumes both incident recordings in real time.
The test still blocks settlement until all twelve complete, fails the fifth
completion checkpoint once, and requires twelve ordered starts/deliveries, one
download each, clean EOFs and no refund.
The targeted rerun with the actual seventh source passed in 134 seconds: twelve
ordered starts and deliveries, no repeats or refund, and its full 24,514,304 PCM
bytes decoded with no warnings, 127,679 ms decoded versus 127,660 ms consumed
(within one 20 ms frame). The real HTTP-severed-preload regression and 213 focused
worker/player/receipt/browser tests also passed.
This is server-player verification, not a production deployment or browser AAC
compatibility test. The native browser handoff check uses WAV fixtures; an
authorized production rollout and real listener verification remain separate gates.

The Playlists section of the connected wallet's own profile shows its five most recent Play Live receipts:
verifying queue, queued, playing, completed, or refunded. Expand a receipt for
delivered-song progress, paid/refunded/settled USDC and Base transaction links.
Refund notices explicitly distinguish USDC returned from non-refundable worker
ETH (v0.4) and network gas. Completion requires the terminal on-chain fee event,
not a purchase confirmation or a missing queue entry. Failed refreshes retain the
last verified receipt and show an unavailable notice rather than implying success.
Receipts refresh while that profile is open, even with the DJuke drawer closed;
they are hidden when viewing another wallet's profile or disconnecting. The DJuke
drawer stays focused on selecting and queueing music.
Its named queue highlights the exact DJuke request reported as playing by the
radio, including its contract and playlist lane identity. The current song is
centered when it changes or the drawer opens; routine polls preserve manual
scroll position. A preparing interval clears the on-air marker and explains
that paid playback is continuing without requiring another payment.
DJuke purchase confirmations use a small, dismissible neon callout anchored by
the drawer/tab (also visible over an open Profile), not full-screen celebration
effects. They show confirmed USDC and a Base transaction link without stealing
focus; purchase confirmation is not a delivery receipt. Reduced-motion settings
disable the decorative movement.
Public read-only snapshots include pending batches and the 50 most recent resolved
batches. Legacy schema-2 checkpoints replay events once from the configured
deployment block to recover exact amounts and resolution links; this adds no
transactions or public-request checkpoint writes.

## DJuke v0.5 deployment (2026-10-23)

The drained v0.4 contract is paused for new requests. Replacement v0.5 is
`0xf51D2F7892cF9D49e14DF4afDf227a59ee170A51` (deployment block 52993982),
with module `0x093d2dbCcBA612d2B2aD9B620cA4d0A03D98fE11`.
The reviewed migration copies all 255 songs and verifies creator splits/listen
prices; the deployment record lives in DecentMarket's
`deployments/djuke-v05-base.json`. Old charges cannot be retroactively removed.
Both versions retain ordinary
wallet network gas, signed quotes, the same USDC tiers, and main-request cut-in.
Fund reports resolve these verified contract addresses through the shared
known-address book as **DJuke v0.5** and **DJuke v0.4** (with v0.3 retained),
linking to their BaseScan contract pages rather than showing an unnamed wallet.

The v0.5 candidate signs zero worker contributions only after verifying its
on-chain version and worker solvency. Each fourth delivered playlist song releases
$1 **total**, split $0.25 to each of the four funds. Completion releases any
remaining platform fee. Interruptions refund undelivered songs and only the
unreleased platform fee. Existing v0.4 batches retain their original policy.

Listener-facing v0.5 purchases show only USDC and standard Base network gas:
no worker-funding line, surcharge, or funding pitch in single-song, Personal Play,
Play Live, approval, or information text. Both radio entry points reject nonzero
native value/cost before payment and the replacement contracts reject it too.
Funding details belong only in Admin. Legacy v0.4 checkout must continue disclosing
its real charge until cutover, and historical receipts retain their original terms.

Launch funding is **manual top-ups with admin alerts**. Keep
`WORKER_RESERVE_ENABLED` unset/false; no reserve key is required for sponsored
quotes. No keys, transfers, contract deployment or production financial cutover
are authorized by the funding policy. The connected admin sees worker funding
warnings in Admin and the left ankh/Admin action count, without overwriting
live-booking actions. The monitor reads the active contract's `gasWorker()` on
Base every minute while the page is visible; it is not an offline Discord/email
notification. An unavailable balance is an action, never a healthy result.
Wallet disconnect/change invalidates in-flight reads.

For v0.5, warn below **0.002 ETH**, suggest a **0.003 ETH** target, and pause
sponsored quotes below **0.001 ETH** or when twice the estimated execution
budget exceeds the balance. This is an early warning, not a promise of capacity
for all outstanding purchases. Top up only the verified worker with ETH on Base.
Before cutover, verify funded worker, fulfiller/registrar roles, matching
frontend/backend addresses and versions, deployment-block event replay, and
durable mirror/journals. Drain both old paid lanes and stop new v0.4 purchases
before moving the worker; old purchases cannot be migrated by changing config.
Mainnet deployment and production cutover were explicitly approved separately.

At contract cutover, preserve the verified resolved v0.4 receipts in
`DJUKE_LEGACY_PLAYLIST_RECEIPTS` from the deployment manifest. The worker validates
the archive and prepends it to profile receipt history, never the active queue.
Archived receipts retain their old contract, exact refund amounts and v0.4 terms;
batch IDs are local to a contract and must not be treated as new v0.5 payments.

The optional automatic reserve remains disabled and outside the selected launch
policy. If separately approved later, it requires a distinct funded signer, one
writer, and durable recovery before activation. Its limits are at most 0.002 ETH per
transfer and 0.006 ETH per UTC day. These are transfer-value caps; each transfer
also has a separate maximum network fee of 0.00002 ETH. Failed transfers count
conservatively toward the daily value cap. Pinata stores the exact signed raw
transaction **before** broadcast; restart recovery rebroadcasts that transaction,
not a new payment. This reserve journal is not part of the public mirror queue.
All funding failures are explicit; low worker funds pause sponsored quotes.

The public catalog never waits for reconciliation or checkpoint writes. Its
read-only batch snapshot supplies the complete ordered queue; exact, uniquely
matching saved revisions supply names, otherwise the label is `Playlist #id`.
Radio takeover badges and bounded, slow 3D notes/balloons/genies appear only
during audible playlist playback, pause for main-request cut-ins, and clear on
normal rotation/archive mode. Particles require real spectrum energy and respect
reduced motion; the text indicator remains available without animation.

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

The draft exposes exactly three actions: **Save to Profile** signs and stores a
named revision without buying playback; **Personal Play** buys the current ordered
draft in one creator-priced batch, then plays all songs consecutively locally;
**Play Live** buys the draft for the shared radio playlist lane. Saving is optional
for either playback purchase. Personal Play does not affect public radio and has
no radio platform fee. Play Live preserves the tier prices and main paid-request
priority below; it never interrupts a song already playing. Both purchases may
need a separate USDC approval, and wallet gas is additional.

### Personal Play recovery

New Personal Play purchases retain a wallet-scoped session in this browser's
local storage: the submitted Base transaction hash, receiving contract, ordered
recordings, current song, and playback position. The transaction is saved before
waiting for its confirmation, so a refresh during confirmation can be recovered
too. Storage is checked before checkout; an unfinished purchase of the same
ordered songs blocks accidental duplicate payment.

After a refresh or media interruption, open **Profile → Playlists → Your Personal
Play sessions** and choose **Resume · no payment** (or **Resume / retry** during
an active session). Resume verifies the original transaction on Base, including
the purchasing wallet, destination, and successful receipt, without approval or
another purchase. A pending transaction remains recoverable; a verified reverted
transaction is marked failed. Playback resumes the current song near the last
saved position and continues the remaining songs in order. Progress saves every
second, on pause/seek, page hide, and visibility changes; loading must not overwrite
a saved position with zero. A gateway/media failure does not complete the session.
Completion is recorded only after the final song ends.

Recovery requires the same browser/site storage and purchasing wallet. It is not
cross-device, does not auto-start audio after refresh, and cannot recover older
purchases made before sessions were stored or sessions erased by clearing site
data. Session storage is not an on-chain playback entitlement. It does not change
personal-listen settlement or create an automatic refund for media failures.
The public radio keeps running for other listeners throughout personal playback.

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

Queue polling preserves unchanged song option nodes, selection and menu scroll
position. Changed catalogs wait until the song picker loses focus; explicit
searches still update immediately. Transient read failures disable checkout and
the picker without discarding its options or selection, and report the error.
