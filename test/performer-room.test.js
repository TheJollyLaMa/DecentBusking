const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const vm = require('node:vm');
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

test('room module initializes practice, advances to backstage and fails closed on stale audio', async () => {
  const { performerRoomSign } = await import('../js/performer-room.mjs');
  const { bindLiveRecordingOption } = await import('../js/live-recording-option.mjs');
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, disabled: true, textContent: '', src: '', classList: { toggle() {} }, addEventListener() {},
      removeAttribute(name) { this[name] = ''; },
    });
    return elements.get(id);
  };
  let time = start - 86400000, selected = { ...b }, liveState;
  const intervals = [];
  const context = {
    document: { getElementById: element },
    location: { href: `https://example.test/live-room.html?booking=${encodeURIComponent(b.id)}` },
    window: { DecentConfig: { ipfsUploadServiceUrl: 'https://worker.test' }, addEventListener() {} },
    Date: class extends Date { static now() { return time; } },
    URL, AbortSignal, TextEncoder, performerRoomSign, bindLiveRecordingOption,
    bindInputMonitor: () => ({ stop: async () => {} }),
    createInputMeter: () => ({ start() {}, stop: async () => {} }),
    setInterval(fn, ms) { intervals.push({ fn, ms }); },
    fetch: async url => ({ ok: true, json: async () => url.includes('/api/live-bookings')
      ? { bookings: [selected] } : liveState }),
  };
  const source = (await fs.readFile(require.resolve('../js/live-audio-room.mjs'), 'utf8'))
    .replace(/^import .*;\n/gm, '');
  vm.runInNewContext(source, context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  assert.equal(element('room-practice').hidden, false);
  assert.equal(element('room-helper').hidden, true, 'embedded practice owns the sole visible DBusker help');
  assert.match(element('room-practice-frame').src, /rehearsal.html\?booking=friday%3Ainvited/);
  assert.match(element('room-countdown').textContent, /Private practice/);
  time = start - 70 * 60000;
  intervals.find(entry => entry.ms === 1000).fn();
  assert.equal(element('room-practice').hidden, true);
  assert.equal(element('room-helper').hidden, false, 'backstage shows the outer guide after removing practice');
  assert.equal(element('room-practice-frame').src, '');
  selected = { ...b, status: 'funded', acknowledged: true };
  liveState = { configured: true, bookingId: b.id, status: 'ON-AIR', phase: 'live', armed: true };
  time = start;
  intervals.find(entry => entry.ms === 10000).fn();
  await settle();
  assert.equal(element('room-on-air').textContent, 'ON AIR');
  time += 12001;
  intervals.find(entry => entry.ms === 1000).fn();
  assert.equal(element('room-on-air').textContent, 'OFF AIR');
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
