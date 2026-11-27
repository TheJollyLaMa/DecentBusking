# Community Pinner Network

New pinners: start with the plain-language [Earn by pinning guide](../wiki/Earn-by-Pinning.md).
This page is the technical design and operator reference.

Status: **manifest-pinner rewards implemented, deployment-gated**. Set
`PINNER_REWARDS_ENABLED=true` on the hosted worker to open enrollment after the
matching code is deployed. The header reports the actual service state. No
unattended transfers or contract changes are introduced. Wider checkpoint
fan-out and K-of-N durability remain future work in #497.

## Where we are today

| Piece | Code | What it does now |
| --- | --- | --- |
| Checkpoint mirror service | `discord-bot/checkpoint-mirror.js` (`createCheckpointMirror`) | In-memory job queue on the Render worker. `mirror(bytes, { required })` enqueues exact checkpoint bytes up to `CHECKPOINT_MIRROR_MAX_BYTES` (16 MiB; the playlist checkpoint passed 5 MB in November 2026), and queued best-effort jobs share a 32 MiB budget so Render memory stays bounded; `claimWait` long-polls (10 s); `acknowledge` resolves the job when the client returns the expected CID with `recursivePinned: true`. Available = polled within 30 s. |
| HTTP routes | `discord-bot/ipfs-worker.js` `POST /api/checkpoint-mirror/claim\|ack` | Bearer auth with one shared `CHECKPOINT_MIRROR_SECRET`. |
| Mirror client | `discord-bot/checkpoint-mirror-client.js --watch` | Operator Mac. Verifies the CID, allowlists checkpoint shapes, imports into loopback Kubo, verifies the recursive pin, then acks. |
| Save policy | `discord-bot/ipfs-state.js` (`requireLocalMirror`) | **Required** stores (DJuke playlist batches, DeVert paid journal, DMTv radio, DCal rewards, some live-audio state) call `beforeUpload(..., { required: true })` *before* the Pinata upload and fail if the mirror is offline. Other stores upload to Pinata first and mirror best-effort. |
| Manifest | `js/pinner-rewards.mjs` `buildCommunityPinManifest`, served at `GET /api/pinners/manifest` | Latest playlist checkpoint + pinned tracks + `payrollAssets.communityAlbumRoots`; reward status comes from the hosted reward service. |
| Visitor pinning | `js/community-pinning.mjs` and `js/pinner-rewards-ui.mjs` | Local pinning, wallet enrollment, local ownership marker, approval and personal earnings. A visitor's own Pinata copy remains voluntary, not reward-eligible. |
| Reward service | `discord-bot/pinner-network.js`, `GET/POST /api/pinners` | Discord-linked membership, signed owner approval, durable evidence and frozen weekly receipts. |
| Independent checks | `discord-bot/pinner-probe.js` | A fresh, empty Kubo probe connects only to the registered peer, verifies its ownership marker and samples public-content DAG blocks. No shared gateway or cached probe data can satisfy a check. |
| Reward math | `allocatePinnerRewards` | Called for estimates and closed weeks: score = successful checks; eligible if ≥ 20 checks, ≥ 90 % availability and verified within 24 h of the cutoff. |
| Fund | `dbusk-pinners` (settlement router) | Receives the 8 % routed pinner share. 100 % of unreserved closing USDC is allocated to qualifying wallets; owner-signed Payroll settles immutable weekly references. |

Remaining gaps: checkpoint replication still uses one operator mirror and one
operator-only mirror secret; required saves still depend on that mirror.
Radio deployment and DMTv verification now use separate secrets. Community
reward proofs never use any of those secrets and do not trust mirror acks.

## Join and keep your node earning

1. Run IPFS Desktop/Kubo and leave it running. Check available disk space before
   pinning the full public manifest. Media is retained; this program never
   removes existing pins or runs garbage collection.
2. Connect your Base wallet and link your Discord account in **Profile**.
   Both musicians and listeners may apply. Existing profile linking enforces
   one wallet per Discord member. The registry also prevents a member from
   enrolling a second wallet after relinking Discord. To change wallets, ask
   the admin to suspend the old node first; old frozen awards remain owed to
   their original wallet.
3. Open the header **IPFS** button → **Keep a copy**, choose **IPFS Desktop** and pin shared data.
   In **My node & rewards**, choose **Join pinner rewards**. Sign the enrollment message (no gas or
   transfer); the browser detects the local peer ID and pins a random ownership
   marker on that node. Marker bytes are not uploaded to shared Pinata.
4. Ask the admin to select **Verify node & approve** in the IPFS panel or
   **Payroll → Community pinner rewards**. The worker must retrieve the marker
   directly from your peer before approval succeeds. A different peer or a
   public gateway cannot substitute for that proof.
5. Keep shared content current with the dependency-free Node 22+ helper from
   this checkout:

   ```sh
   cd discord-bot
   npm run community-pinner
   ```

   It checks and recursively pins the current public manifest every 15 minutes.
   No bot token, wallet key, Pinata key or mirror secret is required. It never
   enrolls you, removes pins or claims a reward. For a different hosted worker,
   set `DBUSK_SERVICE_URL`; `IPFS_API_URL` must remain loopback. Keep the helper
   and IPFS Desktop running; arrange your own login/startup service if needed.
   New Pinata uploads are often not advertised on the DHT. When `pin/add` does
   not finish within 30 s, the helper (and the browser's local pin flow) fetches
   a trustless CAR from `https://gateway.pinata.cloud/ipfs/<cid>?format=car`,
   imports it with `dag/import?pin-roots=true` (Kubo hash-verifies every block)
   and requires the CAR root to equal the manifest CID. Set
   `PINNER_CAR_GATEWAY` to use another trustless gateway.

### Reachability and browser setup

The IPFS landing page shows registered membership, recent verification, weekly
qualification and the available/reserved pot. Its lines are not measured swarm
connections or geography. **Keep a copy** holds the existing pin controls;
**My node & rewards** holds enrollment and personal evidence/earnings.
An optional cost calculator uses your incremental electricity and hosting
estimates; neither byte coverage nor profitability is inferred.

On the node host, `node discord-bot/community-pinner-client.js --setup` makes
a private, exclusive backup before adding the exact site origin and HTTP
methods to existing CORS settings and enabling Kubo's built-in NAT port mapping.
It refuses non-loopback APIs and wildcard CORS, preserves other settings and
pins, and requires a manual IPFS restart. Backups contain node identity:
never publish them. `--diagnose` checks AutoNAT reachability afterward. This
cannot bypass native permissions, configure every router or resolve CGNAT.

Rewards require a publicly reachable **TCP or QUIC IPFS swarm address**, normally
port 4001. The worker discovers advertised public numeric addresses via the
standard IPFS HTTP peer-routing API, then connects directly to that peer.
Private IPs, DNS addresses and relay-only nodes are not supported in this pilot.
Router/NAT port forwarding may be needed; a node behind CGNAT may require a
publicly reachable host. The panel reports failed checks rather than claiming
that inaccessible pins earn rewards.

Keep the administrative Kubo API on `127.0.0.1:5001`. **Never expose port 5001
or a Pinata key publicly.** If the browser cannot detect/pin your node, allow
the actual DecentBusking page origin in Kubo's API CORS configuration and
approve any browser local-network permission. Do not use a wildcard origin.
Changing CORS requires a Kubo restart. A lost ownership marker can be replaced
with **Reset lost node marker** (or **Retry node setup** while pending),
followed by fresh owner approval. Resetting returns the node to pending;
previous frozen awards remain intact.

### Album roots blocked by a gateway

The AW album root currently receives Pinata's `ERR_ID:00023` HTML-content
restriction when requesting its CAR. Extra HTML/index content can trigger this
gateway policy; it does not demonstrate corrupt audio. Do not remove files or
rewrite minted references. A dedicated gateway or separately published
music-only derivative requires explicit review; removing a file changes the
root CID. Keep the original root and pins until a replacement is verified.

### Weekly terms and evidence

- Each approved node receives independently scheduled, unpredictable samples
  approximately once per hour. Checks verify the ownership marker plus
  CID-hashed public DAG blocks; heartbeats and self-reported pin counts do not
  earn credit. Infrastructure errors are surfaced and never invented as
  successful checks or backfilled as participant failures.
- At least **20 checks**, **90 % availability**, and a successful check in the
  last **24 hours** qualify at **Monday 00:00 America/New_York**. The operator
  may enroll under the same rules. This is sampled availability, not proof of
  continuous uptime or distinct physical hardware; owner approval remains the
  defense against shared-node/Sybil abuse.
- The **8 % incoming allocation** funds this pot; the separately approved
  **100 % weekly payout budget** uses its unreserved closing USDC balance.
  Historic closing balances and unpaid prior receipts protect existing awards
  and prevent later deposits from enlarging an old week.
- Successful checks weight wallet shares. No qualifying wallets means no
  payout; funds carry forward. Estimates can change and are not payments.
  Frozen receipts retain `dbusk-pinners:<NY-week>:<wallet>` references, verified
  on Base before every payment/retry.
- Evidence for each closed week is uploaded to immutable IPFS journals before
  it is removed from the hot checkpoint. Weekly receipts and journals are
  retained; no unpin/GC is performed. Public records contain wallet, peer ID,
  check metadata and amounts, not endpoint IP addresses or marker bytes.
  Registry checkpoints include a hashed Discord identity to prevent duplicate
  wallets; this is pseudonymous, not anonymous.

### Deployment and recovery

Pinning **promotional campaigns** are separate from the weekly allocation above.
Admin DCal can schedule extra capped ETH bonuses and optional NFT gifts; public
DCal shows how to qualify, links to joining and node enrollment, and shows joined
wallets a progress bar; verified campaign stats appear as a Profile **✨ For you** card.
Completed New York daily check summaries are stored as additive `campaignDays`
records in the same strict-restored pinner checkpoint before weekly checks are
pruned. They use campaign-scoped identity hashes when qualifying a claim; marker
bytes and private node endpoints are not published. Legacy checks without these
identity-bound summaries do not become invented historical campaign days.
See [Pinning bonus campaigns](PROMOTIONS.md#pinning-bonus-campaigns). Campaign
bonuses use `dbusk-promotionals`, not `dbusk-pinners`; this does not alter weekly
USDC policy, immutable receipts, replay protection or owner signing.

The existing Render worker runs enrollment, isolated probes and weekly
preparation. `npm install` installs the pinned official `kubo` binary at build
time; runtime never downloads a missing binary. Probes use fresh temporary
repos with no bootstrap, discovery or content routing and clean up only those
temporary repos, never the operator's IPFS data.

Deploy matching mirror validation before enabling the worker, then deploy the
header/payroll UI. Set `PINNER_REWARDS_ENABLED=true`. Verify `/api/pinners`
reports `ready: true`, `rewardStatus: "active"` and the expected Base router,
and `/api/pinners/manifest` reports the same active state. An empty enrollment
list is not an already-earned reward.

The `pinner-network` Pinata checkpoint is strict-restored. Invalid/unavailable
state disables reward readiness; it is not silently reset. Frozen receipts
are hash-validated; paid work references are reread from Base. The Payroll
panel reuses the radio settlement's recipient approval, preflight, transaction
confirmation and replay-protection helper. Owner approval remains separate
from actual USDC transfer.

## Goals

1. Any number of community pinners can hold copies of DecentBusking data.
2. Their availability is measured independently and feeds `allocatePinnerRewards`.
3. Weekly rewards from `dbusk-pinners` are prepared as reviewable payroll
   entries; the owner still signs every payout.
4. No single pinner (including the operator) can block the platform.

## Wider checkpoint-network design (not yet implemented)

### 1. Registration and per-pinner credentials

- A pinner signs an EIP-191 message with their Base wallet:
  `DecentBusking pinner registration v1 · peerId · endpoint kind · nonce · expiry`.
  The worker verifies the signature and stores a pinner record
  `{ wallet, peerId, kind: 'kubo'|'cluster'|'pinning-service', label, createdAt, status }`
  in a Pinata-checkpointed journal (same `createPinataStateStore` pattern).
- The worker issues a **per-pinner token** (random 32 bytes; only its hash is
  stored) scoped to `claim`/`ack`/`challenge` for that pinner. Tokens are
  revocable and rotatable by re-signing. The existing
  `CHECKPOINT_MIRROR_SECRET` stays the **operator** credential and is never
  shared. Radio deployment and DMTv verification already have separate secrets.
- Status: `pending` (owner approval), `active`, `suspended`, `retired`.
  Pinners are admin-approved (see decisions).
- `peerId` is proven by the first challenge (the node must serve the challenge
  blocks over Bitswap from that peer).

### 2. What is pinned

- **Checkpoints:** the exact bytes the mirror queue already carries (CIDv1,
  raw leaves, 256 KiB chunks). Community pinners receive only checkpoint kinds
  marked public; see Privacy.
- **Manifest:** `buildCommunityPinManifest` output (playlist checkpoint, pinned
  audio, album roots), published as its own CID each time it changes. Pinners
  pin the manifest CID plus every entry.
- The client keeps its current CID and shape verification. Per-pinner jobs are
  fan-out copies of the same job; each pinner acks independently.

### 3. Independent availability challenges

Acks prove nothing remotely, so rewards use worker-run challenges:

- At random times (target ~24/day per pinner, jittered), the challenger picks a
  random CID from the pinner's assigned set and a random block within its DAG.
- It retrieves that block **from the pinner's peer only** (Bitswap via a
  dedicated Kubo/Helia node using `routing/findpeer` + `swarm connect`, or an
  HTTPS gateway endpoint the pinner registered) with a short timeout
  (e.g. 20 s), then hashes it against the expected multihash.
- Result `{ wallet, cid, blockIndex, ok, latencyMs, at }` is appended to a
  checkpointed challenge journal. Challenges must not be predictable or
  answerable by proxying Pinata: require the block from the registered peer,
  and periodically challenge recently added, low-replication content.
- Optional Phase 3 hardening: a second challenger host so the worker is not the
  only witness.

### 4. Feeding `allocatePinnerRewards`

For a closed week (Monday 00:00 `America/New_York`, matching payroll buckets):

```js
pinners = activePinners.map(p => ({
  wallet: p.wallet,
  successfulChecks: count(challenges, p, ok),
  failedChecks: count(challenges, p, !ok),
  lastVerifiedAt: latestOk(challenges, p),
}));
allocatePinnerRewards({ fundBalanceUnits: weeklyBudgetUnits, pinners,
  now: weekEnd /* freezes staleness at the cutoff */ });
```

Score is successful checks, so a pinner holding more assigned content (more
challenges) earns more. The defaults (20 checks, 90 %, 24 h) stay unless the
owner changes them. Operator wallets are excluded unless the owner opts in.

### 5. Weekly payroll-queue entries

- A weekly receipt (schema `pinner-rewards/v1`) records the week, budget,
  inputs digest, challenge-journal CID and per-wallet `amountUnits`, frozen at
  the cutoff and published to IPFS like Playback/Top 10 receipts.
- Each recipient becomes a payout entry with work reference
  `dbusk-pinners:<NY-week>:<wallet>`, shown in the **💸 Payroll** panel as a
  **Pinner rewards** card beside Playback/Top 10, using the existing router
  `completedWorkReferences` replay protection. Entries come from the receipt,
  not `payroll-queue.json` (pinners are wallets, not GitHub contributors),
  mirroring how Supporter tokens owed are sourced.
- Budget: a fixed weekly amount or a percentage of unreserved `dbusk-pinners`
  balance; unallocated amounts and rounding stay in the fund. No automatic
  transfers; the owner signs each payout.

### 6. Required saves with N pinners (K-of-N)

Replace "the one local mirror must ack" with a policy:

```
required save succeeds when
  Pinata upload succeeds  AND  acks from ≥ K healthy mirrors (default K = 1)
  where healthy = active pinner polled < 30 s ago
  and the operator mirror is just one eligible mirror
```

- Jobs fan out to all healthy mirrors; the save resolves at the K-th valid ack
  (CID match + recursive pin). Late acks still count toward replication stats.
- If fewer than K mirrors are healthy, keep today's fail-closed behavior for
  money-bearing journals but expose a clear status; the owner may choose
  "Pinata-only with alert" for low-risk kinds (decision below).
- Only `trusted` pinners (owner-approved, long healthy history) count toward K
  in early phases, so an untrusted node cannot satisfy durability by itself.
- Persist the job queue (or make re-enqueue on restart explicit) so a worker
  restart does not silently drop pending required mirrors.

### 7. IPFS Cluster option

For pinners who run several nodes, or for a trusted core (operator + a few
long-standing members), an IPFS Cluster with `replication_factor_min = 2` lets
one registration represent a cluster: the worker pins once via the Cluster
REST API (HTTPS, per-cluster token) and challenges each cluster peer. Rewards
go to the registered wallet, not per peer, so a cluster cannot multiply its
score by adding peers that serve the same blocks.

### 8. Sybil and abuse

- One physical copy behind many wallets: challenge per peerId, require distinct
  peerIds and (soft) distinct IP/ASN; cap rewards per wallet and per ASN;
  owner approval during early phases.
- Proxying Pinata/public gateways: only accept blocks fetched from the
  registered peer; challenge unpopular blocks; measure latency.
- Ack spam or malformed acks: per-pinner token rate limits, size limits as
  today, and acks never affect rewards (challenges do).
- Collusion with the challenger: challenge schedule and selection are secret
  until execution; challenge journal is public after the week closes.
- Revocation: suspend a pinner, invalidate the token, and exclude the week's
  results pending review; frozen receipts are never edited.

### 9. Privacy

- Pinners only receive **public** content: the manifest and checkpoint kinds
  already published on public Pinata. Before fan-out, classify each store
  (playlist, batch journals, DeVert/DMTv journals, DCal rewards, live audio,
  promotions) as public or operator-only; operator-only kinds stay on the
  operator mirror.
- Registration stores wallet, peerId and label only; no email or Discord ID is
  required. Public receipts show wallets and amounts, like other payroll.
- IP addresses seen by the challenger are used for abuse checks, not
  published, and are retained for a short, stated period.
- Visitors' own Pinata keys remain browser-only, as today.

## Original wider-network rollout

1. **Phase 1 (this PR):** stable operator mirror under launchd (below); this
   design doc. No behavior changes.
2. **Phase 2:** wallet registration + per-pinner tokens; fan-out mirror jobs;
   challenge journal running in shadow mode (published stats, no rewards);
   per-store public/operator-only classification.
3. **Phase 3:** K-of-N required-save policy (start with operator + one trusted
   pinner, K = 1); persistent mirror queue; header dialog shows registration
   and personal availability.
4. **Phase 4:** weekly `pinner-rewards/v1` receipts and Payroll panel card;
   owner-signed payouts from `dbusk-pinners`. Optional IPFS Cluster core.

The manifest reward pilot above delivers enrollment, peer-only verification
and weekly payroll without exposing the operator mirror's claim/ack API.
Checkpoint fan-out, per-pinner mirror tokens, persistent multi-mirror jobs and
the K-of-N policy remain future work. No contract changes are anticipated.

## Owner decisions (2026-11-25)

1. **Admission:** pinners must be admin-approved.
2. **Required saves:** Pinata plus at least **1** approved pinner (K = 1). If no
   pinner is healthy for about 5 minutes, save to Pinata only and alert the
   admin; the platform never freezes on pinner availability.
3. **Mirror scope:** everything that is not a secret.
4. **Budget:** **100 %** of the unreserved closing `dbusk-pinners` USDC fund,
   approved on 2026-11-25; prior unpaid awards remain protected. The operator's
   wallet is eligible under the same checks.
5. **Eligibility:** as proposed (at least 20 checks, 90 % availability, a check
   within 24 h).
6. **Sybil rule:** one wallet = one Discord member = one possible pinner.
   Admission now includes both musicians and listeners, as requested on
   2026-11-25; all require admin approval.
7. **IPFS Cluster:** not now. Start with manifest pinners and our own
   challenges; revisit at about 5+ pinners or when the dataset is too large for
   one person to hold.
8. **Retention:** media (audio, video, artwork, NFT metadata, albums) is kept
   forever. Checkpoints keep the latest per store, one per day for 90 days and
   one per month forever; superseded versions are archived (CAR + CID manifest,
   verified) before unpinning. Implementation: #499. At decision time the
   operator node held 22.2 of 25 GB and checkpoint churn was about 190 MB/day.
   Challenge journals and challenger-observed IPs: proposed to follow the same
   90-day detail window, with weekly reward summaries kept permanently
   (pending owner confirmation).
9. **Credential split:** approved. Radio deployment and DMTv verification get
   their own secrets, done with the verifier's move to Render (#496), before any
   pinner credential exists.

## Operator mirror (launchd)

The operator's mirror runs from a dedicated detached checkout of `main`, so
feature-worktree cleanup never stops it.

- Checkout: `/Users/j/DevTree/DecentBusking.services` (detached at
  `origin/main`, holds no branch). Dependencies: `npm ci` in `discord-bot`.
- Secrets stay in the existing private env file, loaded with
  `--env-file=/Users/j/DevTree/DecentBusking/discord-bot/.env`
  (`PUBLIC_WORKER_URL`, `CHECKPOINT_MIRROR_SECRET`, optional `IPFS_API_URL`).
- Agent: `~/Library/LaunchAgents/com.decentagency.dbusk-checkpoint-mirror.plist`
  with `RunAtLoad` and `KeepAlive` (restarts on crash and at login).
- Logs: `~/Library/Logs/DecentBusking/checkpoint-mirror.log` (verified pins)
  and `checkpoint-mirror.err.log` (errors). Idle polling is silent.
- IPFS Desktop (Kubo on `127.0.0.1:5001`) must also start at login.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.decentagency.dbusk-checkpoint-mirror</string>
  <key>WorkingDirectory</key><string>/Users/j/DevTree/DecentBusking.services/discord-bot</string>
  <key>ProgramArguments</key><array>
    <string>/opt/homebrew/bin/node</string>
    <string>--env-file=/Users/j/DevTree/DecentBusking/discord-bot/.env</string>
    <string>checkpoint-mirror-client.js</string><string>--watch</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/Users/j/Library/Logs/DecentBusking/checkpoint-mirror.log</string>
  <key>StandardErrorPath</key><string>/Users/j/Library/Logs/DecentBusking/checkpoint-mirror.err.log</string>
</dict></plist>
```

Install / status / stop:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.decentagency.dbusk-checkpoint-mirror.plist
launchctl print gui/$(id -u)/com.decentagency.dbusk-checkpoint-mirror | grep -E 'state|pid'
tail -f ~/Library/Logs/DecentBusking/checkpoint-mirror*.log
launchctl bootout gui/$(id -u)/com.decentagency.dbusk-checkpoint-mirror   # stop + unload
```

Update after a merge to `main`. The restart gap is a few seconds; the worker
treats the mirror as available for 30 s after its last poll, so required saves
are not interrupted by a quick restart:

```sh
cd /Users/j/DevTree/DecentBusking.services
git fetch origin && git checkout --detach origin/main
(cd discord-bot && npm ci)
launchctl kickstart -k gui/$(id -u)/com.decentagency.dbusk-checkpoint-mirror
```

Do not run a second copy from a feature worktree. Overlap is harmless (the
first valid ack wins; the other gets a 400) but wastes work and log noise.
