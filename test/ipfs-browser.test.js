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
  await assert.rejects(upload(new File(['image'], 'cover.png', { type: 'image/png' })), /Upload to IPFS failed \(step 2\/2\).*File size exceeds signed limit/);
});

test('browser uploader retries transient upload failures and reports progress', async () => {
  const { createBrowserIpfsUploader } = await import(moduleUrl);
  const progress = [];
  const signed = [];
  let uploads = 0;
  const originalXHR = global.XMLHttpRequest;
  class FakeXHR {
    constructor() {
      this.upload = {};
      this.status = 0;
      this.responseText = '';
      FakeXHR.instances.push(this);
    }
    open(method, url) { this.method = method; this.url = url; }
    send() {
      uploads++;
      this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
      if (uploads === 1) {
        this.onerror?.(new TypeError('Failed to fetch'));
      } else {
        this.status = 200;
        this.responseText = JSON.stringify({ data: { cid: 'bafyretry' } });
        this.onload?.();
      }
    }
  }
  FakeXHR.instances = [];
  global.XMLHttpRequest = FakeXHR;
  try {
    const upload = createBrowserIpfsUploader({
      provider: 'pinata',
      serviceUrl: 'https://worker.example',
      signer: { signMessage: async message => { signed.push(message); return '0xsigned'; } },
      address: '0x1111111111111111111111111111111111111111',
      origin: 'https://busking.example',
      fetchImpl: async (url, options) => {
        if (url.endsWith('/api/ipfs/upload-url')) {
          return new Response(JSON.stringify({ url: `https://uploads.example/${signed.length}` }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url} ${options?.method || ''}`);
      },
      retries: 1,
    });
    assert.equal(await upload(new File(['abc'], 'song.mp3', { type: 'audio/mpeg' }), {
      onProgress: event => progress.push(Math.round(event.progress * 100)),
    }), 'ipfs://bafyretry');
    assert.equal(signed.length, 2);
    assert.equal(uploads, 2);
    assert.ok(progress.includes(50));
  } finally {
    global.XMLHttpRequest = originalXHR;
  }
});

test('browser uploader returns a readable owner-only CORS error', async () => {
  const { createBrowserIpfsUploader } = await import(moduleUrl);
  const upload = createBrowserIpfsUploader({
    provider: 'pinata',
    serviceUrl: 'https://worker.example',
    signer: { signMessage: async () => '0xsigned' },
    address: '0x1111111111111111111111111111111111111111',
    origin: 'https://unlisted.example',
    fetchImpl: async () => new Response(JSON.stringify({ error: 'This site address isn’t authorized for uploads' }), { status: 403 }),
  });
  await assert.rejects(upload(new File(['image'], 'cover.png', { type: 'image/png' })),
    /step 1\/2.*authorized for uploads/);
});
test('image uploads are relabelled to the type their bytes actually contain', async () => {
  const { normalizeImageFileType } = await import(moduleUrl);
  const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
  const mislabelled = new File([jpegBytes], 'cover.png', { type: 'image/png' });
  const fixed = await normalizeImageFileType(mislabelled);
  assert.equal(fixed.type, 'image/jpeg');
  assert.equal(fixed.name, 'cover.jpg');
  assert.equal(fixed.size, mislabelled.size);
  const correct = new File([jpegBytes], 'cover.jpg', { type: 'image/jpeg' });
  assert.equal(await normalizeImageFileType(correct), correct);
  const audio = new File([jpegBytes], 'song.mp3', { type: 'audio/mpeg' });
  assert.equal(await normalizeImageFileType(audio), audio);
});
