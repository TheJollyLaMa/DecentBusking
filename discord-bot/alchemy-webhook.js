import { createHmac, timingSafeEqual } from 'node:crypto';

export const MAX_WEBHOOK_BODY_BYTES = 512 * 1024;

export function verifyAlchemySignature(rawBody, signature, signingKey) {
  if (!signingKey || typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', signingKey).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

// Collects every emitting contract address from a custom (GraphQL) or Address Activity payload.
export function webhookAddresses(payload) {
  const found = new Set();
  const add = value => { if (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)) found.add(value.toLowerCase()); };
  const event = payload?.event || {};
  for (const log of event.data?.block?.logs || []) {
    add(log?.account?.address);
    for (const inner of log?.transaction?.logs || []) add(inner?.account?.address);
  }
  for (const activity of event.activity || []) {
    add(activity?.rawContract?.address);
    add(activity?.log?.address);
    add(activity?.toAddress);
    add(activity?.fromAddress);
  }
  return found;
}

/**
 * Alchemy webhooks are treated purely as a nudge: a verified delivery schedules the matching
 * refreshers, which then read the chain themselves. Payload contents are never trusted as data.
 */
export function createAlchemyWebhook({ signingKey, routes = [], debounceMs = 3_000, now = () => Date.now(),
  setTimer = setTimeout, clearTimer = clearTimeout, log = console } = {}) {
  const byAddress = new Map();
  for (const { addresses = [], refresh = [], label = 'contract' } of routes) {
    for (const address of addresses) {
      if (!address) continue;
      const key = address.toLowerCase();
      const entry = byAddress.get(key) || { labels: new Set(), refresh: new Set() };
      entry.labels.add(label);
      for (const task of refresh) if (typeof task === 'function') entry.refresh.add(task);
      byAddress.set(key, entry);
    }
  }
  const pending = new Set();
  let timer = null;
  const stats = { received: 0, verified: 0, rejected: 0, triggered: 0, lastVerifiedAt: null, lastEventAt: null, lastLabels: [] };

  function flush() {
    timer = null;
    const tasks = [...pending];
    pending.clear();
    for (const task of tasks) {
      try {
        Promise.resolve(task()).catch(error => log.warn?.('[alchemy-webhook] refresh failed:', error?.message || error));
      } catch (error) {
        log.warn?.('[alchemy-webhook] refresh failed:', error?.message || error);
      }
    }
  }

  function handle(rawBody, signature) {
    stats.received += 1;
    if (!signingKey) return { status: 404, body: { error: 'Alchemy webhooks are not configured' } };
    if (!verifyAlchemySignature(rawBody, signature, signingKey)) {
      stats.rejected += 1;
      return { status: 401, body: { error: 'Invalid webhook signature' } };
    }
    let payload;
    try { payload = JSON.parse(Buffer.from(rawBody).toString('utf8')); } catch {
      stats.rejected += 1;
      return { status: 400, body: { error: 'Webhook body is not JSON' } };
    }
    stats.verified += 1;
    stats.lastVerifiedAt = new Date(now()).toISOString();
    const labels = new Set();
    for (const address of webhookAddresses(payload)) {
      const entry = byAddress.get(address);
      if (!entry) continue;
      for (const label of entry.labels) labels.add(label);
      for (const task of entry.refresh) pending.add(task);
    }
    if (labels.size) {
      stats.triggered += 1;
      stats.lastEventAt = stats.lastVerifiedAt;
      stats.lastLabels = [...labels];
      if (!timer) {
        timer = setTimer(flush, debounceMs);
        timer?.unref?.();
      }
    }
    return { status: 200, body: { ok: true, matched: [...labels] } };
  }

  return {
    handle,
    flush() { if (timer) clearTimer(timer); flush(); },
    configured: () => Boolean(signingKey),
    health: () => ({ configured: Boolean(signingKey), watching: byAddress.size, ...stats }),
  };
}

export async function readRawBody(request, limit = MAX_WEBHOOK_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
