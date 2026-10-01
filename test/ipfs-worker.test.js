const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const botRequire = createRequire(path.join(__dirname, '..', 'discord-bot', 'package.json'));
const { Interface, Wallet } = botRequire('ethers');
const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'ipfs-worker.js')).href;

async function withServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('worker issues a Pinata URL only for a fresh owner signature', async () => {
  const { buildUploadAuthorizationMessage, createWorkerRequestHandler } = await import(moduleUrl);
  const owner = Wallet.createRandom();
  const issuedAt = '2026-10-01T12:00:00.000Z';
  const authorization = {
    address: owner.address,
    origin: 'https://busking.example',
    name: 'cover.png',
    size: 5,
    type: 'image/png',
    issuedAt,
  };
  const signature = await owner.signMessage(buildUploadAuthorizationMessage(authorization));
  const handler = createWorkerRequestHandler({
    allowedOrigins: [authorization.origin],
    ownerWallet: owner.address,
    pinataJwt: 'server-secret',
    now: () => Date.parse(issuedAt),
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.authorization, 'Bearer server-secret');
      return new Response(JSON.stringify({ data: 'https://uploads.pinata.example/signed' }), { status: 200 });
    },
  });

  await withServer(handler, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ipfs/upload-url`, {
      method: 'POST',
      headers: { origin: authorization.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ ...authorization, signature }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).url, 'https://uploads.pinata.example/signed');

    const replay = await fetch(`${baseUrl}/api/ipfs/upload-url`, {
      method: 'POST',
      headers: { origin: authorization.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ ...authorization, signature }),
    });
    assert.equal(replay.status, 400);
    assert.match((await replay.json()).error, /already been used/);
  });
});

test('worker rejects a valid signature from a non-owner wallet', async () => {
  const { buildUploadAuthorizationMessage, createWorkerRequestHandler } = await import(moduleUrl);
  const owner = Wallet.createRandom();
  const stranger = Wallet.createRandom();
  const issuedAt = '2026-10-01T12:00:00.000Z';
  const authorization = {
    address: stranger.address,
    origin: 'https://busking.example',
    name: 'cover.png',
    size: 5,
    type: 'image/png',
    issuedAt,
  };
  const signature = await stranger.signMessage(buildUploadAuthorizationMessage(authorization));
  const handler = createWorkerRequestHandler({
    allowedOrigins: [authorization.origin],
    ownerWallet: owner.address,
    pinataJwt: 'server-secret',
    now: () => Date.parse(issuedAt),
    fetchImpl: async () => { throw new Error('Pinata must not be called'); },
  });

  await withServer(handler, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ipfs/upload-url`, {
      method: 'POST',
      headers: { origin: authorization.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ ...authorization, signature }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /not from the mint owner/);
  });
});

test('worker reconciles only a verified Base mint transaction', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const completions = [];
  const txHash = `0x${'ab'.repeat(32)}`;
  const handler = createWorkerRequestHandler({
    allowedOrigins: ['https://busking.example'],
    ownerWallet: '0x1111111111111111111111111111111111111111',
    pinataJwt: 'server-secret',
    verifyMintTransaction: async ({ tokenId, txHash: receivedHash }) => {
      assert.equal(tokenId, '42');
      assert.equal(receivedHash, txHash);
      return { recipient: '0x2222222222222222222222222222222222222222' };
    },
    onMintComplete: async (completion) => completions.push(completion),
  });

  await withServer(handler, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/mint-complete`, {
      method: 'POST',
      headers: { origin: 'https://busking.example', 'content-type': 'application/json' },
      body: JSON.stringify({ trackId: 'track-1', tokenId: '42', txHash }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(completions, [{
      trackId: 'track-1',
      tokenId: '42',
      txHash,
      recipient: '0x2222222222222222222222222222222222222222',
    }]);
  });
});

test('verifies the owner transaction and EditionMinted event on Base', async () => {
  const { createMintTransactionVerifier } = await import(moduleUrl);
  const owner = '0x1111111111111111111111111111111111111111';
  const recipient = '0x2222222222222222222222222222222222222222';
  const contract = '0x3333333333333333333333333333333333333333';
  const txHash = `0x${'ab'.repeat(32)}`;
  const iface = new Interface([
    'event EditionMinted(uint256 indexed tokenId, address indexed to, uint256 amount, address indexed minter)',
  ]);
  const encoded = iface.encodeEventLog(iface.getEvent('EditionMinted'), [42, recipient, 1, owner]);
  const verify = createMintTransactionVerifier({
    contractAddress: contract,
    ownerWallet: owner,
    provider: {
      getTransaction: async () => ({ from: owner, to: contract }),
      getTransactionReceipt: async () => ({
        status: 1,
        logs: [{ address: contract, topics: encoded.topics, data: encoded.data }],
      }),
    },
  });

  assert.deepEqual(await verify({ tokenId: '42', txHash }), { recipient, amount: '1' });
});