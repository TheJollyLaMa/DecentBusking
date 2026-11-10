# Live Performance — operator runbook

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
and a rehearsal-room link. Legacy offers and historical receipts retain their
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
twelve-sign zodiac and star overlay celebrates the saved invitation. It is
decorative, pointer-transparent and cleaned up on timeout or page exit; reduced
motion uses a still composition. It never indicates funding or payment.

The agreed Friday slot is November 13, 2026, 21:00–21:20 New York:
`2026-11-14T02:00:00.000Z`–`2026-11-14T02:20:00.000Z`. Checks are
20:00 and 20:45 New York. Monday onboarding does not grant early access to this
Friday media room, create another funded show or require any token purchase.

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
