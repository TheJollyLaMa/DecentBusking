const test = require('node:test');
const assert = require('node:assert/strict');

const payer = `0x${'a'.repeat(40)}`;
const contract = `0x${'b'.repeat(40)}`;
const txHash = `0x${'c'.repeat(64)}`;
const items = [1, 2, 3].map(i => ({ songId: `0x${String(i).padStart(64, '0')}`,
  title: `Song ${i}`, audioUrl: `ipfs://song${i}` }));
const purchase = { payer, contract, txHash, items, name: 'BoogieNight' };
function memory() {
  const values = new Map();
  return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), values };
}

test('confirmed and pending sessions survive reload, stay wallet scoped, and prevent duplicate purchases', async () => {
  const { createPersonalPlayRecovery } = await import('../js/personal-play-recovery.mjs');
  const storage = memory();
  const store = createPersonalPlayRecovery(storage);
  store.check(payer, items.map(item => item.songId));
  store.save(purchase);
  assert.throws(() => store.check(payer, items.map(item => item.songId)), /already.*unfinished/);
  store.save(purchase);
  assert.equal(store.list(payer).length, 1, 'submission replay is idempotent');
  store.update(payer, txHash, { status: 'confirmed', index: 1, position: 87.25 });
  const reloaded = createPersonalPlayRecovery(storage);
  assert.equal(reloaded.list(payer.toUpperCase().replace('0X', '0x'))[0].position, 87.25);
  assert.equal(reloaded.list(payer)[0].index, 1);
  assert.deepEqual(reloaded.list(`0x${'d'.repeat(40)}`), []);
  assert.throws(() => store.check(payer, items.map(item => item.songId)), /already.*unfinished/);
  store.update(payer, txHash, { status: 'completed' });
  assert.doesNotThrow(() => store.check(payer, items.map(item => item.songId)));
});

test('sessions keep independent progress; failed transactions do not prevent a fresh purchase', async () => {
  const { createPersonalPlayRecovery } = await import('../js/personal-play-recovery.mjs');
  const store = createPersonalPlayRecovery(memory());
  store.save(purchase);
  const otherHash = `0x${'d'.repeat(64)}`;
  store.save({ ...purchase, txHash: otherHash, items: [items[2]] });
  store.update(payer, txHash, { index: 2, position: 33 });
  assert.equal(store.list(payer)[1].position, 0);
  store.update(payer, txHash, { status: 'failed' });
  assert.doesNotThrow(() => store.check(payer, items.map(item => item.songId)));
});

test('storage failures and corrupt records surface explicitly instead of pretending recovery was saved', async () => {
  const { createPersonalPlayRecovery } = await import('../js/personal-play-recovery.mjs');
  const blocked = createPersonalPlayRecovery({ getItem: () => null, setItem: () => { throw new Error('quota'); } });
  assert.throws(() => blocked.check(payer, items.map(item => item.songId)), /could not be saved/);
  const corrupt = createPersonalPlayRecovery({ getItem: () => '{', setItem() {} });
  assert.throws(() => corrupt.list(payer), /could not be read/);
  const store = createPersonalPlayRecovery(memory());
  assert.throws(() => store.save({ ...purchase, items: [] }), /invalid/);
  store.save(purchase);
  assert.throws(() => store.update(payer, txHash, { index: 99 }), /invalid/);
  assert.throws(() => store.update(payer, txHash, { position: -1 }), /invalid/);
});

test('resume verifies the original Base receipt without invoking any purchase or approval', async () => {
  const { verifyPersonalPlaySession } = await import('../js/personal-play-recovery.mjs');
  let chainId = 8453, receipt = null;
  const provider = { getNetwork: async () => ({ chainId }),
    getTransactionReceipt: async hash => { assert.equal(hash, txHash); return receipt; } };
  await assert.rejects(verifyPersonalPlaySession(purchase, provider), /awaiting confirmation/);
  receipt = { from: payer, to: contract, status: 1 };
  await verifyPersonalPlaySession(purchase, provider);
  chainId = 1;
  await assert.rejects(verifyPersonalPlaySession(purchase, provider), /Switch to Base/);
  chainId = 8453;
  receipt = { ...receipt, status: 0 };
  await assert.rejects(verifyPersonalPlaySession(purchase, provider), { code: 'PERSONAL_PLAY_REVERTED' });
  receipt = { from: contract, to: contract, status: 1 };
  await assert.rejects(verifyPersonalPlaySession(purchase, provider), /does not match/);
});
