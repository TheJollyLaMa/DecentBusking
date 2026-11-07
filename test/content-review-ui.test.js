const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const source = fs.readFileSync(path.join(__dirname, '../js/content-review-ui.mjs'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export /g, '');
  const listeners = new Map();
  let resolveSignature, requests = 0;
  const signer = { signMessage: () => new Promise(resolve => { resolveSignature = resolve; }) };
  const window = { _wallet: { signer, address: '0x' + '11'.repeat(20) }, DecentConfig: { ipfsUploadServiceUrl: 'https://example.org' } };
  const document = { readyState: 'loading', addEventListener: (name, fn) => {
    const callbacks = listeners.get(name) || []; callbacks.push(fn); listeners.set(name, callbacks);
  } };
  const context = vm.createContext({ window, document, location: { origin: 'https://example.org' },
    contentAuthorization: JSON.stringify, AbortSignal, structuredClone,
    fetch: async () => { requests++; return { ok: true, json: async () => ({ submitted: true }) }; } });
  vm.runInContext(source, context);
  return { window, context, resolve: () => resolveSignature('mock'),
    change: () => listeners.get('wallet-connected').forEach(fn => fn()), requests: () => requests,
    send: () => vm.runInContext("sendContentCommand({action:'report'})", context),
    view: (reuse = false) => vm.runInContext(`sendContentCommand({action:'view'}, {reuseViewAuthorization:${reuse}})`, context) };
}

test('wallet change during report signature prevents sending, even after switching back', async () => {
  const f = fixture();
  const pending = f.send();
  f.change(); f.change();
  f.resolve();
  await assert.rejects(pending, /Wallet changed/);
  assert.equal(f.requests(), 0);
});

test('explicit report signatures submit once; missing wallet and missing service are errors', async () => {
  const f = fixture();
  const pending = f.send();
  f.resolve();
  assert.equal((await pending).submitted, true);
  assert.equal(f.requests(), 1);
  f.window.DecentConfig = {};
  await assert.rejects(f.send(), /not configured/);
  f.window._wallet = null;
  await assert.rejects(f.send(), /Connect your wallet/);
});

test('compact UI includes one admin section, fixed report target, four reasons and scoped controls', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'js/content-review-ui.mjs'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'css/content-review.css'), 'utf8');
  assert.equal((html.match(/id="admin-content-review"/g) || []).length, 1);
  assert.match(source, /structuredClone\(contentTarget\(item\)\)/);
  assert.match(source, /CONTENT_REASONS\.map/);
  assert.match(source, /data-other hidden/);
  assert.match(source, /form\.elements\.note\.required = other/);
  assert.match(source, /Remove from music rotation/);
  assert.match(source, /Block all radio, including adverts/);
  assert.match(source, /wallet-connected/);
  assert.match(css, /\[hidden\].*display: none !important/);
  assert.match(html, /id="now-playing-watchlist-btn"[^>]*>👀<\/button>\s*<button id="radio-content-report"/);
  assert.doesNotMatch(html.match(/<div id="radio-voting"[\s\S]*?<\/div>/)[0], /radio-content-report/);
  const card = fs.readFileSync(path.join(root, 'js/nft-card.js'), 'utf8');
  assert.match(card, /class="nft-watchlist-btn[^>]*>👀 Save<\/button>\s*<button class="content-review-flag/);
  assert.match(source, /setInterval\(\(\) => void refreshReports\(\), 30000\)/);
  assert.match(source, /dirty \|\| root.contains\(document.activeElement\)/);
  assert.match(source, /Title, artist, token or collection/);
});

test('automatic review reads reuse only the signed view and stop on wallet changes or expiry', async () => {
  const f = fixture();
  await assert.rejects(f.view(true), /renew the read-only signature/);
  const initial = f.view();
  f.resolve();
  await initial;
  await f.view(true);
  assert.equal(f.requests(), 2, 'Polling reuses authorization without another signature');
  await assert.rejects(vm.runInContext("sendContentCommand({action:'policy'}, {reuseViewAuthorization:true})", f.context), /renew/);
  vm.runInContext('Date.now = () => new Date().getTime() + 270001', f.context);
  await assert.rejects(f.view(true), /renew/);
  assert.equal(f.requests(), 2);
  f.change();
  await assert.rejects(f.view(true), /renew/);
});

test('checkout rechecks eligibility and does not silently treat missing catalogs as safe', async () => {
  const { verifyRadioSongEligibility } = await import('../js/content-review.mjs');
  const songId = '0x' + '11'.repeat(32);
  await assert.rejects(verifyRadioSongEligibility({ service: '', songId }), /not configured/);
  await assert.rejects(verifyRadioSongEligibility({ service: 'https://example.org', songId,
    fetchImpl: async () => Response.json({ tracks: [] }) }), /no longer eligible/);
  await assert.rejects(verifyRadioSongEligibility({ service: 'https://example.org', songId,
    fetchImpl: async () => new Response('', { status: 503 }) }), /unavailable/);
  await verifyRadioSongEligibility({ service: 'https://example.org', songId,
    fetchImpl: async () => Response.json({ tracks: [{ songId }] }) });
});
