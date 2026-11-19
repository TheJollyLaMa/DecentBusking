# Public radio: audience scale and operating guide

## What changes, in plain language

LiveKit is the interactive studio: the performer, producer and independent audio
receiver need real-time connections. Putting every audience member in that studio
uses a participant seat for each connection. A monthly allowance of participant
minutes does not raise the simultaneous-seat limit.

HLS is the public radio distribution line. The server produces one continuous
audio programme, cuts it into four-second files and uploads it to Cloudflare.
Listeners obtain those files from its CDN, not individual LiveKit seats. Programme
updates also use the CDN; moving audio alone would leave hundreds of browsers
polling Render directly.

This trades immediate sound for approximately 10-20 seconds of delay. It is not
unlimited capacity, and it does not make the studio or Render server unnecessary.
The same programme includes rotation, paid adverts and successive performers.
Scheduled studio changes must not cut off the previous act's buffered ending.

The new path defaults **off**. Deploying an empty CDN Worker does not select it
for production listeners. Begin with approved show/rehearsal windows, not 24/7
encoding.

The public HLS feed remains the main-radio audio clock. When a queued MP4
reaches that clock, the browser shows its muted video through the existing
radio media endpoint. An audio-only entry, a live set, or leaving radio
clears the picture. If the picture fails, audio continues with a visible
notice. These on-demand video requests use the radio media proxy, not the
audio CDN, and are not covered by the audio-only capacity measurements below.

## The separate limits

| Limit | Meaning |
| --- | --- |
| LiveKit simultaneous participants | Studio/direct-listener seats, shared across the project. Its documented Build limit is 100; the existing temporary direct-listener cap reserves headroom. Verify the actual account before each rehearsal. |
| Monthly allowances | Minutes, transfer, requests and operations included in each provider's plan. These are not simultaneous-audience guarantees. |
| Render CPU and memory | The bot, receiver, encoder and existing radio work share a machine. The currently inspected instance has 0.5 CPU and 512 MB; no upgrade follows from this feature. |
| Audio transfer | At 128 kbps, one listener uses roughly 57.6 MB/hour; 200 use roughly 11.52 GB/hour, before transport overhead. This is arithmetic, not a measured bill or capacity result. |
| CDN requests | Playlist refreshes, audio files and programme snapshots all count. Cached Worker requests still count. A shared-NAT audience needs a sufficient per-IP request allowance. |

Workers Paid has a $5/month minimum, with usage allowances and metered overages.
R2 Standard has included storage/operation allowances and no Internet-egress fee,
but remains a metered, auto-renewing subscription. Neither estimate is a hard
spending cap. Always-on publishing consumes operations even without listeners.
At 200 listeners, approximate two-second playlist/state polling plus one audio
file every four seconds is about 900,000 Worker requests per show hour, before
startup and retries. The current Paid allowance of 10 million requests per
month would cover roughly eleven such hours if nothing else used it; CPU,
storage and R2 operations have separate allowances. A CDN cache hit avoids
re-reading an object but is still a Worker request. This is a planning estimate,
not a per-show fixed price, measured invoice or budget ceiling.
Consult current [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/) and
[Render bandwidth](https://render.com/docs/outbound-bandwidth).

## Source, privacy and performer attribution

- Rotation/adverts use JukeLoop's actually consumed Opus packets, not its prefetch.
- Live audio reuses the independent receiver only for the exact authorized,
  armed, fresh public booking. Private practice, backstage, suspended/filler
  periods and unrelated rooms cannot feed this path.
- Broadcasting permission is independent of permission to make an archive.
  HLS does not turn on recording or create an IPFS archive.
- R2 stays private. Only the authenticated Worker accepts backend uploads.
  Public objects expire within 120 seconds even after an encoder crash; cache
  lifetimes cannot extend their expiry. A cleanup cron removes expired objects.
- The player labels the programme from actual media programme time. Tips bind to
  that audible booking and its exact performer, not the next studio performer.
  Reactions pause when the delayed audible act differs from the current studio act.
- Publisher self-return protection, archive listening and Ads Only remain
  separate. Errors never silently consume a LiveKit listener seat.

## Configure and deploy in order

1. Obtain explicit billing approval; activate Workers Paid and R2 through normal
   Cloudflare access. Create the private Standard bucket named in
   [wrangler.toml](../cloudflare/wrangler.toml). Do not enable public R2 access.
2. Validate and deploy the independent edge:

   ```sh
   npx wrangler deploy --dry-run --config cloudflare/wrangler.toml
   npx wrangler deploy --config cloudflare/wrangler.toml
   npx wrangler secret put BROADCAST_UPLOAD_TOKEN --config cloudflare/wrangler.toml
   ```

   Generate a separate 32-200 character URL-safe upload secret. Use the private
   secret prompt/input, never a command-line literal, source file or screenshot.
   The Worker requires both its R2 binding and rate limiter. The latter allows
   24,000 requests/minute per IP/location: 200 shared-NAT clients can exceed
   15,000/minute with bootstrap, state, playlist and segment requests.
   This approximate per-location limit is not a global spending cap.
3. Configure the publisher's server-only environment:

   - `PUBLIC_BROADCAST_MODE=preview`: encode/upload, but keep the ordinary public
     radio transport. `direct` is the default and does not run the encoder.
   - `PUBLIC_BROADCAST_EDGE_URL`: exact HTTPS Worker origin, no path or credentials.
   - `PUBLIC_BROADCAST_UPLOAD_TOKEN`: the same dedicated private upload secret.
   - `FFMPEG_PATH`: optional override of the existing FFmpeg executable.

   Native 48 kHz stereo AAC encoding must work on the deployment architecture.
   A local ignored environment file is not a Render environment update.
4. Prewarm the preview for at least 20 seconds. Verify continuous segment,
   playlist and state publication, real AAC playback and Linux container metrics.
   Do not start a second production Discord bot from a worktree.
5. Run the agreed staged workload and an actual browser/hardware rehearsal.
   Selecting `public` for production requires separate operator approval after
   reviewing the evidence. Deploy readers before selecting that mode.

Do not bypass the existing radio predeploy guard. The public protected tail
adds 40 seconds of deployment protection after paid/ad/live packets. A change
of transport or service restart can still interrupt listening; schedule the
switch outside a protected show. To roll back, have the producer explicitly
select `direct` only with the bounded direct-seat allowance verified, or stop
the public broadcast. There is no automatic mass fallback.

Quiet DJuke playlist event scans retain a durable cursor after at least one
complete scan chunk of progress. Short empty polls still avoid uploads, but a
replacement worker no longer needs to replay an indefinitely old quiet range.
This uses the existing required-mirror checkpoint path; failed cursor writes
remain errors and do not advance the durable boundary. The first catch-up from
an older checkpoint must still complete before the safe deployment gate opens.
The deployed cursor repair was read back successfully near the current chain
head through the existing checkpoint store, with the six batch records retained.

The encoder, Opus decoding, HLS pacing and uploads run in a dedicated Node
worker thread in the same container, not another service. This keeps unrelated
bot event-loop stalls out of the audio clock. The parent forwards only the
selected public source, with bounded in-flight messages; source age across the
thread boundary and the PCM queue remains limited to one second. By the
owner's 18 Nov decision, audio that would exceed that second (a burst after a
bot stall, or audio older than one second) is skipped down to half a second
in one go, rather than stopping the station. Skips are logged at most every
10 s and counted in the snapshot as `lateAudio` (skips, dropped milliseconds,
last stage), so they stay visible rather than silent. Malformed PCM still fails
closed. The encoder's own 500 ms scheduling-stall limit, private-room gates and
protected tail remain.
In-flight credits are decremented by the worker through a shared atomic counter,
not by parent-loop acknowledgment callbacks. Otherwise a busy parent can falsely
count already processed frames as backlogged. Limit failures include a bounded
stage/count diagnostic, distinguishing IPC backlog, PCM size and source age.
Public state is requested from the parent through the existing eight-second
deadline, and worker errors explicitly make the broadcast unavailable.
Object PUTs may retry fast network/408/500/502/503/504 failures at most three
times with bounded backoff, sharing the original eight-second deadline rather
than restarting it. Identical object keys/bytes make these retries idempotent.
Authorization, other client errors and exhausted budgets still fail explicitly.
Publication errors expose only a bounded stage and HTTP status/timeout name,
distinguishing state reads, object uploads and local staging without disclosing
credentials or filesystem errors. Audio age/queue/clock limits do not change.

Preview mode samples the parent CPU only when explicitly enabled with
`PUBLIC_BROADCAST_PROFILE_CPU=true`, at 10 ms for at most ten resource windows.
Leave it unset for normal, production-equivalent preview measurements. Only
windows with an event-loop maximum above 500 ms log
`[radio-cpu-stall]`: a top-ten aggregate of module-relative file, function, line
and sampled time, never a raw profile, payload, credential or absolute path.
Direct/public modes do not start this diagnostic. Health reports the measured
event-loop maximum alongside p99, since a rare multi-second pause can be hidden
by an otherwise healthy percentile. Sampling is diagnostic overhead, not proof
that a particular function caused a pause.
Container memory also exposes anonymous, file and inactive-file counters from
`memory.stat` when available. Under the owner's 18 Nov rule below, the scored
percentage is the working set, `(memory.current - inactive_file) / memory.max`,
which matches Render's memory graph; raw `memory.current / memory.max` is still
reported. Missing optional breakdown falls back to the raw value; it does not
erase otherwise valid quota samples or turn them into passes.

The client uses native HLS only with a usable programme clock (`getStartDate`),
otherwise the self-hosted pinned Hls.js bundle. Native playback capability
alone is insufficient to identify the audible performer. The Hls.js initial
sync target is three segments; playback stays at normal speed rather than
fast-forwarding a buffered song ending. A listener more than six segments
(about 24 s) behind the playlist edge, roughly 26-30 s by the clock, jumps back
to the sync target instead of drifting further. Before 18 Nov the limit was
unbounded, so every stall added permanent delay (owner choice: jump, not speed
up). AAC decoding is required. An embedded
browser without AAC is not evidence that Safari or full Chrome decoded the
broadcast.

## Frozen acceptance limits and evidence

Before the scored staging rehearsal, the operator approved:

- 200 public listeners for 10 minutes.
- Metadata request p95 at most 1.5 seconds; decoded audio-start p95 at most
  3 seconds. Download latency is **not** audio-start latency.
- Zero server 5xx responses.
- Container CPU at most 70% of its actual quota; memory at most 75%.
  On the inspected 0.5-CPU/512-MB plan, these correspond to 0.35 CPU and 384 MB.
- Event-loop p99 below 200 ms. Separately measure audible delay against the
  10-20 second HLS target and inspect silence, overlap, reconnects and boundaries.

On 18 Nov 2026 the owner amended two limits: memory is the working set
(excluding reclaimable inactive file cache) at most 85% of the container
limit, about 435 MiB of 512 MiB, and audible delay p95 at most 30 seconds.
The other limits above are unchanged, and the public mode stays unselected
until the owner confirms it.

`/health.radioResources` reports Node CPU/RSS/heap/event-loop values and Linux
cgroup v2 container CPU/memory where available. Only container values include
FFmpeg and the other container processes. Verify their reported quotas match
the hosting plan. Missing counters or missing samples are **unmeasured**, not a
headroom pass.

For development only, start the isolated synthetic fixture:

```sh
node test/helpers/broadcast-preview.cjs
node scripts/broadcast-load.mjs --origin http://127.0.0.1:8331 --listeners 200 --seconds 60
```

It does not connect to Discord, LiveKit, a wallet or production state. Supplying
the server-only edge environment explicitly sends synthetic audio to the approved
test edge instead of the in-memory local edge. Stop it after the check.
For authorized non-production hosting, the workload runner requires
`--staging-approved` and a matching explicit `--media-origin` when different.
It rejects the known production hostname and never signs, votes or settles fees.
Its result remains HTTP-only and unscored; no aggregate test count certifies
200-listener capacity or a successful human rehearsal.

Development evidence so far:

- One fresh full-Chrome session decoded the synthetic AAC feed from the real
  CDN, advanced playback, displayed the correct programme and reported no page
  errors or overflow at 390 pixels. Audio began in 1.818 seconds and measured
  programme delay was 16.401 seconds. These are individual observations, not
  a 200-browser startup percentile or a hardware Safari result.
- An earlier four-segment sync target measured 22.183 seconds of delay, outside
  the target; the three-segment setting above was verified afterward.
- An earlier 60-second all-local 200-client exercise failed with 3,158
  `BROADCAST_NOT_READY` errors when its publisher hit `PCM_BUFFER_LIMIT`.
  That fixture combined encoding, delivery and clients on one Mac. Its failure
  is retained, not counted as production capacity evidence. Encoder safety
  thresholds were not loosened to conceal it.
- The completed real-CDN HTTP exercise ran 200 clients for 600 seconds: 124,901
  successful measured responses, metadata p95 587.8 ms, playlist p95 550.9 ms,
  segment p95 463.5 ms, and approximately 2.23 GB received. It also recorded ten
  request failures, so it was not a clean exercise. No HTTP 5xx was observed;
  that does not classify failures that produced no HTTP response.
- A fresh, prewarmed 120-second diagnostic repeated 200 clients and recorded
  seven `ECONNRESET` failures across metadata, playlists and segments. The
  runner now retains bounded phase/socket diagnostics. These do not establish
  whether the reset originated locally, in transit or at the edge.
- After the first exercise the local publisher entered
  `ENCODER_CLOCK_STALLED`; a subsequent attempt against that stopped publisher
  correctly reported unavailable throughout. It was stopped and separately
  restarted before the fresh diagnostic, not silently counted as healthy.
  The safety threshold remains unchanged.
- Encoder pacing now uses a monotonic clock, independently of UTC programme
  timestamps. A focused regression demonstrates that wall-clock corrections
  neither falsely stop nor freeze encoding, while a genuine scheduling stall
  still triggers the existing safety limit. This fixes a reproducible timing
  defect; it does not establish the cause of the earlier observed stop.
- Reader release `1ba11c5` is live. The first hosted-preview deployment safely
  failed its unchanged paid-playback handoff after timeouts and HTTP 520.
  A subsequent authenticated handoff verified both paid and recording state,
  and the guarded retry deployed successfully with public selection still off.
- That hosted preview safety-stopped during catalog restoration, before any
  programme history existed. It had encoded about 20 seconds of startup
  silence. The publisher now starts its programme clock only when authorized
  public audio first arrives, rather than charging catalog restoration against
  an unused audio timeline. A regression covers a one-minute startup delay,
  private-input exclusion, UTC corrections and the unchanged real-stall limit.
  This fixes the pre-input startup case; it does not prove that later stalls
  cannot occur.
- Hosted revalidation of the startup fix reached ready and decoded all 20 test
  media elements: audio-start p95 2.000 s, metadata p95 196 ms and delay p95
  17.055 s. No playback, request, metadata or HTTP 5xx failures occurred.
- A subsequent actual 200-decoder/600-second exercise used four isolated Chrome
  pages, not 200 physical browsers. All 200 initially decoded: startup p95
  1.801 s, metadata p95 213 ms, delay p95 18.326 s. Eleven resource samples
  measured maximum container CPU 46.8% of its 0.5-core quota, memory 63.7% of
  512 MiB and event-loop p99 92.2 ms. No HTTP 5xx or realtime room connections
  occurred. Nevertheless the publisher later hit `ENCODER_CLOCK_STALLED` and
  all 200 listeners lost the stream; expired objects then produced request
  and metadata failures. This is a failed continuity exercise, not a pass.
  The encoder is now isolated from the application's event loop; a real-thread
  regression blocks the parent for 650 ms while encoding continues, without
  increasing the encoder's safety threshold. Hosted verification must repeat.
- The first threaded small rehearsal kept the audio clock alive but recorded
  a slow CDN request (one eight-second metadata timeout, startup p95 5.501 s).
  A fresh diagnostic measured startup p95 1.101 s and metadata p95 231 ms with
  no request failures, but later reached `PCM_BUFFER_LIMIT` across a programme
  transition. Neither run passed. The bridge now uses worker-owned atomic
  credits and reports the precise limit stage; these changes require another
  hosted continuity exercise rather than assuming every limit is network load.
- The atomic-credit release's next 200/600 attempt stopped after 187.85 observed
  seconds, not ten minutes. All 200 initially decoded, but startup p95 3.200 s
  missed its limit and audible delay p95 23.477 s exceeded the target.
  Metadata p95 was 1.077 s; CPU max 35.4%, memory max 65.7%, event-loop p99
  67.6 ms, with no request/metadata/HTTP 5xx failures before the safety stop.
  The new diagnostic established an actual PCM queue overflow: 192,000 bytes
  queued plus a 3,840-byte incoming frame, not an IPC-credit failure.
  Programme history also showed a gap and return within the same recording,
  not solely a song transition. A contemporaneous request took 1.944 s, but
  its duration alone does not establish a blocking function. The unchanged
  one-second queue limit remains; parent CPU/max-delay diagnostics investigate
  the producer rather than silently dropping audio or raising the limit.
- The diagnostic release then measured a 1.621 s parent event-loop maximum in
  the minute of another actual PCM overflow, despite event-loop p99 91 ms.
  Its CPU aggregate included weekly-history byte scanning and whole-day JSON
  parsing, plus 2.023 s of garbage-collector samples; memory reached 82.2%.
  Aggregates identify a measured blocking-work candidate, not an exact
  sample-by-sample causal trace. Weekly history now yields every 64 KiB while
  scanning raw archive ranges. A pinned MIT-licensed incremental JSON parser
  validates the entire daily document but retains only `_checkpoint`, rather
  than reconstructing each cumulative state just to read its metadata.
  Archive bytes, hashes, coverage checks, readback verification and fail-closed
  pruning remain unchanged. Large-history regressions require radio callbacks
  to run during both daily validation and existing-archive scans; malformed
  unselected state and later invalid duplicate metadata still fail. This
  repair requires guarded hosted revalidation; neither memory nor continuity
  is claimed passed from local tests.
- Deployed history repair `91f3774` passed a 20/60 hosted stage: all decoded,
  startup p95 1.501 s, metadata p95 154 ms, delay p95 16.546 s, CPU max 31.3%,
  memory 64.4%, event-loop p99 25.2 ms and no measured errors. The next 200/600
  run completed all 600 seconds with the producer continuously ready, CPU max
  43.5%, memory 68.6% and event-loop p99 97.7 ms. Startup p95 2.600 s and
  metadata p95 1.318 s passed, but 50 players lost control updates, 462 stalls,
  9,559 metadata errors and 10,060 request failures occurred; delay p95 grew
  to 40.829 s. This remains a failed acceptance run. Failures clustered in
  one of four 50-decoder browser contexts; that does not establish a local,
  transit or CDN root cause.
- A default-transport diagnostic removed measurement-time browser-driver
  interception while explicitly disabling browser cache. HTTP/3 carried most
  responses; one context received about 20 MB versus 134 MB each in the other
  contexts, and errors persisted. No cached responses or server 5xx occurred.
  Removing interception did not resolve the problem; transport-forced tests
  must not be counted as default-browser acceptance passes.
- The producer later failed publication after about 37 minutes of encoded
  audio, with no stage in the older error. That observation does not identify
  an upload timeout versus a state-read or staging failure. The bounded PUT
  retries and safe stage diagnostics above require hosted revalidation; they
  do not retroactively classify that failure or establish readiness.
- The next HTTP/2 control case was aborted before its scored observation
  window: actual container memory was 91.6%, subsequently 94.0%, while Node
  RSS was approximately 270 MiB. It provides no two-minute HTTP/2 comparison.
  The new breakdown attributes that difference without assuming file cache,
  redefining memory, relaxing the 75% cap or approving another instance/plan.
- The owner chose to retain the $7/month 512 MiB service and optimize first.
  Checkpoint comparison keys now reuse `checkpoint-history.js:contentHash`
  (SHA-256) instead of retaining full serialized values. Non-daily stores no
  longer accumulate an unused per-day identity map. Snapshot bytes, immutable
  state copies, event identity, required local mirrors and publication ordering
  are unchanged. An isolated generated 8 MiB snapshot retained 25,208,096 heap
  bytes before and 16,827,408 after, approximately 8 MiB less; the new memory
  regression failed before the repair. Median local identity calculation CPU
  across seven samples increased from 7.451 ms to 19.248 ms for that input.
  All 66 checkpoint, retention and mirror tests passed. These are local
  measurements, not proof of actual container headroom or browser continuity;
  guarded hosted revalidation and the unchanged raw 75% limit still apply.
- Deployed compact identities `17f8515` passed a 20/120 stage (all 20 decoded,
  startup p95 1.101 s, metadata 315 ms, delay 15.667 s, raw memory max 65.7%)
  and a default-transport 200/120 stage (startup 2.101 s, metadata 549 ms,
  delay 19.735 s, memory 68.6%), both without measured errors. The next
  200/600 observed 600.058 seconds: all decoded, no stalls or fatal playback
  failures, startup 1.700 s, metadata 611 ms, CPU max 35.7%, raw memory 74.48%,
  event-loop p99 57.4 ms. It still failed: one HTTP 503, 612 request failures,
  516 metadata errors and final delay p95 38.746 s. Older harness evidence
  lacks that 503's URL/body, so its origin is not established.
- The HTTP/2-only control was safety-stopped after 291.593 seconds at raw
  memory 75.25%; no HTTP 5xx or metadata errors occurred, but one request
  failed and delay reached 21.677 s. It is not a full ten-minute comparison
  or a capacity pass. Normal previews now leave temporary CPU profiling off;
  always-on quota/event-loop metrics remain. Checkpoint publication also
  reuses its already-owned immutable capture rather than cloning it again
  after upload. Caller isolation and quiet-day rollover remain covered.
  All 89 affected checkpoint, mirror, resource and actual AAC encoder tests
  pass, including the explicit opt-in/direct/public matrix. An isolated
  generated 8 MiB save now performs one full-state clone rather than two;
  that is not a measurement of hosted peak-memory reduction.
  These further changes still require guarded hosted validation.
- Unattended, with no listener test running, deployed `5c9c5b2` stopped at
  2026-11-18 06:53:25 UTC with `EDGE_PUBLISH_FAILED` at `state-read`. The
  paid-advert chain lookup stalled (its queue selection timed out after 10 s
  at 06:53:30). The programme-state read waited for that lookup without its own
  limit, missed its 8-second deadline and permanently stopped audio
  publication. Programme state is now best-effort and runs beside, not in
  front of, segment and playlist uploads. A failed or stalled read is retried
  and reported as `stateIssue`; it no longer stops or delays audio. The paid
  advert queue and live-room lookups each fall back after 5 s to their
  existing unavailable messages. A regression proves audio continues through
  a failed then stalled state read and recovers. Segment/playlist upload
  failure still fails closed, and the publisher still has no automatic
  restart.
- Deployed `02d5987`, 18 Nov: a 50/600 run with a temporary 93% raw limit
  passed every check except the then 10-20 s delay target (delay p95
  23.9 s; raw memory max 88.9%, working set 72.8-75.4%). Under the amended
  rule, 200/600 decoded all 200 listeners with startup p95 1.5 s, metadata p95
  134 ms, delay p95 17.5 s, CPU max 38.6%, event-loop p99 61 ms and no
  errors, but was safety-stopped at 317.6 s on a working-set spike to 86.3%.
  No OOM kill occurred, and the working set returned to 73.5% within minutes.
- That spike and the smaller 90-second memory saw-tooth were traced to
  overlapping FFmpeg processes. The website-only VertLoop (Discord paused)
  decoded every advert purely as a clock nobody hears. Its current campaign
  is a 117 MB, 78 s 720p MP4, so each play downloaded the whole video. A local
  replica of that decoder held about 45 MiB plus about 4 MB of socket buffers.
  Both spikes (08:44 and 10:19 UTC) fell on song or advert changes while that
  loop was playing, alongside the current song, the prepared next song and the
  HLS encoder. At 08:44 the main radio was also decoding the same video
  advert. Website-only adverts now read only the container header for their
  length (cached per URL, capped at 120 s) and feed the existing player
  silence for that long, so no decoder or video download remains. Votes,
  timing, failure retry and Discord-enabled VertLoop playback are unchanged.
  These are local measurements and log correlation; hosted 200/600 under the
  amended rule must be repeated after deployment.
- Deployed `58c7aaa`, 18 Nov 16:09 UTC: idle working set fell to 63-70%
  (from about 73-81%). The 16:21 200/600 rerun decoded all 200 listeners
  (startup p95 1.3 s, metadata p95 197 ms, delay p95 17.6 s, CPU max 33.4%,
  working set max 70.6%, event-loop p99 48 ms, no errors), but it was
  safety-stopped after 61 s because the publisher reported
  `EDGE_PUBLISH_FAILED` at `playlist-upload` (`TimeoutError`). That short run
  is not memory acceptance evidence. Logs show the same permanent stop without
  listener load at 03:14 (no stage recorded) and 14:12 (`segment-upload`
  timeout). Each time, public audio stayed unavailable until the next deploy.
  Now, a segment or playlist upload that times out, fails at the network
  level or receives 408/5xx from the edge only defers publication. The
  snapshot reports `publishIssue`, status falls back to buffering after 12 s,
  the next 500 ms tick retries on the same stream URL, and status returns to
  ready once the edge accepts uploads. Local staging is trimmed before
  uploading, so an outage cannot grow it. Authentication, validation, size and
  encoder failures still fail closed, with no automatic restart. Hosted
  200/600 must be repeated after deployment.
- Deployed `29cf745`, 18 Nov 16:51 UTC: at 16:59:37 a real segment upload
  timed out and publication recovered 2 s later on the same stream. The 17:04
  200/600 run reached 448 s (startup p95 1.4 s, metadata p95 387 ms, CPU max
  38.4%, working set max 71.3%, no HTTP errors). It was then safety-stopped by
  `PCM_BUFFER_LIMIT` at `source-age` (1,004 ms old, 0.9 s queued). In that
  minute the bot's main loop recorded an 882 ms maximum. Its reported 35.2 s
  delay p95 and 154 failures include listeners after the publisher stopped.
  Render logs show 400-600 ms main-loop maxima every few minutes all day,
  with or without listeners. A one-second freeze therefore eventually stops a
  zero-tolerance encoder. The owner chose to both skip late audio (above) and
  profile the remaining freezes on the hosted preview.
- Deployed `45979fc`, 18 Nov 19:30 UTC: the 200/600 run lasted the full
  600 s without a stop or late-audio skip (startup p95 2.3 s, metadata p95
  393 ms, CPU max 43.6%, working set max 67.4%, event-loop p99 99 ms). It
  failed on delay p95 46.9 s and two Cloudflare 503s on `state.json` in one
  second. The server's newest segment was about 6 s old. Delay grew with run
  length (17-23 s in short runs, 39-47 s in every 10-minute run) because the
  player never rejoined live; it now jumps back (above). The CPU profile's
  largest application function was `periodOf` for radio-history advert
  tallies, which the site header polls every 15 s per open tab.
- Deployed `4851f4b` (#410 player rejoins live, #411 hourly payroll-week
  cache), 18 Nov 23:22 UTC: the 23:26 hosted 200/600 run passed every check
  (all 200 decoded, startup p95 1.7 s, metadata p95 284 ms, delay p95 26.7 s,
  CPU max 38.4%, working set max 71.2%, event-loop p99 84 ms, no HTTP or
  request errors, no stalls, no late-audio skips, no edge upload deferrals,
  production `selected=false`). Per-minute main-loop maxima during the run
  were about 100-400 ms, against 600-950 ms in the 19:31 run. The Render service builds from Root Directory
  `discord-bot/`, so commits touching only shared `js/` modules the bot
  imports did not auto-deploy; this one was deployed manually.
- After that run the owner approved selecting `public`. At 18 Nov 23:55 UTC
  `PUBLIC_BROADCAST_MODE=public` was deployed (`6368179`) during ordinary
  rotation, through the predeploy guard. Headless Chrome on the live site
  showed the buffered broadcast label and played 15.0 s of audio in 15 s from
  edge segments. Friday's human rehearsal is the next real-world check.
  Rollback: set `preview` and deploy.

These observations support the CDN distribution approach, not readiness
sign-off. The approved decoded-start percentile, actual Render container
headroom, controlled network reliability and human/hardware rehearsal still
need evidence. A feature-off reader release is distinct from approving a
production public-transport switch.

Why this was not finished in the previous sprint: functional repairs and their
regressions were delivered, but the staged capacity exercise, full-container
instrumentation and operator-approved acceptance contract were not completed.
That was a planning/closeout gap. Passing functional tests was never proof of
audience capacity, and further live observation must not be reported as already
performed.

## Reuse decision

Need: distribute the complete public programme without per-listener LiveKit
seats, while preserving public/private gates and exact performer attribution.
The searched scope was Canopy's relevant curated offers and current Busking
source, tests, issues/PRs and worktrees; it was not a whole-library inventory.
Adapt Busking at `35f9a96d34c552a98cbc14a7b5c6acb9dd01b41f`:
`createLiveAudioService`'s independently verified PCM,
JukeLoop's `_startPrepared` consumed-resource path, and the existing shared
radio audio element and deployment guard. No compatible whole-program HLS
donor was identified in that inspected scope. The small publisher, edge and
HLS player are new; no speculative shared framework is extracted.
Existing Apache-2.0 Busking code and third-party notices remain applicable.
For compact checkpoint identities, reuse Busking's existing
`discord-bot/checkpoint-history.js:contentHash` from `973f806`; no new hash
dependency or shared abstraction is needed. The receiving checkpoint,
retention and required-mirror tests pass, including the measured retained-heap
regression; hosted validation remains a separate gate.
The website-only advert clock adapts the existing `devert-loop.js`
controller and its injected `createStream` seam; FFmpeg's own header read
supplies the length because the deployed bundle has no `ffprobe`.
Edge publish recovery adapts the `stateIssue` deferral from `02d5987` (#400)
and reuses the uploader's existing transient-error classification.
Receiving tests include actual FFmpeg AAC decode across advert/A/B/advert,
wrong/private-room exclusion, delayed tip binding, zero-seat HLS admission,
state coalescing/expiry, quota normalization and legacy-radio regressions.
Hosted capacity, a genuine multi-human rehearsal and hardware Safari remain
separate evidence gates until actually performed.
