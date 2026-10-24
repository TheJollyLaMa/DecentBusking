const test = require('node:test');
const assert = require('node:assert/strict');

test('takeover indicator is driven only by an audible paid-playlist radio item', async () => {
  const { playlistTakeover } = await import('../js/radio-playlist-effects.mjs');
  assert.equal(playlistTakeover({ nowPlaying: null }), null);
  assert.equal(playlistTakeover({ nowPlaying: { title: 'Regular rotation' } }), null);
  const playlist = { batchId: '0', name: 'BoogieNight', songCount: 12, remaining: 8 };
  assert.equal(playlistTakeover({ nowPlaying: { djukePlaylist: playlist } }).label,
    'BoogieNight · Play Live · 8 of 12 songs remaining');
  assert.equal(playlistTakeover({ nowPlaying: { djukePlaylist: { ...playlist, remaining: 0 } } }), null);
  assert.equal(playlistTakeover({ nowPlaying: { djukePlaylist: { ...playlist, remaining: 13 } } }), null);
  assert.equal(playlistTakeover({ nowPlaying: { djukePlaylist: { ...playlist, position: 8, remaining: 5 } } }).label,
    'BoogieNight · Play Live · Song 8 of 12');
  assert.equal(playlistTakeover({ nowPlaying: { djukePlaylist: { ...playlist, position: 13 } } }).label,
    'BoogieNight · Play Live · 8 of 12 songs remaining');
});

test('public radio state preserves paid-playlist metadata without marking ordinary requests as takeover', async () => {
  const { buildRadioState } = await import('../discord-bot/jukeloop.js');
  const djukePlaylist = { batchId: '0', name: 'BoogieNight', songCount: 12, remaining: 8 };
  const track = { title: 'Song', trackId: 'track', startedAt: 1000, audible: true, djukePlaylist };
  assert.deepEqual(buildRadioState({ nowPlaying: track, playlist: [], now: 2000 }).nowPlaying.djukePlaylist, djukePlaylist);
  assert.equal(buildRadioState({ nowPlaying: { ...track, audible: false }, playlist: [] }).nowPlaying, null);
  assert.equal(buildRadioState({ nowPlaying: { ...track, djukePlaylist: undefined }, playlist: [] }).nowPlaying.djukePlaylist, undefined);
});
