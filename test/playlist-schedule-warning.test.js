const test = require('node:test');
const assert = require('node:assert/strict');

const now = Date.parse('2026-10-25T16:00:00Z');
const song = `0x${'a'.repeat(64)}`;
const event = (startMinutes, endMinutes, extra = {}) => ({
  id: 'protected', type: 'playlist_show', title: 'Community hour',
  startUtc: new Date(now + startMinutes * 60000).toISOString(),
  endUtc: new Date(now + endMinutes * 60000).toISOString(), ...extra,
});
function input(count = 6) {
  return { now, songIds: Array(count).fill(song),
    calendar: { ready: true, schedule: [], events: [event(20, 80)] },
    queue: { tracks: [{ songId: song, trackId: 'song' }], requests: [], mainPending: 0, playlistPending: 0 },
    radio: { nowPlaying: null } };
}

test('playlist size triggers a warning only when its estimated window overlaps a public protected block', async () => {
  const { playlistScheduleConflict } = await import('../js/playlist-schedule-warning.mjs');
  assert.equal(playlistScheduleConflict(input(4)), null);
  assert.equal(playlistScheduleConflict(input(5)), null, 'finishing at the show boundary is not an overlap');
  const conflict = playlistScheduleConflict(input(6));
  assert.equal(conflict.event.title, 'Community hour');
  assert.equal(conflict.playlistMs, 24 * 60000);
  assert.equal(conflict.estimatedSongs, 6);
});

test('measured duration beats the size allowance; current and queued songs extend the conflict window', async () => {
  const { playlistScheduleConflict } = await import('../js/playlist-schedule-warning.mjs');
  const data = input(6);
  data.queue.tracks[0].durationSeconds = 60;
  assert.equal(playlistScheduleConflict(data), null);
  data.queue.requests = [{ songId: song }];
  data.queue.mainPending = 1;
  data.queue.playlistPending = 3;
  data.radio.nowPlaying = { trackId: 'song', durationMs: 240000, positionMs: 60000 };
  data.calendar.events = [event(15, 75)];
  const conflict = playlistScheduleConflict(data);
  assert.equal(conflict.playlistMs, 6 * 60000);
  assert.equal(conflict.waitMs, 16 * 60000, '1 queued minute + 12 unseen minutes + 3 current minutes');
  assert.equal(conflict.estimatedSongs, 3);
});

test('current protected shows warn, while completed, canceled and ordinary-rotation blocks do not', async () => {
  const { playlistScheduleConflict } = await import('../js/playlist-schedule-warning.mjs');
  const data = input(1);
  data.calendar.events = [event(-10, 50)];
  assert.ok(playlistScheduleConflict(data));
  for (const item of [event(-60, 0), event(-10, 50, { status: 'cancelled' }), event(-10, 50, { type: 'normal_rotation' })]) {
    data.calendar.events = [item];
    assert.equal(playlistScheduleConflict(data), null);
  }
  data.calendar.events = [event(5, 65), event(-10, 50, { id: 'active', type: 'live_performance' })];
  assert.equal(playlistScheduleConflict(data).event.id, 'active');
});

test('the currently playing paid request is not counted again as a full queued song', async () => {
  const { playlistScheduleConflict } = await import('../js/playlist-schedule-warning.mjs');
  const data = input(6);
  data.queue.tracks[0].durationMs = 240000;
  data.queue.mainPending = 1;
  data.queue.requests = [{ songId: song, requestId: 'paid-current' }];
  data.radio.nowPlaying = { trackId: 'song', positionMs: 180000,
    sponsor: { kind: 'djuke', requestId: 'paid-current' } };
  assert.equal(playlistScheduleConflict(data).waitMs, 60000);
});

test('weekly programs, Top 10 finale, midnight and DST use the same occurrence expansion as the public calendar', async () => {
  const { playlistScheduleConflict } = await import('../js/playlist-schedule-warning.mjs');
  const cases = [
    ['2026-10-24T00:50:00Z', { id: 'friday-live', type: 'live_performance', weekday: 5, startHourLocal: 21, endHourLocal: 22 }],
    ['2026-10-26T02:50:00Z', { id: 'finale', type: 'weekly_top10', window: 'final-payroll-hour' }],
    ['2026-11-02T03:50:00Z', { id: 'finale', type: 'weekly_top10', window: 'final-payroll-hour' }],
    ['2026-10-26T03:50:00Z', { id: 'midnight', type: 'playlist_show', weekday: 1, startMinuteLocal: 0, endMinuteLocal: 60 }],
  ];
  for (const [timestamp, show] of cases) {
    const data = input(6);
    data.now = Date.parse(timestamp);
    data.calendar = { ready: true, schedule: [{ ...show, label: show.id }], events: [] };
    assert.equal(playlistScheduleConflict(data).event.showId, show.id);
  }
});

test('canceled weekly occurrences override their regular slot instead of warning on a canceled show', async () => {
  const { playlistScheduleConflict } = await import('../js/playlist-schedule-warning.mjs');
  const data = input(6);
  data.now = Date.parse('2026-10-24T00:50:00Z');
  data.calendar.schedule = [{ id: 'friday-live', type: 'live_performance', label: 'Live',
    weekday: 5, startHourLocal: 21, endHourLocal: 22 }];
  data.calendar.events = [{ id: 'friday-live:2026-10-23', status: 'cancelled', type: 'live_performance',
    title: 'Canceled live', startUtc: '2026-10-24T01:00:00Z', endUtc: '2026-10-24T02:00:00Z' }];
  assert.equal(playlistScheduleConflict(data), null);
});

test('unready calendar, invalid times and missing queue timing fail explicitly, not as no-conflict', async () => {
  const { playlistScheduleConflict } = await import('../js/playlist-schedule-warning.mjs');
  const data = input();
  data.calendar.ready = false;
  assert.throws(() => playlistScheduleConflict(data), /calendar is not ready/);
  data.calendar.ready = true;
  data.calendar.events[0].endUtc = 'invalid';
  assert.throws(() => playlistScheduleConflict(data), /invalid show times/);
  data.calendar.events = [];
  delete data.queue.playlistPending;
  assert.throws(() => playlistScheduleConflict(data), /queue timing is unavailable/);
});

test('conflict copy identifies the dated block, estimate assumptions, resumption and separate failure refund policy', async () => {
  const { playlistScheduleConflict, playlistConflictMessage } = await import('../js/playlist-schedule-warning.mjs');
  const message = playlistConflictMessage(playlistScheduleConflict(input()));
  assert.match(message, /Community hour/);
  assert.match(message, /Sun, Oct 25/);
  assert.match(message, /EDT/);
  assert.match(message, /about 24 minutes/);
  assert.match(message, /rough 4-minute-per-song allowance/);
  assert.match(message, /Remaining songs return to the queue afterward without another payment/);
  assert.match(message, /no refund solely for that delay or interruption/);
  assert.match(message, /separate failed-delivery refunds still apply/);
  assert.match(message, /exact start and finish times are not guaranteed/);
});

test('each checkout reads fresh schedule, full queue counts and radio state in parallel; errors and aborts stay explicit', async () => {
  const { checkPlaylistSchedule } = await import('../js/playlist-schedule-warning.mjs');
  const data = input(1);
  const urls = [];
  const fetchImpl = async (url, options) => {
    urls.push(url);
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal);
    return { ok: true, json: async () => url.endsWith('/schedule') ? { ...data.calendar, events: [] }
      : url.endsWith('/api/djuke') ? data.queue : data.radio };
  };
  assert.equal(await checkPlaylistSchedule({ songIds: data.songIds,
    config: { ipfsUploadServiceUrl: 'https://worker.example/' }, fetchImpl }), null);
  assert.deepEqual(urls.sort(), ['https://worker.example/api/djuke', 'https://worker.example/api/radio',
    'https://worker.example/api/radio/schedule']);
  await assert.rejects(checkPlaylistSchedule({ songIds: data.songIds, config: {},
    fetchImpl: async () => ({ ok: false }) }), /Could not check.*no approval or purchase/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(checkPlaylistSchedule({ songIds: data.songIds, config: {}, signal: controller.signal,
    fetchImpl }), { name: 'AbortError' });
});
