const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('pinner setup preserves existing settings and pins while adding narrow browser access and NAT mapping', async () => {
  const { pinnerSetupConfig } = await import('../discord-bot/community-pinner-client.js');
  const original = { Addresses: { API: '/ip4/127.0.0.1/tcp/5001', Swarm: ['/ip4/0.0.0.0/tcp/4001'] },
    API: { HTTPHeaders: { 'Access-Control-Allow-Origin': ['https://webui.ipfs.io'], 'X-Custom': ['keep'] } },
    Swarm: { DisableNatPortMap: true }, Datastore: { StorageMax: '25GB' }, Pinning: { RemoteServices: {} } };
  const next = pinnerSetupConfig(original);
  assert.deepEqual(next.API.HTTPHeaders['Access-Control-Allow-Origin'], ['https://webui.ipfs.io', 'https://thejollylama.github.io']);
  assert.deepEqual(next.API.HTTPHeaders['X-Custom'], ['keep']);
  assert.deepEqual(next.Datastore, original.Datastore);
  assert.deepEqual(next.Pinning, original.Pinning);
  assert.deepEqual(next.Addresses, original.Addresses);
  assert.equal(next.Swarm.DisableNatPortMap, false);
  assert.equal(original.Swarm.DisableNatPortMap, true);
  assert.deepEqual(pinnerSetupConfig(next), next, 'setup is idempotent');
  assert.throws(() => pinnerSetupConfig({ Addresses: { API: '/ip4/0.0.0.0/tcp/5001' } }), /loopback/);
  assert.throws(() => pinnerSetupConfig({ ...original, API: { HTTPHeaders: { 'Access-Control-Allow-Origin': ['*'] } } }), /Wildcard/);
});

test('setup writes a private original backup, preserves data and is safe to repeat', async t => {
  const { setupPinnerNode } = await import('../discord-bot/community-pinner-client.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dbusk-setup-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config');
  const original = JSON.stringify({ Addresses: { API: '/ip4/127.0.0.1/tcp/5001' }, Other: 'unchanged' });
  await fs.writeFile(configPath, original);
  const result = await setupPinnerNode({ configPath });
  assert.equal(result.changed, true);
  assert.equal(await fs.readFile(result.backupPath, 'utf8'), original);
  assert.equal((await fs.stat(result.backupPath)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await fs.readFile(configPath)).Other, 'unchanged');
  assert.equal((await setupPinnerNode({ configPath })).changed, false);
  assert.equal((await fs.readdir(directory)).length, 2, 'no extra backups or temporary files on a repeated setup');
});

test('diagnostics distinguish public, private and unavailable without assuming success', async () => {
  const { diagnosePinnerNode } = await import('../discord-bot/community-pinner-client.js');
  for (const reachability of ['Public', 'Private', 'Unknown']) {
    assert.equal(await diagnosePinnerNode({ fetchImpl: async (url, options) => {
      assert.equal(options.method, 'POST');
      assert.equal(new URL(url).hostname, '127.0.0.1');
      return Response.json({ reachability });
    } }), reachability);
  }
  await assert.rejects(diagnosePinnerNode({ ipfsApiUrl: 'http://remote.example:5001' }), /loopback/);
  await assert.rejects(diagnosePinnerNode({ fetchImpl: async () => new Response('', { status: 503 }) }), /503/);
});
