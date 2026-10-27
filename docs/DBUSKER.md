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
- [Evaluation questions](../agent-service/handoff/evaluation.json): add the
  questions you want DBusker to handle, and what good answers should do.
- [Public excerpts](../agent-service/handoff/sources.json): generated from
  explicit public Git history, never from uncommitted local changes.

Review process:

1. Read and edit the voice and boundaries with the steward. Agree on invitation
   policy, EOA-only wallet support, the provider's data terms, operating costs,
   an actual human-contact route, and the community covenant before approval.
2. Run `npm run review` in `agent-service`. This prints the handoff fingerprint,
   source commit/date, and questions without contacting OpenAI.
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

Changing **any** of the four handoff files invalidates approval. A running
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

- In `.env`, set `OPENAI_API_KEY` from a dedicated provider project and choose
  a currently supported structured-output model in `DBUSKER_MODEL`.
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
per wallet per minute; 20 calls per session; 2,000-character questions;
28,000 UTF-8 bytes of instructions/evidence/context; 800 maximum output tokens;
45-second model deadline. Challenge/signature endpoints are also IP-limited.
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

## Updating knowledge

The explicit public file selection is in
[the snapshot command](../agent-service/handoff.mjs). It starts narrowly with
the README, whitepaper, newcomer guide, NOTICE, shared wallet and admin-access
module. This is not a whole-codebase index. Four keyword-ranked excerpts are
selected per question; missing knowledge must lead to uncertainty, not guesses.
Expand this reviewed list when the test conversations identify real gaps.

From `agent-service`, after fetching public `origin/main`:

```sh
npm run snapshot -- <full-public-commit-sha>
npm run review
```

The command only accepts a commit reachable from fetched `origin/main` and
reads committed files via `git show`, not local working copies. Check that the
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

Tests use ephemeral wallets and stubbed provider calls. They cover authentication,
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
