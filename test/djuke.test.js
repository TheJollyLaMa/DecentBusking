const test = require('node:test');
const assert = require('node:assert/strict');

test('DJuke starts at 0.25 USDC and doubles after each eight pending requests', async () => {
  const { quoteDjuke } = await import('../js/djuke.mjs');
  for (const [pending, expected] of [[0, 250000n], [7, 250000n], [8, 500000n],
    [15, 500000n], [16, 1000000n], [23, 1000000n], [24, 2000000n], [32, 4000000n]]) {
    assert.equal(quoteDjuke(pending).priceUnits, expected);
  }
  assert.equal(quoteDjuke(7).priceUnits, 250000n);
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

test('DJuke displays prices and fractional-cent splits without rounding', async () => {
  const { formatDjukeUsdc } = await import('../js/djuke.mjs');
  assert.equal(formatDjukeUsdc(250000n), '0.25');
  assert.equal(formatDjukeUsdc(1000000n), '1.00');
  assert.equal(formatDjukeUsdc(225000n), '0.225');
  assert.equal(formatDjukeUsdc(25000n), '0.025');
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

function paymentFixture({ chainId = 8453n, price = 250000n, balance = 1000000n, allowance = 0n } = {}) {
  const calls = [];
  const confirmed = hash => ({ hash, wait: async () => ({ status: 1 }) });
  const requestPlay = async (songId, maxPrice) => { calls.push(['requestPlay', songId, maxPrice]); return confirmed('0xrequest'); };
  requestPlay.staticCall = async () => {};
  const djuke = { target: `0x${'d'.repeat(40)}`, quote: async () => price, requestPlay };
  const usdc = { target: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: async () => 6n,
    balanceOf: async () => balance, allowance: async () => allowance,
    approve: async (spender, amount) => { calls.push(['approve', spender, amount]); return confirmed('0xapprove'); } };
  const signer = { provider: { getNetwork: async () => ({ chainId }) }, getAddress: async () => `0x${'1'.repeat(40)}` };
  return { calls, signer, djuke, usdc, songId: `0x${'a'.repeat(64)}`, maxPriceUnits: 250000n };
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

test('DJuke payment refuses wrong networks, price increases and low balances before any wallet prompt', async () => {
  const { payForDjukeSong } = await import('../js/djuke.mjs');
  for (const [options, message] of [[{ chainId: 1n }, /Base/], [{ price: 500000n }, /Price rose/], [{ balance: 1n }, /need 0.25 USDC/]]) {
    const fixture = paymentFixture(options);
    await assert.rejects(payForDjukeSong(fixture), message);
    assert.deepEqual(fixture.calls, []);
  }
});

test('DJuke drawer contains queue, pricing, and gated wallet controls', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
  const config = require('node:fs').readFileSync(require('node:path').join(__dirname, '../decent.config.js'), 'utf8');
  for (const id of ['djuke-tab', 'djuke-panel', 'djuke-queue', 'djuke-price-tiers', 'djuke-connect']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="djuke-pay"[^>]*disabled/);
  assert.match(html, /id="djuke-panel"[^>]*inert/);
  assert.match(config, /contractAddress: "0x64D5aDc50E5513975EfF7e9ba366B7eE58586fa3"/);
  assert.match(config, /additionalNftContractAddresses: \["0xe63EC9f8228720bAAC2fD528C0A6d06B3Dc5439B"\]/);
  assert.match(config, /djukeContractAddress: "0x333Aa353d6fc70aE79Cf91CE090645CD740FEf59"/);
  assert.match(config, /djukeContractVersion: "0.2"/);
  assert.match(config, /nftBatchMintEnabled: true/);
  for (const tab of ['top-ten', 'djuke', 'devert']) assert.match(html, new RegExp(`id="${tab}-tab"[^>]*aria-controls="${tab}-panel"`));
  assert.match(html, /class="djuke-tab-slot">⚸🎰🧞‍♂️/);
  assert.match(html, /class="djuke-tab-coin">🪙/);
});

test('worker gas reminders precede import, mint and paid queue controls', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
  for (const [startId, controlId] of [['djuke-body', 'djuke-pay'],
    ['admin-reviewed-album-import', 'admin-reviewed-album-import-btn'], ['admin-mint-section', 'admin-mint-queue']]) {
    const start = startId === 'djuke-body' ? html.indexOf('class="djuke-body"') : html.indexOf(`id="${startId}"`);
    const control = html.indexOf(`id="${controlId}"`, start);
    const notice = html.slice(start, control);
    assert.match(notice, /class="worker-gas-notice"/);
    assert.match(notice, /ETH on Base/);
    assert.match(notice, /0x4894698f2B5cAF13Fad4Aa8fbaFE3618b960909F/);
    assert.match(notice, /Balance is not checked here/);
  }
  assert.match(html, /NFT mint gas is paid by your connected wallet/);
});

test('DJuke search matches song titles and creators without selecting a song implicitly', async () => {
  const { filterDjukeSongs } = await import('../js/djuke.mjs');
  const tracks = [{ trackId: 'a', title: 'Heart of Gold', artist: 'thejollylama', creator: '0xabc' },
    { trackId: 'b', title: 'Other', artist: 'Someone' }];
  assert.deepEqual(filterDjukeSongs(tracks, 'heart jolly').map(track => track.trackId), ['a']);
  assert.deepEqual(filterDjukeSongs(tracks, '0xabc').map(track => track.trackId), ['a']);
  assert.deepEqual(filterDjukeSongs(tracks, 'missing'), []);
});

test('v0.2 payment verifies a worker quote and sends exactly the doubled ETH contribution', async () => {
  const { payForDjukeSong } = await import('../js/djuke.mjs');
  const { createRequire } = require('node:module');
  const library = createRequire(require('node:path').join(__dirname, '../discord-bot/package.json'))('ethers');
  const { GAS_QUOTE_TYPES } = await import('../discord-bot/djuke-gas.js');
  const previous = global.ethers;
  global.ethers = library;
  try {
    const worker = library.Wallet.createRandom();
    const fixture = paymentFixture({ allowance: 250000n });
    fixture.signer.provider.getBalance = async () => 100000n;
    const listener = await fixture.signer.getAddress();
    const quote = { listener, songId: fixture.songId, maxPrice: '250000', fulfillmentCostWei: '1000', nonce: '0',
      deadline: Math.floor(Date.now() / 1000) + 120, contributionWei: '2000', contractAddress: fixture.djuke.target, chainId: 8453 };
    quote.signature = await worker.signTypedData({ name: 'DecentJukeBox', version: '0.2', chainId: 8453, verifyingContract: fixture.djuke.target }, GAS_QUOTE_TYPES, quote);
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
  } finally { global.ethers = previous; }
});