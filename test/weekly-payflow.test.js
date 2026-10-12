const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const url = pathToFileURL(path.join(__dirname, '../discord-bot/weekly-payflow.js')).href;

async function fixture() {
  const { createWeeklyPayflow } = await import(url);
  const config = { routerAddress: `0x${'1'.repeat(40)}`, assets: { USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' } },
    radioFunds: { playback: 'dbusk-playback', topTen: 'dbusk-top10' } };
  const reports = [{ week: 'NY-2026-09-28', startAt: '2026-09-28T04:00:00.000Z', current: false,
    tracks: [{ wallet: `0x${'2'.repeat(40)}`, artist: 'Artist', plays: 1, votes: 2 }] },
    { week: 'NY-2026-10-05', current: true, tracks: [{ wallet: `0x${'2'.repeat(40)}`, artist: 'Artist', plays: 1, votes: 2 }] }];
  const paid = new Set();
  const snapshots = [];
  let uploads = 0;
  const router = { runner: { getNetwork: async () => ({ chainId: 8453 }) }, approvedAssets: async () => true,
    funds: async () => ({ exists: true, active: true }), fundBalances: async () => 10000000n, completedWorkReferences: async reference => paid.has(reference) };
  const options = { router, config, getReports: async () => reports, now: () => Date.parse('2026-10-08T12:00:00Z'),
    upload: async () => { uploads++; return 'ipfs://allocation'; }, save: async value => { snapshots.push(structuredClone(value)); return 'ipfs://schedule'; } };
  return { options, reports, paid, snapshots, uploads: () => uploads, scheduler: createWeeklyPayflow(options) };
}

test('weekly payflow freezes funded closed-week shares, reserves unpaid receipts, and does not pay automatically', async () => {
  const value = await fixture();
  await value.scheduler.initialize();
  const state = value.scheduler.getState();
  assert.equal(state.allocations.length, 2);
  assert.equal(state.funds.playback.reservedUnits, '10000000');
  assert.equal(state.funds.playback.budgetUnits, '0');
  assert.equal(state.timeZone, 'America/New_York');
  assert.equal(state.nextCloseAt, '2026-10-12T04:00:00.000Z');
  await value.scheduler.tick();
  assert.equal(value.uploads(), 2);
  const { createWeeklyPayflow } = await import(url);
  const restored = createWeeklyPayflow({ ...value.options, restore: async () => value.snapshots.at(-1) });
  await restored.initialize();
  assert.equal(restored.getState().allocations.length, 2);
  assert.equal(value.uploads(), 2);
});

test('ignored partial week removes its stale reservation and keeps its USDC available', async () => {
  const { createWeeklyPayflow } = await import(url);
  const value = await fixture();
  await value.scheduler.initialize();
  const saved = value.snapshots.at(-1);
  const ignoredWeek = saved.allocations[0].allocation.week;
  const config = { ...value.options.config, radioPayflow: { ignoredWeeks: [ignoredWeek] } };
  const persisted = [];
  const scheduler = createWeeklyPayflow({ ...value.options, config, restore: async () => saved,
    save: async checkpoint => { persisted.push(structuredClone(checkpoint)); return 'ipfs://filtered-schedule'; } });
  await scheduler.initialize();
  const state = scheduler.getState();
  assert.equal(state.allocations.some(record => record.allocation.week === ignoredWeek), false);
  assert.equal(state.funds.playback.reservedUnits, '0');
  assert.equal(state.funds.playback.availableUnits, '10000000');
  assert.deepEqual(state.ignoredWeeks, [ignoredWeek]);
  assert.equal(persisted.at(-1).allocations.some(record => record.allocation.week === ignoredWeek), false);
  assert.equal(value.uploads(), 2, 'ignoring the closed week must not prepare a replacement receipt');
});

test('historical close balance reads use the supplied archive router and subtract unpaid reservations', async () => {
  const { readClosingFundBalance } = await import(url);
  const calls = [];
  const router = {
    target: `0x${'1'.repeat(40)}`,
    runner: { getCode: async (_target, blockTag) => { calls.push(['getCode', blockTag]); return '0x6000'; } },
    fundBalances: async (fundId, asset, overrides) => {
      calls.push(['fundBalances', fundId, asset, overrides.blockTag]);
      return 12_000_000n;
    },
    completedWorkReferences: async (reference, overrides) => {
      calls.push(['completedWorkReferences', reference, overrides.blockTag]);
      return false;
    },
  };
  const balance = await readClosingFundBalance({ router, fundSlug: 'dbusk-playback',
    assetAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', blockTag: 123,
    allocations: [{ allocation: { entries: [{ workReferenceText: 'weekly payout', amountUnits: '2000000' }] } }] });
  assert.equal(balance, 10_000_000n);
  assert.deepEqual(calls.map(call => call[0]), ['getCode', 'fundBalances', 'completedWorkReferences']);
  assert.ok(calls.every(call => call.at(-1) === 123));
});

test('closing block search skips a provider-pruned range and finds the exact close boundary', async () => {
  const { findBlockAtOrBefore } = await import(url);
  const requested = [];
  const delays = [];
  const provider = {
    getBlockNumber: async () => 100,
    getBlock: async blockNumber => {
      requested.push(blockNumber);
      if (blockNumber < 80) throw new Error(`pruned history unavailable: requested ${blockNumber}, earliest available 80`);
      return { number: blockNumber, timestamp: blockNumber };
    },
  };
  assert.equal(await findBlockAtOrBefore(provider, 90, { requestDelayMs: 75, wait: async delay => delays.push(delay) }), 89);
  assert.ok(requested[0] < 80);
  assert.ok(requested.slice(1).every(blockNumber => blockNumber >= 80));
  assert.equal(delays.length, requested.length - 1);
  assert.ok(delays.every(delay => delay === 75));
});

test('closing block search rejects weeks older than the archive provider retention floor', async () => {
  const { findBlockAtOrBefore } = await import(url);
  const provider = {
    getBlockNumber: async () => 100,
    getBlock: async blockNumber => {
      if (blockNumber < 80) throw new Error(`pruned history unavailable: earliest available 80`);
      return { number: blockNumber, timestamp: blockNumber };
    },
  };
  await assert.rejects(findBlockAtOrBefore(provider, 70), /does not retain the payroll closing block/);
});

test('historical close balance is zero when the router was not deployed at close', async () => {
  const { readClosingFundBalance } = await import(url);
  const router = { target: `0x${'1'.repeat(40)}`, runner: { getCode: async () => '0x' },
    fundBalances: async () => { throw new Error('must not read balance'); } };
  assert.equal(await readClosingFundBalance({ router, fundSlug: 'dbusk-playback',
    assetAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', blockTag: 123 }), 0n);
});

test('new deposits cannot enlarge an old week beyond its verified closing balance', async () => {
  const { createWeeklyPayflow } = await import(url);
  const value = await fixture();
  const scheduler = createWeeklyPayflow({ ...value.options, getClosingBalance: async () => 3000000n });
  await scheduler.initialize();
  assert.equal(scheduler.getState().allocations[0].allocation.budgetUnits, '3000000');
  assert.equal(scheduler.getState().funds.playback.availableUnits, '7000000');
});

test('paid scheduled entries release reservations but receipts are not rewritten', async () => {
  const { id } = require('node:module').createRequire(path.join(__dirname, '../discord-bot/package.json'))('ethers');
  const value = await fixture();
  await value.scheduler.initialize();
  const before = value.scheduler.getState().allocations[0];
  value.paid.add(id(before.allocation.entries[0].workReferenceText));
  value.options.router.fundBalances = async () => 5000000n;
  await value.scheduler.tick();
  assert.equal(value.scheduler.getState().funds.playback.reservedUnits, '0');
  assert.equal(value.scheduler.getState().funds.playback.availableUnits, '5000000');
  assert.equal(value.scheduler.getState().allocations[0].metadataHash, before.metadataHash);
  assert.equal(value.uploads(), 2);
});

test('weekly payflow defers empty or insufficient funds and hides receipts until durable backup succeeds', async () => {
  const { createWeeklyPayflow } = await import(url);
  const value = await fixture();
  value.options.router.fundBalances = async () => 0n;
  await value.scheduler.initialize();
  assert.equal(value.scheduler.getState().allocations.length, 0);
  assert.match(value.scheduler.getState().funds.playback.warning, /No unreserved/);
  value.options.router.fundBalances = async () => 10000000n;
  let offline = true;
  const scheduler = createWeeklyPayflow({ ...value.options, save: async () => { if (offline) throw new Error('IPFS offline'); return 'ipfs://restored'; } });
  await assert.rejects(scheduler.initialize(), /IPFS offline/);
  assert.equal(scheduler.getState().allocations.length, 0);
  assert.equal(scheduler.getState().backupPending, true);
  offline = false;
  await scheduler.tick();
  assert.equal(scheduler.getState().allocations.length, 2);
});

test('an ignored week allows a clean schedule when its old checkpoint cannot be restored', async () => {
  const { createWeeklyPayflow } = await import(url);
  const value = await fixture();
  await value.scheduler.initialize();
  const saved = value.snapshots.at(-1);
  const ignoredWeek = saved.allocations[0].allocation.week;
  const config = { ...value.options.config, radioPayflow: { ignoredWeeks: [ignoredWeek], resetUnavailableCheckpoint: true } };
  const persisted = [];
  const scheduler = createWeeklyPayflow({ ...value.options, config,
    restore: async () => { throw new Error('Pinata gateway unavailable'); },
    save: async checkpoint => { persisted.push(structuredClone(checkpoint)); return 'ipfs://fresh-schedule'; },
    log: { warn() {} },
  });
  await scheduler.initialize();
  const state = scheduler.getState();
  assert.equal(state.ready, true);
  assert.equal(state.allocations.some(record => record.allocation.week === ignoredWeek), false);
  assert.equal(state.funds.playback.reservedUnits, '0');
  assert.equal(state.funds.playback.availableUnits, '10000000');
  assert.deepEqual(persisted.at(-1).allocations, []);
  assert.equal(value.uploads(), 2, 'ignoring the closed week must not prepare a replacement receipt');
});