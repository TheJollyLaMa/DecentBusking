const test = require('node:test');
const assert = require('node:assert/strict');

test('network summary counts actual registrations and recent successes, never a fictional swarm', async () => {
  const { pinnerHealth, pinnerNetworkSummary } = await import('../js/pinner-network-view.mjs');
  const now = Date.parse('2026-11-26T10:00:00Z');
  const active = { status: 'active', lastVerifiedAt: new Date(now - 60000).toISOString(), qualified: true, lastCheck: { ok: true } };
  assert.deepEqual(pinnerNetworkSummary({ participants: [] }, now), { enrolled: 0, approved: 0, verified: 0, qualified: 0 });
  const stale = { ...active, lastVerifiedAt: '2026-11-20T10:00:00Z', qualified: false };
  const degraded = { ...active, lastCheck: { ok: false }, qualified: false };
  assert.equal(pinnerHealth(stale, now), 'unverified');
  assert.equal(pinnerHealth(degraded, now), 'degraded');
  assert.equal(pinnerHealth({ ...active, lastVerifiedAt: new Date(now + 60000).toISOString() }, now), 'unverified');
  assert.deepEqual(pinnerNetworkSummary({ participants: [active, stale, degraded, { status: 'pending' }, { status: 'suspended' }] }, now),
    { enrolled: 5, approved: 3, verified: 1, qualified: 1 });
});

test('cost estimate uses incremental electricity plus hosting and rejects invalid hours or costs', async () => {
  const { monthlyPinnerCost } = await import('../js/pinner-network-view.mjs');
  assert.ok(Math.abs(monthlyPinnerCost({ watts: 10, hoursPerDay: 24, pricePerKwh: 0.15, hosting: 0 }) - 1.08) < 0.00001);
  assert.equal(monthlyPinnerCost({ watts: '0', hoursPerDay: '24', pricePerKwh: '0.2', hosting: '5' }), 5);
  for (const changes of [{ watts: -1 }, { hoursPerDay: 25 }, { pricePerKwh: '' }, { hosting: 'NaN' }]) {
    assert.throws(() => monthlyPinnerCost({ watts: 10, hoursPerDay: 24, pricePerKwh: 0.15, hosting: 0, ...changes }), /nonnegative/);
  }
});
