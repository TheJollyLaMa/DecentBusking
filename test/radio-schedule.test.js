const test = require('node:test');
const assert = require('node:assert/strict');

const TOP10_START = new Date('2026-10-12T03:00:00Z').getTime();
const PAYROLL_BOUNDARY = new Date('2026-10-12T04:00:00Z').getTime();
const DST_PAYROLL_BOUNDARY = new Date('2026-11-02T05:00:00Z').getTime();
const FRIDAY_HYPE_START = new Date('2026-10-10T00:00:00Z').getTime();
const FRIDAY_LIVE_START = new Date('2026-10-10T01:00:00Z').getTime();
const FRIDAY_NORMAL_START = new Date('2026-10-10T02:00:00Z').getTime();
const FRIDAY_HYPE_START_STANDARD_TIME = new Date('2026-11-07T01:00:00Z').getTime();
const FRIDAY_LIVE_START_STANDARD_TIME = new Date('2026-11-07T02:00:00Z').getTime();
const SATURDAY = new Date('2026-10-10T12:00:00Z').getTime();
const UPCOMING = new Date('2026-10-10T13:00:00Z').getTime();

function track(id, votes = 0, plays = 0) {
  return { trackId: id, title: `Track ${id}`, votes, plays, uploader: 'Artist', enabled: true };
}

test('live performance calendar validates, upserts, cancels, and round-trips versioned snapshots', async () => {
  const { upsertLivePerformanceEvent, removeLivePerformanceEvent, serializeLiveSchedule, deserializeLiveSchedule } = await import('../js/radio-schedule.mjs');
  const events = upsertLivePerformanceEvent([], {
    id: 'live-1', title: 'Artist Live Set', startUtc: new Date(UPCOMING).toISOString(),
    endUtc: new Date(UPCOMING + 60 * 60 * 1000).toISOString(),
  }, { now: SATURDAY });
  assert.equal(events.length, 1);
  const state = { events, weeklySchedule: {} };
  assert.deepEqual(deserializeLiveSchedule(serializeLiveSchedule(state)), state);
  assert.deepEqual(removeLivePerformanceEvent(events, 'live-1'), []);
  assert.throws(() => upsertLivePerformanceEvent([], {
    id: 'bad', title: 'Too long', startUtc: new Date(SATURDAY - 1).toISOString(),
    endUtc: new Date(SATURDAY + 60 * 60 * 1000).toISOString(),
  }, { now: SATURDAY }), /future/);
  assert.throws(() => upsertLivePerformanceEvent([], {
    id: 'bad-duration', title: 'Too long', startUtc: new Date(UPCOMING).toISOString(),
    endUtc: new Date(UPCOMING + 5 * 60 * 60 * 1000).toISOString(),
  }, { now: SATURDAY }), /four hours/);
  assert.throws(() => upsertLivePerformanceEvent([], {
    id: 'ambiguous-time', title: 'Unzoned',
    startUtc: new Date(UPCOMING).toISOString().replace('Z', '-04:00'),
    endUtc: new Date(UPCOMING + 60 * 60 * 1000).toISOString(),
  }, { now: SATURDAY }), /Invalid live performance event/);
  assert.throws(() => deserializeLiveSchedule({ schemaVersion: 3, events: [] }), /unsupported/);
});

test('weekly programming overrides allow safe custom slots while preserving the Sunday payroll finale', async () => {
  const { defaultRadioSchedule, validateWeeklyScheduleOverrides, serializeLiveSchedule, deserializeLiveSchedule } = await import('../js/radio-schedule.mjs');
  const weeklySchedule = validateWeeklyScheduleOverrides({
    'friday-top10-hype': { weekday: 5, startHourLocal: 19, endHourLocal: 20 },
    'friday-live-performance': { weekday: 5, startHourLocal: 20, endHourLocal: 22 },
  });
  const schedule = defaultRadioSchedule(weeklySchedule);
  assert.deepEqual(schedule.filter(show => show.id.startsWith('friday-')).map(show => [show.startHourLocal, show.endHourLocal]), [[19, 20], [20, 22]]);
  assert.equal(schedule.find(show => show.window === 'final-payroll-hour').window, 'final-payroll-hour');
  assert.throws(() => validateWeeklyScheduleOverrides({
    'friday-top10-hype': { weekday: 5, startHourLocal: 19, endHourLocal: 21 },
    'friday-live-performance': { weekday: 5, startHourLocal: 20, endHourLocal: 22 },
  }), /overlap/);
  assert.throws(() => validateWeeklyScheduleOverrides({
    'friday-top10-hype': { weekday: 5, startHourLocal: 24, endHourLocal: 25 },
  }), /Invalid weekly programming/);
  const state = { events: [], weeklySchedule };
  assert.deepEqual(deserializeLiveSchedule(serializeLiveSchedule(state)), state);
  assert.deepEqual(deserializeLiveSchedule({ schemaVersion: 1, events: [] }), { events: [], weeklySchedule: {} });
});

test('schedule UI converts New York local inputs across DST and rejects skipped wall-clock times', async () => {
  const { newYorkInputToUtc, utcToNewYorkInput, formatWeeklySlot } = await import('../js/radio-schedule-ui.mjs');
  const daylight = newYorkInputToUtc('2026-10-09T20:00');
  const standard = newYorkInputToUtc('2026-11-06T20:00');
  assert.equal(daylight, '2026-10-10T00:00:00.000Z');
  assert.equal(standard, '2026-11-07T01:00:00.000Z');
  assert.equal(utcToNewYorkInput(daylight), '2026-10-09T20:00');
  assert.equal(formatWeeklySlot({ weekday: 5, startHourLocal: 23, endHourLocal: 24 }), 'Friday 11:00 PM - 12:00 AM (Saturday)');
  assert.throws(() => newYorkInputToUtc('2026-03-08T02:30'), /daylight-saving/);
});

test('default Top 10 finale runs during the last New York payroll hour and ends at Monday midnight', async () => {
  const { resolveActiveShow, defaultRadioSchedule } = await import('../js/radio-schedule.mjs');
  const schedule = defaultRadioSchedule();
  assert.equal(resolveActiveShow({ now: TOP10_START, schedule }).type, 'weekly_top10');
  assert.equal(resolveActiveShow({ now: PAYROLL_BOUNDARY - 1, schedule }).type, 'weekly_top10');
  assert.equal(resolveActiveShow({ now: PAYROLL_BOUNDARY, schedule }).type, 'normal_rotation');
  assert.equal(resolveActiveShow({ now: DST_PAYROLL_BOUNDARY - 1, schedule }).type, 'weekly_top10');
  assert.equal(resolveActiveShow({ now: DST_PAYROLL_BOUNDARY, schedule }).type, 'normal_rotation');
});

test('Friday Top 10 hype hour hands off to a live performance block at 9pm New York time', async () => {
  const { resolveActiveShow, defaultRadioSchedule } = await import('../js/radio-schedule.mjs');
  const schedule = defaultRadioSchedule();
  const hype = resolveActiveShow({ now: FRIDAY_HYPE_START, schedule });
  assert.equal(hype.type, 'weekly_top10');
  assert.equal(hype.label, 'Friday Top 10 Hype Hour');
  const live = resolveActiveShow({ now: FRIDAY_LIVE_START, schedule });
  assert.equal(live.type, 'live_performance');
  assert.equal(live.label, 'Friday Live Performance Block');
  assert.equal(live.event.id, 'friday-live-performance:2026-10-09');
  assert.equal(resolveActiveShow({ now: FRIDAY_NORMAL_START, schedule }).type, 'normal_rotation');
  assert.equal(resolveActiveShow({ now: FRIDAY_HYPE_START_STANDARD_TIME, schedule }).type, 'weekly_top10');
  assert.equal(resolveActiveShow({ now: FRIDAY_LIVE_START_STANDARD_TIME, schedule }).type, 'live_performance');
});

test('Top 10 radio queue uses New York payroll-week votes, not lifetime reactions', async () => {
  const { rankWeeklyTopTenTracks } = await import('../js/radio-schedule.mjs');
  const playlist = [
    { trackId: 'lifetime-favorite', title: 'Lifetime', likes: 500, plays: 90 },
    { trackId: 'weekly-winner', title: 'Weekly winner', likes: 0, plays: 1 },
    { trackId: 'unminted', title: 'Unminted', source: 'site', mintStatus: 'requested' },
  ];
  const report = { tracks: [
    { trackId: 'weekly-winner', votes: 8, plays: 1 },
    { trackId: 'lifetime-favorite', votes: -1, plays: 4 },
    { trackId: 'unminted', votes: 99, plays: 10 },
  ] };
  assert.deepEqual(rankWeeklyTopTenTracks(playlist, report).map(track => track.trackId), ['weekly-winner', 'lifetime-favorite']);
});

test('live performance override wins over weekly Top 10 and regular rotation', async () => {
  const { resolveActiveShow, buildRadioProgram, defaultRadioSchedule } = await import('../js/radio-schedule.mjs');
  const schedule = defaultRadioSchedule();
  const live = [{ id: 'live-1', type: 'live_performance', title: 'Live Set', startUtc: '2026-10-11T23:50:00-04:00', endUtc: '2026-10-12T00:10:00-04:00', priority: 200 }];
  const active = resolveActiveShow({ now: PAYROLL_BOUNDARY - 10 * 60 * 1000, schedule, livePerformanceEvents: live });
  assert.equal(active.type, 'live_performance');
  const program = buildRadioProgram({
    now: PAYROLL_BOUNDARY - 10 * 60 * 1000,
    schedule,
    tracks: [track('a', 10, 5), track('b', 5, 1)],
    livePerformanceEvents: live,
    topTenTracks: [track('a', 10, 5), track('b', 5, 1)],
    adCampaigns: [],
  });
  assert.equal(program[0].type, 'live');
});

test('DeVert ads are inserted into the main radio cadence at ten-song intervals and keep overflow separate', async () => {
  const { buildRadioProgram, defaultRadioSchedule } = await import('../js/radio-schedule.mjs');
  const songs = [
    track('a', 15, 20), track('b', 13, 14), track('c', 12, 10),
    track('d', 10, 8), track('e', 9, 7), track('f', 8, 6),
    track('g', 7, 5), track('h', 6, 4), track('i', 5, 3), track('j', 4, 2),
    track('k', 3, 1), track('l', 2, 1),
  ];
  const ads = [
    { id: 'ad-1', title: 'Hype', offerUnits: '5000000', mainRadio: true, campaignId: 'ad-1', kind: 'devert' },
    { id: 'ad-2', title: 'Club', offerUnits: '7000000', mainRadio: true, campaignId: 'ad-2', kind: 'devert' },
    { id: 'ad-3', title: 'Overflow', offerUnits: '4000000', mainRadio: false, campaignId: 'ad-3', kind: 'devert' },
  ];
  const schedule = defaultRadioSchedule();
  const program = buildRadioProgram({
    now: SATURDAY,
    schedule,
    tracks: songs,
    topTenTracks: songs.slice(0, 3),
    adCampaigns: ads,
    songsPerMainAd: 10,
  });
  const songCount = program.filter(entry => entry.type === 'song').length;
  const adCount = program.filter(entry => entry.type === 'ad').length;
  assert.equal(songCount, 12);
  assert.equal(adCount, 1);
  assert.equal(program[10].type, 'ad');
  assert.equal(program[11].type, 'song');
});

test('normal rotation keeps its weighted order independently of the Top 10 pool', async () => {
  const { buildRadioProgram, defaultRadioSchedule } = await import('../js/radio-schedule.mjs');
  const schedule = defaultRadioSchedule();
  const songs = [track('low', 1, 1), track('mid', 10, 5), track('high', 50, 30), track('t10', 9, 4)];
  const program = buildRadioProgram({
    now: SATURDAY,
    schedule,
    tracks: songs,
    topTenTracks: [track('high', 50, 30), track('mid', 10, 5), track('t10', 9, 4)],
    adCampaigns: [],
  });
  assert.equal(program[0].trackId, 'high');
  assert.equal(program[1].trackId, 'mid');
  assert.equal(program[2].type, 'song');
  assert.ok(program.some(entry => entry.type === 'song'));
});
