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

test('dual pin reuses an existing CID and requires a verified local recursive pin', async () => {
  const { createDualPinUploader } = await import(moduleUrl);
  const cid = 'bafybeidxx4rufx7xrn5lmt3npyaej6doupxajyh53ibb4fp43whdvgfm2u';
  const calls = [];
  let pinned = false;
  const upload = createDualPinUploader({ pinataJwt: 'test-jwt', fetchImpl: async url => {
    calls.push(url);
    if (url.includes('/pin/add')) { pinned = true; return new Response('{}'); }
    if (url.includes('/pin/ls')) return new Response(JSON.stringify({ Keys: pinned ? { [cid]: { Type: 'recursive' } } : {} }));
    throw new Error('Existing Pinata content must not be uploaded');
  } });
  assert.equal(await upload(null, 'song.mp3', 'audio/mpeg', { existingPinataCid: cid }), `ipfs://${cid}`);
  assert.equal(calls.filter(url => url.includes('/pin/add')).length, 1);
  await upload(null, 'song.mp3', 'audio/mpeg', { existingPinataCid: cid });
  assert.equal(calls.filter(url => url.includes('/pin/add')).length, 1);
});

test('dual pin does not report success when local storage fails after Pinata upload', async () => {
  const { createDualPinUploader } = await import(moduleUrl);
  const cid = 'bafybeidxx4rufx7xrn5lmt3npyaej6doupxajyh53ibb4fp43whdvgfm2u';
  let uploads = 0;
  const upload = createDualPinUploader({ pinataJwt: 'test-jwt', fetchImpl: async url => {
    if (url.includes('uploads.pinata')) { uploads++; return new Response(JSON.stringify({ data: { cid } })); }
    return new Response('{}', { status: 503 });
  } });
  await assert.rejects(upload(Buffer.from('audio'), 'song.mp3', 'audio/mpeg'), error => {
    assert.equal(error.pinataCid, cid);
    assert.match(error.message, /do not upload again/);
    return true;
  });
  assert.equal(uploads, 1);
});
test('retries transient Pinata timeouts and server errors, but not client errors', async () => {
  const { createIpfsUploader } = await import(moduleUrl);
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const statuses = [408, 502];
    let calls = 0;
    const upload = createIpfsUploader({ pinataJwt: 'test-jwt', retryDelayMs: 0, fetchImpl: async () => {
      calls++;
      const status = statuses.shift();
      return status ? new Response('busy', { status }) : new Response(JSON.stringify({ data: { cid: 'bafyretry' } }), { status: 200 });
    } });
    assert.equal(await upload(Buffer.from('art'), 'cover.png', 'image/png'), 'ipfs://bafyretry');
    assert.equal(calls, 3);

    let rejectedCalls = 0;
    const rejected = createIpfsUploader({ pinataJwt: 'test-jwt', retryDelayMs: 0, fetchImpl: async () => {
      rejectedCalls++; return new Response('bad', { status: 400 });
    } });
    await assert.rejects(rejected(Buffer.from('art'), 'cover.png', 'image/png'), /Pinata upload failed \(400\)/);
    assert.equal(rejectedCalls, 1);

    let timeoutCalls = 0;
    const exhausted = createIpfsUploader({ pinataJwt: 'test-jwt', retryDelayMs: 0, attempts: 3, fetchImpl: async () => {
      timeoutCalls++; return new Response('timeout', { status: 408 });
    } });
    await assert.rejects(exhausted(Buffer.from('art'), 'cover.png', 'image/png'), /Pinata upload failed \(408\)/);
    assert.equal(timeoutCalls, 3);

    let networkCalls = 0;
    const network = createIpfsUploader({ pinataJwt: 'test-jwt', retryDelayMs: 0, fetchImpl: async () => {
      if (++networkCalls === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ data: { cid: 'bafynet' } }), { status: 200 });
    } });
    assert.equal(await network(Buffer.from('art'), 'cover.png', 'image/png'), 'ipfs://bafynet');
  } finally { console.warn = originalWarn; }
});
