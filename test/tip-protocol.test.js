const test = require('node:test');
const assert = require('node:assert/strict');
const ethers = require('../discord-bot/node_modules/ethers');
const payer = `0x${'12'.repeat(20)}`, recipient = `0x${'ab'.repeat(20)}`, router = `0x${'34'.repeat(20)}`;
const hash = `0x${'56'.repeat(32)}`;
const nftId = `8453:${recipient}:80`;

test('tip contexts distinguish live, radio and archive without losing recording identity or accepting invented kinds', async () => {
  const { createTipContext, parseTipContext } = await import('../js/tip-protocol.mjs');
  for (const source of ['live', 'radio', 'archive']) {
    const original = source === 'live' ? { source, bookingId: 'friday:fixture' } : { source, nftId };
    const context = createTipContext(original);
    assert.deepEqual(parseTipContext(context), original);
  }
  for (const value of [
    { source: 'payroll', bookingId: 'show' }, { source: 'live', bookingId: 'bad\nbooking' },
    { source: 'radio', nftId: '80' }, { source: 'radio', nftId: `8453:0x${'0'.repeat(40)}:80` },
    { source: 'archive', nftId: `8453:${recipient}:01` },
    { source: 'radio', nftId: `8453:${recipient}:${1n << 256n}` },
  ]) assert.throws(() => createTipContext(value), /source|booking|identity/i);
  assert.throws(() => parseTipContext({ sourceKind: 0, contextRef: `decentbusking:radio:${nftId}` }), /not recognized/);
});

test('exact trusted-contract receipt proof binds payer, recipient, wei and context and preserves repeated tips', async () => {
  const { TIP_ABI, createTipContext, decodeTipReceipt, verifyAttributedTipReceipt } = await import('../js/tip-protocol.mjs');
  const iface = new ethers.Interface(TIP_ABI);
  const intent = { source: 'live', bookingId: 'friday:fixture', payer, recipient, amountWei: '10000000000000001' };
  const context = createTipContext(intent);
  const encoded = iface.encodeEventLog(iface.getEvent('TipSent'), [
    payer, recipient, ethers.id(context.contextRef), context.sourceKind, BigInt(intent.amountWei), context.contextRef,
  ]);
  const receipt = { status: 1, hash, logs: [{ address: router, index: 7, ...encoded }] };
  const verified = verifyAttributedTipReceipt({ receipt, routerAddress: router, intent, ethers });
  assert.equal(verified.amountWei, '10000000000000001');
  assert.equal(verified.logIndex, 7);
  assert.equal(verified.context.bookingId, intent.bookingId);
  for (const change of [{ payer: router }, { recipient: payer }, { amountWei: '1' }, { bookingId: 'other-show' }]) {
    assert.throws(() => verifyAttributedTipReceipt({ receipt, routerAddress: router, intent: { ...intent, ...change }, ethers }), /No single exact/);
  }
  assert.throws(() => verifyAttributedTipReceipt({ receipt: { ...receipt, status: 0 }, routerAddress: router, intent, ethers }), /not confirmed/);
  assert.throws(() => verifyAttributedTipReceipt({ receipt, routerAddress: payer, intent, ethers }), /No single exact/);
  const repeated = { ...receipt, logs: [...receipt.logs, { ...receipt.logs[0], index: 8 }] };
  assert.equal(decodeTipReceipt({ receipt: repeated, routerAddress: router, ethers }).length, 2);
  assert.throws(() => verifyAttributedTipReceipt({ receipt: repeated, routerAddress: router, intent, ethers }), /No single exact/);
});

test('unrecognized caller-supplied context remains a real tip event but cannot become verified source earnings', async () => {
  const { TIP_ABI, decodeTipReceipt } = await import('../js/tip-protocol.mjs');
  const iface = new ethers.Interface(TIP_ABI), contextRef = 'invented-label';
  const encoded = iface.encodeEventLog(iface.getEvent('TipSent'), [payer, recipient, ethers.id(contextRef), 0, 1n, contextRef]);
  const [tip] = decodeTipReceipt({ receipt: { status: 1, hash, logs: [{ address: router, index: 0, ...encoded }] },
    routerAddress: router, ethers });
  assert.equal(tip.amountWei, '1');
  assert.equal(tip.context, null);
  assert.match(tip.contextError, /not recognized/);
});

test('split tips mirror the router rounding and require one exact event per owner', async () => {
  const { TIP_ABI, createTipContext, normalizeTipSplit, splitTipAmounts, verifySplitTipReceipt } = await import('../js/tip-protocol.mjs');
  const coOwner = `0x${'77'.repeat(20)}`;
  assert.throws(() => normalizeTipSplit([recipient, recipient], [5000, 5000]), /cannot receive/);
  assert.throws(() => normalizeTipSplit([recipient, coOwner], [5000, 4000]), /cannot receive/);
  const splits = normalizeTipSplit([recipient, coOwner], [3333n, 6667n]);
  assert.deepEqual(splitTipAmounts(10n, splits), [3n, 7n]);
  assert.throws(() => splitTipAmounts(1n, splits), /too small/);
  const context = createTipContext({ source: 'radio', nftId });
  const iface = new ethers.Interface(TIP_ABI);
  const log = (to, amount, index) => ({ ...iface.encodeEventLog('TipSent', [payer, to, ethers.id(context.contextRef),
    context.sourceKind, amount, context.contextRef]), address: router, index });
  const intent = { source: 'radio', nftId, payer, amountWei: '10', splits };
  const receipt = logs => ({ status: 1, hash, logs });
  assert.equal(verifySplitTipReceipt({ receipt: receipt([log(recipient, 3n, 0), log(coOwner, 7n, 1)]),
    routerAddress: router, intent, ethers }).length, 2);
  for (const logs of [[log(recipient, 3n, 0)], [log(recipient, 5n, 0), log(coOwner, 5n, 1)],
    [log(recipient, 3n, 0), log(payer, 7n, 1)]]) {
    assert.throws(() => verifySplitTipReceipt({ receipt: receipt(logs), routerAddress: router, intent, ethers }), /every song owner/);
  }
});
