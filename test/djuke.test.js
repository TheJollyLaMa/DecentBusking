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
  assert.match(config, /djukeContractAddress: "0x153ef59a57C9A88cbB7822252B5d9D0B11E48F0E"/);
  assert.match(config, /nftBatchMintEnabled: true/);
});