import { announcePaymentCelebration } from './payment-celebration.mjs';
import { LIVE_ESCROW_ABI, claimState, liveBookingRows } from './live-bookings.mjs';

export function liveReceiptEntry(bookings, wallet) {
 const paid = bookings.filter(b => b.mode === 'phase1' && b.wallet.toLowerCase() === wallet.toLowerCase() && BigInt(b.paidUnits || 0) > 0n);
 if (!paid.length) return null;
 return { kind:'live-performance', label:'Live performances', asset:'USDC', status:'paid', count:paid.length,
   units:paid.reduce((n,b) => n + BigInt(b.paidUnits),0n), transactions:paid.map(b => {
     const tx = b.transactions.PerformancePaid;
     return { title:b.title, hash:tx.hash, blockNumber:tx.blockNumber, units:b.paidUnits, url:`https://basescan.org/tx/${tx.hash}` };
   }) };
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
