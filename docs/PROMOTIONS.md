# Invites & Promotions

The admin panel supports small, capped, owner-reviewed promotional pilots.
Deploying the code does not create, publish, announce, fund, approve, or pay
any offer. An actual funded pilot requires separate steward authorization.

## Storage and deployment

All promotion data is public, using DecentBusking's existing Pinata account and
checkpoint schema. **No promotions encryption key or private backup location is
needed.** Do not reuse or remove encryption keys belonging to unrelated features.

Promotions requires the existing server-side `PINATA_JWT` and
`PROMOTIONS_STORAGE_PATH`, an explicitly initialized SQLite journal on the
approved persistent single-host volume. SQLite is retained for atomic budget
reservations and cross-process write fencing, not secrecy. Pinata alone cannot
compare-and-swap concurrent reservations. Keep the journal outside the web root;
public API/snapshots expose records, not live database/WAL files or credentials.

Use one worker; additional local processes must use the *same* journal on the
same host and filesystem. Never run independent journals or multiple hosts for
the same campaigns. SQLite WAL is not a replicated database. Node must support
`node:sqlite`; some supported Node 22 releases require
`NODE_OPTIONS=--experimental-sqlite`.

Coordinate rollout: keep promotions disabled until storage is provisioned,
deploy the worker and confirm its `/api/promotions` response first, then deploy
the matching frontend. Do not mix worker versions or independent journals for
the same offers.

Set the journal path on the approved volume and initialize a new file only once:

```sh
node discord-bot/promotions-store.js init "$PROMOTIONS_STORAGE_PATH"
```

Initialization refuses to overwrite an existing file. Every successful mutation
pins a plaintext `schemaVersion: 1` snapshot containing the revision, campaigns,
claims, members and votes as `decentbusking-promotions-state.json`, tagged
`app=decentbusking`, `kind=promotions-state`, `schema=1`. It uses
`createPinataStateStore`, existing checkpoint groups/retention, and the existing
optional local mirror. A transaction first saves a pending publication, fencing
all other writes. After Pinata acknowledges the public CID, a conditional update
commits the local state and receipt. No new
Pinata credentials, data-encryption keys or private backup service is required.

Startup verifies the latest Pinata snapshot against the local revision. An
acknowledged remote snapshot ahead of the local state is restored before accepting
requests. A pending publication is either reconciled to that exact snapshot or
republished unchanged before writes resume. Missing, older, inconsistent, ambiguous or unreadable
remote state stops startup rather than silently falling back to an older
financial snapshot. An uncertain upload locks the service until restart and
reconciliation; no payment prompt or Discord send follows a failed checkpoint.

For disaster recovery, stop every writer, preserve the old journal and WAL,
and verify the latest public snapshot and its CID. Initialize a *new* journal
path and start the worker; it restores that snapshot before enabling operations.
Inspect all pending payment and Discord records, wallet history and Base
receipts before resuming. Never seed an empty journal to bypass missing pins.
Existing encrypted prototype databases are not silently migrated or published:
preserve them and arrange an explicit verified export if any exist.

## Funding and offers

In **Payroll → Settlements Router**, create and deposit native Base USDC into
**Promotionals (`dbusk-promotionals`)** with the existing owner-confirmed
controls. Creation, token approval if needed, and deposit are separate wallet
actions. The admin may instead choose a dedicated slug beginning
`dbusk-promotionals-` and create/fund it using the custom fund selector. Each
source is accounted independently. Playback, Top 10, pinner, live-performer,
and repo-development funds cannot be selected as promotional reward sources.

Open **Admin → Invites & Promotions → Unlock / refresh promotions** and sign the
origin-bound read authorization. Missing storage, RPC, roles, active fund, or
funding produces an explicit error. Draft editing does not require money.
Publishing checks that the chosen fund covers its own and other outstanding
campaign budgets; approvals and payment preparation recheck commitments. These
are service-side earmarks, not on-chain escrow: the owner can recover the fund.
No existing fee split is changed.

The six templates start as drafts: album onboarding, referral rush, sponsor
scout, band-buddy onboarding, first-sponsor match, and village listening
session. The steward edits the title, criteria, rights/privacy/dispute/refund
terms, reward, budget, award cap, dedicated source, dates, and deadline. Album
offers require an explicit minimum original-track count; sponsor scout requires
a minimum paid DVert purchase. Referral offers set a required count from 2–100
and choose the current New York payroll week or the offer window. The steward
verifies album rights, approval and radio delivery, buddy onboarding, and
listening-session evidence manually. Default amounts are examples, not promises.

**First-sponsor match is draft-only.** Its draft records the selected artist
fund, match amount, cap, minimum contribution and dedicated source, but cannot
publish or move funds. The existing router has no verified atomic fund-to-fund
settlement path; do not treat a wallet payout or recover/deposit as an
implemented match. Fund contributions are not refundable ad purchases.

## $150 musician referral pilot template

The **First musician referral pilot** is an extension of this same promotions
journal, not a separate service. Its base configuration is fixed at six
conversions, $25 per conversion and $150 total. Qualification is all-or-nothing:
the referred musician must own a playlist entry that the restored worker
playlist marks `minted` with a token ID, and that musician must have 10 distinct
play IDs with campaign-scoped signed song votes. The votes are associated with
the referred musician; one wallet cannot silently reuse an earlier anonymous
or differently scoped vote.

Each qualifying conversion creates four independently visible legs:

| Leg | USDC | Settlement state |
| --- | ---: | --- |
| Referrer wallet | $10 | review and existing one-address payout router |
| Referred musician wallet | $5 | review and existing one-address payout router |
| `dbusk-top10` allocation | $5 | **funding needed**; not paid by this router |
| `dbusk-playback` allocation | $5 | **funding needed**; not paid by this router |

The two funding-needed legs remain auditable obligations. They are excluded
from paid counters and no transfer is fabricated. Direct wallet legs get
separate references, payment preparation, Base receipts and reconciliation.
The current router cannot atomically pay a whole four-leg conversion.

An admin can curate a pilot referrer before or after publication. A participant
can correct their own attribution during the active window after registration;
wallets and ENS inputs are resolved in the browser, while the server persists
only the verified wallet. Self/duplicate attribution and changes to reserved or
paid conversion evidence fail closed. Corrections retain an immutable public
reason and reviewer record.

An admin may top up the source or extend the end/claim dates only through an
**explicit immutable amendment**. The prior budget and dates, new budget and
dates, reviewer, timestamp and reason are retained together. The normal draft
editor cannot overwrite published pilot terms.

The supporter token result is eligibility only. When all six conversions have
both direct wallet legs paid before the campaign end, every earning referrer is
marked eligible. No NFT is minted or transferred because no exact edition or
authority configuration is present. Missing playlist, vote, router, amendment
or settlement support is displayed as unavailable/blocked, not as success.

Published terms are immutable and participants sign acceptance of that version;
duplicate an offer to create changed terms. New York date inputs reject both
nonexistent spring-forward times and ambiguous fall-back times. Pausing/closing
stops registrations and activity but preserves registered participants' claims
until the deadline. Resolve claims before archiving; archived offers release
unused service-side budget. The dashboard distinguishes applications awaiting
review, approved reservations, pending payments, paid totals and remaining
capacity. Links use `?promotion=<campaign-id>`; closing the offer panel does
not lose the link.

The journal limits are 1,000 campaigns, 10,000 participants, 10,000 claims,
30,000 weekly activity records and 20 promotional fund slugs. Signed mutations
are limited to 60 per wallet per hour per worker; this in-memory throttle resets
on restart. Capacity errors need steward review rather than silent pruning.

## Participation, referrals, and disputes

Participants connect a wallet, open **My participation**, accept the displayed
terms, and register before the offer closes. Referrers must already be
registered for that offer; a referee must be new to the promotions register.
Self-referrals are rejected. The admin can correct an attribution with a signed
reason and audit trail, but cannot alter evidence supporting a reserved or paid
reward. The participant view shows counts for the current offer.

For referral rush, the configured number of distinct registered referees
(default two) must each have an accepted, wallet-signed **song vote in that
offer**, both at claim submission and approval. The default window is the
current New York payroll week; the steward can instead choose any vote during
the offer after registration. Either vote direction qualifies. The vote must
occur through the offer panel; ads and ordinary anonymous or other-offer votes
are not retroactively attributed. If the browser already voted on that play,
wait for the next song. Approved qualification is frozen for payment. Weekly
boundaries use New York time and DST; offer-window activity remains eligible
for review after the offer closes. The admin can inspect the selected wallets,
play IDs, vote times and weeks supporting the recorded qualification.

A vote is activity, not proof of listening time or a unique person. Browser IDs
are hashed and one browser cannot qualify multiple wallets, but multi-wallet or
multi-browser abuse remains possible. The steward must review distinct people,
rights and disputes. This pilot allows one claim per wallet per campaign and
does not stack a wallet's approved/pending/paid rewards across campaigns; a
musician or referred person cannot support overlapping reserved rewards.

Sponsor scout additionally verifies the configured Base DVert contract's
canonical `CampaignCreated` event and exact native USDC transfer from the
purchaser, within the campaign window, at or above the published minimum, with
two confirmations. A lead or self-referral is not a conversion and the same
conversion cannot be claimed twice. The steward separately checks that the
advertiser is new and reviews the published refund and attribution-dispute
policy before approval **and again before payment**. Later cancellations,
refunds or disputes require human resolution under those published terms; they
are not automatically detected or clawed back.

**Public-data policy:** drafts (not live offers), archived campaigns, budgets,
claim evidence, wallets, referral relationships, hashed browser/activity records,
review reasons, payment preparation and receipts are publicly readable through
`GET /api/promotions` without connecting or signing. Offer pages show public
claims/reviews and expandable attribution/activity audit records, with a link to
the full IPFS recovery snapshot. The participation signature personalizes the
view; it is not a privacy boundary. Mutations still require the correct wallet,
origin, timestamp and command signature, with admin-only review/payment controls.

The form discloses public IPFS publication before registration and submission.
Submit only rights-cleared public evidence/references; never submit secrets,
credentials or personal information about others. Anyone may retain public
copies permanently; editing a claim or unpinning does not retract those copies.
No existing private moderation or rehearsal records are included in these pins.

## Poster-first Discord

An admin may preview one public HTTPS poster, one short supporting sentence and
the campaign link, then explicitly confirm sending to `ANNOUNCE_CHANNEL_ID`.
The bot requires channel permissions, checks Discord cooldowns and suppresses
all mentions. Use an approved image URL; Discord and the previewing browser
fetch it from its host. No announcement is automatic.

Delivery is journaled before sending. If the response is uncertain, use
**Reconcile Discord delivery** and inspect the channel; do not send a duplicate
or reset the database. Reconciliation searches the bot's recent messages for
the unique journal marker. If it cannot establish delivery, the offer remains
locked pending operator investigation rather than assuming it was not sent.

## Review, payment, and recovery

Claims progress through submitted, needs-evidence, rejected, approved,
payment-pending and paid. The signed reviewer, reason, time and qualifying
evidence are retained. The final slot and budget are reserved transactionally;
stale concurrent updates must refresh and retry. A claimant can update evidence
when requested. Approval is not payment.

The owner may separately enable an approved recipient on the shared settlement
router, then confirm **Pay approved reward** from the designated promotional
fund. Recipient enablement uses the contributor-admin role and also allows that
wallet to receive payouts from other router funds; it is not a payment. Paying
requires the payroll role, an unpaused router, approved native Base USDC,
sufficient committed funds and gas. No worker signing key is used.

The payout uses a fixed campaign/wallet work reference, recipient, amount,
asset and fund. The router prevents reuse of a completed work reference. The
worker marks paid only after matching router `PayrollPaid` **and** USDC
`Transfer` events in a canonical Base block with two confirmations. Two
confirmations are not absolute finality.

Before a wallet prompt, the worker records a durable payment preparation and the
browser journals its attempt. Unknown or pending responses stay locked across
devices and restarts. Inspect the owner wallet history and use **Reconcile
payment** with the original hash or a confirmed matching replacement. A
matching reverted owner-authorized payout returns the claim to approved; an
unrelated revert cannot unlock it. If there is no hash, only after explicitly
verifying that *no* payout was broadcast may the admin record a reason and use
**Review unbroadcast preparation**. Even a rejected wallet prompt requires
this review before retrying. Never clear browser or server journals to force a
retry. A wrong or unknown hash may require operator investigation.

## Reuse and verification

Need: bounded campaigns, public qualification evidence, and owner-reviewed
rewards. Adapted DecentBusking PR #302 commit `0442609`, under the same Apache
2.0 repository license, plus the existing
`js/settlement-funds.mjs` fund controls,
`discord-bot/live-bookings.js` review/receipt patterns,
`discord-bot/jukeloop.js::submitJukeLoopVote`,
`js/radio-client.mjs::radioListenerId`, and
`js/payroll-week.mjs::currentPayrollPeriod`. Public persistence adapts
`discord-bot/ipfs-state.js::createPinataStateStore` and the live-booking Pinata
wiring at DecentBusking commit `4c89498` (Apache-2.0). The receiving worker retains
the transactional SQLite fence for atomic reservations; plaintext Pinata
checkpoints provide public records and restart/disaster recovery. Pinata
credentials remain server-side, unlike the public records. This is not a
multi-host settlement service.

Run the local checkpoint client from the same release as the worker.
`checkpoint-mirror-client.js` validates public promotions records using
`validatePromotionCheckpoint` and existing calendar-reward journals using
`validateCalendarRewardCheckpoint`. An older client can reject a supported
journal and hold required checkpoints, including a radio-safe deployment drain.
Update/restart the client rather than bypassing CID validation, recursive pin
verification or the radio handoff. This changes neither reward eligibility nor
transaction authorization.
DVert purchase semantics were checked against DecentMarket
`contracts/DeVert_v0.1.sol` at `394169b348d17e29486672a2cb2f2c0efe48f2ce`;
no donor contract or third-party source was copied.

DecentCanopy's curated agency map, current Busking issues/worktrees, and the
receiving app's relevant source/tests were checked. No tested cross-repo
referral verifier was identified in that scope; this is not a synchronization
service or unique-human verifier. The receiving-app focused tests use fake
funds, receipts, Discord and signed fixture wallets:

```sh
node --test test/promotions-store.test.js test/promotions.test.js \
  test/promotions-ui.test.js test/settlement-funds.test.js \
  test/ipfs-worker.test.js test/ipfs-state.test.js test/tutorial.test.js
```

Public-Pinata revision verification: **163 tests passed**. Includes competing
worker reservations, upload-response loss, crash-before-upload recovery,
cross-process pending-publication fencing, public unauthenticated evidence,
and unchanged mutation/payment authorization. A local browser fixture confirmed
public evidence/referral audit data without a wallet and no horizontal overflow
at a 390px viewport. Pinata, payment and Discord operations in these checks were
fixtures, not live integrations.

These tests do not spend money, send Discord messages, or broadcast audio. A
steward-authorized live pilot must separately record campaign ID, published
terms, evidence, transaction/proof, actual cost and lessons. The 10 USDC
development bounty for #301 uses the normal `dbusk-repo-dev` bounty ledger and
is separate from participant funding; filing or merging does not itself pay it.
