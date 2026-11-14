const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');

const tick = () => new Promise(resolve => setImmediate(resolve));
const initialTime = 100000;
const makeState = (extra = {}) => ({
  schemaVersion: 1, serverTime: initialTime, epoch: 'epoch-one', bookingId: 'booking-a', revision: 0,
  capabilities: { cue: true, notifyDelay: true, message: true },
  performerPresence: null, readiness: null, cue: null, finished: null, delay: null, messages: [],
  cursor: { epoch: 'epoch-one', sequence: 0 }, resetRequired: false,
  chat: { persistence: 'memory-only', retentionMs: 1800000, maxMessages: 100, maxTextLength: 500, expiresAt: initialTime + 600000 },
  limits: { pollIntervalMs: 3000, heartbeatIntervalMs: 15000 },
  ...extra,
});
async function fixture(extra = {}) {
  const { createLiveDirection } = await import('../js/live-direction.mjs');
  let time = initialTime, state = makeState(extra), view, revoked, handler, serial = 0;
  const calls = [];
  const session = { token: 'owner-pass', role: 'owner', expiresAt: initialTime + 600000, state: { bookingId: 'booking-a' } };
  const client = createLiveDirection({
    bookingId: 'booking-a', serviceUrl: 'https://worker.test', now: () => time, uuid: () => `command-${++serial}`,
    onChange(next) { view = next; }, onSessionExpired(reason) { revoked = reason; },
    request: async (_service, path, input, token) => {
      calls.push({ path, input, token });
      if (handler) return handler(input);
      return input.action === 'direction-state' ? structuredClone(state)
        : { commandId: input.commandId, applied: true, state: structuredClone(state) };
    },
  });
  client.setSession(session);
  await tick();
  return { client, calls, session, get view() { return view; }, get revoked() { return revoked; },
    time(value) { time = value; }, state(value) { state = value; }, handler(value) { handler = value; } };
}

test('direction uses the existing token only, exact booking snapshots and explicit capabilities', async () => {
  const f = await fixture();
  assert.equal(f.view.fresh, true);
  await f.client.send('cue', { kind: 'wrap-up' });
  assert.deepEqual(f.calls[1].input, {
    kind: 'wrap-up', action: 'direction-cue', epoch: 'epoch-one', commandId: 'command-1', expectedRevision: 0,
  });
  assert.equal(f.calls[1].token, 'owner-pass');
  assert.equal(Object.hasOwn(f.calls[1].input, 'bookingId'), false);
  await assert.rejects(f.client.send('finished'), /unavailable/);
  await assert.rejects(f.client.send('end-broadcast'), /unavailable/);
  f.time(initialTime + 15000);
  f.client.tick();
  await tick();
  assert.equal(f.calls.some(call => call.input.action === 'direction-heartbeat'), false, 'Owner polling is not performer presence');
});

test('performer heartbeat has no revision or command id and chat never changes schedule', async () => {
  const f = await fixture({ capabilities: { setReadiness: true, message: true } });
  f.client.tick();
  await tick();
  const heartbeat = f.calls.find(call => call.input.action === 'direction-heartbeat');
  assert.deepEqual(heartbeat.input, { action: 'direction-heartbeat', epoch: 'epoch-one' });
  await f.client.send('message', { text: 'Ready when you are' });
  const sent = f.calls.at(-1).input;
  assert.equal(sent.action, 'direction-message');
  assert.equal(Object.hasOwn(sent, 'expectedRevision'), false);
  assert.equal(Object.hasOwn(sent, 'effectiveEndUtc'), false);
});

test('stale reports disable mutations without implying that audio stopped', async () => {
  const f = await fixture();
  f.time(initialTime + 12001);
  f.handler(() => Promise.reject(new Error('Direction service unavailable')));
  f.client.tick();
  await tick();
  assert.equal(f.view.fresh, false);
  assert.equal(f.view.session, true);
  assert.match(f.view.message, /Audio controls are unaffected/);
  await assert.rejects(f.client.send('cue', { kind: 'another-song' }), /unavailable/);
});

test('snapshot from another booking is rejected without exposing its private messages', async () => {
  const f = await fixture();
  f.state(makeState({ bookingId: 'other', messages: [{ id: 'secret', senderRole: 'owner', sentAt: initialTime, text: 'other room' }] }));
  await f.client.refresh();
  assert.equal(f.view.snapshot.bookingId, 'booking-a');
  assert.deepEqual(f.view.messages, []);
  assert.match(f.view.message, /does not match/);
});

test('wallet/session clearing ignores late private responses and clears messages', async () => {
  const f = await fixture();
  let resolve;
  f.handler(() => new Promise(done => { resolve = done; }));
  const pending = f.client.refresh();
  f.client.setSession(null);
  resolve(makeState({ messages: [{ id: 'a', senderRole: 'owner', sentAt: initialTime, text: 'late private message' }] }));
  await pending;
  assert.equal(f.view.session, false);
  assert.equal(f.view.snapshot, null);
  assert.deepEqual(f.view.messages, []);
});

test('epoch reset clears cues and messages and requires reauthorization without automatic resending', async () => {
  const f = await fixture({ messages: [{ id: 'a', senderRole: 'owner', sentAt: initialTime, text: 'old' }] });
  f.state(makeState({ epoch: 'epoch-two' }));
  await f.client.refresh();
  assert.equal(f.view.session, false);
  assert.deepEqual(f.view.messages, []);
  assert.match(f.revoked, /restart/);
  assert.equal(f.calls.length, 2);
});

test('session expiry clears private state and prevents further requests', async () => {
  const f = await fixture();
  f.time(f.session.expiresAt);
  f.client.tick();
  assert.equal(f.view.session, false);
  assert.equal(f.calls.length, 1);
  assert.match(f.revoked, /ended/);
});

test('message delta is deduplicated and expired content is removed locally', async () => {
  const one = { id: 'one', senderRole: 'owner', sentAt: initialTime, text: 'One' };
  const f = await fixture({ messages: [one], chat: { persistence: 'memory-only', retentionMs: 5000, maxMessages: 100 } });
  f.state(makeState({ messages: [one, { ...one, id: 'two', text: 'Two' }], cursor: { epoch: 'epoch-one', sequence: 2 },
    chat: { retentionMs: 5000, maxMessages: 100 } }));
  await f.client.refresh();
  assert.equal(f.view.messages.length, 2);
  assert.equal(f.calls.at(-1).input.cursor.epoch, 'epoch-one');
  f.time(initialTime + 6000);
  f.handler(() => Promise.reject(new Error('offline')));
  f.client.tick();
  await tick();
  assert.equal(f.view.messages.length, 0);
});

test('uncertain mutation is never automatically resent; explicit retry keeps its original id', async () => {
  const f = await fixture();
  f.handler(() => Promise.reject(new Error('network lost')));
  assert.equal(await f.client.send('cue', { kind: 'another-song' }), false);
  const original = f.calls.at(-1).input;
  assert.equal(f.view.canRetry, true);
  await assert.rejects(f.client.send('cue', { kind: 'wrap-up' }), /unknown outcome/);
  f.handler(input => ({ commandId: input.commandId, applied: false, state: makeState() }));
  assert.equal(await f.client.retry(), true);
  assert.deepEqual(f.calls.at(-1).input, original);
  assert.equal(f.view.canRetry, false);
});

test('stale revision conflict has an explicit error and no automatic retry', async () => {
  const f = await fixture();
  f.handler(() => { throw Object.assign(new Error('Conflict'), { status: 409 }); });
  await f.client.send('cue', { kind: 'wrap-up' });
  assert.match(f.view.message, /Refresh and review/);
  assert.equal(f.view.canRetry, false);
  assert.equal(f.calls.length, 2);
});

test('out-of-order heartbeat snapshots cannot roll back the latest performer presence', async () => {
  const f = await fixture({ serverTime: initialTime + 100,
    performerPresence: { lastSeenAt: initialTime + 100, expiresAt: initialTime + 30100 } });
  f.state(makeState({ performerPresence: null }));
  await f.client.refresh();
  assert.equal(f.view.snapshot.performerPresence.lastSeenAt, initialTime + 100);
});

function dom() {
  const doc = { createElement(tag) {
    return { tag, textContent: '', value: '', children: [], attrs: {}, dataset: {}, ownerDocument: doc,
      classList: { add() {} }, handlers: {},
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = nodes; },
      setAttribute(name, value) { this.attrs[name] = value; },
      addEventListener(name, callback) { this.handlers[name] = callback; },
    };
  } };
  return doc;
}
const descendants = node => [node, ...node.children.flatMap(descendants)];

test('shared card keeps private text as text, role-gates actions and handles stale readiness', async () => {
  const { bindLiveDirection } = await import('../js/live-direction.mjs');
  const doc = dom(), container = doc.createElement('section');
  let time = initialTime, timer;
  const state = makeState({ capabilities: { setReadiness: true, acknowledgeCue: true, acknowledgeDelay: true, declareFinished: true, message: true },
    performerPresence: { lastSeenAt: initialTime, expiresAt: initialTime + 1000 },
    readiness: { ready: true, updatedAt: initialTime, expiresAt: initialTime + 1000 },
    messages: [{ id: 'one', senderRole: 'owner', sentAt: initialTime, text: '<img src=x onerror=alert(1)>' }],
    cue: { id: 'cue', kind: 'wrap-up', sentAt: initialTime, expiresAt: initialTime + 1000 } });
  const binding = bindLiveDirection({ container, serviceUrl: '', bookingId: 'booking-a', now: () => time,
    environment: { setInterval(fn) { timer = fn; }, clearInterval() {}, confirm: () => true },
    request: async () => structuredClone(state) });
  binding.setSession({ token: 'pass', expiresAt: initialTime + 60000, state: { bookingId: 'booking-a' } });
  await tick();
  let nodes = descendants(container);
  assert.equal(nodes.find(node => node.textContent === 'Cue: another song').hidden, true);
  assert.equal(nodes.find(node => node.textContent === 'Acknowledge cue').disabled, false);
  assert.ok(nodes.some(node => node.tag === 'li' && node.textContent.includes('<img')));
  assert.equal(nodes.some(node => node.tag === 'img'), false);
  assert.ok(nodes.some(node => /messages expire after 30 minutes/.test(node.textContent)));
  assert.ok(nodes.some(node => /Ready backstage ·/.test(node.textContent)));
  time += 1001;
  timer();
  nodes = descendants(container);
  assert.equal(nodes.find(node => node.textContent === 'Acknowledge cue').disabled, true);
  assert.ok(nodes.some(node => /Last reported ready; confirmation is stale/.test(node.textContent)));
  binding.setSession(null);
  assert.equal(descendants(container).filter(node => node.tag === 'li').length, 0);
  assert.equal(descendants(container).some(node => /Last reported ready/.test(node.textContent)), false);
  binding.dispose();
  assert.equal(container.children.length, 0);
});

test('desk and performer surfaces keep audience placeholders truthful and have no transition controls', async () => {
  for (const file of ['live-room.html', 'producer-room.html']) {
    const html = await fs.readFile(require.resolve(`../${file}`), 'utf8');
    assert.match(html, /Audience feedback/);
    assert.match(html, /unavailable/);
    assert.doesNotMatch(html, /onclick=|autoplay|end-broadcast|take-live/);
  }
  const html = await fs.readFile(require.resolve('../producer-room.html'), 'utf8');
  assert.match(html, /Selecting a name does not grant private access/);
  assert.match(html, /Your microphone is never opened/);
  const source = await fs.readFile(require.resolve('../js/producer-room.mjs'), 'utf8');
  assert.doesNotMatch(source, /localStorage|sessionStorage|createLocalAudioTrack|publishTrack/);
});

test('not-playing choice reports not ready and sends a notice without cancellation or payment commands', async () => {
  const { bindLiveDirection } = await import('../js/live-direction.mjs');
  const doc = dom(), container = doc.createElement('section'), calls = [];
  const state = makeState({ capabilities: { setReadiness: true, message: true } });
  const binding = bindLiveDirection({ container, serviceUrl: '', bookingId: 'booking-a', now: () => initialTime,
    environment: { setInterval() {}, clearInterval() {}, confirm(text) { assert.match(text, /does not cancel your guaranteed fee/); return true; } },
    request: async (_url, _path, input) => {
      calls.push(input);
      if (input.action === 'direction-state') return structuredClone(state);
      state.revision++;
      return { commandId: input.commandId, applied: true, state: structuredClone(state) };
    } });
  binding.setSession({ token: 'performer-pass', expiresAt: initialTime + 60000, state: { bookingId: 'booking-a' } });
  await tick();
  await descendants(container).find(node => node.textContent === 'Not playing this slot — notify owner').handlers.click();
  assert.deepEqual(calls.slice(1).map(input => input.action), ['direction-readiness', 'direction-message']);
  assert.equal(calls[1].ready, false);
  assert.match(calls[2].text, /does not waive my original guaranteed fee/);
  binding.dispose();
});
