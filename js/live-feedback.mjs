import { roomRequest } from './live-audio-client.mjs?v=20261114-allocated-stage';
import { activeFeedbackShow, FEEDBACK_ADVISORY, FEEDBACK_ROUTE, FEEDBACK_SIGNALS,
  FEEDBACK_SNAPSHOT_ACTION } from './live-feedback-protocol.mjs?v=20261115-listener-feedback';

const SIGNALS = Object.freeze({
  applause: { icon: '👏', label: 'Applause', action: 'Send applause' },
  love: { icon: '❤️', label: 'Love', action: 'Send love' },
  encore: { icon: '🔁', label: 'Encore', action: 'Request an encore' },
  'audio-problem': { icon: '⚠️', label: 'Can’t hear', action: 'Report an audio problem' },
});
const CONTROL_STALE_MS = 12_000;
const ROOM_POLL_MS = 3000;
const ROOM_STALE_MS = 9000;
const EVENT_MAX_AGE_MS = 10_000;
const MAX_SEEN = 512;
const TIP_NOTICE_AMOUNT_MAX_CHARS = 20;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const count = value => Number.isSafeInteger(value) && value >= 0;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function mintFeedbackClientId(cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.getRandomValues !== 'function') return null;
  return Array.from(cryptoImpl.getRandomValues(new Uint8Array(18)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createLiveFeedbackControl({ root, serviceUrl, fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(), clientId = mintFeedbackClientId(),
  timeoutSignal = ms => globalThis.AbortSignal?.timeout?.(ms) }) {
  const doc = root.ownerDocument || globalThis.document;
  const make = (tag, text, className) => {
    const node = doc.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const group = make('div', '', 'live-feedback-buttons');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Send an anonymous signal to the live performer');
  const buttons = new Map();
  for (const signal of FEEDBACK_SIGNALS) {
    const copy = SIGNALS[signal], button = make('button', '', 'live-feedback-button');
    button.type = 'button';
    button.dataset.signal = signal;
    button.setAttribute('aria-label', copy.action);
    const icon = make('span', copy.icon, 'live-feedback-icon');
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon, make('span', copy.label, 'live-feedback-label'));
    button.addEventListener('click', () => { void control.send(signal); });
    buttons.set(signal, button);
    group.append(button);
  }
  const status = make('p', '', 'live-feedback-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  root.replaceChildren(group, status);
  root.hidden = true;
  const endpoint = `${String(serviceUrl || '').replace(/\/$/, '')}${FEEDBACK_ROUTE}`;
  let live = null, observedAt = null, serverTime = 0, mode = 'radio', busy = false;
  let connected = false, showUnavailable = false;
  let generation = 0, lockedUntil = 0, message = '', messageUntil = 0;

  function reset() {
    generation++;
    busy = false;
    lockedUntil = messageUntil = 0;
    message = '';
  }
  function fresh() {
    const elapsed = observedAt === null ? Infinity : now() - observedAt;
    return connected && !!live && elapsed >= 0 && elapsed <= CONTROL_STALE_MS && serverTime + elapsed < live.endsAt;
  }
  function render() {
    const elapsed = observedAt === null ? Infinity : now() - observedAt;
    if (mode === 'archive' || !live && !showUnavailable ||
        live && Number.isFinite(elapsed) && serverTime + elapsed >= live.endsAt) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    const available = fresh() && !!clientId && !busy && now() >= lockedUntil;
    for (const button of buttons.values()) button.disabled = !available;
    const text = !clientId ? 'Anonymous signals are unavailable in this browser.'
      : !fresh() ? 'Listener signals are disconnected or out of date; waiting to reconnect.'
        : busy ? 'Sending your signal…'
          : now() < messageUntil ? message
            : 'Anonymous and advisory only. Encore requests do not extend the set.';
    if (status.textContent !== text) status.textContent = text;
  }
  const control = {
    update(state, { unavailable = false } = {}) {
      const next = activeFeedbackShow(state);
      if (unavailable || state?.phase === 'live' && !next) {
        connected = false;
        showUnavailable = !!live || state?.phase === 'live';
        reset();
        render();
        return;
      }
      if (!next || next.lifecycle !== live?.lifecycle) reset();
      live = next;
      connected = !!next;
      showUnavailable = false;
      observedAt = next ? now() : null;
      serverTime = next ? state.serverTime : 0;
      render();
    },
    setMode(next) { if (next === 'archive' && mode !== next) reset(); mode = next; render(); },
    async send(signal) {
      if (!FEEDBACK_SIGNALS.includes(signal) || !fresh() || !clientId || busy || now() < lockedUntil || mode === 'archive') {
        return 'ignored';
      }
      const current = generation, bookingId = live.bookingId;
      busy = true;
      render();
      let outcome = 'error', retryMs = 0;
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit', cache: 'no-store',
          body: JSON.stringify({ signal, bookingId, clientId }), signal: timeoutSignal(8000),
        });
        let body;
        try { body = await response.json(); } catch { body = null; }
        if (response.ok && body?.ok === true && body.signal === signal && body.bookingId === bookingId) {
          outcome = 'sent';
          retryMs = Number.isFinite(body.nextAllowedInMs) ? clamp(body.nextAllowedInMs, 0, 10_000) : 2000;
        } else if (response.status === 429) {
          outcome = 'limited';
          const header = Number(response.headers?.get?.('retry-after'));
          retryMs = clamp(Number.isFinite(body?.retryAfterMs) && body.retryAfterMs > 0 ? body.retryAfterMs
            : Number.isFinite(header) && header > 0 ? header * 1000 : 5000, 1000, 120_000);
        } else if (response.status === 409 || response.status === 404) outcome = 'changed';
        else if (response.status === 503) outcome = 'unavailable';
      } catch { outcome = 'error'; }
      if (current !== generation) return 'ignored';
      busy = false;
      lockedUntil = now() + (retryMs || 1500);
      messageUntil = now() + Math.max(4000, retryMs);
      message = outcome === 'sent' ? 'Signal accepted for the stage. Delivery depends on its connection.'
        : outcome === 'limited' ? 'Too many signals. Please wait before trying again.'
          : outcome === 'changed' ? 'The live set ended or changed. Refresh before sending again.'
            : outcome === 'unavailable' ? 'Listener signals are unavailable. Try again shortly.'
              : 'Your signal could not be sent. Try again.';
      render();
      return outcome;
    },
    tick: render,
    dispose() { reset(); live = null; root.hidden = true; root.replaceChildren(); },
  };
  return control;
}

export function mountLiveFeedback({ root = globalThis.document?.getElementById('live-feedback'),
  serviceUrl = globalThis.DecentConfig?.ipfsUploadServiceUrl, eventTarget = globalThis.document,
  environment = globalThis, fetchImpl, now, clientId } = {}) {
  if (!root || !serviceUrl || typeof eventTarget?.addEventListener !== 'function') {
    console.warn('[live-feedback] Listener controls could not be mounted.');
    return null;
  }
  const control = createLiveFeedbackControl({ root, serviceUrl, fetchImpl, now, clientId });
  const onState = event => {
    const state = event.detail;
    const unavailable = !state || state.mainRadioAdCountdown?.reason === 'disconnected' ||
      state.liveAudio?.phase === 'unavailable' || state.liveAudio?.configured === false;
    control.update(state?.liveAudio, { unavailable });
  };
  const onMode = event => control.setMode(event.detail);
  eventTarget.addEventListener('dbusk-radio-state', onState);
  eventTarget.addEventListener('radio-source-mode-change', onMode);
  const timer = environment.setInterval(() => control.tick(), 1000);
  return {
    control,
    dispose() {
      eventTarget.removeEventListener('dbusk-radio-state', onState);
      eventTarget.removeEventListener('radio-source-mode-change', onMode);
      environment.clearInterval(timer);
      control.dispose();
    },
  };
}

function validWindow(value, seconds) {
  return value?.seconds === seconds && FEEDBACK_SIGNALS.every(signal =>
    count(value.counts?.[signal]) && count(value.browsers?.[signal])) &&
    ['client', 'source', 'global'].every(scope => count(value.limited?.[scope]));
}

function validSnapshot(state, bookingId) {
  if (!state || state.schemaVersion !== 1 || state.bookingId !== bookingId ||
      !Number.isFinite(state.serverTime) || typeof state.active !== 'boolean') return false;
  if (!state.active) return true;
  if (typeof state.epoch !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(state.epoch) ||
      !Number.isFinite(state.endsAt) || state.endsAt <= state.serverTime ||
      !validWindow(state.windows?.short, 30) || !validWindow(state.windows?.long, 120) ||
      !['any', ...FEEDBACK_SIGNALS].every(key => state.lastReceivedAt?.[key] === null ||
        Number.isFinite(state.lastReceivedAt?.[key]) && state.lastReceivedAt[key] <= state.serverTime) ||
      !Array.isArray(state.events) || state.events.length > 120 ||
      !state.events.every(event => typeof event.id === 'string' && /^[A-Za-z0-9_-]{1,32}:[1-9][0-9]*$/.test(event.id) &&
        ['applause', 'love', 'encore'].includes(event.signal) && Number.isFinite(event.at) && event.at <= state.serverTime) ||
      typeof state.tips?.available !== 'boolean') return false;
  if (!state.tips.available) return true;
  return typeof state.tips.complete === 'boolean' && count(state.tips.count) && UINT.test(state.tips.totalWei || '') &&
    Array.isArray(state.tips.entries) && state.tips.entries.length <= 20 &&
    state.tips.entries.every(entry => typeof entry.id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(entry.id) &&
      UINT.test(entry.amountWei || '') && entry.amountWei !== '0' && Number.isFinite(entry.paidAt) &&
      entry.paidAt <= state.serverTime);
}

export function createLiveFeedbackReader({ serviceUrl, bookingId, request = roomRequest,
  now = () => Date.now(), onChange = () => {} }) {
  let session = null, snapshot = null, observedAt = null, generation = 0, polling = false, lastPoll = 0;
  let message = '', epoch = '', baseline = false, tipsBaseline = false, listeningSince = 0;
  const seenEvents = new Set(), seenTips = new Set();
  const remember = (set, id) => {
    set.add(id);
    if (set.size > MAX_SEEN) set.delete(set.values().next().value);
  };
  const fresh = () => {
    const elapsed = observedAt === null ? Infinity : now() - observedAt;
    return !!snapshot && elapsed >= 0 && elapsed <= ROOM_STALE_MS &&
      (!snapshot.active || snapshot.serverTime + elapsed < snapshot.endsAt);
  };
  const emit = (notices = []) => onChange({ session: !!session, snapshot, fresh: fresh(), polling, message, notices });
  function clear(reason = '') {
    generation++;
    session = snapshot = null;
    observedAt = null;
    polling = false;
    lastPoll = 0;
    message = reason;
    epoch = '';
    listeningSince = 0;
    baseline = tipsBaseline = false;
    seenEvents.clear();
    seenTips.clear();
    emit();
  }
  async function refresh() {
    if (!session || polling) return;
    if (!Number.isFinite(session.expiresAt) || session.expiresAt <= now()) {
      clear('Your private pass expired. Reconnect your booking wallet.');
      return;
    }
    polling = true;
    lastPoll = now();
    const current = generation, authorization = session;
    try {
      const state = await request(serviceUrl, 'control', { action: FEEDBACK_SNAPSHOT_ACTION }, authorization.token);
      if (current !== generation || session !== authorization) return;
      if (!validSnapshot(state, bookingId)) throw new Error('Invalid booking-scoped feedback snapshot');
      const notices = [];
      if (state.active) {
        if (epoch !== state.epoch) {
          epoch = state.epoch;
          baseline = tipsBaseline = false;
          listeningSince = state.serverTime;
          seenEvents.clear();
          seenTips.clear();
        }
        const hadBaseline = baseline;
        for (const event of state.events) {
          if (hadBaseline && !seenEvents.has(event.id) && state.serverTime - event.at < EVENT_MAX_AGE_MS) {
            notices.push({ kind: event.signal });
          }
          remember(seenEvents, event.id);
        }
        baseline = true;
        if (state.tips.available) {
          for (const tip of state.tips.entries) {
            if (!seenTips.has(tip.id) && (tipsBaseline || hadBaseline && tip.paidAt >= listeningSince)) {
              notices.push({ kind: 'tip', amountWei: tip.amountWei });
            }
            remember(seenTips, tip.id);
          }
          tipsBaseline = true;
        }
      } else {
        epoch = '';
        listeningSince = 0;
        baseline = tipsBaseline = false;
        seenEvents.clear();
        seenTips.clear();
      }
      snapshot = state;
      observedAt = now();
      message = '';
      polling = false;
      emit(notices);
    } catch (error) {
      if (current !== generation) return;
      if ([401, 403].includes(error?.status)) {
        clear('Your private pass ended. Reconnect your booking wallet.');
        return;
      }
      snapshot = null;
      observedAt = null;
      message = 'Listener feedback is unavailable; reconnecting. Audio controls are unaffected.';
      polling = false;
      emit();
    }
  }
  return {
    setSession(next) {
      if (next === session) return;
      clear();
      if (!next) return;
      if (next.state?.bookingId !== bookingId || !Number.isFinite(next.expiresAt) || next.expiresAt <= now()) {
        clear('This private pass is expired or belongs to another booking.');
        return;
      }
      session = next;
      emit();
      void refresh();
    },
    refresh,
    tick() {
      if (session && session.expiresAt <= now()) { clear('Your private pass expired. Reconnect your booking wallet.'); return; }
      emit();
      if (session && !polling && now() - lastPoll >= ROOM_POLL_MS) void refresh();
    },
    dispose: () => clear(),
  };
}

export function formatFeedbackWei(value) {
  if (!UINT.test(value || '')) throw new Error('Invalid confirmed tip amount');
  const amount = BigInt(value), whole = amount / 10n ** 18n;
  const fraction = (amount % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}

function createLiveFeedbackRoom({ container, stageContainer = null, serviceUrl, bookingId, performer = false,
  environment = globalThis, request = roomRequest, now = () => Date.now() }) {
  const doc = container.ownerDocument || globalThis.document;
  const make = (tag, text, className) => {
    const node = doc.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  container.replaceChildren();
  container.classList.add('live-feedback-panel');
  const heading = make('h3', 'Audience feedback');
  const advisory = make('p', FEEDBACK_ADVISORY, 'feedback-advisory');
  const status = make('p', '', 'feedback-state');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const alert = make('p', '', 'feedback-alert');
  alert.setAttribute('role', 'status');
  alert.setAttribute('aria-live', 'polite');
  const stage = make('div', '', 'feedback-stage');
  stage.setAttribute('aria-hidden', 'true');
  const toggleLabel = make('label', '', 'feedback-toggle');
  const toggle = make('input');
  toggle.type = 'checkbox';
  toggle.checked = true;
  toggleLabel.append(toggle, doc.createTextNode(' Show floating reactions and tip notices'));
  toggleLabel.hidden = !performer;
  stage.hidden = !performer;
  const table = make('table', '', 'feedback-table');
  table.setAttribute('aria-label', 'Anonymous listener signal counts');
  const header = make('tr');
  for (const title of ['Signal', 'Last 30 s', 'Last 2 min']) {
    const cell = make('th', title);
    cell.setAttribute('scope', 'col');
    header.append(cell);
  }
  const thead = make('thead');
  thead.append(header);
  const tbody = make('tbody'), rows = new Map();
  for (const signal of FEEDBACK_SIGNALS) {
    const row = make('tr'), label = make('th', SIGNALS[signal].label);
    label.setAttribute('scope', 'row');
    const short = make('td'), long = make('td');
    row.append(label, short, long);
    tbody.append(row);
    rows.set(signal, { short, long });
  }
  table.append(thead, tbody);
  const tips = make('p', '', 'feedback-tips');
  tips.setAttribute('role', 'status');
  tips.setAttribute('aria-live', 'polite');
  const last = make('p', '', 'feedback-last');
  const limited = make('p', '', 'feedback-limited');
  container.append(heading, advisory, status);
  if (performer && stageContainer) {
    stageContainer.hidden = true;
    stageContainer.replaceChildren(toggleLabel, stage);
  } else container.append(toggleLabel, stage);
  container.append(alert, table, tips, last, limited);
  const timers = new Map();
  function clearStage() {
    for (const timer of timers.values()) environment.clearTimeout(timer);
    timers.clear();
    stage.replaceChildren();
  }
  function showNotice(notice) {
    if (!performer || !toggle.checked) return;
    while (timers.size >= 4) {
      const oldest = timers.keys().next().value;
      environment.clearTimeout(timers.get(oldest));
      timers.delete(oldest);
      oldest.remove();
    }
    const tip = notice.kind === 'tip';
    const amount = tip ? formatFeedbackWei(notice.amountWei) : '';
    const text = tip
      ? (amount.length <= TIP_NOTICE_AMOUNT_MAX_CHARS ? `Tip · ${amount} ETH` : 'Tip received')
      : SIGNALS[notice.kind]?.icon;
    if (!text) return;
    const bubble = make('span', text, `feedback-bubble${tip ? ' feedback-bubble-tip' : ''}`);
    if (tip) stage.prepend(bubble);
    else stage.append(bubble);
    if (tip && (bubble.scrollWidth > bubble.clientWidth || bubble.scrollHeight > bubble.clientHeight)) {
      bubble.textContent = 'Tip received';
    }
    timers.set(bubble, environment.setTimeout(() => { timers.delete(bubble); bubble.remove(); }, 4000));
  }
  toggle.addEventListener('change', () => { if (!toggle.checked) clearStage(); });
  const write = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  const reader = createLiveFeedbackReader({
    serviceUrl, bookingId, request, now,
    onChange(view) {
      const snap = view.snapshot, active = view.session && view.fresh && snap?.active === true;
      if (stageContainer && performer) stageContainer.hidden = !active;
      const text = !view.session ? view.message || 'Connect your booking wallet to see audience feedback.'
        : view.message ? view.message
          : !snap ? 'Connecting to audience feedback…'
            : !view.fresh ? 'Audience feedback is out of date; reconnecting. Audio controls are unaffected.'
              : !snap.active ? 'No live feedback is available for this booking right now.'
                : 'Anonymous signals received for this live set.';
      write(status, text);
      table.hidden = !active;
      if (!active) {
        clearStage();
        write(alert, '');
        write(tips, '');
        write(last, '');
        write(limited, '');
        return;
      }
      for (const [signal, cells] of rows) {
        const short = snap.windows.short, long = snap.windows.long;
        const describe = window => `${window.counts[signal]} (${window.browsers[signal]} ${window.browsers[signal] === 1 ? 'browser' : 'browsers'})`;
        write(cells.short, describe(short));
        write(cells.long, describe(long));
      }
      const shortProblems = snap.windows.short.counts['audio-problem'];
      const longProblems = snap.windows.long.counts['audio-problem'];
      write(alert, shortProblems ? `${shortProblems} audio-problem report${shortProblems === 1 ? '' : 's'} in 30 seconds. Check the public audio.`
        : longProblems ? `${longProblems} audio-problem report${longProblems === 1 ? '' : 's'} in the last 2 minutes. Check the public audio.`
          : 'No recent audio-problem reports. This does not prove listeners can hear.');
      alert.dataset.level = shortProblems ? 'recent' : longProblems ? 'earlier' : 'none';
      const latestTip = snap.tips.available ? snap.tips.entries.at(-1) : null;
      write(tips, !snap.tips.available ? 'Verified tip updates are unavailable; unverified payments are not shown as paid.'
        : `Verified tips${snap.tips.complete ? '' : ' so far'}: ${formatFeedbackWei(snap.tips.totalWei)} ETH · ${snap.tips.count} confirmed.${latestTip ? ` Latest confirmed tip: ${formatFeedbackWei(latestTip.amountWei)} ETH.` : ''}`);
      const recent = snap.lastReceivedAt.any;
      write(last, recent === null ? 'No listener signals received yet.'
        : `Last listener signal received ${Math.max(0, Math.floor((snap.serverTime - recent) / 1000))} seconds ago.`);
      const held = snap.windows.long.limited;
      const total = held.client + held.source + held.global;
      write(limited, total ? `Some signals were rate-limited in roughly the last 2 minutes (${total}).` : '');
      for (const notice of view.notices) showNotice(notice);
    },
  });
  reader.tick();
  const timer = environment.setInterval(() => reader.tick(), 1000);
  return {
    setSession: value => reader.setSession(value),
    dispose() {
      environment.clearInterval(timer);
      reader.dispose();
      clearStage();
      container.replaceChildren();
      if (stageContainer && performer) { stageContainer.hidden = true; stageContainer.replaceChildren(); }
    },
  };
}

export function bindLiveFeedbackRoom(options) {
  try { return createLiveFeedbackRoom(options); }
  catch (error) {
    console.warn('[live-feedback] Audience panel unavailable:', error?.name || 'Error');
    if (options?.container) options.container.textContent = 'Audience feedback is unavailable. Audio controls are unaffected.';
    return { setSession() {}, dispose() {} };
  }
}

export function bindTogether(primary, secondary) {
  const safely = (method, value) => {
    try { secondary[method](value); }
    catch (error) { console.warn('[live-feedback] Audience panel unavailable:', error?.name || 'Error'); }
  };
  return {
    setSession(value) { primary.setSession(value); safely('setSession', value); },
    dispose() { primary.dispose(); safely('dispose'); },
  };
}
