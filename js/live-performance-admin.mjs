import {
 LIVE_FUND, LIVE_ROUTER, LIVE_USDC, LIVE_ESCROW_ABI, LIVE_NOTICE, DRAFT_TERMS,
 LIVE_PERFORMANCE_AIRTIME_MINUTES, LIVE_PERFORMANCE_FULL_PAYOUT_MINUTES, LIVE_PERFORMANCE_FEE_UNITS,
 liveAuthorization, liveAcknowledgement, liveBookingRows, livePerformancePayoutBps, bookingGroup, escapeLive, workReference,
} from './live-bookings.mjs?v=20261022-live-offer-v2';
import { newYorkInputToUtc } from './radio-schedule-ui.mjs?v=20261022-action-badges';
import { isAdminWallet } from './admin-access.mjs';
import { publishLiveBookingState } from './live-booking-notifications.mjs?v=20261022-action-badges';

const routerAbi = [
 'function funds(bytes32) view returns (string metadataUri,bool active,bool exists)',
 'function createFund(bytes32,string)', 'function fundToken(bytes32,address,uint256)',
 'function recoverFund(bytes32,address,address,uint256)',
 'function completedWorkReferences(bytes32) view returns (bool)',
 'function payout(bytes32,address,address,uint256,bytes32,bytes32,bytes32,string,bytes32)',
];
const erc20Abi = ['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'];
const base = () => String(window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
const field = (name, label, value = '', type = 'text') => `<label>${label} <input name="${name}" type="${type}" value="${escapeLive(value)}" required></label>`;
let state;
let busy = false;
let section;
let accountRevision = 0;
async function api(body) {
 const response = await fetch(`${base()}/api/live-bookings`, body ? { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(body) } : { cache:'no-store' });
 const result = await response.json();
 if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
 publishLiveBookingState(result);
 return result;
}
async function wallet() {
 const ethers = window.ethers;
 const provider = new ethers.BrowserProvider(window.ethereum);
 const signer = await provider.getSigner();
 const address = await signer.getAddress();
 if (!isAdminWallet(address)) throw new Error('Connect the owner wallet');
 if ((await provider.getNetwork()).chainId !== 8453n) throw new Error('Switch to Base (8453) and retry');
 const revision = accountRevision;
 return { ethers, provider, signer, address, check: async () => {
   if (accountRevision !== revision || (await provider.getNetwork()).chainId !== 8453n || (await signer.getAddress()).toLowerCase() !== address.toLowerCase()) throw new Error('Wallet/network changed; refresh and reconcile any submitted transaction before retry');
 } };
}
async function command(input) {
 const w = await wallet();
 const command = { ...input, revision: state.revision };
 const body = { address: w.address, origin: location.origin, issuedAt: new Date().toISOString(), command };
 body.signature = await w.signer.signMessage(liveAuthorization(body));
 await w.check();
 state = await api(body);
 if (input.action === 'transaction') {
   const tx = state.bookings.find(b => b.id === input.id)?.transactions?.[input.txAction];
   if (['confirmed','reverted'].includes(tx?.status)) localStorage.removeItem(`live-pending:${input.id}:${input.txAction}`);
 }
 render();
 return state;
}
async function transaction(b, action, send) {
 const w = await wallet();
 await w.check();
 const tx = await send(w);
 localStorage.setItem(`live-pending:${b.id}:${action}`, tx.hash);
 await command({ action:'transaction', id:b.id, txAction:action, txHash:tx.hash });
 section.querySelector('[data-live-status]').textContent = `Pending ${tx.hash}. If interrupted, use Reconcile transaction; do not send again.`;
 const receipt = await tx.wait(2);
 await w.check();
 await command({ action:'transaction', id:b.id, txAction:action, txHash:receipt.hash || tx.hash });
 localStorage.removeItem(`live-pending:${b.id}:${action}`);
}
function render() {
 const rows = section.querySelector('[data-live-list]');
 section.querySelector('[data-live-capability]').textContent = state.escrowAddress
  ? '🔒 Per-booking escrow is ready on Base. Check the exact offer before sending any funds.'
  : '⚠️ Per-booking escrow is not configured. The community-fund option is earmarked, not protected escrow.';
 const accepted = state.bookings.filter(b => b.acknowledged && b.status === 'draft' && !b.cancelled);
 const notice = section.querySelector('[data-live-acceptance-notice]');
 notice.hidden = accepted.length === 0;
 notice.textContent = accepted.length
   ? `✅ ${accepted.map(b => `${b.displayName || b.wallet} accepted${b.acknowledgedAt ? ` at ${new Date(b.acknowledgedAt).toLocaleString()}` : ''}`).join(', ')}. Review the booking, then choose “Fund booking” to send the separate escrow payment. Acceptance did not move funds.`
   : '';
 rows.innerHTML = ['draft','upcoming','active','completed','cancelled'].map(group => {
  const bookings = state.bookings.filter(b => bookingGroup(b) === group);
  const labels = { draft:'📨 Invitations & drafts', upcoming:'🗓 Upcoming performances', active:'🔴 In progress',
   completed:'📚 Completed performances', cancelled:'❌ Canceled performances' };
  return `<details class="live-booking-group"${group === 'draft' ? ' open' : ''}><summary>${labels[group]} (${bookings.length})</summary>${bookings.length
   ? bookings.map(b => `${liveBookingRows([b])}<div data-live-actions="${escapeLive(b.id)}"><details class="live-booking-actions"><summary>🛠️ Booking actions</summary><div>${bookingActionButtons(b)}</div></details></div>`).join('')
   : '<p class="live-booking-empty">No bookings in this group.</p>'}</details>`;
 }).join('');
}
function bookingActionButtons(b) {
 const reviewActions = Number.isInteger(b.airtimeMinutes)
  ? [['review','🎙️ Record live minutes & calculate payout']]
  : [['full','✅ Approve full payment'], ['partial','🧮 Set a partial payment'], ['withhold','⛔ Withhold / reject payment']];
 const actions = [
  ['agreement','📨 Copy agreement text'], ['acknowledge','✅ Record performer acceptance (legacy)'],
  ['schedule','🗓 Add / retry calendar listing'], ['createFund','🏦 Create community fund'],
  ['fund','💵 Fund this booking'], ['reconcile','🔎 Check a pending transaction'],
  ...reviewActions, ['settle','💸 Send the recorded payment'],
  ['cancel','❌ Cancel this date'], ['recover','↩️ Return unused community-fund money'],
  ['financialCancel','🧾 Reconcile cancellation payment'],
 ];
 return actions.map(([action, label]) => `<button type="button" data-live-action="${action}">${label}</button>`).join('');
}
async function review(b, bps, cancellation = false) {
 let liveMusicMinutes;
 if (Number.isInteger(b.airtimeMinutes) && !cancellation) {
  const entered = prompt(`Verified live-music minutes (0–${b.airtimeMinutes}). ${b.fullPayoutLiveMinutes} minutes earns the full $${Number(b.amountUnits) / 1e6}; shorter sets are prorated. Enter 0 for no live performance.`);
  if (entered === null) return;
  if (!/^(0|[1-9]\d*)$/.test(entered) || Number(entered) > b.airtimeMinutes) throw new Error(`Enter a whole number from 0 to ${b.airtimeMinutes}`);
  liveMusicMinutes = Number(entered);
  bps = livePerformancePayoutBps(liveMusicMinutes, b.fullPayoutLiveMinutes);
 }
 const reason = prompt('Public review note: describe the set and the payout decision.');
 if (!reason) return;
 const reportUri = prompt('Link to the public performance report (pinned IPFS URI)');
 if (!reportUri) return;
 const reportHash = b.mode === 'phase0' ? prompt('Advanced: content fingerprint for the pinned report (bytes32)') : '';
 if (b.mode === 'phase0' && !/^0x[0-9a-fA-F]{64}$/.test(reportHash || '')) throw new Error('The pinned report fingerprint is required');
 const remainderDisposition = prompt('What should happen to the unpaid remainder? (e.g. keep for future shows or return to funder)');
 if (!remainderDisposition) return;
 await command({ action:'decision', id:b.id, payoutBps:bps, liveMusicMinutes, reason, reportUri, reportHash, remainderDisposition, cancellation });
}
async function action(name, b) {
 if (name === 'agreement') { prompt('Send the exact text to the performer for personal_sign; never request their private key.', liveAcknowledgement(b)); return; }
 if (name === 'review') await review(b, null);
 else if (name === 'acknowledge') {
   if (!confirm('Has the steward approved these exact immutable per-booking terms (not merely the DRAFT v1 proposal)?')) return;
   const performerSignature = prompt('Performer personal_sign signature of the exact acknowledgement message');
   if (performerSignature) await command({ action:'acknowledge', id:b.id, performerSignature, stewardApproved:true });
 } else if (name === 'schedule') await command({ action:'schedule', id:b.id });
 else if (name === 'createFund') {
   const metadataUri = prompt('Pinned immutable ipfs:// fund metadata URI (event, verified performer, fee, terms and earmarked limitation)');
   if (!/^ipfs:\/\/[a-zA-Z0-9]+/.test(metadataUri || '')) throw new Error('Pin reviewed metadata first. This panel does not pin production data automatically.');
   const w = await wallet();
   const router = new w.ethers.Contract(LIVE_ROUTER, routerAbi, w.signer);
   if ((await router.funds(w.ethers.id(LIVE_FUND))).exists) throw new Error('Fund already exists; do not create it again');
   await w.check();
   const tx = await router.createFund(w.ethers.id(LIVE_FUND), metadataUri);
   section.querySelector('[data-live-status]').textContent = `createFund pending: ${tx.hash}`;
   await tx.wait(2);
 } else if (name === 'fund') {
   if (!b.acknowledged || b.cancelled || ['funded','paid','refunded'].includes(b.status)) throw new Error('Requires acknowledged draft/failed booking, not a settled/cancelled booking');
   const pending = localStorage.getItem(`live-pending:${b.id}:funding`);
   if (pending || b.transactions.funding?.status === 'pending') throw new Error(`Funding already pending: ${pending || b.transactions.funding.hash}. Reconcile instead of resending.`);
   if (!confirm(`Fund ${Number(b.amountUnits)/1e6} USDC? ${b.mode === 'phase0' ? 'Earmarked, NOT escrowed; admin can recoverFund.' : 'Per-booking escrow.'}`)) return;
   const w = await wallet();
   const target = b.mode === 'phase1' ? state.escrowAddress : LIVE_ROUTER;
   if (!target) throw new Error('Escrow not deployed');
   const token = new w.ethers.Contract(LIVE_USDC, erc20Abi, w.signer);
   if (await token.allowance(w.address, target) < BigInt(b.amountUnits)) {
     const tx = await token.approve(target, b.amountUnits);
     await tx.wait(2);
   }
   await w.check();
   await transaction(b, 'funding', w => b.mode === 'phase0' ? new w.ethers.Contract(LIVE_ROUTER, routerAbi, w.signer).fundToken(w.ethers.id(LIVE_FUND), LIVE_USDC, b.amountUnits)
     : new w.ethers.Contract(state.escrowAddress, LIVE_ESCROW_ABI, w.signer).createBooking(w.ethers.id(b.id), b.wallet, b.amountUnits, Date.parse(b.startUtc)/1000, Date.parse(b.endUtc)/1000, Date.parse(b.claimDeadline)/1000, b.termsHash, b.termsUri, b.reviewWindow, b.cancellationWindow, b.killFeeBps));
 } else if (name === 'reconcile') {
   const txAction = prompt('Action: funding / payout / recovery / approve / claim / reject / cancel', 'funding');
   const txHash = prompt('Base transaction hash', localStorage.getItem(`live-pending:${b.id}:${txAction}`) || b.transactions[txAction]?.hash || '');
   if (txHash) await command({ action:'transaction', id:b.id, txAction, txHash });
 } else if (name === 'full') await review(b, 10000);
 else if (name === 'partial') { const percentage = Number(prompt('How much of the agreed fee should be paid? Enter a percentage from 1 to 99.')); if (Number.isInteger(percentage) && percentage > 0 && percentage < 100) await review(b, percentage * 100); }
 else if (name === 'withhold') await review(b, 0);
 else if (name === 'settle') {
   if (!b.decision) throw new Error('Record the completion decision first');
   if (b.mode === 'phase1') {
     await transaction(b, b.decision.payoutBps ? 'approve' : 'reject', w => {
       const contract = new w.ethers.Contract(state.escrowAddress, LIVE_ESCROW_ABI, w.signer);
       return b.decision.payoutBps ? contract.getFunction('approve(bytes32,uint16,string)')(w.ethers.id(b.id), b.decision.payoutBps, b.reportUri) : contract.reject(w.ethers.id(b.id), b.reportUri);
     });
   } else {
     if (!BigInt(b.approvedUnits || 0)) throw new Error('Withheld payment: no payout. Remainder stays earmarked; recovery requires separate owner operation.');
     const w = await wallet();
     const router = new w.ethers.Contract(LIVE_ROUTER, routerAbi, w.signer);
     if (await router.completedWorkReferences(w.ethers.id(workReference(b)))) throw new Error('Work reference already paid; reconcile receipt instead');
     const contributor = prompt('Approved contributor ID hash (bytes32) for the verified performer, from payroll registration');
     if (!/^0x[0-9a-fA-F]{64}$/.test(contributor || '')) throw new Error('Valid approved contributor hash required; register via payroll if needed');
     if (!confirm(`Pay ${Number(b.approvedUnits)/1e6} USDC via router? This is Phase 0 push-payment, not escrow claim.`)) return;
     await transaction(b, 'payout', w => router.payout(w.ethers.id(LIVE_FUND), LIVE_USDC, b.wallet, b.approvedUnits, w.ethers.id(workReference(b)), w.ethers.id('TheJollyLaMa/DecentBusking'), contributor, b.reportUri, b.reportHash));
   }
 } else if (name === 'recover') {
   if (b.mode !== 'phase0' || !b.decision || !BigInt(b.remainderUnits || 0)) throw new Error('Record a Phase 0 partial/withheld/cancellation decision with remainder first');
   if (b.transactions.recovery?.status === 'confirmed') throw new Error('Recovery already confirmed; do not repeat');
   if (localStorage.getItem(`live-pending:${b.id}:recovery`) || b.transactions.recovery?.status === 'pending') throw new Error('Recovery pending; reconcile original hash');
   if (confirm(`Recover ${Number(b.remainderUnits)/1e6} USDC to the original owner/funder? This is shared earmarked money, NOT a per-booking escrow refund. Check agreed remainder disposition first.`)) await transaction(b, 'recovery', w => new w.ethers.Contract(LIVE_ROUTER, routerAbi, w.signer).recoverFund(w.ethers.id(LIVE_FUND), LIVE_USDC, w.address, b.remainderUnits));
 } else if (name === 'cancel') {
   const reason = prompt('PUBLIC cancellation reason (schedule only; financial consequences handled separately)');
   if (reason && confirm('Cancel ONLY this dated occurrence? Radio continues. Financial cancellation/refund is a separate step.')) await command({ action:'cancel', id:b.id, reason, confirm:true });
 } else if (name === 'financialCancel') {
   if (!b.cancelled) throw new Error('Cancel the schedule occurrence first');
   if (b.mode === 'phase0') {
     if (!confirm(`Record agreed cancellation consequence: ${Number(b.cancellationFeeUnits || 0)/1e6} USDC kill fee? No funds move now; execute fee payment and recovery separately only after reviewing the report/disposition.`)) return;
     const bps = BigInt(b.cancellationFeeUnits || 0) > 0n ? b.killFeeBps : 0;
     await review(b, bps, true);
     return;
   }
   const reasonUri = prompt('Pinned ipfs:// public cancellation report');
   if (reasonUri) await transaction(b, 'cancel', w => new w.ethers.Contract(state.escrowAddress, LIVE_ESCROW_ABI, w.signer).cancel(w.ethers.id(b.id), reasonUri));
 }
}
async function guarded(fn) {
 if (busy) return;
 busy = true;
 try {
  const result = await fn();
  section.querySelector('[data-live-status]').textContent = typeof result === 'string'
   ? result : 'Action completed. Refresh to verify the latest booking state.';
 }
 catch (error) { section.querySelector('[data-live-status]').textContent = `${error.shortMessage || error.message}. Refresh/reconcile before retrying; submitted transactions may still be pending.`; }
 finally { busy = false; }
}
function mount() {
 const parent = document.getElementById('admin-role-section')?.parentElement;
 if (!parent || section) return;
 section = document.createElement('details');
 section.className = 'live-performance-admin';
 section.innerHTML = `<summary class="live-performance-admin-summary"><span>🎤 Live Performance</span><small>Invitations, schedule listings, and payment review</small></summary>
 <div class="live-performance-admin-content">
 <p>${LIVE_NOTICE}</p><p data-live-capability></p>
 <ol class="live-performance-flow"><li>📝 Review the offer and pinned terms.</li><li>📨 Add the date to the community calendar; only the invited wallet can accept.</li><li>✅ Acceptance appears here. Funding is always a separate owner action.</li><li>🎙️ After the show, record live minutes and calculate the payout.</li></ol>
 <aside class="live-performance-offer"><strong>💵 Current offer: $${Number(LIVE_PERFORMANCE_FEE_UNITS) / 1e6} USDC</strong><span>🗓 ${LIVE_PERFORMANCE_AIRTIME_MINUTES}-minute calendar event</span><span>🎵 ${LIVE_PERFORMANCE_FULL_PAYOUT_MINUTES} live-music minutes earns the full fee; shorter sets are prorated, capped at $${Number(LIVE_PERFORMANCE_FEE_UNITS) / 1e6}.</span><span>🚫 No live performance earns $0.</span></aside>
 <p class="live-performance-draft-note">${DRAFT_TERMS}</p>
 <details class="live-create-details" open><summary>➕ Prepare a performance invitation</summary><form data-live-create>
 ${field('performer','Performer wallet or ENS')}${field('displayName','Name shown on the calendar')}${field('discordHandle','Discord name (if agreed public)')}${field('title','Show title','Friday Live Performance')}
 ${field('startLocal','Start time (America/New_York)','2026-10-23T21:00','datetime-local')}
 <p class="live-performance-form-note">The event lasts 20 minutes; its end time is calculated from the start. Current fee is fixed at $20 USDC on Base.</p>
 <input name="fee" type="hidden" value="${Number(LIVE_PERFORMANCE_FEE_UNITS) / 1e6}"><input name="airtimeMinutes" type="hidden" value="${LIVE_PERFORMANCE_AIRTIME_MINUTES}">
 <input name="fullPayoutLiveMinutes" type="hidden" value="${LIVE_PERFORMANCE_FULL_PAYOUT_MINUTES}">
 <label>Payment handling<select name="mode"><option value="phase1">🔒 Protected booking escrow (recommended)</option><option value="phase0">🏦 Community fund (earmarked, not escrowed)</option></select></label>
 <label>Review period after the show (hours)<input name="reviewWindowHours" type="number" value="24" min="1" max="8760" step="1" required></label>
 <label>Late-cancellation notice (hours)<input name="cancellationWindowHours" type="number" value="8" min="0" max="8760" step="1" required></label>
 <label>Late-cancellation fee (%)<input name="killFeePercent" type="number" value="50" min="0" max="100" step="1" required></label>
 <p class="live-performance-form-note">The performer’s claim deadline is set automatically to three days after the review window closes.</p>
 <details class="live-advanced-terms"><summary>📎 Pinned agreement details (advanced)</summary><p>Use the exact v2 agreement link and fingerprint after it is pinned. A CID alone is accepted and saved as an ipfs:// URI. Do not reuse v1: it describes a 60-minute show.</p>
 ${field('termsVersion','Agreement version','LIVE PERFORMANCE v2 — draft')}${field('termsUri','Pinned agreement IPFS link')}${field('termsHash','Agreement verification fingerprint')}</details>
 <label class="live-performance-approval"><input name="stewardApproved" type="checkbox"> I approve these exact pinned terms for this performer and date.</label>
 <button type="submit">📝 Save invitation draft (no payment)</button></form></details>
 <button type="button" data-live-refresh>🔄 Refresh bookings</button><p class="live-performance-acceptance" role="alert" aria-live="assertive" data-live-acceptance-notice hidden></p><p role="status" data-live-status></p><div data-live-list></div></div>`;
 parent.append(section);
 section.querySelector('[data-live-refresh]').onclick = () => guarded(async () => {
  state = await api();
  render();
  return `Bookings refreshed from the service. ${state.bookings.length} booking${state.bookings.length === 1 ? '' : 's'} found.`;
 });
 section.querySelector('form').onsubmit = event => { event.preventDefault(); guarded(async () => {
   const f = Object.fromEntries(new FormData(section.querySelector('form')));
   if (!state) state = await api();
   const startUtc = newYorkInputToUtc(f.startLocal);
   const eventId = `friday-live-performance:${f.startLocal.slice(0,10)}`;
   const reviewWindow = Math.round(Number(f.reviewWindowHours) * 3600);
   const cancellationWindow = Math.round(Number(f.cancellationWindowHours) * 3600);
   const termsUri = /^b[a-zA-Z0-9]{20,}$/.test(f.termsUri.trim()) ? `ipfs://${f.termsUri.trim()}` : f.termsUri.trim();
   const endUtc = new Date(Date.parse(startUtc) + Number(f.airtimeMinutes) * 60_000).toISOString();
   const booking = { ...f, eventId, airtimeMinutes:Number(f.airtimeMinutes),
   fullPayoutLiveMinutes:Number(f.fullPayoutLiveMinutes), stewardApproved:f.stewardApproved === 'on',
   termsUri,
   startUtc, endUtc,
   claimDeadline:new Date(Date.parse(endUtc) + reviewWindow * 1000 + 3 * 86400_000).toISOString(),
   amountUnits:window.ethers.parseUnits(f.fee,6).toString(),
   reviewWindow,
   cancellationWindow,
   killFeeBps:Math.round(Number(f.killFeePercent) * 100) };
   delete booking.startLocal;
   delete booking.fee;
   delete booking.reviewWindowHours;
   delete booking.cancellationWindowHours;
   delete booking.killFeePercent;
   const id = `${eventId}:${crypto.randomUUID()}`;
   await command({ action:'create', id, booking });
   return `Invitation draft saved for ${booking.displayName || booking.wallet}. It is not funded or listed on the community calendar yet.`;
 }); };
 section.onclick = event => { const button = event.target.closest('[data-live-action]'); if (!button) return; const id = button.closest('[data-live-actions]').dataset.liveActions; guarded(() => action(button.dataset.liveAction,state.bookings.find(b=>b.id===id))); };
 window.ethereum?.on?.('accountsChanged', () => { accountRevision++; });
 window.ethereum?.on?.('chainChanged', () => { accountRevision++; });
 guarded(async () => { state = await api(); render(); });
 document.addEventListener('live-booking-state-updated', event => {
   if (busy || !isAdminWallet(window._wallet?.address)) return;
   state = event.detail.state;
   render();
 });
 document.addEventListener('live-booking-notification-error', event => {
   if (!isAdminWallet()) return;
   section.querySelector('[data-live-status]').textContent = `Could not refresh performer acceptance status: ${event.detail.message}`;
 });
}
if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount(); }
