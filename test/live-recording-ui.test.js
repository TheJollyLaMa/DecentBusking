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
  assert.match(editor, /'recording-preview'/);
  assert.match(editor, /signMessage\(message\)/);
  assert.match(editor, /'recording-publish'/);
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
    this.style = {};
    this.value = '';
    const classes = new Set();
    this.classList = {
      add: key => classes.add(key),
      remove: key => classes.delete(key),
      contains: key => classes.has(key),
      toggle: (key, on) => on ? classes.add(key) : classes.delete(key),
    };
  }
  addEventListener(type, handler) { this.handlers.set(type, handler); }
  dispatchEvent(event) { return this.handlers.get(event.type)?.(event); }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  append(...children) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  querySelector() { return this.paragraph ||= new StudioElement(); }
  click() { return this.handlers.get('click')?.(); }
  focus() {}
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(selector === '[data-time-boundary]' && child.dataset?.timeBoundary ? [child] : []),
      ...(child.querySelectorAll?.(selector) || []),
    ]);
  }
  getBoundingClientRect() { return { left: 0, width: 600, height: 100 }; }
  getContext() { return null; }
  pause() {}
  load() {}
  removeAttribute(key) { delete this.attributes[key]; }
}

const artist = `0x${'1'.repeat(40)}`, other = `0x${'2'.repeat(40)}`, collection = `0x${'3'.repeat(40)}`;
const song = (wallet = artist, tokenId = 1) => ({
  chainId: 8453, contractAddress: collection, tokenId, artist: wallet,
  nftId: `8453:${collection}:${tokenId}`, name: `Song ${tokenId}`, audioUrl: `ipfs://${'a'.repeat(46)}`, mediaType: 'audio/mpeg',
});
const settled = () => new Promise(resolve => setImmediate(resolve));

async function recordingEditor(t, { storage = new Map(), request, sign } = {}) {
  const { runInNewContext } = require('node:vm');
  const model = require('../js/live-recording-edit.mjs');
  const gateway = require('../js/ipfs-gateway.js');
  const elements = new Map(), calls = [], signatures = [], timers = new Set(), posts = [];
  const get = id => {
    if (!elements.has(id)) elements.set(id, new StudioElement());
    return elements.get(id);
  };
  const preview = { available: true, previewOnly: true, journalRevision: 0, wallet: artist,
    sourceCid: 'a'.repeat(46), sourceSamples: 288000, sampleRate: 48000, durationSeconds: 6,
    catalogSource: { nftId: song().nftId }, releases: [], waveform: [], decision: 'undecided',
    draft: { revision: 0, albumTitle: 'Original', songs: [0, 1, 2].map(index => ({
      title: `Cut ${index + 1}`, startSample: index * 96000, endSample: (index + 1) * 96000,
    })) } };
  const window = new StudioElement();
  const signer = { getAddress: async () => artist, signMessage: async message => {
    signatures.push(message); return sign ? sign(message) : 'fixture-final-signature';
  } };
  window.parent = { _wallet: { address: artist, signer }, postMessage: value => posts.push(value) };
  window.DecentConfig = { ipfsUploadServiceUrl: 'https://service.example' };
  window.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const document = { body: new StudioElement(), getElementById: get,
    createElement: () => new StudioElement(), createTextNode: () => new StudioElement() };
  const location = new URL(`https://radio.example/recording-edit.html?catalog=${song().nftId}`);
  const code = read('js/live-recording-editor.mjs').replace(/^import[\s\S]*?from '[^']+';\n/gm, '');
  runInNewContext(code, { ...model, ...gateway, window, document, location, URL, structuredClone, console,
    setTimeout: (callback, delay) => { const timer = setTimeout(callback, delay); timers.add(timer); return timer; },
    clearTimeout,
    roomRequest: async (_service, path, input) => {
      calls.push({ path, input });
      if (request) return request(path, input, preview);
      return path === 'recording-preview' ? structuredClone(preview)
        : { ...structuredClone(preview), previewOnly: false, draft: structuredClone(input.draft) };
    },
  });
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  await settled();
  get('recording-edit-audio').dispatchEvent({ type: 'loadedmetadata' });
  return { get: id => get(`recording-edit-${id}`), window, calls, signatures, storage, posts };
}

test('editor opens and saves locally without signing; only final confirmation signs once', async t => {
  const ui = await recordingEditor(t);
  assert.equal(ui.get('workspace').hidden, false);
  assert.deepEqual(ui.calls.map(call => call.path), ['recording-preview']);
  assert.equal(ui.signatures.length, 0);
  ui.get('album-title').value = 'My finished album';
  ui.get('album-title').oninput();
  await ui.get('save').click();
  assert.equal(ui.storage.size, 1);
  assert.match([...ui.storage.values()][0], /My finished album/);
  await ui.get('defer').click();
  await settled();
  assert.equal(ui.signatures.length, 0);
  assert.equal(ui.calls.length, 1);
  await ui.get('full').click();
  await settled();
  assert.equal(ui.signatures.length, 1);
  assert.match(ui.signatures[0], /catalog recording publication approval v1/);
  assert.match(ui.signatures[0], /My finished album/);
  assert.equal(ui.calls[1].path, 'recording-publish');
  assert.equal(ui.calls[1].input.draft.revision, 1, 'local save count must not change the journal revision');
  const reopened = await recordingEditor(t, { storage: ui.storage });
  assert.equal(reopened.get('album-title').value, 'My finished album');
  assert.equal(reopened.signatures.length, 0);
});

test('unchanged final-publication retry reuses its signature; failed local storage blocks a successful flush', async t => {
  let attempts = 0;
  const ui = await recordingEditor(t, { request: async (path, input, preview) => {
    if (path === 'recording-preview') return structuredClone(preview);
    if (++attempts === 1) throw Error('Timed out while preparing releases');
    return { ...structuredClone(preview), previewOnly: false, draft: structuredClone(input.draft) };
  } });
  await ui.get('full').click();
  await settled();
  await ui.get('full').click();
  await settled();
  assert.equal(attempts, 2);
  assert.equal(ui.signatures.length, 1);
  ui.window.localStorage.setItem = () => { throw Error('QuotaExceeded'); };
  ui.get('album-title').value = 'Do not lose this';
  ui.get('album-title').oninput();
  await ui.window.dispatchEvent({ type: 'message', origin: 'https://radio.example', source: ui.window.parent,
    data: { type: 'decentbusking:flush-recording-draft', requestId: 'flush-test' } });
  assert.equal(ui.posts.at(-1).type, 'decentbusking:recording-draft-flush-failed');
  assert.match(ui.get('status').textContent, /could not be saved on this device/);
});

test('wallet changes while the final signature is open prevent submission', async t => {
  let finish;
  const ui = await recordingEditor(t, { sign: () => new Promise(resolve => { finish = resolve; }) });
  ui.get('full').click();
  await settled();
  await ui.window.dispatchEvent({ type: 'message', origin: 'https://radio.example', source: ui.window.parent,
    data: { type: 'decentbusking:editor-wallet-changed' } });
  finish('old-wallet-signature');
  await settled();
  assert.deepEqual(ui.calls.map(call => call.path), ['recording-preview']);
  assert.match(ui.get('status').textContent, /Wallet changed/);
});

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

async function rightPanels(t, fetchImpl = async () => ({ ok: true, json: async () => ({ canHost: true }) })) {
  const { initRightSidePanels } = await import('../js/right-side-panels.mjs');
  const elements = new Map(), posts = [], popups = [];
  const get = id => {
    if (!elements.has(id)) elements.set(id, new StudioElement());
    return elements.get(id);
  };
  const frame = get('rehearsal-frame');
  frame.src = 'about:blank'; frame.contentWindow = { postMessage: value => posts.push(value) };
  const document = new StudioElement();
  document.body = new StudioElement(); document.getElementById = get;
  const window = new StudioElement();
  window.location = { href: 'https://radio.example/', origin: 'https://radio.example' };
  window.CustomEvent = CustomEvent; window.crypto = globalThis.crypto;
  window._wallet = { address: artist, signer: {} }; window.DecentConfig = { ipfsUploadServiceUrl: 'https://worker.example' };
  window.open = () => {
    const popup = { location: { replace: url => { popup.url = url; } }, close: () => { popup.closed = true; } };
    popups.push(popup); return popup;
  };
  initRightSidePanels({ document, window, fetchImpl });
  const message = (data, origin = window.location.origin) => window.dispatchEvent({
    type: 'message', data, origin, source: frame.contentWindow,
  });
  t.after(() => { window._wallet = {}; document.dispatchEvent(new Event('wallet-disconnected')); });
  await settled();
  return { get, document, window, posts, popups, message };
}

test('right panels wait for the studio draft before switching, and reject stale eligibility', async t => {
  const ui = await rightPanels(t);
  assert.equal(ui.get('rehearsal-tab').hidden, false);
  ui.get('recording-edit-panel').classList.toggle('is-open', true);
  ui.document.addEventListener('decentbusking:close-recording-editor', event => event.detail.complete(false));
  await ui.get('bignuten-tab').click();
  assert.equal(ui.get('bignuten-panel').classList.contains('is-open'), false);
  assert.match(ui.get('right-panel-status').textContent, /studio draft has not been saved/);
  ui.document.addEventListener('decentbusking:close-recording-editor', event => {
    ui.get('recording-edit-panel').classList.toggle('is-open', false);
    event.detail.complete(true);
  });
  await ui.get('bignuten-tab').click();
  assert.equal(ui.get('bignuten-panel').classList.contains('is-open'), true);
  let finish;
  const stale = await rightPanels(t, () => new Promise(resolve => { finish = resolve; }));
  stale.window._wallet = {};
  stale.document.dispatchEvent(new Event('wallet-disconnected'));
  finish({ ok: true, json: async () => ({ canHost: true }) });
  await settled();
  assert.equal(stale.get('rehearsal-tab').hidden, true);
});

test('rehearsal close requires a trusted shutdown acknowledgement and preserves the visible room on failure', async t => {
  const ui = await rightPanels(t);
  await ui.get('rehearsal-tab').click();
  ui.message({ type: 'decentbusking:rehearsal-ready' });
  const source = ui.get('rehearsal-frame').src;
  const closing = ui.get('rehearsal-panel-close').click();
  await settled();
  const requestId = ui.posts.at(-1).requestId;
  ui.message({ type: 'decentbusking:rehearsal-closed', requestId }, 'https://other.example');
  assert.equal(ui.get('rehearsal-frame').src, source);
  ui.message({ type: 'decentbusking:rehearsal-close-failed', requestId });
  await closing;
  assert.equal(ui.get('rehearsal-panel').classList.contains('is-open'), true);
  assert.match(ui.get('right-panel-status').textContent, /current rehearsal action/);
  const retry = ui.get('rehearsal-panel-close').click();
  await settled();
  ui.message({ type: 'decentbusking:rehearsal-closed', requestId: ui.posts.at(-1).requestId,
    warning: 'Audio stopped; server sign-out pending.' });
  await retry;
  assert.equal(ui.get('rehearsal-frame').src, 'about:blank');
  assert.equal(ui.get('rehearsal-panel').classList.contains('is-open'), false);
  assert.match(ui.get('right-panel-status').textContent, /server sign-out pending/);
});

test('popout stops embedded audio first and transfers only a room-specific fragment invitation', async t => {
  const ui = await rightPanels(t);
  await ui.get('rehearsal-tab').click();
  const roomId = `rehearsal:${'a'.repeat(64)}`;
  ui.message({ type: 'decentbusking:rehearsal-ready' });
  ui.message({ type: 'decentbusking:rehearsal-room', roomId });
  ui.get('rehearsal-popout').click();
  await settled();
  assert.equal(ui.popups.length, 1);
  assert.equal(ui.popups[0].url, undefined);
  assert.equal(ui.posts.at(-1).handoff, true);
  ui.message({ type: 'decentbusking:rehearsal-closed', requestId: ui.posts.at(-1).requestId });
  await settled();
  const link = new URL(ui.popups[0].url);
  assert.equal(new URLSearchParams(link.hash.slice(1)).get('room'), roomId);
  assert.equal(link.search, '');
  assert.equal(ui.popups[0].opener, null);
  assert.equal(ui.get('rehearsal-frame').src, 'about:blank');
});

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

test('studio stays discoverable without granting editor access and ignores old-wallet catalog results', async t => {
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
  assert.equal(ui.elements.tab.hidden, false);
  ui.elements.tab.click();
  assert.equal(ui.elements.panel.inert, false);
  await ui.clickSource('catalog', song().nftId);
  assert.equal(ui.elements.frame.src, 'about:blank');
  ui.window._wallet = {};
  ui.document.dispatchEvent(new Event('wallet-disconnected'));
  assert.equal(ui.elements.library.children.length, 0);
  assert.equal(ui.elements.panel.inert, true);
  ui.elements.tab.click();
  assert.equal(ui.elements.panel.inert, false);
  assert.equal(ui.elements.search.disabled, true);
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
