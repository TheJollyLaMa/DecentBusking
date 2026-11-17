import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';

const { values } = parseArgs({ options: {
  origin: { type: 'string' }, listeners: { type: 'string', default: '200' },
  seconds: { type: 'string', default: '600' }, 'staging-approved': { type: 'boolean', default: false },
  'media-origin': { type: 'string' },
} });
const origin = new URL(values.origin);
const mediaOrigin = new URL(values['media-origin'] || origin.origin);
const listeners = Number(values.listeners), seconds = Number(values.seconds);
if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
    !['http:', 'https:'].includes(origin.protocol) ||
    !Number.isInteger(listeners) || listeners < 1 || listeners > 200 ||
    !Number.isInteger(seconds) || seconds < 10 || seconds > 3600) {
  throw new Error('Use an origin, 1–200 listeners and 10–3600 seconds');
}
if (/decentbusking\.onrender\.com$/i.test(origin.hostname) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && !values['staging-approved']) {
  throw new Error('Production load testing is prohibited. Non-local staging requires --staging-approved');
}
const abort = new AbortController();
const timeout = setTimeout(() => abort.abort(), seconds * 1000);
const samples = { radioMs: [], manifestMs: [], audioMs: [], errors: {}, errorDetails: [], bytes: 0, resources: [] };
function error(code) { samples.errors[code] = (samples.errors[code] || 0) + 1; }
async function get(url, category) {
  const beganAt = performance.now();
  const response = await fetch(url, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
    redirect: 'error', cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  samples.bytes += bytes.byteLength;
  samples[category].push(performance.now() - beganAt);
  return category === 'audioMs' ? null : new TextDecoder().decode(bytes);
}
async function listener(index) {
  await new Promise(resolve => setTimeout(resolve, index * 10));
  const seen = new Set();
  let stateUrl = `${origin.origin}/api/radio`;
  while (!abort.signal.aborted) {
    let phase = 'metadata';
    try {
      const state = JSON.parse(await get(stateUrl, 'radioMs'));
      const broadcast = state.publicBroadcast;
      if (broadcast?.status !== 'ready' || !broadcast.url) throw new Error('BROADCAST_NOT_READY');
      const manifestUrl = new URL(broadcast.url);
      if (manifestUrl.origin !== mediaOrigin.origin) throw new Error('UNAPPROVED_MEDIA_ORIGIN');
      if (broadcast.stateUrl) {
        const nextState = new URL(broadcast.stateUrl);
        if (nextState.origin !== mediaOrigin.origin) throw new Error('UNAPPROVED_STATE_ORIGIN');
        stateUrl = nextState.href;
      }
      if (manifestUrl.protocol !== 'https:' &&
          !['localhost', '127.0.0.1', '[::1]'].includes(manifestUrl.hostname)) throw new Error('INVALID_MEDIA_ORIGIN');
      phase = 'manifest';
      const manifest = await get(manifestUrl, 'manifestMs');
      const names = manifest.split('\n').filter(line => /^segment-\d{9}\.ts$/.test(line));
      if (!names.length || names.length > 8) throw new Error('INVALID_PLAYLIST');
      // Match the player's three-segment target, before publishing/cache delay.
      for (const name of names.slice(Math.max(0, names.length - 3))) {
        const key = new URL(name, manifestUrl).href;
        if (seen.has(key)) continue;
        phase = 'audioSegment';
        await get(key, 'audioMs');
        seen.add(key);
      }
      if (seen.size > 32) for (const key of [...seen].slice(0, seen.size - 32)) seen.delete(key);
    } catch (failure) {
      if (!abort.signal.aborted) {
        const code = /^HTTP_\d+$|^[A-Z_]+$/.test(failure.message) ? failure.message : 'REQUEST_FAILED';
        error(code);
        if (samples.errorDetails.length < 20) samples.errorDetails.push({
          phase, code, name: failure.name, causeCode: failure.cause?.code || null,
          nestedCodes: Array.isArray(failure.cause?.errors) ? failure.cause.errors.slice(0, 3).map(item => item.code) : [],
        });
      }
    }
    if (!abort.signal.aborted) await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
const resourceTimer = setInterval(async () => {
  try {
    const response = await fetch(`${origin.origin}/health`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('Health unavailable');
    samples.resources.push((await response.json()).radioResources || null);
    if (samples.resources.length > 360) samples.resources.shift();
  } catch { if (!abort.signal.aborted) error('RESOURCE_SAMPLE_FAILED'); }
}, 10000);
try {
  await Promise.all(Array.from({ length: listeners }, (_, index) => listener(index)));
} finally {
  clearTimeout(timeout); clearInterval(resourceTimer);
}
const summary = data => {
  data.sort((a, b) => a - b);
  return { count: data.length, p95Ms: data.length ? data[Math.ceil(data.length * .95) - 1] : null,
    p99Ms: data.length ? data[Math.ceil(data.length * .99) - 1] : null };
};
console.log(JSON.stringify({ kind: 'HTTP workload measurement; not decoded audio or production capacity certification',
  listeners, seconds, verdict: 'NOT_EVALUATED: HTTP-only; frozen limits also require audible and hosted-quota evidence',
  radio: summary(samples.radioMs), manifest: summary(samples.manifestMs), audioSegment: summary(samples.audioMs),
  audioStart: { p95Ms: null, reason: 'Downloading a segment is not starting decoded playback' },
  errors: samples.errors, errorDetails: samples.errorDetails, receivedBytes: samples.bytes, resources: samples.resources,
  unmeasured: ['actual hosting headroom without verified plan quotas', 'authenticated producer control latency',
    'mobile Safari', 'audible silence/overlap/latency', 'real multi-human rehearsal', 'paid settlement correctness'] }, null, 2));
if (Object.keys(samples.errors).length) process.exitCode = 1;
