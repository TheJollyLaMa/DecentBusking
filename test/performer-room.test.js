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

test('performer headphone monitor is directly visible, not hidden in collapsed help', async () => {
  const html = await fs.readFile(require.resolve('../live-room.html'), 'utf8');
  const publisher = html.slice(html.indexOf('<fieldset id="room-publisher"'), html.indexOf('<section class="remote-listen"'));
  const monitor = publisher.slice(publisher.indexOf('<fieldset class="self-monitor">'), publisher.indexOf('id="room-recording-option"'));
  assert.match(monitor, /Your headphone monitor/);
  assert.match(monitor, /id="room-monitor-toggle"/);
  assert.match(monitor, /id="room-monitor-volume"/);
  assert.match(monitor, /id="room-monitor-status"/);
  assert.doesNotMatch(monitor, /<\/details>/);
  assert.doesNotMatch(publisher.slice(0, publisher.indexOf('<fieldset class="self-monitor">')), /<details/);
});

test('room module initializes practice, advances to backstage and fails closed on stale audio', async () => {
  const { performerRoomSign } = await import('../js/performer-room.mjs');
  const { bindLiveRecordingOption } = await import('../js/live-recording-option.mjs');
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, disabled: true, textContent: '', src: '', classList: { toggle() {} }, addEventListener() {},
      setAttribute(name, value) { this[name] = value; },
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
  assert.equal(element('room-practice-direct').href, element('room-practice-frame').src);
  assert.match(element('room-practice-directions').textContent, /7:50 PM.*8:00 PM and 8:45 PM New York/);
  assert.match(element('room-countdown').textContent, /Private practice/);
  time = start - 70 * 60000;
  intervals.find(entry => entry.ms === 1000).fn();
  assert.equal(element('room-practice').hidden, true);
  assert.equal(element('room-helper').hidden, false, 'backstage shows the outer guide after removing practice');
  assert.match(element('room-entry-directions').textContent, /Connect your performer or operator wallet/);
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

test('guided operator flow shows pending saves, persistent errors and saved check/arm states across public refresh', async () => {
  const { performerRoomSign } = await import('../js/performer-room.mjs');
  const { bindLiveRecordingOption } = await import('../js/live-recording-option.mjs');
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, hidden: false, disabled: true, textContent: '',
      classList: { toggle() {} }, addEventListener() {}, setAttribute(name, value) { this[name] = value; },
      removeAttribute() {}, paused: true, pause() { this.paused = true; },
      async play() { this.paused = false; } });
    return elements.get(id);
  };
  let time = start - 58 * 60000, completeCheck, rejectCheck;
  const selected = { ...b, status: 'funded', acknowledged: true };
  const state = { configured: true, phase: 'preflight', status: 'OFF-AIR', armed: false,
    bookingId: b.id, checks: {}, privateAudioFresh: true, serverTime: time };
  const intervals = [], handlers = {};
  class Room {
    remoteParticipants = new Map();
    on(name, fn) { handlers[name] = fn; }
    async connect() {}
    async disconnect() {}
    async startAudio() {}
  }
  const context = {
    document: { getElementById: element }, location: { href: `https://example.test/live-room.html?booking=${b.id}` },
    window: { DecentConfig: { ipfsUploadServiceUrl: 'https://worker.test' }, addEventListener() {},
      ethereum: { on() {}, async request({ method }) { return method === 'eth_requestAccounts' ? ['0xowner'] : 'fixture-signature'; } } },
    Date: class extends Date { static now() { return time; } },
    URL, AbortSignal, TextEncoder, performerRoomSign, bindLiveRecordingOption,
    bindInputMonitor: () => ({ stop: async () => {} }),
    createInputMeter: () => ({ start() {}, stop: async () => {} }),
    loadLiveAudioSdk: async () => ({ Room, RoomEvent: { TrackPublished: 'published', TrackSubscribed: 'subscribed',
      TrackUnsubscribed: 'unsubscribed', Disconnected: 'disconnected' }, Track: { Kind: { Audio: 'audio' } } }),
    roomRequest: async (_url, path, input) => {
      if (path === 'challenge') return { message: 'fixture challenge', challengeId: 'fixture' };
      if (path === 'session') return { token: 'fixture-token', role: 'owner', canPublish: false, state };
      if (input.action === 'connect') return { url: 'fixture', token: 'fixture', publisherIdentity: 'performer' };
      if (input.action === 'check') return new Promise((resolve, reject) => {
        completeCheck = () => { state.checks[input.check] = new Date(time).toISOString(); resolve(state); };
        rejectCheck = () => reject(new Error('Fixture durable save failed'));
      });
      if (input.action === 'arm') state.armed = true;
      return state;
    },
    setInterval(fn, ms) { intervals.push({ fn, ms }); },
    fetch: async url => ({ ok: true, json: async () => url.includes('/api/live-bookings')
      ? { bookings: [selected] } : { configured: true, bookingId: b.id, phase: 'preflight', serverTime: time } }),
  };
  const source = (await fs.readFile(require.resolve('../js/live-audio-room.mjs'), 'utf8')).replace(/^import .*;\n/gm, '');
  vm.runInNewContext(source, context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const click = id => element(id).onclick({ currentTarget: element(id) });
  await settle();
  await click('room-authorize');
  assert.equal(element('room-publisher').hidden, true);
  assert.equal(element('room-operator-listen').hidden, false);
  assert.equal(element('room-check15').disabled, true);
  await click('room-monitor');
  assert.match(element('room-listen-status').textContent, /Connected.*waiting/);
  handlers.subscribed({ kind: 'audio', attach() {}, detach() {} }, {}, { identity: 'performer' });
  await settle();
  assert.match(element('room-listen-status').textContent, /Playing performer audio/);
  const failedSave = click('room-check60');
  await settle();
  assert.match(element('room-step60-status').textContent, /Saving/);
  assert.equal(element('room-check60').disabled, true);
  rejectCheck(); await failedSave;
  intervals.find(entry => entry.ms === 2000).fn(); await settle();
  assert.match(element('room-action-status').textContent, /Fixture durable save failed/);
  assert.equal(element('room-action-status')['data-state'], 'error');
  const saved = click('room-check60');
  await settle(); completeCheck(); await saved;
  assert.equal(element('room-step60')['data-state'], 'passed');
  assert.match(element('room-step60-status').textContent, /PASSED.*saved/);
  assert.match(element('room-next-step').textContent, /8:45 PM/);
  intervals.find(entry => entry.ms === 10000).fn(); await settle();
  assert.equal(element('room-step60')['data-state'], 'passed', 'public refresh must not erase private checks');
  assert.equal(element('room-check60').disabled, true);
  time = start - 15 * 60000; state.serverTime = time;
  intervals.find(entry => entry.ms === 2000).fn(); await settle();
  assert.equal(element('room-check15').disabled, false);
  const second = click('room-check15');
  await settle(); completeCheck(); await second;
  assert.equal(element('room-arm').disabled, false);
  await click('room-arm');
  assert.equal(element('room-step-arm')['data-state'], 'passed');
  assert.match(element('room-step-arm-status').textContent, /ARMED.*saved/);
  assert.equal(element('room-arm').disabled, true);
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
