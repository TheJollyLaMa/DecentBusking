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

test('radio checkout accepts zero worker ETH only for configured on-chain v0.5 before any approval', async () => {
  const helpers = await import('../js/djuke-playlists.mjs');
  const address = `0x${'1'.repeat(40)}`, listener = `0x${'2'.repeat(40)}`;
  const config = { djukePlaylistBatchAddress: address, djukePlaylistBatchVersion: '0.5',
    djukePlaylistBatchEnabled: true, djukePlaylistRadioReady: true, ipfsUploadServiceUrl: 'https://worker.example' };
  let version = '0.5', contribution = '0', cost = '0', sent = 0;
  const steps = [];
  const request = async (...args) => { assert.equal(args.at(-1).value, 0n); sent++;
    return { hash: '0xpreview', wait: async () => ({ status: 1 }) }; };
  request.staticCall = async (...args) => assert.equal(args.at(-1).value, 0n);
  const djuke = { target: address, CONTRACT_VERSION: async () => version, requestPlaylistWithGas: request };
  const token = { decimals: async () => 6, balanceOf: async () => 100000000n,
    allowance: async () => 0n, approve: async () => ({ wait: async () => ({ status: 1 }) }) };
  const context = vm.createContext({ ...helpers, AbortSignal, URL, BASE_USDC_ADDRESS: 'usdc', USDC_BROWSER_ABI: [],
    ensureBaseNetwork: async () => {}, formatUsdcUnits: String, announcePaymentCelebration() {},
    checkPlaylistSchedule: async () => null,
    approvalNotice: (await import('../js/base-chain.mjs')).approvalNotice, waitForAllowance: async () => {},
    ethers: { Contract: function(target) { return target === address ? djuke : token; } } });
  const source = fs.readFileSync(path.join(__dirname, '../js/djuke-checkout.mjs'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('export async function checkoutRadioPlaylist'),
    source.indexOf('export async function checkoutPrivatePlaylist')).replace('export ', ''), context);
  const purchase = () => context.checkoutRadioPlaylist({ ethers: context.ethers, config, playlist: { songIds: [`0x${'a'.repeat(64)}`] },
    signer: { provider: { getBalance: async () => 100000n }, getAddress: async () => listener },
    onStep: step => steps.push(step), fetchImpl: async () => ({ ok: true, json: async () => ({
      contractAddress: address, listener, maxTotal: '3250000', fulfillmentCostWei: cost, contributionWei: contribution,
      deadline: Math.floor(Date.now() / 1000) + 120, signature: '0xsigned' }) }) });
  config.djukePlaylistBatchVersion = '0.4';
  await assert.rejects(purchase(), /Legacy playlist checkout/);
  config.djukePlaylistBatchVersion = '0.5'; version = '0.4';
  await assert.rejects(purchase(), /v0.5 requires a verified USDC-only/);
  version = '0.5'; contribution = '2000'; cost = '1000';
  await assert.rejects(purchase(), /v0.5 requires a verified USDC-only/);
  contribution = cost = '0';
  await purchase();
  assert.equal(sent, 1);
  assert.ok(steps.some(step => step.includes('standard Base network gas only')));
  assert.ok(steps.every(step => !/worker|sponsor|extra ETH/i.test(step)));
  const approval = steps.find(step => step.includes('spending allowance'));
  assert.doesNotMatch(approval, /worker ETH/);
  assert.match(approval, /network gas/);
});

test('v0.5 radio tooltip and public information contain no worker funding pitch', () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/djuke-playlists-ui.mjs'), 'utf8');
  const radioButton = {}, privateButton = {}, saveButton = {};
  const context = vm.createContext({ config: () => ({ djukePlaylistBatchVersion: '0.5' }),
    batchCapability: () => true, radioCapability: () => true, addSelected: null,
    draft: { list: () => [{}] }, busy: false, nameInput: { value: 'BoogieNight' },
    radioButton, privateButton, saveButton });
  vm.runInContext(source.slice(source.indexOf('const workerCostNotice'), source.indexOf('async function refreshPlaylistReadiness')) +
    source.slice(source.indexOf('function updateGate()'), source.indexOf('function renderDraft()')) + '\nupdateGate();', context);
  assert.match(radioButton.title, /Standard Base network gas/);
  assert.doesNotMatch(radioButton.title, /worker|ETH|sponsor/i);
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const info = html.slice(html.indexOf('id="djuke-instructions"'), html.indexOf('id="djuke-instructions-close"'));
  assert.doesNotMatch(info, /worker|ETH|sponsor/i);
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
  let storageFails = false;
  const config = { djukePlaylistBatchVersion: '0.4', djukePlaylistBatchAddress: address,
    djukePlaylistBatchEnabled: true, djukePlaylistRadioReady: true, ipfsUploadServiceUrl: 'https://worker.example' };
  const context = vm.createContext({ ...helpers, document, AbortSignal,
    window: { DecentConfig: config, _wallet: { address, signer: { getAddress: async () => address } } },
    createPersonalPlayRecovery: () => ({
      check() { if (storageFails) throw new Error('Recovery storage unavailable'); },
      save: submitted => calls.push({ type: 'recovery', ...submitted }),
    }),
    createListenPlaylist: () => ({ list: () => draftItems, replace: next => { draftItems = next; } }),
    createNamedPlaylistClient: () => ({
      profile: async () => ({ madePlaylists: [], playlists: [] }),
      saveOriginal: async playlist => { calls.push({ type: 'save', playlist }); return { playlist }; },
    }),
    makePlaylistId: () => 'a'.repeat(32),
    safeButton: () => element(`button:${nodes.size}`),
    formatUsdcUnits: units => String(units),
    event: (type, detail) => document.dispatchEvent({ type, detail }),
    purchasePrivateNamedPlaylist: async ({ playlist, onSubmitted }) => {
      calls.push({ type: 'personal', playlist });
      await onSubmitted({ payer: address, contract: address, txHash: '0xtest' });
      return { txHash: '0xtest' };
    },
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
      return { hash: '0xtest', wait: async () => { calls.push({ type: 'wait' }); return { status: 1 }; } };
    };
    purchase.staticCall = async (ids, maxTotal) => { calls.push({ type: 'simulate', ids, maxTotal }); };
    const djuke = { target: address, purchasePlaylistPrivate: purchase,
      quotePlaylist: async (ids, radio) => { calls.push({ type: 'quote', ids, radio }); return [950000n, 0n, 950000n]; } };
    const usdc = { decimals: async () => 6, balanceOf: async () => 1000000n, allowance: async () => 1000000n };
    const context = vm.createContext({ ...helpers, BASE_USDC_ADDRESS: 'usdc', USDC_BROWSER_ABI: [],
      window: {}, ensureBaseNetwork: async () => {}, formatUsdcUnits: String,
      announcePaymentCelebration: () => {},
      ethers: { Contract: function (target) { return target === address ? djuke : usdc; } },
    });
    const source = fs.readFileSync(path.join(__dirname, '../js/djuke-checkout.mjs'), 'utf8');
    const purchaseSource = source.slice(source.indexOf('export async function checkoutPrivatePlaylist'));
    vm.runInContext(purchaseSource.replace('export ', ''), context);
    await context.checkoutPrivatePlaylist({ ethers: context.ethers, playlist: { songIds }, signer: { provider: {}, getAddress: async () => address },
      onSubmitted: submitted => { calls.push({ type: 'persist', submitted }); },
      config: { djukePlaylistBatchVersion: '0.4', djukePlaylistBatchAddress: address, djukePlaylistBatchEnabled: true } });
    assert.equal(calls.filter(call => call.type === 'purchase').length, 1);
    assert.deepEqual(calls.find(call => call.type === 'purchase').ids, songIds);
    assert.equal(calls.find(call => call.type === 'purchase').maxTotal, 950000n);
    assert.equal(calls.find(call => call.type === 'quote').radio, false);
    assert.ok(calls.findIndex(call => call.type === 'persist') < calls.findIndex(call => call.type === 'wait'));
    assert.equal(calls.find(call => call.type === 'persist').submitted.payer, address);
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
  assert.ok(calls.indexOf(playback) > calls.findIndex(call => call.type === 'recovery'));
  assert.equal(playback.detail.payer, address);
  assert.equal(playback.detail.txHash, '0xtest');
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
  catalogFails = false;
  storageFails = true;
  await click('djuke-named-playlist-private');
  assert.match(element('djuke-playlist-state').textContent, /Recovery storage unavailable/);
  assert.equal(calls.filter(call => call.type === 'personal').length, 1, 'storage must work before opening checkout');
});

test('Play Live conflict acknowledgment blocks checkout before any wallet, quote, approval or purchase on cancel', async () => {
  const { checkoutRadioPlaylist } = await import('../js/djuke-checkout.mjs');
  const config = { djukePlaylistBatchAddress: `0x${'1'.repeat(40)}`, djukePlaylistBatchVersion: '0.5',
    djukePlaylistBatchEnabled: true, djukePlaylistRadioReady: true };
  const playlist = { songIds: [`0x${'a'.repeat(64)}`] };
  const original = structuredClone(playlist);
  for (const answer of [false, undefined, null, 'true']) {
    let confirmations = 0;
    const forbidden = () => { assert.fail('Cancelled checkout must not touch wallets, contracts or quotes'); };
    await assert.rejects(checkoutRadioPlaylist({
      config, playlist, signer: { get provider() { return forbidden(); }, getAddress: forbidden },
      checkSchedule: async () => ({ event: { title: 'Protected hour', startUtc: '2026-10-25T16:00:00Z',
        endUtc: '2026-10-25T17:00:00Z' }, playlistMs: 3600000, waitMs: 0, estimatedSongs: 0 }),
      confirmConflict: message => { assert.match(message, /Protected hour/); confirmations++; return answer; },
      ensureChain: forbidden, fetchImpl: forbidden, ethers: { Contract: forbidden },
    }), /checkout cancelled.*No approval or purchase was requested/);
    assert.equal(confirmations, 1);
    assert.deepEqual(playlist, original);
  }
});

test('Play Live checks each purchase but skips confirmation without a conflict and respects aborts', async () => {
  const { checkoutRadioPlaylist } = await import('../js/djuke-checkout.mjs');
  const config = { djukePlaylistBatchAddress: `0x${'1'.repeat(40)}`, djukePlaylistBatchVersion: '0.5',
    djukePlaylistBatchEnabled: true, djukePlaylistRadioReady: true };
  const order = [];
  for (let i = 0; i < 2; i++) {
    await assert.rejects(checkoutRadioPlaylist({
      config, playlist: { songIds: [`0x${'a'.repeat(64)}`] }, signer: { provider: {} },
      checkSchedule: async () => { order.push('checked'); return null; },
      confirmConflict: () => assert.fail('No conflict must not open an extra window'),
      ensureChain: async () => { order.push('chain'); throw new Error('Stop before real wallet activity'); },
    }), /Stop before real wallet/);
  }
  assert.deepEqual(order, ['checked', 'chain', 'checked', 'chain']);
  const controller = new AbortController();
  await assert.rejects(checkoutRadioPlaylist({
    config, playlist: { songIds: [`0x${'a'.repeat(64)}`] }, signer: {},
    signal: controller.signal,
    checkSchedule: async () => { controller.abort(); return null; },
    ensureChain: () => assert.fail('Aborted checkout must not request wallet actions'),
  }), { name: 'AbortError' });
});

test('general scheduling terms stay in information and tutorial; checkout only confirms detected conflicts', () => {
  const root = path.join(__dirname, '..');
  const checkout = fs.readFileSync(path.join(root, 'js/djuke-checkout.mjs'), 'utf8');
  assert.match(checkout, /if \(conflict && await confirmConflict/);
  const privateCheckout = checkout.slice(checkout.indexOf('export async function checkoutPrivatePlaylist'));
  assert.doesNotMatch(privateCheckout, /confirmConflict|checkSchedule/);
  for (const name of ['djuke-playlists-ui.mjs', 'djuke-widget.mjs']) {
    const source = fs.readFileSync(path.join(root, 'js', name), 'utf8');
    assert.match(source, /checkoutRadioPlaylist/);
  }
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /id="djuke-playlist-scheduling-notice"|Checkout asks you to acknowledge/);
  assert.match(html, /Protected-show warning:/);
  assert.match(html, /no refund solely for this delay or interruption/);
  const tutorial = fs.readFileSync(path.join(root, 'js/tutorial.js'), 'utf8');
  assert.match(tutorial, /No refund solely for that delay or interruption/);
  assert.doesNotMatch(tutorial, /Checkout requires acknowledgment/);
});
