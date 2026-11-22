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

function setup({ resolve = async () => null, receipt = async () => ({ status: 1 }), chainId = 8453n,
  liveTarget = async () => null, radioState = null, serviceUrl = '', routerAddress = '',
  protocol = {}, pendingReceipt = receipt, contractCode = '0x01', ethersImpl, configExtra = {}, songSplit = null } = {}) {
  const ids = ['hat-btn', 'tip-modal', 'tip-to-label', 'tip-artist', 'tip-song', 'tip-status',
    'tip-track-position', 'tip-prev-btn', 'tip-next-btn', 'tip-send-btn', 'tip-cancel-btn', 'tip-amount', 'tip-route',
    'tip-usdc-estimate'];
  const elements = Object.fromEntries(ids.map(id => [id, element()]));
  const listeners = new Map();
  const document = {
    getElementById: id => elements[id] || null,
    createElement: element,
    addEventListener: (name, callback) => listeners.set(name, callback),
  };
  const transfers = [];
  const celebrations = [];
  const contractTips = [];
  const copied = [];
  const context = vm.createContext({
    console, document, setTimeout, clearTimeout, ...protocol,
    navigator: { clipboard: { writeText: async value => { copied.push(value); } } },
    window: { ethereum: {}, _currentBuskerWallet: walletB, DecentConfig: { ipfsUploadServiceUrl: serviceUrl, tipRouterAddress: routerAddress, ...configExtra },
      _wallet: { signer: {
        getAddress: async () => walletB,
        provider: { getNetwork: async () => ({ chainId }), getCode: async () => contractCode,
          getTransactionReceipt: pendingReceipt },
        sendTransaction: async transfer => {
          transfers.push(transfer);
          return { hash: `0x${'34'.repeat(32)}`, wait: receipt };
        },
      } },
    },
    ethers: { parseEther: amount => { assert.equal(amount, '0.01'); return 10n ** 16n; },
      formatEther: () => '0.01', ...ethersImpl,
      Contract: class {
        constructor(address) {
          this.tip = async (...args) => {
            contractTips.push({ address, args });
            return { hash: `0x${'34'.repeat(32)}`, wait: receipt };
          };
          this.tipSplit = async (...args) => {
            contractTips.push({ address, split: true, args });
            return { hash: `0x${'34'.repeat(32)}`, wait: receipt };
          };
          this.getSong = async songId => {
            if (!songSplit) throw new Error('No on-chain song');
            return { ...songSplit, songId };
          };
        }
      } },
    announcePaymentCelebration: detail => celebrations.push(detail),
    resolveNowPlayingNFT: resolve,
    readLiveTipTarget: liveTarget,
    getRadioStateSnapshot: () => radioState,
    getBaseReadProvider: () => ({}),
    nftArtistLabel: nft => nft.artistName || nft.artist || 'Unknown artist',
    nftIdentity: nft => {
      if (!nft?.contractAddress || !Number.isSafeInteger(nft.tokenId)) throw new Error('Invalid NFT identity');
      return `${nft.chainId || 8453}:${nft.contractAddress.toLowerCase()}:${nft.tokenId}`;
    },
    initRadioSync() {}, openMintModal() {},
  });
  vm.runInContext(`${source}\ninitStage();`, context);
  return { elements, transfers, contractTips, celebrations, copied, context,
    mode: detail => listeners.get('radio-source-mode-change')({ detail }),
    play: detail => listeners.get('dbusk-now-playing')({ detail }),
    stop: () => listeners.get('dbusk-now-playing-stopped')(),
  };
}

test('live, radio and archive tips use the contract with frozen source, recipient, chain and exact wei', async () => {
  const protocol = await import('../js/tip-protocol.mjs');
  const ethersImpl = require('../discord-bot/node_modules/ethers');
  const routerAddress = `0x${'cd'.repeat(20)}`, collection = `0x${'ef'.repeat(20)}`;
  for (const source of ['live', 'radio', 'archive']) {
    const sourceContext = source === 'live' ? { source, bookingId: 'friday:fixture' }
      : { source, nftId: `8453:${collection}:80` };
    const expected = protocol.createTipContext(sourceContext);
    const encoded = new ethersImpl.Interface(protocol.TIP_ABI).encodeEventLog('TipSent', [
      walletB, walletA, ethersImpl.id(expected.contextRef), expected.sourceKind, 10000000000000001n, expected.contextRef,
    ]);
    const { elements, play, contractTips, transfers, context, celebrations } = setup({
      protocol, ethersImpl, routerAddress,
      serviceUrl: source === 'live' ? 'https://worker.test' : '',
      liveTarget: async () => ({ wallet: walletA, artist: 'Artist A', title: 'Live set', bookingId: 'friday:fixture' }),
      receipt: async () => ({ status: 1, hash: `0x${'34'.repeat(32)}`, logs: [{ ...encoded, address: routerAddress, index: 0 }] }),
    });
    play({ ...songA, source: source === 'live' ? 'radio' : source, nft: { ...songA.nft, contractAddress: collection, tokenId: 80 } });
    await elements['hat-btn'].click();
    elements['tip-amount'].value = '0.010000000000000001';
    context.window.DecentConfig.tipRouterAddress = walletB;
    context.window.DecentConfig.chainId = 1;
    play(songB);
    await elements['tip-send-btn'].click();
    assert.equal(transfers.length, 0);
    assert.equal(contractTips.length, 1);
    assert.equal(contractTips[0].address, routerAddress);
    assert.equal(contractTips[0].args[0], walletA);
    assert.equal(contractTips[0].args[1], expected.sourceKind);
    assert.equal(contractTips[0].args[2], expected.contextRef);
    assert.equal(contractTips[0].args[3].value, 10000000000000001n);
    assert.equal(contractTips[0].args[3].chainId, 8453);
    assert.match(elements['tip-status'].textContent, /source recorded on-chain/);
    assert.equal(celebrations.length, 1);
  }
});

test('invalid attribution configuration and missing recording identity never silently use a direct transfer', async () => {
  const protocol = await import('../js/tip-protocol.mjs');
  for (const routerAddress of ['bad-router', `0x${'0'.repeat(40)}`, 0, `0x${'cd'.repeat(20)}`]) {
    const { elements, play, transfers, contractTips } = setup({ protocol, routerAddress });
    play(songA);
    await elements['hat-btn'].click();
    assert.match(elements['tip-status'].textContent, /invalid contract|Invalid NFT identity/i);
    await elements['tip-send-btn'].click();
    assert.equal(transfers.length + contractTips.length, 0);
  }
});

test('unverified contract receipts and interrupted waits only recheck the submitted tip, including after modal close', async () => {
  const protocol = await import('../js/tip-protocol.mjs');
  const ethersImpl = require('../discord-bot/node_modules/ethers');
  const routerAddress = `0x${'cd'.repeat(20)}`;
  const context = protocol.createTipContext({ source: 'live', bookingId: 'show' });
  const encoded = new ethersImpl.Interface(protocol.TIP_ABI).encodeEventLog('TipSent', [
    walletB, walletA, ethersImpl.id(context.contextRef), context.sourceKind, 10n ** 16n, context.contextRef,
  ]);
  for (const receipt of [async () => { throw Error('RPC offline'); }, async () => ({ status: 1, hash: `0x${'34'.repeat(32)}`, logs: [] })]) {
    const { elements, play, transfers, contractTips, celebrations } = setup({
      protocol, ethersImpl, routerAddress, receipt, serviceUrl: 'https://worker.test',
      liveTarget: async () => ({ wallet: walletA, artist: 'Artist A', title: 'Set A', bookingId: 'show' }),
      pendingReceipt: async () => ({ status: 1, hash: `0x${'34'.repeat(32)}`, logs: [{ ...encoded, address: routerAddress, index: 3 }] }),
    });
    await elements['hat-btn'].click();
    await elements['tip-send-btn'].click();
    assert.match(elements['tip-status'].textContent, /not yet verified/);
    assert.equal(celebrations.length, 0);
    elements['tip-cancel-btn'].click();
    play(songB);
    await elements['hat-btn'].click();
    assert.equal(elements['tip-song'].textContent, 'Set A');
    assert.equal(elements['tip-send-btn'].textContent, 'Recheck tip');
    await elements['tip-send-btn'].click();
    assert.equal(transfers.length, 0);
    assert.equal(contractTips.length, 1);
    assert.equal(celebrations.length, 1);
  }
});

test('live hat replaces the last recorded artist with the freshly verified performer and freezes that recipient', async () => {
  let lookups = 0;
  const { elements, play, stop, transfers, context } = setup({
    serviceUrl: 'https://worker.test',
    radioState: { liveAudio: { phase: 'live', bookingId: 'show', policy: { mode: 'live' } } },
    liveTarget: async options => {
      lookups++;
      assert.equal(options.expectedBookingId, 'show');
      return { bookingId: 'show', wallet: walletB, artist: 'Live artist', title: 'Live set' };
    },
  });
  play(songA); stop();
  await elements['hat-btn'].click();
  assert.equal(lookups, 1);
  assert.equal(elements['tip-to-label'].title, walletB);
  assert.match(elements['tip-track-position'].textContent, /Live performer.*locked/);
  assert.equal(elements['tip-prev-btn'].disabled, true);
  play(songA);
  context.window.DecentConfig.chainId = 1;
  await elements['tip-send-btn'].click();
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].to, walletB, 'Neither another track nor configuration change can redirect the prepared tip');
});

test('live-target lookup failure is visible and cannot fall back to recorded history or an arbitrary busker wallet', async () => {
  for (const history of [false, true]) {
    const { elements, play, stop, transfers } = setup({
      serviceUrl: 'https://worker.test',
      liveTarget: async () => { throw Error('Live booking verification is stale'); },
    });
    if (history) { play(songA); stop(); }
    await elements['hat-btn'].click();
    assert.equal(elements['tip-send-btn'].disabled, true);
    assert.match(elements['tip-status'].textContent, /Live booking verification is stale/);
    await elements['tip-send-btn'].click();
    assert.equal(transfers.length, 0);
  }
});

test('closing a pending live lookup cannot replace a later verified performer', async () => {
  let finishOld, calls = 0;
  const { elements } = setup({
    serviceUrl: 'https://worker.test',
    liveTarget: async () => ++calls === 1 ? new Promise(resolve => { finishOld = resolve; })
      : { bookingId: 'second', wallet: walletB, artist: 'Second artist', title: 'Second set' },
  });
  const first = elements['hat-btn'].click();
  elements['tip-cancel-btn'].click();
  await elements['hat-btn'].click();
  finishOld({ bookingId: 'first', wallet: walletA, artist: 'First artist', title: 'First set' });
  await first;
  assert.equal(elements['tip-to-label'].title, walletB);
  assert.equal(elements['tip-artist'].textContent, 'Second artist');
});

test('archive selection and confirmed ordinary radio retain their existing NFT tip flow', async () => {
  let liveReads = 0;
  const { elements, mode, play, stop } = setup({
    serviceUrl: 'https://worker.test', resolve: async () => songA.nft,
    liveTarget: async () => { liveReads++; return null; },
  });
  mode('archive'); play(songA);
  await elements['hat-btn'].click();
  assert.equal(liveReads, 0);
  assert.equal(elements['tip-to-label'].title, walletA);
  elements['tip-cancel-btn'].click();
  stop(); mode('radio');
  play({ ...songA, source: 'radio', nft: null });
  await elements['hat-btn'].click();
  assert.equal(liveReads, 1);
  assert.equal(elements['tip-to-label'].title, walletA);
});

test('recordings with multiple creator shares fail closed instead of sending a 100% tip', async () => {
  const { elements, play, transfers, contractTips } = setup({
    serviceUrl: 'https://worker.test', liveTarget: async () => null,
    resolve: async () => ({ ...songA.nft, creatorSplits: [
      { wallet: walletA, shareBps: 6000 }, { wallet: walletB, shareBps: 4000 },
    ] }),
  });
  play({ ...songA, source: 'radio', nft: null });
  await elements['hat-btn'].click();
  assert.match(elements['tip-status'].textContent, /shared between owners/);
  assert.equal(elements['tip-send-btn'].disabled, true);
  await elements['tip-send-btn'].click();
  assert.equal(transfers.length + contractTips.length, 0);
});

test('shared songs tip every owner in one contract call using the on-chain DJuke split', async () => {
  const protocol = await import('../js/tip-protocol.mjs');
  const ethersImpl = require('../discord-bot/node_modules/ethers');
  const splitRouter = `0x${'cd'.repeat(20)}`, collection = `0x${'ef'.repeat(20)}`, djuke = `0x${'56'.repeat(20)}`;
  const songId = `0x${'78'.repeat(32)}`;
  const expected = protocol.createTipContext({ source: 'radio', nftId: `8453:${collection}:49` });
  const iface = new ethersImpl.Interface(protocol.TIP_ABI);
  const amount = 10000000000000001n, first = amount * 7000n / 10000n;
  const logs = [[walletA, first], [walletB, amount - first]].map(([recipient, value], index) => ({
    ...iface.encodeEventLog('TipSent', [walletB, recipient, ethersImpl.id(expected.contextRef), expected.sourceKind, value, expected.contextRef]),
    address: splitRouter, index }));
  const nft = { ...songA.nft, contractAddress: collection, tokenId: 49, djukeSongId: songId,
    creatorSplits: [{ wallet: walletA, shareBps: 7000 }, { wallet: walletB, shareBps: 3000 }] };
  const { elements, play, contractTips, celebrations } = setup({
    protocol, ethersImpl, routerAddress: `0x${'9a'.repeat(20)}`,
    configExtra: { tipSplitRouterAddress: splitRouter, djukeContractAddress: djuke },
    songSplit: { recipients: [walletA, walletB], sharesBps: [7000n, 3000n] },
    receipt: async () => ({ status: 1, hash: `0x${'34'.repeat(32)}`, logs }),
  });
  play({ ...songA, source: 'radio', nft });
  await elements['hat-btn'].click();
  assert.match(elements['tip-route'].textContent, /Split between 2 song owners/);
  elements['tip-amount'].value = '0.010000000000000001';
  await elements['tip-send-btn'].click();
  assert.equal(contractTips.length, 1);
  assert.equal(contractTips[0].split, true);
  assert.equal(contractTips[0].address, splitRouter);
  assert.deepEqual([...contractTips[0].args[0]], [walletA, walletB]);
  assert.deepEqual([...contractTips[0].args[1]], [7000, 3000]);
  assert.equal(contractTips[0].args[3], expected.contextRef);
  assert.equal(contractTips[0].args[4].value, amount);
  assert.match(elements['tip-status'].textContent, /Tip confirmed/);
  assert.equal(celebrations.length, 1);

  const stale = setup({ protocol, ethersImpl, routerAddress: `0x${'9a'.repeat(20)}`,
    configExtra: { tipSplitRouterAddress: splitRouter, djukeContractAddress: djuke },
    songSplit: { recipients: [walletA, walletB], sharesBps: [5000n, 5000n] } });
  stale.play({ ...songA, source: 'radio', nft });
  await stale.elements['hat-btn'].click();
  assert.match(stale.elements['tip-status'].textContent, /being updated/);
  await stale.elements['tip-send-btn'].click();
  assert.equal(stale.contractTips.length, 0);
});

test('all cached stage importers resolve to the live-tip controller', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const imports = JSON.parse(html.match(/<script type="importmap">\s*([\s\S]*?)<\/script>/)[1]).imports;
  for (const file of ['main.js', 'space.js', 'nft-card.js']) {
    const importer = fs.readFileSync(path.join(__dirname, '../js', file), 'utf8');
    const references = [...importer.matchAll(/['"](\.\/stage\.js[^'"]*)['"]/g)];
    assert.ok(references.length);
    for (const [, reference] of references) {
      assert.equal(imports[reference.replace('./', './js/')], './js/stage.js?v=20261123-song-splits');
    }
  }
  assert.equal(imports['./js/space.js?v=20261030-ad-cutoff'], './js/space.js?v=20261122-hls-tip-match');
});

test('footer NFT lookup failures report verification errors and recover on retry', async () => {
  const status = element();
  const button = element();
  const warnings = [];
  let fail = true;
  const context = vm.createContext({
    console: { warn: (...args) => warnings.push(args) },
    document: { getElementById: id => id === 'now-playing-watchlist-status' ? status : button },
    resolveNowPlayingNFT: async () => { if (fail) throw new Error('Catalog unavailable'); return { tokenId: 80 }; },
    applyCreatorWatchlistButton: (_button, nft, flags) => ({ mode: flags.resolving ? 'pending' : nft ? 'saved' : 'unavailable' }),
  });
  vm.runInContext(`${source}\n_watchlistTrack = {title:'Minted song'};`, context);
  await vm.runInContext('_resolveWatchlistTrack(_watchlistTrack)', context);
  assert.equal(status.textContent, 'NFT verification unavailable: Catalog unavailable');
  assert.equal(warnings.length, 1);
  fail = false;
  await vm.runInContext('_resolveWatchlistTrack(_watchlistTrack)', context);
  assert.equal(status.textContent, 'Saved to your watchlist.');
  assert.equal(button.textContent, '👀');
  assert.equal(button.classList.contains('hidden'), false);
});

test('watchlist eyes remain visible but disabled when no song is playing', () => {
  const button = element();
  const status = element();
  const context = vm.createContext({
    document: { getElementById: id => id === 'now-playing-watchlist-status' ? status : button },
  });
  vm.runInContext(`${source}\n_renderWatchlistState();`, context);
  assert.equal(button.textContent, '👀');
  assert.equal(button.classList.contains('hidden'), false);
  assert.equal(button.disabled, true);
  assert.match(button.getAttribute('aria-label'), /Play a verified NFT/);
});

test('wallet connection guidance stays on the eyes button rather than cluttering the footer', () => {
  const button = element();
  const status = element();
  const context = vm.createContext({
    document: { getElementById: id => id === 'now-playing-watchlist-status' ? status : button },
    applyCreatorWatchlistButton: (target) => {
      target.setAttribute('aria-label', 'Connect your wallet to save this NFT');
      target.title = 'Connect your wallet to save this NFT';
      return { mode: 'connect' };
    },
  });
  vm.runInContext(`${source}\n_watchlistTrack = { nft: { tokenId: 80 } }; _renderWatchlistState();`, context);
  assert.equal(status.textContent, '');
  assert.equal(button.textContent, '👀');
  assert.match(button.getAttribute('aria-label'), /Connect your wallet/);
  assert.match(button.title, /Connect your wallet/);
});

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

test('tip recipient wallet is copyable and ETH amount shows an approximate USDC value', async () => {
  const { elements, play, copied, context } = setup();
  play(songA);
  vm.runInContext('_tipEthUsdcRate = 2500;', context);
  await elements['hat-btn'].click();
  elements['tip-amount'].value = '0.5';
  await vm.runInContext('_renderTipUsdcEstimate()', context);
  assert.match(elements['tip-usdc-estimate'].textContent, /1,250\.00 USDC/);
  const copy = elements['tip-to-label'].children.find(child => child.className === 'tip-wallet-copy');
  assert.ok(copy);
  await copy.click();
  assert.deepEqual(copied, [walletA]);
  assert.equal(copy.textContent, 'Copied');
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
