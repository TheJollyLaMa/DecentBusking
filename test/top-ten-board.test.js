const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const url = pathToFileURL(path.join(__dirname, '../js/top-ten-board.mjs')).href;

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

test('pullout leaderboard exposes public weekly ranking and a distinct current-playing state', () => {
  const html = require('node:fs').readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.match(html, /id="top-ten-tab"/);
  assert.match(html, /id="top-ten-panel"/);
  assert.match(html, /weekly net votes/i);
  assert.match(html, /aria-expanded="false"/);
  const board = require('node:fs').readFileSync(path.join(__dirname, '../js/top-ten-board.mjs'), 'utf8');
  assert.match(board, /is-now-playing/);
  assert.match(board, /nowPlayingId/);
  const paper = require('node:fs').readFileSync(path.join(__dirname, '../WHITEPAPER.md'), 'utf8');
  assert.match(paper, /fold-away public Top 10 Songs drawer/);
  assert.match(paper, /distinct from the payout rule/);
});