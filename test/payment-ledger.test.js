const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { Interface, id } = createRequire(path.join(__dirname, '../discord-bot/package.json'))('ethers');
const url = pathToFileURL(path.join(__dirname, '../discord-bot/payment-ledger.js')).href;

test('payment ledger verifies exact router events, snapshots payments, and detects altered chain proofs', async () => {
  const { createPaymentLedger, PAYMENT_EVENT_ABI } = await import(url);
  const address = `0x${'1'.repeat(40)}`;
  const txHash = `0x${'2'.repeat(64)}`;
  const blockHash = `0x${'3'.repeat(64)}`;
  const iface = new Interface(PAYMENT_EVENT_ABI);
  const encoded = iface.encodeEventLog(iface.getEvent('PayrollPaid'), [id('fund'), address, address, 123n,
    id('work'), id('TheJollyLaMa/DecentBusking'), id('artist'), 'ipfs://receipt', id('metadata')]);
  const receipt = { hash: txHash, status: 1, blockNumber: 10, blockHash, logs: [{ ...encoded, address, index: 0 }] };
  let canonicalHash = blockHash;
  let backups = 0;
  const provider = { getNetwork: async () => ({ chainId: 8453 }), getBlockNumber: async () => 12,
    getTransactionReceipt: async () => receipt, getBlock: async () => ({ hash: canonicalHash, timestamp: 1791200000 }), getLogs: async () => [] };
  const ledger = createPaymentLedger({ provider, routerAddress: address, startBlock: 10,
    save: async snapshot => { backups++; assert.equal(snapshot.chainId, 8453); return 'ipfs://ledger'; } });
  await ledger.initialize();
  const result = await ledger.reconcile(txHash);
  assert.equal(result.entries[0].amountUnits, '123');
  assert.equal(result.entries[0].workReference, id('work'));
  assert.equal(result.snapshotUri, 'ipfs://ledger');
  await ledger.reconcile(txHash);
  assert.equal(ledger.getState().entries.length, 1);
  canonicalHash = `0x${'4'.repeat(64)}`;
  await ledger.compare();
  assert.equal(ledger.getState().entries[0].verification, 'chain-mismatch');
  assert.ok(backups >= 2);
  await assert.rejects(ledger.reconcile(txHash), /canonical/);
  receipt.status = 0;
  await assert.rejects(ledger.reconcile(txHash), /successful/);
});

test('restored records are compared with real transaction events, not trusted as paid', async () => {
  const { createPaymentLedger } = await import(url);
  const address = `0x${'1'.repeat(40)}`;
  const provider = { getNetwork: async () => ({ chainId: 8453 }), getBlockNumber: async () => 12,
    getBlock: async () => ({ hash: 'canonical', timestamp: 1791200000 }), getLogs: async () => [],
    getTransactionReceipt: async () => ({ status: 1, blockNumber: 10, blockHash: 'canonical', logs: [] }) };
  const ledger = createPaymentLedger({ provider, routerAddress: address, restore: async () => ({ schemaVersion: 1, chainId: 8453,
    routerAddress: address, scannedFrom: 1, scannedThrough: 10, entries: [{ workReference: id('fabricated'), txHash: `0x${'2'.repeat(64)}`,
      blockNumber: 10, blockHash: 'canonical', amountUnits: '999', verification: 'verified' }] }), save: async () => 'ipfs://compared' });
  await ledger.initialize();
  assert.equal(ledger.getState().entries[0].verification, 'proof-mismatch');
});

test('repository ledger settlement requires exact fund, asset, recipient, amount and work proof', async () => {
  const { verifyRepositoryPayment, PAYMENT_EVENT_ABI } = await import(url);
  const address = `0x${'1'.repeat(40)}`;
  const entry = { contributor: address, contributorGithub: 'artist', issueRef: 'TheJollyLaMa/DecentBusking#1', role: 'contributor', currency: 'USDC', amount: '1', fund: 'repo-fund' };
  const config = { routerAddress: address, fundSlug: 'repo-fund', assets: { USDC: { address, decimals: 6 } } };
  const iface = new Interface(PAYMENT_EVENT_ABI);
  const event = iface.encodeEventLog(iface.getEvent('PayrollPaid'), [id('repo-fund'), address, address, 1000000n,
    id(`${entry.issueRef}:artist:contributor:USDC`), id('TheJollyLaMa/DecentBusking'), id('artist'), 'https://github.com/issue', id('metadata')]);
  const receipt = { status: 1, blockNumber: 10, blockHash: 'canonical', logs: [{ ...event, address }] };
  const provider = { getNetwork: async () => ({ chainId: 8453 }), getBlockNumber: async () => 12,
    getTransactionReceipt: async () => receipt, getBlock: async () => ({ hash: 'canonical' }) };
  await verifyRepositoryPayment({ entry, config, txHash: 'tx', provider });
  for (const change of [{ amount: '2' }, { fund: 'other' }, { contributor: `0x${'2'.repeat(40)}` }, { issueRef: 'TheJollyLaMa/DecentBusking#2' }]) {
    await assert.rejects(verifyRepositoryPayment({ entry: { ...entry, ...change }, config, txHash: 'tx', provider }), /exact router/);
  }
});

test('payment ledger waits for confirmations and does not trust unrelated events or failed backups', async () => {
  const { createPaymentLedger, PAYMENT_EVENT_ABI } = await import(url);
  const address = `0x${'1'.repeat(40)}`;
  const txHash = `0x${'2'.repeat(64)}`;
  const blockHash = `0x${'3'.repeat(64)}`;
  const iface = new Interface(PAYMENT_EVENT_ABI);
  const event = iface.encodeEventLog(iface.getEvent('PayrollPaid'), [id('fund'), address, address, 123n,
    id('work'), id('another/repo'), id('artist'), 'ipfs://receipt', id('metadata')]);
  let head = 10;
  const receipt = { hash: txHash, status: 1, blockNumber: 10, blockHash, logs: [{ ...event, address }] };
  const provider = { getNetwork: async () => ({ chainId: 8453 }), getBlockNumber: async () => head,
    getTransactionReceipt: async () => receipt, getBlock: async () => ({ hash: blockHash, timestamp: 1791200000 }), getLogs: async () => [] };
  const ledger = createPaymentLedger({ provider, routerAddress: address, save: async () => { throw new Error('offline'); } });
  await ledger.initialize();
  await assert.rejects(ledger.reconcile(txHash), /No DecentBusking/);
  const relevant = iface.encodeEventLog(iface.getEvent('PayrollPaid'), [id('fund'), address, address, 123n,
    id('work'), id('TheJollyLaMa/DecentBusking'), id('artist'), 'ipfs://receipt', id('metadata')]);
  receipt.logs = [{ ...relevant, address }];
  assert.equal((await ledger.reconcile(txHash)).pending, true);
  head = 12;
  assert.equal((await ledger.reconcile(txHash)).pending, false);
  assert.equal(ledger.getState().entries.length, 1);
  assert.equal(ledger.getState().backupPending, true);
});