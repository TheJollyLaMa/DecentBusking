export function fundBudgetFor(state, fundSlug, fallbackBalanceUnits = null) {
  const fund = state?.funds?.[fundSlug] || {};
  const category = fundSlug === 'dbusk-top10' ? 'top10' : 'playback';
  const weekly = state?.weekly?.funds?.[category];
  const balanceUnits = Object.hasOwn(fund, 'balanceUnits') ? fund.balanceUnits : weekly?.balanceUnits ?? fallbackBalanceUnits;
  const reservedUnits = weekly?.reservedUnits ?? fund.reservedUnits ?? null;
  let budgetUnits = /^\d+$/.test(String(weekly?.budgetUnits ?? '')) ? weekly.budgetUnits : null;
  if (balanceUnits == null || fund.balanceAvailable === false) budgetUnits = null;
  const shareBps = state?.weekly?.fundShareBps;
  if (fund.balanceAvailable !== false && budgetUnits != null && /^\d+$/.test(String(balanceUnits)) && /^\d+$/.test(String(reservedUnits)) &&
    Number.isInteger(shareBps) && shareBps > 0 && shareBps <= 10000) {
    const available = BigInt(balanceUnits) > BigInt(reservedUnits) ? BigInt(balanceUnits) - BigInt(reservedUnits) : 0n;
    budgetUnits = String(available * BigInt(shareBps) / 10000n);
  }
  return { balanceUnits, reservedUnits, budgetUnits };
}
