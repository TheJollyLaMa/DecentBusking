const test = require('node:test');
const assert = require('node:assert/strict');
const NOW = 100000;
function dom() {
  const doc = { createElement(tag) { return { tag, textContent: '', value: '', children: [], attrs: {}, dataset: {}, ownerDocument: doc,
    classList: { add() {} }, events: {}, append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; }, setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(name, callback) { this.events[name] = callback; } }; } };
  return doc;
}
const nodes = node => [node, ...node.children.flatMap(nodes)];
async function fixture(options = {}) {
  const { bindLiveBroadcastControls } = await import('../js/live-broadcast-controls.mjs');
  const doc = dom(), container = doc.createElement('section'), calls = [], confirmations = [], nextPasses = [];
  let time = NOW, handler, serial = 0, timer;
  let state = { bookingId: 'a', serverTime: NOW, configured: true, phase: 'live', broadcast: {
    allocationId: 'allocated-a', revision: 7, phase: 'live', actualStartedAt: NOW - 1000, plannedStartAt: NOW - 1000,
    effectiveSetEndAt: NOW + 1200000, authorizedEndAt: NOW + 1200000, encoreMs: 0, remainingEncoreMs: 600000, accessUntil: NOW + 1800000 },
    broadcastControl: { choice: 'contracted', finishedId: null }, broadcastCapabilities: {
      grantEncore: true, reserveNext: true, endBroadcast: true, ...options.capabilities } };
  let session = { role: 'owner', token: 'a-owner', expiresAt: NOW + 600000, state };
  const binding = bindLiveBroadcastControls({ container, bookingId: 'a', serviceUrl: 'worker',
    getSession: () => session,
    getBooking: () => ({ id: 'a', startUtc: new Date(NOW - 1000).toISOString(), endUtc: new Date(NOW + 1199000).toISOString() }),
    getCandidates: () => [{ id: 'a', displayName: 'Artist a' }, { id: 'b', displayName: 'Artist b' }],
    getNextPass: async id => { nextPasses.push(id); return { role: 'owner', token: `${id}-owner`, expiresAt: NOW + 1000000,
      state: { bookingId: id, broadcast: { revision: 4 } } }; },
    onReconnect: async () => { session = { ...session, expiresAt: NOW + 1800000 }; return session; },
    onState: value => { state = value; },
    now: () => time, environment: { crypto: { randomUUID: () => `command-${++serial}` },
      setInterval(fn) { timer = fn; }, clearInterval() {}, confirm(text) { confirmations.push(text); return true; } },
    request: async (_service, _path, input, token) => {
      calls.push({ input, token });
      if (handler) return handler(input);
      if (input.action === 'state') return state;
      const result = { ...state, broadcast: { ...state.broadcast, revision: state.broadcast.revision + 1 } };
      return { commandId: input.commandId, applied: true, state: result };
    },
  });
  binding.update(state);
  return { binding, container, calls, nextPasses, confirmations,
    find: text => nodes(container).find(node => node.textContent === text),
    control: label => nodes(container).find(node => node.attrs['aria-label'] === label),
    text: () => nodes(container).map(node => node.textContent).join('\n'),
    async click(text) { await nodes(container).find(node => node.textContent === text).events.click(); },
    state(value) { state = value; binding.update(state); }, get stateValue() { return state; },
    time(value) { time = value; }, tick() { timer(); }, handler(value) { handler = value; },
    session(value) { session = value; }, get pass() { return session; },
  };
}

test('durable encore uses broadcast revision, remains bounded and is never an advisory cue', async () => {
  const f = await fixture();
  f.control('Additional encore minutes').value = '3';
  await f.click('Authorize additional encore');
  assert.deepEqual(f.calls[0], { input: {
    action: 'broadcast-encore', commandId: 'command-1', expectedRevision: 7, additionalMs: 180000,
  }, token: 'a-owner' });
  assert.ok(f.confirmations[0].includes('original guaranteed fees'));
  f.control('Additional encore minutes').value = '11';
  await f.click('Authorize additional encore');
  assert.equal(f.calls.length, 1);
  assert.match(f.text(), /remaining allowance/);
});

test('reserving and bumping next act requires that exact next owner pass', async () => {
  const f = await fixture();
  f.control('Next booked act to reserve').value = 'b';
  await f.click('Reserve and notify selected next act');
  assert.deepEqual(f.nextPasses, ['b']);
  assert.equal(f.calls[0].input.nextToken, 'b-owner');
  assert.equal(f.calls[0].input.expectedNextRevision, 4);
  f.state({ ...f.stateValue, broadcastControl: { nextBookingId: 'b' } });
  await f.click('Authorize additional encore');
  assert.deepEqual(f.nextPasses, ['b', 'b']);
  assert.equal(f.calls[1].input.nextToken, 'b-owner');
});

test('artist chooses decline/short/full without signed schedule or fee changes', async () => {
  const f = await fixture({ capabilities: { grantEncore: false, reserveNext: false, endBroadcast: false, chooseSet: true, declareFinished: true } });
  f.control('Short-set minutes').value = '10';
  await f.click('Choose this short set');
  assert.equal(f.calls[0].input.choice, 'short');
  assert.equal(f.calls[0].input.durationMs, 600000);
  await f.click('Choose full contracted-length set');
  assert.equal(f.calls[1].input.choice, 'full');
  await f.click('Decline this delayed slot · keep original guarantee');
  assert.equal(f.calls[2].input.choice, 'decline');
  assert.ok(f.confirmations.at(-1).includes('still payable'));
  assert.equal(f.calls.some(call => Object.hasOwn(call.input, 'startUtc') || Object.hasOwn(call.input, 'amountUnits')), false);
  await f.click('My allocated set is finished');
  assert.equal(f.calls[3].input.action, 'broadcast-finished');
});

test('normal end requires durable finish and forced cut remains explicitly interrupted', async () => {
  const f = await fixture();
  assert.equal(f.find('End after performer’s finished declaration').disabled, true);
  f.state({ ...f.stateValue, broadcastControl: { finishedId: 'durable-finished' } });
  assert.equal(f.find('End after performer’s finished declaration').disabled, false);
  await f.click('End after performer’s finished declaration');
  assert.equal(f.calls[0].input.mode, 'normal');
  await f.click('Force cut · mark interrupted');
  assert.equal(f.calls[1].input.mode, 'operator-cut');
  assert.ok(f.confirmations.at(-1).includes('not a successful curtain call'));
});

test('stale or expired pass disables timing changes and pass renewal does not invoke audio', async () => {
  const f = await fixture();
  f.time(NOW + 12001);
  f.handler(() => new Promise(() => {}));
  f.tick();
  assert.equal(f.find('Authorize additional encore').disabled, true);
  f.time(NOW);
  f.state(f.stateValue);
  f.session({ ...f.pass, expiresAt: NOW - 1 });
  f.tick();
  assert.equal(f.find('Authorize additional encore').disabled, true);
  await f.click('Refresh allocated booking pass · keep microphone on');
  assert.equal(f.pass.expiresAt, NOW + 1800000);
  assert.equal(f.find('Authorize additional encore').disabled, false);
  assert.match(f.text(), /Immutable contract/);
  assert.match(f.text(), /Effective stage/);
});

test('uncertain durable mutation uses same command id on manual retry; mismatched state is rejected', async () => {
  const f = await fixture();
  f.handler(() => Promise.reject(new Error('Response lost')));
  await f.click('Authorize additional encore');
  const original = f.calls[0].input;
  assert.equal(f.find('Retry same stage command').hidden, false);
  f.handler(input => ({ commandId: input.commandId, applied: false, state: f.stateValue }));
  await f.click('Retry same stage command');
  assert.deepEqual(f.calls[1].input, original);
  f.handler(input => ({ commandId: input.commandId, applied: true, state: { ...f.stateValue, bookingId: 'other' } }));
  await f.click('Authorize additional encore');
  assert.match(f.text(), /did not match this booking/);
});

test('absent capabilities never expose live timing mutation buttons', async () => {
  const f = await fixture();
  f.state({ bookingId: 'a', serverTime: NOW, broadcast: null });
  assert.equal(f.find('Authorize additional encore').hidden, true);
  assert.equal(f.find('Take this selected act live').hidden, true);
  assert.equal(f.find('Enable allocated-stage control').hidden, true);
  assert.match(f.text(), /Existing automatic scheduling/);
});
