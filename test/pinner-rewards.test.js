const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const moduleUrl = pathToFileURL(path.join(__dirname, '../js/pinner-rewards.mjs')).href;
const root = 'bafybeidxx4rufx7xrn5lmt3npyaej6doupxajyh53ibb4fp43whdvgfm2u';

test('community pin manifest is CID-normalized and deduplicated by content', async () => {
  const { buildCommunityPinManifest } = await import(moduleUrl);
  const manifest = buildCommunityPinManifest({ checkpointCid: root,
    tracks: [{ ipfsCid: root, title: 'Audio' }, { ipfsCid: 'ipfs://' + root, title: 'Alias' }],
    albumRoots: [{ cid: root, title: 'Album' }] });
  assert.equal(manifest.entryCount, 1);
  assert.deepEqual(manifest.entries[0].kinds.sort(), ['album', 'audio', 'playlist-checkpoint']);
  assert.equal(manifest.rewardStatus, 'not-active');
});

test('pinner reward weights successful verified checks and splits exact total deterministically', async () => {
  const { allocatePinnerRewards } = await import(moduleUrl);
  const wallets = ['1', '2', '3'].map(value => `0x${value.repeat(40)}`);
  const result = allocatePinnerRewards({ fundBalanceUnits: 101n, now: 100000,
    pinners: [
      { wallet: wallets[1], successfulChecks: 60, failedChecks: 0, lastVerifiedAt: new Date(99000).toISOString() },
      { wallet: wallets[0], successfulChecks: 36, failedChecks: 4, lastVerifiedAt: new Date(99000).toISOString() },
      { wallet: wallets[2], successfulChecks: 2, failedChecks: 0, lastVerifiedAt: new Date(99000).toISOString() },
    ] });
  assert.deepEqual(result.eligible.map(entry => entry.wallet), [wallets[0], wallets[1]]);
  assert.equal(result.eligible[0].amountUnits + result.eligible[1].amountUnits, 101n);
  assert.equal(result.eligible[0].amountUnits, 37n);
  assert.equal(result.eligible[1].amountUnits, 64n);
  assert.equal(result.remainingUnits, 0n);
});

test('pinner weights reject stale/low-availability records and reserve the fund when nobody qualifies', async () => {
  const { allocatePinnerRewards } = await import(moduleUrl);
  const result = allocatePinnerRewards({ fundBalanceUnits: 1000n, now: 200000000,
    pinners: [
      { wallet: `0x${'1'.repeat(40)}`, successfulChecks: 100, failedChecks: 0, lastVerifiedAt: new Date(0).toISOString() },
      { wallet: `0x${'2'.repeat(40)}`, successfulChecks: 10, failedChecks: 10, lastVerifiedAt: new Date(199999000).toISOString() },
    ] });
  assert.deepEqual(result.eligible, []);
  assert.equal(result.distributedUnits, 0n);
  assert.equal(result.remainingUnits, 1000n);
});

test('community pinning supports local Kubo and a visitor Pinata key only for the active call', async () => {
  const { pinCommunityManifest } = await import(moduleUrl);
  const manifest = { schemaVersion: 1, entries: [{ cid: root }, { cid: root }] };
  const requests = [];
  const local = await pinCommunityManifest({ manifest, provider: 'local', fetchImpl: async url => {
    requests.push(url.toString());
    return url.toString().includes('/pin/ls')
      ? new Response(JSON.stringify({ Keys: { [root]: { Type: 'recursive' } } }))
      : new Response('{}');
  } });
  assert.equal(local.successes.length, 2);
  assert.equal(requests.filter(url => url.includes('/pin/add')).length, 2);
  assert.equal(requests.filter(url => url.includes('/pin/ls')).length, 2);
  assert.ok(requests.every(url => url.includes('127.0.0.1:5001/api/v0/')));
  requests.length = 0;
  const pinata = await pinCommunityManifest({ manifest, provider: 'pinata', pinataJwt: 'one-session-key', fetchImpl: async (url, options) => {
    requests.push([url, options]); return new Response('{}');
  } });
  assert.equal(pinata.successes.length, 2);
  assert.ok(requests.every(([url, options]) => url === 'https://api.pinata.cloud/pinning/pinByHash' &&
    options.headers.authorization === 'Bearer one-session-key'));
  await assert.rejects(pinCommunityManifest({ manifest, provider: 'pinata' }), /Enter your Pinata API key/);
  const unsafeLocal = await pinCommunityManifest({ manifest, provider: 'local', ipfsApiUrl: 'http://example.com:5001' });
  assert.equal(unsafeLocal.successes.length, 0);
  assert.match(unsafeLocal.failures[0].error, /loopback/);
});
