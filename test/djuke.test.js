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
  for (const id of ['djuke-connect', 'djuke-search-results', 'djuke-search-more', 'djuke-profile', 'djuke-playlist', 'community-pin-heading']) {
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
  assert.match(html, /id="djuke-panel"[^>]*inert/);
  assert.match(html, /id="devert-panel"[^>]*inert/);
  assert.match(html, /<dt>IPFS pinning rewards<\/dt><dd>8%<\/dd>/);
  assert.match(html, /<dt>Repo development fund<\/dt><dd>2%<\/dd>/);
  assert.match(config, /contractAddress: "0x64D5aDc50E5513975EfF7e9ba366B7eE58586fa3"/);
  assert.match(config, /additionalNftContractAddresses: \["0xe63EC9f8228720bAAC2fD528C0A6d06B3Dc5439B"\]/);
  assert.match(config, /djukeContractAddress: "0x5d07489163feBCdB39C9F579CCC36dff5A067FF9"/);
  assert.match(config, /djukeContractVersion: "0.3"/);
  assert.match(config, /nftBatchMintEnabled: true/);
  for (const tab of ['top-ten', 'djuke', 'devert']) assert.match(html, new RegExp(`id="${tab}-tab"[^>]*aria-controls="${tab}-panel"`));
  assert.match(html, /class="djuke-tab-slot">⚸🎰🧞‍♂️/);
  assert.match(html, /class="djuke-tab-coin">🪙/);
  const search = html.indexOf('id="djuke-search"');
  const select = html.indexOf('id="djuke-song"');
  const queue = html.indexOf('id="djuke-pay"');
  const worker = html.indexOf('class="worker-gas-notice"');
  assert.ok(search < select && select < queue && queue < worker);
});

test('worker funding remains available beside mint and paid queue controls', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
  const djukePay = html.indexOf('id="djuke-pay"');
  const workerNotice = html.indexOf('class="worker-gas-notice"');
  assert.ok(djukePay < workerNotice);
  const notice = html.slice(workerNotice, html.indexOf('id="djuke-payment-state"', workerNotice));
  assert.match(notice, /ETH/);
  assert.match(notice, /0x4894698f2B5cAF13Fad4Aa8fbaFE3618b960909F/);
  assert.match(notice, /Worker balance is monitored/);
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
  } finally { global.ethers = previous; }
});