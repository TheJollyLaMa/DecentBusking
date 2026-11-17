const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once, EventEmitter } = require('node:events');

const START = Date.parse('2026-11-20T20:00:00Z');
const origin = 'https://radio.example';
const page = i => `page_${String(i).padStart(24, '0')}`;

async function fixture(t, showDuration = 7_200_000) {
  const { createListenerTelemetry } = await import('../discord-bot/live-listener-telemetry.js');
  let time = START + 1000, state = 'show-a';
  const telemetry = createListenerTelemetry({ now: () => time, resolveState: () => state && ({
    configured: true, phase: 'live', armed: true, bookingId: state, serverTime: time,
    startUtc: new Date(START).toISOString(), endUtc: new Date(START + showDuration).toISOString(),
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
  client.dispose(); await client.flush();
});

async function recoveryHarness(t, f, { join = true, loseRenewalResponse = false } = {}) {
  const { handleListenerTelemetry } = await import('../discord-bot/live-listener-telemetry.js');
  const { createPageListenerTelemetry } = await import('../js/live-listener-telemetry.mjs');
  const server = http.createServer((req, res) => void handleListenerTelemetry(req, res, {
    telemetry: f.telemetry, allowedOrigins: [origin],
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const handlers = {}, timers = new Map(), routes = [], clock = { at: START + 1000 };
  let nextTimer = 0, offline = false;
  const environment = { setInterval(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearInterval(id) { timers.delete(id); }, addEventListener(name, fn) { handlers[name] = fn; },
    removeEventListener(name) { delete handlers[name]; } };
  const client = createPageListenerTelemetry({ serviceUrl: `http://127.0.0.1:${server.address().port}`, environment,
    pageId: page(1), now: () => clock.at, fetchImpl: (url, opts) => {
      const body = JSON.parse(opts.body);
      routes.push({ path: new URL(url).pathname, body });
      if (offline) return Promise.reject(new Error('offline'));
      const request = fetch(url, { ...opts, headers: { ...opts.headers, origin } });
      if (body.event === 'renew' && loseRenewalResponse) {
        loseRenewalResponse = false;
        return request.then(() => { throw new Error('lost response'); });
      }
      return request;
    } });
  t.after(() => client.dispose());
  const token = f.issue(1), renewal = f.telemetry.renewal?.('show-a', page(1)), source = {};
  if (join) {
    client.join(source, token, 'show-a', clock.at, renewal);
    await client.flush();
  }
  return { client, source, handlers, timers, routes, clock, token, renewal, setOffline(value) { offline = value; } };
}

test('transport reconnect after lease expiry reacquires without a second room grant', async t => {
  const f = await fixture(t), h = await recoveryHarness(t, f);
  h.client.suspend(h.source);
  h.clock.at = START + 47_000; f.at(h.clock.at);
  assert.equal(f.telemetry.snapshot('show-a').current, 0);
  h.client.resumed(h.source, 'transport'); await h.client.flush();
  const snapshot = f.telemetry.snapshot('show-a');
  assert.equal(snapshot.current, 1);
  assert.equal(snapshot.connects, 1);
  assert.equal(snapshot.reconnectsLastHour, 1);
  assert.ok(h.routes.every(request => request.path === '/api/live-audio/telemetry'));
  h.client.dispose(); await h.client.flush();
});

test('a late initial room connection restores observation without fabricating a connect', async t => {
  const f = await fixture(t), h = await recoveryHarness(t, f, { join: false });
  h.clock.at = START + 47_000; f.at(h.clock.at);
  h.client.join(h.source, h.token, 'show-a', START + 1000, h.renewal); await h.client.flush();
  const snapshot = f.telemetry.snapshot('show-a');
  assert.equal(snapshot.current, 1); assert.equal(snapshot.connects, 0);
  h.client.dispose(); await h.client.flush();
});

test('a lost renewal response is retried idempotently without inflating connections', async t => {
  const f = await fixture(t), h = await recoveryHarness(t, f, { loseRenewalResponse: true });
  h.client.suspend(h.source); h.clock.at = START + 47_000; f.at(h.clock.at);
  assert.equal(f.telemetry.snapshot('show-a').current, 0);
  h.client.resumed(h.source); await h.client.flush();
  const result = f.telemetry.snapshot('show-a');
  assert.equal(result.current, 1); assert.equal(result.peak, 1);
  assert.equal(result.connects, 1); assert.equal(result.reconnectsLastHour, 1);
  assert.equal(h.routes.filter(request => request.body.event === 'renew').length, 2);
  h.client.dispose(); await h.client.flush();
});

test('live listener recovers telemetry in the same full room without requesting another seat', async t => {
  const f = await fixture(t), h = await recoveryHarness(t, f, { join: false });
  const { createLiveAudioListener } = await import('../js/live-audio-client.mjs');
  let room, grants = 0;
  class Room extends EventEmitter {
    constructor() { super(); room = this; this.state = 'connecting'; this.remoteParticipants = new Map(); }
    async connect() { this.state = 'connected'; }
    async disconnect() { this.state = 'disconnected'; }
  }
  const audio = { paused: true, pause() { this.paused = true; }, srcObject: null };
  const listener = createLiveAudioListener({ audio, serviceUrl: 'https://worker.example', now: () => h.clock.at,
    telemetry: h.client, sdkLoader: async () => ({ Room, Track: { Kind: { Audio: 'audio' } }, RoomEvent: {
      TrackPublished: 'published', TrackSubscribed: 'subscribed', TrackUnsubscribed: 'unsubscribed',
      Reconnecting: 'reconnecting', Reconnected: 'reconnected', Disconnected: 'disconnected' } }),
    request: async () => {
      if (++grants > 1) throw new Error('Room is full');
      return { url: 'wss://fixture', token: 'livekit-grant', publisherIdentity: 'performer',
        telemetryToken: h.token, telemetryRenewal: h.renewal };
    } });
  listener.update({ bookingId: 'show-a', phase: 'live', armed: true, status: 'ON-AIR' });
  await new Promise(setImmediate); await h.client.flush();
  assert.equal(f.telemetry.snapshot('show-a').current, 1);
  room.emit('reconnecting');
  h.clock.at = START + 47_000; f.at(h.clock.at);
  assert.equal(f.telemetry.snapshot('show-a').current, 0);
  room.emit('reconnected'); await h.client.flush();
  const snapshot = f.telemetry.snapshot('show-a');
  assert.equal(snapshot.current, 1); assert.equal(snapshot.connects, 1); assert.equal(snapshot.reconnectsLastHour, 1);
  assert.equal(grants, 1); assert.equal(room.state, 'connected');
  await listener.disconnect(); await h.client.flush();
});

test('pagehide and pageshow restore the active observation without inflating connects', async t => {
  const f = await fixture(t), h = await recoveryHarness(t, f);
  h.handlers.pagehide(); await h.client.flush();
  assert.equal(f.telemetry.snapshot('show-a').current, 0);
  h.handlers.pageshow(); await h.client.flush();
  const snapshot = f.telemetry.snapshot('show-a');
  assert.equal(snapshot.current, 1);
  assert.equal(snapshot.connects, 1);
  assert.equal(snapshot.reconnectsLastHour, 0);
  assert.equal(h.routes.at(-1).body.event, 'renew');
  assert.equal(h.routes.at(-1).body.token, undefined);
  h.client.dispose(); await h.client.flush();
});

test('pageshow racing an unfinished pagehide leave is serialized', async t => {
  const f = await fixture(t), h = await recoveryHarness(t, f);
  h.handlers.pagehide(); h.handlers.pageshow(); await h.client.flush();
  const snapshot = f.telemetry.snapshot('show-a');
  assert.equal(snapshot.current, 1); assert.equal(snapshot.connects, 1);
  assert.deepEqual(h.routes.slice(-2).map(request => request.body.event), ['leave', 'renew']);
  h.client.dispose(); await h.client.flush();
});

test('a suspended source restored after pageshow renews before recording reconnect', async t => {
  const f = await fixture(t), h = await recoveryHarness(t, f);
  h.client.suspend(h.source); h.handlers.pagehide(); await h.client.flush();
  h.handlers.pageshow(); await h.client.flush();
  assert.equal(f.telemetry.snapshot('show-a').current, 0);
  h.client.resumed(h.source); await h.client.flush();
  const snapshot = f.telemetry.snapshot('show-a');
  assert.equal(snapshot.current, 1); assert.equal(snapshot.connects, 1); assert.equal(snapshot.reconnectsLastHour, 1);
  h.client.dispose(); await h.client.flush();
});

test('background timer suspension expires then restores the lease without a reconnect or new connect', async t => {
  const f = await fixture(t), h = await recoveryHarness(t, f);
  h.clock.at = START + 47_000; f.at(h.clock.at);
  assert.equal(f.telemetry.snapshot('show-a').current, 0);
  h.timers.values().next().value();
  await h.client.flush();
  const snapshot = f.telemetry.snapshot('show-a');
  assert.equal(snapshot.current, 1); assert.equal(snapshot.connects, 1); assert.equal(snapshot.reconnectsLastHour, 0);
  h.client.dispose(); await h.client.flush();
});

test('a transient offline failure retries bounded renewal without requiring another room grant', async t => {
  const f = await fixture(t), h = await recoveryHarness(t, f);
  h.client.suspend(h.source); h.clock.at = START + 47_000; f.at(h.clock.at); h.setOffline(true);
  h.client.resumed(h.source); await h.client.flush();
  assert.equal(f.telemetry.snapshot('show-a').current, 0);
  h.clock.at += 30_000; f.at(h.clock.at); h.setOffline(false);
  h.timers.values().next().value(); await h.client.flush();
  const result = f.telemetry.snapshot('show-a');
  assert.equal(result.current, 1); assert.equal(result.connects, 1);
  assert.equal(result.reconnectsLastHour, 0, 'an uncertain failed reconnect is not replayed as a new event');
  assert.ok(h.routes.every(request => request.path === '/api/live-audio/telemetry'));
  h.client.dispose(); await h.client.flush();
});

test('expired renewal capabilities stop automatic retries without opening another seat', async t => {
  const f = await fixture(t, 10 * 60 * 60_000), h = await recoveryHarness(t, f);
  h.client.suspend(h.source); h.clock.at = START + 4 * 60 * 60_000 + 1001; f.at(h.clock.at);
  h.client.resumed(h.source); await h.client.flush();
  assert.equal(f.telemetry.snapshot('show-a').current, 0);
  assert.equal(h.timers.size, 0);
  assert.ok(h.routes.every(request => request.path === '/api/live-audio/telemetry'));
  h.client.dispose(); await h.client.flush();
});

test('renewal is scoped to an admitted page and show, expires, and never creates a connect', async t => {
  const f = await fixture(t, 10 * 60 * 60_000), token = f.issue(1);
  const capability = f.telemetry.renewal('show-a', page(1));
  const input = { event: 'renew', bookingId: 'show-a', pageId: page(1), renewal: capability };
  assert.throws(() => f.telemetry.renew({ ...input, pageId: page(2) }, '192.0.2.1'), e => e.status === 403);
  assert.throws(() => f.telemetry.renew({ ...input, renewal: capability.replace(/.$/, '!') }, '192.0.2.1'), e => e.status === 400);
  assert.throws(() => f.telemetry.renew({ ...input, extra: 'private' }, '192.0.2.1'), e => e.status === 400);
  f.send(token, 1, 'connect');
  f.at(START + 47_000);
  const renewed = f.telemetry.renew(input, '192.0.2.1');
  assert.notEqual(renewed.token, token);
  assert.equal(f.telemetry.renew(input, '192.0.2.1').token, renewed.token);
  let snapshot = f.telemetry.snapshot('show-a');
  assert.equal(snapshot.current, 1); assert.equal(snapshot.peak, 1); assert.equal(snapshot.connects, 1);
  assert.ok(!JSON.stringify(snapshot).includes(capability));
  f.at(START + 4 * 60 * 60_000 + 1000);
  assert.throws(() => f.telemetry.renew(input, '192.0.2.1'), e => e.status === 403);
  f.state('show-b');
  assert.throws(() => f.telemetry.renew(input, '192.0.2.1'), e => e.status === 409);
});

test('active long shows rotate the page capability before expiry without increasing connects', async t => {
  const f = await fixture(t, 10 * 60 * 60_000), h = await recoveryHarness(t, f);
  h.clock.at = START + 4 * 60 * 60_000 - 59_000; f.at(h.clock.at);
  h.timers.values().next().value(); await h.client.flush();
  assert.equal(f.telemetry.snapshot('show-a').current, 1);
  h.clock.at = START + 4 * 60 * 60_000 + 3000; f.at(h.clock.at);
  h.timers.values().next().value(); await h.client.flush();
  const result = f.telemetry.snapshot('show-a');
  assert.equal(result.current, 1); assert.equal(result.connects, 1); assert.equal(result.reconnectsLastHour, 0);
  h.client.dispose(); await h.client.flush();
});

test('renewal respects network limits and the fixed lease bound', async t => {
  const f = await fixture(t), token = f.issue(1), cap = f.telemetry.renewal('show-a', page(1));
  const request = { event: 'renew', bookingId: 'show-a', pageId: page(1), renewal: cap };
  for (let i = 0; i < 300; i++) assert.equal(f.telemetry.renew(request, '192.0.2.1').token, token);
  assert.throws(() => f.telemetry.renew(request, '192.0.2.1'), error => error.status === 429);
  for (let i = 2; i <= 2000; i++) assert.ok(f.issue(i));
  assert.equal(f.issue(2001), null);
  assert.equal(f.telemetry.snapshot('show-a').current, 1);
  assert.equal(f.telemetry.snapshot('show-a').connects, 0);
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

test('unexpected cleanup failures produce only rate-limited generic diagnostics', async t => {
  const { createListenerTelemetry } = await import('../discord-bot/live-listener-telemetry.js');
  t.mock.timers.enable({ apis: ['setInterval'] });
  let diagnosticTime = 0;
  const messages = [];
  const telemetry = createListenerTelemetry({ resolveState: () => null,
    now: () => { throw new Error('secret-address-and-token'); },
    diagnosticNow: () => diagnosticTime, warn: message => messages.push(message) });
  t.after(() => telemetry.close());
  t.mock.timers.tick(15_000);
  assert.equal(messages.length, 1);
  diagnosticTime += 60_000; t.mock.timers.tick(5000);
  assert.equal(messages.length, 2);
  assert.ok(messages.every(message => !message.includes('secret') && /unavailable/.test(message)));
});

test('browser telemetry failures report one generic warning without identifiers', async t => {
  const { createPageListenerTelemetry } = await import('../js/live-listener-telemetry.mjs?diagnostics-test');
  const messages = [];
  t.mock.method(console, 'warn', (...args) => messages.push(args.join(' ')));
  const environment = { setInterval() { return 1; }, clearInterval() {}, addEventListener() {}, removeEventListener() {} };
  const client = createPageListenerTelemetry({ environment, pageId: page(1),
    fetchImpl: async () => { throw new Error('secret-address-and-token'); } });
  client.join({}, 'A'.repeat(32), 'show-a', Date.now()); await client.flush();
  assert.equal(messages.length, 1);
  assert.ok(messages.every(message => !message.includes('secret') && !message.includes(page(1))));
  client.dispose(); await client.flush();
});

test('unexpected browser timer failures are reported without exposing errors', async t => {
  const { createPageListenerTelemetry } = await import('../js/live-listener-telemetry.mjs?timer-diagnostics');
  const messages = []; let tick, stopped = false;
  t.mock.method(console, 'warn', (...args) => messages.push(args.join(' ')));
  const environment = { setInterval(fn) { tick = fn; return 1; }, clearInterval() { stopped = true; },
    addEventListener() {}, removeEventListener() {} };
  const client = createPageListenerTelemetry({ environment, pageId: page(1),
    now: () => { throw new Error('secret-address-and-token'); }, fetchImpl: async () => ({ ok: true }) });
  client.join({}, 'A'.repeat(32), 'show-a', 0, `9999999999999.${'A'.repeat(43)}`);
  await client.flush(); tick();
  assert.equal(stopped, true); assert.equal(messages.length, 1);
  assert.ok(!messages[0].includes('secret')); client.dispose(); await client.flush();
});

test('telemetry and logging failures cannot disconnect the audio room', async t => {
  const { createLiveAudioListener } = await import('../js/live-audio-client.mjs');
  t.mock.method(console, 'warn', () => { throw new Error('logging unavailable'); });
  let room;
  class Room extends EventEmitter {
    constructor() { super(); room = this; this.state = 'connecting'; this.remoteParticipants = new Map(); }
    async connect() { this.state = 'connected'; }
    async disconnect() { this.state = 'disconnected'; }
  }
  const audio = { paused: true, pause() {}, srcObject: null };
  const listener = createLiveAudioListener({ audio, serviceUrl: 'https://worker.example',
    telemetry: { pageId: page(1), join() { throw new Error('secret'); }, leave() {} },
    sdkLoader: async () => ({ Room, Track: { Kind: { Audio: 'audio' } }, RoomEvent: {
      TrackPublished: 'published', TrackSubscribed: 'subscribed', TrackUnsubscribed: 'unsubscribed',
      Reconnecting: 'reconnecting', Disconnected: 'disconnected' } }),
    request: async () => ({ url: 'wss://fixture', token: 'grant', publisherIdentity: 'performer' }) });
  listener.update({ bookingId: 'show-a', phase: 'live', armed: true, status: 'ON-AIR' });
  await new Promise(setImmediate);
  assert.equal(room.state, 'connected');
  await listener.disconnect();
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
