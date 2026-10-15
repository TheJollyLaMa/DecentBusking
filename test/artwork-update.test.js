const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const vm = require('node:vm');

const { Interface, Wallet } = createRequire(path.join(__dirname, '../discord-bot/package.json'))('ethers');

const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'js', 'artwork-update.mjs')).href;
const workerUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'ipfs-worker.js')).href;

test('artwork update metadata only replaces the image and creator wallets are checked directly', async () => {
  const { buildArtworkUpdateAuthorizationMessage, buildArtworkUpdateMetadata, canEditArtwork } = await import(moduleUrl);
  const metadata = { name: 'Track', image: 'ipfs://old', audioUrl: 'ipfs://audio' };
  assert.deepEqual(buildArtworkUpdateMetadata(metadata, 'ipfs://new'), { name: 'Track', image: 'ipfs://new', audioUrl: 'ipfs://audio' });
  assert.equal(canEditArtwork({ creator: '0xabc' }, '0xabc'), true);
  assert.equal(canEditArtwork({ creator: '0xabc' }, '0xdef'), false);
  assert.match(buildArtworkUpdateAuthorizationMessage({
    address: '0x1111111111111111111111111111111111111111',
    origin: 'https://site.example',
    contractAddress: '0x2222222222222222222222222222222222222222',
    tokenId: 7,
    artworkCid: 'bafynew',
    nonce: 'nonce',
    issuedAt: '2026-10-15T00:00:00.000Z',
    expiresAt: '2026-10-15T00:05:00.000Z',
  }), /Artwork CID: bafynew/);
});

test('artwork update queue replaces pending requests for the same token and records completion', async () => {
  const { createArtworkUpdateQueue } = await import(pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'artwork-updates.js')).href);
  const queue = createArtworkUpdateQueue({ restore: async () => [], save: async () => {} });
  await queue.initialize();
  const first = await queue.queueRequest({ tokenId: 7, contractAddress: '0x2222222222222222222222222222222222222222', creator: '0x1', title: 'Track', newImageCid: 'bafy-old' });
  const second = await queue.queueRequest({ tokenId: 7, contractAddress: '0x2222222222222222222222222222222222222222', creator: '0x1', title: 'Track', newImageCid: 'bafy-new' });
  assert.equal(first.status, 'superseded');
  assert.equal(second.status, 'pending');
  assert.equal(queue.getPendingRequests().length, 1);
  const completed = await queue.completeRequest(second.requestId, { txHash: '0xhash', metadataUri: 'ipfs://meta' });
  assert.equal(completed.status, 'completed');
  assert.equal(queue.getPendingCount(), 0);
  const rejected = await queue.rejectRequest(first.requestId, 'nope');
  assert.equal(rejected.status, 'rejected');
});

test('artwork update completion verifier requires the expected URI event from the owner wallet', async () => {
  const { createArtworkUpdateTransactionVerifier } = await import(workerUrl);
  const iface = new Interface(['event URI(string value,uint256 indexed id)']);
  const event = iface.encodeEventLog(iface.getEvent('URI'), ['ipfs://new-meta', 7n]);
  const verifier = createArtworkUpdateTransactionVerifier({
    ownerWallet: '0x1111111111111111111111111111111111111111',
    provider: {
      getTransaction: async () => ({ from: '0x1111111111111111111111111111111111111111' }),
      getTransactionReceipt: async () => ({ status: 1, hash: '0xhash', logs: [{ address: '0x2222222222222222222222222222222222222222', ...event }] }),
    },
    contractAddress: '0x2222222222222222222222222222222222222222',
  });
  await assert.deepEqual(await verifier({ tokenId: 7, txHash: '0xhash', expectedUri: 'ipfs://new-meta' }), {
    metadataUri: 'ipfs://new-meta',
    contractAddress: '0x2222222222222222222222222222222222222222',
    txHash: '0xhash',
  });
  await assert.rejects(verifier({ tokenId: 7, txHash: '0xhash', expectedUri: 'ipfs://different' }), /does not match/);
});

test('browser artwork uploads sign bare CIDs and the worker accepts current and legacy signatures', async (t) => {
  const { submitArtworkUpdateRequest, buildArtworkUpdateAuthorizationMessage } = await import(moduleUrl);
  const { createBrowserIpfsUploader } = await import('../js/ipfs-upload.js');
  const { createWorkerRequestHandler, buildAdminAuthorizationMessage } = await import(workerUrl);
  const { createArtworkUpdateQueue } = await import('../discord-bot/artwork-updates.js');
  const { normalizeMediaCid } = await import('../discord-bot/media.js');
  const creator = Wallet.createRandom();
  const stranger = Wallet.createRandom();
  const origin = 'https://busking.example';
  const contractAddress = '0x2222222222222222222222222222222222222222';
  const cid = 'bafybeieupiamdn7e4qmi4hou6zfu4cwluoubn6ppgsqs4rfjydyee7wtnm';
  const cidV0 = 'QmYwAPJzv5CZsnAzt8auVZRnGiRAzN7VwG2DkJk1F2vHjM';
  const metadata = { name: 'Track', image: 'ipfs://old', animation_url: 'ipfs://audio' };
  const iface = new Interface(['function creatorOf(uint256) view returns (address)', 'function uri(uint256) view returns (string)']);
  let creatorChecks = 0;
  const serve = async handler => {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const rpcUrl = await serve(async (req, res) => {
    let data = '';
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    const reply = call => {
      let result = '0x2105';
      if (call.method === 'eth_call') {
        const name = iface.parseTransaction({ data: call.params[0].data }).name;
        if (name === 'creatorOf') creatorChecks++;
        result = iface.encodeFunctionResult(name, [name === 'creatorOf' ? creator.address : 'ipfs://old-meta']);
      }
      return { jsonrpc: '2.0', id: call.id, result };
    };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(Array.isArray(body) ? body.map(reply) : reply(body)));
  });
  const queue = createArtworkUpdateQueue({ restore: async () => [], save: async () => {} });
  await queue.initialize();
  let uploadedMetadata;
  const base = await serve(createWorkerRequestHandler({
    allowedOrigins: [origin], ownerWallet: creator.address, rpcUrl, artworkUpdateQueue: queue,
    getMintQueue: async () => queue.getPendingRequests(),
    fetchImpl: async (url, options) => {
      if (url.includes('/api/v0/add')) {
        uploadedMetadata = JSON.parse(await options.body.get('file').text());
        return new Response(JSON.stringify({ Hash: cid }));
      }
      return new Response(JSON.stringify(metadata));
    },
  }));
  let posted;
  const browserFetch = async (url, options) => {
    posted = JSON.parse(options.body);
    return fetch(url, { ...options, headers: { ...options.headers, origin } });
  };
  const upload = createBrowserIpfsUploader({
    provider: 'local',
    fetchImpl: async () => new Response(JSON.stringify({ Hash: cid })),
  });
  const artworkCid = await upload(new File(['GIF89a'], 'cover.gif', { type: 'image/gif' }));
  assert.equal(artworkCid, `ipfs://${cid}`);
  for (const value of [artworkCid, cid, `ipfs://${cidV0}`]) {
    const result = await submitArtworkUpdateRequest({
      serviceUrl: base, signer: creator, address: creator.address, origin,
      request: { contractAddress, tokenId: 7, artworkCid: value }, fetchImpl: browserFetch,
    });
    assert.equal(posted.artworkCid, value.replace('ipfs://', ''));
    assert.equal(result.request.newImageCid, normalizeMediaCid(value));
    assert.deepEqual(uploadedMetadata, { ...metadata, image: `ipfs://${normalizeMediaCid(value)}` });
  }
  const post = body => fetch(`${base}/api/artwork-update`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  for (const value of [artworkCid, `ipfs://${cidV0}`]) {
    const body = { ...posted, artworkCid: value, nonce: crypto.randomUUID() };
    body.signature = await creator.signMessage(buildArtworkUpdateAuthorizationMessage(body));
    const response = await post(body);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).request.newImageCid, normalizeMediaCid(value));
    const replay = await post(body);
    assert.match((await replay.json()).error, /already been used/);
  }
  const checksBeforeTampering = creatorChecks;
  const unsigned = { ...posted, artworkCid: cidV0, nonce: crypto.randomUUID() };
  const signature = await creator.signMessage(buildArtworkUpdateAuthorizationMessage(unsigned));
  const tampered = await post({ ...unsigned, artworkCid: cid, signature });
  assert.equal(tampered.status, 400);
  assert.match((await tampered.json()).error, /signature mismatch.*message format/);
  assert.equal(creatorChecks, checksBeforeTampering);
  await assert.rejects(submitArtworkUpdateRequest({
    serviceUrl: base, signer: stranger, address: stranger.address, origin,
    request: { contractAddress, tokenId: 7, artworkCid }, fetchImpl: browserFetch,
  }), /Only the token creator can request artwork changes/);
  const admin = { address: creator.address, origin, issuedAt: new Date().toISOString() };
  admin.signature = await creator.signMessage(buildAdminAuthorizationMessage(admin));
  const pending = await fetch(`${base}/api/mint-queue`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(admin),
  });
  assert.equal(pending.status, 200);
  assert.equal((await pending.json()).requests[0].requestType, 'artwork-update');
});

test('NFT card places the shared pencil badge beside artwork only for its creator', async () => {
  const { canEditArtwork } = await import(moduleUrl);
  const { PENCIL_ICON } = await import('../js/artwork-edit-badge.mjs');
  const source = fs.readFileSync(path.join(__dirname, '../js/nft-card.js'), 'utf8')
    .replace(/^import .*;$/gm, '').replace(/export /g, '');
  const window = { _wallet: { address: '0xabc' } };
  const context = vm.createContext({ window, document: { addEventListener() {} }, canEditArtwork, PENCIL_ICON, URL });
  vm.runInContext(source, context);
  const nft = { tokenId: 7, creator: '0xabc', image: 'ipfs://art', name: 'Track' };
  const html = context._buildCardHTML(nft);
  assert.match(html, /class="nft-detail-artwork">[\s\S]*class="nft-artwork-edit-btn artwork-edit-badge"/);
  assert.match(html, /aria-label="Edit artwork" title="Edit artwork"/);
  assert.ok(html.includes(PENCIL_ICON));
  assert.doesNotMatch(html, /✏️ Edit artwork/);
  assert.doesNotMatch(html.split('class="nft-card-actions"')[1], /nft-artwork-edit-btn/);
  window._wallet.address = '0xdef';
  assert.doesNotMatch(context._buildCardHTML(nft), /nft-artwork-edit-btn/);
  window._wallet = null;
  assert.doesNotMatch(context._buildCardHTML(nft), /nft-artwork-edit-btn/);
});
