import {
 LIVE_FUND, LIVE_ROUTER, LIVE_USDC, LIVE_ESCROW_ABI, LIVE_NOTICE, LIVE_APPROVED_TERMS_V2,
 LIVE_PERFORMANCE_AIRTIME_MINUTES, LIVE_PERFORMANCE_FULL_PAYOUT_MINUTES, LIVE_PERFORMANCE_FEE_UNITS,
 LIVE_PILOT_POLICY, LIVE_PILOT_TERMS_VERSION, LIVE_PILOT_COMPANION_OFFER, livePerformancePolicyText, liveRehearsalPayoutBps,
 LIVE_ASSET_VERSION, LIVE_ASSET_POLICY, LIVE_ASSET_ESCROW_ABI, LIVE_ZERO_ADDRESS, assetBookingTerms, matchesAssetBooking, formatLiveAsset,
 liveAuthorization, liveAcknowledgement, liveBookingRows, livePerformancePayoutBps, bookingGroup, escapeLive, workReference,
} from './live-bookings.mjs?v=20261108-live-audio-pilot';
import { newYorkInputToUtc } from './radio-schedule-ui.mjs?v=20261025-community-reminder';
import { utcToNewYorkInput } from './radio-calendar.mjs';
import { isAdminWallet } from './admin-access.mjs';
import { publishLiveBookingState } from './live-booking-notifications.mjs?v=20261113-one-action-release';
import { liveAudioRoomUrl } from './live-audio.mjs?v=20261114-allocated-stage';
import { afterpartyRows } from './live-afterparty.mjs?v=20261117-release-party';
import { guaranteedReleaseState, guidedGuaranteedRelease, liveBroadcastCompletionPending } from './live-escrow-release.mjs?v=20261115-afterparty';
// Approved and pinned 2026-11-20; the hash is keccak256 of the exact pinned bytes.
export const LIVE_ASSET_TERMS_V1 = Object.freeze({ version:'LIVE PERFORMANCE ASSETS v1',
  uri:'ipfs://bafkreiayf2eh66dr2v22thqv6ygwwdothxdzphfgyeinhdiquiuvas442m',
  hash:'0x730ca56b2c511b3e5af825f125d79a541a88a27f3e9fa13250c9f25eedd66509' });

const routerAbi = [
 'function funds(bytes32) view returns (string metadataUri,bool active,bool exists)',
 'function createFund(bytes32,string)', 'function fundToken(bytes32,address,uint256)',
 'function recoverFund(bytes32,address,address,uint256)',
 'function completedWorkReferences(bytes32) view returns (bool)',
 'function payout(bytes32,address,address,uint256,bytes32,bytes32,bytes32,string,bytes32)',
];
const erc20Abi = ['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'];
const marketListingAbi = ['function nextListingId() view returns(uint256)',
 'function getListing(uint256) view returns ((address nftContract,uint256 tokenId,uint256 priceETH,address priceToken,uint256 priceAmount,uint256 available,bool active,string note))'];
// Gift editions come from the funding wallet. Public listings of the same edition may stay
// active only while the Market itself still holds every listed edition (no oversell).
export async function assertGiftListingsBacked(market, nft, gift) {
 const total = await market.nextListingId();
 if (total > 2000n) throw new Error('Too many Market listings to verify safely; funding is unavailable');
 let listed = 0n;
 for (let start = 0; start < Number(total); start += 20) {
   const listings = await Promise.all(Array.from({ length:Math.min(20,Number(total)-start) }, (_,i) => market.getListing(start+i)));
   for (const item of listings) {
     if (item.active && item.nftContract.toLowerCase() === gift.collection.toLowerCase() && item.tokenId === BigInt(gift.tokenId)) listed += BigInt(item.available);
   }
 }
 if (listed > 0n && await nft.balanceOf(market.target, gift.tokenId) < listed) {
   throw new Error('Active Market listings for this edition are not fully stocked by the Market; reconcile sold inventory before funding');
 }
}
export function liveOccurrenceId(startLocal, bookings = []) {
 const date = startLocal.slice(0,10);
 const base = `friday-live-performance:${date}`;
 return bookings.some(b => b.eventId === base && !b.cancelled)
   ? `friday-live-performance-${startLocal.slice(11,16).replace(':','')}:${date}` : base;
}
export function overlappingLiveBooking(bookings = [], startUtc, endUtc) {
 const start = Date.parse(startUtc), end = Date.parse(endUtc);
 return bookings.find(b => !b.cancelled && Date.parse(b.startUtc) < end && start < Date.parse(b.endUtc)) || null;
}
const base = () => String(window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
export function nextFridayLiveStart(now = Date.now()) {
 const localDate = utcToNewYorkInput(new Date(now).toISOString()).slice(0, 10);
 const date = new Date(`${localDate}T12:00:00Z`);
 date.setUTCDate(date.getUTCDate() + (5 - date.getUTCDay() + 7) % 7);
 let value = `${date.toISOString().slice(0, 10)}T21:00`;
 if (Date.parse(newYorkInputToUtc(value)) <= now) {
   date.setUTCDate(date.getUTCDate() + 7);
   value = `${date.toISOString().slice(0, 10)}T21:00`;
 }
 return value;
}
const field = (name, label, value = '', type = 'text') => `<label>${label} <input name="${name}" type="${type}" value="${escapeLive(value)}" required></label>`;
function renderAfterpartyStatus(b, now) {
 if (b.mode !== 'phase1' || b.payoutPolicy !== LIVE_PILOT_POLICY) return '';
 const rows = afterpartyRows(b, { audience: 'admin', now });
 return `<details class="live-afterparty-checklist" open><summary>Show, fee and recording status</summary><ol>${rows.map(row =>
  `<li data-state="${escapeLive(row.state)}"><strong>${escapeLive(row.label)}: ${escapeLive(row.text)}</strong>${row.detail ? `<p>${escapeLive(row.detail)}</p>` : ''}${row.next ? `<p class="live-afterparty-next">Next: ${escapeLive(row.next)}</p>` : ''}${row.links.map(link =>
   `<a href="${escapeLive(link.href)}" target="_blank" rel="noopener noreferrer">${escapeLive(link.label)}</a>`).join('')}</li>`).join('')}</ol></details>`;
}
let state;
let busy = false;
let section;
let accountRevision = 0;
const pendingReleaseHashes = new Map();
export function applyConfirmedRelease(card, result) {
 const button = card?.querySelector('[data-live-action="release"]');
 if (button) { button.disabled = true; button.textContent = 'Approved · performer can claim'; }
 const report = card?.querySelector('[data-live-release-report]');
 if (report && /^ipfs:\/\/[a-zA-Z0-9]+$/.test(result.reportUri || '')) {
  report.href = `https://gateway.pinata.cloud/ipfs/${result.reportUri.slice('ipfs://'.length)}`;
  report.hidden = false; report.target = '_blank'; report.rel = 'noopener';
 }
}
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
 document.dispatchEvent(new CustomEvent('live-booking-transaction-updated'));
 await command({ action:'transaction', id:b.id, txAction:action, txHash:tx.hash });
 section.querySelector('[data-live-status]').textContent = `Pending ${tx.hash}. If interrupted, use Reconcile transaction; do not send again.`;
 const receipt = await tx.wait(2);
 await w.check();
 await command({ action:'transaction', id:b.id, txAction:action, txHash:receipt.hash || tx.hash });
 localStorage.removeItem(`live-pending:${b.id}:${action}`);
 document.dispatchEvent(new CustomEvent('live-booking-transaction-updated'));
}
function render() {
 const rows = section.querySelector('[data-live-list]');
 const assetOption = section.querySelector('[name="payoutPolicy"] option[value="asset-guaranteed-v1"]');
 if (assetOption) assetOption.disabled = !state.assetBookingCreationEnabled;
 section.querySelector('[data-live-capability]').textContent = (state.escrowAddress
  ? '🔒 Legacy USDC booking escrow is configured on Base.'
  : '⚠️ Legacy booking escrow is not configured; community-fund money is only earmarked.') +
  (state.assetBookingCreationEnabled ? ' Fixed-asset booking invitations are enabled; check exact terms before funding.'
   : state.assetEscrowConfigured ? ' New asset invitations are disabled; existing assets remain available for reconciliation.'
   : ' Fixed-asset bookings are unavailable.');
 const accepted = state.bookings.filter(b => b.acknowledged && b.status === 'draft' && !b.cancelled && Date.parse(b.startUtc) > Date.now());
 const notice = section.querySelector('[data-live-acceptance-notice]');
 notice.hidden = accepted.length === 0;
 notice.textContent = accepted.length
   ? `✅ ${accepted.map(b => `${b.displayName || b.wallet} accepted${b.acknowledgedAt ? ` at ${new Date(b.acknowledgedAt).toLocaleString()}` : ''}`).join(', ')}. Review the booking, then choose “Fund booking” to send the separate escrow payment. Acceptance did not move funds.`
   : '';
 rows.innerHTML = ['draft','upcoming','active','completed','cancelled'].map(group => {
  const bookings = state.bookings.filter(b => (b.broadcastCompletion?.known && b.broadcastCompletion.pending &&
    !b.cancelled && Date.parse(b.startUtc) <= Date.now() ? 'active' : bookingGroup(b)) === group);
  const labels = { draft:'📨 Invitations & drafts', upcoming:'🗓 Upcoming performances', active:'🔴 In progress',
   completed:'📚 Past contract windows & completed performances', cancelled:'❌ Canceled performances' };
  const releaseDue = bookings.some(b => { const release = guaranteedReleaseState(b); return release && !release.disabled; });
  return `<details class="live-booking-group"${group === 'draft' || releaseDue ? ' open' : ''}><summary>${labels[group]} (${bookings.length})</summary>${bookings.length
   ? bookings.map(b => renderLivePerformanceAdminBooking(b)).join('')
   : '<p class="live-booking-empty">No bookings in this group.</p>'}</details>`;
 }).join('');
}
export function renderLivePerformanceAdminBooking(b, now = Date.now()) {
 const roomUrl = liveAudioRoomUrl(b, now) || (b.broadcastCompletion?.known && b.broadcastCompletion?.pending &&
   b.mode === 'phase1' && [LIVE_PILOT_POLICY, LIVE_ASSET_POLICY].includes(b.payoutPolicy) && b.stewardApproved && b.acknowledged && !b.cancelled
   ? `live-room.html?booking=${encodeURIComponent(b.id)}` : null);
 const room = roomUrl ? `<p><a data-live-room="operator" href="${escapeLive(roomUrl)}">Open operator audio room</a> · <a data-live-desk href="producer-room.html?booking=${encodeURIComponent(b.id)}">Open production desk</a><br><small>This link does not grant access. Authorize with the configured owner wallet; publishing remains performer-only. Hosting may be unavailable. Private checks open at T−70 minutes. Desk passes and private messages are live-session only; cues do not extend the booking.</small></p>` : '';
 const release = guaranteedReleaseState(b, now);
 const pending = typeof localStorage !== 'undefined' && localStorage.getItem(`live-pending:${b.id}:approve`);
 const releaseCard = release ? `<section class="live-release-card" aria-label="Guaranteed performer fee">
  <h3>Guaranteed performer fee · $${(Number(b.amountUnits) / 1e6).toFixed(2)} USDC</h3>
  <p>Base escrow → ${escapeLive(b.displayName || 'Performer')}<br><small>${escapeLive(b.wallet)}</small></p>
  <button type="button" class="live-release-primary" data-live-action="release"${release.disabled && !pending ? ' disabled' : ''}>${escapeLive(pending ? 'Check pending escrow release' : release.disabled ? release.label : 'Release the full guaranteed fee')}</button>
  <p>${escapeLive(release.detail)}</p>
  <p>Clicking release publishes a minimal public fee report. Confirm the wallet upload signature and escrow approval transaction; never share your private key.</p>
  <ol data-live-release-checks aria-label="Guaranteed fee release checks"></ol>
  <a data-live-release-report${b.reportUri ? ` href="https://gateway.pinata.cloud/ipfs/${escapeLive(b.reportUri.replace(/^ipfs:\/\//, ''))}" target="_blank" rel="noopener"` : ' hidden'}>Read public fee report</a>
  <output data-live-release-status role="status" aria-live="polite"></output>
  </section>` : '';
 return `${liveBookingRows([b])}${renderLiveBroadcastCompletion(b)}${renderAfterpartyStatus(b, now)}${room}<div data-live-actions="${escapeLive(b.id)}">${releaseCard}<details class="live-booking-actions"><summary>${release ? 'Advanced · booking & manual review' : '🛠️ Booking actions'}</summary><div>${bookingActionButtons(b)}</div></details></div>`;
}
export function renderLiveBroadcastCompletion(b) {
 if (!Object.hasOwn(b, 'broadcastCompletion')) return '';
 const completion = b.broadcastCompletion;
 const reasons = { 'producer-finished': 'Performer finished at the song-boundary ending.',
  'operator-cut': 'Interrupted by an owner cut.', 'authorization-expired': 'Authorized airtime expired.',
  'audio-loss': 'Interrupted after audio loss.', declined: 'Performer declined this slot.', 'not-ready': 'Performer was not ready for this slot.' };
 const detail = completion?.known !== true ? 'Stage completion is unavailable. New review/release actions are paused until it can be verified.'
  : completion.pending ? 'The allocated stage is not finished. The original contract end is not proof of actual completion.'
    : Number.isFinite(completion.actualEndedAt)
      ? `Actual stage ended ${new Date(completion.actualEndedAt).toISOString()}. ${reasons[completion.endReason] || 'Ending reason not provided.'}`
      : 'No allocated-stage completion is reported; the original contract workflow remains in effect.';
 return `<section class="live-stage-completion" aria-label="Actual stage completion"><h3>Actual stage completion · separate from payment</h3>
  <p>${escapeLive(detail)}</p><p>Original guaranteed fee, signed start/end and contract review/claim times are unchanged. A delay, shortened set, decline or interrupted broadcast does not forfeit the guarantee. Existing confirmed chain transactions remain valid; reconcile them rather than sending duplicates.</p>
  ${completion?.priorityFollowup === true ? '<p>Priority invitation follow-up requested. This is not a new booking, performer acceptance or funding.</p>' : ''}</section>`;
}
function bookingActionButtons(b) {
 if (b.escrowVersion === LIVE_ASSET_VERSION) return [
  ['agreement','📨 Copy agreement text'], ['schedule','🗓 Add / retry calendar listing'],
  ['fund','💵 Fund exact fee and reserve gift'], ['assetApprove','✅ Approve performance'],
  ['giftRelease','🎁 Release approved gift'], ['assetFault','⚠️ Platform fault / cancellation'],
  ['assetNoShow','No-show (review window)'], ['assetUnperformed','Return unperformed gift decision'],
  ['assetRefund','Return refundable fee'], ['giftReturn','Return unearned gift'],
  ['cancel','❌ Cancel schedule only'], ['reconcile','🔎 Check a pending transaction'],
 ].map(([action,label]) => `<button type="button" data-live-action="${action}">${label}</button>`).join('');
 const pilot = b.payoutPolicy === LIVE_PILOT_POLICY;
 const reviewActions = pilot ? [['review','Record rehearsal & approve guaranteed fee']] : Number.isInteger(b.airtimeMinutes)
  ? [['review','🎙️ Record live minutes & calculate payout']]
  : [['full','✅ Approve full payment'], ['partial','🧮 Set a partial payment'], ['withhold','⛔ Withhold / reject payment']];
 const actions = [
  ...(b.broadcastCompletion?.known === true && b.broadcastCompletion?.pending === false &&
    Number.isFinite(b.broadcastCompletion?.actualEndedAt) &&
    b.broadcastCompletion?.priorityFollowup === true && !b.priorityInvitation
    ? [['priorityInvite','Prepare next-week priority invitation']] : []),
  ['agreement','📨 Copy agreement text'], ['acknowledge','✅ Record performer acceptance (legacy)'],
  ['schedule','🗓 Add / retry calendar listing'], ['createFund','🏦 Create community fund'],
  ['fund','💵 Fund this booking'], ['reconcile','🔎 Check a pending transaction'],
  ...reviewActions, ['settle','💸 Send the recorded payment'],
  ['cancel','❌ Cancel this date'], ['recover','↩️ Return unused community-fund money'],
  ['financialCancel','🧾 Reconcile cancellation payment'],
 ];
 return actions.filter(([action]) => !pilot || !['financialCancel', 'recover', 'createFund'].includes(action))
  .map(([action, label]) => `<button type="button" data-live-action="${action}"${liveBroadcastCompletionPending(b) &&
    ['review', 'full', 'partial', 'withhold', 'settle'].includes(action) ? ' disabled' : ''}>${label}</button>`).join('');
}
async function review(b, bps, cancellation = false) {
 let liveMusicMinutes;
 let verifiedSeconds;
 let verifiedStart;
 if (b.payoutPolicy === LIVE_PILOT_POLICY) {
  const entered = prompt(`Verified live-audio seconds within the ${b.airtimeMinutes}-minute slot (0–${b.airtimeMinutes * 60}). Rehearsal only: the full $20 pilot fee is guaranteed even if the show was cancelled.`, '0');
  if (entered === null) return;
  if (!/^(0|[1-9]\d*)$/.test(entered)) throw new Error('Enter non-negative whole seconds');
  verifiedSeconds = Number(entered);
  verifiedStart = confirm('Did a verified on-air start occur after both soundchecks passed? OK = yes; Cancel = no verified start.');
  const rehearsalBps = liveRehearsalPayoutBps(verifiedSeconds, b.airtimeMinutes * 60, verifiedStart);
  if (!confirm(`Rehearsal score: ${rehearsalBps / 100}%. Record a FULL $20 fee decision, independent of that score? This does not send funds.`)) return;
  bps = 10000;
 } else if (Number.isInteger(b.airtimeMinutes) && !cancellation) {
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
 const remainderDisposition = b.payoutPolicy === LIVE_PILOT_POLICY ? 'No remainder; full pilot fee guaranteed'
  : prompt('What should happen to the unpaid remainder? (e.g. keep for future shows or return to funder)');
 if (!remainderDisposition) return;
 await command({ action:'decision', id:b.id, payoutBps:bps, liveMusicMinutes, verifiedSeconds, verifiedStart, reason, reportUri, reportHash, remainderDisposition, cancellation });
}
async function action(name, b) {
 if (b.escrowVersion === LIVE_ASSET_VERSION && ['fund','assetApprove','giftRelease','assetFault','assetNoShow','assetUnperformed','assetRefund','giftReturn'].includes(name)) {
   if (!state.assetEscrowConfigured || state.assetEscrowAddress?.toLowerCase() !== b.escrowAddress?.toLowerCase()) throw new Error('Exact asset escrow is unavailable; do not send a transaction');
   const w = await wallet();
   const contract = new w.ethers.Contract(b.escrowAddress, LIVE_ASSET_ESCROW_ABI, w.signer);
   const bookingId = w.ethers.id(b.id);
   if (name === 'fund') {
     if (!b.acknowledged || b.cancelled || !['draft','failed'].includes(b.status)) throw new Error('Requires an accepted, unfunded invitation');
     if (localStorage.getItem(`live-pending:${b.id}:funding`) || b.transactions.funding?.status === 'pending') throw new Error('Funding is pending; reconcile instead of resending');
     if (Date.parse(b.startUtc) <= Date.now()) throw new Error('Invitation expired');
     if (!confirm(`Fund ${formatLiveAsset(b.amountUnits,b.assetDecimals,b.assetSymbol)} on Base for ${b.wallet}? ${b.gift ? 'The exact gift will be transferred from this wallet into booking custody. Public Market listings of this edition may stay active only while the Market still holds every listed edition. ' : ''}Administrator recovery can defeat this guarantee.`)) return;
     if (b.assetAddress.toLowerCase() !== LIVE_ZERO_ADDRESS) {
       const token = new w.ethers.Contract(b.assetAddress, [...erc20Abi, 'function decimals() view returns(uint8)', 'function symbol() view returns(string)'], w.signer);
       if (!await contract.approvedTokens(b.assetAddress) || Number(await token.decimals()) !== b.assetDecimals || await token.symbol() !== b.assetSymbol) throw new Error('Token approval or metadata changed; do not fund');
       if (await token.allowance(w.address,b.escrowAddress) < BigInt(b.amountUnits)) {
         const tx = await token.approve(b.escrowAddress,b.amountUnits); await tx.wait(2); await w.check();
       }
     }
     let giftMarket, giftNft;
     if (b.gift) {
       if (!state.giftTreasuryAddress || state.giftTreasuryAddress.toLowerCase() !== b.gift.treasury.toLowerCase()) throw new Error('Signed gift treasury is no longer configured');
       const marketAddress = window.DecentConfig?.supporterDnft?.escrowAddress;
       if (!w.ethers.isAddress(marketAddress || '')) throw new Error('Market contract is not configured; do not fund');
       giftMarket = new w.ethers.Contract(marketAddress,marketListingAbi,w.provider);
       giftNft = new w.ethers.Contract(b.gift.collection, ['function balanceOf(address,uint256) view returns(uint256)', 'function isApprovedForAll(address,address) view returns(bool)', 'function setApprovalForAll(address,bool)'], w.signer);
       await assertGiftListingsBacked(giftMarket,giftNft,b.gift);
       if (await giftNft.balanceOf(w.address,b.gift.tokenId) < BigInt(b.gift.quantity)) throw new Error('Funder does not hold the exact unlisted editions');
       if (!await giftNft.isApprovedForAll(w.address,b.escrowAddress)) {
         if (!confirm('Approve the asset escrow to transfer ALL your editions in this collection? Revoke this operator approval after funding if desired.')) return;
         const tx = await giftNft.setApprovalForAll(b.escrowAddress,true); await tx.wait(2); await w.check();
       }
     }
     await w.check();
     if (Date.parse(b.startUtc) <= Date.now()) throw new Error('Invitation expired during approvals');
     await transaction(b,'funding', async () => {
       await w.check();
       if (b.gift) await assertGiftListingsBacked(giftMarket,giftNft,b.gift);
       if (b.assetAddress.toLowerCase() !== LIVE_ZERO_ADDRESS && !await contract.approvedTokens(b.assetAddress)) throw new Error('Token is no longer approved');
       return contract.createBooking(bookingId,assetBookingTerms(b),b.termsUri,
         { value:b.assetAddress.toLowerCase() === LIVE_ZERO_ADDRESS ? b.amountUnits : 0 });
     });
     return;
   }
   if (!matchesAssetBooking(b,await contract.bookings(bookingId),w.address)) throw new Error('On-chain booking differs from the accepted terms or funder');
   const methods = {
     assetApprove:['approve','approvePerformance','Performance review report IPFS URI; approval enables independent producer-paid gift release'],
     giftRelease:['giftRelease','releaseGift','Release the approved gift to the exact booked performer?'],
     assetFault:['fault','platformFault','Platform fault/cancellation report IPFS URI (full fee remains guaranteed; unearned gift returns)'],
     assetNoShow:['noShow','noShow','Performer no-show report IPFS URI (not for platform/rehearsal faults)'],
     assetUnperformed:['unperformed','markUnperformedGift','Unperformed gift report IPFS URI (does not reduce vested fee)'],
     assetRefund:['refund','refund','Return the refundable fee to the original funder?'],
     giftReturn:['giftReturn','returnGift','Return the unearned gift to its signed treasury?'],
   };
   const [txAction, method, question] = methods[name];
   if (localStorage.getItem(`live-pending:${b.id}:${txAction}`) || b.transactions[txAction]?.status === 'pending') throw new Error('Transaction pending; reconcile instead of resending');
   const takesReport = ['assetApprove','assetFault','assetNoShow','assetUnperformed'].includes(name);
   if (name === 'assetApprove' && liveBroadcastCompletionPending(b)) throw new Error('Actual broadcast completion is pending or unavailable; do not approve performance');
   const reason = takesReport ? prompt(question) : null;
   if (takesReport && !/^ipfs:\/\/[a-zA-Z0-9]+(?:\/[^\s]*)?$/.test(reason || '')) throw new Error('A pinned IPFS report is required');
   if (!takesReport && !confirm(question)) return;
   await w.check();
   await transaction(b,txAction,async () => { await w.check(); return takesReport ? contract[method](bookingId,reason) : contract[method](bookingId); });
   return;
 }
 if (name === 'priorityInvite') {
   if (b.priorityInvitation) throw new Error('Use the existing follow-up invitation; do not prepare another');
   const form = section.querySelector('[data-live-create]');
   form.elements.payoutPolicy.value = LIVE_PILOT_POLICY;
   form.elements.payoutPolicy.dispatchEvent(new Event('change'));
   form.elements.performer.value = b.wallet;
   form.elements.displayName.value = b.displayName || '';
   form.elements.title.value = b.title || 'Friday Live Performance';
   form.elements.startLocal.value = nextFridayLiveStart();
   form.elements.airtimeMinutes.value = b.airtimeMinutes || 20;
   form.elements.priorityFor.value = b.id;
   section.querySelector('.live-create-details').open = true;
   form.scrollIntoView({ block: 'nearest' });
   return 'Priority invitation prepared in the form only. Review the date and fresh terms, then save. Nothing was sent, accepted or funded.';
 }
 if (liveBroadcastCompletionPending(b) && ['review', 'full', 'partial', 'withhold', 'settle'].includes(name)) {
   throw new Error('Wait for verified actual stage completion before a new review/release workflow. Original guarantees and claim deadlines are unchanged; existing transactions can still be reconciled.');
 }
 if (name === 'release') {
   const w = await wallet();
   const card = [...section.querySelectorAll('[data-live-actions]')].find(node => node.dataset.liveActions === b.id);
   const output = card?.querySelector('[data-live-release-status]');
   const progress = message => {
     section.querySelector('[data-live-status]').textContent = message;
     if (output) output.textContent = message;
   };
   const network = await w.provider.getNetwork();
   const result = await guidedGuaranteedRelease({
     booking: b, escrowAddress: state.escrowAddress,
     session: { wallet: w, facts: { checked: true, chainId: Number(network.chainId), wallet: { address: w.address, admin: true } } },
     storage: localStorage,
     serviceUrl: base(), origin: location.origin,
     knownHash: pendingReleaseHashes.get(b.id) || null,
     onProgress: progress,
     onState: event => {
       if (['submitted', 'unknown'].includes(event.type) && event.hash) pendingReleaseHashes.set(b.id, event.hash);
       if (event.type === 'confirmed' || event.type === 'failed' && event.kind === 'replaced') pendingReleaseHashes.delete(b.id);
       if (event.type === 'preflight') {
         const checks = card?.querySelector('[data-live-release-checks]');
         if (checks) checks.innerHTML = event.preflight.rows.map(row =>
           `<li data-state="${escapeLive(row.status)}"><strong>${escapeLive(row.label)}:</strong> ${escapeLive(row.detail)}${row.next ? ` Next: ${escapeLive(row.next)}` : ''}</li>`).join('');
         progress(event.preflight.summary);
       } else if (event.type === 'submitted') {
         const button = card?.querySelector('[data-live-action="release"]');
         if (button) button.textContent = 'Check pending escrow release';
       } else if (event.type === 'confirmed') {
         progress('Full fee approved on Base. The performer can claim from Profile; this is not payment received.');
       } else if (event.type === 'unknown') {
         progress(`${event.message || 'The result could not be verified.'} Do not send again; re-check the transaction.`);
       } else if (event.type === 'failed') {
         progress(`${event.message || 'The release did not complete.'} Re-check before retrying.`);
       }
     },
   });
   if (result.outcome !== 'approved') {
     if (result.outcome === 'reverted') pendingReleaseHashes.delete(b.id);
     return result.preflight?.summary || result.error?.message || `Release status: ${result.outcome}. Re-check before retrying.`;
   }
   document.dispatchEvent(new CustomEvent('live-booking-transaction-updated'));
   const success = result.txHash
     ? `Full fee approved on Base (${result.txHash}). Performer can claim from Profile; this is not payment received.`
     : 'Full fee approval is already confirmed on Base. Performer can claim from Profile; this is not payment received.';
   try { state = await api(); render(); }
   catch (error) { return `${success} Booking refresh unavailable: ${error.message}. Do not send again.`; }
   const updatedCard = [...section.querySelectorAll('[data-live-actions]')].find(node => node.dataset.liveActions === b.id);
   applyConfirmedRelease(updatedCard, result);
   return success;
 }
 if (['agreement', 'acknowledge', 'fund'].includes(name) && Date.parse(b.startUtc) <= Date.now()) {
   throw new Error('This invitation has expired; prepare a new booking and obtain fresh performer acceptance. Do not fund the old date.');
 }
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
   if (Date.parse(b.startUtc) <= Date.now()) throw new Error('The invitation expired while connecting the wallet; no approval or funding will be requested');
   const token = new w.ethers.Contract(LIVE_USDC, erc20Abi, w.signer);
   if (await token.allowance(w.address, target) < BigInt(b.amountUnits)) {
     const tx = await token.approve(target, b.amountUnits);
     await tx.wait(2);
   }
   await w.check();
   if (Date.parse(b.startUtc) <= Date.now()) throw new Error('The show has started; do not fund this expired invitation');
   await transaction(b, 'funding', w => b.mode === 'phase0' ? new w.ethers.Contract(LIVE_ROUTER, routerAbi, w.signer).fundToken(w.ethers.id(LIVE_FUND), LIVE_USDC, b.amountUnits)
     : new w.ethers.Contract(state.escrowAddress, LIVE_ESCROW_ABI, w.signer).createBooking(w.ethers.id(b.id), b.wallet, b.amountUnits, Date.parse(b.startUtc)/1000, Date.parse(b.endUtc)/1000, Date.parse(b.claimDeadline)/1000, b.termsHash, b.termsUri, b.reviewWindow, b.cancellationWindow, b.killFeeBps));
 } else if (name === 'reconcile') {
   const txAction = prompt(b.escrowVersion === LIVE_ASSET_VERSION ? 'Action: funding / approve / claim / giftRelease / giftReturn / refund / fault / noShow / unperformed' : 'Action: funding / payout / recovery / approve / claim / reject / cancel', 'funding');
   const savedHash = localStorage.getItem(`live-pending:${b.id}:${txAction}`);
   const txHash = prompt('Base transaction hash', (/^0x[0-9a-fA-F]{64}$/.test(savedHash || '') ? savedHash : '') || b.transactions[txAction]?.hash || '');
   if (txHash) await command({ action:'transaction', id:b.id, txAction, txHash });
 } else if (name === 'full') await review(b, 10000);
 else if (name === 'partial') { const percentage = Number(prompt('How much of the agreed fee should be paid? Enter a percentage from 1 to 99.')); if (Number.isInteger(percentage) && percentage > 0 && percentage < 100) await review(b, percentage * 100); }
 else if (name === 'withhold') await review(b, 0);
 else if (name === 'settle') {
   if (!b.decision) throw new Error('Record the completion decision first');
   if (b.payoutPolicy === LIVE_PILOT_POLICY && b.decision.payoutBps !== 10000) throw new Error('This pilot requires a full-fee decision');
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
   if (b.payoutPolicy === LIVE_PILOT_POLICY) throw new Error('Pilot fee is guaranteed. Cancel the schedule only, then approve the full fee after the original booked end.');
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
async function guarded(fn, bookingId) {
 if (busy) return;
 busy = true;
 const controls = [...section.querySelectorAll('[data-live-action]')].map(button => [button, button.disabled]);
 for (const [button] of controls) button.disabled = true;
 const feedback = message => {
  section.querySelector('[data-live-status]').textContent = message;
  const card = [...section.querySelectorAll('[data-live-actions]')].find(node => node.dataset.liveActions === bookingId);
  const output = card?.querySelector('[data-live-release-status]');
  if (output) { output.textContent = message; output.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
 };
 try {
  const result = await fn();
  feedback(typeof result === 'string' ? result : 'Action completed. Refresh to verify the latest booking state.');
 }
 catch (error) { feedback(`${error.shortMessage || error.message}. Refresh/reconcile before retrying; submitted transactions may still be pending.`); }
 finally { busy = false; for (const [button, disabled] of controls) button.disabled = disabled; }
}
function mount() {
 const parent = document.getElementById('admin-live-performance-slot');
 if (!parent || section) return;
 section = document.createElement('details');
 section.className = 'live-performance-admin';
 section.innerHTML = `<summary class="live-performance-admin-summary"><span>🎤 Live Performance</span><small>Invitations, schedule listings, and payment review</small></summary>
 <div class="live-performance-admin-content">
 <p>${LIVE_NOTICE}</p><p data-live-capability></p>
 <ol class="live-performance-flow"><li>📝 Review the offer and pinned terms.</li><li>📨 Add the date to the community calendar; only the invited wallet can accept.</li><li>✅ Acceptance appears here. Funding is always a separate owner action.</li><li>🎙️ After the show, review the actual coverage under this booking's agreed payment policy.</li></ol>
 <details class="live-create-details"><summary>➕ Prepare a new performance invitation</summary>
 <aside class="live-performance-offer" data-live-offer><strong>💵 Current offer: $${Number(LIVE_PERFORMANCE_FEE_UNITS) / 1e6} USDC</strong><span>🗓 ${LIVE_PERFORMANCE_AIRTIME_MINUTES}-minute calendar event</span><span>🎵 ${LIVE_PERFORMANCE_FULL_PAYOUT_MINUTES} live-music minutes earns the full fee; shorter sets are prorated, capped at $${Number(LIVE_PERFORMANCE_FEE_UNITS) / 1e6}.</span><span>🚫 No live performance earns $0.</span></aside>
 <p class="live-performance-draft-note">Legacy v2 terms are pinned. The guaranteed audio pilot requires a NEW reviewed agreement pin and fingerprint; never reuse v2. Each performer and date requires fresh acceptance before funding.</p>
 <form data-live-create><input name="priorityFor" type="hidden" value="">
 <label>Offer policy<select name="payoutPolicy"><option value="">Legacy v2: prorated live minutes</option><option value="${LIVE_PILOT_POLICY}">Audio pilot: guaranteed $20, rehearsal ladder only</option><option value="${LIVE_ASSET_POLICY}" disabled>Fixed asset fee / optional gift</option></select></label>
 ${field('performer','Performer wallet or ENS')}${field('displayName','Name shown on the calendar')}<label>Discord name (optional, with consent)<input name="discordHandle"></label>${field('title','Show title','Friday Live Performance')}
 ${field('startLocal','Start time (America/New_York)',nextFridayLiveStart(),'datetime-local')}
 <p class="live-performance-form-note" data-live-fee-note>End time is calculated from the duration. Fee is $20 USDC on Base. Legacy v2 is fixed at 20 minutes; the pilot uses the agreed duration.</p>
 <input name="fee" type="hidden" value="${Number(LIVE_PERFORMANCE_FEE_UNITS) / 1e6}"><label>Duration (minutes)<input name="airtimeMinutes" type="number" value="${LIVE_PERFORMANCE_AIRTIME_MINUTES}" min="11" max="59" step="1" required readonly></label>
 <details data-live-asset-options hidden><summary>Fee asset & optional gift</summary>
 <p>Exact quantity on Base, not a dollar conversion. The administrator can recover reserved or earned assets. No fee-on-transfer, rebasing or unusual tokens.</p>
 <label>Asset<select name="assetChoice"><option value="usdc">USDC (default)</option><option value="eth">Base ETH</option><option value="token">Producer-approved ERC-20</option></select></label>
 <label>Exact quantity<input name="assetAmount" value="20" inputmode="decimal"></label>
 <label data-live-token-address hidden>Base ERC-20 contract<input name="assetAddress" placeholder="0x…"></label>
 <label><input name="hasGift" type="checkbox"> Reserve an ERC-1155 gift at funding</label>
 <div data-live-gift-fields hidden><label>Collection on Base<input name="giftCollection" placeholder="0x…"></label><label>Token ID<input name="giftTokenId" inputmode="numeric"></label><label>Quantity<input name="giftQuantity" value="1" inputmode="numeric"></label>
 <p>Gift editions transfer from the funding wallet. The configured gift treasury is the signed return recipient. Public Market listings of this edition may stay active only while the Market holds every listed edition. Funding is not yet confirmed.</p></div></details>
 <input name="fullPayoutLiveMinutes" type="hidden" value="${LIVE_PERFORMANCE_FULL_PAYOUT_MINUTES}">
 <label data-live-additional hidden>Additional pilot offer (public; NOT funded by performance escrow)<textarea name="additionalOffer" maxlength="1000" placeholder="Separate prep-task payments and supporter gift, including their conditions. No private notes."></textarea></label>
 <label>Payment handling<select name="mode"><option value="phase1">🔒 Protected booking escrow (recommended)</option><option value="phase0">🏦 Community fund (earmarked, not escrowed)</option></select></label>
 <label>Review period after the show (hours)<input name="reviewWindowHours" type="number" value="24" min="1" max="8760" step="1" required></label>
 <label data-live-legacy-only>Late-cancellation notice (hours)<input name="cancellationWindowHours" type="number" value="8" min="0" max="8760" step="1" required></label>
 <label data-live-legacy-only>Late-cancellation fee (%)<input name="killFeePercent" type="number" value="50" min="0" max="100" step="1" required></label>
 <p class="live-performance-form-note" data-live-legacy-only>The performer’s claim deadline is set automatically to three days after the review window closes.</p>
 <details class="live-advanced-terms"><summary>📎 Pinned agreement details (advanced)</summary><p>Legacy v2 references are prefilled only for the legacy policy. The guaranteed audio pilot requires its own reviewed pin and fingerprint. Check the exact text before approving.</p>
 ${field('termsVersion','Agreement version',LIVE_APPROVED_TERMS_V2.version)}${field('termsUri','Pinned agreement IPFS link',LIVE_APPROVED_TERMS_V2.uri)}${field('termsHash','Agreement verification fingerprint',LIVE_APPROVED_TERMS_V2.hash)}</details>
 <label class="live-performance-approval"><input name="stewardApproved" type="checkbox"> I approve these exact pinned terms for this performer and date.</label>
 <button type="submit">📝 Save invitation draft (no payment)</button></form></details>
 <button type="button" data-live-refresh>🔄 Refresh bookings</button><p class="live-performance-acceptance" role="alert" aria-live="assertive" data-live-acceptance-notice hidden></p><p role="status" data-live-status></p><div data-live-list></div></div>`;
 parent.append(section);
 const form = section.querySelector('form');
 const updatePolicy = () => {
  const pilot = form.elements.payoutPolicy.value === LIVE_PILOT_POLICY;
  const assets = form.elements.payoutPolicy.value === LIVE_ASSET_POLICY;
  section.querySelector('[data-live-fee-note]').textContent = assets ? 'End time follows the duration. Set the exact asset quantity below.' : 'End time is calculated from the duration. Fee is $20 USDC on Base. Legacy v2 is fixed at 20 minutes; the pilot uses the agreed duration.';
  form.elements.airtimeMinutes.readOnly = !pilot && !assets;
  if (!pilot && !assets) form.elements.airtimeMinutes.value = LIVE_PERFORMANCE_AIRTIME_MINUTES;
  form.elements.mode.value = 'phase1';
  form.elements.mode.querySelector('[value="phase0"]').disabled = pilot || assets;
  form.elements.killFeePercent.value = assets ? '0' : pilot ? '100' : '50';
  for (const name of ['reviewWindowHours', 'cancellationWindowHours', 'killFeePercent']) form.elements[name].readOnly = pilot;
  form.elements.reviewWindowHours.value = '24';
  form.elements.cancellationWindowHours.value = assets ? '0' : '8';
  form.elements.termsVersion.value = assets ? LIVE_ASSET_TERMS_V1.version : pilot ? LIVE_PILOT_TERMS_VERSION : LIVE_APPROVED_TERMS_V2.version;
  form.elements.termsUri.value = assets ? LIVE_ASSET_TERMS_V1.uri : pilot ? '' : LIVE_APPROVED_TERMS_V2.uri;
  form.elements.termsHash.value = assets ? LIVE_ASSET_TERMS_V1.hash : pilot ? '' : LIVE_APPROVED_TERMS_V2.hash;
  form.elements.stewardApproved.checked = false;
  section.querySelector('[data-live-additional]').hidden = !pilot;
  if (pilot && !form.elements.additionalOffer.value.trim()) form.elements.additionalOffer.value = LIVE_PILOT_COMPANION_OFFER;
  const assetOptions = section.querySelector('[data-live-asset-options]');
  assetOptions.hidden = !assets;
  assetOptions.open = assets;
  section.querySelectorAll('[data-live-legacy-only]').forEach(element => { element.hidden = assets; });
  if (pilot || assets) section.querySelector('.live-advanced-terms').open = true;
  updateOffer();
 };
 const updateOffer = () => {
  const pilot = form.elements.payoutPolicy.value === LIVE_PILOT_POLICY;
  const assets = form.elements.payoutPolicy.value === LIVE_ASSET_POLICY;
  section.querySelector('[data-live-offer]').textContent = assets ? 'Fixed exact Base asset quantity; full fee is guaranteed despite platform faults. Gift is optional and separately delivered.' : livePerformancePolicyText({
   payoutPolicy: pilot ? LIVE_PILOT_POLICY : undefined,
   airtimeMinutes: Number(form.elements.airtimeMinutes.value),
   fullPayoutLiveMinutes: LIVE_PERFORMANCE_FULL_PAYOUT_MINUTES, amountUnits: LIVE_PERFORMANCE_FEE_UNITS,
  });
 };
 form.elements.payoutPolicy.addEventListener('change', updatePolicy);
 form.elements.airtimeMinutes.addEventListener('input', updateOffer);
 form.elements.assetChoice.addEventListener('change', () => {
  section.querySelector('[data-live-token-address]').hidden = form.elements.assetChoice.value !== 'token';
  form.elements.assetAmount.value = form.elements.assetChoice.value === 'usdc' ? '20' : '';
 });
 form.elements.hasGift.addEventListener('change', () => { section.querySelector('[data-live-gift-fields]').hidden = !form.elements.hasGift.checked; });
 section.querySelector('[data-live-refresh]').onclick = () => guarded(async () => {
  state = await api();
  render();
  return `Bookings refreshed from the service. ${state.bookings.length} booking${state.bookings.length === 1 ? '' : 's'} found.`;
 });
 section.querySelector('form').onsubmit = event => { event.preventDefault(); guarded(async () => {
   const f = Object.fromEntries(new FormData(section.querySelector('form')));
   state = await api();
   const startUtc = newYorkInputToUtc(f.startLocal);
   if (Date.parse(startUtc) <= Date.now()) throw new Error('Choose a future New York start time; expired invitations must be replaced, not reused');
   const reviewWindow = Math.round(Number(f.reviewWindowHours) * 3600);
   const cancellationWindow = Math.round(Number(f.cancellationWindowHours) * 3600);
   const termsUri = /^b[a-zA-Z0-9]{20,}$/.test(f.termsUri.trim()) ? `ipfs://${f.termsUri.trim()}` : f.termsUri.trim();
   const endUtc = new Date(Date.parse(startUtc) + Number(f.airtimeMinutes) * 60_000).toISOString();
   const overlap = overlappingLiveBooking(state.bookings, startUtc, endUtc);
   if (overlap) throw new Error(`This slot overlaps ${overlap.displayName || overlap.wallet}'s booking; choose a back-to-back start instead`);
   const eventId = liveOccurrenceId(f.startLocal, state.bookings);
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
   if (booking.payoutPolicy === LIVE_ASSET_POLICY) {
     if (!state.assetBookingCreationEnabled) throw new Error('New asset bookings are disabled or escrow is unavailable');
     const w = await wallet();
     const assetAddress = f.assetChoice === 'eth' ? LIVE_ZERO_ADDRESS : f.assetChoice === 'usdc' ? LIVE_USDC : f.assetAddress.trim();
     if (!w.ethers.isAddress(assetAddress)) throw new Error('Enter a valid Base asset contract');
     let decimals = 18, symbol = 'ETH';
     if (assetAddress.toLowerCase() !== LIVE_ZERO_ADDRESS) {
       const token = new w.ethers.Contract(assetAddress, ['function decimals() view returns(uint8)','function symbol() view returns(string)'], w.provider);
       [decimals, symbol] = await Promise.all([token.decimals(),token.symbol()]);
       decimals = Number(decimals);
     }
     if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || !/^[A-Za-z0-9._-]{1,16}$/.test(symbol)) throw new Error('Unsupported token metadata');
     booking.escrowVersion = LIVE_ASSET_VERSION;
     booking.assetAddress = assetAddress;
     booking.assetDecimals = decimals;
     booking.assetSymbol = symbol;
     booking.amountUnits = w.ethers.parseUnits(f.assetAmount,decimals).toString();
     if (f.hasGift === 'on') {
       if (!state.giftTreasuryAddress) throw new Error('Gift treasury is not configured');
       booking.gift = { collection:f.giftCollection, tokenId:f.giftTokenId, quantity:f.giftQuantity, treasury:state.giftTreasuryAddress };
     }
     delete booking.fullPayoutLiveMinutes;
   } else if (booking.payoutPolicy === LIVE_PILOT_POLICY) delete booking.fullPayoutLiveMinutes;
   else { delete booking.payoutPolicy; delete booking.additionalOffer; }
   for (const key of ['assetChoice','assetAmount','assetAddressInput','hasGift','giftCollection','giftTokenId','giftQuantity']) delete booking[key];
   if (!booking.priorityFor) delete booking.priorityFor;
   const id = `${eventId}:${crypto.randomUUID()}`;
   await command({ action:'create', id, booking });
   form.elements.priorityFor.value = '';
   return `Invitation draft saved for ${booking.displayName || booking.wallet}. It is not funded or listed on the community calendar yet.`;
 }); };
 section.onclick = event => { const button = event.target.closest('[data-live-action]'); if (!button || button.disabled) return; const id = button.closest('[data-live-actions]').dataset.liveActions; guarded(() => action(button.dataset.liveAction,state.bookings.find(b=>b.id===id)), id); };
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
