# Live audio pilot — website radio

This is an **audio-first, disabled-until-configured** room implementation. It does not create an account, subscribe to a plan, deploy, publish an invitation, record media, or move money. A funded, acknowledged `pilot-guaranteed-v1` booking supplies the identity, start and end. No wallet address or Friday timestamp is hardcoded.

The agreed pilot is Friday **November 13, 2026, 21:00–21:20 America/New_York** (`2026-11-14T02:00:00Z`–`02:20:00Z`), following Friday Hype. Its private checks are **20:00 and 20:45 ET**. These are operator acceptance targets, not a calendar creation performed by this change.

## Reuse / transport decision

The actual Canopy Rabbit Hole is `rabbit-hole/index.html` at `5f46266979f02487896ea330c1a3a7d036243cf8`, with wallet/session proofs around lines 615–670 and PeerJS mesh calls around 729–963. `wiki/Creators-and-Archive.md` documents public PeerJS signaling, no TURN, approximately six video participants, twelve guests maximum, and radio playback local to each browser. It has no OBS ingress, authoritative radio handoff, or independent media-health receiver. Its tests cover room links, signed opt-in and IPFS inclusion, not verified multi-network audio delivery.

That is useful existing room/authentication work, but not a compatible production transport for this pilot without adding relay/ingress infrastructure. Following the user's conditional approval, this change uses **LiveKit Cloud**, one room per booking, pinned SDKs, browser microphone/audio-interface publishing, and optionally OBS WHIP ingress without transcoding. It adapts Busking's signed-origin controls, existing radio media element, JukeLoop exclusion and existing paid-ad selection/completion paths. It does not extract a speculative shared framework.

References: [LiveKit ingress](https://docs.livekit.io/transport/media/ingress-egress/ingress/) and [encoder configuration](https://docs.livekit.io/transport/media/ingress-egress/ingress/encoders.md). Existing repo code is Apache-2.0. No Canopy source or private inventory data was copied/published.

## Hosting gates — not completed by code

An operator must separately provide an approved LiveKit Cloud project with sufficient **free** participant/ingress quotas and no paid subscription/spend. Code cannot establish the account's billing limits. Do not enable a project whose usage can incur unauthorized charges. Confirm microphone publishing, ingress and the independent worker receiver fit the free allocation.

The worker requires Node **22.12+** (also required by existing `@discordjs/voice`), HTTPS, working outbound WebRTC/TURN access and the existing encrypted, locally mirrored Pinata checkpoint service. No purchased disk is required. No second production bot may be started from a development worktree.

Server-only environment names, deliberately without values:

- `LIVE_AUDIO_ENABLED=true` only after hosting/quota approval.
- `LIVEKIT_URL` — the project's `wss://…livekit.cloud` URL.
- `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` — **never** browser config, repository files, shared screenshots or logs.
- `LIVE_AUDIO_STORAGE_KEY` — dedicated 32-byte random hex AES-256-GCM key, privately backed up and never reused from content-review or signing keys. Production uses `createLiveAudioPinataStore`, not an ephemeral file path. Only lifecycle state is allowlisted; no media, tokens or stream keys are persisted. Existing Pinata credentials and the checkpoint mirror must be available; missing/latest-checkpoint restore or mirror failures close media controls. Healthy packet timestamps stay in memory; only lifecycle transitions write checkpoints.
- `LIVE_AUDIO_OBS_ENABLED=true` only after independently approving WHIP ingress availability/quota. Otherwise OBS is explicitly unavailable.
- Existing owner wallet and allowed-origin configuration must match the website. Do not add a new hardcoded performer identity.

Missing hosting/storage configuration fails closed. The existing Render service had no LiveKit credentials or durable disk at the release audit; neither hosting nor broadcasting is activated by this release. Native `@livekit/rtc-node` must load on the deployment architecture; source code is not proof of live compatibility.

A lifecycle save has a **ten-second deadline**. Missing that deadline disables
media controls and closes existing rooms, rather than holding the media watchdog
behind the mirror's longer timeout or claiming successful cancellation/recovery.
An underlying checkpoint request may finish later; the failed process does not
resume broadcasting. Restore still requires the latest authenticated checkpoint
and fresh receiver evidence. Real mirror/upload latency must be tested before enabling.

For local setup, fill the ignored `discord-bot/.env.live-audio.local` in the
isolated pilot worktree, not a production checkout. It starts disabled and
contains no wallet key. Use it only with a separately configured local worker;
do not start a second production Discord bot. This file is a staging worksheet,
not an automatic Render environment update. Keep permissions 0600, server-only
credentials out of chat, and both enable flags false until hosting/quota/storage
approval. Calendar deployment uses its own ignored `.env` in the Calendar
feature worktree; the two applications do not share keys or credentials.

Friday's funded room cannot be used for an earlier rehearsal: access opens at Friday T−70.
The separate private rehearsal mode below requires no booking or payment and cannot arm
public radio. Missing USDC is not permission to swap ETH, fund an escrow, transfer token 75
or activate a broadcast.

Booking verification refreshes in the background rather than blocking the media watchdog on RPC/indexing. Initial access remains unavailable until a snapshot loads; verification older than thirty seconds denies new authorization, publishing and listener grants. Existing room health/cancellation continues using its previously verified booking and original end. Operator cancellation remains available with the existing room session. Test booking-service failure as well as media transport failure.

Once enabled, the worker prepares eligible funded pilot rooms at T−70, even if nobody opens backstage; a missed soundcheck cannot leave radio paused indefinitely. Stop/revoke an existing OBS input before disabling ingress configuration. Switching to browser publishing while ingress is enabled revokes the old OBS key.

Never enable automatic egress/recording in the hosting project. This code requests no recording/egress. OBS video/crowd features are not implemented; configure only the required audio where the encoder permits, and do not assume hidden video is a privacy guarantee.

## Separate private rehearsal

### Wallet-linked practice before show day

The invitation and Profile card link to `live-room.html?booking=<id>` even
before acceptance/funding. That URL grants no access. Before T-70 it embeds
the existing private rehearsal client with the booking reference. The worker
verifies the live booking and signed wallet (only performer or configured
operator) before creating/rejoining a private room. Practice uses no financial
signature, radio arming or soundcheck credit. The per-wallet session lasts at
most 15 minutes; reauthorize for another session, with rooms capped at two hours.
There remains one private rehearsal at a time; a closing room can take 35 seconds
to clear. Provider failure/restart cleanup limitations below still apply.
Private checkpoints retain encrypted latest-state readback verification. Their
bounded 45-second write deadline allows the storage helper's 15-second gateway
attempts to finish; consent/end requests allow 60 seconds, while ordinary audio
controls retain their 10-second unavailable cutoff. A failed checkpoint still
closes access rather than pretending the room was saved.

At T-70, private practice ends and the same page switches to the existing
funded/accepted backstage flow. Both actual soundchecks and explicit operator
arming are still required. The top-center sign counts down from the booking;
it lights ON AIR only for fresh server-confirmed delivered audio in the exact
funded/accepted booking, inside its slot. A clock, green mic indicator or practice
audio cannot light it. An expired service response goes OFF AIR.

The independent native receiver checks advancing **audio inbound-RTP** packet
counters across both SDK peer-connection statistics lists, plus recently decoded
PCM. In rtc-node 1.2.1 the actual receive connection can appear in
`publisherStats` while `subscriberStats` is empty. The list's name does not make
an outbound counter delivery evidence. Video/outbound counters and decoded
concealment without new packets never establish freshness.

Reuse: adapt `rehearsal.js` / `rehearsal.mjs` and the existing live backstage
client, retaining separate private/public transport namespaces, signatures and
escrow gates. No recording, payout streaming or Calendar integration is added.

The receiving need is a short two-wallet audio rehearsal without a funded booking or
public radio. Reuse decision: adapt this repository's `discord-bot/live-audio-transport.js`
independent receiver and `js/live-audio-client.mjs` SDK loader from merged pilot commit
`f60fbb48b225ad9bbcfa35ffbcd59006a1f3e6d4`; use a separate service, routes, signed
challenge text, encrypted checkpoint namespace and rehearsal-prefixed random IDs. The
Canopy `data/agency-map.json` inventory was consulted; the existing Rabbit Hole/PeerJS
candidate lacks the independent receiver and managed relay required here. No shared code
was extracted. The existing paid booking/policy and financial signer mirror paths are not
reused as rehearsal state or relaxed.

`PRIVATE_REHEARSAL_ENABLED=true` is a separate server-only switch, default false.
It requires the existing owner wallet, allowed website origin, LiveKit URL/key/secret,
Pinata JWT, and dedicated `LIVE_AUDIO_STORAGE_KEY`; `LIVE_AUDIO_ENABLED` and
`LIVE_AUDIO_OBS_ENABLED` can remain false. Confirm the free LiveKit participant quota and
disable egress/recording in the project; the rehearsal requests neither recording nor OBS.
Only one rehearsal at a time, two humans plus the worker receiver, for at most 120 minutes.

Only the configured owner may create an invitation: open `/rehearsal.html`, enter the
confirmed guest wallet and a duration, connect the owner wallet and sign the displayed
origin-bound message. Share the resulting invitation privately. The guest opens it,
connects the invited wallet, and signs the explicit consent message. Neither signature
is a transaction or authorizes payment. Each may select an input, publish and listen, or
listen only. Use headphones. The worker receiver verifies the guest's incoming audio;
that indication is not proof the owner heard it. Stop or leave when finished; the owner
can end for everyone. Browser wallet sessions expire after 15 minutes or at the room
deadline, whichever is earlier. A new signature is required; if all participants leave
or stop heartbeating for 30 seconds the room ends. Closing the page stops browser audio.

The lifecycle checkpoint is AES-GCM encrypted on Pinata with an allowlist of room ID,
guest wallet, expiry and ended time; no media, tokens, signatures or credentials are
stored. It has a distinct name and authenticated-data domain and does not require the
local mirror, allowing unattended hosted operation. Saves require a successful latest
listing and authenticated read-back; listing, latest-read, integrity, or save failure
closes controls. Equal-time ambiguous latest checkpoints are rejected. Like any
Pinata-only store, it relies on the provider returning a complete, correctly ordered
listing; it cannot detect an omitted latest checkpoint or prove rollback resistance
without an independent durable authority. Financial signer journals and funded live
audio still require their existing local mirror. Back up the key privately.

Restart invalidates all rehearsal sessions and ends restored room generations; cleanup
retries until LiveKit confirms deletion. Short-lived join grants may recreate a deleted
room briefly, so the worker retains the ended tombstone and retries deletion for at least
35 seconds. Expiry is **not a strict provider-side TTL**: LiveKit token expiry applies to
initial connection, not an already-connected participant. During a worker outage the
browser stops at its deadline, but an uncooperative or disconnected-from-control client
could remain connected until the worker recovers and deletes the room. This limitation was
explicitly accepted; no claim of provider-enforced cleanup is made.

Validation uses mocked browser transport and signed test wallets; it does not demonstrate
real audio, consent by the invited person, or an actual room. Live listening requires
both people to participate after deployment and enablement.

## Private room and controls

Open **Open performer audio room** in the wallet's Profile booking or **Open operator audio room** in Admin's booking listing. Both link to `live-room.html?booking=<existing-funded-booking-id>` for an acknowledged, funded, uncancelled, unended guaranteed-pilot booking. They do not grant rights or assert that hosting is configured. Keep the performer room open while publishing browser audio; navigating away stops that source. An absent, unfunded, unacknowledged, cancelled or incompatible booking cannot publish.

- Backstage opens at T−70 minutes. The performer and configured owner sign a fresh, origin- and booking-bound one-use challenge. This authorizes room access, not payments. Sessions are memory-only and end at the original booked end; reload/restart requires reauthorization.
- The performer alone can publish microphone/audio-interface audio or obtain/replace OBS credentials. The owner receives audio and controls checks/arming/cancellation; public listeners receive only.
- Microphone input selection requests permission on an explicit click. Use headphones; music capture disables automatic gain/noise suppression/echo cancellation. Browser Opus DTX is disabled so intentional silence continues transport.
- OBS: use a WHIP-capable version, Opus audio, and the complete private WHIP endpoint shown. Its key is in the endpoint path; leave the separate Bearer Token field empty. Never publish it. Replacing the input revokes the previous ingress. Validate silence, reconnection and codec behavior with the actual OBS version.
- The same booking room remains private through both checks. No public listen token exists before an armed slot starts. The source does not need to be moved between private/public rooms.
- Owner listens, confirms T−60, then confirms T−15, then **arms**. The first check window is T−70 to T−40; the second is T−25 to start. Neither a source connection nor clicking a check alone is proof: a separate worker receiver must be receiving decoded audio and advancing inbound audio RTP packet counters.
- Public capacity is ten listeners; the performer, owner and receiver are separate participants. Admission can briefly report busy after repeated reloads; retry in thirty seconds.

## Truthful delivery and handoff

At the booked start, an armed room is eligible for website-radio listeners. The main player stops old recordings, stale preloads, upload takeovers and ad transitions before attaching the authorized audio track. Archive listening remains an explicit listener opt-out. Mute/volume/autoplay restrictions remain visible and respected.

The index import map redirects the existing radio-controller import URL to one cache-busted live-audio module, including cached stage/DJuke/listening modules; it avoids loading two independent radio controllers. Use a current import-map-capable browser and reload the website after deploying this change. An already-open tab running old code does not become a live receiver automatically.

Server **ON-AIR** requires fresh decoded audio **and advancing received RTP packets** at the independent worker receiver. Zero-amplitude music silence is valid; speaker activity/nonzero amplitude is not a health test. Browser ON-AIR additionally requires its own advancing audio packets and playing media. A connected socket or published track alone is insufficient. Autoplay blocking says to tap Play. Short failures show **RECONNECTING**.

After **60 seconds without verified delivered audio during the booked slot**, cancellation is irreversible for that booking. Lack of arming also cannot leave a silent reservation indefinitely. An observed outage deadline is checkpointed and survives restart, with a five-second receiver rejoin probe. A previously healthy checkpoint is **not proof** that audio stopped at its old timestamp: after an unobserved process gap, the worker starts an unverified grace period and must receive packets before showing ON-AIR. This avoids irreversible cancellation based on an invented outage. Watchdog scheduling can add a short delay; test the actual hosting environment.

Cancellation order:

1. Persist the cancellation and stop new grants; revoke OBS ingress and close the room.
2. Display the cancellation message. For up to **five seconds**, show static color bars and quiet, smoothly enveloped noise/tone. No flashing; honor radio mute, allow immediate dismissal, and do not replay the full slate for late arrivals. Browser audio policy may suppress its sound.
3. Give **ten minutes of wall-clock time** to DVert adverts using existing paid-ad priority, campaign eligibility, audio evidence and completion bookkeeping. DJuke songs remain queued. A different explicitly reserved event takes precedence; recovery cannot silently displace another performer's booking. Verify calendar room for the recovery window before the pilot. Missing/failed ads produce an honest waiting state—not invented impressions, a guaranteed ten minutes of delivered adverts, or replacement fabricated content. A window boundary interrupts unfinished media without claiming completion.
4. Resume ordinary radio. The protected live slot itself never accepts ads or paid DJuke interruptions.

The injected cancellation hook is `onCancel(booking, reason)`. Worker wiring invokes the existing booking `execute({action:'cancel', id, reason, confirm:true})` for the **calendar/booking cancellation only**. It does not submit an escrow transaction. The guaranteed-pilot policy keeps the full fee funded until the existing post-end approval/claim process. Hook failure is retried and does not undo media cancellation. Rehearsal arithmetic and guaranteed pay are separate concerns.

**Discord parity:** current JukeLoop pauses Discord's regular audio while website live audio is active. The new worker receiver verifies PCM delivery but does not feed that PCM into Discord. Thus website audio is primary and **Discord live parity is not enabled**. A later bounded adapter could feed that already-received PCM through a separate Discord voice resource; it still needs real permissions, reconnect and duplicate-audio checks. Cancellation announcements/regular-ad recovery use existing JukeLoop paths when Discord is available; delivery is not promised during Discord outages.

## Release/soundcheck acceptance — still required on actual hosting

- Two separate real devices/networks, including mobile Safari/Chrome and a restrictive/mobile network. Test browser microphone, USB/audio interface and actual OBS independently.
- T−60/T−15 are private: an unauthenticated listener, wrong wallet, old signature and copied URL cannot hear backstage or publish/control.
- Ten concurrent listeners plus performer/operator/receiver; late join, refresh, mute and autoplay prompt. Confirm no wallet is required to listen publicly.
- Measure glass-to-glass latency; proposed pilot target is ≤5 seconds, not a measured capability claim.
- Keep intentional silence for over sixty seconds: **no cancellation**. Inject 5/30/59-second transport outages: reconnect without cancellation. Inject ≥60 seconds without advancing audio packets: cancel once, revoke ingress, preserve the fee, then observe the exact recovery sequence.
- Close/restart the worker, fail the checkpoint write, lose the hosting connection, block OBS, switch wallet and revoke source access. A total worker/hosting outage cannot deliver adverts; display unavailable rather than pretend recovery.
- Verify radio → live → radio has no duplicate sound or stale source; paid DJuke stays queued; ads only run in the cancellation window or normal programming, with actual existing evidence/priority rules.
- Inspect provider recording/egress and billing settings; verify no recordings or unauthorized spend. No real cloud stream, mic/OBS soundcheck, ten-listener load test or deployment has been completed by local unit tests.

## Local verification

The focused media/radio/schedule/paid-queue/booking/storage/reward tests pass locally
(283 tests), including healthy transport without periodic checkpoint uploads,
one durable write per outage/recovery transition and a bounded stalled save.
Full-suite validation found five
pre-existing failures: two playlist wiring assertions, one Admin section-count
assertion and two legacy unbooked-Friday handoff assertions; the additional three
were reproduced on released `19f8d66`. No unrelated fixes were applied.
Synthetic 390px browser checks exercised unavailable hosting, performer/operator
separation, private-check controls, quiet/dismissible fault UI, and wallet-change
races. The pinned native/server/browser SDKs load locally. These are implementation
checks, not a live soundcheck, load test or measured latency result.
