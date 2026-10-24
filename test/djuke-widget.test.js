const test = require('node:test');
const assert = require('node:assert/strict');

class Element extends EventTarget {
  constructor(tag, document) {
    super(); this.tagName = tag; this.ownerDocument = document; this.children = [];
    this.attributes = {}; this.value = ''; this.textContent = ''; this.currentTime = 0;
  }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  get firstChild() { return this.children[0]; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  set innerHTML(html) {
    this.nodes = new Map();
    for (const match of html.matchAll(/<(\w+)[^>]*\bdata-([\w-]+)/g)) {
      const node = new Element(match[1], this.ownerDocument);
      this.nodes.set(`[data-${match[2]}]`, node); this.append(node);
    }
    this.nodes.set('h2', new Element('h2', this.ownerDocument));
  }
  querySelector(selector) { return this.nodes.get(selector); }
  attachShadow() { return this.shadowRoot = new Element('shadow', this.ownerDocument); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  pause() { this.paused = true; }
  load() {}
  play() { this.paused = false; return Promise.resolve(); }
}
function environment() {
  const view = new EventTarget();
  view.location = { origin: 'https://host.example' };
  view.crypto = globalThis.crypto;
  const map = new Map();
  view.localStorage = { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value) };
  const document = { defaultView: view, createElement: tag => new Element(tag, document) };
  return { view, element: new Element('div', document) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const address = `0x${'1'.repeat(40)}`;
const songId = `0x${'a'.repeat(64)}`;
const config = { ipfsUploadServiceUrl: 'https://worker.example', djukeContractAddress: address,
  djukeContractVersion: '0.5', djukePlaylistBatchAddress: address, djukePlaylistBatchVersion: '0.5',
  djukePlaylistBatchEnabled: true, djukePlaylistRadioReady: true };
const snapshot = { chainId: 8453, contractAddress: address, priceUnits: '250000', paymentsEnabled: true,
  requests: [], tracks: [{ trackId: 'song', songId, title: 'Evidence', artist: 'Artist', ipfsCid: 'bafytest' }] };
function service(url) {
  const body = url.includes('playlist-readiness') ? { ready: true, version: '0.5', contractAddress: address } : snapshot;
  return Promise.resolve({ ok: true, json: async () => body });
}

test('actual mount reuses Head snapshots, renders paid controls and tears down idempotently', async () => {
  const { mount } = await import('../js/djuke-widget.mjs');
  const { element } = environment();
  let subscriptions = 0, unsubscribed = 0, signerRequests = 0, callback;
  const head = {
    getWallet: () => ({ snapshot: () => ({ connected: true, address, chainId: 8453,
      provider: { getSigner() { signerRequests++; throw new Error('mount must not request a signer'); } } }),
      connect() { throw new Error('second login'); } }),
    getIpfs: () => ({}),
    on(type, listener) { assert.equal(type, 'wallet'); subscriptions++; callback = listener; return () => { unsubscribed++; }; },
  };
  const controller = mount(element, { head, config, fetch: service, title: 'My DJuke' });
  await tick();
  const section = element.shadowRoot.children[1];
  assert.equal(section.querySelector('h2').textContent, 'My DJuke');
  assert.match(section.querySelector('[data-session]').textContent, /Base/);
  assert.match(section.querySelector('[data-price]').textContent, /0.25 USDC/);
  assert.equal(signerRequests, 0);
  assert.equal(subscriptions, 1);
  assert.throws(() => mount(element, { head }), /already mounted/);
  section.querySelector('[data-song]').value = 'song';
  section.querySelector('[data-song]').dispatchEvent(new Event('change'));
  assert.equal(section.querySelector('[data-pay]').disabled, false);
  section.querySelector('[data-add]').dispatchEvent(new Event('click'));
  await tick();
  assert.equal(section.querySelector('[data-draft]').children.length, 1);
  assert.equal(section.querySelector('[data-live]').disabled, false);
  callback({ connected: false });
  assert.match(section.querySelector('[data-session]').textContent, /host|DecentHead/);
  controller.destroy(); controller.destroy();
  assert.equal(unsubscribed, 1);
  assert.equal(element.shadowRoot.children.length, 0);
  const again = mount(element, { head, config, fetch: service });
  await tick(); again.destroy();
  assert.equal(unsubscribed, 2);
  assert.equal(signerRequests, 0);
});

test('late Head readiness and aborting pending network work leave no mount listeners or UI', async () => {
  const { mount } = await import('../js/djuke-widget.mjs');
  const { view, element } = environment();
  let aborted = 0, subscribed = 0;
  const controller = mount(element, { config, fetch: (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); });
  }) });
  const section = element.shadowRoot.children[1];
  assert.match(section.querySelector('[data-session]').textContent, /Waiting/);
  view.DecentHead = { getWallet: () => ({ snapshot: () => ({ connected: false }) }),
    on() { subscribed++; return () => { subscribed--; }; } };
  view.dispatchEvent(new Event('decenthead:ready'));
  assert.equal(subscribed, 1);
  controller.destroy(); await tick();
  assert.equal(aborted, 1); assert.equal(subscribed, 0);
  view.dispatchEvent(new Event('decenthead:ready'));
  assert.equal(subscribed, 0);
  assert.equal(element.shadowRoot.children.length, 0);
});

test('unconfigured/offline worker errors are explicit and USDC-only configuration is enforced', async () => {
  const { mount, validateConfig } = await import('../js/djuke-widget.mjs');
  assert.throws(() => validateConfig({ djukeContractVersion: '0.4' }), /USDC-only/);
  assert.throws(() => validateConfig({ ipfsUploadServiceUrl: 'http://production.example' }), /HTTPS/);
  assert.throws(() => validateConfig({ ipfsUploadServiceUrl: 'https://user:secret@example.com' }), /credentials/);
  const { element } = environment();
  let fetched = false;
  const controller = mount(element, { fetch() { fetched = true; } });
  await tick();
  const section = element.shadowRoot.children[1];
  assert.match(section.querySelector('[data-state]').textContent, /cloning does not start a worker/);
  assert.equal(section.querySelector('[data-pay]').disabled, true);
  assert.equal(fetched, false);
  controller.destroy();
});

test('checkout cancellation prevents a wallet mutation after async simulation', async () => {
  const { purchaseDjukeSong, BASE_USDC_ADDRESS } = await import('../js/djuke-payment.mjs');
  const abort = new AbortController();
  let transactions = 0;
  const requestPlay = async () => { transactions++; };
  requestPlay.staticCall = async () => abort.abort();
  await assert.rejects(purchaseDjukeSong({ signal: abort.signal,
    signer: { provider: { getNetwork: async () => ({ chainId: 8453 }) }, getAddress: async () => address },
    djuke: { target: address, quote: async () => 250000n, requestPlay },
    usdc: { target: BASE_USDC_ADDRESS, decimals: async () => 6, balanceOf: async () => 1000000n, allowance: async () => 1000000n },
    songId, maxPriceUnits: 250000n }), /abort/i);
  assert.equal(transactions, 0);
});

test('mounted single, named save, Personal Play recovery and Play Live use real checkout boundaries', async () => {
  const { mount } = await import('../js/djuke-widget.mjs');
  const { BASE_USDC_ADDRESS } = await import('../js/djuke-payment.mjs');
  const { element } = environment();
  const calls = [];
  const hash = `0x${'b'.repeat(64)}`;
  const transaction = name => {
    const send = async (...args) => { calls.push(name); return { hash, wait: async () => ({ status: 1 }) }; };
    send.staticCall = async () => {};
    return send;
  };
  const currentSigner = { getAddress: async () => address, signMessage: async () => { calls.push('save-authorization'); return '0xsynthetic'; },
    provider: { getNetwork: async () => ({ chainId: 8453 }),
      getTransactionReceipt: async () => ({ from: address, to: address, status: 1 }) } };
  const token = { target: BASE_USDC_ADDRESS, decimals: async () => 6,
    balanceOf: async () => 100000000n, allowance: async () => 100000000n };
  const contract = { target: address, quote: async () => 250000n, quotePlaylist: async () => [250000n, 0n, 250000n],
    CONTRACT_VERSION: async () => '0.5', gasWorker: async () => address, maxGasContributionWei: async () => 0n,
    gasQuoteNonces: async () => 0n, requestPlayWithGas: transaction('single'),
    purchasePlaylistPrivate: transaction('private'), requestPlaylistWithGas: transaction('live'),
    replaceRequest: transaction('replacement') };
  const ethers = { Contract: function(target) { return target.toLowerCase() === BASE_USDC_ADDRESS.toLowerCase() ? token : contract; },
    verifyTypedData: () => address };
  const fetch = async (url, init) => {
    let body;
    if (url.includes('gas-quote')) body = { listener: address, contractAddress: address, chainId: 8453, songId,
      maxPrice: '250000', maxTotal: '3250000', fulfillmentCostWei: '0', contributionWei: '0', nonce: '0',
      deadline: Math.floor(Date.now() / 1000) + 120, signature: '0xsynthetic' };
    else if (url.includes('/api/creator/playlists') && init.method === 'POST') {
      calls.push('profile-save'); body = { playlist: JSON.parse(init.body).playlist };
    } else if (url.includes('/api/creator/profile')) body = { madePlaylists: [], playlists: [] };
    else if (url.endsWith('/api/djuke')) body = { ...snapshot,
      requests: [{ title: 'Unavailable request', playable: false, payer: address, chainRequestId: '7' }],
      playlistReceipts: [{ name: 'Real receipt shape', payer: address, status: 'refunded',
        songs: [{ status: 'refunded' }], subtotalUnits: '250000', feeUnits: '3000000', refundedUnits: '3250000',
        transactionHash: hash, resolutionTransactionHash: hash,
        playbackFailure: { reason: 'decoder_failed', attempts: 4, maxAttempts: 4, exhausted: true } }] };
    else return service(url);
    return { ok: true, json: async () => body };
  };
  const controller = mount(element, { config, ethers, fetch, head: {
    getWallet: () => ({ snapshot: () => ({ connected: true, address, chainId: 8453,
      provider: { getSigner: async () => currentSigner } }) }),
    getIpfs: () => ({}), on: () => () => {},
  } });
  await tick();
  const section = element.shadowRoot.children[1];
  const $ = key => section.querySelector(`[data-${key}]`);
  $('song').value = 'song'; $('song').dispatchEvent(new Event('change'));
  assert.deepEqual(calls, []);
  $('pay').dispatchEvent(new Event('click')); await tick();
  assert.deepEqual(calls, ['single']);
  $('queue').children[0].children[0].dispatchEvent(new Event('click')); await tick();
  assert.equal(calls.at(-1), 'replacement');
  assert.equal($('receipts').children.length, 1);
  assert.ok($('receipts').children[0].children.some(child => child.textContent.includes('refunded 3.25 USDC')));
  $('add').dispatchEvent(new Event('click')); await tick();
  $('name').value = 'My synthetic mix';
  $('save').dispatchEvent(new Event('click')); await tick();
  assert.deepEqual(calls, ['single', 'replacement', 'save-authorization', 'profile-save']);
  $('private').dispatchEvent(new Event('click')); await tick();
  assert.ok(calls.includes('private'));
  assert.match($('playing').textContent, /My synthetic mix: 1\/1/);
  assert.equal($('recovery').children.length, 1);
  const paidBeforeResume = calls.length;
  $('recovery').children[0].children[0].dispatchEvent(new Event('click')); await tick();
  assert.equal(calls.length, paidBeforeResume);
  $('live').dispatchEvent(new Event('click')); await tick();
  assert.equal(calls.at(-1), 'live');
  assert.match($('payment').textContent, /Profile → Playlists/);
  controller.destroy();
});

test('destroy/cancellation during allowance read prevents approval, not just final submission', async () => {
  const { purchaseDjukeSong, BASE_USDC_ADDRESS } = await import('../js/djuke-payment.mjs');
  const lifetime = new AbortController();
  let approvals = 0;
  await assert.rejects(purchaseDjukeSong({ signal: lifetime.signal, songId, maxPriceUnits: 250000n,
    signer: { getAddress: async () => address, provider: { getNetwork: async () => ({ chainId: 8453 }) } },
    djuke: { target: address, quote: async () => 250000n },
    usdc: { target: BASE_USDC_ADDRESS, decimals: async () => 6, balanceOf: async () => 250000n,
      allowance: async () => { lifetime.abort(); return 0n; }, approve: async () => { approvals++; } } }), /abort/i);
  assert.equal(approvals, 0);
});
