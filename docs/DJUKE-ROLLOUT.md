# DJuke and DNft rollout

Status (2026-10-10): DecentNFT v0.3 and DecentJukeBox v0.1 are deployed on Base;
the `dbusk-pinners` fund is active. DJuke payment requests remain disabled until
the worker environment is configured and radio fulfillment is verified. The
existing DecentNFT v0.2 remains in the archive alongside v0.3. New owner-approved
mint requests target v0.3 in sequential batches of up to 20. The reviewed album
plan is ready to import and queue after mirror readiness is confirmed; no album
NFTs have been minted yet.

## Go-live checklist (you enter keys and execute)

Never paste keys or secrets into chat. Each step is independent and reversible until
the on-chain steps (3, 4, 6), which cost Base gas.

1. **Ship the code.** Push the reviewed branch; GitHub Pages and Render redeploy.
  Expected: Top 10 and DJuke tabs stacked on the left; the deployed contract
  address is public, but paid requests remain gated by worker status.
2. **Album import and owner mint queue.** Set `DBUSK_IMPORT_REVIEWED_ALBUMS=true`
  on Render for the next restart and keep the authenticated Mac mirror available.
  The 190-track title-reviewed, dual-pinned candidate plan is rechecked against the current restored playlist at worker
  startup; exact current title/CID duplicates are skipped. The matching uploader
  identity and previously reviewed owner wallet are required, and conflicting
  wallet assignments stop the import. New songs enter the owner mint queue; no
  NFT is minted automatically. Confirm `[album-import] Added …; queued …`, then
  set the flag to `false` to prevent future retries.
3. **Create the pinners fund (admin wallet, one transaction).** Done 2026-10-10:
  `dbusk-pinners` is active, with public purpose metadata at
  `https://thejollylama.github.io/DecentBusking/payroll-assets.json#dbusk-pinners`.
  It is empty until revenue is routed to it.
4. **Deploy contracts.** Done 2026-10-10 on Base: DecentNFT v0.3 at
  `0x64D5aDc50E5513975EfF7e9ba366B7eE58586fa3` and DecentJukeBox v0.1 at
  `0x153ef59a57C9A88cbB7822252B5d9D0B11E48F0E`. The deployment script's final
  role-read raced RPC indexing; both contracts and the two confirmed worker role
  grants were independently verified. Receipts and addresses are recorded in
  DecentMarket `deployments/dbusk-base.json`. The deployer has about 0.00246 Base
  ETH remaining; budget more before future transactions.
5. **Point the worker at DJuke (Render admin required).** Public config now
  includes the deployed address. Set `DJUKE_CONTRACT_ADDRESS` and the dedicated
  `DJUKE_FULFILLER_PRIVATE_KEY` on Render; the worker key must match the address
  granted `FULFILLER_ROLE` and `REGISTRAR_ROLE`. Render is not configured from
  this workspace, so this step remains outstanding. Keep
  `DJUKE_PAYMENTS_ENABLED=false` until queue reads, song registration and a full
  playback/fulfillment test are verified.
6. **Songs register automatically.** With the worker key set, the bot registers every
   radio-eligible song that has an artist wallet: a one-time catch-up shortly after
   start, then new Discord uploads and briefcase submissions every two minutes, in
   batches of 25. Watch for `[djuke] Registered` in the logs. The admin-only
   `configure:djuke:base` script remains for changing an existing song's payees.
  **Current catalog gate (2026-10-10):** the latest restored Pinata playlist had
  76 IPFS-backed tracks but no `mintRecipient` artist wallets, so the live DJuke
  reader reported zero registered songs. The reviewed album import uses the
  previously verified `thejollylama` uploader ID and configured owner wallet;
  conflicting wallet assignments stop the import. New Discord drops receive a
  **Request NFT** button; the uploader opens the private wallet/artwork form and
  submission queues owner review but does not mint. Never infer a wallet from an
  unverified Discord name.
7. **Open payments (not yet).** Only after the Render worker is configured and a
  full test passes, set `DJUKE_PAYMENTS_ENABLED=true`. Verify one 0.25 USDC bump
  and the 0.225 / 0.020 / 0.005 artist/pinner/repo split in router balances.
8. **Batch mint owner requests.** The site targets deployed v0.3 for new mints and
  retains v0.2 as an additional archive collection; batch minting is enabled.
  Review the imported songs and artist recipient in Admin, select the approved
  requests, then confirm sequential transactions of up to 20 songs each. The
  queue refreshes after each successful batch. Existing v0.2 token IDs and
  metadata remain unchanged.

Rollback: unset `DJUKE_PAYMENTS_ENABLED` or `djukeContractAddress` to hide payments;
the contract's `pauseRequests` stops new purchases while queued plays still settle.

## Verification so far

- 196 app tests and 72 contract tests pass. Browser checks cover the left-tab layout
  (mobile, small and desktop) and payment-button gating.
- Base fork rehearsal (real USDC and router, nothing broadcast): one-transaction
  batch mint of three songs, a 0.25 USDC bump, 0.025 USDC into the repo fund, and a
  70/30 collaborator split withdrawn.
- Paid requests play ahead of free rotation; fulfillment needs 30 audible seconds,
  happens in the background, and is bound to the exact recording revision played.
  A failed paid play waits 60 seconds before retrying; free radio never stalls.

## Current implementation checkpoint

- Album application code now lives in `discord-bot/album-import.js`. It rechecks
  current title/filename and audio identity, preserves every existing entry,
  assigns stable album IDs and album membership, and creates zero-stat unminted
  radio tracks. It neither registers NFTs nor requests mints automatically.
- The newest readable checkpoint (77 tracks, 2026-10-10T14:43:29.254Z) passed a
  local rehearsal: 190 additions, 267 resulting tracks, old history unchanged,
  zero additions on rerun, verified existing Jolly uploader/wallet attribution.
  See `docs/reports/album-import-rehearsal.json`. This was not a live import.
- Opt-in startup application requires deployed code and
  `DBUSK_IMPORT_REVIEWED_ALBUMS=true`, a successful nonempty remote restore, and
  the authenticated outbound checkpoint mirror described below. The previous
  `DBUSK_ALBUM_LOCAL_IPFS_API` option has been replaced: Render loopback is not
  the user's Mac. The media requires no additional uploads; Pinata state
  persistence creates a small JSON checkpoint, not another copy of the albums.
- With `CHECKPOINT_MIRROR_SECRET` configured, the playlist state store serializes
  each checkpoint once, waits for the Mac to recursively pin those bytes, then
  publishes the same bytes on Pinata. It verifies the returned CID against the
  local CID before adoption/pruning. An offline or failed local mirror prevents
  Pinata publication. A failed remote upload leaves a safe local-only copy.
  Pinata/local storage are not atomic: an unexpected remote CID mismatch is
  reported and must be resolved before restart or activation; it does not prove
  that Pinata's chosen import profile matches the locally tested profile.
- The bridge's authenticated claim/ack endpoints use a dedicated shared secret,
  not Pinata credentials or a wallet key. Only the Mac client can retrieve pending
  checkpoint bytes. Kubo stays loopback-only. Acknowledgments trust the configured
  client to verify its recursive pins; they are not remote cryptographic storage
  proofs. Requests are bounded to 2 MiB checkpoints and two queued jobs, with
  timeouts. The job queue is in memory: restart interrupts pending jobs, and no
  not-yet-mirrored checkpoint is published. Automatic remote media uploads and
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
- `docs/reports/album-import-candidates.json` contains 190 unblocked, dual-pinned
  candidate recordings needing no uploads. On worker startup with
  `DBUSK_IMPORT_REVIEWED_ALBUMS=true`, the importer rechecks current titles and
  CIDs, applies album membership without changing existing history, and queues
  new songs for owner mint review. It does not mint automatically. Set the flag
  to `false` to pause future import retries.
  The broader Desktop folders remain in the review report, not automatically
  added to the original ENS import scope. No radio entries or NFTs were added.

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
- Dual pinning is required for this import and future pinning workflows. The
  opt-in `createDualPinUploader` reuses known Pinata CIDs and verifies a local
  recursive pin before returning success. Partial failure reports the existing
  Pinata CID for retry rather than encouraging duplicate uploads. It is not yet
  wired into all production upload paths. Render's loopback API is not the user's
  Mac: hosted/browser uploads need an explicit local-mirror integration before
  they can claim this guarantee. Existing production pinning is not silently
  reconfigured. Saving files on the Desktop alone is not a verified IPFS pin.
- Detailed generated audit and mirror checkpoint are currently at
  `/tmp/dbusk-album-pinata-audit.json` and
  `/tmp/dbusk-local-mirror-journal.json`; these are temporary diagnostic files.
  A complete import manifest still needs live NFT/playlist reconciliation and
  review of recordings with alternate encodings and expanded album scope.

- Archive caches, selection, detail links and coin placement distinguish
  chain/contract/token identities. `additionalNftContractAddresses` is empty;
  v0.2 remains the configured collection. Both archive and CLI/worker scans
  support additional collections. Worker scans retain v0.2 and accept optional
  `DECENT_NFT_ADDITIONAL_ADDRESSES` (comma-separated); every scan must succeed
  before playlist reconciliation. Existing playlist token IDs and statistics
  remain intact; `nftReferences` carries verified collection-qualified refs.
- Admin selected-song minting supports v0.3 behind `nftBatchMintEnabled: false`.
  It prepares metadata, estimates gas, limits batches to 20 songs, uses one
  transaction and matches receipt events to metadata/recipients. It does not
  automatically rebroadcast after Discord reconciliation fails.
- Local DecentMarket now also contains the undeployed
  `contracts/DecentJukeBox_v0.1.sol` candidate and its tests. It escrows USDC,
  enforces FIFO and a user-specified maximum price, snapshots collaborator
  shares, and routes 10% through `fundToken` on fulfillment. The remaining 90%
  becomes artist withdrawal credit. This delayed settlement and withdrawal
  workflow is a candidate design requiring user review, not a deployed feature.
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
- The durable playback journal is tested but not attached to the live radio or
  Pinata store. It checkpoints before acquisition, retries failures after restart
  and preserves completed playback awaiting fulfillment. Its synchronization
  input must come from verified contract state; chain-order reconciliation and
  external fulfillments still need integration testing.
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

Browser retry of the user-confirmed ipfs.io URL returned a Cloudflare challenge
(HTTP 403) rather than player content. The user reports that the same gateway
plays the albums in their browser. This environment's automated-access failures
are not evidence of dead CIDs; use accessible player HTML/manifests from the
working browser session or another available gateway to complete the audit.

Next activation gates: finish paid-play scheduler and worker signer integration,
implement approved paid-play accounting and payer-consented replacement flow,
wire browser quote/approval/request actions, make mint completion verification
explicitly collection-qualified, export ABIs, complete adversarial tests and
testnet rehearsal, and recover accessible album manifests before duplicate
review/import. Do not enable payments or batch signing before these gates.

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
does the next request price. Every price allocates 10% to the repo-dev-fund
and 90% to the song's artist, including approved collaborator splits.
Verify the existing fund's on-chain identifier and deposit route before wiring
this allocation; do not substitute an assumed wallet address.

Native Base USDC is the approved payment asset. At its six decimals, the
starting price is 250,000 units: 25,000 for the fund and 225,000 for the
artist/collaborators. Keep fractional-cent splits exact. The payment contract
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