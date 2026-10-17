const test = require('node:test');
const assert = require('node:assert/strict');
const ethers = require('../discord-bot/node_modules/ethers');

const load = () => import('../js/creator-earnings.mjs');
const WALLET = '0x807061DF657A7697c04045dA7d16D941861cAABc';

test('an empty earnings index does not upload on unchanged polling and retries failed initial persistence', async () => {
  const { createEarningsLedger } = await load();
  let head = 10;
  let fail = true;
  let saves = 0;
  const scheduled = [];
  const ledger = createEarningsLedger({ ethers, startBlock: 10, contracts: [],
    provider: { getBlockNumber: async () => head, getLogs: async () => [] },
    save: async () => { saves++; if (fail) throw new Error('IPFS offline'); },
    schedule: value => scheduled.push(value) });
  await assert.rejects(ledger.initialize(), /IPFS offline/);
  fail = false;
  await ledger.refresh();
  assert.equal(saves, 2);
  await ledger.refresh();
  assert.equal(saves, 2);
  assert.equal(scheduled.length, 0);
  head++;
  await ledger.refresh();
  assert.equal(saves, 2);
  assert.equal(scheduled[0].scannedThrough, 11);
});

test('top jukebox earners aggregate only fulfilled song-play payouts, rank exact totals and recover after scan failure', async () => {
  const { createEarningsLedger, ROUTER_ADDRESS, DJUKE_EARNING_CONTRACTS } = await load();
  const contract = DJUKE_EARNING_CONTRACTS[0].address;
  const wallets = ['1', '2', '3', '4'].map(digit => `0x${digit.repeat(40)}`);
  const items = [
    ...wallets.map((artist, index) => ({ kind: 'song-play', artist, contract, asset: 'USDC', requestId: String(index),
      units: String([100, 500, 300, 200][index]), txHash: `0x${index}`, logIndex: 0, blockNumber: 5 })),
    { kind: 'song-play', artist: wallets[0], contract, asset: 'USDC', requestId: '9', units: '1000', txHash: '0x9', logIndex: 0, blockNumber: 6 },
    { kind: 'song-play', artist: wallets[3], contract, asset: 'USDC', units: '9999999', txHash: '0xa', logIndex: 0, blockNumber: 6 },
    { kind: 'payroll', recipient: wallets[3], asset: 'USDC', units: '9999999', txHash: '0xb', logIndex: 0, blockNumber: 6 },
    { kind: 'withdrawal', artist: wallets[3], contract, asset: 'USDC', units: '9999999', txHash: '0xc', logIndex: 0, blockNumber: 6 },
  ];
  let fail = false;
  const ledger = createEarningsLedger({ ethers, provider: {
    getBlockNumber: async () => { if (fail) throw new Error('RPC offline'); return 10; },
    getLogs: async () => [],
  }, restore: async () => ({ schemaVersion: 2, chainId: 8453, routerAddress: ROUTER_ADDRESS,
    scannedFrom: 0, scannedThrough: 10, songPlaysThrough: 10, items, lastCheckedAt: new Date().toISOString() }),
    save: async () => {} });
  assert.throws(() => ledger.getDjukeTopEarners(), /indexing/);
  await ledger.initialize();
  const result = ledger.getDjukeTopEarners();
  assert.equal(result.period, 'all-time');
  assert.deepEqual(result.earners, [
    { address: wallets[0], totalUnits: '1100' }, { address: wallets[1], totalUnits: '500' }, { address: wallets[2], totalUnits: '300' },
  ]);
  assert.equal(result.through, 10);
  fail = true;
  await assert.rejects(ledger.refresh(), /RPC offline/);
  assert.throws(() => ledger.getDjukeTopEarners(), /indexing/);
  fail = false;
  await ledger.refresh();
  assert.deepEqual(ledger.getDjukeTopEarners().earners, result.earners);
});

function memoryStorage() {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
}

test('formatAmount rounds USDC displays to cents and preserves ART precision', async () => {
  const { formatAmount } = await load();
  assert.equal(formatAmount(1125000n, 'USDC'), '1.13 USDC');
  assert.equal(formatAmount(225000n, 'USDC'), '0.23 USDC');
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
    'event ArtistPaid(address indexed artist, uint256 amount, uint256 cumulativePaid)',
  ]);
  const zero = ethers.ZeroHash;
  const DJUKE = '0x5d07489163feBCdB39C9F579CCC36dff5A067FF9';
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
      if (filter.topics[0] === iface.getEvent('ArtistPaid').topicHash) {
        assert.equal(filter.topics[1], ethers.zeroPadValue(WALLET, 32).toLowerCase());
        return [225000n, 225000n].map((amount, index) => ({ ...iface.encodeEventLog('ArtistPaid', [WALLET, amount, amount * BigInt(index + 1)]),
          address: DJUKE, transactionHash: '0x' + String(5 + index).repeat(64), index: 0, blockNumber: ROUTER_START_BLOCK + 30 + index }));
      }
      return [{ ...iface.encodeEventLog('ArtistWithdrawal', [WALLET, 50000n]), address: '0x5d07489163feBCdB39C9F579CCC36dff5A067FF9',
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
  const plays = result.entries.find(entry => entry.kind === 'song-play');
  assert.equal(plays.label, 'DJuke v0.3 song plays');
  assert.equal(plays.units, 450000n);
  assert.equal(plays.transactions.length, 2);
  assert.equal(summarizeEarnings(result.entries).USDC.paid, 2000000n);

  calls.length = 0;
  const again = await scanLogEarnings({ ethers, providers: [provider], address: WALLET, storage });
  assert.equal(calls.length, 0, 'cached scan should not re-query already scanned blocks');
  assert.equal(summarizeEarnings(again.entries).USDC.paid, 2000000n);
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
  const makeWithdrawal = (artist, amount, blockNumber, txHash, contract = '0x5d07489163feBCdB39C9F579CCC36dff5A067FF9') => ({
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

test('retired DJuke v0.1/v0.2 withdrawals are no longer tracked in groups or restored indexes', async () => {
  const { groupLogEarnings, createEarningsLedger, ROUTER_ADDRESS } = await load();
  const v02 = '0x333Aa353d6fc70aE79Cf91CE090645CD740FEf59';
  const v03 = '0x5d07489163feBCdB39C9F579CCC36dff5A067FF9';
  const withdrawal = (contract, txHash) => ({ kind: 'withdrawal', contract, artist: WALLET, units: '50000', txHash, logIndex: 0, blockNumber: 1 });
  const groups = groupLogEarnings([withdrawal(v02, '0x' + 'a'.repeat(64)), withdrawal(v03, '0x' + 'b'.repeat(64))], ethers);
  assert.equal(groups.length, 1);
  assert.match(groups[0].label, /v0\.3/);
  const ledger = createEarningsLedger({ ethers, wait: async () => {},
    provider: { getBlockNumber: async () => 100, getLogs: async () => [], getBlock: async () => ({ timestamp: 1 }) },
    restore: async () => ({ schemaVersion: 1, chainId: 8453, routerAddress: ROUTER_ADDRESS, scannedFrom: 1, scannedThrough: 100,
      lastCheckedAt: null, items: [withdrawal(v02, '0x' + 'a'.repeat(64)), withdrawal(v03, '0x' + 'b'.repeat(64))] }) });
  await ledger.initialize();
  assert.deepEqual(ledger.getAddressState(WALLET).entries.map(item => item.contract), [v03]);
});

test('earnings ledger backfills DJuke song-play payouts with song ids from a v1 checkpoint', async () => {
  const { createEarningsLedger, groupLogEarnings, ROUTER_ADDRESS } = await load();
  const DJUKE = '0x5d07489163feBCdB39C9F579CCC36dff5A067FF9';
  const start = 52526453;
  const iface = new ethers.Interface([
    'event ArtistPaid(address indexed artist, uint256 amount, uint256 cumulativePaid)',
    'event PlayFulfilled(uint256 indexed requestId, bytes32 indexed songId, bytes32 playbackProof, uint256 fundAmount)',
  ]);
  const songId = ethers.id('track-1');
  const logs = [1, 2].flatMap(n => [
    { ...iface.encodeEventLog('PlayFulfilled', [BigInt(n), songId, ethers.ZeroHash, 250000n]), address: DJUKE,
      transactionHash: '0x' + String(n).repeat(64), index: 0, blockNumber: start + n * 10 },
    { ...iface.encodeEventLog('ArtistPaid', [WALLET, 225000n, 225000n * BigInt(n)]), address: DJUKE,
      transactionHash: '0x' + String(n).repeat(64), index: 1, blockNumber: start + n * 10 },
  ]);
  const head = start + 3000;
  const filters = [];
  const provider = {
    getBlockNumber: async () => head,
    getBlock: async blockNumber => ({ timestamp: blockNumber }),
    getLogs: async filter => {
      filters.push(filter);
      return logs.filter(log => log.topics[0] === filter.topics[0] && log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock);
    },
  };
  const saved = [];
  const ledger = createEarningsLedger({
    ethers, provider, wait: async () => {}, chunkSize: 2000,
    restore: async () => ({ schemaVersion: 1, chainId: 8453, routerAddress: ROUTER_ADDRESS, scannedFrom: start - 100, scannedThrough: head, items: [] }),
    save: async snapshot => { saved.push(snapshot); },
  });
  await ledger.initialize();
  assert.equal(saved.length, 1, 'backfill progress must be checkpointed');
  assert.equal(saved[0].schemaVersion, 2);
  assert.equal(saved[0].songPlaysThrough, head);
  assert.ok(filters.every(filter => filter.fromBlock >= start), 'backfill starts at the DJuke v0.3 deploy block');
  const state = ledger.getAddressState(WALLET);
  assert.equal(state.entries.length, 2);
  assert.deepEqual(state.entries.map(entry => [entry.kind, entry.requestId, entry.songId, entry.cumulativePaid]),
    [['song-play', '1', songId, '225000'], ['song-play', '2', songId, '450000']]);
  const [group] = groupLogEarnings(state.entries.map(entry => ({ ...entry, trackTitle: 'Track One' })), ethers);
  assert.equal(group.label, 'DJuke v0.3 song plays');
  assert.equal(group.units, 450000n);
  assert.equal(group.transactions[0].title, 'Track One');
  assert.equal(group.transactions[0].timestamp, start + 20);
});

test('worker payroll entries with symbol assets count as USDC instead of TOKEN', async () => {
  const { groupLogEarnings, summarizeEarnings } = await load();
  const entries = groupLogEarnings(Array.from({ length: 9 }, (_, index) => ({ kind: 'payroll', fundId: ethers.id('dbusk-repo-dev'),
    asset: 'USDC', units: '200000', txHash: '0x' + index.toString(16).repeat(64), logIndex: 0, blockNumber: 100 + index })), ethers);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].asset, 'USDC');
  assert.equal(entries[0].label, 'Repo dev payroll');
  assert.equal(summarizeEarnings(entries).USDC.paid, 1800000n);
});

test('verified song-play receipts accept ArtistPaid logs from tracked DJuke contracts', async () => {
  const { verifyGroupedEarningsProofs } = await load();
  const DJUKE = '0x5d07489163feBCdB39C9F579CCC36dff5A067FF9';
  const iface = new ethers.Interface(['event ArtistPaid(address indexed artist, uint256 amount, uint256 cumulativePaid)']);
  const hash = '0x' + 'a'.repeat(64);
  const entry = { kind: 'song-play', contract: DJUKE, transactions: [{ hash, units: '225000' }] };
  const receipt = { status: 1, logs: [{ ...iface.encodeEventLog('ArtistPaid', [WALLET, 225000n, 225000n]), address: DJUKE }] };
  assert.equal((await verifyGroupedEarningsProofs({ ethers, provider: { getTransactionReceipt: async () => receipt }, address: WALLET, entries: [entry] })).length, 1);
  const forged = { status: 1, logs: [{ ...receipt.logs[0], address: '0x' + 'b'.repeat(40) }] };
  assert.equal((await verifyGroupedEarningsProofs({ ethers, provider: { getTransactionReceipt: async () => forged }, address: WALLET, entries: [entry] })).length, 0);
});
