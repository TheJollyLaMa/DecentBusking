# Invites & Promotions

The admin panel supports small, capped, owner-reviewed promotional pilots.
Deploying the code does not create, publish, announce, fund, approve, or pay
any offer. An actual funded pilot requires separate steward authorization.

Admin DCal's campaign selector combines the presets and saved reusable campaigns;
**Custom** is last. Browsing uses public GET without signing. Custom campaigns
reuse the promotion draft/checkpoint and protected save commands. Reusing a saved
campaign copies offer terms into a new draft, not its claims or settlement state.
**Pin Reward Campaign** uses verified daily pinning evidence, its own ETH or USDC
bonus budget and optional NFT gifts. See [Admin DCal](ADMIN-DCAL.md).

## Pinning bonus campaigns

1. In **left ankh → Admin DCal**, select **Pin Reward Campaign** and drag its
   text onto a calendar slot. The drop opens the same blob popout as the
   Referral Campaign, not the verbose custom form, and nothing is saved until
   you press a button. Clicking a pinner **draft** bar reopens that same draft
   in the popout; published pinner campaigns open their management view.
   Rows: ✏️ Title · 🟢 Start · 🏁 End · ⏳ Claims close (default end + 7 days,
   directly under the dates) · 📌 Pinning requirements · 🎁 The gift · 🏦 Fund.
2. **📌 Pinning requirements** is separate from the gift. Required days
   default to 90% of the timebox's full America/New_York days, rounded up
   (`pinnerDefaultQualifyingDays`; e.g. 6 of 6, 27 of 30). The value is
   editable (1 to the number of full days), and **↺ 90%** restores the
   suggestion. Moving the dates refills the suggestion unless you have edited
   the days. A day counts when the node passes 90% of at least 20 independent
   spot checks. The award cap (first finishers win) is also set here.
3. **🎁 The gift** pays fixed bonuses in **ETH and/or USDC and/or Ommm**
   (toggle chips, each with its own per-finisher amount; defaults 0.002 ETH,
   $5, 1,000 Ommm), five winners; each asset's budget = bonus × winners. One
   of ETH/USDC is the primary bonus; Ommm (Base `0xD324…b778`) can only be
   added alongside it, and stays blocked until the ArtFi Settlements Router
   approves Ommm (`setAssetApproved`) and the fund holds it. Extras are stored
   as `extraRewards` and paid through a separate `bonusAwards` ledger. ETH shows the live USD estimate, e.g.
   `0.002 ETH ($6.70)`; the ETH amount is the promise. **🎖 Supporter gift**
   lists the Supporter DNFTs the connected admin wallet holds on the Base
   Supporter contract (read on-chain via `nextTokenId`, `balanceOfBatch` and
   one Multicall3 read of caps/metadata), with balances, and warns when the
   wallet holds fewer copies than the award cap, as a contained chip picker
   inside the popout. **Other ERC-1155 token**
   keeps manual contract/token-ID entry. One token per winner is owed
   separately from the bonus. Tokens are not escrowed or minted: they stay in
   the admin wallet until approved delivery through Payroll, and activation
   checks inventory against outstanding pinning promises.
4. Every pin reward campaign draws from the standing **`dbusk-pinner-campaigns`**
   allocation, whose ETH and USDC balances are accounted separately. One
   progressive button walks the setup and changes text as you go:
   **⚸ Create dbusk-pinner-campaigns** (opens Fund Allocations and runs the
   metadata signature and Create Fund transaction; the popout updates when it
   lands) → **▶ Fund <shortfall> & Activate** (saves edits, deposits exactly the
   shortfall per selected asset after other pinner campaigns' reservations,
   sequentially: `fundNative` for ETH, approve + deposit for USDC/Ommm, then
   signs activation) → **▶ Sign & Activate**
   when the fund already covers it. **💾 Save draft / Save changes** saves
   without activating, and later saves update the same draft rather than
   creating another. **🗑 Discard draft** archives a draft so it leaves the
   calendar. The fund is earmarked and admin-recoverable, not escrow.
   Activation requires a signed review plus enough of each selected asset for
   every outstanding campaign budget (primary and extras) in that fund. No quote is needed: published
   terms and amounts are immutable, with no payout-time repricing.
5. The published offer appears on **right ankh → DCal**. Opening it leads to
   registration and the existing node setup/enrollment dialog. A listener or
   musician signs acceptance of the campaign terms, enrolls their own
   Discord-linked node and obtains owner approval. These are free signatures,
   not payment transactions. No song votes or manually supplied uptime claims
   count toward pinning bonuses.
6. Each full **America/New_York** day inside the offer and after registration
   needs at least **20 independent checks and 90% sampled availability**.
   Days need not be consecutive. Partial opening/joining/closing days are
   excluded. DST days use actual local midnight boundaries, not fixed 24-hour
   intervals. Missing historical daily records are not invented.
7. First finishers fill the bonus slots, ordered by completion midnight,
   then campaign registration time, then wallet address. A hashed,
   campaign-scoped Discord identity permits only one winner per identity.
   Completing verified days is retained even if a node is later suspended;
   disputes still require owner review. Rejecting a claim makes that slot
   available to the next finisher.
8. Profile **✨ For you** banner cards (swipe ‹ › between campaigns) show verified days/check ratios,
   qualification/claim status, pending/approved/paid ETH, optional NFT delivery,
   and payment proof. Registration does not promise payment. Claim submission
   and approval recheck server-side evidence and ordering; unavailable
   verification is shown explicitly, not as zero progress or success.
9. Approved bonuses (primary and each extra asset) use the existing protected promotion Payroll flow:
   recipient approval, fixed fund/reference, pre-broadcast journal, two
   canonical Base confirmations and exact payment reconciliation. Optional
   NFTs enter the existing dev Payroll delivery queue. Pending/delivered NFTs
   prevent reversing their approved award; owed gifts must settle before archive.

**Weekly pinning rewards remain separate:** normal USDC awards from
`dbusk-pinners` continue under their existing weekly checks and weighting.
Campaign bonuses use `dbusk-pinner-campaigns`, never the weekly pot. Musician
referral campaigns use `dbusk-referrals`; `dbusk-promotionals` (or a
`dbusk-promotionals-*` fund) is for other one-off offers. Separate
campaigns may reward the same pinner for their own qualifying timeboxes.
Reusing a saved campaign copies its terms into a new draft, not participants,
claims, receipts or earned NFT state.

Deploy the matching worker before the UI. `/api/promotions` advertises
`features.pinnerCampaign: "pinner-eth-v2"` (fixed bonus, dedicated fund) and
`features.pinnerCampaignAssets: ["eth","usdc"]` (USDC pinner bonuses) and
`features.pinnerExtraRewards: ["eth","usdc","ommm"]` (multi-asset gifts);
the editor refuses a pinning save against an older worker. Existing legacy pinner drafts restore as draft-only:
edit/save them to explicitly choose the new timebox and terms. Daily summaries
are durably stored in the existing pinner checkpoint before weekly hot-check
pruning, so progress survives payroll rollover/restarts. An older worker cannot
restore published new-version pinner campaigns: rollback requires a compatible
worker, not deleting or silently resetting earned records.

Reuse decision: adapt DecentBusking `04b5a8a`, specifically
`createPinnerNetwork`/`pinnerWeekStats`, `createPromotions`/`promotionWorkReference`,
`mountAdminPromotions`, `publicCalendarData`, `renderPromotionProfileSummary`
and `supporterRewardQueue`. Canopy's curated pinning/schedule leads and existing
pinner/promotions worktrees were inspected; no external code was copied and no
shared subsystem was extracted. Ordinary weekly rewards and referral settlement
contracts remain unchanged. Focused tests exercise actual independent-probe
results through daily archival, week close, public DCal, profile qualification,
claim approval and restart, plus ordering, funding and optional-gift safeguards.

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

In **Left ankh → Admin DCal → Fund Allocations**, create and deposit native Base USDC into
**Promotionals (`dbusk-promotionals`)** with the existing owner-confirmed
controls. Creation, token approval if needed, and deposit are separate wallet
actions. The admin may instead choose a dedicated slug beginning
`dbusk-promotionals-` and create/fund it using the custom fund selector. Each
source is accounted independently. Pin reward campaigns use the dedicated ETH/USDC
allocation `dbusk-pinner-campaigns` (see above), not `dbusk-promotionals`.
Playback, Top 10, weekly pinner (`dbusk-pinners`), live-performer,
and repo-development funds cannot be selected as promotional reward sources.

Musician referral campaigns always use **Referrals (`dbusk-referrals`)**. Create
that fund once using the calendar's **Fund Allocations → Prepare referral fund**
flow. Save its metadata, create the empty allocation, then deposit ETH or USDC.
The campaign editor separately checks available budget and commitments.

### Running a referral campaign from the calendar

Choose the referral preset from the campaign control's text dropdown, then drag that same selected title onto a day in **Left ankh → Admin DCal**
(or tap it on a phone to use the selected day). A compact editor opens with the
title, start, end, claims-close, referrers and 💵 budget. The default
title is "Referral Campaign"; a custom title is shown as "<title> Referral
Campaign". Referrers come from whitelisted contributors in
`contributor-accounts.json`; extra wallets or ENS names can be added with an
optional display name (up to 40 characters).

The budget defaults to the $150 pilot but every part is editable: the total,
the four per-musician legs (🤝 referrer, 🎤 musician, 🏆 Top 10, 📻 Playback)
and the 🗳 vote count (1–100). The referrer leg must be above zero, other legs
may be $0 (zero legs are not created), and the total must be an exact multiple
of the per-musician reward, up to 100 musicians. Run stays disabled until the
breakdown is valid. Campaigns saved before this change keep the pilot terms.

Nothing is signed while editing. **Run Campaign** re-reads `dbusk-referrals`.
If unearmarked USDC is short, the button becomes **Fund $X & Run** and deposits
only the shortfall through the existing router deposit flow. It then signs a
single `run` command. The server rejects underfunded or overcommitted runs, and
saves and publishes the campaign in one journal revision. Only then does its
bar appear on the calendar. Campaigns that already ran appear as dashed
template chips so the same rules, breakdown and named referrers can be
dragged onto new dates.

On the week view each published campaign is one continuous bar across the
days it runs, stacked above the time grid like iCal all-day events.

### ETH campaigns, fixed fund matches and Supporter baskets

**💱 Currency** switches a campaign between 💵 USDC and Ξ ETH. Switching
converts the current amounts at the Coinbase ETH-USD spot price (the same
quote as the tip modal), rounded to 0.000001 ETH or one cent. ETH amounts show
an approximate USD value in brackets, which is an estimate only. ETH campaigns
hold native ETH in `dbusk-referrals` (the router's `fundNative` and
`fundBalances(fund, 0x0)`). Wallet rewards and fund-share releases originate
there; Top10/Playback ultimately receive USDC through the Payroll flow below. USDC and ETH
balances are separate: a campaign is only checked against, and funded from,
its own currency. No Settlements Router change is needed.

New calendar campaigns use settlement policy `eth-usdc-match-v1`. **Budget**
shows the fixed USDC match per successful newcomer before signing, using an
admin-approved ETH/USD quote captured before publication. Refresh and review
quotes older than five minutes. Calculate with integer wei and quote micros;
round each fund share to the nearest USDC cent, halves upward. A nonzero ETH
fund share must match at least one cent. This is a publication agreement, not
an on-chain oracle or automatic swap. The admin supplies USDC and separate gas.

After the campaign ends, closes or fills, **Payroll → Referral fund matches
owed** lists one Top10/Playback obligation per approved qualifying newcomer.
Unfilled slots create no entries. **Release & match** first pays the exact
source share to the configured admin wallet with a unique router work
reference; it then asks separately to deposit the fixed USDC match. An ERC-20
approval may be needed too. Both canonical, twice-confirmed receipts are
required. The source payout immediately reduces ETH commitments, but the
target leg remains owed until its USDC deposit is proven. A deposit alone
cannot settle a new-policy leg. See [Payroll recovery](PAYROLL.md#referral-fund-matches).

**🎁 Gifts** for new campaigns are Supporter DNFTs only, one optional criterion
per trigger:

| Gift | Who wins |
| --- | --- |
| 🎟 Participation | Every curated referrer with at least one conversion |
| 🏁 Completion | Every converting referrer, only if the campaign fills |
| 🥇 Top referrer | Most conversions; ties break on registered referrals; remaining tied winners each receive the basket |

The basket defaults to DecentBusking Supporter #75 on Base. Add other
admin-owned Base ERC-1155 Supporter contracts/IDs (up to eight distinct tokens).
Each eligible wallet receives one of each selected DNFT per campaign, even if
multiple criteria overlap. Gifts reserve **zero ETH/USDC**. Publication checks
ERC-1155 support and at least one admin-held copy of every selected token;
inventory is not escrowed or guaranteed and may need replenishing for winners.

Once the campaign fills or its claims close, and every claim has been reviewed,
the admin presses **🎁 Award** on the campaign bar. That signed `award-gifts`
command freezes the winners and adds 🎖 winners to the Supporter queue (see
**🎖 Supporter tokens owed** below). New-policy full-campaign Supporter eligibility
requires successful wallet rewards, not delayed fund-match deposits.

**Legacy campaigns keep their original terms**, cash-gift reserves, separate
owner-funded fund legs, and default #75 delivery identity. Each legacy money award has its own
**🎁 Send** button: one router payout with work reference
`…:<campaign>:<wallet>:gift-<trigger>`, reconciled like a claim payment.
If a wallet transaction is interrupted, **↻** reconciles its hash; **↩** can
release a prepared gift only after the admin checks wallet history, confirms
there was no broadcast, and records why. Winners see their gift glow in
**✨ For you**. Gifts in other ERC-20 tokens are not supported yet; the router
would allow them once the asset is approved.

### Profile "For you" inbox

The user's own profile has a permanent **✨ For you** carousel (‹ › arrows)
for platform notifications: live-performer after-show payments and referral
campaign invites. Every curated referrer of a published or paused campaign sees
an invite card until claims close, even before joining. It shows earned versus
possible USDC as a ring, the leg amounts, required votes, open slots, the
Supporter-token goal, and an avatar for each referred musician (ENS avatar or
👽) with a vote-progress ring. **🔗 Copy invite** copies the referral link
without a signature. Cards disappear when their action is complete.

Campaign rewards and money gifts use Base USDC or ETH. Other ERC-20 gifts are
not yet supported. Supporter tokens are not escrowed: the v2.1 router cannot
hold ERC-1155 tokens, so they are owed and sent as described below.

### 🎖 Supporter tokens owed

An earned Supporter enters the queue when an approved conversion earns a 🎖
participation gift, when the campaign fills for a 🎖 completion gift, when the
top-referrer 🎖 award is finalized, or when all configured conversions are paid.
Each earning wallet is owed one of each selected Supporter DNFT per campaign
(#75 on Base `0xe63E…439B` by default). Owed tokens appear in the
**💸 Payroll** panel, below the repo dev payouts, as **🎖 Supporter tokens
owed**. They come from the public promotions ledger rather than
`payroll-queue.json`, because referrers are wallets, not registered GitHub
contributors. Before a transfer is prepared, eligibility follows the current
approved claims; preparing it records the obligation even if a claim is later
reversed.

**🎖 Send** checks that the admin wallet holds a copy and simulates the
transfer. It then records a signed `prepare-supporter`, and the wallet sends
`safeTransferFrom(admin, recipient, selectedTokenId, 1)` on the selected contract. The token is marked delivered only
after a twice-confirmed, canonical Base receipt has a `TransferSingle` of
exactly one selected token from the admin wallet to that recipient. A hash can settle only
one record. A proven reverted attempt returns the token to owed. **🔎 Check**
reconciles an interrupted send and accepts a replacement transaction hash.
**↩** releases a preparation without a hash only after wallet-history review,
with a recorded reason. Tokens come from the admin wallet's existing inventory;
nothing is minted. Recipients see **🎖 Supporter
🎁** in **✨ For you** until delivery, including after the campaign closes.
An active invite shows **🎖 Supporter ✅** after delivery; a closed invite clears.

Open **Admin → Invites & Promotions → Unlock / refresh promotions** and sign the
origin-bound read authorization. Missing storage, RPC, roles, active fund, or
funding produces an explicit error. Draft editing does not require money.
Publishing checks that the chosen fund covers its own and other outstanding
campaign budgets; approvals and payment preparation recheck commitments. These
are service-side earmarks, not on-chain escrow: the owner can recover the fund.
No existing fee split is changed. Deploy the matching worker first and verify
`features.referralSettlement === "eth-usdc-match-v1"` in `/api/promotions`;
the new editor refuses to Run against an older worker. The worker also
rejects an older calendar's Run command, including an
unsaved draft in an already-open tab; preserve its details and reopen in the
updated editor instead of signing the old policy. New checkpoint fields
require the matching worker on restart; do not roll back to one that ignores
them. Worker releases still require the radio-safe predeploy process and
explicit approval; frontend deployment is not campaign publication.

Reuse decision: adapt this receiving app's existing
[router payout and signing controller](../js/promotions-ui.mjs),
[USDC deposit helper](../js/settlement-funds.mjs), and
[Supporter delivery journal](../js/supporter-payroll.mjs), from production commit
`3230c38581462c7f01d8f85a9302cef267939b36`. ArtFi's
`ArtFiSettlementRouter.payout` / `fundToken` (commit `843e770`) supply the two
explicit stages; there is no direct fund transfer or hidden recovery bridge.
Scoped Canopy and existing referral worktree inspection found no compatible
basket/matching implementation to reuse. Legacy cash rewards, Base-only assets,
and the ETH/USDC mismatch are kept explicit. Receiving-app tests exercise the
0.00095/0.0008 ETH trial, exact proofs, unfilled slots, per-token delivery and
checkpoint recovery without real transfers.

The six templates start as drafts: album onboarding, referral rush, sponsor
scout, band-buddy onboarding, first-sponsor match, and village listening
session. Dropping a preset on Admin DCal opens a compact campaign editor;
clicking its calendar bar opens its details and actions in the same style.
Pin Reward Campaign drafts use their own blob popout (above); published ones use this editor's management view. Opening a draft's bar edits that draft in place. Saved campaigns can be dropped
again to create a new draft with the same terms. The full promotions workspace
is used to create a new Custom campaign. The compact editor adapts the existing
`mountAdminPromotions` form, signed commands and referral-blob styles rather
than introducing a second promotions backend. It shows an unavailable balance
until the service supplies one; publication still performs the existing funding
and qualification checks. The steward edits the title, criteria, rights/privacy/dispute/refund
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

### Who brought you here? (inviters)

Every wallet can record one inviter. The question appears once, as a small
👽 card. It never blocks the action that triggered it:

- after a wallet's first successful radio vote;
- before a wallet's first Briefcase upload. If a musician referral campaign is
  open, the choice fills the referral field, so the campaign `join` records the
  inviter in the same signature;
- after a first Discord song upload. DBusker replies with a **🛸 Tell us** link
  (`?inviter=1`), which asks once the wallet is connected;
- from the faint **👽 who invited you?** link on your own profile.

**Skip** needs no signature; the card does not ask that wallet again in that
browser. **That's them** signs a `set-inviter` action. Records are public,
one per wallet and immutable, and cannot invite yourself or create a loop.
Only the owner can change one, with `correct-inviter` and a reason; the change
is kept in the record's `history`. A referred campaign `join` records the
inviter automatically when none exists yet.

The founding tree lives in `contributor-accounts.json` (`referredBy` and
`referredByName`): thejollylama.eth was invited by decentagency.eth, and the
first group by thejollylama.eth. Journal records override the roster.

Profiles show a subtle **🛸 via …** pill in the banner corner. The label is
the referrer's ENS name, then their linked Discord name, then their roster
name, then a short wallet. The pill opens the referrer's profile. An inviter
record grants no role, payout or campaign reward by itself.

## Wallet-tagged radio votes

With a wallet connected, a listener's first 👍/👎 on the main radio asks for
one free signature (no transaction, no payment). The signed sign-in message is
a 7-day pass bound to the wallet, the browser's listener ID and the site
origin; the browser sends it with every vote and the worker verifies it
(`discord-bot/vote-pass.js`, shared message in `js/vote-pass.mjs`). No server
secret is needed, so passes survive restarts. Declining or not connecting keeps
the vote anonymous, and an invalid pass falls back to an anonymous vote.

A wallet-tagged vote on a song (not an advert) counts toward every open
campaign that wallet has joined, using the same rules as the signed offer-panel
vote: one browser qualifies one wallet, earlier anonymous votes do not count,
and musician-pilot votes are tallied as distinct play IDs. The radio bar shows
the wallet and, for the musician pilot, progress such as 🎯 3/10. A pass proves
wallet ownership, not a unique human; payouts still require admin review.

## $150 Referral Campaign template

The **Referral Campaign** is an extension of this same promotions
journal, not a separate service. Its default configuration is six
conversions, $25 per conversion and $150 total; the calendar editor can change
the total, legs and vote count (see above). Qualification is all-or-nothing:
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

When all configured conversions have all their legs paid before the campaign
end, every earning referrer is owed one Supporter token, sent from the payroll
panel as described in **🎖 Supporter tokens owed**. Nothing is minted. Missing playlist, vote, router, amendment
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
