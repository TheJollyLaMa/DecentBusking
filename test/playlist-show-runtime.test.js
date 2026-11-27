const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const { verifiedRecording } = require('./helpers/verified-recording');
const runtimeRoot = path.join(__dirname, '..', '.test-runtime');
fs.mkdirSync(runtimeRoot, { recursive: true });
const runtimeDir = fs.mkdtempSync(path.join(runtimeRoot, 'playlist-show-'));
process.env.JUKELOOP_PLAYLIST_PATH = path.join(runtimeDir, 'playlist.json');
test.after(() => { delete process.env.JUKELOOP_PLAYLIST_PATH; fs.rmSync(runtimeDir, { recursive: true, force: true }); });
const START = Date.parse('2026-10-23T01:00:00Z');
const event = { id: 'tonight', type: 'playlist_show', playlistId: 'songs-awaiting-your-vote', title: 'Songs Awaiting Your Vote',
  startUtc: new Date(START).toISOString(), endUtc: new Date(START + 3600_000).toISOString() };

async function fixture(t, { count = 2, voted = false, store: customStore, showEvent = event, seconds = 180, getRadioSchedule } = {}) {
  let now = START;
  t.mock.method(Date, 'now', () => now);
  const { JukeLoopSession, buildRadioState, buildNowPlayingMessage, synchronizeDiscordRating } = await import('../discord-bot/jukeloop.js');
  const { loadPlaylist, getPlaylist, applySiteVote, applyRating } = await import('../discord-bot/playlist-store.js');
  const tracks = Array.from({ length: count }, (_, index) => verifiedRecording({ trackId: `song-${index}`, title: `Song ${index}`,
    uploader: 'Artist', filename: 'song.mp3', ipfsCid: `cid-${index}`, likes: voted ? 1 : 0, dislikes: 0 }, seconds));
  loadPlaylist(tracks);
  let value = null;
  const store = customStore || { restore: async () => value, save: async next => { value = structuredClone(next); return 'ipfs://snapshot'; } };
  const player = new EventEmitter();
  player.state = { status: 'idle' };
  const heard = [];
  player.play = resource => { player.resource = resource; player.state.status = 'playing'; heard.push(session._nowPlaying.trackId); };
  let stops = 0;
  player.stop = () => { player.state.status = 'idle'; stops++; };
  let paidCalls = 0;
  let adCalls = 0;
  const session = new JukeLoopSession({ voiceChannel: { guild: { id: 'playlist-runtime-test' } }, client: {},
    livePerformanceEvents: [showEvent], getRadioSchedule, audioPlayer: player, playlistShowStore: store,
    createStream: () => { const stream = new PassThrough(); stream.write(Buffer.alloc(100));
      const ffmpegProcess = new EventEmitter(); ffmpegProcess.kill = () => stream.destroy(); return { stream, ffmpegProcess }; },
    djuke: { nextPaid: async () => { paidCalls++; return null; } },
    devertPlayback: { nextMainRadioAd: async () => { adCalls++; return []; } },
  });
  session._getFreshUrl = async () => 'https://example.test/song';
  session._announcePrepared = async () => {};
  session._sendPlaybackNotice = () => {};
  t.after(() => { session.destroy(); loadPlaylist([]); });
  return { session, tracks, player, heard, getPlaylist, loadPlaylist, applySiteVote, applyRating, buildRadioState, buildNowPlayingMessage, synchronizeDiscordRating,
    value: () => value, stops: () => stops, paidCalls: () => paidCalls, adCalls: () => adCalls, setNow: value => { now = value; } };
}

test('a long recording finishes past its slot and Top10 boundary; completion, not admission, advances its durable queue', async t => {
  const f = await fixture(t, { seconds: 1200, showEvent: { ...event, playlistId: 'long-form-hour' } });
  f.setNow(START + 3599_000);
  await f.session._playNext();
  assert.equal(f.heard.length, 1);
  assert.equal(f.value().occurrences[0].cursor, 0, 'admission is not completion');
  f.session._primeNext();
  assert.equal(f.session._preparedNext, null, 'unfinished long recording cannot prefetch itself');
  f.setNow(START + 3601_000);
  f.session._started = true;
  f.session._syncScheduledShow();
  f.session.setSchedule([{ id: 'later-chart', type: 'weekly_top10', weekday: 5, startHourUtc: 0, endHourUtc: 23 }]);
  assert.equal(f.stops(), 0, 'the clock and ordinary chart handoff do not truncate the long recording');
  const trackId = f.session._currentTrack.trackId;
  f.session._completedPlay = { playId: 'full-set-finished', trackId, audibleMs: 1200000, finished: true };
  await f.session._collectReactions();
  assert.equal(f.value().occurrences[0].cursor, 1);
  assert.equal(f.value().occurrences[0].lastCompleted.trackId, trackId);
});

test('website runtime reads the durable schedule source after save/restore and actually admits only intact Long-Form tracks', async t => {
  const { serializeLiveSchedule, deserializeLiveSchedule, defaultRadioSchedule } = await import('../js/radio-schedule.mjs');
  let saved = { events: [], weeklySchedule: {} };
  const f = await fixture(t, { seconds: 1200, getRadioSchedule: () => ({
    schedule: defaultRadioSchedule(saved.weeklySchedule), events: saved.events,
  }) });
  f.setNow(Date.parse('2026-11-27T20:44:00Z'));
  f.loadPlaylist([...f.getPlaylist(), verifiedRecording({ trackId: 'ordinary', title: 'Ordinary', likes: 0, dislikes: 0 }, 180)]);
  assert.equal(f.session.getShowState().activeShow.type, 'normal_rotation');
  saved = deserializeLiveSchedule(serializeLiveSchedule({ events: [], weeklySchedule: { programs: [
    { id: 'program-saved-long', title: 'Saved Long-Form', playlistId: 'long-form-hour',
      weekday: 5, startMinuteLocal: 900, startDateLocal: '2026-11-27', announce: true },
  ] } }));
  assert.equal((await f.session.getMainRadioAdCountdown()).activeShow.type, 'playlist_show');
  assert.equal(f.session.getShowState().activeShow.playlistId, 'long-form-hour');
  const notices = [];
  f.session._sendPlaybackNotice = message => notices.push(message);
  f.session._syncScheduledShow({ requestPlayback: false });
  assert.match(notices.join(' '), /strictly longer than 10 minutes, played intact/);
  assert.doesNotMatch(notices.join(' '), /voted songs are dropped/);
  await f.session._playNext();
  assert.equal(f.heard.length, 1);
  assert.notEqual(f.heard[0], 'ordinary');
  assert.equal(f.session._nowPlaying.playlistShow.fallback, false);
  assert.equal(f.value().occurrences[0].playlistId, 'long-form-hour');
  assert.equal(f.value().occurrences[0].cursor, 0, 'long tracks advance on completed playback, not admission');
});

test('long recordings that cannot finish before a protected live event yield to short fallback without losing attribution', async t => {
  const f = await fixture(t, { seconds: 1200, showEvent: { ...event, playlistId: 'long-form-hour' } });
  f.loadPlaylist([...f.getPlaylist(), verifiedRecording({ trackId: 'short-fallback', title: 'Short fallback', likes: 1, dislikes: 0 }, 60)]);
  f.session.setLivePerformanceEvents([{ ...event, playlistId: 'long-form-hour' },
    { id: 'booked-live', type: 'live_performance', title: 'Booked artist',
      startUtc: new Date(START + 600000).toISOString(), endUtc: new Date(START + 1800000).toISOString() }]);
  await f.session._playNext();
  assert.deepEqual(f.heard, ['short-fallback']);
  assert.equal(f.paidCalls(), 0);
  assert.ok(f.value().occurrences[0].skipped.every(entry => /protected live event/.test(entry.reason)));
});

test('historical allocation with null public live state cannot override saved Long-Form or zero-vote actual playback', async t => {
  const { createLiveAudioService } = await import('../discord-bot/live-audio.js');
  const { defaultRadioSchedule } = await import('../js/radio-schedule.mjs');
  for (const [playlistId, at, minute, seconds] of [
    ['long-form-hour', '2026-11-27T20:44:00Z', 900, 1200],
    ['songs-awaiting-your-vote', '2026-11-27T21:49:00Z', 960, 180],
  ]) await t.test(playlistId, async t => {
    const weeklySchedule = { programs: [{ id: 'program-saved-hour', title: 'Saved hour', weekday: 5,
      startMinuteLocal: minute, startDateLocal: '2026-11-27', playlistId }] };
    const f = await fixture(t, { count: 1, seconds,
      getRadioSchedule: () => ({ schedule: defaultRadioSchedule(weeklySchedule), events: [] }) });
    f.setNow(Date.parse(at));
    f.loadPlaylist([...f.getPlaylist(), verifiedRecording({ trackId: 'ineligible', title: 'Ordinary voted song', likes: 1, dislikes: 0 }, 180)]);
    const past = { id: 'historical-paid-booking', eventId: 'historical-live-event', mode: 'phase1', status: 'paid',
      acknowledged: true, wallet: `0x${'2'.repeat(40)}`, payoutPolicy: 'pilot-guaranteed-v1', amountUnits: '20000000',
      startUtc: '2026-11-21T02:25:00Z', endUtc: '2026-11-21T02:45:00Z', title: 'Past performance' };
    let state = { version: 1, rooms: [{ bookingId: past.id, armed: false, checks: {}, lastVerifiedAt: 0,
      allocation: { id: 'historical-allocation', revision: 5, plannedStartAt: 1795232040000,
        startedAt: 1795232133043, endedAt: 1795233933043, endReason: 'authorization-expired',
        durationMs: 1200000, encoreMs: 600000, choice: 'full', choiceAt: 1795232040000,
        previousBookingId: null, nextBookingId: null, delayNotifiedAt: null,
        finishedId: null, finishedAt: null, priorityFollowup: false } }] };
    const liveAudio = createLiveAudioService({ getBookings: async () => ({ bookings: [past] }),
      ownerWallet: `0x${'1'.repeat(40)}`, transport: { ready: true, close: async () => {}, stop: async () => {} },
      store: { restore: async () => structuredClone(state), save: async next => { state = structuredClone(next); } },
      onPolicy: policy => f.session.setLiveAudioPolicy(policy) });
    t.after(() => liveAudio.stop());
    assert.equal(await liveAudio.current(), null, 'null public liveAudio is compatible with a historical room policy');
    assert.equal(await liveAudio.tick(), null, 'completed historical allocation no longer occupies the canonical policy');
    assert.equal(f.session.getShowState().activeShow.playlistId, playlistId);
    f.session.setLiveAudioPolicy({ mode: 'radio', controlled: true, bookingId: past.id, eventId: past.eventId });
    assert.equal((await f.session.getMainRadioAdCountdown()).activeShow.type, 'playlist_show', 'a stale copied radio policy also yields to the actual schedule');
    await f.session._playNext();
    assert.deepEqual(f.heard, ['song-0']);
    assert.equal(f.session._nowPlaying.playlistShow.fallback, false);
    assert.equal(f.value().occurrences[0].playlistId, playlistId);
    assert.equal(past.status, 'paid');
    assert.equal(past.amountUnits, '20000000', 'expiry does not mutate agreed fees or settlement');
  });
});

test('a minted twenty-minute live set waits for long-form programming and records replay only after complete playback', async t => {
  const f = await fixture(t, { count: 0 });
  const p = await import('../discord-bot/playlist-store.js');
  p.configureRemotePersistence(async () => {});
  t.after(() => p.configureRemotePersistence(null));
  const { liveRecordingRelease } = require('./helpers/live-recording-release');
  const track = await p.submitLiveRecordingRelease(liveRecordingRelease({
    booking: { id: 'full-live-set', title: 'Twenty-minute set', wallet: `0x${'1'.repeat(40)}`,
      endUtc: new Date(START - 600000).toISOString() },
    cid: 'c'.repeat(46), artworkCid: 'a'.repeat(46), durationSeconds: 1200, incomplete: false,
    consent: { enabled: true, signature: 'fixture', issuedAt: START - 2000000 },
  }));
  p.completeTrackMint(track.trackId, { tokenId: '1001', txHash: 'verified-fixture' });
  assert.equal(p.pendingLiveRecordingReplay(), undefined);
  assert.deepEqual(p.getWeightedShuffledPlaylist(), []);
  await f.session._playNext();
  assert.deepEqual(f.heard, [], 'ordinary themed show cannot select the long recording');
  f.session.setLivePerformanceEvents([{ ...event, id: 'long-live-set', playlistId: 'long-form-hour' }]);
  await f.session._playNext();
  assert.deepEqual(f.heard, [track.trackId]);
  assert.equal(track.liveRecording.replayStatus, 'pending');
  f.session._completedPlay = { playId: 'finished-live-set', trackId: track.trackId, audibleMs: 1200000, finished: true };
  await f.session._collectReactions();
  assert.equal(track.liveRecording.replayStatus, 'played');
  assert.equal(track.mintRecipient, `0x${'1'.repeat(40)}`);
  assert.equal(track.tokenId, '1001');
});

test('long-form handoff waits for durable completion, retries a failed checkpoint and never restarts the just-finished set', async t => {
  let value, release, fail = true;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, { seconds: 1200, showEvent: { ...event, playlistId: 'long-form-hour' },
    store: { restore: async () => value, save: async next => {
      if (next.occurrences[0].cursor === 1 && fail) {
        await gate;
        fail = false;
        throw new Error('Completion checkpoint unavailable');
      }
      value = structuredClone(next);
      return 'ipfs://checkpoint';
    } } });
  f.session._sleep = async () => {};
  f.session.devertPlayback.recordCompletedMusicPlay = async () => {};
  await f.session._playNext();
  const first = f.heard[0];
  f.session._nowPlaying.audible = true;
  f.session._announcementMsg = { fetch: () => new Promise(() => {}) };
  f.session._activeAudio = { resource: f.player.resource,
    completion: { finish: async () => ({ finished: true, reason: 'clean_eof' }), interrupt() {} } };
  f.setNow(START + 1200000);
  f.player.state.status = 'idle';
  f.player.emit('idle');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.heard, [first], 'no next selection while completion checkpoint is pending');
  release();
  await f.session._transitionTask;
  assert.equal(value.occurrences[0].cursor, 1);
  assert.equal(f.heard.length, 2);
  assert.notEqual(f.heard[1], first);
});

test('missing long-form media uses short fallback while preserving the durable retry position', async t => {
  const f = await fixture(t, { seconds: 1200, showEvent: { ...event, playlistId: 'long-form-hour' } });
  f.loadPlaylist([...f.getPlaylist(), verifiedRecording({ trackId: 'short-fallback', title: 'Short fallback', likes: 1, dislikes: 0 }, 60)]);
  f.session._getFreshUrl = async track => track.trackId === 'short-fallback' ? 'https://example.test/short' : null;
  await f.session._playNext();
  assert.deepEqual(f.heard, ['short-fallback']);
  assert.equal(f.value().occurrences[0].cursor, 0);
  assert.match(f.session.getShowState().playlistShow.fallbackReason, /could not be fetched/);
});

test('prepared music is revalidated after reclassification, and old paid long recordings are held rather than failed or paid', async t => {
  const f = await fixture(t);
  const prepared = await f.session._prepareNextPlayback();
  const current = f.getPlaylist().find(track => track.trackId === prepared.track.trackId);
  Object.assign(current, verifiedRecording(current, 1200));
  assert.equal(f.session._startPrepared(prepared), false);
  assert.deepEqual(f.heard, []);
  f.session.setLivePerformanceEvents([]);
  let releases = 0;
  f.session.djuke = { release: async () => { releases++; },
    fail: async () => { throw new Error('Already-paid requests must not be discarded'); } };
  assert.equal(await f.session._prepareNextPlayback({ record: { requestId: 'legacy-paid' }, track: current }), null);
  assert.equal(releases, 1);
});

test('custom ranked rules reach actual audio playback and keep their opening order', async t => {
  const { validateRadioPreset } = await import('../js/radio-playlists.mjs');
  const definition = validateRadioPreset({ id: 'preset-growth', title: 'Our climbers', selector: 'weekly-growth',
    ranking: 'weekly-growth', limit: 0, revision: 1 });
  const f = await fixture(t, { showEvent: { ...event, playlistId: definition.id, playlistDefinition: definition } });
  for (const [index, track] of f.getPlaylist().entries()) {
    track.payrollVotes = { 'NY-2026-10-19': index + 3, 'NY-2026-10-12': 1 };
  }
  await f.session._playNext();
  assert.deepEqual(f.heard, ['song-1']);
  assert.equal(f.session._nowPlaying.playlistShow.fallback, false);
  assert.equal(f.value().occurrences[0].playlistDefinition.id, definition.id);
  await f.session._playNext();
  assert.deepEqual(f.heard, ['song-1', 'song-0']);
});

test('actual playback commits progress before sound, restores opening order after restart, falls back after exhaustion, defers paid requests', async t => {
  const f = await fixture(t);
  f.player.play = () => {
    assert.equal(f.value().occurrences[0].cursor, f.heard.length + 1);
    f.heard.push(f.session._nowPlaying.trackId);
  };
  await f.session._playNext();
  const first = f.heard[0];
  f.session._disposePrepared(f.session._preparedNext);
  f.session._preparedNext = null;
  const { createPlaylistShow } = await import('../discord-bot/playlist-show.js');
  f.session._playlistShow = createPlaylistShow({ store: { restore: async () => f.value(), save: async next => {
    assert.equal(next.occurrences[0].cursor, 2); return 'ipfs://second';
  } } });
  f.player.play = () => f.heard.push(f.session._nowPlaying.trackId);
  await f.session._playNext();
  assert.notEqual(f.heard[1], first);
  await f.session._playNext();
  assert.equal(f.heard.length, 3, 'normal rotation supplies the rest of the hour');
  assert.equal(f.session._nowPlaying.playlistShow.fallback, true);
  assert.equal(f.session.getShowState().playlistShow.fallbackReason, 'Eligible pool exhausted');
  assert.equal(f.paidCalls(), 0);
});

test('prefetched song voted on site before its turn is durably skipped, not played; vote during playback never stops audio', async t => {
  const f = await fixture(t);
  const prepared = await f.session._prepareNextPlayback();
  const id = prepared.track.trackId;
  f.applySiteVote(id, -1);
  f.session._preparedNext = prepared;
  await f.session._playNext();
  assert.deepEqual(f.heard, []);
  assert.match(f.value().occurrences[0].skipped[0].reason, /human vote/);
  await f.session._playNext();
  assert.notEqual(f.heard[0], id);
  f.applySiteVote(f.heard[0], 1);
  f.session._syncScheduledShow({ requestPlayback: false });
  assert.equal(f.stops(), 0);
});

test('a Discord vote removed later still excludes a song forever; bot seeded reactions are handled by existing collector', async t => {
  const f = await fixture(t);
  const id = f.tracks[0].trackId;
  f.getPlaylist()[0].likes = 1;
  f.getPlaylist()[0].discordRatings = { announcement: { likes: 1, dislikes: 0 } };
  f.applyRating(id, 0, 0, 'announcement');
  const prepared = await f.session._prepareNextPlayback();
  assert.notEqual(prepared.track.trackId, id);
  assert.equal(f.getPlaylist()[0].likes, 0);
  assert.equal(f.getPlaylist()[0].everHumanVoted, true);
  f.session._disposePrepared(prepared);
});

test('empty and persistence-unavailable pools immediately play normal rotation with an exposed reason', async t => {
  const f = await fixture(t, { voted: true });
  await f.session._playNext();
  assert.equal(f.heard.length, 1);
  assert.equal(f.session.getShowState().playlistShow.fallbackReason, 'Empty eligible pool');
  const { createPlaylistShow } = await import('../discord-bot/playlist-show.js');
  f.session._playlistShow = createPlaylistShow();
  await f.session._playNext();
  assert.equal(f.heard.length, 2);
  assert.match(f.session.getShowState().playlistShow.fallbackReason, /storage unavailable/);
});

test('show end finishes current audio, stale prefetch cannot start, and paid queue resumes after the hour', async t => {
  const f = await fixture(t);
  await f.session._playNext();
  const stale = await f.session._prepareNextPlayback();
  f.setNow(START + 3600_000);
  f.session._started = true;
  f.session._activeShowKey = 'playlist_show:tonight';
  f.session._syncScheduledShow({ requestPlayback: false });
  assert.equal(f.stops(), 0, 'ordinary 10pm handoff must finish current song');
  f.session._preparedNext = stale;
  await f.session._playNext();
  assert.equal(f.heard.length, 1, 'stale snapshot song cannot start beyond end');
  await f.session._playNext();
  assert.equal(f.heard.length, 2);
  assert.ok(f.paidCalls() > 0);
});

test('live and Top10 preemption cut off playlist audio at protected handoff', async t => {
  const f = await fixture(t);
  await f.session._playNext();
  f.session._started = true;
  f.session._activeShowKey = 'playlist_show:tonight';
  f.session.livePerformanceEvents.push({ ...event, id: 'live', type: 'live_performance' });
  f.session._syncScheduledShow({ requestPlayback: false });
  assert.equal(f.stops(), 1);
  assert.equal(f.session.getShowState().activeShow.type, 'live_performance');
  f.session.livePerformanceEvents = [{ ...event, endUtc: '2026-10-24T01:00:00Z' }];
  f.session._liveEventId = null;
  f.session._activeShowKey = 'playlist_show:tonight';
  f.player.state.status = 'playing';
  f.setNow(Date.parse('2026-10-24T00:00:00Z'));
  f.session._syncScheduledShow({ requestPlayback: false });
  assert.equal(f.stops(), 2);
  assert.equal(f.session.getShowState().activeShow.type, 'weekly_top10');
});

test('ordinary DeVert cadence stays active without advancing a playlist song; public API and Discord invite both votes', async t => {
  const f = await fixture(t);
  f.session._musicSinceAd = 10;
  f.session.devertPlayback.nextMainRadioAd = async () => [{ campaignId: '1', mainRadio: true,
    track: { trackId: 'ad', title: 'Ad', filename: 'ad.mp3', ipfsCid: 'ad-cid' } }];
  const ad = await f.session._prepareNextPlayback();
  assert.equal(ad.track.trackId, 'ad');
  assert.equal(ad.playlistShow, null);
  assert.equal(f.value(), null, 'ad preparation must not consume a playlist slot');
  f.session._disposePrepared(ad);
  f.session._preparedDevertAd = null;
  f.session._musicSinceAd = 0;
  await f.session._playNext();
  f.session._nowPlaying.audible = true;
  const state = f.buildRadioState({ nowPlaying: f.session._nowPlaying, playlist: [], ...f.session.getShowState() });
  assert.equal(state.activeShow.type, 'playlist_show');
  assert.equal(state.nowPlaying.playlistShow.title, 'Songs Awaiting Your Vote');
  assert.match(state.playlistShow.invitation, /Vote up OR down/);
  const announcement = f.buildNowPlayingMessage(f.tracks[0], { queueIndex: 1, totalTracks: 2,
    playlistShow: { title: 'Songs Awaiting Your Vote' } });
  assert.match(announcement, /Songs Awaiting Your Vote/);
  assert.match(announcement, /Vote up OR down/);
});

test('Discord bot-seeded up/down reactions remain zero and do not remove a song from the no-votes pool', async t => {
  const f = await fixture(t);
  const content = f.buildNowPlayingMessage(f.tracks[0], { queueIndex: 1, totalTracks: 2 });
  const message = { id: 'seeded-announcement', content, author: { id: 'bot', bot: true }, reactions: { cache: new Map([
    ['up', { emoji: { name: '👍' }, count: 1, me: true }],
    ['down', { emoji: { name: '👎' }, count: 1, me: true }],
  ]) } };
  f.synchronizeDiscordRating(message, 'bot');
  assert.equal(f.getPlaylist()[0].likes, 0);
  assert.equal(f.getPlaylist()[0].dislikes, 0);
  assert.notEqual(f.getPlaylist()[0].everHumanVoted, true);
  await f.session._playlistShow.ensure(f.session.getShowState().activeShow, f.getPlaylist());
  assert.equal(f.value().occurrences[0].tracks.length, 2);
});

test('a vote arriving during the progress checkpoint prevents audio and is recorded as a skip', async t => {
  const f = await fixture(t);
  const prepared = await f.session._prepareNextPlayback();
  const original = f.session._playlistShow.advance;
  f.session._playlistShow.advance = async (selection, reason) => {
    await original(selection, reason);
    f.applySiteVote(selection.trackId, 1);
  };
  f.session._preparedNext = prepared;
  await f.session._playNext();
  assert.equal(f.heard.length, 0);
  assert.equal(f.value().occurrences[0].cursor, 1);
  assert.equal(f.value().occurrences[0].skipped[0].trackId, prepared.track.trackId);
});

test('persistent progress-store outage falls back to audible normal rotation rather than retrying the snapshot silently forever', async t => {
  const f = await fixture(t);
  await f.session._playlistShow.ensure(f.session.getShowState().activeShow, f.getPlaylist());
  const { createPlaylistShow } = await import('../discord-bot/playlist-show.js');
  let saves = 0;
  f.session._playlistShow = createPlaylistShow({ store: { restore: async () => f.value(), save: async () => { saves++; throw new Error('progress store offline'); } } });
  await f.session._playNext();
  assert.equal(f.heard.length, 0, 'no uncheckpointed playlist sound');
  await f.session._playNext();
  assert.equal(f.heard.length, 1, 'ordinary music fills storage outage');
  assert.equal(f.session._nowPlaying.playlistShow.fallback, true);
  assert.match(f.session.getShowState().playlistShow.fallbackReason, /progress store offline/);
  assert.ok(saves >= 2);
});
