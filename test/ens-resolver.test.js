const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const resolverUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'ens-resolver.js')).href;
const workerUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'ipfs-worker.js')).href;
const clientUrl = pathToFileURL(path.join(__dirname, '..', 'js', 'ens-client.mjs')).href;
const ADMIN = '0x807061DF657A7697c04045dA7d16D941861cAABc';
const admin = ADMIN.toLowerCase();

function fakeProvider({ fail = false, calls = [] } = {}) {
  const check = method => { calls.push(method); if (fail) throw new Error('rate limited'); };
  return {
    async lookupAddress(address) { check('lookupAddress'); return address === admin ? 'thejollylama.eth' : null; },
    async resolveName(name) { check('resolveName'); return name === 'thejollylama.eth' || name === 'decentcanopy.eth' ? ADMIN : null; },
    async getResolver() {
      check('getResolver');
      return { getAvatar: async () => 'https://example.com/a.png', getText: async key => (key === 'banner' ? 'ipfs://banner' : '') };
    },
  };
}

async function withServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('ENS RPC urls prefer Alchemy and always keep the public fallback', async () => {
  const { ensRpcUrlsFromEnv } = await import(resolverUrl);
  assert.deepEqual(ensRpcUrlsFromEnv({ ALCHEMY_ETH_URL: 'https://eth-mainnet.g.alchemy.com/v2/k' }),
    ['https://eth-mainnet.g.alchemy.com/v2/k', 'https://ethereum-rpc.publicnode.com']);
  assert.deepEqual(ensRpcUrlsFromEnv({}), ['https://ethereum-rpc.publicnode.com']);
});

test('ENS resolver fails over to the next provider, forward-verifies, and caches', async () => {
  const { createEnsResolver } = await import(resolverUrl);
  const paidCalls = [];
  const publicCalls = [];
  const providers = { paid: fakeProvider({ fail: true, calls: paidCalls }), public: fakeProvider({ calls: publicCalls }) };
  const resolver = createEnsResolver({ urls: ['paid', 'public'], createProvider: url => providers[url] });
  assert.deepEqual(await resolver.lookupAddress(ADMIN), { address: admin, name: 'thejollylama.eth' });
  assert.deepEqual(await resolver.lookupAddress(ADMIN), { address: admin, name: 'thejollylama.eth' });
  assert.deepEqual(publicCalls, ['lookupAddress', 'resolveName']);
  assert.deepEqual(await resolver.resolveName('DecentCanopy.eth'), { name: 'decentcanopy.eth', address: ADMIN });
  assert.deepEqual(await resolver.records('thejollylama.eth'),
    { name: 'thejollylama.eth', avatar: 'https://example.com/a.png', texts: { avatar: '', banner: 'ipfs://banner', header: '' } });
  await assert.rejects(resolver.resolveName('not a name'), /Invalid ENS name/);
});

test('ENS resolver rejects names whose forward record points elsewhere', async () => {
  const { createEnsResolver } = await import(resolverUrl);
  const other = `0x${'2'.repeat(40)}`;
  const resolver = createEnsResolver({ urls: ['x'], createProvider: () => ({
    lookupAddress: async () => 'spoof.eth', resolveName: async () => ADMIN,
  }) });
  assert.deepEqual(await resolver.lookupAddress(other), { address: other, name: null });
});

test('worker ENS routes batch lookups and report RPC failures as 502', async () => {
  const { createEnsResolver } = await import(resolverUrl);
  const { createWorkerRequestHandler } = await import(workerUrl);
  const other = `0x${'3'.repeat(40)}`;
  const ensResolver = createEnsResolver({ urls: ['x'], createProvider: () => fakeProvider() });
  const handler = createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: ADMIN, ensResolver });
  await withServer(handler, async base => {
    const lookup = await fetch(`${base}/api/ens/lookup?addresses=${ADMIN},${other}`);
    assert.equal(lookup.status, 200);
    assert.equal(lookup.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await lookup.json(), { results: { [admin]: 'thejollylama.eth', [other]: null } });
    const resolved = await fetch(`${base}/api/ens/resolve?name=decentcanopy.eth`);
    assert.deepEqual(await resolved.json(), { name: 'decentcanopy.eth', address: ADMIN });
    assert.equal((await fetch(`${base}/api/ens/lookup?addresses=nope`)).status, 400);
    const tooMany = Array.from({ length: 26 }, (_, i) => `0x${String(i).padStart(40, '0')}`).join(',');
    assert.equal((await fetch(`${base}/api/ens/lookup?addresses=${tooMany}`)).status, 400);
  });
  const broken = createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: ADMIN,
    ensResolver: createEnsResolver({ urls: ['x'], createProvider: () => fakeProvider({ fail: true }) }) });
  await withServer(broken, async base => {
    assert.equal((await fetch(`${base}/api/ens/lookup?addresses=${ADMIN}`)).status, 502);
  });
});

test('browser ENS client batches through the worker and falls back to the public RPC', async () => {
  const { lookupEnsName, resolveEnsName, workerEnsProvider, _resetEnsClientCache } = await import(clientUrl);
  const { resolveCreatorENS } = await import(pathToFileURL(path.join(__dirname, '..', 'js', 'creator-profile-data.mjs')).href);
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.window = { DecentConfig: { ipfsUploadServiceUrl: 'https://worker.test/' } };
  try {
    globalThis.fetch = async url => {
      requests.push(String(url));
      if (String(url).includes('/api/ens/lookup')) return { ok: true, json: async () => ({ results: { [admin]: 'thejollylama.eth' } }) };
      if (String(url).includes('/api/ens/records')) return { ok: true, json: async () => ({ name: 'thejollylama.eth', avatar: 'https://a', texts: { banner: 'b' } }) };
      return { ok: false, status: 404 };
    };
    const [one, two] = await Promise.all([lookupEnsName(ADMIN), lookupEnsName(admin)]);
    assert.equal(one, 'thejollylama.eth');
    assert.equal(two, 'thejollylama.eth');
    assert.equal(await resolveEnsName('thejollylama.eth'), admin);
    assert.deepEqual(await resolveCreatorENS(ADMIN, workerEnsProvider), { name: 'thejollylama.eth', avatarURI: 'https://a', bannerURI: 'b' });
    assert.deepEqual(requests, ['https://worker.test/api/ens/lookup?addresses=' + admin, 'https://worker.test/api/ens/records?name=thejollylama.eth']);

    _resetEnsClientCache();
    globalThis.fetch = async () => { throw new Error('offline'); };
    class FallbackProvider {
      async lookupAddress() { return 'thejollylama.eth'; }
      async resolveName() { return ADMIN; }
      destroy() {}
    }
    globalThis.window.ethers = { JsonRpcProvider: FallbackProvider };
    assert.equal(await lookupEnsName(ADMIN), 'thejollylama.eth');
    assert.equal(await resolveEnsName('decentcanopy.eth'), ADMIN);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.window;
    _resetEnsClientCache();
  }
});
