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