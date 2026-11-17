const PREFIX = /^\/hls\/[a-f0-9]{32}\/(index\.m3u8|state\.json|segment-\d{9}\.ts)$/;
const headers = { 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff',
  'access-control-expose-headers': 'date', 'cache-control': 'no-store' };
const reply = (status, text = '') => new Response(status === 204 ? null : text, { status, headers });

async function authorized(request, token) {
  if (!/^[a-zA-Z0-9_-]{32,200}$/.test(token || '')) return false;
  const supplied = request.headers.get('authorization')?.replace(/^Bearer /, '') || '';
  if (supplied.length > 200) return false;
  const digest = value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [a, b] = await Promise.all([digest(supplied), digest(token)]);
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let different = 0;
  for (let i = 0; i < aa.length; i++) different |= aa[i] ^ bb[i];
  return different === 0;
}

export async function handleBroadcastRequest(request, env, context, now = Date.now) {
  const url = new URL(request.url);
  if (!PREFIX.test(url.pathname) || url.search) return reply(404);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
    ...headers, 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-allow-headers': 'range' } });
  if (!env.BROADCAST_BUCKET) return reply(503, 'Broadcast storage unavailable');
  const key = url.pathname.slice(1), manifest = url.pathname.endsWith('.m3u8');
  const state = url.pathname.endsWith('.json');
  const contentType = manifest ? 'application/vnd.apple.mpegurl' : state ? 'application/json' : 'video/mp2t';
  if (request.method === 'PUT') {
    if (!await authorized(request, env.BROADCAST_UPLOAD_TOKEN)) return reply(403);
    const expiresAt = Number(request.headers.get('x-broadcast-expires-at'));
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now() || expiresAt > now() + 120000) return reply(400);
    const chunks = [];
    let length = 0;
    for await (const chunk of request.body || []) {
      length += chunk.byteLength;
      if (length > (manifest ? 32768 : state ? 65536 : 256000)) {
        return reply(413);
      }
      chunks.push(chunk);
    }
    if (!length) return reply(413);
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    await env.BROADCAST_BUCKET.put(key, bytes, { customMetadata: { expiresAt: String(expiresAt) },
      httpMetadata: { contentType } });
    return reply(204);
  }
  if (!['GET', 'HEAD'].includes(request.method)) return reply(405);
  if (!env.BROADCAST_RATE_LIMITER) return reply(503, 'Broadcast rate controls unavailable');
  const limit = await env.BROADCAST_RATE_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
  if (!limit.success) return reply(429, 'Broadcast request limit reached');
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(url.origin + url.pathname);
  const cached = await cache?.match(cacheKey);
  if (cached) return new Response(request.method === 'HEAD' ? null : cached.body, cached);
  const object = await env.BROADCAST_BUCKET.get(key);
  const expiresAt = Number(object?.customMetadata?.expiresAt);
  if (!object || !Number.isSafeInteger(expiresAt) || expiresAt <= now()) return reply(404, 'Broadcast expired');
  const ttl = Math.max(0, Math.min(manifest || state ? 1 : 30, Math.floor((expiresAt - now()) / 1000)));
  const response = new Response(object.body, { headers: { ...headers,
    'content-type': contentType,
    'cache-control': `public, max-age=${ttl}, must-revalidate` } });
  if (cache && context?.waitUntil) context.waitUntil(cache.put(cacheKey, response.clone()));
  return new Response(request.method === 'HEAD' ? null : response.body, response);
}

export default {
  async fetch(request, env, context) {
    try { return await handleBroadcastRequest(request, env, context); }
    catch {
      console.error('[public-broadcast-edge] STORAGE_REQUEST_FAILED');
      return reply(503, 'Broadcast temporarily unavailable');
    }
  },
  async scheduled(_event, env) {
    const page = await env.BROADCAST_BUCKET.list({ prefix: 'hls/', limit: 1000, include: ['customMetadata'] });
    const expired = page.objects.filter(object => Number(object.customMetadata?.expiresAt || 0) <= Date.now());
    if (expired.length) await env.BROADCAST_BUCKET.delete(expired.map(object => object.key));
  },
};
