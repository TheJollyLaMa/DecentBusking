# Community Pinner Network (design, Phase 1)

Status: **design only**. Rewards stay off. Nothing here changes code behavior,
moves funds or alters contracts. Tracking issue: #497.

## Where we are today

| Piece | Code | What it does now |
| --- | --- | --- |
| Checkpoint mirror service | `discord-bot/checkpoint-mirror.js` (`createCheckpointMirror`) | In-memory job queue on the Render worker. `mirror(bytes, { required })` enqueues exact checkpoint bytes; `claimWait` long-polls (10 s); `acknowledge` resolves the job when the client returns the expected CID with `recursivePinned: true`. Available = polled within 30 s. |
| HTTP routes | `discord-bot/ipfs-worker.js` `POST /api/checkpoint-mirror/claim\|ack` | Bearer auth with one shared `CHECKPOINT_MIRROR_SECRET`. |
| Mirror client | `discord-bot/checkpoint-mirror-client.js --watch` | Operator Mac. Verifies the CID, allowlists checkpoint shapes, imports into loopback Kubo, verifies the recursive pin, then acks. |
| Save policy | `discord-bot/ipfs-state.js` (`requireLocalMirror`) | **Required** stores (DJuke playlist batches, DeVert paid journal, DMTv radio, DCal rewards, some live-audio state) call `beforeUpload(..., { required: true })` *before* the Pinata upload and fail if the mirror is offline. Other stores upload to Pinata first and mirror best-effort. |
| Manifest | `js/pinner-rewards.mjs` `buildCommunityPinManifest`, served at `GET /api/pinners/manifest` | Latest playlist checkpoint + pinned tracks + `payrollAssets.communityAlbumRoots`; `rewardStatus: 'not-active'`. |
| Visitor pinning | `js/community-pinning.mjs` (header IPFS button) → `pinCommunityManifest` | Pins the manifest to local IPFS Desktop or the visitor's own Pinata. No registration, no reward. |
| Reward math | `allocatePinnerRewards` | Score = successful checks; eligible if ≥ 20 checks, ≥ 90 % availability and verified within 24 h. Pure function; nothing calls it for payouts. |
| Fund | `dbusk-pinners` (settlement router) | Receives the 8 % pinner share of DJuke, DeVert and other routed flows. No disbursal path. |

Gaps: one mirror (the operator's Mac), one shared secret that also authorizes
radio deployment and DMTv radio verification (`checkpointMirror.authorize` in
`index.js`/`ipfs-worker.js`), acks that are trusted rather than proven, and
required saves that block when that single Mac is offline.

## Goals

1. Any number of community pinners can hold copies of DecentBusking data.
2. Their availability is measured independently and feeds `allocatePinnerRewards`.
3. Weekly rewards from `dbusk-pinners` are prepared as reviewable payroll
   entries; the owner still signs every payout.
4. No single pinner (including the operator) can block the platform.

## Design

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
  shared, because it also authorizes radio deployment and DMTv verification.
- Status: `pending` (owner approval), `active`, `suspended`, `retired`.
  Owner approval is the Phase 2 default (see decisions).
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

## Phased rollout

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

Each phase needs owner approval before deployment; no contract changes are
anticipated (the settlement router already supports per-reference payouts).

## Owner decisions needed

1. **Admission:** open registration, or owner-approved pinners only (recommended
   for Phases 2–3)?
2. **Required-save policy:** value of K, which pinners count toward K, and
   whether any store may fall back to "Pinata-only + alert" when fewer than K
   mirrors are healthy.
3. **Public vs operator-only checkpoints:** which stores may be mirrored to
   community pinners.
4. **Weekly budget rule** for `dbusk-pinners`: fixed amount or % of unreserved
   balance; minimum payout; whether the operator's own wallet is eligible.
5. **Eligibility thresholds:** keep 20 checks / 90 % / 24 h, or change them;
   challenge frequency.
6. **Sybil limits:** per-wallet and per-ASN caps; whether to require distinct
   peerIds/IPs.
7. **IPFS Cluster:** run a trusted cluster core now, later, or not at all.
8. **Data retention** for challenger-observed IPs and challenge journals.
9. **Credential split:** approve moving radio deployment and DMTv verification
   to their own secrets before any pinner token exists.

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
