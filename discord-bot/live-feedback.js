import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { activeFeedbackShow, FEEDBACK_ADVISORY, FEEDBACK_SIGNALS, validateFeedbackInput } from '../js/live-feedback-protocol.mjs';

export const FEEDBACK_LIMITS = Object.freeze({
  maxBodyBytes: 1024,
  clientMinIntervalMs: 2000,
  clientPerMinute: 12,
  sourcePerMinute: 60,
  globalPerMinute: 600,
  rateWindowMs: 60_000,
  maxClientRecords: 5000,
  maxSourceRecords: 5000,
  bucketMs: 10_000,
  retentionMs: 130_000,
  eventTtlMs: 10_000,
  maxEvents: 120,
  tipNoticeLimit: 20,
  trustedProxyHops: 1,
});

const UNAVAILABLE = 'Listener feedback is unavailable; try again shortly';
const INVALID = 'Listener feedback request is not valid';
const SCOPES = ['client', 'source', 'global'];

export class FeedbackError extends Error {
  constructor(status, code, message, retryAfterMs) {
    super(message);
    this.name = 'FeedbackError';
    this.status = status;
    this.code = code;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
  body() {
    return { error: this.message, code: this.code,
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }) };
  }
}

function resolveLimits(overrides = {}) {
  const limits = { ...FEEDBACK_LIMITS, ...overrides };
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(FEEDBACK_LIMITS, key)) throw new TypeError(`Unknown live feedback limit: ${key}`);
  }
  for (const [key, value] of Object.entries(limits)) {
    const minimum = ['clientMinIntervalMs', 'trustedProxyHops'].includes(key) ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`Invalid live feedback limit: ${key}`);
  }
  if (limits.trustedProxyHops > 5 || limits.retentionMs < 120_000 + limits.bucketMs ||
      limits.eventTtlMs > limits.retentionMs) throw new TypeError('Invalid live feedback retention or proxy limits');
  return Object.freeze(limits);
}

export function rateLimiter({ windowMs, limit, minIntervalMs = 0, maxKeys, ttlMs }) {
  const entries = new Map();
  return {
    check(key, time) {
      const entry = entries.get(key);
      if (!entry) return 0;
      const hits = entry.hits.filter(at => at > time - windowMs && at <= time);
      let wait = hits.length && minIntervalMs ? hits.at(-1) + minIntervalMs - time : 0;
      if (hits.length >= limit) wait = Math.max(wait, hits[hits.length - limit] + windowMs - time);
      return Math.max(0, Math.min(wait, Math.max(windowMs, minIntervalMs)));
    },
    charge(key, time) {
      for (const [oldKey, entry] of entries) {
        if (time >= entry.touchedAt && time - entry.touchedAt <= ttlMs) break;
        entries.delete(oldKey);
      }
      const entry = entries.get(key) || { hits: [], signals: {}, touchedAt: time };
      entries.delete(key);
      entry.hits = entry.hits.filter(at => at > time - windowMs && at <= time);
      entry.hits.push(time);
      entry.touchedAt = time;
      entries.set(key, entry);
      while (entries.size > maxKeys) entries.delete(entries.keys().next().value);
    },
    markSignal(key, signal, time) {
      const entry = entries.get(key);
      if (entry) entry.signals[signal] = time;
    },
    clearSignals() {
      for (const entry of entries.values()) entry.signals = {};
    },
    prune(time) {
      for (const [key, entry] of entries) {
        entry.hits = entry.hits.filter(at => at > time - windowMs && at <= time);
        for (const [signal, at] of Object.entries(entry.signals)) {
          if (at <= time - 120_000 || at > time) delete entry.signals[signal];
        }
        if (time < entry.touchedAt || time - entry.touchedAt >= ttlMs) entries.delete(key);
      }
    },
    values: () => entries.values(),
    clear: () => entries.clear(),
    get size() { return entries.size; },
  };
}

function expandIpv6(text) {
  const [head, tail = ''] = text.split('::');
  const groups = part => part ? part.split(':') : [];
  return [...groups(head), ...(text.includes('::') ? Array(Math.max(0, 8 - groups(head).length - groups(tail).length)).fill('0') : []),
    ...groups(tail)].slice(0, 8).map(group => group.padStart(4, '0').toLowerCase());
}

export function normalizePeer(value) {
  let text = String(value || '').trim();
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end > 0) text = text.slice(1, end);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(text)) text = text.slice(0, text.lastIndexOf(':'));
  text = text.replace(/%.*$/, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(text);
  if (mapped) text = mapped[1];
  if (isIP(text) === 4) return text;
  if (isIP(text) === 6) {
    const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
    const plain = dotted ? `${dotted[1]}${((+dotted[2] << 8) | +dotted[3]).toString(16)}:${((+dotted[4] << 8) | +dotted[5]).toString(16)}` : text;
    return `${expandIpv6(plain).slice(0, 4).join(':')}::/64`;
  }
  return 'unknown';
}

export function peerAddress(request, hops = FEEDBACK_LIMITS.trustedProxyHops) {
  if (hops > 0) {
    const forwarded = String(request.headers?.['x-forwarded-for'] || '').split(',').map(part => part.trim()).filter(Boolean);
    if (forwarded.length >= hops) return forwarded[forwarded.length - hops];
  }
  return request.socket?.remoteAddress || '';
}

export function parseTrustedProxyHops(raw, warn = console.warn) {
  if (raw === undefined || String(raw).trim() === '') return FEEDBACK_LIMITS.trustedProxyHops;
  if (/^[0-5]$/.test(String(raw).trim())) return Number(String(raw).trim());
  warn('[live-feedback] LIVE_FEEDBACK_TRUSTED_PROXY_HOPS must be an integer from 0 to 5; using 1.');
  return FEEDBACK_LIMITS.trustedProxyHops;
}

const zeroCounts = () => Object.fromEntries(FEEDBACK_SIGNALS.map(signal => [signal, 0]));

export function createLiveFeedback({ resolveState, readLiveTips = () => null, limits: overrides,
  now = () => Date.now(), salt = randomBytes(32) } = {}) {
  if (typeof resolveState !== 'function' || typeof readLiveTips !== 'function') {
    throw new TypeError('Live feedback requires state and tip readers');
  }
  const limits = resolveLimits(overrides);
  const digest = (kind, value) => createHmac('sha256', salt).update(`${kind}\0${value}`).digest('base64url').slice(0, 22);
  const clients = rateLimiter({ windowMs: limits.rateWindowMs, limit: limits.clientPerMinute,
    minIntervalMs: limits.clientMinIntervalMs, maxKeys: limits.maxClientRecords, ttlMs: limits.retentionMs });
  const sources = rateLimiter({ windowMs: limits.rateWindowMs, limit: limits.sourcePerMinute,
    maxKeys: limits.maxSourceRecords, ttlMs: limits.rateWindowMs });
  const global = rateLimiter({ windowMs: limits.rateWindowMs, limit: limits.globalPerMinute,
    maxKeys: 1, ttlMs: limits.rateWindowMs });
  const maxBuckets = Math.ceil(limits.retentionMs / limits.bucketMs) + 1;
  const maxReports = Math.min(2000, (Math.ceil(120_000 / limits.rateWindowMs) + 1) * limits.globalPerMinute);
  let data = null, expiryTimer = null, tipErrorLogged = false, closed = false;

  function maintain() {
    const time = now();
    clients.prune(time);
    sources.prune(time);
    global.prune(time);
    if (!data) return;
    data.reports = data.reports.filter(report => report.at > time - 120_000 && report.at <= time);
    data.events = data.events.filter(event => event.at > time - limits.eventTtlMs && event.at <= time);
    const cutoff = Math.floor((time - limits.retentionMs) / limits.bucketMs);
    for (const key of data.buckets.keys()) if (key < cutoff) data.buckets.delete(key);
  }
  const maintenanceTimer = setInterval(() => {
    try { maintain(); }
    catch { console.warn('[live-feedback] Listener feedback retention cleanup failed.'); }
  }, Math.min(10_000, limits.bucketMs));
  maintenanceTimer.unref?.();

  function dropData() {
    clearTimeout(expiryTimer);
    expiryTimer = null;
    data = null;
    clients.clearSignals();
  }
  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    if (!data) return;
    expiryTimer = setTimeout(() => {
      expiryTimer = null;
      try { refresh(); }
      catch {
        dropData();
        console.warn('[live-feedback] Listener feedback expired because the current booking could not be verified.');
      }
    }, Math.max(1, Math.min(data.endsAt - now(), 2_147_483_647)));
    expiryTimer.unref?.();
  }
  function refresh() {
    if (closed) throw new FeedbackError(503, 'FEEDBACK_UNAVAILABLE', UNAVAILABLE);
    let state;
    try { state = resolveState(); }
    catch {
      if (data && now() >= data.endsAt) dropData();
      throw new FeedbackError(503, 'FEEDBACK_UNAVAILABLE', UNAVAILABLE);
    }
    if (state && typeof state.then === 'function') throw new TypeError('Live feedback state reader must be synchronous');
    const live = activeFeedbackShow(state);
    if (!live) { dropData(); return null; }
    if (data?.lifecycle !== live.lifecycle || data.recipient !== live.recipient) {
      dropData();
      data = { ...live, epoch: randomBytes(12).toString('base64url'), sequence: 0,
        buckets: new Map(), reports: [], events: [], lastAt: {} };
      scheduleExpiry();
    } else if (data.endsAt !== live.endsAt) {
      data.endsAt = live.endsAt;
      scheduleExpiry();
    }
    return live;
  }
  function bucketFor(time) {
    const index = Math.floor(time / limits.bucketMs);
    let bucket = data.buckets.get(index);
    if (!bucket) {
      bucket = { limited: { client: 0, source: 0, global: 0 } };
      data.buckets.set(index, bucket);
      const cutoff = Math.floor((time - limits.retentionMs) / limits.bucketMs);
      for (const key of data.buckets.keys()) if (key < cutoff) data.buckets.delete(key);
      while (data.buckets.size > maxBuckets) data.buckets.delete(Math.min(...data.buckets.keys()));
    }
    return bucket;
  }
  function summarize(windowMs, time) {
    const first = Math.floor((time - windowMs) / limits.bucketMs);
    const counts = zeroCounts(), browsers = zeroCounts(), limited = { client: 0, source: 0, global: 0 };
    for (const report of data.reports) {
      if (report.at > time - windowMs && report.at <= time) counts[report.signal] += 1;
    }
    for (const [index, bucket] of data.buckets) {
      if (index < first) continue;
      for (const scope of SCOPES) limited[scope] += bucket.limited[scope];
    }
    for (const entry of clients.values()) {
      for (const signal of FEEDBACK_SIGNALS) if (entry.signals[signal] > time - windowMs) browsers[signal] += 1;
    }
    return { seconds: windowMs / 1000, counts, browsers, limited };
  }
  function tipSnapshot(live) {
    try {
      const result = readLiveTips({ bookingId: live.bookingId, recipient: live.recipient,
        startedAt: live.startedAt, endsAt: live.endsAt, limit: limits.tipNoticeLimit });
      tipErrorLogged = false;
      if (!result?.ready) return { available: false };
      return { available: true, complete: result.complete, count: result.count, totalWei: result.totalWei,
        checkedAt: result.checkedAt,
        entries: result.entries.map(entry => ({ id: digest('tip', entry.eventKey),
          amountWei: entry.amountWei, paidAt: entry.paidAt })) };
    } catch (error) {
      if (!tipErrorLogged) console.warn('[live-feedback] Verified tip status unavailable:', error?.name || 'Error');
      tipErrorLogged = true;
      return { available: false };
    }
  }
  return {
    limits,
    submit(input, { peer = '' } = {}) {
      if (closed) throw new FeedbackError(503, 'FEEDBACK_UNAVAILABLE', UNAVAILABLE);
      if (!validateFeedbackInput(input)) throw new FeedbackError(400, 'FEEDBACK_INVALID', INVALID);
      const time = now(), clientKey = digest('client', input.clientId), sourceKey = digest('source', normalizePeer(peer));
      const verdicts = [['client', clients.check(clientKey, time)], ['source', sources.check(sourceKey, time)],
        ['global', global.check('all', time)]];
      const blocked = verdicts.filter(([, wait]) => wait > 0);
      if (blocked.length) {
        try {
          if (refresh()) bucketFor(time).limited[blocked[0][0]] += 1;
        } catch (error) {
          if (!(error instanceof FeedbackError) || error.code !== 'FEEDBACK_UNAVAILABLE') throw error;
        }
        throw new FeedbackError(429, 'FEEDBACK_RATE_LIMITED', 'Too many listener signals; try again shortly',
          Math.max(...blocked.map(([, wait]) => wait)));
      }
      clients.charge(clientKey, time);
      sources.charge(sourceKey, time);
      global.charge('all', time);
      const live = refresh();
      if (!live) throw new FeedbackError(404, 'FEEDBACK_NO_LIVE_SET', 'No live set is accepting listener signals right now');
      if (input.bookingId !== live.bookingId) {
        throw new FeedbackError(409, 'FEEDBACK_BOOKING_MISMATCH', 'The live set changed; refresh and try again');
      }
      clients.markSignal(clientKey, input.signal, time);
      data.reports = data.reports.filter(report => report.at > time - 120_000 && report.at <= time);
      data.reports.push({ signal: input.signal, at: time });
      if (data.reports.length > maxReports) data.reports.splice(0, data.reports.length - maxReports);
      data.lastAt[input.signal] = data.lastAt.any = time;
      data.events = data.events.filter(event => event.at > time - limits.eventTtlMs);
      if (input.signal !== 'audio-problem') {
        data.events.push({ id: `${data.epoch}:${++data.sequence}`, signal: input.signal, at: time });
        if (data.events.length > limits.maxEvents) data.events.splice(0, data.events.length - limits.maxEvents);
      }
      return { ok: true, signal: input.signal, bookingId: live.bookingId, nextAllowedInMs: limits.clientMinIntervalMs };
    },
    snapshot(bookingId) {
      const live = refresh(), time = now();
      const base = { schemaVersion: 1, bookingId, serverTime: time, advisory: FEEDBACK_ADVISORY };
      if (!live || live.bookingId !== bookingId) return { ...base, active: false };
      data.reports = data.reports.filter(report => report.at > time - 120_000 && report.at <= time);
      data.events = data.events.filter(event => event.at > time - limits.eventTtlMs && event.at <= time);
      const lastReceivedAt = { any: data.lastAt.any ?? null };
      for (const signal of FEEDBACK_SIGNALS) lastReceivedAt[signal] = data.lastAt[signal] ?? null;
      return { ...base, active: true, epoch: data.epoch, endsAt: live.endsAt, bucketSeconds: limits.bucketMs / 1000,
        windows: { short: summarize(30_000, time), long: summarize(120_000, time) },
        lastReceivedAt, events: data.events.map(event => ({ ...event })), tips: tipSnapshot(live) };
    },
    sync() {
      if (closed) return;
      if (!data) return;
      try { refresh(); }
      catch {
        dropData();
        console.warn('[live-feedback] Listener feedback cleared because the current booking could not be verified.');
      }
    },
    inspect: () => ({ bookingBound: !!data, buckets: data?.buckets.size ?? 0, events: data?.events.length ?? 0,
      reports: data?.reports.length ?? 0, clients: clients.size, sources: sources.size }),
    close() {
      closed = true;
      clearInterval(maintenanceTimer);
      dropData();
      clients.clear();
      sources.clear();
      global.clear();
    },
  };
}

export function readBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new FeedbackError(413, 'FEEDBACK_TOO_LARGE', 'Listener feedback request is too large');
    const declared = Number(request.headers?.['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) { reject(tooLarge()); return; }
    const chunks = [];
    let size = 0, settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('error', onError);
      request.removeListener('close', onClose);
      settle(value);
    };
    function onData(chunk) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += part.length;
      if (size > maxBytes) finish(reject, tooLarge());
      else chunks.push(part);
    }
    const onEnd = () => finish(resolve, Buffer.concat(chunks).toString('utf8'));
    const onError = () => finish(reject, new FeedbackError(400, 'FEEDBACK_INVALID', INVALID));
    const onClose = () => finish(reject, new FeedbackError(400, 'FEEDBACK_INVALID', INVALID));
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
    request.on('close', onClose);
  });
}

export async function handleLiveFeedbackRequest(request, response, { feedback, allowedOrigins = [] } = {}) {
  const origin = String(request.headers?.origin || ''), allowed = allowedOrigins.includes(origin);
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store',
    ...(allowed ? { 'access-control-allow-origin': origin, vary: 'origin', 'access-control-expose-headers': 'retry-after' } : {}) };
  const send = (status, body, extra = {}) => { response.writeHead(status, { ...headers, ...extra }); response.end(JSON.stringify(body)); };
  if (request.method === 'OPTIONS') {
    response.writeHead(allowed ? 204 : 403, { ...headers, 'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type' });
    response.end();
    return true;
  }
  if (!allowed) { send(403, { error: 'Listener feedback origin is not allowed', code: 'FEEDBACK_ORIGIN_NOT_ALLOWED' }); return true; }
  if (request.method !== 'POST') { send(405, { error: 'Listener feedback requires POST', code: 'FEEDBACK_METHOD' }, { allow: 'POST, OPTIONS' }); return true; }
  if (!feedback) { send(503, { error: UNAVAILABLE, code: 'FEEDBACK_UNAVAILABLE' }); return true; }
  if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers?.['content-type'] || ''))) {
    send(415, { error: 'Listener feedback must be sent as JSON', code: 'FEEDBACK_UNSUPPORTED_TYPE' });
    return true;
  }
  try {
    const text = await readBody(request, feedback.limits.maxBodyBytes);
    let input;
    try { input = JSON.parse(text); }
    catch { throw new FeedbackError(400, 'FEEDBACK_INVALID', INVALID); }
    send(200, feedback.submit(input, { peer: peerAddress(request, feedback.limits.trustedProxyHops) }));
  } catch (error) {
    if (!(error instanceof FeedbackError)) {
      console.error('[live-feedback] Request failed:', error?.name || 'Error');
      send(503, { error: UNAVAILABLE, code: 'FEEDBACK_UNAVAILABLE' });
      return true;
    }
    const extra = error.status === 429 ? { 'retry-after': String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))) }
      : error.status === 413 ? { connection: 'close' } : {};
    send(error.status, error.body(), extra);
    if (error.status === 413) response.once?.('finish', () => request.destroy?.());
  }
  return true;
}
