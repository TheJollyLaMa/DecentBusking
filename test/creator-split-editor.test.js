const test = require('node:test');
const assert = require('node:assert/strict');

test('row editor accepts exact two-decimal percentages and resolves ENS without rounding', async () => {
  const { splitPercentToBps, resolveSplitEditorRows } = await import('../js/creator-split-editor.mjs');
  const first = `0x${'1'.repeat(40)}`;
  const second = `0x${'2'.repeat(40)}`;
  assert.equal(splitPercentToBps('33.33'), 3333);
  assert.equal(splitPercentToBps('0.01'), 1);
  for (const value of ['', '0', '-1', '100.01', '33.333', '1e2', 'NaN']) {
    assert.throws(() => splitPercentToBps(value));
  }
  assert.deepEqual(await resolveSplitEditorRows([
    { wallet: ` ${first} `, percent: '66.67', position: ' Performer ' },
    { wallet: 'producer.eth', percent: '33.33', position: 'Producer' },
  ], async name => name === 'producer.eth' ? second : null), [
    { wallet: first, shareBps: 6667, position: 'Performer' },
    { wallet: second, shareBps: 3333, position: 'Producer' },
  ]);
  await assert.rejects(resolveSplitEditorRows([
    { wallet: first, percent: '50', position: '' },
    { wallet: 'alias.eth', percent: '50', position: '' },
  ], async () => first), /distinct/);
  await assert.rejects(resolveSplitEditorRows([
    { wallet: 'missing.eth', percent: '100', position: '' },
  ], async () => null), /Could not resolve/);
  await assert.rejects(resolveSplitEditorRows([
    { wallet: first, percent: '99.99', position: '' },
  ], async () => null), /exactly 100%/);
  await assert.rejects(resolveSplitEditorRows([
    { wallet: first, percent: '100', position: 'a'.repeat(81) },
  ], async () => null), /80 characters/);
});

test('song editor and album default controls are separate and have no freeform split text boxes', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.doesNotMatch(html, /textarea name="splits"/);
  assert.match(html, /data-song-split-current-chart/);
  assert.match(html, /data-song-split-review-chart/);
  assert.match(html, /data-song-split-review/);
  assert.match(html, /data-song-split-editor/);
  assert.match(html, /data-album-split-editor/);
  assert.ok(html.indexOf('data-song-split-form') < html.indexOf('data-album-section'));
});

test('song list split uses verified DJuke state, not stale or missing catalog credits', async () => {
  const { readSongSplitForList } = await import('../js/creator-profile.mjs');
  const first = `0x${'1'.repeat(40)}`;
  const second = `0x${'2'.repeat(40)}`;
  const stale = `0x${'3'.repeat(40)}`;
  let song = { audioURI: 'ipfs://recording', enabled: true, recipients: [first, second], sharesBps: [5000n, 5000n] };
  const ethers = { Contract: class { async getSong() { return song; } } };
  const options = { config: { djukeContractAddress: first }, ethers, provider: {}, resolveSongId: async () => 'song-id' };
  const nft = { audioUrl: 'ipfs://recording', creatorSplits: [{ wallet: stale, shareBps: 10000 }] };
  assert.deepEqual(await readSongSplitForList(nft, options), [
    { wallet: first, shareBps: 5000, position: '' },
    { wallet: second, shareBps: 5000, position: '' },
  ]);
  song = { ...song, audioURI: 'ipfs://different' };
  await assert.rejects(readSongSplitForList(nft, options), /does not match/);
  song = { ...song, enabled: false };
  await assert.rejects(readSongSplitForList(nft, options), /not registered or enabled/);
  await assert.rejects(readSongSplitForList(nft, { ...options, provider: null }), /RPC unavailable/);
});

function installChartDocument(t) {
  const previous = global.document;
  class Element extends EventTarget {
    constructor(tag) {
      super();
      this.tag = tag;
      this.children = [];
      this.attributes = {};
      this.style = {};
      this.hidden = false;
      this.textContent = '';
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    contains(target) { return this === target || this.children.some(child => child.contains?.(target)); }
    matches() { return false; }
  }
  global.document = {
    activeElement: null,
    createElement: tag => new Element(tag),
    createElementNS: (_namespace, tag) => new Element(tag),
  };
  t.after(() => {
    if (previous === undefined) delete global.document;
    else global.document = previous;
  });
  return () => new Element('div');
}

test('split pie shows exact shares and clickable ENS or wallet labels on hover and focus', async t => {
  const createRoot = installChartDocument(t);
  const { renderCreatorSplitPie } = await import('../js/creator-split-pie.mjs');
  const first = `0x${'1'.repeat(40)}`;
  const second = `0x${'2'.repeat(40)}`;
  const root = createRoot();
  renderCreatorSplitPie(root, [
    { wallet: first, shareBps: 7500 },
    { wallet: second, shareBps: 2500 },
  ], { size: 'compact', lookupName: async wallet => wallet === second ? 'producer.eth' : null });
  await new Promise(resolve => setImmediate(resolve));
  const [chart] = root.children;
  assert.match(chart.className, /creator-split-pie--compact/);
  const [svg, tooltip] = chart.children;
  const [firstSlice, secondSlice] = svg.children;
  assert.match(firstSlice.children[0].attributes.d, /A 94 94 0 1 1/);
  assert.match(secondSlice.children[0].attributes.d, /A 94 94 0 0 1/);
  assert.equal(tooltip.hidden, true);
  firstSlice.dispatchEvent(new Event('mouseenter'));
  const link = tooltip.children[0];
  assert.equal(link.href, `https://basescan.org/address/${first}`);
  assert.equal(link.children[0].children[1].children.length, 4);
  assert.equal(link.children[1].textContent, '75%');
  secondSlice.dispatchEvent(new Event('focus'));
  assert.equal(link.href, `https://basescan.org/address/${second}`);
  assert.equal(link.children[0].textContent, 'producer.eth');
  assert.equal(link.children[1].textContent, '25%');
  chart.dispatchEvent(new Event('mouseleave'));
  assert.equal(tooltip.hidden, true);
});

test('split pie handles a sole payee and rejects incomplete or invalid shares', async t => {
  const createRoot = installChartDocument(t);
  const { renderCreatorSplitPie } = await import('../js/creator-split-pie.mjs');
  const root = createRoot();
  const wallet = `0x${'3'.repeat(40)}`;
  renderCreatorSplitPie(root, [{ wallet, shareBps: 10000 }], { lookupName: async () => null });
  const [chart] = root.children;
  const [svg, tooltip] = chart.children;
  assert.equal(svg.children[0].children[0].tag, 'circle');
  svg.children[0].dispatchEvent(new Event('click'));
  assert.equal(tooltip.children[0].href, `https://basescan.org/address/${wallet}`);
  assert.equal(tooltip.children[0].children[1].textContent, '100%');
  assert.throws(() => renderCreatorSplitPie(root, [{ wallet, shareBps: 5000 }]), /exactly 100%/);
  assert.equal(root.children[0], chart, 'invalid data does not replace the previous chart');
});
