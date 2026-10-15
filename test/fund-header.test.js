const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ethers = require('../discord-bot/node_modules/ethers');

const url = pathToFileURL(path.join(__dirname, '../js/fund-header.mjs')).href;
const routerAddress = '0x8ecca903e2a6Daa8CCbB933700e4F2C58C44A4B5';
const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const top10 = 'dbusk-top10';
const iface = new ethers.Interface([
  'event FundFunded(bytes32 indexed fundId, address indexed asset, address indexed funder, uint256 amount)',
  'event PayrollPaid(bytes32 indexed fundId, address indexed asset, address indexed recipient, uint256 amount, bytes32 workReference, bytes32 repositoryIdHash, bytes32 contributorIdHash, string metadataUri, bytes32 metadataHash)',
]);

function encodeLog(eventName, args, blockNumber, transactionHash, logIndex) {
  const encoded = iface.encodeEventLog(iface.getEvent(eventName), args);
  return {
    address: routerAddress,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber,
    transactionHash,
    logIndex,
    index: logIndex,
  };
}

function fakeProvider() {
  const names = new Map([
    ['0x1111111111111111111111111111111111111111', 'thejollylama.eth'],
    ['0x2222222222222222222222222222222222222222', 'decentcanopy.eth'],
  ]);
  return {
    lookupAddress: async address => names.get(address.toLowerCase()) || null,
    resolveName: async name => ({
      'thejollylama.eth': '0x1111111111111111111111111111111111111111',
      'decentcanopy.eth': '0x2222222222222222222222222222222222222222',
    }[name] || null),
    getResolver: async () => null,
    getBlock: async blockNumber => ({ timestamp: 1_700_000_000 + Number(blockNumber) }),
  };
}

function fakeFetch() {
  const inflows = [
    encodeLog('FundFunded', [ethers.id(top10), usdc, '0x1111111111111111111111111111111111111111', 7_250_000n], 10, '0x' + '1'.repeat(64), 0),
    encodeLog('FundFunded', [ethers.id(top10), usdc, '0x2222222222222222222222222222222222222222', 2_000_000n], 11, '0x' + '2'.repeat(64), 0),
    encodeLog('FundFunded', [ethers.id(top10), usdc, '0x3333333333333333333333333333333333333333', 6_000_000n], 12, '0x' + '3'.repeat(64), 0),
  ];
  const outflows = [
    encodeLog('PayrollPaid', [ethers.id(top10), usdc, '0x4444444444444444444444444444444444444444', 3_000_000n, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, 'ipfs://pay', ethers.ZeroHash], 13, '0x' + '4'.repeat(64), 0),
  ];
  return async url => {
    const parsed = new URL(url);
    const topic0 = parsed.searchParams.get('topic0');
    if (topic0 === iface.getEvent('FundFunded').topicHash) {
      return { ok: true, json: async () => ({ status: '1', message: 'OK', result: inflows }) };
    }
    if (topic0 === iface.getEvent('PayrollPaid').topicHash) {
      return { ok: true, json: async () => ({ status: '1', message: 'OK', result: outflows }) };
    }
    return { ok: true, json: async () => ({ status: '1', message: 'OK', result: [] }) };
  };
}

test('loadFundBreakdown groups inflows, payouts, and reconciles the balance', async () => {
  const { loadFundBreakdown } = await import(url);
  const state = {
    balanceUnits: '12250000',
    sources: [
      { txHash: '0x' + '1'.repeat(64), logIndex: 0, kind: 'advert', campaignId: '7', title: 'Weekend shoutout' },
      { txHash: '0x' + '2'.repeat(64), logIndex: 0, kind: 'djuke', requestId: '42' },
      { txHash: '0x' + '3'.repeat(64), logIndex: 0, kind: 'sponsor' },
    ],
  };
  const result = await loadFundBreakdown({
    fundSlug: top10,
    fundState: state,
    fundBalanceUnits: 12_250_000n,
    fetchImpl: fakeFetch(),
    provider: fakeProvider(),
    ethers,
    sponsorAliases: { '0x3333333333333333333333333333333333333333': ['sponsor.eth'] },
  });

  assert.equal(result.historyAvailable, true);
  assert.equal(result.balanceUnits, 12_250_000n);
  assert.equal(result.inflowUnits, 15_250_000n);
  assert.equal(result.outflowUnits, 3_000_000n);
  assert.equal(result.netUnits, 12_250_000n);
  assert.equal(result.reconciles, true);

  const advert = result.rows.find(row => row.kind === 'advert');
  assert.ok(advert);
  assert.equal(advert.direction, 'in');
  assert.match(advert.sourceHtml, /thejollylama\.eth/);
  assert.match(advert.extra, /Campaign #7/);

  const djuke = result.rows.find(row => row.kind === 'djuke');
  assert.ok(djuke);
  assert.match(djuke.sourceHtml, /decentcanopy\.eth/);
  assert.match(djuke.extra, /DJuke request #42/);

  const payout = result.rows.find(row => row.direction === 'out');
  assert.ok(payout);
  assert.match(payout.txUrl, /basescan\.org\/tx\/0x4+/);
});
