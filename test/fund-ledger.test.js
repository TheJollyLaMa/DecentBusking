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
