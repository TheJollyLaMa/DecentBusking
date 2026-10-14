const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/stage.js'), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/export /g, '');
const spaceSource = fs.readFileSync(path.join(__dirname, '../js/space.js'), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/export /g, '');
const walletA = `0x${'12'.repeat(20)}`;
const walletB = `0x${'ab'.repeat(20)}`;
const songA = { source: 'archive', title: 'Song A', artist: 'Artist A',
  nft: { name: 'Song A', artistName: 'Artist A', tipWallet: walletA } };
const songB = { source: 'archive', title: 'Song B', artist: 'Artist B',
  nft: { name: 'Song B', artistName: 'Artist B', tipWallet: walletB } };

function element() {
  const listeners = new Map();
  const classes = new Set(['hidden']);
  const attributes = new Map();
  return {
    textContent: '', children: [], disabled: false, value: '0.01',
    classList: {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      contains: value => classes.has(value),
      toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value),
    },
    addEventListener: (name, callback) => listeners.set(name, callback),
    click() { return listeners.get('click')?.({ target: this }); },
    append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; this.textContent = ''; },
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: name => attributes.get(name),
    removeAttribute: name => attributes.delete(name),
  };
}

function setup({ resolve = async () => null, receipt = async () => ({ status: 1 }), chainId = 8453n } = {}) {
  const ids = ['hat-btn', 'tip-modal', 'tip-to-label', 'tip-artist', 'tip-song', 'tip-status',
    'tip-track-position', 'tip-prev-btn', 'tip-next-btn', 'tip-send-btn', 'tip-cancel-btn', 'tip-amount'];
  const elements = Object.fromEntries(ids.map(id => [id, element()]));
  const listeners = new Map();
  const document = {
    getElementById: id => elements[id] || null,
    createElement: element,
    addEventListener: (name, callback) => listeners.set(name, callback),
  };
  const transfers = [];
  const celebrations = [];
  const context = vm.createContext({
    console, document, setTimeout,
    window: { ethereum: {}, _currentBuskerWallet: walletB, DecentConfig: {},
      _wallet: { signer: {
        provider: { getNetwork: async () => ({ chainId }) },
        sendTransaction: async transfer => {
          transfers.push(transfer);
          return { hash: `0x${'34'.repeat(32)}`, wait: receipt };
        },
      } },
    },
    ethers: { parseEther: amount => { assert.equal(amount, '0.01'); return 10n ** 16n; },
      formatEther: () => '0.01' },
    announcePaymentCelebration: detail => celebrations.push(detail),
    resolveNowPlayingNFT: resolve,
    nftArtistLabel: nft => nft.artistName || nft.artist || 'Unknown artist',
    initRadioSync() {}, openMintModal() {},
  });
  vm.runInContext(`${source}\ninitStage();`, context);
  return { elements, transfers, celebrations, context,
    play: detail => listeners.get('dbusk-now-playing')({ detail }),
    stop: () => listeners.get('dbusk-now-playing-stopped')(),
  };
}

test('hat shows the playing artist/song and first 6 + four ENS icons + last 4 of its wallet', async () => {
  const { elements, play, transfers, celebrations } = setup();
  play(songA);
  await elements['hat-btn'].click();
  assert.match(elements['tip-track-position'].textContent, /current song/i);
  assert.equal(elements['tip-artist'].textContent, 'Artist A');
  assert.equal(elements['tip-song'].textContent, 'Song A');
  const label = elements['tip-to-label'];
  assert.equal(label.title, walletA);
  assert.equal(label.getAttribute('aria-label'), `Tip recipient wallet: ${walletA}`);
  const address = label.children[0];
  assert.equal(address.children[0], walletA.slice(0, 6));
  assert.equal(address.children[5], walletA.slice(-4));
  assert.equal(address.children.length, 6);
  for (const icon of address.children.slice(1, 5)) {
    assert.equal(icon.src, 'img/Ens_Eth_Breathe.png');
    assert.equal(icon.alt, '');
  }
  play(songB);
  await elements['tip-send-btn'].click();
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].to, walletA);
  assert.match(elements['tip-status'].textContent, /Tip confirmed for Artist A.*Song A/);
  assert.equal(elements['tip-send-btn'].disabled, true);
  assert.equal(celebrations.length, 1);
  assert.equal(celebrations[0].amountText, '0.01');
  assert.equal(celebrations[0].assetText, 'ETH');
  assert.match(celebrations[0].summary, /Artist A.*Song A.*0x1212/);
});

test('played-song arrows move through history without changing playback', async () => {
  const { elements, play } = setup({ resolve: async (track) => (track.title === 'Song A' ? songA.nft : songB.nft) });
  play({ ...songA, nft: null });
  await elements['hat-btn'].click();
  assert.equal(elements['tip-prev-btn'].disabled, true);
  assert.equal(elements['tip-next-btn'].disabled, true);
  play({ ...songB, nft: null });
  assert.match(elements['tip-track-position'].textContent, /newer track/i);
  await elements['tip-next-btn'].click();
  assert.equal(elements['tip-artist'].textContent, 'Artist B');
  assert.equal(elements['tip-song'].textContent, 'Song B');
  assert.equal(elements['tip-to-label'].title, walletB);
  assert.match(elements['tip-track-position'].textContent, /current song/i);
  assert.equal(elements['tip-next-btn'].disabled, true);
  assert.equal(elements['tip-prev-btn'].disabled, false);
  await elements['tip-prev-btn'].click();
  assert.equal(elements['tip-to-label'].title, walletA);
  assert.equal(elements['tip-artist'].textContent, 'Artist A');
  assert.equal(elements['tip-song'].textContent, 'Song A');
});

test('radio lookup captures the clicked track even if playback changes during lookup', async () => {
  let complete;
  let lookup;
  const { elements, play, transfers } = setup({ resolve: (track, options) => {
    lookup = { track, options };
    return new Promise(resolve => { complete = resolve; });
  } });
  play({ ...songA, source: 'radio', nft: null, ipfsCid: 'bafy-a' });
  const opening = elements['hat-btn'].click();
  assert.equal(elements['tip-send-btn'].disabled, true);
  play(songB);
  complete(songA.nft);
  await opening;
  assert.equal(lookup.track.title, 'Song A');
  assert.equal(lookup.options.requireMediaMatch, true);
  await elements['tip-send-btn'].click();
  assert.equal(transfers[0].to, walletA);
});

test('closing while resolving cannot overwrite a newly opened recipient', async () => {
  let complete;
  const { elements, play } = setup({ resolve: () => new Promise(resolve => { complete = resolve; }) });
  play({ ...songA, nft: null });
  const opening = elements['hat-btn'].click();
  elements['tip-cancel-btn'].click();
  play(songB);
  await elements['hat-btn'].click();
  complete(songA.nft);
  await opening;
  assert.equal(elements['tip-to-label'].title, walletB);
  assert.equal(elements['tip-song'].textContent, 'Song B');
});

test('missing, invalid, and zero tip wallets never fall back to the last selected NFT', async () => {
  for (const wallet of ['', 'not-a-wallet', `0x${'0'.repeat(40)}`]) {
    const { elements, play, transfers } = setup();
    play({ ...songA, nft: { ...songA.nft, tipWallet: wallet } });
    await elements['hat-btn'].click();
    assert.equal(elements['tip-send-btn'].disabled, true);
    assert.match(elements['tip-status'].textContent, /No verified tip wallet/);
    await elements['tip-send-btn'].click();
    assert.equal(transfers.length, 0);
  }
});

test('no playing song and stopped playback disable tips, while open snapshots survive a stop', async () => {
  const { elements, play, stop, transfers } = setup();
  await elements['hat-btn'].click();
  assert.match(elements['tip-status'].textContent, /No song is playing/);
  play(songA);
  await elements['hat-btn'].click();
  stop();
  await elements['tip-send-btn'].click();
  assert.equal(transfers[0].to, walletA);
  await elements['hat-btn'].click();
  assert.equal(elements['tip-send-btn'].disabled, true);
});

test('lookup failures surface an error without enabling payment', async () => {
  const { elements, play } = setup({ resolve: async () => { throw new Error('Service offline'); } });
  play({ ...songA, nft: null });
  await elements['hat-btn'].click();
  assert.match(elements['tip-status'].textContent, /Could not verify.*Service offline/);
  assert.equal(elements['tip-send-btn'].disabled, true);
});

test('tips wait for successful receipts and prevent double submission', async () => {
  let complete;
  const { elements, play, transfers, celebrations } = setup({ receipt: () => new Promise(resolve => { complete = resolve; }) });
  play(songA);
  await elements['hat-btn'].click();
  const sending = elements['tip-send-btn'].click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(elements['tip-status'].textContent, /Waiting for on-chain confirmation/);
  assert.equal(elements['tip-prev-btn'].disabled, true);
  assert.equal(elements['tip-next-btn'].disabled, true);
  assert.equal(celebrations.length, 0);
  await elements['tip-send-btn'].click();
  assert.equal(transfers.length, 1);
  complete({ status: 0 });
  await sending;
  assert.match(elements['tip-status'].textContent, /not confirmed successfully/);
  assert.equal(elements['tip-send-btn'].disabled, false);
  assert.equal(celebrations.length, 0);
});

test('actual signer network must match the configured tip chain', async () => {
  const { elements, play, transfers } = setup({ chainId: 1n });
  play(songA);
  await elements['hat-btn'].click();
  await elements['tip-send-btn'].click();
  assert.equal(transfers.length, 0);
  assert.match(elements['tip-status'].textContent, /Switch MetaMask/);
});

test('a confirmed tip celebrates once with the receipt hash, never while pending', async () => {
  let complete;
  const hash = `0x${'56'.repeat(32)}`;
  const { elements, play, celebrations } = setup({ receipt: () => new Promise(resolve => { complete = resolve; }) });
  play(songA);
  await elements['hat-btn'].click();
  const sending = elements['tip-send-btn'].click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(celebrations.length, 0);
  complete({ status: 1, hash });
  await sending;
  assert.equal(celebrations.length, 1);
  assert.equal(celebrations[0].txHash, hash);
  await elements['tip-send-btn'].click();
  assert.equal(celebrations.length, 1);
});

test('strict catalog lookup rejects title-only matches and propagates service failures', async () => {
  const queries = [];
  const correct = { ...songA.nft, audioUrl: 'ipfs://bafy-correct' };
  const wrong = { ...songA.nft, audioUrl: 'ipfs://bafy-wrong', tipWallet: walletB };
  const context = vm.createContext({
    window: { DecentConfig: { ipfsUploadServiceUrl: 'https://service.example' } },
    fetchNftCatalogPage: async ({ query }) => {
      queries.push(query);
      return { nfts: [wrong, { ...wrong, audioUrl: 'ipfs://bafy-correct-extra' },
        { ...wrong, audioUrl: 'ipfs://BAFY-CORRECT' }, correct], nextOffset: null };
    },
  });
  vm.runInContext(spaceSource, context);
  const resolved = await context.resolveNowPlayingNFT({ title: 'Song A', artist: 'Discord uploader',
    ipfsCid: 'bafy-correct', audioUrl: 'https://gateway.example/ipfs/bafy-correct' }, { requireMediaMatch: true });
  assert.equal(resolved.tipWallet, walletA);
  assert.equal(queries[0], 'Song A');
  context.fetchNftCatalogPage = async () => { throw new Error('Catalog offline'); };
  await assert.rejects(context.resolveNowPlayingNFT({ title: 'Song A', ipfsCid: 'missing' },
    { requireMediaMatch: true }), /Catalog offline/);
});

test('the reused wallet icon exists and tip form describes native ETH only', () => {
  assert.ok(fs.statSync(path.join(__dirname, '../img/Ens_Eth_Breathe.png')).size > 0);
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.match(html, /id="tip-prev-btn"/);
  assert.match(html, /id="tip-next-btn"/);
  assert.match(html, /id="tip-track-position"/);
  assert.match(html, /id="tip-artist"/);
  assert.match(html, /id="tip-song"/);
  assert.match(html, /Amount <span class="hint">\(ETH\)/);
});
