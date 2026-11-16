const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs/promises');
const settle = () => new Promise(resolve => setImmediate(resolve));

async function fixture() {
  let time = 100000, account = 'owner', walletChanged, pagehide, requestFailure = false;
  const elements = new Map(), calls = [], bindings = [], timers = [];
  const el = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', hidden: false, disabled: false, events: {},
      addEventListener(name, handler) { this.events[name] = handler; }, replaceChildren(...nodes) { this.children = nodes; } });
    return elements.get(id);
  };
  const bookings = ['a', 'b'].map((id, index) => ({
    id, mode: 'phase1', payoutPolicy: 'pilot-guaranteed-v1', stewardApproved: true, status: 'funded', acknowledged: true,
    displayName: `Artist ${id}`, startUtc: new Date(90000 + index * 100000).toISOString(),
    endUtc: new Date(900000 + index * 100000).toISOString(),
  }));
  const context = {
    document: { getElementById: el }, location: { href: 'https://fixture.test/producer-room.html?booking=a' },
    window: { DecentConfig: { ipfsUploadServiceUrl: 'https://worker.test' },
      addEventListener(_event, callback) { pagehide = callback; },
      ethereum: { on(_event, callback) { walletChanged = callback; },
        async request({ method }) { return method === 'eth_requestAccounts' ? [account] : 'signature'; } } },
    Date: class extends Date { static now() { return time; } },
    URL, AbortSignal, TextEncoder, Intl, console,
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    setInterval(fn, ms) { timers.push({ fn, ms }); return timers.length; }, clearInterval() {},
    radioEndpoint: service => `${service}/api/radio`,
    performerAllocationAccess: () => false,
    bindLiveBroadcastControls: () => ({ update() {}, dispose() {} }),
    readRadioState: async () => ({ nowPlaying: null, liveAudio: {
      configured: true, phase: 'live', armed: true, status: 'ON-AIR', bookingId: 'a',
      policy: { mode: 'live' }, performer: { artist: 'Artist a' }, bookingVerification: { fresh: true },
    } }),
    fetch: async () => ({ ok: !requestFailure, json: async () => ({ bookings }) }),
    roomRequest: async (_service, path, input) => {
      calls.push({ path, input: { ...input } });
      return path === 'challenge' ? { challengeId: input.bookingId, message: 'Booking fixture' }
        : { role: 'owner', token: `${input.challengeId}-pass`, expiresAt: 800000, state: { bookingId: input.challengeId } };
    },
    bindLiveFeedbackRoom: () => ({ setSession() {}, dispose() {} }),
    bindTogether: primary => primary,
    bindLiveDirection: options => {
      const binding = { options, session: null, disposed: false,
        setSession(session) { this.session = session; options.onState(session ? { bookingId: options.bookingId } : null); },
        dispose() { this.disposed = true; this.session = null; } };
      bindings.push(binding);
      return binding;
    },
    createPrivateRoomListener: () => ({
      async disconnect() { calls.push({ audio: 'disconnect' }); },
      async connect(session, bookingId) { calls.push({ audio: 'connect', token: session.token, bookingId }); },
    }),
  };
  const source = (await fs.readFile(require.resolve('../js/producer-room.mjs'), 'utf8')).replace(/^import .*;\n/gm, '');
  vm.runInNewContext(source, context);
  await settle();
  return { el, calls, bindings, timers,
    async click(id) { await el(id).events.click(); await settle(); },
    async select(id) { el('desk-booking').value = id; el('desk-booking').events.change(); await settle(); },
    changeWallet(value) { account = value; walletChanged([value]); },
    end() { pagehide(); }, time(value) { time = value; }, failSchedule() { requestFailure = true; } };
}

test('public roster renders before authorization and selected-room changes never change the public act', async () => {
  const f = await fixture();
  assert.match(f.el('desk-program').textContent, /Artist a/);
  assert.match(f.el('desk-selected').textContent, /Artist a/);
  assert.equal(f.el('desk-authorize').disabled, false);
  assert.equal(f.el('desk-listen').disabled, true);
  await f.select('b');
  assert.match(f.el('desk-selected').textContent, /Artist b/);
  assert.match(f.el('desk-program').textContent, /Artist a/);
  assert.equal(f.calls.some(call => call.path === 'challenge'), false);
});

test('separate passes are cached only in memory and are cleared on wallet change', async () => {
  const f = await fixture();
  await f.click('desk-authorize');
  assert.equal(f.el('desk-listen').disabled, false);
  await f.click('desk-listen');
  assert.deepEqual(f.calls.find(call => call.audio === 'connect'), { audio: 'connect', token: 'a-pass', bookingId: 'a' });
  await f.select('b');
  assert.equal(f.el('desk-listen').disabled, true);
  assert.equal(f.bindings.at(-1).session, null);
  await f.click('desk-authorize');
  assert.equal(f.calls.filter(call => call.path === 'challenge').length, 2);
  await f.select('a');
  assert.equal(f.el('desk-listen').disabled, false);
  assert.equal(f.calls.filter(call => call.path === 'challenge').length, 2);
  f.changeWallet('different');
  assert.equal(f.el('desk-listen').disabled, true);
  assert.equal(f.bindings.at(-1).session, null);
  await f.select('b');
  assert.equal(f.el('desk-listen').disabled, true);
  f.end();
  assert.equal(f.bindings.at(-1).disposed, true);
});

test('expired passes and unavailable schedule disable private entry with explicit guidance', async () => {
  const f = await fixture();
  await f.click('desk-authorize');
  f.time(800001);
  f.timers.find(timer => timer.ms === 1000).fn();
  assert.equal(f.el('desk-listen').disabled, true);
  assert.match(f.el('desk-auth-status').textContent, /expired/);
  f.failSchedule();
  await f.click('desk-refresh');
  assert.equal(f.el('desk-authorize').disabled, true);
  assert.match(f.el('desk-roster-status').textContent, /unavailable/);
});
