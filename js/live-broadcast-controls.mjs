import { roomRequest } from './live-audio-client.mjs?v=20261114-allocated-stage';

export function broadcastTimes(booking, state) {
  return {
    contractStart: Date.parse(booking?.startUtc), contractEnd: Date.parse(booking?.endUtc),
    plannedStart: state?.broadcast?.plannedStartAt ?? null,
    actualStart: state?.broadcast?.actualStartedAt ?? null,
    setEnd: state?.broadcast?.effectiveSetEndAt ?? null,
    authorizedEnd: state?.broadcast?.authorizedEndAt ?? null,
    actualEnd: state?.broadcast?.actualEndedAt ?? null,
  };
}

export function bindLiveBroadcastControls({ container, bookingId, serviceUrl, getSession, getBooking,
  getCandidates = () => [], getNextPass, onReconnect, onState = () => {}, pollState = true,
  request = roomRequest, environment = globalThis, now = () => Date.now() }) {
  const doc = container.ownerDocument || document;
  const make = (tag, text) => {
    const node = doc.createElement(tag);
    if (text) node.textContent = text;
    return node;
  };
  let state, observedAt = 0, busy = false, polling = false, lastPoll = 0, disposed = false, uncertain;
  let report = '', failed = false, candidateKey = '';
  const clock = () => Number.isFinite(state?.serverTime) ? state.serverTime + Math.max(0, now() - observedAt) : now();
  const fresh = () => state && observedAt > 0 && now() >= observedAt && now() - observedAt <= 12000;
  const activePass = () => getSession()?.expiresAt > clock();
  const time = value => Number.isFinite(value) ? new Intl.DateTimeFormat(undefined, {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(value)) : 'not set';
  container.replaceChildren();
  container.classList.add('broadcast-controls');
  const title = make('h3', 'Allocated stage · actual timing controls');
  const status = make('output');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const contract = make('p'), timing = make('p'), allocation = make('p'), choice = make('p'), passNote = make('p'), recording = make('p');
  const terms = make('p', 'Original contract times and guaranteed fee do not change. A delayed artist may decline, choose a short set, or choose the full contracted length. A standby acknowledgment is receipt, not permission or a commitment to play.');
  const actions = make('div');
  actions.className = 'room-action-row';
  const nodes = [];
  function confirm(message) { return !message || environment.confirm(message); }
  async function execute(input) {
    const authorization = getSession();
    if (!authorization || !fresh() || !activePass()) throw new Error('Refresh or reconnect this booking’s pass before changing stage timing.');
    busy = true;
    report = 'Saving stage control… Wait for durable confirmation (up to 60 seconds).';
    failed = false;
    render();
    try {
      const result = await request(serviceUrl, 'control', input, authorization.token);
      if (disposed || getSession() !== authorization) return false;
      if (result.commandId !== input.commandId || typeof result.applied !== 'boolean' || result.state?.bookingId !== bookingId) {
        throw new Error('Stage confirmation did not match this booking and command.');
      }
      update(result.state);
      onState(result.state);
      uncertain = null;
      report = 'Stage control saved. The effective times below are server-confirmed; original contract terms are unchanged.';
      failed = false;
      return true;
    } catch (cause) {
      if (disposed || getSession() !== authorization) return false;
      uncertain = !cause.status || cause.status >= 500 ? input : null;
      report = [401, 403].includes(cause.status) ? 'Stage authorization expired or changed. Reconnect; your microphone is not stopped by this message.'
        : cause.status === 409 ? 'Stage state or next-act authorization changed. Refresh and review before trying again.'
          : `${cause.message || 'Stage control unavailable'}. The change is not confirmed; refresh or retry the same command.`;
      failed = true;
      return false;
    } finally { if (!disposed) { busy = false; render(); } }
  }
  function button(label, capability, action, fields = () => ({}), confirmation) {
    const node = make('button', label);
    node.type = 'button';
    node.addEventListener('click', async () => {
      if (busy || !state?.broadcastCapabilities?.[capability]) return;
      try {
        if (uncertain) throw new Error('Resolve the previous uncertain command with Refresh / Retry before submitting another change.');
        if (!confirm(confirmation)) return;
        const authorization = getSession(), revision = state.broadcast?.revision || 0;
        busy = true;
        report = 'Preparing booking-scoped stage control…';
        render();
        const extra = await fields();
        if (disposed || getSession() !== authorization) return;
        busy = false;
        await execute({ ...extra, action: `broadcast-${action}`, commandId: environment.crypto.randomUUID(), expectedRevision: revision });
      } catch (cause) { report = cause.message; failed = true; }
      finally { if (!disposed) { busy = false; render(); } }
    });
    actions.append(node);
    nodes.push({ node, capability, action });
    return node;
  }
  button('Enable allocated-stage control', 'enable', 'enable', undefined,
    'Enable explicit stage timing for this booking? This can adopt the current live set. Other unallocated bookings keep their existing automatic schedule; original fees and terms are unchanged.');
  const nextLabel = make('label', 'Next booked act to reserve');
  const next = make('select');
  next.setAttribute('aria-label', 'Next booked act to reserve');
  nextLabel.append(next);
  function verifiedNext(pass, id) {
    if (pass?.role !== 'owner' || pass.state?.bookingId !== id || !pass.token || !(pass.expiresAt > clock())) {
      throw new Error('A current owner pass for the exact next booking is required.');
    }
    return pass;
  }
  const reserve = button('Reserve and notify selected next act', 'reserveNext', 'reserve-next', async () => {
    const nextBookingId = next.value;
    if (!nextBookingId || nextBookingId === bookingId) throw new Error('Select a different next booking.');
    const pass = verifiedNext(await getNextPass(nextBookingId), nextBookingId);
    return { nextBookingId, nextToken: pass.token, expectedNextRevision: pass.state?.broadcast?.revision || 0 };
  }, 'Reserve and notify this next act? Their acknowledgment is not required for the scheduling notice. They may choose whether and how long to play; their original guaranteed fee remains unchanged.');
  const encoreLabel = make('label', 'Additional encore minutes · cumulative maximum 10');
  const encore = make('input');
  encore.type = 'number'; encore.min = '0.1'; encore.step = '0.1'; encore.value = '1';
  encore.setAttribute('aria-label', 'Additional encore minutes');
  encoreLabel.append(encore);
  button('Authorize additional encore', 'grantEncore', 'encore', async () => {
    const additionalMs = Math.round(Number(encore.value) * 60000);
    if (!Number.isSafeInteger(additionalMs) || additionalMs <= 0 || additionalMs > state.broadcast.remainingEncoreMs) {
      throw new Error('Choose a positive encore within the server-reported remaining allowance.');
    }
    const nextId = state.broadcastControl?.nextBookingId;
    if (nextId && !getNextPass) throw new Error('Use the production desk to authorize the paired next booking before bumping it.');
    const pass = nextId ? verifiedNext(await getNextPass(nextId), nextId) : null;
    return { additionalMs, ...(pass ? { nextToken: pass.token } : {}) };
  }, 'Authorize these extra encore minutes? Any paired next act will be notified of the bump. This changes effective airtime only, not the original guaranteed fees or contract times.');
  const shortLabel = make('label', 'Short-set minutes');
  const short = make('input');
  short.type = 'number'; short.min = '0.1'; short.step = '0.1'; short.value = '10';
  short.setAttribute('aria-label', 'Short-set minutes');
  shortLabel.append(short);
  button('Choose full contracted-length set', 'chooseSet', 'choice', () => ({ choice: 'full' }));
  button('Choose this short set', 'chooseSet', 'choice', () => {
    const durationMs = Math.round(Number(short.value) * 60000);
    const b = getBooking();
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > Date.parse(b?.endUtc) - Date.parse(b?.startUtc)) {
      throw new Error('Choose a positive short set no longer than your original contracted duration.');
    }
    return { choice: 'short', durationMs };
  });
  button('Decline this delayed slot · keep original guarantee', 'chooseSet', 'choice', () => ({ choice: 'decline' }),
    'Decline playing this allocated slot? Your original guaranteed fee is still payable; this does not waive payment or create a new booking.');
  button('My allocated set is finished', 'declareFinished', 'finished', undefined,
    'Declare your allocated set finished at this song boundary? The owner still decides when to end the public broadcast. Your microphone is not stopped by this declaration.');
  const normalEnd = button('End after performer’s finished declaration', 'endBroadcast', 'end', () => ({ mode: 'normal', confirmed: true }),
    'End this broadcast after the performer’s confirmed finished declaration? The server will finalize the actual live lifecycle and hand off safely.');
  const cut = button('Force cut · mark interrupted', 'endBroadcast', 'end', () => ({ mode: 'operator-cut', confirmed: true }),
    'FORCE CUT this broadcast now? This is an interrupted ending, not a successful curtain call. The guaranteed fee remains unchanged.');
  const emergency = make('details');
  emergency.append(make('summary', 'Emergency stage interruption'), cut);
  button('Take this selected act live', 'takeLive', 'take', () => ({ confirmed: true }),
    'Take this exact selected performer live now? Their chosen set, readiness, checks, fresh audio, previous ending and paid-program boundary will be verified by the server.');
  const retry = make('button', 'Retry same stage command');
  retry.type = 'button';
  retry.addEventListener('click', async () => {
    try { if (uncertain) await execute(uncertain); } catch (cause) { report = cause.message; failed = true; render(); }
  });
  const refreshButton = make('button', 'Refresh stage timing');
  refreshButton.type = 'button';
  refreshButton.addEventListener('click', () => { void refresh(); });
  const reconnect = make('button', 'Refresh allocated booking pass · keep microphone on');
  reconnect.type = 'button';
  reconnect.addEventListener('click', async () => {
    if (!onReconnect || busy) return;
    busy = true; render();
    try {
      const pass = await onReconnect();
      if (!disposed && pass) {
        report = 'Allocated booking pass refreshed. Your microphone was not stopped.';
        failed = false;
        update(pass.state);
      }
    } catch (cause) { report = cause.message; failed = true; }
    finally { if (!disposed) { busy = false; render(); } }
  });
  container.append(title, status, contract, timing, allocation, choice, passNote, recording, terms,
    nextLabel, encoreLabel, shortLabel, actions, emergency, retry, refreshButton, reconnect);
  function render() {
    const b = getBooking(), times = broadcastTimes(b, state), broadcast = state?.broadcast, caps = state?.broadcastCapabilities || {};
    const isFresh = fresh(), usable = isFresh && activePass() && !busy;
    contract.textContent = `Immutable contract: ${time(times.contractStart)} – ${time(times.contractEnd)} New York. Original guaranteed fee unchanged.`;
    timing.textContent = broadcast ? `Effective stage: planned ${time(times.plannedStart)}; actual start ${time(times.actualStart)}; set end ${time(times.setEnd)}; authorized end including encore ${time(times.authorizedEnd)}; actual end ${time(times.actualEnd)}. All times New York.`
      : 'No allocated-stage timing is confirmed. Existing automatic scheduling remains in effect unless the owner explicitly enables an allocation.';
    const minutes = value => Number.isFinite(value) ? Math.round(value / 6000) / 10 : 'unknown';
    allocation.textContent = broadcast ? `Allocated stage ${broadcast.phase}. Encore used: ${minutes(broadcast.encoreMs)} minutes; remaining: ${minutes(broadcast.remainingEncoreMs)} minutes (maximum 10 per allocated set).${broadcast.endReason ? ` End reason: ${broadcast.endReason}.` : ''}`
      : '';
    choice.textContent = state?.broadcastControl ? `Artist choice: ${state.broadcastControl.choice || 'not provided'}.${state.broadcastControl.delayNotifiedAt
      ? ` Producer delay notified ${time(state.broadcastControl.delayNotifiedAt)}; no acknowledgment is required to notify.` : ''}${state.broadcastControl.finishedId
      ? ' Durable performer-finished declaration received.' : ''}${state.broadcastControl.priorityFollowup === true
        ? ' Priority invitation follow-up requested; no new booking or funding has been created.' : ''}` : '';
    passNote.textContent = getSession() ? `This pass expires ${time(getSession().expiresAt)}.${broadcast?.accessUntil > getSession().expiresAt
      ? ` Allocation access extends to ${time(broadcast.accessUntil)}; refresh your allocated pass before its old deadline without stopping your microphone.` : ''}` : 'Connect this booking wallet for private timing controls.';
    recording.textContent = !state?.recording ? 'Recording permission is unavailable; timing controls never grant recording rights.'
      : !state.recording.consented ? 'Recording is off. Stage timing changes do not turn it on.'
        : state.recording.consentVersion === 'dbusk-live-recording-v2'
          ? 'Recording permission v2 covers only the authorized on-air allocated set; private practice and soundchecks remain excluded.'
          : 'Recording scope is the original scheduled set only. Delay/encore capture requires the performer’s explicit v2 permission update in their own room.';
    status.textContent = report || (!state ? 'Stage control is unavailable until this booking is authorized.'
      : !isFresh ? 'Stage timing is stale; changes are disabled. Your microphone is unaffected.'
        : 'Server-verified stage timing. Advisory direction cues are not timing authorization.');
    if (report && state && !isFresh) status.textContent += ' Stage timing is now stale; changes are disabled until refreshed.';
    if (getSession() && !activePass()) status.textContent += ' This pass expired; refresh allocated authorization without stopping the microphone.';
    status.dataset.error = String(failed || !!state && !isFresh);
    for (const item of nodes) {
      item.node.hidden = !caps[item.capability];
      item.node.disabled = !usable || !caps[item.capability];
    }
    reserve.hidden = nextLabel.hidden = !caps.reserveNext || !getNextPass;
    encoreLabel.hidden = !caps.grantEncore;
    encore.disabled = !usable;
    encore.max = String((broadcast?.remainingEncoreMs || 0) / 60000);
    shortLabel.hidden = !caps.chooseSet;
    short.disabled = !usable;
    short.max = String((times.contractEnd - times.contractStart) / 60000);
    normalEnd.disabled ||= !state?.broadcastControl?.finishedId;
    emergency.hidden = !caps.endBroadcast;
    next.disabled = !usable;
    const candidates = getCandidates().filter(item => item.id !== bookingId);
    const key = candidates.map(item => `${item.id}:${item.displayName || item.title}`).join('|');
    if (key !== candidateKey) {
      candidateKey = key;
      const previous = next.value;
      const empty = make('option', 'Select next booking'); empty.value = '';
      next.replaceChildren(empty, ...candidates.map(item => {
        const option = make('option', item.displayName || item.title || item.id); option.value = item.id; return option;
      }));
      if (candidates.some(item => item.id === previous)) next.value = previous;
    }
    retry.hidden = !uncertain;
    retry.disabled = !usable;
    refreshButton.disabled = !getSession() || busy;
    reconnect.hidden = !onReconnect;
    reconnect.disabled = busy;
  }
  function update(nextState) {
    if (disposed) return;
    if (!nextState) { state = null; observedAt = 0; uncertain = null; report = ''; failed = false; render(); return; }
    if (nextState.bookingId !== bookingId) throw new Error('Stage response belongs to another booking.');
    if (state?.broadcast && nextState.broadcast?.allocationId === state.broadcast.allocationId &&
        nextState.broadcast.revision < state.broadcast.revision) return;
    state = nextState;
    observedAt = now();
    render();
  }
  async function refresh() {
    const authorization = getSession();
    if (!authorization || polling || busy || disposed) return;
    polling = true;
    lastPoll = now();
    try {
      const nextState = await request(serviceUrl, 'control', { action: 'state' }, authorization.token);
      if (!disposed && getSession() === authorization) { update(nextState); onState(nextState); }
    } catch (cause) {
      if (!disposed && getSession() === authorization) { report = `${cause.message}. Refresh the allocated pass if it expired; microphone publishing is unaffected.`; failed = true; render(); }
    } finally { polling = false; }
  }
  const timer = environment.setInterval(() => {
    if (disposed) return;
    if (!getSession()) { if (state) update(null); return; }
    render();
    if (pollState && now() - lastPoll >= 3000) void refresh();
  }, 1000);
  render();
  return { update, refresh, dispose() { disposed = true; environment.clearInterval(timer); state = null; uncertain = null; container.replaceChildren(); } };
}
