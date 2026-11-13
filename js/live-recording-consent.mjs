export const LIVE_RECORDING_CONSENT_VERSION = 'dbusk-live-recording-v1';

export function liveRecordingConsentMessage({ bookingId, wallet, origin, issuedAt, enabled }) {
  if (typeof bookingId !== 'string' || !/^[a-zA-Z0-9:_-]{1,200}$/.test(bookingId) ||
      !/^0x[0-9a-fA-F]{40}$/.test(wallet || '') || typeof enabled !== 'boolean' ||
      !Number.isSafeInteger(issuedAt) || issuedAt <= 0 || !Number.isFinite(new Date(issuedAt).getTime())) throw new Error('Invalid recording permission');
  let site;
  try { site = new URL(origin); } catch { throw new Error('Invalid recording permission origin'); }
  if (site.origin !== origin || !['http:', 'https:'].includes(site.protocol)) throw new Error('Invalid recording permission origin');
  return [
    'DBusk Radio - separate live recording permission',
    `Version: ${LIVE_RECORDING_CONSENT_VERSION}`,
    `Booking: ${bookingId}`,
    `Performer wallet: ${wallet.toLowerCase()}`,
    `Site: ${origin}`,
    `Issued at: ${new Date(issuedAt).toISOString()}`,
    `Record this and play on the radio: ${enabled ? 'YES' : 'NO'}`,
    enabled
      ? 'I permit recording only my scheduled live set, publishing its audio on public IPFS in the community music collection, minting its DNFT for my wallet, and replaying it on DBusk Radio after admin minting. I can grant these rights for the music I perform.'
      : 'I turn off recording permission for this set. Stop new capture and publication under this permission; already public IPFS audio and minted records cannot be recalled.',
    'Private practice and soundchecks are not recorded. My guaranteed fee and original booking terms are unchanged. No payment, gas or token approval.',
  ].join('\n');
}
