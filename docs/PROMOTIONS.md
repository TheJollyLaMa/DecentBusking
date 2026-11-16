# Invites & Promotions

The admin panel supports small, capped, owner-reviewed promotional pilots.
Deploying the code does not create, publish, announce, fund, approve, or pay
any offer. An actual funded pilot requires separate steward authorization.

## Storage and deployment

Promotions is optional and fails closed unless both server-only settings exist:

- `PROMOTIONS_STORAGE_KEY`: a dedicated 32-byte cryptographically random key
  encoded as 64 hex characters. Back it up privately, separately from the
  database. Do not reuse a wallet, Pinata, content-review, or live-audio secret.
- `PROMOTIONS_STORAGE_PATH`: an explicitly initialized SQLite file on a durable,
  private volume attached to the worker host, outside the public web root.

Provision the persistent volume before enabling promotions. An ephemeral
filesystem, including a free hosting tier without persistent storage, is not
sufficient. Use one worker; any additional local processes must use the *same*
database on the same host and filesystem. SQLite WAL is not a multi-host
replicated database. Node must support `node:sqlite`; some supported Node 22
releases require `NODE_OPTIONS=--experimental-sqlite`.

Only for a new, empty installation, set both environment variables securely and
initialize the database on the persistent volume:

```sh
node discord-bot/promotions-store.js init "$PROMOTIONS_STORAGE_PATH"
```

Initialization refuses to overwrite an existing file. Never reinitialize a
missing or damaged financial journal to bypass an error. The database holds one
AES-256-GCM encrypted state with transactional, revision-checked writes,
SQLite WAL, and full synchronization. Campaigns, claims, attribution, activity,
review notes, and announcement/payment recovery state are **not** automatically
backed up to Pinata or the checkpoint mirror.

Back up the current database regularly and before/after financial actions; for
a running SQLite instance use its online backup API (for example
`sqlite3 "$PROMOTIONS_STORAGE_PATH" ".backup promotions-backup.sqlite"`) and
move the resulting encrypted backup to private durable storage. A raw copy of
the main file alone while WAL is active may omit recent writes. Retain the key
separately. Test backup decryption and integrity in an isolated environment.
Restoring an older backup can lose reservations or payment/Discord journals:
stop writes and reconcile all offers, wallet history, Base receipts and Discord
delivery before resuming. Missing storage, wrong keys, invalid records, and
uncertain writes stop promotions rather than treating history as empty.

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
a minimum paid DVert purchase. The steward verifies album rights, approval and
radio delivery, buddy onboarding, and listening-session evidence manually.
Default amounts are examples, not promises.

**First-sponsor match is draft-only.** Its draft records the selected artist
fund, match amount, cap, minimum contribution and dedicated source, but cannot
publish or move funds. The existing router has no verified atomic fund-to-fund
settlement path; do not treat a wallet payout or recover/deposit as an
implemented match. Fund contributions are not refundable ad purchases.

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

For referral rush, two distinct registered referees must each have an accepted,
wallet-signed **song vote in that offer during the current New York payroll
week**, both at claim submission and approval. Either vote direction qualifies.
The vote must occur after registration through the offer panel; ads and ordinary
anonymous or other-offer votes are not retroactively attributed. If the browser
already voted on that play, wait for the next song. Approved qualification is
frozen for payment. Weekly boundaries use New York time and DST.

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

Claim/evidence and attribution details are available to the claimant wallet and
the admin, not public offer views. Do not submit sensitive personal information.
Base payout recipients, amounts and transactions are public. Encryption protects
stored records, not data visible to an authorized operator or a compromised
worker.

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

Need: bounded campaigns, private qualification evidence, and owner-reviewed
rewards. Adapted DecentBusking PR #302 commit `0442609`, under the same Apache
2.0 repository license, plus the existing
`js/settlement-funds.mjs` fund controls,
`discord-bot/live-bookings.js` review/receipt patterns,
`discord-bot/jukeloop.js::submitJukeLoopVote`,
`js/radio-client.mjs::radioListenerId`, and
`js/payroll-week.mjs::currentPayrollPeriod`. The older PR's Pinata checkpoint
approach was replaced because it cannot atomically reserve across processes;
the receiving worker uses an encrypted transactional SQLite journal instead.
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
  test/ipfs-worker.test.js test/tutorial.test.js
```

These tests do not spend money, send Discord messages, or broadcast audio. A
steward-authorized live pilot must separately record campaign ID, published
terms, evidence, transaction/proof, actual cost and lessons. The 10 USDC
development bounty for #301 uses the normal `dbusk-repo-dev` bounty ledger and
is separate from participant funding; filing or merging does not itself pay it.
