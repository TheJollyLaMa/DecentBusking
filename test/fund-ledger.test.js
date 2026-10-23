const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Interface, id } = require('../discord-bot/node_modules/ethers');

const url = pathToFileURL(path.join(__dirname, '../discord-bot/fund-ledger.js')).href;
const iface = new Interface(['event FundFunded(bytes32 indexed fundId, address indexed asset, address indexed funder, uint256 amount)']);
const routerAddress = '0x8ecca903e2a6Daa8CCbB933700e4F2C58C44A4B5';
const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const devertContract = '0x135Cbc573F87637158eb3186C87c584fb0B34CD9';
const djukeContract = '0x5d07489163feBCdB39C9F579CCC36dff5A067FF9';
const campaignIface = new Interface([
  'event CampaignCreated(uint256 indexed campaignId, address indexed advertiser, uint64 indexed weekId, string title, string audioURI, uint128 offerUnits, uint64 startedAt, uint64 expiresAt)',
]);
const funds = {
  playback: 'dbusk-playback',
  top10: 'dbusk-top10',
  repo: 'dbusk-repo-dev',
  pinners: 'dbusk-pinners',
};

function makeLog(fundSlug, funder, amount, txHash, blockNumber, index) {
  const event = iface.getEvent('FundFunded');
  const encoded = iface.encodeEventLog(event, [id(fundSlug), usdc, funder, amount]);
  return { address: routerAddress, topics: encoded.topics, data: encoded.data, transactionHash: txHash, blockNumber, index, logIndex: index };
}

function makeCampaignLog(campaignId, advertiser, index, address = devertContract) {
  const encoded = campaignIface.encodeEventLog('CampaignCreated', [campaignId, advertiser, 2963, 'Advert <title>', 'ipfs://advert', 10000000n, 1792193971, 1792798771]);
  return { address, topics: encoded.topics, data: encoded.data, index };
}

test('paid advert settlements identify request, payer and campaign rather than generic sponsor deposits', async () => {
  const { createFundLedger } = await import(url);
  const { devertQueueAbi } = await import('../js/devert-queue.mjs');
  const queue = `0x${'3'.repeat(40)}`;
  const payer = `0x${'1'.repeat(40)}`;
  const advertiser = `0x${'2'.repeat(40)}`;
  const txHash = `0x${'a'.repeat(64)}`;
  const paidInterface = new Interface(devertQueueAbi(1));
  const logs = [makeLog(funds.top10, queue, 450000n, txHash, 10, 1)];
  const provider = makeProvider({ head: 10, logs, txFrom: new Map() });
  provider.getTransactionReceipt = async () => {
    const encoded = paidInterface.encodeEventLog('AdFulfilled', [8n, id('radio-play')]);
    return { status: 1, logs: [{ address: queue, index: 5, ...encoded }] };
  };
  provider.call = async transaction => {
    assert.equal(transaction.to.toLowerCase(), queue);
    assert.equal(paidInterface.decodeFunctionData('getRequest', transaction.data)[0], 8n);
    return paidInterface.encodeFunctionResult('getRequest', [[9n, payer, 1000000n, 1, 'Paid advert', 'ipfs://ad', advertiser]]);
  };
  const ledger = createFundLedger({ provider, router: makeRouter(logs, new Map()), startBlock: 10,
    config: { routerAddress, devertQueueContractAddress: queue, radioFunds: { topTen: funds.top10 },
      assets: { USDC: { address: usdc } } } });
  await ledger.initialize();
  const source = (await ledger.getCurrentState()).funds[funds.top10].sources[0];
  assert.equal(source.kind, 'advert');
  assert.equal(source.paidAdvert, true);
  assert.equal(source.payer, payer);
  assert.equal(source.advertiser, advertiser);
  assert.equal(source.requestId, '8');
  assert.equal(source.campaignId, '9');
});

test('advert purchasers are recovered from purchase receipts and backfilled without rescanning history', async () => {
  const { createFundLedger } = await import(url);
  const buyer = `0x${'1'.repeat(40)}`;
  const otherBuyer = `0x${'2'.repeat(40)}`;
  const txHash = `0x${'a'.repeat(64)}`;
  const logs = [
    makeLog(funds.playback, devertContract, 4500000n, txHash, 10, 2),
    makeLog(funds.top10, devertContract, 4500000n, txHash, 10, 4),
    makeLog(funds.top10, devertContract, 4500000n, txHash, 10, 10),
  ];
  let receiptsRead = 0;
  const provider = makeProvider({ head: 10, logs, txFrom: new Map([[txHash, `0x${'9'.repeat(40)}`]]) });
  provider.getTransactionReceipt = async () => {
    receiptsRead++;
    return { status: 1, logs: [
      makeCampaignLog(999, otherBuyer, 5, djukeContract),
      makeCampaignLog(2, buyer, 8),
      makeCampaignLog(3, otherBuyer, 12),
    ] };
  };
  const router = makeRouter(logs, new Map());
  const config = { routerAddress, radioFunds: { playback: funds.playback, topTen: funds.top10 }, assets: { USDC: { address: usdc } } };
  let saved;
  const ledger = createFundLedger({
    provider, router, config, startBlock: 10,
    readDevertState: async () => ({ campaigns: [] }),
    save: async snapshot => { saved = snapshot; return 'ipfs://saved'; },
  });
  await ledger.initialize();
  const current = await ledger.getCurrentState();
  assert.equal(current.funds[funds.playback].sources[0].advertiser, buyer);
  const deposits = current.funds[funds.top10].sources;
  assert.equal(deposits.find(source => source.logIndex === 4).campaignId, '2');
  assert.equal(deposits.find(source => source.logIndex === 10).advertiser, otherBuyer);
  assert.equal(deposits[0].title, 'Advert <title>');
  assert.equal(receiptsRead, 1, 'one receipt per transaction, even with several fund deposits');

  const restoredRouter = makeRouter([], new Map());
  const restored = createFundLedger({
    provider, router: restoredRouter, config,
    restore: async () => ({ ...saved, sources: saved.sources.map(({ advertiser, campaignId, title, ...source }) => source) }),
    save: async snapshot => { saved = snapshot; return 'ipfs://backfilled'; },
  });
  await restored.initialize();
  assert.deepEqual(restoredRouter.queryRanges, [], 'metadata backfill does not rescan indexed blocks');
  assert.equal((await restored.getCurrentState()).funds[funds.playback].sources[0].advertiser, buyer);
  assert.equal(saved.sources[0].advertiser, otherBuyer);
});

test('unavailable DeVert receipts fail explicitly and can be retried', async () => {
  const { createFundLedger } = await import(url);
  const txHash = `0x${'b'.repeat(64)}`;
  const logs = [makeLog(funds.top10, devertContract, 4500000n, txHash, 10, 1)];
  const provider = makeProvider({ head: 10, logs, txFrom: new Map() });
  let receipt = null;
  provider.getTransactionReceipt = async () => receipt;
  const ledger = createFundLedger({
    provider, router: makeRouter(logs, new Map()), startBlock: 10,
    config: { routerAddress, radioFunds: { topTen: funds.top10 }, assets: { USDC: { address: usdc } } },
  });
  await assert.rejects(ledger.initialize(), /DeVert purchase receipt unavailable/);
  assert.match(ledger.getState().lastError, /receipt unavailable/);
  receipt = { status: 1, logs: [makeCampaignLog(2, `0x${'1'.repeat(40)}`, 3)] };
  await ledger.refresh();
  assert.equal((await ledger.getCurrentState()).funds[funds.top10].sources[0].campaignId, '2');
});

function makeProvider({ head, logs, txFrom }) {
  const blocks = new Map();
  for (const log of logs) blocks.set(log.blockNumber, { timestamp: log.blockNumber * 1000 });
  return {
    getBlockNumber: async () => head,
    getBlock: async blockNumber => blocks.get(blockNumber) || { timestamp: blockNumber * 1000 },
    getTransaction: async hash => ({ hash, from: txFrom.get(hash) }),
  };
}

for (const version of [1, 2, 'legacy']) {
test(`paid advert ${version} settlements identify request, payer and campaign rather than generic sponsor deposits`, async () => {
  const { createFundLedger } = await import(url);
  const { devertQueueAbi } = await import('../js/devert-queue.mjs');
  const queue = version === 'legacy' ? '0x9ebf98367319e6c8b15b5517d808ccfeb3ddda61' : `0x${'3'.repeat(40)}`;
  const payer = `0x${'1'.repeat(40)}`;
  const advertiser = `0x${'2'.repeat(40)}`;
  const txHash = `0x${'a'.repeat(64)}`;
  const paidInterface = new Interface(devertQueueAbi(version === 'legacy' ? 1 : version));
  const logs = [makeLog(funds.top10, queue, 450000n, txHash, 10, 1)];
  const provider = makeProvider({ head: 10, logs, txFrom: new Map() });
  provider.getTransactionReceipt = async () => {
    const encoded = paidInterface.encodeEventLog('AdFulfilled', [8n, id('radio-play')]);
    return { status: 1, logs: [{ address: queue, index: 5, ...encoded }] };
  };
  provider.call = async transaction => {
    assert.equal(transaction.to.toLowerCase(), queue);
    assert.equal(paidInterface.decodeFunctionData('getRequest', transaction.data)[0], 8n);
    const request = [9n, payer, 1000000n, 1, 'Paid advert', 'ipfs://ad', advertiser];
    if (version === 2) request.push(1);
    return paidInterface.encodeFunctionResult('getRequest', [request]);
  };
  const ledger = createFundLedger({ provider, router: makeRouter(logs, new Map()), startBlock: 10,
    config: { routerAddress, devertQueueContractAddress: version === 'legacy' ? `0x${'4'.repeat(40)}` : queue,
      devertQueueVersion: version === 'legacy' ? 2 : version, radioFunds: { topTen: funds.top10 },
      assets: { USDC: { address: usdc } } } });
  await ledger.initialize();
  const source = (await ledger.getCurrentState()).funds[funds.top10].sources[0];
  assert.equal(source.kind, 'advert');
  assert.equal(source.paidAdvert, true);
  assert.equal(source.payer, payer);
  assert.equal(source.advertiser, advertiser);
  assert.equal(source.requestId, '8');
  assert.equal(source.campaignId, '9');
  if (version === 2) assert.equal(source.priorityTier, 1);
});
}

function makeRouter(logs, balances) {
  const queryRanges = [];
  return {
    target: routerAddress,
    filters: { FundFunded: () => ({}) },
    queryRanges,
    queryFilter: async (_filter, fromBlock, toBlock) => {
      queryRanges.push([fromBlock, toBlock]);
      return logs.filter(log => log.blockNumber >= fromBlock && log.blockNumber <= toBlock);
    },
    fundBalances: async (fundId) => balances.get(fundId.toLowerCase()) || 0n,
  };
}

test('public balances distinguish RPC failure, real zero and recovery without losing history readiness', async () => {
  const { createFundLedger } = await import(url);
  const router = makeRouter([], new Map());
  let failed = true;
  router.fundBalances = async fundId => {
    if (fundId === id(funds.top10) && failed) throw new Error('RPC unavailable');
    return fundId === id(funds.top10) ? 9007199254740993123456n : 0n;
  };
  const checkedAt = '2026-10-23T12:00:00.000Z';
  const ledger = createFundLedger({
    provider: makeProvider({ head: 10, logs: [], txFrom: new Map() }), router, startBlock: 10,
    config: { chainId: 8453, routerAddress, radioFunds: { topTen: funds.top10 }, assets: { USDC: { address: usdc } } },
    now: () => Date.parse(checkedAt),
    getWeeklyPayflow: () => ({ ready: true, funds: { top10: { reservedUnits: '7', availableUnits: '123' } } }),
  });
  const unread = ledger.getState();
  assert.equal(unread.funds[funds.top10].balanceUnits, null);
  assert.equal(unread.funds[funds.top10].advertUnits, null);
  assert.equal(unread.funds[funds.top10].balanceCheckedAt, null);
  const before = await ledger.getCurrentState();
  assert.equal(before.ready, false);
  assert.equal(before.funds[funds.top10].sourcesAvailable, false);
  assert.equal(before.funds[funds.top10].sponsorUnits, null);
  await ledger.initialize();
  const state = await ledger.getCurrentState();
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.evidenceVersion, 1);
  assert.deepEqual(state.network, { chainId: 8453, name: 'Base' });
  assert.deepEqual(state.asset, { address: usdc, symbol: 'USDC', decimals: 6 });
  assert.equal(state.source, 'worker-rpc');
  assert.equal(state.ready, true, 'history readiness is separate from balance availability');
  const top = state.funds[funds.top10];
  assert.equal(top.balanceUnits, null);
  assert.equal(top.availableUnits, null, 'weekly data must not mask a failed live balance read');
  assert.equal(top.balanceAvailable, false);
  assert.equal(top.balanceError, 'RPC unavailable');
  assert.equal(top.balanceCheckedAt, checkedAt);
  assert.equal(top.sourcesAvailable, true);
  assert.equal(top.payoutsAvailable, false, 'legacy queryFilter does not index payouts');
  assert.equal(top.historyCheckedAt, checkedAt);
  assert.equal(state.funds['dbusk-live-performers'].balanceUnits, '0');
  assert.equal(state.funds['dbusk-live-performers'].balanceAvailable, true);
  failed = false;
  const recovered = (await ledger.getCurrentState()).funds[funds.top10];
  assert.equal(recovered.balanceUnits, '9007199254740993123456');
  assert.equal(recovered.balanceAvailable, true);
  assert.equal(recovered.balanceError, '');
});

test('weekly failure does not substitute total balance for an unknown spendable balance', async () => {
  const { createFundLedger } = await import(url);
  const ledger = createFundLedger({
    provider: makeProvider({ head: 10, logs: [], txFrom: new Map() }),
    router: makeRouter([], new Map([[id(funds.top10), 123n]])), startBlock: 10,
    config: { routerAddress, radioFunds: { topTen: funds.top10 }, assets: { USDC: { address: usdc } } },
    getWeeklyPayflow: () => { throw new Error('Weekly RPC failure'); },
  });
  await ledger.initialize();
  const fund = (await ledger.getCurrentState()).funds[funds.top10];
  assert.equal(fund.balanceUnits, '123');
  assert.equal(fund.availableUnits, null);
  assert.equal(fund.weeklyAvailable, false);
  assert.equal(fund.weeklyError, 'Weekly RPC failure');
  assert.equal(fund.weeklyCheckedAt, null);
  assert.equal(fund.reservedUnits, undefined);
});

test('history scan failure makes totals unavailable while independently healthy balances remain readable', async () => {
  const { createFundLedger } = await import(url);
  const provider = makeProvider({ head: 10, logs: [], txFrom: new Map() });
  const ledger = createFundLedger({
    provider, router: makeRouter([], new Map()), startBlock: 10,
    config: { routerAddress, radioFunds: { topTen: funds.top10 }, assets: { USDC: { address: usdc } } },
  });
  await ledger.initialize();
  provider.getBlockNumber = async () => { throw new Error('History RPC unavailable'); };
  await assert.rejects(ledger.refresh(), /History RPC unavailable/);
  const fund = (await ledger.getCurrentState()).funds[funds.top10];
  assert.equal(fund.balanceUnits, '0');
  assert.equal(fund.balanceAvailable, true);
  assert.equal(fund.sourcesAvailable, false);
  assert.equal(fund.sponsorUnits, null);
  assert.equal(fund.historyError, 'History RPC unavailable');
});

test('public evidence filters other assets and backfills legacy deposits with missing asset identity', async () => {
  const { createFundLedger } = await import(url);
  const logs = [
    makeLog(funds.top10, `0x${'1'.repeat(40)}`, 123n, `0x${'a'.repeat(64)}`, 10, 0),
    makeLog(funds.top10, `0x${'1'.repeat(40)}`, 999n, `0x${'b'.repeat(64)}`, 10, 1),
  ];
  const foreign = iface.encodeEventLog('FundFunded', [id(funds.top10), `0x${'2'.repeat(40)}`, `0x${'1'.repeat(40)}`, 999n]);
  Object.assign(logs[1], foreign);
  const router = makeRouter(logs, new Map());
  const ledger = createFundLedger({
    provider: makeProvider({ head: 10, logs, txFrom: new Map() }), router,
    config: { routerAddress, radioFunds: { topTen: funds.top10 }, assets: { USDC: { address: usdc } } },
    restore: async () => ({ schemaVersion: 1, chainId: 8453, routerAddress,
      scannedFrom: 10, scannedThrough: 10, lastCheckedAt: '2026-10-22T00:00:00Z',
      sources: [{ slug: funds.top10, amountUnits: '999', txHash: logs[1].transactionHash }], payouts: [] }),
  });
  await ledger.initialize();
  assert.deepEqual(router.queryRanges, [[10, 10]]);
  const fund = (await ledger.getCurrentState()).funds[funds.top10];
  assert.equal(fund.sources.length, 1);
  assert.equal(fund.sources[0].asset, usdc);
  assert.equal(fund.sponsorUnits, '123');
});

test('public evidence rejects unsupported asset metadata instead of labeling it Base USDC', async () => {
  const { createFundLedger } = await import(url);
  for (const config of [
    { chainId: 1, assets: { USDC: { address: usdc } } },
    { assets: { USDC: { address: `0x${'1'.repeat(40)}` } } },
    { assets: { USDC: { address: usdc, decimals: 18 } } },
  ]) assert.throws(() => createFundLedger({ provider: {}, router: {}, config }), /native Base USDC/);
});

test('fund refresh skips unchanged checks, schedules event-free cursor progress and saves new funds immediately', async () => {
  const { createFundLedger } = await import(url);
  let head = 10;
  const logs = [];
  const provider = makeProvider({ head, logs, txFrom: new Map() });
  provider.getBlockNumber = async () => head;
  const saves = [];
  const scheduled = [];
  const ledger = createFundLedger({ provider, router: makeRouter(logs, new Map()), startBlock: 10,
    config: { routerAddress, radioFunds: { topTen: funds.top10 }, assets: { USDC: { address: usdc } } },
    save: async value => { saves.push(structuredClone(value)); return 'ipfs://saved'; },
    schedule: value => scheduled.push(structuredClone(value)) });
  await ledger.initialize();
  await ledger.refresh();
  assert.equal(saves.length, 1);
  assert.equal(scheduled.length, 0);
  head++;
  await ledger.refresh();
  assert.equal(saves.length, 1);
  assert.equal(scheduled[0].scannedThrough, 11);
  logs.push(makeLog(funds.top10, `0x${'1'.repeat(40)}`, 100n, `0x${'a'.repeat(64)}`, ++head, 0));
  await ledger.refresh();
  assert.equal(saves.length, 2);
  assert.equal(saves[1].sources.length, 1);
});

test('fund ledger classifies advert, djuke, and sponsor sources', async () => {
  const { createFundLedger } = await import(url);
  const logs = [
    makeLog(funds.top10, devertContract, 12250000n, '0x' + '1'.repeat(64), 10, 0),
    makeLog(funds.pinners, djukeContract, 1020000n, '0x' + '2'.repeat(64), 11, 0),
    makeLog(funds.repo, '0x3333333333333333333333333333333333333333', 255000n, '0x' + '3'.repeat(64), 12, 0),
  ];
  const provider = makeProvider({ head: 12, logs, txFrom: new Map([
    ['0x' + '1'.repeat(64), devertContract],
    ['0x' + '2'.repeat(64), djukeContract],
    ['0x' + '3'.repeat(64), '0x4444444444444444444444444444444444444444'],
  ]) });
  const router = makeRouter(logs, new Map([
    [id(funds.playback).toLowerCase(), 12250000n],
    [id(funds.top10).toLowerCase(), 12250000n],
    [id(funds.repo).toLowerCase(), 255000n],
    [id(funds.pinners).toLowerCase(), 1020000n],
  ]));
  const state = {
    campaigns: [{ advertiser: '0x1111111111111111111111111111111111111111', paidUnits: '12250000', campaignId: '7', title: 'Weekend shoutout', txHash: '0x' + '1'.repeat(64) }],
  };
  const djuke = { requests: [{ payer: '0x2222222222222222222222222222222222222222', amountUnits: '1020000', chainRequestId: '42', txHash: '0x' + '2'.repeat(64) }] };
  const saved = [];
  const ledger = createFundLedger({
    provider,
    router,
    config: {
      routerAddress,
      radioFunds: { playback: funds.playback, topTen: funds.top10 },
      fundSlug: funds.repo,
      pinnerFundSlug: funds.pinners,
      assets: { USDC: { address: usdc } },
    },
    getWeeklyPayflow: async () => ({
      funds: {
        playback: { balanceUnits: '12250000', reservedUnits: '0', availableUnits: '12250000' },
        top10: { balanceUnits: '12250000', reservedUnits: '0', availableUnits: '12250000' },
      },
    }),
    readDevertState: async () => state,
    readDjukeState: async () => djuke,
    restore: async () => null,
    save: async snapshot => { saved.push(snapshot); return 'ipfs://saved'; },
    startBlock: 10,
  });
  await ledger.initialize();
  const current = await ledger.getCurrentState();
  assert.equal(current.ready, true);
  assert.equal(current.funds['dbusk-top10'].balanceUnits, '12250000');
  assert.equal(current.funds['dbusk-top10'].advertUnits, '12250000');
  assert.equal(current.funds['dbusk-top10'].sources[0].kind, 'advert');
  assert.equal(current.funds['dbusk-top10'].sources[0].campaignId, '7');
  assert.equal(current.funds['dbusk-top10'].sources[0].title, 'Weekend shoutout');
  assert.equal(current.funds['dbusk-pinners'].sources[0].kind, 'djuke');
  assert.equal(current.funds['dbusk-pinners'].sources[0].requestId, '42');
  assert.equal(current.funds['dbusk-repo-dev'].sources[0].kind, 'sponsor');
  assert.ok(saved.at(-1).scannedThrough >= 12);
});

test('fund ledger resumes from its saved cursor instead of rescanning from the start', async () => {
  const { createFundLedger } = await import(url);
  const firstLogs = [makeLog(funds.top10, '0x1111111111111111111111111111111111111111', 12250000n, '0x' + '1'.repeat(64), 10, 0)];
  const firstProvider = makeProvider({ head: 10, logs: firstLogs, txFrom: new Map([['0x' + '1'.repeat(64), '0x1111111111111111111111111111111111111111']]) });
  const firstRouter = makeRouter(firstLogs, new Map([[id(funds.top10).toLowerCase(), 12250000n]]));
  let savedSnapshot = null;
  const firstLedger = createFundLedger({
    provider: firstProvider,
    router: firstRouter,
    config: { routerAddress, radioFunds: { topTen: funds.top10 }, assets: { USDC: { address: usdc } } },
    getWeeklyPayflow: async () => ({ funds: { top10: { balanceUnits: '12250000', reservedUnits: '0', availableUnits: '12250000' } } }),
    restore: async () => null,
    save: async snapshot => { savedSnapshot = snapshot; return 'ipfs://saved'; },
    startBlock: 10,
  });
  await firstLedger.initialize();

  const secondLogs = [
    makeLog(funds.top10, '0x1111111111111111111111111111111111111111', 12250000n, '0x' + '1'.repeat(64), 10, 0),
    makeLog(funds.top10, '0x1111111111111111111111111111111111111111', 12250000n, '0x' + '4'.repeat(64), 13, 0),
  ];
  const secondProvider = makeProvider({
    head: 14,
    logs: secondLogs,
    txFrom: new Map([
      ['0x' + '1'.repeat(64), '0x1111111111111111111111111111111111111111'],
      ['0x' + '4'.repeat(64), '0x1111111111111111111111111111111111111111'],
    ]),
  });
  const secondRouter = makeRouter(secondLogs, new Map([[id(funds.top10).toLowerCase(), 24500000n]]));
  const secondLedger = createFundLedger({
    provider: secondProvider,
    router: secondRouter,
    config: { routerAddress, radioFunds: { topTen: funds.top10 }, assets: { USDC: { address: usdc } } },
    getWeeklyPayflow: async () => ({ funds: { top10: { balanceUnits: '24500000', reservedUnits: '0', availableUnits: '24500000' } } }),
    restore: async () => savedSnapshot,
    save: async () => 'ipfs://saved-again',
    startBlock: 10,
  });
  await secondLedger.initialize();
  assert.deepEqual(secondRouter.queryRanges.at(-1), [11, 14]);
});

test('fund ledger accepts a synchronous weekly payflow getter', async () => {
  const { createFundLedger } = await import(url);
  const logs = [makeLog(funds.top10, '0x1111111111111111111111111111111111111111', 12250000n, '0x' + '1'.repeat(64), 10, 0)];
  const ledger = createFundLedger({
    provider: makeProvider({ head: 10, logs, txFrom: new Map([['0x' + '1'.repeat(64), '0x1111111111111111111111111111111111111111']]) }),
    router: makeRouter(logs, new Map([[id(funds.top10).toLowerCase(), 12250000n]])),
    config: { routerAddress, radioFunds: { topTen: funds.top10 }, assets: { USDC: { address: usdc } } },
    getWeeklyPayflow: () => ({ funds: { top10: { balanceUnits: '12250000', reservedUnits: '0', availableUnits: '12250000' } } }),
    restore: async () => null,
    save: async () => 'ipfs://saved',
    startBlock: 10,
  });
  await ledger.initialize();
  const current = await ledger.getCurrentState();
  assert.equal(current.funds[funds.top10].balanceUnits, '12250000');
});

const paidIface = new Interface(['event PayrollPaid(bytes32 indexed fundId, address indexed asset, address indexed recipient, uint256 amount, bytes32 workReference, bytes32 repositoryIdHash, bytes32 contributorIdHash, string metadataUri, bytes32 metadataHash)']);

function makePaidLog(fundSlug, recipient, amount, txHash, blockNumber, index) {
  const encoded = paidIface.encodeEventLog('PayrollPaid', [id(fundSlug), usdc, recipient, amount, id('work'), id('repo'), id('who'), 'ipfs://meta', id('meta')]);
  return { address: routerAddress, topics: encoded.topics, data: encoded.data, transactionHash: txHash, blockNumber, index, logIndex: index };
}

function logsProvider({ head, logs, txFrom }) {
  const getLogsCalls = [];
  return {
    ...makeProvider({ head, logs, txFrom }),
    getLogsCalls,
    getLogs: async filter => {
      getLogsCalls.push(filter);
      const wanted = new Set(filter.topics[0]);
      return logs.filter(log => log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock && wanted.has(log.topics[0]));
    },
  };
}

test('fund ledger indexes deposits and payouts with one getLogs call per range', async () => {
  const { createFundLedger } = await import(url);
  const recipient = '0x5555555555555555555555555555555555555555';
  const logs = [
    makeLog(funds.top10, devertContract, 12250000n, '0x' + '1'.repeat(64), 10, 0),
    makePaidLog(funds.top10, recipient, 3000000n, '0x' + '9'.repeat(64), 12, 1),
  ];
  const provider = logsProvider({ head: 12, logs, txFrom: new Map([['0x' + '1'.repeat(64), devertContract]]) });
  const router = makeRouter(logs, new Map([[id(funds.top10).toLowerCase(), 9250000n]]));
  const ledger = createFundLedger({
    provider,
    router,
    config: { routerAddress, radioFunds: { topTen: funds.top10 }, assets: { USDC: { address: usdc } } },
    getWeeklyPayflow: async () => ({ funds: { top10: { balanceUnits: '9250000', reservedUnits: '0', availableUnits: '9250000' } } }),
    restore: async () => null,
    save: async () => 'ipfs://saved',
    startBlock: 10,
  });
  await ledger.initialize();
  const fund = (await ledger.getCurrentState()).funds['dbusk-top10'];
  assert.equal(provider.getLogsCalls.length, 1);
  assert.equal(router.queryRanges.length, 0, 'queryFilter is only a fallback for providers without getLogs');
  assert.equal(fund.sources.length, 1);
  assert.equal(fund.payouts.length, 1);
  assert.equal(fund.payouts[0].recipient.toLowerCase(), recipient);
  assert.equal(fund.payouts[0].amountUnits, '3000000');
  assert.equal(fund.payoutUnits, '3000000');
});

test('fund ledger rescans once to backfill payouts for checkpoints saved before payouts were indexed', async () => {
  const { createFundLedger } = await import(url);
  const logs = [
    makeLog(funds.top10, devertContract, 12250000n, '0x' + '1'.repeat(64), 10, 0),
    makePaidLog(funds.top10, '0x5555555555555555555555555555555555555555', 1000000n, '0x' + '9'.repeat(64), 11, 1),
  ];
  const provider = logsProvider({ head: 20, logs, txFrom: new Map([['0x' + '1'.repeat(64), devertContract]]) });
  const saved = [];
  const ledger = createFundLedger({
    provider,
    router: makeRouter(logs, new Map([[id(funds.top10).toLowerCase(), 11250000n]])),
    config: { routerAddress, radioFunds: { topTen: funds.top10 }, assets: { USDC: { address: usdc } } },
    getWeeklyPayflow: async () => ({ funds: { top10: { balanceUnits: '11250000', reservedUnits: '0', availableUnits: '11250000' } } }),
    restore: async () => ({ schemaVersion: 1, chainId: 8453, routerAddress, scannedFrom: 10, scannedThrough: 20, sources: [] }),
    save: async snapshot => { saved.push(snapshot); return 'ipfs://saved'; },
    startBlock: 10,
  });
  await ledger.initialize();
  assert.equal(provider.getLogsCalls[0].fromBlock, 10);
  assert.equal((await ledger.getCurrentState()).funds['dbusk-top10'].payouts.length, 1);
  assert.ok(Array.isArray(saved.at(-1).payouts));
});
