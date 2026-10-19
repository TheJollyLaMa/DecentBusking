const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const url = pathToFileURL(path.join(__dirname, '../js/radio-payroll.mjs')).href;
const track = (wallet, plays) => ({ wallet: `0x${String(wallet).repeat(40)}`, plays, votes: plays, artist: `Artist ${wallet}` });

test('song-ranked receipts freeze separate prizes for songs by the same artist and preserve historical validation', async () => {
  const { finalizeRadioAllocation, validateRadioReceipt, radioAllocationMatchesReport } = await import(url);
  const config = { routerAddress: track(3, 1).wallet, assetAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', funds: { playback: 'dbusk-playback', topTen: 'dbusk-top10' } };
  const report = { week: 'NY-2026-10-05', current: false, tracks: [
    { ...track(1, 2), trackId: 'song-a', title: 'First', votes: 17 },
    { ...track(1, 1), trackId: 'song-b', title: 'Second', votes: 8 },
    { ...track(2, 1), trackId: 'song-c', title: 'Third', votes: 4 },
  ] };
  const allocation = finalizeRadioAllocation({ ...config, report, category: 'top10', fundSlug: 'dbusk-top10', budgetUnits: 12250000n, minimumUnits: 10000n, topTenScheduleVersion: 3, now: Date.parse('2026-10-13T12:00:00Z') });
  assert.equal(allocation.schemaVersion, 5);
  assert.deepEqual(allocation.entries.map(entry => entry.amountUnits), ['6125000', '3062500', '3062500']);
  assert.notEqual(allocation.entries[0].workReferenceText, allocation.entries[1].workReferenceText);
  assert.equal(radioAllocationMatchesReport(report, allocation), true);
  assert.equal(validateRadioReceipt(allocation, config), allocation);
  const changed = structuredClone(allocation);
  changed.entries[0].amountUnits = '6000000';
  changed.entries[1].amountUnits = '3187500';
  assert.throws(() => validateRadioReceipt(changed, config), /frozen chart/);
  assert.equal(radioAllocationMatchesReport({ ...report, tracks: [...report.tracks].map(song => ({ ...song, votes: song.trackId === 'song-b' ? 99 : song.votes })) }, allocation), false);
});

test('song settlement pays each winning song once and rejects an overlapping artist-based payout', async () => {
  const { finalizeRadioAllocation, settleRadioAllocation, radioWorkReferenceText } = await import(url);
  const { id } = require('../discord-bot/node_modules/ethers');
  const owner = track(9, 1).wallet;
  const allocation = finalizeRadioAllocation({ report: { week: 'NY-2026-10-05', current: false, tracks: [
    { ...track(1, 2), trackId: 'song-a', title: 'First' }, { ...track(1, 1), trackId: 'song-b', title: 'Second' },
  ] }, category: 'top10', budgetUnits: 12250000n, minimumUnits: 10000n, topTenScheduleVersion: 3,
  fundSlug: 'dbusk-top10', routerAddress: track(3, 1).wallet, assetAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', now: Date.parse('2026-10-13T12:00:00Z') });
  const paid = new Set();
  const sent = [];
  const payout = async (...args) => {
    sent.push(args);
    return { hash: `tx-${sent.length}`, wait: async () => { paid.add(args[4]); return { status: 1 }; } };
  };
  payout.staticCall = async () => {};
  const options = { allocation, metadataUri: 'ipfs://song-receipt', metadataHash: `0x${'1'.repeat(64)}`, owner, hashReference: id,
    signer: { provider: { getNetwork: async () => ({ chainId: 8453 }) }, getAddress: async () => owner },
    router: { target: allocation.routerAddress, paused: async () => false, PAYROLL_ROLE: async () => 'payroll', hasRole: async () => true,
      approvedAssets: async () => true, funds: async () => ({ exists: true, active: true }), contributors: async () => ({ approved: true }),
      completedWorkReferences: async reference => paid.has(reference), fundBalances: async () => 12250000n, payout } };
  assert.equal((await settleRadioAllocation(options)).confirmed.length, 2);
  assert.equal(sent.reduce((sum, args) => sum + args[3], 0n), 12250000n);
  assert.notEqual(sent[0][4], sent[1][4]);
  assert.equal((await settleRadioAllocation(options)).skipped, 2);
  assert.equal(sent.length, 2);
  paid.clear();
  paid.add(id(radioWorkReferenceText({ week: allocation.week, category: 'top10', wallet: track(1, 1).wallet })));
  await assert.rejects(settleRadioAllocation(options), /artist-based prize was already paid/);
  assert.equal(sent.length, 2);
});

test('playback preview groups artists, caps its budget, and retains dust and rounding', async () => {
  const { previewPlaybackPayroll } = await import(url);
  const result = previewPlaybackPayroll({ tracks: [track(1, 1), track(1, 1), track(2, 1), track(3, 1), { plays: 4 }],
    budgetUnits: 8000000n, minimumUnits: 1000000n });
  assert.equal(result.entries.length, 4);
  assert.equal(result.totalPlays, 8n);
  assert.equal(result.forfeitedUnits, 4000000n);
  assert.equal(result.allocatedUnits, 4000000n);
  assert.equal(result.remainderUnits, 4000000n);
  assert.equal(result.entries[0].amountUnits, 2000000n);
  assert.equal(result.entries[3].wallet, '');
  assert.equal(result.entries[3].payable, false);
  assert.equal(result.entries[3].amountUnits, 4000000n);
  const empty = previewPlaybackPayroll({ tracks: [], budgetUnits: 1000000n });
  assert.equal(empty.remainderUnits, 1000000n);
  const zeroAddress = previewPlaybackPayroll({ tracks: [track(0, 10)], budgetUnits: 1000000n });
  assert.equal(zeroAddress.entries.length, 1);
  assert.equal(zeroAddress.entries[0].payable, false);
  assert.equal(zeroAddress.forfeitedUnits, 1000000n);
});

test('walletless Top 10 winners forfeit their original prize without increasing other prizes', async () => {
  const { previewTopTenSongPayroll } = await import('../js/top-ten-prizes.mjs');
  const result = previewTopTenSongPayroll({ tracks: [
    { ...track(1, 3), trackId: 'first', votes: 9 },
    { trackId: 'unlinked', title: 'Unlinked', plays: 2, votes: 8 },
    { ...track(2, 1), trackId: 'third', votes: 7 },
  ], budgetUnits: 8000000n });
  assert.deepEqual(result.entries.map(entry => [entry.trackId, entry.amountUnits, entry.payable]), [
    ['first', 4000000n, true], ['unlinked', 2000000n, false], ['third', 2000000n, true],
  ]);
  assert.equal(result.allocatedUnits, 6000000n);
  assert.equal(result.forfeitedUnits, 2000000n);
  assert.equal(result.remainderUnits, 2000000n);
});

test('frozen song receipts with forfeited ranks validate and settle only against the full closed-week chart', async () => {
  const { finalizeRadioAllocation, validateRadioReceipt, settleRadioAllocation } = await import(url);
  const { id } = require('../discord-bot/node_modules/ethers');
  const config = { routerAddress: track(3, 1).wallet, assetAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    funds: { playback: 'dbusk-playback', topTen: 'dbusk-top10' } };
  const report = { week: 'NY-2026-10-12', current: false, tracks: [
    { ...track(1, 3), trackId: 'first', title: 'First', votes: 9 },
    { trackId: 'unlinked', title: 'Unlinked', plays: 2, votes: 8 },
    { ...track(2, 1), trackId: 'third', title: 'Third', votes: 7 },
  ] };
  const allocation = finalizeRadioAllocation({ ...config, report, category: 'top10', fundSlug: 'dbusk-top10',
    budgetUnits: 8000000n, minimumUnits: 10000n, topTenScheduleVersion: 3, now: Date.parse('2026-10-19T05:00:00Z') });
  const original = JSON.stringify(allocation);
  assert.deepEqual(allocation.entries.map(entry => [entry.rank, entry.amountUnits]), [[1, '4000000'], [3, '2000000']]);
  assert.throws(() => validateRadioReceipt(allocation, config), /full closed-week report/);
  assert.equal(validateRadioReceipt(allocation, { ...config, report }), allocation);
  const changed = structuredClone(allocation);
  changed.entries[0].amountUnits = '5000000';
  changed.allocatedUnits = '7000000';
  changed.remainderUnits = '1000000';
  assert.throws(() => validateRadioReceipt(changed, { ...config, report }), /frozen chart/);
  assert.throws(() => validateRadioReceipt(allocation, { ...config, report: { ...report, current: true } }), /frozen chart/);
  const paid = new Set();
  const sent = [];
  const payout = async (...args) => {
    sent.push(args);
    return { hash: `tx-${sent.length}`, wait: async () => { paid.add(args[4]); return { status: 1 }; } };
  };
  payout.staticCall = async () => {};
  const options = { allocation, report, metadataUri: 'ipfs://frozen', metadataHash: id(original), owner: config.routerAddress,
    hashReference: id, signer: { provider: { getNetwork: async () => ({ chainId: 8453 }) }, getAddress: async () => config.routerAddress },
    router: { target: config.routerAddress, paused: async () => false, PAYROLL_ROLE: async () => 'payroll',
      hasRole: async () => true, approvedAssets: async () => true, funds: async () => ({ exists: true, active: true }),
      contributors: async () => ({ approved: true }), completedWorkReferences: async reference => paid.has(reference),
      fundBalances: async () => 8000000n, payout } };
  await assert.rejects(settleRadioAllocation({ ...options, report: undefined }), /full closed-week report/);
  assert.equal((await settleRadioAllocation(options)).confirmed.length, 2);
  assert.equal(sent.reduce((sum, args) => sum + args[3], 0n), 6000000n);
  assert.equal((await settleRadioAllocation(options)).skipped, 2);
  assert.equal(JSON.stringify(allocation), original);
});

test('Top 10 preview ranks unique artists by votes and splits only its capped prize budget', async () => {
  const { previewTopTenPayroll } = await import(url);
  const result = previewTopTenPayroll({ tracks: [track(1, 5), track(1, 4), track(2, 8), track(3, 2)], budgetUnits: 1000001n });
  assert.equal(result.entries.length, 3);
  assert.equal(result.entries[0].plays, 9);
  assert.equal(result.entries[0].amountUnits, 500000n);
  assert.equal(result.entries[1].amountUnits, 250000n);
  assert.equal(result.entries[2].amountUnits, 250001n);
  assert.equal(result.allocatedUnits, 1000001n);
  assert.equal(result.remainderUnits, 0n);
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

test('Top 10 preview rolls sub-threshold prizes into the last payable winner', async () => {
  const { previewTopTenPayroll } = await import(url);
  const result = previewTopTenPayroll({ tracks: [track(1, 5), track(2, 4), track(3, 3), track(4, 2)], budgetUnits: 1000000n, minimumUnits: 300000n });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].amountUnits, 1000000n);
  assert.equal(result.remainderUnits, 0n);
});

test('finalization excludes live/all-time weeks and freezes stable identities independently of budget', async () => {
  const { finalizeRadioAllocation, radioWorkReferenceText } = await import(url);
  const args = { report: { week: '2026-W40', current: false, tracks: [track(1, 3)] }, category: 'playback',
    budgetUnits: 3000000n, minimumUnits: 1000000n, fundSlug: 'dbusk-playback', routerAddress: track(2, 1).wallet,
    assetAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', now: Date.parse('2026-10-06T00:00:00Z') };
  const receipt = finalizeRadioAllocation(args);
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.entries[0].amountUnits, '3000000');
  assert.equal(finalizeRadioAllocation({ ...args, budgetUnits: 5000000n }).entries[0].workReferenceText, receipt.entries[0].workReferenceText);
  assert.throws(() => finalizeRadioAllocation({ ...args, report: { ...args.report, current: true } }), /completed/);
  assert.throws(() => finalizeRadioAllocation({ ...args, report: { ...args.report, week: '2026-W41', current: false } }), /not completed/);
  assert.notEqual(radioWorkReferenceText({ week: receipt.week, category: 'top10', wallet: track(1, 1).wallet }), receipt.entries[0].workReferenceText);
});

test('frozen receipts must match the recovered weekly report before settlement', async () => {
  const { finalizeRadioAllocation, radioAllocationMatchesReport } = await import(url);
  const report = { week: 'NY-2026-10-05', current: false,
    tracks: [{ wallet: track(1, 125).wallet, artist: 'Artist 1', plays: 125, votes: 0 }] };
  const allocation = finalizeRadioAllocation({ report, category: 'playback', budgetUnits: 10000000n, minimumUnits: 10000n,
    fundSlug: 'dbusk-playback', routerAddress: track(2, 1).wallet,
    assetAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', now: Date.parse('2026-10-13T12:00:00Z') });
  assert.equal(radioAllocationMatchesReport(report, allocation), true);
  assert.equal(radioAllocationMatchesReport(report, { ...allocation, entries: [{ ...allocation.entries[0], plays: 126 }] }), false);
  assert.equal(radioAllocationMatchesReport(report, { ...allocation, entries: [{ ...allocation.entries[0], amountUnits: '9999999' }] }), false);
});

test('historical equal-split Top 10 receipts still validate after the halving schedule change', async () => {
  const { finalizeRadioAllocation, radioAllocationMatchesReport } = await import(url);
  const report = { week: 'NY-2026-10-05', current: false, tracks: [track(1, 5), track(2, 4), track(3, 3)] };
  const legacy = finalizeRadioAllocation({ report, category: 'top10', budgetUnits: 1200000n, minimumUnits: 0n,
    topTenScheduleVersion: 1, fundSlug: 'dbusk-top10', routerAddress: track(4, 1).wallet,
    assetAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', now: Date.parse('2026-10-13T12:00:00Z') });
  legacy.schemaVersion = 3;
  legacy.ranking = 'votes';
  assert.equal(radioAllocationMatchesReport(report, legacy), true);
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
  legacyTopTen.ranking = 'plays';
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