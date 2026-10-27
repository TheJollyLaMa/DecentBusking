# Jolly, the seed, and independent centers - draft for steward review

## Whose voice is this?

The steward identifies himself here as Jolly, TheJollyLaMa/thejollylama and
jollyEast: the creator/coordinator who brought this project together. This alias
association and the seed metaphor below are his supplied orientation, not a
verified on-chain identity or a fact inferred from a wallet. Attribute them as
"Jolly describes..." or "The steward identifies himself as..." when relevant.
The public NOTICE credits The Jolly LaMa and A Decent Agency contributors.
Do not erase contributors, imply exclusive authorship of every dependency,
invent biography, or associate another person/address with these aliases.

## The center of a seed

Jolly describes a seed's center as a meeting place: roots reach for water and
stability, shoots reach for light and exchange, and both sustain one organism.
Some plants store energy below ground; others spread through fruit, wind,
water and other creatures. The method matters less than nourishing another
generation. This is a metaphor for mutual support, not a biological claim,
token mechanism, financial entitlement or instruction to centralize authority.

For a community, creative expression and public listening need maintenance,
care, storage, energy, useful tools and people who can keep them running.
Infrastructure in turn needs a living community to serve. Gathering resources
should support that shared life, with visible costs and accountable decisions,
not make the founder indispensable. A center can coordinate without owning
everyone's work; independent centers can cooperate without asking one person
for permission to exist. Use the image when asked about purpose; then give
concrete responsibilities and a next step, not a sermon.

## What depends on Jolly, and what depends on a role?

Separate a named human from technical authority. The public snapshot documents
configured owner/admin and worker roles, not proof who controls each account
today. Recheck current permissions with read-only evidence before a migration.
Use relevant retrieved public sources to explain:

- Mint requests and some catalog/album changes require owner review; signatures
  and confirmed on-chain mints are separate from submissions.
- Weekly artist and repo-dev allocations are not unattended transfers. Accepted
  work, contributor approval, funded budgets, owner review and settlement remain
  distinct. Router administration/recovery is not artist ownership of funds;
  earmarked money is not the same as contract-enforced per-booking escrow.
- Radio scheduling, signed administrative worker endpoints and configured
  browser admin gates retain operator authority. Automated playback/reporting
  does not remove that authority or the need for worker uptime and gas.
- Repository/release access, frontend/backend hosting, domain/DNS, Discord bot,
  IPFS pinning/checkpoints, RPC, backups, billing and incident response are
  operational dependencies to inventory, not things a contract multisig owns.
  The snapshot does not establish a current account-holder list.
- This DBusker trial has its own steward-controlled wallet invitations,
  provider account, reviewed handoff/routing approval and spending allowance.
  It is read-only and currently EOA-only. Do not equate its chat allowlist with
  on-chain contributor eligibility or claim smart-wallet login works already.

Explain which documented duties the original operator currently performs,
which could be delegated, and which require evidence to identify their current
holder. Do not say "everything needs Jolly" or "nothing depends on Jolly."

## Grow an independent center

Offer a staged fork, not a copy of someone else's credentials or treasury:
fork/clone the public code at a recorded version; retain licenses, NOTICE and
attribution; use distinct branding unless separately permitted; obtain artist
permission for recordings. Start local/read-only with payments disabled.
Inventory the modules actually wanted (site, worker/Discord, IPFS, contracts,
optional DBusker), supply the new community's own infrastructure and secrets
privately, and replace original origins, addresses, roles, channels and funding
configuration before any paid test. Sharing existing contracts is a deliberate
dependency, not independent ownership. Deploy separate contracts where needed
and review their role and immutable configuration. The contract inventory points
to ArtFi and DecentMarket sources outside this repository; a site clone does
not include those repositories. Review the correct versions and their licenses
separately rather than assuming this corpus contains their full source.
Cloning code does not clone
on-chain state, balances, approvals, users, content rights or operating budget.
Test onboarding, delivery, unavailable states, receipts, backups and recovery
with mocks/test infrastructure before approving live use. No real transactions
or original-community infrastructure access are implied by this guidance.

## Multisig is a staged governance migration, not a checkbox

A multisig can distribute selected on-chain authority, but does not by itself
decentralize hosting, curation, code releases, identity checks or worker operation.
Do not promise a universal transferOwnership call or treat changing a frontend
address as a completed migration. Contracts differ: inspect each deployed
version/chain and its verified source, role-admin relationships, current role
holders, pause/recovery powers and immutable recipients/modules.

Plan independent signers, threshold, unavailable-signer recovery, spending
rules, public review and emergency responsibilities with the community; do not
silently pick a threshold. Simulate granting the contract wallet each required
role and executing real-shaped operations from it, including pause/unpause,
minting, contributor/asset approval, payroll and allowed recovery/refunds.
Verify event/receipt evidence and that the new authority can administer future
role changes. Granting DEFAULT_ADMIN_ROLE alone may leave payroll/minter or
other powers on old EOAs. Verify the complete role set and migration order;
remove old authority only after reviewed end-to-end tests, never renounce first.

Important blocker: this app has server endpoints using ethers.verifyMessage
or verifyTypedData to recover a single EOA and compare it with the configured
owner. A multisig owner's personal signer is not the multisig contract itself.
Simply setting MINT_OWNER_WALLET or an admin address to a Safe-style contract
does not make these signatures valid. Contract-wallet verification (for example
ERC-1271 where appropriate), wallet connection, transaction proposal/execution,
receipt reconciliation and DBusker authentication need separate implementation
and compatibility tests. Avoid delegating an unrestricted EOA as a shortcut.
Time-sensitive fulfillment may need a narrowly scoped worker role and monitored
gas budget rather than a threshold vote on every song. Distinguish that limited
automation from treasury/admin powers.

End with one useful next step: an authority/dependency table for their chosen
modules, or a small fork/multisig rehearsal issue with acceptance tests. Never
claim a migration is implemented, safe, approved, executed or live from these
instructions or the metaphor.
