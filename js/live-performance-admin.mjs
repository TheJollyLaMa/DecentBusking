import { LIVE_FUND, LIVE_ROUTER, LIVE_USDC, LIVE_ESCROW_ABI, LIVE_NOTICE, DRAFT_TERMS, liveAuthorization, liveAcknowledgement, liveBookingRows, bookingGroup, escapeLive, workReference } from './live-bookings.mjs';
import { newYorkInputToUtc } from './radio-schedule-ui.mjs';
import { isAdminWallet } from './admin-access.mjs';

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
 section.querySelector('[data-live-capability]').textContent = state.escrowAddress ? `Phase 1 configured: ${state.escrowAddress} (Base). Verify deployment/code before funding.` : 'Phase 1: escrow not deployed. Use Phase 0 earmarked router funding.';
 rows.innerHTML = ['draft','upcoming','active','completed','cancelled'].map(group => `<details open><summary>${group}</summary>${state.bookings.filter(b => bookingGroup(b) === group).map(b => liveBookingRows([b]) + `<div data-live-actions="${escapeLive(b.id)}">${[
 ['agreement','Show acknowledgement message'], ['acknowledge','Record approved terms + performer acknowledgement'], ['schedule','Link / retry schedule occurrence'],
 ['createFund','Create Live Performers fund (owner signs)'], ['fund','Fund booking (owner signs)'], ['reconcile','Reconcile transaction'],
 ['full','Approve full payment'], ['partial','Approve partial payment'], ['withhold','Withhold / reject payment'], ['settle','Execute recorded payment decision'],
 ['cancel','Cancel live performance'], ['recover','Recover agreed remainder (Phase 0)'], ['financialCancel','Reconcile financial cancellation'],
 ].map(([action,label]) => `<button type="button" data-live-action="${action}">${label}</button>`).join('')}</div>`).join('')}</details>`).join('');
}
async function review(b, bps, cancellation = false) {
 const reason = prompt('Required PUBLIC reason (including full approval)');
 if (!reason) return;
 const reportUri = prompt('Required pinned ipfs:// performance report');
 if (!reportUri) return;
 const reportHash = b.mode === 'phase0' ? prompt('Keccak256 hash of the exact pinned report content (bytes32)') : '';
 if (b.mode === 'phase0' && !/^0x[0-9a-fA-F]{64}$/.test(reportHash || '')) throw new Error('Exact pinned report content hash required');
 const remainderDisposition = prompt('Required remainder disposition (e.g. remains earmarked for future shows / refund to original funder)');
 if (!remainderDisposition) return;
 await command({ action:'decision', id:b.id, payoutBps:bps, reason, reportUri, reportHash, remainderDisposition, cancellation });
}
async function action(name, b) {
 if (name === 'agreement') { prompt('Send the exact text to the performer for personal_sign; never request their private key.', liveAcknowledgement(b)); return; }
 if (name === 'acknowledge') {
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
 else if (name === 'partial') { const bps = Number(prompt('Payout basis points (1–9999, 5000 = 50%)')); if (bps > 0 && bps < 10000) await review(b, bps); }
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
 try { await fn(); section.querySelector('[data-live-status]').textContent = 'Saved / confirmed. Refresh to reconcile on-chain evidence.'; }
 catch (error) { section.querySelector('[data-live-status]').textContent = `${error.shortMessage || error.message}. Refresh/reconcile before retrying; submitted transactions may still be pending.`; }
 finally { busy = false; }
}
function mount() {
 const parent = document.getElementById('admin-role-section')?.parentElement;
 if (!parent || section) return;
 section = document.createElement('section');
 section.className = 'live-performance-admin';
 section.innerHTML = `<h2>🎤 Live Performance</h2><p>${LIVE_NOTICE}</p><p data-live-capability></p><p>${DRAFT_TERMS}</p><form data-live-create>
 ${field('performer','Wallet / ENS')}${field('displayName','Public performer name')}${field('discordHandle','Discord handle')}${field('title','Show title','Friday Live Performance')}
 ${field('eventId','Dated occurrence ID','friday-live-performance:2026-10-23')}${field('startLocal','Start (America/New_York)','2026-10-23T21:00','datetime-local')}${field('endLocal','End (America/New_York)','2026-10-23T22:00','datetime-local')}
 ${field('fee','Fee (USDC, Base 8453)','20','number')}<label>Mode <select name="mode"><option value="phase0">Phase 0 — earmarked, NOT escrowed</option><option value="phase1">Phase 1 — requires configured escrow</option></select></label>
 ${field('termsVersion','Terms version','DRAFT v1 — pending steward approval')}${field('termsUri','Pinned terms ipfs:// URI')}${field('termsHash','Exact terms keccak256 hash')}
 ${field('reviewWindow','Review window seconds (proposal, agree per booking)','259200','number')}${field('cancellationWindow','Cancellation window seconds (proposal)','172800','number')}${field('killFeeBps','Kill fee basis points (proposal)','2500','number')}${field('claimDeadline','Claim deadline (New York)','2026-11-23T22:00','datetime-local')}
 <button>Create draft booking — saves only, no chain transaction</button></form><button type="button" data-live-refresh>Refresh bookings</button><p role="status" data-live-status></p><div data-live-list></div>`;
 parent.append(section);
 section.querySelector('[data-live-refresh]').onclick = () => guarded(async () => { state = await api(); render(); });
 section.querySelector('form').onsubmit = event => { event.preventDefault(); guarded(async () => {
   const f = Object.fromEntries(new FormData(section.querySelector('form')));
   if (!state) state = await api();
   const booking = { ...f, startUtc:newYorkInputToUtc(f.startLocal), endUtc:newYorkInputToUtc(f.endLocal), claimDeadline:newYorkInputToUtc(f.claimDeadline), amountUnits:window.ethers.parseUnits(f.fee,6).toString() };
   const id = `${f.eventId}:${window.ethers.id(`${f.performer}:${booking.startUtc}`).slice(2,14)}`;
   await command({ action:'create', id, booking });
 }); };
 section.onclick = event => { const button = event.target.closest('[data-live-action]'); if (!button) return; const id = button.closest('[data-live-actions]').dataset.liveActions; guarded(() => action(button.dataset.liveAction,state.bookings.find(b=>b.id===id))); };
 window.ethereum?.on?.('accountsChanged', () => { accountRevision++; });
 window.ethereum?.on?.('chainChanged', () => { accountRevision++; });
 guarded(async () => { state = await api(); render(); });
}
if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount(); }
