const test = require('node:test');
const assert = require('node:assert/strict');

test('cancelled Friday occurrence survives validation and leaves Hype and future Fridays intact', async () => {
  const { cancelLivePerformanceEvent, validateLivePerformanceSchedule, resolveActiveShow } = await import('../js/radio-schedule.mjs');
  const occurrence = { id: 'friday-live-performance:2026-10-16', title: 'Mock live show',
    startUtc: '2026-10-17T01:00:00.000Z', endUtc: '2026-10-17T02:00:00.000Z' };
  const now = Date.parse('2026-10-17T00:55:00Z');
  const events = validateLivePerformanceSchedule(cancelLivePerformanceEvent([], occurrence, 'Mock-up only'), { now });
  assert.equal(events[0].status, 'cancelled');
  assert.equal(events[0].cancellationReason, 'Mock-up only');
  assert.equal(resolveActiveShow({ now, livePerformanceEvents: events }).id, 'friday-top10-hype');
  for (const time of ['2026-10-17T01:00:00Z', '2026-10-17T01:30:00Z', '2026-10-17T01:59:59Z']) {
    assert.equal(resolveActiveShow({ now: Date.parse(time), livePerformanceEvents: events }).type, 'normal_rotation');
  }
  const nextFriday = resolveActiveShow({ now: Date.parse('2026-10-24T01:30:00Z'), livePerformanceEvents: events });
  assert.equal(nextFriday.type, 'normal_rotation');
  assert.equal(nextFriday.unbookedLiveOccurrenceId, 'friday-live-performance:2026-10-23');
  assert.equal(nextFriday.cancelledOccurrenceId, undefined);
  assert.throws(() => cancelLivePerformanceEvent([], occurrence, ''), /reason/);
  assert.equal(validateLivePerformanceSchedule(events, { now: Date.parse('2026-10-18T01:00:00Z') }).length, 1);
});

test('one-off cancellation does not leave underlying recurring live block running', async () => {
  const { cancelLivePerformanceEvent, resolveActiveShow } = await import('../js/radio-schedule.mjs');
  const events = cancelLivePerformanceEvent([], { id: 'special-booking', title: 'Special booking',
    startUtc: '2026-10-17T01:00:00Z', endUtc: '2026-10-17T02:00:00Z' }, 'Artist unavailable');
  assert.equal(resolveActiveShow({ now: Date.parse('2026-10-17T01:30:00Z'), livePerformanceEvents: events }).type, 'normal_rotation');
});

test('public calendar generates cancellable Friday occurrences without duplicating cancelled records', async () => {
  const { scheduledLiveOccurrences } = await import('../js/radio-schedule-ui.mjs');
  const { defaultRadioSchedule } = await import('../js/radio-schedule.mjs');
  const now = Date.parse('2026-10-17T00:55:00Z');
  const payload = { schedule: defaultRadioSchedule(), events: [] };
  const events = scheduledLiveOccurrences(payload, now);
  const tonight = events.find(event => event.id === 'friday-live-performance:2026-10-16');
  assert.equal(tonight.startUtc, '2026-10-17T01:00:00.000Z');
  assert.equal(tonight.endUtc, '2026-10-17T02:00:00.000Z');
  payload.events = [{ ...tonight, status: 'cancelled', cancellationReason: 'Mock-up only' }];
  assert.equal(scheduledLiveOccurrences(payload, now).filter(event => event.id === tonight.id).length, 1);
});
