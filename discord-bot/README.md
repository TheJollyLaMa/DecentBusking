# DecentBusking Jukebox Bot

A Node.js Discord bot with three modes:

1. **Upload → IPFS Pin → Mint Request** — watches the `#DecentJukebox` channel for audio file uploads, pins them through Pinata (or a local Kubo node), and lets the uploader request an owner-approved Base mint.

2. **IPFS Radio & Personal Jukebox** — slash commands that stream an IPFS album directory to a Discord voice channel (`/radio`) or send you a private numbered playlist via DM (`/jukebox`).

3. **JukeLoop** — 24/7 community radio that continuously plays every audio file posted in `#DecentJukebox` in the `JukeLoop` voice channel. New tracks play from their stored IPFS CID, with Discord attachment fallback for legacy records. Track order is influenced by 👍/👎 reactions so popular tracks appear more often.

The bot holds **no on-chain private key**. An authorized owner reviews the queue and confirms each mint in MetaMask. The NFT is minted directly to the artist wallet, which is also configured as the ERC-2981 royalty receiver.

The website named-playlist library is separate from Discord `/radio` and `/jukebox`; saved copies pin a revision and attribution. Named radio checkout is not enabled until a compatible DJuke deployment and batch-aware worker are configured. See the [playlist rollout and settlement rules](../docs/DJUKE-PLAYLISTS.md).

---

## Quick Start

### 1. Prerequisites

- Node.js ≥ 18
- **FFmpeg** installed and available on the system `PATH` (required for `/radio` and JukeLoop voice streaming)
  - Ubuntu/Debian: `sudo apt install ffmpeg`
  - macOS: `brew install ffmpeg`
  - Windows: download from [ffmpeg.org](https://ffmpeg.org/download.html) and add to `PATH`
  - Or set `FFMPEG_PATH` in `.env` to point to a custom binary
- A Discord bot application with the **Message Content** privileged intent enabled
- A Pinata account and server-side JWT for production, or a local Kubo/IPFS Desktop node

### 2. Install dependencies

```bash
cd discord-bot
npm install
```

### 3. Configure environment variables

```bash
cp .env.example .env
# Edit .env with your values
```

| Variable                     | Required | Description |
|------------------------------|----------|-------------|
| `DISCORD_TOKEN`              | ✅        | Bot token from the [Discord Developer Portal](https://discord.com/developers/applications) |
| `JUKEBOX_CHANNEL_ID`         | ✅        | Numeric ID of the `#DecentJukebox` channel to watch for uploads |
| `IPFS_UPLOAD_PROVIDER`       | ✅        | `pinata` on Render or `local` with Kubo/IPFS Desktop |
| `PINATA_JWT`                 | Pinata    | Server-only Pinata JWT; never expose it in browser code |
| `PUBLIC_WORKER_URL`          | Pinata    | Public URL of this Render service |
| `IPFS_ALLOWED_ORIGINS`       | Pinata    | Comma-separated browser origins allowed to request upload URLs (for example: `https://thejollylama.github.io,https://decentbusking.com,https://www.decentbusking.com,http://localhost:4173,http://127.0.0.1:4173`) |
| `MINT_OWNER_WALLET`          | Pinata    | Base admin wallet allowed to authorize browser uploads |
| `PINATA_API_URL`             | ❌        | Direct upload API; defaults to Pinata v3 |
| `PINATA_SIGN_URL`            | ❌        | Signed upload API; defaults to Pinata v3 |
| `PINATA_FILES_API_URL`       | ❌        | Files API used to discover the latest JukeLoop state snapshot |
| `IPFS_API_URL`               | Local     | Kubo RPC API; defaults to `http://127.0.0.1:5001` |
| `SITE_URL`                   | ❌        | DecentBusking site URL (default: `https://thejollylama.github.io/DecentBusking`) |
| `IPFS_GATEWAY`               | ❌        | IPFS HTTP gateway base URL (default: `https://dweb.link`). Radio playback falls back to `gateway.pinata.cloud`, then to the account's dedicated Pinata gateway (discovered via `PINATA_JWT`) when public gateways rate-limit. A paid request that still can't be fetched stays queued and retries every 60s while free rotation keeps playing. |
| `FFMPEG_PATH`                | ❌        | Path to `ffmpeg` binary (default: `ffmpeg` from `PATH`) |
| `JUKE_LOOP_VOICE_CHANNEL_ID` | ❌        | Numeric ID of the `JukeLoop` **voice** channel — enables 24/7 radio |
| `ANNOUNCE_CHANNEL_ID`        | ❌        | Calendar promotion and automatic reminder destination, default `943117480883265539` (#themessagebox); independent of playback/payroll channels |
| `ANNOUNCE_DEFAULT_MENTION`   | ❌        | `everyone` (default), `none`, or comma-separated **mentionable guild role IDs**; use JukeboxHero's numeric role ID to change the default without code changes |
| `JUKE_LOOP_TEXT_CHANNEL_ID`  | ❌        | Numeric ID of the `JukeLoop` **text** channel — where "Now Playing" posts go |
| `DEVERT_CONTRACT_ADDRESS`    | DeVert    | Deployed DeVert campaign contract address; endpoint stays unavailable when unset |
| `DEVERT_SCHEDULER_PRIVATE_KEY` | DeVert   | Optional override; defaults to the existing `DJUKE_FULFILLER_PRIVATE_KEY` |
| `DEVERT_CONFIRMATIONS`       | ❌        | Confirmations for public DeVert campaign reads (default: `2`) |
| `WORKER_MIN_BALANCE_WEI`     | DeVert   | Optional low-balance threshold (wei) for DeVert reporting; defaults to `20000000000000` (0.00002 ETH). Below this, impressions and music reports stay in the journal until the worker is funded again |
| `WORKER_ESTIMATED_DAILY_BURN_WEI` | DeVert | Optional runway estimate for the worker-gas notice; defaults to the observed daily burn rate used in the operator UI |
| `DVERT_LOOP_DISCORD_TOKEN`   | AdLoop   | Separate bot token for the dedicated ad-only voice channel |
| `DVERT_LOOP_DISCORD_ENABLED` | AdLoop | Defaults off. Only literal `true` enables the separate Discord login, voice rotation, announcements, and bot intake; otherwise the website loop remains active |
| `VERT_LOOP_CHANNEL_ID`       | AdLoop   | ID of the `#vertloop` text channel for announcements/submissions |
| `VERTLOOP_VOICE_CHANNEL_ID`  | AdLoop   | ID of the `VertLoop` voice channel for the dedicated ad rotation |
| `DVERT_LOOP_AD_INTAKE_ENABLED` | AdLoop | Enable DVertLoop intake in DecentJukebox after enabling Message Content intent for that bot |
| `DISABLE_MINT_FLOW`          | ❌        | Set to `true` to skip IPFS pinning and the Mint embed (JukeLoop-only mode). Default: `false` |

> JukeLoop is **opt-in**: omit `JUKE_LOOP_VOICE_CHANNEL_ID` / `JUKE_LOOP_TEXT_CHANNEL_ID` (or leave them blank) to keep the bot running without it.

DeVert campaigns use the existing JukeLoop rotation after each ten completed
audible music plays. The DJuke fulfiller wallet also holds DeVert's
`SCHEDULER_ROLE`. A second Discord bot is required for AdLoop because a bot cannot
join two voice channels in the same guild. The DVert panel's Ads Only mode mirrors
that live loop; browser playback never creates paid impressions. The optional
ad-mute preference affects only the visitor's main-radio audio. A confirmed DJuke
request boosts a campaign only when the payer has exactly one active campaign;
ambiguous requests are skipped rather than assigned arbitrarily.
`GET /api/radio` includes `nowPlaying.sponsor` for paid DJuke requests and
DeVert ads so the site can show the payer/advertiser next to the live player;
DJuke sponsors include the verified payer address, `requestId`, and `amountUnits`.
Campaign video metadata is recovered from the on-chain NFT catalog as well as
the playlist, matching the campaign media CID and advertiser wallet. A minted
advert need not remain in the music playlist to play as video on the website.
If a pending main-radio impression reverts with `No seated main-radio slot`,
it stays pending with a durable retry cooldown. This does not block scheduler
startup, VertLoop playback, or reporting the next music milestone to unlock slots.
Other unexpected contract failures still surface as errors.
At track transitions, overdue adverts are checked again before prefetched music
starts, because a slot can unlock after prefetch. Already prepared paid DJuke
requests retain priority; lookup failures keep music playing and are logged.
Between items the bot waits `CHANGEOVER_GAP_MS` (2.5 s) before starting the
next prepared track, and `GET /api/radio` publishes it as `upNext` (`trackId`,
`title`, `ipfsCid`, `mediaType`, `videoUrl`, `isDevert`, plus `startsAt` /
`startsInMs` during the gap). The website preloads `upNext` into an in-memory
Blob (≤ 80 MB; skipped for Save-Data/2G, blocked autoplay, ads-only and archive
listeners), so each new song or advert starts from 0:00 instead of seeking past
a slow gateway start. Listeners who join mid-song, or fall more than 45 s
behind, still sync to the live position. Preloading never records an
impression; the browser's `getRadioTransitionDiagnostics()` and `[radio]`
console logs report preload vs network startup timing. An advert that becomes
due on the current song is selected while that song plays so it can be
preloaded; if the song ends before counting (under 30 s audible), the advert
is held for the next break and music plays instead.

Website radio starts from the restored playlist before Discord gateway login.
Its real audio player consumes decoded media in real time with
`NoSubscriberBehavior.Play`, even with no Discord voice subscriber. Discord
gateway failures, voice disconnects and text delivery therefore do not pause the
website broadcast clock. This is not a duration-only timer: paid completion still
requires the existing natural media completion and minimum playback checks.
These are broadcast-play checks, not proof that an individual browser listened.
The browser media proxy retains its own upstream stream-error listener, including
after a listener disconnects, so a truncated gateway response is logged without
becoming an unhandled stream error that terminates the worker.

Once Discord becomes ready, the existing broadcast attaches its text channel
and posts the current recording, then continues scrolling songs and adverts.
Announcements missed while disconnected are not replayed as a stale backlog.
Command registration and historical backfill do not gate website playback.
Discord voice remains an optional output: set `JUKE_LOOP_VOICE_ENABLED=false`
to omit it while retaining text posts. `JUKE_LOOP_TEXT_CHANNEL_ID` enables the
radio; a voice channel ID is no longer required.
Failed FFmpeg preparation destroys its stream and terminates the failed process
before moving to another recording. Paid-queue selection has a 10-second deadline;
a still-pending lookup is not duplicated, and a late reservation is returned to
its queue rather than charged for an unplayed recording.

The session checks playback health every second. Two minutes without active audio
triggers a logged website session restart through the existing backoff. Playing
recordings, scheduled live-performance blocks and genuinely empty playlists are
not interrupted. `GET /api/radio` exposes `playback.status`, `ready`, `reason`
and, while preparing, `idleMs`. The website distinguishes a short changeover from
offline/recovering/paused playback and warns after 30 seconds of preparation.
Paid advert checkout requires actual active playback and the local checkpoint
mirror, not merely a registered session or a successful HTTP health check.
Discord gateway login logs connection stages and rate-limit delays without
tokens or payloads. If the client does not become ready within two minutes,
the connection failure is logged explicitly while website playback continues.
Both clients reject gateway-discovery HTTP 429s back to the recovery supervisor
rather than leaving a second retry loop inside discord.js. The supervisor
respects Discord's persisted `Retry-After` instead of repeatedly restarting.
Initial logins are serialized: the second bot rechecks the shared persisted
deadline after the first bot's attempt, before making its own request.
`GET /api/radio` reports Discord separately as `discord.ready` / `discord.reason`;
paid-checkout readiness follows actual broadcast playback and checkpoint safety,
not Discord connectivity.

Both bots now have a connection supervisor. Transient startup failures retry with
fresh clients after 30 seconds, then 60 seconds, doubling to a 15-minute ceiling.
An invalidated session is cleaned up and reconnected without replacing the website
broadcast; ordinary gateway reconnects remain managed by discord.js. Invalid
credentials, forbidden startup access and invalid/disallowed gateway intents stop
automatic retries and report `blocked` for operator attention. Fix credentials or
permissions before restarting. Graceful shutdown cancels pending login/backoff
and releases the current connections. Background jobs are installed once, not
once per reconnect. Transient text-channel attachment failures retry once per
minute; forbidden access stops that retry until an operator fixes permissions and
restarts JukeLoop.

Gateway and global HTTP 429 cooldowns are saved to the separate
`decentbusking-discord-cooldowns.json` Pinata checkpoint (`discord-cooldowns` tags).
Only the newest checkpoint is restored. If restore fails, Discord connections
wait and retry storage restoration; website radio continues. If saving fails,
the current process still respects the deadline, reports `persistence: failed`,
and retries checkpointing each minute. Do not redeploy during a failed save:
first preserve the logged deadline with `DISCORD_LOGIN_NOT_BEFORE` (UTC ISO time).
This setting also supports restrictions discovered before automatic persistence
was installed. An unscoped gateway restriction conservatively delays both bot
logins because it may be IP-based; a token-global restriction delays only that bot.
Do not rotate IPs, change endpoints or restart repeatedly to evade a restriction.
An expired timestamp has no effect and can be removed during routine maintenance.

#### Diagnosing Discord in place

Read `GET /api/radio` and inspect `discord.diagnostics` before restarting:

* `bots.dbusker` and `bots["devert-loop"]` show connection phase, `retryAt`,
  cumulative failed attempts, HTTP totals and recent lifecycle/error events.
* `routes` counts successful and failed responses by sanitized route, method and
  status, including responses to network retries. `retries` counts responses whose
  discord.js network retry index is nonzero; rate-limit waits remain separate
  lifecycle events. `traffic` reports response counts in the current second,
  trailing minute and trailing ten minutes, plus process-lifetime peaks for a
  second and a trailing minute. Windows use one-second buckets. These are observed
  response rates, not outbound request-start timestamps or IP-wide traffic totals.
* `invalidLast10Minutes` counts observed 401/403 and non-shared 429 responses in
  a rolling window with one-second resolution. It is not Discord's authoritative
  IP-wide count and cannot identify another host sharing the egress IP.
* Error routes replace IDs, webhook tokens, reaction text and all unknown path
  components with `:id`. Query strings, bodies, usernames, authorization headers,
  arbitrary error messages and tokens are never copied into diagnostics.
* Rate-limit events include scope, global flag, retry deadline, limit/remaining
  and reset timing. Gateway restrictions retain a sanitized last incident across
  restarts, including JSON vs HTML response format and a validated Cloudflare ray
  ID when supplied, to correlate with support. These clues are not proof of an IP
  ban.
* `startedAt` identifies the current diagnostic observation period. Each bot's
  `restrictions` retains its ten most recent sampled HTTP 429 incidents across
  restarts, including message-route restrictions, plain-text vs JSON/HTML response
  format, and both bots' request/error totals and rolling invalid counts at the
  incident, together with route counts and burst peaks. Bucket, limit, remaining
  and reset timing survive checkpoint restoration too. Repeated incidents are
  sampled once per route/method/status per minute;
  login restrictions are always retained. These historical snapshots do not
  repopulate current-process counters or change which restrictions delay login.
  Older checkpoints seed history from their last saved login restriction, without
  inventing missing traffic counts. Response bodies are never retained.
* `observations` retains six traffic snapshots from five-minute checkpoints
  whenever traffic has changed, preserving roughly the last half hour of active
  observations across restarts. Each contains its own timestamp and observation
  start time; gaps must not be interpreted as zero traffic. Routine checkpointing
  does not run while idle. A sampled error log includes the immediate traffic
  context; HTTP 429 incidents checkpoint immediately, without waiting five minutes.
* Request counters start fresh per worker process. Recent events are capped at 30
  per bot, route/status groups at 64 (oldest groups are evicted), and repeated error logs at once per route,
  method and status per minute. A changed summary is logged every minute; it flags
  100 observed invalid requests within ten minutes as an early diagnostic warning,
  not a new Discord limit or an automatic traffic cutoff.
* Telemetry observes existing requests only; it does not probe Discord during a
  cooldown. Slash-command registration uses the same monitored REST client.
* A gateway restriction changes disconnected clients to `cooldown`, not a
  misleading indefinite `connecting`. Summaries include the retained restriction
  and cooldown deadline even when no further requests occur.

Interpret `401` as authentication trouble, `403` as access/permission trouble,
and a scoped `429` as a reported rate limit. Shared-resource 429s are excluded
from invalid-request counts per Discord's documentation. For an unscoped gateway
429, retain the retry deadline and incident metadata; do not assume voice caused
it or that the bot's login-session quota was exhausted.

For hosting-side escalation, provide Render support with the service ID, region,
gateway route (`GET /api/v10/gateway/bot`), HTTP status, `Retry-After` and UTC
timestamps from the safe logs. Never include bot tokens. Render documents
[shared regional outbound IPs](https://render.com/docs/outbound-ip-addresses);
Discord documents [IP-based invalid-request restrictions](https://docs.discord.com/developers/topics/rate-limits).
A successful local request with the same bot credentials supports a network-side
diagnosis, but does not prove another tenant caused the restriction. A standard
paid service upgrade alone does not establish exclusive egress:
[dedicated outbound IPs](https://render.com/docs/dedicated-ips) require a Pro
workspace and an additional fee. Obtain approval before any paid hosting change.

Advert cadence and queued-ad state use the separate
`decentbusking-main-radio-ad-state.json` checkpoint (`main-radio-ad-state` tags).
They must not share the playlist's `decentbusking-jukeloop-state.json` namespace:
the schemas differ and each store prunes its own snapshots.

### Calendar programming and rule-based radio hours

Open **Admin → Radio Programming** with the owner wallet. The weekly calendar
shows the Friday Top 10 (8 PM), Friday live block (9 PM), and Sunday Finish Line
(11 PM), all in **America/New_York**. Drag a preset to a time, or click a preset
or time slot and fill out the form. Click a card to edit it; drag it to move it.
Click/tap forms provide the same controls without dragging. Advanced controls
and immediate manual promotion remain in a collapsed section.
The enlarged Admin panel shows all seven day columns without horizontal scrolling.
On narrow screens, a day picker shows one full-width day instead of squeezing or
side-scrolling the week. Today's column and current half-hour slot are highlighted;
a New York **Now** line refreshes every 30 seconds without closing the editor.
**Today · now** returns to the current day/time. The 24-hour timeline scrolls
vertically; saving or refreshing the calendar preserves its scroll position.

### Monday community poster

Every Monday at **09:00 America/New_York** (EST/EDT automatically), DBusker posts
one `@everyone` community poster in DecentAgency's **#themessagebox**
(`943117480883265539`). The first scheduled occurrence is October 26, 2026.
The original orange/blue psychedelic artwork with metallic gold/silver accents
is maintained in `img/community-monday.svg`;
`img/community-monday.png` is the 1200 x 1500 Discord attachment. Rasterize the SVG
with a standards-compliant browser at its intrinsic resolution after artwork edits;
inspect the complete PNG before committing it. No image-generation service or
new runtime dependency is needed.

The poster asks people to check and sync **Public Schedule** in the right ankh
menu, run DVert adverts/public announcements to fuel the funds, submit radio
music and invite friends, and listen/vote. A short caption, accessible image
description, and clickable links accompany it. `?schedule=1` opens the actual
public schedule, including its calendar subscription controls, without a wallet.

The worker checks its local clock every minute but makes no reminder-related
Discord requests outside the delivery window. If unavailable at 09:00, it may
retry until 10:00 New York time; it does not catch up missed weeks later.
Discord cooldown/reconnect gates and channel permissions (including Attach Files
and Mention Everyone) are checked before delivery. Durable pending/sent receipts
use the existing Pinata checkpoint and mirror facilities under
`decentbusking-community-reminders.json`, separate from radio-show reminders.
An uncertain delivery is reconciled by its embed footer marker and never blindly
reposted; an unresolved pending receipt blocks further posts and requires operator
review of the channel and checkpoint. Logs and
`/api/radio` → `discord.communityReminder` expose readiness, next run, errors, and
last delivery. This adds one weekly post, not a Discord ad loop.

Reuse decision: adapt `radio-announcements.js`'s checkpoint-before-send, footer
reconciliation, permission, and cooldown patterns; reuse `radio-calendar.mjs`'s
New York conversion helpers and the public schedule's existing subscription UI.
DecentCalendar's payment-oriented prototype is not needed for this integration.

Each new radio hour lasts 60 minutes. **Part of the default program** repeats
it weekly, beginning on the selected date; unchecked means it plays once.
Weekly cards represent the series, so moving/removing one edits the series.
The Sunday Finish Line stays tied to payroll cutoff; its reminder can be disabled.
Overlapping playlist hours, default blocks, and dated performances are rejected
before signing and at the authenticated server endpoint. Hours may cross midnight.
Recurring hours retain New York wall-clock starts; in spring's missing 2 AM hour,
the occurrence moves forward one hour (exposed as `timeAdjustment`), and in the
repeated fall hour the first occurrence is used. Each radio hour still lasts 60
actual minutes. A nonexistent **one-off** start is rejected instead of guessed.

Built-in presets:

- **Top 10 Hour**: up to ten tracks with votes/qualified plays this New York
  payroll week, ranked by net score, then plays.
- **0 Votes / Songs Awaiting Your Vote**: known all-time human upvotes and
  downvotes both zero; shuffled.
- **Rising Stars**: finite recorded net votes in both this and the preceding
  payroll week, current score positive and greater than the prior score.
  Ordered by improvement, then plays. This is week-over-week growth, not a
  claim of daily steady growth: daily vote history is not available.

Preset rules are maintained in code with the operator; there is no front-end
rule builder. The three built-in presets are ready to schedule. The model
retains support for named, allowlisted selectors/rankings and song limits for
future code-managed presets. No executable code is accepted. Existing shows
retain their embedded rule revision when a saved preset changes.
The opening pool/order and cursor are durable; additions do not refill an
already-opened show. Empty/exhausted pools and unavailable checkpoint storage
fall back to normal rotation with an explicit public reason, rather than
claiming to fill a whole hour with unavailable qualifying music.

Schedule schema 3 is retained. `weeklySchedule` optionally includes `presets`,
`programs`, and default-show `reminders`; old schedules remain readable. Deploy
the worker and its shared model modules before releasing the new admin client.
Do not roll back to a worker that discards these fields after saving new programs.
Deploying this worker also enables the default reminders described below;
review the next scheduled shows and permissions before production rollout.

Reuse decision: this calendar adapts Busking's own `radioCalendarOccurrences`,
`currentPayrollPeriod`, `createPlaylistShow`, and `createRadioAnnouncements`
from main baseline `9482896`. The focused native calendar needs no new
dependency; no external calendar code was copied. Receiving-app coverage:
`radio-programming`, `radio-calendar`, `radio-schedule`, `radio-announcements`,
`playlist-show-runtime`, and authenticated `ipfs-worker` tests.

`js/radio-playlists.mjs` contains reusable, allowlisted definitions and a selector
boundary, including `songs-awaiting-your-vote` (`no-votes-ever`).
Calendar events use `type: "playlist_show"` and `playlistId`; they are not live
performances. Schedule snapshot v3 reads v1/v2 calendars without changing existing
live cancellations or weekly overrides. Owner authorization uses the existing
signed calendar endpoint; there is no new payment or signing path.

`discord-bot/playlist-show.js` persists up to 100 occurrence records (at most 10,000
selected identities per occurrence) in the dedicated Pinata checkpoint
`decentbusking-playlist-shows.json` (`kind=playlist-shows`). The existing checkpoint
storage/mirror configuration is reused; no extra secret is required. The occurrence
identity includes the event ID and start time. Editing a future start creates a new
occurrence, while live preemption/restart resumes the saved order/cursor. Advancing
before audio starts provides at-most-once selection across restart: a crash between
checkpoint and sound can lose that slot, but cannot replay it. Missing/unconfirmed
storage falls back to normal rotation with an exposed reason, never an unpersisted
playlist. A late capture is flagged in `/api/radio.playlistShow.lateSnapshot`.

Eligibility shares the normal-rotation music/approval predicate. Both `likes` and
`dislikes` must be known nonnegative integer all-time human totals, with neither
positive. Missing/null/incomplete totals are excluded and counted in the preview.
Existing site/Discord vote accounting is reused (including subtraction of the bot's
seeded reactions). A sticky `everHumanVoted` flag prevents removed reactions from
requalifying a track; retained historical Discord/weekly vote evidence also excludes
it. No votes are created by selection, playback, or fallback.

The opening pool is shuffled once and stored, never refilled during that occurrence.
Before actual audio starts, eligibility/votes are rechecked (including after media
prefetch and checkpoint I/O); voted or missing songs are checkpointed as skips.
Voting during playback does not cut the song off. Empty/exhausted/unavailable pools
return to ordinary weighted rotation for the rest of the block. The site/Discord
continue to identify the scheduled show and invite votes in either direction.

Policy: finish the current song at ordinary start/end boundaries. Live and Top10
preempt immediately; interrupted selections stay consumed rather than replaying.
All paid DJuke requests, including paid advert bumps, stay queued for after this
playlist occurrence, just as requests are deferred in protected programming; no
request is fulfilled/charged by a playlist selection. Ordinary DeVert breaks retain
their normal cadence and do not consume a playlist slot. Overlapping playlist
bookings are rejected; preview warns about live/Top10 conflicts. Runtime progress,
selected order, skipped reasons, unknown-count and fallback reason are visible at
`GET /api/radio` under `playlistShow`; `GET /api/radio/schedule` includes current
full-catalog definition previews. Durations are estimated only when every matching
track has a known duration; unknown does not mean zero or a guaranteed full set.

For scheduling tonight's 9–10pm ET one-off, follow
[the operator runbook](../docs/DJUKE-ROLLOUT.md#tonights-songs-awaiting-your-vote-runbook).
Wallet-curated sets, submission intake, playlist/fee binding and recurring curated
sets remain out of scope (#240 stays open).

Validation from the repository root: `node --test test/*.test.js` (CI's existing
payroll smoke subset is `node --test test/payroll.test.js test/commentArt.test.js
test/automation.test.js`). Focused tests:
`node --test test/radio-playlists.test.js test/playlist-show-runtime.test.js test/radio-schedule.test.js`.

### Friday Top10 Hype

The Friday Hype slot snapshots the current New York week's eligible chart at
entry and plays the fixed selection from its lowest opening place to #1, then
labelled encores in the same order until the scheduled handoff. Sunday Final
Listen and normal rotation keep their existing selection behavior. Paid requests
and all prepared/pending adverts are deferred during Friday Hype, not discarded.

The separate Pinata checkpoint `decentbusking-friday-top10-hype.json`
(`friday-top10-hype` tags, schema 1) contains the show-instance identity, opening
ranks, playback cursor, last reserved start, and skip reasons. A position is
checkpointed **before** audio starts: after a restart, previously reserved starts
are not replayed, even if the restart interrupted that song. Remaining places
keep their original ranks. This store only restores the newest checkpoint:
gateway fallback is allowed, but an older playback cursor must not be restored
when the latest CID is unavailable. Storage/restore failures pause the countdown with an
explicit public error instead of silently reshuffling or using regular rotation.
Unavailable recordings are visibly skipped; a fully unavailable selection waits
and retries rather than looping recursively forever. An empty opening chart stays
empty for that show.

Run the worker before the opening bell. If there is no saved snapshot and the
worker first enters the slot over 15 seconds late, its on-arrival snapshot is
explicitly labelled late; historical opening-bell votes cannot be reconstructed
from current aggregates. A late snapshot is not presented as the exact opening
chart. A restored snapshot retains its original capture time.

`GET /api/radio` publishes `activeShow` and `topTenHype`, plus `nowPlaying.hype`
for opening-rank/encore identification. The browser pins the existing chart panel,
continues live voting/ranking/prize updates, respects reduced motion, and restores
ordinary drawer behavior when the authoritative show ends (or its known deadline
passes during disconnection). Friday retains its configured end time; no guarantee
is made that all opening tracks fit. Weekly history includes media CIDs so the
chart's **+** buttons resolve the exact NFT before using the existing signed
profile-watchlist save flow. Unverified/unavailable media produces a visible error.

An advert can run again after its paid campaign expires; a single advert cannot
start another paid term from the DVert checkout while its current term is active.
Availability is checked again before purchase, including after USDC approval.
This is an application rule, not a new restriction in the deployed contract:
transactions made directly to that contract, or simultaneous transactions from
separate clients, cannot be atomically prevented by this UI check.
Active cards show their actual expiry rather than a generic locked state.
An unavailable advert slot is not the same as an expired campaign.

Advertisers can **Remove from playback** in My Ads; the radio owner has the same
control under **DVert campaign moderation** in Admin. `POST /api/devert/remove`
requires a fresh wallet signature bound to the campaign, origin and no-refund
terms. Only the campaign advertiser or configured worker owner wallet is accepted.
Removal is durably checkpointed before it takes effect. It excludes the campaign
from main radio and VertLoop, drops prepared/queued resources, and stops a current
server-side play. Already buffered client media cannot be remotely erased.
The on-chain campaign and expiry stay unchanged, there is no refund or restart
of that paid term, and the advert becomes reusable when the original term expires.
Removed campaigns do not free on-chain seats for other campaigns.
`GET /api/funds` exposes configured settlement funds (including Live Performers), current balances,
and proof-of-funding sources. The source ledger scans the router incrementally
from `PAYROLL_START_BLOCK` (or the stored cursor) and is cached for about 60s.
The public evidence contract is additive to `schemaVersion: 1`, with
`evidenceVersion: 1`, `source: "worker-rpc"`, `network: { chainId: 8453, name: "Base" }`,
the existing top-level `chainId` and `routerAddress`, and top-level/per-fund
`asset: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 }`.
This is worker-reported RPC/index evidence, not independent chain verification.
The reader rejects unsupported chain/token/decimal configuration rather than
labeling arbitrary assets USDC. Indexed sources and payouts only include this
asset; new deposit records include `asset`. Legacy checkpoints with deposits
missing asset identity rescan their stored range once to backfill it.

Successful amounts remain exact unsigned decimal unit strings, including `"0"`
for a successful zero read. **Unknown amounts are JSON `null`, never `"0"`**:

- Per fund, `balanceUnits` is nullable. `balanceAvailable`, `balanceCheckedAt`
  (the most recent read attempt, including a failed attempt), and `balanceError`
  distinguish a successful zero from RPC failure. One failed fund read does not
  discard healthy funds or change the separate history `ready`/`lastError`.
- `availableUnits` is null after a balance failure. For Playback/Top10 it is also
  null without a healthy weekly source; total balance is not a spendable-balance
  fallback. `reservedUnits` remains optional and is omitted when unknown.
  `weeklyAvailable`, `weeklyCheckedAt`, and `weeklyError` describe the weekly
  source independently. These fields do not guarantee weekly reconciliation or
  a common block/time between the balance and weekly snapshot.
- `sourcesAvailable`, `payoutsAvailable`, `historyCheckedAt`, and `historyError`
  describe the incremental history source. History can be unavailable even
  with a healthy balance. Retained partial/stale event arrays must not be
  presented as complete when unavailable; `advertUnits`, `sponsorUnits`,
  `djukeUnits`, and (when present) `payoutUnits` are null until history is ready
  and error-free. Empty arrays with availability false do not establish zero
  activity. Legacy `queryFilter` providers still omit payouts, with
  `payoutsAvailable: false`.

**Compatibility/deployment ordering:** existing successful string fields,
fund keys, event fields, routes, checkpoint schema and legacy history readiness
remain supported. Failure values deliberately change from false zero to null;
consumers requiring every amount to be a string must migrate first. In
particular, Canopy's deployed `scripts/busking-public-source.js` currently
rejects present null balance fields and can suppress the entire fund response.
Before any upstream production deployment, update/test/deploy that adapter to
accept nullable units, validate the explicit Base/router/USDC identity and
`evidenceVersion`, respect each availability/error/timestamp, and withhold
unknown amounts without hiding healthy event evidence. Test mixed healthy/
failed funds, real zero, uninitialized/stale history and recovery. Then deploy
this worker change, followed by synthetic/read-only integration checks.
Keep Canopy's balance display gated until that separate adapter work is accepted.
No independent receipt verification or weekly reconciliation is implied.
Owner-maintained sponsor aliases live in `payroll-assets.json.sponsorAliases` and
are only shown after a reverse lookup or verified forward resolution.

Worker gas is monitored. Optional DeVert reporting is deferred below
`WORKER_MIN_BALANCE_WEI` and retried automatically once the worker is funded
again. If the node still rejects a write with "insufficient funds", reporting
stays paused until the worker balance actually rises. VertLoop on-chain
impressions are coalesced to one submission per campaign per hour: additional
loop plays inside that window are not recorded on chain, so a single looping ad
cannot drain the wallet with one transaction per play. Main-radio impressions are
never coalesced. The notice panel shows the worker wallet, live
balance, threshold, and a rough runway estimate using
`WORKER_ESTIMATED_DAILY_BURN_WEI` (defaults to the observed daily burn rate).
The worker wallet also funds `reportCompletedMusicPlays`; those batches use the
same balance check and retry queue.

**Discord ad rotation is paused by default.** The website Ads Only loop keeps
using the same campaign selection, media clock, and voting endpoint, but does not
log DVertLoop into Discord, join voice, or send `#vertloop` announcements. The API
reports `delivery: "website"` and `discord.enabled: false`. The local media player
advances without a voice subscriber; this is not a Discord broadcast and does not
record paid impressions for an unattended website stream. Main-radio playback,
its qualifying ad impressions, and Discord traffic diagnostics are unchanged.
The pause persists across restarts; resuming Discord requires explicitly setting
`DVERT_LOOP_DISCORD_ENABLED=true` and redeploying. Website uploads remain available;
the main bot handles intake while the separate bot is paused.

When resuming Discord, create the AdLoop voice channel as `VertLoop` and its announcement/submission text
channel as `#vertloop`. Channel names are for people; the worker connects using
their numeric channel IDs configured above.

The second bot uses its own voice connection group, so it cannot reuse DBusker's
connection or redirect the music player into VertLoop. Both text channels retain
playback logs without push notification pings.

VertLoop ads have a 60-second playback ceiling, including the soundtrack of MP4
ads. Main-radio ads have the same ceiling; ordinary songs are not truncated.
DBusker waits for ten qualifying audible music plays between ad selections,
subject to the current show and on-chain campaign-slot eligibility. VertLoop's
live ad accepts one durable vote per listener per play through Discord reactions
or the DVert panel. Main-radio selection ranks the top ten eligible campaigns
using those votes. Opening Ads Only hushes the main-radio browser player and
mirrors the shared ad-loop media clock (website-only while Discord is paused);
a browser mirror never creates a second paid impression.

Media uploads in `#DecentJukebox`, `#jukeLoop`, and `#vertloop` now get a short
prompt with **Song** and **Advert** buttons. JukeLoop/DecentJukebox default to
Song; VertLoop defaults to Advert. Only the uploader or a moderator can choose,
and a timeout falls back to the channel default.

To enable DVertLoop ad intake, enable Message Content intent for the DVertLoop
application and set both `DVERT_LOOP_DISCORD_ENABLED=true` and
`DVERT_LOOP_AD_INTAKE_ENABLED=true`. Give the bot View Channel,
Read Message History, and Send Messages in DecentJukebox, plus Add Reactions in
the vertloop text channel. If the advertiser wallet is not linked yet, the bot
shows a **Link wallet** button and keeps the same upload pending until the user
clicks **Continue**. Larger media uploads use the DVert panel. The old
`!devert-ad` command still works as a hidden shortcut, but normal uploads no longer
need it. Ad submissions queue owner NFT review separately from campaign purchase.
Existing DJuke v0.2 requests still boost only a payer's sole active campaign;
multi-campaign targeting and a dedicated ad purchase UI are not implemented.

### Automatic five-minute reminders

All calendar shows announce to **@everyone** five minutes before their start
unless **Announce to @everyone** is unchecked. This includes the three built-in
weekly blocks, recurring preset hours and dated events. An omitted `announce`
flag on an older event means enabled. Automatic reminders always select
@everyone; `ANNOUNCE_DEFAULT_MENTION` controls **manual promotion only**.

One worker checks its local calendar every 15 seconds, with no Discord request
unless a reminder is due. During a persisted Discord cooldown or reconnect it
does not attempt delivery. There is no late catch-up after a show's start.
Storage/permission/delivery errors are logged and surfaced at
`/api/radio/schedule.reminders` and in the calendar; failures back off 60 seconds.
Opt-out, cancellation, start time and schedule revision are rechecked after the
pending checkpoint and before sending. The journal below stores independent
`reminder:<occurrence-id>:<start-utc>` receipts, preventing repeated ticks/restarts
from duplicating reminders without suppressing a separate manual promotion.
Rescheduling to a different start permits one reminder for that new start.
An uncertain delivery is reconciled, never blindly retried. A missed window
does not imply a successful announcement.

### Manual calendar announcements

**Operator workflow:** open the site's owner-only **Admin → Radio Programming**,
expand **Advanced scheduling and announce-now controls**, refresh, check one
dated occurrence, edit its reason, choose mention targets,
**Preview announcement**, then **Confirm — send to Discord**. Options, preview,
and send each require an off-chain owner-wallet signature (no transaction/gas).
The server uses `MINT_OWNER_WALLET`, the same owner authorization as schedule
updates; hiding UI is not the authorization boundary. Each signature binds origin,
action, occurrence ID/start, SHA-256 of the full payload, nonce and short expiry.

Configure `ANNOUNCE_CHANNEL_ID` (default #themessagebox `943117480883265539`),
`SITE_URL`, and `JUKE_LOOP_VOICE_CHANNEL_ID` in the **same guild**. Promotion does
not require joining voice or starting playback. The bot must have **View Channel,
Send Messages, Embed Links, Read Message History** in the destination. It also
needs **Mention Everyone** there when @everyone is selected; otherwise the preview
fails clearly, and the operator can choose roles/none instead. Mention choices
come from the destination guild's cached, mentionable, non-managed roles. Role
IDs are checked again at send, and `allowedMentions` allows only selected roles
and, only when selected, everyone; user mentions and reply pings are disabled.
Free-text titles/reasons cannot smuggle mentions.

`ANNOUNCE_DEFAULT_MENTION=everyone` deliberately defaults to a community ping.
Set it to `none` for opt-in mentions, or to JukeboxHero's **numeric role ID**
(for example `ANNOUNCE_DEFAULT_MENTION=123456789012345678`), or comma-separated
role IDs for multiple defaults. The roles must belong to this guild, be
mentionable and not managed by an integration. A bad configured default fails
closed; correct the environment and restart the worker. Admins can override the
default in each preview, including selecting everyone plus specific roles.

A Pinata checkpoint journal, `decentbusking-radio-announcements.json`
(`kind=radio-announcements`, schema 1), stores delivery receipts and pending
attempts separately from the shared schedule. Startup restores **only the latest
checkpoint**: falling back to an older journal could lose deduplication records.
Unavailable/corrupt storage disables sends. Keep one active sending worker per
journal/destination; this is not a distributed multi-writer lock. Do not delete
or roll back this checkpoint when restarting/deploying.

Every send checkpoints its pending marker **before** contacting Discord, then
revalidates the current schedule and records the message link/time after success.
Double-clicks, retries (even after restart), and a lost response reuse the same
confirmation ID, including deliberate re-announcements. A *new* preview with
**Intentionally re-announce** checked authorizes one additional post. Existing
start-of-show messages and audio are unchanged. Manual promotion is separate
from the automatic reminder above; no Discord Scheduled Events are created.

**Failures/recovery:** refresh and preview/reconfirm after a changed, canceled,
ended, or removed occurrence. Fix channel/mention permissions or reconnect the bot
and retry other failures. Definite Discord rejections are safe to retry. If an
HTTP timeout/5xx or receipt-save failure leaves delivery uncertain, retries first
search up to 2,000 recent channel messages for the bot's unique embed-footer
marker and recover the receipt without posting again. If no receipt is found,
sending stays blocked rather than guessing; never keep clicking re-announce to
work around it. An operator must inspect Discord and the latest journal: recover
the matching message ID/URL/time into the pending request and delivery receipt,
or, **only after verifying no post exists and no send is in flight**, remove that
pending request from a newly saved checkpoint using the same state store. Preserve
all other receipts. Do not restore an older journal or remove an uncertain marker
without checking Discord. Then refresh and explicitly preview/confirm again.

Test without production Discord: use a staging guild/channel and
`ANNOUNCE_DEFAULT_MENTION=none`, verify content/DST, role choices, permissions,
retry/restart dedupe, explicit re-announcement and stale/canceled rejection.
Only send a real community ping after operator approval. Run local tests from
the repository root: `node --test test/*.test.js` (the payroll CI workflows also
run their narrower `node --test test/payroll.test.js test/commentArt.test.js test/automation.test.js`).

### 4. Configure IPFS uploads

```bash
# Render / production
IPFS_UPLOAD_PROVIDER=pinata
PINATA_JWT=<server-only JWT from Pinata>
PUBLIC_WORKER_URL=https://<service>.onrender.com
IPFS_ALLOWED_ORIGINS=https://thejollylama.github.io,https://decentbusking.com,https://www.decentbusking.com,http://localhost:4173,http://127.0.0.1:4173
MINT_OWNER_WALLET=0x...

# Local alternative
IPFS_UPLOAD_PROVIDER=local
IPFS_API_URL=http://127.0.0.1:5001
```

In Pinata mode, the playlist, ratings, IPFS CIDs, and mint queue are checkpointed as tagged JSON on IPFS. On startup the bot discovers and restores the newest snapshot through Pinata's Files API. Render's persistent disk is not required; `JUKELOOP_PLAYLIST_PATH` should be omitted on the free tier.

All worker checkpoint stores use the **DecentBusking - Live checkpoints** Pinata
group (the dashboard's folder-like grouping), with **seven New York calendar
days: today plus the preceding six days**. Each state type retains its latest
complete snapshot for each day, not its seven most recent writes. Today's copy
advances as changes are saved; the last successfully saved state of a completed
day is its recovery point. Each snapshot contains the full state, including
cumulative counters and ledger entries still retained by that subsystem.
Expiring a backup does not remove older cumulative entries from today's state.
Operational journals keep their existing bounded working history. Their newly
observed transitions are separately retained in daily event history and embedded
in permanent weekly archives; a bounded journal is not the historical record.

Unchanged logical state with no new events is not uploaded again within the same day. Routine
playlist play/vote updates and unchanged-event ledger scan progress coalesce
into at most one routine upload every five minutes per store, without delaying
in-memory/UI updates. New submissions, media/mint changes, verified financial
events, paid-playback journals, schedule edits and explicit persistence barriers
remain immediate. Pending routine changes flush on graceful shutdown and at the
New York day boundary. The boundary also starts a full current-day snapshot on
quiet days, including across daylight-saving changes. An unexpected server loss
can lose up to five minutes of routine changes; an upload outage can extend that
window. Failed automatic saves log explicitly, remain pending and retry.
Downtime is not backfilled with invented daily observations.

IPFS CIDs are immutable, so replacing today's state uploads new bytes, then
unpins superseded same-day copies after confirming the new checkpoint is listed.
Daily snapshots carry `_checkpoint` metadata (`policy: daily-v1`, `day`,
`timeZone`, `savedAt`, `historyStartedAt`, `events`) and matching Pinata keyvalues. Restores remove this
metadata before validating the subsystem's original schema. Old formats remain
readable. Required paid-ad local-mirror confirmation still precedes publication.

### Permanent weekly history

After each New York Monday-to-Sunday week closes, the next checkpoint maintenance
pass writes a **self-contained weekly bundle per state type** in
**DecentBusking - Weekly archives**. Its filename is
`<state-name>.history-YYYY-MM-DD.json`, where the date is that week's Monday.
Bundles contain `policy: weekly-history-v1`, `kind`, `week`, `timeZone`,
`days` and `missingDays`. Each `days` entry embeds its day's entire serialized
snapshot (including events), a SHA-256 digest and its source CID for provenance.
These are embedded bytes, not merely links to soon-to-expire daily files.
No new version is uploaded when the weekly content is unchanged.

Before daily expiry, the worker reads the source snapshots, uploads the bundle,
fetches it back, compares its content and confirms its exact-policy Pinata
listing. If any step fails, daily pruning stops, the failure is logged/pending,
and maintenance retries. Verified weekly bundles are **retained indefinitely**.
A late day-close correction merges with the already archived days before
replacing an earlier weekly bundle; earlier versions are unpinned only after
the replacement is verified. Archive failures can temporarily increase the
number of live recovery files. First/partial weeks and downtime list their
unobserved dates in `missingDays`, rather than fabricating daily states.

For historical investigation, select that Monday's `.history-...json` file for
the relevant state type in Pinata. `days[].snapshot` answers what the retained
state was that day; `days[].snapshot._checkpoint.events` contains the activity
observed that day:

- Playlist: accepted submissions, site votes, Discord vote-count changes
  (including removals), and completed play observations with start/end times,
  audible duration and whether they qualified for counters.
- Financial ledgers: newly observed or changed payment, funding, payout and
  earnings records, with transaction/log references and chain time when known.
- Paid-playback journals: request/playback transitions and advert impressions;
  the DeVert journal also preserves accepted advert votes.

Each event has an ID, type and `observedAt`; `occurredAt` records the actual event
time only when known. A Discord count change is an observation, not a claim to
know an individual voter's identity or original click time. Historical reaction
reconciliation is labelled separately from live voting. No IP addresses,
credentials or additional voter identities are collected. Event capture begins
at `historyStartedAt`; older lost events cannot be reconstructed. Routine
events share the five-minute recovery window, not guaranteed lossless recording
during a crash/outage. Financial journals still require immediate durable saves.

Legacy weekly archives, ungrouped files and pre-policy checkpoints are untouched
pending a reviewed cleanup, so the initial file count can exceed seven per state
type. Media, NFT metadata, allocation receipts and explicit recovery baseline
files are not deleted by this policy. Old intermediate `previousSnapshotUri`
links can expire; cumulative entries and archived daily states remain.
Local/community IPFS pins are independent and are not unpinned by Pinata cleanup.

The worker provisions/reuses the live and weekly archive groups at startup; its server-only
Pinata key needs group read/write plus file read/write/delete permissions.
Saves are serialized per store. Pruning requires exact group, filename, app,
kind, schema and daily-policy tags, and paginates the full listing. It removes
at most ten files per pass; failures surface explicitly and can retry without
re-uploading the confirmed state. A failed upload never triggers pruning.
Run `cd discord-bot && node checkpoint-inventory.js` for a **read-only**,
paginated cleanup inventory. It identifies only allowlisted, app-tagged JSON
checkpoints, identifies the seven-day daily recovery window, and lists older
and legacy files for review rather than deleting or moving them. If a type has
no daily-policy snapshots yet, it proposes keeping its newest legacy checkpoint.
Review cumulative data, proof references and recovery baseline CIDs before
approving any cleanup.

### 5. Run the bot

```bash
npm start
```

---

## Slash Commands

### 🎙️ `/radio` — Community Radio (shared voice channel)

Stream an entire IPFS album directory to a Discord voice channel. Only one radio session per server at a time.

| Command | Description |
|---------|-------------|
| `/radio play <cid>` | Join your current voice channel and stream all audio tracks from the IPFS directory CID. Posts "🎵 Now Playing" in the text channel for each track. |
| `/radio skip` | Skip to the next track. |
| `/radio pause` | Pause or resume playback (toggle). |
| `/radio stop` | Stop the radio and disconnect from the voice channel. |

**Example:**
```
/radio play bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi
```

### 🎧 `/jukebox` — Personal Playlist (private)

Fetch a numbered playlist of direct stream links from an IPFS album directory and send it to your DMs (or as an ephemeral reply if your DMs are closed).

| Command | Description |
|---------|-------------|
| `/jukebox play <cid>` | Receive a private numbered playlist with clickable gateway stream links. |
| `/jukebox backlog` | Privately list your tracked uploads that have not been minted yet. |
| `/jukebox request-mint <track_id> <wallet> [artwork]` | Queue one of your pinned tracks with optional NFT artwork for owner approval. |

**Example:**
```
/jukebox play bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi
```

The CID must point to an **IPFS directory** containing audio files (`.mp3`, `.m4a`, `.wav`, `.ogg`, `.flac`, `.aac`, `.opus`).

### 📻 `/jukeloop` — JukeLoop Admin Commands

Manage the 24/7 community radio playlist.  Most subcommands are available to everyone; `remove` requires the **Manage Messages** permission.

| Command | Permission | Description |
|---------|------------|-------------|
| `/jukeloop stats` | Everyone | Show the top 10 rated tracks (likes, dislikes, plays, score). |
| `/jukeloop remove <title>` | Manage Messages | Remove a track from the JukeLoop playlist by searching its title. |
| `/jukeloop mint-queue` | Manage Messages | Show pending requests and owner approval links. |
| `/jukeloop mark-minted <track_id> <token_id> <tx_hash>` | Manage Messages | Reconcile a completed Base mint with the playlist. |
| `/jukeloop restart` | Manage Messages | Reconnect and restart JukeLoop without redeploying the bot. |

Wallet addresses submitted in Discord are community claims, not cryptographic proof of wallet ownership. During this manual bootstrap phase, the owner must verify unexpected or disputed addresses before approving a mint.

### MP4 Videos and CID Submissions

Discord audio and MP4 attachments are accepted up to and including 10 MB; larger attachments are rejected before playlist ingestion or IPFS pinning. Restart backfill also discovers older MP4 posts within that cap. Attachments enter the artist's `/jukebox backlog`, not the mint queue automatically: use `/jukebox request-mint` to supply the artist wallet, or have the owner run `/jukeloop queue-uploads uploader:<artist> wallet:<artist Base wallet>` for the full pinned backlog. FFmpeg extracts only the audio (`-vn`) for the JukeLoop Discord voice channel. DecentBusking plays the MP4 video above the NFT scene at 84% opacity, with the same synchronized position and radio mute/volume controls. The video button hides or shows the picture without creating a second audio stream. Use H.264 video with AAC audio for broad browser compatibility; silent videos have no voice-channel audio, and other MP4 codecs may not play in every browser.

For files over the 10 MB Discord attachment limit, pin the file to IPFS and use:

```text
/jukebox submit cid:<file CID> title:<title> wallet:<artist Base wallet> format:mp4
```

The CID must identify the media file itself, not an album directory or a gateway URL. The command queues owner approval without downloading or re-uploading the file. Existing `/jukebox request-mint` can add artwork to that request.

The site's briefcase supports audio/MP4 file uploads up to 50 MB, or an existing file CID for larger media. Artwork accepts PNG, JPEG, WebP, or GIF up to 10 MB. An artist signs the upload and submission with their connected wallet; this grants no on-chain mint permission. The submitted recipient must match that wallet unless the owner is submitting. Artist uploads are restricted to supported media/artwork, allowed site origins, fresh signatures, replay protection, and 20 upload/submission requests per wallet per hour. These limits are in memory and reset when the service restarts; monitor Pinata quotas for this public upload service.

Site submissions join the existing private owner mint queue. They remain outside radio rotation and new-upload previews until the owner mints and the verified transaction is reconciled. The owner Admin panel and CLI preserve video type, artwork, tip wallet, and parent-token lineage in NFT metadata. Neither a submission nor an upload sends a blockchain transaction. Redeploy the Render bot/worker and publish the static frontend together to enable these routes; no new environment variables are required.

Successful Discord media uploads still receive a **Request NFT** button after the
file is pinned. It embeds the Track ID automatically and opens a private
wallet/artwork form for the original uploader. A single previously used artist
wallet is prefilled for confirmation; otherwise the artist enters it. Artwork is
optional: attach PNG, JPEG, WebP, or GIF up to 10 MB, or enter an already-uploaded
IPFS image file CID for larger artwork. The CID field accepts a bare CID or
`ipfs://CID`, not directory paths or gateway URLs, and does not re-upload the
image or impose the Discord attachment-size cap. Choose one source, not both.
Leaving both fields blank keeps existing artwork or uses the Discord profile image
by default when no artwork exists. The bot explicitly reminds the artist of that
default and queues owner approval; it does not send a mint transaction. If the
profile image cannot be archived, the artist is asked to retry or supply artwork
rather than silently queuing an image-less NFT. Old confirmation messages do not
gain buttons automatically; `/jukebox request-mint` remains available for those
tracks and as a fallback.

`/jukebox request-mint` only queues a request; it does not submit a blockchain transaction. Artists may attach PNG, JPEG, WebP, or GIF artwork up to 10 MB; the bot pins it immediately and stores its CID with the request. The contract owner opens **Admin** in the DecentBusking dapp, uses the connected `DEFAULT_ADMIN_ROLE` wallet, and authorizes the private queue. Artist artwork is previewed and preloaded, with an optional replacement control. Each request has an individual Mint action. Multiple selected requests can be processed sequentially; the current contract has no batch registration method, so MetaMask still requires two Base transaction confirmations per track. The browser reports each confirmed mint to the Render worker. After the worker verifies the owner, contract, recipient, token ID, and `EditionMinted` event on Base, the bot removes the item from the backlog and announces the NFT in both configured public text channels. `/jukeloop mint-queue` and `/jukeloop mark-minted` remain recovery tools.

A true one-confirmation batch is possible through a separately deployed `BatchProductMinter` helper contract holding `DEFAULT_ADMIN_ROLE`: it can loop over requests and use each `registerToken` return value immediately in `mintProduct`. That privileged helper requires its own Solidity project, review, deployment, and explicit role grant before the dapp should use it.

Admin reuses the wallet connected in the site header; opening the panel checks the on-chain admin role without another connection request or message signature. NFT Requests starts collapsed: expanding it loads the private queue and requests its owner-wallet message signature, since a public address alone is not proof of ownership. Closing that section does not sign. That authorization is reused in memory for four minutes (within the worker's five-minute validity window), then refreshed when needed. It is cleared on account/network changes or disconnect and never stored in browser storage. Upload authorizations and on-chain mint transactions remain separate approvals.

The Admin sections appear in this order: Radio Programming, NFT Requests, Live
Performance, DVert, Worker funding, Contract Roles. The connected wallet reuses
the creator-profile four-icon identity label, with `DEFAULT_ADMIN_ROLE` beside it
below the header divider. Balance warnings and verified Base funding details stay
inside Worker funding; a low balance does not force the section open and never
initiates a transfer. The balance, threshold and runway remain live readings, not
hardcoded display values.

---

## JukeLoop — 24/7 Community Radio

JukeLoop automatically streams every audio file posted in `#DecentJukebox` to the `JukeLoop` voice channel, non-stop.

### How it works

```
Bot starts up
    ↓
Loads playlist from jukeloop-playlist.json (persisted across restarts)
    ↓
Scans ALL historic messages in #DecentJukebox for audio attachments (backfill)
    ↓
Joins the JukeLoop voice channel
    ↓
Builds a weighted-random playlist (higher-rated tracks play sooner/more often)
    ↓
Plays each track and announces it with a website link and reminder to vote there
    ↓
When the next track starts, reads the reaction counts and updates ratings
    ↓
After each full loop, reshuffles using fresh weights → repeat forever
```

### Rating system

| Reaction | Effect |
|----------|--------|
| 👍 | +1 to the track's score |
| 👎 | −0.5 to the track's score |

Track weight = `max(0.1, 1 + likes − dislikes × 0.5)`.  A brand-new track has weight 1.0.  Higher weight = higher probability of appearing earlier in each loop pass.  Even heavily down-voted tracks still appear occasionally (weight floor: 0.1).

Ratings **accumulate** across plays and **persist to disk** (`jukeloop-playlist.json`) so they survive bot restarts.

The playlist is the single master tally. The local runtime file and tagged Pinata snapshots are copies of that ledger, not independent vote lists. Both Playback Tally panels read its counters; the personal panel filters by the artist wallet.

Site votes, Now Playing reactions, and reactions on an original upload that identifies exactly one track update the same track totals. Discord reaction additions/removals are synchronized live; each message has a persisted count baseline, so rereading it adds only the difference. Thumb skin-tone variants count, and the bot's own seed reactions do not. Reactions remain available after a play finishes. Multi-track upload posts are not assigned a vote arbitrarily; listeners can react on each track's Now Playing message instead.

New JukeLoop and AdLoop announcements do not seed thumb reactions: they link to
`SITE_URL` and direct listeners to vote on the website. Posting an announcement now
uses one REST request instead of a message plus two reaction requests, a two-thirds
reduction for announcement creation, not for all bot traffic. Existing/manual
Discord reactions still synchronize, and historical rating recovery is unchanged.

On startup, JukeLoop scans up to 500 recent announcements and checkpoints recovered changes. For older messages, readable reactions and bot-published cumulative counters establish a one-time conservative minimum; those two representations are not added together. Reactions erased by older bot versions cannot be reconstructed. New announcements carry a Play ID, and completed audible plays retain their announcement ID, preventing recovery from adding the same play twice. Historical totals do not create qualified weekly playback credits.

Playback payroll uses qualified plays (completed Discord audio with at least 30 audible seconds) and verified artist wallets. New payout buckets close Monday 00:00 `America/New_York`, retain legacy UTC history and lifetime totals, and start with a labelled partial migration week. Top 10 prizes use live weekly net-vote buckets, not historic/all-time totals. Site votes are anonymous; prize recipients still require owner review.

`GET /api/payroll/weekly` exposes the current New York period, closing time, funding/commitments, warnings and published closed-week receipts; `?wallet=0x...` filters provisional artist/song shares. The running worker prepares drafts every 15 seconds, using historical closing balances and current unreserved funds. IPFS schedule checkpoints are retained independently of playlist/payment snapshots. Defaults in `payroll-assets.json.radioPayflow`: 100% unreserved budget, 0.01 USDC minimum, 1 USDC average-share warning. It never signs payouts. Historical RPC or backup failure stops preparation; after downtime, older eligible periods are processed first. Use `calendar=new-york` on `/api/radio/history` for the new buckets; default UTC history is preserved.

### NFT Artwork Defaults

Discord NFT requests and `/jukebox submit` default to the submitting user's pinned Discord profile image, including an animated avatar when available. Existing custom artwork is preserved. Missing profile defaults on pending Discord requests are recovered when the private Admin queue is read. The Discord modal cannot prefill its native file upload with an existing avatar; the optional upload/CID fields replace the default, and the confirmation shows the selected image.

Admin previews the queued image and supports PNG/JPEG/WebP/GIF uploads up to 10 MB or an existing image/GIF file CID with no upload-size cap. Choose one replacement source, not both. `/api/ipfs/artwork-cid` validates/normalizes a file CID; it does not fetch/pin the entire image or guarantee its availability/type. Larger GIFs may render slowly depending on gateway/browser resources. A website-only submission does not establish a Discord identity.

### Payment Proof Service

`GET /api/payroll/ledger` exposes verified Base payments and IPFS snapshot status. Allowed browser origins can submit a transaction hash to `POST /api/payroll/reconcile`; the worker accepts only successful, canonical, twice-confirmed `PayrollPaid` events from the configured router and DecentBusking repository namespace. No signing key is held by the bot. A 15-second comparator discovers new events, rechecks saved proofs and retries pending backups. Tagged payment snapshots are retained independently of playlist snapshots. Radio state advertises this endpoint for DJuke/DBusk consumers.

Optional server variables: `PAYROLL_START_BLOCK` specifies historical scan coverage (default: startup head minus 2,000 unless restoring); `PAYROLL_ARCHIVE_RPC_URL` selects an archive-capable Base endpoint for weekly closing-balance checks (defaults to `https://mainnet.base.org`); `JUKELOOP_PAYROLL_RECOVERY_CID` accepts a comma-separated list overriding the one-time archived playlist checkpoints used to recover weekly counters; `PINATA_GATEWAY_TOKEN` is a server-only access key for a restricted Pinata gateway; `PAYROLL_GITHUB_TOKEN` is an owner credential with Actions-write permission for automatic dispatch of verified repo-dev ledger updates. Never put credentials in browser configuration. Without `PAYROLL_GITHUB_TOKEN`, the GitHub ledger workflow remains manual. See [payroll procedures](../docs/PAYROLL.md) for confirmation, backup, history and batch limitations.

### Setting up JukeLoop

1. Create a `JukeLoop` voice channel and a `JukeLoop` text channel in your server.
2. Copy both channel IDs (Developer Mode → right-click → Copy Channel ID).
3. Add to `.env`:
   ```
   JUKE_LOOP_VOICE_CHANNEL_ID=<voice-channel-id>
   JUKE_LOOP_TEXT_CHANNEL_ID=<text-channel-id>
   ```
4. Restart the bot — it will backfill existing tracks automatically.

---

## Upload → IPFS Pin Flow

```
User posts audio in #DecentJukebox
    ↓
Bot detects message attachments with audio MIME type or extension
    ↓
Track is immediately added to the JukeLoop playlist (if JukeLoop is enabled)
    ↓
Bot downloads the file buffer via fetch
    ↓
Bot uploads through Pinata or local Kubo → receives CID
    ↓
Bot builds mint URL:
  https://thejollylama.github.io/DecentBusking/?title=<track>&ipfs=<CID>
    ↓
Bot replies with a rich embed containing the "🎸 Mint This As A DNFT" link
```

Supported audio formats: `mp3`, `wav`, `ogg`, `flac`, `m4a`, `aac`, `opus`, `weba`

---

## Discord Developer Portal Setup

1. Go to [https://discord.com/developers/applications](https://discord.com/developers/applications) and create a new application.
2. Under **Bot**, click *Add Bot* and copy the **Token** → `DISCORD_TOKEN`.
3. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**.
   (Voice channel support uses the non-privileged `GuildVoiceStates` intent — no extra toggle needed.)
4. Under **OAuth2 → URL Generator**, select scopes:
   - `bot`
   - `applications.commands`
   
   And permissions:
   - `Send Messages`
   - `Read Message History`
   - `Embed Links`
   - `Connect` (voice)
   - `Speak` (voice)
5. Use the generated URL to invite the bot to your server.
6. Enable Discord **Developer Mode** (Settings → Advanced), right-click `#jukebox`, and choose **Copy Channel ID** → `JUKEBOX_CHANNEL_ID`.

> **Note:** Global slash commands can take up to 1 hour to propagate after first registration. For faster iteration during development, register commands to a specific guild by replacing `Routes.applicationCommands(clientId)` with `Routes.applicationGuildCommands(clientId, guildId)` in `index.js` — guild commands update instantly.

---

## Deployment (Railway — recommended)

1. Push this repository to GitHub.
2. Create a new [Railway](https://railway.app) project and connect the repo.
3. Set the **Root Directory** to `discord-bot`.
4. Add the environment variables in the Railway dashboard under *Variables*.
5. Add a `NIXPACKS_PKGS=ffmpeg` variable so Railway installs FFmpeg automatically.
6. Railway will run `npm start` automatically.

### Alternative: fly.io

```bash
cd discord-bot
fly launch --name decentbusking-jukebox-bot
fly secrets set DISCORD_TOKEN=... JUKEBOX_CHANNEL_ID=... PINATA_JWT=... MINT_OWNER_WALLET=...
fly deploy
```

Add `ffmpeg` to your `Dockerfile` or `fly.toml` build configuration.

### Alternative: PM2 on a VPS

```bash
# Install FFmpeg first
sudo apt install ffmpeg

npm install -g pm2
pm2 start index.js --name jukebox-bot
pm2 save && pm2 startup
```

---

## File Structure

```
discord-bot/
  index.js                 ← bot entry point (message handler + slash command router)
  radio.js                 ← IPFS track fetcher + per-guild RadioSession (voice streaming)
  jukeloop.js              ← JukeLoopSession (24/7 radio) + channel backfill helper
  playlist-store.js        ← persistent playlist with 👍/👎 ratings and weighted shuffle
  jukeloop-playlist.json   ← runtime data: playlist + ratings (auto-created, gitignored)
    ipfs.js                  ← Pinata/local Kubo upload adapters
    ipfs-worker.js           ← owner-authenticated Pinata upload URL endpoint
  embed.js                 ← Discord EmbedBuilder for mint-link replies
  config.js                ← environment variable loader with validation
  package.json             ← Node.js manifest
  .env.example             ← template for required environment variables
  README.md                ← this file
```
