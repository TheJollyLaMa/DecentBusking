export const LIVE_FUND = 'dbusk-live-performers';
export const LIVE_ROUTER = '0x8ecca903e2a6Daa8CCbB933700e4F2C58C44A4B5';
export const LIVE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const LIVE_PERFORMANCE_AIRTIME_MINUTES = 20;
export const LIVE_PERFORMANCE_FULL_PAYOUT_MINUTES = 15;
export const LIVE_PERFORMANCE_FEE_UNITS = '20000000';
export const LIVE_NOTICE = 'Escrow keeps the booking fee locked until review; payout follows the agreed terms. Community-fund money is only earmarked, not escrowed, and may be recovered by the steward.';
export const DRAFT_TERMS = 'Offer v2 is a draft until its exact agreement is pinned and approved. The proposed set is 20 minutes of airtime for $20 USDC; 15 live-music minutes earns the full fee, shorter sets are prorated, and no live set earns $0. Platform outages and other exceptions must be written in the pinned agreement.';
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
export function workReference(b) { return `decentbusking:live:v1:8453:${b.eventId}:${b.wallet.toLowerCase()}`; }
export function bookingGroup(b, now = Date.now()) {
 if (b.cancelled) return 'cancelled';
 if (['paid', 'refunded'].includes(b.status)) return 'completed';
 if (b.status === 'draft') return 'draft';
 if (Date.parse(b.endUtc) <= now) return 'completed';
 return Date.parse(b.startUtc) <= now ? 'active' : 'upcoming';
}
export function claimState(b, escrowAddress, wallet, now = Date.now()) {
 if (b.mode !== 'phase1') return { enabled: false, label: 'Community-fund booking; ask the steward about payment after review' };
 if (!escrowAddress) return { enabled: false, label: 'Booking escrow is not configured' };
 if (String(wallet).toLowerCase() !== b.wallet.toLowerCase()) return { enabled: false, label: 'Connect performer wallet' };
 if (b.status === 'paid' || b.status === 'refunded') return { enabled: false, label: b.status === 'paid' ? 'Claimed' : 'Refunded' };
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
export function liveBookingRows(bookings = [], { walletRenderer } = {}) {
 return bookings.map(b => {
  const status = b.cancelled ? 'Canceled' : b.acknowledged && b.status === 'draft' ? 'Accepted · awaiting funding'
   : ({ draft:'Draft invitation', funded:'Funded', approved:'Payment approved', paid:'Paid', refunded:'Refunded',
      'funding pending':'Funding pending', failed:'Needs review' }[b.status] || b.status);
  const terms = b.termsUri ? `<a href="${escapeLive(b.termsUri.replace('ipfs://','https://gateway.pinata.cloud/ipfs/'))}" target="_blank" rel="noopener noreferrer">📄 Read ${escapeLive(b.termsVersion)} terms</a>` : '';
  const policy = Number.isInteger(b.airtimeMinutes) && Number.isInteger(b.fullPayoutLiveMinutes)
   ? `<p>🎙️ ${b.airtimeMinutes} minutes of airtime · full fee after ${b.fullPayoutLiveMinutes} live minutes · shorter sets earn the fee × live minutes ÷ ${b.fullPayoutLiveMinutes}, capped at the fee; no live minutes earns $0.</p>` : '';
  const performance = Number.isInteger(b.decision?.liveMusicMinutes)
   ? `<p>Verified live music: ${b.decision.liveMusicMinutes} minutes · approved ${liveBookingMoney(b.approvedUnits)}.</p>` : '';
  const transactions = Object.values(b.transactions || {}).filter(tx => tx?.hash).map(tx =>
   `<p>${escapeLive(tx.action || 'Transaction')} · ${escapeLive(tx.status || 'submitted')} · <a href="https://basescan.org/tx/${escapeLive(tx.hash)}" target="_blank" rel="noopener noreferrer">View receipt</a></p>`).join('');
  const technical = `<details class="live-booking-technical"><summary>Technical details</summary><p>Occurrence: <code>${escapeLive(b.eventId)}</code></p><p>Terms fingerprint: <code>${escapeLive(b.termsHash)}</code></p>${transactions}</details>`;
  return `<article class="live-booking" data-booking-id="${escapeLive(b.id)}"><header><strong>${escapeLive(b.displayName || b.ens || b.wallet)}</strong> · ${walletRenderer ? walletRenderer(b) : `<a href="https://basescan.org/address/${escapeLive(b.wallet)}" target="_blank" rel="noopener noreferrer">${escapeLive(b.ens || b.wallet)}</a>`} <span class="live-status">${escapeLive(status)}</span></header><p>🗓 ${escapeLive(liveBookingDate(b.startUtc))}–${escapeLive(new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', timeStyle:'short' }).format(new Date(b.endUtc)))} ET</p><p>💵 Maximum fee: ${escapeLive(liveBookingMoney(b.amountUnits))} · ${b.mode === 'phase0' ? 'community fund (not escrowed)' : 'protected in booking escrow'}</p>${policy}${performance}${terms}<p>📅 Community calendar: ${escapeLive(b.scheduleStatus || 'Not linked yet')}${b.cancelled && b.cancellationReason ? ` · ${escapeLive(b.cancellationReason)}` : ''}</p>${b.reason ? `<p>📝 ${escapeLive(b.reason)}</p>` : ''}${b.remainderDisposition ? `<p>Remainder: ${escapeLive(b.remainderDisposition)}</p>` : ''}${technical}</article>`;
 }).join('');
}
