import { announcePaymentCelebration } from './payment-celebration.mjs';
import { LIVE_ESCROW_ABI, LIVE_PILOT_POLICY, claimState, liveAcknowledgement, liveBookingRows, livePerformancePolicyText } from './live-bookings.mjs?v=20261108-live-audio-pilot';
import { liveAudioRoomUrl } from './live-audio.mjs?v=20261108-live-audio-pilot';
import { performerRoomUrl } from './performer-room.mjs?v=20261110-wallet-practice';
import { renderPerformerGift } from './performer-gift.mjs?v=20261114-performer-encore';

function secretPyramid() {
 const image = document.createElement('img');
 image.className = 'live-invitation-pyramid';
 image.src = new URL('../img/SecretPyramid.png', import.meta.url).href;
 image.alt = 'Secret Pyramid';
 image.width = 24;
 image.height = 24;
 return image;
}

export function celebrateLiveInvitation({ documentRef = document, windowRef = window } = {}) {
 const effect = documentRef.createElement('div');
 effect.className = 'live-invitation-cosmos';
 effect.setAttribute('aria-hidden', 'true');
 effect.setAttribute('popover', 'manual');
 const reducedMotion = windowRef.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
 if (reducedMotion) effect.className += ' is-still';
 const pyramid = documentRef.createElement('img');
 pyramid.className = 'live-cosmos-pyramid';
 pyramid.src = new URL('../img/SecretPyramid.png', import.meta.url).href;
 pyramid.alt = '';
 const stars = ['✦', '✧', '⋆'];
 const signs = ['♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓'];
 const figures = ['🜡', '☿', '♀︎', '🜐', '🜑', '⚸', '♁', '♄', '⚳', '⚵', '⚶', '⚷'];
 effect.append(pyramid);
 for (let index = 0; index < 36; index++) {
   const particle = documentRef.createElement('span');
   particle.className = index < 12 ? 'live-cosmos-sign' : 'live-cosmos-star';
   particle.textContent = index < 12 ? signs[index] : stars[index % stars.length];
   particle.style.setProperty('--angle', `${index % 12 * 30}deg`);
   particle.style.setProperty('--left', `${(index * 37 + 11) % 100}%`);
   particle.style.setProperty('--top', `${(index * 23 + 7) % 100}%`);
   particle.style.setProperty('--delay', `${index % 6 * 80}ms`);
   effect.append(particle);
 }
 for (const [index, symbol] of figures.entries()) {
   const figure = documentRef.createElement('span');
   figure.className = 'live-cosmos-figure';
   figure.textContent = symbol;
   figure.style.setProperty('--left', `${8 + index % 4 * 28}%`);
   figure.style.setProperty('--top', `${18 + Math.floor(index / 4) * 28}%`);
   figure.style.setProperty('--delay', `${index % 4 * 100}ms`);
   effect.append(figure);
 }
 documentRef.body.append(effect);
 const remove = () => {
   windowRef.clearTimeout(timer);
   windowRef.removeEventListener('pagehide', remove);
   effect.remove();
 };
 const timer = windowRef.setTimeout(remove, 4400);
 windowRef.addEventListener('pagehide', remove, { once: true });
 // A top-layer decoration stays above the Profile dialog without intercepting input.
 if (typeof effect.showPopover === 'function') effect.showPopover();
 return remove;
}

function pilotInvitationCard(b) {
 const card = document.createElement('section');
 card.className = 'live-booking-invite live-invitation-card';
 const element = (tag, className, text) => {
   const node = document.createElement(tag);
   node.className = className;
   node.textContent = text;
   return node;
 };
 const time = value => new Intl.DateTimeFormat('en-US', {
   timeZone: 'America/New_York', timeStyle: 'short',
 }).format(new Date(value));
 const date = new Intl.DateTimeFormat('en-US', {
   timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric', year: 'numeric',
 }).format(new Date(b.startUtc));
 const header = element('header', 'live-invitation-header', '');
 const art = document.createElement('img');
 art.src = new URL('../img/D_Busker.jpeg', import.meta.url).href;
 art.alt = 'DBusker playing guitar';
 art.width = 80;
 art.height = 80;
 const greeting = element('div', 'live-invitation-greeting', '');
 greeting.append(element('p', 'live-invitation-eyebrow', 'DECENT BUSKING · A PERSONAL INVITATION'),
   element('h3', '', `Hey ${b.displayName || 'there'}, you're invited.`));
 header.append(art, greeting);
 const facts = element('ul', 'live-invitation-facts', '');
 for (const text of [
   `🗓 ${date} · ${time(b.startUtc)}–${time(b.endUtc)}`,
   `🎧 Private soundchecks · ${time(Date.parse(b.startUtc) - 60 * 60_000)} & ${time(Date.parse(b.startUtc) - 15 * 60_000)}`,
 ]) facts.append(element('li', '', text));
 const fee = element('li', 'live-invitation-fee', '');
 fee.append(secretPyramid(), element('span', '', `$${Number(b.amountUnits) / 1e6} USDC on Base · guaranteed, even if the tech lets us down.`));
 facts.append(fee);
 card.append(header,
   element('p', 'live-invitation-note', 'A little music. A friendly room. Let’s get comfortable going live, together.'),
   facts, element('p', 'live-invitation-zone', 'All times New York.'));
 if (b.additionalOffer) card.append(element('p', 'live-invitation-extra', `Also offered, separately: ${b.additionalOffer}`));
 const details = element('details', 'live-invitation-payment', '');
 details.append(element('summary', '', 'Payment & practical details'),
   element('p', '', `Jolly funds escrow after you accept, then approves the full fee after the set. Claim here with your wallet (Base ETH for gas). Without a review, full claim opens after ${b.reviewWindow / 3600} hours. Claim by ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(b.claimDeadline))} New York.`),
   element('p', '', 'Contract pause, cancellation or expiry can affect escrow; Jolly still owes any shortfall against the guarantee. Both soundchecks must pass before broadcast.'));
 card.append(details);
 const roomUrl = performerRoomUrl(b);
 if (roomUrl) {
   const link = document.createElement('a');
   link.href = roomUrl;
   link.textContent = '🎙 Your room · practise before Friday';
   link.setAttribute('data-performer-room', '');
   card.append(link);
 }
 if (b.status === 'funded') {
   card.append(element('p', 'live-invitation-response', '🔒 Your fee is in escrow. Come back here for your soundcheck.'));
 } else if (b.acknowledged) {
   card.append(element('p', 'live-invitation-response', 'You’re on the guest list. Jolly’s next step: fund your escrow.'));
 } else {
   card.append(element('p', 'live-invitation-response', 'Your escrow will be funded after you accept.'));
 }
 return card;
}

export function liveReceiptEntry(bookings, wallet) {
 const paid = bookings.filter(b => b.mode === 'phase1' && b.wallet.toLowerCase() === wallet.toLowerCase() && BigInt(b.paidUnits || 0) > 0n);
 if (!paid.length) return null;
 return { kind:'live-performance', label:'Live performances', asset:'USDC', status:'paid', count:paid.length,
   units:paid.reduce((n,b) => n + BigInt(b.paidUnits),0n), transactions:paid.map(b => {
     const tx = b.transactions.PerformancePaid;
     return { title:b.title, hash:tx.hash, blockNumber:tx.blockNumber, units:b.paidUnits, url:`https://basescan.org/tx/${tx.hash}` };
   }) };
}
export function renderPerformerBookingInvite({ booking: b, wallet, serviceUrl, ethers, fetchImpl = fetch, now = Date.now() }) {
 const pilot = b.payoutPolicy === LIVE_PILOT_POLICY && b.stewardApproved;
 const open = !b.cancelled && Date.parse(b.status === 'funded' ? b.endUtc : b.startUtc) > now;
 const invitation = pilot && open ? pilotInvitationCard(b) : document.createElement('section');
 if (!pilot || !open) invitation.className = 'live-booking-invite';
 const description = document.createElement('p');
 const status = document.createElement('p');
 status.setAttribute('role', 'status');
 status.setAttribute('aria-live', 'polite');
 if (pilot && open && b.status === 'funded') return invitation;
 if (b.cancelled || b.status !== 'draft' || Date.parse(b.startUtc) <= now) {
   description.textContent = 'This invitation is closed or its start time has passed. Ask the steward for a new date and agreement; this invitation cannot be accepted or funded.';
   invitation.append(description, status);
   return invitation;
 }
 if (b.stewardApproved && !pilot) {
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
   policy.textContent = livePerformancePolicyText(b);
   const additional = document.createElement('p');
   additional.textContent = b.additionalOffer ? `Outside performance escrow: ${b.additionalOffer}` : '';
   const technical = document.createElement('details');
   const technicalSummary = document.createElement('summary');
   technicalSummary.textContent = 'Technical verification details';
   const termsHash = document.createElement('code');
   termsHash.textContent = b.termsHash;
   technical.append(technicalSummary, termsHash);
   invitation.append(summary, termsLink);
   if (policy.textContent) invitation.append(policy);
   if (additional.textContent) invitation.append(additional);
   invitation.append(technical);
 }
 if (!b.stewardApproved) {
   description.textContent = 'The steward is preparing the booking terms. The acceptance invitation is not open yet.';
   invitation.append(description, status);
   return invitation;
 }
 if (b.acknowledged) {
   description.textContent = pilot ? 'You’re all set for now. No payment was sent by accepting.' : 'You accepted these terms. Escrow funding is a separate steward action; no funds have been sent by this acceptance.';
   status.textContent = pilot ? '' : b.acknowledgedAt ? `Accepted ${new Date(b.acknowledgedAt).toLocaleString()}.` : 'Acceptance recorded.';
   invitation.append(description, status);
   return invitation;
 }
 description.textContent = pilot ? 'Accept this invitation with a wallet signature. No payment. No gas.' : 'Invitation: review the pinned booking terms above. Accepting signs this booking agreement only; no payment or escrow transaction is submitted.';
 description.className = 'live-invitation-signature';
 const consent = document.createElement('label');
 const checkbox = document.createElement('input');
 checkbox.type = 'checkbox';
 consent.append(checkbox, document.createTextNode(' I have reviewed and agree to these exact booking terms.'));
 const button = document.createElement('button');
 button.type = 'button';
 button.disabled = !pilot;
 if (pilot) button.append(secretPyramid(), document.createTextNode(' Count me in'));
 else button.textContent = 'Review and accept terms';
 button.className = 'live-invitation-accept';
 checkbox.addEventListener('change', () => { button.disabled = !checkbox.checked; });
 button.addEventListener('click', async () => {
   button.disabled = true;
   status.textContent = 'Confirm the agreement in your wallet…';
   try {
     if (!pilot && !checkbox.checked) throw new Error('Review and accept the terms first');
     if (Date.now() >= Date.parse(b.startUtc)) throw new Error('This invitation has expired; request a new booking');
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
     if (!pilot) consent.lastChild.textContent = ' Terms accepted.';
     status.textContent = pilot ? 'You’re in! Jolly’s next step is funding your escrow.' : 'Terms accepted and recorded. The steward has been notified; escrow funding is a separate step.';
     if (pilot) {
       const response = Array.from(invitation.children).find(node => node.className === 'live-invitation-response');
       response.textContent = 'You’re on the guest list. Jolly’s next step: fund your escrow.';
       description.textContent = 'See you at soundcheck.';
     }
     button.textContent = pilot ? '✓ You’re in' : 'Terms accepted';
     document.dispatchEvent(new CustomEvent('live-booking-acknowledged', { detail: { id: b.id } }));
     if (pilot) celebrateLiveInvitation();
   } catch (error) {
     status.textContent = `${error.shortMessage || error.message}. No escrow transaction was sent.`;
     button.disabled = !pilot && !checkbox.checked;
   }
 });
 invitation.append(description);
 if (!pilot) invitation.append(consent);
 invitation.append(button, status);
 return invitation;
}
export async function renderLivePerformances({ container, wallet, serviceUrl, ethers, onReceipt = () => {}, fetchImpl = fetch, bookingState }) {
 if (!container || !serviceUrl) return;
 let state = bookingState;
 if (!state) {
   const response = await fetchImpl(`${serviceUrl.replace(/\/$/,'')}/api/live-bookings`, { cache:'no-store' });
   if (!response.ok) throw new Error('Live performance bookings unavailable');
   state = await response.json();
 }
 const bookings = state.bookings.filter(b => b.wallet.toLowerCase() === wallet.toLowerCase());
 container.innerHTML = '';
 for (const b of bookings) {
   const compact = b.mode === 'phase1' && b.payoutPolicy === LIVE_PILOT_POLICY && b.stewardApproved &&
     !b.cancelled && Date.parse(b.status === 'funded' ? b.endUtc : b.startUtc) > Date.now() && ['draft', 'funded'].includes(b.status);
   const article = compact ? renderPerformerBookingInvite({ booking: b, wallet, serviceUrl, ethers, fetchImpl }) : document.createElement('div');
   const afterparty = b.mode === 'phase1' && b.payoutPolicy === LIVE_PILOT_POLICY &&
     (Date.parse(b.endUtc) <= Date.now() || ['approved', 'paid'].includes(b.status));
   const connected = window._wallet?.address || '';
   const claim = claimState(b, state.escrowAddress, connected);
   const pendingHash = connected.toLowerCase() === b.wallet.toLowerCase() && !['paid', 'refunded'].includes(b.status)
     ? localStorage.getItem(`live-claim:${b.id}`) : null;
   let nextStatus;
   if (afterparty) {
     article.className = 'live-performer-next';
     article.setAttribute('data-live-next-step', b.id);
     article.setAttribute('data-action-needed', String(claim.enabled || !!pendingHash));
     const title = document.createElement('h3');
     title.textContent = b.status === 'paid' ? '✓ Your performance fee is paid'
       : pendingHash ? 'Your next step · check your claim'
         : claim.enabled ? 'Your next step · claim your fee' : 'Your set is finished · thank you!';
     const amount = document.createElement('p');
     amount.className = 'live-performer-fee';
     amount.textContent = `$${(Number(b.status === 'paid' ? b.paidUnits || b.approvedUnits || b.amountUnits : b.approvedUnits || b.amountUnits) / 1e6).toFixed(2)} USDC · Base`;
     nextStatus = document.createElement('output');
     nextStatus.setAttribute('role', 'status');
     nextStatus.setAttribute('aria-live', 'polite');
     nextStatus.textContent = b.status === 'paid' ? 'Confirmed on-chain. No payment action needed.'
       : pendingHash ? 'Your transaction is saved. Check it below; do not send a second claim.'
         : claim.enabled ? 'Ready for you. Claim to your booked wallet; a little Base ETH is needed for gas.'
           : b.status === 'funded' && Date.now() <= Date.parse(b.claimDeadline) &&
             Date.now() < Date.parse(b.endUtc) + b.reviewWindow * 1000 ? 'Jolly’s next step: approve your guaranteed fee. Nothing for you to sign yet.'
             : claim.label;
     article.append(title, amount, nextStatus);
   } else if (!compact) article.innerHTML = liveBookingRows([b]);
   if (!compact && b.mode === 'phase1' && b.status === 'draft' && !b.cancelled) {
     article.append(renderPerformerBookingInvite({ booking: b, state, wallet, serviceUrl, ethers, fetchImpl }));
   }
   if (!compact && b.mode === 'phase1' && b.payoutPolicy === LIVE_PILOT_POLICY && !b.cancelled && Date.parse(b.endUtc) > Date.now()) {
     const directions = document.createElement('p');
     directions.setAttribute('data-live-performer-directions', '');
     const checkTime = minutes => new Intl.DateTimeFormat('en-US', {
       timeZone: 'America/New_York', timeStyle: 'short',
     }).format(new Date(Date.parse(b.startUtc) - minutes * 60_000));
     directions.textContent = `Profile: review and accept → wait for confirmed escrow funding → open performer audio room → authorize your booked wallet, allow microphone and publish browser audio → private checks at ${checkTime(60)} and ${checkTime(15)} New York → ON-AIR only after both checks pass and the operator arms broadcast → claim here after approval or the review window, before the claim deadline. Keep the audio room open. Acceptance is a real agreement, not a payment or a simulated signature.`;
     article.append(directions);
   }
   const roomUrl = liveAudioRoomUrl(b);
   if (roomUrl) {
     const entry = document.createElement('p');
     const link = document.createElement('a');
     link.href = roomUrl;
     link.textContent = compact ? '🎙 Open your rehearsal room' : 'Open performer audio room';
     link.setAttribute('data-live-room', 'performer');
     const notice = document.createElement('small');
     notice.textContent = compact ? 'Opens 70 minutes before your set. Connect your invited wallet, allow your mic, and keep the room open. Jolly checks the sound before taking you live. Room hosting may be unavailable.' : 'This link does not grant access. Authorize with the booked performer wallet; hosting may be unavailable. Private checks open at T−70 minutes. Keep the room open while publishing browser audio.';
     entry.append(link, document.createElement('br'), notice);
     article.append(entry);
   }
   const button = document.createElement('button');
   let refresh;
   button.type = 'button'; button.disabled = !claim.enabled && !pendingHash;
   button.className = afterparty ? 'live-performer-claim' : '';
   const amount = (Number(b.approvedUnits || b.amountUnits) / 1e6).toFixed(2);
   button.textContent = pendingHash ? 'Check pending claim' : afterparty && claim.enabled ? `Claim $${amount} USDC` : claim.label;
   button.onclick = async () => {
     button.disabled = true;
     if (refresh) refresh.disabled = true;
     article.setAttribute('data-live-claim-busy', 'true');
     if (nextStatus) nextStatus.textContent = 'Opening your wallet on Base…';
     try {
       const provider = new ethers.BrowserProvider(window.ethereum);
       const signer = await provider.getSigner();
       if ((await provider.getNetwork()).chainId !== 8453n || (await signer.getAddress()).toLowerCase() !== b.wallet.toLowerCase()) throw new Error('Connect performer wallet on Base');
       const previous = localStorage.getItem(`live-claim:${b.id}`);
       if (previous) {
         const receipt = await provider.getTransactionReceipt(previous);
         if (!receipt) { button.textContent = 'Check pending claim'; button.disabled = false; if (nextStatus) nextStatus.textContent = `Still pending: ${previous}. Do not send again.`; return; }
         localStorage.removeItem(`live-claim:${b.id}`);
         button.textContent = receipt.status === 1 ? 'Previous claim confirmed; refresh indexed receipt' : 'Previous claim reverted; refresh before retrying';
         if (nextStatus) nextStatus.textContent = receipt.status === 1 ? 'Previous transaction confirmed. Refresh payment status for the indexed payment receipt.'
           : 'Previous transaction reverted. Refresh payment status before retrying.';
         document.dispatchEvent(new CustomEvent('live-booking-claim-updated'));
         return;
       }
       const contract = new ethers.Contract(state.escrowAddress, LIVE_ESCROW_ABI, signer);
       const tx = await contract.claim(ethers.id(b.id));
       localStorage.setItem(`live-claim:${b.id}`,tx.hash);
       button.textContent = `Claim pending: ${tx.hash}`;
       if (nextStatus) nextStatus.textContent = `Claim submitted. Waiting for confirmation: ${tx.hash}`;
       const receipt = await tx.wait(2);
       if (receipt?.status !== 1) throw new Error('Claim did not confirm successfully');
       button.textContent = 'Claim confirmed; refresh for indexed receipt';
       if (nextStatus) nextStatus.textContent = '✓ Claim confirmed on Base. Refresh payment status for the indexed receipt.';
       announcePaymentCelebration({ chainId:8453, txHash:tx.hash, amountText:String(Number(b.approvedUnits || b.amountUnits)/1e6), assetText:'USDC', summary:'Live performance claim confirmed', txLabel:'Claim confirmed' });
       localStorage.removeItem(`live-claim:${b.id}`);
       document.dispatchEvent(new CustomEvent('live-booking-claim-updated'));
     } catch (error) {
       const message = `${error.shortMessage || error.message}. Refresh payment status to reconcile before retrying.`;
       if (nextStatus) { nextStatus.textContent = message; button.textContent = 'Claim needs attention'; }
       else button.textContent = message;
     } finally {
       article.setAttribute('data-live-claim-busy', 'false');
       if (refresh) refresh.disabled = false;
     }
   };
   if (afterparty) {
     if (claim.enabled || pendingHash) article.append(button);
     refresh = document.createElement('button');
     refresh.type = 'button'; refresh.className = 'live-performer-refresh';
     refresh.textContent = 'Refresh payment status';
     refresh.onclick = async () => {
       if (article.getAttribute('data-live-claim-busy') === 'true') return;
       refresh.disabled = true;
       try { await renderLivePerformances({ container, wallet, serviceUrl, ethers, onReceipt, fetchImpl }); }
       catch (error) { nextStatus.textContent = `Payment status unavailable: ${error.message}`; refresh.disabled = false; }
     };
     article.append(refresh);
     const details = document.createElement('details');
     details.className = 'live-performer-details';
     const summary = document.createElement('summary'); summary.textContent = 'Agreement & receipts';
     const contents = document.createElement('div'); contents.innerHTML = liveBookingRows([b]);
     details.append(summary, contents); article.append(details);
   } else if (!compact || claim.enabled || pendingHash) article.append(button);
   container.append(article);
   const gift = renderPerformerGift({ booking: b, wallet, ethers, config: window.DecentConfig,
     onReveal: () => celebrateLiveInvitation() });
   if (gift) container.append(gift);
 }
 const receipt = liveReceiptEntry(bookings, wallet);
 if (receipt) onReceipt(receipt);
}
