const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'js', 'ipfs-upload.js')).href;

test('browser uploader signs a request then uploads through the returned Pinata URL', async () => {
  const { createBrowserIpfsUploader, buildUploadAuthorizationMessage } = await import(moduleUrl);
  const calls = [];
  const signed = [];
  const upload = createBrowserIpfsUploader({
    provider: 'pinata',
    serviceUrl: 'https://worker.example/',
    signer: { signMessage: async (message) => { signed.push(message); return '0xsigned'; } },
    address: '0x1111111111111111111111111111111111111111',
    origin: 'https://busking.example',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/api/ipfs/upload-url')) {
        return new Response(JSON.stringify({ url: 'https://uploads.pinata.example/signed' }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { cid: 'bafybrowser' } }), { status: 200 });
    },
  });
  const file = new File(['image'], 'cover.png', { type: 'image/png' });

  assert.equal(await upload(file), 'ipfs://bafybrowser');
  assert.equal(calls.length, 2);
  const authorization = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].url, 'https://worker.example/api/ipfs/upload-url');
  assert.equal(authorization.signature, '0xsigned');
  assert.equal(signed[0], buildUploadAuthorizationMessage(authorization));
  assert.equal(calls[1].options.body.get('network'), 'public');
});

test('browser batch uploader requests all metadata URLs with one owner signature', async () => {
  const { createBrowserIpfsUploader, buildUploadBatchAuthorizationMessage } = await import(moduleUrl);
  const calls = [];
  const signed = [];
  const upload = createBrowserIpfsUploader({ provider: 'pinata', serviceUrl: 'https://worker.example',
    signer: { signMessage: async message => { signed.push(message); return '0xbatch-signed'; } },
    address: '0x1111111111111111111111111111111111111111', origin: 'https://busking.example',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/api/ipfs/upload-batch-urls')) return new Response(JSON.stringify({ urls: [
        'https://uploads.pinata.example/first', 'https://uploads.pinata.example/second',
      ] }));
      return new Response(JSON.stringify({ data: { cid: new URL(url).pathname.endsWith('first') ? 'bafyfirst' : 'bafysecond' } }));
    } });
  const files = [new File(['{}'], 'first.json', { type: 'application/json' }),
    new File(['{}'], 'second.json', { type: 'application/json' })];

  assert.deepEqual(await upload.batch(files), ['ipfs://bafyfirst', 'ipfs://bafysecond']);
  assert.equal(signed.length, 1);
  const authorization = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].url, 'https://worker.example/api/ipfs/upload-batch-urls');
  assert.equal(authorization.signature, '0xbatch-signed');
  assert.deepEqual(authorization.files.map(({ name, size, type }) => ({ name, size, type })),
    files.map(file => ({ name: file.name, size: file.size, type: file.type })));
  assert.equal(signed[0], buildUploadBatchAuthorizationMessage(authorization));
  assert.equal(calls.length, 3);
});

test('browser uploader supports local Kubo without a wallet signer', async () => {
  const { createBrowserIpfsUploader } = await import(moduleUrl);
  let endpoint;
  const upload = createBrowserIpfsUploader({
    provider: 'local',
    fetchImpl: async (url) => {
      endpoint = url;
      return new Response(JSON.stringify({ Hash: 'bafydesktop' }), { status: 200 });
    },
  });

  assert.equal(await upload(new File(['{}'], 'meta.json', { type: 'application/json' })), 'ipfs://bafydesktop');
  assert.match(endpoint, /127\.0\.0\.1:5001\/api\/v0\/add/);
});

test('failed artwork upload reports the filename and Pinata rejection reason', async () => {
  const { createBrowserIpfsUploader } = await import(moduleUrl);
  const upload = createBrowserIpfsUploader({ serviceUrl: 'https://worker.example',
    signer: { signMessage: async () => 'signature' }, address: '0x1111111111111111111111111111111111111111', origin: 'https://site.example',
    fetchImpl: async url => url.endsWith('/api/ipfs/upload-url')
      ? new Response(JSON.stringify({ url: 'https://uploads.example/signed' }))
      : new Response(JSON.stringify({ error: { reason: 'File size exceeds signed limit' } }), { status: 400 }),
  });
  await assert.rejects(upload(new File(['image'], 'cover.png', { type: 'image/png' })), /400.*cover\.png.*File size exceeds signed limit/);
});