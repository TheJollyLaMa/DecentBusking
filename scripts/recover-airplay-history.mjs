import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { datedAirplayEvent } from '../discord-bot/airplay-calendar.js';
import { currentPayrollPeriod, newYorkDay } from '../js/payroll-week.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const shiftDay = (day, offset) => new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);

export async function recoverDatedAirplay(snapshots, { through }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(through || '') || shiftDay(through, 0) !== through) throw new Error('Invalid recovery cutoff');
  const events = new Map(), days = new Map(), sources = [];
  let reference, referenceCid;
  for await (const { snapshot, cid } of snapshots) {
    const checkpoint = snapshot?._checkpoint;
    if (checkpoint?.policy !== 'daily-v1' || checkpoint.timeZone !== 'America/New_York' ||
      !Array.isArray(checkpoint.events) || !Array.isArray(snapshot.playlist) ||
      !Number.isFinite(Date.parse(checkpoint.savedAt)) || shiftDay(checkpoint.day, 0) !== checkpoint.day) throw new Error('Invalid radio daily checkpoint');
    if (!reference || Date.parse(checkpoint.savedAt) > Date.parse(reference._checkpoint.savedAt)) {
      reference = snapshot; referenceCid = cid;
    }
    if (checkpoint.day > through) continue;
    sources.push({ cid, day: checkpoint.day, sha256: hash(snapshot) });
    days.set(checkpoint.day, { date: checkpoint.day, coverage: 'partial', tracks: new Map() });
    for (const event of checkpoint.events) {
      const dated = datedAirplayEvent(event);
      if (!dated || dated.metric !== 'plays' || dated.day > through) continue;
      const previous = events.get(dated.key);
      if (previous && previous.day !== dated.day) throw new Error('Conflicting finish dates for the same radio airing');
      events.set(dated.key, dated);
    }
  }
  if (!reference || !events.size) throw new Error('No dated qualifying airings found');
  for (const event of events.values()) {
    if (!days.has(event.day)) days.set(event.day, { date: event.day, coverage: 'partial', tracks: new Map() });
    const tracks = days.get(event.day).tracks;
    tracks.set(event.trackId, (tracks.get(event.trackId) || 0) + 1);
  }
  const weeks = new Map();
  for (const day of days.values()) {
    const week = currentPayrollPeriod(Date.parse(`${day.date}T12:00:00Z`)).week;
    if (!weeks.has(week)) weeks.set(week, new Map());
    const totals = weeks.get(week);
    for (const [trackId, plays] of day.tracks) totals.set(trackId, (totals.get(trackId) || 0) + plays);
  }
  const reconciliation = [];
  for (const [week, actual] of weeks) {
    const expected = new Map((reference.playlist || []).filter(t => t.payrollPlays?.[week] > 0)
      .map(t => [t.trackId, t.payrollPlays[week]]));
    const dates = Array.from({ length: 7 }, (_, index) => shiftDay(week.slice(3), index));
    const complete = dates.every(day => days.has(day) && day <= through) && expected.size > 0 &&
      [...new Set([...actual.keys(), ...expected.keys()])].every(id => (actual.get(id) || 0) === (expected.get(id) || 0));
    if (complete) for (const date of dates) days.get(date).coverage = 'tracked';
    reconciliation.push({ week, complete, dated: [...actual.values()].reduce((a, b) => a + b, 0),
      accounted: [...expected.values()].reduce((a, b) => a + b, 0) });
  }
  return { schemaVersion: 1, timeZone: 'America/New_York', through,
    reference: { cid: referenceCid, savedAt: reference._checkpoint.savedAt, sha256: hash(reference) }, sources,
    reconciliation: reconciliation.sort((a, b) => a.week.localeCompare(b.week)),
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map(day => ({ ...day,
      tracks: [...day.tracks].sort(([a], [b]) => a.localeCompare(b)).map(([trackId, plays]) => ({ trackId, plays })) })) };
}

async function recover({ through, output }) {
  if (!process.env.PINATA_JWT) throw new Error('PINATA_JWT is required for read-only archive discovery');
  if (!through || through >= newYorkDay(Date.now())) throw new Error('Recovery must stop before today in New York');
  if (!output) throw new Error('An output path is required');
  const { discoverPinataMetadataGateway, buildGatewayUrl } = await import('../discord-bot/mint-sync.js');
  const headers = { authorization: `Bearer ${process.env.PINATA_JWT}` };
  const files = [], tokens = new Set();
  let token;
  do {
    const url = new URL('https://api.pinata.cloud/v3/files/public');
    url.searchParams.set('name', 'decentbusking-jukeloop-state');
    url.searchParams.set('order', 'DESC'); url.searchParams.set('limit', '100');
    if (token) url.searchParams.set('pageToken', token);
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Radio archive inventory failed (${response.status})`);
    const result = await response.json();
    if (!Array.isArray(result.data?.files)) throw new Error('Invalid radio archive inventory');
    files.push(...result.data.files.filter(file => file.keyvalues?.app === 'decentbusking' &&
      (file.keyvalues.historyPolicy === 'weekly-history-v1' || file.keyvalues.checkpointDay)));
    token = result.data.next_page_token;
    if (token && tokens.has(token)) throw new Error('Repeated inventory page');
    if (token) tokens.add(token);
  } while (token);
  const gateway = await discoverPinataMetadataGateway({ pinataJwt: process.env.PINATA_JWT });
  async function* snapshots() {
    for (const file of files) {
      console.info(`Reading radio archive ${file.name}`);
      const response = await fetch(buildGatewayUrl(gateway, file.cid), { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`Radio archive read failed (${response.status})`);
      const body = await response.json();
      if (file.keyvalues.historyPolicy === 'weekly-history-v1') {
        if (body.schemaVersion !== 1 || body.policy !== 'weekly-history-v1' || body.kind !== 'jukeloop-state' ||
          body.timeZone !== 'America/New_York' || !Array.isArray(body.days)) throw new Error('Invalid weekly radio archive');
        for (const entry of body.days) {
          if (hash(entry.snapshot) !== entry.sha256 || entry.day !== entry.snapshot?._checkpoint?.day) throw new Error('Radio archive day hash mismatch');
          yield { snapshot: entry.snapshot, cid: file.cid };
        }
      } else yield { snapshot: body, cid: file.cid };
    }
  }
  const result = await recoverDatedAirplay(snapshots(), { through });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result) + '\n');
  console.info(JSON.stringify({ days: result.days.length, from: result.days[0]?.date, through, reconciliation: result.reconciliation }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = new Map(process.argv.slice(2).map(arg => { const at = arg.indexOf('='); return [arg.slice(0, at), arg.slice(at + 1)]; }));
  recover({ through: args.get('--through'), output: args.get('--output') }).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
