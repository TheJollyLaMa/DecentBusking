# Retired Payroll History

Historical ETH queue entries, settlement records, account totals, and browser receipt assignments are retained for audit. They are not displayed or payable in the active Base payroll panel and must not be relabeled as Base payments.

The retired Optimism flow used direct wallet transfers, not the Base router's replay-protected work references. Previously paid entries may remain in repository JSON until their exact confirmed transaction hashes are recorded through the Settle Payroll workflow. A repeated recipient/value does not identify the bounty: the owner must assign each confirmed transaction to its intended entry, with no transaction reused for two payouts.

The retired receipt helper and its tests are retained as historical tools, but active payroll no longer imports or invokes them. Stored browser receipts are not deleted by the transition. This release does not fabricate transaction hashes or mark historical entries settled without their receipts.