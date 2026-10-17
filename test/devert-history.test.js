const test = require('node:test');
const assert = require('node:assert/strict');

const tx = digit => `0x${digit.repeat(64)}`;
const routerAddress = `0x${'a'.repeat(40)}`;
const source = (overrides = {}) => ({ kind: 'advert', txHash: tx('1'), fundId: tx('a'),
  logIndex: 1, blockNumber: 100, timestamp: 1792235025, amountUnits: '450000', paidAdvert: true,
  requestId: '0', campaignId: '2', title: 'Radio advert', ...overrides });
const state = sources => ({ ready: true, chainId: 8453, routerAddress, lastError: '', funds: {
  playback: { label: 'Playback', sources },
} });

test('advert history groups exact destinations once per log, excludes unrelated funding and sorts newest first', async () => {
  const { advertFundingHistory } = await import('../js/devert-history.mjs');
  const input = state([source(), source(), source({ kind: 'sponsor', amountUnits: '999999999' }),
    source({ txHash: tx('2'), logIndex: 9, blockNumber: 90, amountUnits: '5000000', paidAdvert: false, title: undefined })]);
  input.funds.top10 = { label: 'Top 10', sources: [source({ fundId: tx('b'), logIndex: 2 })] };
  input.funds.pinners = { label: 'Pinners', sources: [source({ fundId: tx('c'), logIndex: 3, amountUnits: '80000' })] };
  input.funds.dev = { label: 'Development', sources: [source({ fundId: tx('d'), logIndex: 4, amountUnits: '20000' })] };
  const result = advertFundingHistory(input);
  assert.equal(result.totalUnits, 6000000n);
  assert.equal(result.transactions.length, 2);
  assert.equal(result.transactions[0].totalUnits, 1000000n);
  assert.deepEqual(result.transactions[0].destinations.map(d => d.units), [450000n, 450000n, 80000n, 20000n]);
  assert.deepEqual(result.transactions[0].titles, ['Radio advert']);
  assert.deepEqual(result.transactions[0].requestIds, ['0']);
  assert.equal(result.transactions[1].paidAdvert, false);
  assert.deepEqual(result.transactions[1].titles, []);
  assert.equal(input.funds.playback.sources.length, 4);
});

test('history refuses incomplete, failed and malformed ledgers instead of claiming zero funding', async () => {
  const { advertFundingHistory } = await import('../js/devert-history.mjs');
  for (const input of [null, { ...state([]), ready: false }, { ...state([]), lastError: 'RPC failed' },
    { ...state([]), chainId: 1 }, state([source({ txHash: 'javascript:alert(1)' })]),
    state([source({ amountUnits: '-1' })]), state([source({ fundId: 'invalid' })])]) {
    assert.throws(() => advertFundingHistory(input));
  }
  assert.equal(advertFundingHistory(state([])).totalUnits, 0n);
});

test('history loads lazily, paginates confirmed entries and clears stale data on refresh failure', async () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const { formatUsdcUnits } = await import('../js/usdc-format.mjs');
  const nodes = new Map();
  const element = id => {
    if (nodes.has(id)) return nodes.get(id);
    const node = { children: [], listeners: {}, open: false, hidden: false, textContent: '',
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      addEventListener(event, callback) { this.listeners[event] = callback; } };
    nodes.set(id, node);
    return node;
  };
  let requests = 0;
  let offline = false;
  const data = state(Array.from({ length: 12 }, (_, index) => source({
    txHash: `0x${(index + 1).toString(16).padStart(64, '0')}`, blockNumber: 100 + index,
  })));
  const context = vm.createContext({ formatUsdcUnits, AbortSignal,
    document: { getElementById: element, createElement: tag => element(`${tag}-${nodes.size}`), addEventListener() {} },
    window: { DecentConfig: { ipfsUploadServiceUrl: 'https://service.example' } },
    fetch: async () => { requests++; if (offline) throw new Error('offline'); return { ok: true, json: async () => data }; },
  });
  const sourceCode = fs.readFileSync(path.join(__dirname, '../js/devert-history.mjs'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export /g, '');
  vm.runInContext(`${sourceCode}\ninitDevertHistory();`, context);
  assert.equal(requests, 0);
  element('devert-history').open = true;
  element('devert-history').listeners.toggle();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1);
  assert.equal(element('devert-history-list').children.length, 10);
  assert.equal(element('devert-history-more').hidden, false);
  element('devert-history-more').listeners.click();
  assert.equal(element('devert-history-list').children.length, 12);
  assert.equal(element('devert-history-more').hidden, true);
  const first = element('devert-history-list').children[0];
  assert.match(first.children[3].href, /^https:\/\/basescan.org\/tx\/0x/);
  assert.match(element('devert-history-total').textContent, /5.40 USDC funded · 12 transactions/);
  offline = true;
  await element('devert-history-refresh').listeners.click();
  assert.equal(element('devert-history-list').children.length, 0);
  assert.equal(element('devert-history-total').textContent, '');
  assert.match(element('devert-history-status').textContent, /unavailable: offline/);
});
