const test = require('node:test');
const assert = require('node:assert/strict');
const START = Date.parse('2026-10-23T01:00:00Z');
const ID = 'songs-awaiting-your-vote';
const song = (trackId, extra = {}) => ({ trackId, title: trackId, likes: 0, dislikes: 0, ...extra });
const event = (extra = {}) => ({ id: 'tonight', type: 'playlist_show', playlistId: ID, title: 'Songs Awaiting Your Vote',
  startUtc: new Date(START).toISOString(), endUtc: new Date(START + 3600_000).toISOString(), ...extra });
async function setup(catalog = [song('a'), song('b'), song('c')]) {
  const { createPlaylistShow } = await import('../discord-bot/playlist-show.js');
  const { resolveActiveShow } = await import('../js/radio-schedule.mjs');
  const show = resolveActiveShow({ now: START, livePerformanceEvents: [event()] });
  let value = null;
  let writes = 0;
  const store = { restore: async () => value && structuredClone(value), save: async next => {
    value = structuredClone(next); writes++; return 'ipfs://confirmed';
  } };
  const runner = createPlaylistShow({ store, now: () => START, random: () => 0 });
  return { runner, show, catalog, store, createPlaylistShow, value: () => value, writes: () => writes };
}

test('no-votes-ever uses separate all-time human totals: 0/0 only, excluding net-zero, unknown, ads and unapproved', async () => {
  const { previewRadioPlaylist } = await import('../js/radio-playlists.mjs');
  const preview = previewRadioPlaylist(ID, [song('zero', { durationMs: 120000 }), song('site', { source: 'site', mintStatus: 'minted', durationMs: 60000 }),
    song('net-zero', { likes: 1, dislikes: 1 }), song('up', { likes: 1 }), song('down', { dislikes: 1 }),
    song('missing', { likes: undefined }), song('incomplete', { voteTotalsComplete: false }), song('null', { dislikes: null }),
    song('ad', { isDevertAd: true }), song('pending', { source: 'site', mintStatus: 'requested' }),
    song('disabled', { enabled: false }), song('removed', { available: false }), song('removed-vote', { everHumanVoted: true })]);
  assert.deepEqual(preview.tracks.map(track => track.trackId), ['zero', 'site']);
  assert.equal(preview.unknownCount, 3);
  assert.equal(preview.estimatedDurationMs, 180000);
});

test('opening shuffle and progress survive restart without reshuffle, additions or repeat; exhaustion returns null', async () => {
  const f = await setup();
  await f.runner.ensure(f.show, f.catalog);
  assert.deepEqual(f.value().occurrences[0].tracks.map(track => track.trackId), ['b', 'c', 'a']);
  const first = await f.runner.next(f.show, f.catalog);
  await f.runner.advance(first);
  const restarted = f.createPlaylistShow({ store: f.store, now: () => START + 60000, random: () => { throw new Error('Must not reshuffle'); } });
  const catalog = [...f.catalog, song('late')];
  const second = await restarted.next(f.show, catalog);
  assert.equal(second.trackId, 'c');
  await restarted.advance(second);
  await restarted.advance(await restarted.next(f.show, catalog));
  assert.equal(await restarted.next(f.show, catalog), null);
  assert.equal(restarted.publicState(f.show).fallbackReason, 'Eligible pool exhausted');
});

test('drops newly voted songs before their turn and records skipped reason; currently playing votes do not rewind progress', async () => {
  const f = await setup();
  const first = await f.runner.next(f.show, f.catalog);
  await f.runner.advance(first);
  f.catalog.find(track => track.trackId === first.trackId).likes = 1;
  f.catalog.find(track => track.trackId === 'c').dislikes = 1;
  const next = await f.runner.next(f.show, f.catalog);
  assert.equal(next.trackId, 'a');
  assert.equal(f.runner.publicState(f.show).cursor, 2);
  assert.match(f.runner.publicState(f.show).skipped[0].reason, /human vote/);
});

test('empty, failed persistence and unknown-only pools expose a normal rotation fallback', async () => {
  const f = await setup([song('unknown', { likes: undefined })]);
  assert.equal(await f.runner.next(f.show, f.catalog), null);
  assert.equal(f.runner.publicState(f.show).fallbackReason, 'Empty eligible pool');
  assert.equal(f.runner.publicState(f.show).unknownCount, 1);
  const unavailable = f.createPlaylistShow();
  await assert.rejects(unavailable.next(f.show, [song('a')]), /storage unavailable/);
  assert.equal(unavailable.publicState(f.show).status, 'normal_rotation');
  assert.match(unavailable.publicState(f.show).fallbackReason, /storage unavailable/);
});

test('playlist one-off scheduling honors tonight ET, DST, cancellation, v1/v2 compatibility and live/Top10 precedence', async () => {
  const { newYorkInputToUtc } = await import('../js/radio-calendar.mjs');
  const { upsertLivePerformanceEvent, serializeLiveSchedule, deserializeLiveSchedule, resolveActiveShow, cancelLivePerformanceEvent } = await import('../js/radio-schedule.mjs');
  assert.equal(newYorkInputToUtc('2026-10-22T21:00'), '2026-10-23T01:00:00.000Z');
  assert.equal(newYorkInputToUtc('2026-11-05T21:00'), '2026-11-06T02:00:00.000Z');
  assert.throws(() => newYorkInputToUtc('2026-03-08T02:30'), /daylight-saving/);
  const events = upsertLivePerformanceEvent([], event(), { now: START - 1000 });
  const snapshot = serializeLiveSchedule({ events, weeklySchedule: {} });
  assert.equal(snapshot.schemaVersion, 3);
  assert.deepEqual(deserializeLiveSchedule(snapshot).events, events);
  for (const schemaVersion of [1, 2]) assert.deepEqual(deserializeLiveSchedule({ schemaVersion, events: [] }).events, []);
  assert.equal(resolveActiveShow({ now: START, livePerformanceEvents: events }).type, 'playlist_show');
  assert.equal(resolveActiveShow({ now: START + 3600_000, livePerformanceEvents: events }).type, 'normal_rotation');
  assert.equal(resolveActiveShow({ now: START, livePerformanceEvents: [...events, event({ id: 'live', type: 'live_performance' })] }).type, 'live_performance');
  const friday = Date.parse('2026-10-24T00:00:00Z');
  assert.equal(resolveActiveShow({ now: friday, livePerformanceEvents: [event({ startUtc: new Date(friday).toISOString(), endUtc: new Date(friday + 3600_000).toISOString() })] }).type, 'weekly_top10');
  const duringLive = event({ startUtc: '2026-10-24T01:00:00Z', endUtc: '2026-10-24T02:00:00Z' });
  const cancelledDuringLive = cancelLivePerformanceEvent([], duringLive, 'Playlist canceled');
  const unbooked = resolveActiveShow({ now: Date.parse(duringLive.startUtc), livePerformanceEvents: cancelledDuringLive });
  assert.equal(unbooked.type, 'normal_rotation');
  assert.equal(unbooked.unbookedLiveOccurrenceId, 'friday-live-performance:2026-10-23');
  const cancelled = cancelLivePerformanceEvent(events, events[0], 'Canceled by owner');
  assert.equal(cancelled[0].type, 'playlist_show');
  assert.equal(cancelled[0].playlistId, ID);
  assert.equal(resolveActiveShow({ now: START, livePerformanceEvents: cancelled }).type, 'normal_rotation');
  assert.throws(() => upsertLivePerformanceEvent(events, event({ id: 'overlap' }), { now: START - 1000 }), /cannot overlap/);
});

test('initial checkpoint retries retain the opening shuffle despite new candidates/votes; corrupt snapshots are never overwritten', async () => {
  const f = await setup();
  const save = f.store.save;
  let first;
  f.store.save = async value => { first = structuredClone(value); throw new Error('offline'); };
  await assert.rejects(f.runner.ensure(f.show, f.catalog), /offline/);
  f.catalog.push(song('late'));
  f.catalog[0].likes = 1;
  f.store.save = save;
  await f.runner.ensure(f.show, f.catalog);
  assert.deepEqual(f.value().occurrences[0].tracks, first.occurrences[0].tracks);
  const broken = f.createPlaylistShow({ store: { restore: async () => ({ schemaVersion: 999 }),
    save: async () => { throw new Error('must not overwrite invalid history'); } } });
  await assert.rejects(broken.ensure(f.show, f.catalog), /Invalid playlist-show checkpoint/);
});

test('admin preview shows rule, matching count, duration/unknown totals and protected-show conflict before scheduling', async t => {
  const previous = global.document;
  t.after(() => { if (previous === undefined) delete global.document; else global.document = previous; });
  const elements = Object.fromEntries(Object.entries({
    'admin-radio-event-type': 'playlist_show', 'admin-radio-event-playlist': ID,
    'admin-radio-event-start': '2026-10-23T20:00', 'admin-radio-event-end': '2026-10-23T21:00',
    'admin-radio-event-id': '', 'admin-radio-playlist-preview': '',
  }).map(([id, value]) => [id, { value, textContent: '' }]));
  global.document = { getElementById: id => elements[id] };
  const { previewRadioPlaylist } = await import('../js/radio-playlists.mjs');
  const { defaultRadioSchedule } = await import('../js/radio-schedule.mjs');
  const { renderPlaylistShowPreview } = await import('../js/admin-radio-playlists.mjs');
  const payload = { playlistDefinitions: [previewRadioPlaylist(ID, [song('a', { durationMs: 7200000 }), song('unknown', { likes: null })])],
    schedule: defaultRadioSchedule(), events: [] };
  renderPlaylistShowPreview(payload);
  const output = elements['admin-radio-playlist-preview'].textContent;
  assert.match(output, /upvotes = 0 AND downvotes = 0/);
  assert.match(output, /1 matching tracks/);
  assert.match(output, /estimated 120 minutes/);
  assert.match(output, /1 tracks excluded/);
  assert.match(output, /exceeds this slot/);
  assert.match(output, /Friday Top 10/);
  assert.match(output, /Paid DJuke requests wait/);
  payload.playlistDefinitions[0].estimatedDurationMs = null;
  renderPlaylistShowPreview(payload);
  assert.match(elements['admin-radio-playlist-preview'].textContent, /duration unknown/);
});

test('snapshot captures the start-boundary catalog before waiting for durable restore', async () => {
  const f = await setup();
  let release;
  f.store.restore = () => new Promise(resolve => { release = resolve; });
  const ensuring = f.runner.ensure(f.show, f.catalog);
  await new Promise(resolve => setImmediate(resolve));
  f.catalog.push(song('arrived-during-restore'));
  release(null);
  await ensuring;
  assert.equal(f.value().occurrences[0].tracks.length, 3);
});
