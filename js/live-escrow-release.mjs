import { LIVE_ESCROW_ABI, LIVE_PILOT_POLICY } from './live-bookings.mjs?v=20261108-live-audio-pilot';
import { createBrowserIpfsUploader } from './ipfs-upload.js?v=20261015-mime-sniff';

const BOOKING_ABI = 'function bookings(bytes32) view returns ((address performer,address funder,uint256 amount,uint256 payoutAmount,uint64 showStart,uint64 showEnd,uint64 claimDeadline,uint32 reviewWindow,uint32 cancellationWindow,uint16 killFeeBps,bytes32 termsHash,uint8 status))';
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const pendingKey = id => `live-pending:${id}:approve`;
const reportKey = id => `live-release-report:${id}`;

export function guaranteedReleaseState(b, now = Date.now()) {
  if (b.mode !== 'phase1' || b.payoutPolicy !== LIVE_PILOT_POLICY) return null;
  if (b.status === 'paid') return { label: 'Payment claimed', disabled: true, detail: 'Confirmed performer claim. No further release needed.' };
  if (b.status === 'approved') return { label: 'Approved · performer can claim', disabled: true, detail: 'Owner approval confirmed. The performer claims the USDC from their Profile.' };
  if (b.status !== 'funded') return { label: 'Escrow release unavailable', disabled: true, detail: 'Requires confirmed booking escrow funding.' };
  if (now < Date.parse(b.endUtc)) return { label: 'Available after the set', disabled: true, detail: 'The booked end must pass before escrow approval.' };
  if (now >= Date.parse(b.claimDeadline)) return { label: 'Claim deadline passed', disabled: true, detail: 'Review the contract state; do not send a duplicate payment.' };
  if (now >= Date.parse(b.endUtc) + b.reviewWindow * 1000) return { label: 'Performer can claim full fee', disabled: true, detail: 'The review window ended. Ask the performer to claim from Profile; no owner approval required.' };
  return { label: `Release full $${(Number(b.amountUnits) / 1e6).toFixed(2)} from escrow`, disabled: false,
    detail: 'Automatically prepares a public full-fee report, then asks your wallet to approve escrow release. Performer claims afterward. No manual report link or rehearsal score required.' };
}

export function fullFeeReport(b) {
  return {
    schema: 'decentbusking-guaranteed-fee-release-v1', bookingId: b.id, performerWallet: b.wallet,
    title: b.title, startUtc: b.startUtc, endUtc: b.endUtc, termsUri: b.termsUri, termsHash: b.termsHash,
    amountUnits: b.amountUnits, asset: 'USDC', chainId: 8453, payoutBps: 10000,
    reason: 'Release the full guaranteed pilot fee under the accepted booking terms, independent of rehearsal coverage or technical outcome.',
    evidenceLimit: 'This report does not certify listening duration, recording publication, NFT minting or payment received. Contract approval and performer claim require separate confirmed events.',
  };
}

export async function releaseGuaranteedEscrow({ booking, escrowAddress, wallet, storage = localStorage,
  serviceUrl, origin, onProgress = () => {}, uploadReport, contract: suppliedContract }) {
  const { ethers, signer, address, provider, check } = wallet;
  await check();
  const contract = suppliedContract || new ethers.Contract(escrowAddress, [...LIVE_ESCROW_ABI, BOOKING_ABI], signer);
  const bookingId = ethers.id(booking.id);
  const progress = message => onProgress(message);
  const savedHash = storage.getItem(pendingKey(booking.id));

  function verifyReceipt(receipt) {
    if (!receipt || receipt.status !== 1 || !same(receipt.to, escrowAddress)) throw new Error('Escrow approval did not confirm successfully. No new transaction was sent.');
    const matches = [];
    for (const log of receipt.logs) {
      if (!same(log.address, escrowAddress)) continue;
      let event;
      try { event = contract.interface.parseLog(log); } catch { continue; }
      if (event?.name === 'PerformanceApproved' && event.args.bookingId === bookingId &&
          same(event.args.termsHash, booking.termsHash) && BigInt(event.args.payoutBps) === 10000n &&
          BigInt(event.args.payoutAmount) === BigInt(booking.amountUnits) && BigInt(event.args.refundAmount) === 0n) matches.push(event);
    }
    if (matches.length !== 1) throw new Error('Receipt is missing the exact full-fee escrow approval. Keep the transaction hash and reconcile; do not send again.');
    return matches[0].args.reportUri;
  }

  async function confirmed(receipt) {
    const reportUri = verifyReceipt(receipt);
    await check();
    storage.removeItem(pendingKey(booking.id));
    progress('✓ Full fee approved on Base. Performer can now claim from Profile. Approval is not payment received.');
    return { txHash: receipt.hash, reportUri, approved: true };
  }

  if (savedHash) {
    progress(`Checking existing approval ${savedHash}. No duplicate transaction will be sent.`);
    const receipt = await provider.getTransactionReceipt(savedHash);
    if (!receipt) throw new Error(`Approval still pending: ${savedHash}. Check MetaMask/Base; retry here only to reconcile.`);
    if (receipt.status === 0) {
      storage.removeItem(pendingKey(booking.id));
      throw new Error(`Previous approval reverted: ${savedHash}. No payment released. Review the failure before retrying.`);
    }
    if (await provider.getBlockNumber() - receipt.blockNumber + 1 < 2) throw new Error(`Approval awaiting two confirmations: ${savedHash}. Retry to reconcile.`);
    return confirmed(receipt);
  }

  const available = guaranteedReleaseState(booking);
  if (!available || available.disabled) throw new Error(available?.detail || 'This action is only for guaranteed pilot escrow bookings.');
  if (!/^0x[0-9a-f]{40}$/i.test(escrowAddress || '')) throw new Error('Escrow contract is unavailable.');

  async function validateBooking() {
    await check();
    const network = await provider.getNetwork();
    if (network.chainId !== 8453n) throw new Error('Switch to Base (8453).');
    const b = await contract.bookings(bookingId);
    if (!same(b.performer, booking.wallet) || !same(b.funder, address) || !same(b.termsHash, booking.termsHash) ||
        b.amount !== BigInt(booking.amountUnits) || b.showStart !== BigInt(Date.parse(booking.startUtc) / 1000) ||
        b.showEnd !== BigInt(Date.parse(booking.endUtc) / 1000) ||
        b.claimDeadline !== BigInt(Date.parse(booking.claimDeadline) / 1000) ||
        b.reviewWindow !== BigInt(booking.reviewWindow) || b.cancellationWindow !== BigInt(booking.cancellationWindow) ||
        b.killFeeBps !== BigInt(booking.killFeeBps)) throw new Error('On-chain booking does not match the funded performer, fee or accepted terms.');
    if (Number(b.status) !== 1) throw new Error('Escrow is no longer in funded status. Refresh to check approval/claim; do not send again.');
    const block = await provider.getBlock('latest');
    const now = block.timestamp;
    if (now < Number(b.showEnd) || now >= Number(b.showEnd) + Number(b.reviewWindow) ||
        now >= Number(b.claimDeadline)) throw new Error('Outside the on-chain owner review window. Refresh booking/claim status.');
  }

  progress('Checking the funded booking on Base…');
  await validateBooking();
  const report = fullFeeReport(booking);
  const fingerprint = JSON.stringify(report);
  let cached;
  const stored = storage.getItem(reportKey(booking.id));
  if (stored) {
    try { cached = JSON.parse(stored); } catch { throw new Error('Saved report receipt is unreadable. Review browser storage before retrying.'); }
  }
  let reportUri = cached?.fingerprint === fingerprint ? cached.uri : '';
  if (reportUri && !/^ipfs:\/\/[a-zA-Z0-9]+$/.test(reportUri)) throw new Error('Saved report URI is invalid. Review the report before retrying.');
  if (!reportUri) {
    progress('Preparing the public guaranteed-fee report. Approve the upload signature in your wallet…');
    const upload = uploadReport || createBrowserIpfsUploader({ serviceUrl, signer, address, origin });
    reportUri = await upload(new File([JSON.stringify(report, null, 2) + '\n'], 'guaranteed-performance-fee-report.json', { type: 'application/json' }));
    if (!/^ipfs:\/\/[a-zA-Z0-9]+$/.test(reportUri || '')) throw new Error('Report upload did not return a valid IPFS URI.');
    storage.setItem(reportKey(booking.id), JSON.stringify({ fingerprint, uri: reportUri }));
  }
  progress('Report pinned. Checking escrow approval before opening the transaction…');
  await validateBooking();
  const approve = contract.getFunction('approve(bytes32,uint16,string)');
  await approve.staticCall(bookingId, 10000, reportUri);
  await check();
  progress('Confirm full-fee escrow approval in MetaMask. This does not fund the booking again.');
  const tx = await approve(bookingId, 10000, reportUri);
  try { storage.setItem(pendingKey(booking.id), tx.hash); }
  catch { throw new Error(`Approval already submitted: ${tx.hash}, but browser could not save its hash. Do not retry release; reconcile this transaction from MetaMask.`); }
  progress(`Approval submitted: ${tx.hash}. Waiting for two confirmations; do not send again.`);
  let receipt;
  try { receipt = await tx.wait(2); }
  catch (error) {
    if (error.code !== 'TRANSACTION_REPLACED' || !error.receipt) throw error;
    if (error.cancelled) {
      storage.removeItem(pendingKey(booking.id));
      throw new Error(`Approval transaction was cancelled/replaced (${error.receipt.hash}). No escrow approval is certified. Refresh contract status before trying again.`);
    }
    receipt = error.receipt;
    storage.setItem(pendingKey(booking.id), receipt.hash);
  }
  return confirmed(receipt);
}
