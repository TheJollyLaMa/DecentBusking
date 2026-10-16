const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Wallet } = require('../discord-bot/node_modules/ethers');

test('campaign removals persist before applying, survive restart and fail closed before restore', async () => {
  const { createDevertRemovals } = await import('../discord-bot/devert-removals.js');
  let saved;
  let fail = true;
  const options = { restore: async () => saved, save: async value => {
    if (fail) throw new Error('Pinata unavailable');
    saved = structuredClone(value);
    return 'ipfs://removals';
  } };
  const store = createDevertRemovals(options);
  assert.throws(() => store.isRemoved('1'), /unavailable/);
  await store.initialize();
  const payload = { campaignId: '1', address: Wallet.createRandom().address };
  await assert.rejects(store.remove(payload), /Pinata unavailable/);
  assert.equal(store.isRemoved('1'), false);
  fail = false;
  await Promise.all([store.remove(payload), store.remove(payload)]);
  assert.equal(saved.removals.length, 1);
  const restarted = createDevertRemovals(options);
  await restarted.initialize();
  assert.equal(restarted.isRemoved('1'), true);
  assert.equal(restarted.isRemoved('2'), false);
});

test('removal authorization binds campaign, origin, signer and time; advertiser and owner can remove', async () => {
  const { createWorkerRequestHandler } = await import('../discord-bot/ipfs-worker.js');
  const { buildDevertRemovalMessage } = await import('../js/devert-campaigns.mjs');
  const owner = Wallet.createRandom();
  const advertiser = Wallet.createRandom();
  const stranger = Wallet.createRandom();
  const origin = 'https://example.test';
  const now = Date.now();
  const calls = [];
  const handler = createWorkerRequestHandler({ allowedOrigins: [origin], ownerWallet: owner.address, now: () => now,
    getDevertState: async () => ({ campaigns: [{ campaignId: '1', advertiser: advertiser.address }] }),
    removeDevertCampaign: async payload => { calls.push(payload); return payload; } });
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/devert/remove`;
    const signed = async (wallet, overrides = {}) => {
      const body = { address: wallet.address, origin, campaignId: '1', issuedAt: new Date(now).toISOString(), ...overrides };
      return { ...body, signature: await wallet.signMessage(buildDevertRemovalMessage(body)) };
    };
    const post = body => fetch(url, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post(await signed(stranger))).status, 400);
    assert.equal((await post({ ...await signed(advertiser), campaignId: '2' })).status, 400);
    assert.equal((await post(await signed(advertiser, { origin: 'https://wrong.test' }))).status, 400);
    assert.equal((await post(await signed(advertiser, { issuedAt: new Date(now - 600_000).toISOString() }))).status, 400);
    const authorization = await signed(advertiser);
    assert.equal((await post(authorization)).status, 200);
    assert.equal((await post(authorization)).status, 400);
    assert.equal((await post(await signed(owner))).status, 200);
    assert.equal(calls.length, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('paid terms remain active when removed and become reusable exactly at expiry', async () => {
  const { activeDevertCampaign } = await import('../js/devert-campaigns.mjs');
  const address = Wallet.createRandom().address;
  const campaign = { campaignId: '1', advertiser: address, audioURI: 'ipfs://media',
    startedAt: new Date(1000).toISOString(), expiresAt: new Date(2000).toISOString(), removed: true };
  assert.equal(activeDevertCampaign([campaign], address.toLowerCase(), 'ipfs://media', 1999), campaign);
  assert.equal(activeDevertCampaign([campaign], address, 'ipfs://media', 2000), null);
});
