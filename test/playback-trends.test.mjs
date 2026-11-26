import test from 'node:test';
import assert from 'node:assert/strict';
import { playbackDataset, playbackSeries } from '../js/playback-trends.mjs';
import { buildRadioHistoryCatalog } from '../discord-bot/playlist-store.js';
import { buildAirplayCalendar } from '../discord-bot/airplay-calendar.js';

const a = `0x${'a'.repeat(40)}`, b = `0x${'b'.repeat(40)}`;
const song = (trackId, wallet, albums) => ({ trackId, title: 'Same title', wallet, artist: 'Same name', albums });
const catalog = [song('1', a, ['Blue', 'Green']), song('2', a, ['Blue']), song('3', b, ['Blue']), song('4', a, [])];
const start = '2026-11-04T12:00:00Z';
const week = (date, end, tracks, extra) => ({ week: `NY-2026-${date}`, accountingStartedAt: start, endAt: end, tracks, ...extra });
const row = (index, plays, votes) => ({ ...catalog[index], plays, votes });
const reports = [
  week('10-26', '2026-11-02T05:00:00Z', []),
  week('11-02', '2026-11-09T05:00:00Z', [row(0, 3, -2), row(2, 7, 2)], { partial: true }),
  week('11-09', '2026-11-16T05:00:00Z', [row(0, 2, 0), row(1, 1, 1)], { current: true }),
  { week: 'all-time', tracks: [row(0, 500, 300)] },
];
test('NY time series counts group membership once, preserves zero and signed votes, excludes pre-tracking and lifetime', () => {
  const data = playbackDataset(reports, catalog);
  assert.equal(playbackSeries(data).total, 13);
  assert.deepEqual(playbackSeries(data, { scope: 'songs', selected: new Set(['1', '2']), metric: 'votes' }).points.map(p => p.value), [-2, 1]);
  const albums = [...data.albums.keys()];
  assert.deepEqual(albums.map(subject => playbackSeries(data, { scope: 'album', subject }).total), [6, 5, 7]);
  assert.equal(playbackSeries(data, { range: 1 }).points.length, 1);
  const personal = playbackDataset(reports, catalog, a.toUpperCase());
  assert.equal(playbackSeries(personal).total, 6);
  assert.equal(personal.albums.size, 2);
  assert.deepEqual(playbackSeries(personal).rows.map(song => song.value), [5, 1, 0]);
  assert.equal(playbackDataset(reports, undefined).albumsAvailable, false);
});

test('public metadata includes unplayed eligible recordings, real release/legacy/live album names, never a wallet’s unrelated drafts', () => {
  const base = { uploader: 'Artist', mintRecipient: a, title: 'Sample', plays: 0 };
  const playlist = [
    { ...base, trackId: 'dual', albums: ['JonesDriveSessions_AB'], releaseAlbums: [{ album: 'Jones Dr Sessions AB' }, { album: 'Jones Dr Sessions AC' }] },
    { ...base, trackId: 'show', albumTitle: 'Live set' },
    { ...base, trackId: 'draft', source: 'site', mintStatus: 'requested' },
    { ...base, trackId: 'ad', isDevertAd: true },
    { ...base, trackId: 'other', mintRecipient: b },
  ];
  const personal = buildRadioHistoryCatalog(playlist, { wallet: a.toUpperCase() });
  assert.deepEqual(personal.map(t => [t.trackId, t.albums]), [['dual', ['Jones Dr Sessions AB', 'Jones Dr Sessions AC']], ['show', ['Live set']]]);
  assert.equal(buildRadioHistoryCatalog(playlist).length, 3);
});

test('monthly uses only attributable counts; lifetime ranks include undated plays while bars span older dated weeks', () => {
  const old = 'NY-2025-10-06', boundary = 'NY-2026-12-28', jan = 'NY-2027-01-04';
  const playlist = [
    { trackId: '1', mintRecipient: a, payrollTrackingStartedAt: '2025-10-01T00:00:00Z',
      payrollPlays: { [old]: 2, [boundary]: 50, [jan]: 7 }, payrollVotes: { [jan]: -3 },
      airplayDays: { '2026-12-31': { plays: 5 }, '2027-01-01': { plays: 3 }, '2027-01-04': { plays: 2, votes: -1 } } },
    { trackId: '3', mintRecipient: b, payrollPlays: { [jan]: 4 } },
  ];
  const now = Date.parse('2027-01-07T16:00:00Z');
  const periods = buildAirplayCalendar(playlist, { now });
  const report = [{ week: 'all-time', tracks: [row(0, 102, -7), row(1, 200, 1), row(2, 4, 0)] }];
  const data = playbackDataset(report, catalog, '', periods);
  const series = (range, extra = {}) => playbackSeries(data, { range, ...extra });
  assert.deepEqual(series('monthly').points.slice(-3).map(p => p.value), [null, 5, 14]);
  assert.deepEqual(series('monthly', { metric: 'votes' }).points.slice(-2).map(p => p.value), [null, -3]);
  assert.deepEqual(series('monthly', { scope: 'album', subject: [...data.albums.keys()][0] }).total, 15);
  assert.deepEqual(series('daily', { scope: 'songs', selected: new Set(['1', '2']) }).total, 10);
  assert.equal(series('all-time').total, 306);
  assert.equal(series('all-time').rows.find(song => song.id === '2').value, 200);
  assert.equal(series('all-time').points[0].date, '2025-10-06');
  assert.ok(series('all-time').points.length <= 12);
  assert.equal(series('all-time').points.reduce((s, p) => s + (p.value ?? 0), 0), 63);
  const scoped = buildAirplayCalendar(playlist, { wallet: a.toUpperCase(), now });
  for (const buckets of Object.values(scoped)) assert.ok(buckets.every(bucket => bucket.tracks.every(t => t.trackId === '1')));
  const personal = playbackDataset(report, catalog, a, scoped);
  assert.equal(playbackSeries(personal, { range: 'all-time', metric: 'votes' }).total, -6);
  assert.equal(playbackSeries(personal, { range: 'monthly' }).total, 15);
  const oldWorker = playbackDataset(report, catalog);
  assert.equal(playbackSeries(oldWorker, { range: 'daily' }).total, null);
  assert.equal(playbackSeries(oldWorker, { range: 'all-time' }).total, 306);
});
