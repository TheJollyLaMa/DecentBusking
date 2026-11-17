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
thread boundary and the PCM queue remains limited to one second. The encoder's
own 500 ms scheduling-stall limit, private-room gates and protected tail remain.
Public state is requested from the parent through the existing eight-second
deadline, and worker errors explicitly make the broadcast unavailable.

The client uses native HLS only with a usable programme clock (`getStartDate`),
otherwise the self-hosted pinned Hls.js bundle. Native playback capability
alone is insufficient to identify the audible performer. The Hls.js initial
sync target is three segments; playback stays at normal speed rather than
fast-forwarding a buffered song ending. AAC decoding is required. An embedded
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
Receiving tests include actual FFmpeg AAC decode across advert/A/B/advert,
wrong/private-room exclusion, delayed tip binding, zero-seat HLS admission,
state coalescing/expiry, quota normalization and legacy-radio regressions.
Hosted capacity, a genuine multi-human rehearsal and hardware Safari remain
separate evidence gates until actually performed.
