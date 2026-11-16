export const FEEDBACK_SIGNALS = Object.freeze(['applause', 'love', 'encore', 'audio-problem']);
export const FEEDBACK_ADVISORY = 'Listener signals are advisory. No reports do not prove that the audio is healthy.';
export const FEEDBACK_ROUTE = '/api/live-audio/feedback';
export const FEEDBACK_SNAPSHOT_ACTION = 'feedback-snapshot';
export const FEEDBACK_CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
export const FEEDBACK_BOOKING_ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;

const BODY_KEYS = new Set(['signal', 'bookingId', 'clientId']);
const ADDRESS = /^0x[0-9a-f]{40}$/i;

export function validateFeedbackInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Object.keys(input).some(key => !BODY_KEYS.has(key))) return false;
  return FEEDBACK_SIGNALS.includes(input.signal) &&
    typeof input.bookingId === 'string' && FEEDBACK_BOOKING_ID_PATTERN.test(input.bookingId) &&
    typeof input.clientId === 'string' && FEEDBACK_CLIENT_ID_PATTERN.test(input.clientId);
}

export function activeFeedbackShow(state) {
  const verification = state?.bookingVerification;
  const serverTime = state?.serverTime;
  const wallet = state?.performer?.wallet;
  if (state?.configured !== true || state.phase !== 'live' || state.armed !== true ||
      typeof state.bookingId !== 'string' || !FEEDBACK_BOOKING_ID_PATTERN.test(state.bookingId) ||
      state.policy?.mode !== 'live' || state.policy.bookingId !== state.bookingId ||
      verification?.fresh !== true || !Number.isFinite(verification.verifiedAt) ||
      verification.verifiedAt <= 0 || !Number.isFinite(serverTime) ||
      verification.verifiedAt > serverTime || serverTime - verification.verifiedAt > 30_000 ||
      !ADDRESS.test(wallet || '') || /^0x0{40}$/i.test(wallet)) return null;

  const broadcast = state.broadcast;
  const startedAt = broadcast ? broadcast.actualStartedAt : Date.parse(state.startUtc);
  const endsAt = broadcast ? broadcast.actualEndedAt ?? broadcast.authorizedEndAt : Date.parse(state.endUtc);
  if (broadcast && (broadcast.phase !== 'live' || broadcast.actualEndedAt != null ||
      typeof broadcast.allocationId !== 'string' || !broadcast.allocationId)) return null;
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(endsAt) ||
      startedAt <= 0 || endsAt <= startedAt || serverTime < startedAt || serverTime >= endsAt) return null;
  return {
    bookingId: state.bookingId,
    lifecycle: JSON.stringify([state.bookingId, broadcast?.allocationId || 'scheduled', startedAt]),
    recipient: wallet.toLowerCase(),
    startedAt,
    endsAt,
  };
}
