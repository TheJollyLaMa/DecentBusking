# Live audio pilot — website radio

This is an **audio-first, disabled-until-configured** room implementation. It does not create an account, subscribe to a plan, deploy, publish an invitation, record media, or move money. A funded, acknowledged `pilot-guaranteed-v1` booking supplies the identity, start and end. No wallet address or Friday timestamp is hardcoded.

For the separately gated larger-audience transport, its costs and acceptance
limits, see [Public broadcast operating guide](PUBLIC_BROADCAST.md). That path
does not enlarge the interactive studio's LiveKit participant allowance.

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
- `LIVE_AUDIO_STORAGE_KEY` — dedicated 32-byte random hex AES-256-GCM key, privately backed up and never reused from content-review or signing keys. Production uses `createLiveAudioPinataStore`, not an ephemeral file path. Only lifecycle state is allowlisted; no media, tokens or stream keys are persisted. The default requires the checkpoint mirror. `LIVE_AUDIO_CHECKPOINT_MODE=hosted-verified` explicitly uses encrypted Pinata lifecycle checkpoints with verified latest-CID/content readback instead, adapting the private rehearsal store. Missing, ambiguous, unreadable or unverifiable latest state closes media controls. This media-only option changes **no financial, booking, payroll or paid-playback durability requirements**. Lifecycle writes have a bounded 45-second deadline; authorizing/checking/arming clients allow 60 seconds. Healthy packet timestamps stay in memory; only lifecycle transitions write checkpoints.
- `LIVE_AUDIO_PROGRAMS` — optional JSON keyed by exact booking ID, with integer `leadInSeconds` and `outroSeconds` (0–600). This opts only the specified funded/accepted booking into scheduled advert breaks. It does not fund, arm, pass soundchecks or authorize recording. Invalid configuration stops startup.
- **#358:** `LIVE_AUDIO_GRACE_MS=15000` selects the authorized 15-second recovery default explicitly. An existing `60000` override must not be mistaken for the new policy. The supported override is an integer 1–60000 ms.
- **#358:** `LIVE_AUDIO_RECOVERY_ENABLED=true` enables explicit producer recovery writes **only after the reader-first sequence below**. It defaults off. The shorter default watchdog does not depend on this control flag.
- `LIVE_AUDIO_OBS_ENABLED=true` only after independently approving WHIP ingress availability/quota. Otherwise OBS is explicitly unavailable.
- Browser listener freshness uses `RemoteTrack.getRTCStatsReport()` audio-only inbound RTP counters. LiveKit 2.23's summarized audio `getReceiverStats()` omits `packetsReceived`; neither bytes, video/outbound counters nor concealed samples substitute for received audio packets.
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
Before backstage opens, the stable link embeds private practice and offers a direct
practice tab for wallets that do not inject into frames. MetaMask account exposure
during the initial connection is not treated as a mid-session wallet change.
Entry displays connection, invitation-check and signature progress; subsequent
account changes still invalidate authorization.
The public Live Events card also exposes a stage button for the exact funded,
acknowledged, compatible booking, even before a wallet is connected. It is a
discovery link, not an authorization grant. It distinguishes performer/operator
entry from audience listening and lists backstage and both soundcheck times in
New York time; cancelled, ended and incompatible bookings expose no stage entry.
The separate private rehearsal mode below requires no booking or payment and cannot arm
public radio. Missing USDC is not permission to swap ETH, fund an escrow, transfer token 75
or activate a broadcast.

Booking verification refreshes in the background rather than blocking the media watchdog on RPC/indexing. Initial access remains unavailable until a snapshot loads; verification older than thirty seconds denies new authorization, publishing and listener grants. Existing room health/cancellation continues using its previously verified booking and original end. Operator cancellation remains available with the existing room session. Test booking-service failure as well as media transport failure.

Backstage booking verification allows up to 60 seconds for the escrow-backed booking list. Leave the tab open while it loads; a timeout is reported explicitly and retried automatically. A loading timeout does not stop an already-published microphone.

For separate voice/instrument inputs on a two-channel interface, choose **Transmitted mix → Voice + guitar · centered mono in both ears** before publishing. It averages both input channels and sends the same mix to left and right; intentional stereo remains the default. This differs from **Headphone mix**, which affects only local software monitoring. Changing an active transmitted mix requires a coordinated stop and republish; do not interrupt an on-air set to change it. Scarlett mono direct monitoring can center the performer's headphones without changing the USB capture sent to the browser.

Once enabled, the worker prepares eligible funded pilot rooms at T−70, even if nobody opens backstage; a missed soundcheck cannot leave radio paused indefinitely. Stop/revoke an existing OBS input before disabling ingress configuration. Switching to browser publishing while ingress is enabled revokes the old OBS key.

Never enable project-wide automatic egress/recording. Consented scheduled-set
recording uses the existing independent audio receiver and a separate affirmative
performer permission, not the original guaranteed-fee booking. The backstage
checkbox defaults off and its information explains public audio, DNFT minting
and radio replay. No private practice, soundcheck or video is recorded.
The owner reviews the finalized recording in the existing mint panel; only a
real completed mint unlocks replay at a safe afterparty radio boundary.
Enable this path with `LIVE_AUDIO_RECORDING_ENABLED=true` only after testing.
The separate encrypted recording journal verifies the performer's wallet signature
and binds consent to the booking, origin and timestamp. Revocation is a newer signed
choice, not a change to the original booking or fee.

Audio is copied from the existing 48 kHz mono receiver only during the armed
scheduled slot with fresh packet evidence. Thirty-second WAV segments are pinned
as they fill and checkpointed with verified encrypted readback. At most four
segment uploads can queue; a failure stops capture explicitly, not the live show.
Already public segments cannot be recalled. A crash can lose the current unpinned
segment; restored/gapped/truncated recordings are labelled partial, never complete.
At the end, ffmpeg (`FFMPEG_PATH`, otherwise `ffmpeg`, as for ordinary radio)
streams the persisted segments into a 192 kbps MP3. Finalization retries from
the durable manifest, but does not create a mint request. The booked performer
can open **Review your live recording** from Profile after the set, preview the
preserved original, save a split draft or decide later, and explicitly approve
either a full-set or split-song release. Split boundaries use exact canonical
48 kHz source samples; each server export is limited to 30 minutes and 45 MB.
Approval is a wallet signature, not a transaction. The encrypted journal retains
the source CID, consent, approval, exports and release-to-queue state so a failed
export or queue handoff can be retried without changing the original bytes or
duplicating an accepted release. Source audio and exports on public IPFS are
public, not private. Every approved release independently enters the existing
admin mint queue; owner review and a genuine mint signature remain separate.
The existing community DBusker artwork is used; mint recipient and tip wallet
are the booked artist, not an operator or invented Discord account.

Full-set and split-song releases may coexist when separately approved. After a
mint, a later cut is a new immutable release linked to the existing full set;
no token or source is edited in place. The booked performer remains artist,
royalty receiver and tip wallet under existing defaults. No collaborator split
is inferred or added.

The same `recording-edit.html` room is also embedded in the archive's right-side
panel and remains available as a dedicated page. A verified configured-collection
NFT card offers **Edit / split** only to its metadata-attributed artist wallet.
The server re-resolves the NFT from the chain-synced catalog, checks moderation
and audio media type, and binds authorization and each publication approval to
the NFT identity and original source CID; arbitrary CIDs are not accepted. The
attributed artist wallet (not a current ERC-721 holder lookup) is the edit
authority. Catalog audio must be a directly addressed IPFS file, at most 100 MB
and 120 minutes, and must decode successfully into bounded 48 kHz mono segments.
The draft starts with three or four named cuts, can be adjusted to three or four,
and autosaves **on this browser/device**, scoped to wallet, NFT/booking and source
CID. Local drafts are not synchronized across devices; blocked/full site storage
is an explicit error and prevents a successful close/switch flush. Closing or switching
the panel flushes pending edits before it hides or replaces the room. A full-set
approval and a cut approval are separate wallet signatures; only approved cuts
are exported as new MP3 releases. Existing NFT/source media are unchanged, the
artist remains recipient and tip wallet, and no collaborator payout is inferred.

The right-edge Studio tab is shown after the connected header wallet is verified
as the credited artist/creator of at least one editable catalog song NFT. Its
search and pagination show only that wallet's artist-attributed audio, not tokens
it merely holds or collaborator credits. NFT-card **Edit / split** still opens
the panel. It reuses the header wallet without another connection or opening
signature. Preview, cut editing, draft saving and “decide later” are unsigned.
Only final full-set/cut confirmation requests **one publication signature**;
artist proof, exact source/sample count, origin, revision, choice and cut contents
are verified before any derivative upload or journal write. Existing v1 approval
messages and deterministic release IDs are retained; identical pending retries
reuse the signed approval and cannot create duplicate releases. Existing scoped
access routes remain compatible with older clients.
Wallet changes clear the panel and discard stale preview/signature responses.
The standalone room remains compatible, but the panel has no dedicated-room link.

`recording-preview` exposes only verified public source analysis and a revision
counter, not previous server drafts, consent signatures or release history.
Catalog analysis streams bounded 48 kHz PCM without pinning chunks or saving the
journal. Before decoding, the original is streamed to a private, bounded
temporary file (100 MB maximum), then removed on success or failure. MP4/M4A
files can store metadata after their audio; decoding a non-seekable input pipe
fails for these otherwise valid recordings. Both preview and approved
publication use the seekable file, with network input protocols disabled in
the decoder. There is one concurrent analysis, a 15-second new-analysis admission
interval and a four-entry/ten-minute memory cache; new analysis pauses during
live capture/deployment. Signed publication uses the existing encrypted journal,
bounded exports and independent admin mint queue. Gateway download preserves
configured access-token queries and can fall back to another gateway for the
same immutable CID; diagnostics contain host/status or classified error codes,
never provider URLs, tokens or raw exceptions.

Visible loading covers source checks, waveform preparation and original
audio metadata. Preview failures and slow loads offer a retry without altering
the saved draft. Waveform boundaries support pointer/touch dragging, arrow keys,
Shift-arrow one-second steps and Home/End. Shared cuts move both adjacent song
edges; source bounds, neighboring cuts and the 0.5-second/30-minute limits apply.
The time fields remain synchronized. While the panel is open, the existing
invitation-gated DBusker is docked in its header as a small avatar; its chat stays
inside the panel instead of floating over the editing controls.

Studio polish reuse: adapt the existing Busking editor/model, catalog paging,
header wallet and DBusker host at `3de791a0b61d9bc751bf181d00917f5e80b3bd69`;
no separate editor or assistant instance is introduced. Receiving-app checks
cover creator-only discovery, stale wallet/search results, local close/switch
flushes, shared-cut sample bounds and longer catalog save/approval responses.
Unsigned-flow repair adapts those same `e092966` modules and the existing v1
publication proof rather than introducing a second editor or approval protocol.
Tests exercise trailing-metadata MP4 decoding without writes, no-write preview,
one-signature confirmation, wrong artist/origin,
restored proofs, idempotent retries and explicit local-storage failures. A real
artist's final confirmation and production mint are not established by fixtures.

Release the backend reader/routes first, verify the hosted unsigned preview, and
only then publish the new editor assets. Legacy editor routes stay available.
Once a new publication proof has entered the journal, rollback must retain the
new proof reader; an older worker cannot validate that authorization variant.

The existing admin panel still requires a genuine owner-signed mint and verified
chain reconciliation. A durable replay-pending marker prioritizes the approved
full-set recording only in normal rotation after the five-minute outro, behind
paid requests and protected shows. Split tracks do not auto-replay.
Failed/short/interrupted plays remain pending. Deployments wait for an armed
public handoff and active recording/finalization to become safe.

Reuse decision: the receiving-app acceptance test is a separately consented live
set reaching the existing admin mint queue, followed by verified-mint radio replay.
The Canopy inventory and current Busking issues, PRs and worktrees were checked;
this adapts Busking's `live-audio-transport.js` receiver,
`rehearsal-store.js:createRehearsalStore` encrypted/readback pattern,
`ipfs.js:createIpfsUploader`, and `playlist-store.js:submitMediaTrack`.
These donors are in this same Apache-2.0 repository; no external source was copied.
No shared package or new minting authority is introduced. Recording consent,
bounded media storage and durable replay intent are new because the existing
room/ingest path did not provide them. Tests include actual native PCM capture,
a fully decoded twenty-minute MP3 fixture, restart/readback failure and paid/
protected-show replay boundaries; a fixture is not a real artist's signature or mint.
OBS video/crowd features are not implemented; configure only required audio
where the encoder permits, and do not assume hidden video guarantees privacy.

Public live listeners on the main-radio page currently use LiveKit individually.
`LIVE_AUDIO_LISTENER_LIMIT` defaults to 10; tonight's explicit target is 90 with
reserved performer/operator/receiver seats. The documented Free Build project
cap is 100 simultaneous participants across all rooms, subject to separate
monthly allowances. Recorded rotation does not use LiveKit. Public HTTP/HLS
fan-out is a follow-up in
[#331](https://github.com/TheJollyLaMa/DecentBusking/issues/331), not a tested
integration or an unlimited audience claim.

## Separate private rehearsal

The practice client guides the artist through wallet consent, **Start my
microphone**, browser permission and the input meter. The local meter is not
proof of network delivery: the separate delivery indicator uses the independent
worker's packet/decoded-audio evidence for the invited artist. The operator's
own mic does not light the artist's delivery indicator. Listening alone is
silent. For hearing their own performance, recommend the interface's direct
headphone monitor first. An optional **Hear my input** browser monitor is
headphones-only, defaults off, starts quietly and may introduce noticeable
delay. Never enable both direct and browser monitoring. Browser monitoring
connects only the captured local input to the local audio output; it does not
replay the network feed, record, or prove what listeners receive. Both practice
and booked backstage provide the same controls. Stop/reconnect, wallet change,
expiry and page exit reset browser monitoring to off; it never restarts itself.
Permission errors stay visible during state polling;
Stop audio stops capture and resets the meter. Consent controls return after
expiry or wallet change.

The room's DBusker portrait and expandable help are a static guide to input,
headphones and delivery checks, not a connected AI agent or a claim that the
operator is present. The stable room link transitions to booked backstage at
T-70 with fresh wallet authorization; neither self-monitoring nor practice
passes the two operator-confirmed Friday soundchecks.
Only one help section is visible: the embedded practice guide before T-70,
then the outer backstage guide. The entry title's keyboard-accessible “i”
explains wallet-control proof, temporary access and private-audio consent,
separately from booking acceptance or financial authorization.

### Wallet-linked practice before show day

The invitation and Profile card link to `live-room.html?booking=<id>` even
before acceptance/funding. That URL grants no access. Before T-70 it embeds
the private rehearsal client (below); a host must have accepted a live invitation
or be an administrator. The booking reference only changes the welcome
text. Practice uses no financial signature, radio arming or soundcheck credit.
Closing-room tombstones do not block other independent rehearsals. Provider
failure/restart cleanup limitations below still apply.
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
### Independent DHearse rehearsal rooms

Administrators/engineers and wallets with **any previously accepted live invitation**
can start a separate room, without a current booking, funding or show window.
Cancelled/completed accepted invitations still qualify. Server-side eligibility
uses the persisted booking acknowledgement, not NFT ownership or a claimed role;
unavailable history produces an explicit error. The header wallet's DHearse tab
uses the same check. `/rehearsal.html` is not a global shared room.

Each creation allocates a different random 256-bit rehearsal ID. The private
invitation is `rehearsal.html#room=<id>`: the fragment avoids ordinary URL/referrer
logging, and the page sets `no-referrer`. Treat this unguessable ID as an invite
capability. It is not listed by public status/eligibility APIs. Any wallet holding
the link can sign room-, action-, origin- and nonce-bound consent, including
bandmates without bookings. There is no walletless or synchronized remote-band mode.
Each room has up to six people plus its independent receiver; existing overall
64-pass and 100-checkpoint-room limits remain. Provider project quotas can reject
additional connections; this is not a new tested audience-capacity claim.

- **Lost page:** open that rehearsal's invitation and sign again while it is active.
- **Passes** stay valid while the page checks in. An abandoned page loses access after
  five idle minutes. **Stop audio** keeps you signed in; closing the page signs you out.
- **Sessions** close when everyone has left, after four hours, after a worker restart,
  or when its host/an engineer closes it. Old links then expire; an eligible host
  starts another rehearsal with a new link.
- **Engineers** (`REHEARSAL_ENGINEER_WALLETS`, comma-separated; default
  thejollylama.eth and decentagency.eth, plus `MINT_OWNER_WALLET`) can remove someone
  for the rest of that room, or close it for everyone. The room's host has those
  controls in their own room only. Guests cannot manage rooms.
- **Delivery check** is per person: the worker receiver confirms each person's audio
  reaches the room. It is not proof that anyone heard it.

The lifecycle checkpoint is AES-GCM encrypted on Pinata with an allowlist of room ID,
host wallet, expiry, ended time and wallets removed from that session (legacy rooms may also hold a
guest wallet or booking ID); no media, tokens, signatures or credentials are
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

The right-side stack is Archive, creator-only Studio, eligible-host DHearse and an
image-based BigNuten placeholder. Its tabs mirror the left-side tabs: 44px wide,
6px outer corners, aligned stack tops and the same compact mobile sizing.
If the DHearse access check fails, the tab itself retries the check and opens
the room on success. A confirmed ineligible wallet does not see the tab.
The same rehearsal client runs in the side panel
using the header signer, and in a popout. Closing/switching waits for microphone
shutdown acknowledgement; moving to a popout stops embedded audio first and passes
only the private invitation. During that handoff the previous idle pass is retained
for at most five minutes so the room does not close before the new page signs in.
If audio shutdown succeeds but server sign-out cannot be confirmed, the panel
closes with an explicit warning about that five-minute idle expiry, not a false
claim that the server session ended.
Wallet changes stop/unload the embedded room. Studio draft-flush failure blocks a
panel switch; slow/failed room shutdown keeps the rehearsal visible for retry.
Opening embedded DHearse mutes this tab's main radio, without automatically unmuting
it on exit; booth confirmation still covers every other tab/device.

Reuse: adapt this repository's `rehearsal.js`, `rehearsal-store.js`, `rehearsal.mjs`
and editor/Archive drawers at `e092966`; no second audio transport is introduced.
BigNuten is only an honest placeholder, with no health data, storage or sync.
Its unmodified `img/BigNuten.png` comes from `BigNuten_Vanilla` image commit
`4e48373`; the donor's `d2e0d4e` NOTICE specifies **CC BY 4.0 for artwork**
(Apache-2.0 covers code). The artwork license and NOTICE are shipped beside the
image and the placeholder visibly credits The Jolly LaMa / A Decent Agency.
Local tests cover isolated invitations, historic eligibility, per-room privileges,
shutdown acknowledgements and popout transfer. These are not a real band rehearsal.

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

**#358 policy:** an unfinished live set gets **15 seconds** to recover
verified delivered audio, unless the producer explicitly grants extra time. At
the authorized deadline it follows the existing irreversible cancellation path.
An unarmed automatic slot retains its separate **60-second initial-arm
allowance**, independent of `LIVE_AUDIO_GRACE_MS`. A durable,
observed loss deadline survives restart **without an extra rejoin extension**.
A previously healthy checkpoint is not proof of when packets stopped during an
unobserved process gap: the existing bounded receiver probe and new observed
grace still apply in that case, without claiming ON-AIR. Watchdog/checkpoint
latency can delay the visible terminal transition; measure this on actual hosting.

### Producer recovery (#358)

The production desk and full operator room share the existing signed,
booking-scoped stage controls:

- **Grant explicit recovery hold:** choose additional seconds, at most **60
  seconds cumulative for the entire set**, across all outages. The server stores
  the used budget and absolute deadline; retries, reconnect, refresh, successful
  recovery and worker restore cannot reset them. No client deadline is accepted.
  A hold cannot exceed the existing authorized set end, move contracts, change
  guaranteed pay, or become an encore. A durable finished declaration still
  follows the existing normal ending rather than a hold.
- **Run commercials now / Run radio now:** switch immediately at the existing
  safe program boundary while the original set remains recoverable until its
  unchanged deadline. Existing public listener seats are removed; the performer,
  independent health receiver and private producer remain. A reconnecting
  performer stays private while filler runs. No filler is artist attendance,
  soundcheck, performance, recording or completion evidence.
- **Return recovered performer safely:** explicitly confirm after fresh actual
  receiver audio and the performer's fresh readiness/presence. It uses the same
  handoff guard as producer take/end, additionally waiting for a currently
  playing advert. It cannot interrupt active paid work or resurrect a terminal
  set. No automatic overtime is granted while a handoff is busy.
- **Open paired next act / Check paired next-act readiness:** reuse the exact
  next booking's owner pass, existing invitation/status and private direction
  thread. The roster also opens unpaired upcoming bookings. Messages are sent
  only by the existing explicit private-message action; opening a room is not
  delivery. No-next, unknown/not-ready, stale/expired and denied access stay
  visible. No external messaging service is added.
- **Advance paired ready next act:** an explicit, irrevocable interruption of
  the current recovering set and atomic take of its paired next booking. It
  requires both owner scopes, actual performer readiness/presence, chosen set,
  real checks, fresh audio, funding/acknowledgment, no third-booking conflict and
  the safe paid/advert boundary. This action alone can take the next act before
  its original start; ordinary take cannot. It does not change escrow terms or
  auto-start a merely scheduled/standby act.

Recording consent is unchanged. Filler stops/flushes artist capture and marks
the genuine interruption; returning captures only genuine performer audio.
Early advancement does **not** broaden existing v1/v2 recording permission:
pre-contract audio is excluded, and any resulting early-start recording is
partial. Publication still needs the existing performer release approval.

**Reader and mirror compatibility / deployment blocker:**

1. Deploy compatible readers first with recovery writes disabled
   (`LIVE_AUDIO_RECOVERY_ENABLED` unset/false) and explicitly retain
   `LIVE_AUDIO_GRACE_MS=60000` for this reader-only phase. The code defaults to
   15000 even when recovery writes are disabled: omitting this override would
   activate the shorter lost-audio watchdog before producer controls are enabled.
   The temporary 60000 value is a rollout safeguard, not the final #358 policy.
   Old version-1 rooms without `recovery` restore unchanged. Optional `recovery` has only
   validated `revision`, `usedMs` (0–60000), `graceMs`, `deadline` and `filler`.
   It shares the existing bounded broadcast command receipts. Tokens, messages,
   ingress and financial records are not added to this journal.
2. The encrypted envelope/AAD/name/tags and room-state version remain unchanged.
   The older strict decrypted room allowlist **rejects** the new optional field.
   After enabling writes, rollback must retain a compatible reader; never delete
   recovery facts or restore an older checkpoint to make rollback work.
3. Explicitly checked repository `checkpoint-mirror-client.js`: its allowlist
   rejects **both existing and new encrypted live-audio envelopes**, before any
   Kubo import. The running mirror's source and current hosted-mode configuration
   were not inspected; this is source-contract evidence, not deployment evidence.
   Retain an already approved `LIVE_AUDIO_CHECKPOINT_MODE=hosted-verified`
   lifecycle configuration (latest encrypted CID/content readback), or obtain a
   separately approved reader-first mirror upgrade before using mirrored mode.
   Other financial/paid journals keep all existing mirror requirements.
4. Only after reader/restore verification, compatible producer controls and
   separate deployment approval, activate both settings together:
   `LIVE_AUDIO_GRACE_MS=15000` and `LIVE_AUDIO_RECOVERY_ENABLED=true`.
   Existing recording-frame-time reader-first rollout remains separate.
   `radio-predeploy.js` protects playback/recording drain boundaries; it does not
   verify compatible readers or replace these reader-first checks.

Do not bypass `node radio-predeploy.js`. Release and activation evidence belongs
in #358; the local checks below are not real musician, provider-stream, message,
payment, consent or recording tests. Under the owner's Friday sprint workflow,
close delivered implementations after verified rollout, then file new issues
for failures actually observed during the next live rehearsal. Closure is not
a claim that an unperformed live check passed.

Reuse decision: adapt the already integrated `planBroadcastCommand`,
`createLiveDirection`, `withBroadcastHandoff`, `endAllocation`/`cancel`, and
recorder interruption/consent boundaries; do not create a second session system.
The receiving source is local integrated base `e440a1d`; its inherited
`discord-bot/live-audio.js:tickInternal` quiet-ending foundation and
`test/night-simulation.test.js:night` are from `d9302ff`. Earlier invitation
readiness work at `ff4534e` was inspected, not copied over current guaranteed
booking/authorization policy. All are the same Apache-2.0 repository; no external
auth, storage, chain, payment or messaging runtime is introduced.
The receiving tests include `test/live-recovery.test.js` and the three
`recovery rehearsal` cases in `test/night-simulation.test.js`. The latter use
real radio/recorder modules on a fake clock, not staging. The existing older
night cases expect automatic recording intake; that expectation also fails on
untouched local base `e440a1d` and is not repaired as part of this policy change.

Local validation for this patch: **349/349** focused/audio/stage/recording/
producer/booking/mirror/paid-boundary regressions passed. The supplemental
paid-queue/escrow/editor selection passed **138/140**; its two DJuke source-wiring
assertions also fail unchanged on `e440a1d`. The complete night selection passed
the **three new recovery cases**, with the **14 existing automatic-intake
expectations failing identically** on both branches (untouched base: 0/14).
Four new acceptance cases were also run against unchanged base code and all
failed there, demonstrating the new coverage is not baseline-green. Separate
codec checks verified both directions of old-room envelope compatibility and
the old decrypted reader's rejection of the new recovery field. These are local,
mocked-provider checks, not a live staging rehearsal.

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
- Keep intentional silence for over sixty seconds: **no cancellation**. For #358, test outages just below and exactly at 15 seconds; hold explicitly, reconnect within the authorized window, and expire an unrecovered hold once. Test both immediate filler choices, safe return behind a paid song/advert, repeated requests/reconnect/restart preserving the one-minute cap, and actual ready/not-ready next-act advance. Real staging checks are **NOT RUN**.
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
