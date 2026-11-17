function mintPageId(cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.getRandomValues) return null;
  return Array.from(cryptoImpl.getRandomValues(new Uint8Array(18)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createPageListenerTelemetry({ serviceUrl, fetchImpl = (...args) => fetch(...args),
  environment = globalThis, now = Date.now, pageId = mintPageId() } = {}) {
  const sources = new Map();
  let token = '', bookingId = '', sequence = 0, queue = Promise.resolve(), disabled = false, first = false, startedAt = 0, pending = 0;
  let epoch = { failed: false }, timer;
  const endpoint = `${String(serviceUrl || '').replace(/\/$/, '')}/api/live-audio/telemetry`;
  function send(event, extra = {}) {
    if (!token || disabled) return;
    if (pending >= 8) { disabled = true; epoch.failed = true; stopTimer(); return; }
    pending++;
    const body = JSON.stringify({ token, bookingId, sequence: ++sequence, event, ...extra });
    const currentEpoch = epoch;
    queue = queue.then(async () => {
      if (currentEpoch.failed) return;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
            credentials: 'omit', cache: 'no-store', keepalive: event === 'leave', body,
            signal: globalThis.AbortSignal?.timeout?.(8000) });
          if (response.ok) return;
          if (response.status < 500) break;
        } catch { /* Retry the same sequence, never manufacture a replacement event. */ }
      }
      currentEpoch.failed = true;
      if (epoch === currentEpoch) { disabled = true; stopTimer(); }
    }).finally(() => { pending--; });
  }
  const active = () => [...sources.values()].some(Boolean);
  function startTimer() {
    if (timer != null || disabled) return;
    timer = environment.setInterval?.(() => { if (active()) send('heartbeat'); }, 15_000);
    timer?.unref?.();
  }
  function stopTimer() { if (timer != null) environment.clearInterval?.(timer); timer = null; }
  function leaveAll() {
    if (sources.size) send('leave');
    sources.clear();
    stopTimer();
  }
  environment.addEventListener?.('pagehide', leaveAll);
  return {
    pageId,
    grantPageId() { return pending && !sources.size ? null : pageId; },
    flush() { return queue; },
    join(source, grant, show, beganAt) {
      if (!pageId || !grant || !show) return;
      const hadActive = active(), hadSources = sources.size > 0, sameGrant = token === grant && bookingId === show;
      if (token !== grant || bookingId !== show) {
        if (hadActive) send('leave');
        sources.clear(); token = grant; bookingId = show; sequence = 0; disabled = false; first = false;
        epoch = { failed: false };
        startedAt = beganAt;
      }
      const alreadyActive = active();
      sources.set(source, true);
      startTimer();
      if (!alreadyActive) {
        if (sameGrant && hadSources && hadActive === false) send('reconnect', { reason: 'disconnected' });
        else send('connect');
      }
    },
    suspend(source) {
      if (sources.has(source)) sources.set(source, false);
      if (!active()) stopTimer();
    },
    resumed(source, reason = 'transport') {
      if (!sources.has(source)) return;
      const hadActive = active();
      sources.set(source, true);
      startTimer();
      if (!hadActive) send('reconnect', { reason });
    },
    audio(source) {
      if (!sources.get(source) || first) return;
      const duration = Math.round(now() - startedAt);
      if (duration < 0 || duration > 120_000) return;
      first = true; send('first-audio', { durationMs: duration });
    },
    leave(source) {
      const known = sources.delete(source);
      if (known && !sources.size) send('leave');
      if (!sources.size) { token = ''; bookingId = ''; stopTimer(); }
    },
    dispose() {
      leaveAll(); environment.removeEventListener?.('pagehide', leaveAll);
    },
  };
}

let pageTelemetry;
export function sharedPageListenerTelemetry(serviceUrl) {
  if (!pageTelemetry) {
    try { pageTelemetry = createPageListenerTelemetry({ serviceUrl }); }
    catch { pageTelemetry = {}; }
  }
  return pageTelemetry;
}
