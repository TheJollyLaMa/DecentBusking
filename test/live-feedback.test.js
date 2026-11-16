const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');

const START = Date.parse('2026-11-20T20:00:00Z');
const END = START + 20 * 60_000;
const WALLET = `0x${'12'.repeat(20)}`;
const ORIGIN = 'https://radio.example';
const client = number => `listener_${String(number).padStart(16, '0')}`;

function show(time, changes = {}) {
  return {
    configured: true, phase: 'live', armed: true, bookingId: 'show-a',
    serverTime: time, startUtc: new Date(START).toISOString(), endUtc: new Date(END).toISOString(),
    performer: { wallet: WALLET }, bookingVerification: { fresh: true, verifiedAt: time },
    policy: { mode: 'live', bookingId: 'show-a' }, status: 'ON-AIR', broadcast: null,
    ...changes,
  };
}

async function fixture(t, options = {}) {
  const { createLiveFeedback } = await import('../discord-bot/live-feedback.js');
  const clock = { at: START + 10_000 };
  let state = () => show(clock.at);
  const feedback = createLiveFeedback({
    resolveState: () => state(), now: () => clock.at, salt: Buffer.alloc(32, 7), ...options,
  });
  t.after(() => feedback.close());
  return {
    feedback, clock, setState: value => { state = value; },
    send: (signal = 'applause', id = client(1), bookingId = 'show-a', peer = '192.0.2.10') =>
      feedback.submit({ signal, clientId: id, bookingId }, { peer }),
  };
}

test('anonymous signals reach only the current booking with advisory counts and no identities', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.send(), { ok: true, signal: 'applause', bookingId: 'show-a', nextAllowedInMs: 2000 });
  f.clock.at += 2000;
  f.send('audio-problem');
  f.clock.at += 2000;
  f.send('encore', client(2), 'show-a', '2001:db8:1:2::1');
  const result = f.feedback.snapshot('show-a');
  assert.equal(result.active, true);
  assert.match(result.advisory, /advisory.*do not prove/i);
  assert.equal(result.windows.short.counts.applause, 1);
  assert.equal(result.windows.short.counts['audio-problem'], 1);
  assert.equal(result.windows.long.counts.encore, 1);
  assert.equal(result.windows.long.browsers['audio-problem'], 1);
  assert.deepEqual(result.events.map(event => event.signal), ['applause', 'encore']);
  assert.equal(result.lastReceivedAt['audio-problem'], START + 12_000);
  const serialized = JSON.stringify(result);
  for (const privateValue of [client(1), client(2), '192.0.2.10', '2001:db8:1:2::1', WALLET]) {
    assert.ok(!serialized.includes(privateValue));
  }
  assert.equal(f.feedback.snapshot('other-show').active, false);
  f.clock.at += 121_000;
  const later = f.feedback.snapshot('show-a');
  assert.equal(later.windows.long.counts['audio-problem'], 0);
  assert.equal(later.windows.long.browsers['audio-problem'], 0);
  assert.deepEqual(later.events, []);
});

test('only allowlisted bounded inputs are accepted; signals cannot carry payment or HTML data', async t => {
  const f = await fixture(t);
  for (const value of [
    null, [], {}, { signal: '<script>', bookingId: 'show-a', clientId: client(1) },
    { signal: 'applause', bookingId: 'show-a', clientId: client(1), wallet: WALLET },
    { signal: 'applause', bookingId: 'show-a', clientId: client(1), text: '<img>' },
    { signal: 'applause', bookingId: 'show-a', clientId: 'short' },
    { signal: 'applause', bookingId: 'x'.repeat(201), clientId: client(1) },
  ]) assert.throws(() => f.feedback.submit(value), error => error.status === 400);
  assert.equal(f.feedback.inspect().bookingBound, false);
});

test('signals fail closed for stale, ended or changed shows, but still work during audio reconnect', async t => {
  const f = await fixture(t);
  f.setState(() => show(f.clock.at, { status: 'RECONNECTING' }));
  f.send('audio-problem');
  f.clock.at += 2000;
  f.setState(() => show(f.clock.at, { bookingVerification: { fresh: false, verifiedAt: f.clock.at } }));
  assert.throws(() => f.send(), error => error.status === 404);
  f.clock.at += 2000;
  f.setState(() => show(f.clock.at, { bookingVerification: { fresh: true, verifiedAt: f.clock.at - 30_001 } }));
  assert.throws(() => f.send(), error => error.status === 404);
  f.clock.at += 2000;
  f.setState(() => show(f.clock.at, { bookingId: 'show-b', policy: { mode: 'live', bookingId: 'show-b' } }));
  assert.throws(() => f.send(), error => error.status === 409);
  assert.equal(f.feedback.snapshot('show-a').active, false);
  assert.equal(f.feedback.snapshot('show-b').windows.long.counts['audio-problem'], 0);
  f.clock.at += 2000;
  f.send('love', client(1), 'show-b');
  assert.deepEqual(f.feedback.snapshot('show-b').events.map(event => event.signal), ['love']);
  f.clock.at = END;
  assert.equal(f.feedback.snapshot('show-b').active, false);
  assert.equal(f.feedback.inspect().bookingBound, false);
});

test('effective allocated end governs feedback, including an approved extension and an early ending', async t => {
  const f = await fixture(t);
  const broadcast = { allocationId: 'allocation-a', phase: 'live', actualStartedAt: START,
    actualEndedAt: null, authorizedEndAt: END + 120_000 };
  f.setState(() => show(f.clock.at, { broadcast }));
  f.clock.at = END + 1000;
  f.send();
  assert.equal(f.feedback.snapshot('show-a').endsAt, END + 120_000);
  broadcast.actualEndedAt = f.clock.at + 1000;
  broadcast.phase = 'ended';
  f.clock.at += 1000;
  f.feedback.sync();
  assert.equal(f.feedback.inspect().bookingBound, false);
  assert.equal(f.feedback.snapshot('show-a').active, false);
});

test('rate limits hold per browser, network and globally, with bounded state and event bursts', async t => {
  const f = await fixture(t, { limits: { clientMinIntervalMs: 0, clientPerMinute: 2,
    sourcePerMinute: 3, globalPerMinute: 4, maxClientRecords: 3, maxSourceRecords: 2, maxEvents: 2 } });
  f.send('applause', client(1));
  f.send('love', client(1));
  assert.throws(() => f.send('love', client(1)), error => error.status === 429 && error.retryAfterMs > 0);
  f.send('encore', client(2));
  assert.throws(() => f.send('love', client(3)), error => error.status === 429);
  f.send('love', client(4), 'show-a', '192.0.2.11');
  assert.throws(() => f.send('love', client(5), 'show-a', '192.0.2.12'), error => error.status === 429);
  const snapshot = f.feedback.snapshot('show-a');
  assert.equal(snapshot.events.length, 2);
  assert.deepEqual(snapshot.events.map(event => event.signal), ['encore', 'love']);
  assert.deepEqual(snapshot.windows.long.limited, { client: 1, source: 1, global: 1 });
  assert.ok(f.feedback.inspect().clients <= 3);
  assert.ok(f.feedback.inspect().sources <= 2);
  f.clock.at += 60_001;
  assert.equal(f.send('love', client(1)).ok, true);
});

test('default per-browser spacing and per-minute cap are exact', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 12; index++) {
    f.send();
    if (index === 0) {
      f.clock.at += 1999;
      assert.throws(() => f.send(), error => error.status === 429 && error.retryAfterMs === 1);
      f.clock.at += 1;
    } else f.clock.at += 2000;
  }
  assert.throws(() => f.send(), error => error.status === 429);
});

test('idle feedback and hashed rate-limit records are physically expired without another request', async t => {
  const f = await fixture(t, { limits: { bucketMs: 1 } });
  f.send();
  assert.equal(f.feedback.inspect().reports, 1);
  assert.equal(f.feedback.inspect().clients, 1);
  f.clock.at += 130_001;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.feedback.inspect().reports, 0);
  assert.equal(f.feedback.inspect().events, 0);
  assert.equal(f.feedback.inspect().clients, 0);
  assert.equal(f.feedback.inspect().sources, 0);
  f.feedback.close();
  assert.throws(() => f.feedback.snapshot('show-a'), error => error.status === 503);
});

test('feedback reports unavailable rather than accepting a stale last-known show', async t => {
  const f = await fixture(t);
  f.send();
  f.clock.at += 2000;
  f.setState(() => { throw new Error('booking lookup unavailable'); });
  assert.throws(() => f.send(), error => error.status === 503);
  assert.throws(() => f.feedback.snapshot('show-a'), error => error.status === 503);
  f.feedback.sync();
  assert.equal(f.feedback.inspect().bookingBound, false);
});

test('proxy normalization groups an IPv6 network and never trusts extra left-hand forwarded values', async () => {
  const { normalizePeer, peerAddress, parseTrustedProxyHops } = await import('../discord-bot/live-feedback.js');
  assert.equal(normalizePeer('2001:db8:1:2::1'), normalizePeer('2001:0db8:0001:0002::beef'));
  assert.equal(normalizePeer('::ffff:192.0.2.10'), '192.0.2.10');
  const request = { headers: { 'x-forwarded-for': '203.0.113.1, 192.0.2.10' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(peerAddress(request, 1), '192.0.2.10');
  assert.equal(peerAddress(request, 0), '127.0.0.1');
  const warnings = [];
  assert.equal(parseTrustedProxyHops('9', message => warnings.push(message)), 1);
  assert.equal(warnings.length, 1);
});

test('HTTP feedback route enforces origin, type, body size and explicit rate-limit responses', async t => {
  const { handleLiveFeedbackRequest } = await import('../discord-bot/live-feedback.js');
  const f = await fixture(t);
  const server = http.createServer((request, response) => {
    void handleLiveFeedbackRequest(request, response, { feedback: f.feedback, allowedOrigins: [ORIGIN] });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/live-audio/feedback`;
  const headers = { origin: ORIGIN, 'content-type': 'application/json' };
  const body = JSON.stringify({ signal: 'applause', bookingId: 'show-a', clientId: client(1) });
  let response = await fetch(url, { method: 'OPTIONS', headers });
  assert.equal(response.status, 204);
  response = await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://other.example' }, body });
  assert.equal(response.status, 403);
  response = await fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body });
  assert.equal(response.status, 415);
  response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ x: 'x'.repeat(1100) }) });
  assert.equal(response.status, 413);
  response = await fetch(url, { method: 'POST', headers, body });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  response = await fetch(url, { method: 'POST', headers, body });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) >= 1);
});
