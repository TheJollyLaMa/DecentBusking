import { LIVE_ESCROW_ABI, LIVE_PILOT_POLICY } from './live-bookings.mjs?v=20261114-tip-provenance';
import { createBrowserIpfsUploader } from './ipfs-upload.js?v=20261015-mime-sniff';
import { BASE_CHAIN_ID, FULL_PAYOUT_BPS, classifyTxError, formatUsdc, parseUnits, releasePreflight, shortError } from './live-afterparty.mjs?v=20261115-afterparty';

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const pendingKey = id => `live-pending:${id}:approve`;
const reportKey = id => `live-release-report:${id}`;
// Written just before the wallet opens, so an approval whose hash was never saved cannot be re-sent blindly.
// It is released by a verified on-chain approval, a wallet rejection, or after the hold when Base still shows the escrow funded.
const RESERVATION = 'approval-wallet-result-unknown';
const RESERVATION_HOLD_MS = 10 * 60_000;
const isReservation = value => typeof value === 'string' && value.startsWith(RESERVATION);
const reservationHeld = (value, now) => {
  const at = Number(String(value).slice(RESERVATION.length + 1));
  return Number.isFinite(at) && at > 0 && Math.abs(now - at) < RESERVATION_HOLD_MS;
};
const ROLE_ABI = ['function hasRole(bytes32,address) view returns (bool)', 'function paused() view returns (bool)'];
const toSeconds = iso => { const ms = Date.parse(iso); return Number.isInteger(ms / 1000) ? BigInt(ms / 1000) : null; };
const toBig = value => { try { return BigInt(value); } catch { return null; } };

// `kind` tells the guided panel whether nothing was sent or a transaction may exist, without parsing messages.
export class ReleaseError extends Error {
  constructor(message, kind = 'error', hash = null) { super(message); this.name = 'ReleaseError'; this.kind = kind; this.hash = hash; }
}

function unknownPendingApproval() {
  return new ReleaseError('A previous approval may have been submitted, but its hash is unavailable. Check MetaMask activity and do not send another approval. Re-check here in about 10 minutes: an approval confirmed on Base shows as approved, and if Base still shows the escrow funded the release unlocks again.', 'unsaved');
}

export function compareOnchainBooking(onchain, booking, address) {
  const checks = {
    performer: same(onchain.performer, booking.wallet), funder: same(onchain.funder, address), termsHash: same(onchain.termsHash, booking.termsHash),
    amount: onchain.amount === parseUnits(booking.amountUnits), showStart: onchain.showStart === toSeconds(booking.startUtc),
    showEnd: onchain.showEnd === toSeconds(booking.endUtc), claimDeadline: onchain.claimDeadline === toSeconds(booking.claimDeadline),
    reviewWindow: onchain.reviewWindow === toBig(booking.reviewWindow), cancellationWindow: onchain.cancellationWindow === toBig(booking.cancellationWindow),
    killFeeBps: onchain.killFeeBps === toBig(booking.killFeeBps),
  };
  return Object.entries(checks).filter(([, ok]) => !ok).map(([field]) => field);
}

// Read-only. Role and pause state are advisory: the simulation just before signing remains the authoritative check.
async function readRoleFacts({ ethers, provider, escrowAddress, address }) {
  if (typeof ethers?.Contract !== 'function' || typeof ethers?.id !== 'function') return {};
  try {
    const roles = new ethers.Contract(escrowAddress, ROLE_ABI, provider);
    const [hasRole, paused] = await Promise.allSettled([roles.hasRole(ethers.id('ADMIN_ROLE'), address), roles.paused()]);
    return { hasRole: hasRole.status === 'fulfilled' ? hasRole.value : undefined, paused: paused.status === 'fulfilled' ? paused.value : undefined };
  } catch { return {}; }
}

export async function readChainFacts({ booking, escrowAddress, wallet, contract: supplied }) {
  const { ethers, provider, address } = wallet;
  try {
    const contract = supplied || new ethers.Contract(escrowAddress, LIVE_ESCROW_ABI, provider);
    const [onchain, block] = await Promise.all([contract.bookings(ethers.id(booking.id)), provider.getBlock('latest')]);
    return { status: Number(onchain.status), amountUnits: String(onchain.amount), payoutUnits: String(onchain.payoutAmount ?? 0n),
      blockTime: Number(block?.timestamp), mismatches: compareOnchainBooking(onchain, booking, address),
      ...await readRoleFacts({ ethers, provider, escrowAddress, address }) };
  } catch (error) { return { error: shortError(error) }; }
}

export function liveBroadcastCompletionPending(b) {
  return Object.hasOwn(b, 'broadcastCompletion') &&
    (b.broadcastCompletion?.known !== true || b.broadcastCompletion?.pending !== false);
}

export function guaranteedReleaseState(b, now = Date.now()) {
  if (b.mode !== 'phase1' || b.payoutPolicy !== LIVE_PILOT_POLICY) return null;
  if (b.status === 'paid') return { label: 'Payment claimed', disabled: true, detail: 'Confirmed performer claim. No further release needed.' };
  if (b.status === 'approved') return { label: 'Approved · performer can claim', disabled: true, detail: 'Owner approval confirmed. The performer claims the USDC from their Profile.' };
  if (b.status !== 'funded') return { label: 'Escrow release unavailable', disabled: true, detail: 'Requires confirmed booking escrow funding.' };
  if (now < Date.parse(b.endUtc)) return { label: 'Available after the set', disabled: true, detail: 'The booked end must pass before escrow approval.' };
  if (now >= Date.parse(b.claimDeadline)) return { label: 'Claim deadline passed', disabled: true, detail: 'Review the contract state; do not send a duplicate payment.' };
  if (now >= Date.parse(b.endUtc) + b.reviewWindow * 1000) return { label: 'Performer can claim full fee', disabled: true, detail: 'The review window ended. Ask the performer to claim from Profile; no owner approval required.' };
  if (liveBroadcastCompletionPending(b)) return { label: b.broadcastCompletion?.known
    ? 'Waiting for allocated stage completion' : 'Stage completion unavailable', disabled: true,
    detail: 'New completion/release actions wait for verified actual stage completion. Your original guaranteed fee and contract claim/review times are unchanged; reconcile any existing transaction instead of sending another.' };
  const amount = formatUsdc(b.amountUnits);
  if (amount === null || BigInt(b.amountUnits) === 0n) return { label: 'Escrow release unavailable', disabled: true, detail: 'The booking has no valid guaranteed fee amount.' };
  return { label: `Release full $${amount} from escrow`, disabled: false,
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

function verifyApprovalReceipt({ receipt, contract, escrowAddress, bookingId, booking }) {
  if (!receipt || receipt.status !== 1 || !same(receipt.to, escrowAddress)) {
    throw new ReleaseError('Escrow approval did not confirm successfully. No new transaction was sent.', receipt?.status === 1 ? 'mismatch' : 'reverted', receipt?.hash);
  }
  const matches = [];
  for (const log of receipt.logs) {
    if (!same(log.address, escrowAddress)) continue;
    let event;
    try { event = contract.interface.parseLog(log); } catch { continue; }
    if (event?.name === 'PerformanceApproved' && same(event.args.bookingId, bookingId) &&
        same(event.args.termsHash, booking.termsHash) && BigInt(event.args.payoutBps) === BigInt(FULL_PAYOUT_BPS) &&
        BigInt(event.args.payoutAmount) === BigInt(booking.amountUnits) && BigInt(event.args.refundAmount) === 0n) matches.push(event);
  }
  if (matches.length !== 1) throw new ReleaseError('Receipt is missing the exact full-fee escrow approval. Keep the transaction hash and reconcile; do not send again.', 'mismatch', receipt.hash);
  return matches[0].args.reportUri;
}

// Looks up a previously submitted approval. It never sends: pending/confirming/reverted come back as typed errors.
async function readSavedApproval({ hash, booking, provider, storage, progress, track }) {
  track.stage = 'reconcile';
  track.hash = hash;
  progress(`Checking existing approval ${hash}. No duplicate transaction will be sent.`);
  const receipt = await provider.getTransactionReceipt(hash);
  if (!receipt) throw new ReleaseError(`Approval still pending: ${hash}. Check MetaMask/Base; retry here only to reconcile.`, 'pending', hash);
  if (receipt.status === 0) {
    storage.removeItem(pendingKey(booking.id));
    throw new ReleaseError(`Previous approval reverted: ${hash}. No payment released. Review the failure before retrying.`, 'reverted', hash);
  }
  if (await provider.getBlockNumber() - receipt.blockNumber + 1 < 2) throw new ReleaseError(`Approval awaiting two confirmations: ${hash}. Retry to reconcile.`, 'confirming', hash);
  return receipt;
}

const emitter = onState => event => {
  try { onState?.(event); } catch { /* a display failure must never change an on-chain flow */ }
};

function failureEvent(error, track) {
  const hash = error?.hash || error?.receipt?.hash || track.hash || null, message = shortError(error);
  let kind = error instanceof ReleaseError ? error.kind : classifyTxError(error);
  if (kind === 'pending') return { type: 'submitted', hash };
  if (kind === 'confirming') return { type: 'confirming', hash };
  if (kind === 'unsaved') return { type: 'unknown', kind, message, hash };
  if (kind === 'rejected') return { type: 'failed', kind, message: '', hash };
  if (hash && ['wait', 'reconcile'].includes(track.stage) && ['error', 'unavailable'].includes(kind)) {
    return { type: 'unknown', kind: 'unconfirmed', message: `The transaction was sent, but its result could not be read: ${message}`, hash };
  }
  if (track.stage === 'report') kind = 'upload';
  else if (kind === 'error' && ['check', 'simulate'].includes(track.stage)) kind = 'precheck';
  return { type: 'failed', kind, message, hash };
}

export async function releaseGuaranteedEscrow(options) {
  const track = { stage: 'check', hash: null }, emit = emitter(options.onState);
  try { return await runRelease(options, track, emit); }
  catch (error) { emit(failureEvent(error, track)); throw error; }
}

async function runRelease({ booking, escrowAddress, wallet, storage = localStorage,
  serviceUrl, origin, onProgress = () => {}, uploadReport, contract: suppliedContract }, track, emit) {
  const { ethers, signer, address, provider, check } = wallet;
  await check();
  const contract = suppliedContract || new ethers.Contract(escrowAddress, LIVE_ESCROW_ABI, signer);
  const bookingId = ethers.id(booking.id);
  const progress = message => onProgress(message);
  const savedHash = storage.getItem(pendingKey(booking.id));

  async function confirmed(receipt) {
    const reportUri = verifyApprovalReceipt({ receipt, contract, escrowAddress, bookingId, booking });
    emit({ type: 'confirmed', hash: receipt.hash, verified: true, reportUri });
    try { await check(); } catch { /* the receipt already proves the approval; a later wallet switch cannot undo it */ }
    storage.removeItem(pendingKey(booking.id));
    progress('✓ Full fee approved on Base. Performer can now claim from Profile. Approval is not payment received.');
    return { txHash: receipt.hash, reportUri, approved: true };
  }

  if (isReservation(savedHash)) {
    if (reservationHeld(savedHash, Date.now())) throw unknownPendingApproval();
    storage.removeItem(pendingKey(booking.id));
  } else if (savedHash) return confirmed(await readSavedApproval({ hash: savedHash, booking, provider, storage, progress, track }));

  const available = guaranteedReleaseState(booking);
  if (!available || available.disabled) throw new ReleaseError(available?.detail || 'This action is only for guaranteed pilot escrow bookings.', 'precheck');
  if (!/^0x[0-9a-f]{40}$/i.test(escrowAddress || '')) throw new ReleaseError('Escrow contract is unavailable.', 'precheck');

  async function validateBooking() {
    await check();
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(BASE_CHAIN_ID)) throw new ReleaseError('Switch to Base (8453).', 'precheck');
    const b = await contract.bookings(bookingId);
    if (compareOnchainBooking(b, booking, address).length) throw new ReleaseError('On-chain booking does not match the funded performer, fee or accepted terms.', 'precheck');
    if (Number(b.status) !== 1) throw new ReleaseError('Escrow is no longer in funded status. Refresh to check approval/claim; do not send again.', 'precheck');
    const block = await provider.getBlock('latest');
    const now = block.timestamp;
    if (now < Number(b.showEnd) || now >= Number(b.showEnd) + Number(b.reviewWindow) ||
        now >= Number(b.claimDeadline)) throw new ReleaseError('Outside the on-chain owner review window. Refresh booking/claim status.', 'precheck');
  }

  progress('Checking the funded booking on Base…');
  await validateBooking();
  const report = fullFeeReport(booking);
  const fingerprint = JSON.stringify(report);
  let cached;
  const stored = storage.getItem(reportKey(booking.id));
  if (stored) {
    try { cached = JSON.parse(stored); } catch { throw new ReleaseError('Saved report receipt is unreadable. Review browser storage before retrying.', 'precheck'); }
  }
  let reportUri = cached?.fingerprint === fingerprint ? cached.uri : '';
  if (reportUri && !/^ipfs:\/\/[a-zA-Z0-9]+$/.test(reportUri)) throw new ReleaseError('Saved report URI is invalid. Review the report before retrying.', 'precheck');
  if (!reportUri) {
    track.stage = 'report';
    emit({ type: 'report-signing' });
    progress('Preparing the public guaranteed-fee report. Approve the upload signature in your wallet…');
    const upload = uploadReport || createBrowserIpfsUploader({ serviceUrl, signer, address, origin });
    reportUri = await upload(new File([JSON.stringify(report, null, 2) + '\n'], 'guaranteed-performance-fee-report.json', { type: 'application/json' }));
    if (!/^ipfs:\/\/[a-zA-Z0-9]+$/.test(reportUri || '')) throw new ReleaseError('Report upload did not return a valid IPFS URI.', 'upload');
    storage.setItem(reportKey(booking.id), JSON.stringify({ fingerprint, uri: reportUri }));
  }
  emit({ type: 'report-pinned', uri: reportUri });
  progress('Report pinned. Checking escrow approval before opening the transaction…');
  track.stage = 'simulate';
  await validateBooking();
  const approve = contract.getFunction('approve(bytes32,uint16,string)');
  await approve.staticCall(bookingId, FULL_PAYOUT_BPS, reportUri);
  await check();
  track.stage = 'sign';
  try {
    const reservation = `${RESERVATION}:${Date.now()}`;
    storage.setItem(pendingKey(booking.id), reservation);
    if (storage.getItem(pendingKey(booking.id)) !== reservation) throw new Error('Pending approval reservation was not saved');
  } catch {
    throw new ReleaseError('Browser storage could not reserve a place for the approval. No escrow approval was sent; restore storage and retry.', 'precheck');
  }
  emit({ type: 'signing' });
  progress('Confirm full-fee escrow approval in MetaMask. This does not fund the booking again.');
  let tx;
  try {
    tx = await approve(bookingId, FULL_PAYOUT_BPS, reportUri);
  } catch (error) {
    if (classifyTxError(error) !== 'rejected') throw unknownPendingApproval();
    try { storage.removeItem(pendingKey(booking.id)); }
    catch { throw new ReleaseError('The wallet rejected the approval, but browser storage could not clear its reservation. Check storage before retrying.', 'precheck'); }
    throw error;
  }
  track.stage = 'wait';
  track.hash = tx.hash;
  emit({ type: 'submitted', hash: tx.hash });
  try { storage.setItem(pendingKey(booking.id), tx.hash); }
  catch { throw new ReleaseError(`Approval already submitted: ${tx.hash}, but browser could not save its hash. Do not retry release; reconcile this transaction from MetaMask.`, 'unsaved', tx.hash); }
  progress(`Approval submitted: ${tx.hash}. Waiting for two confirmations; do not send again.`);
  let receipt;
  try { receipt = await tx.wait(2); }
  catch (error) {
    if (error.code !== 'TRANSACTION_REPLACED' || !error.receipt) throw error;
    if (error.cancelled) {
      storage.removeItem(pendingKey(booking.id));
      throw new ReleaseError(`Approval transaction was cancelled/replaced (${error.receipt.hash}). No escrow approval is certified. Refresh contract status before trying again.`, 'replaced', error.receipt.hash);
    }
    receipt = error.receipt;
    track.hash = receipt.hash;
    storage.setItem(pendingKey(booking.id), receipt.hash);
  }
  return confirmed(receipt);
}

// Read-only: reconciles a submitted approval or runs the pre-signing checks. It never uploads, signs or sends.
export async function checkGuaranteedRelease({ booking, escrowAddress, session = {}, storage = localStorage, now = Date.now(),
  knownHash = null, onState, onProgress = () => {}, contract: supplied }) {
  const emit = emitter(onState), track = { stage: 'check', hash: null }, wallet = session.wallet;
  emit({ type: 'checking' });
  try {
    const saved = storage.getItem(pendingKey(booking.id));
    const reserved = isReservation(saved);
    const hash = reserved ? knownHash : saved || knownHash;
    if (hash && wallet && session.facts?.chainId === BASE_CHAIN_ID) {
      const contract = supplied || new wallet.ethers.Contract(escrowAddress, LIVE_ESCROW_ABI, wallet.provider);
      const receipt = await readSavedApproval({ hash, booking, provider: wallet.provider, storage, progress: onProgress, track });
      const reportUri = verifyApprovalReceipt({ receipt, contract, escrowAddress, bookingId: wallet.ethers.id(booking.id), booking });
      storage.removeItem(pendingKey(booking.id));
      emit({ type: 'confirmed', hash: receipt.hash, verified: true, reportUri });
      return { outcome: 'approved', txHash: receipt.hash, reportUri };
    }
    const facts = { checked: true, ...session.facts };
    if (wallet && facts.chainId === BASE_CHAIN_ID) {
      facts.chain = await readChainFacts({ booking, escrowAddress, wallet, contract: supplied });
      if (approvedOnChain(booking, facts.chain)) {
        if (reserved) storage.removeItem(pendingKey(booking.id));
        emit({ type: 'confirmed', source: 'chain-state', verified: true });
        return { outcome: 'approved', source: 'chain-state', chain: facts.chain };
      }
    }
    if (reserved && !hash) {
      // Only a readable, still-funded escrow after the hold releases the reservation; the checks and simulation then decide.
      if (reservationHeld(saved, now) || !facts.chain || facts.chain.error || facts.chain.status !== 1) throw unknownPendingApproval();
      storage.removeItem(pendingKey(booking.id));
    }
    const preflight = releasePreflight({ booking, facts, now });
    if (hash) preflight.pendingHash = hash;
    emit({ type: 'preflight', preflight });
    return { outcome: hash ? 'pending-unverified' : preflight.ready ? 'ready' : preflight.blocked ? 'blocked' : 'unavailable', preflight, facts };
  } catch (error) {
    const event = failureEvent(error, track);
    emit(event);
    return { outcome: { submitted: 'pending', confirming: 'confirming', unknown: 'unknown' }[event.type] || event.kind, error };
  }
}

function approvedOnChain(booking, chain) {
  if (!chain || chain.error || chain.status !== 2 || (chain.mismatches || []).some(field => field !== 'funder')) return false;
  const amount = parseUnits(booking.amountUnits);
  return amount !== null && parseUnits(chain.amountUnits) === amount && parseUnits(chain.payoutUnits) === amount;
}

// One guided action: checks first, then the wallet-signed steps. Blocked or unverified checks never ask for a signature.
export async function guidedGuaranteedRelease(options) {
  const checked = await checkGuaranteedRelease(options);
  if (checked.outcome !== 'ready') return checked;
  if (!options.session?.wallet) return { ...checked, outcome: 'unavailable' };
  const result = await releaseGuaranteedEscrow({ ...options, wallet: options.session.wallet });
  return { outcome: 'approved', ...result };
}
