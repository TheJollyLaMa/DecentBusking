const test = require('node:test');
const assert = require('node:assert/strict');
const ethers = require('../discord-bot/node_modules/ethers');
const router = `0x${'12'.repeat(20)}`, sender = `0x${'34'.repeat(20)}`, recipient = `0x${'56'.repeat(20)}`;
const collection = `0x${'78'.repeat(20)}`;

async function fixture(options = {}) {
  const { createTipLedger } = await import('../discord-bot/tip-ledger.js');
  const { TIP_ABI } = await import('../js/tip-protocol.mjs');
  const iface = new ethers.Interface(TIP_ABI);
  const state = { head: 30, epoch: 0, logs: [], receipts: new Map(), reads: [], backup: null };
  const block = number => ({ hash: ethers.id(`block:${number}:${state.epoch}`), timestamp: 1794600000 + number });
  const provider = {
    getNetwork: async () => ({ chainId: 8453n }), getCode: async (_address, at) => at === 0 ? '0x' : '0x01',
    getBlockNumber: async () => state.head, getBlock: async number => block(number),
    getTransactionReceipt: async hash => state.receipts.get(hash),
    getLogs: async filter => {
      state.reads.push(filter);
      return state.logs.filter(log => log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock);
    },
  };
  function add({ hash = ethers.id('tip'), blockNumber = 2, index = 0, amount = 5n,
    contextRef = 'decentbusking:live:show', from = sender, to = recipient, sourceKind = 0 } = {}) {
    const encoded = iface.encodeEventLog('TipSent', [from, to, ethers.id(contextRef), sourceKind, amount, contextRef]);
    const log = { ...encoded, address: router, index, transactionHash: hash, blockNumber };
    state.logs.push(log);
    const receipt = state.receipts.get(hash) || { status: 1, hash, blockNumber, blockHash: block(blockNumber).hash, logs: [] };
    receipt.logs.push(log);
    state.receipts.set(hash, receipt);
    return hash;
  }
  const ledger = createTipLedger({ provider, routerAddress: router, startBlock: 1,
    resolveContext: async () => ({ status: 'verified', label: 'Verified show' }),
    save: async snapshot => { state.backup = structuredClone(snapshot); return 'ipfs://tip-ledger'; }, ...options });
  return { ledger, provider, state, add, createTipLedger };
}

test('ledger verifies canonical receipts, keeps repeat tips by event identity, and uses exact native units', async () => {
  const { ledger, add, state } = await fixture();
  add({ amount: 10000000000000001n });
  add({ index: 1, amount: 7n });
  add({ hash: ethers.id('another-tip'), amount: 9n });
  await ledger.initialize();
  const result = ledger.getState({ wallet: recipient, limit: 2 });
  assert.equal(result.attributedWei, '10000000000000017');
  assert.equal(result.entries.length, 2);
  assert.equal(result.nextOffset, 2);
  assert.equal(result.total, 3);
  assert.equal(result.caughtUp, true);
  assert.equal(state.backup.entries.length, 3);
  await ledger.compare();
  assert.equal(ledger.getState().total, 3);
  assert.equal(ledger.getState({ wallet: sender }).attributedWei, '0');
  assert.throws(() => ledger.getState({ limit: 101 }), /Invalid tip ledger page/);
});

test('live tip feedback uses only confirmed exact-booking and recipient facts within the effective show', async () => {
  const base = 1794600000000;
  const clock = { at: base + 100_000 };
  const pending = ethers.id('pending-source');
  let sourceAvailable = false;
  const { ledger, add, state } = await fixture({ now: () => clock.at, resolveContext: async event =>
    event.txHash === pending && !sourceAvailable ? { status: 'unavailable' } : { status: 'verified' } });
  add({ hash: ethers.id('good-a'), blockNumber: 3, amount: 10n });
  add({ hash: ethers.id('good-b'), blockNumber: 4, amount: 17n });
  add({ hash: pending, blockNumber: 5, amount: 23n });
  add({ hash: ethers.id('too-early'), blockNumber: 2, amount: 100n });
  add({ hash: ethers.id('too-late'), blockNumber: 9, amount: 100n });
  add({ hash: ethers.id('wrong-show'), blockNumber: 6, contextRef: 'decentbusking:live:another-show' });
  add({ hash: ethers.id('wrong-recipient'), blockNumber: 6, to: collection });
  add({ hash: ethers.id('self-tip'), blockNumber: 6, from: recipient });
  add({ hash: ethers.id('radio-tip'), blockNumber: 6, sourceKind: 1,
    contextRef: `decentbusking:radio:8453:${collection}:80` });
  const scope = { bookingId: 'show', recipient, startedAt: base + 3000, endsAt: base + 8000 };
  assert.deepEqual(ledger.getLiveTips(scope), { ready: false });
  await ledger.initialize();
  let result = ledger.getLiveTips(scope);
  assert.equal(result.ready, true);
  assert.equal(result.complete, false);
  assert.equal(result.count, 2);
  assert.equal(result.totalWei, '27');
  assert.deepEqual(result.entries.map(entry => entry.amountWei), ['10', '17']);
  assert.ok(result.entries.every(entry => !Object.hasOwn(entry, 'sender') && !Object.hasOwn(entry, 'recipient')));
  sourceAvailable = true;
  await ledger.compare();
  result = ledger.getLiveTips(scope);
  assert.equal(result.complete, true);
  assert.equal(result.count, 3);
  assert.equal(result.totalWei, '50');
  assert.equal(ledger.getLiveTips({ ...scope, endsAt: base + 4000 }).count, 1);
  assert.equal(ledger.getLiveTips({ ...scope, bookingId: 'other-show' }).count, 0);
  clock.at += 60_001;
  assert.deepEqual(ledger.getLiveTips(scope), { ready: false });
  await ledger.compare();
  assert.equal(ledger.getLiveTips(scope).count, 3);
  state.epoch++;
  state.logs = [];
  state.receipts.clear();
  await ledger.compare();
  assert.equal(ledger.getLiveTips(scope).count, 0);
});

test('live tip feedback totals all verified tips while bounding notices and rejecting invalid scope', async () => {
  const base = 1794600000000, clock = { at: base + 100_000 };
  const { ledger, add } = await fixture({ now: () => clock.at });
  for (let index = 0; index < 125; index++) {
    add({ hash: ethers.id(`live-bulk-${index}`), blockNumber: 4, index, amount: 1n });
  }
  await ledger.initialize();
  const scope = { bookingId: 'show', recipient, startedAt: base + 3000, endsAt: base + 8000 };
  const result = ledger.getLiveTips(scope);
  assert.equal(result.count, 125);
  assert.equal(result.totalWei, '125');
  assert.equal(result.entries.length, 20);
  assert.equal(new Set(result.entries.map(entry => entry.eventKey)).size, 20);
  assert.throws(() => ledger.getLiveTips({ ...scope, recipient: sender.slice(0, -1) }), /scope/);
  assert.throws(() => ledger.getLiveTips({ ...scope, limit: 21 }), /scope/);
  assert.throws(() => ledger.getLiveTips({ ...scope, bookingId: '<show>' }), /booking/);
});

test('one confirmation, reverted receipts, wrong chain and noncanonical blocks never become earnings', async () => {
  for (const kind of ['pending', 'reverted', 'chain', 'fork']) {
    const { ledger, add, state, provider } = await fixture();
    const hash = add();
    if (kind === 'pending') state.head = 2;
    if (kind === 'reverted') state.receipts.get(hash).status = 0;
    if (kind === 'chain') provider.getNetwork = async () => ({ chainId: 1n });
    if (kind === 'fork') state.receipts.get(hash).blockHash = ethers.id('different fork');
    if (kind === 'pending') await ledger.initialize();
    else await assert.rejects(ledger.initialize(), /unsuccessful|Base-only|canonical/);
    assert.equal(ledger.getState().attributedWei, '0');
    if (kind === 'pending') {
      state.head = 3;
      await ledger.compare();
      assert.equal(ledger.getState().attributedWei, '5');
    }
  }
});

test('caller labels and unavailable source verification are not credited as verified performance earnings', async () => {
  const { ledger, add } = await fixture({ resolveContext: async () => { throw Error('Historical RPC unavailable'); } });
  add();
  add({ hash: ethers.id('invented'), contextRef: 'my invented show' });
  add({ hash: ethers.id('self-tip'), from: recipient });
  await ledger.initialize();
  const result = ledger.getState();
  assert.equal(result.attributedWei, '0');
  assert.equal(result.unattributedWei, '10', 'Self-transfers are not artist earnings');
  assert.equal(result.entries.filter(entry => entry.sourceVerification.status === 'mismatch').length, 1);
  assert.match(result.entries.find(entry => entry.sourceVerification.status === 'unavailable').sourceVerification.error, /source verification.*unavailable/);
});

test('restored entries must be reverified; extra restored log indexes and replaced chain history disappear', async () => {
  const { ledger, add, state, provider, createTipLedger } = await fixture();
  add();
  await ledger.initialize();
  const saved = structuredClone(state.backup);
  saved.entries[0].amountWei = '999999';
  saved.entries.push({ ...saved.entries[0], logIndex: 99 });
  const restored = createTipLedger({ provider, routerAddress: router, startBlock: 1,
    resolveContext: async () => ({ status: 'verified', label: 'Show' }), restore: async () => saved });
  assert.equal(restored.getState().ready, false);
  await restored.initialize();
  assert.equal(restored.getState().attributedWei, '5');
  assert.equal(restored.getState().restoringCount, 0);
  assert.equal(restored.getState().total, 1);
  state.epoch++;
  state.logs = [];
  state.receipts.clear();
  await restored.compare();
  assert.equal(restored.getState().attributedWei, '0');
  assert.equal(restored.getState().total, 0);
  assert.equal(state.reads.at(-1).fromBlock, 1, 'A deep reorganization restarts at deployment, not an arbitrary recent window');
});

test('missing deployment origin and backup failures are explicit, with retryable chain recovery', async () => {
  const { createTipLedger, provider } = await fixture();
  assert.throws(() => createTipLedger({ provider, routerAddress: router, resolveContext() {} }), /TIP_START_BLOCK/);
  let fail = true;
  const { ledger, add } = await fixture({ save: async () => {
    if (fail) throw Error('IPFS offline');
    return 'ipfs://restored';
  } });
  add();
  await assert.rejects(ledger.initialize(), /IPFS offline/);
  assert.equal(ledger.getState().ready, false);
  fail = false;
  await ledger.compare();
  assert.equal(ledger.getState().ready, true);
  assert.equal(ledger.getState().attributedWei, '5');
});

test('context resolver binds NFT recipient and existence to the tip block, never current mutable metadata', async () => {
  const { createTipContextResolver } = await import('../discord-bot/tip-context.js');
  const calls = [];
  const resolver = createTipContextResolver({ collections: [collection],
    readLiveBooking: async (id, blockNumber) => ({ verified: id === 'show' && blockNumber === 3, performer: recipient, title: 'Set' }),
    readNft: async params => { calls.push(params); return { uri: 'ipfs://metadata', supply: params.blockNumber === 3 ? 1n : 0n }; },
    fetchMetadata: async () => ({ artistName: 'Artist', name: 'Recording', tipWallet: recipient, audioUrl: 'ipfs://audio' }),
  });
  const event = { context: { source: 'radio', nftId: `8453:${collection}:80` }, recipient, blockNumber: 3 };
  assert.equal((await resolver(event)).status, 'verified');
  assert.equal(calls[0].blockNumber, 3);
  assert.equal((await resolver({ ...event, blockNumber: 2 })).status, 'mismatch');
  assert.equal((await resolver({ ...event, recipient: sender })).status, 'mismatch');
  assert.equal((await resolver({ ...event, context: { source: 'archive', nftId: `8453:${router}:80` } })).status, 'mismatch');
  assert.equal((await resolver({ ...event, context: { source: 'live', bookingId: 'show' } })).status, 'verified');
  assert.equal((await resolver({ ...event, context: { source: 'live', bookingId: 'unknown' } })).status, 'unavailable');
});

test('historical booking reader reuses the real escrow ABI and exact booking key at the receipt block', async () => {
  const { createHistoricalTipBookingReader } = await import('../discord-bot/tip-context.js');
  const { LIVE_ESCROW_ABI } = await import('../js/live-bookings.mjs');
  const iface = new ethers.Interface(LIVE_ESCROW_ABI);
  const reader = createHistoricalTipBookingReader({ escrowAddress: router, provider: { call: async transaction => {
    assert.equal(transaction.blockTag, 17);
    assert.equal(transaction.data, iface.encodeFunctionData('bookings', [ethers.id('friday:fixture')]));
    return iface.encodeFunctionResult('bookings', [[recipient, sender, 20n, 20n, 1, 2, 3, 4, 5, 0, ethers.id('terms'), 1]]);
  } } });
  const booking = await reader('friday:fixture', 17);
  assert.equal(booking.verified, true);
  assert.equal(booking.exists, true);
  assert.equal(booking.performer.toLowerCase(), recipient);
});

test('chain changes during source lookup cannot strand orphaned tips behind a newly advanced cursor', async () => {
  let changeChain;
  const { ledger, add, state } = await fixture({ resolveContext: async () => {
    changeChain?.();
    return { status: 'verified' };
  } });
  add();
  changeChain = () => { state.epoch++; state.logs = []; state.receipts.clear(); changeChain = null; };
  await assert.rejects(ledger.initialize(), /chain changed/);
  assert.equal(ledger.getState().ready, false);
  assert.equal(ledger.getState().attributedWei, '0');
  await ledger.compare();
  assert.equal(ledger.getState().attributedWei, '0');
  assert.equal(ledger.getState().ready, true);
});

test('a later scan start cannot silently omit the earliest contract tips', async () => {
  const { ledger, provider } = await fixture();
  provider.getCode = async () => '0x01';
  await assert.rejects(ledger.initialize(), /exact contract deployment block/);
  assert.equal(ledger.getState().ready, false);
});

test('a long backlog drains in one bounded run without gaps, so catch-up takes minutes instead of hours', async () => {
  const { ledger, add, state } = await fixture({ maxWindowsPerRun: 10 });
  state.head = 5501;
  for (const [name, blockNumber] of [['a', 2], ['b', 1500], ['c', 3200], ['d', 5400]]) add({ hash: ethers.id(`tip-${name}`), blockNumber });
  const result = await ledger.initialize();
  assert.equal(result.caughtUp, true);
  assert.equal(result.scannedThrough, 5500);
  assert.equal(result.total, 4);
  assert.equal(result.attributedWei, '20');
  assert.deepEqual(state.reads.map(read => [read.fromBlock, read.toBlock]),
    [[1, 1000], [989, 2000], [1989, 3000], [2989, 4000], [3989, 5000], [4989, 5500]]);
});

test('each run stops at its window cap and resumes where it ended; the default stays one window', async () => {
  const capped = await fixture({ maxWindowsPerRun: 2 });
  capped.state.head = 5501;
  await capped.ledger.initialize();
  assert.equal(capped.ledger.getState().scannedThrough, 2000);
  assert.equal(capped.ledger.getState().caughtUp, false);
  await capped.ledger.compare();
  assert.equal(capped.ledger.getState().scannedThrough, 4000);
  await capped.ledger.compare();
  assert.equal(capped.ledger.getState().scannedThrough, 5500);
  assert.equal(capped.ledger.getState().caughtUp, true);
  const single = await fixture();
  single.state.head = 5501;
  await single.ledger.initialize();
  assert.equal(single.ledger.getState().scannedThrough, 1000);
  for (const bad of [0, -1, 1.5, 101, '5', NaN]) await assert.rejects(fixture({ maxWindowsPerRun: bad }), /windows per run/);
});

test('a failed window keeps the progress of earlier windows and the next run resumes there', async () => {
  const { ledger, add, state, provider } = await fixture({ maxWindowsPerRun: 10 });
  state.head = 5501;
  add({ blockNumber: 2 });
  const getLogs = provider.getLogs;
  provider.getLogs = async filter => {
    if (filter.fromBlock === 1989) throw new Error('Provider rate limit');
    return getLogs(filter);
  };
  await assert.rejects(ledger.initialize(), /rate limit/);
  assert.equal(ledger.getState().scannedThrough, 2000);
  assert.equal(ledger.getState().attributedWei, '5');
  assert.equal(ledger.getState().ready, false);
  provider.getLogs = getLogs;
  await ledger.compare();
  assert.equal(ledger.getState().caughtUp, true);
  assert.equal(ledger.getState().ready, true);
  assert.equal(ledger.getState().attributedWei, '5');
});

test('a chain replaced during a multi-window run drops earlier windows and rescans from the deployment block', async () => {
  const { ledger, add, state, provider } = await fixture({ maxWindowsPerRun: 10 });
  state.head = 5501;
  add({ blockNumber: 2 });
  const getLogs = provider.getLogs;
  provider.getLogs = async filter => {
    if (filter.fromBlock === 1989) { state.epoch++; state.logs = []; state.receipts.clear(); }
    return getLogs(filter);
  };
  await assert.rejects(ledger.initialize(), /chain changed/);
  provider.getLogs = getLogs;
  await ledger.compare();
  assert.equal(ledger.getState().total, 0);
  assert.equal(ledger.getState().attributedWei, '0');
  assert.equal(ledger.getState().caughtUp, true);
});

test('checkpoint history retains native tips as distinct event observations rather than payroll work references', async () => {
  const { stateHistoryEvents } = await import('../discord-bot/checkpoint-history.js');
  const entry = { txHash: ethers.id('tip'), logIndex: 0, contextRef: 'decentbusking:live:show', amountWei: '1' };
  const events = stateHistoryEvents('tip-ledger', { entries: [entry, { ...entry, logIndex: 1 }] },
    { entries: [entry] }, '2026-11-14T10:00:00Z');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'financial');
  assert.equal(events[0].record.logIndex, 1);
});
