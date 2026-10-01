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
        return new Response(JSON.stringify({ data: { files: [{ cid: 'bafystate' }] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ schemaVersion: 1, playlist: [{ trackId: 'track-1' }] }), { status: 200 });
    },
  });

  assert.deepEqual(await store.restore(), [{ trackId: 'track-1' }]);
  const listUrl = new URL(requests[0].url);
  assert.equal(listUrl.searchParams.get('keyvalues[app]'), 'decentbusking');
  assert.equal(listUrl.searchParams.get('keyvalues[kind]'), 'jukeloop-state');
  assert.equal(listUrl.searchParams.get('order'), 'DESC');
  assert.equal(listUrl.searchParams.get('limit'), '1');
  assert.equal(requests[1].url, 'https://dweb.link/ipfs/bafystate');
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
        data: { files: ['new', 'two', 'three', 'old'].map((id) => ({ id, cid: `bafy${id}` })) },
      }), { status: 200 });
    },
  });

  assert.equal(await store.save([{ trackId: 'track-1' }]), 'ipfs://bafynew');
  const upload = requests.find((request) => request.url.includes('uploads.pinata.cloud'));
  assert.equal(upload.options.body.get('name'), 'decentbusking-jukeloop-state.json');
  assert.deepEqual(JSON.parse(upload.options.body.get('keyvalues')), {
    keyvalues: { app: 'decentbusking', kind: 'jukeloop-state', schema: '1' },
  });
  const snapshot = JSON.parse(await upload.options.body.get('file').text());
  assert.equal(snapshot.schemaVersion, 1);
  assert.deepEqual(snapshot.playlist, [{ trackId: 'track-1' }]);
  assert.deepEqual(
    requests.filter((request) => request.options.method === 'DELETE').map((request) => request.url),
    ['https://api.pinata.cloud/v3/files/public/old'],
  );
});