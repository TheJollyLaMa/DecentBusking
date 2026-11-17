const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const read = file => readFileSync(join(root, file), 'utf8');

test('recording release room exposes accessible review and explicit performer choices', () => {
  const html = read('recording-edit.html');
  const index = read('index.html');
  const editor = read('js/live-recording-editor.mjs');
  const panel = read('js/recording-edit-panel.mjs');
  const profile = read('js/live-performance-profile.mjs');
  const cards = read('js/nft-card.js');
  const css = read('css/live-recording-edit.css');
  const appCss = read('css/styles.css');

  for (const control of ['recording-edit-audio', 'recording-edit-waveform', 'recording-edit-save',
    'recording-edit-defer', 'recording-edit-full', 'recording-edit-split']) assert.ok(html.includes(control));
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /aria-label="Waveform of the preserved original recording"/);
  assert.match(html, /IPFS audio is public/);
  assert.match(editor, /scope: 'recording-edit'/);
  assert.match(editor, /signMessage\(message\)/);
  assert.match(editor, /recording-edit-approve/);
  assert.match(editor, /catalog-recording-edit/);
  assert.match(editor, /markDraftChanged/);
  assert.match(editor, /flush-recording-draft/);
  assert.match(editor, /validateCatalogRecordingDraft/);
  assert.match(editor, /sourceSamples/);
  assert.match(profile, /recording-edit\.html\?booking=/);
  assert.match(profile, /Review your live recording/);
  assert.match(css, /@media/);
  assert.match(index, /id="recording-edit-panel"/);
  assert.match(index, /id="recording-edit-frame"/);
  assert.match(panel, /data-recording-edit/);
  assert.match(panel, /data-catalog-recording-edit/);
  assert.match(panel, /decentbusking:flush-recording-draft/);
  assert.match(cards, /canEditCatalogRecording/);
  assert.match(appCss, /#recording-edit-panel\.is-open/);
});

class StudioElement {
  constructor() {
    this.handlers = new Map();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.value = '';
    const classes = new Set();
    this.classList = {
      contains: key => classes.has(key),
      toggle: (key, on) => on ? classes.add(key) : classes.delete(key),
    };
  }
  addEventListener(type, handler) { this.handlers.set(type, handler); }
  dispatchEvent(event) { return this.handlers.get(event.type)?.(event); }
  setAttribute(key, value) { this.attributes[key] = value; }
  append(child) { this.children.push(child); }
  replaceChildren() { this.children = []; }
  querySelector() { return this.paragraph ||= new StudioElement(); }
  click() { return this.handlers.get('click')?.(); }
  focus() {}
}

const artist = `0x${'1'.repeat(40)}`, other = `0x${'2'.repeat(40)}`, collection = `0x${'3'.repeat(40)}`;
const song = (wallet = artist, tokenId = 1) => ({
  chainId: 8453, contractAddress: collection, tokenId, artist: wallet,
  nftId: `8453:${collection}:${tokenId}`, name: `Song ${tokenId}`, audioUrl: `ipfs://${'a'.repeat(46)}`, mediaType: 'audio/mpeg',
});
const settled = () => new Promise(resolve => setImmediate(resolve));

async function studio(t, fetchPage = async () => ({ nfts: [song()], nextOffset: null })) {
  const { initRecordingEditPanel } = await import('../js/recording-edit-panel.mjs');
  const ids = ['panel', 'frame', 'tab', 'panel-close', 'search', 'library', 'library-status', 'more', 'opening'];
  const elements = Object.fromEntries(ids.map(id => [id, new StudioElement()]));
  elements.frame.src = 'about:blank';
  const posts = [];
  elements.frame.contentWindow = { postMessage: value => posts.push(value) };
  const document = new StudioElement();
  document.body = new StudioElement();
  document.getElementById = id => elements[id.replace('recording-edit-', '')];
  document.createElement = () => new StudioElement();
  const window = new StudioElement();
  window.location = { href: 'https://example.test/DecentBusking/', origin: 'https://example.test' };
  window.CustomEvent = CustomEvent;
  window.crypto = globalThis.crypto;
  window.DecentConfig = {};
  window._wallet = { address: artist, signer: {} };
  initRecordingEditPanel({ document, window, fetchPage });
  t.after(() => {
    window._wallet = {};
    document.dispatchEvent(new Event('wallet-disconnected'));
  });
  const clickSource = (key, id) => document.dispatchEvent({
    type: 'click', preventDefault() {},
    target: { closest: selector => selector === `[data-${key === 'catalog' ? 'catalog-recording-edit' : 'recording-edit'}]`
      ? { dataset: key === 'catalog' ? { catalogRecordingEdit: id } : { recordingEdit: id } } : null },
  });
  const message = (data, origin = window.location.origin) => window.dispatchEvent({
    type: 'message', origin, source: elements.frame.contentWindow, data,
  });
  return { elements, posts, document, window, clickSource, message };
}

test('studio discovers only artist audio across pages and opens canonical booking IDs', async t => {
  const calls = [];
  const ui = await studio(t, async args => {
    calls.push(args);
    return args.offset === 0 ? { nfts: [song(other), { ...song(), mediaType: 'video/mp4' }], nextOffset: 25 }
      : { nfts: [song()], nextOffset: null };
  });
  await settled();
  assert.deepEqual(calls.map(call => call.offset), [0, 25]);
  assert.ok(calls.every(call => call.artist === artist));
  assert.equal(ui.elements.tab.hidden, false);
  assert.equal(ui.elements.library.children.length, 1);
  const bookingId = 'friday-live-performance:2026-11-13:withinthevacuum';
  await ui.clickSource('booking', bookingId);
  const openedUrl = ui.elements.frame.src;
  assert.equal(new URL(openedUrl).searchParams.get('booking'), bookingId);
  assert.equal(ui.elements.panel.inert, false);
  assert.equal(ui.elements.opening.hidden, false);
  await ui.clickSource('booking', 'invalid/<booking>');
  assert.equal(ui.elements.frame.src, openedUrl);
});

test('studio hides access for non-creators and ignores old-wallet catalog results', async t => {
  const requests = [];
  const ui = await studio(t, args => new Promise(resolve => requests.push({ ...args, resolve })));
  ui.window._wallet = { address: other, signer: {} };
  ui.document.dispatchEvent(new Event('wallet-connected'));
  requests[1].resolve({ nfts: [song(other, 2)], nextOffset: null });
  await settled();
  requests[0].resolve({ nfts: [song()], nextOffset: null });
  await settled();
  assert.equal(ui.elements.library.children[0].children[0].textContent, 'Song 2 · #2');
  ui.window._wallet = { address: artist, signer: {} };
  ui.document.dispatchEvent(new Event('wallet-connected'));
  requests[2].resolve({ nfts: [song(other)], nextOffset: null });
  await settled();
  assert.equal(ui.elements.tab.hidden, true);
  await ui.clickSource('catalog', song().nftId);
  assert.equal(ui.elements.frame.src, 'about:blank');
  ui.window._wallet = {};
  ui.document.dispatchEvent(new Event('wallet-disconnected'));
  assert.equal(ui.elements.library.children.length, 0);
  assert.equal(ui.elements.panel.inert, true);
});

test('studio authenticates frame messages and retains the panel after failed draft flush', async t => {
  const ui = await studio(t);
  await settled();
  await ui.clickSource('catalog', song().nftId);
  const requestId = new URL(ui.elements.frame.src).searchParams.get('studioRequest');
  ui.message({ type: 'decentbusking:editor-ready', requestId }, 'https://other.example');
  assert.equal(ui.elements.opening.hidden, false);
  ui.message({ type: 'decentbusking:editor-ready', requestId });
  assert.equal(ui.elements.opening.hidden, true);
  ui.elements['panel-close'].click();
  ui.message({ type: 'decentbusking:recording-draft-flush-failed', requestId: ui.posts.at(-1).requestId });
  assert.equal(ui.elements.panel.inert, false);
  assert.match(ui.elements['library-status'].textContent, /could not be saved/);
  ui.elements['panel-close'].click();
  ui.message({ type: 'decentbusking:recording-draft-flushed', requestId: ui.posts.at(-1).requestId });
  assert.equal(ui.elements.panel.inert, true);
});

test('typing a search immediately rejects the previous response before the debounce expires', async t => {
  const requests = [];
  const ui = await studio(t, args => new Promise(resolve => requests.push({ ...args, resolve })));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  ui.elements.search.value = 'second';
  ui.elements.search.dispatchEvent(new Event('input'));
  requests[0].resolve({ nfts: [song()], nextOffset: null });
  await settled();
  assert.equal(ui.elements.library.children.length, 0);
  t.mock.timers.tick(251);
  assert.equal(requests[1].query, 'second');
  requests[1].resolve({ nfts: [song(artist, 2)], nextOffset: null });
  await settled();
  assert.equal(ui.elements.library.children[0].children[0].textContent, 'Song 2 · #2');
});

test('catalog draft saves and approvals survive a thirty-second export response', async t => {
  const { roomRequest } = await import('../js/live-audio-client.mjs');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('Request timed out')), milliseconds);
    return controller.signal;
  });
  const pending = Promise.all(['catalog-recording-edit-save', 'catalog-recording-edit-approve'].map(action =>
    roomRequest('https://fixture.test', 'control', { action }, 'fixture', async (_url, { signal }) => {
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        setTimeout(resolve, 30000);
      });
      return { ok: true, json: async () => ({ available: true }) };
    })));
  t.mock.timers.tick(30001);
  assert.deepEqual(await pending, [{ available: true }, { available: true }]);
});
