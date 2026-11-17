function mintPageId(cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.getRandomValues) { warnTelemetryUnavailable(); return null; }
  return Array.from(cryptoImpl.getRandomValues(new Uint8Array(18)), byte => byte.toString(16).padStart(2, '0')).join('');
}

let lastWarning = -Infinity;
export function warnTelemetryUnavailable() {
  const time = Date.now();
  if (time < lastWarning || time - lastWarning >= 60_000) {
    lastWarning = time;
    try { globalThis.console?.warn?.('[listener-telemetry] Telemetry unavailable; audio is unaffected.'); }
    catch { /* An unavailable logging sink must not interrupt playback. */ }
  }
}

export function createPageListenerTelemetry({ serviceUrl, fetchImpl = (...args) => fetch(...args),
  environment = globalThis, now = Date.now, pageId = mintPageId() } = {}) {
  const sources = new Map();
  let queue = Promise.resolve(), pending = 0, timer, hidden = false, disposed = false;
  let epoch = { token: '', bookingId: '', sequence: 0, renewal: '', failed: false, first: false, startedAt: 0 };
  const endpoint = `${String(serviceUrl || '').replace(/\/$/, '')}/api/live-audio/telemetry`;
  const active = () => [...sources.values()].some(Boolean);
  function startTimer() {
    if (timer != null || hidden || disposed || epoch.failed &&
        (!epoch.renewal || now() >= Number(epoch.renewal.split('.')[0]))) return;
    timer = environment.setInterval?.(() => {
      try {
        if (!active()) return;
        if (epoch.failed) {
          if (now() >= Number(epoch.renewal.split('.')[0])) { stopTimer(); return; }
          if (epoch.renewal && !epoch.restoring && now() >= epoch.retryAt) enqueue('restore');
          return;
        }
        const expiry = Number(epoch.renewal.split('.')[0]);
        if (expiry && !epoch.restoring && now() >= expiry - 60_000 && now() - (epoch.lastRenewalAt || 0) >= 60_000) enqueue('restore');
        enqueue('heartbeat');
      } catch {
        stopTimer(); warnTelemetryUnavailable();
      }
    }, 15_000);
    timer?.unref?.();
  }
  function stopTimer() { if (timer != null) environment.clearInterval?.(timer); timer = null; }
  function failEpoch(current) {
    let time;
    try { time = now(); } catch { time = Date.now(); }
    current.failed = true; current.restoring = false; current.retryAt = time + 30_000;
    if (current === epoch) {
      stopTimer();
      if (active() && current.renewal) startTimer();
    }
    warnTelemetryUnavailable();
  }
  async function post(body, keepalive = false) {
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
          credentials: 'omit', cache: 'no-store', keepalive, body,
          signal: globalThis.AbortSignal?.timeout?.(8000) });
        if (response.ok || response.status < 500) return response;
      } catch { /* Retry the same event, never manufacture a replacement. */ }
    }
    return response;
  }
  async function renew(current) {
    if (!current.renewal || !pageId) return false;
    const response = await post(JSON.stringify({ event: 'renew', bookingId: current.bookingId,
      pageId, renewal: current.renewal }));
    if (!response?.ok) return false;
    let value;
    try { value = await response.json(); } catch { return false; }
    if (!value?.ok || !/^[A-Za-z0-9_-]{32}$/.test(value.token || '') ||
        !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
        !/^[0-9]{1,16}\.[A-Za-z0-9_-]{43}$/.test(value.renewal || '')) return false;
    current.token = value.token; current.sequence = value.sequence; current.renewal = value.renewal;
    current.lastRenewalAt = now();
    return true;
  }
  function enqueue(event, extra = {}) {
    const current = epoch;
    if ((!current.token && !(current.renewal && (event === 'restore' || current.restoring))) ||
        current.failed && event !== 'restore') return;
    if (pending >= 8) { failEpoch(current); return; }
    if (event === 'restore') current.restoring = true;
    pending++;
    queue = queue.then(async () => {
      if (event === 'restore') {
        if (await renew(current)) {
          current.failed = false; current.restoring = false;
          if (current === epoch && active()) startTimer();
          return;
        }
      } else if (!current.failed) {
        const eventBody = () => JSON.stringify({ token: current.token, bookingId: current.bookingId,
          sequence: current.sequence + 1, event, ...extra });
        let response = await post(eventBody(), event === 'leave');
        if (response?.status === 403 && event !== 'leave' && await renew(current)) {
          if (event === 'connect') return;
          response = await post(eventBody());
        }
        if (response?.ok) { current.sequence++; return; }
        if (event === 'leave' && response?.status === 403) return;
      } else return;
      failEpoch(current);
    }).catch(() => {
      failEpoch(current);
    }).finally(() => { pending--; });
  }
  function onPageHide() {
    if (hidden) return;
    hidden = true;
    if (sources.size) enqueue('leave');
    const current = epoch;
    queue = queue.then(() => { current.token = ''; current.sequence = 0; });
    stopTimer();
  }
  function onPageShow() {
    if (!hidden || disposed) return;
    hidden = false;
    if (active()) {
      if (epoch.renewal) enqueue('restore');
      else warnTelemetryUnavailable();
    }
  }
  environment.addEventListener?.('pagehide', onPageHide);
  environment.addEventListener?.('pageshow', onPageShow);
  return {
    pageId,
    grantPageId() { return pending && !sources.size ? null : pageId; },
    flush() { return queue; },
    join(source, grant, show, beganAt, renewal) {
      if (!pageId || !grant || !show) return;
      const hadActive = active(), hadSources = sources.size > 0;
      const sameGrant = epoch.token === grant && epoch.bookingId === show;
      if (!sameGrant) {
        if (hadActive && !hidden) enqueue('leave');
        sources.clear();
        epoch = { token: grant, bookingId: show, sequence: 0, renewal: renewal || '', failed: false,
          first: false, startedAt: beganAt };
      } else if (renewal) epoch.renewal = renewal;
      const alreadyActive = active();
      sources.set(source, true);
      if (!hidden) {
        startTimer();
        if (!alreadyActive) {
          if (sameGrant && hadSources && !hadActive) enqueue('reconnect', { reason: 'disconnected' });
          else enqueue('connect');
        }
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
      if (!hidden) {
        if (epoch.failed || !epoch.token) {
          if (!epoch.renewal) { warnTelemetryUnavailable(); return; }
          enqueue('restore');
          epoch.failed = false;
        }
        startTimer();
        if (!hadActive) enqueue('reconnect', { reason });
      }
    },
    audio(source) {
      if (hidden || !sources.get(source) || epoch.first) return;
      const duration = Math.round(now() - epoch.startedAt);
      if (duration < 0 || duration > 120_000) return;
      epoch.first = true; enqueue('first-audio', { durationMs: duration });
    },
    leave(source) {
      const known = sources.delete(source);
      if (known && !sources.size && !hidden) enqueue('leave');
      if (!sources.size) {
        epoch = { token: '', bookingId: '', sequence: 0, renewal: '', failed: false };
        stopTimer();
      }
    },
    dispose() {
      if (!hidden && sources.size) enqueue('leave');
      sources.clear(); disposed = true; stopTimer();
      environment.removeEventListener?.('pagehide', onPageHide);
      environment.removeEventListener?.('pageshow', onPageShow);
    },
  };
}

let pageTelemetry;
export function sharedPageListenerTelemetry(serviceUrl) {
  if (!pageTelemetry) {
    try { pageTelemetry = createPageListenerTelemetry({ serviceUrl }); }
    catch { warnTelemetryUnavailable(); pageTelemetry = {}; }
  }
  return pageTelemetry;
}
