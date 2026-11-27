import test from 'node:test';
import assert from 'node:assert/strict';
import { playbackWeekStory } from '../js/playback-week.mjs';
import { buildAirplayCalendar } from '../discord-bot/airplay-calendar.js';

const a = `0x${'a'.repeat(40)}`, b = `0x${'b'.repeat(40)}`, tx = `0x${'1'.repeat(64)}`;
const now = Date.parse('2026-11-27T12:00:00Z');
const report = { week: 'NY-2026-11-16', tracks: [
  { trackId: 'one', title: 'One', wallet: a, plays: 4 },
  { trackId: 'two', title: 'Two', wallet: a, plays: 0 },
  { trackId: 'three', title: 'Three', wallet: b, plays: 2 },
] };
const payment = (recipient, amountUnits, logIndex = 0) => ({
  recipient, amountUnits, txHash: tx, logIndex, timestamp: Date.parse('2026-11-23T12:00:00Z') / 1000,
});
const archive = entries => ({ fundSlug: 'dbusk-playback', payoutsAvailable: true, unmatchedPaidUnits: '0',
  weeks: [{ week: report.week, status: 'partial', entries }] });

test('a week separates repeat airings from distinct songs and dated gaps from observed zeros', () => {
  const days = [
    { date: '2026-11-16', coverage: { plays: 'partial' }, tracks: [{ trackId: 'one', plays: 1 }] },
    { date: '2026-11-17', coverage: { plays: 'tracked' }, tracks: [{ trackId: 'three', plays: 2 }] },
    { date: '2026-11-18', coverage: { plays: 'missing' }, tracks: [] },
  ];
  const station = playbackWeekStory({ report, days, now });
  assert.equal(station.airings, 6);
  assert.equal(station.songs, 2);
  assert.equal(station.points.length, 7);
  const personal = playbackWeekStory({ report, days, wallet: a.toUpperCase(), now });
  assert.equal(personal.airings, 4);
  assert.equal(personal.songs, 1);
  assert.deepEqual(personal.points.slice(0, 3).map(p => [p.value, p.coverage]), [[1, 'partial'], [0, 'tracked'], [null, 'missing']]);
  const future = playbackWeekStory({ report: { ...report, week: 'NY-2026-11-23', current: true }, days, now });
  assert.equal(future.points.at(-1).coverage, 'future');
});

test('payments belong to the earning week, retain actual later dates, and never leak another wallet’s income', () => {
  const p = payment(a, '1500000');
  const evidence = archive([
    { wallet: a, amountUnits: '2000000', paymentMismatch: true, payments: [p, p] },
    { wallet: b, amountUnits: '3000000', payments: [payment(b, '3000000', 1)] },
  ]);
  const station = playbackWeekStory({ report, archive: evidence, now }).funding;
  assert.equal(station.paid, 4500000n);
  assert.equal(station.pending, 500000n);
  assert.equal(station.disputed, true);
  const mine = playbackWeekStory({ report, archive: evidence, wallet: a.toUpperCase(), now }).funding;
  assert.equal(mine.paid, 1500000n);
  assert.equal(mine.rows.length, 1);
  assert.equal(mine.rows[0].payments.length, 1);
  assert.equal(mine.rows[0].payments[0].timestamp, p.timestamp);
  assert.ok(p.timestamp * 1000 > Date.parse(playbackWeekStory({ report, now }).period.endAt));
});

test('wrong-recipient evidence, missing allocations, unavailable indexing, and estimates cannot masquerade as payment', () => {
  const evidence = archive([{ wallet: a, amountUnits: '9000000', payments: [payment(b, '9000000')] }]);
  const result = playbackWeekStory({ report, archive: evidence, now }).funding;
  assert.equal(result.paid, 0n);
  assert.equal(result.pending, 9000000n);
  assert.equal(result.disputed, true);
  const noAllocation = playbackWeekStory({ report, archive: archive([]), now }).funding;
  assert.equal(noAllocation.allocated, true);
  const missing = playbackWeekStory({ report, archive: { ...archive([]), weeks: [] }, now }).funding;
  assert.equal(missing.allocated, false);
  assert.throws(() => playbackWeekStory({ report, archive: { ...evidence, payoutsAvailable: false }, now }), /indexing/);
  const estimates = { ready: true, chainId: 8453, timeZone: 'America/New_York', currentPeriod: { week: report.week },
    funds: { playback: { estimatedShares: [
      { wallet: a, amountUnits: '2000000', payable: true }, { wallet: b, amountUnits: '9999', payable: false },
    ] } } };
  const live = playbackWeekStory({ report, estimates, now }).funding;
  assert.equal(live.kind, 'estimate');
  assert.equal(live.paid, undefined);
  assert.equal(live.estimate, 2000000n);
  assert.equal(playbackWeekStory({ report, estimates, wallet: b, now }).funding.rows[0].belowMinimum, true);
  assert.throws(() => playbackWeekStory({ report, estimates: { ...estimates, lastError: 'RPC offline' }, now }), /unavailable/);
  assert.throws(() => playbackWeekStory({ report, estimates: { ...estimates, currentPeriod: { week: 'NY-2026-11-23' } }, now }), /unavailable/);
});

test('selecting an older week retrieves its retained finish-date detail, including the DST transition', () => {
  const playlist = [{ trackId: 'one', mintRecipient: a, airplayDays: {
    '2026-10-31': { plays: 3 }, '2026-11-01': { plays: 4 }, '2026-11-02': { plays: 2 },
  } }];
  const result = buildAirplayCalendar(playlist, { now, dayWeek: 'NY-2026-10-26', wallet: a.toUpperCase() });
  assert.deepEqual(result.daily.map(d => d.date), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  assert.equal(result.daily.at(-1).tracks[0].plays, 4);
  assert.throws(() => buildAirplayCalendar(playlist, { now, dayWeek: 'NY-2026-11-01' }), /Monday/);
});
