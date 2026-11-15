import { LIVE_PILOT_POLICY } from './live-bookings.mjs?v=20261114-tip-provenance';

// Pure afterparty model: exact-integer USDC preview, release preflight, release/claim state machine and the
// verified-fact checklist. Every success state here requires a verified fact; anything else stays pending/unknown.
export const BASE_CHAIN_ID = 8453;
export const FULL_PAYOUT_BPS = 10000;
export const AFTERPARTY_SEEN_KEY = 'decentbusking:afterparty-milestones:v1';
const MICRO = 1000000n;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const STATUS_WORDS = ['not created', 'funded', 'approved', 'paid', 'refunded'];
const FIELD_WORDS = { performer: 'performer wallet', funder: 'funding wallet', termsHash: 'agreement fingerprint',
  amount: 'fee amount', showStart: 'show start', showEnd: 'show end', claimDeadline: 'claim deadline',
  reviewWindow: 'review window', cancellationWindow: 'cancellation window', killFeeBps: 'late-cancel fee' };
const END_REASONS = {
  'producer-finished': 'Performer finished; producer confirmed the song-boundary ending.',
  'operator-cut': 'Interrupted by an owner cut.', 'authorization-expired': 'Authorized airtime expired.',
  'audio-loss': 'Interrupted after audio loss.', declined: 'Performer declined this slot.',
  'not-ready': 'Performer was not ready for this slot.',
};
const END_HEADLINES = {
  'producer-finished': 'Set finished ✓', 'operator-cut': 'Set ended early', 'authorization-expired': 'Set ended when airtime expired',
  'audio-loss': 'Set ended after audio loss', declined: 'No set aired · slot declined', 'not-ready': 'No set aired · not ready',
};

// ── Exact integer USDC (6 decimals) ─────────────────────────────────────────
export function parseUnits(value) {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  return typeof value === 'string' && /^(0|[1-9]\d{0,29})$/.test(value) ? BigInt(value) : null;
}
export function formatUsdc(units) {
  const value = parseUnits(units);
  if (value === null) return null;
  const whole = (value / MICRO).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (value % MICRO).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${whole}.${fraction}`;
}
export function usdcText(units) {
  const text = formatUsdc(units);
  return text === null ? 'an unknown amount' : `$${text} USDC`;
}
export function payoutUnits(amountUnits, payoutBps) {
  const amount = parseUnits(amountUnits);
  return amount === null ? null : amount * BigInt(payoutBps) / 10000n;
}

const etFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });
export const formatEt = ms => Number.isFinite(ms) ? `${etFormat.format(new Date(ms))} ET` : 'an unknown time';
export const shortHex = value => /^0x[0-9a-fA-F]{40,64}$/.test(value || '') ? `${value.slice(0, 6)}…${value.slice(-4)}` : String(value || '');
const shortError = error => String(error?.shortMessage || error?.message || error || 'Unknown error').slice(0, 240);
const txLink = hash => HASH.test(hash || '') ? { label: 'View transaction on BaseScan', href: `https://basescan.org/tx/${hash}` } : null;
const ipfsLink = uri => /^ipfs:\/\/[a-zA-Z0-9]+$/.test(uri || '')
  ? { label: 'Read public fee report', href: `https://gateway.pinata.cloud/ipfs/${uri.slice(7)}` } : null;

export function releaseTiming(booking, now = Date.now()) {
  const end = Date.parse(booking?.endUtc), deadline = Date.parse(booking?.claimDeadline), review = Number(booking?.reviewWindow);
  if (!Number.isFinite(end) || !Number.isFinite(deadline) || !Number.isFinite(review) || review < 0) return { phase: 'invalid' };
  const reviewEnds = end + review * 1000;
  const phase = now < end ? 'before-end' : now >= deadline ? 'after-deadline' : now >= reviewEnds ? 'auto-claim' : 'review-window';
  return { phase, end, reviewEnds, deadline };
}

// ── Plain-language preview: original contract terms only ───────────────────
export function releasePreview(booking) {
  const amount = parseUnits(booking?.amountUnits), timing = releaseTiming(booking, 0);
  if (amount === null || amount === 0n || timing.phase === 'invalid' || !(timing.deadline > timing.reviewEnds)) {
    return { ok: false, reason: 'The booking is missing its original fee or contract times, so the exact release cannot be previewed and nothing can be signed from here.' };
  }
  const payout = amount * BigInt(FULL_PAYOUT_BPS) / 10000n, refund = amount - payout;
  const who = booking.displayName || shortHex(booking.wallet) || 'The performer';
  const percent = FULL_PAYOUT_BPS / 100;
  const lines = [
    { id: 'approval', label: 'You approve', text: `${percent}% of the original guaranteed fee: ${usdcText(payout)} of ${usdcText(amount)} (${FULL_PAYOUT_BPS.toLocaleString('en-US')} of 10,000 basis points).` },
    { id: 'claim', label: 'Performer claim', text: `Once the approval is confirmed on Base, ${who} can claim the ${usdcText(payout)} from their Profile with the booked wallet, until ${formatEt(timing.deadline)}. Without an approval the contract lets them claim the full fee on their own from ${formatEt(timing.reviewEnds)}.` },
    { id: 'refund', label: 'Refund', text: refund === 0n ? 'None. $0.00 goes back to the funder.' : `${usdcText(refund)} goes back to the funder.` },
    { id: 'fee', label: 'Fees', text: 'The escrow contract takes no fee from the performer’s payout. You pay Base gas for the approval; publishing the report is a free wallet signature. The performer pays gas for their own claim.' },
    { id: 'basis', label: 'Basis', text: 'The original accepted contract terms (fee, show times and windows). A producer delay, a shortened set or a declined slot does not change the amount or the claim window.' },
    { id: 'signing', label: 'Your wallet', text: 'Up to two confirmations: a free signature to publish the report, then the approval transaction. Nothing is sent automatically or without your confirmation.' },
  ];
  return { ok: true, basis: 'original-contract-terms', amountUnits: amount.toString(), payoutBps: FULL_PAYOUT_BPS,
    payoutUnits: payout.toString(), refundUnits: refund.toString(), claimDeadline: timing.deadline, autoClaimFrom: timing.reviewEnds,
    summary: `Approve ${percent}% · ${usdcText(payout)} · refund ${usdcText(refund)}`, lines };
}

// ── Stage completion: verified facts only ───────────────────────────────────
export function completionFacts(booking, reentry = null) {
  const record = booking?.broadcastCompletion;
  if (reentry?.status === 'ended') {
    return { state: 'verified', endReason: reentry.endReason ?? null, endedAt: Number.isFinite(record?.actualEndedAt) ? record.actualEndedAt : null };
  }
  if (record?.known === true && record.pending === false && Number.isFinite(record.actualEndedAt)) {
    return { state: 'verified', endReason: record.endReason ?? null, endedAt: record.actualEndedAt };
  }
  if (reentry?.status === 'active' || record?.known === true && record.pending === true) return { state: 'pending' };
  if (record?.known === true && record.pending === false) return { state: 'unknown', reason: 'no-stage-record' };
  return { state: 'unknown', reason: record ? 'unavailable' : 'not-reported' };
}
export const stageEndedSuccessfully = facts => facts?.state === 'verified' && facts.endReason === 'producer-finished';

function stageGate(booking) {
  if (!Object.hasOwn(booking || {}, 'broadcastCompletion')) {
    return { status: 'pass', detail: 'No allocated-stage record is attached to this booking; the original contract workflow applies.' };
  }
  const facts = completionFacts(booking);
  if (facts.state === 'verified') return { status: 'pass', detail: `Stage ended ${formatEt(facts.endedAt)}. ${END_REASONS[facts.endReason] || 'Ending reason not provided.'}` };
  if (facts.state === 'pending') return { status: 'pending', detail: 'The allocated stage has not finished. The original contract end is not proof of actual completion.',
    next: 'Wait until the stage closes, then press Re-check status.' };
  if (facts.reason === 'no-stage-record') return { status: 'pass', detail: 'No allocated-stage completion is reported; the original contract workflow remains in effect.' };
  return { status: 'unknown', detail: 'Stage completion could not be read, so a new release is paused. The guaranteed fee is unchanged.',
    next: 'Press Re-check status in a moment. Do not sign without it.' };
}

function recordingFacts(booking) {
  const record = booking?.recordingRelease;
  if (!record || record.known !== true) return { state: 'unknown' };
  return { ...record, state: ['none', 'processing', 'mint-requested', 'minted', 'airing', 'aired'].includes(record.state) ? record.state : 'unknown' };
}
const RECORDING_WORDS = { unknown: 'Recording state is unavailable; nothing is assumed.', none: 'No recording has been submitted for this show.',
  processing: 'The recording is being prepared.', 'mint-requested': 'The recording was submitted and is waiting for its mint.',
  minted: 'The recording is minted; radio replay is not confirmed yet.', airing: 'The recording is playing on the radio now.',
  aired: 'The recording has played on the radio.' };

// ── Preflight: every blocking row must pass before a signature is requested ─
export function releasePreflight({ booking, facts = {}, now = Date.now() }) {
  const preview = releasePreview(booking), chain = facts.chain, checked = facts.checked === true;
  const rows = [];
  const add = (id, label, status, detail, next = '', blocking = true) => rows.push({ id, label, status, detail, next, blocking });
  const unread = 'Read when you press the button.';

  if (!checked) add('wallet', 'Admin wallet', 'pending', unread, '');
  else if (facts.walletError) add('wallet', 'Admin wallet', 'fail', `Wallet unavailable: ${facts.walletError}`, 'Open your wallet, connect the admin wallet, then press the button again.');
  else if (!facts.wallet?.address) add('wallet', 'Admin wallet', 'fail', 'No wallet is connected.', 'Connect the admin wallet that funded this escrow, then press the button again.');
  else if (facts.wallet.admin === false) add('wallet', 'Admin wallet', 'fail', 'The connected wallet is not the admin wallet.', 'Switch to the admin wallet that funded this escrow.');
  else if (chain?.mismatches?.includes('funder')) add('wallet', 'Admin wallet', 'fail', 'The connected wallet did not fund this escrow.', 'Switch to the wallet that funded it.');
  else add('wallet', 'Admin wallet', 'pass', `Admin wallet ${shortHex(facts.wallet.address)} is connected.`);

  if (!checked || facts.chainId == null) {
    add('network', 'Network', facts.chainError ? 'unknown' : 'pending', facts.chainError ? `Could not read the wallet network: ${facts.chainError}` : unread,
      facts.chainError ? 'Check your wallet connection, then press Re-check status.' : '');
  } else if (facts.chainId === BASE_CHAIN_ID) add('network', 'Network', 'pass', 'Wallet is on Base (chain 8453).');
  else add('network', 'Network', 'fail', `The wallet is on chain ${facts.chainId}, not Base.`, 'Switch your wallet network to Base (8453), then press the button again.');

  const state = booking?.status;
  if (booking?.mode !== 'phase1' || booking.payoutPolicy !== LIVE_PILOT_POLICY) add('booking', 'Booking state', 'fail', 'This is not a guaranteed-pilot escrow booking.', 'Use Advanced › manual review for this booking.');
  else if (state === 'funded') add('booking', 'Booking state', 'pass', 'The booking service shows the escrow as funded and awaiting approval.');
  else if (['approved', 'paid', 'refunded'].includes(state)) {
    add('booking', 'Booking state', 'fail', `The booking is already ${state}; there is nothing left to release.`,
      state === 'refunded' ? 'No payout is possible from this escrow.' : 'Tell the performer to claim from Profile; nothing more to sign.');
  } else add('booking', 'Booking state', 'fail', 'The escrow is not funded yet.', 'Fund the booking before the show; release is not available until then.');

  if (!checked) add('escrow', 'Escrow on Base', 'pending', unread);
  else if (facts.chainId != null && facts.chainId !== BASE_CHAIN_ID) add('escrow', 'Escrow on Base', 'pending', 'Not read because the wallet is not on Base.', 'Switch to Base first.');
  else if (!chain) add('escrow', 'Escrow on Base', 'unknown', 'The escrow could not be read from Base.', 'Press Re-check status. Nothing was signed.');
  else if (chain.error) add('escrow', 'Escrow on Base', 'unknown', `Base did not answer: ${chain.error}`, 'Press Re-check status in a moment. Nothing was signed.');
  else if (chain.status !== 1) {
    const partial = chain.status === 2 && parseUnits(chain.payoutUnits) !== parseUnits(booking?.amountUnits);
    const next = { 2: partial ? 'Do not send anything. Ask the developer to review the approval transaction on BaseScan.' : 'Already approved: tell the performer to claim from Profile. Nothing more to sign.',
      3: 'Already paid. Nothing to release.', 4: 'The escrow was refunded. Nothing to release.' }[chain.status] || 'No funded escrow exists on Base for this booking. Do not send funds from here; check the booking.';
    add('escrow', 'Escrow on Base', 'fail', partial ? `The escrow is approved on Base for ${usdcText(chain.payoutUnits)}, not the full ${usdcText(booking?.amountUnits)} fee.`
      : `The escrow is ${STATUS_WORDS[chain.status] || 'in an unknown status'} on Base, not funded.`, next);
  } else {
    const differs = (chain.mismatches || []).filter(field => field !== 'funder').map(field => FIELD_WORDS[field] || field);
    if (differs.length) add('escrow', 'Escrow on Base', 'fail', `The on-chain booking differs from the accepted terms: ${differs.join(', ')}.`, 'Do not sign. Press Re-check status; if it persists, stop and ask the developer.');
    else add('escrow', 'Escrow on Base', 'pass', 'Funded on Base and matching the accepted terms.');
  }

  if (!preview.ok) add('amounts', 'Amounts', 'fail', preview.reason, 'Fix the booking record before releasing.');
  else if (!chain || chain.error || facts.chainId !== BASE_CHAIN_ID) add('amounts', 'Amounts', checked && chain?.error ? 'unknown' : 'pending', `Will approve ${usdcText(preview.payoutUnits)} with a ${usdcText(preview.refundUnits)} refund; compared with Base when checks run.`);
  else if (parseUnits(chain.amountUnits) !== BigInt(preview.amountUnits)) {
    add('amounts', 'Amounts', 'fail', `The amount funded on Base (${usdcText(chain.amountUnits)}) differs from the booking fee (${usdcText(preview.amountUnits)}).`, 'Do not sign. Ask the developer to reconcile the booking.');
  } else add('amounts', 'Amounts', 'pass', `Will approve ${usdcText(preview.payoutUnits)}, the full funded fee, with a ${usdcText(preview.refundUnits)} refund.`);

  const clock = Number.isFinite(chain?.blockTime) ? chain.blockTime * 1000 : now, source = Number.isFinite(chain?.blockTime) ? 'Base time' : 'your clock';
  const timing = releaseTiming(booking, clock);
  if (timing.phase === 'review-window') add('timing', 'Review window', 'pass', `Inside the review window by ${source}; it closes ${formatEt(timing.reviewEnds)}.`);
  else if (timing.phase === 'before-end') add('timing', 'Review window', 'fail', `The booked end has not passed by ${source}. Release opens ${formatEt(timing.end)}.`, `Come back after ${formatEt(timing.end)}.`);
  else if (timing.phase === 'auto-claim') add('timing', 'Review window', 'fail', 'The review window has ended; the performer can claim the full fee without your approval.', 'Ask the performer to claim from their Profile.');
  else if (timing.phase === 'after-deadline') add('timing', 'Review window', 'fail', 'The claim deadline has passed.', 'Review the contract state; do not send a duplicate payment.');
  else add('timing', 'Review window', 'fail', 'The booking has no usable contract times.', 'Fix the booking record before releasing.');

  if (!chain || chain.error || facts.chainId !== BASE_CHAIN_ID) add('role', 'Admin role', 'pending', 'Read from Base when checks run.', '', false);
  else if (chain.paused === true) add('role', 'Admin role', 'fail', 'The escrow contract is paused.', 'Wait until it is unpaused. Do not retry meanwhile.');
  else if (chain.hasRole === false) add('role', 'Admin role', 'fail', 'This wallet does not hold the escrow admin role.', 'Switch to the wallet that holds the admin role.');
  else if (chain.hasRole === true) add('role', 'Admin role', 'pass', `This wallet holds the escrow admin role; the contract ${chain.paused === false ? 'is not paused' : 'pause state was not readable'}.`, '', false);
  else add('role', 'Admin role', 'unknown', 'The role could not be read; the simulation just before signing is the final check.', '', false);

  const gate = stageGate(booking);
  add('stage', 'Stage completion', gate.status, gate.detail, gate.next || '');

  const recording = recordingFacts(booking);
  add('recording', 'Recording (separate)', 'info', `${RECORDING_WORDS[recording.state]} Cash release does not depend on the recording or on any supporter gift.`, '', false);

  const blocking = rows.filter(row => row.blocking);
  const blocked = blocking.some(row => row.status === 'fail');
  const ready = checked && !blocked && blocking.every(row => row.status === 'pass');
  const unverified = !ready && !blocked;
  const failing = blocking.filter(row => row.status !== 'pass');
  const summary = ready ? 'All checks passed. Nothing has been signed yet.'
    : blocked ? `Not ready: ${failing.filter(row => row.status === 'fail').map(row => row.label).join(', ')}. Nothing was signed.`
      : checked ? `Could not verify: ${failing.map(row => row.label).join(', ')}. Nothing was signed.` : 'Checks have not run yet. Nothing has been signed.';
  return { ready, blocked, unverified, rows, summary };
}

// ── Transaction flow state machine (release and claim share it) ─────────────
export const FLOW_PHASES = ['idle', 'checking', 'blocked', 'unavailable', 'ready', 'signing-report', 'report-pinned', 'signing',
  'pending', 'confirming', 'confirmed', 'failed', 'unknown'];
export const createFlow = () => ({ phase: 'idle', step: 'check', failedStep: null, rows: [], hash: null, reportUri: null, source: null, kind: null, message: '', confirmations: 0 });
export function reduceFlow(flow, event) {
  if (flow.phase === 'confirmed' && event?.type !== 'reset') return flow;
  const hash = HASH.test(event?.hash || '') ? event.hash : flow.hash;
  switch (event?.type) {
    case 'reset': return createFlow();
    case 'checking': return { ...flow, phase: 'checking', step: 'check', failedStep: null, kind: null, message: '' };
    case 'preflight': {
      const result = event.preflight;
      return { ...flow, phase: result.ready ? 'ready' : result.blocked ? 'blocked' : 'unavailable', step: 'check', failedStep: null,
        rows: result.rows, kind: null, message: result.summary };
    }
    case 'report-signing': return { ...flow, phase: 'signing-report', step: 'report', kind: null, message: '' };
    case 'report-pinned': return { ...flow, phase: 'report-pinned', step: 'report', reportUri: event.uri || flow.reportUri };
    case 'signing': return { ...flow, phase: 'signing', step: 'approve', kind: null, message: '' };
    case 'submitted':
      return HASH.test(event.hash || '') ? { ...flow, phase: 'pending', step: 'confirm', hash, kind: null, message: '' }
        : { ...flow, phase: 'unknown', kind: 'no-hash', message: 'A transaction was reported without a valid hash, so it cannot be tracked.' };
    case 'confirming': return { ...flow, phase: 'confirming', step: 'confirm', hash, confirmations: event.confirmations ?? flow.confirmations };
    case 'confirmed':
      return event.verified === true && (HASH.test(event.hash || '') || event.source === 'chain-state')
        ? { ...flow, phase: 'confirmed', step: 'verified', failedStep: null, hash, source: event.source || 'receipt', reportUri: event.reportUri || flow.reportUri, kind: null, message: '' }
        : { ...flow, phase: 'unknown', kind: 'unverified', hash, message: 'The transaction was not verified against the expected escrow event, so success is not claimed.' };
    case 'failed': return { ...flow, phase: 'failed', failedStep: flow.step, kind: event.kind || 'error', message: event.message || '', hash };
    case 'unknown': return { ...flow, phase: 'unknown', failedStep: flow.step, kind: event.kind || 'unknown', message: event.message || '', hash };
    default: return flow;
  }
}

const STEPS = [['check', 'Checks'], ['report', 'Public report'], ['approve', 'Approve in wallet'], ['confirm', 'Base confirms'], ['verified', 'Verified']];
function stepStates(flow) {
  const order = STEPS.map(([id]) => id), current = order.indexOf(flow.step);
  const active = !['idle', 'ready', 'blocked', 'unavailable', 'confirmed', 'failed', 'unknown', 'report-pinned'].includes(flow.phase);
  return STEPS.map(([id, label], index) => {
    let state = 'todo';
    if (flow.phase === 'confirmed') state = 'done';
    else if (flow.phase === 'idle') state = 'todo';
    else if (index < current) state = 'done';
    else if (index === current) state = flow.phase === 'blocked' || flow.phase === 'failed' ? 'failed'
      : flow.phase === 'unavailable' || flow.phase === 'unknown' ? 'unknown' : flow.phase === 'ready' || flow.phase === 'report-pinned' ? 'done' : active ? 'active' : 'todo';
    return { id, label, state };
  });
}

function releasePrimary(flow, { pendingHash, preview, release }) {
  const tracked = pendingHash || (['pending', 'confirming', 'unknown'].includes(flow.phase) ? flow.hash : null);
  const dollars = preview.ok ? `$${formatUsdc(preview.amountUnits)}` : 'the full fee';
  const checkPending = { label: 'Check pending escrow release', disabled: false };
  switch (flow.phase) {
    case 'checking': case 'ready': case 'signing-report': case 'report-pinned': case 'signing': return { label: 'Release in progress…', disabled: true };
    case 'confirmed': return { label: 'Approved · performer can claim', disabled: true };
    case 'pending': case 'confirming': return checkPending;
    case 'idle': return tracked ? checkPending : release?.disabled ? { label: release.label, disabled: true } : { label: `Check & release full ${dollars} from escrow`, disabled: false };
    default: return tracked ? checkPending : { label: 'Check again & release', disabled: false };
  }
}
const WORKING_PHASES = ['checking', 'ready', 'signing-report', 'report-pinned', 'signing'];

export function releaseFlowView(flow, { booking, preview = releasePreview(booking), pendingHash = null, release = null } = {}) {
  const hash = flow.hash || pendingHash, tx = hash ? shortHex(hash) : 'the transaction';
  const amount = preview.ok ? usdcText(preview.payoutUnits) : 'the full fee';
  const until = preview.ok ? formatEt(preview.claimDeadline) : 'the claim deadline';
  const base = { phase: flow.phase, steps: stepStates(flow), busy: false, retry: false, links: [txLink(hash), ipfsLink(flow.reportUri || booking?.reportUri)].filter(Boolean),
    primary: releasePrimary(flow, { pendingHash, preview, release }), recheck: !WORKING_PHASES.includes(flow.phase) && flow.phase !== 'confirmed' };
  const failures = flow.rows.filter(row => row.blocking && row.status === 'fail');
  switch (flow.phase) {
    case 'checking': return { ...base, tone: 'busy', busy: true, title: 'Checking…', text: 'Reading your wallet and Base. Nothing is signed during checks.', next: 'Please wait.' };
    case 'blocked': return { ...base, tone: 'warn', retry: true, title: 'Not ready · nothing was signed',
      text: failures.map(row => `${row.label}: ${row.detail}`).join(' '), next: failures[0]?.next || 'Fix the item above, then press Check again.' };
    case 'unavailable': {
      const open = flow.rows.filter(row => row.blocking && row.status !== 'pass');
      return { ...base, tone: 'warn', retry: true, title: 'Could not verify · nothing was signed',
        text: `${open.length ? open.map(row => `${row.label}: ${row.detail}`).join(' ') : flow.message} Unverified checks are never assumed to pass.`,
        next: open.find(row => row.next)?.next || 'Press Re-check status in a moment. The performer’s guaranteed fee is unaffected.' };
    }
    case 'ready': return { ...base, tone: 'ok', busy: true, title: 'All checks passed', text: 'Nothing has been signed yet. Your wallet asks for each confirmation.', next: 'Continue in your wallet.' };
    case 'signing-report': return { ...base, tone: 'busy', busy: true, title: 'Sign the report upload in your wallet',
      text: 'This free signature publishes the public full-fee report. No gas and no funds move.', next: 'Approve the signature in your wallet, or reject it to stop here.' };
    case 'report-pinned': return { ...base, tone: 'busy', busy: true, title: 'Public report pinned', text: 'The report is saved. The approval transaction comes next.', next: 'Get ready to confirm in your wallet.' };
    case 'signing': return { ...base, tone: 'busy', busy: true, title: 'Confirm the approval in your wallet',
      text: `Approve 100% · ${amount}. This is an escrow approval, not a payment to the performer; they still claim it. Gas is paid from your wallet.`,
      next: 'Confirm in your wallet, or reject to stop. Nothing is sent until you confirm.' };
    case 'pending': return { ...base, tone: 'warn', title: 'Submitted · waiting for Base',
      text: `${tx} was sent but is not confirmed yet. It may still confirm, or the wallet may have dropped it. Do not send another.`,
      next: 'Press Check pending escrow release in a minute, or look the transaction up on BaseScan.' };
    case 'confirming': return { ...base, tone: 'warn', title: 'Seen on Base · waiting for the second confirmation',
      text: `${tx} is in a block but needs one more confirmation before it counts here.`, next: 'Press Check pending escrow release shortly.' };
    case 'confirmed': return { ...base, tone: 'ok', title: 'Approved on Base ✓',
      text: `The escrow approved ${amount} (100%)${flow.source === 'chain-state' ? ', read directly from the escrow contract' : ', verified from the transaction receipt'}. The performer can claim it from their Profile until ${until}. Approval is not payment received; that shows once they claim.`,
      next: 'Tell the performer to open Profile and claim. Nothing more for you to sign.' };
    case 'failed': return failedView(flow, base, tx);
    case 'unknown': return { ...base, tone: 'warn', title: 'Outcome unknown',
      text: `${flow.message || 'The result could not be verified.'} It may or may not have happened; neither is assumed.`,
      next: 'Press the button to re-check (read-only). If it stays unknown, look at the transaction on BaseScan or ask the developer.' };
    default: return { ...base, tone: 'idle', title: 'Ready when you are', text: 'Nothing has been signed or sent. Checks run first when you press the button.', next: 'Press the button to start.' };
  }
}
function failedView(flow, base, tx) {
  const kinds = {
    rejected: ['Cancelled in your wallet · nothing was sent', 'You rejected the request, so no approval was submitted and no funds moved. A pinned report, if any, is kept.', 'Press Check again when you are ready to retry.'],
    reverted: ['Approval reverted on Base · nothing was released', `${tx} failed on-chain. There is no approval and no payment.`, 'Press Re-check status, read the failure on BaseScan, and retry only if the escrow is still funded.'],
    replaced: ['Approval cancelled or replaced', 'The submitted transaction was replaced or cancelled, so no approval is certified from it.', 'Press Re-check status; retry only if the escrow is still funded.'],
    mismatch: ['Receipt does not match · not certified', `${tx} confirmed, but its receipt does not contain exactly the expected full-fee approval.`, 'Do not send again. Open the transaction on BaseScan, compare it with the booking, then Re-check status.'],
    unavailable: ['Could not reach Base · nothing was sent', 'The network or wallet did not answer, so nothing is assumed.', 'Check your connection, then press Check again.'],
    precheck: ['Final check failed · nothing was sent', 'The last read of Base, or the simulation, refused to continue, so nothing was signed or sent.', 'Press Re-check status to read the latest state before trying again.'],
    upload: ['Report upload failed · nothing was sent', 'The public report could not be published, so no approval was requested.', 'Press Check again. The report signature is free and no funds move.'],
  };
  const [title, text, next] = kinds[flow.kind] || ['Something went wrong · nothing confirmed', flow.message || 'The action did not complete.', 'Press Re-check status before retrying; a transaction may already be pending.'];
  return { ...base, tone: 'error', retry: true, recheck: true, title, text: flow.message && kinds[flow.kind] ? `${text} ${flow.message}` : text, next };
}

export function claimFlowView(flow, { booking } = {}) {
  const units = booking?.approvedUnits || booking?.amountUnits, amount = usdcText(units), tx = flow.hash ? shortHex(flow.hash) : 'the transaction';
  const base = { phase: flow.phase, steps: [], busy: false, recheck: false, retry: false, links: [txLink(flow.hash)].filter(Boolean) };
  switch (flow.phase) {
    case 'checking': return { ...base, tone: 'busy', busy: true, title: 'Checking your wallet…', text: 'Opening your wallet on Base. Nothing is signed yet.', next: 'Please wait.' };
    case 'blocked': return { ...base, tone: 'warn', retry: true, title: 'Not ready · nothing was sent', text: flow.message, next: 'Connect your booked performer wallet on Base, then try again.' };
    case 'unavailable': return { ...base, tone: 'warn', retry: true, title: 'Could not verify · nothing was sent', text: flow.message, next: 'Try again in a moment. Your claim rights are unchanged.' };
    case 'signing': return { ...base, tone: 'busy', busy: true, title: 'Confirm your claim in your wallet', text: `Claim ${amount} to your booked wallet. Your wallet pays a little Base gas.`, next: 'Confirm in your wallet, or reject to stop.' };
    case 'pending': return { ...base, tone: 'warn', busy: true, recheck: true, title: 'Claim submitted · waiting for Base',
      text: `${tx} is not confirmed yet. It may still confirm. Do not send a second claim.`, next: 'Press Check pending claim in a minute.' };
    case 'confirming': return { ...base, tone: 'warn', busy: true, recheck: true, title: 'Seen on Base · waiting for the second confirmation', text: `${tx} needs one more confirmation.`, next: 'Check again shortly.' };
    case 'confirmed': return { ...base, tone: 'ok', title: 'Payment confirmed ✓', text: `${amount} was paid to your booked wallet by the escrow contract, verified from the transaction receipt.`, next: 'Nothing more to do. Keep the receipt below.' };
    case 'failed': {
      const kinds = { rejected: ['Cancelled in your wallet · nothing was sent', 'No claim was submitted and no funds moved.', 'Press Claim again when you are ready.'],
        reverted: ['Claim reverted on Base · nothing was paid', `${tx} failed on-chain.`, 'Refresh payment status before trying again; the claim window may have changed.'],
        replaced: ['Claim cancelled or replaced', 'The submitted transaction was replaced, so no payment is certified from it.', 'Refresh payment status before trying again.'],
        mismatch: ['Payment not confirmed · receipt does not match', `${tx} confirmed, but its receipt does not show the expected payment to your booked wallet.`, 'Check the transaction on BaseScan and do not claim again until you have; then ask Jolly.'] };
      const [title, text, next] = kinds[flow.kind] || ['Claim needs attention', flow.message || 'The claim did not complete.', 'Refresh payment status to reconcile before retrying.'];
      return { ...base, tone: 'error', retry: true, recheck: true, title, text: flow.message && kinds[flow.kind] ? `${text} ${flow.message}` : text, next };
    }
    case 'unknown': return { ...base, tone: 'warn', recheck: true, title: 'Payment not verified yet',
      text: `${flow.message || 'The result could not be verified.'} The payment is neither confirmed nor ruled out.`,
      next: 'Check the transaction on BaseScan, then press Check pending claim. If it stays unknown, ask Jolly.' };
    default: return { ...base, tone: 'idle', title: 'Ready to claim', text: `Claim ${amount} to your booked wallet.`, next: 'Press Claim.' };
  }
}

export function classifyTxError(error) {
  const text = `${error?.shortMessage || ''} ${error?.message || ''}`;
  if (error?.code === 'ACTION_REJECTED' || error?.code === 4001 || /user (rejected|denied|cancel)|rejected the request|request rejected|denied (transaction|message) signature/i.test(text)) return 'rejected';
  if (error?.code === 'TRANSACTION_REPLACED') return 'replaced';
  if (error?.code === 'CALL_EXCEPTION' && error.receipt) return 'reverted';
  if (['NETWORK_ERROR', 'TIMEOUT', 'SERVER_ERROR'].includes(error?.code) || /failed to fetch|network request failed|timed? ?out|econn|enotfound|rpc endpoint|unreachable|\b(429|502|503|504)\b/i.test(text)) return 'unavailable';
  return 'error';
}

// Verifies the exact PerformancePaid event; `iface` is an ethers Interface for the live-escrow ABI.
export function verifyPaidReceipt({ receipt, escrowAddress, iface, bookingHash, performer, amountUnits, termsHash }) {
  if (!receipt || receipt.status !== 1) return { ok: false, reason: 'reverted' };
  if (typeof iface?.parseLog !== 'function' || !Array.isArray(receipt.logs)) return { ok: false, reason: 'unverifiable' };
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase(), expected = parseUnits(amountUnits);
  const matches = [];
  for (const log of receipt.logs) {
    if (!same(log.address, escrowAddress)) continue;
    let event;
    try { event = iface.parseLog(log); } catch { continue; }
    if (event?.name !== 'PerformancePaid' || !same(event.args.bookingId, bookingHash) || !same(event.args.performer, performer)) continue;
    if (termsHash && !same(event.args.termsHash, termsHash)) continue;
    if (expected !== null && BigInt(event.args.amount) !== expected) continue;
    matches.push(event);
  }
  return matches.length === 1 ? { ok: true, amountUnits: BigInt(matches[0].args.amount).toString() } : { ok: false, reason: matches.length ? 'duplicate' : 'no-event' };
}

// ── Afterparty checklist: one row per independent verified fact ────────────
const row = (id, label, state, text, detail = '', next = '', extra = {}) => ({ id, label, state, text, detail, next, links: [], celebrate: false, ...extra });

function completionRow(b, reentry, audience) {
  const facts = completionFacts(b, reentry);
  if (facts.state === 'verified') {
    const ok = stageEndedSuccessfully(facts), ended = Number.isFinite(facts.endedAt) ? ` ${formatEt(facts.endedAt)}.` : '';
    return row('completion', 'Show', 'verified', END_HEADLINES[facts.endReason] || 'Stage ended · reason not reported',
      `${END_REASONS[facts.endReason] || 'The stage record does not give a reason.'}${ended}${ok ? '' : ' The guaranteed fee is unchanged.'}`.trim(), '',
      { celebrate: ok, facts });
  }
  if (facts.state === 'pending') return row('completion', 'Show', 'pending', 'Set not finished yet', 'The scheduled end passing is not proof the set finished; this waits for the stage record.', 'Check again after the stage closes.', { facts });
  const detail = { 'no-stage-record': `No stage record exists for this booking, so the finish cannot be verified (scheduled end ${formatEt(Date.parse(b.endUtc))}).`,
    unavailable: 'The stage record could not be read right now.', 'not-reported': 'The server did not report stage completion.' }[facts.reason];
  return row('completion', 'Show', 'unknown', 'Finish not verified', `${detail} Payment is unaffected.`, 'Check again later; your payment status below is independent.', { facts });
}

function approvalRow(b, now, audience) {
  const timing = releaseTiming(b, now), report = ipfsLink(b.reportUri);
  const admin = audience === 'admin';
  if (b.status === 'approved' || b.status === 'paid') {
    const auto = b.reportUri === 'automatic-review-window';
    return row('approval', 'Escrow approval', 'verified', `Approved on Base · ${usdcText(b.approvedUnits || b.amountUnits)}`,
      auto ? 'Approved automatically when the review window passed.' : 'Confirmed from the escrow approval event.', '', { links: [report].filter(Boolean) });
  }
  if (b.status === 'refunded') return row('approval', 'Escrow approval', 'attention', 'Refunded · no payout approved', 'The escrow returned the funds to the funder.', 'Contact Jolly if you expected a payout.');
  if (b.status !== 'funded') return row('approval', 'Escrow approval', 'info', 'Not funded', 'No funded escrow exists for this booking, so there is nothing to approve.', admin ? 'Fund the booking before the show.' : 'Nothing to do yet.');
  if (timing.phase === 'before-end') return row('approval', 'Escrow approval', 'pending', 'Waiting for the show to end', `Approval opens after ${formatEt(timing.end)}.`, admin ? 'Come back after the set.' : 'Nothing for you to sign.');
  if (timing.phase === 'review-window') {
    return row('approval', 'Escrow approval', 'pending', 'Waiting for approval',
      admin ? 'The review window is open.' : 'Jolly approves your guaranteed fee after the set.',
      admin ? 'Use the guided release above.' : `Nothing for you to sign. You can also claim yourself from ${formatEt(timing.reviewEnds)}.`);
  }
  if (timing.phase === 'auto-claim') return row('approval', 'Escrow approval', 'attention', 'Review window ended', 'The contract lets the performer claim the full fee without an approval.', admin ? 'Ask the performer to claim from Profile.' : 'You can claim now.');
  if (timing.phase === 'after-deadline') return row('approval', 'Escrow approval', 'attention', 'Claim deadline passed', 'The claim window has closed.', admin ? 'Review the contract state; do not send a duplicate payment.' : 'Contact Jolly; do not wait for an approval.');
  return row('approval', 'Escrow approval', 'unknown', 'Approval status unclear', 'The booking has no usable contract times.', 'Refresh and check again.');
}

function paymentRow(b, now, audience) {
  const timing = releaseTiming(b, now), hash = b.transactions?.PerformancePaid?.hash, admin = audience === 'admin';
  if (b.status === 'paid') {
    return row('payment', 'Payment', 'verified', `Payment confirmed · ${usdcText(b.paidUnits || b.approvedUnits || b.amountUnits)}`,
      'Claimed by the booked performer wallet; confirmed from the escrow payment event.', '', { links: [txLink(hash)].filter(Boolean), celebrate: HASH.test(hash || ''), txHash: hash || null });
  }
  if (b.status === 'approved') {
    return row('payment', 'Payment', 'pending', 'Approved · not claimed yet', `Claimable until ${formatEt(timing.deadline)}.`,
      admin ? 'Nothing for you to sign. Remind the performer if the deadline is close.' : 'Claim below; your wallet pays a little Base gas.');
  }
  if (b.status === 'refunded') return row('payment', 'Payment', 'attention', 'Not paid · escrow refunded', 'The funds returned to the funder.', 'Contact Jolly if you expected a payout.');
  if (b.status === 'funded' && timing.phase === 'auto-claim') return row('payment', 'Payment', 'pending', 'Claimable now', 'The review window ended, so the full fee can be claimed without an approval.', admin ? 'Ask the performer to claim from Profile.' : 'Claim below.');
  if (b.status === 'funded' && timing.phase === 'after-deadline') return row('payment', 'Payment', 'attention', 'Claim deadline passed', 'No payment is recorded.', admin ? 'Review the contract state; do not send a duplicate payment.' : 'Contact Jolly.');
  if (b.status === 'funded') return row('payment', 'Payment', 'pending', 'Not paid yet', 'The funded escrow is waiting for approval and claim.', 'No action yet.');
  return row('payment', 'Payment', 'info', 'No payment yet', 'The escrow is not funded.', admin ? 'Fund the booking before the show.' : 'Nothing to do yet.');
}

function recordingRows(b, audience) {
  const r = recordingFacts(b), admin = audience === 'admin';
  const nft = r.contractAddress && r.tokenId != null ? { label: 'View the token on BaseScan', href: `https://basescan.org/nft/${r.contractAddress}/${r.tokenId}` } : null;
  const partial = r.partial ? ' This is a partial recording.' : '';
  let recording, radio;
  if (r.state === 'unknown') {
    recording = row('recording', 'Recording', 'unknown', 'Recording state unavailable', 'The recording pipeline did not report a state, so nothing is assumed. Payment is unaffected.', admin ? 'Check the production desk and the Admin mint queue.' : 'Check again later.');
    radio = row('radio', 'Radio release', 'unknown', 'Radio release unknown', 'It cannot be verified without a recording state.', 'Check again later.');
  } else if (r.state === 'none') {
    recording = row('recording', 'Recording', 'info', 'No recording submitted yet', 'Only opted-in sets are recorded, and the recording appears here once the pipeline submits it.', 'Nothing to do. Check again after processing.');
    radio = row('radio', 'Radio release', 'info', 'Nothing to air yet', 'A recording must be minted before it can be released on the radio.', '');
  } else if (r.state === 'processing') {
    recording = row('recording', 'Recording', 'pending', 'Recording is being prepared', 'The stage pipeline is processing the capture.', 'Check again shortly.');
    radio = row('radio', 'Radio release', 'pending', 'Waiting for the mint', 'Radio release comes after the recording is submitted and minted.', '');
  } else if (r.state === 'mint-requested') {
    recording = row('recording', 'Recording', 'pending', 'Submitted · waiting for the mint', `Nothing is automatic.${partial}`, admin ? 'Approve it in Admin › mint queue (owner-signed).' : 'Nothing for you to sign. This updates when the mint confirms.');
    radio = row('radio', 'Radio release', 'pending', 'Waiting for the mint', 'Radio release comes after the mint.', '');
  } else {
    recording = row('recording', 'Recording', 'verified', `Minted${r.tokenId != null ? ` as token #${r.tokenId}` : ''}`, `Confirmed minted.${partial}`, '', { links: [nft].filter(Boolean) });
    if (r.state === 'minted') {
      radio = row('radio', 'Radio release', 'pending', 'Not played on the radio yet',
        `Minting alone does not mean it aired. It plays in a normal rotation slot${Number.isFinite(r.replayAfter) ? ` after ${formatEt(r.replayAfter)}` : ''}.`, admin ? 'If it stays pending long after that, check the radio queue.' : 'Nothing to do. Tune in later.');
    } else {
      const live = r.state === 'airing';
      radio = row('radio', 'Radio release', 'verified', live ? 'On the radio now ✓' : 'Played on the radio ✓', live ? 'The radio is playing this exact recording right now.' : 'The radio played this exact recording to the end.', '',
        { celebrate: !!r.trackId, trackId: r.trackId || null, tokenId: r.tokenId ?? null, links: [nft].filter(Boolean) });
    }
  }
  return [recording, radio];
}

const giftRow = () => row('gift', 'Supporter gift', 'info', 'Separate from your fee', 'The thank-you collectible is tracked on its own. Its delivery never delays, reduces or blocks the cash payment.', '');

export function afterpartyRows(booking, { audience = 'performer', now = Date.now(), reentry = null } = {}) {
  if (!booking) return [];
  const completion = completionRow(booking, reentry, audience), [recording, radio] = recordingRows(booking, audience);
  if (audience === 'public') {
    return [completion.state === 'verified' && completion.celebrate ? completion : null, radio.state === 'verified' ? radio : null].filter(Boolean);
  }
  return [completion, approvalRow(booking, now, audience), paymentRow(booking, now, audience), recording, radio, giftRow()];
}

export function afterpartyMilestones(booking, rows) {
  const name = booking.displayName || 'The performer';
  return rows.filter(item => item.celebrate && item.state === 'verified').map(item => {
    if (item.id === 'completion') {
      return { id: `curtain:${booking.id}:${item.facts.endedAt ?? 'verified'}`, kind: 'completion', bookingId: booking.id, title: 'Curtain call', subtitle: `${name}’s set is finished.`, evidence: { endedAt: item.facts.endedAt } };
    }
    if (item.id === 'payment') return { id: `payment:${booking.id}:${item.txHash}`, kind: 'payment', bookingId: booking.id, title: 'Payment confirmed', subtitle: usdcText(booking.paidUnits || booking.approvedUnits || booking.amountUnits), evidence: { txHash: item.txHash, chainId: BASE_CHAIN_ID } };
    return { id: `release:${booking.id}:${item.trackId}`, kind: 'radio-release', bookingId: booking.id, title: 'On the radio', subtitle: `${booking.title || 'The live recording'} is out.`, evidence: { trackId: item.trackId, tokenId: item.tokenId } };
  });
}

// ── Celebration hook: idempotent, replayable, never blocks the UI ──────────
// Another lane may register its visual with setAfterpartyCelebrator(detail => …); the default only announces.
const memory = new Set();
let celebrator = detail => {
  if (typeof document !== 'undefined' && typeof CustomEvent === 'function') document.dispatchEvent(new CustomEvent('afterparty-celebration', { detail }));
};
const defaultCelebrator = celebrator;
export function setAfterpartyCelebrator(handler) {
  celebrator = typeof handler === 'function' ? handler : defaultCelebrator;
  return () => { celebrator = defaultCelebrator; };
}
function storedMilestones(storage) {
  try {
    const value = JSON.parse(storage?.getItem?.(AFTERPARTY_SEEN_KEY) || '[]');
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
  } catch { return []; }
}
export function milestoneSeen(id, storage = globalThis.localStorage) { return memory.has(id) || storedMilestones(storage).includes(id); }
export function resetAfterpartyMilestones() { memory.clear(); }
export function celebrateAfterparty(milestone, { storage = globalThis.localStorage, replay = false } = {}) {
  if (!milestone?.id || typeof milestone.id !== 'string') return { celebrated: false, reason: 'no-id' };
  const fresh = !milestoneSeen(milestone.id, storage);
  if (!fresh && !replay) return { celebrated: false, reason: 'already-seen' };
  if (fresh) {
    memory.add(milestone.id);
    try { storage?.setItem?.(AFTERPARTY_SEEN_KEY, JSON.stringify([...storedMilestones(storage), milestone.id].slice(-120))); } catch { /* memory set still prevents repeats this session */ }
  }
  const reducedMotion = typeof matchMedia === 'function' ? !!matchMedia('(prefers-reduced-motion: reduce)').matches : false;
  try { celebrator({ ...milestone, replay: !fresh, reducedMotion }); } catch (error) { console.warn('[afterparty] celebration unavailable:', error?.message); }
  return { celebrated: true, fresh };
}
export { shortError };
