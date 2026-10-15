const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(path.join(__dirname, '../discord-bot/alchemy-webhook.js')).href;
const workerUrl = pathToFileURL(path.join(__dirname, '../discord-bot/ipfs-worker.js')).href;
const KEY = 'whsec_test_signing_key';
const ROUTER = '0x8ecca903aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NFT = '0x1111111111111111111111111111111111111111';
const sign = body => crypto.createHmac('sha256', KEY).update(body).digest('hex');
const customPayload = (...addresses) => JSON.stringify({ webhookId: 'wh_1', id: 'whevt_1', type: 'GRAPHQL',
  event: { data: { block: { logs: addresses.map(address => ({ account: { address }, topics: ['0x' + '0'.repeat(64)] })) } } } });

function manualTimers() {
  const timers = [];
  return { timers, setTimer: fn => { timers.push(fn); return { unref() {} }; }, clearTimer: () => {} };
}

test('signature verification accepts only the exact HMAC of the raw body', async () => {
  const { verifyAlchemySignature } = await import(moduleUrl);
  const body = Buffer.from(customPayload(ROUTER));
  assert.equal(verifyAlchemySignature(body, sign(body), KEY), true);
  assert.equal(verifyAlchemySignature(body, sign(body).toUpperCase(), KEY), true);
  assert.equal(verifyAlchemySignature(Buffer.from(body.toString() + ' '), sign(body), KEY), false);
  assert.equal(verifyAlchemySignature(body, '', KEY), false);
  assert.equal(verifyAlchemySignature(body, 'zz', KEY), false);
  assert.equal(verifyAlchemySignature(body, sign(body), ''), false);
});

test('verified webhooks debounce matching refreshers once; forged or foreign events trigger nothing', async () => {
  const { createAlchemyWebhook } = await import(moduleUrl);
  const calls = [];
  const fund = () => { calls.push('fund'); };
  const payments = () => { calls.push('payments'); return Promise.resolve(); };
  const mints = () => { calls.push('mints'); throw new Error('boom'); };
  const timers = manualTimers();
  const webhook = createAlchemyWebhook({ signingKey: KEY, ...timers, log: { warn() {} }, routes: [
    { label: 'router', addresses: [ROUTER.toUpperCase().replace('0X', '0x')], refresh: [fund, payments] },
    { label: 'nft', addresses: [NFT], refresh: [mints, fund] },
  ] });

  const forged = Buffer.from(customPayload(ROUTER));
  assert.equal(webhook.handle(forged, 'a'.repeat(64)).status, 401);
  assert.equal(webhook.handle(forged, '').status, 401);
  assert.equal(timers.timers.length, 0);

  const foreign = Buffer.from(customPayload('0x' + '9'.repeat(40)));
  assert.deepEqual(webhook.handle(foreign, sign(foreign)), { status: 200, body: { ok: true, matched: [] } });
  assert.equal(timers.timers.length, 0);

  const first = Buffer.from(customPayload(ROUTER));
  const second = Buffer.from(customPayload(NFT, ROUTER));
  assert.deepEqual(webhook.handle(first, sign(first)).body.matched, ['router']);
  assert.deepEqual(webhook.handle(second, sign(second)).body.matched.sort(), ['nft', 'router']);
  assert.equal(timers.timers.length, 1, 'bursts share one debounce timer');
  timers.timers[0]();
  assert.deepEqual(calls.sort(), ['fund', 'mints', 'payments'], 'each refresher runs once even when several contracts fire');

  const health = webhook.health();
  assert.equal(health.configured, true);
  assert.equal(health.verified, 3);
  assert.equal(health.rejected, 2);
  assert.equal(health.triggered, 2);
  assert.ok(health.lastEventAt);
});

test('address activity payloads are routed by contract address', async () => {
  const { webhookAddresses } = await import(moduleUrl);
  const found = webhookAddresses({ event: { network: 'BASE_MAINNET', activity: [
    { fromAddress: '0x' + '2'.repeat(40), toAddress: ROUTER, rawContract: { address: '0x' + '3'.repeat(40) } },
  ] } });
  assert.ok(found.has(ROUTER));
  assert.ok(found.has('0x' + '3'.repeat(40)));
});

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

test('worker route verifies the raw body and reports webhook health', async () => {
  const { createAlchemyWebhook } = await import(moduleUrl);
  const { createWorkerRequestHandler } = await import(workerUrl);
  const triggered = [];
  const timers = manualTimers();
  const alchemyWebhook = createAlchemyWebhook({ signingKey: KEY, ...timers,
    routes: [{ label: 'router', addresses: [ROUTER], refresh: [() => triggered.push('router')] }] });
  const server = await serve(createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: '0x' + '0'.repeat(40), alchemyWebhook,
    getRpcHealth: () => ({ mode: 'normal' }) }));
  try {
    const body = customPayload(ROUTER);
    const ok = await fetch(`${server.base}/api/webhooks/alchemy`, { method: 'POST', body,
      headers: { 'content-type': 'application/json', 'x-alchemy-signature': sign(body) } });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).matched, ['router']);
    const bad = await fetch(`${server.base}/api/webhooks/alchemy`, { method: 'POST', body,
      headers: { 'content-type': 'application/json', 'x-alchemy-signature': sign(body + 'x') } });
    assert.equal(bad.status, 401);
    timers.timers.forEach(fn => fn());
    assert.deepEqual(triggered, ['router']);
    const health = await (await fetch(`${server.base}/api/rpc-health`)).json();
    assert.equal(health.mode, 'normal');
    assert.equal(health.webhook.verified, 1);
    assert.equal(health.webhook.rejected, 1);
  } finally {
    await server.close();
  }
});

test('worker route is absent when webhooks are not configured', async () => {
  const { createWorkerRequestHandler } = await import(workerUrl);
  const server = await serve(createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: '0x' + '0'.repeat(40) }));
  try {
    const response = await fetch(`${server.base}/api/webhooks/alchemy`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 404);
  } finally {
    await server.close();
  }
});
