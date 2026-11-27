# Admin DCal

**Left ankh → ⚸ 🗓️ Admin DCal ⨘ 🜐** retains the receiving app's owner-wallet
and contract-role checks. Radio slot clicks, show clicks and moves open centered
dialogs; a drop is a proposal, not a write. Errors and signature/save feedback
remain visible in the dialog. Choose Long-Form, 0 Votes, Top10 or Rising Stars
and drag the single radio button. Campaigns have their own single selector/button;
the last choice is **Custom**.

## Saved Long-Form investigation (2026-11-27, read-only)

The live schedule contained `program-d048e5d9-3219-4da1-b1ff-71871d359521`:
Friday, minute 900, first date November 27, `long-form-hour`. That is **15:00–16:00
New York / 20:00–21:00 UTC**, not a future show at the time of investigation.
The following `program-67e95c2b-ff06-4d20-9ebe-66de2c9ff8a1` zero-vote hour
started at minute 960 / 21:00 UTC. Both survived persistence and the public
schedule API. New York conversion and the receiving selector evaluated the
saved Long-Form occurrence correctly.

Two different boundaries were involved:

* Public DCal filtered weekly projections by **start >= now**, removing an
  already-started hour while showing the next, future hour. It now keeps a weekly
  occurrence until **end > now**. Optional past-rule projections stay separate
  from evidence that a show actually aired.
* At 15:55–15:58 New York, `/api/radio` reported **Normal Rotation**, no
  `playlistShow`, and ordinary songs (including “Jones Dr 511 my generation”),
  despite the active saved Long-Form rule. The mismatch also persisted after
  16:00 for the zero-vote hour. A later read-only Long-Form preview reported
  three eligible recordings, no unknown durations and about 42 minutes of media;
  this is current pool evidence, not a recovered opening snapshot.
  A healthy encoder was **not** proof of the intended
  playlist policy. The website JukeLoop now reads the same canonical schedule
  source used by persistence/public APIs whenever it resolves a show, rather
  than relying solely on separately copied runtime arrays. Tests exercise the
  constructor binding, serialized saved weekly hour, actual eligible-track
  admission and durable completion cursor.

The initial copied-array/deployed-artifact hypothesis was unverified, and the
canonical getter did **not** repair production playback after PR #519 was
released. The post-release investigation below identifies a different,
reproduced override cause. No worker restart, rollout, live schedule edit,
signature, booking cancellation or payment was performed by the implementing
agent.
Playback-history PR #517 is merged at current main `545c8f1`; it does not change
the scheduling selector. Public DCal PR #518 merged at `36993740f83b8cc56cfdfc096330e503837f06ab`.

### Post-release root cause: expired live allocation overrides the calendar

The released PR #519 source at `26e8920b3f97749afa1d0bda6face73ffbca6e1a`
still returned Normal Rotation during the saved zero-vote hour. Read-only
`https://decentbusking.onrender.com/api/radio` at **21:51:40.229Z** returned
`activeShow: normal_rotation`, `playlistShow: null`, `liveAudio: null` and
“675 long as I can see the light” (started **21:48:46.551Z**).
Render application logs (`--type app`, **21:45–21:50Z**) recorded the new
service live at **21:48:17Z**, Discord startup at **21:48:33Z**, and that
ordinary song at **21:48:46Z**. This is actual worker playback, not just a
healthy encoder or a separate edge presentation.

The public booking ledger retained the paid
`friday-live-performance-2125:2026-11-20:daef17ed-5122-4ca8-9235-c3d3a4b7b3ef`
allocation, with actual completion **2026-11-21T04:05:33.043Z**. Reconstructing
its timing from public completion evidence and evaluating the exact saved
schedule at the observed API timestamp reproduced the override. A subsequent
read-only **`/api/live-audio/state?bookingId=…` at 22:02:38.330Z** directly
confirmed the actual historical room: `configured: true`, `phase: ended`,
fresh booking verification, and **`policy: { controlled: true, mode: radio }`**
with no `program`. Its public allocation had 20 minutes plus a ten-minute
encore, revision 5, and the same recorded actual ending. This establishes the
running policy cause, rather than merely a compatible local hypothesis:

1. `resolveActiveShow` correctly selects the saved zero-vote occurrence.
2. `liveAudioPolicy` returns a **controlled, program-less `mode: radio`**
   indefinitely after that historical allocation ends.
3. `applyLiveAudioShow` preserves scheduled playlists/Top10 in radio mode only
   when `policy.program` exists; otherwise it replaces them with Normal Rotation.
4. `createLiveAudioService.current()` intentionally hides radio-mode policies
   as `null`. Consequently `liveAudio: null` did not establish a wrong artifact.
   `/api/radio` reads the same in-process JukeLoop state through a one-second
   state-reader cache; this path does not substitute a separate public edge state.

The fix adapts those existing helpers, without another schedule subsystem:
completed allocations expire after **both** the original signed reservation and
actual outro; radio-mode policy yields to scheduled playlist/Top10 regardless
of optional program configuration. Existing live, fault, recovery adverts,
lead-in, protected next performer and canceled-reservation rules remain.
Booking records, fee guarantees, actual completion and settlement are not erased
or changed by policy expiry.

Focused validation passed **74/74**:

```sh
node --test test/live-audio.test.js test/playlist-show-runtime.test.js
```

The historical-allocation regression failed on the released behavior and passes
with this fix. It restores a paid, ended room with no program configuration,
checks canonical policy and public `current()` semantics, injects a stale copied
radio policy, and actually admits eligible Long-Form and zero-vote audio from
saved weekly rules while rejecting an ineligible ordinary track. It also covers
Top10 preservation and early/delayed ending boundaries. Production private room
files were not accessed, and this follow-up has not been deployed by the agent;
production recovery still requires an authorized release and in-hour playback
verification.

After an authorized worker release, verify both `/api/radio/schedule` and
`/api/radio` at an intended hour: selected playlist, eligible pool/fallback reason,
actual `nowPlaying.playlistShow` and intact recording duration. Long-Form admits
verified recordings strictly longer than ten minutes, preserves full playback
across ordinary/chart boundaries, and yields to protected live performances.
Storage, unavailable media, an empty/exhausted eligible pool and protected-live
conflicts remain explicit fallback states.

## Cancellation is not settlement

An event dialog requires a public reason, an impact acknowledgement **and** a
second confirmation before signing the schedule update. Its red action cancels
**one occurrence**, not a weekly series. It offers:

* **Keep publicly:** retain the occurrence with a 45-degree red **Canceled** stamp.
* **Remove from calendar:** hide it from the visible calendars, but retain its
  canceled tombstone for runtime suppression and calendar subscriptions.

The existing schedule snapshot stores `status: "cancelled"`,
`cancellationReason` and optional `calendarHidden: true`. The original occurrence
ID suppresses the weekly projection and runtime reservation; next week remains
unchanged. Hidden canceled entries are not restored by weekly projection.
The subscription feed retains the same UID with `STATUS:CANCELLED` and no alarm.
Clients must refresh the feed to receive cancellation; a separately imported
Google/ICS reminder cannot be remotely erased by this app. Existing schedule
retention remains seven days after an occurrence ends; this does not promise a
permanent cancellation archive or guaranteed behavior in every external client.

Default Friday Top10 and Sunday Finish Line can also cancel one occurrence.
Their `weekly_top10` records are cancellation-only tombstones, not a new dated
playable type. Runtime, public projection and ICS use the exact occurrence ID;
next week stays scheduled. The immutable payroll cutoff still cannot be moved.

Calendar cancellation does **not** cancel an invitation, approve a refund, settle
an escrow or erase claims. The dialog shows linked fee obligations from the
loaded ledger, or explicitly says the ledger is unavailable. Open **Live
Performance** to inspect and separately authorize the real booking lifecycle.
Guaranteed fees and separately promised gifts retain their agreed treatment.
Do not equate hiding a show with recovering its funds.

## Campaigns and live performances

Campaign browsing uses the public GET endpoint, including public drafts; it
does not request a signature. Save, publish, review, announce and payment actions
still use the existing protected promotion commands. **Custom** creates an
ordinary promotion draft with explicitly entered title, evidence, terms, reward
and budget; it does not invent a reward promise. Saved campaigns appear as
reusable selector choices. Dropping one creates a new draft with copied offer
terms and relative date windows, not copied IDs, claims, payment state or
announcement state. Referrals keep their existing specialized editor and
settlement policy.

The radio and campaign palettes each have one draggable selected-text control.
Click its native disclosure to choose, then drag the same visible text:
**Long-Form / 0 Votes / Top10 / Rising Stars**, or a campaign title.
Saved reusable campaigns join the campaign options; **Custom** is always last.
There is no separate static-name scheduling button.

**Pin Reward Campaign** opens editable campaign dates, qualifying days, a capped
ETH bonus and optional NFT gift. Save, fund and explicitly publish to make it
public in right-ankh DCal. Independent daily checks and personal profile cards
track its first-finisher bonus eligibility; ordinary weekly USDC pinning rewards
remain separate. Legacy drafts require an explicit edit/save upgrade.
See [Pinning bonus campaigns](PROMOTIONS.md#pinning-bonus-campaigns) for the
qualification boundaries, publication quote, payment safeguards and deployment
order. A drop alone never publishes, pays or announces anything.

Dragging **Live Performance** opens the existing invitation form at the chosen
time. Clicking a live occurrence exposes the same booking workflow. It uses the
connected header signer, not another wallet connection. Invitation approval,
performer acceptance, confirmed escrow receipts and allocated-stage completion
are distinct colored/outlined states directly in calendar event blurbs as well
as the booking dialog. Phase0 funding is explicitly **earmarked, NOT escrow**;
only phase1 confirmed receipts indicate escrow funding, never payout.
Wallet-bound ledger snapshots expire after five minutes plus request allowance;
wallet changes and refresh failures clear highlights. Matching verified live
audio expires after fifteen seconds; actual completion is not inferred from a
scheduled end or paid status. A local five-second redraw expires evidence without
adding network polling. Short events keep compact lifecycle icons, funding text,
full accessible labels/tooltips and unchanged calendar duration.
Sound checks are verified in the existing
permissioned operator/performer rooms, not inferred from a calendar or a timer.
Absent private check evidence is explicitly unavailable with workflow navigation;
only fresh, booking-matched verified check timestamps show passed checks.
Existing acceptance, funding, claims, gift, production-desk and recovery controls
keep their original signature, permission, privacy and clock gates.

## Reuse decision and validation

Need: a shared, decision-ready admin calendar whose public projection and
playback agree with a saved hour. Canopy's curated agency map was checked along
with receiving source/tests, existing worktrees and PRs #302, #517 and #518;
another worktree's unfinished changes were not imported.

* **Reuse/adapt:** DecentBusking at `545c8f1`, `js/radio-calendar.mjs`
  (`radioCalendarOccurrences`, New York conversion), `js/radio-schedule.mjs`
  (`cancelLivePerformanceEvent`, schedule serialization), `js/dbusk-calendar-core.mjs`
  (`publicCalendarEvents`), `discord-bot/playlist-show.js` (`createPlaylistShow`),
  `js/live-performance-admin.mjs` (existing booking actions), and
  `js/promotions-ui.mjs` (`mountAdminPromotions`, signed commands). No duplicate
  schedule, campaign, booking, escrow or signature subsystem was extracted.
* **Inspect only:** DecentCalendar at
  `dfae35fd5a3e2c9476475e3a1f7e79b936ea3dd1`,
  `decent-calendar-vanilla/js/calendar.js:handleEventClick`. Its global
  FullCalendar/local-storage ownership and POL-priced appointment flow do not
  match Busking's Base assets, shared IPFS schedule and accepted-performer escrow
  lifecycle. Its MIT license was inspected; no donor source was copied.
  Receiving helpers remain under their existing license.

The targeted receiving suite passed **267/267**:

```sh
node --test test/radio-programming.test.js test/promotions.test.js \
  test/promotions-ui.test.js test/dbusk-calendar.test.js \
  test/radio-schedule.test.js test/radio-calendar.test.js \
  test/playlist-show-runtime.test.js test/live-audio.test.js \
  test/live-asset-review.test.js test/radio-announcements.test.js \
  test/live-bookings.test.js test/live-booking-notifications.test.js
```

These tests cover persisted active Long-Form projection, the future
zero-vote boundary, actual intact-track runtime admission, single-occurrence
cancellation with both visibility choices/ICS suppression, and reusable custom
promotion persistence/authorization. Desktop 1280px and mobile 390px browser
checks used controlled local saves only: centered dialogs, genuine validation
feedback, the double guard, canceled stamp, unsigned custom browsing and the
real invitation form. Selected-radio drop opened a proposal without saving;
failure feedback/focus recovery and Escape retained the underlying calendar.
Real-wallet acceptance, escrow transactions, sound-check
execution and repaired production playback were not exercised.

Follow-up checks cover the selected-text control's changed drag payload, actual
invitation/acceptance/funding/escrow/check/live/completion projections, phase0
funding, stale/error evidence and both default Top10 cancellation tombstones.
Controlled browser checks verified desktop lifecycle outline transitions and
390px mobile layout without overflow. Native dragstart used the newly selected
Long-Form text; controlled drop opened that Long-Form proposal at the target
time. The embedded browser did not complete native drag/drop end-to-end, so
that interaction still needs a normal-browser release check. No standalone
preview fixture is shipped; the release decision superseded that request.

The expanded JukeLoop suite also reproduces three failures and one canceled
subtest on unchanged `545c8f1` with the same installed dependencies: missing
`getJukeLoopSession` in a VM startup fixture, real-audio voice-frame timeout, and
`import.meta` in a VM countdown fixture. They are not claimed fixed here.

Preview from this worktree:

```sh
python3 -m http.server 8767 --bind 127.0.0.1
```

Open `http://127.0.0.1:8767/`; local preview still targets configured live read
APIs. Do not sign or submit production changes while previewing. Release the
matching worker before enabling custom-template writes or hidden-cancellation
UI; an older worker does not understand these additive fields/options.
