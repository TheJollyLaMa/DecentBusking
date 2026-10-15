const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const { Interface } = createRequire(path.join(__dirname, '../discord-bot/package.json'))('ethers');

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
