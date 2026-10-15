const test = require('node:test');
const assert = require('node:assert/strict');
const ethers = require('../discord-bot/node_modules/ethers');

const load = () => import('../js/creator-earnings.mjs');
const WALLET = '0x807061DF657A7697c04045dA7d16D941861cAABc';

function memoryStorage() {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
}

test('formatAmount renders USDC and ART units without rounding up', async () => {
  const { formatAmount } = await load();
  assert.equal(formatAmount(1125000n, 'USDC'), '1.125 USDC');
  assert.equal(formatAmount(225000n, 'USDC'), '0.225 USDC');
  assert.equal(formatAmount(0n, 'USDC'), '0.00 USDC');
  assert.equal(formatAmount(10n ** 18n * 3n / 2n, 'ART'), '1.50 ART');
});

test('readContractEarnings reports DJuke ledger payouts and unclaimed credits with proof links', async () => {
  const { readContractEarnings } = await load();
  const values = {
    '0xaaa': { ledger: [1125000n, 5n], credits: 0n },
    '0xbbb': { credits: 225000n },
    '0xccc': { credits: 0n },
  };
  const fakeEthers = { Contract: class { constructor(address) { this.address = address; }
    async artistLedger() { const [totalPaid, payoutCount] = values[this.address].ledger; return { totalPaid, payoutCount }; }
    async artistCredits() { return values[this.address].credits; } } };
  const entries = await readContractEarnings({ ethers: fakeEthers, provider: {}, address: WALLET, contracts: [
    { label: 'DJuke v0.3', address: '0xaaa', ledger: true }, { label: 'DJuke v0.2', address: '0xbbb' }, { label: 'DJuke v0.1', address: '0xccc' }] });
  assert.equal(entries.length, 2);
  const paid = entries.find(entry => entry.status === 'paid');
  assert.equal(paid.units, 1125000n);
  assert.equal(paid.count, 5);
  assert.match(paid.proofUrl, /basescan\.org\/address\/0xaaa#readContract/);
  const unclaimed = entries.find(entry => entry.status === 'unclaimed');
  assert.equal(unclaimed.units, 225000n);
  assert.match(unclaimed.label, /v0\.2/);
});

test('scanLogEarnings groups router payouts by fund with tx proofs and caches progress', async () => {
  const { scanLogEarnings, summarizeEarnings, ROUTER_ADDRESS, USDC_ADDRESS, ROUTER_START_BLOCK } = await load();
  const iface = new ethers.Interface([
    'event PayrollPaid(bytes32 indexed fundId, address indexed asset, address indexed recipient, uint256 amount, bytes32 workReference, bytes32 repositoryIdHash, bytes32 contributorIdHash, string metadataUri, bytes32 metadataHash)',
    'event ArtistWithdrawal(address indexed artist, uint256 amount)',
  ]);
  const zero = ethers.ZeroHash;
  const payroll = (fund, amount, hash) => ({ ...iface.encodeEventLog('PayrollPaid', [ethers.id(fund), USDC_ADDRESS, WALLET, amount, zero, zero, zero, '', zero]),
    address: ROUTER_ADDRESS, transactionHash: hash, index: 0, blockNumber: ROUTER_START_BLOCK + 10 });
  const calls = [];
  const provider = {
    getBlockNumber: async () => ROUTER_START_BLOCK + 100,
    getLogs: async filter => {
      calls.push(filter);
      if (filter.topics[0] === iface.getEvent('PayrollPaid').topicHash) {
        assert.equal(filter.topics[3], ethers.zeroPadValue(WALLET, 32).toLowerCase());
        return [payroll('dbusk-playback', 300000n, '0x' + '1'.repeat(64)), payroll('dbusk-playback', 200000n, '0x' + '2'.repeat(64)), payroll('dbusk-top10', 1000000n, '0x' + '3'.repeat(64))];
      }
      return [{ ...iface.encodeEventLog('ArtistWithdrawal', [WALLET, 50000n]), address: '0x333Aa353d6fc70aE79Cf91CE090645CD740FEf59',
        transactionHash: '0x' + '4'.repeat(64), index: 1, blockNumber: ROUTER_START_BLOCK + 20 }];
    },
  };
  const storage = memoryStorage();
  const result = await scanLogEarnings({ ethers, providers: [null, provider], address: WALLET, storage });
  assert.equal(result.complete, true);
  const playback = result.entries.find(entry => entry.label === 'Playback rewards');
  assert.equal(playback.units, 500000n);
  assert.equal(playback.count, 2);
  assert.match(playback.transactions[0].url, /basescan\.org\/tx\/0x/);
  assert.equal(result.entries.find(entry => entry.label === 'Top 10 rewards').units, 1000000n);
  assert.equal(result.entries.find(entry => /claimed credits/.test(entry.label)).units, 50000n);
  assert.equal(summarizeEarnings(result.entries).USDC.paid, 1550000n);

  calls.length = 0;
  const again = await scanLogEarnings({ ethers, providers: [provider], address: WALLET, storage });
  assert.equal(calls.length, 0, 'cached scan should not re-query already scanned blocks');
  assert.equal(summarizeEarnings(again.entries).USDC.paid, 1550000n);
});

test('scanLogEarnings reports incomplete instead of guessing when no provider can read logs', async () => {
  const { scanLogEarnings } = await load();
  const failing = { getBlockNumber: async () => 52000000, getLogs: async () => { throw new Error('request limit reached'); } };
  const result = await scanLogEarnings({ ethers, providers: [failing], address: WALLET, storage: memoryStorage(), maxRequests: 4 });
  assert.equal(result.complete, false);
  assert.deepEqual(result.entries, []);
});

test('earnings ledger scans in chunks, filters by address, and checkpoints progress', async () => {
  const { createEarningsLedger, ROUTER_ADDRESS, ROUTER_START_BLOCK, USDC_ADDRESS } = await load();
  const iface = new ethers.Interface([
    'event PayrollPaid(bytes32 indexed fundId, address indexed asset, address indexed recipient, uint256 amount, bytes32 workReference, bytes32 repositoryIdHash, bytes32 contributorIdHash, string metadataUri, bytes32 metadataHash)',
    'event ArtistWithdrawal(address indexed artist, uint256 amount)',
  ]);
  const makePayroll = (recipient, amount, blockNumber, txHash, fund = 'dbusk-repo-dev') => {
    const encoded = iface.encodeEventLog(iface.getEvent('PayrollPaid'), [ethers.id(fund), USDC_ADDRESS, recipient, amount,
      ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, 'ipfs://pay', ethers.ZeroHash]);
    return { address: ROUTER_ADDRESS, topics: encoded.topics, data: encoded.data, transactionHash: txHash, index: 0, blockNumber };
  };
  const makeWithdrawal = (artist, amount, blockNumber, txHash, contract = '0x333Aa353d6fc70aE79Cf91CE090645CD740FEf59') => ({
    ...iface.encodeEventLog(iface.getEvent('ArtistWithdrawal'), [artist, amount]), address: contract, transactionHash: txHash, index: 1, blockNumber,
  });
  const calls = [];
  const head = ROUTER_START_BLOCK + 4500;
  const logs = [
    makePayroll(WALLET, 300000n, ROUTER_START_BLOCK + 50, '0x' + '1'.repeat(64)),
    makePayroll('0x405bb3a0000000000000000000000000000000a1', 200000n, ROUTER_START_BLOCK + 1050, '0x' + '2'.repeat(64), 'dbusk-pinners'),
    makeWithdrawal(WALLET, 50000n, ROUTER_START_BLOCK + 2050, '0x' + '3'.repeat(64)),
  ];
  const provider = {
    getBlockNumber: async () => head,
    getBlock: async blockNumber => ({ timestamp: blockNumber * 12 }),
    getLogs: async filter => {
      calls.push([filter.fromBlock, filter.toBlock, filter.topics[0]]);
      const rangeLogs = logs.filter(log => log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock &&
        (filter.topics[0] === iface.getEvent('PayrollPaid').topicHash
          ? log.topics[0] === iface.getEvent('PayrollPaid').topicHash
          : log.topics[0] === iface.getEvent('ArtistWithdrawal').topicHash));
      return rangeLogs;
    },
  };
  const saved = [];
  const ledger = createEarningsLedger({
    ethers,
    provider,
    save: async snapshot => { saved.push(snapshot); return 'ipfs://earnings'; },
    wait: async () => {},
    chunkSize: 2000,
  });
  await ledger.initialize();
  assert.ok(calls.length >= 4);
  assert.equal(saved.length >= 1, true);
  const state = ledger.getAddressState(WALLET);
  assert.equal(state.ready, true);
  assert.equal(state.entries.length, 2);
  assert.equal(state.entries[0].recipient.toLowerCase(), WALLET.toLowerCase());
  assert.equal(state.entries[1].artist.toLowerCase(), WALLET.toLowerCase());
});

test('earnings ledger resumes from checkpoint and retries transient log rate limits', async () => {
  const { createEarningsLedger, ROUTER_START_BLOCK, ROUTER_ADDRESS, USDC_ADDRESS } = await load();
  const iface = new ethers.Interface([
    'event PayrollPaid(bytes32 indexed fundId, address indexed asset, address indexed recipient, uint256 amount, bytes32 workReference, bytes32 repositoryIdHash, bytes32 contributorIdHash, string metadataUri, bytes32 metadataHash)',
    'event ArtistWithdrawal(address indexed artist, uint256 amount)',
  ]);
  const log = {
    ...iface.encodeEventLog(iface.getEvent('PayrollPaid'), [ethers.id('dbusk-top10'), USDC_ADDRESS, WALLET, 100000n,
      ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, 'ipfs://pay', ethers.ZeroHash]),
    address: ROUTER_ADDRESS, transactionHash: '0x' + '4'.repeat(64), index: 0, blockNumber: ROUTER_START_BLOCK + 10,
  };
  const waits = [];
  const calls = [];
  let first = true;
  const provider = {
    getBlockNumber: async () => ROUTER_START_BLOCK + 100,
    getBlock: async blockNumber => ({ timestamp: blockNumber * 12 }),
    getLogs: async filter => {
      calls.push([filter.fromBlock, filter.toBlock]);
      if (first) { first = false; throw new Error('request limit reached'); }
      return filter.fromBlock <= log.blockNumber && log.blockNumber <= filter.toBlock ? [log] : [];
    },
  };
  const ledger = createEarningsLedger({
    ethers,
    provider,
    restore: async () => ({ schemaVersion: 1, chainId: 8453, routerAddress: ROUTER_ADDRESS, scannedFrom: ROUTER_START_BLOCK, scannedThrough: ROUTER_START_BLOCK + 9,
      lastCheckedAt: new Date().toISOString(), items: [] }),
    save: async () => 'ipfs://earnings',
    wait: async delay => { waits.push(delay); },
    chunkSize: 2000,
  });
  await ledger.initialize();
  assert.ok(waits.length >= 1);
  assert.equal(waits[0], 250);
  assert.ok(calls.some(([from]) => from === ROUTER_START_BLOCK + 10));
  const state = ledger.getAddressState(WALLET);
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].units, '100000');
});

test('grouped earnings entries are dropped when the receipt does not prove the transaction', async () => {
  const { verifyGroupedEarningsProofs, ROUTER_ADDRESS, USDC_ADDRESS } = await load();
  const iface = new ethers.Interface([
    'event PayrollPaid(bytes32 indexed fundId, address indexed asset, address indexed recipient, uint256 amount, bytes32 workReference, bytes32 repositoryIdHash, bytes32 contributorIdHash, string metadataUri, bytes32 metadataHash)',
  ]);
  const recipient = WALLET;
  const txHash = '0x' + '5'.repeat(64);
  const encoded = iface.encodeEventLog(iface.getEvent('PayrollPaid'), [ethers.id('dbusk-repo-dev'), USDC_ADDRESS, recipient, 100000n,
    ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, 'ipfs://pay', ethers.ZeroHash]);
  const entries = [{
    kind: 'payroll',
    fundId: ethers.id('dbusk-repo-dev'),
    label: 'Repo dev payroll',
    asset: 'USDC',
    units: 100000n,
    count: 1,
    transactions: [{ hash: txHash, units: '100000', blockNumber: 123, url: `https://basescan.org/tx/${txHash}` }],
  }];
  const provider = {
    getTransactionReceipt: async hash => hash === txHash ? ({ status: 1, logs: [{ address: ROUTER_ADDRESS, topics: encoded.topics, data: encoded.data }] }) : null,
  };
  const verified = await verifyGroupedEarningsProofs({ ethers, provider, address: recipient, entries });
  assert.equal(verified.length, 1);
  const rejected = await verifyGroupedEarningsProofs({ ethers, provider: { getTransactionReceipt: async () => ({ status: 1, logs: [] }) }, address: recipient, entries });
  assert.equal(rejected.length, 0);
});

test('scanLogEarnings splits block ranges only when the RPC rejects the range size', async () => {
  const { scanLogEarnings, ROUTER_START_BLOCK } = await load();
  let calls = 0;
  const provider = { getBlockNumber: async () => ROUTER_START_BLOCK + 40000,
    getLogs: async ({ fromBlock, toBlock }) => { calls++; if (toBlock - fromBlock > 10000) throw new Error('block range too large'); return []; } };
  const result = await scanLogEarnings({ ethers, providers: [provider], address: WALLET, storage: memoryStorage() });
  assert.equal(result.complete, true);
  assert.ok(calls > 2);
});
