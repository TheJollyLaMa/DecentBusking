export function formatUsdcUnits(units) {
  const value = typeof units === 'bigint' ? units : BigInt(units || 0);
  const magnitude = value < 0n ? -value : value;
  const cents = (magnitude + 5000n) / 10000n;
  return `${value < 0n && cents > 0n ? '-' : ''}${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}