const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const NOW = Date.parse('2026-10-26T16:00:00Z');
const WEEK = 'NY-2026-10-26';
const PREVIOUS = 'NY-2026-10-19';
const track = (id, current, previous, plays = 1) => ({ trackId: id, title: id, likes: 0, dislikes: 0,
  payrollVotes: { [WEEK]: current, [PREVIOUS]: previous }, payrollPlays: { [WEEK]: plays } });
const program = extra => ({ id: 'program-test', title: 'Our hour', playlistId: 'rising-stars',
  weekday: 2, startMinuteLocal: 630, startDateLocal: '2026-11-03', announce: true, ...extra });

test('calendar offers scheduling presets without a front-end rule builder', () => {
  const source = readFileSync(require.resolve('../js/radio-programming-calendar.mjs'), 'utf8');
  assert.doesNotMatch(source, /presetEditor|Rule preset|Save preset|Rule preset builder/);
  assert.match(source, /for \(const preset of presets\(\)\)/);
  assert.match(source, /button\('\+ Live block'/);
});

test('Rising Stars requires known positive net votes improving on the prior payroll week', async () => {
  const { previewRadioPlaylist } = await import('../js/radio-playlists.mjs');
  const catalog = [track('small', 2, 1), track('big', 8, 2), track('flat', 3, 3), track('falling', 2, 4),
    track('zero', 0, -1), track('unknown', 6, undefined), track('null', 6, null),
    track('negative', -1, -2), track('disabled', 9, 1)];
  catalog.at(-1).enabled = false;
  assert.deepEqual(previewRadioPlaylist('rising-stars', catalog, { now: NOW }).tracks.map(t => t.trackId), ['big', 'small']);
});

test('Top 10 ranking uses payroll score then plays, returns exactly ten, and excludes inactive tracks', async () => {
  const { previewRadioPlaylist } = await import('../js/radio-playlists.mjs');
  const catalog = Array.from({ length: 14 }, (_, i) => track(`song-${i}`, i, 0));
  catalog.push(track('tie-more-plays', 13, 0, 9), track('no-activity', 0, 0, 0));
  const preview = previewRadioPlaylist('top10-hour', catalog, { now: NOW });
  assert.equal(preview.count, 10);
  assert.deepEqual(preview.tracks.slice(0, 2).map(t => t.trackId), ['tie-more-plays', 'song-13']);
  assert.equal(preview.tracks.some(t => t.trackId === 'no-activity'), false);
});

test('structured custom rules survive normalization/checkpoints and reject executable or invalid input', async () => {
  const { validateRadioPreset, previewRadioPlaylist } = await import('../js/radio-playlists.mjs');
  const { serializeLiveSchedule, deserializeLiveSchedule } = await import('../js/radio-schedule.mjs');
  const preset = validateRadioPreset({ id: 'preset-climbers', title: 'Climbers', revision: 2,
    selector: 'weekly-growth', ranking: 'weekly-growth', limit: 1, arbitraryCode: 'ignored' });
  assert.equal(preset.arbitraryCode, undefined);
  assert.throws(() => validateRadioPreset({ ...preset, selector: 'eval' }), /Invalid/);
  assert.throws(() => validateRadioPreset({ ...preset, limit: 101 }), /Invalid/);
  const weeklySchedule = { presets: [preset], programs: [program({ playlistId: preset.id, playlistDefinition: preset })],
    reminders: { 'friday-top10-hype': false } };
  const restored = deserializeLiveSchedule(serializeLiveSchedule({ events: [], weeklySchedule }));
  assert.deepEqual(restored.weeklySchedule, weeklySchedule);
  const result = previewRadioPlaylist(preset.id, [track('a', 2, 1), track('b', 6, 1)], { now: NOW, definition: preset });
  assert.deepEqual(result.tracks.map(t => t.trackId), ['b']);
});

test('weekly programs respect their first date, minute precision, DST and live active-show resolution', async () => {
  const { defaultRadioSchedule, resolveActiveShow } = await import('../js/radio-schedule.mjs');
  const { radioCalendarOccurrences } = await import('../js/radio-calendar.mjs');
  const schedule = defaultRadioSchedule({ programs: [program()] });
  const occurrences = radioCalendarOccurrences({ schedule }, { now: NOW, days: 15 }).filter(e => e.showId === 'program-test');
  assert.equal(occurrences[0].startUtc, '2026-11-03T15:30:00.000Z');
  assert.equal(occurrences[0].endUtc, '2026-11-03T16:30:00.000Z');
  const active = resolveActiveShow({ now: Date.parse('2026-11-03T15:31:00Z'), schedule });
  assert.equal(active.type, 'playlist_show');
  assert.equal(active.playlistId, 'rising-stars');
  assert.equal(resolveActiveShow({ now: Date.parse('2026-10-27T14:31:00Z'), schedule }).type, 'normal_rotation');
});

test('conflicts are rejected against defaults, recurring hours and dated shows; adjoining hours are allowed', async () => {
  const { validateWeeklyScheduleOverrides, validateRadioProgrammingConflicts, validateLivePerformanceSchedule } = await import('../js/radio-schedule.mjs');
  assert.throws(() => validateWeeklyScheduleOverrides({ programs: [program({ announce: 'false' })] }), /announcement preference/);
  assert.throws(() => validateLivePerformanceSchedule([{ announce: 'false' }]), /Announcement preference/);
  assert.throws(() => validateWeeklyScheduleOverrides({ programs: [program({ weekday: 5, startMinuteLocal: 1230 })] }), /overlap/);
  assert.throws(() => validateWeeklyScheduleOverrides({ 'friday-top10-hype': { weekday: 5, startHourLocal: 21, endHourLocal: 22 } }), /overlap/);
  assert.throws(() => validateWeeklyScheduleOverrides({ programs: [program({ weekday: 0, startMinuteLocal: 1380 })] }), /overlap/);
  const event = { id: 'one-time', type: 'playlist_show', playlistId: 'top10-hour', title: 'Top 10',
    startUtc: '2026-11-03T16:00:00Z', endUtc: '2026-11-03T17:00:00Z' };
  const weekly = { programs: [program()] };
  assert.throws(() => validateRadioProgrammingConflicts([event], weekly, { now: NOW }), /overlaps/);
  assert.doesNotThrow(() => validateRadioProgrammingConflicts([{ ...event, startUtc: '2026-11-03T16:30:00Z' }], weekly, { now: NOW }));
  assert.doesNotThrow(() => validateRadioProgrammingConflicts([{ ...event, status: 'cancelled' }], weekly, { now: NOW }));
});

test('calendar weeks use New York civil dates through DST and year boundaries', async () => {
  const { programmingWeek } = await import('../js/radio-programming-calendar.mjs');
  assert.deepEqual(programmingWeek(Date.parse('2026-11-01T04:30:00Z')), [
    '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  assert.equal(programmingWeek(Date.parse('2026-12-31T12:00:00Z'), 1)[0], '2027-01-04');
});

test('recurring spring-gap starts advance explicitly; autumn repeats once for sixty actual minutes', async () => {
  const { defaultRadioSchedule } = await import('../js/radio-schedule.mjs');
  const { radioCalendarOccurrences } = await import('../js/radio-calendar.mjs');
  const schedule = defaultRadioSchedule({ programs: [program({ weekday: 0, startMinuteLocal: 150, startDateLocal: '2026-03-01' })] });
  const spring = radioCalendarOccurrences({ schedule }, { now: Date.parse('2026-03-08T05:00:00Z'), days: 0 })
    .find(e => e.id === 'program-test:2026-03-08');
  assert.equal(spring.startUtc, '2026-03-08T07:30:00.000Z');
  assert.match(spring.timeAdjustment, /Moved forward/);
  assert.equal(Date.parse(spring.endUtc) - Date.parse(spring.startUtc), 3600000);
  const autumnSchedule = defaultRadioSchedule({ programs: [program({ weekday: 0, startMinuteLocal: 90, startDateLocal: '2026-10-01' })] });
  const autumn = radioCalendarOccurrences({ schedule: autumnSchedule }, { now: Date.parse('2026-11-01T04:00:00Z'), days: 0 })
    .filter(e => e.id === 'program-test:2026-11-01');
  assert.equal(autumn.length, 1);
  assert.equal(autumn[0].startUtc, '2026-11-01T05:30:00.000Z');
  assert.equal(Date.parse(autumn[0].endUtc) - Date.parse(autumn[0].startUtc), 3600000);
});

test('weekly hours can cross midnight and cannot overlap across day/week boundaries', async () => {
  const { defaultRadioSchedule, validateWeeklyScheduleOverrides } = await import('../js/radio-schedule.mjs');
  const { radioCalendarOccurrences } = await import('../js/radio-calendar.mjs');
  const { formatWeeklySlot } = await import('../js/radio-schedule-ui.mjs');
  const night = program({ weekday: 1, startMinuteLocal: 1410, startDateLocal: '2026-10-26' });
  const schedule = defaultRadioSchedule({ programs: [night] });
  const event = radioCalendarOccurrences({ schedule }, { now: NOW, days: 1 }).find(e => e.showId === night.id);
  assert.equal(event.startUtc, '2026-10-27T03:30:00.000Z');
  assert.equal(event.endUtc, '2026-10-27T04:30:00.000Z');
  assert.equal(formatWeeklySlot(schedule.find(s => s.id === night.id)), 'Monday 11:30 PM - Tuesday 12:30 AM');
  for (const weekday of [1, 6]) {
    assert.throws(() => validateWeeklyScheduleOverrides({ programs: [
      { ...night, weekday }, program({ id: 'program-next', weekday: (weekday + 1) % 7, startMinuteLocal: 0 }),
    ] }), /overlap/);
  }
});

test('custom ranked playlist snapshot survives restart without reshuffling and carries its rule to playback', async () => {
  const { createPlaylistShow } = await import('../discord-bot/playlist-show.js');
  const { validateRadioPreset } = await import('../js/radio-playlists.mjs');
  const definition = validateRadioPreset({ id: 'preset-growth', title: 'Growth', selector: 'weekly-growth',
    ranking: 'weekly-growth', limit: 0, revision: 1 });
  const show = { instanceId: 'test-hour', type: 'playlist_show', playlistId: definition.id, playlistDefinition: definition,
    label: 'Growth', startAt: new Date(NOW).toISOString(), endAt: new Date(NOW + 3600000).toISOString() };
  let snapshot;
  const store = { restore: async () => snapshot, save: async value => { snapshot = structuredClone(value); return 'ipfs://test'; } };
  const catalog = [track('small', 2, 1), track('big', 9, 2)];
  const runner = createPlaylistShow({ store, now: () => NOW, random: () => { throw new Error('Ranked hours must not shuffle'); } });
  const first = await runner.next(show, catalog);
  assert.equal(first.trackId, 'big');
  assert.deepEqual(first.playlistDefinition, definition);
  assert.equal(first.capturedAt, new Date(NOW).toISOString());
  await runner.advance(first);
  const restored = createPlaylistShow({ store, now: () => NOW + 1000 });
  assert.equal((await restored.next(show, catalog)).trackId, 'small');
});
