import { announcePaymentCelebration } from './payment-celebration.mjs';
import { LIVE_ESCROW_ABI, claimState, liveAcknowledgement, liveBookingRows } from './live-bookings.mjs?v=20261022-live-offer-v2';

export function liveReceiptEntry(bookings, wallet) {
 const paid = bookings.filter(b => b.mode === 'phase1' && b.wallet.toLowerCase() === wallet.toLowerCase() && BigInt(b.paidUnits || 0) > 0n);
 if (!paid.length) return null;
 return { kind:'live-performance', label:'Live performances', asset:'USDC', status:'paid', count:paid.length,
   units:paid.reduce((n,b) => n + BigInt(b.paidUnits),0n), transactions:paid.map(b => {
     const tx = b.transactions.PerformancePaid;
     return { title:b.title, hash:tx.hash, blockNumber:tx.blockNumber, units:b.paidUnits, url:`https://basescan.org/tx/${tx.hash}` };
   }) };
}
export function renderPerformerBookingInvite({ booking: b, wallet, serviceUrl, ethers, fetchImpl = fetch }) {
 const invitation = document.createElement('section');
 invitation.className = 'live-booking-invite';
 const description = document.createElement('p');
 const status = document.createElement('p');
 status.setAttribute('role', 'status');
 status.setAttribute('aria-live', 'polite');
 if (b.stewardApproved) {
   const summary = document.createElement('p');
   const eventTime = value => new Intl.DateTimeFormat('en-US', {
     timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short',
   }).format(new Date(value));
   summary.textContent = `${b.title} · $${(Number(b.amountUnits) / 1e6).toFixed(2)} USDC · ${eventTime(b.startUtc)}–${eventTime(b.endUtc)} ET`;
   const termsLink = document.createElement('a');
   termsLink.href = `https://gateway.pinata.cloud/ipfs/${b.termsUri.replace(/^ipfs:\/\//, '')}`;
   termsLink.target = '_blank';
   termsLink.rel = 'noopener noreferrer';
   termsLink.textContent = `Open ${b.termsVersion}`;
   const policy = document.createElement('p');
   if (Number.isInteger(b.airtimeMinutes) && Number.isInteger(b.fullPayoutLiveMinutes)) {
     policy.textContent = `🎙️ ${b.airtimeMinutes} minutes of airtime. ${b.fullPayoutLiveMinutes} live minutes earns the full fee; shorter sets earn the fee × live minutes ÷ ${b.fullPayoutLiveMinutes} (capped at the fee), and no live minutes earns $0.`;
   }
   const technical = document.createElement('details');
   const technicalSummary = document.createElement('summary');
   technicalSummary.textContent = 'Technical verification details';
   const termsHash = document.createElement('code');
   termsHash.textContent = b.termsHash;
   technical.append(technicalSummary, termsHash);
   invitation.append(summary, termsLink);
   if (policy.textContent) invitation.append(policy);
   invitation.append(technical);
 }
 if (!b.stewardApproved) {
   description.textContent = 'The steward is preparing the booking terms. The acceptance invitation is not open yet.';
   invitation.append(description, status);
   return invitation;
 }
 if (b.acknowledged) {
   description.textContent = 'You accepted these terms. Escrow funding is a separate steward action; no funds have been sent by this acceptance.';
   status.textContent = b.acknowledgedAt ? `Accepted ${new Date(b.acknowledgedAt).toLocaleString()}.` : 'Acceptance recorded.';
   invitation.append(description, status);
   return invitation;
 }
 description.textContent = 'Invitation: review the pinned booking terms above. Accepting signs this booking agreement only; no payment or escrow transaction is submitted.';
 const consent = document.createElement('label');
 const checkbox = document.createElement('input');
 checkbox.type = 'checkbox';
 consent.append(checkbox, document.createTextNode(' I have reviewed and agree to these exact booking terms.'));
 const button = document.createElement('button');
 button.type = 'button';
 button.disabled = true;
 button.textContent = 'Review and accept terms';
 checkbox.addEventListener('change', () => { button.disabled = !checkbox.checked; });
 button.addEventListener('click', async () => {
   button.disabled = true;
   status.textContent = 'Confirm the agreement in your wallet…';
   try {
     if (!checkbox.checked) throw new Error('Review and accept the terms first');
     if (!window.ethereum) throw new Error('A connected wallet is required');
     const provider = new ethers.BrowserProvider(window.ethereum);
     const signer = await provider.getSigner();
     if ((await provider.getNetwork()).chainId !== 8453n ||
         (await signer.getAddress()).toLowerCase() !== b.wallet.toLowerCase() ||
         wallet.toLowerCase() !== b.wallet.toLowerCase()) {
       throw new Error('Connect this invited wallet on Base');
     }
     const signature = await signer.signMessage(liveAcknowledgement(b));
     const response = await fetchImpl(`${serviceUrl.replace(/\/$/, '')}/api/live-bookings/acknowledge`, {
       method: 'POST',
       headers: { 'content-type': 'application/json' },
       body: JSON.stringify({ id: b.id, address: b.wallet, signature }),
     });
     const result = await response.json();
     if (!response.ok) throw new Error(result.error || `Acknowledgement failed (${response.status})`);
     const accepted = result.bookings?.find(item => item.id === b.id);
     if (!accepted?.acknowledged) throw new Error('The service did not confirm the performer acknowledgement');
     checkbox.disabled = true;
     consent.lastChild.textContent = ' Terms accepted.';
     status.textContent = 'Terms accepted and recorded. The steward has been notified; escrow funding is a separate step.';
     button.textContent = 'Terms accepted';
     document.dispatchEvent(new CustomEvent('live-booking-acknowledged', { detail: { id: b.id } }));
   } catch (error) {
     status.textContent = `${error.shortMessage || error.message}. No escrow transaction was sent.`;
     button.disabled = !checkbox.checked;
   }
 });
 invitation.append(description, consent, button, status);
 return invitation;
}
export async function renderLivePerformances({ container, wallet, serviceUrl, ethers, onReceipt = () => {}, fetchImpl = fetch }) {
 if (!container || !serviceUrl) return;
 const response = await fetchImpl(`${serviceUrl.replace(/\/$/,'')}/api/live-bookings`, { cache:'no-store' });
 if (!response.ok) throw new Error('Live performance bookings unavailable');
 const state = await response.json();
 const bookings = state.bookings.filter(b => b.wallet.toLowerCase() === wallet.toLowerCase());
 container.innerHTML = '<h3>🎤 Upcoming performance / live bookings</h3>' + (bookings.length ? '' : '<p>No bookings for this wallet.</p>');
 for (const b of bookings) {
   const article = document.createElement('div');
   article.innerHTML = liveBookingRows([b]);
   if (b.mode === 'phase1' && b.status === 'draft' && !b.cancelled) {
     article.append(renderPerformerBookingInvite({ booking: b, state, wallet, serviceUrl, ethers, fetchImpl }));
   }
   const button = document.createElement('button');
   const connected = window._wallet?.address || '';
   const claim = claimState(b, state.escrowAddress, connected);
   const pendingHash = localStorage.getItem(`live-claim:${b.id}`);
   button.type = 'button'; button.disabled = !claim.enabled; button.textContent = pendingHash ? `Reconcile claim: ${pendingHash.slice(0,10)}…` : claim.label;
   button.onclick = async () => {
     button.disabled = true;
     try {
       const provider = new ethers.BrowserProvider(window.ethereum);
       const signer = await provider.getSigner();
       if ((await provider.getNetwork()).chainId !== 8453n || (await signer.getAddress()).toLowerCase() !== b.wallet.toLowerCase()) throw new Error('Connect performer wallet on Base');
       const previous = localStorage.getItem(`live-claim:${b.id}`);
       if (previous) {
         const receipt = await provider.getTransactionReceipt(previous);
         if (!receipt) { button.textContent = `Claim still pending: ${previous}`; return; }
         localStorage.removeItem(`live-claim:${b.id}`);
         button.textContent = receipt.status === 1 ? 'Previous claim confirmed; refresh indexed receipt' : 'Previous claim reverted; refresh before retrying';
         return;
       }
       const contract = new ethers.Contract(state.escrowAddress, LIVE_ESCROW_ABI, signer);
       const tx = await contract.claim(ethers.id(b.id));
       localStorage.setItem(`live-claim:${b.id}`,tx.hash);
       button.textContent = `Claim pending: ${tx.hash}`;
       await tx.wait(2);
       button.textContent = 'Claim confirmed; refresh for indexed receipt';
       announcePaymentCelebration({ chainId:8453, txHash:tx.hash, amountText:String(Number(b.approvedUnits || b.amountUnits)/1e6), assetText:'USDC', summary:'Live performance claim confirmed', txLabel:'Claim confirmed' });
       localStorage.removeItem(`live-claim:${b.id}`);
     } catch (error) { button.textContent = `${error.shortMessage || error.message}. Refresh to reconcile before retrying.`; }
   };
   article.append(button); container.append(article);
 }
 const receipt = liveReceiptEntry(bookings, wallet);
 if (receipt) onReceipt(receipt);
}
