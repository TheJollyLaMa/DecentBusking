export const LIVE_FUND = 'dbusk-live-performers';
export const LIVE_ROUTER = '0x8ecca903e2a6Daa8CCbB933700e4F2C58C44A4B5';
export const LIVE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const LIVE_NOTICE = 'Phase 0: earmarked, NOT escrowed. The admin can still recoverFund. Phase 1: escrow not deployed unless a configured contract is shown.';
export const DRAFT_TERMS = 'DRAFT v1 — pending steward approval. Agree the slot, soundcheck, minimum minutes, start tolerance, content rights, platform outage protection, recording opt-out, review window, partial/no-show rules, cancellation notice/kill fee, disputes, tips and taxes before acknowledging. Router deposits are earmarked, NOT escrowed; admin recoverFund remains possible. Example 72h review / 25% kill fee are proposals, not binding policy.';
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
 return ['DecentBusking Live Performance agreement v1', `Booking: ${b.id}`, `Performer: ${b.wallet}`, `Occurrence: ${b.eventId}`, `Slot: ${b.startUtc}/${b.endUtc}`, `Fee: ${b.amountUnits} USDC units on Base 8453`, `Mode: ${b.mode}`, `Terms: ${b.termsVersion} ${b.termsHash} ${b.termsUri}`, `Review: ${b.reviewWindow}s; cancellation window: ${b.cancellationWindow}s; kill fee: ${b.killFeeBps}bps`, `Claim deadline: ${b.claimDeadline}`, b.mode === 'phase0' ? 'Earmarked, NOT escrowed. Admin can recoverFund.' : 'Configured per-booking escrow.'].join('\n');
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
 if (b.mode !== 'phase1') return { enabled: false, label: 'Phase 0: earmarked, NOT escrowed; admin pays after review' };
 if (!escrowAddress) return { enabled: false, label: 'Escrow not deployed' };
 if (String(wallet).toLowerCase() !== b.wallet.toLowerCase()) return { enabled: false, label: 'Connect performer wallet' };
 if (b.status === 'paid' || b.status === 'refunded') return { enabled: false, label: b.status === 'paid' ? 'Claimed' : 'Refunded' };
 const automatic = b.status === 'funded' && now >= Date.parse(b.endUtc) + b.reviewWindow * 1000;
 const enabled = (b.status === 'approved' || automatic) && now <= Date.parse(b.claimDeadline);
 return { enabled, label: enabled ? 'Claim payment' : `Awaiting review; automatic after ${new Date(Date.parse(b.endUtc) + b.reviewWindow * 1000).toISOString()}` };
}
export function escapeLive(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
export function liveBookingRows(bookings = [], { walletRenderer } = {}) {
 return bookings.map(b => `<article class="live-booking" data-booking-id="${escapeLive(b.id)}"><strong>${escapeLive(b.displayName || b.ens || b.wallet)}</strong> · ${walletRenderer ? walletRenderer(b) : `<a href="https://basescan.org/address/${escapeLive(b.wallet)}" target="_blank" rel="noopener">${escapeLive(b.ens || b.wallet)}</a>`} · ${escapeLive(b.eventId)} · ${escapeLive(b.startUtc)}<p>${Number(b.amountUnits) / 1e6} USDC · <span class="live-status">${escapeLive(b.status)}</span>${b.cancelled ? ' · Cancelled: ' + escapeLive(b.cancellationReason) : ''} · ${b.mode === 'phase0' ? 'earmarked, NOT escrowed' : 'Phase 1 escrow'}</p><p>Approved: ${Number(b.approvedUnits || 0) / 1e6}; paid: ${Number(b.paidUnits || 0) / 1e6}; refund/remainder: ${Number(b.remainderUnits || b.refundUnits || 0) / 1e6} USDC. ${escapeLive(b.remainderDisposition || '')}</p><p>${escapeLive(b.reason || '')} ${escapeLive(b.reportUri || '')} Schedule: ${escapeLive(b.scheduleStatus || 'not linked')}; financial cancellation: ${escapeLive(b.financialStatus || 'none')}. ${escapeLive(b.error || '')}</p><a href="${escapeLive(b.termsUri?.replace('ipfs://','https://gateway.pinata.cloud/ipfs/'))}" target="_blank" rel="noopener">${escapeLive(b.termsVersion)} terms</a> <code>${escapeLive(b.termsHash)}</code>${Object.values(b.transactions || {}).map(tx => tx?.hash ? ` <a target="_blank" rel="noopener" href="https://basescan.org/tx/${escapeLive(tx.hash)}">${escapeLive(tx.action)}: ${escapeLive(tx.status)}</a>` : '').join('')}</article>`).join('');
}
