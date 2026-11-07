# Content Review

Listeners can flag the current radio recording or an NFT card using four reasons:
Inappropriate, Mislabeled, Copyright, or Other. Other requires an explanation,
limited to 1,000 characters. Reports require an explicit wallet signature, not
a transaction. The target is frozen when the dialog opens. Reporting does not
automatically remove content or establish a copyright violation.

## Admin

Open **Admin -> Content Review -> Unlock / refresh** with the configured admin
wallet. Reports appear first. Search by title/token, optionally select Reports
only, and choose a recording. Unreported catalog NFTs can also be selected.

The selected recording has two independent controls:

- **Label:** original catalog label, Song, or Advert. Reclassifying as Advert
  removes it from music selectors and makes approved owned media available in
  the DVert library. It does not edit immutable NFT metadata or purchase/cancel
  a campaign. Existing campaign terms and historical payments are unchanged.
- **Radio:** Allowed, Remove from music rotation, or Block all radio including
  adverts. Music-only exclusion keeps legitimate advert campaigns usable.
  All-radio exclusion blocks ordinary and paid radio playback and VertLoop.
  Voluntary NFT previews and private listens are not changed.

Enter a reason and save. **Skip now** immediately stops an affected current
recording; unchecked allows the current play to finish but excludes future
selections. Prepared/in-flight playback rechecks eligibility before starting.
Controls are reversible. Restoring eligibility does not erase the audit trail.

Reports separately progress through New, In review, Actioned, or Dismissed.
Updating a report requires a review reason; it does not itself change playback.
Review changed errors require a refresh rather than overwriting another decision.

## Paid content

Blocked paid requests remain pending with an explicit review/unavailable state.
They are not silently refunded, fulfilled, deleted, or counted as delivered.
Single-song payers can use the existing replacement flow; playlist/advert
liabilities require steward review and the existing applicable settlement/refund
process. Prior completed impressions and settlement proofs remain untouched.

Catalog/quote readers, platform checkout and standalone DJuke checkout recheck music eligibility. Campaign
checkout refuses known all-radio-blocked media. These are application controls,
not a modification to deployed contracts: an external client or an already-signed
quote may still submit an on-chain request. Such requests remain blocked by the
worker and need review. A moderation action never secretly sends a contract
removal or refunds an existing campaign.

Catalog identities use Base collection/token references where available,
otherwise stable track IDs. Media aliases carry a recording's policy through
radio and campaign playback, including another catalog entry with the same
IPFS recording. Titles are not identifiers. Report-only records do not alter
the original catalog; effective overlays never rewrite past votes/payroll.

## Deployment and private persistence

1. Set `CONTENT_REVIEW_STORAGE_KEY` to 32 cryptographically random bytes encoded
   as 64 hex characters on the worker. Generate and privately back up a dedicated
   key; do not reuse a wallet key or publish it.
2. Keep Pinata checkpoint storage configured. Use one worker instance.
3. Deploy the worker and site together. Frontend-only deployment does not provide
   the API. Shared worker deployments restart radio; check readiness afterward.
   Existing archive-module URLs retain their shared singleton; browser asset
   caches may delay the NFT-card flag button until refresh/cache expiry.
4. Verify Content Review unlocks, submit a harmless test report, and review it
   before making real exclusions.

The key encrypts the complete report/policy/audit checkpoint using AES-256-GCM
before Pinata/mirror transport. Public catalog responses expose only effective
label and exclusion scope, not reporter wallets or private review explanations.
The latest checkpoint must restore before enabled moderation admits selections;
invalid/wrong-key/unavailable restoration fails startup rather than ignoring
existing exclusions. Ambiguous saves stop further writes and selections until
restore/restart. A saved policy whose live refresh fails reports that distinction.

Without the key, reporting/review explicitly reports unavailable and existing
unmoderated radio behavior is preserved. **Never remove/change the key to bypass
an exclusion or persistence failure.** Losing it loses recoverability of private
decisions. Keep encrypted checkpoints and the key backed up together.

Reports allow ten submissions per wallet/hour, deduplicate open reports, and
reject replayed report signatures. Capacity is bounded at 10,000 policies,
20,000 reports and 30,000 decisions; exhaustion requires an explicit retention
review, not silent pruning. Wallet limits are not proof of unique humans.
Do not collect sensitive personal data. Rights complaints require steward
review; this form is not a complete legal notice/counter-notice procedure.
For reinstatement or an appeal, contact the steward with the catalog reference.

## Reuse and validation

Need: signed reporting and non-destructive radio moderation. Adapted existing
DecentBusking at `7b0f552`: origin-bound worker authorization, admin disclosures,
`playlist-store.js` selectors, `jukeloop.js` prepared-playback invalidation,
`devert-playback.js` eligibility checks, DJuke pending journals and
`ipfs-state.js` checkpoint transport. Private reports require encrypted storage;
ordinary playlist snapshots are not appropriate for private notes. The Canopy
map and receiving-app issues/worktrees were checked; no complete donor workflow
was established in that scope. No cross-repository code or private findings
were published.

Focused regressions:

```sh
node --test test/content-review.test.js test/content-review-ui.test.js \
  test/djuke.test.js test/jukeloop.test.js test/devert-playback.test.js \
  test/devert-loop.test.js test/mint-sync.test.js test/radio-playlists.test.js \
  test/ipfs-worker.test.js test/devert-panel.test.js test/devert-paid-queue.test.js \
  test/devert-purchase.test.js test/devert-scheduler.test.js \
  test/djuke-widget.test.js test/nft-loader.test.js
```

Tests use synthetic wallets/media/receipts. Local browser mocks verify the
four-reason modal, frozen target, admin relabel/exclusion, wallet cleanup,
mobile fit and focus restoration. They are not live moderation or payments.
The focused command passed 297 tests; modified runtime syntax checks and
`git diff --check` also passed. Deployment/key activation remains separate.
