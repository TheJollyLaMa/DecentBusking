const test = require('node:test');
const assert = require('node:assert/strict');

test('DVert shares the USDC ABI without importing and initializing the DJuke drawer', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../js/devert-paid-queue.mjs'), 'utf8');
  assert.match(source, /import \{ USDC_BROWSER_ABI \} from '\.\/usdc-abi\.mjs'/);
  assert.doesNotMatch(source, /from ['"]\.\/djuke\.mjs/);
  const { USDC_BROWSER_ABI } = await import('../js/usdc-abi.mjs');
  const djuke = await import('../js/djuke.mjs');
  assert.equal(djuke.USDC_BROWSER_ABI, USDC_BROWSER_ABI);
  assert.deepEqual(USDC_BROWSER_ABI, [
    'function decimals() view returns (uint8)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address, address) view returns (uint256)',
    'function approve(address, uint256) returns (bool)',
  ]);
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.match(html, /djuke\.mjs\?v=20261023-profile-receipts/);
  assert.match(html, /devert-paid-queue\.mjs\?v=20261019-radio-recovery/);
});

test('DJuke starts at 0.25 USDC and doubles after each eight pending requests', async () => {
  const { quoteDjuke } = await import('../js/djuke.mjs');
  for (const [pending, expected] of [[0, 250000n], [7, 250000n], [8, 500000n],
    [15, 500000n], [16, 1000000n], [23, 1000000n], [24, 2000000n], [32, 4000000n]]) {
    assert.equal(quoteDjuke(pending).priceUnits, expected);
  }
  assert.equal(quoteDjuke(7).priceUnits, 250000n);
});

test('playlist receipt distinguishes purchase, delivery and exact refund without hiding worker ETH', async () => {
  const { playlistReceiptSummary } = await import('../js/djuke.mjs');
  const batch = { status: 'refunded', songs: Array.from({ length: 12 }, (_, i) => ({
    status: i === 0 ? 'delivered' : 'refunded' })), subtotalUnits: '4000000', feeUnits: '3000000',
    refundedUnits: '6750000', workerGasSponsored: false };
  const refund = playlistReceiptSummary(batch);
  assert.equal(refund.label, 'Refunded');
  assert.equal(refund.progress, '1 / 12 songs delivered');
  assert.equal(refund.payment, 'Paid 7.00 USDC · Refunded 6.75 USDC · Settled 0.25 USDC');
  assert.match(refund.note, /Worker ETH and network gas are not refunded/);
  const queued = playlistReceiptSummary({ ...batch, status: 'pending' });
  assert.equal(queued.label, 'Queued');
  assert.doesNotMatch(queued.payment, /Refunded/);
  assert.equal(playlistReceiptSummary({ ...batch, status: 'pending', playing: true }).label, 'Playing');
  const completed = playlistReceiptSummary({ ...batch, status: 'settled', songs: batch.songs.map(() => ({ status: 'delivered' })) });
  assert.equal(completed.label, 'Completed');
  assert.equal(completed.progress, '12 / 12 songs delivered');
  assert.match(completed.note, /platform fee settled/);
  const confirming = playlistReceiptSummary({ ...batch, status: 'confirming' });
  assert.equal(confirming.label, 'Verifying queue');
  assert.match(confirming.note, /playback is not complete/);
  assert.match(playlistReceiptSummary({ ...batch, refundedUnits: null }).payment, /Refund amount is being verified/);
  assert.match(playlistReceiptSummary({ ...batch, subtotalUnits: undefined }).payment, /Payment details are being verified/);
  assert.doesNotMatch(playlistReceiptSummary({ ...batch, workerGasSponsored: true }).note, /Worker ETH/);
});

test('Play Live receipts belong to the profile, not the DJuke drawer', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const drawer = html.slice(html.indexOf('<aside id="djuke-panel"'), html.indexOf('</aside>', html.indexOf('<aside id="djuke-panel"')));
  const profile = html.slice(html.indexOf('<dialog id="creator-profile"'));
  assert.ok(drawer.length > 0);
  assert.doesNotMatch(drawer, /id="djuke-receipts"|Your Play Live receipts/);
  assert.match(profile, /id="djuke-receipts"/);
  const playlists = profile.slice(profile.indexOf('data-playlists-section'), profile.indexOf('</details>', profile.indexOf('data-playlists-section')));
  assert.match(playlists, /id="djuke-receipts"/);
  assert.equal((html.match(/id="djuke-receipts"/g) || []).length, 1);
  assert.match(html, /open your profile for your latest Play Live receipts/);
  const profileSource = fs.readFileSync(path.join(__dirname, '../js/creator-profile.mjs'), 'utf8');
  assert.match(profileSource, /creator-profile-view-changed/);
});

test('DJuke keeps the 10 percent fund and 90 percent artist split exact', async () => {
  const { quoteDjuke } = await import('../js/djuke.mjs');
  for (const pending of [0, 8, 16, 24, 100]) {
    const quote = quoteDjuke(pending);
    assert.equal(quote.fundUnits * 10n, quote.priceUnits);
    assert.equal(quote.fundUnits + quote.artistUnits, quote.priceUnits);
  }
  assert.equal(quoteDjuke(0).fundUnits, 25000n);
  assert.equal(quoteDjuke(0).artistUnits, 225000n);
});

test('DJuke rejects invalid queue counts and prices beyond uint256', async () => {
  const { quoteDjuke } = await import('../js/djuke.mjs');
  for (const count of [-1, 1.5, NaN, Infinity, '8', null, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => quoteDjuke(count), RangeError);
  }
  assert.ok(quoteDjuke(1904).priceUnits <= (2n ** 256n) - 1n);
  assert.throws(() => quoteDjuke(1912), RangeError);
});

test('DJuke rounds displayed USDC prices to cents without changing split calculations', async () => {
  const { formatDjukeUsdc, formatDjukeEth, splitDjukeCharges } = await import('../js/djuke.mjs');
  assert.equal(formatDjukeUsdc(250000n), '0.25');
  assert.equal(formatDjukeUsdc(1000000n), '1.00');
  assert.equal(formatDjukeUsdc(225000n), '0.23');
  assert.equal(formatDjukeUsdc(25000n), '0.03');
  assert.equal(formatDjukeEth(22010689501538n), '0.000022');
  assert.equal(formatDjukeEth(1000000000000000000n), '1');
  assert.deepEqual(splitDjukeCharges(250000n), { artistUnits: 225000n, fundUnits: 25000n });
});

test('DJuke rejects missing and ambiguous queue data instead of assuming an empty queue', async () => {
  const { readDjukeQueue } = await import('../js/djuke.mjs');
  assert.deepEqual(readDjukeQueue({ requests: [] }), []);
  const request = { requestId: 'base:receipt:0', trackId: 'track-1', title: 'A song' };
  assert.deepEqual(readDjukeQueue({ requests: [request] }), [request]);
  for (const snapshot of [null, {}, { requests: null }, { requests: [{}] }, { requests: [request, request] }]) {
    assert.throws(() => readDjukeQueue(snapshot));
  }
});

test('DJuke journal keeps payer and amount metadata on the claimed record', async () => {
  const { createDjukePlaybackJournal } = await import('../discord-bot/djuke.js');
  const writes = [];
  const journal = createDjukePlaybackJournal({
    restore: async () => ({ schemaVersion: 1, records: [] }),
    save: async snapshot => { writes.push(snapshot); return 'ipfs://journal'; },
  });
  await journal.initialize();
  await journal.synchronize([{
    requestId: '8453:0xabc:1',
    chainRequestId: '1',
    songId: '0x' + 'a'.repeat(64),
    revision: '2',
    trackId: 'track-1',
    payer: '0x1111111111111111111111111111111111111111',
    amountUnits: '1000000',
  }]);
  const record = await journal.reserveNext();
  assert.equal(record.payer, '0x1111111111111111111111111111111111111111');
  assert.equal(record.amountUnits, '1000000');
  assert.equal(writes.at(-1).records[0].payer, '0x1111111111111111111111111111111111111111');
});

function paymentFixture({ chainId = 8453n, price = 250000n, balance = 1000000n, allowance = 0n } = {}) {
  const calls = [];
  let currentChainId = chainId;
  let currentAllowance = allowance;
  const confirmed = hash => ({ hash, wait: async () => ({ status: 1 }) });
  const requestPlay = async (songId, maxPrice) => { calls.push(['requestPlay', songId, maxPrice]); return confirmed('0xrequest'); };
  requestPlay.staticCall = async () => {};
  const djuke = { target: `0x${'d'.repeat(40)}`, quote: async () => price, requestPlay };
  const usdc = { target: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: async () => 6n,
    balanceOf: async () => balance, allowance: async () => currentAllowance,
    approve: async (spender, amount) => { calls.push(['approve', spender, amount]); currentAllowance = amount; return confirmed('0xapprove'); } };
  const signer = { provider: { getNetwork: async () => ({ chainId: currentChainId }) }, getAddress: async () => `0x${'1'.repeat(40)}` };
  return { calls, signer, djuke, usdc, songId: `0x${'a'.repeat(64)}`, maxPriceUnits: 250000n, setChainId: chainId => { currentChainId = chainId; } };
}

test('DJuke payment approves exactly the current price and caps the request at the quoted price', async () => {
  const { payForDjukeSong } = await import('../js/djuke.mjs');
  const fixture = paymentFixture();
  assert.equal((await payForDjukeSong(fixture)).priceUnits, 250000n);
  assert.deepEqual(fixture.calls, [['approve', fixture.djuke.target, 250000n], ['requestPlay', fixture.songId, 250000n]]);
  const approved = paymentFixture({ allowance: 250000n });
  await payForDjukeSong(approved);
  assert.deepEqual(approved.calls.map(call => call[0]), ['requestPlay']);
});

test('DJuke payment switches to Base, then refuses price increases and low balances before any wallet prompt', async () => {
  const { payForDjukeSong } = await import('../js/djuke.mjs');
  const requests = [];
  const previousWindow = global.window;
  const chain = paymentFixture({ chainId: 1n, balance: 1_000_000n });
  global.window = { ethereum: { request: async ({ method, params }) => {
    requests.push([method, params]);
    if (method === 'wallet_switchEthereumChain') chain.setChainId(8453n);
  } } };
  try {
    await payForDjukeSong(chain);
    assert.equal(requests[0][0], 'wallet_switchEthereumChain');
    for (const [options, message] of [[{ price: 500000n }, /Price rose/], [{ balance: 1n }, /need 0.25 USDC/]]) {
      const fixture = paymentFixture(options);
      await assert.rejects(payForDjukeSong(fixture), message);
      assert.deepEqual(fixture.calls, []);
    }
  } finally {
    global.window = previousWindow;
  }
});

test('DJuke drawer contains queue, pricing, and gated wallet controls', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
  const config = require('node:fs').readFileSync(require('node:path').join(__dirname, '../decent.config.js'), 'utf8');
  for (const id of ['djuke-tab', 'djuke-panel', 'djuke-queue', 'djuke-price-tiers', 'devert-tab', 'devert-panel']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const id of ['djuke-connect', 'djuke-search-results', 'djuke-search-more', 'djuke-profile', 'community-pin-heading']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /class="djuke-tab-mark"/);
  assert.match(html, /class="djuke-note/);
  assert.match(html, /class="djuke-tab-coin"/);
  assert.match(html, /data-devert-ticket/);
  assert.match(html, /aria-label="DVert advertising"/);
  assert.match(html, /class="devert-tab-art" data-devert-ticket/);
  assert.match(html, /class="devert-cash first">💸/);
  assert.match(html, /class="devert-speaker second">🔊/);
  assert.doesNotMatch(html, />DeVert</);
  assert.match(html, /id="djuke-pay"[^>]*disabled/);
  assert.match(html, /id="djuke-playlist" aria-label="Ordered playlist draft"/);
  assert.match(html, /id="djuke-named-playlist-private"[^>]*disabled/);
  assert.match(html, /id="djuke-named-playlist-radio"[^>]*disabled/);
  assert.match(html, /id="djuke-panel"[^>]*inert/);
  assert.match(html, /id="devert-panel"[^>]*inert/);
  assert.match(html, /<dt>IPFS pinning rewards<\/dt><dd>8%<\/dd>/);
  assert.match(html, /<dt>Repo development fund<\/dt><dd>2%<\/dd>/);
  assert.match(config, /contractAddress: "0x64D5aDc50E5513975EfF7e9ba366B7eE58586fa3"/);
  assert.match(config, /additionalNftContractAddresses: \["0xe63EC9f8228720bAAC2fD528C0A6d06B3Dc5439B"\]/);
  assert.match(config, /djukeContractAddress: "0xBBCb7F7369978cbdc32C6719B1d24B07f3d55619"/);
  assert.match(config, /djukeContractVersion: "0.4"/);
  assert.match(config, /nftBatchMintEnabled: true/);
  for (const tab of ['top-ten', 'djuke', 'devert']) assert.match(html, new RegExp(`id="${tab}-tab"[^>]*aria-controls="${tab}-panel"`));
  assert.match(html, /class="djuke-tab-slot">⚸🎰🧞‍♂️/);
  assert.match(html, /class="djuke-tab-coin">🪙/);
  const search = html.indexOf('id="djuke-search"');
  const select = html.indexOf('id="djuke-song"');
  const queue = html.indexOf('id="djuke-pay"');
  const earners = html.indexOf('id="djuke-earners"');
  assert.ok(search < select && select < queue && queue < earners);
});

test('DJuke replaces operator messaging with a podium, info dialog and decorative LCD equalizer', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
  const panel = html.match(/<aside id="djuke-panel"[\s\S]*?<\/aside>/)[0];
  assert.doesNotMatch(panel, /Operator reminder|worker-gas-notice|img\/hat\.svg/);
  assert.match(panel, /djuke-header-machine/);
  assert.match(panel, /id="djuke-info".*aria-controls="djuke-instructions"/);
  assert.match(panel, /class="djuke-lcd-equalizer" aria-hidden="true"/);
  assert.match(panel, /id="djuke-earners"/);
  assert.match(panel, /id="djuke-payment-state"[^>]*><\/p>/);
  assert.match(html, /<dialog id="djuke-instructions"/);
  assert.match(html, /Mint gas comes from your wallet/);
  assert.doesNotMatch(html, /id="admin-reviewed-album-import"/);
  assert.match(html, /<details id="admin-radio-schedule"/);
  assert.match(html, /<details id="admin-role-section"/);
});

test('DJuke search matches song titles and creators without selecting a song implicitly', async () => {
  const { filterDjukeSongs } = await import('../js/djuke.mjs');
  const tracks = [{ trackId: 'a', title: 'Heart of Gold', artist: 'thejollylama', creator: '0xabc' },
    { trackId: 'b', title: 'Other', artist: 'Someone' }];
  assert.deepEqual(filterDjukeSongs(tracks, 'heart jolly').map(track => track.trackId), ['a']);
  assert.deepEqual(filterDjukeSongs(tracks, '0xabc').map(track => track.trackId), ['a']);
  assert.deepEqual(filterDjukeSongs(tracks, 'missing'), []);
});

test('DJuke prompts only on a disconnected queue click, renders ENS payouts and preserves modal focus', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const helpers = await import('../js/djuke.mjs');
  const versions = await import('../js/djuke-version.mjs');
  const { renderWalletAddress } = await import('../js/fund-display.mjs');
  const { formatUsdcUnits } = await import('../js/usdc-format.mjs');
  const nodes = new Map();
  let focused;
  function element(id) {
    if (nodes.has(id)) return nodes.get(id);
    const item = { children: [], listeners: {}, attributes: {}, dataset: {}, style: {}, value: '', textContent: '', open: false,
      classList: { add() {}, remove() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      getAttribute(name) { return this.attributes[name]; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); },
      focus() { focused = id; }, showModal() { this.open = true; },
      close() { this.open = false; for (const callback of this.listeners.close || []) callback(); },
    };
    nodes.set(id, item);
    return item;
  }
  const listeners = {};
  const document = { body: element('body'), getElementById: element,
    createElement: tag => element(`${tag}-${nodes.size}`), querySelectorAll: () => [],
    addEventListener(name, callback) { (listeners[name] ||= []).push(callback); },
    dispatchEvent(event) { for (const callback of listeners[event.type] || []) callback(event); },
  };
  const address = `0x${'1'.repeat(40)}`;
  let earningsFail = false;
  let catalogFail = false;
  let playlistReceipts = [];
  let queueReads = 0;
  let scheduled;
  let tracks = [{ trackId: 'a', songId: `0x${'a'.repeat(64)}`, title: 'First song', artist: 'Musician' }];
  const context = vm.createContext({ ...helpers, ...versions, renderWalletAddress, formatUsdcUnits, document, AbortSignal,
    window: { DecentConfig: { ipfsUploadServiceUrl: 'https://service.example', djukeContractAddress: address } },
    lookupEnsName: async () => 'musician.eth',
    CustomEvent: class { constructor(type, { detail }) { this.type = type; this.detail = detail; } },
    clearTimeout() { scheduled = null; }, setTimeout(callback) { scheduled = callback; },
    fetch: async url => {
      if (url.endsWith('/earners')) return { ok: !earningsFail, status: earningsFail ? 503 : 200,
        json: async () => ({ chainId: 8453, asset: 'USDC', period: 'all-time', earners: [{ address, totalUnits: '1125000' }] }) };
      queueReads++;
      return { ok: !catalogFail, status: catalogFail ? 503 : 200,
        json: async () => ({ contractAddress: address, paymentsEnabled: true, requests: [], tracks, playlistReceipts }) };
    },
  });
  const source = fs.readFileSync(path.join(__dirname, '../js/djuke.mjs'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export \{.*\};\n/gm, '').replace(/export /g, '');
  vm.runInContext(`${source}\ninitDjuke();`, context);
  const click = async id => {
    for (const callback of element(id).listeners.click || []) await callback({ stopPropagation() {} });
    await new Promise(resolve => setImmediate(resolve));
  };
  await click('djuke-tab');
  const select = element('djuke-song');
  const originalOption = select.children[1];
  select.value = 'a';
  select.scrollTop = 80;
  await click('djuke-refresh');
  assert.equal(select.children[1], originalOption, 'unchanged polls must preserve native option nodes');
  assert.equal(select.value, 'a');
  assert.equal(select.scrollTop, 80);
  document.activeElement = select;
  tracks = [...tracks, { trackId: 'b', title: 'Second song' }];
  await click('djuke-refresh');
  assert.equal(select.children.length, 2, 'catalog changes wait until the picker loses focus');
  document.activeElement = null;
  for (const callback of select.listeners.blur || []) callback();
  assert.equal(select.children.length, 3);
  assert.equal(select.value, 'a');
  assert.equal(select.scrollTop, 80);
  const updatedOption = select.children[1];
  catalogFail = true;
  await click('djuke-refresh');
  assert.equal(select.children[1], updatedOption, 'transient errors must not destroy the song menu');
  assert.equal(select.disabled, true);
  assert.match(element('djuke-queue-state').textContent, /Queue unavailable/);
  catalogFail = false;
  await click('djuke-refresh');
  assert.equal(select.children[1], updatedOption);
  assert.equal(select.disabled, false);
  select.value = '';
  assert.equal(element('djuke-payment-state').textContent, '');
  assert.equal(element('djuke-pay').disabled, false);
  await click('djuke-pay');
  assert.equal(element('djuke-payment-state').textContent, 'Connect your wallet in the header to queue a song');
  const row = element('djuke-earners').children[0];
  assert.equal(row.children[1].textContent, 'musician.eth');
  assert.match(row.children[1].href, /^https:\/\/basescan.org\/address\/0x/);
  assert.equal(row.children[2].textContent, '1.13');
  context.window._wallet = { address, signer: {}, chainId: 8453 };
  document.dispatchEvent({ type: 'wallet-connected' });
  assert.equal(element('djuke-payment-state').textContent, '');
  assert.equal(element('djuke-pay').disabled, true, 'a connected wallet still needs a selected song');
  await click('djuke-info');
  document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(element('djuke-tab').getAttribute('aria-expanded'), 'true');
  await click('djuke-instructions-close');
  assert.equal(focused, 'djuke-info');
  await click('djuke-info');
  let stopped = false;
  element('djuke-instructions').listeners.keydown[0]({ key: 'Escape', preventDefault() {},
    stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.equal(element('djuke-instructions').open, false);
  assert.equal(element('djuke-tab').getAttribute('aria-expanded'), 'true');
  earningsFail = true;
  await click('djuke-refresh');
  assert.equal(element('djuke-earners').children.length, 0);
  assert.match(element('djuke-earners-state').textContent, /unavailable/);
  await click('djuke-close');
  playlistReceipts = [{ payer: address, name: 'BoogieNight', status: 'refunded', songs: [{ status: 'refunded' }],
    subtotalUnits: '250000', feeUnits: '3000000', refundedUnits: '3250000', transactionHash: `0x${'a'.repeat(64)}` }];
  element('creator-profile').showModal();
  document.dispatchEvent({ type: 'creator-profile-view-changed', detail: { address } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('djuke-tab').getAttribute('aria-expanded'), 'false');
  assert.equal(element('djuke-receipts').hidden, false, 'own profile loads receipts without opening DJuke');
  assert.equal(element('djuke-receipt-list').children.length, 1);
  assert.equal(typeof scheduled, 'function', 'profile keeps receipt updates scheduled');
  const beforePoll = queueReads;
  await scheduled();
  assert.ok(queueReads > beforePoll);
  document.dispatchEvent({ type: 'creator-profile-view-changed', detail: { address: `0x${'2'.repeat(40)}` } });
  assert.equal(element('djuke-receipts').hidden, true, 'other profiles never show the connected wallet receipts');
  assert.equal(scheduled, null);
  document.dispatchEvent({ type: 'creator-profile-view-changed', detail: { address } });
  await new Promise(resolve => setImmediate(resolve));
  context.window._wallet = null;
  document.dispatchEvent({ type: 'wallet-disconnected' });
  assert.equal(element('djuke-receipts').hidden, true);
  element('creator-profile').close();
  assert.equal(scheduled, null, 'closing the profile stops receipt polling when DJuke is closed');
});

test('v0.2 payment verifies a worker quote and sends exactly the doubled ETH contribution', async () => {
  const { payForDjukeSong } = await import('../js/djuke.mjs');
  const previous = global.ethers;
  try {
    const worker = { address: `0x${'3'.repeat(40)}`, signTypedData: async () => '0xsignature' };
    global.ethers = { verifyTypedData: () => worker.address };
    const fixture = paymentFixture({ allowance: 250000n });
    fixture.signer.provider.getBalance = async () => 100000n;
    const listener = await fixture.signer.getAddress();
    const quote = { listener, songId: fixture.songId, maxPrice: '250000', fulfillmentCostWei: '1000', nonce: '0',
      deadline: Math.floor(Date.now() / 1000) + 120, contributionWei: '2000', contractAddress: fixture.djuke.target, chainId: 8453 };
    quote.signature = await worker.signTypedData();
    fixture.djuke.gasWorker = async () => worker.address;
    fixture.djuke.maxGasContributionWei = async () => 10000n;
    fixture.djuke.gasQuoteNonces = async () => 0n;
    fixture.djuke.requestPlayWithGas = async (...args) => {
      fixture.calls.push(['gas-request', args.at(-1).value]);
      return { hash: '0xgas', wait: async () => ({ status: 1 }) };
    };
    fixture.djuke.requestPlayWithGas.staticCall = async () => {};
    await payForDjukeSong({ ...fixture, gasQuote: quote });
    assert.deepEqual(fixture.calls, [['gas-request', 2000n]]);
    await assert.rejects(payForDjukeSong({ ...fixture, gasQuote: { ...quote, contributionWei: '4000' } }), /Invalid worker gas quote/);
    const sponsoredQuote = { ...quote, contributionWei: '0', fulfillmentCostWei: '0' };
    fixture.djuke.CONTRACT_VERSION = async () => '0.4';
    await assert.rejects(payForDjukeSong({ ...fixture, gasQuote: sponsoredQuote }), /Invalid worker gas quote/);
    fixture.djuke.CONTRACT_VERSION = async () => '0.5';
    await payForDjukeSong({ ...fixture, gasQuote: sponsoredQuote });
    assert.deepEqual(fixture.calls.at(-1), ['gas-request', 0n]);
  } finally { global.ethers = previous; }
});