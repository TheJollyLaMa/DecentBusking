export function performerRoomUrl(booking, now = Date.now()) {
  const allocated = booking?.broadcastCompletion?.known === true && booking.broadcastCompletion.pending === true;
  if (!booking?.id || booking.mode !== 'phase1' || booking.payoutPolicy !== 'pilot-guaranteed-v1' ||
      !booking.stewardApproved || booking.cancelled ||
      !['draft', 'funded', ...(allocated ? ['approved', 'paid'] : [])].includes(booking.status) ||
      !Number.isFinite(Date.parse(booking.startUtc)) || !Number.isFinite(Date.parse(booking.endUtc)) ||
      Date.parse(booking.endUtc) <= now && !allocated) return null;
  return `live-room.html?booking=${encodeURIComponent(booking.id)}`;
}

export function performerAllocationAccess(booking, state, now = Date.now(), observedAt = 0) {
  const fresh = observedAt > 0 && now >= observedAt && now - observedAt <= 12000;
  const serverNow = Number.isFinite(state?.serverTime) ? state.serverTime + Math.max(0, now - observedAt) : now;
  return !!(fresh && booking?.id && state?.bookingId === booking.id && state.configured &&
    !['cancelled', 'ended', 'unavailable'].includes(state.phase) &&
    state.broadcast?.allocationId && ['waiting', 'live'].includes(state.broadcast.phase) &&
    Number.isFinite(state.broadcast.accessUntil) && Number.isFinite(new Date(state.broadcast.accessUntil).getTime()) &&
    state.broadcast.accessUntil > serverNow);
}

export function verifiedPerformerStageBooking(booking, state) {
  const verifiedAt = state?.bookingVerification?.verifiedAt;
  return !!(booking?.id && state?.bookingId === booking.id && state.configured &&
    state.bookingVerification?.fresh === true && Number.isFinite(verifiedAt) &&
    Number.isFinite(state.serverTime) && verifiedAt <= state.serverTime &&
    state.serverTime - verifiedAt <= 30000);
}

export function verifiedPerformerFinish(booking, state) {
  const broadcast = state?.broadcast;
  return !!(verifiedPerformerStageBooking(booking, state) && state.phase === 'ended' &&
    broadcast?.phase === 'ended' && broadcast.endReason === 'producer-finished' &&
    typeof broadcast.allocationId === 'string' && broadcast.allocationId.length > 0 &&
    Number.isSafeInteger(broadcast.actualStartedAt) && broadcast.actualStartedAt > 0 &&
    Number.isSafeInteger(broadcast.actualEndedAt) && broadcast.actualEndedAt > 0 &&
    broadcast.actualStartedAt <= broadcast.actualEndedAt && broadcast.actualEndedAt <= state.serverTime);
}

export async function resolvePerformerReentry(booking, { serviceUrl, fetchImpl = fetch, now = () => Date.now() }) {
  const completion = booking?.broadcastCompletion;
  const eligible = booking?.id && booking.mode === 'phase1' && booking.payoutPolicy === 'pilot-guaranteed-v1' &&
    booking.acknowledged === true && !booking.cancelled && ['funded', 'approved', 'paid'].includes(booking.status) &&
    Number.isFinite(Date.parse(booking.startUtc)) && Date.parse(booking.endUtc) > Date.parse(booking.startUtc);
  if (!eligible || !completion || completion.known === true && completion.pending === false ||
      Date.parse(booking.endUtc) > now() && !['approved', 'paid'].includes(booking.status)) return { status: 'none' };
  try {
    const response = await fetchImpl(`${serviceUrl.replace(/\/$/, '')}/api/live-audio/state?bookingId=${encodeURIComponent(booking.id)}`, {
      cache: 'no-store', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Stage state unavailable');
    const state = await response.json(), observedAt = now();
    if (!verifiedPerformerStageBooking(booking, state)) {
      throw new Error('Stage booking verification is unavailable');
    }
    if (performerAllocationAccess(booking, state, observedAt, observedAt)) {
      return { status: 'active', url: `live-room.html?booking=${encodeURIComponent(booking.id)}`,
        broadcast: state.broadcast, observedAt };
    }
    if (state.broadcast?.phase === 'ended' || ['cancelled', 'ended'].includes(state.phase)) {
      if (state.broadcast?.endReason === 'producer-finished' && !verifiedPerformerFinish(booking, state)) {
        throw new Error('Successful stage ending is unavailable');
      }
      return { status: 'ended', endReason: state.broadcast?.endReason || null,
        endedAt: Number.isFinite(state.broadcast?.actualEndedAt) ? state.broadcast.actualEndedAt : null };
    }
    throw new Error('No current bounded allocation could be verified');
  } catch {
    return { status: 'unavailable',
      detail: 'Allocated backstage could not be verified. The original contract end is not proof that your set finished. Refresh stage status; your original guaranteed fee and claim rights are unchanged.' };
  }
}

export function performerRoomSign(booking, state, now = Date.now(), observedAt = 0) {
  if (!booking || booking.cancelled) return { label: 'OFF AIR', detail: 'No active performance booking.', live: false };
  const start = Date.parse(booking.startUtc), end = Date.parse(booking.endUtc);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { label: 'OFF AIR', detail: 'Schedule unavailable.', live: false };
  const fresh = observedAt > 0 && now - observedAt <= 12000 && now >= observedAt;
  const allocated = performerAllocationAccess(booking, state, now, observedAt);
  const serverNow = Number.isFinite(state?.serverTime) ? state.serverTime + Math.max(0, now - observedAt) : now;
  if (fresh && state?.bookingId === booking.id && state.broadcast?.phase === 'ended') {
    return { label: 'OFF AIR', detail: `Allocated broadcast ended${state.broadcast.endReason ? `: ${state.broadcast.endReason}` : ''}. Original guaranteed fee unchanged.`, live: false };
  }
  if (now >= end && !allocated) return { label: 'OFF AIR', detail: state?.broadcast
    ? 'Allocated stage status unavailable or expired. Check the verified effective timing; original contract terms are unchanged.'
    : 'Your set has ended. Thank you for the music.', live: false };
  if (now < start) {
    const remaining = Math.ceil((start - now) / 1000);
    const days = Math.floor(remaining / 86400);
    const clock = [Math.floor(remaining / 3600) % 24, Math.floor(remaining / 60) % 60, remaining % 60]
      .map(value => String(value).padStart(2, '0')).join(':');
    return { label: 'OFF AIR', detail: `${days ? `${days}d ` : ''}${clock} until your set · ${now < start - 70 * 60_000 ? 'Private practice' : 'Soundcheck time'}`, live: false };
  }
  if ((booking.status === 'funded' || allocated) && booking.acknowledged && fresh &&
      state?.configured && state.bookingId === booking.id && state.phase === 'live' &&
      state.armed && state.status === 'ON-AIR' && (!state.broadcast ||
        allocated && state.broadcast.phase === 'live' && Number.isFinite(state.broadcast.actualStartedAt) &&
        state.broadcast.actualStartedAt <= serverNow && state.broadcast.authorizedEndAt > serverNow)) {
    return { label: 'ON AIR', detail: allocated ? 'Live on the authorized allocated stage. Original contract times and guaranteed fee are unchanged.'
      : 'Live on DecentBusking radio.', live: true };
  }
  return { label: 'OFF AIR', detail: fresh && state?.phase === 'cancelled'
    ? 'Broadcast cancelled. Your guaranteed fee is unchanged.'
    : allocated && state.broadcast.phase === 'waiting' ? 'Allocated stage is waiting for your choice and the owner’s explicit take-live. Your guaranteed fee is unchanged.'
    : 'Waiting for verified audio and operator clearance.', live: false };
}
