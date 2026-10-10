const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'ipfs-state.js')).href;

test('restores the newest tagged JukeLoop snapshot from Pinata', async () => {
  const { createPinataStateStore } = await import(moduleUrl);
  const requests = [];
  const store = createPinataStateStore({
    pinataJwt: 'test-jwt',
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.startsWith('https://api.pinata.cloud/')) {
        return new Response(JSON.stringify({ data: { files: [{
          cid: 'bafystate',
          name: 'decentbusking-jukeloop-state.json',
          created_at: '2026-10-01T12:00:00.000Z',
        }] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ schemaVersion: 1, playlist: [{ trackId: 'track-1' }] }), { status: 200 });
    },
  });

  assert.deepEqual(await store.restore(), [{ trackId: 'track-1' }]);
  const listUrl = new URL(requests[0].url);
  assert.equal(listUrl.pathname, '/v3/files/public');
  assert.equal(listUrl.searchParams.get('name'), 'decentbusking-jukeloop-state.json');
  assert.equal(listUrl.searchParams.get('network'), null);
  assert.equal(listUrl.searchParams.get('order'), 'DESC');
  assert.equal(listUrl.searchParams.get('limit'), '100');
  assert.equal(requests[1].url, 'https://dweb.link/ipfs/bafystate');
  assert.ok(requests.every(({ options }) => options.signal instanceof AbortSignal));
});

test('restore falls back to the Pinata gateway when the configured gateway is rate-limited', async () => {
  const { createPinataStateStore } = await import(moduleUrl);
  const fetched = [];
  const store = createPinataStateStore({
    pinataJwt: 'test-jwt',
    filesApiUrl: 'https://api.pinata.cloud/v3/files/public',
    fetchImpl: async (url) => {
      fetched.push(url);
      if (url.startsWith('https://api.pinata.cloud/')) {
        return new Response(JSON.stringify({ data: { files: [{ cid: 'bafystate', name: 'decentbusking-jukeloop-state.json', created_at: '2026-10-01T12:00:00Z' }] } }));
      }
      if (url.startsWith('https://dweb.link')) return new Response('', { status: 429 });
      return new Response(JSON.stringify({ schemaVersion: 1, playlist: [{ trackId: 'kept' }] }));
    },
  });

  assert.deepEqual(await store.restore(), [{ trackId: 'kept' }]);
  assert.equal(new URL(fetched[0]).pathname, '/v3/files/public');
  assert.deepEqual(fetched.slice(1), ['https://dweb.link/ipfs/bafystate', 'https://gateway.pinata.cloud/ipfs/bafystate']);
});

test('payment snapshot namespace is separate and immutable payment backups are retained', async () => {
  const { createPinataStateStore } = await import(moduleUrl);
  const requests = [];
  const snapshot = { schemaVersion: 1, chainId: 8453, entries: [{ txHash: 'proof' }] };
  const store = createPinataStateStore({ pinataJwt: 'test', name: 'decentbusking-payment-ledger.json',
    tags: { app: 'decentbusking', kind: 'payment-ledger', schema: '1' }, retainSnapshots: Infinity,
    serialize: value => value, deserialize: (value, uri) => ({ ...value, snapshotUri: uri }),
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (options.method === 'POST') {
        assert.deepEqual(JSON.parse(await options.body.get('file').text()), snapshot);
        return new Response(JSON.stringify({ data: { cid: 'ledger' } }));
      }
      if (url.includes('/ipfs/')) return new Response(JSON.stringify(snapshot));
      assert.equal(new URL(url).searchParams.get('name'), 'decentbusking-payment-ledger.json');
      return new Response(JSON.stringify({ data: { files: Array.from({ length: 5 }, (_, index) => ({ id: String(index), cid: 'ledger', name: 'decentbusking-payment-ledger.json' })) } }));
    } });
  assert.equal(await store.save(snapshot), 'ipfs://ledger');
  assert.deepEqual(await store.restore(), { ...snapshot, snapshotUri: 'ipfs://ledger' });
  assert.equal(requests.some(value => value.options.method === 'DELETE'), false);
});

test('uploads tagged state and prunes snapshots older than the newest three', async () => {
  const { createPinataStateStore } = await import(moduleUrl);
  const requests = [];
  const store = createPinataStateStore({
    pinataJwt: 'test-jwt',
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === 'https://uploads.pinata.cloud/v3/files') {
        return new Response(JSON.stringify({ data: { cid: 'bafynew' } }), { status: 200 });
      }
      if (options.method === 'DELETE') return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({
        data: { files: ['new', 'two', 'three', 'old'].map((id, index) => ({
          id,
          cid: `bafy${id}`,
          name: 'decentbusking-jukeloop-state.json',
          created_at: `2026-10-01T12:00:0${3 - index}.000Z`,
        })) },
      }), { status: 200 });
    },
  });

  assert.equal(await store.save([{ trackId: 'track-1' }]), 'ipfs://bafynew');
  const upload = requests.find((request) => request.url.includes('uploads.pinata.cloud'));
  assert.equal(upload.options.body.get('name'), 'decentbusking-jukeloop-state.json');
  assert.deepEqual(JSON.parse(upload.options.body.get('keyvalues')), {
    app: 'decentbusking', kind: 'jukeloop-state', schema: '1',
  });
  const snapshot = JSON.parse(await upload.options.body.get('file').text());
  assert.equal(snapshot.schemaVersion, 1);
  assert.deepEqual(snapshot.playlist, [{ trackId: 'track-1' }]);
  assert.deepEqual(
    requests.filter((request) => request.options.method === 'DELETE').map((request) => request.url),
    ['https://api.pinata.cloud/v3/files/public/old'],
  );
});

test('checkpoint bytes must be mirrored before publication and match the Pinata CID', async () => {
  const { createPinataStateStore } = await import(moduleUrl);
  let mirrored;
  let uploads = 0;
  const store = createPinataStateStore({ pinataJwt: 'test', beforeUpload: async bytes => {
    mirrored = Buffer.from(bytes); return 'mirrored-cid';
  }, fetchImpl: async (url, options = {}) => {
    if (options.method === 'POST') {
      uploads++;
      assert.deepEqual(Buffer.from(await options.body.get('file').arrayBuffer()), mirrored);
      return new Response(JSON.stringify({ data: { cid: 'mirrored-cid' } }));
    }
    return new Response(JSON.stringify({ data: { files: [] } }));
  } });
  assert.equal(await store.save([{ trackId: 'song' }]), 'ipfs://mirrored-cid');
  const offline = createPinataStateStore({ pinataJwt: 'test', beforeUpload: async () => { throw new Error('Mirror offline'); },
    fetchImpl: async () => { uploads++; throw new Error('Must not publish'); } });
  await assert.rejects(offline.save([]), /Mirror offline/);
  assert.equal(uploads, 1);
  const mismatch = createPinataStateStore({ pinataJwt: 'test', beforeUpload: async () => 'local',
    fetchImpl: async () => new Response(JSON.stringify({ data: { cid: 'different' } })) });
  await assert.rejects(mismatch.save([]), /differs from locally mirrored/);
});