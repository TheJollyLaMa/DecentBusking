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
  assert.equal(performerRoomUrl({ ...b, status: 'paid', broadcastCompletion: { known: true, pending: true } }, start + 1200001),
    'live-room.html?booking=friday%3Ainvited', 'Allocated discovery link still requires separate current authorization');
  assert.deepEqual(b, before);
});

test('performer headphone monitor is directly visible, not hidden in collapsed help', async () => {
  const html = await fs.readFile(require.resolve('../live-room.html'), 'utf8');
  const publisher = html.slice(html.indexOf('<fieldset id="room-publisher"'), html.indexOf('<section class="remote-listen"'));
  const monitor = publisher.slice(publisher.indexOf('<fieldset class="self-monitor">'), publisher.indexOf('id="room-recording-option"'));
  assert.match(monitor, /Browser monitor · not used on air/);
  assert.match(monitor, /id="room-monitor-toggle"/);
  assert.match(monitor, /id="room-monitor-volume"/);
  assert.match(monitor, /id="room-monitor-status"/);
  assert.match(monitor, /id="room-monitor-mix"/);
  assert.match(monitor, /value="mono">Centered mono/);
  assert.match(monitor, /does not change the broadcast/);
  assert.doesNotMatch(monitor, /<\/details>/);
  assert.doesNotMatch(publisher.slice(0, publisher.indexOf('<fieldset class="self-monitor">')), /<details/);
});

test('booth setup is shown to every performer before publishing, and operators get the booth check', async () => {
  for (const [file, prefix, publish] of [['live-room.html', 'room-', 'room-publish'], ['rehearsal.html', '', 'publish']]) {
    const html = await fs.readFile(require.resolve(`../${file}`), 'utf8');
    const booth = html.indexOf(`id="${prefix}booth"`);
    assert.ok(booth > 0 && booth < html.indexOf(`id="${publish}"`), `${file}: booth setup precedes the mic button`);
    const card = html.slice(booth, html.indexOf('</fieldset>', booth));
    assert.match(card, /headphones into your <b>audio interface<\/b>/);
    assert.match(card, /<b>direct monitor<\/b> on/);
    assert.match(card, /<b>Turn the radio off<\/b>/);
    for (const value of ['direct', 'unplugged']) assert.match(card, new RegExp(`<option value="${value}"`));
    if (file === 'live-room.html') assert.doesNotMatch(card, /<option value="browser"/, 'shows never offer the delayed browser monitor');
    else assert.match(card, /<option value="browser">Browser monitor · delayed, practice only/);
    assert.match(card, new RegExp(`id="${prefix}booth-radio-off" type="checkbox"`));
    assert.doesNotMatch(card, /<details/, 'booth steps are never hidden in collapsed help');
  }
  const live = await fs.readFile(require.resolve('../live-room.html'), 'utf8');
  const operator = live.slice(live.indexOf('<fieldset id="room-owner"'), live.indexOf('id="room-check60"'));
  assert.match(operator, /Booth check · before T−60/);
  assert.match(operator, /headphones in the interface with direct monitor on<\/b>, or <b>unplugged<\/b>/);
  assert.match(operator, /Hear my input stays off/);
  assert.match(operator, /doubled or echoing/);
  const desk = await fs.readFile(require.resolve('../producer-room.html'), 'utf8');
  assert.match(desk, /headphones in the interface with direct monitor on, or unplugged/);
});

test('room module initializes practice, advances to backstage and fails closed on stale audio', async () => {
  const { performerRoomSign, performerAllocationAccess } = await import('../js/performer-room.mjs');
  const { bindLiveRecordingOption } = await import('../js/live-recording-option.mjs');
  const { afterpartyRows } = await import('../js/live-afterparty.mjs');
  const { renderAfterpartyChecklist } = await import('../js/live-afterparty-view.mjs');
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
    URL, AbortSignal, TextEncoder, performerRoomSign, performerAllocationAccess, bindLiveRecordingOption,
    afterpartyRows, renderAfterpartyChecklist,
    LIVE_RECORDING_CONSENT_VERSION: 'dbusk-live-recording-v1', LIVE_RECORDING_ALLOCATED_CONSENT_VERSION: 'dbusk-live-recording-v2',
    bindInputMonitor: () => ({ stop: async () => {} }), bindBoothSetup: () => ({ ready: () => true, problem: () => '' }), SHOW_MODES: ['direct', 'unplugged'],
    bindLiveDirection: () => ({ setSession() {}, dispose() {} }),
    bindLiveFeedbackRoom: () => ({ setSession() {}, dispose() {} }),
    bindTogether: primary => primary,
    bindLiveBroadcastControls: () => ({ update() {}, dispose() {} }),
    createLivePublisherPresence: () => ({ start: () => true, stop() {} }),
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
  const { performerRoomSign, performerAllocationAccess } = await import('../js/performer-room.mjs');
  const { bindLiveRecordingOption } = await import('../js/live-recording-option.mjs');
  const { afterpartyRows } = await import('../js/live-afterparty.mjs');
  const { renderAfterpartyChecklist } = await import('../js/live-afterparty-view.mjs');
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
    URL, AbortSignal, TextEncoder, performerRoomSign, performerAllocationAccess, bindLiveRecordingOption,
    afterpartyRows, renderAfterpartyChecklist,
    LIVE_RECORDING_CONSENT_VERSION: 'dbusk-live-recording-v1', LIVE_RECORDING_ALLOCATED_CONSENT_VERSION: 'dbusk-live-recording-v2',
    bindInputMonitor: () => ({ stop: async () => {} }), bindBoothSetup: () => ({ ready: () => true, problem: () => '' }), SHOW_MODES: ['direct', 'unplugged'],
    bindLiveDirection: () => ({ setSession() {}, dispose() {} }),
    bindLiveFeedbackRoom: () => ({ setSession() {}, dispose() {} }),
    bindTogether: primary => primary,
    bindLiveBroadcastControls: () => ({ update() {}, dispose() {} }),
    createLivePublisherPresence: () => ({ start: () => true, stop() {} }),
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

test('publisher protects the return before publication and releases it on stop, track end, disconnection or publication failure', async t => {
  const { performerRoomSign, performerAllocationAccess } = await import('../js/performer-room.mjs');
  const { bindLiveRecordingOption } = await import('../js/live-recording-option.mjs');
  const { afterpartyRows } = await import('../js/live-afterparty.mjs');
  const { renderAfterpartyChecklist } = await import('../js/live-afterparty-view.mjs');
  const { bindBoothSetup, SHOW_MODES } = await import('../js/booth-setup.mjs');
  const source = (await fs.readFile(require.resolve('../js/live-audio-room.mjs'), 'utf8')).replace(/^import .*;\n/gm, '');
  for (const outcome of ['stop', 'ended', 'disconnected', 'failed-publish', 'storage-denied', 'allocated-original-end']) {
    await t.test(outcome, async () => {
      const elements = new Map(), handlers = {}, order = [];
      let publishing = false, stopped = false, ended, time = start - 60000, broadcastBinding;
      const intervals = [], performer = `0x${'12'.repeat(20)}`;
      const audioState = () => outcome === 'allocated-original-end' ? {
        configured: true, bookingId: b.id, phase: 'live', armed: true, status: 'ON-AIR', serverTime: time,
        broadcast: { allocationId: 'allocation-a', revision: 1, phase: 'live', actualStartedAt: start,
          authorizedEndAt: start + 1800000, accessUntil: start + 1800000 },
      } : { configured: true, bookingId: b.id, phase: 'preflight' };
      const element = id => {
        if (!elements.has(id)) elements.set(id, { id, value: '', textContent: '', classList: { toggle() {} }, listeners: {},
          addEventListener(name, fn) { this.listeners[name] = fn; }, setAttribute() {}, removeAttribute() {}, pause() {} });
        return elements.get(id);
      };
      const capture = { stop() { stopped = true; },
        mediaStreamTrack: { addEventListener(name, fn) { assert.equal(name, 'ended'); ended = fn; } } };
      class Room {
        remoteParticipants = new Map();
        localParticipant = { async publishTrack(track, options) {
          order.push('publish');
          assert.equal(track, capture);
          assert.equal(options.forceStereo, true, 'Headphone mix must not change the broadcast');
          if (outcome === 'failed-publish') throw Error('Publication failed');
        } };
        on(name, fn) { handlers[name] = fn; }
        async connect() {}
        async disconnect() {}
      }
      const context = {
        document: { getElementById: element }, location: { href: `https://example.test/live-room.html?booking=${b.id}` },
        window: { DecentConfig: { ipfsUploadServiceUrl: 'https://worker.test' }, addEventListener() {},
          ethereum: { on() {}, async request({ method }) { return method === 'eth_requestAccounts' ? [performer] : 'signature'; } } },
        Date: class extends Date { static now() { return time; } },
        URL, AbortSignal, TextEncoder, performerRoomSign, performerAllocationAccess, bindLiveRecordingOption,
        afterpartyRows, renderAfterpartyChecklist,
        LIVE_RECORDING_CONSENT_VERSION: 'dbusk-live-recording-v1', LIVE_RECORDING_ALLOCATED_CONSENT_VERSION: 'dbusk-live-recording-v2',
        bindInputMonitor: () => ({ stop: async () => {} }), bindBoothSetup, SHOW_MODES,
        bindLiveDirection: () => ({ setSession() {}, dispose() {} }),
        bindLiveFeedbackRoom: () => ({ setSession() {}, dispose() {} }),
        bindTogether: primary => primary,
        bindLiveBroadcastControls: options => { broadcastBinding = options; return { update() {}, dispose() {} }; },
        createInputMeter: () => ({ start() {}, stop: async () => {} }),
        createLivePublisherPresence: ({ onError }) => ({
          start(id) {
            assert.equal(id, b.id);
            order.push('protect');
            if (outcome === 'storage-denied') { onError(Error('Storage denied')); return false; }
            publishing = true; return true;
          },
          stop() { publishing = false; return true; },
        }),
        loadLiveAudioSdk: async () => ({ Room, createLocalAudioTrack: async () => capture,
          RoomEvent: { Disconnected: 'disconnected' }, Track: { Source: { Microphone: 'microphone' } } }),
        roomRequest: async (_url, path) => path === 'challenge' ? { message: 'challenge', challengeId: 'fixture' }
          : path === 'session' ? { token: 'fixture-token', role: 'performer', canPublish: true,
            expiresAt: time < start + 1200000 ? start + 1200000 : start + 1800000, state: audioState() }
            : { url: 'fixture', token: 'fixture', publisherIdentity: 'performer' },
        setInterval(fn, ms) { intervals.push({ fn, ms }); },
        fetch: async url => ({ ok: true, json: async () => url.includes('/api/live-bookings')
          ? { bookings: [{ ...b, wallet: performer, status: outcome === 'allocated-original-end' && time >= start + 1200000 ? 'approved' : 'funded', acknowledged: true }] }
          : audioState() }),
      };
      vm.runInNewContext(source, context);
      const click = id => element(id).onclick({ currentTarget: element(id) });
      await new Promise(resolve => setImmediate(resolve));
      await click('room-authorize');
      assert.equal(element('room-publish').disabled, true, 'booth setup gates publishing');
      await click('room-publish');
      assert.deepEqual(order, [], 'an unready booth never opens or publishes the mic');
      assert.match(element('room-action-status').textContent, /Booth setup: choose how you will hear yourself/);
      element('room-booth-mode').value = 'direct';
      element('room-booth-radio-off').checked = true;
      element('room-booth-mode').listeners.change();
      assert.equal(element('room-publish').disabled, false);
      await click('room-publish');
      assert.deepEqual(order, ['protect', 'publish']);
      if (outcome === 'failed-publish') {
        assert.match(element('room-action-status').textContent, /Publication failed/);
      } else if (outcome === 'storage-denied') {
        assert.equal(stopped, false, 'Protection failure must not discard the microphone publication');
        assert.match(element('room-return-status').textContent, /protection is unavailable/);
        await click('room-stop');
      } else {
        assert.equal(publishing, true);
        assert.match(element('room-return-status').textContent, /live return is muted/);
        if (outcome === 'stop') await click('room-stop');
        if (outcome === 'ended') ended();
        if (outcome === 'disconnected') handlers.disconnected();
        if (outcome === 'allocated-original-end') {
          time = start + 1200001;
          intervals.find(entry => entry.ms === 10000).fn();
          await new Promise(resolve => setImmediate(resolve));
          assert.equal(stopped, false, 'Original contract end cannot stop a verified allocated publication');
          assert.equal(publishing, true);
          assert.equal(element('room-on-air').textContent, 'ON AIR');
          const renewed = await broadcastBinding.onReconnect();
          assert.equal(renewed.expiresAt, start + 1800000);
          assert.equal(stopped, false, 'Allocated pass renewal must not tear down the microphone');
          assert.deepEqual(order, ['protect', 'publish'], 'Renewal must not republish or change return protection');
          await click('room-stop');
        }
      }
      assert.equal(publishing, false);
      assert.match(element('room-return-status').textContent, /protection is off/);
    });

  }
});

test('allocated sign needs a fresh bounded actual live allocation, never original clock or advisory choice', async () => {
  const { performerRoomSign, performerAllocationAccess } = await import('../js/performer-room.mjs');
  const now = start + 1200001;
  const booking = { ...b, status: 'paid', acknowledged: true };
  const state = { configured: true, bookingId: b.id, phase: 'live', armed: true, status: 'ON-AIR', serverTime: now,
    broadcast: { allocationId: 'allocation-a', phase: 'live', actualStartedAt: start,
      authorizedEndAt: now + 10000, accessUntil: now + 20000 } };
  assert.equal(performerAllocationAccess(booking, state, now, now), true);
  assert.equal(performerRoomSign(booking, state, now, now).live, true);
  assert.equal(performerRoomSign(booking, state, now, now - 12001).live, false);
  for (const changed of [
    { ...state, bookingId: 'other' },
    { ...state, broadcast: { ...state.broadcast, phase: 'waiting' } },
    { ...state, broadcast: { ...state.broadcast, actualStartedAt: null } },
    { ...state, broadcast: { ...state.broadcast, authorizedEndAt: now - 1 } },
    { ...state, broadcast: { ...state.broadcast, accessUntil: now - 1 } },
  ]) assert.equal(performerRoomSign(booking, changed, now, now).live, false);
  const ended = performerRoomSign(booking, { ...state, broadcast: { ...state.broadcast, phase: 'ended', endReason: 'operator-cut' } }, now, now);
  assert.equal(ended.live, false);
  assert.match(ended.detail, /operator-cut/);
  assert.doesNotMatch(ended.detail, /successful|Thank you/);
});
