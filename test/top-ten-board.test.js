const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const url = pathToFileURL(path.join(__dirname, '../js/top-ten-board.mjs')).href;

test('rank climb effects identify only songs moving upward, not initial loads or unchanged refreshes', async () => {
  const { chartRankGains } = await import(url);
  const before = [{ trackId: 'first', rank: 1 }, { trackId: 'second', rank: 2 }, { trackId: 'third', rank: 3 }];
  const after = [{ trackId: 'third', rank: 1 }, { trackId: 'first', rank: 2 }, { trackId: 'second', rank: 3 }];
  assert.deepEqual([...chartRankGains(before, after)], [['third', 2]]);
  assert.equal(chartRankGains(null, after).size, 0);
  assert.equal(chartRankGains(after, after).size, 0);
  assert.equal(chartRankGains(before, [{ trackId: 'outside', rank: null }, ...before]).size, 0);
  assert.equal(chartRankGains(before, [{ trackId: 'new-song', rank: 1 }]).size, 0);
});

test('chart flights connect continuously between title, vote and prize visits without changing rankings', async () => {
  const { chartFlightFrames } = await import(url);
  const first = chartFlightFrames({ x: 50, y: 100 }, { x: 220, y: 180 });
  const next = chartFlightFrames({ x: 220, y: 180 }, { x: 280, y: 260 });
  assert.equal(first.at(-1).transform, next[0].transform);
  assert.equal(first[0].offset, 0);
  assert.equal(first.at(-1).offset, 1);
  assert.match(first[1].transform, /rotate\(-8deg\)/);
  const source = require('node:fs').readFileSync(path.join(__dirname, '../js/top-ten-board.mjs'), 'utf8');
  assert.match(source, /top-ten-song-title, \.top-ten-net-votes, \.top-ten-prize/);
  assert.match(source, /flightLayer\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(source, /reducedMotion\.addEventListener\('change', syncFlights\)/);
});

test('song prizes follow chart rank, split the remaining pot, and conserve every USDC unit', async () => {
  const { previewTopTenSongPayroll } = await import('../js/top-ten-prizes.mjs');
  const tracks = Array.from({ length: 10 }, (_value, index) => ({ trackId: `song-${index}`, title: `Song ${index}`, votes: 20 - index, plays: 1 }));
  const small = previewTopTenSongPayroll({ tracks, budgetUnits: 12250000n });
  assert.deepEqual(small.entries.map(entry => entry.amountUnits), [6125000n, 3062500n, 1531250n, 765625n, 382812n, 191406n, 191407n]);
  assert.equal(small.allocatedUnits, 12250000n);
  assert.ok(small.entries.every(entry => entry.amountUnits > 100000n));
  for (let count = 1; count <= 10; count++) {
    const plan = previewTopTenSongPayroll({ tracks: tracks.slice(0, count), budgetUnits: 512000001n });
    assert.equal(plan.entries.length, count);
    assert.equal(plan.entries.reduce((sum, entry) => sum + entry.amountUnits, 0n), 512000001n);
    assert.equal(plan.remainderUnits, 0n);
  }
  const larger = previewTopTenSongPayroll({ tracks, budgetUnits: 24500000n });
  assert.equal(larger.entries[0].amountUnits, small.entries[0].amountUnits * 2n);
  tracks[1].votes = 99;
  const reranked = previewTopTenSongPayroll({ tracks, budgetUnits: 12250000n });
  assert.equal(reranked.entries[0].trackId, 'song-1');
  assert.equal(reranked.entries[0].amountUnits, 6125000n);
  assert.equal(reranked.entries[1].trackId, 'song-0');
});

test('song prizes retain sub-dime pots and do not combine songs from the same wallet', async () => {
  const { previewTopTenSongPayroll } = await import('../js/top-ten-prizes.mjs');
  const wallet = `0x${'1'.repeat(40)}`;
  const tracks = [{ trackId: 'first', title: 'First', votes: 9, plays: 1, wallet }, { trackId: 'second', title: 'Second', votes: 8, plays: 1, wallet }];
  const plan = previewTopTenSongPayroll({ tracks, budgetUnits: 1000000n });
  assert.equal(plan.entries.length, 2);
  assert.deepEqual(plan.entries.map(entry => entry.amountUnits), [500000n, 500000n]);
  for (const budgetUnits of [0n, 1n, 100000n]) {
    const below = previewTopTenSongPayroll({ tracks, budgetUnits });
    assert.equal(below.allocatedUnits, 0n);
    assert.equal(below.remainderUnits, budgetUnits);
    assert.equal(below.entries.length, 0);
  }
  assert.equal(previewTopTenSongPayroll({ tracks, budgetUnits: 100001n }).entries[0].amountUnits, 100001n);
});

test('chart prize rows update after deposits and vote changes without awarding the outside-chart live song', async () => {
  const { topTenPrizeRows } = await import(url);
  const tracks = Array.from({ length: 10 }, (_value, index) => ({ trackId: `song-${index}`, title: `Song ${index}`, votes: 20 - index, plays: 1 }));
  const rows = topTenPrizeRows(tracks, { trackId: 'live-elsewhere', title: 'Live song' }, { budgetUnits: '12250000' });
  assert.equal(rows[0].prizeUnits, null);
  assert.equal(rows[1].prizeUnits, 6125000n);
  assert.equal(rows[2].prizeUnits, 3062500n);
  assert.equal(rows.at(-1).prizeUnits, 0n);
  assert.equal(topTenPrizeRows(tracks, null, { budgetUnits: '24500000' })[0].prizeUnits, 12250000n);
  tracks[1].votes = 99;
  const changed = topTenPrizeRows(tracks, null, { budgetUnits: '12250000' });
  assert.equal(changed[0].trackId, 'song-1');
  assert.equal(changed[0].prizeUnits, 6125000n);
  assert.equal(changed[1].prizeUnits, 3062500n);
  assert.equal(topTenPrizeRows(tracks, null)[0].prizeUnits, null);
});

test('public song leaderboard ranks weekly net votes and highlights the live track', async () => {
  const { rankTopTenSongs } = await import(url);
  const songs = rankTopTenSongs([
    { trackId: 'a', title: 'A', votes: 3, plays: 10 },
    { trackId: 'b', title: 'B', votes: 8, plays: 1 },
    { trackId: 'c', title: 'C', votes: 3, plays: 12 },
    { trackId: 'd', title: 'D', votes: -2, plays: 7 },
    { trackId: 'silent', title: 'Silent', votes: 0, plays: 0 },
  ], 'a');
  assert.deepEqual(songs.map(song => [song.rank, song.trackId, song.nowPlaying]), [
    [1, 'b', false], [2, 'c', false], [3, 'a', true], [4, 'd', false],
  ]);
});

test('public song leaderboard is limited to ten and uses stable tie ordering', async () => {
  const { rankTopTenSongs } = await import(url);
  const songs = rankTopTenSongs(Array.from({ length: 12 }, (_, index) => ({ trackId: String(index).padStart(2, '0'),
    title: `Song ${String(index).padStart(2, '0')}`, votes: 1, plays: 1 })));
  assert.equal(songs.length, 10);
  assert.equal(songs[0].trackId, '00');
  assert.equal(songs[9].trackId, '09');
});

test('new york week keys render as listener-friendly week numbers', async () => {
  const { weekNumberFromKey } = await import(pathToFileURL(path.join(__dirname, '../js/payroll-week.mjs')).href);
  assert.equal(weekNumberFromKey('NY-2026-10-12'), 0);
  assert.equal(weekNumberFromKey('NY-2026-10-19'), 1);
});

test('currently playing song stays highlighted when it is outside the ranked top ten', async () => {
  const { topTenDisplayRows } = await import(url);
  const tracks = Array.from({ length: 12 }, (_, index) => ({ trackId: `song-${index}`, title: `Song ${index}`, votes: 12 - index, plays: index + 1 }));
  const rows = topTenDisplayRows(tracks, { trackId: 'song-11', title: 'Song 11', uploader: 'Live Artist' });
  assert.equal(rows.length, 11);
  assert.equal(rows[0].outsideTopTen, true);
  assert.equal(rows[0].nowPlaying, true);
  assert.equal(rows[0].rank, null);
  assert.equal(rows[0].title, 'Song 11');
  assert.equal(rows.filter(row => row.rank).length, 10);
});

test('campaign ads are not inserted into the public song leaderboard', async () => {
  const { topTenDisplayRows } = await import(url);
  const songs = [{ trackId: 'song-1', title: 'Song', votes: 3, plays: 2 }];
  const rows = topTenDisplayRows(songs, { trackId: 'devert:7', title: 'Ad', uploader: 'DeVert advertiser', isDevert: true });
  assert.deepEqual(rows.map(row => row.trackId), ['song-1']);
});

test('pullout leaderboard exposes public weekly ranking and a distinct current-playing state', () => {
  const html = require('node:fs').readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.match(html, /id="top-ten-tab"/);
  assert.match(html, /id="top-ten-panel"/);
  assert.match(html, /weekly net votes/i);
  assert.doesNotMatch(html, /current song stays highlighted/i);
  assert.match(html, /aria-expanded="false"/);
  const board = require('node:fs').readFileSync(path.join(__dirname, '../js/top-ten-board.mjs'), 'utf8');
  assert.match(board, /is-now-playing/);
  assert.match(board, /rankTopTenSongs, previewTopTenSongPayroll.*top-ten-prizes/);
  assert.doesNotMatch(board, /Fund balances unavailable right now/);
  assert.doesNotMatch(board, /Songs ranked by New York-week net votes/i);
  const paper = require('node:fs').readFileSync(path.join(__dirname, '../WHITEPAPER.md'), 'utf8');
  assert.match(paper, /fold-away public Top 10 Songs drawer/);
  assert.match(paper, /same song ranking determines prize places/);
});