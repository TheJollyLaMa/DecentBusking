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

test('Mac client pins only verified checkpoint bytes before sending an acknowledgment', async () => {
  const { createLocalCheckpointMirrorClient } = await import('../discord-bot/checkpoint-mirror-client.js');
  const { checkpointContentCid } = await import('../discord-bot/checkpoint-mirror.js');
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, playlist: [] }));
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