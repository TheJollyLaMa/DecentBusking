import { Contract, Interface, id, verifyMessage } from 'ethers';
import {
  LIVE_FUND, LIVE_ROUTER, LIVE_USDC, LIVE_ESCROW_ABI,
  LIVE_PERFORMANCE_AIRTIME_MINUTES, LIVE_PERFORMANCE_FULL_PAYOUT_MINUTES, LIVE_PERFORMANCE_FEE_UNITS,
  liveAcknowledgement, livePerformancePayoutBps, workReference,
} from '../js/live-bookings.mjs';
import { cancelLivePerformanceEvent, upsertLivePerformanceEvent } from '../js/radio-schedule.mjs';

const routerInterface = new Interface([
  'event FundRecovered(bytes32 indexed fundId,address indexed asset,address indexed recipient,uint256 amount)',
  'event FundFunded(bytes32 indexed fundId,address indexed asset,address indexed funder,uint256 amount)',
  'event PayrollPaid(bytes32 indexed fundId,address indexed asset,address indexed recipient,uint256 amount,bytes32 workReference,bytes32 repositoryIdHash,bytes32 contributorIdHash,string metadataUri,bytes32 metadataHash)',
]);
const escrowInterface = new Interface(LIVE_ESCROW_ABI);
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const lower = value => String(value || '').toLowerCase();
const clone = value => JSON.parse(JSON.stringify(value));
const required = (value, label, max = 500) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} is required (max ${max})`);
  return value.trim();
};
function uri(value, label) {
  const text = required(value, label);
  if (!/^ipfs:\/\/[a-zA-Z0-9]+(?:\/[^\s]*)?$/.test(text)) throw new Error(`${label} must be pinned ipfs:// content`);
  return text;
}
function integer(value, min, max, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${label}`);
  return n;
}

export function createLiveBookings({ provider, ownerWallet, escrowAddress = '', escrowStartBlock = 0, ensResolver,
  restore = async () => null, save, getSchedule, saveSchedule, confirmations = 2, now = Date.now }) {
  if (escrowAddress && (!addressPattern.test(escrowAddress) || /^0x0{40}$/i.test(escrowAddress))) throw new Error('Invalid live escrow address');
  const escrow = escrowAddress ? new Contract(escrowAddress, [
    'function bookings(bytes32) view returns ((address performer,address funder,uint256 amount,uint256 payoutAmount,uint64 showStart,uint64 showEnd,uint64 claimDeadline,uint32 reviewWindow,uint32 cancellationWindow,uint16 killFeeBps,bytes32 termsHash,uint8 status))',
  ], provider) : null;
  let state = { schemaVersion: 1, revision: 0, bookings: [], escrowScannedThrough: null };
  let initialized;
  let queue = Promise.resolve();
  const run = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  const initialize = () => initialized ||= restore().then(value => { if (value) state = value; });
  async function commit(next) {
    if (!save) throw new Error('Durable booking storage unavailable; no changes saved');
    next.revision = state.revision + 1;
    const checkpoint = await save(next);
    if (!/^ipfs:\/\//.test(checkpoint || '')) throw new Error('Booking checkpoint did not confirm');
    state = next;
  }
  function eventFor(b) {
    return { id: b.eventId, title: `${b.title} — ${b.displayName}`.slice(0, 100), type: 'live_performance', startUtc: b.startUtc, endUtc: b.endUtc, priority: 200 };
  }
  async function syncSchedule(next, b) {
    b.scheduleStatus = 'pending';
    await commit(next);
    try {
      const schedule = await getSchedule();
      if (schedule.ready === false) throw new Error('Schedule is restoring');
      const event = eventFor(b);
      const events = b.cancelled ? cancelLivePerformanceEvent(schedule.events || [], event, b.cancellationReason)
        : upsertLivePerformanceEvent(schedule.events || [], event, { now: now() });
      await saveSchedule({ events, weeklySchedule: schedule.weeklySchedule || {} });
      const synced = clone(state);
      Object.assign(synced.bookings.find(item => item.id === b.id), { scheduleStatus: 'synced', error: '' });
      await commit(synced);
    } catch (error) {
      const failed = clone(state);
      Object.assign(failed.bookings.find(item => item.id === b.id), { scheduleStatus: 'failed', error: error.message });
      await commit(failed);
    }
  }
  async function applyEscrowLog(next, log) {
    const event = escrowInterface.parseLog(log);
    if (!event) return;
    const b = next.bookings.find(item => id(item.id) === event.args.bookingId && item.mode === 'phase1');
    if (!b || lower(event.args.termsHash) !== lower(b.termsHash)) return;
    const a = event.args;
    if (event.name === 'BookingFunded') {
      if (lower(a.performer) !== b.wallet || a.amount.toString() !== b.amountUnits || lower(a.funder) !== lower(ownerWallet)) throw new Error('Escrow booking evidence mismatch');
      const onchain = await escrow.bookings(a.bookingId);
      if (onchain.showStart !== BigInt(Date.parse(b.startUtc) / 1000) || onchain.showEnd !== BigInt(Date.parse(b.endUtc) / 1000) ||
          onchain.claimDeadline !== BigInt(Date.parse(b.claimDeadline) / 1000) || onchain.reviewWindow !== BigInt(b.reviewWindow) ||
          onchain.cancellationWindow !== BigInt(b.cancellationWindow) || onchain.killFeeBps !== BigInt(b.killFeeBps) || a.termsUri !== b.termsUri) throw new Error('Escrow booking terms/parameters mismatch');
      b.status = 'funded';
      b.financialStatus = 'Escrow funding confirmed';
    } else if (event.name === 'PerformanceApproved') {
      Object.assign(b, { financialStatus: 'Escrow decision confirmed; approved amount awaits performer claim', status: a.payoutAmount > 0n ? 'approved' : 'refunded', approvedUnits: a.payoutAmount.toString(), expectedRefundUnits: a.refundAmount.toString(), reportUri: a.reportUri, remainderDisposition: 'Returned to original funder on-chain' });
    } else if (event.name === 'PerformancePaid') {
      if (lower(a.performer) !== b.wallet) throw new Error('Escrow performer mismatch');
      Object.assign(b, { status: 'paid', paidUnits: a.amount.toString(), financialStatus: 'Performer claim confirmed' });
    } else if (event.name === 'BookingRefunded') {
      b.refundUnits = (BigInt(b.refundUnits || '0') + a.amount).toString();
      b.reportUri = a.reasonUri;
      if (a.reasonUri === 'expired-claim-deadline' || b.status !== 'approved' && b.status !== 'paid') { b.status = 'refunded'; b.financialStatus = 'Escrow refund confirmed'; }
    } else if (event.name === 'BookingCancelled') {
      b.financialStatus = 'confirmed cancellation';
      b.cancelled = true;
      b.cancellationReason ||= `On-chain cancellation: ${a.reasonUri}`;
      b.scheduleStatus = 'pending';
      b.approvedUnits = a.killFee.toString();
    }
    b.transactions[event.name] = { action: event.name, hash: log.transactionHash, status: 'confirmed', blockNumber: log.blockNumber };
  }
  async function indexEscrow() {
    if (!escrowAddress) return;
    if (!escrowStartBlock) throw new Error('Configure LIVE_PERFORMANCE_ESCROW_START_BLOCK before enabling escrow');
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== 8453) throw new Error('Escrow indexing requires Base');
    const head = await provider.getBlockNumber() - confirmations + 1;
    const next = clone(state);
    const from = next.escrowScannedThrough == null ? escrowStartBlock : next.escrowScannedThrough + 1;
    if (from > head) return;
    const through = Math.min(head, from + 1999);
    for (const log of (await provider.getLogs({ address: escrowAddress, fromBlock: from, toBlock: through }))
      .sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)) {
      try { await applyEscrowLog(next, log); } catch (error) { if (!/no matching event/.test(error.message)) throw error; }
    }
    next.escrowScannedThrough = through;
    await commit(next);
    for (const b of state.bookings.filter(b => b.cancelled && b.scheduleStatus === 'pending')) {
      const pending = clone(state);
      await syncSchedule(pending, pending.bookings.find(item => item.id === b.id));
    }
  }
  async function reconcile(next, b, action, hash) {
    if (!hashPattern.test(hash || '')) throw new Error('Valid transaction hash required');
    if ((await provider.getNetwork()).chainId != 8453n) throw new Error('Transaction evidence must be on Base 8453');
    const previous = b.transactions[action];
    if (previous?.status === 'confirmed') {
      if (lower(previous.hash) !== lower(hash)) throw new Error('Action already confirmed');
      return;
    }
    for (const other of next.bookings) {
      if (other.id !== b.id && Object.values(other.transactions || {}).some(tx => lower(tx.hash) === lower(hash))) throw new Error('Transaction already linked to another booking');
    }
    b.transactions[action] = { hash, action, status: 'pending' };
    const receipt = await provider.getTransactionReceipt(hash);
    if (!receipt) { if (action === 'funding') b.status = 'funding pending'; return; }
    if (Number(receipt.status) !== 1) { b.transactions[action].status = 'reverted'; if (action === 'funding') b.status = 'failed'; return; }
    if (await provider.getBlockNumber() - receipt.blockNumber + 1 < confirmations) { if (action === 'funding') b.status = 'funding pending'; return; }
    const contract = b.mode === 'phase1' ? escrowAddress : LIVE_ROUTER;
    if (lower(receipt.to) !== lower(contract)) throw new Error('Wrong transaction target');
    const logs = receipt.logs.filter(log => lower(log.address) === lower(contract));
    if (b.mode === 'phase1') {
      const names = { funding: 'BookingFunded', approve: 'PerformanceApproved', claim: 'PerformancePaid', reject: 'BookingRefunded', cancel: 'BookingCancelled' };
      if (!logs.some(log => { try { const e = escrowInterface.parseLog(log); return e.name === names[action] && e.args.bookingId === id(b.id) && lower(e.args.termsHash) === lower(b.termsHash); } catch { return false; } })) throw new Error('Missing matching escrow event');
      // The ordered scanner is the sole escrow accounting writer; receipt reconciliation only tracks tx status.
      b.transactions[action].status = 'confirmed';
      return;
    }
    let matched = false;
    for (const log of logs) {
      let e; try { e = routerInterface.parseLog(log); } catch { continue; }
      if (!e || e.args.fundId !== id(LIVE_FUND) || lower(e.args.asset) !== lower(LIVE_USDC)) continue;
      if (action === 'funding' && e.name === 'FundFunded' && e.args.amount.toString() === b.amountUnits && lower(e.args.funder) === lower(ownerWallet)) {
        b.status = 'funded'; b.financialStatus = 'Phase 0 earmarked funding confirmed, NOT escrowed'; matched = true;
      }
      if (action === 'recovery' && e.name === 'FundRecovered' && lower(e.args.recipient) === lower(ownerWallet) && e.args.amount.toString() === b.remainderUnits && BigInt(b.remainderUnits || 0) > 0n) {
        b.refundUnits = e.args.amount.toString(); b.financialStatus = 'Remainder recovered to original owner/funder (confirmed)';
        if (!BigInt(b.approvedUnits || 0)) b.status = 'refunded';
        matched = true;
      }
      if (action === 'payout' && e.name === 'PayrollPaid' && lower(e.args.recipient) === b.wallet && e.args.workReference === id(workReference(b)) && e.args.amount.toString() === b.approvedUnits && BigInt(b.approvedUnits) > 0n) {
        b.status = 'paid'; b.paidUnits = e.args.amount.toString(); b.financialStatus = 'Performer payout confirmed; remainder follows recorded disposition'; matched = true;
      }
    }
    if (!matched) throw new Error('Missing matching confirmed funding/payout evidence');
    b.transactions[action] = { hash, action, status: 'confirmed', blockNumber: receipt.blockNumber };
  }
  async function execute(command) {
    return run(async () => {
      await initialize();
      if (command.revision !== state.revision) throw new Error('Stale booking revision; refresh before retrying');
      const next = clone(state);
      const action = command.action;
      let b = next.bookings.find(item => item.id === command.id);
      if (action === 'create') {
        if (b) throw new Error('Duplicate booking ID');
        const input = command.booking || {};
        const bookingId = required(command.id, 'Booking ID', 100);
        if (!/^[a-z0-9:_-]+$/.test(bookingId)) throw new Error('Invalid booking ID');
        const performer = required(input.performer, 'Performer');
        const resolved = addressPattern.test(performer) ? performer : await ensResolver.resolveName(performer);
        const wallet = lower(typeof resolved === 'string' ? resolved : resolved?.address);
        if (!addressPattern.test(wallet) || /^0x0{40}$/i.test(wallet)) throw new Error('Performer wallet/ENS could not be resolved');
        const start = Date.parse(input.startUtc), end = Date.parse(input.endUtc);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start <= now() || end <= start || end - start > 4 * 3600_000) throw new Error('Invalid future show slot');
        const eventId = required(input.eventId, 'Dated occurrence ID', 100);
        if (!/:\d{4}-\d{2}-\d{2}$/.test(eventId)) throw new Error('Link a dated occurrence, not a recurring series');
        const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(start);
        if (!eventId.endsWith(`:${localDate}`)) throw new Error('Occurrence date must match the New York show date');
        if (next.bookings.some(item => item.eventId === eventId && !item.cancelled)) throw new Error('Occurrence already has a booking');
        const amount = required(input.amountUnits, 'USDC amount', 24);
        if (!/^[1-9][0-9]*$/.test(amount)) throw new Error('Amount must be positive USDC base units');
        let airtimeMinutes;
        let fullPayoutLiveMinutes;
        if (input.airtimeMinutes !== undefined || input.fullPayoutLiveMinutes !== undefined) {
          airtimeMinutes = integer(input.airtimeMinutes, 1, 240, 'airtime minutes');
          fullPayoutLiveMinutes = integer(input.fullPayoutLiveMinutes, 1, airtimeMinutes, 'full-payout live minutes');
          if (airtimeMinutes !== LIVE_PERFORMANCE_AIRTIME_MINUTES ||
              fullPayoutLiveMinutes !== LIVE_PERFORMANCE_FULL_PAYOUT_MINUTES ||
              amount !== LIVE_PERFORMANCE_FEE_UNITS || end - start !== airtimeMinutes * 60_000) {
            throw new Error('The current live-performance offer is $20 for a 20-minute slot with full payout at 15 live minutes');
          }
        }
        if (!hashPattern.test(input.termsHash || '') || /^0x0{64}$/.test(input.termsHash)) throw new Error('Immutable terms hash required');
        const mode = input.mode === 'phase1' ? 'phase1' : 'phase0';
        if (mode === 'phase1' && !escrowAddress) throw new Error('Escrow not deployed');
        const reviewWindow = integer(input.reviewWindow, 1, 365 * 86400, 'review window');
        const cancellationWindow = integer(input.cancellationWindow, 0, 365 * 86400, 'cancellation window');
        const killFeeBps = integer(input.killFeeBps, 0, 10000, 'kill fee');
        const claimDeadline = Date.parse(input.claimDeadline);
        if (!Number.isFinite(claimDeadline) || claimDeadline <= end + reviewWindow * 1000) throw new Error('Claim deadline must follow automatic review window');
        b = { id: bookingId, wallet, ens: addressPattern.test(performer) ? '' : performer,
          displayName: required(input.displayName, 'Display name', 80), discordHandle: required(input.discordHandle, 'Discord handle', 80),
          eventId, title: required(input.title, 'Show title', 80), startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString(),
          amountUnits: amount, asset: 'USDC', chainId: 8453, mode, termsVersion: required(input.termsVersion, 'Terms version', 80),
          termsHash: input.termsHash, termsUri: uri(input.termsUri, 'Terms URI'), termsStatus: 'DRAFT pending steward approval',
          stewardApproved: input.stewardApproved === true,
          ...(airtimeMinutes ? { airtimeMinutes, fullPayoutLiveMinutes } : {}),
          reviewWindow, cancellationWindow, killFeeBps, claimDeadline: new Date(claimDeadline).toISOString(),
          status: 'draft', transactions: {}, createdAt: new Date(now()).toISOString() };
        if (b.stewardApproved) b.termsStatus = 'Steward-approved; awaiting performer acknowledgement';
        next.bookings.push(b);
      } else {
        if (!b) throw new Error('Unknown booking');
        if (action === 'acknowledge') {
          if (b.status !== 'draft') throw new Error('Agreement is immutable after funding starts');
          const signature = required(command.performerSignature, 'Performer acknowledgement signature', 1000);
          if (lower(verifyMessage(liveAcknowledgement(b), signature)) !== b.wallet) throw new Error('Performer acknowledgement mismatch');
          if (command.stewardApproved !== true) throw new Error('Steward approval of precise terms required');
          b.stewardApproved = true;
          b.acknowledgements = { performerSignature: signature, performer: b.wallet, owner: lower(ownerWallet), at: new Date(now()).toISOString() };
          b.termsStatus = 'Acknowledged per-booking terms';
        } else if (action === 'transaction') {
          if (!['funding','payout','approve','claim','reject','cancel','recovery'].includes(command.txAction)) throw new Error('Invalid transaction action');
          if (command.txAction === 'funding' && (!b.acknowledgements || b.cancelled)) throw new Error('Both parties must acknowledge approved terms before funding');
          if (command.txAction === 'payout' && (!b.decision || b.mode !== 'phase0')) throw new Error('Phase 0 payment requires a recorded completion decision');
          await reconcile(next, b, command.txAction, command.txHash);
        } else if (action === 'decision') {
          const cancellation = command.cancellation === true && b.cancelled;
          if (b.status !== 'funded' || !cancellation && (b.cancelled || now() < Date.parse(b.endUtc))) throw new Error('Review requires a funded completed show or cancelled booking');
          const liveMusicMinutes = b.airtimeMinutes && !cancellation
            ? integer(command.liveMusicMinutes, 0, b.airtimeMinutes, 'verified live-music minutes') : null;
          const bps = liveMusicMinutes === null
            ? integer(command.payoutBps, 0, 10000, 'payout basis points')
            : livePerformancePayoutBps(liveMusicMinutes, b.fullPayoutLiveMinutes);
          if (cancellation && (BigInt(b.amountUnits) * BigInt(bps) / 10000n).toString() !== b.cancellationFeeUnits) throw new Error('Cancellation decision must match agreed kill-fee consequence');
          b.reason = required(command.reason, 'Public decision reason');
          b.reportUri = uri(command.reportUri, 'Decision report');
          if (b.mode === 'phase0' && !hashPattern.test(command.reportHash || '')) throw new Error('Pinned report content hash required for Phase 0 payout metadata');
          b.reportHash = command.reportHash || '';
          b.remainderDisposition = required(command.remainderDisposition, 'Remainder disposition');
          b.decision = { payoutBps: bps, ...(liveMusicMinutes === null ? {} : { liveMusicMinutes }), at: new Date(now()).toISOString() };
          b.approvedUnits = (BigInt(b.amountUnits) * BigInt(bps) / 10000n).toString();
          b.remainderUnits = (BigInt(b.amountUnits) - BigInt(b.approvedUnits)).toString();
          b.financialStatus = b.mode === 'phase0' ? 'Decision recorded; router payment/recovery requires separate confirmed transaction' : 'Decision proposal; escrow approval/refund not yet confirmed';
        } else if (action === 'cancel') {
          if (command.confirm !== true) throw new Error('Explicit cancellation confirmation required');
          if (b.status === 'paid' || b.status === 'refunded') throw new Error('Cannot cancel a settled booking');
          b.cancelled = true;
          b.cancellationReason = required(command.reason, 'Public cancellation reason');
          const late = now() >= Date.parse(b.startUtc) - b.cancellationWindow * 1000;
          b.cancellationFeeUnits = late ? (BigInt(b.amountUnits) * BigInt(b.killFeeBps) / 10000n).toString() : '0';
          b.financialStatus = b.status === 'draft' ? 'No confirmed deposit; verify any pending wallet transaction' : 'Pending separate financial reconciliation; schedule cancellation does not move funds';
          if (now() >= Date.parse(b.startUtc)) b.financialStatus += '; show started: escrow pre-show cancel unavailable, review/reject after end';
        } else if (action !== 'schedule') throw new Error('Unknown booking action');
      }
      if (action === 'schedule' || action === 'cancel') await syncSchedule(next, b);
      else await commit(next);
      return publicState();
    });
  }
  async function acknowledgePerformer({ id: bookingId, address, signature }) {
    return run(async () => {
      await initialize();
      const next = clone(state);
      const b = next.bookings.find(item => item.id === bookingId);
      if (!b) throw new Error('Unknown booking');
      if (b.status !== 'draft' || b.cancelled) throw new Error('This booking invitation is no longer open');
      if (lower(address) !== b.wallet) throw new Error('Connect the invited performer wallet');
      if (b.acknowledgements) {
        if (lower(verifyMessage(liveAcknowledgement(b), signature)) === b.wallet) return publicState();
        throw new Error('This booking has already been acknowledged');
      }
      if (!b.stewardApproved) throw new Error('The steward has not approved these exact terms yet');
      const performerSignature = required(signature, 'Performer acknowledgement signature', 1000);
      if (lower(verifyMessage(liveAcknowledgement(b), performerSignature)) !== b.wallet) {
        throw new Error('Performer acknowledgement mismatch');
      }
      b.acknowledgements = { performerSignature, performer: b.wallet, at: new Date(now()).toISOString() };
      b.termsStatus = 'Performer accepted steward-approved terms; awaiting escrow funding';
      await commit(next);
      return publicState();
    });
  }
  function publicState() {
    return { ...clone(state), ready: true, escrowAddress, escrowConfigured: !!escrowAddress, notice: 'Earmarked, NOT escrowed. Phase 0 admin can recoverFund.',
      bookings: state.bookings.map(({ acknowledgements, discordHandle, ...b }) => ({ ...clone(b),
        acknowledged: !!acknowledgements, acknowledgedAt: acknowledgements?.at || null })) };
  }
  async function getState() { return run(async () => { await initialize(); await indexEscrow(); return publicState(); }); }
  return { execute, getState, acknowledgePerformer };
}
