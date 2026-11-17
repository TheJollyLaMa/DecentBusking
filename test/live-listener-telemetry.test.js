const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');

const START = Date.parse('2026-11-20T20:00:00Z');
const origin = 'https://radio.example';
const page = i => `page_${String(i).padStart(24, '0')}`;

async function fixture(t) {
  const { createListenerTelemetry } = await import('../discord-bot/live-listener-telemetry.js');
  let time = START + 1000, state = 'show-a';
  const telemetry = createListenerTelemetry({ now: () => time, resolveState: () => state && ({
    configured: true, phase: 'live', armed: true, bookingId: state, serverTime: time,
    startUtc: new Date(START).toISOString(), endUtc: new Date(START + 7_200_000).toISOString(),
    performer: { wallet: `0x${'12'.repeat(20)}` }, bookingVerification: { fresh: true, verifiedAt: time },
    policy: { mode: 'live', bookingId: state },
  }) });
  t.after(() => telemetry.close());
  return { telemetry, at: value => { time = value; }, state: value => { state = value; },
    issue: i => telemetry.issue('show-a', page(i)),
    send: (token, sequence, event, extra = {}) => telemetry.submit({ token, bookingId: 'show-a', sequence, event, ...extra }, '192.0.2.10') };
}

test('controlled 50-page ramp produces bounded aggregate count, peak, reconnects and histogram percentiles', async t => {
  const f = await fixture(t), tokens = [];
  for (let i = 0; i < 50; i++) {
    const token = f.issue(i); tokens.push(token);
    f.send(token, 1, 'connect');
    f.send(token, 2, 'first-audio', { durationMs: (i + 1) * 100 });
  }
  for (let i = 0; i < 10; i++) f.send(tokens[i], 3, 'reconnect', { reason: 'transport' });
  for (let i = 10; i < 30; i++) f.send(tokens[i], 3, 'leave');
  const value = f.telemetry.snapshot('show-a');
  assert.equal(value.current, 30); assert.equal(value.peak, 50); assert.equal(value.connects, 50);
  assert.equal(value.reconnectsLastHour, 10);
  assert.equal(value.firstAudio.samples, 50);
  assert.equal(value.firstAudio.p50UpperMs, 5000); assert.equal(value.firstAudio.p95UpperMs, 5000);
  const text = JSON.stringify(value);
  for (const secret of [page(1), tokens[1], '192.0.2.10', `0x${'12'.repeat(20)}`]) assert.ok(!text.includes(secret));
  f.at(START + 47_000);
  assert.equal(f.telemetry.snapshot('show-a').current, 0);
  assert.equal(f.telemetry.snapshot('show-a').peak, 50);
  f.at(START + 3_601_000);
  assert.equal(f.telemetry.snapshot('show-a').reconnectsLastHour, 0);
});

test('grant, sequencing, duplicate, malformed and show boundaries fail closed', async t => {
  const f = await fixture(t), token = f.issue(1);
  assert.equal(f.issue(1), token, 'sources on the same page share one lease');
  assert.equal(f.telemetry.issue('show-a', 'short'), null);
  assert.throws(() => f.send(token, 2, 'connect'), e => e.status === 409);
  f.send(token, 1, 'connect');
  assert.equal(f.send(token, 1, 'connect').duplicate, true);
  assert.throws(() => f.send(token, 2, 'reconnect', { reason: 'arbitrary text' }), e => e.status === 400);
  assert.throws(() => f.send(token, 2, 'first-audio', { durationMs: 120001 }), e => e.status === 400);
  assert.throws(() => f.send(token, 2, 'heartbeat', { wallet: 'secret' }), e => e.status === 400);
  f.send(token, 2, 'leave');
  assert.throws(() => f.send(token, 3, 'connect'), e => e.status === 409);
  const next = f.issue(1); assert.notEqual(next, token);
  f.at(START + 47_000);
  assert.throws(() => f.send(next, 1, 'connect'), e => e.status === 403);
  f.state('show-b');
  assert.throws(() => f.send(token, 3, 'heartbeat'), e => e.status === 409);
  assert.throws(() => f.telemetry.snapshot('show-a'), e => e.status === 409);
  f.state(null);
  assert.throws(() => f.telemetry.snapshot('show-b'), e => e.status === 503);
});

test('HTTP telemetry rejects untrusted origins, malformed and oversized bodies', async t => {
  const f = await fixture(t);
  const { handleListenerTelemetry } = await import('../discord-bot/live-listener-telemetry.js');
  const server = http.createServer((req, res) => void handleListenerTelemetry(req, res, {
    telemetry: f.telemetry, allowedOrigins: [origin],
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (body, site = origin) => fetch(url, { method: 'POST',
    headers: { origin: site, 'content-type': 'application/json' }, body });
  assert.equal((await post('{}', 'https://evil.example')).status, 403);
  assert.equal((await post('{')).status, 400);
  assert.equal((await post('x'.repeat(1200))).status, 413);
  assert.equal((await post(JSON.stringify({ token: 'x'.repeat(32), bookingId: 'show-a', sequence: 1, event: 'connect' }))).status, 403);
});

test('page sources share one ordered session; retry, reconnect and teardown contain only allowed data', async () => {
  const { createPageListenerTelemetry } = await import('../js/live-listener-telemetry.mjs');
  const calls = [], handlers = {}, intervals = new Map(); let clock = 1000, fail = true;
  const env = { setInterval(fn) { intervals.set(1, fn); return 1; }, clearInterval(id) { intervals.delete(id); },
    addEventListener(name, fn) { handlers[name] = fn; }, removeEventListener(name) { delete handlers[name]; } };
  const telemetry = createPageListenerTelemetry({ serviceUrl: 'https://worker.example', environment: env,
    pageId: page(1), now: () => clock, fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      if (fail) { fail = false; throw new Error('offline'); }
      return { ok: true };
    } });
  const a = {}, b = {}, token = 'A'.repeat(32);
  telemetry.join(a, token, 'show-a', clock); telemetry.join(b, token, 'show-a', clock);
  clock += 450; telemetry.audio(a); telemetry.audio(b);
  telemetry.suspend(a); telemetry.suspend(b); telemetry.resumed(b);
  telemetry.leave(a); telemetry.leave(b);
  assert.equal(telemetry.grantPageId(), null, 'pending leave cannot accidentally reuse a closing grant');
  await telemetry.flush();
  assert.equal(telemetry.grantPageId(), page(1));
  assert.deepEqual(calls.map(x => x.event), ['connect', 'connect', 'first-audio', 'reconnect', 'leave']);
  assert.deepEqual(calls.map(x => x.sequence), [1, 1, 2, 3, 4]);
  assert.equal(calls[2].durationMs, 450);
  assert.equal(calls[3].reason, 'transport');
  telemetry.dispose(); assert.equal(intervals.size, 0); assert.equal(handlers.pagehide, undefined);
});

test('browser page lifecycle reaches the real HTTP aggregate and pagehide removes the lease', async t => {
  const f = await fixture(t);
  const { handleListenerTelemetry } = await import('../discord-bot/live-listener-telemetry.js');
  const { createPageListenerTelemetry } = await import('../js/live-listener-telemetry.mjs');
  const server = http.createServer((req, res) => void handleListenerTelemetry(req, res, {
    telemetry: f.telemetry, allowedOrigins: [origin],
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const handlers = {}, environment = { setInterval() { return 1; }, clearInterval() {},
    addEventListener(name, fn) { handlers[name] = fn; }, removeEventListener(name) { delete handlers[name]; } };
  let time = START + 1000;
  const client = createPageListenerTelemetry({ serviceUrl: `http://127.0.0.1:${server.address().port}`, environment,
    pageId: page(1), now: () => time, fetchImpl: (url, opts) => fetch(url, { ...opts, headers: { ...opts.headers, origin } }) });
  t.after(() => client.dispose());
  const token = f.issue(1), source = {};
  client.join(source, token, 'show-a', time);
  time += 700; client.audio(source);
  client.suspend(source); client.resumed(source);
  await client.flush();
  let snapshot = f.telemetry.snapshot('show-a');
  assert.equal(snapshot.current, 1); assert.equal(snapshot.reconnectsLastHour, 1);
  assert.equal(snapshot.firstAudio.p50UpperMs, 1000);
  handlers.pagehide(); await client.flush();
  snapshot = f.telemetry.snapshot('show-a');
  assert.equal(snapshot.current, 0); assert.equal(snapshot.peak, 1);
});

test('telemetry failure does not fabricate later events or leave an unbounded retry queue', async () => {
  const { createPageListenerTelemetry } = await import('../js/live-listener-telemetry.mjs');
  let calls = 0, tick;
  const environment = { setInterval(fn) { tick = fn; return 1; }, clearInterval() {},
    addEventListener() {}, removeEventListener() {} };
  const client = createPageListenerTelemetry({ environment, pageId: page(1), fetchImpl: async () => {
    calls++; throw new Error('offline');
  } });
  client.join({}, 'A'.repeat(32), 'show-a', Date.now());
  for (let i = 0; i < 20; i++) tick();
  await client.flush();
  assert.ok(calls <= 2);
  client.dispose();
});

test('producer panel exports only fresh authorized snapshots and clears on failure/disposal', async () => {
  const { bindProducerListenerTelemetry, safeBindProducerListenerTelemetry } = await import('../js/producer-listener-telemetry.mjs');
  const doc = { createElement: () => ({ textContent: '', disabled: false, setAttribute() {},
    addEventListener(_name, fn) { this.click = fn; } }) };
  const root = { ownerDocument: doc, replaceChildren(...nodes) { this.children = nodes; } };
  let tick, time = 10_000, result, exported = '', failDownload = false;
  const environment = { setInterval(fn) { tick = fn; return 1; }, clearInterval() { tick = null; } };
  const panel = bindProducerListenerTelemetry({ container: root, bookingId: 'show-a', serviceUrl: 'x', environment,
    now: () => time, request: async () => { if (!result) throw new Error('offline'); return result; },
    download: text => { if (failDownload) throw new Error('downloads blocked'); exported = text; } });
  result = { schemaVersion: 1, bookingId: 'show-a', startedAt: 1, observationStartedAt: 2, observedAt: time,
    current: 1, peak: 2, connects: 2, reconnectsLastHour: 1, reconnectReasons: { transport: 1, disconnected: 0 },
    leaseSeconds: 45, wallet: 'must-not-export',
    firstAudio: { samples: 0, p50UpperMs: null, p95UpperMs: null,
      histogram: [250, 500, 1000, 2000, 5000, 10000, 30000, 60000, 120000].map(upperMs => ({ upperMs, count: 0 })) } };
  panel.setSession({ role: 'owner', token: 'private', expiresAt: time + 60_000, state: { bookingId: 'show-a' } });
  await new Promise(setImmediate);
  assert.match(root.children[1].textContent, /active page connections: 1/);
  root.children[2].click(); assert.equal(JSON.parse(exported).current, 1); assert.ok(!exported.includes('private'));
  assert.ok(!exported.includes('must-not-export'));
  failDownload = true; root.children[2].click(); assert.match(root.children[1].textContent, /export failed/i);
  time += 12_001; root.children[2].click();
  assert.match(root.children[1].textContent, /stale/i); assert.equal(root.children[2].disabled, true);
  result = null; await panel.refresh();
  assert.match(root.children[1].textContent, /unavailable/i); assert.equal(root.children[2].disabled, true);
  panel.dispose(); assert.equal(tick, null); assert.equal(root.children.length, 0);
  const failed = safeBindProducerListenerTelemetry({ container: root, environment: { setInterval() { throw new Error('unavailable'); } } });
  assert.match(root.textContent, /unavailable.*unaffected/i);
  failed.setSession(null); failed.dispose();
});
