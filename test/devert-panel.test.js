const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const at = Date.parse('2026-10-14T00:00:00Z');
const advertiser = `0x${'11'.repeat(20)}`;
function campaign(id, overrides = {}) {
  return { campaignId: String(id), title: `Ad ${id}`, advertiser, audioURI: `ipfs://ad-${id}`,
    offerUnits: '5000000', startedAt: new Date(at - 1000).toISOString(),
    expiresAt: new Date(at + 1000).toISOString(), ...overrides };
}
function snapshot(campaigns = []) {
  return { chainId: 8453, snapshotAt: new Date(at).toISOString(), campaigns, market: { slots: 1 },
    contractAddress: `0x${'22'.repeat(20)}`, paused: false };
}

test('public next-position quotes use shared pricing at every seven-ad boundary', async () => {
  const { devertPublicQueue } = await import('../js/devert-tab.mjs');
  for (const [count, dollars] of [[0, 1], [6, 1], [7, 2], [13, 2], [14, 4], [20, 4], [21, 8]]) {
    const result = devertPublicQueue(snapshot(Array.from({ length: count }, (_, i) => campaign(i))));
    assert.equal(result.campaigns.length, count);
    assert.equal(result.minimumOfferUnits, BigInt(dollars) * 1_000_000n);
  }
  assert.throws(() => devertPublicQueue({}), /Invalid public queue/);
  assert.throws(() => devertPublicQueue({ ...snapshot(), campaigns: null }), /Invalid DeVert schedule/);
});

test('public queue follows shared scheduling priority, not API or wallet order, and excludes inactive ads', async () => {
  const { devertPublicQueue } = await import('../js/devert-tab.mjs');
  const state = snapshot([
    campaign(1, { offerUnits: '9000000', mainRadioPlays: 2 }),
    campaign(2, { offerUnits: '1000000', djukeBoosts: 1 }),
    campaign(3, { offerUnits: '8000000' }),
    campaign(4, { expiresAt: new Date(at).toISOString() }),
    campaign(5, { startedAt: new Date(at + 100).toISOString() }),
  ]);
  assert.deepEqual(devertPublicQueue(state).campaigns.map(ad => ad.campaignId), ['2', '3', '1']);
  assert.deepEqual(state.campaigns.map(ad => ad.campaignId), ['1', '2', '3', '4', '5']);
});

async function panelFixture({ wallet = null } = {}) {
  const scheduler = await import('../js/devert-scheduler.mjs');
  const { formatUsdcUnits } = await import('../js/usdc-format.mjs');
  const nodes = new Map();
  const documentListeners = new Map();
  let focused;
  let radioSnapshot = null;
  function element(id) {
    if (nodes.has(id)) return nodes.get(id);
    const listeners = new Map();
    const attributes = new Map();
    const item = { id, listeners, children: [], dataset: {}, value: '', textContent: '', open: false,
      files: [], paused: true, volume: 1, hidden: false, classList: { add() {}, remove() {} },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      setAttribute(name, value) { attributes.set(name, value); },
      getAttribute(name) { return attributes.get(name); },
      removeAttribute(name) { attributes.delete(name); },
      addEventListener(name, callback) { listeners.set(name, callback); },
      focus() { focused = id; }, pause() {}, load() {},
      contains(target) { return target === this || this.children.some(child => child.contains?.(target)); },
      showModal() { this.open = true; },
      close() { this.open = false; listeners.get('close')?.(); },
    };
    nodes.set(id, item);
    return item;
  }
  const document = { readyState: 'loading', body: element('body'), getElementById: element,
    createElement: tag => element(`created-${tag}-${nodes.size}`),
    addEventListener(name, callback) {
      if (!documentListeners.has(name)) documentListeners.set(name, []);
      documentListeners.get(name).push(callback);
    },
    dispatchEvent(event) { for (const listener of documentListeners.get(event.type) || []) listener(event); },
  };
  const timers = [];
  const listenModes = [];
  const requests = [];
  let read = async () => snapshot();
  let readAds = async () => ({ ads: [{ title: 'Ready ad', ipfsCid: 'ready', state: 'ready' }] });
  const context = vm.createContext({ ...scheduler, document, formatUsdcUnits,
    window: { DecentConfig: { ipfsUploadServiceUrl: 'https://service.example',
      devertContractAddress: snapshot().contractAddress }, _wallet: wallet },
    canSetDevertListenMode: () => true,
    setDevertListenMode: mode => { listenModes.push(mode); return true; }, AbortSignal,
    getRadioStateSnapshot: () => radioSnapshot,
    formatMainRadioAdCountdown: (countdown, { disconnected } = {}) => {
      if (disconnected) return 'Main radio ad: disconnected';
      if (!countdown) return 'Main radio ad: scheduling unavailable';
      if (countdown.status === 'countdown') return `Main radio ad: Next advert after ${countdown.remainingSongs} more songs (current song not counted)`;
      if (countdown.status === 'up_next') return 'Main radio ad: Advert up next';
      if (countdown.status === 'playing') return 'Main radio ad: Advert playing now';
      if (countdown.status === 'paused') return `Main radio ad: Deferred during ${countdown.activeShow?.label || 'this show'}`;
      if (countdown.status === 'none') return 'Main radio ad: No eligible campaign available';
      if (countdown.status === 'unavailable' && countdown.reason === 'worker gas low') return 'Ad reporting paused – worker gas low';
      return 'Main radio ad: unavailable';
    },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {}, clearInterval() {}, setInterval() { return 1; },
    fetch: async url => {
      requests.push(url);
      const body = url.includes('/ads?') ? await readAds()
        : url.endsWith('/loop') ? { ready: true } : await read();
      return { ok: true, status: 200, json: async () => body };
    },
  });
  const source = fs.readFileSync(path.join(__dirname, '../js/devert-tab.mjs'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export /g, '');
  vm.runInContext(`${source}\ninitDevertTab();`, context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { element, document, timers, requests, listenModes, settle, context, focus: () => focused,
    read: callback => { read = callback; }, readAds: callback => { readAds = callback; },
    setRadioState: (state) => { radioSnapshot = state; document.dispatchEvent({ type: 'dbusk-radio-state', detail: state }); },
    click: id => element(id).listeners.get('click')({ stopPropagation() {} }) };
}

test('public queue loads without a wallet, refreshes tiers, and clears stale quotes on failures', async () => {
  const ui = await panelFixture();
  await ui.click('devert-tab');
  assert.equal(ui.element('devert-price').textContent, 'Loading…');
  await ui.settle();
  assert.equal(ui.element('devert-price').textContent, '1.00');
  assert.match(ui.element('devert-queue-status').textContent, /No active campaigns in ordinary rotation/);
  assert.equal(ui.requests.some(url => url.includes('/ads?')), false);
  assert.equal(ui.timers.at(-1).delay, 30_000);
  ui.read(async () => snapshot(Array.from({ length: 7 }, (_, i) => campaign(i))));
  await ui.click('devert-queue-refresh');
  await ui.settle();
  assert.equal(ui.element('devert-price').textContent, '2.00');
  assert.equal(ui.element('devert-queue').children.length, 7);
  ui.read(async () => { throw new Error('offline'); });
  await ui.click('devert-queue-refresh');
  await ui.settle();
  assert.equal(ui.element('devert-price').textContent, 'Unavailable');
  assert.equal(ui.element('devert-queue').children.length, 0);
  assert.match(ui.element('devert-queue-status').textContent, /unavailable: offline/);
});

test('wallet library failures do not hide the public quote or queue', async () => {
  const ui = await panelFixture({ wallet: { address: advertiser } });
  ui.read(async () => snapshot([campaign(1)]));
  ui.readAds(async () => { throw new Error('library offline'); });
  await ui.click('devert-tab');
  await ui.settle();
  assert.equal(ui.element('devert-price').textContent, '1.00');
  assert.equal(ui.element('devert-queue').children.length, 1);
  assert.match(ui.element('devert-campaign-status').textContent, /library offline/);
});

test('main radio countdown note mirrors the shared main-radio status', async () => {
  const ui = await panelFixture();
  ui.setRadioState({
    mainRadioAdCountdown: { status: 'countdown', remainingSongs: 3, includesCurrentSong: false },
  });
  await ui.click('devert-tab');
  await ui.settle();
  assert.equal(ui.element('devert-radio-status').textContent, 'Main radio ad: Next advert after 3 more songs (current song not counted)');
  ui.setRadioState({ mainRadioAdCountdown: { status: 'up_next', remainingSongs: 0, includesCurrentSong: false } });
  assert.equal(ui.element('devert-radio-status').textContent, 'Main radio ad: Advert up next');
  ui.setRadioState({ mainRadioAdCountdown: { status: 'unavailable', reason: 'disconnected' } });
  assert.equal(ui.element('devert-radio-status').textContent, 'Main radio ad: disconnected');
});

test('superseded queue responses cannot overwrite newer queue and pricing state', async () => {
  const ui = await panelFixture();
  let release;
  ui.read(() => new Promise(resolve => { release = resolve; }));
  await ui.click('devert-tab');
  ui.read(async () => snapshot([campaign(99)]));
  await ui.click('devert-queue-refresh');
  await ui.settle();
  release(snapshot(Array.from({ length: 7 }, (_, i) => campaign(i))));
  await ui.settle();
  assert.equal(ui.element('devert-price').textContent, '1.00');
  assert.equal(ui.element('devert-queue').children.length, 1);
  assert.equal(ui.element('devert-queue').children[0].children[0].textContent, 'Ad 99');
});

test('wallet gating and pending-upload polling remain independent of the public queue', async () => {
  const ui = await panelFixture({ wallet: { address: advertiser, signer: {}, chainId: 1 } });
  ui.readAds(async () => ({ ads: [], scanPending: true }));
  await ui.click('devert-tab');
  await ui.settle();
  assert.equal(ui.element('devert-price').textContent, '1.00');
  assert.equal(ui.element('devert-purchase').disabled, true);
  assert.equal(ui.element('devert-ad-queue').disabled, true);
  assert.equal(ui.timers.at(-1).delay, 3_000);
});

test('ready-ad selection reveals Run Campaign before focus, keeps disclosures independent and weekly checkout fixed', async () => {
  const ui = await panelFixture({ wallet: { address: advertiser, signer: {}, chainId: 8453 } });
  await ui.click('devert-tab');
  await ui.settle();
  const use = ui.element('devert-campaigns').children[0].children[1];
  use.listeners.get('click')();
  assert.equal(ui.element('devert-run-campaign').open, true);
  assert.equal(ui.element('devert-submit-ad').open, false);
  assert.equal(ui.focus(), 'devert-weeks');
  assert.equal(ui.element('devert-title').value, 'Ready ad');
  assert.equal(ui.element('devert-audio-uri').value, 'ipfs://ready');
  ui.element('devert-run-campaign').open = false;
  ui.element('devert-search-results').children[0].children[0].listeners.get('click')();
  assert.equal(ui.element('devert-run-campaign').open, true);
  ui.element('devert-weeks').value = '3';
  ui.element('devert-weeks').listeners.get('input')();
  assert.match(ui.element('devert-campaign-total').textContent, /3 × 5.00 USDC = 15\.00 USDC/);
});

test('instructions modal restores focus and Escape does not close its underlying panel', async () => {
  const ui = await panelFixture();
  await ui.click('devert-tab');
  await ui.settle();
  await ui.click('devert-info');
  assert.equal(ui.element('devert-instructions').open, true);
  ui.document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(ui.element('devert-tab').getAttribute('aria-expanded'), 'true');
  await ui.click('devert-instructions-close');
  assert.equal(ui.element('devert-instructions').open, false);
  assert.equal(ui.focus(), 'devert-info');
});

test('DVert uses the header wallet and resyncs campaign checkout when its network changes', async () => {
  const ui = await panelFixture({ wallet: { address: advertiser, signer: {}, chainId: 8453 } });
  await ui.click('devert-tab');
  await ui.settle();
  assert.equal(ui.element('devert-purchase').disabled, false);
  ui.context.window._wallet.chainId = 1;
  ui.document.dispatchEvent({ type: 'wallet-chain-changed' });
  assert.equal(ui.element('devert-purchase').disabled, true);
  assert.equal(ui.element('devert-minimum-offer').textContent, 'Switch to Base');
  ui.context.window._wallet.chainId = 8453;
  ui.document.dispatchEvent({ type: 'wallet-chain-changed' });
  assert.equal(ui.element('devert-purchase').disabled, false);
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '../js/devert-tab.mjs'), 'utf8');
  assert.doesNotMatch(html, /id="devert-connect-wallet"/);
  assert.doesNotMatch(source, /walletButton|_wallet\?\.connect/);
});

test('machine layout orders LCD, paid queue, search and controls with secondary sections collapsed', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const panel = html.slice(html.indexOf('<aside id="devert-panel"'), html.indexOf('<dialog id="devert-instructions"'));
  assert.doesNotMatch(panel, /Ad studio · Base|7 Days|Campaign Instructions/);
  const ordered = ['devert-audio-mode', 'devert-paid-price', 'devert-paid-requests',
    'devert-search', 'devert-paid-campaign', 'devert-paid-queue-button', 'devert-queue'];
  for (let index = 1; index < ordered.length; index++) {
    assert.ok(panel.indexOf(`id="${ordered[index - 1]}"`) < panel.indexOf(`id="${ordered[index]}"`));
  }
  assert.match(panel, /id="devert-paid-queue-button"[^>]*disabled>Queue Ad/);
  assert.match(panel, /id="devert-paid-immediate-button"[^>]*disabled>After This Song/);
  assert.match(panel, /On Rotation/);
  assert.match(panel, /aria-describedby="devert-live-tooltip"/);
  assert.match(panel, /id="devert-live-tooltip" role="tooltip"/);
  assert.doesNotMatch(panel, /devert-paid-refund|Claim full refund|class="devert-tiers" open/);
  for (const id of ['devert-my-ads', 'devert-submit-ad', 'devert-run-campaign']) {
    assert.match(panel, new RegExp(`<details id="${id}" class="devert-disclosure">`));
  }
  assert.match(html, /<dialog id="devert-instructions" aria-labelledby="devert-instructions-title">/);
  assert.match(html, /aria-label="DVert campaign instructions" aria-haspopup="dialog"/);
  for (const step of ['Upload your audio or MP4 ad for review', 'Approved NFT sent to your wallet',
    'Select the minted NFT, choose weeks, and purchase the campaign']) assert.ok(html.includes(step));
});

test('live icon preserves its artwork, hushes radio, and returns on toggle or panel close', async () => {
  const ui = await panelFixture();
  const button = ui.element('devert-audio-mode');
  button.textContent = 'icon artwork';
  await ui.click('devert-tab');
  await ui.settle();
  assert.equal(ui.element('devert-live-player').hidden, true);
  await ui.click('devert-audio-mode');
  await ui.settle();
  assert.equal(button.textContent, 'icon artwork');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.getAttribute('aria-label'), 'Return to Main Radio');
  assert.equal(ui.element('devert-live-player').hidden, false);
  assert.equal(ui.element('devert-live-votes').hidden, false);
  assert.deepEqual(ui.listenModes, ['ads-only']);
  await ui.click('devert-audio-mode');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(ui.element('devert-live-player').hidden, true);
  assert.equal(ui.element('devert-live-votes').hidden, true);
  await ui.click('devert-audio-mode');
  await ui.settle();
  await ui.click('devert-close');
  assert.deepEqual(ui.listenModes, ['ads-only', 'radio', 'ads-only', 'radio']);
  assert.equal(button.getAttribute('aria-label'), 'Listen to VertLoop');
  assert.equal(ui.element('devert-live-player').hidden, true);
});
