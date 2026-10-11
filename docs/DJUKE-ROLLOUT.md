# DJuke and DNft rollout

Status: DJuke v0.2 is deployed on Base at
`0x333Aa353d6fc70aE79Cf91CE090645CD740FEf59`. The live worker reports 253
registered tracks with no catalog read errors, and payments are enabled for the
low-stakes prototype; no paid request was submitted during verification. The
prototype still uses its current worker and Pinata credentials, which must be
rotated before expanding the audience. Community pinning follow-up is in PR #110
and the final 8/2/90 contract allocation is in DecentMarket PR #49.
## Creator profiles and DJuke v0.2

The Base-fork rehearsal passed after mining one local block before historical
contract reads. DJuke v0.2 is deployed at
`0x333Aa353d6fc70aE79Cf91CE090645CD740FEf59`, transaction
`0x27973e8bff75d4cf0a29356641dba04b8a787cfdd76ae27dd3893ef0c966658a`.
All 253 songs were migrated and verified with identical IDs, audio and payee
splits. Worker roles are granted. The live API reports 253 registered tracks
with no catalog read errors, and payments are enabled for the low-stakes
prototype. No paid request was submitted during verification. Receipts are in
DecentMarket `deployments/djuke-v02-base.json`. Migration RPC calls are serialized
to avoid public provider rate limits. Album grouping is curated separately,
not inferred from artist names.

The Top 10, DJuke emoji mark, and DVert pullout tabs are restored in the UI.
DVert is currently a profile entry point and an explicit undeployed status, not
a live advertisement checkout or broadcast.

The creator profile opens from DJuke or an NFT detail panel. Public profiles are
readable without connecting; editing requires the same wallet's fresh signature.
Linking Discord requires both a wallet-signed link request and the authenticated
`/creator-link code:...` Discord interaction. Codes expire in five minutes and
cannot silently replace an existing wallet/Discord association. Profile snapshots
use their own Pinata namespace; they are not part of the playlist-only Mac mirror.

Uploaded IPFS avatar/banner overrides take precedence over forward-verified ENS
records, then verified Discord images. ENS is resolved on Ethereum mainnet, not
Base. Banners use `banner` or `header` text records; neither record is guaranteed.
Images may be PNG, JPEG, WebP or GIF up to 10 MB. Profile updates never rewrite
immutable DNFT metadata, transfer NFTs, or grant song/advert contract permissions.

DecentMarket's v0.2 source compiles separately with IR. It preserves FIFO queue
pricing (0.25 USDC, doubling every eight pending requests), and the 90/8/2 split.
Albums have a manager, collaborator percentages and position titles. Every current
recipient must sign the same revision before a manager changes recipients/shares;
song splits can then be synced in a separate retryable transaction. Existing paid
requests retain their original recipients. Album manifest edits do not change
individual song audio. Personal listen/album prices are separate from queue prices.

Queued plays use `requestPlayWithGas` with a worker-signed EIP-712 quote bound to
listener, song, USDC price cap, nonce and expiry. The ETH contribution is twice the
quoted fulfillment budget and is forwarded atomically to the fixed worker. The
worker budget defaults to 1,000,000 gas plus the Base gas oracle's L1 data fee;
it is a conservative budget, not a guarantee of future fee levels. Quotes fail
closed above the deployed contract cap. Prototype payments are enabled; verify
the budget and settlement against the production router before widening access.

Browser and worker configuration must use the new address with
`DJUKE_CONTRACT_VERSION=0.2` on Render and `djukeContractVersion: "0.2"`
in browser config. `DJUKE_FULFILLMENT_GAS_UNITS` may
override the bounded budget (100,000 to 2,000,000). Existing v0.1 registrations do
not automatically appear in a new contract. Album management remains disabled
until v0.2 is selected. Advert-specific editing still requires the advert contract's
own permissions and a reviewed integration; linking Discord alone is insufficient.

Status: DecentNFT v0.3 and DecentJukeBox v0.2 are deployed on Base; the
`dbusk-pinners` fund is active. DJuke payments are enabled for the low-stakes
prototype after the worker, catalog and mirror were verified. The
existing DecentNFT v0.2 remains in the archive alongside v0.3. New owner-approved
mint requests target v0.3 in sequential batches of up to 20. The reviewed album
plan is ready to import and queue after mirror readiness is confirmed; no album
NFTs have been minted yet.

Regular radio playback is active. The live-performance calendar and DeVert
reader/UI changes in the local worktree are not deployed; the live
`/api/radio/schedule` endpoint currently returns 404. The DeVert contract and
campaign payments remain undeployed and off.

## Remaining public-launch checklist (you enter keys and execute)

Never paste keys or secrets into chat. Browser and Render settings are reversible;
fund creation, worker-role changes, and song registration require Base gas.

1. **Ship the remaining sprint code.** The DJuke prototype is already deployed;
  publish the reviewed local schedule/calendar and DeVert read-only UI changes.
  Expected: the schedule endpoint returns 200, DJuke shows the live catalog, and
  DVert clearly identifies that campaigns and the ad-only broadcast are not live;
  regular radio playback is unchanged.
2. **Optional community mirror.** The shared Pinata checkpoint is primary and saves
    never wait for a mirror. Visitors open the pin chooser from the existing header
    IPFS button and pin shared CIDs to local IPFS Desktop or their own Pinata account.
    No shared mirror secret is required for playlist saves.
3. **Pinner fund status.** `dbusk-pinners` is active and empty until revenue is
  routed to it. Confirm the pinner, artist and repo-dev balances before widening
  the audience.
4. **Rotate the prototype worker before expanding access.** The v0.2 contract is
  already deployed. Grant the replacement worker the required roles, revoke the
  old worker, then update `DJUKE_FULFILLER_PRIVATE_KEY` on Render. No contract
  redeployment is needed for this key switch.
5. **Keep app configuration aligned.** `decent.config.js` and Render currently
  point to the deployed v0.2 contract. Preserve `DJUKE_PAYMENTS_ENABLED=true` for
  the prototype; turn it off before any maintenance that makes the catalog or
  fulfillment journal unavailable.
6. **Song registration is complete for the prototype.** The live worker exposes
  253 registered tracks, verified against their on-chain audio CIDs. New
  eligible uploads continue to register automatically; watch for `[djuke]
  Registered` in the logs. The reviewed-album action rechecks the 190-song
  dual-pinned plan against the current playlist and queues eligible songs for
  owner review; it does not mint. Review the artist wallet before approving.
7. **Verify settlement before widening access.** Prototype payments are enabled
  with the 90% artist / 8% pinner / 2% repo-dev split. Confirm all three router
  balances before inviting a broader audience. A 0.25 USDC bump/listen splits
  0.225 / 0.020 / 0.005 USDC.
8. **Batch minting.** New owner-approved mints target DecentNFT v0.3; v0.2 stays
  in the archive and reconciliation scan. Batch minting is enabled. Review the
  imported song and artist recipient in Admin, then confirm sequential batches
  of up to 20. Existing v0.2 token IDs and metadata remain unchanged.
Rollback: unset `DJUKE_PAYMENTS_ENABLED` or `djukeContractAddress` to hide payments;
the contract's `pauseRequests` stops new purchases while queued plays still settle.

## DeVert advertising candidate

The separate, undeployed DeVert candidate charges at least 5 USDC for a seven-day
campaign. Main-radio delivery is limited to one ad slot per ten completed music
plays. When all current slots are seated, a new offer must clear the cheapest
seated offer by at least 0.01 USDC. Campaigns that do not make the main-radio cut
remain in the 24/7 DeVert-only stream for their paid week; there are no refunds.

Campaign payments route 45% to Playback, 45% to Top 10, 8% to Pinners and 2% to
Repo-dev. The public DVert tab now shows the broadcast/campaign status and can
display the read-only confirmed campaign snapshot when the worker is deployed
with `DEVERT_CONTRACT_ADDRESS`. It does not yet play audio or accept campaign
payments, and the contract has not been deployed.

Before deployment, finish these gates in order: implement advertiser quote and
purchase controls with exact USDC approval and a user-set maximum; implement the
24/7 IPFS ad player and the one-per-ten-music-plays main-radio insertion; add a
dedicated scheduler service with durable, idempotent impression records and
weekly market updates; verify any DJuke purchase on Base before linking its
unique ID, so a bump is never charged twice; then rehearse campaign expiry,
overbids, fee routing, failed playback, restart recovery and role permissions on
a fork/testnet. Keep DeVert payments disabled until those checks pass.

## Verification so far

- App and contract test totals are recorded by CI. Browser checks cover the left-tab layout
  (mobile, small and desktop) and payment-button gating.
- Base fork rehearsal (real USDC and router, nothing broadcast): one-transaction
  batch mint of three songs, a 0.25 USDC bump split 0.225 artist, 0.020 pinners,
  0.005 repo-dev, and a two-song listen split 0.450 artist, 0.040 pinners,
  0.010 repo-dev.
- Paid requests play ahead of free rotation; fulfillment needs 30 audible seconds,
  happens in the background, and is bound to the exact recording revision played.
  A failed paid play waits 60 seconds before retrying; free radio never stalls.

## Current implementation checkpoint

- Album application code now lives in `discord-bot/album-import.js`. It rechecks
  current title/filename and audio identity, preserves every existing entry,
  assigns stable album IDs and album membership, and creates zero-stat unminted
  radio tracks. It neither registers NFTs nor requests mints automatically.
- The current recovered Pinata checkpoint contains 266 tracks, including 253
  DJuke-eligible songs. All 253 eligible song IDs are enabled on-chain and match
  their exact audio CIDs. The older 77-track checkpoint is superseded.
- Opt-in startup application requires deployed code and
  `DBUSK_IMPORT_REVIEWED_ALBUMS=true`, a successful nonempty remote restore, and
  the authenticated outbound checkpoint mirror described below. The live
  instance restored the full checkpoint; its latest reviewed-plan run added 0,
  queued 0, skipped 190, and minted no NFTs. The previous
  `DBUSK_ALBUM_LOCAL_IPFS_API` option has been replaced: Render loopback is not
  the user's Mac. The media requires no additional uploads; Pinata state
  persistence creates a small JSON checkpoint, not another copy of the albums.
- Pinata publishes checkpoints as the primary copy and never waits for the
  community mirror. The exact serialized bytes are queued asynchronously for
  connected mirrors; offline/failed mirrors only log a deferred copy. The local
  pinner compares its CID to the shared CID before acknowledging. Radio saves
  continue while all community pinners are offline.
- The bridge's authenticated claim/ack endpoints use a dedicated shared secret,
  not Pinata credentials or a wallet key. Only the Mac client can retrieve pending
  checkpoint bytes. Kubo stays loopback-only. Acknowledgments trust the configured
  client to verify its recursive pins; they are not remote cryptographic storage
  proofs. Requests are bounded to 2 MiB checkpoints and two queued jobs, with
  timeouts. The job queue is in memory: restart interrupts pending mirror attempts;
  the shared Pinata checkpoint remains the primary copy. Automatic media uploads and
  other backup namespaces are not covered by this playlist-only bridge.
- End-to-end local rehearsal through the worker HTTP handler and real Kubo
  mirrored a 471,114-byte, 267-track checkpoint before mock publication. No real
  Pinata upload or live radio change occurred. See
  `docs/reports/checkpoint-mirror-rehearsal.json`.

- Latest duplicate policy: the user stopped remote NFT metadata requests and
  approved normalized song-title review instead. No additional NFT lookup is
  required for this album candidate report. Capitalization, media extensions,
  underscores and whitespace are normalized; recording numbers and other title
  content remain significant. This is a title heuristic, not proof of identical
  audio or a complete on-chain duplicate audit. Existing-title matches and local
  same-title collisions are held out rather than merged automatically.
- The saved 77-track playlist checkpoint and local inventories produced
  `docs/reports/album-import-title-review.json`: 331 byte-distinct recordings,
  270 with verified dual-pin coverage, 53 existing-title matches, and 25 local
  title-collision recordings. Counts overlap. Sixteen original album directory
  roots matched offline using raw leaves and their existing Finder metadata;
  those same roots are now recursively pinned locally with no Pinata uploads.
  AW did not match any tested profile and remains a directory-review blocker.
  `docs/reports/album-import-candidates.json` contains 190 unblocked, dual-pinned
  candidate recordings needing no uploads. Startup rechecks current titles and
  CIDs, applies album membership without changing existing history, and queues
  new songs for owner mint review. The separate Admin action also rechecks the
  plan and queues without minting. Set the startup flag to `false` to pause
  automatic retries.
  The broader Desktop folders remain in the review report, not automatically
  added to the original ENS import scope. No NFTs were minted by the latest
  reviewed-plan run.

- Album storage update: use `/Users/j/Desktop/DecentJukeboxAlbums` as the local
  source, leaving originals unchanged. Inventory found 343 media files in 27
  folders, with 331 distinct byte hashes and 12 redundant exact copies. Total
  media is 8,659,219,756 bytes; unique media is 7,510,339,120 bytes.
- Pinata lists 222 top-level records, including the 17 ENS album directories.
  Its aggregate endpoint reports 18,518,411,642 bytes and a pin count of 22,811;
  that aggregate count is not comparable to the top-level file listing. Plan
  quota/headroom has not been verified. Do not blindly upload the entire folder.
- Offline SHA-256 and common UnixFS CID profiles verified 55 recordings already
  stored on Pinata (476,412,483 bytes), including 51 CID matches in the local
  playlist cache. Those 55 recordings were imported into local Kubo from the
  original files and recursively pinned at the exact existing Pinata CIDs.
  No new Pinata uploads, unpins, NFT mints or source modifications occurred.
- Local Kubo is reachable at `http://127.0.0.1:5001`. The 17 remote album-root
  directory listings timed out through Kubo. Remaining file matches inside those
  directories are unverified; lack of a file-level match does not authorize an
  upload. An upper bound of 7,033,926,637 unmatched bytes is not a new-upload
  estimate: it includes media that may already exist inside the pinned albums.
- Shared Pinata is the primary copy. The header's existing IPFS button opens a
  community pin dialog for local IPFS Desktop or the visitor's Pinata account.
  The visitor's Pinata key is used only in that browser session and never sent to
  the DBusk worker. Local Kubo pins are confirmed by listing recursive pins.
  Community copy availability is best effort and never blocks radio saves.
- `allocatePinnerRewards` calculates weighted shares from successful availability
  checks, with a minimum 20 checks, 90% availability and a recent check required.
  Pinner registrations, independent challenge verification and weekly disbursal
  are not implemented; rewards remain off, and pinning alone earns nothing yet.
- Detailed local storage audit and mirror journals are temporary files. The
  complete durable title-review and candidate reports remain under
  `docs/reports/`. AW's local folder still does not match the original Pinata root.
- Detailed generated audit and mirror checkpoint are currently at
  `/tmp/dbusk-album-pinata-audit.json` and
  `/tmp/dbusk-local-mirror-journal.json`; these are temporary diagnostic files.
  A complete import manifest still needs live NFT/playlist reconciliation and
  review of recordings with alternate encodings and expanded album scope.

- Archive caches, selection, detail links and coin placement distinguish
  chain/contract/token identities. DecentNFT v0.3 is the configured mint
  collection and v0.2 remains in `additionalNftContractAddresses`. Both archive and CLI/worker scans
  support additional collections. Worker scans retain v0.2 and accept optional
  `DECENT_NFT_ADDITIONAL_ADDRESSES` (comma-separated); every scan must succeed
  before playlist reconciliation. Existing playlist token IDs and statistics
  remain intact; `nftReferences` carries verified collection-qualified refs.
- Admin selected-song minting supports v0.3 with `nftBatchMintEnabled: true`.
  It prepares metadata, estimates gas, limits batches to 20 songs, uses one
  transaction and matches receipt events to metadata/recipients. It does not
  automatically rebroadcast after Discord reconciliation fails.
- DecentJukeBox v0.2 is deployed and its worker-signed EIP-712 gas quote is wired
  into the browser request path. The live prototype uses FIFO queue pricing,
  exact 90/8/2 routing and a bounded worker gas contribution. Keep the existing
  Fulfiller credentials prototype-only; rotate them and regrant roles before
  widening access.
- Song audio references cannot change under an existing DJuke song ID. Split
  edits affect future purchases only. Admin configuration does not prove artist
  consent. The fulfillment role trusts a designated worker; an on-chain playback
  identifier is replay protection, not cryptographic proof that audio played.
- Worker `GET /api/djuke` is implemented but returns unavailable without
  `DJUKE_CONTRACT_ADDRESS`. It reads a complete confirmed contract snapshot,
  checks canonical block identity, and maps only matching registered recordings.
  The current reader refuses queues exceeding 128 pending requests rather than
  presenting an incomplete price. Pagination must be implemented before activation
  so this operational bound does not undermine paid fulfillment.
- The durable playback journal is attached to the live radio and Pinata store.
  Its local Kubo mirror client must remain online for checkpoint acknowledgements;
  when the client is unavailable, journal writes can fail. The journal checkpoints
  before acquisition, retries after restart and synchronizes from confirmed
  contract state. No paid request was submitted during prototype verification.
- Read-only `discord-bot/album-audit.js` parses HTML and literal track manifests
  without executing player scripts, retains CID/path identities, links exact
  existing references and flags title-only matches for review. It is not a
  perceptual fingerprint audit and cannot equate file CIDs with directory paths.
  The live run found all 17 players but every player returned HTTP 429. No track
  inventory, media hash comparison or import has been completed.
- New parser dependencies are Cheerio and Acorn. npm audit reports nine
  advisories in the existing Discord/voice dependency tree (including one
  critical tar advisory); dependency remediation needs a separate scoped review.

Approved follow-up policies: paid DJuke plays count like free plays toward weekly
playback payouts, subject to the existing audible qualification checks. For
permanently unavailable media, the payer may choose a replacement recording.
Replacement is explicit consent, not automatic substitution. The contract
candidate now allows only the payer to select an enabled replacement, preserving
the paid amount and queue position and snapshotting the new artist split. Each
replacement increments a revision; fulfillment must match both song and revision,
including when a payer changes A to B and back to A. This protects against stale
playback settlement. The worker reads revisions, but journal revision recovery
and replacement UI are not integrated yet. The contract currently permits payer
replacement for any pending request; restricting the UI to unavailable content
requires verified availability state. No refunds or additional charges occur.

### Live performance calendar

The regular Friday lineup is 8:00–9:00 PM New York time for the Top 10 Hype
Hour, followed by the Live Performance Block from 9:00–10:00 PM; normal
rotation resumes at 10:00 PM. Both windows follow New York daylight-saving
time. Performers use the connected JukeLoop voice channel while the bot's music
player is stopped.

The weekly Top 10 finale occupies the final New York payroll hour: Sunday 11:00
PM through Monday 12:00 AM, with the boundary calculated by the payroll calendar
so daylight-saving transitions do not move payout weeks. It plays the current
week's net-vote chart, accepts votes through the cutoff, and yields to normal
rotation exactly at midnight. DJuke paid picks wait until the show ends.

The Discord bot now supports `/jukeloop live-add`, `/jukeloop live-list`, and
`/jukeloop live-cancel`. Adding or cancelling requires Manage Messages. Supply
ISO-8601 UTC timestamps ending in `Z`; events must start within 60 days, last no
more than four hours, and fit within the 100-event calendar limit. The event
calendar is stored as a separate versioned Pinata snapshot, not inside playlist
history. If the calendar cannot be restored, normal radio still starts but
scheduled live blocks remain inactive and calendar edits are disabled rather
than risking overwrite.

At the scheduled start, JukeLoop stops its own track player and remains connected
so performers can play in the same voice channel. Paid picks wait during the
block. At the end or after cancellation, scheduled music resumes. This first
slice does not record performances, create replays or DNfts, or add the live
performance payroll category. The DeVert planner and read-only confirmed Base
campaign reader now exist. Setting `DEVERT_CONTRACT_ADDRESS` exposes its
confirmed snapshot at `GET /api/devert` (`DEVERT_CONFIRMATIONS` defaults to 2);
without an address, the endpoint stays unavailable. The reader is read-only and
not connected to voice playback. Audible ad delivery still needs the contract
deployed, a scheduler-role signer, and a durable delivery journal before the
live bot can safely record impressions.

Browser retry of the user-confirmed ipfs.io URL returned a Cloudflare challenge
(HTTP 403) rather than player content. The user reports that the same gateway
plays the albums in their browser. This environment's automated-access failures
are not evidence of dead CIDs; use accessible player HTML/manifests from the
working browser session or another available gateway to complete the audit.

Before widening the prototype audience, rotate the worker key and Pinata token,
verify all three router balances, confirm journal persistence with the Mac mirror
client, and complete a controlled paid-play/fulfillment rehearsal. The local
radio-calendar UI and worker routes still need to be published. DeVert remains
undeployed and needs advertiser purchase controls, reliable audio delivery,
durable impression/market scheduling, verified DJuke-purchase linking and its
own testnet rehearsal. Keep DeVert payments off until those gates pass.

## Preserve the existing system

- Keep Base DNft v0.2 at `0xe63EC9f8228720bAAC2fD528C0A6d06B3Dc5439B`.
- Existing balances, token IDs, metadata and royalties stay on that contract.
- A new contract cannot move those token identities. Do not burn or re-mint
  existing songs as a migration step.
- Before enabling a new address, make archive loading, mint reconciliation,
  duplicate detection and completion reporting support both collections.
- Identify tokens by chain ID, contract address and token ID, never token ID
  alone. Store album membership against canonical song identities.
- Keep free radio, voting and weekly accounting unchanged unless a specific
  policy change is approved. DJuke must be an optional priority lane, not a
  replacement radio. An empty or disabled priority lane uses normal rotation.

## DNft batch candidate

The separate local DecentMarket repository now contains an undeployed
`contracts/DecentNFT_v0.3.sol` candidate and `test/DecentNFT_v03.test.js`.
It inherits v0.2 and OpenZeppelin Multicall.

- `registerAndMintProductsBatch` registers and mints multiple new songs in one
  transaction, using actual registration return values rather than predicted
  token IDs. It supports different recipients, metadata and royalty settings.
- An invalid item rolls back the whole transaction. Existing role checks,
  supply caps and Product/Achievement lane checks still apply.
- The registering admin remains `creatorOf`, matching v0.2 provenance semantics.
  This is not a new recording-artist ownership model. Preserve artist identity
  separately; any change to creator semantics needs an explicit design.
- `multicall` batches existing mint, metadata and royalty-setting operations.
  Native payments are rejected. The audited v0.2 source has no payment receipt,
  sale, royalty payout or withdrawal functions; ERC-2981 reports royalty terms
  but does not collect or distribute royalties.
- Existing ERC-1155 batch transfers remain available. Transfers, edition
  minting and registration of new songs are different operations.
- Local batch suite: 8 tests passing, including contract-recipient rejection.
  Compilation has an SPDX warning; no license designation was added.
- This is not a security audit or proof that source matches deployed bytecode.
  Callback reentrancy review, production gas estimates, ABI export,
  dual-address integration and testnet rehearsal remain deployment gates.

## Album import

Only use `https://decentbusking.thejollylama.eth.limo/` and its current album
player links. Do not fetch songs from dead legacy JukeBox registry CIDs.

The catalog currently lists 17 Jones Drive Sessions albums: AA, AB, AC, AD,
AE, AG, AJ, AK, AL, AM, AQ, AR, AS, AT, AU, AV and AW.
The catalog is readable, but sampled player gateway requests returned HTTP
429. No complete song manifest or duplicate report has been verified yet.

Before importing, compare normalized audio CIDs and exact content hashes with
the live playlist and minted metadata from every supported DNft collection.
Directory CID plus filename is not necessarily the audio file's CID. Flag
possible re-encoded duplicates for review rather than treating different CIDs
as proof of different recordings. Keep alternate live performances distinct.
When a song already exists, add album membership to that song instead of a
second radio entry, mint request, vote history or payout identity.
Incomplete metadata or unavailable content must block automatic import.

## DJuke contract and policy gates

Published JollyJukeBox mappings distinguish Polygon v1.2 from Optimism
v1.2.4-v1.2.6. The v1.2.5 and v1.2.6 ABIs accept multiple album owners;
they do not expose retroactive artist editing or weighted share parameters.
ABI evidence alone does not establish actual distribution or refund behavior.
Verify the relevant Solidity sources before reusing those mechanisms.

Keep payment receipts and queue fulfillment separate from NFT ownership.
Queue requests must bind payment to the canonical song, resist replay, and
only become eligible after payment verification. Do not interrupt the current
song. The user's no-refund direction requires durable paid requests, restart
recovery, pre-payment availability checks and retries after playback failures.
Do not silently expire or discard paid requests, or equate a payment event with
completed playback. Escalating prices discourage long queues but do not
guarantee content availability or a fulfillment deadline.

Approved pricing (2026-10-10, supersedes the initial $1 price): the starting
price is 0.25 USDC and doubles for each eight pending paid requests. Count
the queue before adding the new request: 0-7 costs 0.25, 8-15 costs 0.50,
16-23 costs 1.00, 24-31 costs 2.00, and so on. As the pending count falls, so
does the next request price. Every price allocates 8% to the pinners fund,
2% to repo-dev, and 90% to the song's artist, including approved collaborators.
Verify the existing fund's on-chain identifier and deposit route before wiring
this allocation; do not substitute an assumed wallet address.

Native Base USDC is the approved payment asset. At its six decimals, the
starting price is 250,000 units: 20,000 for pinners, 5,000 for repo-dev, and
225,000 for the artist/collaborators. Keep fractional-cent splits exact. The payment contract
must compute the authoritative quote at acceptance and reject a price above
the user's approved maximum; a changed queue must never cause a surprise
charge. Client-side prices are informational, not transaction authority.

The local DJuke right-side drawer now shows the tier model, a queue display,
song selection and a shared-wallet connection control. It polls the gated
`GET /api/djuke` endpoint; the payment contract candidate is not deployed.
The response supplies ordered `requests` (unique `requestId`,
`trackId`, `title`, optional `artist`) and available `tracks` (`trackId`,
`title`). Unavailable or invalid responses clear the quote rather than showing
a false empty queue. The payment button remains disabled in all states.
No USDC approval, payment or queue submission is implemented or enabled.
Desktop/mobile browser checks use mocked queue and wallet state.

First-paid, first-played remains the proposed queue order. Paid plays count
toward weekly qualification; permanently unavailable recordings allow a
payer-chosen replacement. Collaborative shares also need consent and rules for
prospective versus retroactive changes. Replacement settlement details require
review before activating the no-refund payment model.

## Wallet handoff

### Album activation without a wallet

1. Deploy the reviewed bot code with `DBUSK_IMPORT_REVIEWED_ALBUMS=false`.
2. Configure a dedicated random `CHECKPOINT_MIRROR_SECRET` of at least 32 bytes
  privately in Render and the Mac's local bot environment. Do not paste secrets
  into chat or commit them. The Mac client needs `PUBLIC_WORKER_URL` and
  `IPFS_API_URL=http://127.0.0.1:5001`; it does not need Pinata or wallet keys.
3. Start IPFS Desktop, then run `npm run checkpoint-mirror -- --watch` in the
  local `discord-bot` directory. It polls over HTTPS every five seconds, imports
  only CID-verified playlist bytes, verifies the recursive pin and acknowledges
  it. It does not expose ports or modify Desktop source files.
4. Once the client can poll the deployed endpoints, set
  `DBUSK_IMPORT_REVIEWED_ALBUMS=true` and restart the bot. It waits up to 30
  seconds for the mirror client, rechecks current titles/artist attribution,
  mirrors the new checkpoint before publication and adopts it after success.
5. Check the `[album-import]` log and public radio playlist, then disable the
  import flag. Reruns are idempotent. Keep the Mac mirror running whenever
  protected playlist checkpoints must be saved; going offline blocks those
  writes. Existing persistence code may keep in-memory changes while remote
  saving is blocked, so an offline Mac is an operational durability risk.

No deployment or live activation has been performed by the local rehearsal.

No wallet action is needed for the remaining local implementation and tests.
After policy approval, integration checks and a testnet rehearsal, provide
the user with the network, constructor arguments, admin/royalty recipients,
estimated gas and verified artifacts before requesting deployment signing.
Treat DNft and DJuke deployments, role setup and the first reviewed batch mint
as separate explicit approvals. Never request private keys through chat.