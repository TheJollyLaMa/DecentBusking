# Issue delivery and contributor credit

- Read the issue and comments; preserve approved bounty, idea and bug-catcher attribution.
- Bug reporters submit on GitHub themselves. DBusker's **Report a bug on GitHub** helper
  drafts and sanitizes text; it never creates an issue or approves rewards.
- Do not add payout/approval labels yourself or guess an amount. The owner uses
  **Actions -> Review Bug Report** to approve the first unique whitelisted reporter
  or record duplicate/rejected/spam/self-reported/maintainer-discovered with no
  bug-catcher payout. Bot credit remains `retain-in-fund`.
- Link a complete fix with `Closes #N` in the PR body. For incomplete work use
  `Refs #N`, describe the remaining acceptance checks and do not close the issue.
  Cross-repository references must use `owner/repo#N`.
- Run focused tests and report what was actually verified. Deployment, real-user
  rehearsal and payment proofs are separate; never claim an unperformed check.
  Follow task-specific instructions that prohibit closure or deployment.
- Before requesting closeout, verify the linked PR merged and Bounty Bot succeeded
  (or explicitly report blocked/missing-bounty/pending-review). Merely closing an
  issue does not queue payroll. Use **Bounty Bot** manual recovery with the merged
  PR and issue number if needed; never queue the same credit twice.
- Repo-dev payroll backlog is tracked by **Repo Payroll Alerts** and in the owner's
  Payroll menu. Queued/retained/paid are different states. Only the owner confirms
  transfers; never move funds or mark settled without exact confirmed Base proof.
