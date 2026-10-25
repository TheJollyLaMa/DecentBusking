const test = require('node:test');
const assert = require('node:assert/strict');

const ownerA = `0x${'1'.repeat(40)}`;
const ownerB = `0x${'2'.repeat(40)}`;

test('split update queue becomes ready only after every current owner approves', async () => {
  const { createCreatorSplitUpdateQueue } = await import('../discord-bot/creator-split-updates.js');
  let saved = [];
  const queue = createCreatorSplitUpdateQueue({
    restore: async () => saved,
    save: async value => { saved = value; },
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
  });
  await queue.initialize();
  const request = await queue.queueRequest({
    kind: 'song',
    resourceId: `0x${'a'.repeat(64)}`,
    owners: [ownerA, ownerB],
    approvals: [{ address: ownerA, signature: 'first' }],
    requestedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-08T00:00:00.000Z',
  });
  assert.equal(queue.getReadyRequests().length, 0);
  await assert.rejects(queue.addApproval(request.requestId, {
    address: `0x${'3'.repeat(40)}`, signature: 'invalid',
  }), /not a current owner/);
  const ready = await queue.addApproval(request.requestId, { address: ownerB, signature: 'second' });
  assert.equal(ready.approvals.length, 2);
  assert.equal(queue.getReadyRequests().length, 1);
  assert.equal(saved[0].approvals.length, 2);
});

test('superseded and expired split proposals cannot be approved or completed', async () => {
  const { createCreatorSplitUpdateQueue } = await import('../discord-bot/creator-split-updates.js');
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const queue = createCreatorSplitUpdateQueue({ now: () => now });
  await queue.initialize();
  const base = {
    kind: 'album',
    resourceId: `0x${'b'.repeat(64)}`,
    owners: [ownerA],
    approvals: [{ address: ownerA, signature: 'approved' }],
    requestedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-08T00:00:00.000Z',
  };
  const first = await queue.queueRequest(base);
  const second = await queue.queueRequest({ ...base, requestId: 'second' });
  assert.equal(queue.getRequest(first.requestId).status, 'superseded');
  assert.equal(queue.getRequest(second.requestId).status, 'pending');
  now = Date.parse('2026-01-09T00:00:00.000Z');
  assert.equal(queue.getRequest(second.requestId).status, 'expired');
  assert.equal(queue.getReadyRequests().length, 0);
  await assert.rejects(queue.completeRequest(second.requestId), /expired/);
});
