const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('playlist draft exposes exactly Save to Profile, Personal Play and Play Live', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const group = html.match(/<div class="djuke-playlist-actions"[\s\S]*?<\/div>/)[0];
  assert.equal((group.match(/<button /g) || []).length, 3);
  for (const label of ['Save to Profile', 'Personal Play', 'Play Live']) assert.ok(group.includes(`<strong>${label}</strong>`));
  assert.doesNotMatch(html, /id="djuke-playlist-buy"/);
  const css = fs.readFileSync(path.join(__dirname, '../css/styles.css'), 'utf8');
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /djuke-live-beacon/);
});

test('unsaved draft buys one personal batch then plays in order; Live and Save stay independent', async () => {
  const helpers = await import('../js/djuke-playlists.mjs');
  const address = `0x${'1'.repeat(40)}`;
  const items = [1, 2, 3].map(i => ({ songId: `0x${String(i).padStart(64, '0')}`, title: `Song ${i}` }));
  let draftItems = items;
  const calls = [];
  const nodes = new Map();
  const listeners = {};
  function element(id) {
    if (nodes.has(id)) return nodes.get(id);
    const node = { value: '', textContent: '', children: [], listeners: {},
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); },
      setAttribute() {},
      querySelector(selector) { return element(selector); },
    };
    nodes.set(id, node);
    return node;
  }
  const document = { getElementById: element, createElement: tag => element(`${tag}:${nodes.size}`),
    addEventListener(name, callback) { (listeners[name] ||= []).push(callback); },
    dispatchEvent(event) { calls.push(event); for (const callback of listeners[event.type] || []) callback(event); },
  };
  let catalogFails = false;
  const config = { djukePlaylistBatchVersion: '0.4', djukePlaylistBatchAddress: address,
    djukePlaylistBatchEnabled: true, djukePlaylistRadioReady: true, ipfsUploadServiceUrl: 'https://worker.example' };
  const context = vm.createContext({ ...helpers, document, AbortSignal,
    window: { DecentConfig: config, _wallet: { address, signer: {} } },
    createListenPlaylist: () => ({ list: () => draftItems, replace: next => { draftItems = next; } }),
    createNamedPlaylistClient: () => ({
      profile: async () => ({ madePlaylists: [], playlists: [] }),
      saveOriginal: async playlist => { calls.push({ type: 'save', playlist }); return { playlist }; },
    }),
    makePlaylistId: () => 'a'.repeat(32),
    safeButton: () => element(`button:${nodes.size}`),
    formatUsdcUnits: units => String(units),
    event: (type, detail) => document.dispatchEvent({ type, detail }),
    purchasePrivateNamedPlaylist: async ({ playlist }) => { calls.push({ type: 'personal', playlist }); },
    purchaseRadioNamedPlaylist: async ({ playlist }) => { calls.push({ type: 'live', playlist }); },
    fetch: async url => {
      if (url.endsWith('playlist-readiness')) return { ok: true, json: async () => ({ ready: true, version: '0.4', contractAddress: address }) };
      if (catalogFails) throw new Error('Catalog timeout');
      return { ok: true, json: async () => ({ tracks: items.map((item, i) => ({ ...item, ipfsCid: `cid${i}` })) }) };
    },
    setInterval() {},
  });

  test('Personal Play submits one creator-priced contract batch in the reviewed order', async () => {
    const helpers = await import('../js/djuke-playlists.mjs');
    const address = `0x${'1'.repeat(40)}`;
    const songIds = [3, 1, 2].map(i => `0x${String(i).padStart(64, '0')}`);
    const calls = [];
    const purchase = async (ids, maxTotal) => {
      calls.push({ type: 'purchase', ids, maxTotal });
      return { hash: '0xtest', wait: async () => ({ status: 1 }) };
    };
    purchase.staticCall = async (ids, maxTotal) => { calls.push({ type: 'simulate', ids, maxTotal }); };
    const djuke = { target: address, purchasePlaylistPrivate: purchase,
      quotePlaylist: async (ids, radio) => { calls.push({ type: 'quote', ids, radio }); return [950000n, 0n, 950000n]; } };
    const usdc = { decimals: async () => 6, balanceOf: async () => 1000000n, allowance: async () => 1000000n };
    const context = vm.createContext({ ...helpers, BASE_USDC: 'usdc', PLAYLIST_BATCH_ABI: [], USDC_ABI: [],
      window: {}, ensureBaseNetwork: async () => {}, formatUsdcUnits: String,
      announcePaymentCelebration: () => {},
      ethers: { Contract: function (target) { return target === address ? djuke : usdc; } },
    });
    const source = fs.readFileSync(path.join(__dirname, '../js/djuke-playlists-ui.mjs'), 'utf8');
    const purchaseSource = source.slice(source.indexOf('export async function purchasePrivateNamedPlaylist'), source.indexOf('export function initDjukePlaylists'));
    vm.runInContext(purchaseSource.replace('export ', ''), context);
    await context.purchasePrivateNamedPlaylist({ playlist: { songIds }, signer: { provider: {}, getAddress: async () => address },
      config: { djukePlaylistBatchVersion: '0.4', djukePlaylistBatchAddress: address, djukePlaylistBatchEnabled: true } });
    assert.equal(calls.filter(call => call.type === 'purchase').length, 1);
    assert.deepEqual(calls.find(call => call.type === 'purchase').ids, songIds);
    assert.equal(calls.find(call => call.type === 'purchase').maxTotal, 950000n);
    assert.equal(calls.find(call => call.type === 'quote').radio, false);
  });
  const source = fs.readFileSync(path.join(__dirname, '../js/djuke-playlists-ui.mjs'), 'utf8');
  const init = source.slice(source.indexOf('export function initDjukePlaylists()'), source.indexOf("\nif (typeof document"));
  vm.runInContext(`${init.replace('export ', '')}\ninitDjukePlaylists();`, context);
  await new Promise(resolve => setImmediate(resolve));
  const click = async id => {
    for (const callback of element(id).listeners.click || []) await callback();
    await new Promise(resolve => setImmediate(resolve));
  };
  const ids = items.map(item => item.songId);
  assert.equal(element('djuke-named-playlist-private').disabled, false, 'saving is not a prerequisite');
  assert.equal(element('djuke-named-playlist-radio').disabled, false);
  await click('djuke-named-playlist-private');
  assert.deepEqual(Array.from(calls.find(call => call.type === 'personal').playlist.songIds), ids);
  const playback = calls.find(call => call.type === 'djuke-private-playlist-purchased');
  assert.deepEqual(Array.from(playback.detail.items, item => item.songId), ids);
  assert.ok(calls.indexOf(playback) > calls.findIndex(call => call.type === 'personal'));
  assert.equal(calls.filter(call => call.type === 'personal').length, 1);
  assert.equal(calls.filter(call => call.type === 'save' || call.type === 'live').length, 0);
  await click('djuke-named-playlist-radio');
  assert.deepEqual(Array.from(calls.find(call => call.type === 'live').playlist.songIds), ids);
  assert.equal(calls.filter(call => call.type === 'djuke-private-playlist-purchased').length, 1);
  element('djuke-playlist-name').value = 'BoogieNight';
  await click('djuke-playlist-save');
  assert.equal(calls.filter(call => call.type === 'save').length, 1);
  assert.equal(calls.filter(call => ['personal', 'live'].includes(call.type)).length, 2);
  catalogFails = true;
  await click('djuke-named-playlist-private');
  assert.match(element('djuke-playlist-state').textContent, /Catalog timeout/);
  assert.equal(calls.filter(call => call.type === 'personal').length, 1, 'no purchase on catalog failure');
  assert.equal(element('djuke-named-playlist-private').disabled, false, 'failure releases busy gate');
});
