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

async function careFixture({ now = () => new Date() } = {}) {
  const { initBigNutenPanel } = await import('../js/bignuten-panel.mjs');
  const { createCreatorProfiles } = await import('../discord-bot/creator-profiles.js');
  const { Wallet } = require('node:module').createRequire(join(root, 'discord-bot/package.json'))('ethers');
  const wallet = Wallet.createRandom();
  let snapshot, fail = false, loseResponse = false;
  const options = { now: () => now().getTime(), restore: async () => structuredClone(snapshot),
    save: async next => { if (fail) throw Error('Checkpoint offline'); snapshot = structuredClone(next); return 'ipfs://care'; } };
  let store = createCreatorProfiles(options);
  await store.initialize();
  const requests = [];
  async function fetchImpl(url, options = {}) {
    if (options.method !== 'POST') return { ok: true, json: async () => store.get(new URL(url).searchParams.get('address')) };
    const body = JSON.parse(options.body);
    requests.push(body);
    const result = await store.updateMusicianCare(body, 'https://radio.example');
    if (loseResponse) { loseResponse = false; throw Error('Response lost'); }
    return { ok: true, json: async () => result };
  }
  async function visit(fetch = fetchImpl) {
    const elements = new Map(), document = new StudioElement(), window = new StudioElement();
    const intervals = new Map();
    let clock = 0, intervalId = 0;
    const get = id => {
      if (!elements.has(id)) elements.set(id, new StudioElement());
      return elements.get(id);
    };
    document.getElementById = get;
    window._wallet = { address: wallet.address, signer: wallet };
    window.location = { origin: 'https://radio.example' };
    window.DecentConfig = { ipfsUploadServiceUrl: 'https://worker.example' };
    window.crypto = globalThis.crypto; window.CustomEvent = CustomEvent;
    const panel = initBigNutenPanel({ document, window, now, fetchImpl: fetch, timeZone: () => 'UTC',
      monotonicNow: () => clock, schedule: callback => { intervals.set(++intervalId, callback); return intervalId; },
      clear: id => intervals.delete(id) });
    await settled();
    return { get, document, window, panel, intervals,
      advance: milliseconds => { clock += milliseconds; for (const tick of [...intervals.values()]) tick(); } };
  }
  return { visit, fetchImpl, requests, wallet, setFailure: value => { fail = value; }, loseNextResponse: () => { loseResponse = true; },
    restart: async () => { store = createCreatorProfiles(options); await store.initialize(); },
    profile: () => store.get(wallet.address) };
}

test('BigNuten profile tracking persists water and guided practices across reload and local midnight', async () => {
  let date = new Date('2026-11-18T23:59:00.000Z');
  const fixture = await careFixture({ now: () => date }), ui = await fixture.visit();
  assert.equal(ui.get('bignuten-water-add').disabled, false);
  assert.equal(ui.get('bignuten-water-remove').disabled, true);
  for (let count = 0; count < 10; count++) await ui.get('bignuten-water-add').click();
  assert.equal(ui.get('bignuten-water-total').textContent, '10', 'the eight-glass arc is not a storage cap');
  assert.equal(ui.get('bignuten-water-fill').getAttribute('stroke-dashoffset'), '0');
  await ui.get('bignuten-water-remove').click();
  assert.equal(ui.get('bignuten-water-total').textContent, '9');
  ui.get('bignuten-heart-select').click();
  ui.get('bignuten-practice-start').click();
  ui.advance(60000);
  await ui.get('bignuten-practice-save').click();
  assert.equal(ui.get('bignuten-breathwork-total').textContent, '1');
  ui.get('bignuten-practice-back').click();
  ui.get('bignuten-throat-select').click();
  assert.equal(ui.get('bignuten-breath-icon').getAttribute('hidden'), '', 'SVG visibility uses an attribute, not the HTML-only hidden property');
  ui.get('bignuten-method-chant').click();
  ui.get('bignuten-practice-start').click();
  ui.advance(60000);
  await ui.get('bignuten-practice-save').click();
  assert.equal(ui.get('bignuten-chanting-total').textContent, '1');
  ui.get('bignuten-method-hum').click();
  ui.get('bignuten-practice-start').click();
  ui.advance(30000);
  await ui.get('bignuten-practice-save').click();
  assert.equal(ui.get('bignuten-vocal-total').textContent, '0.5');
  await fixture.restart();
  const reloaded = await fixture.visit();
  assert.equal(reloaded.get('bignuten-water-total').textContent, '9');
  assert.equal(reloaded.get('bignuten-breathwork-total').textContent, '1');
  date = new Date('2026-11-19T00:01:00.000Z');
  await reloaded.panel.refresh();
  assert.equal(reloaded.get('bignuten-water-total').textContent, '0');
  assert.equal(reloaded.get('bignuten-water-remove').disabled, true);
  assert.equal(fixture.profile().musicianCare.entries.length, 13, 'midnight does not erase historical entries');
});

test('guided breathing uses one clock, skips paused/hidden time and requires explicit completion to log', async () => {
  const fixture = await careFixture(), ui = await fixture.visit();
  ui.get('bignuten-heart-select').click();
  assert.equal(ui.get('bignuten-breath-icon').getAttribute('hidden'), null);
  ui.get('bignuten-method-extended').click();
  ui.get('bignuten-practice-start').click();
  ui.get('bignuten-practice-start').click();
  assert.equal(ui.intervals.size, 1);
  assert.equal(ui.get('bignuten-home').hidden, true);
  ui.advance(2000);
  assert.equal(ui.get('bignuten-practice-phase').textContent, 'Breathe in');
  assert.equal(ui.get('bignuten-practice-orb').style.transform, 'scale(0.87)');
  ui.advance(2000);
  assert.equal(ui.get('bignuten-practice-phase').textContent, 'Breathe out');
  assert.equal(ui.get('bignuten-practice-countdown').textContent, '6s');
  ui.get('bignuten-practice-pause').click();
  assert.equal(ui.intervals.size, 0);
  ui.advance(50000);
  assert.equal(ui.get('bignuten-practice-elapsed').textContent, '00:04');
  ui.get('bignuten-practice-pause').click();
  ui.advance(6000);
  assert.equal(ui.get('bignuten-practice-phase').textContent, 'Breathe in');
  ui.document.hidden = true;
  ui.document.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(ui.intervals.size, 0);
  ui.advance(300000);
  ui.document.hidden = false;
  ui.document.dispatchEvent({ type: 'visibilitychange' });
  await settled();
  assert.equal(ui.get('bignuten-practice-elapsed').textContent, '00:10');
  assert.equal(ui.get('bignuten-practice-pause').textContent, 'Resume');
  ui.get('bignuten-practice-pause').click();
  ui.advance(70000);
  assert.equal(ui.get('bignuten-practice-phase').textContent, 'Minute complete');
  assert.equal(ui.get('bignuten-practice-elapsed').textContent, '01:00');
  assert.equal(ui.intervals.size, 0);
  assert.equal(fixture.requests.length, 0, 'timer completion never triggers a signature or POST');
  await ui.get('bignuten-practice-save').click();
  assert.equal(fixture.profile().musicianCare.entries[0].amount, 60);
  assert.equal(fixture.profile().musicianCare.entries[0].activity, 'breathwork');
  assert.match(ui.get('bignuten-practice-status').textContent, /Logged 01:00/);
});

test('guided practice preserves its activity until discarded and clears unfinished time on wallet changes', async () => {
  const fixture = await careFixture(), ui = await fixture.visit();
  ui.get('bignuten-heart-select').click();
  ui.get('bignuten-practice-start').click();
  ui.advance(6000);
  ui.get('bignuten-practice-back').click();
  assert.equal(ui.intervals.size, 0);
  assert.equal(ui.get('bignuten-home').hidden, false);
  ui.get('bignuten-throat-select').click();
  assert.equal(ui.get('bignuten-practice-controls').dataset.kind, 'heart');
  assert.match(ui.get('bignuten-practice-status').textContent, /Finish or discard/);
  ui.get('bignuten-practice-discard').click();
  ui.get('bignuten-practice-back').click();
  ui.get('bignuten-throat-select').click();
  ui.get('bignuten-method-trill').click();
  ui.get('bignuten-practice-start').click();
  ui.advance(4500);
  assert.equal(ui.get('bignuten-practice-phase').textContent, 'Brr...');
  ui.get('bignuten-method-chant').click();
  assert.equal(ui.get('bignuten-practice-title').textContent, 'Lip trill');
  ui.window._wallet = { address: other, signer: {} };
  await ui.document.dispatchEvent({ type: 'wallet-connected' });
  assert.equal(ui.intervals.size, 0);
  assert.equal(ui.get('bignuten-practice-elapsed').textContent, '00:00');
  assert.match(ui.get('bignuten-practice-status').textContent, /Wallet changed/);
  assert.equal(fixture.requests.length, 0);
});

test('an unconfirmed guided session stays retryable without changing duration or double logging', async () => {
  const fixture = await careFixture(), ui = await fixture.visit();
  ui.get('bignuten-throat-select').click();
  ui.get('bignuten-practice-start').click();
  ui.advance(5500);
  const sign = fixture.wallet.signMessage.bind(fixture.wallet);
  fixture.wallet.signMessage = async () => { throw Error('Signature rejected'); };
  await ui.get('bignuten-practice-save').click();
  assert.equal(ui.get('bignuten-practice-elapsed').textContent, '00:05');
  assert.equal(ui.get('bignuten-practice-save').disabled, false);
  assert.equal(ui.intervals.size, 0);
  assert.equal(fixture.requests.length, 0);
  fixture.wallet.signMessage = sign;
  fixture.setFailure(true);
  await ui.get('bignuten-practice-save').click();
  assert.equal(ui.get('bignuten-vocal-total').textContent, '0');
  assert.equal(ui.get('bignuten-practice-discard').disabled, true);
  fixture.setFailure(false);
  fixture.loseNextResponse();
  await ui.get('bignuten-retry').click();
  ui.advance(600000);
  await fixture.restart();
  await ui.panel.refresh();
  assert.equal(fixture.profile().musicianCare.entries.length, 1);
  assert.equal(fixture.profile().musicianCare.entries[0].amount, 5);
  assert.equal(fixture.profile().musicianCare.entries[0].activity, 'vocal');
  assert.equal(new Set(fixture.requests.map(body => body.entry.id)).size, 1);
  assert.match(ui.get('bignuten-practice-status').textContent, /Logged 00:05/);
  assert.equal(ui.get('bignuten-practice-start').disabled, false);
});

test('BigNuten failed saves retain confirmed totals and retry the same ID after a lost response', async () => {
  const fixture = await careFixture(), ui = await fixture.visit();
  fixture.setFailure(true);
  await ui.get('bignuten-water-add').click();
  assert.equal(ui.get('bignuten-water-total').textContent, '0');
  assert.match(ui.get('bignuten-water-status').textContent, /not confirmed/);
  assert.equal(ui.get('bignuten-water-add').disabled, true);
  fixture.setFailure(false);
  fixture.loseNextResponse();
  await ui.get('bignuten-retry').click();
  assert.equal(ui.get('bignuten-water-total').textContent, '0');
  await fixture.restart();
  await ui.get('bignuten-retry').click();
  assert.equal(ui.get('bignuten-water-total').textContent, '1');
  assert.equal(new Set(fixture.requests.map(body => body.entry.id)).size, 1);
  assert.equal(fixture.profile().musicianCare.entries.length, 1);
  ui.window._wallet.signer.signMessage = async () => { throw Error('Signature rejected'); };
  await ui.get('bignuten-water-add').click();
  assert.match(ui.get('bignuten-water-status').textContent, /Not saved: Signature rejected/);
  assert.equal(ui.get('bignuten-retry').hidden, true);
  assert.equal(ui.get('bignuten-water-total').textContent, '1');
});

test('BigNuten ignores stale loads and signatures after wallet changes, including profile viewing', async () => {
  const fixture = await careFixture();
  let resolveLoad;
  const ui = await fixture.visit(() => new Promise(resolve => { resolveLoad = resolve; }));
  ui.window._wallet = {};
  await ui.document.dispatchEvent({ type: 'wallet-disconnected' });
  resolveLoad({ ok: true, json: async () => fixture.profile() });
  await settled();
  assert.equal(ui.get('bignuten-water-total').textContent, '0');
  assert.equal(ui.get('bignuten-water-add').disabled, true);
  const signing = await fixture.visit();
  signing.document.dispatchEvent({ type: 'creator-profile-view-changed', detail: { address: other } });
  await signing.get('bignuten-water-add').click();
  assert.equal(fixture.requests.at(-1).address, fixture.wallet.address.toLowerCase(), 'viewing another profile never changes the logging wallet');
  let finishSignature;
  signing.window._wallet.signer = { signMessage: () => new Promise(resolve => { finishSignature = resolve; }) };
  await signing.document.dispatchEvent({ type: 'wallet-connected' });
  const pending = signing.get('bignuten-water-add').click();
  signing.window._wallet = { address: other, signer: {} };
  await signing.document.dispatchEvent({ type: 'wallet-connected' });
  finishSignature('old-wallet-signature');
  await pending;
  assert.equal(fixture.requests.length, 1, 'a stale signature must not submit another entry');
  assert.equal(signing.get('bignuten-water-total').textContent, '0');
  const unsupported = await fixture.visit(async () => ({ ok: true, json: async () => ({ address: fixture.wallet.address }) }));
  assert.equal(unsupported.get('bignuten-water-total').textContent, '--');
  assert.match(unsupported.get('bignuten-water-status').textContent, /service needs the musician-care update/);
  assert.equal(unsupported.get('bignuten-water-add').disabled, true);
});

test('refreshing the signer for the same wallet keeps a pending practice retry and never submits its stale signature', async () => {
  const fixture = await careFixture(), ui = await fixture.visit();
  ui.get('bignuten-heart-select').click();
  ui.get('bignuten-practice-start').click();
  ui.advance(7000);
  let finishSignature;
  ui.window._wallet.signer = { signMessage: () => new Promise(resolve => { finishSignature = resolve; }) };
  await ui.document.dispatchEvent({ type: 'wallet-connected' });
  const saving = ui.get('bignuten-practice-save').click();
  assert.equal(ui.get('bignuten-practice-save').disabled, true);
  ui.window._wallet = { address: fixture.wallet.address, signer: fixture.wallet };
  await ui.document.dispatchEvent({ type: 'wallet-connected' });
  finishSignature('stale-same-wallet-signature');
  await saving;
  assert.equal(fixture.requests.length, 0, 'the old signer cannot submit after replacement');
  assert.equal(ui.get('bignuten-water-total').textContent, '0');
  assert.equal(ui.get('bignuten-retry').hidden, false, 'the stable pending event remains recoverable');
  await ui.get('bignuten-retry').click();
  assert.equal(fixture.profile().musicianCare.entries.length, 1);
  assert.equal(fixture.profile().musicianCare.entries[0].amount, 7);
  assert.equal(fixture.profile().musicianCare.entries[0].activity, 'breathwork');
});

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

test('DHearse tab silently retries a failed access check and opens on success', async t => {
  let attempts = 0;
  const ui = await rightPanels(t, async url => {
    if (!url.endsWith('/api/private-rehearsal/eligibility')) return { ok: false };
    if (++attempts < 3) throw new TypeError('Failed to fetch');
    return { ok: true, json: async () => ({ canHost: true }) };
  });
  const tab = ui.get('rehearsal-tab');
  assert.equal(tab.hidden, false);
  assert.match(tab.getAttribute('aria-label'), /retry/i);
  assert.equal(ui.get('right-panel-status').textContent ?? '', '');
  await tab.click();
  assert.equal(ui.get('rehearsal-frame').src, 'about:blank');
  assert.equal(tab.hidden, false);
  assert.equal(ui.get('right-panel-status').textContent ?? '', '');
  await tab.click();
  assert.equal(attempts, 3);
  assert.match(ui.get('rehearsal-frame').src, /rehearsal\.html\?embedded=1$/);
  assert.equal(tab.getAttribute('aria-expanded'), 'true');
});

test('DHearse retry hides the tab without opening if the wallet is ineligible', async t => {
  let attempts = 0;
  const ui = await rightPanels(t, async url => {
    if (!url.endsWith('/api/private-rehearsal/eligibility')) return { ok: false };
    if (++attempts === 1) throw new TypeError('Failed to fetch');
    return { ok: true, json: async () => ({ canHost: false }) };
  });
  await ui.get('rehearsal-tab').click();
  assert.equal(ui.get('rehearsal-tab').hidden, true);
  assert.equal(ui.get('rehearsal-frame').src, 'about:blank');
  assert.equal(ui.get('right-panel-status').textContent ?? '', '');
});

test('closing or switching the BigNuten drawer pauses its guide until explicitly resumed', async t => {
  const ui = await rightPanels(t);
  t.after(() => ui.get('bignuten-panel-close').click());
  await ui.get('bignuten-tab').click();
  ui.get('bignuten-heart-select').click();
  ui.get('bignuten-practice-start').click();
  assert.equal(ui.get('bignuten-practice-controls').dataset.running, 'true');
  await ui.get('bignuten-panel-close').click();
  assert.equal(ui.get('bignuten-practice-controls').dataset.running, 'false');
  await ui.get('bignuten-tab').click();
  assert.equal(ui.get('bignuten-practice-pause').textContent, 'Resume');
  ui.get('bignuten-practice-pause').click();
  await ui.get('rehearsal-tab').click();
  assert.equal(ui.get('bignuten-practice-controls').dataset.running, 'false');
  assert.equal(ui.get('bignuten-practice-pause').textContent, 'Resume');
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
