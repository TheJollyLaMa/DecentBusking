const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const start = Date.parse('2026-10-17T00:00:00Z');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'top-ten-hype-'));
process.env.JUKELOOP_PLAYLIST_PATH = path.join(tempDir, 'playlist.json');
test.after(() => {
  delete process.env.JUKELOOP_PLAYLIST_PATH;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function fixture(t, count = 3) {
  let now = start;
  t.mock.method(Date, 'now', () => now);
  const { JukeLoopSession, buildRadioState, buildNowPlayingMessage } = await import('../discord-bot/jukeloop.js');
  const { loadPlaylist } = await import('../discord-bot/playlist-store.js');
  const playlist = Array.from({ length: count }, (_, index) => ({
    trackId: `song-${index}`, title: `Song ${index}`, uploader: 'Artist', filename: 'song.mp3',
    ipfsCid: `cid-${index}`, payrollVotes: { 'NY-2026-10-12': count - index },
  }));
  loadPlaylist(playlist);
  let snapshot = null;
  const notices = [];
  const player = new EventEmitter();
  player.state = { status: 'idle' };
  player.play = resource => { player.resource = resource; player.state.status = 'playing'; };
  player.stop = () => { player.state.status = 'idle'; };
  const store = {
    restore: async () => snapshot,
    save: async value => { snapshot = structuredClone(value); return 'ipfs://snapshot'; },
  };
  const session = new JukeLoopSession({
    voiceChannel: { guild: { id: 'hype-runtime-test' } },
    client: {},
    audioPlayer: player,
    createStream: () => { const stream = new PassThrough(); stream.write(Buffer.alloc(100));
      const ffmpegProcess = new EventEmitter(); ffmpegProcess.kill = () => stream.destroy();
      return { stream, ffmpegProcess }; },
    textChannel: { send: async message => { notices.push(message.content); return { react: async () => {} }; } },
    topTenHypeStore: store,
    djuke: { nextPaid: async () => { throw new Error('Paid requests must not run during Hype'); } },
    devertPlayback: { nextMainRadioAd: async () => { throw new Error('Ads must not run during Hype'); } },
  });
  session._getFreshUrl = async () => 'https://example.test/song';
  session._announcePrepared = async () => {};
  session._musicSinceAd = 100;
  t.after(() => { session.destroy(); loadPlaylist([]); });
  return { session, playlist, notices, player, store, buildRadioState, buildNowPlayingMessage,
    setNow: value => { now = value; }, snapshot: () => snapshot };
}

test('actual JukeLoop selects #3 → #2 → #1 then encores, checkpointing before audio and deferring pending ads', async t => {
  const f = await fixture(t);
  f.session._preparedDevertAd = { campaignId: 'pending-ad' };
  const heard = [];
  f.player.play = () => {
    assert.equal(f.snapshot().cursor, heard.length + 1, 'position must be durable before sound starts');
    heard.push(f.session._nowPlaying.hype.openingRank);
  };
  for (let index = 0; index < 4; index++) await f.session._playNext();
  assert.deepEqual(heard, [3, 2, 1, 3]);
  assert.equal(f.session._nowPlaying.hype.encore, true);
  assert.equal(f.session._preparedDevertAd.campaignId, 'pending-ad');
  const show = f.session.getShowState();
  f.session._nowPlaying.audible = true;
  const radio = f.buildRadioState({ nowPlaying: f.session._nowPlaying, playlist: [], ...show });
  assert.equal(radio.activeShow.id, 'friday-top10-hype');
  assert.equal(radio.nowPlaying.hype.openingRank, 3);
  assert.equal(radio.topTenHype.tracks.length, 3);
  const message = f.buildNowPlayingMessage(f.playlist[0], { queueIndex: 3, totalTracks: 3, hype: { openingRank: 1, encore: false } });
  assert.match(message, /Opening chart #1/);
  assert.match(message, /headliner/);
});

test('actual JukeLoop records missing recordings without recursion into an infinite all-failed encore loop', async t => {
  const f = await fixture(t);
  f.session._getFreshUrl = async () => null;
  const prepared = await f.session._prepareNextPlayback();
  assert.equal(prepared, null);
  assert.equal(f.snapshot().cursor, 3);
  assert.equal(f.snapshot().skipped.length, 3);
  assert.equal(f.notices.filter(message => /skipped/.test(message)).length, 4);
});

test('actual JukeLoop refuses late-prepared audio at the 9pm boundary even before the next watcher tick', async t => {
  const f = await fixture(t);
  const prepared = await f.session._prepareNextPlayback();
  f.session._preparedNext = prepared;
  f.setNow(start + 3600_000);
  await f.session._playNext();
  assert.equal(f.player.resource, undefined);
  assert.equal(f.snapshot().cursor, 0);
  assert.equal(f.session.getShowState().activeShow.type, 'live_performance');
  assert.equal(f.session.getShowState().topTenHype, null);
});

test('actual JukeLoop empty chart never falls back to non-chart music', async t => {
  const f = await fixture(t, 0);
  f.session._queue = [{ trackId: 'not-on-chart', title: 'Not charted' }];
  assert.equal(await f.session._prepareNextPlayback(), null);
  assert.equal(f.session.getShowState().topTenHype.status, 'empty');
  assert.match(f.notices[0], /opening Top10 chart is empty/);
});

test('actual JukeLoop recovers from a progress-checkpoint failure without losing or repeating a place', async t => {
  const f = await fixture(t);
  await f.session._prepareNextPlayback().then(prepared => f.session._disposePrepared(prepared));
  const save = f.store.save;
  f.store.save = async () => { throw new Error('checkpoint offline'); };
  await f.session._playNext();
  assert.equal(f.player.resource, undefined);
  assert.equal(f.snapshot().cursor, 0);
  assert.equal(f.session.getShowState().topTenHype.status, 'unavailable');
  assert.equal(f.session.getShowState().topTenHype.tracks.length, 3);
  f.store.save = save;
  await f.session._playNext();
  assert.equal(f.session._nowPlaying.hype.openingRank, 3);
  assert.equal(f.snapshot().cursor, 1);
  assert.equal(f.session.getShowState().topTenHype.status, 'ready');
});
