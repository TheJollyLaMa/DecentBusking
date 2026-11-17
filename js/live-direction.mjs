import { roomRequest } from './live-audio-client.mjs?v=20261117-lease-recovery';

const FRESH_MS = 12000;
const actionCapability = {
  cue: 'cue', 'acknowledge-cue': 'acknowledgeCue', readiness: 'setReadiness',
  finished: 'declareFinished', 'notify-delay': 'notifyDelay',
  'acknowledge-delay': 'acknowledgeDelay', message: 'message',
};
const expired = (value, time) => !Number.isFinite(value) || value <= time;

export function createLiveDirection({ serviceUrl, bookingId, onChange = () => {}, onSessionExpired = () => {},
  request = roomRequest, now = () => Date.now(), uuid = () => crypto.randomUUID() }) {
  let session, snapshot, observedAt = 0, generation = 0, polling = false, pending = false;
  let lastPoll = 0, lastHeartbeat = 0, message = '', error = false, uncertain = null, messages = [];
  let heartbeatPending = false;
  const serverNow = () => snapshot ? snapshot.serverTime + Math.max(0, now() - observedAt) : now();
  const fresh = () => !!snapshot && observedAt > 0 && now() >= observedAt && now() - observedAt <= FRESH_MS;
  function emit() {
    const time = serverNow();
    const retention = snapshot?.chat?.retentionMs;
    if (Number.isFinite(retention)) messages = messages.filter(item => item.sentAt + retention > time);
    onChange({ session: !!session, snapshot, messages: [...messages], fresh: fresh(), pending, message, error,
      canRetry: !!uncertain && uncertain.epoch === snapshot?.epoch && fresh(), serverTime: time });
  }
  function clear(reason = '') {
    ++generation;
    session = null;
    snapshot = null;
    messages = [];
    observedAt = 0;
    polling = pending = heartbeatPending = false;
    uncertain = null;
    message = reason;
    error = !!reason;
    emit();
  }
  function revoke(reason) {
    clear(reason);
    onSessionExpired(reason);
  }
  function apply(state) {
    if (state?.schemaVersion !== 1 || state.bookingId !== bookingId || typeof state.epoch !== 'string' ||
        !Number.isFinite(state.serverTime) || !Number.isSafeInteger(state.revision)) {
      throw new Error('Direction response is unavailable or does not match this booking.');
    }
    if (snapshot && state.epoch !== snapshot.epoch) {
      revoke('Session reset after a service restart. Private messages and cues were cleared. Reconnect and confirm readiness again.');
      return false;
    }
    if (snapshot && state.revision < snapshot.revision) return false;
    if (snapshot && state.serverTime < snapshot.serverTime) return false;
    if (state.resetRequired) messages = [];
    const byId = new Map(messages.map(item => [item.id, item]));
    for (const item of state.messages || []) {
      if (typeof item.id === 'string' && typeof item.text === 'string' &&
          ['owner', 'performer'].includes(item.senderRole) && Number.isFinite(item.sentAt)) byId.set(item.id, item);
    }
    messages = [...byId.values()].sort((a, b) => a.sentAt - b.sentAt)
      .slice(-Math.max(1, Math.min(100, state.chat?.maxMessages || 100)));
    if (snapshot?.cursor?.sequence > state.cursor?.sequence) state = { ...state, cursor: snapshot.cursor };
    snapshot = state;
    observedAt = now();
    emit();
    return true;
  }
  function failure(cause) {
    if ([401, 403].includes(cause.status)) {
      revoke('Private session ended or access changed. Reconnect your booking wallet. Unsent content is not saved.');
      return;
    }
    message = cause.status === 409 ? 'Direction changed. Refresh and review before trying again; nothing was automatically resent.'
      : cause.status === 429 ? 'Too many requests. Wait, then refresh or retry the same action.'
        : `${cause.message || 'Direction unavailable'}. Audio controls are unaffected.`;
    error = true;
    emit();
  }
  async function refresh() {
    if (!session || polling || pending) return;
    if (expired(session.expiresAt, now())) { revoke('Private session expired. Reconnect your booking wallet.'); return; }
    polling = true;
    lastPoll = now();
    const current = generation, authorization = session;
    try {
      const state = await request(serviceUrl, 'control', {
        action: 'direction-state', ...(snapshot?.cursor ? { cursor: snapshot.cursor } : {}),
      }, authorization.token);
      if (current === generation && session === authorization) apply(state);
    } catch (cause) { if (current === generation) failure(cause); }
    finally { if (current === generation) { polling = false; emit(); } }
  }
  async function execute(input) {
    if (!session || pending || !fresh()) throw new Error('Refresh the private room before sending direction.');
    const current = generation, authorization = session;
    pending = true;
    message = 'Sending… Awaiting server confirmation.';
    error = false;
    emit();
    try {
      const result = await request(serviceUrl, 'control', input, authorization.token);
      if (current !== generation || session !== authorization) return false;
      if (result.commandId !== input.commandId || typeof result.applied !== 'boolean') {
        throw new Error('Direction confirmation did not match the submitted action');
      }
      apply(result.state);
      if (current !== generation || session !== authorization) return false;
      uncertain = null;
      message = 'Confirmed for this live session only.';
      error = false;
      return true;
    } catch (cause) {
      if (current !== generation) return false;
      uncertain = !cause.status || cause.status >= 500 || cause.status === 429 ? input : null;
      failure(cause);
      return false;
    } finally { if (current === generation) { pending = false; emit(); } }
  }
  async function heartbeat() {
    if (!session || heartbeatPending || !fresh() || !snapshot.capabilities?.setReadiness) return;
    heartbeatPending = true;
    lastHeartbeat = now();
    const current = generation, authorization = session;
    try {
      const result = await request(serviceUrl, 'control', { action: 'direction-heartbeat', epoch: snapshot.epoch }, authorization.token);
      if (current === generation && session === authorization) apply(result.state);
    } catch (cause) { if (current === generation) failure(cause); }
    finally { if (current === generation) heartbeatPending = false; }
  }
  return {
    setSession(next) {
      if (next === session) return;
      clear();
      if (!next) return;
      if (next.state?.bookingId !== bookingId || expired(next.expiresAt, now())) {
        revoke('This pass is expired or belongs to another booking.');
        return;
      }
      session = next;
      lastPoll = lastHeartbeat = 0;
      emit();
      void refresh();
    },
    refresh,
    async send(action, fields = {}) {
      if (!session || !fresh() || !snapshot.capabilities?.[actionCapability[action]]) {
        throw new Error('This action is unavailable for your current booking pass.');
      }
      if (uncertain) throw new Error('A previous action has an unknown outcome. Retry that same action or dismiss its retry first.');
      return execute({ ...fields, action: `direction-${action}`, epoch: snapshot.epoch, commandId: uuid(),
        ...(action === 'message' ? {} : { expectedRevision: snapshot.revision }) });
    },
    retry() {
      if (!uncertain || uncertain.epoch !== snapshot?.epoch) throw new Error('This action cannot be retried after a session reset.');
      return execute(uncertain);
    },
    dismissRetry() { uncertain = null; message = 'Retry dismissed. Check current state before sending a new action.'; emit(); },
    report(text, isError = true) { message = text; error = isError; emit(); },
    tick() {
      if (session && (expired(session.expiresAt, now()) ||
          snapshot?.chat?.expiresAt && expired(snapshot.chat.expiresAt, serverNow()))) {
        revoke('This live session has ended. Private messages and controls were cleared.');
        return;
      }
      emit();
      if (!session) return;
      const pollMs = Math.max(3000, snapshot?.limits?.pollIntervalMs || 3000);
      if (now() - lastPoll >= pollMs) void refresh();
      if (now() - lastHeartbeat >= Math.max(15000, snapshot?.limits?.heartbeatIntervalMs || 15000)) void heartbeat();
    },
    dispose() { clear(); },
  };
}

export function bindLiveDirection({ container, serviceUrl, bookingId, onSessionExpired, onReconnect, onState = () => {},
  environment = globalThis, request = roomRequest, now = () => Date.now() }) {
  const doc = container.ownerDocument || document;
  const make = (tag, text, className) => {
    const node = doc.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  container.replaceChildren();
  container.classList.add('live-direction');
  const heading = make('h3', 'Private production direction');
  const status = make('output');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const freshness = make('p', '', 'studio-note');
  const retention = make('p', 'Live-session messages only. Not saved in this browser; server restart, expiry or booking end clears the thread.', 'direction-retention');
  const rules = make('p', 'Cues and standby notices do not authorize extra airtime or move a signed start. Read the separate allocated-stage controls for actual authorized timing; this advisory panel never changes it. Producer delay, readiness choices and choosing not to play do not forfeit the original guaranteed fee.', 'studio-note');
  const content = make('div');
  const delivery = make('p');
  const cue = make('p', '', 'direction-cue');
  const delay = make('p', '', 'direction-delay');
  for (const notice of [cue, delay]) {
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
  }
  const ready = make('p');
  const finished = make('p');
  const ownerActions = make('div', '', 'room-action-row');
  const artistActions = make('div', '', 'room-action-row');
  const controls = [];
  let view, lastMessages = '', client;
  const action = (parent, label, capability, name, fields) => {
    const button = make('button', label);
    button.type = 'button';
    button.addEventListener('click', async () => {
      try {
        if (name === 'finished' && !environment.confirm('Send an advisory finished note? This does not stop the microphone or radio. An allocated set needs its separate durable finished declaration before a normal producer ending.')) return;
        await client.send(name, typeof fields === 'function' ? fields() : fields);
      } catch (cause) { client.report(cause.message); }
    });
    parent.append(button);
    controls.push({ button, capability, name });
    return button;
  };
  action(ownerActions, 'Cue: another song', 'cue', 'cue', { kind: 'another-song' });
  action(ownerActions, 'Cue: wrap up after this song', 'cue', 'cue', { kind: 'wrap-up' });
  action(ownerActions, 'Notify possible delay', 'notifyDelay', 'notify-delay', { status: 'possible-delay' });
  action(ownerActions, 'Tell performer to stand by', 'notifyDelay', 'notify-delay', { status: 'stand-by' });
  action(ownerActions, 'Clear standby notice', 'notifyDelay', 'notify-delay', { status: 'clear' });
  action(artistActions, 'Acknowledge cue', 'acknowledgeCue', 'acknowledge-cue', () => ({ cueId: view.snapshot.cue.id }));
  action(artistActions, 'Ready backstage', 'setReadiness', 'readiness', { ready: true });
  action(artistActions, 'Not ready / need help', 'setReadiness', 'readiness', { ready: false });
  const notPlaying = make('button', 'Not playing this slot — notify owner');
  notPlaying.type = 'button';
  notPlaying.addEventListener('click', async () => {
    if (!environment.confirm('Notify the owner that you are not playing this slot? This marks you not ready and sends a private notice. It does not cancel your guaranteed fee.')) return;
    try {
      if (await client.send('readiness', { ready: false })) {
        await client.send('message', { text: 'I am not playing this slot. Please contact me. This notice does not waive my original guaranteed fee.' });
      }
    } catch (cause) { client.report(cause.message); }
  });
  artistActions.append(notPlaying);
  action(artistActions, 'Send advisory finished note', 'declareFinished', 'finished');
  action(artistActions, 'Seen standby notice', 'acknowledgeDelay', 'acknowledge-delay', () => ({ noticeId: view.snapshot.delay.id }));
  const thread = make('ol');
  thread.setAttribute('aria-label', 'Private messages for this booking');
  const messageNotice = make('p');
  messageNotice.setAttribute('role', 'status');
  messageNotice.setAttribute('aria-live', 'polite');
  const label = make('label', 'Message to the other person in this booking');
  const input = make('textarea');
  input.rows = 3;
  input.setAttribute('aria-label', 'Private booking message');
  label.append(input);
  const send = make('button', 'Send private message');
  send.type = 'button';
  send.addEventListener('click', async () => {
    const text = input.value.trim();
    if (!text) { client.report('Enter a message first.'); return; }
    try { if (await client.send('message', { text })) input.value = ''; }
    catch (cause) { client.report(cause.message); }
  });
  const retry = make('button', 'Retry same action');
  retry.type = 'button';
  retry.addEventListener('click', async () => {
    try { await client.retry(); } catch (cause) { client.report(cause.message); }
  });
  const dismiss = make('button', 'Dismiss retry');
  dismiss.type = 'button';
  dismiss.addEventListener('click', () => client.dismissRetry());
  const refresh = make('button', 'Refresh private direction');
  refresh.type = 'button';
  refresh.addEventListener('click', () => { void client.refresh(); });
  const reconnect = make('button', 'Reconnect private direction');
  reconnect.type = 'button';
  reconnect.hidden = !onReconnect;
  reconnect.addEventListener('click', async () => {
    reconnect.disabled = true;
    client.report('Confirm the booking-wallet signature. Your microphone is unaffected.', false);
    try { client.setSession(await onReconnect()); }
    catch (cause) { client.report(cause.message); }
    finally { reconnect.disabled = false; }
  });
  const time = value => Number.isFinite(value) ? new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'time unavailable';
  content.append(delivery, cue, delay, ready, finished, ownerActions, artistActions,
    make('h4', 'Booking-private messages'), messageNotice, thread, label, send);
  container.append(heading, status, freshness, retention, rules, content, retry, dismiss, refresh, reconnect);
  client = createLiveDirection({
    serviceUrl, bookingId, request, now, onSessionExpired,
    onChange(next) {
      view = next;
      const state = next.snapshot, caps = state?.capabilities || {}, currentTime = next.serverTime;
      content.hidden = !next.session || !state;
      refresh.disabled = !next.session || next.pending;
      status.textContent = next.message || (!next.session ? 'Connect your booking wallet to open private direction.'
        : !state ? 'Checking private direction availability…' : 'Connected to this booking’s private thread.');
      status.dataset.error = String(next.error);
      freshness.textContent = !state ? 'Direction and performer presence are not yet verified.'
        : next.fresh ? `Last verified ${time(state.serverTime)} · direction is separate from audio delivery.`
          : 'Direction is stale / disconnected. Last reports below are not current; sending is disabled. Audio controls are unaffected.';
      retry.hidden = dismiss.hidden = !next.canRetry;
      retry.disabled = next.pending;
      dismiss.disabled = next.pending;
      if (!next.session) {
        input.value = '';
        thread.replaceChildren();
        messageNotice.textContent = '';
        lastMessages = '';
      }
      if (!state) {
        for (const node of [delivery, cue, delay, ready, finished]) node.textContent = '';
        retention.textContent = 'Live-session messages only. Not saved in this browser; server restart, expiry or booking end clears the thread.';
        onState(null);
        return;
      }
      const max = state.chat?.maxTextLength;
      notPlaying.hidden = !caps.setReadiness || !caps.message;
      notPlaying.disabled = !next.fresh || next.pending || !caps.setReadiness || !caps.message;
      input.disabled = send.disabled = !next.fresh || next.pending || !caps.message;
      if (Number.isSafeInteger(max) && max > 0) input.maxLength = max;
      const minutes = Number.isFinite(state.chat?.retentionMs) ? Math.round(state.chat.retentionMs / 60000) : null;
      retention.textContent = `Live-session only · ${minutes === null ? 'retention unavailable' : `messages expire after ${minutes} minutes`}${state.chat?.maxMessages ? `, at most ${state.chat.maxMessages} retained` : ''}. Server restart, expiry or booking end clears messages and cues. No offline delivery or saved history.`;
      const presence = state.performerPresence;
      const present = next.fresh && presence && !expired(presence.expiresAt, currentTime);
      delivery.textContent = present ? 'Performer room recently checked in (not proof of audio delivery).'
        : 'Performer presence unavailable / offline. The room may be closed or disconnected.';
      const cueActive = state.cue && !expired(state.cue.expiresAt, currentTime);
      cue.textContent = !state.cue ? 'No production cue.'
        : `${state.cue.kind === 'another-song' ? 'Another song' : 'Wrap up after this song'} · ${time(state.cue.sentAt)} · ${
          state.cue.acknowledgedAt ? `acknowledged ${time(state.cue.acknowledgedAt)}`
            : cueActive ? 'awaiting performer acknowledgment' : 'expired; do not act on this cue'}`;
      const delayActive = state.delay && !expired(state.delay.expiresAt, currentTime);
      delay.textContent = !state.delay ? 'No standby notice.'
        : `${state.delay.status === 'clear' ? 'Standby notice cleared' : state.delay.status === 'possible-delay'
          ? 'Possible delay — owner is coordinating the previous act' : 'Stand by — remain ready for the owner'} · ${
          state.delay.acknowledgedAt ? `seen ${time(state.delay.acknowledgedAt)}` : delayActive ? 'not yet acknowledged' : 'expired'}. No revised start time has been set. Seeing this notice is optional, not consent or a commitment to play; your guaranteed fee is unchanged.`;
      const readiness = state.readiness;
      const readyFresh = next.fresh && readiness && !expired(readiness.expiresAt, currentTime) && present;
      ready.textContent = readiness?.ready === true ? `${readyFresh ? 'Ready backstage' : 'Last reported ready; confirmation is stale'} · ${time(readiness.updatedAt)}`
        : readiness?.ready === false ? `${readyFresh ? 'Not ready / needs help' : 'Last reported not ready; confirmation is stale'} · ${time(readiness.updatedAt)}`
          : 'Readiness has not been confirmed.';
      finished.textContent = state.finished ? `Performer declared their set finished at ${time(state.finished.at)}. This does not stop the broadcast or confirm a successful curtain call.`
        : 'No set-finished declaration.';
      for (const control of controls) {
        control.button.hidden = !caps[control.capability];
        control.button.disabled = !next.fresh || next.pending || !caps[control.capability] ||
          control.name === 'acknowledge-cue' && (!cueActive || !!state.cue.acknowledgedAt) ||
          control.name === 'acknowledge-delay' && (!delayActive || !!state.delay.acknowledgedAt) ||
          control.name === 'finished' && !!state.finished;
      }
      const key = JSON.stringify(next.messages);
      if (key !== lastMessages) {
        lastMessages = key;
        messageNotice.textContent = `${next.messages.length} retained private message${next.messages.length === 1 ? '' : 's'} in this booking.`;
        thread.replaceChildren(...next.messages.map(item =>
          make('li', `${item.senderRole === 'owner' ? 'Owner' : 'Performer'} · ${time(item.sentAt)}: ${item.text}`)));
      }
      onState(next.fresh ? state : null);
    },
  });
  const timer = environment.setInterval(() => client.tick(), 1000);
  client.setSession(null);
  return {
    setSession: value => client.setSession(value),
    dispose() { environment.clearInterval(timer); client.dispose(); input.value = ''; container.replaceChildren(); },
  };
}
