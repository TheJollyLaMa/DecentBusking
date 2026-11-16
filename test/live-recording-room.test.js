const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const vm = require('node:vm');

test('room explicitly signs and submits v2 on new opt-in and legacy renewal, with visible scope', async () => {
  const consent = await import('../js/live-recording-consent.mjs');
  const { bindLiveRecordingOption } = await import('../js/live-recording-option.mjs');
  const { performerRoomSign, performerAllocationAccess } = await import('../js/performer-room.mjs');
  const { afterpartyRows } = await import('../js/live-afterparty.mjs');
  const { renderAfterpartyChecklist } = await import('../js/live-afterparty-view.mjs');
  const source = (await fs.readFile(require.resolve('../js/live-audio-room.mjs'), 'utf8')).replace(/^import .*;\n/gm, '');
  const now = Date.parse('2026-11-14T02:00:00Z'), wallet = `0x${'12'.repeat(20)}`;
  for (const legacy of [false, true]) {
    const elements = new Map(), signed = [], commands = [];
    const el = id => {
      if (!elements.has(id)) elements.set(id, { id, value: '', textContent: '', hidden: false,
        classList: { toggle() {} }, addEventListener() {}, setAttribute() {}, removeAttribute() {}, pause() {} });
      return elements.get(id);
    };
    const booking = { id: 'booking-a', wallet, mode: 'phase1', payoutPolicy: 'pilot-guaranteed-v1',
      stewardApproved: true, acknowledged: true, status: 'funded',
      startUtc: new Date(now).toISOString(), endUtc: new Date(now + 1200000).toISOString() };
    const state = { bookingId: booking.id, configured: true, phase: 'live', armed: true, status: 'ON-AIR',
      recording: { available: true, canChange: true, consented: legacy } };
    const context = {
      ...consent, bindLiveRecordingOption, performerRoomSign, performerAllocationAccess, afterpartyRows, renderAfterpartyChecklist,
      URL, AbortSignal, TextEncoder,
      Date: class extends Date { static now() { return now; } },
      document: { getElementById: el }, location: { href: 'https://fixture.test/live-room.html?booking=booking-a', origin: 'https://fixture.test' },
      window: { DecentConfig: { ipfsUploadServiceUrl: 'https://worker.test' }, addEventListener() {},
        ethereum: { on() {}, async request({ method, params }) {
          if (method === 'eth_requestAccounts') return [wallet];
          signed.push(Buffer.from(params[0].slice(2), 'hex').toString('utf8'));
          return 'fixture-signature';
        } } },
      bindInputMonitor: () => ({ stop: async () => {} }), bindBoothSetup: () => ({ ready: () => true, problem: () => '' }), SHOW_MODES: ['direct', 'unplugged'],
      bindLiveDirection: () => ({ setSession() {}, dispose() {} }),
      bindLiveBroadcastControls: () => ({ update() {}, dispose() {} }),
      createLivePublisherPresence: () => ({ start() {}, stop() {} }),
      createInputMeter: () => ({ start() {}, stop: async () => {} }),
      setInterval() {},
      fetch: async url => ({ ok: true, json: async () => url.includes('/api/live-bookings') ? { bookings: [booking] } : state }),
      roomRequest: async (_service, path, input) => {
        if (path === 'challenge') return { challengeId: 'fixture', message: 'Access this booking' };
        if (path === 'session') return { token: 'performer-pass', role: 'performer', canPublish: true, expiresAt: now + 1200000, state };
        commands.push(input);
        state.recording = { ...state.recording, consented: input.enabled, consentVersion: input.consentVersion };
        return state;
      },
    };
    vm.runInNewContext(source, context);
    await new Promise(resolve => setImmediate(resolve));
    await el('room-authorize').onclick({ currentTarget: el('room-authorize') });
    assert.equal(el('room-recording-consent').checked, legacy);
    if (legacy) {
      assert.match(el('room-recording-scope').textContent, /Legacy permission v1/);
      assert.equal(el('room-recording-renew').hidden, false);
      assert.equal(commands.length, 0, 'Loading old permission cannot renew it');
      await el('room-recording-renew').onclick();
    } else {
      el('room-recording-consent').checked = true;
      await el('room-recording-consent').onchange();
    }
    assert.equal(commands.length, 1);
    assert.equal(commands[0].action, 'recording-consent');
    assert.equal(commands[0].consentVersion, consent.LIVE_RECORDING_ALLOCATED_CONSENT_VERSION);
    assert.match(signed.at(-1), /Version: dbusk-live-recording-v2/);
    assert.match(signed.at(-1), /authorized delayed start/);
    assert.match(el('room-recording-scope').textContent, /Permission v2/);
    assert.equal(el('room-recording-renew').hidden, true);
  }
});
