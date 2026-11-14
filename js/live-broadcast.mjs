export const MAX_LIVE_ENCORE_MS = 600000;
export const LIVE_TAKE_GRACE_MS = 60000;

const allocationKeys = ['id', 'revision', 'plannedStartAt', 'startedAt', 'endedAt', 'endReason',
  'durationMs', 'encoreMs', 'choice', 'choiceAt', 'previousBookingId', 'nextBookingId',
  'delayNotifiedAt', 'finishedId', 'finishedAt', 'priorityFollowup'];
const instant = value => value === null || Number.isSafeInteger(value) && value > 0;
const reference = value => value === null || typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,200}$/.test(value);

export function validateLiveAllocation(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(key => !allocationKeys.includes(key)) ||
      !reference(a.id) || !a.id || !Number.isSafeInteger(a.revision) || a.revision < 1 ||
      !Number.isSafeInteger(a.plannedStartAt) || a.plannedStartAt <= 0 ||
      ![a.startedAt, a.endedAt, a.choiceAt, a.delayNotifiedAt, a.finishedAt].every(instant) ||
      !Number.isSafeInteger(a.durationMs) || a.durationMs <= 0 || a.durationMs > 4 * 3600000 ||
      !Number.isSafeInteger(a.encoreMs) || a.encoreMs < 0 || a.encoreMs > MAX_LIVE_ENCORE_MS ||
      !['contracted', 'pending', 'full', 'short', 'decline'].includes(a.choice) ||
      ![a.previousBookingId, a.nextBookingId, a.finishedId].every(reference) ||
      ![null, 'producer-finished', 'operator-cut', 'authorization-expired', 'audio-loss', 'declined', 'not-ready'].includes(a.endReason) ||
      !!a.endedAt !== !!a.endReason || !!a.finishedAt !== !!a.finishedId ||
      a.startedAt !== null && (!['contracted', 'full', 'short'].includes(a.choice) ||
        a.endedAt !== null && a.endedAt < a.startedAt) ||
      a.encoreMs > 0 && a.startedAt === null ||
      a.finishedAt !== null && (a.startedAt === null || a.finishedAt < a.startedAt ||
        a.endedAt !== null && a.finishedAt > a.endedAt) ||
      a.endReason === 'producer-finished' && a.finishedAt === null ||
      ['declined', 'not-ready'].includes(a.endReason) && a.startedAt !== null ||
      a.priorityFollowup === true && a.endedAt === null ||
      typeof a.priorityFollowup !== 'boolean') throw new Error('Invalid live broadcast allocation');
  return a;
}

export function liveBroadcastTiming(booking, record) {
  const a = record?.allocation;
  if (!a) return null;
  const start = a.startedAt ?? a.plannedStartAt;
  const effectiveSetEndAt = start + a.durationMs;
  return {
    allocationId: a.id, revision: a.revision,
    phase: a.endedAt ? 'ended' : a.startedAt ? 'live' : 'waiting',
    plannedStartAt: a.plannedStartAt, actualStartedAt: a.startedAt,
    effectiveSetEndAt, authorizedEndAt: effectiveSetEndAt + a.encoreMs,
    actualEndedAt: a.endedAt, endReason: a.endReason,
    allocatedDurationMs: a.durationMs, encoreMs: a.encoreMs,
    remainingEncoreMs: MAX_LIVE_ENCORE_MS - a.encoreMs,
    accessUntil: start + Math.max(a.durationMs, Date.parse(booking.endUtc) - Date.parse(booking.startUtc)) +
      MAX_LIVE_ENCORE_MS + LIVE_TAKE_GRACE_MS,
  };
}

export function liveBroadcastEnd(booking) {
  return booking.broadcast
    ? booking.broadcast.actualEndedAt ?? (booking.broadcast.actualStartedAt
      ? booking.broadcast.authorizedEndAt : booking.broadcast.accessUntil)
    : Date.parse(booking.endUtc);
}

export function liveBroadcastStart(booking) {
  return booking.broadcast?.actualStartedAt ?? booking.broadcast?.plannedStartAt ?? Date.parse(booking.startUtc);
}
