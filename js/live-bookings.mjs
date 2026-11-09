export const LIVE_FUND = 'dbusk-live-performers';
export const LIVE_ROUTER = '0x8ecca903e2a6Daa8CCbB933700e4F2C58C44A4B5';
export const LIVE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const LIVE_PERFORMANCE_AIRTIME_MINUTES = 20;
export const LIVE_PERFORMANCE_FULL_PAYOUT_MINUTES = 15;
export const LIVE_PERFORMANCE_FEE_UNITS = '20000000';
export const LIVE_PILOT_POLICY = 'pilot-guaranteed-v1';
export const LIVE_PILOT_TERMS_VERSION = 'LIVE PERFORMANCE PILOT v1';
export const LIVE_PILOT_COMPANION_OFFER = 'Four guided prep tasks: $10 USDC each, paid separately upon task completion; Friday technical success does not affect task pay. Success gift: one DecentBusking v1.0.0 Supporter DNFT (Base DecentNFT 0xe63EC9f8228720bAAC2fD528C0A6d06B3Dc5439B, token 75), after all four prep tasks, both passed T-60 and T-15 soundchecks, and at least 75% verified website-radio slot coverage, with steward review. The gift is outside the USDC escrow and requires a separately confirmed NFT transfer; listing price is not cash value. The $20 pilot cash fee remains guaranteed regardless of technical outcome. No purchase or audience recruitment is required.';
export const LIVE_APPROVED_TERMS_V2 = {
 version: 'LIVE PERFORMANCE v2',
 uri: 'ipfs://bafkreidzxhbeub33romiprjlsjojgpitnwrqap52g6hpen3wowwhfi3zgq',
 hash: '0x8ae5bc38f9d8a66b0c43ac4697c14d62e14ef1c3e66768b6df294ff5b68d88f6',
};
export const LIVE_NOTICE = 'Escrow keeps the booking fee locked until review; payout follows the agreed terms. Community-fund money is only earmarked, not escrowed, and may be recovered by the steward.';
export const DRAFT_TERMS = 'Offer v2 is a draft until its exact agreement is pinned and approved. The proposed set is 20 minutes of airtime for $20 USDC; 15 live-music minutes earns the full fee, shorter sets are prorated, and no live set earns $0. Payout is based only on verified live-music minutes; outages do not create a separate full-fee exception.';
export const LIVE_ESCROW_ABI = [
 'function createBooking(bytes32 bookingId,address performer,uint256 amount,uint64 showStart,uint64 showEnd,uint64 claimDeadline,bytes32 termsHash,string termsUri,uint32 reviewWindow,uint32 cancellationWindow,uint16 killFeeBps)',
 'function approve(bytes32 bookingId,uint16 payoutBps,string reportUri)',
 'function claim(bytes32 bookingId)', 'function reject(bytes32 bookingId,string reasonUri)',
 'function markNoShow(bytes32 bookingId,string reasonUri)', 'function cancel(bytes32 bookingId,string reasonUri)',
 'event BookingFunded(bytes32 indexed bookingId,address indexed performer,address indexed funder,uint256 amount,bytes32 termsHash,string termsUri)',
 'event PerformanceApproved(bytes32 indexed bookingId,uint16 payoutBps,uint256 payoutAmount,uint256 refundAmount,string reportUri,bytes32 termsHash)',
 'event PerformancePaid(bytes32 indexed bookingId,address indexed performer,uint256 amount,bytes32 termsHash)',
 'event BookingRefunded(bytes32 indexed bookingId,address indexed funder,uint256 amount,string reasonUri,bytes32 termsHash)',
 'event BookingCancelled(bytes32 indexed bookingId,uint256 killFee,string reasonUri,bytes32 termsHash)',
];
export function liveAuthorization({ address, origin, issuedAt, command }) {
 return ['DecentBusking Live Performance authorization v1', `Wallet: ${address.toLowerCase()}`, `Origin: ${origin}`, `Issued: ${issuedAt}`, `Command: ${JSON.stringify(command)}`].join('\n');
}
export function liveAcknowledgement(b) {
 if (b.payoutPolicy === LIVE_PILOT_POLICY) {
  return [
   'DecentBusking Live Performance pilot agreement v1',
   `Booking reference: ${b.id}`,
   `Performer wallet: ${b.wallet}`,
   `Community calendar date: ${b.eventId}`,
   `Event time (UTC): ${b.startUtc} to ${b.endUtc}`,
   `Airtime: ${b.airtimeMinutes} minutes`,
   `Payout policy: ${b.payoutPolicy}`,
   livePerformancePolicyText(b),
   'Soundchecks: 60 and 15 minutes before the booked start; both must pass before going on air. Failed checks, no verified start, interruptions or cancellation do not reduce this pilot fee.',
   'Rehearsal coverage: verified whole seconds within the booked slot only. The estimate is not vested, claimable or paid money.',
   `Additional offer (outside performance escrow): ${b.additionalOffer || 'None recorded'}`,
   'Payment handling: per-booking Base USDC escrow; one full-fee approval after the booked end, then performer claim. Schedule cancellation is not a financial cancellation.',
   `Review window: ${b.reviewWindow} seconds after booked end; no decision by then allows full-fee claim.`,
   `Claim deadline (UTC): ${b.claimDeadline}`,
   `Contract cancellation parameters: ${b.cancellationWindow} seconds; ${b.killFeeBps} basis points. Direct contract cancellation/expiry/pause still apply; the steward must separately honor any guaranteed shortfall.`,
   `Agreement version: ${b.termsVersion}`,
   `Pinned agreement: ${b.termsUri}`,
   `Technical fingerprint for verifying the pinned agreement: ${b.termsHash}`,
  ].join('\n');
 }
 if (Number.isInteger(b.airtimeMinutes) && Number.isInteger(b.fullPayoutLiveMinutes)) {
  const formatWindow = seconds => seconds % 3600 === 0
   ? `${seconds / 3600} hours` : `${seconds / 60} minutes`;
  return [
   'DecentBusking Live Performance agreement v2',
   `Booking reference: ${b.id}`,
   `Performer wallet: ${b.wallet}`,
   `Community calendar date: ${b.eventId}`,
   `Event time (UTC): ${b.startUtc} to ${b.endUtc}`,
   `Airtime: ${b.airtimeMinutes} minutes`,
   `Maximum fee: $${(Number(b.amountUnits) / 1e6).toFixed(2)} USDC on Base`,
   `Payout: full fee at ${b.fullPayoutLiveMinutes} live-music minutes; below that, fee × verified live minutes ÷ ${b.fullPayoutLiveMinutes}, capped at the fee; no live minutes earns $0`,
   `Payment handling: ${b.mode === 'phase0' ? 'community fund, earmarked but not escrowed' : 'per-booking escrow'}`,
   `Review period: ${formatWindow(b.reviewWindow)} after the event`,
   `Late-cancellation notice: ${formatWindow(b.cancellationWindow)}; late-cancellation fee: ${(b.killFeeBps / 100).toFixed(2)}%`,
   `Claim deadline (UTC): ${b.claimDeadline}`,
   `Agreement version: ${b.termsVersion}`,
   `Pinned agreement: ${b.termsUri}`,
   `Technical fingerprint for verifying the pinned agreement: ${b.termsHash}`,
  ].join('\n');
 }
 const lines = ['DecentBusking Live Performance agreement v1', `Booking: ${b.id}`, `Performer: ${b.wallet}`,
  `Occurrence: ${b.eventId}`, `Slot: ${b.startUtc}/${b.endUtc}`, `Fee: ${b.amountUnits} USDC units on Base 8453`];
 if (Number.isInteger(b.airtimeMinutes) && Number.isInteger(b.fullPayoutLiveMinutes)) {
  lines.push(`Airtime: ${b.airtimeMinutes} minutes`,
   `Full payout at ${b.fullPayoutLiveMinutes} live-music minutes; below that, payout is proportional to verified live minutes, capped at the fee.`);
 }
 lines.push(`Mode: ${b.mode}`, `Terms: ${b.termsVersion} ${b.termsHash} ${b.termsUri}`,
  `Review: ${b.reviewWindow}s; cancellation window: ${b.cancellationWindow}s; kill fee: ${b.killFeeBps}bps`,
  `Claim deadline: ${b.claimDeadline}`, b.mode === 'phase0'
   ? 'Earmarked, NOT escrowed. Admin can recoverFund.' : 'Configured per-booking escrow.');
 return lines.join('\n');
}
export function livePerformancePayoutBps(liveMinutes, fullPayoutLiveMinutes = LIVE_PERFORMANCE_FULL_PAYOUT_MINUTES) {
 if (!Number.isSafeInteger(liveMinutes) || liveMinutes < 0 ||
     !Number.isSafeInteger(fullPayoutLiveMinutes) || fullPayoutLiveMinutes < 1) {
  throw new Error('Live performance minutes must be non-negative whole minutes');
 }
 return Math.min(10000, Math.floor(liveMinutes * 10000 / fullPayoutLiveMinutes));
}
export function liveRehearsalPayoutBps(verifiedSeconds, durationSeconds, verifiedStart) {
 if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 14400 ||
     !Number.isSafeInteger(verifiedSeconds) || verifiedSeconds < 0 || verifiedSeconds > durationSeconds ||
     typeof verifiedStart !== 'boolean' || !verifiedStart && verifiedSeconds !== 0) {
  throw new Error('Rehearsal requires valid whole seconds within the slot and an explicit verified start');
 }
 if (!verifiedStart) return 0;
 // Nine remaining tranches span three quarters of the slot: one every 1/12 slot.
 return Math.min(10000, (1 + Math.floor(verifiedSeconds * 12 / durationSeconds)) * 1000);
}
export function livePerformancePolicyText(b) {
 if (b.payoutPolicy === LIVE_PILOT_POLICY) {
  return `${b.airtimeMinutes} minutes of airtime. Guaranteed pilot fee: ${liveBookingMoney(b.amountUnits)}, regardless of coverage or technical outcome. Rehearsal only: 10% at verified start, then nine equal 10% steps, one every ${b.airtimeMinutes * 5} verified seconds; 100% at ${b.airtimeMinutes * 0.75} minutes (75% of the slot). No mid-show transfers.`;
 }
 return Number.isInteger(b.airtimeMinutes) && Number.isInteger(b.fullPayoutLiveMinutes)
  ? `${b.airtimeMinutes} minutes of airtime; full fee after ${b.fullPayoutLiveMinutes} live minutes; shorter sets earn the fee × live minutes ÷ ${b.fullPayoutLiveMinutes}, capped at the fee; no live minutes earns $0.`
  : '';
}
export function workReference(b) { return `decentbusking:live:v1:8453:${b.eventId}:${b.wallet.toLowerCase()}`; }
export function bookingGroup(b, now = Date.now()) {
 if (b.cancelled) return 'cancelled';
 if (['paid', 'refunded'].includes(b.status)) return 'completed';
 if (b.status === 'draft' && Date.parse(b.startUtc) <= now) return 'completed';
 if (b.status === 'draft') return 'draft';
 if (Date.parse(b.endUtc) <= now) return 'completed';
 return Date.parse(b.startUtc) <= now ? 'active' : 'upcoming';
}
export function claimState(b, escrowAddress, wallet, now = Date.now()) {
 if (b.mode !== 'phase1') return { enabled: false, label: 'Community-fund booking; ask the steward about payment after review' };
 if (!escrowAddress) return { enabled: false, label: 'Booking escrow is not configured' };
 if (String(wallet).toLowerCase() !== b.wallet.toLowerCase()) return { enabled: false, label: 'Connect performer wallet' };
 if (b.status === 'paid' || b.status === 'refunded') return { enabled: false, label: b.status === 'paid' ? 'Claimed' : 'Refunded' };
 if (['draft', 'failed', 'funding pending'].includes(b.status)) return { enabled: false, label: 'No confirmed escrow funding; no payment to claim' };
 if (now > Date.parse(b.claimDeadline)) return { enabled: false, label: 'Claim deadline passed; unclaimed funds require expiry/refund reconciliation' };
 const automaticAt = Date.parse(b.endUtc) + b.reviewWindow * 1000;
 const automatic = b.status === 'funded' && now >= automaticAt;
 const enabled = (b.status === 'approved' || automatic) && now <= Date.parse(b.claimDeadline);
 const automaticDate = new Intl.DateTimeFormat('en-US', {
  timeZone:'America/New_York', dateStyle:'medium', timeStyle:'short',
 }).format(new Date(automaticAt)) + ' ET';
 return { enabled, label: enabled ? 'Claim payment' : `Awaiting review; claim available automatically after ${automaticDate}` };
}
export function escapeLive(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
function liveBookingDate(value) {
 return new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', dateStyle:'medium', timeStyle:'short' }).format(new Date(value));
}
function liveBookingMoney(units) { return `$${(Number(units || 0) / 1e6).toFixed(2)} USDC`; }
export function liveBookingRows(bookings = [], { walletRenderer, now = Date.now() } = {}) {
 return bookings.map(b => {
  const status = b.cancelled ? 'Canceled' : b.status === 'draft' && Date.parse(b.startUtc) <= now ? 'Invitation expired · no confirmed funding'
   : b.acknowledged && b.status === 'draft' ? 'Accepted · awaiting funding'
   : ({ draft:'Draft invitation', funded:'Funded', approved:'Payment approved', paid:'Paid', refunded:'Refunded',
      'funding pending':'Funding pending', failed:'Needs review' }[b.status] || b.status);
  const terms = b.termsUri ? `<a href="${escapeLive(b.termsUri.replace('ipfs://','https://gateway.pinata.cloud/ipfs/'))}" target="_blank" rel="noopener noreferrer">📄 Read ${escapeLive(b.termsVersion)} terms</a>` : '';
  const policyText = livePerformancePolicyText(b);
  const policy = policyText ? `<p>🎙️ ${escapeLive(policyText)}</p>` : '';
  const additional = b.additionalOffer ? `<p>Outside performance escrow: ${escapeLive(b.additionalOffer)}</p>` : '';
  const performance = b.payoutPolicy === LIVE_PILOT_POLICY && b.decision
   ? `<p>Rehearsal: ${b.decision.verifiedSeconds} verified seconds, ${b.decision.rehearsalPayoutBps / 100}% simulated. Guaranteed fee decision: ${liveBookingMoney(b.approvedUnits)}; approval and claim still require confirmed transactions.</p>`
   : Number.isInteger(b.decision?.liveMusicMinutes)
   ? `<p>Verified live music: ${b.decision.liveMusicMinutes} minutes · approved ${liveBookingMoney(b.approvedUnits)}.</p>` : '';
  const transactions = Object.values(b.transactions || {}).filter(tx => tx?.hash).map(tx =>
   `<p>${escapeLive(tx.action || 'Transaction')} · ${escapeLive(tx.status || 'submitted')} · <a href="https://basescan.org/tx/${escapeLive(tx.hash)}" target="_blank" rel="noopener noreferrer">View receipt</a></p>`).join('');
  const technical = `<details class="live-booking-technical"><summary>Technical details</summary><p>Occurrence: <code>${escapeLive(b.eventId)}</code></p><p>Terms fingerprint: <code>${escapeLive(b.termsHash)}</code></p>${transactions}</details>`;
  return `<article class="live-booking" data-booking-id="${escapeLive(b.id)}"><header><strong>${escapeLive(b.displayName || b.ens || b.wallet)}</strong> · ${walletRenderer ? walletRenderer(b) : `<a href="https://basescan.org/address/${escapeLive(b.wallet)}" target="_blank" rel="noopener noreferrer">${escapeLive(b.ens || b.wallet)}</a>`} <span class="live-status">${escapeLive(status)}</span></header><p>🗓 ${escapeLive(liveBookingDate(b.startUtc))}–${escapeLive(new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', timeStyle:'short' }).format(new Date(b.endUtc)))} ET</p><p>💵 ${b.payoutPolicy === LIVE_PILOT_POLICY ? 'Guaranteed pilot fee' : 'Maximum fee'}: ${escapeLive(liveBookingMoney(b.amountUnits))} · ${b.mode === 'phase0' ? 'community fund (not escrowed)' : 'per-booking escrow; see confirmed funding status'}</p>${policy}${additional}${performance}${terms}<p>📅 Community calendar: ${escapeLive(b.scheduleStatus || 'Not linked yet')}${b.cancelled && b.cancellationReason ? ` · ${escapeLive(b.cancellationReason)}` : ''}</p>${b.reason ? `<p>📝 ${escapeLive(b.reason)}</p>` : ''}${b.remainderDisposition ? `<p>Remainder: ${escapeLive(b.remainderDisposition)}</p>` : ''}${technical}</article>`;
 }).join('');
}
