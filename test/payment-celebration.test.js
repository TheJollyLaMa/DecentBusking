const test = require('node:test');
const assert = require('node:assert/strict');

test('payment celebrations rotate through 12 distinct effects before repeating', async () => {
  const { announcePaymentCelebration, resetPaymentCelebrationState } = await import('../js/payment-celebration.mjs');
  resetPaymentCelebrationState();
  const effects = [];
  for (let index = 0; index < 13; index++) {
    const result = announcePaymentCelebration({
      chainId: 8453,
      txHash: `0x${String(index + 1).padStart(64, '0')}`,
      amountText: '0.25',
      assetText: 'USDC',
    });
    assert.equal(result.accepted, true);
    effects.push(result.effectId);
  }
  assert.equal(new Set(effects.slice(0, 12)).size, 12);
  assert.equal(effects[12], effects[0]);
});

test('duplicate confirmed transfers are ignored', async () => {
  const { announcePaymentCelebration, resetPaymentCelebrationState } = await import('../js/payment-celebration.mjs');
  resetPaymentCelebrationState();
  const detail = { chainId: 8453, txHash: `0x${'a'.repeat(64)}`, amountText: '1.00', assetText: 'USDC' };
  assert.equal(announcePaymentCelebration(detail).accepted, true);
  assert.equal(announcePaymentCelebration(detail).accepted, false);
});
