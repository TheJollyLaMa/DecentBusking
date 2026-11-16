# Live Performance — operator runbook

## Production desk: live-session coordination

The Admin booking card's **Open production desk** link opens
`producer-room.html?booking=…`. Its roster is the public booking schedule, **not**
a private access grant. Select a booking and sign with the existing configured
owner wallet. Each selected room needs its own pass; unexpired passes stay only
in that tab's memory and clear on wallet change, expiry or page exit. No new
engineer/staff role is enabled.

The desk separates the canonical public radio act from the selected private
room. It never automatically plays public radio or opens the operator microphone.
Selecting/listening never changes the program; only explicit server-enabled
allocated-stage commands can do so. **Listen to selected room** disconnects the old private subscription
before opening the next. Mute public radio in other tabs/devices; use headphones.
Use **Open full soundcheck room** for the existing actual check/arm workflow.
Private practice remains separately authorized in its existing rehearsal room.

Owner and performer share one booking-private text thread using their existing
backstage passes. The owner can cue **another song** or **wrap up after this
song**, and notify the next performer of a possible delay or standby. The
performer can acknowledge a cue, report ready/not ready, notify the owner that
they are not playing, and declare their set
finished. Acknowledgment is not musical completion, schedule-change consent,
payment approval or an instruction to cut the feed. Standby acknowledgment is
optional and does not gate owner notifications. **Not playing this slot** first
marks the performer not ready, then sends a private notice; neither action
cancels the booking or waives the original guaranteed fee. If either save fails,
the panel shows the failure rather than claiming both succeeded.

Messages, cues, readiness and presence are memory-only, bounded live-session
state. The panel displays server-reported retention and expiry. A worker restart,
booking end/cancellation or session expiry clears access/history; reconnect and
confirm readiness after a reset. There is no saved transcript or offline delivery.
Do not put secrets in the thread. Lost responses are not automatically resent:
**Retry same action** reuses the command ID in the same session epoch; after a
reset, review current state instead. Presence only reflects performer heartbeats,
not audio delivery. A stale direction service disables sending without stopping
the performer's microphone.

The **advisory direction card** never extends airtime, cuts the broadcast or takes
an act live. Use the separate allocated-stage controls below, only when the worker
returns their capabilities. [#343](https://github.com/TheJollyLaMa/DecentBusking/issues/343)
still needs the integrated two-act/device rehearsal and release verification;
an “another song” cue alone is never permission to play past the authorized end.
Original contract times and guaranteed fees remain unchanged.

### Anonymous listener feedback and verified tip notices (#341)

With the matching site and worker versions, a guest can send applause, love,
encore or **Can't hear** from the radio footer during the currently verified,
armed live set. No wallet, sign-in or free-text message is required. Controls
disable when the live state is stale or unavailable, and disappear in archive
mode or after the effective set ends. Signals are advisory: an encore request
never extends airtime, and a report never cancels a show or changes payment.

The performer room and the owner-authorized production desk show anonymous
counts for the last 30 seconds and two minutes, plus browser counts and an
audio-problem warning. A browser is not a verified person; refreshes, shared
networks, dropped requests and limits can affect the count. An empty report is
**not proof that listeners can hear**: independently listen to the public
return. If the private pass, booking verification or feedback service goes
stale, the panel says so and does not change microphone, monitoring or
broadcast controls. The performer can turn off the small floating reactions
and tip notices beside the publish controls; the detailed panel follows the
audio controls. The visual strip cannot intercept input, and reduced-motion
settings show static notices. The owner desk receives counts without a public
overlay. Longer amounts that cannot fit in the compact notice are replaced
with “Tip received”; the detailed panel shows the exact latest confirmed tip
and verified set total.

Tip notices and the set's ETH total come from the separate native-tip ledger,
not the browser's payment assertion. Only successfully confirmed, canonical
Base router events with verified source, exact booking and performer recipient,
and a timestamp inside the effective live window qualify. Self-tips, pending,
reverted, mismatched and old direct transfers are not shown as verified.
The ledger may lag or be unavailable while indexing, rebuilding after a reorg,
or verifying a source; **so far** means the total may be incomplete. A room's
first snapshot establishes a baseline rather than replaying older notices;
only up to 20 recent tip entries are used for notifications. These are brief
“tip received” notices, not listener-authored notes. Existing tip routing and
the guaranteed performer fee are unchanged.

Signals and their per-browser/network rate-limit identifiers are held only in
worker memory, with no identity opt-in, durable transcript, IPFS checkpoint or
Discord publication. The display has no wallet or network addresses. Recent
events expire after 10 seconds, counts cover at most two minutes, and idle
hashed browser records expire after 130 seconds with a cleanup sweep at most
10 seconds later. The latest anonymous signal time remains for the current set.
All set-specific feedback is cleared when that set ends, changes, is cancelled
or the worker restarts; rate-limit records may remain briefly to enforce limits.
Defaults are two seconds between signals and 12 per browser/minute, 60 per
network/minute and 600 globally/minute. Shared networks and IPv6 /64 grouping
can limit several listeners together.

Before any release, confirm the actual trusted reverse-proxy topology and set
`LIVE_FEEDBACK_TRUSTED_PROXY_HOPS` accordingly; see the
[worker configuration](../discord-bot/README.md#anonymous-live-audience-feedback).
Never merge or deploy during a live show without the separate owner approval and
safe handoff. Local tests and a mocked browser are not a real performer or
live-tip test. Keep #341 open until a guest and authorized performer/operator
exercise the flow in a real show, including a real verified tip and public-audio
check.

### Explicit allocated-stage controls

1. Authorize the current booking with the existing owner wallet, then **Enable
   allocated-stage control**. This can adopt a currently live contracted set.
   Unallocated bookings retain their legacy automatic scheduling.
2. In the desk, select the exact next act and **Reserve and notify selected next
   act**. The owner must separately authorize that next booking; the current
   room's pass cannot grant access to it. This slice coordinates the current and
   selected next act only, not an all-night schedule or third-booking cascade.
   Bump notices do not require the artist's acknowledgment or consent, but the
   delayed artist chooses **decline**, a positive short duration no longer than
   the contract, or the full contracted length from the actual delayed start.
   All choices retain the original guarantee.
3. Real checks use the effective planned start; existing passed checks remain
   real checks, not retroactive credit. Both checks, fresh delivered audio,
   performer choice/readiness and the owner's explicit take are required.
   Arming an allocated stage confirms readiness; it is not an automatic take.
4. **Authorize additional encore** records extra minutes, capped cumulatively
   at ten per allocated set. If a next act is paired, its separate owner pass is
   required again before a bump. Read the server-confirmed effective times; the
   immutable original start/end and financial terms are shown separately.
5. The performer's **My allocated set is finished** is the durable declaration
   required for a normal producer ending. An advisory finished note is not a
   substitute. **Force cut** is explicitly interrupted, never a successful
   curtain call. The owner may **Take this selected act live** only after the
   predecessor has ended and the backend verifies checks, timing, choice,
   readiness, audio and protected-paid-program boundaries.
6. Existing passes retain their original expiration. Use **Refresh allocated
   booking pass · keep microphone on** for the new bounded access window;
   this does not stop or republish the microphone. Stale/failed commands disable
   controls and never claim success. An uncertain durable result can be retried
   with the same command ID rather than submitting another extension.
   After the original end, Profile checks pending/unknown allocations against a
   fresh exact-booking public audio snapshot before offering **Return to allocated
   backstage**. This also works when the original fee is already approved/paid.
   The link does not grant access or prove public playback; authorize the booked
   wallet in the room, and do not open a second publishing microphone. A failed,
   stale, expired or mismatched lookup offers a status refresh instead of claiming
   the set finished. Original contract times, receipts and claim rights stay separate.
7. Admin's actual-stage completion is separate from fee approval/claim. A
   pending or unknown allocated completion blocks new review/release workflows,
   not truthful reconciliation of an already-submitted transaction. The
   original guarantee, on-chain review window and claim deadline remain
   unchanged. A priority invitation flag is follow-up only—not an automatically
   accepted, funded or scheduled booking.
8. **Quiet endings (#343).** Ask the performer to keep the microphone on until the
   producer ends the set. If a set the performer declared finished goes quiet and
   nobody ends it, the server closes it after about a minute as the normal
   producer-finished ending, timed at the later of the declaration and the last
   audio. That is never an audio-loss cancellation, so no fault slate or
   recovery-ads window runs. If the producer's **End** lands more than five
   seconds after the audio stopped, the recording is flagged incomplete and its
   radio title gains "(partial recording)", because the recorder compares captured
   seconds with the set's actual window. An approved encore withdraws the finished
   declaration, so a silent room is again treated as an audio fault. Evidence:
   `node --test test/night-simulation.test.js` replays a two-act night on a fake
   clock; it is a simulation of this server's state machine, not a live-audio test.

Backstage/monitoring/consent/fee regressions (the original 102-test selection,
now including Profile re-entry cases):

```bash
node --test test/{live-broadcast-controls,live-direction-ui,private-room-listener,producer-room,performer-room,input-monitor,live-publisher-presence,live-audio-wiring,live-recording-option,live-recording-room,live-recording-consent,live-escrow-release}.test.js
```

The reproducible **Profile-only** browser harness is
`test/browser/live-profile-reentry.html`. Serve the repository locally and use
**Run browser checks** at 390px and 1280px. Its nine mocked cases cover waiting,
live, approved/paid, stale/offline/expired/mismatched state and forced ending;
it neither connects a wallet nor publishes audio or proves a real live show.
Earlier inline room/producer browser checks did not persist a reusable harness.

New recording opt-ins explicitly sign **permission v2** for this booking's
authorized on-air set, including an authorized delayed start, the artist's chosen
short/full set and at most ten minutes of producer-approved encore. This
permission neither grants extra airtime nor changes the original fee/terms.
Private practice and soundchecks remain excluded. Existing checked v1 permission
still covers **only the original scheduled set**. Its visible **Update recording
permission for delay / encore** action requires a fresh performer signature and
an explicit v2 server confirmation. Declined, unavailable or legacy-only responses
never widen the previous permission. Published IPFS audio cannot be recalled.

Reuse: the desk and shared direction card adapt this repository's
`live-audio-room.mjs` listener/action patterns, `roomRequest`, booking links and
`live-audio.css` at `0cae70d` (monitoring PR #354). Canopy's curated offers/needs
did not identify a directly suitable production-chat donor in the scoped review;
no external/private source was copied. The local mono monitor and public
self-return protection are unchanged. Validate two isolated booking threads,
wallet changes, stale/offline state and room switching before a live rehearsal.

## Attributed native ETH tips (#355; release gate)

The feature branch routes live, radio-recording and archive-recording tips through
the dedicated DecentBusking tip contract **only when configured**. It forwards
100% of the tip to the selected artist; wallet gas is additional. This is not the
USDC payroll router, a supporter gift, custody, or a new fee. Until enabled, the
hat explicitly labels the existing direct-transfer route as having no on-chain
DecentBusking attribution. A broken configured route never falls back to it.

The `TipSent` event binds sender, recipient, exact native wei, source kind and
context. Canonical references are `decentbusking:live:<bookingId>` and
`decentbusking:radio:<chain>:<collection>:<tokenId>` (or `archive` instead of
`radio`). Source kinds are 0/1/2 respectively. The contract route proves use of
the protocol, **not which browser page was open or that a performance happened**.
Caller labels alone never establish verified artist/source earnings.

The separate `/api/tips/ledger?wallet=<address>&offset=0&limit=25` read API verifies
successful receipts, two Base confirmations, canonical blocks and exact events.
Event identity includes chain, contract, transaction and log index; repeated tips
are not deduplicated by show or recording. Live recipients are checked against
`bookings(keccak256(bookingId))` at the receipt block. Recording identity, existence
and tip wallet are checked using the allowlisted NFT's URI/metadata at that block,
not today's owner or a caller-selected wallet. Unavailable or mismatched source
proof stays explicitly unverified, separate from attributed totals. Self-transfers
are not counted as earnings. The Profile's collapsed **Native ETH tips** section
shows precise ETH amounts and transaction/log proofs without changing USDC totals.

Release order, with separate operator approval:

1. Review/test/deploy and verify the immutable Base tip contract; record its
   address and exact deployment block. **Done 2026-11-14, separately from this app
   change:** `0xAa0207731e9F836273634F7B08cE87FfAA125183`, deployment block
   `57465793`, source verified on BaseScan (exact match); details are in the
   DecentMarket `DEPLOYMENTS.md`. No deployment is performed by this change.
2. Set worker `TIP_ROUTER_ADDRESS` and `TIP_START_BLOCK`, retaining the existing
   `LIVE_PERFORMANCE_ESCROW_ADDRESS` and configured NFT collections. The indexer
   checks code at the deployment block and the preceding block so it cannot silently
   start after early tips. Historical state reads must work on the selected RPC.
   Do this early: the ledger must read every block since deployment (about 432,000
   a day) before it is caught up. A poll reads up to 20,000 blocks (measured on
   2026-11-14: the first 19,600 blocks took 5 seconds on public endpoints only), so
   each day of delay adds minutes, not hours.
3. Verify the ledger is ready, caught up and not restoring proof entries.
   IPFS checkpoints use `decentbusking-tip-ledger.json`; chain replay from deployment
   remains the recovery source. Reorganizations invalidate/rebuild the affected
   ledger. RPC/source/checkpoint errors remain visible, never fake zero earnings.
   **Rehearsed 2026-11-14** with three real tips on Base (0.000012 ETH in total,
   from the deployer to the admin wallet): radio #12 and archive #11 verified, a
   tip labelled as an invented live show refused, and the real ledger ready and
   caught up about 7 seconds after start on public endpoints only. Transactions
   and numbers are in DecentMarket `DEPLOYMENTS.md` and issue #355. Still unproven:
   a real live-show tip to a booked performer, the site's tip button, the
   interrupted-tip recheck, and the render worker's own settings and RPC.
4. Only then set public `tipRouterAddress` and refresh the frontend cache version.
   Rehearse a live tip, radio tip, archive tip and interrupted confirmation.
   Once submitted, **Recheck tip** reads that transaction; it does not send again.
   This local pending state does not survive a page reload: check the wallet or
   ledger before making another payment after reloading.

Old direct transfers cannot acquire these events retroactively. Wallet/explorer
activity may still display internal ETH transfers; inspect the branded contract
event or the app ledger for context. The private performer notice above does not
accept a browser's success assertion; public audience-wide tip celebrations
remain a separate integration.

Reuse decision: adapt ArtFi's `ArtFiSettlementRouter.sol` native-forward/reference
event pattern at `843e770fafb9ca701e35c8d4f509cd005f32b77d`, not its custody,
payroll roles, allowlist or once-per-work-reference restriction. The app reuses
`nftIdentity`, the shared escrow ABI, RPC router and checkpoint mechanisms, and
adapts `payment-ledger.js` receipt/canonicality checks at
`a256c8e31dd524ac1cba32e966c844d0cac79b46` into a separate native-tip ledger.
Acceptance tests are `tip-protocol`, `tip-ledger`, `tip-ledger-ui`, `stage-tip`
and `live-tip-target`; mocked browser checks do not certify production deployment.

## Friday November 13 website-radio rehearsal

The approved sequence for `friday-live-performance:2026-11-13:withinthevacuum`
is below, all New York time (UTC is November 14):

| Time | Website radio |
| --- | --- |
| 20:00 / 20:45 | Private T-60 / T-15 soundchecks; owner listens and marks each actual check |
| 20:58–21:00 / 01:58–02:00 UTC | End remaining Top10 audio; eligible DVert advert lead-in |
| 21:00–21:20 / 02:00–02:20 UTC | Same wallet-linked room becomes public **only after both checks and operator arm** |
| 21:20–21:25 / 02:20–02:25 UTC | Close live admission/audio; eligible DVert outro |
| 21:25 / 02:25 UTC | Regular radio; queued paid songs remain eligible, without a second unbooked-live advert break |

Set `LIVE_AUDIO_PROGRAMS` to
`{"friday-live-performance:2026-11-13:withinthevacuum":{"leadInSeconds":120,"outroSeconds":300}}`.
Leave OBS off. There is no Discord live-audio relay.
The accepted guaranteed-fee booking does not itself grant recording rights.
Recording is separately opt-in: the performer must consciously check
**Record this and play on the radio?** in backstage and confirm the wallet
permission. Unchecked, declined or failed permission means no recording.
The small **i** explains scheduled-set capture, public music/DNFT publication
and radio replay, required music rights, and unchanged guaranteed pay.
Never sign this permission for the performer or infer it from a soundcheck.

For a consented set, recording uses the existing independent audio receiver;
private practice and soundchecks are excluded. After the set, the finalized
audio is submitted to the existing admin mint queue with the actual performer
wallet. An admin still reviews and signs the real mint during the afterparty.
Only a genuinely minted, permitted recording can replay, at a safe normal-radio
boundary after the scheduled outro. A paid playlist or another protected show
is not interrupted. Processing, upload or persistence errors remain visible:
an unfinished recording is not a successfully submitted NFT.
Set `LIVE_AUDIO_RECORDING_ENABLED=true` for the worker and confirm the unchecked
option appears for the actual performer wallet. Segment uploads begin during
the public set, not just at its end. A worker crash can lose up to the current
30-second unpinned segment; interrupted or short results are marked partial in
the mint queue. Review that title and listen before signing the mint. Processing
errors are logged under `[live-recording]` and retried; do not re-submit a duplicate
or bypass the deployment handoff while finalization is pending.

Tonight's audience target is 90 public live listeners. Main-radio browsers
currently join LiveKit for live audio even when they never open this room.
LiveKit Free Build documents 100 total concurrent participants across the
project, with separate usage allowances; this is not unlimited listener
capacity. Reserved performer/operator/receiver seats and other rooms count.
The [published participant pricing](https://livekit.com/pricing#participants)
lists 5,000 WebRTC minutes and 50 GB downstream per month for Free Build.
90 listeners for a 20-minute set consume about 1,800 listener-minutes before
backstage, operator, receiver or other project usage. Check remaining allowance,
not just the headline monthly allocation; free-plan exhaustion denies new use.
Regular recorded radio uses hosted media, not LiveKit participant slots.
HTTP/HLS public fan-out is tracked separately in
[#331](https://github.com/TheJollyLaMa/DecentBusking/issues/331).
Eligible adverts only: if none are available, report waiting, never play a song
inside these breaks or fabricate delivery/impressions. Existing cancellation
behavior is separate: a quiet fault slate, recovery adverts, then radio.
A disconnected microphone is not a successful early finish; the existing
60-second verified-delivery grace applies. The planned successful end is 21:20.

The Top10 animated stage stays mounted through lead-in, actual live audio and
outro. The live announcement requires fresh independent receiver evidence,
not the clock. It links to the existing public creator profile (songs/albums)
and shows the actual performer wallet with a Base explorer link; no invented
artist biography, catalog, alternative tipping address or external links.

Before Friday: verify accepted terms and actual escrow funding, hosted verified
media checkpoint configuration, the deployed frontend/worker revisions, and
eligible advert inventory. At 19:50 the practice iframe gives way to booked
backstage: reconnect with a fresh wallet pass. Complete both real checks and
arm while delivered audio is fresh, before 21:00. Test from a separate website
listener with playback enabled; an autoplay-blocked browser needs a click.
Backstage separates performer publishing from operator listening. The operator
sees three large clearance cards: first check, final check, scheduled handoff.
Saving shows progress (up to 60 seconds); green **PASSED · saved** / **ARMED**
cards confirm durable success. Errors remain visible instead of disappearing
on the next status poll. Public booking refreshes cannot erase private check
display. The next-step banner gives the next check's New York time.
Self-monitoring is directly visible in the performer's headphone controls;
it requires publishing first and is not how the operator hears the artist.
Use **Choose / list audio outputs**, then select the interface/headphones
output. This routes browser self-monitoring and room listening, not the mic
input or public broadcast. Practice has the same controls. Supported browsers
use output permission/selection and `setSinkId`; otherwise the panel explicitly
directs the artist to system sound output settings. If no outputs are exposed,
allow microphone access/list inputs first. Output selection is retained while
restarting the monitor in the same tab, not across page reloads.
**Headphone mix** has explicit Stereo and Centered mono choices in both rooms.
Stereo remains the default; Centered mono averages a two-channel input into
both ears without summing it at double gain, and leaves mono input at its
existing level. It changes only browser monitoring, never the published track
or recording. The choice survives monitor stop/start in the same page.
This cannot center an interface's own direct-monitor output.

**Booth rule (required in both rooms).** A performer hears themselves locally,
never through the radio. Before the mic can start, both rooms show a **Booth
setup** card: headphones into the audio interface, interface direct monitor on,
effects in the interface or mixer before the browser (so the radio hears them),
and the radio off on every other tab, phone and speaker. The performer must
choose how they will hear themselves and confirm the radio is off; Publish /
Start my microphone stays disabled until both are set.

Only two setups are allowed on air, and the backstage room offers only these:
**Headphones in my interface · direct monitor on** (recommended) or **No
headphones · unplugged**. Both keep **Hear my input** off, and the backstage
room locks it. The private practice room also offers **Browser monitor ·
delayed, practice only** so performers can experiment; only that choice enables
Hear my input, and switching away stops browser monitoring without stopping the
mic. Choices are kept for that tab only, so a reload mid-show does not block
reconnecting. The choice is a self-declaration: it is not sent to the server and
the operator cannot see it, so confirm it out loud.

**Operator booth check, before T−60** (also shown in the operator card and the
production desk):
1. Ask which setup they chose: headphones in the interface with direct monitor
   on, or unplugged with no headphones. Anything else is not ready for air.
2. Hear my input is off. The backstage room locks it for shows.
3. No radio is playing on any device near them (or near your mic).
4. Listen for doubled or echoing sound. If you hear it, stop and fix the booth
   before passing the check. Radio delay of several seconds is expected and fine;
   delay in the performer's own headphones is not.

Choose one monitoring path: direct interface monitoring with **Hear my input**
off, or browser monitoring with headphones and interface direct monitoring off.
Browser monitoring requests interactive latency and reports the browser's
output estimate when available; this excludes input/capture delay and is not
a measured round trip. Turning it off does not stop the published microphone.
The public radio is a delayed return, not a performance monitor. When browser
publishing starts, backstage advertises a short-lived local notice containing
only the booking ID and expiry, scoped to that worker. The main site radio in
the same origin/browser suppresses that booking's public live feed, with an
explicit **Your return is muted** message; the artist's publishing connection
and other listeners are unchanged. Stop/disconnect releases the notice; a
crashed tab expires after 90 seconds without renewal.
Keep the publishing tab awake; prolonged browser suspension can expire that
local notice. This is not proof that every other playback device is muted.
This does not reach other devices, different browser profiles, Discord voice,
or cross-origin embeds. Mute those returns manually. If browser storage is
blocked, the room and radio explicitly warn that automatic protection is
unavailable. The notice is a local UX aid, not authentication or a server lock.
For #340, compare direct-only, browser-only and off on the actual interface;
record the device, browser, output route and whether the symptom is delay,
doubling, feedback, distortion or missing sound. Do not declare hardware
performance readiness from layout tests or the browser's latency estimate.
The operator can use speakers with their microphone off and ordinary radio
muted, provided another nearby/voice-call microphone cannot feed them back.
UI reuse: adapt the existing private rehearsal's primary buttons, input meter,
and collapsible help from `rehearsal.html` and `css/live-audio.css`; reuse
`bindInputMonitor` and preserve the existing wallet/control protocol. No new
service or shared extraction. Operator/performer browser fixtures cover mobile
and desktop layout, save progress/errors, and durable completion display.
Reconfirm the artist's headphone/interface setup with them; synthetic test
audio cannot establish their hardware, latency or performance readiness.
After the original end, record the truthful result and approve the guaranteed
full fee; incremental rehearsal scoring is **not** incremental on-chain pay.
For guaranteed phase1 bookings, Admin → Live Performance now offers one primary
**Release full $20.00 from escrow** action after the booked end. It pins a
minimal full-fee report using the existing owner-authorized IPFS uploader,
checks the exact on-chain booking/terms and Base review window, simulates the
approval, then asks the owner to sign the approval transaction. It does not
require manual report URIs or a rehearsal score/off-chain decision first.
Contract approval is the canonical decision; the existing event scanner
indexes it. The artist still claims from Profile: approval is not payment
received. Pending approval hashes persist and retries reconcile before sending;
upload and transaction failures remain visible in the booking card.
Legacy/prorated and manual review tools remain under advanced booking actions.
The performer's post-show **Your next step** card is above the collapsed
earnings section, not buried inside it. Waiting for owner approval, ready to
claim, pending and confirmed-paid states are distinct. A prominent claim button
appears only when eligible (or to reconcile a saved pending hash); agreement
and receipt details stay collapsed. Payment cards load independently of the
earnings RPC and update from existing booking notifications without replacing
an in-progress claim. A manual payment-status refresh is also available.
Reuse: existing `createBrowserIpfsUploader`, `LIVE_ESCROW_ABI`, transaction
hash storage convention and event indexer; no contract or worker deployment.

Reuse: adapt this repository's `liveAudioPolicy`, JukeLoop `live_audio_ads`
selection, `mountTopTenFestival`, `open-creator-profile`, and the private
rehearsal store's encrypted latest-readback pattern. No new donor service,
recording, rights grant, Discord relay or shared-package extraction.
Receiving tests cover exact boundaries, deferred paid songs, no-ad waiting,
stage continuity/profile dispatch, checkpoint failure and isolated real LiveKit
publisher → native PCM/RTP proof → public browser listener, loss/reconnect and
booked-end admission closure. The isolated test uses generated fixture wallets,
never the artist's signature or the real booking's Friday soundcheck state.

Refs #210, Refs #223. **Booking/payment prototype build complete; live rehearsal still required.**

**This runbook does not authorize escrow deposits, payouts, refunds, invitations or schedule changes.** Use a newly agreed future date and performer, not the expired October 23 offer. Do not run a second bot from a development worktree against production secrets.

## Guaranteed audio pilot (application policy; not a new deployed contract)

Select **Audio pilot: guaranteed $20, rehearsal ladder only** when preparing
this new kind of invitation. Legacy v1/v2 bookings and signed text are unchanged.
The [pilot terms draft](./LIVE_PERFORMANCE_PILOT_TERMS_V1.json) needs joint review,
an immutable pin and a verified hash before approval/signing. Selecting the pilot
clears the incompatible v2 pin and unchecked approval; there is no automatic pin,
public invitation, calendar write, deposit, task payment or token transfer.

- Use the agreed future start and 11-59 minute duration. Check the actual Friday
  Hype schedule, not just the form's 9 p.m. New York default.
- Private soundchecks are T-60 and T-15. Both gate broadcast, not this pilot's pay.
- The fee is guaranteed regardless of technical outcome. Rehearsal alone scores
  10% at a qualified verified start, then nine 10% increments every one twelfth
  of the booked duration. For 20 minutes: $2 at start, then $2 every 100 verified
  seconds; $18 at 13:20 and $20 at 15:00. Zero start scores zero, not zero pay.
- Record whole verified seconds and the truthful start result after booked end.
  The server calculates the rehearsal score separately and requires a full-fee
  decision. This is neither automatic audio measurement nor on-chain vesting.
- Cancel only the schedule/broadcast if necessary. Keep escrow funded and
  approve 100% after the **original booked end**, even for a cancelled show.
  The pilot UI does not offer a financial-cancellation transaction. Direct
  contract actions, pause, auto-claim and expiry still operate: any shortfall
  against the guarantee is a separately owed steward payment, not invented
  escrow income. Approval must precede the 24-hour review cutoff; afterwards
  reconcile the performer's automatic full-fee claim.
- Companion offers are optional public text in the signed invitation. Describe
  prep payments and gifts with exact conditions and say they are **outside**
  this USDC escrow. Track/pay them separately with their own receipts. Never
  describe the token's list price as guaranteed cash value.
- No recording/archive/video rights are silently inherited from legacy v2.

The revised first-pilot companion gift is conditional: all four prep tasks,
both passed T-60/T-15 soundchecks and at least 75% verified slot coverage, with
steward review. Selecting the pilot policy prefills these conditions only in an
empty additional-offer draft; existing text and signatures are not rewritten.
Record and jointly review those exact conditions in the new signed additional offer;
do not edit an already signed invitation. This replaces the earlier unconditional
participation-gift proposal, not the guaranteed $20 cash fee. The gift remains
outside the USDC escrow. An admin approval or success animation is not an NFT
transfer; reconcile inventory and the actual transfer receipt separately.

### Recording gateway recovery

Recording segment downloads must place the CID in the URL path while
preserving a dedicated gateway's `pinataGatewayToken` query. Reuse
`buildGatewayUrl` through `downloadRecordingSegment`; string concatenation
after a token query produces a malformed request and can return HTTP 401.
Never forward the Pinata API JWT to a media gateway. Downloads reject
redirects, time out at 30 seconds, and enforce the 30-second PCM WAV size
limit while streaming. Persisted errors omit token-bearing URLs.

Recovery belongs to the canonical recorder: its preserved consent, ordered
segments, verified PCM, result checkpoint and mint intake remain authoritative.
Do not overwrite the recording journal or perform parallel ingestion from
a separate local recovery process. A read-only segment probe is not recovery
or mint/replay completion.

The existing production deployment gate blocks replacement while a consented
recording is recording/processing, including failed finalization. A repair to
that worker cannot be declared deployable just because paid queues are empty.
Resolve a verified durable recording handoff in a separately reviewed change
or obtain an explicit maintenance plan; do not bypass the strict gate, restart
the worker casually, revoke consent, or delete preserved segments to get past it.

An ended recording no longer blocks backend deployment. The durable handoff is
on by default (`LIVE_RECORDING_DURABLE_HANDOFF_ENABLED=false` restores the
legacy strict gate). The authenticated deployment lease pauses canonical
recording retries and live controls, verifies a fresh booking read and the
signed journal readback, and refuses active/armed or imminent shows,
missing/changed bookings, buffered audio, active producers/encoding and
unverifiable checkpoints. Cancellation or expiry resumes the recorder without
changing consent, segments or processing status. The paid playlist/ad drain
remains mandatory and independently gates readiness.
Download/encode/intake failures remain visible but are not treated as missing
captured frames; a successful retry clears the delivery error.

The replacement worker waits three minutes after startup before resuming a
`processing` recording, so a replaced worker still retrying during deploy
overlap cannot overwrite the new result. The finished recording then appears
in the Admin mint queue for the performer's wallet; it replays on radio after
the owner mints it.

The first show's recording was stuck behind the pre-fix worker, which could
not run this handoff. It was released by a one-time deploy that skipped the
pre-deploy check while the paid drain lease was held manually; that bootstrap
is not needed again.

### First-night supporter encore

After the first show the steward separately approved one existing v1.0.0
supporter dNFT (Base v0.2 collection, token 75) as a discretionary thank-you to
withinthevacuum. That booking's additional-offer field is blank: this is not
proof that the earlier conditional gift offer was signed or satisfied.

Profile includes **Your Decent encore**, a persistent, booking/wallet-scoped
presentation with the collectible's verified metadata artwork, front/back
control and an explicit Open action. It never requests a signature, purchases
an edition, mints a recording, or blocks the USDC claim. Opening it reuses the
existing non-blocking cosmic effect and respects reduced motion.

A read-only Base `balanceOf` at a confirmation block distinguishes currently
held, not held and unavailable. Holding is not proof of the sender, the gift
transfer receipt, or performance payment. Recheck with **Check gift in wallet**;
there is no new background timer. The dedication remains viewable even if the
token is later transferred away. Verify the treasury withdrawal receipt
separately before saying the gift was delivered.

Market's `DecentEscrow_v001.withdrawNFT` can send an ERC-1155 directly from the
treasury, but does not reserve editions by booking or reduce listing quantity.
Reconcile remaining listings after any withdrawal of listed stock. The
deployed `LivePerformanceEscrow` is USDC-only, has no ERC-1155 receiver or gift
mapping, and is not upgradeable. Never send the supporter NFT to that contract.
Booking-linked gift custody/release for next week is tracked in
[DecentMarket #78](https://github.com/TheJollyLaMa/DecentMarket/issues/78);
deployment needs explicit approval and must not strand earned cash claims.

Reuse decision: adapt the MIT-licensed Market contract's existing custody
semantics, not its buyer flow; use Busking's `getBaseReadProvider`,
`celebrateLiveInvitation` and Profile booking renderer for this read-only
showcase. Source inspected: Market `DecentEscrow_v001.sol` in the local
feature/pinner-allocation worktree and `LivePerformanceEscrow.sol` at
`094b4ac` (unrelated working changes left untouched). Metadata artwork is
the public token-75 URI `ipfs://QmZroFCEhaKoctVqW682Uzv5i6WWiQtuWvTAYkQBYfH6TD`,
not new commemorative art or a new mint. Canopy's agency map was consulted as
a lead; no speculative cross-repo extraction or public inventory update.

### Prep calendar and reuse

[DecentCalendar](https://thejollylama.github.io/DecentCalendar/) is a separate
small-value booking beta, not automatic wallet-to-availability discovery. Its
published timebox links (`?booking=<actual id>`) and recipient invitations require
real Base records; creating or copying a link sends no message and holds no seat.
For paid helper sessions, do not invert the money flow by charging the helper
an attendance fee. Agree the daily time first; use private local appointments or
an explicitly approved timebox and share only its actual generated link.

Inspected Calendar `a3b5c360e5e038536c902f1dbd4d4506d496afc2`,
`decent-calendar-vanilla/js/invitations.js` (`timeboxLink`, `calendarICS`) and
`booking-client.js`. Reuse the app's existing scheduling/export UX, not its
attendee-payment contract for performer wages. Canopy's inventory is only a lead.
Receiving-app booking reuse is `js/live-bookings.mjs`, the existing signed
booking service, Admin/Profile UI and action badges at Busking `5c1db30`.
Keep the DecentMarket escrow as deployed: no NFT custody or mid-show payments.
Focused booking/notification tests cover preserved legacy policies, all ten
rehearsal thresholds, guaranteed cancellation review and explicit funding state.
A real audio rehearsal and wallet acceptance/funding/claim are separate gates.

### Exact signed invitation handoff

The performer-facing guaranteed-pilot invitation is a compact, illustrated card
in Profile and Schedule, with the time, soundchecks and guaranteed fee on the
card. **Count me in** signs acceptance directly; there is no separate document
visit or checkbox step. Payment mechanics and the claim deadline are available
inline under **Payment & practical details**. Existing immutable agreement
bytes, signature authorization and funding gates are unchanged. The card does
not claim a deposit is escrow: only a confirmed funded booking gets that label
as escrow funded. An approved invitation also includes a private practice-room
link before acceptance/funding; that link grants no access or soundcheck credit.
Legacy offers and historical receipts retain their
existing detail view.

Reuse: the card adapts the existing `renderPerformerBookingInvite` and unchanged
`liveAcknowledgement` signature, using Busking's own DBusker portrait and theme.
The Secret Pyramid image is copied unchanged from DecentEscrow
`6b7958a6720ac8c335cad433db529c4d4b261dcd`, `img/SecretPyramid.png`, with its
MIT attribution in NOTICE. This is presentation reuse, not a Calendar payment
integration. Targeted receiving-app tests cover one-button acceptance, wrong
wallet/network, rejected signatures, storage failure, funded-room gating,
legacy offers and notification state.

After confirmed performer acceptance only, a silent 4.4-second Secret Pyramid,
twelve-sign zodiac, stars and twelve figure-like alchemical/planetary glyphs
(including 🜡 ☿ ♀︎ 🜐 🜑 ⚸) celebrate the saved invitation. It is
decorative, pointer-transparent and cleaned up on timeout or page exit; reduced
motion uses a still composition. It never indicates funding or payment.

The agreed Friday slot is November 13, 2026, 21:00–21:20 New York:
`2026-11-14T02:00:00.000Z`–`2026-11-14T02:20:00.000Z`. Checks are
20:00 and 20:45 New York. The wallet-linked room offers private practice until
T-70, then switches to the actual funded/accepted backstage. Early practice
does not create another funded show, pass Friday checks or require a token
purchase. See [wallet-linked practice](./LIVE_AUDIO_PILOT.md#wallet-linked-practice-before-show-day).

Use the deployed worker's `GET /api/live-bookings` revision and escrow address.
From the website's actual allowed origin, the owner signs `liveAuthorization(body)`
from `js/live-bookings.mjs` and appends the result as `body.signature`. Submit
`POST /api/live-bookings`, JSON with this shape (replace placeholders, not dates):

```js
{
  address: OWNER, origin: location.origin, issuedAt: new Date().toISOString(),
  command: {
    action: 'create', id: 'friday-live-performance:2026-11-13:' + crypto.randomUUID(),
    revision: currentState.revision,
    booking: {
      performer: '0x405Bb3Cdf23833bb27BAD6629b7cd4f01688235f',
      displayName: 'withinthevacuum', title: 'withinthevacuum — guaranteed audio pilot',
      eventId: 'friday-live-performance:2026-11-13',
      startUtc: '2026-11-14T02:00:00.000Z', endUtc: '2026-11-14T02:20:00.000Z',
      amountUnits: '20000000', airtimeMinutes: 20, mode: 'phase1',
      payoutPolicy: 'pilot-guaranteed-v1', termsVersion: 'LIVE PERFORMANCE PILOT v1',
      termsUri: REVIEWED_PIN, termsHash: VERIFIED_CONTENT_HASH, stewardApproved: true,
      additionalOffer: '',
      reviewWindow: 86400, cancellationWindow: 28800, killFeeBps: 10000,
      claimDeadline: '2026-11-18T02:20:00.000Z'
    }
  }
}
```

This invitation is **$20 USDC guaranteed only**: no four prep tasks, token
promise, Calendar dependency or purchase. Clear any companion-offer text
prefilled by an older form. The earlier companion proposal above does not apply.
Pin newly reviewed terms reflecting this scope; do not reuse an incompatible
agreement or alter an accepted booking. Do not include
`fullPayoutLiveMinutes`; it is incompatible with this guaranteed policy.
The HTTP `Origin` must match the signed origin. Signing/creation moves no money.
The performer signs `liveAcknowledgement(savedBooking)` from the same deployed
module, then submits `POST /api/live-bookings/acknowledge` with
`{id: savedBooking.id, address: performerWallet, signature}`. Use the saved record,
not reconstructed or edited terms. The owner separately signs a `schedule`
command with the latest revision to publish the dated listing. Acceptance,
scheduling, exact USDC funding and post-end approval/claim remain separate steps.
An ETH balance is not USDC funding and grants no permission for a swap.

The Profile menu's existing notification badge includes invitations and claims;
the Schedule invitation badge is retained. The invited wallet opens Profile →
reviews and accepts → waits for **confirmed escrow funding** → opens the audio
room → authorizes the booked wallet and allows/publishes microphone audio →
attends 8 p.m. and 8:45 p.m. New York checks → goes ON-AIR only after both checks
pass and operator arming → claims here after approval or the review window,
before November 17 at 9:20 p.m. New York. Keep the room open while publishing.
Creation, a badge, allocation and acceptance are not a funded booking. A mock
guest view must be prominently labelled simulated; never sign as the performer.
`payroll-assets.json:liveFundSlug` includes the recoverable live-performer
allocation in the shared fund selector and worker `/api/funds` evidence. It is
optional for other configurations; neither its balance nor a payroll reward
receipt is proof of a booking escrow deposit. The worker must load the updated
configuration for changes to its configured fund list to take effect.

The [November 10 public receipt](./deployments/2026-11-10-within-pilot-funding.json)
records the verified October pinner reward and the distinct $20 live-fund
deposit; the remaining pinner allocation was $10.73. The actual invitation
`friday-live-performance:2026-11-13:withinthevacuum` is steward-approved, awaiting
performer acceptance, with no extras. These are timestamped facts, not a live
balance feed or a confirmed booking deposit.

**After the artist accepts:** recover exactly the existing $20 allocation to
the owner, approve the booking escrow for exactly $20, call `createBooking`
once with the accepted terms, then reconcile the actual `BookingFunded`
receipt. The Admin **Fund booking** action pulls from the owner's wallet; it
does not automatically pull the live-fund allocation. Do not donate another
$20, double-fund, or mark the recoverable deposit as locked escrow. Reconcile
any pending transaction before retrying.

Reuse decision: adapted DecentBusking `996a526`,
`js/live-booking-notifications.mjs:startNotifications` and
`js/live-performance-profile.mjs:renderLivePerformances`; retained the existing
wallet-scoped signed booking workflow and claim/funding gates, with no Calendar
integration. Targeted notification and audio/Profile wiring tests cover the
invited wallet, existing Schedule path and absence of unfunded room access.

## Prototype readiness (verified October 24, 2026)

- Production `/api/live-bookings` reports ready; escrow is configured, unpaused, uses Base USDC, and grants the expected steward the admin role.
- The approved v2 terms are pinned at `ipfs://bafkreidzxhbeub33romiprjlsjojgpitnwrqap52g6hpen3wowwhfi3zgq`, content hash `0x8ae5bc38f9d8a66b0c43ac4697c14d62e14ef1c3e66768b6df294ff5b68d88f6`. Retrieved bytes match the repository agreement exactly. The form prefills these references but does not pre-check approval.
- Jose's October 23 invitation is unaccepted, has no on-chain booking/deposit, and was not linked to the shared calendar. Keep it as history; lack of a response is not a paid no-show, and no payout/refund operation is required for it. A replacement date or musician requires a new booking and fresh consent, never editing the signed agreement.
- New invitations default to the next future Friday at 9 p.m. New York time. October 30 is still EDT (`2026-10-31T01:00Z`); November 6 is EST (`2026-11-07T02:00Z`). Use the app's timezone conversion, not copied UTC offsets.
- Expired invitations show as expired, cannot obtain new acceptance through either endpoint, and cannot request new funding from the admin UI. Previously submitted funding transactions can still be reconciled after the slot starts. An unfunded draft never advertises an automatic escrow claim.
- Discord currently reports a gateway cooldown. Respect its persisted retry deadline; do not reset it or promise a working live channel/automatic announcement. Booking signatures and Base escrow can be tested independently, but a real musician soundcheck and full invite → funding → review → claim rehearsal remain operational validation gates. The owner approved closing #210/#223 as build-complete; track any rehearsal defects in separate issues.

### Next-musician rehearsal checklist

1. Obtain the musician's confirmed wallet, preferred display name, future date and agreement to the exact v2 terms. Record any recording opt-out before soundcheck; do not assume an old invitation transfers to someone else.
2. Steward creates an approved draft, explicitly adds its dated calendar listing, and verifies `scheduleStatus: synced` plus the public occurrence. Saving a draft alone does not publish an invitation to the calendar or send Discord promotion.
3. From a separate performer wallet, verify that Public Schedule/Profile shows only that wallet's acceptance control, pinned terms, time and fee. Acceptance signs the immutable agreement; it moves no USDC. Confirm the steward's action notification.
4. Only after separate authorization, steward funds exactly $20 USDC on Base and waits for confirmed `BookingFunded` evidence. Verify locked amount in Profile and Community Funds, plus receipt recovery after refresh.
5. Before funding/show commitment, verify Discord gateway readiness, voice/stage access, microphones, sound routing and the listener path with the actual musician. Pausing automated JukeLoop rotation is not evidence of live audio delivery or a browser microphone relay. Confirm the intended listening surface explicitly.
6. Run the 20-minute slot, record whole verified live-music minutes, publish the performance report, and submit the agreed full/partial/zero decision within 24 hours. Verify that approval is not displayed as payment.
7. Performer claims from their own Base wallet; confirm the exact transfer, Profile earnings receipt, public accounting and no double claim after refresh. Verify partial/zero refunds and cancellation paths with test fixtures rather than creating unwanted live financial operations.
8. Record rehearsal evidence and open separate issues for any defects. #210/#223 track the completed build, not proof of an actual musician show; do not equate unit/fork tests with a live rehearsal.

## Settlement mode

Phase 1 escrow is deployed at `0x20C08F2e877389D68cFbcF49664211E8CE9554Ec` and configured on the worker. Prefer it for the revised offer: payment is locked per booking and the performer claims after approval. Phase 0 remains a fallback using the Base router `0x8ecca903e2a6Daa8CCbB933700e4F2C58C44A4B5`; its money is **earmarked, NOT escrowed**, can be recovered by the admin, and has no performer claim.

### Before the show (owner actions, in this order)

1. Deploy reviewed site/worker software through the normal separately authorized release process. The production booking service currently reports ready and escrow `0x20C08F2e877389D68cFbcF49664211E8CE9554Ec` (deployment start block 52942855); verify the live `/api/live-bookings` response before acting. Phase 0 bookings still use the router and remain **earmarked, NOT escrowed**; choose the mode deliberately per booking. Ensure booking and schedule Pinata checkpoint restore works and required mirror is online. Worker enforces `MINT_OWNER_WALLET`, allowed origin, signed command, timestamp and durable revision server-side; hiding the panel is not authorization.
2. Confirm the new performer's wallet/ENS, preferred public display name and Discord handle directly with them. Jose's historical wallet is `0x29185eB8cfD22Aa719529217bFbadE61677e0Ad2`; do not use it for a different musician.
3. Open the prefilled approved v2 terms in [LIVE_PERFORMANCE_TERMS_V2.json](./LIVE_PERFORMANCE_TERMS_V2.json) and verify their pinned URI/hash above. Do not reuse v1: it promises a 60-minute slot and 45 live minutes. Changed agreement text requires a new reviewed pin and fresh acknowledgement.
4. In **Admin → Live Performance**, create a draft for a **20-minute** future dated event, fee **$20 USDC**, full payout at 15 verified live-music minutes and proportional payout below that. The default is the next Friday at 9 p.m. New York; adjust only to the explicitly agreed future time. This saves a booking only, not a payment. The owner separately signs the booking-management request. Do not put private notes in the public draft.
5. Link the draft to the shared community calendar. Only the exact invited wallet sees the acceptance control. The performer opens the pinned terms and signs the booking agreement with their connected Base wallet; this records consent only. The owner sees a clear acceptance notice and must still choose **Fund booking** separately. Never ask for a seed/private key.
   Neon-blue action counts mark only a wallet's actionable Phase 1 handoff: the owner funds an accepted invitation, reviews/submits the post-show decision, or executes a funded cancellation; the performer accepts through Public Schedule or claims through Profile. Calendar housekeeping, waiting for the other party, and pending transaction confirmations do not light a badge. Counts clear when the service confirms the handoff is no longer needed, not when the menu is opened. Connected wallets check every five minutes and immediately on connection or a local booking action; notification failures are logged and shown in the owner panel. Refresh bookings remains available on demand.
6. **Phase 1:** choose **Fund this booking** only after acceptance. Confirm Base, the $20 amount, performer, exact slot and terms in the wallet. The panel requests only the exact token approval if allowance is insufficient, then creates the per-booking escrow. Wait for two confirmations and matching `BookingFunded` evidence; use **Check a pending transaction** with the original hash if interrupted.
7. **Phase 0 only:** separately approve/pin fund metadata JSON including slug `dbusk-live-performers`, occurrence/booking ID, title, resolved wallet and ENS, fee/asset/network, slot, terms version/link, and **earmarked, NOT escrowed; admin can recover it**. No automatic production pin occurs in this panel.
8. **Phase 0 only:** if absent, create the Live Performers fund, approve only the exact USDC amount if needed, then choose **Fund this booking**. Wait for two Base confirmations and matching router evidence before the booking says **funded**. Do not repeat a transaction after a timeout; reconcile its original hash.
9. Verify `/api/radio/schedule`, the public calendar, and booking schedule status **synced**. In Community Funds → Live Performers, confirm the performer, date, $20 fee, correct escrow/earmarked label, and transaction proof. No recurring series is replaced/deleted. Verify the next Friday still exists.
10. Soundcheck and run the show. A funding transaction and schedule checkpoint are independent: the panel exposes incomplete linkage/retries, not a fictional atomic cross-system transaction.

### After the show

11. Prepare/pin a public completion report (slot, verified live minutes, decision, reason, terms/booking references, exact approved amount and remainder disposition). The v2 admin flow asks for whole verified live-music minutes and calculates the pro-rated amount; zero live minutes earns $0. A report URI, public reason and explicit remainder disposition are still required. A recorded decision is **not payment**.
12. At 15 or more verified live minutes, the approved amount is the full **$20**. Below 15 minutes it is `$20 × verified live minutes ÷ 15`, capped at $20; the on-chain amount is rounded down to the escrow’s supported precision. Phase 0 only: verify the performer is an approved contributor in the existing payroll/contributor registry; register only through the normal owner-approved flow if needed. Phase 1 claims are enforced by the escrow's booked performer address, not the router contributor registry.
13. For Phase 1, **Send the recorded payment** submits the decision to escrow; the performer then claims the approved amount from their connected wallet. For Phase 0, the **owner payout transaction** uses deployed router `payout` (or existing payroll panel/batch with identical fields) from `id('dbusk-live-performers')`, USDC, resolved performer wallet, approved amount, with exact work reference:
    `decentbusking:live:v1:8453:<dated-event-id>:<verified-lowercase-wallet>`
    Hash the string with `id()` for `workReference`. `completedWorkReferences` is checked before sending and prevents duplicate payment on-chain. Repository/contributor hashes must match the existing approved registry and report metadata hash must describe the actual pinned report. Wait for two confirmations; reconcile PayrollPaid matching fund, asset, wallet, work reference and approved amount. Pending approval/decision is never shown as received funds. Receipt appears in performer earnings **Live performances** with BaseScan proof.
14. For partial/withheld fees, publish the reason and exact approved/remainder units. Earmarked remainder is not an automatic refund. Owner separately approves any `recoverFund`/return or future earmark (the panel’s **Recover agreed remainder** sends only the recorded remainder back to the original owner/funder and requires confirmation); never claim a recovery occurred without chain proof. No unrequested financial operation is sent automatically.

### Cancellation / incident procedure

- **Cancel live performance** requires a public reason and explicit confirmation, then signs an owner command. It invokes the existing #227 dated-occurrence cancellation mechanism; the public cancellation retains artist/title, original time and reason. Normal radio continues; future Fridays remain. Verify public schedule and admin schedule **synced**. Refresh/reopen clients; existing calendar polling receives the shared schedule update.
- Financial consequences are **separate**. Panel displays the agreed proposed kill-fee amount and pending financial reconciliation. Phase 0 has no automatic contract kill fee or refund; **Reconcile financial cancellation** records a report/reason/disposition and the agreed fee, then **Execute recorded payment decision** and **Recover agreed remainder** each require a separate explicit owner transaction. Review agreed terms and actual deposits before authorizing either. No refund is fabricated.
- If a checkpoint fails, cancellation intent remains durable with **schedule failed**; retry linkage with **Link / retry schedule occurrence**, then verify public calendar/radio. Do not claim cancellation succeeded while schedule sync failed. During a slot, schedule cancellation works; Phase 1 pre-show cancel does not, so review/reject after end is required.
- Wrong network/account: signing is blocked. On a wallet/network change or failed signature, refresh and reconcile the original hash. Transactions that were submitted can still mine after UI errors. Local pending hashes survive reload; backend revisions and unique occurrence/booking/tx IDs prevent duplicate records; router completed work references prevent double payout.
- Worker restore errors disable mutations instead of seeding over unknown state. Never erase checkpoints or manually edit production state to “fix” a pending transaction.

## Phase 1 — deployed and worker-configured

Contract source/test companion: [DecentMarket PR #61](https://github.com/TheJollyLaMa/DecentMarket/pull/61), lives in **DecentMarket** because that repository already owns Hardhat/OpenZeppelin and DJuke/DVert sources. The deployed escrow address is `0x20C08F2e877389D68cFbcF49664211E8CE9554Ec` (start block 52942855). The production booking API currently reports it as configured; the browser learns the capability from `/api/live-bookings`. Confirm the live status before funding and verify event indexing.

Phase 1 owner approves exact USDC allowance then `createBooking` with all acknowledged parameters; confirmed BookingFunded evidence funds the booking. After end, owner `approve(id,bps,reportUri)` or `reject`/`markNoShow` before review-end. Partial remainder returns to original funder on-chain. Performer alone signs `claim`; undecided funds become automatically claimable after the agreed review window, before the agreed deadline. `expire` after the deadline returns only unclaimed funds to original funder. Late admin decisions cannot race auto-claim. Before start, platform cancellation may reserve agreed late kill fee for performer claim; performer cancellation fully refunds. Pausing blocks claims/refunds too: disclose this emergency liveness risk. No arbitrary admin withdrawal exists.

## Live Performance Agreement v2 — approved and pin-verified

The steward approved strict verified-minute proration on 2026-10-22; the published pin and hash were independently rechecked on October 24. Exact content is [LIVE_PERFORMANCE_TERMS_V2.json](./LIVE_PERFORMANCE_TERMS_V2.json). This version does **not** carry forward the v1 platform-outage pay guarantee: outages do not add verified live minutes or create a full-fee exception. Attach the verified URI/hash above to each new booking. The v1 text remains immutable and applies only to bookings that reference its original hash.

## Historical Live Performance Agreement — **v1**

The previously pinned agreement is immutable and describes a 60-minute slot with a 45-minute live minimum. It is not suitable for this revised 20-minute offer. Keep it only for bookings that explicitly reference its original hash.

1. Slot: stated New York date/time, duration (proposed 60 minutes, 9–10pm) and Discord stage/voice stream target.
2. Minimum: proposed 45 audible live minutes of 60; start within proposed 10 minutes.
3. Content: original/licensed work; no hate, harassment or illegal content; Discord ToS; flag explicit content beforehand.
4. Technical: proposed soundcheck at least 15 minutes before; reasonable audio. Platform/Discord/bot outages do not reduce pay.
5. Recording/rights: proposed non-exclusive stream/archive/promotional clips permission with recording opt-out; performer retains ownership.
6. Payment: Phase 0 explicitly earmarked, NOT escrowed, recoverable by admin; Phase 1 genuinely escrowed. Proposed review window 72 hours followed by auto-claim; agree exact deadline and emergency pause/expiry effects.
7. Partial/no-show: proposed pro-rating below minimum; unnotified no-show refund to funder; proposed performer cancellation at least 24 hours ahead without penalty. State exact approved amount/reason/remainder.
8. Platform cancellation: proposed less-than-48-hour late window and 25% kill fee. Both configurable/agreed per booking; Phase 0 cannot enforce them on-chain.
9. Disputes: proposed public review using archive; raise in Discord within proposed 7 days.
10. Tips: listener tips/DJuke play earnings separate from fee and payable to performer.
11. Taxes: performer responsibility; on-chain payments public.

## Validation

`node --test test/*.test.js` (full DecentBusking suite). Focused lifecycle/API/claim/cancellation tests: `node --test test/live-bookings.test.js test/settlement-funds.test.js test/fund-ledger.test.js test/creator-profiles.test.js test/approval-safety.test.js`. Contract suite: `npx hardhat test test/*.test.js` in DecentMarket. See PR for exact results and inherited baseline failures. No tests use production writes/signers.

### Prototype readiness verification (October 24, 2026)

- Focused booking, cancellation, notification, schedule/calendar, fund/profile and approval tests: **117 passed**. Includes expired direct/owner-relayed acceptance, DST-safe next-Friday defaults, honest unfunded/expired claim states and post-start reconciliation of already-submitted funding.
- LivePerformanceEscrow lifecycle/adversarial suite in DecentMarket: **14 passed**. Prior Base-fork rehearsal is recorded in [DecentMarket PR #63](https://github.com/TheJollyLaMa/DecentMarket/pull/63); it is not a real performer acceptance or microphone test.
- Browser checks: future date and verified terms prefilled, steward approval unchecked, historical offer labelled expired and moved out of invitations, expired Profile offer has no signature/payment controls.
- Read-only production checks confirmed API readiness, exact terms bytes/hash, Base USDC token, unpaused escrow, steward admin role and no on-chain booking for the old invitation. No new invitation, calendar write, wallet signature or financial transaction was submitted.

### Original Phase 0/escrow implementation verification

- Focused booking/fund/profile/approval regression selector above: **52 passed**.
- Full DecentBusking suite: **818 tests, 816 passed, 2 inherited failures**. The unchanged DVert test expects obsolete `devert-paid-queue.mjs?v=20261017-mercury-release` while baseline already uses `20261019-radio-recovery`; unchanged Top10-hype fixture fails current-New-York-week chart validation before its expected checkpoint error. Both also fail in the isolated existing selector; related source/tests are unchanged.
- Full Solidity suite: **118 passed, 4 existing optional fork cases pending**; new escrow lifecycle/adversarial suite: **14 passed**.
- Worker/new-module syntax and `git diff --check` pass. No production state/signatures/pins/funds were created by validation.
