const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Node {
  constructor() {
    this.children = [];
    this.value = '';
    this.style = {};
    this.listeners = new Map();
    this.text = '';
  }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(' '); }
  get options() { return this.children; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

const walletA = `0x${'1'.repeat(40)}`;
const walletB = `0x${'2'.repeat(40)}`;
const week = { week: '2026-W41', current: true, totalPlays: 7, trackCount: 1,
  tracks: [{ title: 'Song A', artist: 'Artist A', uploadedAt: '2026-10-01T00:00:00Z', plays: 7, likes: 12, dislikes: 2 }] };

function historyPage(fetchImpl) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, new Node());
    return nodes.get(id);
  };
  const events = new Map();
  node('radio-history-dialog').querySelector = () => node('note');
  const window = { _wallet: { address: walletA }, DecentConfig: { ipfsUploadServiceUrl: 'https://worker.example' } };
  const context = vm.createContext({ window, URLSearchParams, fetch: fetchImpl,
    document: { getElementById: node, createElement: () => new Node(),
      addEventListener: (name, callback) => events.set(name, callback) } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/radio-history.js'), 'utf8'), context);
  events.get('DOMContentLoaded')();
  return { node, window, events, open: mode => events.get('open-radio-history')({ detail: { mode, wallet: walletB } }) };
}

test('public Playback Tally stays global and its song/artist/date filters remain usable', async () => {
  const requests = [];
  const page = historyPage(async url => {
    requests.push(url);
    return { ok: true, json: async () => ({ weeks: [week] }) };
  });
  await page.open('totals');
  assert.equal(new URL(requests[0]).searchParams.has('wallet'), false);
  assert.equal(page.node('radio-history-title').textContent, 'Playback Tally');
  assert.equal(page.node('radio-history-rewards').hidden, true);
  assert.match(page.node('radio-history-content').textContent, /7 qualifying plays/);
  page.node('radio-history-search').value = 'Song A';
  page.node('radio-history-artist').value = 'Artist A';
  page.node('radio-history-from').value = '2026-10-01';
  page.node('radio-history-to').value = '2026-10-01';
  page.node('radio-history-search').listeners.get('input')();
  assert.match(page.node('radio-history-content').textContent, /7 matching plays/);
  page.node('radio-history-from').value = '2026-10-02';
  page.node('radio-history-from').listeners.get('change')();
  assert.match(page.node('radio-history-content').textContent, /0 matching plays/);
});

test('My Playback Tally uses only the connected wallet and refreshes on account change', async () => {
  const requests = [];
  const page = historyPage(async url => {
    requests.push(url);
    return { ok: true, json: async () => ({ weeks: [week] }) };
  });
  await page.open('personal');
  assert.equal(new URL(requests[0]).searchParams.get('wallet'), walletA);
  assert.equal(page.node('radio-history-title').textContent, 'My Playback Tally');
  assert.equal(page.node('radio-history-rewards').hidden, false);
  page.window._wallet.address = walletB;
  page.events.get('wallet-connected')();
  assert.equal(new URL(requests[1]).searchParams.get('wallet'), walletB);
  page.window._wallet.address = null;
  page.events.get('wallet-disconnected')();
  assert.equal(page.node('radio-history-dialog').open, false);
  assert.equal(page.node('radio-history-rewards').hidden, true);
  await page.open('personal');
  assert.equal(requests.length, 2);
  assert.match(page.node('radio-history-content').textContent, /Connect your wallet/);
});

test('personal tally defaults to historical all-time plays and preserves weekly filtering', async () => {
  let requestedUrl;
  const allTime = { ...week, week: 'all-time', totalPlays: 518, tracks: [{ ...week.tracks[0], plays: 518 }] };
  const page = historyPage(async url => {
    requestedUrl = new URL(url);
    return { ok: true, json: async () => ({ weeks: [{ ...week, totalPlays: 0, trackCount: 0, tracks: [] }, allTime] }) };
  });
  await page.open('personal');
  assert.equal(requestedUrl.searchParams.get('wallet'), walletA);
  assert.equal(requestedUrl.searchParams.get('includeAllTime'), '1');
  assert.equal(page.node('radio-history-week').value, 'all-time');
  assert.match(page.node('radio-history-content').textContent, /518 recorded plays/);
  assert.match(page.node('radio-history-content').textContent, /legacy Discord announcement counts/);
  page.node('radio-history-search').value = 'Song A';
  page.node('radio-history-search').listeners.get('input')();
  assert.match(page.node('radio-history-content').textContent, /518 matching plays.*518 total all time/);
  page.node('radio-history-search').value = '';
  page.node('radio-history-week').value = week.week;
  page.node('radio-history-week').listeners.get('change')();
  assert.match(page.node('radio-history-content').textContent, /0 qualifying plays/);
});

test('a late personal response cannot overwrite public totals or reopen disconnected data', async () => {
  let complete;
  const page = historyPage(url => new URL(url).searchParams.has('wallet')
    ? new Promise(resolve => { complete = resolve; })
    : Promise.resolve({ ok: true, json: async () => ({ weeks: [week] }) }));
  const pending = page.open('personal');
  await page.open('totals');
  complete({ ok: true, json: async () => ({ weeks: [] }) });
  await pending;
  assert.equal(page.node('radio-history-title').textContent, 'Playback Tally');
  assert.match(page.node('radio-history-content').textContent, /7 qualifying plays/);
  const disconnected = page.open('personal');
  page.window._wallet.address = null;
  page.events.get('wallet-disconnected')();
  complete({ ok: true, json: async () => ({ weeks: [week] }) });
  await disconnected;
  assert.equal(page.node('radio-history-content').textContent, '');
  assert.equal(page.node('radio-history-dialog').open, false);
});

test('both tally modes show all-time song votes and recompute filtered artist totals', async () => {
  const report = { ...week, totalPlays: 10, trackCount: 2,
    tracks: [...week.tracks, { title: 'Song B', artist: 'Artist A', uploadedAt: '2026-10-02T00:00:00Z', plays: 3, likes: 4, dislikes: 1 }] };
  for (const mode of ['totals', 'personal']) {
    const page = historyPage(async () => ({ ok: true, json: async () => ({ weeks: [report] }) }));
    await page.open(mode);
    const content = page.node('radio-history-content');
    assert.match(content.textContent, /all-time totals/);
    const artistBody = content.children[3].children[0].children[1];
    assert.deepEqual(artistBody.children[0].children.map(cell => cell.textContent), ['Artist A', '2', '10', '16', '3']);
    const songBody = content.children[5].children[0].children[1];
    assert.deepEqual(songBody.children[0].children.slice(-3).map(cell => cell.textContent), ['7', '12', '2']);
    page.node('radio-history-search').value = 'Song B';
    page.node('radio-history-search').listeners.get('input')();
    const filteredArtist = content.children[3].children[0].children[1].children[0];
    assert.deepEqual(filteredArtist.children.map(cell => cell.textContent), ['Artist A', '1', '3', '4', '1']);
  }
});

test('Right Ankh contains only My Playbacks and hides it on disconnect', () => {
  const nodes = new Map(['.ankh-coin', '.dropdown-menu.right-ankh-menu', '#radio-history-btn'].map(selector => [selector, new Node()]));
  const root = { innerHTML: '', querySelector: selector => nodes.get(selector) };
  const events = new Map();
  const window = { _wallet: { address: walletA } };
  let dispatched;
  const context = vm.createContext({ window, customElements: { get: () => ({}) },
    HTMLElement: class { attachShadow() { this.shadowRoot = root; } },
    CustomEvent: class { constructor(name, options) { this.type = name; this.detail = options.detail; } },
    document: { addEventListener: (name, callback) => events.set(name, callback), dispatchEvent: event => { dispatched = event; } } });
  const source = fs.readFileSync(path.join(__dirname, '../js/components/header-right-ankh-override.js'), 'utf8');
  vm.runInContext(`${source}\nnew CleanRightAnkh().connectedCallback();`, context);
  assert.equal((root.innerHTML.match(/<li /g) || []).length, 1);
  assert.match(root.innerHTML, /My Playbacks/);
  assert.doesNotMatch(root.innerHTML, /wallet-connect-btn|wallet-addr-display/);
  const button = nodes.get('#radio-history-btn');
  assert.equal(button.style.display, 'block');
  button.listeners.get('click')({ stopPropagation() {} });
  assert.equal(dispatched.detail.mode, 'personal');
  assert.equal(dispatched.detail.wallet, walletA);
  window._wallet.address = null;
  events.get('wallet-disconnected')();
  assert.equal(button.style.display, 'none');
  assert.equal(nodes.get('.dropdown-menu.right-ankh-menu').style.display, 'none');
});

test('header registers the local Right Ankh before CDN imports without loading the legacy dropdown', () => {
  const registered = new Map();
  const context = vm.createContext({ customElements: { get: name => registered.get(name), define: (name, constructor) => registered.set(name, constructor) },
    HTMLElement: class {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/components/header-right-ankh-override.js'), 'utf8'), context);
  assert.equal(registered.get('right-ankh').name, 'CleanRightAnkh');
  const header = fs.readFileSync(path.join(__dirname, '../js/components/header.js'), 'utf8');
  assert.match(header, /^import '\.\/header-right-ankh-override\.js\?v=20261007-my-playbacks';/);
  assert.doesNotMatch(header, /import\([^\n]*RightAnkhDropdown/);
});