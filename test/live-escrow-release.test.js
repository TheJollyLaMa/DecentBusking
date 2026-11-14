const test = require('node:test');
const assert = require('node:assert/strict');
const { Interface, id } = require('../discord-bot/node_modules/ethers');
const owner = '0x' + '11'.repeat(20), artist = '0x' + '22'.repeat(20), escrow = '0x' + '33'.repeat(20);
const txHash = '0x' + '44'.repeat(32);
const reportUri = 'ipfs://bafkreitestpublicreport';

async function fixture(t) {
  const { releaseGuaranteedEscrow, fullFeeReport, guaranteedReleaseState } = await import('../js/live-escrow-release.mjs');
  const { LIVE_ESCROW_ABI } = await import('../js/live-bookings.mjs');
  const now = Date.now();
  const booking = { id: 'release:fixture', mode: 'phase1', payoutPolicy: 'pilot-guaranteed-v1', status: 'funded',
    wallet: artist, title: 'Release fixture', amountUnits: '20000000', termsHash: id('accepted terms'),
    termsUri: 'ipfs://bafkreiterms', startUtc: new Date(now - 3600000).toISOString(),
    endUtc: new Date(Math.floor((now - 600000) / 1000) * 1000).toISOString(),
    claimDeadline: new Date(Math.floor((now + 86400000 * 4) / 1000) * 1000).toISOString(),
    reviewWindow: 86400, cancellationWindow: 28800, killFeeBps: 10000 };
  booking.startUtc = new Date(Math.floor(Date.parse(booking.startUtc) / 1000) * 1000).toISOString();
  const iface = new Interface(LIVE_ESCROW_ABI), values = new Map(), progress = [];
  const counts = { sent: 0, uploaded: 0, simulated: 0, checks: 0 };
  const onchain = { performer: artist, funder: owner, amount: 20000000n, termsHash: booking.termsHash,
    showStart: BigInt(Date.parse(booking.startUtc) / 1000), showEnd: BigInt(Date.parse(booking.endUtc) / 1000),
    claimDeadline: BigInt(Date.parse(booking.claimDeadline) / 1000), reviewWindow: 86400n,
    cancellationWindow: 28800n, killFeeBps: 10000n, status: 1n };
  const log = iface.encodeEventLog('PerformanceApproved', [id(booking.id), 10000, 20000000, 0, reportUri, booking.termsHash]);
  const receipt = { status: 1, to: escrow, hash: txHash, blockNumber: 100, logs: [{ ...log, address: escrow }] };
  let canonicalReceipt = receipt;
  const approve = async (...args) => {
    counts.sent++; assert.deepEqual(args, [id(booking.id), 10000, reportUri]);
    return { hash: txHash, wait: async confirmations => { assert.equal(confirmations, 2); return receipt; } };
  };
  approve.staticCall = async () => { counts.simulated++; };
  const provider = { getNetwork: async () => ({ chainId: 8453n }), getBlock: async () => ({ timestamp: Math.floor(now / 1000) }),
    getBlockNumber: async () => 101, getTransactionReceipt: async () => canonicalReceipt };
  const contract = { interface: iface, bookings: async () => onchain, getFunction: () => approve };
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const options = { booking, escrowAddress: escrow, storage, contract,
    wallet: { ethers: { id }, signer: {}, address: owner, provider, check: async () => { counts.checks++; } },
    uploadReport: async file => {
      counts.uploaded++;
      const report = JSON.parse(await file.text());
      assert.equal(report.payoutBps, 10000);
      assert.equal(report.verifiedSeconds, undefined);
      assert.equal(report.performerWallet, artist);
      return reportUri;
    }, onProgress: message => progress.push(message) };
  return { release: () => releaseGuaranteedEscrow(options), options, booking, onchain, counts, receipt, approve,
    provider, values, progress, fullFeeReport, guaranteedReleaseState, canonical: value => { canonicalReceipt = value; } };
}

test('one action pins truthful report, simulates and confirms exact full escrow approval without off-chain decision', async t => {
  const f = await fixture(t);
  const result = await f.release();
  assert.equal(result.approved, true);
  assert.equal(result.reportUri, reportUri);
  assert.equal(f.counts.sent, 1);
  assert.equal(f.counts.uploaded, 1);
  assert.equal(f.counts.simulated, 1);
  assert.equal(f.values.has(`live-pending:${f.booking.id}:approve`), false);
  assert.match(f.progress.at(-1), /Performer can now claim/);
  assert.equal(f.booking.decision, undefined);
});

test('pending approval retries reconcile only; confirmed retry does not upload or send again', async t => {
  const f = await fixture(t);
  f.values.set(`live-pending:${f.booking.id}:approve`, txHash);
  f.canonical(null);
  await assert.rejects(f.release(), /still pending/);
  assert.equal(f.counts.sent, 0);
  f.canonical(f.receipt);
  await f.release();
  assert.equal(f.counts.sent, 0);
  assert.equal(f.counts.uploaded, 0);
});

test('reverted pending approval is explicit and never automatically resubmits', async t => {
  const f = await fixture(t);
  f.values.set(`live-pending:${f.booking.id}:approve`, txHash);
  f.canonical({ ...f.receipt, status: 0 });
  await assert.rejects(f.release(), /reverted/);
  assert.equal(f.counts.sent, 0);
});

test('wrong chain, performer, terms and amount fail before report upload or approval', async t => {
  for (const change of [{ performer: owner }, { funder: artist }, { termsHash: id('wrong') }, { amount: 1n },
    { showEnd: 1n }, { killFeeBps: 5000n }]) {
    const f = await fixture(t);
    Object.assign(f.onchain, change);
    await assert.rejects(f.release(), /does not match/);
    assert.equal(f.counts.uploaded, 0); assert.equal(f.counts.sent, 0);
  }
  const f = await fixture(t);
  f.provider.getNetwork = async () => ({ chainId: 1n });
  await assert.rejects(f.release(), /Switch to Base/);
});

test('rejected approval retains pinned report for retry without duplicate upload', async t => {
  const f = await fixture(t);
  const rejected = async () => { throw Error('Wallet request rejected'); };
  rejected.staticCall = f.approve.staticCall;
  f.options.contract.getFunction = () => rejected;
  await assert.rejects(f.release(), /rejected/);
  assert.equal(f.counts.uploaded, 1);
  f.options.contract.getFunction = () => f.approve;
  await f.release();
  assert.equal(f.counts.uploaded, 1);
  assert.equal(f.counts.sent, 1);
});

test('failed upload, failed simulation and wrong receipt cannot claim release success', async t => {
  const uploadFailure = await fixture(t);
  uploadFailure.options.uploadReport = async () => { throw Error('Upload denied'); };
  await assert.rejects(uploadFailure.release(), /Upload denied/);
  assert.equal(uploadFailure.counts.sent, 0);
  const simulation = await fixture(t);
  simulation.approve.staticCall = async () => { throw Error('Already approved on-chain'); };
  await assert.rejects(simulation.release(), /Already approved/);
  assert.equal(simulation.counts.sent, 0);
  const wrong = await fixture(t);
  wrong.receipt.logs = [];
  await assert.rejects(wrong.release(), /missing the exact/);
  assert.equal(wrong.values.get(`live-pending:${wrong.booking.id}:approve`), txHash);
});

test('review timing and final booking states gate release without weakening legacy policy', async t => {
  const f = await fixture(t), now = Date.now();
  assert.equal(f.guaranteedReleaseState({ ...f.booking, mode: 'phase0' }), null);
  assert.equal(f.guaranteedReleaseState({ ...f.booking, payoutPolicy: undefined }), null);
  for (const status of ['paid', 'approved', 'draft', 'refunded']) {
    assert.equal(f.guaranteedReleaseState({ ...f.booking, status }).disabled, true);
  }
  f.provider.getBlock = async () => ({ timestamp: Number(f.onchain.showEnd) - 1 });
  await assert.rejects(f.release(), /Outside the on-chain/);
  assert.equal(f.counts.sent, 0);
  assert.equal(f.guaranteedReleaseState(f.booking, now + 86400000).disabled, true);
});

test('already-approved chain state blocks duplicate even if the public booking is stale', async t => {
  const f = await fixture(t);
  f.onchain.status = 2n;
  await assert.rejects(f.release(), /no longer in funded status/);
  assert.equal(f.counts.sent, 0); assert.equal(f.counts.uploaded, 0);
});

test('wallet speed-up is verified and cancellation is not a successful release', async t => {
  const f = await fixture(t);
  const spedUp = async () => ({ hash: txHash, wait: async () => {
    throw Object.assign(Error('replaced'), { code: 'TRANSACTION_REPLACED', cancelled: false, receipt: f.receipt });
  } });
  spedUp.staticCall = f.approve.staticCall;
  f.options.contract.getFunction = () => spedUp;
  assert.equal((await f.release()).approved, true);
  const cancelled = await fixture(t);
  const cancel = async () => ({ hash: txHash, wait: async () => {
    throw Object.assign(Error('cancelled'), { code: 'TRANSACTION_REPLACED', cancelled: true, receipt: cancelled.receipt });
  } });
  cancel.staticCall = cancelled.approve.staticCall;
  cancelled.options.contract.getFunction = () => cancel;
  await assert.rejects(cancelled.release(), /cancelled\/replaced/);
  assert.equal(cancelled.values.has(`live-pending:${cancelled.booking.id}:approve`), false);
});
