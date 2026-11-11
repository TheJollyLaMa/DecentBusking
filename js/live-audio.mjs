export const LIVE_AUDIO_GRACE_MS = 60_000;
export const LIVE_AUDIO_FRESH_MS = 5_000;
export const LIVE_AUDIO_SLATE_MS = 5_000;
export const LIVE_AUDIO_ADS_MS = 10 * 60_000;

export function parseLiveAudioPrograms(value = '{}') {
  const programs = JSON.parse(value);
  if (!programs || typeof programs !== 'object' || Array.isArray(programs)) throw new Error('Invalid live audio programs');
  for (const [id, plan] of Object.entries(programs)) {
    if (!id || id.length > 200 || !plan || Object.keys(plan).some(key => !['leadInSeconds', 'outroSeconds'].includes(key)) ||
        ![plan.leadInSeconds, plan.outroSeconds].every(n => Number.isInteger(n) && n >= 0 && n <= 600)) {
      throw new Error('Invalid live audio program timing');
    }
  }
  return programs;
}

export function liveAudioRoomUrl(booking, now = Date.now()) {
  if (!booking?.id || booking.mode !== 'phase1' || booking.payoutPolicy !== 'pilot-guaranteed-v1' ||
      booking.status !== 'funded' || booking.acknowledged !== true || booking.cancelled ||
      !Number.isFinite(Date.parse(booking.startUtc)) || !(Date.parse(booking.endUtc) > now)) return null;
  return `live-room.html?booking=${encodeURIComponent(booking.id)}`;
}

export function liveAudioPolicy(record, booking, now = Date.now(), program = null) {
  if (!record || !booking) return null;
  const start = Date.parse(booking.startUtc), end = Date.parse(booking.endUtc);
  const common = { bookingId: booking.id, eventId: booking.eventId, title: booking.title || 'Live performance',
    startUtc: booking.startUtc, endUtc: booking.endUtc,
    ...(program ? { program: { ...program, artist: booking.displayName || booking.title,
      wallet: booking.wallet, endsAt: end + program.outroSeconds * 1000 } } : {}) };
  if (record.cancelledAt) {
    const elapsed = now - record.cancelledAt;
    if (now >= end && elapsed >= LIVE_AUDIO_SLATE_MS + LIVE_AUDIO_ADS_MS) return null;
    return { ...common, mode: elapsed < LIVE_AUDIO_SLATE_MS ? 'fault'
      : elapsed < LIVE_AUDIO_SLATE_MS + LIVE_AUDIO_ADS_MS ? 'adverts' : 'radio',
    cancelledAt: record.cancelledAt, reason: record.reason,
    slateEndsAt: record.cancelledAt + LIVE_AUDIO_SLATE_MS,
    advertsEndAt: record.cancelledAt + LIVE_AUDIO_SLATE_MS + LIVE_AUDIO_ADS_MS };
  }
  if (program && now >= start - program.leadInSeconds * 1000 && now < start) {
    return { ...common, mode: 'adverts', breakKind: 'lead-in', advertsEndAt: start };
  }
  if (program && now >= end && now < end + program.outroSeconds * 1000) {
    return { ...common, mode: 'adverts', breakKind: 'outro', advertsEndAt: end + program.outroSeconds * 1000 };
  }
  if (program && now >= end + program.outroSeconds * 1000 && now < end + 24 * 3600000) {
    return { ...common, mode: 'radio' };
  }
  if (now < start || now >= end) return null;
  return { ...common, mode: 'live', armed: !!record.armed };
}

export function listenerAudioStatus({ phase, serverStatus, connected, playing, lastPacketAt, now = Date.now() }) {
  if (phase !== 'live') return 'OFF-AIR';
  return serverStatus === 'ON-AIR' && connected && playing && lastPacketAt > 0 &&
    now - lastPacketAt <= LIVE_AUDIO_FRESH_MS ? 'ON-AIR' : 'RECONNECTING';
}

export function applyLiveAudioShow(show, policy) {
  if (!policy) return show;
  if (policy.mode !== 'live' && show.event?.id && show.event.id !== policy.eventId) return show;
  if (policy.breakKind === 'outro' && show.type === 'playlist_show') return show;
  if (policy.program && policy.mode === 'radio' && show.type !== 'live_performance' && !show.unbookedLiveOccurrenceId) return show;
  if (policy.mode === 'live' || policy.mode === 'fault') {
    const event = { id: policy.mode === 'live' ? policy.eventId || policy.bookingId : `${policy.eventId || policy.bookingId}:fault`, title: policy.title,
      startUtc: policy.startUtc, endUtc: policy.endUtc };
    return { id: event.id, type: 'live_performance', label: policy.mode === 'fault' ? 'Live cancellation fault slate' : policy.title, event };
  }
  if (policy.mode === 'adverts') return { id: `live-${policy.breakKind || 'cancellation'}-ads:${policy.bookingId}`,
    type: 'live_audio_ads', label: policy.breakKind === 'lead-in' ? 'Live show lead-in adverts'
      : policy.breakKind === 'outro' ? 'Live show outro adverts' : 'DVert cancellation recovery window' };
  return { id: 'normal-rotation', type: 'normal_rotation', label: 'Normal Rotation' };
}
