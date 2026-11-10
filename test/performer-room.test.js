const test = require('node:test');
const assert = require('node:assert/strict');
const start = Date.parse('2026-11-14T02:00:00Z');
const b = { id: 'friday:invited', mode: 'phase1', payoutPolicy: 'pilot-guaranteed-v1', stewardApproved: true,
  status: 'draft', startUtc: new Date(start).toISOString(), endUtc: new Date(start + 1200000).toISOString() };

test('stable practice room link is available before acceptance but never authorizes or marks funded', async () => {
  const { performerRoomUrl } = await import('../js/performer-room.mjs');
  const before = structuredClone(b);
  assert.equal(performerRoomUrl(b, start - 86400000), 'live-room.html?booking=friday%3Ainvited');
  for (const change of [{ cancelled: true }, { stewardApproved: false }, { status: 'paid' }, { payoutPolicy: '' }]) {
    assert.equal(performerRoomUrl({ ...b, ...change }, start - 1), null);
  }
  assert.equal(performerRoomUrl(b, start + 1200000), null);
  assert.deepEqual(b, before);
});

test('on-air sign requires fresh verified server state, exact booking and funded acceptance; clock alone never lights it', async () => {
  const { performerRoomSign } = await import('../js/performer-room.mjs');
  const eligible = { ...b, status: 'funded', acknowledged: true };
  const state = { configured: true, bookingId: b.id, phase: 'live', armed: true, status: 'ON-AIR' };
  assert.match(performerRoomSign(b, null, start - 86400000).detail, /1d 00:00:00.*Private practice/);
  assert.match(performerRoomSign(b, null, start - 70 * 60000).detail, /Soundcheck time/);
  assert.equal(performerRoomSign(b, state, start, start).live, false);
  assert.equal(performerRoomSign(eligible, null, start, start).live, false);
  assert.equal(performerRoomSign(eligible, state, start, start - 12001).live, false);
  assert.equal(performerRoomSign(eligible, state, start, start).live, true);
  for (const change of [{ armed: false }, { status: 'RECONNECTING' }, { phase: 'cancelled' },
    { bookingId: 'other' }, { configured: false }]) {
    assert.equal(performerRoomSign(eligible, { ...state, ...change }, start, start).live, false);
  }
  assert.equal(performerRoomSign(eligible, state, start + 1200000, start + 1200000).live, false);
});
