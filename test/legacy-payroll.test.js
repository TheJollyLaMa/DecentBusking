const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const moduleUrl = pathToFileURL(path.join(__dirname, '../js/legacy-payroll.mjs')).href;

test('legacy receipts survive reloads and one transaction cannot settle two work entries', async () => {
  const { createLegacyReceiptStore } = await import(moduleUrl);
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  const entry = { issueRef: 'owner/repo#1', contributor: '0xartist', contributorGithub: 'artist', amount: '0.00001' };
  const txHash = `0x${'1'.repeat(64)}`;
  createLegacyReceiptStore(storage).set(entry, { status: 'pending', txHash });
  const restored = createLegacyReceiptStore(storage);
  assert.equal(restored.get(entry).txHash, txHash);
  assert.throws(() => restored.set({ ...entry, issueRef: 'owner/repo#2' }, { status: 'confirmed', txHash }), /another payroll entry/);
});

test('legacy payment verification requires successful exact Optimism transfers and retains pending status', async () => {
  const { verifyLegacyPayment } = await import(moduleUrl);
  const txHash = `0x${'1'.repeat(64)}`;
  const provider = { getNetwork: async () => ({ chainId: 10n }),
    getTransaction: async () => ({ from: '0xowner', to: '0xartist', value: 10n, chainId: 10n }),
    getTransactionReceipt: async () => ({ status: 1 }) };
  const args = { provider, txHash, owner: '0xowner', recipient: '0xartist', amountWei: 10n };
  assert.equal((await verifyLegacyPayment(args)).status, 'confirmed');
  assert.equal((await verifyLegacyPayment({ ...args, provider: { ...provider, getTransactionReceipt: async () => null } })).status, 'pending');
  await assert.rejects(verifyLegacyPayment({ ...args, amountWei: 11n }), /does not match/);
  await assert.rejects(verifyLegacyPayment({ ...args, owner: '0xstranger' }), /does not match/);
  await assert.rejects(verifyLegacyPayment({ ...args, provider: { ...provider, getNetwork: async () => ({ chainId: 8453 }) } }), /Optimism/);
  await assert.rejects(verifyLegacyPayment({ ...args, provider: { ...provider, getTransactionReceipt: async () => ({ status: 0 }) } }), /failed/);
});