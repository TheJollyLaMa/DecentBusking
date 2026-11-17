import { roomRequest } from './live-audio-client.mjs?v=20261117-lease-recovery';

const integer = value => Number.isSafeInteger(value) && value >= 0;
const BOUNDS = [250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000, 120_000];
function sanitize(value, bookingId) {
  const valid = value?.schemaVersion === 1 && value.bookingId === bookingId &&
    Number.isFinite(value.startedAt) && Number.isFinite(value.observationStartedAt) &&
    Number.isFinite(value.observedAt) && value.startedAt <= value.observationStartedAt &&
    value.observationStartedAt <= value.observedAt && integer(value.current) && integer(value.peak) &&
    value.current <= value.peak && integer(value.connects) && integer(value.reconnectsLastHour) &&
    integer(value.reconnectReasons?.transport) && integer(value.reconnectReasons?.disconnected) &&
    value.leaseSeconds === 45 &&
    integer(value.firstAudio?.samples) && Array.isArray(value.firstAudio.histogram) &&
    value.firstAudio.histogram.length === BOUNDS.length &&
    value.firstAudio.histogram.every((row, i) => row.upperMs === BOUNDS[i] && integer(row.count)) &&
    value.firstAudio.histogram.reduce((sum, row) => sum + row.count, 0) === value.firstAudio.samples &&
    [value.firstAudio.p50UpperMs, value.firstAudio.p95UpperMs].every(n =>
      value.firstAudio.samples ? BOUNDS.includes(n) : n === null);
  if (!valid) return null;
  return { schemaVersion: 1, bookingId, startedAt: value.startedAt, observationStartedAt: value.observationStartedAt,
    observedAt: value.observedAt, current: value.current, peak: value.peak, connects: value.connects,
    firstAudio: { samples: value.firstAudio.samples, p50UpperMs: value.firstAudio.p50UpperMs,
      p95UpperMs: value.firstAudio.p95UpperMs,
      histogram: value.firstAudio.histogram.map(row => ({ upperMs: row.upperMs, count: row.count })) },
    reconnectsLastHour: value.reconnectsLastHour,
    reconnectReasons: { transport: value.reconnectReasons.transport, disconnected: value.reconnectReasons.disconnected },
    leaseSeconds: value.leaseSeconds,
    note: 'Observed page connections, not unique people or proof anyone heard audio. Playback and inbound packets are browser-reported.' };
}

export function bindProducerListenerTelemetry({ container, serviceUrl, bookingId, request = roomRequest,
  environment = globalThis, now = Date.now, download } = {}) {
  const doc = container.ownerDocument;
  const heading = doc.createElement('h3'), status = doc.createElement('p'), button = doc.createElement('button');
  heading.textContent = 'Public listener telemetry';
  status.setAttribute('role', 'status');
  button.type = 'button'; button.textContent = 'Export aggregate evidence'; button.disabled = true;
  container.replaceChildren(heading, status, button);
  let session = null, snapshot = null, observedAt = 0, generation = 0, busy = false, disposed = false;
  const clear = message => { snapshot = null; observedAt = 0; button.disabled = true; status.textContent = message; };
  clear('Unavailable. Authorize the owner for the current public show.');
  async function refresh() {
    if (!session || busy || disposed) return;
    if (session.expiresAt <= now()) { session = null; clear('Owner authorization expired; reconnect.'); return; }
    const current = generation, selected = session;
    busy = true;
    try {
      const result = await request(serviceUrl, 'control', { action: 'telemetry-snapshot' }, selected.token);
      if (disposed || generation !== current) return;
      snapshot = sanitize(result, bookingId);
      if (!snapshot) throw new Error('Invalid snapshot');
      observedAt = now(); button.disabled = false;
      const first = snapshot.firstAudio;
      const percentiles = first.samples ? `p50 ≤ ${first.p50UpperMs} ms, p95 ≤ ${first.p95UpperMs} ms` : 'percentiles unavailable';
      status.textContent = `Observed active page connections: ${snapshot.current}; peak: ${snapshot.peak}. ` +
        `Reconnects in the last hour: ${snapshot.reconnectsLastHour}. ` +
        `First audio: ${first.samples} reports; ${percentiles}. ` +
        'Unreported clients are not counted. Estimates, not unique people or proof of hearing.';
    } catch {
      if (!disposed && generation === current) clear('Listener telemetry unavailable or not the current public show.');
    } finally { if (generation === current) busy = false; }
  }
  button.addEventListener('click', () => {
    if (!session || session.expiresAt <= now() || !snapshot || now() < observedAt || now() - observedAt > 12_000) {
      clear('Telemetry is stale; wait for a fresh snapshot before exporting.'); return;
    }
    const text = JSON.stringify(snapshot, null, 2);
    try {
      if (download) download(text);
      else {
        const url = environment.URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        try {
          const link = doc.createElement('a'); link.href = url; link.download = 'listener-aggregates.json'; link.click();
        } finally { environment.URL.revokeObjectURL(url); }
      }
    } catch { status.textContent = 'Aggregate export failed; try again or check browser download settings.'; }
  });
  const timer = environment.setInterval(() => {
    if (snapshot && (now() < observedAt || now() - observedAt > 12_000)) clear('Telemetry is stale; waiting for a fresh snapshot.');
    void refresh();
  }, 5000);
  return {
    setSession(next) {
      generation++; busy = false; session = null;
      clear('Unavailable. Authorize the owner for the current public show.');
      if (next?.role !== 'owner' || next.state?.bookingId !== bookingId || !next.token ||
          !Number.isFinite(next.expiresAt) || next.expiresAt <= now()) return;
      session = next; void refresh();
    },
    refresh,
    dispose() { disposed = true; generation++; session = null; snapshot = null; environment.clearInterval(timer); container.replaceChildren(); },
  };
}

export function safeBindProducerListenerTelemetry(options) {
  try { return bindProducerListenerTelemetry(options); }
  catch {
    if (options?.container) options.container.textContent = 'Listener telemetry is unavailable. Production controls are unaffected.';
    return { setSession() {}, dispose() {} };
  }
}
