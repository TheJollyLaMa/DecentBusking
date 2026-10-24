const test = require('node:test');
const assert = require('node:assert/strict');

test('prepared batch uses one transaction and reads actual token IDs from matching contract events', async () => {
  const { mintPreparedProductsBatch } = await import('../js/admin-mint-queue.js');
  const owner = `0x${'1'.repeat(40)}`;
  const recipient = `0x${'2'.repeat(40)}`;
  const address = `0x${'3'.repeat(40)}`;
  const products = ['a', 'b'].map(suffix => ({ recipient, amount: 1, maxSupply: 0,
    tokenURI: `ipfs://${suffix}`, royaltyReceiver: recipient, royaltyFeeBps: 500 }));
  const logs = products.flatMap((product, index) => [
    { address, name: 'TokenRegistered', args: { tokenId: BigInt(index + 70), creator: owner, kind: 0n, uri: product.tokenURI } },
    { address, name: 'EditionMinted', args: { tokenId: BigInt(index + 70), to: recipient, minter: owner, amount: 1n } },
  ]);
  let transactions = 0;
  const send = async (_products, options) => {
    transactions++;
    assert.equal(options.gasLimit, 120000n);
    return { hash: '0xbatch', wait: async () => ({ status: 1, hash: '0xbatch', logs }) };
  };
  send.estimateGas = async () => 100000n;
  const contract = { target: address, registerAndMintProductsBatch: send, interface: { parseLog: log => log } };
  assert.deepEqual(await mintPreparedProductsBatch({ contract, products, owner }), { tokenIds: ['70', '71'], txHash: '0xbatch' });
  assert.equal(transactions, 1);
  logs[0].address = recipient;
  await assert.rejects(mintPreparedProductsBatch({ contract, products, owner }), /ambiguous registration/);
  await assert.rejects(mintPreparedProductsBatch({ contract, products, owner, maxGas: 1n }), /select fewer/);
  assert.equal(transactions, 2);
});

test('large batch selections split into sequential contract-sized groups of twenty', async () => {
  const { splitMintBatches } = await import('../js/admin-mint-queue.js');
  const batches = splitMintBatches(Array.from({ length: 43 }, (_, index) => index));
  assert.deepEqual(batches.map(batch => batch.length), [20, 20, 3]);
  assert.deepEqual(batches.flat(), Array.from({ length: 43 }, (_, index) => index));
  assert.deepEqual(splitMintBatches([]), []);
});
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const vm = require('node:vm');

const mockNode = () => ({
  textContent: '',
  innerHTML: '',
  append() {},
  appendChild() {},
  replaceChildren() {},
  setAttribute() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {},
});

test('Admin clearly exposes multi-select mint batches of up to 20 while marking row actions as single-item', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, '../js/admin.js'), 'utf8');
  const worker = fs.readFileSync(path.join(__dirname, '../discord-bot/index.js'), 'utf8');
  const config = fs.readFileSync(path.join(__dirname, '../decent.config.js'), 'utf8');
  assert.match(html, /id="admin-mint-select-all"[^>]*> Select all/);
  assert.match(html, />Mint selected in batches</);
  assert.match(html, /id="admin-mint-pending-badge"/);
  assert.match(html, /up to 20 in one Base transaction/);
  assert.match(admin, />Mint<\/button>/);
  assert.match(admin, /Queued artwork will be used; requests without artwork will mint without an image/);
  assert.match(admin, /track\.isDevertAd === true \? 'Ad' : 'Song'/);
  assert.match(admin, /track\.mediaType === 'video\/mp4' \? 'Video' : 'Audio'/);
  assert.match(admin, /track\.isDevertAd === true \? \{ isDevertAd: true \}/);
  assert.match(worker, /isDevertAd: track\.isDevertAd === true/);
  assert.match(config, /nftBatchMintEnabled:\s*true/);
  assert.match(html, /header-admin-inject\.js\?v=20261022-action-badges/);
});

const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'js', 'admin-mint-queue.js')).href;

test('artwork selection keeps profile default, permits a 10 MB replacement, and references larger CID files without uploading', async () => {
  const { resolveMintArtwork } = await import(moduleUrl);
  const cid = 'bafybeieupiamdn7e4qmi4hou6zfu4cwluoubn6ppgsqs4rfjydyee7wtnm';
  let uploads = 0;
  const upload = async () => { uploads++; return 'ipfs://uploaded-image'; };
  assert.equal(await resolveMintArtwork({ defaultCid: cid, upload }), `ipfs://${cid}`);
  const file = { type: 'image/gif', size: 10 * 1024 * 1024 };
  assert.equal(await resolveMintArtwork({ file, upload }), 'ipfs://uploaded-image');
  await assert.rejects(resolveMintArtwork({ file: { ...file, size: file.size + 1 }, upload }), /up to 10 MB/);
  await assert.rejects(resolveMintArtwork({ file, cid, upload }), /one artwork source/);
  assert.equal(await resolveMintArtwork({ cid, serviceUrl: 'https://worker.example', upload,
    fetchImpl: async url => { assert.equal(new URL(url).searchParams.get('cid'), cid); return new Response(JSON.stringify({ cid })); } }), `ipfs://${cid}`);
  assert.equal(uploads, 1);
  await assert.rejects(resolveMintArtwork({ upload }), /No default artwork/);
});

test('batch minting reuses queued artwork and does not require artwork when none is queued', async () => {
  const { resolveBatchMintArtwork } = await import(moduleUrl);
  assert.equal(resolveBatchMintArtwork('bafy-image'), 'ipfs://bafy-image');
  assert.equal(resolveBatchMintArtwork('ipfs://bafy-image'), 'ipfs://bafy-image');
  assert.equal(resolveBatchMintArtwork(), null);
});

test('signs and fetches the owner mint queue', async () => {
  const { buildAdminAuthorizationMessage, fetchMintQueue } = await import(moduleUrl);
  const signed = [];
  let request;
  const queue = await fetchMintQueue({
    serviceUrl: 'https://worker.example/',
    signer: { signMessage: async (message) => { signed.push(message); return '0xsigned'; } },
    address: '0x1111111111111111111111111111111111111111',
    origin: 'https://busking.example',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ requests: [{ trackId: 'track-1' }] }), { status: 200 });
    },
  });

  test('mint queue pages are bounded to twenty and reuse authorization across navigation', async () => {
    const { fetchMintQueue, clearMintQueueAuthorization } = await import(moduleUrl);
    clearMintQueueAuthorization();
    let signed = 0;
    const options = { serviceUrl: 'https://worker.example', signer: { signMessage: async () => { signed++; return 'signature'; } },
      address: `0x${'1'.repeat(40)}`, origin: 'https://site.example', offset: 0, limit: 20,
      fetchImpl: async (_url, request) => {
        const { offset, limit } = JSON.parse(request.body);
        assert.equal(limit, 20);
        return new Response(JSON.stringify({ requests: Array.from({ length: offset ? 3 : 20 }, (_, i) => ({ trackId: String(i + offset) })),
          total: 23, nextOffset: offset ? null : 20 }));
      } };
    const first = await fetchMintQueue(options);
    assert.equal(first.requests.length, 20);
    assert.equal(first.nextOffset, 20);
    assert.equal((await fetchMintQueue({ ...options, offset: 20 })).requests.length, 3);
    assert.equal(signed, 1);
    await assert.rejects(fetchMintQueue({ ...options, fetchImpl: async () => new Response(JSON.stringify({ requests: [] })) }), /Invalid mint queue page/);
  });

  assert.deepEqual(queue, [{ trackId: 'track-1' }]);
  assert.equal(request.url, 'https://worker.example/api/mint-queue');
  const authorization = JSON.parse(request.options.body);
  assert.equal(authorization.signature, '0xsigned');
  assert.equal(signed[0], buildAdminAuthorizationMessage(authorization));
});

test('signs reviewed album import and returns queue counts without claiming mints', async () => {
  const { buildReviewedAlbumImportAuthorizationMessage, importReviewedAlbums } = await import(moduleUrl);
  let signedMessage;
  let request;
  const result = await importReviewedAlbums({
    serviceUrl: 'https://worker.example/',
    signer: { signMessage: async message => { signedMessage = message; return '0ximport-signature'; } },
    address: '0x1111111111111111111111111111111111111111',
    origin: 'https://busking.example',
    now: () => Date.parse('2026-10-10T12:00:00.000Z'),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ added: 190, queued: 190, skipped: 0, minted: 0 }), { status: 200 });
    },
  });
  const authorization = JSON.parse(request.options.body);
  assert.equal(request.url, 'https://worker.example/api/admin/reviewed-album-import');
  assert.equal(authorization.signature, '0ximport-signature');
  assert.equal(signedMessage, buildReviewedAlbumImportAuthorizationMessage(authorization));
  assert.deepEqual(result, { added: 190, queued: 190, skipped: 0, minted: 0 });
  await assert.rejects(importReviewedAlbums({ serviceUrl: 'https://worker.example', signer: null, address: '0x1' }), /Connect the owner wallet/);
});

test('admin DOM initialization can bind every queue handler', () => {
  const admin = fs.readFileSync(path.join(__dirname, '../js/admin.js'), 'utf8');
  assert.match(admin, /document\.addEventListener\('DOMContentLoaded'/);
  assert.match(admin, /_mintRefreshBtn\?\.addEventListener\('click'/);
  assert.match(admin, /_mintQueueEl\?\.addEventListener\('click'/);
  assert.match(admin, /_radioScheduleForm\?\.addEventListener\('submit'/);
});

test('queue refreshes reuse a short-lived authorization and clear it on account changes or failures', async () => {
  const { fetchMintQueue, clearMintQueueAuthorization } = await import(moduleUrl);
  clearMintQueueAuthorization();
  let time = Date.parse('2026-10-05T12:00:00Z');
  let signatures = 0;
  const requests = [];
  const options = { serviceUrl: 'https://worker.example', address: '0x1111111111111111111111111111111111111111',
    origin: 'https://site.example', signer: { signMessage: async () => `signature-${++signatures}` }, now: () => time,
    fetchImpl: async (_url, request) => { requests.push(JSON.parse(request.body)); return new Response(JSON.stringify({ requests: [] })); } };
  await Promise.all([fetchMintQueue(options), fetchMintQueue(options)]);
  assert.equal(signatures, 1);
  assert.equal(requests[0].signature, requests[1].signature);
  time += 3 * 60 * 1000;
  await fetchMintQueue(options);
  assert.equal(signatures, 1);
  time += 60 * 1000;
  await fetchMintQueue(options);
  assert.equal(signatures, 2);
  await fetchMintQueue({ ...options, address: '0x2222222222222222222222222222222222222222' });
  assert.equal(signatures, 3);
  clearMintQueueAuthorization();
  await fetchMintQueue(options);
  assert.equal(signatures, 4);
  await assert.rejects(fetchMintQueue({ ...options, fetchImpl: async () => new Response(JSON.stringify({ error: 'Expired' }), { status: 400 }) }), /Expired/);
  await fetchMintQueue(options);
  assert.equal(signatures, 5);
  clearMintQueueAuthorization();
});

test('Admin reuses the header signer, checks roles without reconnecting, and clears state on disconnect', async () => {
  const events = new Map();
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, mockNode());
    return elements.get(id);
  };
  let signatures = 0;
  const signer = { signMessage: async () => { signatures++; return 'signature'; } };
  const address = '0x1111111111111111111111111111111111111111';
  let queueCalls = 0;
  let allowed = true;
  const context = vm.createContext({
    PRODUCT_BATCH_ABI: (await import(moduleUrl)).PRODUCT_BATCH_ABI,
    window: { _wallet: { signer, address, chainId: 8453 }, DecentConfig: { chainId: 8453, contractAddress: 'contract' }, location: { origin: 'https://site.example' } },
    document: { getElementById: element, addEventListener: (name, callback) => events.set(name, callback) },
    ethers: { BrowserProvider: class { constructor() { throw new Error('Must not reconnect'); } },
      Contract: class { constructor(_address, _abi, runner) { assert.equal(runner, signer); }
        async DEFAULT_ADMIN_ROLE() { return 'admin'; } async hasRole() { return allowed; } } },
    fetchMintQueue: async options => { assert.equal(options.signer, signer); await options.signer.signMessage('mint queue'); queueCalls++; return []; }, clearMintQueueAuthorization() {},
    renderWallet: (element, address) => { element.textContent = address; },
    isAdminWallet: () => true,
  });
  const source = fs.readFileSync(path.join(__dirname, '../js/admin.js'), 'utf8').replace(/^import .*;\n/gm, '');
  vm.runInContext(`${source}\nglobalThis.checkWallet = _connectWallet; globalThis.getSigner = () => _adminSigner;`, context);
  const mintEvents = new Map();
  element('admin-mint-section').addEventListener = (name, callback) => mintEvents.set(name, callback);
  element('admin-connected-role').removeAttribute = () => {};
  events.get('DOMContentLoaded')();
  await events.get('open-admin')();
  assert.equal(queueCalls, 0);
  assert.equal(signatures, 0, 'opening Admin never prompts for the private queue signature');
  assert.equal(context.getSigner(), signer);
  element('admin-mint-section').open = true;
  mintEvents.get('toggle')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queueCalls, 1);
  assert.equal(signatures, 1, 'expanding NFT Requests requests its authorization');
  element('admin-mint-section').open = false;
  mintEvents.get('toggle')();
  assert.equal(signatures, 1, 'closing NFT Requests does not sign');
  events.get('wallet-disconnected')();
  assert.equal(context.getSigner(), null);
  assert.equal(element('admin-connected-addr').textContent, '');
  allowed = false;
  await context.checkWallet();
  assert.equal(queueCalls, 1);
  assert.equal(context.getSigner(), null);
});

test('admin section order, identity and worker notice stay scoped to their requested sections', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const admin = html.slice(html.indexOf('id="admin-modal"'), html.indexOf('id="payroll-overlay"'));
  const ids = ['admin-radio-schedule', 'admin-mint-section', 'admin-live-performance-slot',
    'admin-devert-campaigns', 'admin-worker-funding', 'admin-role-section'];
  const positions = ids.map(id => admin.indexOf(`id="${id}"`));
  assert.ok(positions.every(position => position >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.doesNotMatch(admin, /Review requests, select items, then confirm the mint in your wallet/);
  assert.match(admin, /id="admin-connected-role" hidden>DEFAULT_ADMIN_ROLE/);
  assert.match(admin, /<span>📣 DVert<\/span>/);
  assert.doesNotMatch(admin, /id="admin-mint-section"[^>]*\bopen\b/);
  assert.ok(admin.indexOf('id="admin-worker-alert"') > admin.indexOf('id="admin-worker-funding"'));
  assert.ok(admin.indexOf('id="admin-worker-alert"') < admin.indexOf('id="admin-role-section"'));
  assert.equal((admin.match(/class="admin-tool-section/g) || []).length, 5);
  const live = fs.readFileSync(path.join(__dirname, '../js/live-performance-admin.mjs'), 'utf8');
  assert.match(live, /getElementById\('admin-live-performance-slot'\)/);
});

test('shared wallet label renders four icons with the full address accessible and clears on disconnect', async t => {
  const previous = global.document;
  t.after(() => {
    if (previous === undefined) delete global.document;
    else global.document = previous;
  });
  const node = tag => ({
    tag, children: [], attrs: {}, style: {},
    append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; },
    setAttribute(key, value) { this.attrs[key] = value; },
    removeAttribute(key) { delete this.attrs[key]; },
  });
  global.document = { createElement: node };
  const { renderWallet } = await import('../js/wallet-label.mjs');
  const root = node('span');
  const address = '0x807061DF657A7697c04045dA7d16D941861cAABc';
  renderWallet(root, address);
  assert.equal(root.title, address);
  assert.equal(root.attrs['aria-label'], `Wallet ${address}`);
  assert.equal(root.children[0].textContent, '0x8070');
  assert.equal(root.children[2].textContent, 'AABc');
  const icons = root.children[1];
  assert.equal(icons.attrs['aria-hidden'], 'true');
  assert.equal(icons.children.length, 4);
  assert.ok(icons.children.every(icon => icon.src === 'img/Ens_Eth_Breathe.png' && icon.alt === ''));
  renderWallet(root, '');
  assert.equal(root.children.length, 0);
  assert.equal(root.title, '');
  assert.equal(root.attrs['aria-label'], undefined);
});