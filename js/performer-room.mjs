export function performerRoomUrl(booking, now = Date.now()) {
  if (!booking?.id || booking.mode !== 'phase1' || booking.payoutPolicy !== 'pilot-guaranteed-v1' ||
      !booking.stewardApproved || booking.cancelled || !['draft', 'funded'].includes(booking.status) ||
      !Number.isFinite(Date.parse(booking.startUtc)) || Date.parse(booking.endUtc) <= now) return null;
  return `live-room.html?booking=${encodeURIComponent(booking.id)}`;
}

export function performerRoomSign(booking, state, now = Date.now(), observedAt = 0) {
  if (!booking || booking.cancelled) return { label: 'OFF AIR', detail: 'No active performance booking.', live: false };
  const start = Date.parse(booking.startUtc), end = Date.parse(booking.endUtc);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { label: 'OFF AIR', detail: 'Schedule unavailable.', live: false };
  if (now >= end) return { label: 'OFF AIR', detail: 'Your set has ended. Thank you for the music.', live: false };
  if (now < start) {
    const remaining = Math.ceil((start - now) / 1000);
    const days = Math.floor(remaining / 86400);
    const clock = [Math.floor(remaining / 3600) % 24, Math.floor(remaining / 60) % 60, remaining % 60]
      .map(value => String(value).padStart(2, '0')).join(':');
    return { label: 'OFF AIR', detail: `${days ? `${days}d ` : ''}${clock} until your set · ${now < start - 70 * 60_000 ? 'Private practice' : 'Soundcheck time'}`, live: false };
  }
  const fresh = observedAt > 0 && now - observedAt <= 12000 && now >= observedAt;
  if (booking.status === 'funded' && booking.acknowledged && fresh &&
      state?.configured && state.bookingId === booking.id && state.phase === 'live' &&
      state.armed && state.status === 'ON-AIR') {
    return { label: 'ON AIR', detail: 'Live on DecentBusking radio.', live: true };
  }
  return { label: 'OFF AIR', detail: fresh && state?.phase === 'cancelled'
    ? 'Broadcast cancelled. Your guaranteed fee is unchanged.'
    : 'Waiting for verified audio and operator clearance.', live: false };
}
