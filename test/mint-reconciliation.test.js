const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'js', 'mint-reconciliation.js')).href;

test('reports a confirmed mint receipt to the configured worker', async () => {
  const { reportMintCompletion } = await import(moduleUrl);
  let request;
  const reported = await reportMintCompletion({
    serviceUrl: 'https://worker.example/',
    trackId: 'track-1',
    tokenId: 42,
    txHash: `0x${'ab'.repeat(32)}`,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  assert.equal(reported, true);
  assert.equal(request.url, 'https://worker.example/api/mint-complete');
  assert.deepEqual(JSON.parse(request.options.body), {
    trackId: 'track-1',
    tokenId: '42',
    txHash: `0x${'ab'.repeat(32)}`,
  });
});

test('skips reconciliation for manual mints without a queued track', async () => {
  const { reportMintCompletion } = await import(moduleUrl);
  assert.equal(await reportMintCompletion({ tokenId: 42, txHash: `0x${'ab'.repeat(32)}` }), false);
});