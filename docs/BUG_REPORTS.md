# Report a problem on GitHub

1. Invited DBusker chat visitors can ask for wording and use its **Report a bug
   on GitHub** button. Anyone can use the direct GitHub form linked below;
   filing there needs no wallet or DBusker invitation. There is no duplicate
   report entry in the left ankh menu.
2. Describe one problem: what happened, expected behavior, reproduction steps,
   impact, browser/device and affected page/control. Or paste your own wording.
3. Review the complete sanitized preview. Common secrets, URLs and address-like
   text are removed conservatively; this is not a comprehensive privacy detector.
   Never paste seeds, keys, private logs, signatures or another person's data.
4. Open the duplicate search and check open AND closed issues. Add evidence to
   an existing issue instead of filing the same problem twice. This is a manual
   check, not an automatic duplicate guarantee.
5. Confirm both duplicate and privacy checks. Copy the reviewed wording if
   wanted, then open the prefilled GitHub draft. Editing invalidates confirmation.
6. Sign into GitHub, review the final content and press **Submit new issue**.
   GitHub authenticates the author and applies its normal submission/abuse limits.
   The helper does not post, store drafts, read chat/wallet state or need a token.
   Only reviewed public evidence should be added on GitHub.

Direct fallback: [new bug report](https://github.com/TheJollyLaMa/DecentBusking/issues/new?template=bug-report.yml).
The template becomes available after merge to the default branch. Before that,
use [a blank new issue](https://github.com/TheJollyLaMa/DecentBusking/issues/new).
Two different problems mean **two separate issues**. Share those links in Discord
if you want help following up. Reporters do not choose bounty/approval labels.

## Owner review and complete closeout

Before rollout, ensure the repository has `bug` and `bug-catcher-pending` labels
so GitHub can apply the form's suggested labels. Normal public issue filing stays
open; only whitelisted, maintainer-approved first unique bug catchers can earn
the report reward. Add an eligible reporter through the existing contributor
onboarding process; wallets belong in the verified registry, not public reports.

In Actions -> **Review Bug Report**, use `main`, the issue number, an outcome,
and the original issue number for duplicates. Only the repository owner can run
the approval job. Read earlier reports, verify the first unique reporter and
eligibility before approving; a matching phrase is not proof of originality.
The workflow derives attribution from the authenticated author, checks the
whitelist and registered payout settings, applies review labels and posts an
audit comment. It never closes the issue or sends money. Negative outcomes
approve no bug-catcher reward; don't attach implementation bounties to spam.

Assign/approve any actual implementation bounty separately. A qualifying merged
fix queues at most one bug-catcher credit per issue/token across all ledger
sections. Pending reviews hold the allocation; after review, recover the merged
PR with **Bounty Bot** if needed. Review cannot change an allocated split.
AI/bot rewards must remain retain-in-fund. See [policy and splits](PAYROLL.md#labels):
the established 20% idea share is preserved, not silently changed to 10%.

Agents must read issue/comments, test acceptance, and use `Closes #N` only for
complete fixes, `Refs #N` for partial work. Honor explicit no-close/no-deploy
instructions. After merge, check issue status and the Bounty Bot result, recover
any missing ledger entry, and distinguish queued/retained/settled. Payroll alerts
are owner review prompts, not proof of payment. No new PAT is required: trusted
Actions use the built-in scoped `GITHUB_TOKEN`.

The DBusker handoff text also describes this flow. Changing its handoff digest
requires human review/reapproval and service restart; do not auto-approve it or
pretend this change updates the live assistant.

## Reuse decision

Need: a local draft/preview/confirmation flow without server posting, opened
from DBusker rather than adding a redundant header-menu entry.
Adapted sanitizer/draft mechanics from
`BigNuten_Vanilla/js/issueHelper.js` (`sanitizeIssueText` equivalent), inspected
read-only in its uncommitted state, not a tested public commit integration.
Both repositories use Apache-2.0; donor attribution is retained in NOTICE.
Health-specific flows, optional address disclosure and unrelated integrations
were not reused. DecentCanopy's curated agency map and the original Busking
reporter/payroll draft were inspected; this is not a whole-library inventory.
The original checkout remains untouched. Receiving-app verification uses the
focused issue-draft/helper, review/payroll and backlog-alert tests.
