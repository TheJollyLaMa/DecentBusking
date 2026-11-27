import { currentPayrollPeriod, newYorkDay, payrollPeriodFromKey } from '../js/payroll-week.mjs';

const metrics = ['plays', 'votes'];
const civil = day => new Date(`${day}T00:00:00Z`);
function shiftDay(day, offset) {
  const date = civil(day);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
function monthStart(day, offset) {
  const date = civil(`${day.slice(0, 7)}-01`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 10);
}

export function countDatedAirplay(track, day, metric, count) {
  track.airplayDays ||= {};
  if (!track.airplayDays[day]) {
    const oldest = monthStart(day, -11);
    for (const previous of Object.keys(track.airplayDays)) if (previous < oldest) delete track.airplayDays[previous];
  }
  const entry = track.airplayDays[day] ||= {};
  entry[metric] = (entry[metric] || 0) + count;
}

// Only bootstrap tracks without the new counters. A restored journal can contain retries
// and non-qualifying plays; its capture date is not necessarily the airing's finish date.
export function seedDatedAirplay(playlist, journal = []) {
  const tracks = new Map(playlist.filter(t => !t.airplayTrackingSince).map(t => [t.trackId, t]));
  const seen = new Set();
  for (const e of journal) {
    const track = tracks.get(e.trackId);
    const dated = datedAirplayEvent(e);
    if (!track || !dated || seen.has(dated.key)) continue;
    seen.add(dated.key);
    countDatedAirplay(track, dated.day, dated.metric, dated.value);
  }
}

export function datedAirplayEvent(e) {
  if (!e.trackId || !e.id) return null;
  const play = e.type === 'play';
  if (play ? !e.playId || e.qualified !== true || !Number.isFinite(e.audibleMs) || e.audibleMs < 30_000
    : e.type !== 'vote' || (e.source === 'site' ? ![1, -1].includes(e.vote)
      : e.source !== 'discord' || !Number.isSafeInteger(e.likesDelta) || !Number.isSafeInteger(e.dislikesDelta))) return null;
  const time = Date.parse(play ? e.endedAt : e.source === 'discord' ? e.observedAt : e.occurredAt);
  const value = play ? 1 : e.source === 'discord' ? e.likesDelta - e.dislikesDelta : e.vote;
  if (!Number.isFinite(time) || !Number.isSafeInteger(value)) return null;
  return { trackId: e.trackId, key: JSON.stringify([e.trackId, e.type, play ? e.playId : e.id]),
    day: newYorkDay(time), metric: play ? 'plays' : 'votes', value };
}

function addRows(rows, trackId, metric, value) {
  const row = rows.get(trackId) || { trackId };
  row[metric] = (row[metric] || 0) + value;
  rows.set(trackId, row);
}

// Reporting only: no IPFS traversal or changes to weekly accounting on a page open.
export function buildAirplayCalendar(playlist, { wallet, now = Date.now(), dayWeek, history = [] } = {}) {
  const today = newYorkDay(now), first = monthStart(today, -11);
  if (dayWeek) payrollPeriodFromKey(dayWeek);
  const firstDaily = dayWeek ? dayWeek.slice(3) : shiftDay(today, -13);
  const lastDaily = dayWeek ? shiftDay(firstDaily, 6) : today;
  const days = new Map(), months = new Map();
  for (let day = first; day <= today; day = shiftDay(day, 1)) {
    days.set(day, { rows: new Map(), evidence: new Set() });
    const month = day.slice(0, 7);
    if (!months.has(month)) months.set(month, { rows: new Map(), plays: [], votes: [] });
  }
  const starts = field => playlist.map(t => t[field]).filter(Boolean).sort()[0];
  const since = starts('airplayTrackingSince'), weeklySince = starts('payrollTrackingStartedAt');
  const sinceDay = since && newYorkDay(Date.parse(since));
  const weeklySinceDay = weeklySince && newYorkDay(Date.parse(weeklySince));
  const archived = new Map(history.map(day => [day.date, day]));
  const archivedTracks = new Map();
  for (const day of history) for (const row of day.tracks) {
    if (!archivedTracks.has(row.trackId)) archivedTracks.set(row.trackId, {});
    archivedTracks.get(row.trackId)[day.date] = { plays: row.plays };
  }
  const weeks = new Map(), thisWeek = currentPayrollPeriod(now).week.slice(3);
  for (const track of playlist) {
    const inScope = !wallet || track.mintRecipient?.toLowerCase() === wallet.toLowerCase();
    const dated = { ...archivedTracks.get(track.trackId) };
    for (const [day, counts] of Object.entries(track.airplayDays || {})) {
      // Closed-day archive and live counters overlap; adding them would double-count.
      dated[day] = { ...counts, ...(dated[day] ? { plays: Math.max(dated[day].plays, counts.plays || 0) } : {}) };
    }
    for (const [day, counts] of Object.entries(dated)) {
      const bucket = days.get(day);
      if (!bucket) continue;
      for (const metric of metrics) if (Object.hasOwn(counts, metric)) {
        bucket.evidence.add(metric);
        if (inScope) addRows(bucket.rows, track.trackId, metric, counts[metric]);
      }
    }
    for (const [metric, field] of [['plays', 'payrollPlays'], ['votes', 'payrollVotes']]) {
      for (const [week, count] of Object.entries(track[field] || {})) {
        const start = week.slice(3);
        if (!/^NY-\d{4}-\d{2}-\d{2}$/.test(week) || start > thisWeek) continue;
        if (!weeks.has(start)) weeks.set(start, { rows: new Map(), evidence: new Set() });
        const bucket = weeks.get(start);
        bucket.evidence.add(metric);
        if (inScope) addRows(bucket.rows, track.trackId, metric, count);
      }
    }
  }
  const daily = [], covered = new Map();
  for (const [start, week] of weeks) {
    const last = start === thisWeek ? today : shiftDay(start, 6);
    if (start < first || last.slice(0, 7) !== start.slice(0, 7)) continue;
    const month = months.get(start.slice(0, 7));
    for (const metric of week.evidence) {
      // Credit the week exactly once, never spread its total across individual days.
      for (let day = start; day <= last; day = shiftDay(day, 1)) {
        if (!covered.has(day)) covered.set(day, {});
        covered.get(day)[metric] = weeklySinceDay && start > weeklySinceDay ? 'tracked' : 'partial';
      }
      for (const row of week.rows.values()) if (Object.hasOwn(row, metric)) addRows(month.rows, row.trackId, metric, row[metric]);
    }
  }
  for (const [day, bucket] of days) {
    const coverage = {};
    const month = months.get(day.slice(0, 7));
    for (const metric of metrics) {
      const observed = bucket.evidence.size > 0 || day === today;
      coverage[metric] = observed && sinceDay && day > sinceDay ? 'tracked'
        : (observed && day === sinceDay) || bucket.evidence.has(metric) ? 'partial' : 'missing';
      if (metric === 'plays' && archived.has(day)) coverage.plays = archived.get(day).coverage;
      const weekly = covered.get(day)?.[metric];
      month[metric].push(weekly || coverage[metric]);
      if (!weekly) for (const row of bucket.rows.values()) {
        if (Object.hasOwn(row, metric)) addRows(month.rows, row.trackId, metric, row[metric]);
      }
    }
    if (day >= firstDaily && day <= lastDaily) daily.push({ date: day, coverage, current: day === today, tracks: [...bucket.rows.values()] });
  }
  const monthly = [...months].map(([date, month]) => ({
    date, current: date === today.slice(0, 7), tracks: [...month.rows.values()],
    coverage: Object.fromEntries(metrics.map(metric => [metric, month[metric].every(s => s === 'tracked') ? 'tracked'
      : month[metric].every(s => s === 'missing') ? 'missing' : 'partial'])),
  }));
  return { daily, monthly, history: historyBands(weeks, thisWeek, today, weeklySinceDay) };
}

// Group whole, consecutive accounting weeks into at most twelve bars, regardless of
// station age. Undated lifetime counts are never allocated to a bar.
function historyBands(weeks, thisWeek, today, weeklySinceDay) {
  const first = [...weeks.keys()].sort()[0];
  if (!first) return [];
  const weekMs = 7 * 86400000;
  const n = Math.round((civil(thisWeek) - civil(first)) / weekMs) + 1;
  const width = Math.ceil(n / 12), result = [];
  for (let i = 0; i < n; i += width) {
    const rows = new Map(), evidence = { plays: 0, votes: 0 };
    const count = Math.min(n - i, width), date = shiftDay(first, i * 7);
    for (let j = 0; j < count; j++) {
      const week = weeks.get(shiftDay(date, j * 7));
      if (!week) continue;
      for (const metric of week.evidence) evidence[metric]++;
      for (const row of week.rows.values()) for (const metric of metrics) {
        if (Object.hasOwn(row, metric)) addRows(rows, row.trackId, metric, row[metric]);
      }
    }
    const current = i + count === n;
    result.push({ date, through: current ? today : shiftDay(date, count * 7 - 1), current, tracks: [...rows.values()],
      coverage: Object.fromEntries(metrics.map(metric => [metric, !evidence[metric] ? 'missing'
        : evidence[metric] < count || !weeklySinceDay || date <= weeklySinceDay ? 'partial' : 'tracked'])) });
  }
  return result;
}
