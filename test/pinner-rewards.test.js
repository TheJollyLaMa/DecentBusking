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

test('pinner awards reject duplicate wallets and never qualify future verification times', async () => {
  const { allocatePinnerRewards } = await import(moduleUrl);
  const pinner = { wallet: `0x${'1'.repeat(40)}`, successfulChecks: 20, failedChecks: 0,
    lastVerifiedAt: new Date(100001).toISOString() };
  assert.equal(allocatePinnerRewards({ fundBalanceUnits: 100n, pinners: [pinner], now: 100000 }).distributedUnits, 0n);
  assert.throws(() => allocatePinnerRewards({ fundBalanceUnits: 100n,
    pinners: [pinner, { ...pinner, wallet: pinner.wallet.toUpperCase().replace('0X', '0x') }], now: 100002 }), /Duplicate wallet/);
});

test('node ownership bytes stay local and a mismatched marker CID fails setup', async () => {
  const { pinPinnerOwnership, readLocalPinnerPeer } = await import(moduleUrl);
  const requests = [];
  const ownership = { cid: root, contentBase64: Buffer.from('unique ownership marker').toString('base64') };
  const fetchImpl = async (url, options) => {
    requests.push(String(url));
    if (String(url).endsWith('/id')) return new Response(JSON.stringify({ ID: 'Qm' + '1'.repeat(44) }));
    assert.equal(options.headers, undefined);
    assert.equal(await options.body.get('file').text(), 'unique ownership marker');
    return new Response(JSON.stringify({ Hash: root }));
  };
  await readLocalPinnerPeer({ fetchImpl });
  await pinPinnerOwnership({ ownership, fetchImpl });
  assert.ok(requests.every(url => url.startsWith('http://127.0.0.1:5001/api/v0/')));
  await assert.rejects(pinPinnerOwnership({ ownership, fetchImpl: async () => new Response('{"Hash":"wrong"}') }), /different ownership marker CID/);
});

test('local pinning imports a hash-verified gateway CAR when the DHT cannot find new content', async () => {
  const { pinCommunityManifest } = await import(moduleUrl);
  const manifest = { schemaVersion: 1, entries: [{ cid: root }] };
  const car = new Uint8Array([0x3a, 0xa2, 0x65, 0x72, 0x6f, 0x6f, 0x74, 0x73]);
  const run = async ({ importedRoot = root, carGatewayUrl } = {}) => {
    const requests = [];
    let pinned = false;
    const result = await pinCommunityManifest({ manifest, provider: 'local', carGatewayUrl, fetchImpl: async (url, options = {}) => {
      requests.push(url);
      if (url.includes('/pin/add')) throw new Error('The operation was aborted due to timeout');
      if (url.startsWith('https://gateway.pinata.cloud/ipfs/')) {
        return new Response(car, { headers: { 'content-type': 'application/vnd.ipld.car; version=1' } });
      }
      if (url.includes('/dag/import')) {
        assert.equal(options.duplex, 'half');
        const body = new Uint8Array(await new Response(options.body).arrayBuffer());
        const boundary = options.headers['content-type'].split('boundary=')[1];
        assert.match(new TextDecoder().decode(body), new RegExp(`^--${boundary}\r\nContent-Disposition: form-data; name="file"`));
        assert.ok(Buffer.from(body).includes(Buffer.from(car)));
        pinned = importedRoot === root;
        return new Response(`${JSON.stringify({ Root: { Cid: { '/': importedRoot }, PinErrorMsg: '' } })}\n`);
      }
      if (url.includes('/pin/ls')) return new Response(JSON.stringify({ Keys: pinned ? { [root]: { Type: 'recursive' } } : {} }));
      throw new Error(`Unexpected request ${url}`);
    } });
    return { result, requests };
  };
  const imported = await run();
  assert.deepEqual(imported.result.successes, [root]);
  assert.ok(imported.requests.includes(`https://gateway.pinata.cloud/ipfs/${root}?format=car&dag-scope=all`));
  assert.ok(imported.requests.some(url => url === 'http://127.0.0.1:5001/api/v0/dag/import?pin-roots=true'));
  const wrongRoot = await run({ importedRoot: 'bafkreiafo5gq6gwkoyvpeg4omvgxvo2dcj3s3wbh2m4qtld5jk4mjhpv4u' });
  assert.match(wrongRoot.result.failures[0].error, /timeout; verified gateway copy failed: gateway CAR root does not match/);
  const disabled = await run({ carGatewayUrl: '' });
  assert.equal(disabled.result.failures[0].error, 'The operation was aborted due to timeout');
  assert.ok(!disabled.requests.some(url => url.includes('gateway')));
});

test('the community sync helper pins new manifest content and fails explicitly when the manifest is unavailable', async () => {
  const { createCommunityPinnerClient } = await import('../discord-bot/community-pinner-client.js');
  const poll = createCommunityPinnerClient({ fetchImpl: async url => {
    if (url.endsWith('/manifest')) return new Response(JSON.stringify({ schemaVersion: 1, entries: [{ cid: root }] }));
    if (url.includes('/pin/ls')) return new Response(JSON.stringify({ Keys: { [root]: { Type: 'recursive' } } }));
    return new Response('{}');
  } });
  assert.deepEqual((await poll()).successes, [root]);
  await assert.rejects(createCommunityPinnerClient({ fetchImpl: async () => new Response('', { status: 503 }) })(), /manifest unavailable/);
});
