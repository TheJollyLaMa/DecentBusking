const test = require('node:test');
const assert = require('node:assert/strict');

test('radio calendar expands all weekly shows in New York time across DST, including Sunday midnight', async () => {
  const { radioCalendarOccurrences } = await import('../js/radio-calendar.mjs');
  const { defaultRadioSchedule } = await import('../js/radio-schedule.mjs');
  const events = radioCalendarOccurrences({ schedule: defaultRadioSchedule(), events: [] },
    { now: Date.parse('2026-10-30T12:00:00Z'), days: 10, pastDays: 0 });
  assert.equal(events.find(event => event.id === 'friday-top10-hype:2026-10-30').startUtc, '2026-10-31T00:00:00.000Z');
  assert.equal(events.find(event => event.id === 'friday-top10-hype:2026-11-06').startUtc, '2026-11-07T01:00:00.000Z');
  const finale = events.find(event => event.id === 'weekly-top10-final-listen:2026-11-01');
  assert.equal(finale.startUtc, '2026-11-02T04:00:00.000Z');
  assert.equal(finale.endUtc, '2026-11-02T05:00:00.000Z');
  assert.equal(events.some(event => event.id.startsWith('normal-rotation')), false);
});

test('calendar cancellations replace one recurring occurrence, preserving other weeks and stable UIDs', async () => {
  const { radioCalendarOccurrences, buildRadioCalendar } = await import('../js/radio-calendar.mjs');
  const { defaultRadioSchedule } = await import('../js/radio-schedule.mjs');
  const now = Date.parse('2026-10-30T12:00:00Z');
  const payload = { schedule: defaultRadioSchedule(), events: [] };
  const original = radioCalendarOccurrences(payload, { now, days: 10, pastDays: 0 });
  const live = original.find(event => event.id === 'friday-live-performance:2026-10-30');
  payload.events = [{ ...live, status: 'cancelled', cancellationReason: 'Artist unavailable' }];
  const updated = radioCalendarOccurrences(payload, { now, days: 10, pastDays: 0 });
  assert.equal(updated.filter(event => event.id === live.id).length, 1);
  assert.equal(updated.find(event => event.id === live.id).status, 'cancelled');
  assert.notEqual(updated.find(event => event.id === 'friday-live-performance:2026-11-06').status, 'cancelled');
  const initial = buildRadioCalendar([live], { now });
  const cancelled = buildRadioCalendar([payload.events[0]], { now: now + 1000 });
  assert.equal(initial.match(/UID:.*/)[0], cancelled.match(/UID:.*/)[0]);
  assert.match(cancelled, /STATUS:CANCELLED/);
  assert.match(cancelled, /Artist unavailable/);
  assert.doesNotMatch(cancelled, /VALARM/);
});

test('calendar exports UTC dates, safe folded UTF-8 text, CRLF lines and a 15-minute alarm', async () => {
  const { buildRadioCalendar, googleRadioCalendarUrl } = await import('../js/radio-calendar.mjs');
  const event = { id: 'custom-live', title: `Music, dance; \\ live\n${'🎶'.repeat(50)}`,
    startUtc: '2026-11-07T01:00:00Z', endUtc: '2026-11-07T02:00:00Z' };
  const ics = buildRadioCalendar([event], { now: Date.parse('2026-10-17T12:00:00Z') });
  assert.match(ics, /DTSTART:20261107T010000Z\r\nDTEND:20261107T020000Z/);
  assert.match(ics, /TRIGGER:-PT15M/);
  assert.ok(ics.includes('SUMMARY:Music\\, dance\\; \\\\ live\\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.equal(ics.replace(/\r\n/g, '').includes('\n'), false);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75);
  assert.equal(ics.includes('�'), false);
  const google = new URL(googleRadioCalendarUrl(event));
  assert.equal(google.origin, 'https://calendar.google.com');
  assert.equal(google.searchParams.get('dates'), '20261107T010000Z/20261107T020000Z');
  assert.equal(google.searchParams.get('text'), event.title);
  assert.match(google.searchParams.get('details'), /15 minutes/);
  assert.throws(() => googleRadioCalendarUrl({ ...event, status: 'cancelled' }), /canceled/);
  assert.throws(() => buildRadioCalendar([{ ...event, endUtc: 'bad' }]), /Invalid calendar event/);
});

test('calendar respects edited weekly slots and explicit live bookings without duplicates', async () => {
  const { radioCalendarOccurrences } = await import('../js/radio-calendar.mjs');
  const { defaultRadioSchedule } = await import('../js/radio-schedule.mjs');
  const event = { id: 'artist-live', title: 'Booked artist', startUtc: '2026-10-31T03:00:00Z', endUtc: '2026-10-31T04:00:00Z' };
  const events = radioCalendarOccurrences({ schedule: defaultRadioSchedule({
    'friday-top10-hype': { weekday: 5, startHourLocal: 19, endHourLocal: 20 },
  }), events: [event] }, { now: Date.parse('2026-10-30T12:00:00Z'), days: 1, pastDays: 0 });
  assert.equal(events.find(entry => entry.id === 'friday-top10-hype:2026-10-30').startUtc, '2026-10-30T23:00:00.000Z');
  assert.equal(events.filter(entry => entry.id === 'artist-live').length, 1);
});
