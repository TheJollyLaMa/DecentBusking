export const PAYROLL_TIME_ZONE = 'America/New_York';
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: PAYROLL_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

function parts(epoch) {
  return Object.fromEntries(formatter.formatToParts(new Date(epoch)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

function midnight(civil) {
  const target = civil.getTime();
  let epoch = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    const local = parts(epoch);
    const displayed = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    const next = epoch + target - displayed;
    if (next === epoch) return epoch;
    epoch = next;
  }
  throw new Error('Could not resolve New York payroll midnight');
}

export function payrollPeriodFromKey(key) {
  if (!/^NY-\d{4}-\d{2}-\d{2}$/.test(key || '')) throw new Error('Invalid New York payroll week');
  const date = new Date(`${key.slice(3)}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== key.slice(3) || date.getUTCDay() !== 1) throw new Error('Payroll weeks must start on a valid Monday');
  const end = new Date(date); end.setUTCDate(end.getUTCDate() + 7);
  const startAt = midnight(date);
  const endAt = midnight(end);
  return { week: key, timeZone: PAYROLL_TIME_ZONE, startAt: new Date(startAt).toISOString(), endAt: new Date(endAt).toISOString() };
}

export function currentPayrollPeriod(now = Date.now()) {
  const local = parts(Number(now));
  const monday = new Date(Date.UTC(local.year, local.month - 1, local.day));
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  return payrollPeriodFromKey(`NY-${monday.toISOString().slice(0, 10)}`);
}

export function payrollPeriods(count = 12, now = Date.now()) {
  count = Math.max(1, Math.min(52, Number(count) || 12));
  const current = currentPayrollPeriod(now);
  const monday = new Date(`${current.week.slice(3)}T00:00:00Z`);
  return Array.from({ length: Math.max(1, Math.min(52, count)) }, (_, index) => {
    const date = new Date(monday); date.setUTCDate(date.getUTCDate() - (count - index - 1) * 7);
    return payrollPeriodFromKey(`NY-${date.toISOString().slice(0, 10)}`);
  });
}

export function overlappingUtcWeeks(period) {
  return [...new Set([Date.parse(period.startAt), Date.parse(period.endAt) - 1].map(epoch => {
    const date = new Date(epoch); date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
    const year = date.getUTCFullYear();
    return `${year}-W${String(Math.ceil((((date - Date.UTC(year, 0, 1)) / 86400000) + 1) / 7)).padStart(2, '0')}`;
  }))];
}