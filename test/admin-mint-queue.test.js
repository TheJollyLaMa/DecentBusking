const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'js', 'admin-mint-queue.js')).href;

test('signs and fetches the owner mint queue', async () => {
  const { buildAdminAuthorizationMessage, fetchMintQueue } = await import(moduleUrl);
  const signed = [];
  let request;
  const queue = await fetchMintQueue({
    serviceUrl: 'https://worker.example/',
    signer: { signMessage: async (message) => { signed.push(message); return '0xsigned'; } },
    address: '0x1111111111111111111111111111111111111111',
    origin: 'https://busking.example',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ requests: [{ trackId: 'track-1' }] }), { status: 200 });
    },
  });

  assert.deepEqual(queue, [{ trackId: 'track-1' }]);
  assert.equal(request.url, 'https://worker.example/api/mint-queue');
  const authorization = JSON.parse(request.options.body);
  assert.equal(authorization.signature, '0xsigned');
  assert.equal(signed[0], buildAdminAuthorizationMessage(authorization));
});