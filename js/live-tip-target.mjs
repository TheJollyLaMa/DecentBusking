import { radioEndpoint, readRadioState } from './radio-client.mjs';

export async function readLiveTipTarget({ serviceUrl, expectedBookingId, fetchImpl = fetch,
  signal = AbortSignal.timeout(10000) }) {
  const state = await readRadioState({ radioUrl: radioEndpoint(serviceUrl), fetchImpl, signal });
  const live = state.liveAudio;
  const liveSlot = live?.policy?.mode === 'live' || live?.phase === 'live' ||
    state.activeShow?.type === 'live_performance';
  if (!liveSlot) {
    if (expectedBookingId) throw new Error('The live performance ended or changed. Close and reopen the hat to choose a recipient.');
    return null;
  }
  if (live?.configured !== true || live.phase !== 'live' || live.armed !== true || live.policy?.mode !== 'live' ||
      typeof live.bookingId !== 'string' || !live.bookingId ||
      (expectedBookingId && expectedBookingId !== live.bookingId)) {
    throw new Error('The live performer is not verified or has changed. Close and reopen the hat before tipping.');
  }
  const verification = live.bookingVerification;
  if (verification?.fresh !== true || !Number.isFinite(verification.verifiedAt) || verification.verifiedAt <= 0 ||
      !Number.isFinite(live.serverTime) || verification.verifiedAt > live.serverTime ||
      live.serverTime - verification.verifiedAt > 30000) {
    throw new Error('Live booking verification is unavailable or stale. Tips are disabled until it recovers.');
  }
  const performer = live.performer;
  if (!/^0x[0-9a-fA-F]{40}$/.test(performer?.wallet || '') || /^0x0{40}$/i.test(performer.wallet) ||
      typeof performer.artist !== 'string' || !performer.artist.trim() ||
      typeof performer.title !== 'string' || !performer.title.trim()) {
    throw new Error('No verified performer tip wallet is available for this live set.');
  }
  return Object.freeze({
    bookingId: live.bookingId, wallet: performer.wallet,
    artist: performer.artist, title: performer.title,
  });
}
