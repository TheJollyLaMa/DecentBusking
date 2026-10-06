const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const storeModule = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'playlist-store.js')).href;
const reportModule = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'weekly-play-report.js')).href;

test('weekly ledger counts only completed 30-second audible plays once by UTC week', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jukeloop-weekly-'));
  process.env.JUKELOOP_PLAYLIST_PATH = path.join(temp, 'playlist.json');
  t.after(() => { delete process.env.JUKELOOP_PLAYLIST_PATH; fs.rmSync(temp, { recursive: true, force: true }); });
  const storeUrl = new URL(storeModule);
  storeUrl.searchParams.set('weekly-test', String(Date.now()));
  const store = await import(storeUrl.href);
  store.loadPlaylist([
    { trackId: 'song-a', title: 'Song A', uploader: 'artist-a', mintRecipient: '0xartist-a', addedAt: '2026-10-01T00:00:00Z', likes: 0, dislikes: 0, plays: 0 },
    { trackId: 'song-b', title: 'Song B', uploader: 'artist-a', mintRecipient: '0xartist-a', addedAt: '2026-10-01T00:00:00Z', likes: 0, dislikes: 0, plays: 0 },
    { trackId: 'song-c', title: 'Song C', uploader: 'artist-b', mintRecipient: '0xartist-b', addedAt: '2026-09-01T00:00:00Z', likes: 0, dislikes: 0, plays: 0 },
  ]);
  const event = (trackId, playId, endedAt, audibleMs = 60_000) => store.recordAudiblePlay(trackId, {
    playId, startedAt: Date.parse(endedAt) - audibleMs, endedAt: Date.parse(endedAt), audibleMs,
  });
  assert.equal(event('song-a', 'short', '2026-10-04T23:59:00Z', 29_999).reason, 'under-30-seconds');
  assert.equal(event('song-a', 'sunday', '2026-10-04T23:59:30Z').week, '2026-W40');
  assert.equal(event('song-a', 'sunday', '2026-10-04T23:59:30Z').reason, 'duplicate');
  assert.equal(event('song-b', 'monday', '2026-10-05T00:00:30Z').week, '2026-W41');
  assert.equal(store.getWeeklyPlayReport('2026-W40').totalPlays, 1);
  const report = store.getWeeklyPlayReport('2026-W41');
  assert.equal(report.totalPlays, 1);
  assert.deepEqual(report.artists.map((artist) => [artist.artist, artist.plays, artist.wallet]), [['artist-a', 1, '0xartist-a']]);
  store.applySiteVote('song-b', 1);
  store.applySiteVote('song-b', 1);
  store.applySiteVote('song-b', -1);
  const votedReport = store.getWeeklyPlayReport('2026-W41', { wallet: '0xARTIST-A' });
  assert.equal(votedReport.tracks[0].likes, 2);
  assert.equal(votedReport.tracks[0].dislikes, 1);
  assert.equal(votedReport.artists[0].likes, 2);
  assert.equal(votedReport.artists[0].dislikes, 1);
  assert.equal(votedReport.totalPlays, 1);
  assert.equal(store.getPlaylist().find((track) => track.trackId === 'song-a').plays, 1);
  assert.deepEqual(store.getWeeklyPlayHistory({ weeks: 12, wallet: '0xARTIST-A', now: Date.parse('2026-10-05T12:00:00Z') })
    .at(-1).tracks.map((track) => track.trackId), ['song-b']);
  assert.deepEqual(store.getWeeklyPlayHistory({ weeks: 2, now: Date.parse('2026-10-05T12:00:00Z') }).map(week => week.week), ['2026-W40', '2026-W41']);
});

test('first-week track gets one extra spaced slot and consumes its bonus only after qualifying', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jukeloop-boost-'));
  process.env.JUKELOOP_PLAYLIST_PATH = path.join(temp, 'playlist.json');
  t.after(() => { delete process.env.JUKELOOP_PLAYLIST_PATH; fs.rmSync(temp, { recursive: true, force: true }); });
  const url = new URL(storeModule);
  url.searchParams.set('boost-test', String(Date.now()));
  const store = await import(url.href);
  store.loadPlaylist([
    { trackId: 'new', addedAt: '2026-10-04T00:00:00Z', likes: 0, dislikes: 0, plays: 0 },
    { trackId: 'old-a', addedAt: '2026-09-01T00:00:00Z', likes: 0, dislikes: 0, plays: 0 },
    { trackId: 'old-b', addedAt: '2026-09-01T00:00:00Z', likes: 0, dislikes: 0, plays: 0 },
  ]);
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const freshPass = store.getWeightedShuffledPlaylist(Date.parse('2026-10-05T00:00:00Z'));
    assert.equal(freshPass.length, 4);
    assert.equal(freshPass.filter((track) => track.trackId === 'new').length, 2);
    const bonus = freshPass.find((track) => track.firstWeekBonus);
    store.recordAudiblePlay('new', {
      playId: 'newcomer-bonus', startedAt: 1, endedAt: 60_001, audibleMs: 60_000,
      firstWeekBonus: bonus.firstWeekBonus,
    });
    const laterPass = store.getWeightedShuffledPlaylist(Date.parse('2026-10-06T00:00:00Z'));
    assert.equal(laterPass.length, 3);
    assert.equal(laterPass.filter((track) => track.trackId === 'new').length, 1);
  } finally {
    Math.random = originalRandom;
  }
});

test('wallet all-time tally retains legacy plays and votes without inventing weekly entries', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jukeloop-lifetime-'));
  process.env.JUKELOOP_PLAYLIST_PATH = path.join(temp, 'playlist.json');
  t.after(() => { delete process.env.JUKELOOP_PLAYLIST_PATH; fs.rmSync(temp, { recursive: true, force: true }); });
  const url = new URL(storeModule);
  url.searchParams.set('lifetime-test', Date.now());
  const store = await import(url.href);
  const wallet = `0x${'1'.repeat(40)}`;
  store.loadPlaylist([
    { trackId: 'legacy', title: 'Legacy', uploader: 'Artist', mintRecipient: wallet, plays: 12, likes: 3, dislikes: 1 },
    { trackId: 'votes-only', title: 'Votes', uploader: 'Artist', mintRecipient: wallet, plays: 0, likes: 2 },
    { trackId: 'other', title: 'Other', uploader: 'Other', mintRecipient: `0x${'2'.repeat(40)}`, plays: 40, likes: 10 },
  ]);
  const report = store.getAllTimePlayReport({ wallet: wallet.toUpperCase() });
  assert.equal(report.totalPlays, 12);
  assert.equal(report.trackCount, 2);
  assert.equal(report.artists[0].likes, 5);
  assert.equal(report.artists[0].dislikes, 1);
  const history = store.getWeeklyPlayHistory({ weeks: 2, wallet, includeAllTime: true, now: Date.parse('2026-10-06T00:00:00Z') });
  assert.equal(history.length, 3);
  assert.equal(history.at(-1).week, 'all-time');
  assert.equal(history.at(-1).totalPlays, 12);
  assert.equal(history[0].totalPlays, 0);
  assert.equal(history[1].totalPlays, 0);
  assert.equal(store.getWeeklyPlayHistory({ weeks: 2, wallet }).length, 2);
});

test('weekly report is explicit about UTC, 30-second eligibility, and is Discord-sized', async () => {
  const { buildWeeklyPlayReportMessage } = await import(reportModule);
  const report = { week: '2026-W41', totalPlays: 20, trackCount: 12,
    artists: [{ artist: 'artist-a', plays: 12, tracks: 5 }],
    tracks: [{ title: 'Song A', artist: 'artist-a', plays: 5 }] };
  const message = buildWeeklyPlayReportMessage(report);
  assert.match(message, /2026-W41/);
  assert.match(message, /30 audible seconds/);
  assert.match(message, /12 qualifying plays|20 qualifying plays/);
  assert.match(message, /jukeloop-weekly-report:2026-W41/);
  assert.ok(message.length < 2000);
});
