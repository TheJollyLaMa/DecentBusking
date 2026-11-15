const test = require('node:test');
const assert = require('node:assert/strict');
const { Interface, id } = require('../discord-bot/node_modules/ethers');

const owner = '0x' + '11'.repeat(20), artist = '0x' + '22'.repeat(20), escrow = '0x' + '33'.repeat(20), stranger = '0x' + '55'.repeat(20);
const txHash = '0x' + '44'.repeat(32), replacementHash = '0x' + '66'.repeat(32);
const reportUri = 'ipfs://bafkreitestpublicreport';
const bookingId = 'afterparty:fixture';
const pendingKey = `live-pending:${bookingId}:approve`;

async function fixture(options = {}) {
  const lib = await import('../js/live-escrow-release.mjs');
  const model = await import('../js/live-afterparty.mjs');
  const { LIVE_ESCROW_ABI } = await import('../js/live-bookings.mjs');
  const now = Date.now(), seconds = ms => Math.floor(ms / 1000) * 1000;
  const booking = { id: bookingId, mode: 'phase1', payoutPolicy: 'pilot-guaranteed-v1', status: 'funded', wallet: artist, displayName: 'Fixture performer',
    title: 'Afterparty fixture', amountUnits: '20000000', termsHash: id('accepted terms'), termsUri: 'ipfs://bafkreiterms',
    startUtc: new Date(seconds(now - 3600000)).toISOString(), endUtc: new Date(seconds(now - 600000)).toISOString(),
    claimDeadline: new Date(seconds(now + 86400000 * 4)).toISOString(), reviewWindow: 86400, cancellationWindow: 28800, killFeeBps: 10000, ...options.booking };
  const iface = new Interface(LIVE_ESCROW_ABI), values = new Map(), events = [], progress = [], uploads = [], sentArgs = [];
  const counts = { sent: 0, uploaded: 0, simulated: 0, checks: 0, receiptReads: 0 };
  const state = {
    onchain: { performer: artist, funder: owner, amount: BigInt(booking.amountUnits), payoutAmount: 0n, termsHash: booking.termsHash,
      showStart: BigInt(Date.parse(booking.startUtc) / 1000), showEnd: BigInt(Date.parse(booking.endUtc) / 1000),
      claimDeadline: BigInt(Date.parse(booking.claimDeadline) / 1000), reviewWindow: 86400n, cancellationWindow: 28800n, killFeeBps: 10000n, status: 1n },
    blockTime: Math.floor(now / 1000), blockNumber: 101, roles: null, uploadError: null, simulateError: null, sendError: null, waitError: null,
    receiptError: null, bookingsError: null, saveFails: false, saveHashFails: false, checkFailsAfterSend: false, uri: reportUri,
  };
  const log = iface.encodeEventLog('PerformanceApproved', [id(booking.id), 10000, BigInt(booking.amountUnits), 0, reportUri, booking.termsHash]);
  const receipt = { status: 1, to: escrow, hash: txHash, blockNumber: 100, logs: [{ ...log, address: escrow }] };
  state.receipt = receipt;
  state.canonical = receipt;
  const approve = async (...args) => {
    if (state.sendError) throw state.sendError;
    counts.sent++; sentArgs.push(args);
    return { hash: txHash, wait: async confirmations => { assert.equal(confirmations, 2); if (state.waitError) throw state.waitError; return state.receipt; } };
  };
  approve.staticCall = async () => { counts.simulated++; if (state.simulateError) throw state.simulateError; };
  const provider = { getNetwork: async () => ({ chainId: 8453n }), getBlock: async () => ({ timestamp: state.blockTime }), getBlockNumber: async () => state.blockNumber,
    getTransactionReceipt: async () => { counts.receiptReads++; if (state.receiptError) throw state.receiptError; return state.canonical; } };
  const contract = { interface: iface, getFunction: () => approve, bookings: async () => { if (state.bookingsError) throw state.bookingsError; return state.onchain; } };
  const storage = { getItem: key => values.get(key) || null, removeItem: key => values.delete(key),
    setItem: (key, value) => {
      if (key === pendingKey && (state.saveFails || state.saveHashFails && counts.sent > 0)) throw new Error('QuotaExceededError');
      values.set(key, value);
    } };
  class FakeContract {
    constructor() {
      return { hasRole: async () => { if (state.roles.hasRoleError) throw new Error('hasRole unavailable'); return state.roles.hasRole; }, paused: async () => state.roles.paused };
    }
  }
  const ethers = { id, get Contract() { return state.roles ? FakeContract : undefined; } };
  const wallet = { ethers, signer: {}, address: owner, provider,
    check: async () => { counts.checks++; if (state.checkFailsAfterSend && counts.sent > 0) throw new Error('Wallet/network changed; refresh and reconcile any submitted transaction before retry'); } };
  const session = { facts: { wallet: { address: owner, admin: true }, chainId: 8453 }, wallet, ...options.session };
  const base = { booking, escrowAddress: escrow, storage, contract, session, onProgress: message => progress.push(message), now: options.now,
    onState: event => { if (options.throwOnState) throw new Error('render exploded'); events.push(event); },
    uploadReport: async file => { counts.uploaded++; if (state.uploadError) throw state.uploadError; uploads.push(JSON.parse(await file.text())); return state.uri; } };
  if (options.now === undefined) delete base.now;
  const fold = list => list.reduce(model.reduceFlow, model.createFlow());
  return { ...lib, model, booking, state, counts, events, progress, uploads, sentArgs, values, receipt, options: base, wallet, session, fold,
    flow: () => fold(events), guided: (extra = {}) => lib.guidedGuaranteedRelease({ ...base, ...extra }), check: (extra = {}) => lib.checkGuaranteedRelease({ ...base, ...extra }),
    direct: (extra = {}) => lib.releaseGuaranteedEscrow({ ...base, wallet, ...extra }), assertNothingSigned() {
      assert.deepEqual([counts.uploaded, counts.simulated, counts.sent], [0, 0, 0], 'no upload, simulation or transaction');
    } };
}
const rejection = () => Object.assign(new Error('user rejected action'), { code: 'ACTION_REJECTED' });
const phases = (model, events) => { const out = []; events.reduce((flow, event) => { const next = model.reduceFlow(flow, event); out.push(next.phase); return next; }, model.createFlow()); return out; };

test('guided release runs checks first, then the wallet-signed steps, in a truthful event order', async () => {
  const f = await fixture();
  const result = await f.guided();
  assert.equal(result.outcome, 'approved');
  assert.equal(result.reportUri, reportUri);
  assert.deepEqual(f.events.map(event => event.type), ['checking', 'preflight', 'report-signing', 'report-pinned', 'signing', 'submitted', 'confirmed']);
  assert.deepEqual(phases(f.model, f.events), ['checking', 'ready', 'signing-report', 'report-pinned', 'signing', 'pending', 'confirmed']);
  assert.deepEqual([f.counts.uploaded, f.counts.simulated, f.counts.sent], [1, 1, 1]);
  assert.equal(f.events[1].preflight.ready, true);
  assert.deepEqual(f.sentArgs, [[id(f.booking.id), 10000, reportUri]]);
  assert.deepEqual(f.events.at(-1), { type: 'confirmed', hash: txHash, verified: true, reportUri });
  assert.equal(f.values.has(pendingKey), false);
  const view = f.model.releaseFlowView(f.flow(), { booking: f.booking });
  assert.match(view.title, /Approved on Base/);
  assert.match(view.text, /Approval is not payment received/);
});

test('guided release never signs or sends while the preflight is blocked or unverified', async () => {
  const roles = (hasRole, paused) => f => { f.state.roles = { hasRole, paused }; };
  const cases = [
    ['wrong network', f => { f.session.facts.chainId = 1; }, 'blocked', /Network: The wallet is on chain 1, not Base/],
    ['not the admin wallet', f => { f.session.facts.wallet.admin = false; }, 'blocked', /not the admin wallet/],
    ['no wallet connected', f => { f.session.facts.wallet = null; f.session.wallet = null; }, 'blocked', /No wallet is connected/],
    ['booking not funded in the backend', f => { f.booking.status = 'draft'; }, 'blocked', /Fund the booking/],
    ['escrow already approved for less than the fee', f => { f.state.onchain.status = 2n; f.state.onchain.payoutAmount = 10000000n; }, 'blocked', /not the full \$20\.00 USDC fee/],
    ['escrow already paid', f => { f.state.onchain.status = 3n; f.state.onchain.payoutAmount = 20000000n; }, 'blocked', /paid on Base/],
    ['escrow refunded', f => { f.state.onchain.status = 4n; }, 'blocked', /refunded on Base/],
    ['escrow never created', f => { f.state.onchain.status = 0n; }, 'blocked', /not created on Base/],
    ['funded amount differs from the booking fee', f => { f.state.onchain.amount = 20000001n; }, 'blocked', /differs from the booking fee/],
    ['accepted terms differ on-chain', f => { f.state.onchain.termsHash = id('other terms'); }, 'blocked', /agreement fingerprint/],
    ['claim deadline differs on-chain', f => { f.state.onchain.claimDeadline += 1n; }, 'blocked', /claim deadline/],
    ['before the booked end by Base time', f => { f.state.blockTime = Number(f.state.onchain.showEnd) - 5; }, 'blocked', /Come back after/],
    ['review window over by Base time', f => { f.state.blockTime = Number(f.state.onchain.showEnd) + 86400 + 1; }, 'blocked', /without your approval/],
    ['contract paused', roles(true, true), 'blocked', /contract is paused/],
    ['wallet lacks the admin role', roles(false, false), 'blocked', /does not hold the escrow admin role/],
    ['stage completion still pending', f => { f.booking.broadcastCompletion = { known: true, pending: true, actualEndedAt: null }; }, 'unavailable', /original contract end is not proof/],
    ['stage completion unreadable', f => { f.booking.broadcastCompletion = null; }, 'unavailable', /guaranteed fee is unchanged/],
    ['escrow state unreadable', f => { f.state.bookingsError = new Error('Base did not answer'); }, 'unavailable', /Base did not answer/],
  ];
  for (const [name, change, outcome, text] of cases) {
    const f = await fixture();
    change(f);
    const result = await f.guided();
    assert.equal(result.outcome, outcome, name);
    f.assertNothingSigned();
    assert.equal(f.values.size, 0, `${name}: nothing saved`);
    assert.deepEqual(f.events.map(event => event.type), ['checking', 'preflight'], name);
    const flow = f.flow();
    assert.equal(flow.phase, outcome, name);
    const view = f.model.releaseFlowView(flow, { booking: f.booking });
    assert.match(view.title, /nothing was signed/, name);
    assert.match(`${view.text} ${view.next}`, text, name);
    assert.ok(view.next.length > 10, `${name}: has a next action`);
    assert.equal(view.primary.disabled, false, `${name}: can re-check`);
  }
});

test('a clean read-only check says ready without signing anything', async () => {
  const f = await fixture();
  const result = await f.check();
  assert.equal(result.outcome, 'ready');
  f.assertNothingSigned();
  assert.equal(f.flow().phase, 'ready');
  const loud = await fixture({ session: { wallet: null, facts: { wallet: null, walletError: 'extension locked', chainId: null } } });
  assert.equal((await loud.check()).outcome, 'blocked');
  assert.match(loud.flow().message, /Admin wallet/);
});

test('report signature rejected, upload failed or invalid URI: nothing is sent and the right step is marked failed', async () => {
  for (const [name, error, uri, kind, title] of [
    ['wallet rejects the report signature', rejection(), reportUri, 'rejected', /Cancelled in your wallet/],
    ['upload service fails', new Error('Upload denied'), reportUri, 'upload', /Report upload failed/],
    ['upload returns a bad URI', null, 'https://example.test/report', 'upload', /Report upload failed/],
  ]) {
    const f = await fixture();
    f.state.uploadError = error;
    f.state.uri = uri;
    await assert.rejects(f.guided());
    assert.deepEqual([f.counts.simulated, f.counts.sent], [0, 0], name);
    assert.equal(f.values.size, 0, `${name}: no report cached`);
    const flow = f.flow();
    assert.deepEqual([flow.phase, flow.kind, flow.failedStep], ['failed', kind, 'report'], name);
    assert.match(f.model.releaseFlowView(flow, { booking: f.booking }).title, title, name);
  }
});

test('failed simulation is a pre-check failure: the report stays pinned, nothing is sent', async () => {
  const f = await fixture();
  f.state.simulateError = Object.assign(new Error('execution reverted: InvalidState'), { code: 'CALL_EXCEPTION' });
  await assert.rejects(f.guided(), /InvalidState/);
  assert.equal(f.counts.sent, 0);
  assert.equal(f.values.has(pendingKey), false);
  const flow = f.flow();
  assert.deepEqual([flow.phase, flow.kind], ['failed', 'precheck']);
  assert.match(f.model.releaseFlowView(flow, { booking: f.booking }).title, /Final check failed · nothing was sent/);
  assert.equal(JSON.parse(f.values.get(`live-release-report:${bookingId}`)).uri, reportUri);
});

test('approval rejected in the wallet keeps the pinned report, and the retry does not upload again', async () => {
  const f = await fixture();
  f.state.sendError = rejection();
  await assert.rejects(f.guided(), /rejected/);
  assert.equal(f.counts.sent, 0);
  const rejected = f.flow();
  assert.deepEqual([rejected.phase, rejected.kind, rejected.failedStep], ['failed', 'rejected', 'approve']);
  assert.equal(rejected.hash, null);
  f.state.sendError = null;
  f.events.length = 0;
  const result = await f.guided();
  assert.equal(result.outcome, 'approved');
  assert.equal(f.counts.uploaded, 1, 'the signed report is reused');
  assert.deepEqual(f.events.map(event => event.type), ['checking', 'preflight', 'report-pinned', 'signing', 'submitted', 'confirmed']);
});

test('reverted, cancelled, mismatching and unreadable transactions are each reported as exactly that', async () => {
  const scenarios = [
    ['reverted on-chain', f => { f.state.waitError = Object.assign(new Error('transaction execution reverted'), { code: 'CALL_EXCEPTION', receipt: { status: 0, hash: txHash } }); },
      { phase: 'failed', kind: 'reverted', hash: txHash, key: true }, /reverted/],
    ['cancelled/replaced', f => { f.state.waitError = Object.assign(new Error('replaced'), { code: 'TRANSACTION_REPLACED', cancelled: true, receipt: { status: 1, hash: replacementHash } }); },
      { phase: 'failed', kind: 'replaced', hash: replacementHash, key: false }, /cancelled\/replaced/],
    ['receipt without the exact approval', f => { f.state.receipt = { ...f.receipt, logs: [] }; },
      { phase: 'failed', kind: 'mismatch', hash: txHash, key: true }, /missing the exact full-fee escrow approval/],
    ['receipt from another contract', f => { f.state.receipt = { ...f.receipt, to: stranger }; },
      { phase: 'failed', kind: 'mismatch', hash: txHash, key: true }, /did not confirm successfully/],
    ['status 0 receipt', f => { f.state.receipt = { ...f.receipt, status: 0 }; },
      { phase: 'failed', kind: 'reverted', hash: txHash, key: true }, /did not confirm successfully/],
    ['network drops while waiting', f => { f.state.waitError = new Error('Failed to fetch'); },
      { phase: 'unknown', kind: 'unconfirmed', hash: txHash, key: true, text: /sent, but its result could not be read: Failed to fetch/ }, /Failed to fetch/],
  ];
  for (const [name, change, expected, message] of scenarios) {
    const f = await fixture();
    change(f);
    await assert.rejects(f.guided(), message, name);
    assert.equal(f.counts.sent, 1, `${name}: exactly one transaction was sent`);
    const flow = f.flow();
    assert.deepEqual({ phase: flow.phase, kind: flow.kind, hash: flow.hash }, { phase: expected.phase, kind: expected.kind, hash: expected.hash }, name);
    if (expected.text) assert.match(flow.message, expected.text, name);
    assert.equal(f.values.has(pendingKey), expected.key, `${name}: pending hash ${expected.key ? 'kept' : 'cleared'}`);
    const view = f.model.releaseFlowView(flow, { booking: f.booking });
    assert.notEqual(view.tone, 'ok', name);
    assert.ok(view.next.length > 10, `${name}: next action`);
    assert.doesNotMatch(`${view.title} ${view.text}`, /Approved on Base/, name);
  }
});

test('unavailable storage blocks escrow approval before a transaction is sent', async () => {
  const f = await fixture();
  f.state.saveFails = true;
  await assert.rejects(f.guided(), /Browser storage could not reserve.*No escrow approval was sent/);
  assert.equal(f.counts.sent, 0);
  assert.equal(f.values.has(pendingKey), false);
  assert.deepEqual([f.flow().phase, f.flow().kind], ['failed', 'precheck']);
});

test('a wallet speed-up is verified against the replacement receipt before it is called approved', async () => {
  const f = await fixture();
  f.state.waitError = Object.assign(new Error('replaced'), { code: 'TRANSACTION_REPLACED', cancelled: false, receipt: { ...f.receipt, hash: replacementHash } });
  const result = await f.guided();
  assert.equal(result.txHash, replacementHash);
  const flow = f.flow();
  assert.deepEqual([flow.phase, flow.hash], ['confirmed', replacementHash]);
  assert.equal(f.values.has(pendingKey), false);
  const wrong = await fixture();
  wrong.state.waitError = Object.assign(new Error('replaced'), { code: 'TRANSACTION_REPLACED', cancelled: false, receipt: { ...wrong.receipt, hash: replacementHash, logs: [] } });
  await assert.rejects(wrong.guided(), /missing the exact/);
  assert.notEqual(wrong.flow().phase, 'confirmed');
});

test('a wallet switch after the receipt is verified cannot turn the approval into an error', async () => {
  const f = await fixture();
  f.state.checkFailsAfterSend = true;
  const result = await f.guided();
  assert.equal(result.outcome, 'approved');
  assert.equal(f.flow().phase, 'confirmed');
  assert.equal(f.values.has(pendingKey), false);
});

test('a saved approval is reconciled read-only: pending, confirming, reverted, mismatching, unreadable and confirmed', async () => {
  const scenarios = [
    ['pending', f => { f.state.canonical = null; }, 'pending', { phase: 'pending', hash: txHash, key: true }, /Approval still pending/],
    ['one confirmation', f => { f.state.blockNumber = 100; }, 'confirming', { phase: 'confirming', hash: txHash, key: true }, /two confirmations/],
    ['reverted', f => { f.state.canonical = { ...f.receipt, status: 0 }; }, 'reverted', { phase: 'failed', hash: txHash, key: false, kind: 'reverted' }, /Previous approval reverted/],
    ['wrong receipt', f => { f.state.canonical = { ...f.receipt, logs: [] }; }, 'mismatch', { phase: 'failed', hash: txHash, key: true, kind: 'mismatch' }, /missing the exact/],
    ['unreadable', f => { f.state.receiptError = new Error('Failed to fetch'); }, 'unknown', { phase: 'unknown', hash: txHash, key: true, kind: 'unconfirmed', text: /sent, but its result could not be read/ }, /Failed to fetch/],
    ['confirmed', () => {}, 'approved', { phase: 'confirmed', hash: txHash, key: false }, null],
  ];
  for (const [name, change, outcome, expected, message] of scenarios) {
    const f = await fixture();
    f.values.set(pendingKey, txHash);
    change(f);
    const result = await f.guided();
    assert.equal(result.outcome, outcome, name);
    f.assertNothingSigned();
    assert.equal(f.counts.receiptReads, 1, name);
    if (message) assert.match(String(result.error?.message), message, name);
    const flow = f.flow();
    assert.equal(flow.phase, expected.phase, name);
    assert.equal(flow.hash, expected.hash, name);
    if (expected.kind) assert.equal(flow.kind, expected.kind, name);
    if (expected.text) assert.match(flow.message, expected.text, name);
    assert.equal(f.values.has(pendingKey), expected.key, `${name}: pending hash ${expected.key ? 'kept' : 'cleared'}`);
  }
  const f = await fixture();
  f.values.set(pendingKey, txHash);
  f.state.canonical = null;
  const flow = (await f.guided(), f.flow());
  const view = f.model.releaseFlowView(flow, { booking: f.booking, pendingHash: txHash });
  assert.equal(view.primary.label, 'Check pending escrow release');
  assert.equal(view.primary.disabled, false);
  assert.match(view.next, /BaseScan/);
});

test('a reservation blocks retries after an unsaved hash, including after a page reload', async () => {
  const f = await fixture();
  f.state.saveHashFails = true;
  await assert.rejects(f.guided(), /could not save its hash/);
  const unknown = f.flow();
  assert.deepEqual([unknown.phase, unknown.kind, unknown.hash], ['unknown', 'unsaved', txHash]);
  assert.match(f.values.get(pendingKey), /^approval-wallet-result-unknown:\d+$/);
  const view = f.model.releaseFlowView(unknown, { booking: f.booking });
  assert.equal(view.primary.label, 'Check pending escrow release', 'the in-memory hash keeps the re-check read-only');
  f.events.length = 0;
  f.state.canonical = null;
  const afterReload = await f.guided();
  assert.equal(afterReload.outcome, 'unknown');
  assert.match(afterReload.error.message, /hash is unavailable.*do not send another approval/i);
  assert.equal(f.counts.sent, 1, 'a lost in-memory hash cannot trigger a second transaction');
  const pending = await f.guided({ knownHash: txHash });
  assert.equal(pending.outcome, 'pending');
  assert.equal(f.counts.sent, 1, 'no second transaction');
  f.state.canonical = f.receipt;
  const confirmed = await f.guided({ knownHash: txHash });
  assert.equal(confirmed.outcome, 'approved');
  assert.equal(f.counts.sent, 1);
  assert.equal(f.flow().phase, 'confirmed');
});

test('a reservation without a hash never strands the release: an on-chain approval or an expired hold resolves it', async () => {
  const approved = await fixture();
  approved.state.sendError = new Error('Wallet disconnected during submission');
  await assert.rejects(approved.guided(), /previous approval may have been submitted/);
  approved.state.sendError = null;
  approved.state.onchain.status = 2n;
  approved.state.onchain.payoutAmount = 20000000n;
  const result = await approved.guided();
  assert.deepEqual([result.outcome, result.source], ['approved', 'chain-state']);
  assert.equal(approved.values.has(pendingKey), false, 'the verified approval clears the reservation');
  assert.equal(approved.counts.sent, 0);

  const expired = await fixture();
  expired.state.sendError = new Error('Wallet disconnected during submission');
  await assert.rejects(expired.guided(), /previous approval may have been submitted/);
  expired.state.sendError = null;
  assert.equal((await expired.check({ now: Date.now() + 9 * 60_000 })).outcome, 'unknown', 'still held inside the hold');
  assert.equal((await expired.check({ now: Date.now() + 11 * 60_000 })).outcome, 'ready', 'Base still shows funded after the hold');
  assert.equal(expired.values.has(pendingKey), false);

  const unreadable = await fixture();
  unreadable.state.sendError = new Error('Wallet disconnected during submission');
  await assert.rejects(unreadable.guided(), /previous approval may have been submitted/);
  unreadable.state.bookingsError = new Error('Base did not answer');
  assert.equal((await unreadable.check({ now: Date.now() + 11 * 60_000 })).outcome, 'unknown', 'an unreadable escrow never releases the hold');
  assert.equal(unreadable.values.has(pendingKey), true);
});

test('an uncertain wallet submission leaves a reservation until the transaction is reconciled', async () => {
  const f = await fixture();
  f.state.sendError = new Error('Wallet disconnected during submission');
  await assert.rejects(f.guided(), /previous approval may have been submitted/);
  assert.match(f.values.get(pendingKey), /^approval-wallet-result-unknown:\d+$/);
  assert.deepEqual([f.flow().phase, f.flow().kind], ['unknown', 'unsaved']);
  f.state.sendError = null;
  assert.equal((await f.guided()).outcome, 'unknown');
  assert.equal(f.counts.sent, 0, 'an ambiguous wallet response is never retried automatically');
});

test('a saved approval is never reported pending just because the wallet is on the wrong network or missing', async () => {
  const wrongChain = await fixture();
  wrongChain.values.set(pendingKey, txHash);
  wrongChain.session.facts.chainId = 1;
  const first = await wrongChain.guided();
  assert.equal(first.outcome, 'pending-unverified');
  assert.equal(wrongChain.counts.receiptReads, 0, 'no receipt lookup on the wrong chain');
  wrongChain.assertNothingSigned();
  assert.equal(wrongChain.flow().phase, 'blocked');
  const noWallet = await fixture({ session: { wallet: null, facts: { wallet: null, walletError: 'locked', chainId: null } } });
  noWallet.values.set(pendingKey, txHash);
  assert.equal((await noWallet.guided()).outcome, 'pending-unverified');
  noWallet.assertNothingSigned();
  assert.equal(noWallet.flow().phase, 'blocked');
  const view = noWallet.model.releaseFlowView(noWallet.flow(), { booking: noWallet.booking, pendingHash: txHash });
  assert.equal(view.primary.label, 'Check pending escrow release');
});

test('an approval already on-chain is shown as approved from the contract itself, without sending', async () => {
  const f = await fixture();
  f.state.onchain.status = 2n;
  f.state.onchain.payoutAmount = 20000000n;
  const result = await f.guided();
  assert.deepEqual([result.outcome, result.source], ['approved', 'chain-state']);
  f.assertNothingSigned();
  const flow = f.flow();
  assert.deepEqual([flow.phase, flow.source], ['confirmed', 'chain-state']);
  assert.match(f.model.releaseFlowView(flow, { booking: f.booking }).text, /read directly from the escrow contract/);
  const stale = await fixture({ booking: { status: 'funded' } });
  stale.state.onchain.status = 2n;
  stale.state.onchain.payoutAmount = 20000000n;
  stale.state.onchain.funder = stranger;
  assert.equal((await stale.check()).outcome, 'approved', 'the funder is irrelevant to knowing it was approved');
  const lowerPayout = await fixture();
  lowerPayout.state.onchain.status = 2n;
  lowerPayout.state.onchain.payoutAmount = 19999999n;
  assert.equal((await lowerPayout.check()).outcome, 'blocked', 'a partial approval is never shown as the full fee');
  const otherTerms = await fixture();
  otherTerms.state.onchain.status = 2n;
  otherTerms.state.onchain.payoutAmount = 20000000n;
  otherTerms.state.onchain.termsHash = id('different terms');
  assert.equal((await otherTerms.check()).outcome, 'blocked', 'an approval under different terms is not this booking');
});

test('chain facts include admin role and paused state only when they can actually be read', async () => {
  const f = await fixture();
  const plain = await f.readChainFacts({ booking: f.booking, escrowAddress: escrow, wallet: f.wallet, contract: f.options.contract });
  assert.equal(plain.status, 1);
  assert.equal(plain.amountUnits, '20000000');
  assert.equal(plain.payoutUnits, '0');
  assert.deepEqual(plain.mismatches, []);
  assert.equal('hasRole' in plain, false, 'no role getter available means nothing is claimed');
  f.state.roles = { hasRole: true, paused: false };
  const withRoles = await f.readChainFacts({ booking: f.booking, escrowAddress: escrow, wallet: f.wallet, contract: f.options.contract });
  assert.deepEqual([withRoles.hasRole, withRoles.paused], [true, false]);
  f.state.roles = { hasRoleError: true, paused: true };
  const partial = await f.readChainFacts({ booking: f.booking, escrowAddress: escrow, wallet: f.wallet, contract: f.options.contract });
  assert.deepEqual([partial.hasRole, partial.paused], [undefined, true]);
  f.state.bookingsError = new Error('Base did not answer');
  assert.deepEqual(await f.readChainFacts({ booking: f.booking, escrowAddress: escrow, wallet: f.wallet, contract: f.options.contract }), { error: 'Base did not answer' });
});

test('every contract term the escrow records is compared against the booking, by field name', async () => {
  const f = await fixture();
  const compare = change => f.compareOnchainBooking({ ...f.state.onchain, ...change }, f.booking, owner);
  assert.deepEqual(compare({}), []);
  assert.deepEqual(compare({ performer: stranger }), ['performer']);
  assert.deepEqual(compare({ funder: stranger }), ['funder']);
  assert.deepEqual(compare({ termsHash: id('x') }), ['termsHash']);
  assert.deepEqual(compare({ amount: 1n }), ['amount']);
  assert.deepEqual(compare({ showStart: 1n }), ['showStart']);
  assert.deepEqual(compare({ showEnd: 1n }), ['showEnd']);
  assert.deepEqual(compare({ claimDeadline: 1n }), ['claimDeadline']);
  assert.deepEqual(compare({ reviewWindow: 1n }), ['reviewWindow']);
  assert.deepEqual(compare({ cancellationWindow: 1n }), ['cancellationWindow']);
  assert.deepEqual(compare({ killFeeBps: 1n }), ['killFeeBps']);
  assert.deepEqual(compare({ performer: stranger, amount: 1n }), ['performer', 'amount']);
  assert.deepEqual(f.compareOnchainBooking({ ...f.state.onchain }, { ...f.booking, amountUnits: 'abc' }, owner), ['amount']);
});

test('producer delay, short sets and declines never change the numbers released: the original terms are the only input', async () => {
  const reference = await fixture();
  await reference.guided();
  const variants = [
    { known: true, pending: false, actualEndedAt: Date.parse(reference.booking.endUtc) - 900000, endReason: 'declined' },
    { known: true, pending: false, actualEndedAt: Date.parse(reference.booking.endUtc) - 300000, endReason: 'operator-cut' },
    { known: true, pending: false, actualEndedAt: Date.parse(reference.booking.endUtc) + 3600000, endReason: 'producer-finished' },
    { known: true, pending: false, actualEndedAt: null },
  ];
  for (const completion of variants) {
    const f = await fixture({ booking: { broadcastCompletion: completion } });
    const result = await f.guided();
    assert.equal(result.outcome, 'approved', JSON.stringify(completion));
    assert.deepEqual(f.sentArgs, reference.sentArgs, 'identical approve(bookingId, 10000, uri) call');
    assert.deepEqual(f.uploads, reference.uploads, 'identical public report');
    assert.equal(f.uploads[0].payoutBps, 10000);
    assert.equal(f.uploads[0].amountUnits, '20000000');
    assert.deepEqual(f.events[1].preflight.rows.find(row => row.id === 'amounts'), reference.events[1].preflight.rows.find(row => row.id === 'amounts'));
    assert.deepEqual(f.model.releasePreview(f.booking), reference.model.releasePreview(reference.booking));
  }
  const large = await fixture({ booking: { amountUnits: '20500000' } });
  large.state.onchain.amount = 20500000n;
  const releaseWithLargerFee = await large.guided();
  assert.equal(releaseWithLargerFee.outcome, 'approved');
  assert.equal(large.uploads[0].amountUnits, '20500000');
  assert.match(large.events[1].preflight.rows.find(row => row.id === 'amounts').detail, /\$20\.50 USDC/);
});

test('a failing display callback can never change what the release does', async () => {
  const f = await fixture({ throwOnState: true });
  const result = await f.guided();
  assert.equal(result.outcome, 'approved');
  assert.deepEqual([f.counts.uploaded, f.counts.sent], [1, 1]);
  const rejected = await fixture({ throwOnState: true });
  rejected.state.sendError = rejection();
  await assert.rejects(rejected.guided(), error => error === rejected.state.sendError, 'the original error is rethrown untouched');
});

test('the direct helper keeps its original contract: same thrown errors, and no state events without a callback', async () => {
  const f = await fixture();
  delete f.options.onState;
  const result = await f.direct();
  assert.equal(result.approved, true);
  assert.equal(f.events.length, 0);
  const wrongChain = await fixture();
  wrongChain.wallet.provider.getNetwork = async () => ({ chainId: 1n });
  await assert.rejects(wrongChain.direct(), error => error.kind === 'precheck' && /Switch to Base/.test(error.message));
  wrongChain.assertNothingSigned();
  const noEscrow = await fixture();
  await assert.rejects(noEscrow.direct({ escrowAddress: '' }), /Escrow contract is unavailable/);
});

test('a check that cannot even start reports unknown or failed, never ready', async () => {
  const f = await fixture();
  f.state.bookingsError = new Error('Failed to fetch');
  const result = await f.check();
  assert.equal(result.outcome, 'unavailable');
  assert.notEqual(f.flow().phase, 'ready');
  const thrown = await fixture({ session: { facts: { wallet: { address: owner, admin: true }, chainId: 8453 }, wallet: { ...(await fixture()).wallet, provider: { getBlock: async () => { throw new Error('boom'); } } } } });
  const outcome = await thrown.check({ contract: { bookings: async () => { throw new Error('boom'); } } });
  assert.equal(outcome.outcome, 'unavailable');
});
