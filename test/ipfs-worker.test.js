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

test('payment ledger is public but reconciliation requires an allowed origin and a valid hash', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const hashes = [];
  const handler = createWorkerRequestHandler({ allowedOrigins: ['https://busking.example'], ownerWallet: Wallet.createRandom().address,
    getPaymentLedger: () => ({ chainId: 8453, entries: [] }),
    reconcilePayment: async hash => { hashes.push(hash); return { pending: false, entries: [] }; } });
  await withServer(handler, async base => {
    const response = await fetch(`${base}/api/payroll/ledger`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const txHash = `0x${'1'.repeat(64)}`;
    for (const [origin, hash, expected] of [['https://other.example', txHash, 400], ['https://busking.example', 'bad', 400], ['https://busking.example', txHash, 200]]) {
      const result = await fetch(`${base}/api/payroll/reconcile`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ txHash: hash }) });
      assert.equal(result.status, expected);
    }
    assert.deepEqual(hashes, [txHash]);
  });
});

test('weekly payflow endpoint filters artists and New York history calendar is explicit', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const wallet = Wallet.createRandom().address;
  const handler = createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: wallet,
    getWeeklyPayflow: options => ({ ready: true, timeZone: 'America/New_York', wallet: options.wallet }),
    getRadioHistory: options => [{ calendar: options.calendar }] });
  await withServer(handler, async base => {
    const response = await fetch(`${base}/api/payroll/weekly?wallet=${wallet}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).wallet, wallet);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal((await fetch(`${base}/api/payroll/weekly?wallet=bad`)).status, 400);
    const history = await (await fetch(`${base}/api/radio/history?calendar=new-york`)).json();
    assert.equal(history.weeks[0].calendar, 'new-york');
  });
});

test('artwork CID validation normalizes file CIDs without imposing an attachment-size limit', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const cid = 'bafybeieupiamdn7e4qmi4hou6zfu4cwluoubn6ppgsqs4rfjydyee7wtnm';
  const handler = createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: Wallet.createRandom().address });
  await withServer(handler, async base => {
    for (const value of [cid, `ipfs://${cid}`]) {
      const response = await fetch(`${base}/api/ipfs/artwork-cid?${new URLSearchParams({ cid: value })}`);
      assert.equal(response.status, 200); assert.equal((await response.json()).cid, cid);
    }
    for (const value of ['bad', `${cid}/image.gif`, `https://example.org/${cid}`]) {
      assert.equal((await fetch(`${base}/api/ipfs/artwork-cid?${new URLSearchParams({ cid: value })}`)).status, 400);
    }
  });
});

test('worker issues a Pinata URL only for a fresh owner signature', async () => {
  const { buildUploadAuthorizationMessage, createWorkerRequestHandler } = await import(moduleUrl);
  const owner = Wallet.createRandom();
  const issuedAt = '2026-10-01T12:00:00.000Z';
  const authorization = {
    address: owner.address,
    origin: 'https://busking.example',
    name: 'performance.mp4',
    size: 12 * 1024 * 1024,
    type: 'video/mp4',
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
      const request = JSON.parse(options.body);
      assert.deepEqual(request.allow_mime_types, ['video/mp4']);
      assert.equal(request.max_file_size, authorization.size + 64 * 1024);
      assert.equal('mime_types' in request, false);
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

test('artist MP4 uploads use separate authorization and cannot access owner upload permissions', async () => {
  const { buildUploadAuthorizationMessage, createWorkerRequestHandler } = await import(moduleUrl);
  const artist = Wallet.createRandom();
  const issuedAt = '2026-10-05T12:00:00Z';
  const origin = 'https://busking.example';
  const payload = { address: artist.address, origin, issuedAt, name: 'performance.mp4',
    type: 'video/mp4', size: 12 * 1024 * 1024, purpose: 'submission' };
  const signature = await artist.signMessage(buildUploadAuthorizationMessage(payload));
  const handler = createWorkerRequestHandler({ allowedOrigins: [origin], ownerWallet: Wallet.createRandom().address,
    now: () => Date.parse(issuedAt), pinataJwt: 'secret',
    fetchImpl: async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body).allow_mime_types, ['video/mp4']);
      return new Response(JSON.stringify({ data: 'https://uploads.example/signed' }));
    } });
  await withServer(handler, async baseUrl => {
    const post = (endpoint, body) => fetch(`${baseUrl}/api/ipfs/${endpoint}`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await post('upload-url', { ...payload, signature })).status, 400);
    assert.equal((await post('submission-upload-url', { ...payload, signature })).status, 200);
    assert.equal((await post('submission-upload-url', { ...payload, signature })).status, 400);
    assert.equal((await post('submission-upload-url', { ...payload, signature, size: 51 * 1024 * 1024 })).status, 400);
  });
});

test('signed CID submissions validate the artist, media, expiry, origin, and replay protection', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const mediaModule = pathToFileURL(path.join(__dirname, '../discord-bot/media.js')).href;
  const { buildSubmissionAuthorizationMessage } = await import(mediaModule);
  const browserModule = pathToFileURL(path.join(__dirname, '../js/mint-submission.js')).href;
  const browser = await import(browserModule);
  const artist = Wallet.createRandom();
  const other = Wallet.createRandom();
  const origin = 'https://busking.example';
  const issuedAt = '2026-10-05T12:00:00Z';
  const payload = { address: artist.address, origin, issuedAt, title: 'Performance', artist: 'Artist',
    ipfsCid: 'bafybeifynaihnl2t37s3nfez3k5vbwwziaqyvayadqwt4bou3yv6jstxye',
    mediaType: 'video/mp4', filename: 'performance.mp4', recipient: artist.address,
    artworkCid: '', tipWallet: artist.address, parentTokenId: 7 };
  assert.equal(browser.buildSubmissionAuthorizationMessage(payload), buildSubmissionAuthorizationMessage(payload));
  const submissions = [];
  const handler = createWorkerRequestHandler({ allowedOrigins: [origin], ownerWallet: other.address,
    now: () => Date.parse(issuedAt), onMediaSubmission: async submission => {
      submissions.push(submission);
      return { trackId: 'queued-video', mintStatus: 'requested' };
    } });
  await withServer(handler, async baseUrl => {
    const post = async (body, requestOrigin = origin, signer = artist) => fetch(`${baseUrl}/api/media/submit`, {
      method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, signature: await signer.signMessage(buildSubmissionAuthorizationMessage(body)) }),
    });
    const accepted = await post(payload);
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { trackId: 'queued-video', status: 'requested' });
    assert.equal(submissions[0].mediaType, 'video/mp4');
    assert.equal(submissions[0].parentTokenId, 7);
    assert.equal((await post(payload)).status, 400);
    for (const invalid of [
      { ...payload, recipient: Wallet.createRandom().address },
      { ...payload, ipfsCid: `${payload.ipfsCid}/movie.mp4` },
      { ...payload, ipfsCid: 'not-a-cid' },
      { ...payload, filename: 'movie.mp3' },
      { ...payload, issuedAt: '2026-10-01T00:00:00Z' },
      { ...payload, parentTokenId: -1 },
    ]) assert.equal((await post(invalid)).status, 400);
    assert.equal((await post({ ...payload, title: 'Forged' }, origin, other)).status, 400);
    assert.equal((await post(payload, 'https://other.example')).status, 400);
    assert.equal(submissions.length, 1);
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

test('accepts owner mints routed through a smart-account delegation contract', async () => {
  const { createMintTransactionVerifier } = await import(moduleUrl);
  const owner = '0x1111111111111111111111111111111111111111';
  const recipient = '0x2222222222222222222222222222222222222222';
  const contract = '0x3333333333333333333333333333333333333333';
  const delegationManager = '0x4444444444444444444444444444444444444444';
  const iface = new Interface([
    'event EditionMinted(uint256 indexed tokenId, address indexed to, uint256 amount, address indexed minter)',
  ]);
  const verifierFor = (minter, logAddress = contract) => {
    const encoded = iface.encodeEventLog(iface.getEvent('EditionMinted'), [8, recipient, 1, minter]);
    return createMintTransactionVerifier({
      contractAddress: contract,
      ownerWallet: owner,
      provider: {
        getTransaction: async () => ({ from: owner, to: delegationManager }),
        getTransactionReceipt: async () => ({
          status: 1,
          logs: [{ address: logAddress, topics: encoded.topics, data: encoded.data }],
        }),
      },
    });
  };
  const txHash = `0x${'cd'.repeat(32)}`;

  assert.deepEqual(await verifierFor(owner)({ tokenId: '8', txHash }), { recipient, amount: '1' });
  await assert.rejects(verifierFor(recipient)({ tokenId: '8', txHash }), /not minted by the configured owner/);
  await assert.rejects(verifierFor(owner, delegationManager)({ tokenId: '8', txHash }), /does not contain the claimed EditionMinted/);
});

test('returns the pending queue only to the mint owner', async () => {
  const { buildAdminAuthorizationMessage, createWorkerRequestHandler } = await import(moduleUrl);
  const owner = Wallet.createRandom();
  const issuedAt = '2026-10-01T12:00:00.000Z';
  const authorization = {
    address: owner.address,
    origin: 'https://busking.example',
    issuedAt,
  };
  const signature = await owner.signMessage(buildAdminAuthorizationMessage(authorization));
  const handler = createWorkerRequestHandler({
    allowedOrigins: [authorization.origin],
    ownerWallet: owner.address,
    pinataJwt: 'server-secret',
    now: () => Date.parse(issuedAt),
    getMintQueue: async () => [{ trackId: 'track-1', title: 'Track One' }],
  });

  await withServer(handler, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/mint-queue`, {
      method: 'POST',
      headers: { origin: authorization.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ ...authorization, signature }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).requests, [{ trackId: 'track-1', title: 'Track One' }]);
  });
});

test('public health check is readable from local and hosted dapp origins', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const handler = createWorkerRequestHandler({
    allowedOrigins: ['https://busking.example'],
    ownerWallet: '0x1111111111111111111111111111111111111111',
    pinataJwt: 'server-secret',
  });

  await withServer(handler, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { origin: 'http://localhost:4173' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await response.json(), { ok: true, ipfsProvider: 'pinata' });
  });
});
test('radio state is public and readable from any dapp origin', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const handler = createWorkerRequestHandler({
    allowedOrigins: ['https://busking.example'],
    ownerWallet: '0x1111111111111111111111111111111111111111',
    getRadioState: async () => ({ serverTime: 1, nowPlaying: null, recent: [] }),
  });

  await withServer(handler, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/radio`, { headers: { origin: 'http://localhost:4173' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await response.json(), { serverTime: 1, nowPlaying: null, recent: [] });
  });
});

test('radio votes need no wallet but require an allowed origin', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const ballots = [];
  const handler = createWorkerRequestHandler({
    allowedOrigins: ['https://busking.example'],
    ownerWallet: '0x1111111111111111111111111111111111111111',
    onRadioVote: (ballot) => { ballots.push(ballot); return { ...ballot, duplicate: false }; },
  });
  await withServer(handler, async (baseUrl) => {
    const body = JSON.stringify({ playId: 'track:1000', voterId: 'browser-123456789', vote: 1 });
    const accepted = await fetch(`${baseUrl}/api/radio/vote`, {
      method: 'POST', headers: { origin: 'https://busking.example', 'content-type': 'application/json' }, body,
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get('access-control-allow-origin'), 'https://busking.example');
    assert.equal((await accepted.json()).vote, 1);
    const rejected = await fetch(`${baseUrl}/api/radio/vote`, {
      method: 'POST', headers: { origin: 'https://other.example', 'content-type': 'application/json' }, body,
    });
    assert.equal(rejected.status, 400);
    assert.equal(ballots.length, 1);
  });
});

test('weekly radio history is public and clamps the requested range', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  let receivedWeeks;
  let receivedWallet;
  let receivedAllTime;
  const handler = createWorkerRequestHandler({
    allowedOrigins: [],
    ownerWallet: '0x1111111111111111111111111111111111111111',
    getRadioHistory: async ({ weeks, wallet, includeAllTime }) => { receivedWeeks = weeks; receivedWallet = wallet; receivedAllTime = includeAllTime; return [{ week: '2026-W41', totalPlays: 4 }]; },
  });
  await withServer(handler, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/radio/history?weeks=500&wallet=0x1111111111111111111111111111111111111111`, { headers: { origin: 'http://localhost:8765' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await response.json(), { weeks: [{ week: '2026-W41', totalPlays: 4 }] });
    assert.equal(receivedWeeks, 52);
    assert.equal(receivedWallet, '0x1111111111111111111111111111111111111111');
    assert.equal(receivedAllTime, false);
    const allTime = await fetch(`${baseUrl}/api/radio/history?includeAllTime=1&wallet=0x1111111111111111111111111111111111111111`);
    assert.equal(allTime.status, 200);
    assert.equal(receivedAllTime, true);
    assert.equal(receivedWallet, '0x1111111111111111111111111111111111111111');
    const invalid = await fetch(`${baseUrl}/api/radio/history?wallet=not-a-wallet`);
    assert.equal(invalid.status, 400);
  });
});
