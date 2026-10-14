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

test('scanLogEarnings splits block ranges only when the RPC rejects the range size', async () => {
  const { scanLogEarnings, ROUTER_START_BLOCK } = await load();
  let calls = 0;
  const provider = { getBlockNumber: async () => ROUTER_START_BLOCK + 40000,
    getLogs: async ({ fromBlock, toBlock }) => { calls++; if (toBlock - fromBlock > 10000) throw new Error('block range too large'); return []; } };
  const result = await scanLogEarnings({ ethers, providers: [provider], address: WALLET, storage: memoryStorage() });
  assert.equal(result.complete, true);
  assert.ok(calls > 2);
});

test('scanBlockscoutEarnings groups indexed router payouts and filters other recipients', async () => {
  const { scanBlockscoutEarnings, ROUTER_ADDRESS, USDC_ADDRESS } = await load();
  const iface = new ethers.Interface(['event PayrollPaid(bytes32 indexed fundId, address indexed asset, address indexed recipient, uint256 amount, bytes32 workReference, bytes32 repositoryIdHash, bytes32 contributorIdHash, string metadataUri, bytes32 metadataHash)']);
  const log = (recipient, amount, index, fund = 'dbusk-repo-dev') => {
    const encoded = iface.encodeEventLog('PayrollPaid', [ethers.id(fund), USDC_ADDRESS, recipient, amount, ethers.id(`w${index}`), ethers.ZeroHash, ethers.ZeroHash, 'u', ethers.ZeroHash]);
    return { address: ROUTER_ADDRESS.toLowerCase(), topics: encoded.topics, data: encoded.data, blockNumber: `0x${(100 + index).toString(16)}`,
      logIndex: `0x${index.toString(16)}`, transactionHash: `0x${String(index).padStart(64, '0')}` };
  };
  const urls = [];
  const fetch = async url => {
    urls.push(url);
    const result = url.includes(ROUTER_ADDRESS) ? [log(WALLET, 200000n, 1), log(WALLET, 200000n, 2), log(WALLET, 50000n, 3, 'dbusk-pinners'),
      log('0x405bb3a0000000000000000000000000000000a1', 5000000n, 4)] : [];
    return { ok: true, json: async () => (result.length ? { status: '1', message: 'OK', result } : { status: '0', message: 'No records found', result: [] }) };
  };
  const scan = await scanBlockscoutEarnings({ ethers, address: WALLET, fetch });
  assert.equal(scan.complete, true);
  const byLabel = Object.fromEntries(scan.entries.map(entry => [entry.label, entry]));
  assert.equal(byLabel['Repo dev payroll'].units, 400000n);
  assert.equal(byLabel['Repo dev payroll'].count, 2);
  assert.equal(byLabel['Pinner rewards'].units, 50000n);
  assert.equal(scan.entries.length, 2);
  assert.ok(urls.every(url => url.startsWith('https://base.blockscout.com/api?')));
  assert.ok(urls.some(url => url.includes('topic3=0x000000000000000000000000807061df657a7697c04045da7d16d941861caabc')));
});
