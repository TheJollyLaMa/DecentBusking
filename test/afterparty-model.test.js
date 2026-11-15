const test = require('node:test');
const assert = require('node:assert/strict');
const { Interface, id } = require('../discord-bot/node_modules/ethers');

const owner = '0x' + '11'.repeat(20), artist = '0x' + '22'.repeat(20), escrow = '0x' + '33'.repeat(20), other = '0x' + '55'.repeat(20);
const txHash = '0x' + '44'.repeat(32);
const NOW = Date.parse('2026-11-14T03:00:00Z');
const model = () => import('../js/live-afterparty.mjs');

const booking = (over = {}) => ({
  id: 'friday-live-performance:2026-11-13:fixture', mode: 'phase1', payoutPolicy: 'pilot-guaranteed-v1', status: 'funded',
  wallet: artist, displayName: 'Fixture performer', title: 'Friday fixture', amountUnits: '20000000', termsHash: id('terms'),
  startUtc: '2026-11-14T02:00:00.000Z', endUtc: '2026-11-14T02:20:00.000Z', claimDeadline: '2026-11-18T02:20:00.000Z', reviewWindow: 86400,
  transactions: {}, ...over,
});
const facts = (over = {}) => ({
  checked: true, wallet: { address: owner, admin: true }, chainId: 8453,
  chain: { status: 1, amountUnits: '20000000', payoutUnits: '0', blockTime: Math.floor(NOW / 1000), mismatches: [], hasRole: true, paused: false },
  ...over,
});
const row = (preflight, rowId) => preflight.rows.find(item => item.id === rowId);

test('USDC math is exact integer arithmetic with six decimals', async () => {
  const { parseUnits, formatUsdc, usdcText, payoutUnits } = await model();
  assert.equal(formatUsdc('20000000'), '20.00');
  assert.equal(formatUsdc('20500000'), '20.50');
  assert.equal(formatUsdc(1), '0.000001');
  assert.equal(formatUsdc('999999'), '0.999999');
  assert.equal(formatUsdc('1000000'), '1.00');
  assert.equal(formatUsdc(0n), '0.00');
  assert.equal(formatUsdc('1234567890123'), '1,234,567.890123');
  assert.equal(formatUsdc('123456789012345678901234567890'), '123,456,789,012,345,678,901,234.56789', 'beyond Number precision, trailing zeros trimmed past two decimals');
  assert.equal(usdcText('20000000'), '$20.00 USDC');
  assert.equal(usdcText(null), 'an unknown amount');
  for (const bad of ['', '-1', '20.5', '1e6', '020', 'abc', null, undefined, -1, 1.5, {}, Number.MAX_SAFE_INTEGER + 2]) assert.equal(parseUnits(bad), null, String(bad));
  assert.equal(parseUnits(12n), 12n);
  assert.equal(parseUnits('0'), 0n);
  assert.equal(payoutUnits('20000000', 10000), 20000000n);
  assert.equal(payoutUnits('333', 3333), 110n, 'integer division never rounds up');
  assert.equal(payoutUnits('abc', 10000), null);
});

test('release preview shows approval, claim window, refund and fees from the original contract terms only', async () => {
  const { releasePreview } = await model();
  const preview = releasePreview(booking());
  assert.equal(preview.ok, true);
  assert.equal(preview.basis, 'original-contract-terms');
  assert.equal(preview.amountUnits, '20000000');
  assert.equal(preview.payoutBps, 10000);
  assert.equal(preview.payoutUnits, '20000000');
  assert.equal(preview.refundUnits, '0');
  assert.equal(preview.claimDeadline, Date.parse('2026-11-18T02:20:00Z'));
  assert.equal(preview.autoClaimFrom, Date.parse('2026-11-15T02:20:00Z'));
  assert.match(preview.summary, /Approve 100% · \$20\.00 USDC · refund \$0\.00 USDC/);
  const text = Object.fromEntries(preview.lines.map(line => [line.id, line.text]));
  assert.match(text.approval, /100% of the original guaranteed fee: \$20\.00 USDC of \$20\.00 USDC \(10,000 of 10,000 basis points\)/);
  assert.match(text.claim, /Fixture performer can claim the \$20\.00 USDC from their Profile with the booked wallet, until Nov 17, 2026, 9:20 PM ET/);
  assert.match(text.claim, /from Nov 14, 2026, 9:20 PM ET/, 'the auto-claim moment is the end plus the review window, shown in ET');
  assert.match(text.refund, /None\. \$0\.00 goes back to the funder/);
  assert.match(text.fee, /no fee from the performer’s payout/);
  assert.match(text.fee, /Base gas/);
  assert.match(text.basis, /does not change the amount or the claim window/);
  assert.match(text.signing, /Nothing is sent automatically/);
});

test('release preview ignores producer delay, shortened sets, declines and any live completion record', async () => {
  const { releasePreview } = await model();
  const original = releasePreview(booking());
  const variants = [
    { broadcastCompletion: { known: true, pending: true, actualEndedAt: null } },
    { broadcastCompletion: { known: true, pending: false, actualEndedAt: NOW - 600000, endReason: 'declined' } },
    { broadcastCompletion: { known: true, pending: false, actualEndedAt: NOW - 300000, endReason: 'operator-cut' } },
    { broadcastCompletion: { known: false, pending: true } },
    { broadcastCompletion: null }, { broadcast: { endReason: 'audio-loss', startedLateMs: 1500000 } },
    { actualStartUtc: '2026-11-14T02:30:00Z', actualEndUtc: '2026-11-14T02:34:00Z', airtimeMinutes: 4 },
    { approvedUnits: '1', paidUnits: '1', recordingRelease: { known: true, state: 'none' } },
  ];
  for (const change of variants) assert.deepEqual(releasePreview(booking(change)), original, JSON.stringify(change));
  const bigger = releasePreview(booking({ amountUnits: '20500000' }));
  assert.equal(bigger.payoutUnits, '20500000');
  assert.match(bigger.summary, /\$20\.50 USDC/);
});

test('release preview refuses to guess when the original terms are unusable', async () => {
  const { releasePreview } = await model();
  for (const change of [{ amountUnits: '0' }, { amountUnits: 'abc' }, { amountUnits: undefined }, { claimDeadline: undefined }, { endUtc: 'nope' },
    { reviewWindow: -1 }, { reviewWindow: 'x' }, { claimDeadline: '2026-11-15T02:20:00.000Z' }]) {
    const preview = releasePreview(booking(change));
    assert.equal(preview.ok, false, JSON.stringify(change));
    assert.match(preview.reason, /nothing can be signed from here/);
  }
  assert.equal(releasePreview(null).ok, false);
});

test('release timing mirrors the escrow review and claim windows', async () => {
  const { releaseTiming } = await model();
  const b = booking(), end = Date.parse(b.endUtc), reviewEnds = end + 86400000, deadline = Date.parse(b.claimDeadline);
  assert.equal(releaseTiming(b, end - 1).phase, 'before-end');
  assert.equal(releaseTiming(b, end).phase, 'review-window');
  assert.equal(releaseTiming(b, reviewEnds - 1).phase, 'review-window');
  assert.equal(releaseTiming(b, reviewEnds).phase, 'auto-claim');
  assert.equal(releaseTiming(b, deadline - 1).phase, 'auto-claim');
  assert.equal(releaseTiming(b, deadline).phase, 'after-deadline');
  assert.equal(releaseTiming(booking({ endUtc: 'x' }), NOW).phase, 'invalid');
});

test('preflight passes only when every blocking fact is verified, and never signs on unknowns', async () => {
  const { releasePreflight } = await model();
  const ready = releasePreflight({ booking: booking(), facts: facts(), now: NOW });
  assert.equal(ready.ready, true);
  assert.equal(ready.blocked, false);
  assert.deepEqual(ready.rows.map(item => item.id), ['wallet', 'network', 'booking', 'escrow', 'amounts', 'timing', 'role', 'stage', 'recording']);
  assert.ok(ready.rows.filter(item => item.blocking).every(item => item.status === 'pass'));
  assert.match(ready.summary, /All checks passed\. Nothing has been signed yet/);
  const unchecked = releasePreflight({ booking: booking(), facts: { checked: false }, now: NOW });
  assert.equal(unchecked.ready, false);
  assert.equal(unchecked.unverified, true);
  for (const needsWalletOrChain of ['wallet', 'network', 'escrow', 'amounts']) assert.equal(row(unchecked, needsWalletOrChain).status, 'pending', needsWalletOrChain);
  assert.match(unchecked.summary, /Checks have not run yet\. Nothing has been signed/);
  assert.equal(releasePreflight({ booking: booking(), facts: { ...facts(), checked: false }, now: NOW }).ready, false, 'facts must be marked as checked');
});

test('preflight wallet, network and role rows give plain failures with a next action', async () => {
  const { releasePreflight } = await model();
  const cases = [
    [{ wallet: null }, 'wallet', 'fail', /No wallet is connected/],
    [{ walletError: 'extension locked', wallet: null }, 'wallet', 'fail', /extension locked/],
    [{ wallet: { address: other, admin: false } }, 'wallet', 'fail', /not the admin wallet/],
    [{ chain: { ...facts().chain, mismatches: ['funder'] } }, 'wallet', 'fail', /did not fund this escrow/],
    [{ chainId: 1 }, 'network', 'fail', /chain 1, not Base/],
    [{ chainId: null, chainError: 'rpc down' }, 'network', 'unknown', /rpc down/],
    [{ chain: { ...facts().chain, hasRole: false } }, 'role', 'fail', /does not hold the escrow admin role/],
    [{ chain: { ...facts().chain, paused: true } }, 'role', 'fail', /contract is paused/],
  ];
  for (const [change, rowId, status, detail] of cases) {
    const result = releasePreflight({ booking: booking(), facts: facts(change), now: NOW });
    const item = row(result, rowId);
    assert.equal(item.status, status, JSON.stringify(change));
    assert.match(`${item.detail}`, detail);
    assert.ok(item.next, `${rowId} gives a next action`);
    assert.equal(result.ready, false);
  }
  const unreadable = releasePreflight({ booking: booking(), facts: facts({ chain: { ...facts().chain, hasRole: undefined, paused: undefined } }), now: NOW });
  assert.equal(row(unreadable, 'role').status, 'unknown');
  assert.equal(row(unreadable, 'role').blocking, false, 'an unreadable role is advisory; the pre-sign simulation is authoritative');
  assert.equal(unreadable.ready, true);
});

test('preflight booking and escrow rows reflect backend state and on-chain state separately', async () => {
  const { releasePreflight } = await model();
  for (const [status, next] of [['draft', /Fund the booking/], ['approved', /claim from Profile/], ['paid', /claim from Profile/], ['refunded', /No payout is possible/]]) {
    const result = releasePreflight({ booking: booking({ status }), facts: facts(), now: NOW });
    assert.equal(row(result, 'booking').status, 'fail', status);
    assert.match(row(result, 'booking').next, next);
    assert.equal(result.blocked, true);
  }
  assert.equal(releasePreflight({ booking: booking({ mode: 'phase0' }), facts: facts(), now: NOW }).blocked, true);
  const chain = overrides => releasePreflight({ booking: booking(), facts: facts({ chain: { ...facts().chain, ...overrides } }), now: NOW });
  assert.match(row(chain({ status: 0 }), 'escrow').detail, /not created on Base/);
  assert.match(row(chain({ status: 2, payoutUnits: '20000000' }), 'escrow').next, /Already approved/);
  const partial = row(chain({ status: 2, payoutUnits: '10000000' }), 'escrow');
  assert.match(partial.detail, /approved on Base for \$10\.00 USDC, not the full \$20\.00 USDC fee/);
  assert.match(partial.next, /Do not send anything/);
  assert.match(row(chain({ status: 3 }), 'escrow').detail, /paid on Base/);
  assert.match(row(chain({ status: 4 }), 'escrow').detail, /refunded on Base/);
  assert.equal(row(chain({ mismatches: ['claimDeadline', 'killFeeBps'] }), 'escrow').status, 'fail');
  assert.match(row(chain({ mismatches: ['claimDeadline', 'killFeeBps'] }), 'escrow').detail, /claim deadline, late-cancel fee/);
  const unreadable = releasePreflight({ booking: booking(), facts: facts({ chain: { error: 'Base did not answer' } }), now: NOW });
  assert.equal(row(unreadable, 'escrow').status, 'unknown');
  assert.equal(unreadable.ready, false);
  assert.equal(unreadable.blocked, false);
  assert.equal(unreadable.unverified, true);
  assert.match(unreadable.summary, /Could not verify: .*Escrow on Base.*Nothing was signed/);
});

test('preflight amounts compare the booking fee with the funded amount in exact units and always show a zero refund', async () => {
  const { releasePreflight } = await model();
  const amounts = (bookingOverride, chainOverride) => row(releasePreflight({ booking: booking(bookingOverride),
    facts: facts({ chain: { ...facts().chain, ...chainOverride } }), now: NOW }), 'amounts');
  assert.equal(amounts().status, 'pass');
  assert.match(amounts().detail, /Will approve \$20\.00 USDC, the full funded fee, with a \$0\.00 USDC refund/);
  assert.equal(amounts({}, { amountUnits: '20000001' }).status, 'fail');
  assert.match(amounts({}, { amountUnits: '20000001' }).detail, /\$20\.000001 USDC\) differs from the booking fee \(\$20\.00 USDC\)/);
  assert.equal(amounts({ amountUnits: '0' }).status, 'fail');
  assert.equal(amounts({}, { error: 'x' }).status, 'unknown');
});

test('preflight timing uses Base time when available and never opens early, late or after the contract auto-claim', async () => {
  const { releasePreflight } = await model();
  const timing = (nowMs, chainTime) => row(releasePreflight({ booking: booking(), now: nowMs,
    facts: facts({ chain: { ...facts().chain, blockTime: chainTime } }) }), 'timing');
  const end = Date.parse(booking().endUtc);
  assert.equal(timing(NOW, Math.floor(NOW / 1000)).status, 'pass');
  assert.match(timing(NOW, Math.floor(NOW / 1000)).detail, /by Base time/);
  assert.equal(timing(NOW, undefined).status, 'pass');
  assert.match(timing(NOW, undefined).detail, /by your clock/);
  assert.equal(timing(NOW, Math.floor(end / 1000) - 1).status, 'fail', 'Base time wins over the local clock');
  assert.match(timing(NOW, Math.floor(end / 1000) - 1).next, /Come back after/);
  assert.equal(timing(end + 86400000, undefined).status, 'fail');
  assert.match(timing(end + 86400000, undefined).detail, /can claim the full fee without your approval/);
  assert.equal(timing(Date.parse(booking().claimDeadline) + 1, undefined).status, 'fail');
  assert.match(timing(Date.parse(booking().claimDeadline) + 1, undefined).next, /do not send a duplicate payment/i);
});

test('preflight stage row blocks on pending or unreadable completion but keeps the legacy and verified workflows', async () => {
  const { releasePreflight } = await model();
  const stage = change => row(releasePreflight({ booking: booking(change), facts: facts(), now: NOW }), 'stage');
  assert.equal(stage({}).status, 'pass');
  assert.match(stage({}).detail, /original contract workflow applies/);
  assert.equal(stage({ broadcastCompletion: { known: true, pending: false, actualEndedAt: NOW - 1000, endReason: 'producer-finished' } }).status, 'pass');
  assert.match(stage({ broadcastCompletion: { known: true, pending: false, actualEndedAt: NOW - 1000, endReason: 'operator-cut' } }).detail, /Interrupted by an owner cut/);
  assert.equal(stage({ broadcastCompletion: { known: true, pending: false, actualEndedAt: null } }).status, 'pass');
  assert.match(stage({ broadcastCompletion: { known: true, pending: false, actualEndedAt: null } }).detail, /original contract workflow remains in effect/);
  const pending = stage({ broadcastCompletion: { known: true, pending: true, actualEndedAt: null } });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.blocking, true);
  assert.match(pending.detail, /original contract end is not proof/);
  for (const completion of [null, { known: false, pending: true }, { known: false, pending: false }]) {
    const unknown = stage({ broadcastCompletion: completion });
    assert.equal(unknown.status, 'unknown', JSON.stringify(completion));
    assert.match(unknown.detail, /guaranteed fee is unchanged/);
  }
  const blockedByStage = releasePreflight({ booking: booking({ broadcastCompletion: { known: true, pending: true } }), facts: facts(), now: NOW });
  assert.equal(blockedByStage.ready, false);
  assert.equal(blockedByStage.blocked, false, 'pending is not a failure; it is not yet verifiable');
});

test('recording state is informational and can never block or alter the cash release', async () => {
  const { releasePreflight, releasePreview } = await model();
  const states = [undefined, { known: false }, { known: true, state: 'none' }, { known: true, state: 'processing' },
    { known: true, state: 'mint-requested' }, { known: true, state: 'minted', tokenId: '7' }, { known: true, state: 'aired', trackId: 'x' }];
  const preview = releasePreview(booking());
  for (const recordingRelease of states) {
    const result = releasePreflight({ booking: booking({ recordingRelease }), facts: facts(), now: NOW });
    const item = row(result, 'recording');
    assert.equal(item.status, 'info');
    assert.equal(item.blocking, false);
    assert.match(item.detail, /Cash release does not depend on the recording or on any supporter gift/);
    assert.equal(result.ready, true);
    assert.deepEqual(releasePreview(booking({ recordingRelease })), preview);
  }
});

test('release flow reducer: every phase transition with the step that failed', async () => {
  const { createFlow, reduceFlow, releasePreflight } = await model();
  const run = (...events) => events.reduce(reduceFlow, createFlow());
  const ready = releasePreflight({ booking: booking(), facts: facts(), now: NOW });
  const blocked = releasePreflight({ booking: booking({ status: 'approved' }), facts: facts(), now: NOW });
  const unverified = releasePreflight({ booking: booking(), facts: facts({ chain: { error: 'x' } }), now: NOW });
  assert.equal(createFlow().phase, 'idle');
  assert.equal(run({ type: 'checking' }).phase, 'checking');
  assert.equal(run({ type: 'checking' }, { type: 'preflight', preflight: ready }).phase, 'ready');
  assert.equal(run({ type: 'preflight', preflight: blocked }).phase, 'blocked');
  assert.equal(run({ type: 'preflight', preflight: unverified }).phase, 'unavailable');
  assert.equal(run({ type: 'preflight', preflight: ready }, { type: 'report-signing' }).phase, 'signing-report');
  const pinned = run({ type: 'report-signing' }, { type: 'report-pinned', uri: 'ipfs://bafkreitest' });
  assert.equal(pinned.phase, 'report-pinned');
  assert.equal(pinned.reportUri, 'ipfs://bafkreitest');
  assert.equal(run({ type: 'signing' }).phase, 'signing');
  assert.equal(run({ type: 'signing' }).step, 'approve');
  const pending = run({ type: 'signing' }, { type: 'submitted', hash: txHash });
  assert.deepEqual([pending.phase, pending.hash, pending.step], ['pending', txHash, 'confirm']);
  assert.equal(run({ type: 'submitted', hash: txHash }, { type: 'confirming', hash: txHash, confirmations: 1 }).phase, 'confirming');
  const confirmed = run({ type: 'submitted', hash: txHash }, { type: 'confirmed', hash: txHash, verified: true, reportUri: 'ipfs://bafkreitest' });
  assert.deepEqual([confirmed.phase, confirmed.step, confirmed.source], ['confirmed', 'verified', 'receipt']);
  const failedAtSign = run({ type: 'signing' }, { type: 'failed', kind: 'rejected', message: '' });
  assert.deepEqual([failedAtSign.phase, failedAtSign.failedStep, failedAtSign.kind], ['failed', 'approve', 'rejected']);
  const failedAtReport = run({ type: 'report-signing' }, { type: 'failed', kind: 'upload', message: 'x' });
  assert.equal(failedAtReport.failedStep, 'report');
  const unknown = run({ type: 'submitted', hash: txHash }, { type: 'unknown', kind: 'unconfirmed', message: 'could not read' });
  assert.deepEqual([unknown.phase, unknown.hash, unknown.failedStep], ['unknown', txHash, 'confirm']);
  assert.equal(run({ type: 'failed', kind: 'reverted' }, { type: 'reset' }).phase, 'idle');
  assert.equal(run({ type: 'submitted', hash: txHash }, { type: 'checking' }).phase, 'checking', 'a re-check may leave pending');
  const retried = run({ type: 'failed', kind: 'rejected' }, { type: 'checking' });
  assert.equal(retried.kind, null, 'a new attempt clears the previous failure');
  assert.equal(run({ type: 'mystery' }).phase, 'idle');
});

test('release flow never reports success without a verified event, and success is terminal', async () => {
  const { createFlow, reduceFlow } = await model();
  const run = (...events) => events.reduce(reduceFlow, createFlow());
  for (const confirmed of [{ type: 'confirmed', hash: txHash }, { type: 'confirmed', hash: txHash, verified: false },
    { type: 'confirmed', hash: 'not-a-hash', verified: true }, { type: 'confirmed', verified: true }]) {
    const flow = run({ type: 'submitted', hash: txHash }, confirmed);
    assert.equal(flow.phase, 'unknown', JSON.stringify(confirmed));
    assert.equal(flow.kind, 'unverified');
    assert.match(flow.message, /success is not claimed/);
  }
  assert.equal(run({ type: 'submitted', hash: 'nope' }).phase, 'unknown', 'an untrackable hash is unknown, not pending');
  const chainState = run({ type: 'confirmed', source: 'chain-state', verified: true });
  assert.deepEqual([chainState.phase, chainState.source], ['confirmed', 'chain-state']);
  assert.equal(run({ type: 'confirmed', source: 'chain-state' }).phase, 'unknown', 'chain-state still needs verified:true');
  const done = run({ type: 'submitted', hash: txHash }, { type: 'confirmed', hash: txHash, verified: true });
  for (const late of [{ type: 'failed', kind: 'error' }, { type: 'unknown' }, { type: 'checking' }, { type: 'signing' }, { type: 'submitted', hash: txHash }]) {
    assert.equal(reduceFlow(done, late), done, `${late.type} cannot undo a verified approval`);
  }
  assert.equal(reduceFlow(done, { type: 'reset' }).phase, 'idle');
});

test('release flow views give a title, plain text and a next action for every phase', async () => {
  const { createFlow, reduceFlow, releaseFlowView, releasePreflight, FLOW_PHASES } = await model();
  const b = booking();
  const ready = releasePreflight({ booking: b, facts: facts(), now: NOW });
  const blocked = releasePreflight({ booking: b, facts: facts({ chainId: 1 }), now: NOW });
  const unverified = releasePreflight({ booking: b, facts: facts({ chain: { error: 'Base did not answer' } }), now: NOW });
  const flows = {
    idle: createFlow(),
    checking: reduceFlow(createFlow(), { type: 'checking' }),
    blocked: reduceFlow(createFlow(), { type: 'preflight', preflight: blocked }),
    unavailable: reduceFlow(createFlow(), { type: 'preflight', preflight: unverified }),
    ready: reduceFlow(createFlow(), { type: 'preflight', preflight: ready }),
    'signing-report': reduceFlow(createFlow(), { type: 'report-signing' }),
    'report-pinned': reduceFlow(createFlow(), { type: 'report-pinned', uri: 'ipfs://bafkreitest' }),
    signing: reduceFlow(createFlow(), { type: 'signing' }),
    pending: reduceFlow(createFlow(), { type: 'submitted', hash: txHash }),
    confirming: reduceFlow(createFlow(), { type: 'confirming', hash: txHash }),
    confirmed: [{ type: 'submitted', hash: txHash }, { type: 'confirmed', hash: txHash, verified: true }].reduce(reduceFlow, createFlow()),
    failed: reduceFlow(createFlow(), { type: 'failed', kind: 'reverted', hash: txHash }),
    unknown: reduceFlow(reduceFlow(createFlow(), { type: 'submitted', hash: txHash }), { type: 'unknown', kind: 'unconfirmed', message: 'The result could not be read.' }),
  };
  assert.deepEqual(Object.keys(flows).sort(), [...FLOW_PHASES].sort());
  for (const [phase, flow] of Object.entries(flows)) {
    const view = releaseFlowView(flow, { booking: b });
    assert.equal(view.phase, phase);
    for (const key of ['title', 'text', 'next']) assert.ok(typeof view[key] === 'string' && view[key].trim().length > 5, `${phase} has ${key}`);
    assert.equal(view.steps.length, 5);
    assert.ok(view.primary.label);
  }
  const view = phase => releaseFlowView(flows[phase], { booking: b });
  assert.match(view('idle').text, /Nothing has been signed or sent/);
  assert.match(view('blocked').title, /nothing was signed/);
  assert.match(view('blocked').text, /Network: The wallet is on chain 1, not Base/);
  assert.match(view('blocked').next, /Switch your wallet network to Base/);
  assert.match(view('unavailable').title, /Could not verify · nothing was signed/);
  assert.match(view('unavailable').text, /never assumed to pass/);
  assert.match(view('signing').text, /Approve 100% · \$20\.00 USDC/);
  assert.match(view('signing').text, /not a payment to the performer/);
  assert.match(view('pending').title, /Submitted · waiting for Base/);
  assert.match(view('pending').text, /Do not send another/);
  assert.match(view('pending').next, /BaseScan/);
  assert.match(view('confirmed').title, /Approved on Base/);
  assert.match(view('confirmed').text, /Approval is not payment received/);
  assert.match(view('confirmed').text, /until Nov 17, 2026, 9:20 PM ET/);
  assert.match(view('confirmed').next, /performer to open Profile and claim/);
  assert.match(view('unknown').text, /neither is assumed/);
  assert.match(view('unknown').next, /BaseScan/);
  assert.deepEqual(view('confirmed').links.map(link => link.href), [`https://basescan.org/tx/${txHash}`]);
});

test('release failure kinds say exactly what happened and what to do next', async () => {
  const { createFlow, reduceFlow, releaseFlowView } = await model();
  const view = (kind, message = '') => releaseFlowView([{ type: 'submitted', hash: txHash }, { type: 'failed', kind, message, hash: txHash }].reduce(reduceFlow, createFlow()), { booking: booking() });
  assert.match(view('rejected').title, /Cancelled in your wallet · nothing was sent/);
  assert.match(view('rejected').next, /Check again/);
  assert.match(view('precheck', 'On-chain booking does not match.').title, /Final check failed · nothing was sent/);
  assert.match(view('precheck', 'On-chain booking does not match.').text, /On-chain booking does not match\./);
  assert.match(view('upload').title, /Report upload failed · nothing was sent/);
  assert.match(view('unavailable').title, /Could not reach Base · nothing was sent/);
  assert.match(view('reverted').title, /reverted on Base · nothing was released/);
  assert.match(view('reverted').text, /There is no approval and no payment/);
  assert.match(view('replaced').title, /cancelled or replaced/);
  assert.match(view('mismatch').title, /Receipt does not match · not certified/);
  assert.match(view('mismatch').next, /Do not send again/);
  const generic = view('error', 'weird failure');
  assert.match(generic.title, /Something went wrong · nothing confirmed/);
  assert.match(generic.next, /a transaction may already be pending/);
  for (const kind of ['rejected', 'precheck', 'upload', 'unavailable', 'reverted', 'replaced', 'mismatch', 'error']) {
    assert.equal(view(kind).tone, 'error');
    assert.ok(view(kind).retry);
    assert.ok(view(kind).recheck);
  }
});

test('release steps and primary button follow the phase and never offer a second send while one is pending', async () => {
  const { createFlow, reduceFlow, releaseFlowView, releasePreflight } = await model();
  const b = booking();
  const states = flow => releaseFlowView(flow, { booking: b }).steps.map(step => step.state);
  assert.deepEqual(states(createFlow()), ['todo', 'todo', 'todo', 'todo', 'todo']);
  assert.deepEqual(states(reduceFlow(createFlow(), { type: 'checking' })), ['active', 'todo', 'todo', 'todo', 'todo']);
  assert.deepEqual(states(reduceFlow(createFlow(), { type: 'report-signing' })), ['done', 'active', 'todo', 'todo', 'todo']);
  assert.deepEqual(states(reduceFlow(createFlow(), { type: 'signing' })), ['done', 'done', 'active', 'todo', 'todo']);
  const pending = reduceFlow(createFlow(), { type: 'submitted', hash: txHash });
  assert.deepEqual(states(pending), ['done', 'done', 'done', 'active', 'todo']);
  const confirmed = [{ type: 'submitted', hash: txHash }, { type: 'confirmed', hash: txHash, verified: true }].reduce(reduceFlow, createFlow());
  assert.deepEqual(states(confirmed), ['done', 'done', 'done', 'done', 'done']);
  assert.deepEqual(states(reduceFlow(createFlow(), { type: 'signing' }) && [{ type: 'signing' }, { type: 'failed', kind: 'rejected' }].reduce(reduceFlow, createFlow())), ['done', 'done', 'failed', 'todo', 'todo']);
  assert.deepEqual(states(reduceFlow(createFlow(), { type: 'preflight', preflight: releasePreflight({ booking: b, facts: facts({ chainId: 1 }), now: NOW }) })), ['failed', 'todo', 'todo', 'todo', 'todo']);
  assert.deepEqual(states([{ type: 'submitted', hash: txHash }, { type: 'unknown', kind: 'unconfirmed' }].reduce(reduceFlow, createFlow())), ['done', 'done', 'done', 'unknown', 'todo']);
  const primary = (flow, extra = {}) => releaseFlowView(flow, { booking: b, ...extra }).primary;
  assert.deepEqual(primary(createFlow()), { label: 'Check & release full $20.00 from escrow', disabled: false });
  assert.deepEqual(primary(createFlow(), { release: { label: 'Available after the set', disabled: true } }), { label: 'Available after the set', disabled: true });
  assert.equal(primary(createFlow(), { pendingHash: txHash }).label, 'Check pending escrow release');
  assert.equal(primary(pending).label, 'Check pending escrow release');
  assert.equal(primary(reduceFlow(createFlow(), { type: 'signing' })).disabled, true);
  assert.equal(primary(confirmed).disabled, true);
  assert.equal(primary(reduceFlow(createFlow(), { type: 'failed', kind: 'rejected' })).label, 'Check again & release');
  assert.equal(releaseFlowView(reduceFlow(createFlow(), { type: 'signing' }), { booking: b }).recheck, false);
  assert.equal(releaseFlowView(confirmed, { booking: b }).recheck, false);
  assert.equal(releaseFlowView(pending, { booking: b }).recheck, true);
});

test('claim flow views for the performer are truthful for each phase', async () => {
  const { createFlow, reduceFlow, claimFlowView } = await model();
  const b = booking({ status: 'approved', approvedUnits: '20000000' });
  const run = (...events) => claimFlowView(events.reduce(reduceFlow, createFlow()), { booking: b });
  assert.match(run().title, /Ready to claim/);
  assert.match(run({ type: 'signing' }).text, /Claim \$20\.00 USDC to your booked wallet/);
  assert.match(run({ type: 'submitted', hash: txHash }).text, /Do not send a second claim/);
  assert.match(run({ type: 'confirmed', hash: txHash, verified: true }).title, /Payment confirmed/);
  assert.match(run({ type: 'confirmed', hash: txHash, verified: true }).text, /verified from the transaction receipt/);
  assert.match(run({ type: 'confirmed', hash: txHash }).title, /not verified/i);
  assert.match(run({ type: 'failed', kind: 'rejected' }).title, /nothing was sent/);
  assert.match(run({ type: 'failed', kind: 'reverted', hash: txHash }).title, /Claim reverted on Base · nothing was paid/);
  assert.match(run({ type: 'failed', kind: 'mismatch', hash: txHash }).title, /receipt does not match/);
  assert.match(run({ type: 'failed', kind: 'mismatch', hash: txHash }).title, /Payment not confirmed/);
  assert.match(run({ type: 'failed', kind: 'weird', message: 'boom' }).next, /Refresh payment status/);
  const unknown = run({ type: 'submitted', hash: txHash }, { type: 'unknown', message: 'Receipt could not be read.' });
  assert.match(unknown.title, /Payment not verified yet/);
  assert.match(unknown.text, /neither confirmed nor ruled out/);
  assert.match(unknown.next, /BaseScan/);
});

test('transaction errors are classified without mistaking service denials for wallet rejections', async () => {
  const { classifyTxError } = await model();
  assert.equal(classifyTxError(Object.assign(new Error('x'), { code: 'ACTION_REJECTED' })), 'rejected');
  assert.equal(classifyTxError(Object.assign(new Error('x'), { code: 4001 })), 'rejected');
  assert.equal(classifyTxError(new Error('User rejected the request.')), 'rejected');
  assert.equal(classifyTxError(new Error('MetaMask Tx Signature: User denied transaction signature.')), 'rejected');
  assert.equal(classifyTxError(new Error('Wallet request rejected')), 'rejected');
  assert.equal(classifyTxError(new Error('Upload denied')), 'error');
  assert.equal(classifyTxError(new Error('Signature declined by service')), 'error');
  assert.equal(classifyTxError(Object.assign(new Error('replaced'), { code: 'TRANSACTION_REPLACED' })), 'replaced');
  assert.equal(classifyTxError(Object.assign(new Error('reverted'), { code: 'CALL_EXCEPTION', receipt: { status: 0 } })), 'reverted');
  assert.equal(classifyTxError(Object.assign(new Error('simulate'), { code: 'CALL_EXCEPTION' })), 'error');
  assert.equal(classifyTxError(new Error('Failed to fetch')), 'unavailable');
  assert.equal(classifyTxError(Object.assign(new Error('x'), { code: 'TIMEOUT' })), 'unavailable');
  assert.equal(classifyTxError(new Error('Wallet/network changed; refresh and reconcile any submitted transaction before retry')), 'error');
  assert.equal(classifyTxError(null), 'error');
});

const paidReceipt = (over = {}) => {
  const iface = new Interface(['event PerformancePaid(bytes32 indexed bookingId, address indexed performer, uint256 amount, bytes32 termsHash)']);
  const args = { bookingId: id(booking().id), performer: artist, amount: 20000000n, termsHash: booking().termsHash, ...over.args };
  const log = iface.encodeEventLog('PerformancePaid', [args.bookingId, args.performer, args.amount, args.termsHash]);
  return { iface, receipt: { status: 1, hash: txHash, logs: [{ ...log, address: over.address || escrow }], ...over.receipt } };
};

test('payment is confirmed only by the exact PerformancePaid event for this booking, performer and amount', async () => {
  const { verifyPaidReceipt } = await model();
  const { LIVE_ESCROW_ABI } = await import('../js/live-bookings.mjs');
  const iface = new Interface(LIVE_ESCROW_ABI);
  const encode = (args = {}) => {
    const value = { bookingId: id(booking().id), performer: artist, amount: 20000000n, termsHash: booking().termsHash, ...args };
    return { ...iface.encodeEventLog('PerformancePaid', [value.bookingId, value.performer, value.amount, value.termsHash]), address: escrow };
  };
  const base = { escrowAddress: escrow, iface, bookingHash: id(booking().id), performer: artist, amountUnits: '20000000', termsHash: booking().termsHash };
  assert.deepEqual(verifyPaidReceipt({ ...base, receipt: { status: 1, logs: [encode()] } }), { ok: true, amountUnits: '20000000' });
  assert.equal(verifyPaidReceipt({ ...base, receipt: { status: 1, logs: [encode({ bookingId: id('other') })] } }).reason, 'no-event');
  assert.equal(verifyPaidReceipt({ ...base, receipt: { status: 1, logs: [encode({ performer: other })] } }).reason, 'no-event');
  assert.equal(verifyPaidReceipt({ ...base, receipt: { status: 1, logs: [encode({ amount: 19999999n })] } }).reason, 'no-event');
  assert.equal(verifyPaidReceipt({ ...base, receipt: { status: 1, logs: [encode({ termsHash: id('x') })] } }).reason, 'no-event');
  assert.equal(verifyPaidReceipt({ ...base, receipt: { status: 1, logs: [{ ...encode(), address: other }] } }).reason, 'no-event', 'a log from another contract proves nothing');
  assert.equal(verifyPaidReceipt({ ...base, receipt: { status: 1, logs: [] } }).reason, 'no-event');
  assert.equal(verifyPaidReceipt({ ...base, receipt: { status: 1, logs: [encode(), encode()] } }).reason, 'duplicate');
  assert.equal(verifyPaidReceipt({ ...base, receipt: { status: 0, logs: [encode()] } }).reason, 'reverted');
  assert.equal(verifyPaidReceipt({ ...base, receipt: null }).reason, 'reverted');
  assert.equal(verifyPaidReceipt({ ...base, receipt: { status: 1 } }).reason, 'unverifiable');
  assert.equal(verifyPaidReceipt({ ...base, iface: undefined, receipt: { status: 1, logs: [encode()] } }).reason, 'unverifiable', 'no way to decode logs is never "confirmed"');
  assert.equal(verifyPaidReceipt({ ...base, iface: { parseLog() { throw new Error('boom'); } }, receipt: { status: 1, logs: [encode()] } }).reason, 'no-event');
});
