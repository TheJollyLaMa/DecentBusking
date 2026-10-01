const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'ipfs.js')).href;

test('uploads to Pinata with a server-side JWT', async () => {
  const { createIpfsUploader } = await import(moduleUrl);
  let request;
  const upload = createIpfsUploader({
    provider: 'pinata',
    pinataJwt: 'test-jwt',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ data: { cid: 'bafypinata' } }), { status: 200 });
    },
  });

  assert.equal(await upload(Buffer.from('audio'), 'track.mp3', 'audio/mpeg'), 'ipfs://bafypinata');
  assert.equal(request.url, 'https://uploads.pinata.cloud/v3/files');
  assert.equal(request.options.headers.authorization, 'Bearer test-jwt');
  assert.equal(request.options.body.get('network'), 'public');
  assert.equal(request.options.body.get('file').name, 'track.mp3');
});

test('uploads to a local Kubo API without Pinata credentials', async () => {
  const { createIpfsUploader } = await import(moduleUrl);
  let request;
  const upload = createIpfsUploader({
    provider: 'local',
    ipfsApiUrl: 'http://127.0.0.1:5001/',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ Hash: 'bafylocal' }), { status: 200 });
    },
  });

  assert.equal(await upload(Buffer.from('{}'), 'metadata.json', 'application/json'), 'ipfs://bafylocal');
  assert.equal(request.url, 'http://127.0.0.1:5001/api/v0/add?cid-version=1&pin=true');
  assert.equal(request.options.headers, undefined);
});