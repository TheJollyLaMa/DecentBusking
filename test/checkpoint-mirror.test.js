const test = require('node:test');
const assert = require('node:assert/strict');
const secret = 'test-only-checkpoint-mirror-secret-32bytes';

test('checkpoint mirror requires authenticated polling and exact CID acknowledgment', async () => {
  const { createCheckpointMirror, checkpointContentCid } = await import('../discord-bot/checkpoint-mirror.js');
  let now = 1000;
  const bridge = createCheckpointMirror({ secret, now: () => now });
  const authorization = `Bearer ${secret}`;
  assert.throws(() => bridge.requireAvailable(), /offline/);
  assert.throws(() => bridge.claim('Bearer wrong'), /authorization/);
  assert.equal(bridge.claim(authorization), null);
  const bytes = Buffer.from('{"playlist":[]}');
  const expected = await checkpointContentCid(bytes);
  const pending = bridge.mirror(bytes);
  let job;
  for (let attempt = 0; attempt < 100 && !job; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
    job = bridge.claim(authorization);
  }
  assert.ok(job);
  assert.equal(Buffer.from(job.contentBase64, 'base64').toString(), bytes.toString());
  assert.throws(() => bridge.acknowledge(authorization, { jobId: job.jobId, cid: expected, recursivePinned: false }), /mismatch/);
  bridge.acknowledge(authorization, { jobId: job.jobId, cid: expected, recursivePinned: true });
  assert.equal(await pending, expected);
  assert.equal(bridge.status().pending, 0);
  assert.throws(() => bridge.acknowledge(authorization, { jobId: job.jobId, cid: expected, recursivePinned: true }), /expired/);
  now += 30001;
  assert.throws(() => bridge.requireAvailable(), /offline/);
});

test('checkpoint mirror times out and rejects oversized jobs without publication', async () => {
  const { createCheckpointMirror } = await import('../discord-bot/checkpoint-mirror.js');
  const bridge = createCheckpointMirror({ secret, timeoutMs: 10, maxBytes: 8 });
  bridge.claim(`Bearer ${secret}`);
  await assert.rejects(bridge.mirror(Buffer.alloc(9)), /size limit/);
  await assert.rejects(bridge.mirror(Buffer.from('small')), /timed out/);
  assert.equal(bridge.status().pending, 0);
});

for (const snapshot of [
  { schemaVersion: 1, playlist: [] },
  { schemaVersion: 1, records: [] },
  { schemaVersion: 1, records: [{ requestId: '8453:queue:0', state: 'playing' }] },
  { schemaVersion: 2, nextBlock: 100, batches: [] },
  { schemaVersion: 2, nextBlock: 100, batches: [{ batchId: '0', status: 'pending',
    songIds: [`0x${'a'.repeat(64)}`], laneIds: ['0'] }] },
  { schemaVersion: 1, revision: 0, bookings: [], escrowScannedThrough: null },
  { schemaVersion: 1, revision: 1, bookings: [{ id: 'friday-live', wallet: `0x${'a'.repeat(40)}` }], escrowScannedThrough: 100 },
  { schemaVersion: 1, occurrences: [] },
  { schemaVersion: 1, deliveries: {}, requests: {} },
  { schemaVersion: 1, instanceId: 'friday', week: 'NY-2026-10-23', startAt: '2026-10-23T23:00:00Z',
    endAt: '2026-10-24T00:00:00Z', capturedAt: '2026-10-23T23:00:00Z', cursor: 0, tracks: [], skipped: [], lastStarted: null },
]) {
test(`Mac client pins verified ${snapshot.playlist ? 'playlist' : 'journal'} bytes before acknowledgment (${snapshot.records?.length || 0} records)`, async () => {
  const { createLocalCheckpointMirrorClient } = await import('../discord-bot/checkpoint-mirror-client.js');
  const { checkpointContentCid } = await import('../discord-bot/checkpoint-mirror.js');
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const cid = await checkpointContentCid(bytes);
  let pinned = false;
  let acknowledged = false;
  const poll = createLocalCheckpointMirrorClient({ serviceUrl: 'https://worker.example', secret,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/claim')) return new Response(JSON.stringify({ job: { jobId: 'job', expectedCid: cid, contentBase64: bytes.toString('base64') } }));
      if (url.includes('/api/v0/add')) {
        assert.deepEqual(Buffer.from(await options.body.get('file').arrayBuffer()), bytes);
        assert.equal(options.headers, undefined);
        return new Response(JSON.stringify({ Hash: cid }));
      }
      if (url.includes('/pin/add')) { pinned = true; return new Response('{}'); }
      if (url.includes('/pin/ls')) return new Response(JSON.stringify({ Keys: pinned ? { [cid]: { Type: 'recursive' } } : {} }));
      if (url.endsWith('/ack')) { assert.equal(pinned, true); acknowledged = true; return new Response('{"ok":true}'); }
      throw new Error('Unexpected request');
    } });
  assert.equal((await poll()).cid, cid);
  assert.equal(acknowledged, true);
  assert.throws(() => createLocalCheckpointMirrorClient({ serviceUrl: 'http://untrusted.example', secret }), /HTTPS/);
});
}

test('Mac client rejects unsupported or invalid playback journals before importing bytes', async () => {
  const { createLocalCheckpointMirrorClient } = await import('../discord-bot/checkpoint-mirror-client.js');
  const { checkpointContentCid } = await import('../discord-bot/checkpoint-mirror.js');
  for (const snapshot of [{ schemaVersion: 2, records: [] }, { schemaVersion: 1, records: [{}] },
    { schemaVersion: 1, records: [{ requestId: 'request', state: 'unknown' }] }, { schemaVersion: 1, other: [] },
    { schemaVersion: 2, nextBlock: -1, batches: [] },
    { schemaVersion: 2, nextBlock: 100, batches: [{}] },
    { schemaVersion: 1, revision: -1, bookings: [], escrowScannedThrough: null },
    { schemaVersion: 1, revision: 0, bookings: [{}], escrowScannedThrough: null },
    { schemaVersion: 1, occurrences: [{}] },
    { schemaVersion: 1, deliveries: {}, requests: { broken: {} } },
    { schemaVersion: 1, instanceId: 'invalid' }]) {
    const bytes = Buffer.from(JSON.stringify(snapshot));
    const cid = await checkpointContentCid(bytes);
    const poll = createLocalCheckpointMirrorClient({ serviceUrl: 'https://worker.example', secret,
      fetchImpl: async url => {
        assert.ok(url.endsWith('/claim'), 'invalid checkpoints must not reach Kubo or acknowledgment');
        return new Response(JSON.stringify({ job: { jobId: 'invalid', expectedCid: cid, contentBase64: bytes.toString('base64') } }));
      } });
    await assert.rejects(poll(), /Only supported|Invalid|Unknown radio playlist/);
  }
});
test('required journal checkpoints are offered first and never fail because best-effort mirrors filled the queue', async () => {
  const { createCheckpointMirror } = await import('../discord-bot/checkpoint-mirror.js');
  const bridge = createCheckpointMirror({ secret, maxOptionalJobs: 2 });
  const authorization = `Bearer ${secret}`;
  bridge.claim(authorization);
  const optional = ['radio', 'hype'].map(key => bridge.mirror(Buffer.from(`{"${key}":1}`), { key }));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(bridge.mirror(Buffer.from('{"shows":1}'), { key: 'shows' }), /queue is full/);
  const required = bridge.mirror(Buffer.from('{"records":[]}'), { key: 'djuke', required: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(bridge.status(), { available: true, pending: 3, required: 1 });
  const job = bridge.claim(authorization);
  assert.equal(Buffer.from(job.contentBase64, 'base64').toString(), '{"records":[]}');
  bridge.acknowledge(authorization, { jobId: job.jobId, cid: job.expectedCid, recursivePinned: true });
  assert.equal(await required, job.expectedCid);
  for (const pending of optional) {
    const next = bridge.claim(authorization);
    bridge.acknowledge(authorization, { jobId: next.jobId, cid: next.expectedCid, recursivePinned: true });
  }
  assert.equal((await Promise.all(optional)).length, 2);
});

test('a newer best-effort snapshot of the same store supersedes its unclaimed predecessor', async () => {
  const { createCheckpointMirror } = await import('../discord-bot/checkpoint-mirror.js');
  const bridge = createCheckpointMirror({ secret });
  const authorization = `Bearer ${secret}`;
  bridge.claim(authorization);
  const first = bridge.mirror(Buffer.from('{"v":1}'), { key: 'radio' });
  await new Promise(resolve => setImmediate(resolve));
  const second = bridge.mirror(Buffer.from('{"v":2}'), { key: 'radio' });
  assert.equal(await first, null);
  await new Promise(resolve => setImmediate(resolve));
  const job = bridge.claim(authorization);
  assert.equal(Buffer.from(job.contentBase64, 'base64').toString(), '{"v":2}');
  const third = bridge.mirror(Buffer.from('{"v":3}'), { key: 'radio' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bridge.status().pending, 2, 'a claimed snapshot is never withdrawn from the local client');
  bridge.acknowledge(authorization, { jobId: job.jobId, cid: job.expectedCid, recursivePinned: true });
  assert.equal(await second, job.expectedCid);
  const last = bridge.claim(authorization);
  bridge.acknowledge(authorization, { jobId: last.jobId, cid: last.expectedCid, recursivePinned: true });
  assert.equal(await third, last.expectedCid);
});

test('an idle long-poll claim receives a new required checkpoint immediately', async () => {
  const { createCheckpointMirror } = await import('../discord-bot/checkpoint-mirror.js');
  const bridge = createCheckpointMirror({ secret });
  const authorization = `Bearer ${secret}`;
  const started = Date.now();
  const waiting = bridge.claimWait(authorization, 5_000);
  const mirrored = bridge.mirror(Buffer.from('{"records":[1]}'), { key: 'djuke', required: true });
  const job = await waiting;
  assert.ok(Date.now() - started < 1_000);
  assert.equal(Buffer.from(job.contentBase64, 'base64').toString(), '{"records":[1]}');
  bridge.acknowledge(authorization, { jobId: job.jobId, cid: job.expectedCid, recursivePinned: true });
  assert.equal(await mirrored, job.expectedCid);
  assert.equal(await bridge.claimWait(authorization, 20), null);
  await assert.rejects(bridge.claimWait('Bearer wrong', 20), /authorization/);
});
