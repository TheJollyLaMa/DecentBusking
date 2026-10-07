const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const url = pathToFileURL(path.join(__dirname, '../js/radio-payroll.mjs')).href;
const track = (wallet, plays) => ({ wallet: `0x${String(wallet).repeat(40)}`, plays, votes: plays, artist: `Artist ${wallet}` });

test('playback preview groups artists, caps its budget, and retains dust and rounding', async () => {
  const { previewPlaybackPayroll } = await import(url);
  const result = previewPlaybackPayroll({ tracks: [track(1, 1), track(1, 1), track(2, 1), track(3, 1), { plays: 999 }],
    budgetUnits: 3000000n, minimumUnits: 1000000n });
  assert.equal(result.entries.length, 3);
  assert.equal(result.totalPlays, 4n);
  assert.equal(result.allocatedUnits, 1500000n);
  assert.equal(result.remainderUnits, 1500000n);
  assert.equal(result.entries[0].amountUnits, 1500000n);
  assert.equal(result.entries[1].payable, false);
  const empty = previewPlaybackPayroll({ tracks: [], budgetUnits: 1000000n });
  assert.equal(empty.remainderUnits, 1000000n);
  const zeroAddress = previewPlaybackPayroll({ tracks: [track(0, 10)], budgetUnits: 1000000n });
  assert.equal(zeroAddress.entries.length, 0);
});

test('Top 10 preview ranks unique artists by votes and splits only its capped prize budget', async () => {
  const { previewTopTenPayroll } = await import(url);
  const result = previewTopTenPayroll({ tracks: [track(1, 5), track(1, 4), track(2, 8), track(3, 2)], budgetUnits: 1000001n });
  assert.equal(result.entries.length, 3);
  assert.equal(result.entries[0].plays, 9);
  assert.equal(result.allocatedUnits, 999999n);
  assert.equal(result.remainderUnits, 2n);
  const many = previewTopTenPayroll({ tracks: Array.from({ length: 13 }, (_value, index) => track((index + 1).toString(16), 20 - index)), budgetUnits: 10000000n });
  assert.equal(many.entries.length, 10);
  assert.equal(many.allocatedUnits, 10000000n);
  assert.throws(() => previewTopTenPayroll({ tracks: [], budgetUnits: -1n }), /nonnegative/);
  const byVotes = previewTopTenPayroll({ tracks: [{ ...track(1, 100), votes: 1 }, { ...track(2, 0), votes: 9 },
    { ...track(3, 50), votes: -2 }, { ...track(4, 40), votes: undefined }], budgetUnits: 1000000n });
  assert.equal(byVotes.entries[0].wallet, track(2, 0).wallet);
  assert.equal(byVotes.entries.length, 2);
  assert.equal(previewTopTenPayroll({ tracks: [track(1, 1), { ...track(1, 1), votes: -1 }], budgetUnits: 1n }).entries.length, 0);
});

test('finalization excludes live/all-time weeks and freezes stable identities independently of budget', async () => {
  const { finalizeRadioAllocation, radioWorkReferenceText } = await import(url);
  const args = { report: { week: '2026-W40', current: false, tracks: [track(1, 3)] }, category: 'playback',
    budgetUnits: 3000000n, minimumUnits: 1000000n, fundSlug: 'dbusk-playback', routerAddress: track(2, 1).wallet,
    assetAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', now: Date.parse('2026-10-06T00:00:00Z') };
  const receipt = finalizeRadioAllocation(args);
  assert.equal(receipt.entries[0].amountUnits, '3000000');
  assert.equal(finalizeRadioAllocation({ ...args, budgetUnits: 5000000n }).entries[0].workReferenceText, receipt.entries[0].workReferenceText);
  assert.throws(() => finalizeRadioAllocation({ ...args, report: { ...args.report, current: true } }), /completed/);
  assert.throws(() => finalizeRadioAllocation({ ...args, report: { ...args.report, week: '2026-W41', current: false } }), /not completed/);
  assert.notEqual(radioWorkReferenceText({ week: receipt.week, category: 'top10', wallet: track(1, 1).wallet }), receipt.entries[0].workReferenceText);
});

test('radio settlement skips paid references and retry does not pay confirmed entries twice', async () => {
  const { finalizeRadioAllocation, settleRadioAllocation } = await import(url);
  const owner = track(9, 1).wallet;
  const allocation = finalizeRadioAllocation({ report: { week: '2026-W40', current: false, tracks: [track(1, 1), track(2, 1)] },
    category: 'playback', budgetUnits: 2000000n, minimumUnits: 0n, fundSlug: 'dbusk-playback', routerAddress: track(3, 1).wallet,
    assetAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', now: Date.parse('2026-10-06T00:00:00Z') });
  const paid = new Set();
  let sent = 0;
  const payout = async (...args) => ({ hash: `tx-${++sent}`, wait: async () => { paid.add(args[4]); return { status: 1 }; } });
  payout.staticCall = async () => {};
  const options = { allocation, metadataUri: 'ipfs://bafy-receipt', metadataHash: `0x${'1'.repeat(64)}`, owner,
    signer: { provider: { getNetwork: async () => ({ chainId: 8453 }) }, getAddress: async () => owner }, hashReference: value => value,
    router: { target: allocation.routerAddress, paused: async () => false, PAYROLL_ROLE: async () => 'payroll', hasRole: async () => true,
      approvedAssets: async () => true, funds: async () => ({ exists: true, active: true }), contributors: async () => ({ approved: true }),
      completedWorkReferences: async key => paid.has(key), fundBalances: async () => 2000000n, payout } };
  assert.equal((await settleRadioAllocation(options)).confirmed.length, 2);
  assert.equal((await settleRadioAllocation(options)).skipped, 2);
  assert.equal(sent, 2);
  options.router.hasRole = async () => false;
  await assert.rejects(settleRadioAllocation(options), /PAYROLL_ROLE/);
});

test('receipt imports reject changed totals, funds, live weeks, and duplicate entries', async () => {
  const { finalizeRadioAllocation, validateRadioReceipt } = await import(url);
  const config = { routerAddress: track(3, 1).wallet, assetAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    funds: { playback: 'dbusk-playback', topTen: 'dbusk-top10' } };
  const allocation = finalizeRadioAllocation({ report: { week: '2026-W40', current: false, tracks: [track(1, 1)] },
    category: 'playback', budgetUnits: 1000000n, minimumUnits: 0n, fundSlug: config.funds.playback,
    ...config, now: Date.parse('2026-10-06T00:00:00Z') });
  assert.equal(validateRadioReceipt(allocation, config), allocation);
  assert.throws(() => validateRadioReceipt({ ...allocation, allocatedUnits: '2' }, config), /totals/);
  assert.throws(() => validateRadioReceipt({ ...allocation, fundSlug: 'other-fund' }, config), /does not match/);
  assert.throws(() => validateRadioReceipt({ ...allocation, entries: [allocation.entries[0], allocation.entries[0]] }, config), /duplicate/);
  const legacyTopTen = finalizeRadioAllocation({ report: { week: '2026-W40', current: false, tracks: [track(1, 1)] },
    category: 'top10', ranking: 'plays', budgetUnits: 1000000n, minimumUnits: 0n, fundSlug: config.funds.topTen,
    ...config, now: Date.parse('2026-10-06T00:00:00Z') });
  legacyTopTen.schemaVersion = 1;
  delete legacyTopTen.ranking;
  assert.equal(validateRadioReceipt(legacyTopTen, config), legacyTopTen);
  assert.equal(legacyTopTen.entries[0].workReferenceText,
    finalizeRadioAllocation({ report: { week: '2026-W40', current: false, tracks: [track(1, 1)] }, category: 'top10',
      budgetUnits: 1000000n, minimumUnits: 0n, fundSlug: config.funds.topTen, ...config, now: Date.parse('2026-10-06T00:00:00Z') }).entries[0].workReferenceText);
});

test('partial radio settlement resumes only unpaid recipients and preflight failures send nothing', async () => {
  const { finalizeRadioAllocation, settleRadioAllocation } = await import(url);
  const owner = track(9, 1).wallet;
  const allocation = finalizeRadioAllocation({ report: { week: '2026-W40', current: false, tracks: [track(1, 1), track(2, 1)] },
    category: 'top10', budgetUnits: 2000000n, minimumUnits: 0n, fundSlug: 'dbusk-top10', routerAddress: track(3, 1).wallet,
    assetAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', now: Date.parse('2026-10-06T00:00:00Z') });
  const paid = new Set();
  let attempts = 0;
  let interrupt = true;
  const payout = async (...args) => {
    attempts++;
    if (attempts === 2 && interrupt) throw new Error('Wallet cancelled second payout');
    return { hash: `tx-${attempts}`, wait: async () => { paid.add(args[4]); return { status: 1 }; } };
  };
  payout.staticCall = async () => {};
  const options = { allocation, metadataUri: 'ipfs://bafy-receipt', metadataHash: `0x${'1'.repeat(64)}`, owner,
    signer: { provider: { getNetwork: async () => ({ chainId: 8453 }) }, getAddress: async () => owner }, hashReference: value => value,
    router: { target: allocation.routerAddress, paused: async () => false, PAYROLL_ROLE: async () => 'payroll', hasRole: async () => true,
      approvedAssets: async () => true, funds: async () => ({ exists: true, active: true }), contributors: async () => ({ approved: true }),
      completedWorkReferences: async key => paid.has(key), fundBalances: async () => 2000000n, payout } };
  await assert.rejects(settleRadioAllocation({ ...options, router: { ...options.router, contributors: async () => ({ approved: false }) } }), /not approved/);
  await assert.rejects(settleRadioAllocation({ ...options, router: { ...options.router, fundBalances: async () => 0n } }), /insufficient/);
  assert.equal(attempts, 0);
  await assert.rejects(settleRadioAllocation(options), /cancelled/);
  assert.equal(paid.size, 1);
  interrupt = false;
  const resumed = await settleRadioAllocation(options);
  assert.equal(resumed.confirmed.length, 1);
  assert.equal(resumed.skipped, 1);
  assert.equal(paid.size, 2);
  assert.equal(attempts, 3);
});