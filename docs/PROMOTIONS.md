# Invites & Promotions

The admin panel contains **Invites & Promotions** for small, bounded promotional
pilots. No offer is created, published, announced, funded, approved, or paid by
deploying this code. There is deliberately no Discord-send action.

## Setup and funding

1. Configure a dedicated server-side `PROMOTIONS_STORAGE_KEY`: 32 cryptographically
   random bytes encoded as 64 hex characters. Back it up privately. It must not be
   a wallet private key, Pinata JWT, or mirror secret. Never put it in frontend
   configuration, GitHub issues, screenshots, or the repository.
2. Keep the existing Pinata checkpoint configuration. Campaigns, claims, wallet
   attribution, activity, and review notes are encrypted using AES-256-GCM before
   they are sent to the existing checkpoint/mirror storage. Losing the key loses
   recovery access. Use one worker; service reservations are not a distributed
   database or on-chain escrow.
   Startup requires the latest checkpoint: it will not silently restore an older
   one when the newest is unavailable. Invalid restored records stop initialization.
3. In **Payroll → Settlements Router**, select **Promotionals
   (`dbusk-promotionals`)**. Use the existing owner-confirmed fund-creation and
   Base USDC deposit controls. Creation and deposit are separate wallet actions.
   The configured settlement router is reused; no new contract is deployed.
4. Open **Admin → Invites & Promotions → Unlock / refresh promotions**. This
   signs an origin-bound read authorization. Missing storage, fund configuration,
   inactive funds, missing router role, paused router, insufficient balance, and
   unavailable RPC produce explicit errors. Draft editing does not require money.

Promotionals is separate from Playback, Top 10, pinners, live performers, and
repo development. No existing fee splits are changed. Fund money is
owner-managed and recoverable, not protected escrow. This feature does not
transfer money from other allocations or reserve money on-chain.

## Offers

Choose a template: album onboarding, referral rush, sponsor scout, band-buddy
onboarding, first-jam welcome, or village listening session. All start as drafts.
Defaults are 10 USDC/reward, a 50 USDC budget and five awards, but the steward
must review and save them explicitly. A first-sponsor *fund matching* offer is
not included: that requires a fund-to-fund delivery path, not a reward paid to
the claimant wallet.

Set qualification/evidence rules, rights, privacy and dispute/refund terms,
per-award amount, budget, maximum awards, opening/closing times, and claim
deadline. Date inputs explicitly use New York time and the existing DST helper.
Claimants receive rewards at the wallet that signed their registration/claim.
Terms must disclose any minimum album size or qualifying DVert purchase,
new-member rules, and how the steward checks duplicates.

Publishing requires the Promotionals balance to cover the campaign and
outstanding budgets of other published/paused/closed campaigns. Pausing stops
new registrations/activity but preserves existing claims. Closing preserves
eligible registered participants' ability to claim until the deadline.
Resolve outstanding claims before archiving; archiving releases unused
service-side budget. Published terms cannot be edited; duplicate to a new
draft instead. A closed campaign cannot be reopened.

Copy an offer link to share or preview it:
`?promotion=<campaign-id>`. No automatic outbound invitations or announcements
are sent. The offer view suppresses automatic first-visit tutorial launch.

## Referrals and active listeners

The pilot rule is **one accepted song vote in the current New York payroll
week**, in either direction. A vote is activity, not proof of listening time or
of a unique human.

Participants open the offer link, connect their wallet with **Connect wallet**,
choose **My participation**, accept the displayed terms, and register. A
registered participant can copy a link with their wallet as referrer. Referees
must be new to the promotions register, register the inviter before voting, and
use **Vote up/down on current song** in the promotion panel. This signs the
exact vote with their wallet and uses the existing radio vote handler and
browser listener ID. Ad votes do not qualify. If the browser already voted on
the current song, its accepted vote is reused instead of adding another.
Close the offer panel to use the radio, then choose **Return to promotion**;
closing does not lose the offer link or registration.

Ordinary historical anonymous votes and Discord votes cannot be safely
attributed to wallets retroactively. They are not silently counted as reward
evidence. Votes from the offer page are subject to the same current-play rules
as normal radio votes.

Two registered referees must have qualifying votes **this week** when the claim
is submitted and approved. Once approved, the qualification week/evidence is
frozen for payment. Weekly boundaries use `currentPayrollPeriod`, including
New York DST. The private participation view shows registered/active referral
counts. Browser IDs are hashed in the checkpoint.

One wallet cannot refer itself; one browser cannot qualify multiple wallets.
These checks do **not** prevent determined multi-wallet/multi-browser abuse.
The admin must review distinct people and attribution disputes. The MVP permits
one claim per wallet per campaign and does not permit stacking another approved
promotional reward for a wallet that already has an approved/pending/paid
reward. These restrictions are disclosed in the default terms.

## Claims and payments

Album, buddy, first-jam and listening-session evidence is reviewed manually.
Sponsor claims additionally require purchaser wallet, DVert campaign ID and
purchase transaction: the worker verifies a positive `CampaignCreated` event
from the configured DVert contract within the offer window, on Base with two
confirmations. One conversion cannot be claimed twice. The admin still checks
new-advertiser, refund, dispute, and any minimum-purchase terms; a lead is not
a conversion.

Claims progress through submitted, needs-evidence, rejected, approved,
payment-pending and paid. Review notes and reviewer/time are retained.
Approval serializes the final-slot and budget checks before reserving a reward.
Unavailable funding never means zero or ready. Approved/pending/paid rewards
consume capacity; published campaign budgets are service-side earmarks only.

**Pay approved reward** preflights the existing settlement router and asks the
owner to confirm a Base `payout` transaction from `dbusk-promotionals`. The
amount, native Base USDC, recipient and deterministic work reference are fixed.
The router's completed-work-reference guard prevents a second successful payout
for the same campaign/wallet, including cross-browser retries. No USDC approval
is needed to pay money already deposited into the router.

The worker marks paid only after two confirmations in the canonical Base block and matching `PayrollPaid`
**and** actual USDC `Transfer` events. A pending/unknown transaction remains
pending. Use **Reconcile payment** with its original hash, or a successful
matching replacement hash; an unrelated reverted transaction cannot unlock a
recorded payment. Reverted matching transactions return the claim to approved.
The browser retains an unresolved journal before wallet broadcast; after an
ambiguous wallet failure without a hash, inspect wallet history and reconcile
the actual transaction rather than clearing storage or sending again. A
definite wallet rejection can be retried with the same work reference.

Payment recipients/amounts and Base transactions are public. Private evidence
is not included in payout metadata. Do not collect sensitive personal data.
Campaign terms/capacity are public; claimant and referral records require
wallet authorization and are visible only to that wallet and the admin.

A checkpoint write failure blocks further mutations until restore/restart and
reconciliation. Keep the encryption key and retained checkpoints together;
do not reset a financial/eligibility journal to get past an error. Service-side
limits are 1,000 campaigns, 10,000 participants/claims, 30,000 weekly activity
records, and 60 signed mutations per wallet/hour. Capacity errors need steward
review, not silent pruning.

## Reuse and verification

Need: bounded promotional offers, private qualification evidence, and
owner-reviewed rewards. Adapted DecentBusking at `cefe234`:
`js/settlement-funds.mjs` fund creation/deposit selectors,
`discord-bot/ipfs-state.js` retained checkpoint storage,
`discord-bot/live-bookings.js` serialized review/receipt patterns,
`discord-bot/jukeloop.js::submitJukeLoopVote`,
`js/radio-client.mjs::radioListenerId`, and
`js/payroll-week.mjs::currentPayrollPeriod`. Exact payment checks are scoped to
the new fund and work references. Existing checkpoint plaintext is not suitable
for private claim evidence, hence the authenticated encryption adapter.

DecentCanopy's curated agency map and the receiving app's open issues/worktrees
were checked. No tested cross-repo referral verifier was identified in that
scope; none is claimed. No donor source was copied or public inventory changed.
This is not a synchronization service or unique-human verifier.

Run focused tests:

```sh
node --test test/promotions.test.js test/promotions-ui.test.js \
  test/settlement-funds.test.js test/ipfs-worker.test.js test/tutorial.test.js
```

The automated tests use fake funds/receipts and signed fixture wallets; they do
not spend money. An actual funded pilot and transaction proof require separate
steward authorization. Keep the 10 USDC issue #301 development bounty separate
from promotional participant funding and verify the normal merged-PR bounty
ledger before paying it.
