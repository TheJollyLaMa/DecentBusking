# DBusker invited pilot

DBusker is a separately hosted, read-only AI guide for public DecentBusking
knowledge. It is not a connection to a maintainer's VS Code session, personal
Copilot subscription, private repositories, or administrative tools.
Tracking: [issue #291](https://github.com/TheJollyLaMa/DecentBusking/issues/291).

**Branch-only, disabled by default, not deployed or approved.** No real model
evaluation or wallet invitation is implied by the offline automated tests.

## The steward leads the handoff

We are not fine-tuning model weights. The first handoff consists of editable
guidance, a pinned public-source snapshot and review questions. You can revise
it quickly between tests without retraining or uploading a private workspace.

Edit these files together before the first live conversation:

- [Voice](../agent-service/handoff/voice.md): personality, welcome and mission.
- [Boundaries](../agent-service/handoff/boundaries.md): consent, rights,
  evidence, uncertainty and human handoff.
- [Participation orientation](../agent-service/handoff/participation.md): the
  steward's grassroots mission and welcoming routes through contributing,
  pinning, artist funds, advertising, playlists, collaboration and independence.
- [Topic routes](../agent-service/handoff/topics.json): editable vocabulary,
  public-file entry points and optional evidence anchors for each subject.
- [Evaluation questions](../agent-service/handoff/evaluation.json): add the
  questions you want DBusker to handle, and what good answers should do.
- [Public excerpts](../agent-service/handoff/sources.json): generated from
  explicit public Git history, never from uncommitted local changes.
- [Routing policy](../agent-service/handoff/routing.json): reviewed model
  assignments, Balanced task routes and aggregate recommendation thresholds.
- [Stewardship and independent centers](../agent-service/handoff/stewardship.md):
  Jolly's supplied aliases/seed metaphor, role dependencies, independent forks
  and a staged multisig compatibility checklist.

Review process:

1. Read and edit the voice and boundaries with the steward. Agree on invitation
   policy, EOA-only wallet support, the provider's data terms, operating costs,
   an actual human-contact route, and the community covenant before approval.
2. Run `npm run review` in `agent-service`. This prints the handoff fingerprint,
   source commit/date, coverage/exclusions, topic routes and questions without
   contacting OpenAI. Run `npm run evaluate:retrieval` to check that each
   community question retrieves the required source files and key evidence
   text. Passing retrieval is not evidence that a model's answer is correct.
3. Only after the steward approves the material for a **private live test**,
   run `npm run approve -- "reviewer name"`. This writes a local ignored approval
   file, not a public endorsement or evidence that the evaluation passed.
4. With an explicitly configured provider key, enable the service and invite
   only the test wallet(s). Walk through every evaluation question in the site.
   Record expected/actual behavior, citations, errors and the handoff fingerprint
   in private review notes. Do not publish wallet addresses or raw transcripts.
5. Pause the service, correct the editable guidance or source selection, run
   offline tests, review the new fingerprint, approve and restart. Repeat
   until the steward accepts the answers and handoff.
6. Community launch is a separate human decision after private testing,
   accessibility checks, data-policy review and a real operating-budget review.
   There is no auto-publish or automatic learning from visitor messages.

Changing **any** of the eight handoff files invalidates approval. A running
service detects edits and refuses new answers; restart with the newly approved
pack. Approval is an operator workflow, not a cryptographic defense against a
server administrator who can edit both the pack and its approval.

## Local setup

Requires Node **24.3 or newer** with `node:sqlite` (experimental in Node 24.3),
and npm. This service is independent of the Discord/radio process.

```sh
cd agent-service
npm ci
cp .env.example .env
cp access.example.json access.json
npm test
npm run review
npm start
```

By default it binds to `127.0.0.1:8788` and refuses chat. Its `GET /health`
reports process liveness and the environment enable flag, **not** approval,
provider readiness, or deployment validation.

Before any real model call:

- In `.env`, set `OPENAI_API_KEY` from a dedicated provider project. Review
  all three model assignments in `handoff/routing.json` for project access,
  current availability, structured-output support and pricing. The old
  `DBUSKER_MODEL` environment override is rejected; remove it rather than
  bypassing the fingerprinted policy.
- Review provider terms/retention. `store:false` avoids Responses conversation
  storage but does **not** promise zero provider retention or opt out of every
  provider-side logging mechanism. Review the
  [provider's data controls](https://developers.openai.com/api/docs/guides/your-data);
  default abuse-monitoring retention can include prompts and responses for up
  to 30 days, subject to exceptions and approved account controls.
  No wallet address is sent by this service
  to the model; a visitor can still type identifying information.
- Set `DBUSKER_SITE_URL` to the exact frontend URL, including its path, e.g.
  `https://thejollylama.github.io/DecentBusking/`. Only its origin receives CORS
  permission. The login message binds the full URI, domain, Base chain,
  single-use nonce, issue time and expiry.
- Put checksummed or lowercase test EOA wallet addresses in the local
  `access.json` `wallets` list. Set its `enabled` to `true` only for testing.
  The file is validated and reread on protected requests. Missing/invalid
  access configuration fails closed.
- Obtain steward approval as described above; set `DBUSKER_ENABLED=true`.
  The service needs both flags, valid approval, unchanged guidance and a key.
- Start the service. In a **local feature-branch build** of
  [site configuration](../decent.config.js), set `dbusker.enabled=true` and
  `dbusker.serviceUrl="http://localhost:8788"`. Serve the site at the exact
  configured frontend origin. No provider key belongs in site configuration.
- Connect an invited wallet to Base using the existing site header. Open
  DBusker, read/accept the data notice, and explicitly sign in to chat.
  Authentication is a gasless signature, not a transaction or token approval.

There is no live mock mode: automated tests inject a fake provider only inside
the test process, and never pretend to be a real knowledge evaluation.

### Creating the provider key

1. Sign in to the [OpenAI API platform](https://platform.openai.com/), not the
   ChatGPT subscription page. API billing is separate from ChatGPT and Copilot.
   Configure API billing before making a live test.
2. In the organization/project selector, create a dedicated **DBusker pilot**
   project. Keep its membership limited to the people operating this service.
3. In that project's **Limits**, enable the three reviewed models and set a small
   monthly budget and usage alerts. Project budgets are alert thresholds,
   **not hard spending caps**. The service's persistent `DBUSKER_MAX_CALLS`
   counter is a separate call-count limit, not a dollar cap.
4. In the selected project's **API keys**, create a new secret key named
   **DBusker local pilot**. Prefer restricted permissions: allow writing to
   `/v1/responses`, with the reviewed models available to the project. This
   service does not need Files, Assistants, fine-tuning, or administrative keys.
   If access fails, inspect the provider's error and adjust only the required
   permission; do not make a broadly privileged key as a workaround.
5. Copy the secret directly into the ignored `agent-service/.env` file after
   `OPENAI_API_KEY=`. Do not paste it into chat, a GitHub issue, site
   configuration, a terminal command, or a screenshot. Restrict `.env` to
   your OS account (`chmod 600 .env` on macOS/Linux), and close the editor tab
   before screen sharing. If exposed, revoke the key and replace it.
6. Leave `DBUSKER_ENABLED=false` and `access.json.enabled=false` until the
   steward has reviewed and approved the current handoff for a private test.
   Start with `npm start` from `agent-service` so Node loads `.env`. A process
   already running will not pick up a newly pasted key; restart it after the
   approval and enablement step. Never print `.env` to verify setup.

See the provider's [project and key administration guide](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform)
for current controls. Key creation and adding billing do not approve DBusker's
handoff, invite a community member, or make a model call.

## Modes and bounded self-review

The pilot supports OpenAI Responses models, not access to a maintainer's
Copilot session. Each mode uses the same community guidance and public corpus.
The [reviewed policy](../agent-service/handoff/routing.json) starts with these
assignments; availability and actual quality still require a private live test:

| Mode | First pass | Maximum provider calls per question |
| --- | --- | --- |
| Efficient | Light model (`gpt-5.6-luna`) | 1 |
| Balanced (default) | Local task triage: navigation -> light; general guidance -> standard (`gpt-5.4-mini`); technical or sensitive questions -> deep (`gpt-5.4`) | 2, only when a higher tier is available |
| Deep dive | Deep model | 1 |

These are initial test assignments, not a measured optimal ranking. Provider
documentation was checked on 2026-10-27: [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini) and
[5.4](https://developers.openai.com/api/docs/models/gpt-5.4) support Responses
and structured output. Project access is not established by documentation.
The former 4.1 nano default was not retained: its model page marks it shut down.
This pilot explicitly uses `reasoning.effort=none` and an 800-token output
ceiling in every tier. Deep dive selects a stronger model, not an unbounded
hidden-reasoning budget. Revisit these limits during human evaluation.

Triage is a small, deterministic English-language heuristic, not another paid
model call or a reliable semantic classifier. Risk/technical words take
precedence over simple navigation; short referential follow-ups inherit the
previous task unless a more explicit task matches. It is not a security or
truthfulness boundary. Users can choose a mode; all modes retain the same
evidence, privacy and permissions boundaries.

1. Retrieve approved public evidence first. With no matches, return an
   explicit evidence-limit answer and make **zero** provider calls.
2. Select the reviewed model locally. Each answer includes a structured
   checklist verdict: `ready`, `insufficient_evidence`, or
   `needs_deeper_review`. This is a self-assessment, not independent validation
   or proof of factual entailment.
3. Only Balanced may move up one tier after `needs_deeper_review`. The second
   pass sees a clearly untrusted earlier draft (at most 2,000 characters, with
   truncation labelled), the visitor question and approved evidence. Its exact
   escaped JSON context must fit 28,000 bytes too. Drafts are not new facts.
4. Stop after that pass, even if it requests another. Withhold an unresolved
   draft and return an explicit limitation instead. Missing/stale evidence
   does not justify another model call. HTTP/provider failures, incomplete
   output, malformed self-checks and invalid citations fail explicitly with
   **no** automatic retry or fallback model.
5. Every pass reserves a durable call allowance and a session call slot
   **before** dispatch. Both passes share the original 45-second deadline.
   Revocation, sign-out, origin/consent checks and shutdown still apply.
   Budget exhaustion between passes returns an error, never an unchecked
   first-pass draft. Only the final answer enters the session history.

The UI sends the selected mode and reports the models used, number of passes
and review verdict after the complete response. It does not claim live
streaming visibility into the router. A mode change alone sends no request.

## Learning with steward approval

This is **review-gated routing feedback, not autonomous training**. DBusker
does not rewrite instructions, change model assignments, ingest conversations
as knowledge, or share a visitor's chat with another visitor.

The existing private SQLite database stores aggregate provider-pass counters,
keyed only by handoff fingerprint, fixed mode/task/tier, configured model,
attempt number and fixed outcome code. Counters accumulate latency,
provider-reported input/output tokens and counts of calls with missing usage.
Failed or cancelled calls still spend the allowance; their unknown tokens are
not silently estimated as zero-cost. There are no per-request rows, individual
timestamps, prompts, draft/final answers, signatures, session IDs or wallets.
No-match answers make no provider call and are not counted as provider samples.
There is no public statistics endpoint or automatic export.

After starting the service once to initialize its tables, run locally:

```sh
cd agent-service
npm run routing:report
```

The command loads `.env`, opens the private database read-only and reports only
the current handoff fingerprint. It does not contact OpenAI, change the policy,
approve a handoff, reset budgets or publish anything. Keep reports private.

Recommendations require at least **20 first-pass samples per route** by
default; second passes cannot inflate that threshold. At a provider-error rate
of **10%** across all passes (including escalation failures), investigate
configuration/provider issues first. The report also shows deeper-pass
ready/cancellation counts, mean provider latency and token totals. At an
evidence-limit rate of **25%**, review source coverage instead of buying more
compute. At a deeper-review rate of **25%**, test a higher starting tier in
Balanced against the same steward evaluation questions. These rates are
review triggers, not statistical proof of improvement. Low review rates do
not prove correctness, justify automatic downgrades, or establish optimality.
Token totals with missing usage are lower bounds, not dollar costs.

Compare correctness/citations, helpfulness, latency and actual token usage on
the evaluation set. Approve a routing change only when that evidence supports
it. Edit the reviewed policy, rerun tests/retrieval, review the new fingerprint,
explicitly approve it and restart. Counters never activate a recommendation.
Each new fingerprint begins a separate report cohort; older aggregate rows
remain private and do not reset or refill the lifetime call budget.

## Companion look and sound

The drawer borrows DJuke's platinum finish and cyan/mint palette, with an
inside avatar, the welcome "How can I help you, Earthling?", and seven
illustrated community paths. Paths only draft questions; they do not send,
sign, connect a wallet, or promise rewards. Public guides and bunny routes
remain available in the expandable field notes.

Companion chimes are **off by default** and can be enabled with the drawer's
Sound button for the current page session only. Short, quiet synthesized notes
respond to opening the drawer or selecting a path; no speech, loops, remote
sound files, or model-reply autoplay. Chimes are skipped while an audible
audio/video element is playing, stopped when media starts or the page becomes
hidden, and cancelled when the drawer closes or a blocking overlay appears.
They do not change the radio's source, playback, volume or wallet flow.
Motion respects the system's reduced-motion preference.

## Access, privacy and shutdown

- Pilot supports ordinary externally owned accounts. Smart-contract wallets,
  delegated keys and universal-signature schemes are not supported yet.
- Sessions use random bearer tokens held only in browser memory. No tokens,
  prompts, signatures or addresses are placed in local storage or routine
  request logs. The dismissal preference alone uses local storage.
- Chat history stays in server memory, bounded to recent turns and a
  15-minute session. It is not sent to another session or saved to SQLite.
  Closing the drawer does not sign out. **Clear chat & sign out**, consent
  withdrawal, account changes and disconnects clear the browser conversation
  and attempt server-session deletion. If offline, the session expires.
- Removing a wallet blocks its next protected request and aborts in-flight
  work within about one second. Pausing `access.json` does the same globally.
  A provider may still bill already-started work after a cancellation.
- Set `access.json.enabled=false` for an immediate operational pause; set
  `DBUSKER_ENABLED=false` and restart for a deployment-level disable. Also
  disable the site launcher if appropriate. None of these stops the radio.
- The allowlist and approval are private ignored files. Keep them out of
  static-site publishing and Git. Protect them and the database with host
  filesystem permissions. No on-chain allowlist is used.
- Human handoff is currently guidance/drafting only. Visitors choose whether
  and where to share it. No transcript is automatically sent to Discord,
  GitHub, a maintainer or another user.
- Chat access is not contributor reward enrollment, recipient approval or
  artist/pinner eligibility. The public Contributor Request form links a GitHub
  handle to a payout wallet publicly; DBusker must explain that before helping
  someone submit it. It cannot whitelist contributors or grant a bounty.

## Bounds and deployment

The pilot uses one Node process/replica with a persistent writable volume for
`state.sqlite` and private configuration. HTTPS must terminate at a trusted
reverse proxy. Set `DBUSKER_HOST=0.0.0.0` only when needed by the host. Do not
expose a public unauthenticated proxy to localhost or the wallet service.

The SQLite call allowance is durable and atomically reserved **before** each
provider request. `DBUSKER_MAX_CALLS` defaults to 100 lifetime requests for that
database, including failed/cancelled calls. Restarting does not refill it.
Do not delete the database to work around an exhausted allowance; a steward
must deliberately review spending before increasing the configured ceiling.

Additional bounds: at most three active calls, one per session; six requests
per wallet per minute; 20 provider calls per session, including deeper passes;
2,000-character questions; 28,000 UTF-8 bytes of instructions/evidence/context
per pass; 800 maximum output tokens per pass; 45-second whole-question model
deadline, shared by both passes. Challenge/signature endpoints are also IP-limited.
The service does not trust forwarded IP headers, so a reverse proxy can make
the sign-in limit shared by visitors. Review proxy-level limits before launch.

**A call/token envelope is not a dollar billing cap.** Confirm current model
pricing and provider spending controls, use a dedicated project, and select an
allowance you can afford at the maximum request size. Provider budget alerts
are not necessarily hard spending limits. Never describe this pilot as having
a verified monetary ceiling. Multi-replica session storage, external abuse
protection and expanded access require further work.

Responses are delivered as complete JSON answers after citation-ID validation,
not token-by-token streams. The UI explicitly shows a waiting state. This is
intentional for the first pilot: incomplete or invalid citations are not
presented as finished answers. Citation validation checks membership in the
approved excerpts; it does not prove that the prose accurately interprets them.
Human factual evaluation remains essential.

## Community context and updating knowledge

The central frame is **how people participate and how value reaches them**:

- Repo development: a useful issue/test, agreed bounty, contributor request,
  accepted work, queue and owner-authorized settlement are separate stages.
- IPFS: additional available community copies are useful, but at the indexed
  baseline the UI explicitly marks availability rewards **not active**. An
  allocation algorithm or funded pinner pot is not a public payout program.
- Top 10, Playback and Live Performance: explain their distinct qualification,
  allocation, review, funding, escrow/earmark and actual transfer/claim stages.
- DVert: distinguish campaigns and optional priority from settled fund deposits,
  then from final artist/builder payments. Trace evidence, not just percentages.
- DJuke, playlists, collaborators and albums: listener choices, save versus pay,
  personal versus radio, rights/consent, splits and version-specific delivery.
- Bunny tutorials: general tour, playlist hops, splits and the payroll/fund proof
  walkthrough are actual teaching sources, not invented UI instructions.
- Independent communities: help people learn enough to maintain their own
  beacon while respecting artists, attribution and operational independence.

### Jolly, the seed, and handing responsibility onward

The [reviewable stewardship guide](../agent-service/handoff/stewardship.md)
recognizes **Jolly**, **TheJollyLaMa/thejollylama** and **jollyEast**, including
questions about "the one who made all this." These aliases and the seed image
are supplied by the steward in this handoff, not independently verified
identity/wallet facts. Public attribution comes from [NOTICE](../NOTICE),
which also credits contributors. DBusker must not invent a biography, attach
private wallets to a name, or erase other people's work.

The center of the seed is Jolly's picture of interdependence: roots sustain
shoots, shoots sustain roots; creative expression needs infrastructure and
infrastructure needs a community worth sustaining. Accountable resources
support that shared life and the next generation of independent centers.
It is not a token promise, a payout formula, a biological theory or a reason
the founder must remain indispensable. DBusker should offer the metaphor when
relevant, then a practical next step.

The assistant distinguishes duties from the person currently performing them:

| Surface | Documented dependency / next handoff question |
| --- | --- |
| Minting/catalog | [Owner-reviewed mint flow](../README.md); submission is not approval or a confirmed mint. |
| Artist/repo funds | [Payroll review and settlement](./PAYROLL.md), contributor/asset eligibility and [contract roles](./CONTRACTS.md); estimates or allocations are not unattended transfers. |
| Operator services | [Worker/Discord/IPFS setup](../discord-bot/README.md), scheduler/fulfiller role, uptime, gas, checkpoints and backups. |
| Releases and accounts | Inventory repository, frontend/backend, domain/DNS, Discord, storage, RPC, billing and incident-response custody with the operators. A code snapshot does not identify their current account holders. |
| DBusker itself | Steward-controlled invitations, provider account, approval/routing review and durable usage allowance; this pilot still supports EOA login only. |

This is a map of dependencies documented at the pinned baseline, **not** a
current ownership audit. DBusker cannot establish that Jolly personally holds
every role today or that another operator has already taken over.

For a new center, teach a staged fork: retain code licenses/NOTICE and credit;
use distinct branding unless separately permitted; ask artists about their
recordings. Start local/read-only. Choose the modules actually needed, establish
the new operators' own infrastructure, secrets and budgets, and deliberately
replace original origins, addresses, roles, channels and deployment settings
before enabling paid actions. Shared contracts remain a dependency; cloned code
does not copy treasury balances, approvals, accounts, users or content rights.
Independent contract deployment/configuration and rehearsed recovery are
separate work, not consequences of pressing Fork.

For multisig, do **not** say "change one address" or prescribe
`transferOwnership` for every contract. Inspect each version's verified source,
chain, current roles, role admins, pause/recovery powers and immutable settings.
Agree independent signers, threshold, recovery and emergency procedures with
the new community. Rehearse grant -> execute representative operations ->
verify authority/events -> retire old roles only after approval. Role grants
and old EOA powers must be checked individually.

The current [worker authorization](../discord-bot/ipfs-worker.js) includes
`verifyMessage` / `verifyTypedData` EOA recovery and comparisons with the
configured owner. A contract-wallet owner cannot satisfy those paths merely
by having one of its signers sign personally. Contract-signature validation
(such as ERC-1271 where appropriate), connection/proposal/execution UX,
receipt reconciliation and DBusker authentication need separate implementation
and tests. Time-sensitive worker actions may still need tightly scoped
automation rather than a multisig vote per song. Hosting, releases, storage,
curation and billing need their own shared operating arrangements.
**No multisig integration, role grant, signature or migration was performed
by adding this teaching guide.**

Stewardship text is fingerprinted with the handoff but appended to model
instructions **only** for matching founder, independence, governance or seed
questions and short topic-follow-ups. It uses the same topic matcher as public
retrieval, not another paid classifier. Unrelated playlist questions do not
pay for this extra context. It remains steward orientation, not a fabricated
GitHub source or an addition to the public snapshot. Project facts still need
actual retrieved public evidence. Both ordinary and deeper passes fit their
exact serialized context to the same 28,000-byte limit; evaluation checks run
against the fitted evidence, not the larger pre-trimming candidate set.

The drawer offers seven optional question starters. Selecting one only drafts
a question; it never signs, submits an issue, sends a prompt, makes a purchase
or enrolls anyone in a rewards program. No live model call is made before
consent and wallet authentication.
The same optional section links to the existing playlist, collaborator and fund
bunny guides plus public issue/contributor forms. Links open in new tabs and
the contributor link discloses its public wallet/handle association.

The [snapshot command](../agent-service/handoff.mjs) now enumerates the complete
public Git tree. Its [coverage policy](../agent-service/knowledge.mjs) indexes
eligible first-party source, tests, docs, workflows, markup/styles, licenses and
configuration. At public commit `951374b93d3875342d3bf269a834b984bf998ae6`,
**324 text files** are included. Every tracked file has a manifest entry with
its public blob identity, size and either chunk count or exclusion reason.

The **21 explicit exclusions** cover creative/binary assets, credential-style
files (including environment examples), dependency lockfiles, generated
operational reports and individual contributor/accounting records. A future
snapshot also excludes the generated knowledge file itself to avoid recursive
ingestion. These boundaries apply even to a closed, allowlisted trial:
restricted chat access is not a reason to ingest secrets or other people's
records. The snapshot contains public source text; it does not grant reuse
rights to artist recordings or brands.

**Repo-wide searchable context is not the whole repo in every prompt.** The
service builds a local term-frequency/inverse-frequency index at startup.
Queries include code-symbol/camel-case tokens, reviewed topic vocabulary,
specific entry-point evidence, and the previous user question for short
follow-ups. It supplies at most eight excerpts, at most three per file, each
at most 1,800 UTF-8 bytes. Total instructions/evidence/history retain the
28,000-byte request ceiling. Older conversation pairs are removed first while
retaining the latest pair; lower-priority evidence is then removed if needed,
and only then the latest conversation pair if it cannot fit. No-match queries supply no
invented fallback source. Evidence references remain commit/file/line anchored.
The byte check uses the exact serialized instructions/input shape sent to
Responses, including the evidence wrapper and JSON escaping; fixed request
options and the output schema are outside that context ceiling.

Repo discussions, current issue/PR contents, live balances/deployments, other
repositories and uncommitted work are not included. Stale or conflicting
version/deployment claims in public docs must be identified, not reconciled by
guessing. Public Git history cannot establish whether a current bounty or a
specific payout is available.

From `agent-service`, after fetching public `origin/main`:

```sh
npm run snapshot -- <full-public-commit-sha>
npm run review
npm run evaluate:retrieval
```

The command verifies the public DecentBusking origin and only accepts a commit
reachable from fetched `origin/main`. It reads committed public blobs, not
local working copies. Check that the
origin really is the public DecentBusking repository before capture.
The snapshot records commit, time, source file, line and public URL.
Snapshot creation does not approve it. Do not add credentials, personal records,
private Discord or local worktree content. Public-source availability does not
grant rights to republish contributed recordings or reuse branding.

## Validation and reuse decision

Run the focused checks from the repository root:

```sh
node --test agent-service/test/*.test.mjs test/tutorial.test.js test/header-layout.test.js
git diff --check
```

Tests use ephemeral wallets and stubbed provider calls. Corpus tests compare
every indexed excerpt to its exact public Git blob, account for every tree
entry and exclusion, exercise long UTF-8 line bounds, and verify topic/evidence
retrieval including obscure code symbols and short conversational follow-ups.
They also check that the actual evaluation evidence fits the request ceiling.
Other checks cover authentication,
nonce reuse/expiry, wrong domains, consent, isolation, revocation and active
cancellation, durable quotas, handoff approval, Responses request shape,
evidence validation, disabled UI, tour deferral and wallet changes. They do
not validate a production provider, real model answer quality or deployment.

Reuse: adapt [the shared wallet state](../js/wallet.js) and defer to
[the existing tour](../js/tutorial.js); do not introduce another wallet manager.
The Canopy agency map led to the Apache-2.0
`jolly-sim-siddhi/server/routes/simSiddhiChat.js` reference at public commit
`9d2ab578e71a9c6cf8357e3f391f98420ce07b05`. Its global thread and CommonJS/beta
API runtime were incompatible with isolated community sessions; no donor code
was copied. This dedicated ESM service uses a supported HTTP Responses boundary,
single-purpose SIWE sessions and bounded stateless calls. Preserve Busking's
[NOTICE](../NOTICE) and individual content/artist permissions.

This expansion adapts the app's own public `951374b` baseline:
[contributor policy](./PAYROLL.md),
[pinning implementation](../js/pinner-rewards.mjs),
[fund bunny](../js/fund-tour.mjs) and
[playlist/split bunny](../js/tutorial.js). No second reward policy, wallet
manager or tutorial engine is introduced. Receiving-app checks include exact
public-tree coverage, required evidence for community questions, and existing
tutorial/header regressions. Real model conversations remain a steward-led
private test, not a result of these automated checks.

Stewardship reuse decision: consulted Canopy's role/treasury leads, existing
Busking worktrees, issue #291 and open PRs; adapted this app's public
`951374b` [NOTICE](../NOTICE), [payroll policy](./PAYROLL.md),
[contract inventory](./CONTRACTS.md) and
[worker EOA authorization](../discord-bot/ipfs-worker.js). Read-only comparison
with ArtFi's `contracts/ArtFiSettlementRouter.sol` at `843e770` and
DecentMarket's `contracts/DecentNFT_v0.3.sol` at `0b9349a` confirmed the need
for role-specific review, not a universal ownership-transfer recipe.
Those are separate contract implementations, not tested multisig integrations;
unrelated donor work was untouched and no donor code or private account data
was copied into the corpus. Reused the existing topic matcher and exact-context
fitter; new code only selects the reviewed teaching context. Receiving-app
checks cover all aliases, concrete dependency/auth evidence, two-pass context
limits, changed-guide approval invalidation and existing onboarding behavior.
No live model answer or decentralized deployment is certified by these tests.

Routing reuse decision: need bounded model selection and reviewed operational
feedback without visitor transcript storage. Rechecked Canopy's curated map,
the receiving feature branch/worktrees, current public issue #291 and open PR
list, and `jolly-sim-siddhi/server/routes/simSiddhiChat.js` at `e643800`
(committed source; unrelated local donor changes were left untouched). That
route uses a global beta Assistants thread and logs message/delta content; it
does not provide this pilot's isolated, privacy-preserving bounded router.
Build the small router here, reusing Busking's own `modelContext`, public
retriever, approval digest, durable SQLite allowance and wallet session checks.
No donor code was copied, no shared package is justified, and no public Canopy
snapshot was updated from private findings. Receiving-app tests exercise all
modes, review limits, per-pass quotas, policy invalidation, aggregate schema
and exact recommendation thresholds. Live model quality/optimality is still
unmeasured and must not be inferred from stubbed tests.
