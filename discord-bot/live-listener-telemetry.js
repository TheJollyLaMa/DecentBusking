import { createHmac, randomBytes } from 'node:crypto';
import { activeFeedbackShow, FEEDBACK_CLIENT_ID_PATTERN } from '../js/live-feedback-protocol.mjs';
import { normalizePeer, peerAddress, rateLimiter, readBody } from './live-feedback.js';

const LEASE_MS = 45_000;
const MAX_LEASES = 2000;
const MAX_DURATION = 120_000;
const BOUNDS = [250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000, MAX_DURATION];
const REASONS = ['transport', 'disconnected'];
const fail = (status, message) => Object.assign(new Error(message), { status });
const increment = value => Math.min(Number.MAX_SAFE_INTEGER, value + 1);

export function createListenerTelemetry({ resolveState, now = Date.now, trustedProxyHops = 1 } = {}) {
  const salt = randomBytes(32);
  const sources = rateLimiter({ windowMs: 60_000, limit: 300, maxKeys: 2000, ttlMs: 60_000 });
  const global = rateLimiter({ windowMs: 60_000, limit: 6000, maxKeys: 1, ttlMs: 60_000 });
  const grants = new Map(), pages = new Map();
  let data = null, closed = false;
  const digest = value => createHmac('sha256', salt).update(value).digest('base64url');
  function prune(time) {
    for (const [token, lease] of grants) {
      if (time < lease.touched || time - lease.touched >= LEASE_MS) {
        grants.delete(token);
        if (pages.get(lease.page) === token) pages.delete(lease.page);
      }
    }
    sources.prune(time); global.prune(time);
    if (data) for (const minute of data.reconnects.keys()) {
      if (minute < Math.floor(time / 60_000) - 59 || minute > Math.floor(time / 60_000)) data.reconnects.delete(minute);
    }
  }
  function refresh() {
    if (closed) throw fail(503, 'Listener telemetry unavailable');
    let live;
    try { live = activeFeedbackShow(resolveState()); }
    catch { throw fail(503, 'Listener telemetry unavailable'); }
    const time = now();
    prune(time);
    if (!live) throw fail(503, 'Current public show cannot be verified');
    if (!data || data.lifecycle !== live.lifecycle) {
      grants.clear(); pages.clear();
      data = { lifecycle: live.lifecycle, bookingId: live.bookingId, startedAt: live.startedAt,
        observationStartedAt: time,
        peak: 0, connects: 0, firstAudio: Array(BOUNDS.length).fill(0),
        reconnects: new Map(), reasons: Object.fromEntries(REASONS.map(reason => [reason, 0])) };
    }
    return live;
  }
  function snapshot(bookingId) {
    const live = refresh(), time = now();
    if (bookingId !== live.bookingId) throw fail(409, 'Selected booking is not the public show');
    const histogram = data.firstAudio.map((count, i) => ({ upperMs: BOUNDS[i], count }));
    const samples = histogram.reduce((sum, item) => sum + item.count, 0);
    const percentile = p => {
      if (!samples) return null;
      let total = 0;
      return histogram.find(item => (total += item.count) >= Math.ceil(samples * p))?.upperMs ?? null;
    };
    return { schemaVersion: 1, bookingId, startedAt: data.startedAt, observationStartedAt: data.observationStartedAt, observedAt: time,
      current: [...grants.values()].filter(lease => lease.connected).length, peak: data.peak,
      connects: data.connects, firstAudio: { samples, p50UpperMs: percentile(.5), p95UpperMs: percentile(.95), histogram },
      reconnectsLastHour: [...data.reconnects.values()].reduce((a, b) => a + b, 0),
      reconnectReasons: { ...data.reasons }, leaseSeconds: LEASE_MS / 1000,
      note: 'Observed page connections, not unique people or proof anyone heard audio. Playback and inbound packets are browser-reported.' };
  }
  const timer = setInterval(() => { try { prune(now()); } catch {} }, 5000);
  timer.unref?.();
  return {
    trustedProxyHops,
    issue(bookingId, page) {
      if (typeof page !== 'string' || !FEEDBACK_CLIENT_ID_PATTERN.test(page)) return null;
      const live = refresh();
      if (live.bookingId !== bookingId) return null;
      const existing = pages.get(page);
      if (existing) return existing;
      if (grants.size >= MAX_LEASES) return null;
      const token = randomBytes(24).toString('base64url');
      grants.set(token, { page, touched: now(), connected: false, ended: false, first: false, sequence: 0 });
      pages.set(page, token);
      return token;
    },
    submit(input, peer) {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some(key => !['token', 'bookingId', 'sequence', 'event', 'reason', 'durationMs'].includes(key)) ||
          typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(input.token) ||
          typeof input.bookingId !== 'string' || !Number.isSafeInteger(input.sequence) || input.sequence < 1 ||
          !['connect', 'heartbeat', 'first-audio', 'reconnect', 'leave'].includes(input.event) ||
          (input.event === 'reconnect' ? !REASONS.includes(input.reason) : input.reason !== undefined) ||
          (input.event === 'first-audio' ? !Number.isSafeInteger(input.durationMs) || input.durationMs < 0 ||
            input.durationMs > MAX_DURATION : input.durationMs !== undefined)) throw fail(400, 'Invalid telemetry event');
      const time = now(), source = digest(normalizePeer(peer));
      if (sources.check(source, time) || global.check('all', time)) throw fail(429, 'Telemetry rate limited');
      sources.charge(source, time); global.charge('all', time);
      const live = refresh();
      if (input.bookingId !== live.bookingId) throw fail(409, 'Public show changed');
      const lease = grants.get(input.token);
      if (!lease) throw fail(403, 'Listener grant expired');
      if (input.sequence <= lease.sequence) return { ok: true, duplicate: true };
      if (lease.ended || input.sequence !== lease.sequence + 1 ||
          input.event !== 'connect' && !lease.connected ||
          input.event === 'connect' && lease.connected ||
          input.event === 'first-audio' && lease.first) throw fail(409, 'Invalid telemetry sequence');
      lease.sequence = input.sequence;
      lease.touched = time;
      if (input.event === 'connect') {
        lease.connected = true;
        data.connects = increment(data.connects);
        data.peak = Math.max(data.peak, [...grants.values()].filter(item => item.connected).length);
      } else if (input.event === 'first-audio') {
        lease.first = true;
        const index = BOUNDS.findIndex(bound => input.durationMs <= bound);
        data.firstAudio[index] = increment(data.firstAudio[index]);
      } else if (input.event === 'reconnect') {
        const minute = Math.floor(time / 60_000);
        data.reconnects.set(minute, increment(data.reconnects.get(minute) || 0));
        data.reasons[input.reason] = increment(data.reasons[input.reason]);
      } else if (input.event === 'leave') {
        lease.connected = false;
        lease.ended = true;
        pages.delete(lease.page);
      }
      return { ok: true };
    },
    snapshot,
    close() { closed = true; clearInterval(timer); grants.clear(); pages.clear(); sources.clear(); global.clear(); data = null; },
  };
}

export async function handleListenerTelemetry(request, response, { telemetry, allowedOrigins = [] }) {
  const origin = String(request.headers.origin || ''), allowed = allowedOrigins.includes(origin);
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store',
    ...(allowed ? { 'access-control-allow-origin': origin, vary: 'origin' } : {}) };
  const send = (status, body) => {
    if (status === 413) response.once?.('finish', () => request.destroy?.());
    response.writeHead(status, status === 413 ? { ...headers, connection: 'close' } : headers);
    response.end(JSON.stringify(body));
  };
  if (request.method === 'OPTIONS') {
    response.writeHead(allowed ? 204 : 403, { ...headers, 'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type' }); response.end(); return;
  }
  if (!allowed) return send(403, { error: 'Origin not allowed' });
  if (request.method !== 'POST') return send(405, { error: 'POST required' });
  if (!telemetry) return send(503, { error: 'Listener telemetry unavailable' });
  if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] || ''))) return send(415, { error: 'JSON required' });
  try {
    const text = await readBody(request, 1024);
    let input;
    try { input = JSON.parse(text); } catch { throw fail(400, 'Invalid telemetry event'); }
    send(200, telemetry.submit(input, peerAddress(request, telemetry.trustedProxyHops)));
  } catch (error) {
    const status = [400, 403, 409, 413, 429, 503].includes(error.status) ? error.status : 503;
    send(status, { error: status === 503 ? 'Listener telemetry unavailable' : 'Telemetry request rejected' });
  }
}
