# Named DJuke playlists — rollout decisions

Issue #241 adds a profile-backed playlist library. Names are 1–60 characters;
playlist IDs are stable 128-bit hex IDs, names need not be globally unique, and
results identify the maker and full ID. A playlist contains 1–10 distinct
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
never silently changes Watchlist content. Top 10's plus action adds to the
current wallet's playlist draft, not Watchlist.

## Prices and settlement

Named playlist prices intentionally differ from creator-configured personal
listen prices. Named private playback is exactly **0.25 USDC per enabled song**,
with no queue-depth escalation and no $5 fee. Existing one-song and ordinary
`purchaseListens`/album checkouts keep their creator-configured prices and are
not rewritten. A private named playlist never creates radio requests.

Radio checkout is **0.25 USDC × song count + $5 once per playlist** (10 tracks:
2.50 private / 7.50 radio), independent of paid-queue depth. Every request binds
the reviewed ordered IDs; the contract validates all songs before taking funds
and appends the batch contiguously in one transaction. Song payments snapshot
artist/collaborator recipients and settle only when the authorized worker
submits the existing unique playback proof; production policy must only submit
that proof after genuine audible completion. The additional $5 remains reserved until every item completes, then
the platform-fund router receives exactly 2.25 playback, 2.25 Top 10, 0.40
pinners, and 0.10 repository development (USDC). All amounts are 6-decimal
base units. Song payments retain the existing 90% artist/collaborator, 8%
pinners, and 2% repo-dev split; these are distinct from the $5 fund split.

If a paid batch cannot be completed, the worker must invoke the contract's
FIFO-head `refundUndeliveredPlaylist(batchId)` recovery path. That path returns
only unresolved song payments and the entire still-reserved $5 fee; previously
completed songs retain their normal settlement. It does not skip a paid item or
settle a partial platform fee. Unavailable songs are rejected atomically at
checkout; later transport/worker failures remain durable until successful
retry or an auditable refund. Refund calls require the fulfiller role and the
unresolved batch suffix to be the paid FIFO head. UI/worker must show pending,
settled, or refunded from receipt/events, not from a submitted transaction.

Worker gas is separate from the $5 fee. Radio checkout requires a worker-signed
short-lived quote for the exact listener, ordered-song hash, maximum total, per-song
gas contribution, nonce, and deadline. The contract requires exactly 2× the quote
for each batch item and transfers the aggregate to the configured worker at checkout.
That native-ETH transfer is immediate and is not held or refunded by the playlist
contract, even if the worker later refunds undelivered USDC items; actual gas use may
be lower. A front end must show the entire contribution before confirmation. The first
USDC allowance can require a separate wallet approval. No gas amount is assumed to be
covered by the platform fee.

## Playback and scheduling

The entire ordered playlist joins after the current paid FIFO queue and is
contiguous relative to other paid songs. It does not interrupt current audio or
preempt protected Top 10, live, or scheduled shows. Existing DVert break policy
continues; it may run at its established break boundary without reordering paid
song requests. The player starts only after a successful private receipt; radio
success is reported only after a successful batch receipt. Playback order comes
from the immutable event/request sequence, not browser-supplied `paid` flags.

## Rollout and safety

Named private and radio checkout are capability-gated on an explicitly configured compatible
DJuke v0.3 address/version; the current configuration remains disabled. The batch-aware gas-quote endpoint, event reconciliation, durable worker restart recovery, and automatic radio-failure refund invocation are not implemented in this change, so radio checkout must remain disabled even after a contract address is supplied until those pieces are independently completed and reviewed. There is
no fallback to repeated tier-priced requests, private listens plus unpaid radio
items, or creator-price overrides. Existing single-song checkout, creator-priced
personal listens/albums, Watchlist, and DeVert behavior remain on their current
paths.

**No deployment, migration, allowance, or fund movement is approved here.**
Before enabling any feature, obtain separate steward approval, independently
review the new module and DJuke deployment, verify all four router fund IDs and
token decimals, publish matching compiler/optimizer settings and ABIs, test on a
fork, configure the exact deployed version/address, implement worker batch event
reconciliation and restart recovery, and validate one controlled private and
radio batch plus full refund. Do not enable radio checkout until the worker has
verified batch receipts, contiguous scheduling, durable audible-completion
proofs, fee settlement, and the FIFO refund path. Rehearse migration with zero
live writes; no existing queue or creator-set price is changed by this code.
