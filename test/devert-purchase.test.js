const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const OFFER = 1_000_000n;
const FEE_CAP = 2_000_000_000n;
const ADVERTISER = '0x1111111111111111111111111111111111111111';
const CONTRACT_ADDRESS = '0x2222222222222222222222222222222222222222';

test('DVert panel exposes local Main Radio and Ads Only controls with no paid preview implication', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  for (const id of ['devert-audio-mode', 'devert-ad-preview', 'devert-listen-status', 'devert-vote-up', 'devert-vote-down']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} should appear once`);
  }
  assert.match(html, /Approved NFT sent to your wallet/);
  assert.match(html, /Submit for Review/);
  assert.match(html, /My Ads/);
  assert.match(html, /id="devert-campaigns" aria-label="My DeVert advertisements"/);
  assert.match(html, /id="devert-search-results"/);
  assert.match(html, /Current Queue Price/);
  assert.match(html, /id="devert-price"[^>]*>Loading…<\/strong>/);
  assert.match(html, /id="devert-audio-uri"[^>]*readonly/);
  assert.match(html, /id="devert-weeks"[^>]*value="1"/);
  assert.match(html, /Priority Queue Bump<\/td><td>\$1\.00 · positions 1–7/);
  assert.match(html, /Priority Queue Bump<\/td><td>\$2\.00 · positions 8–14/);
  assert.match(html, /Priority Queue Bump<\/td><td>\$4\.00 · positions 15–21/);
  assert.match(html, /Campaign Instructions: Submit, Receive &amp; Run/);
  assert.doesNotMatch(html, /<details class="devert-workflow-details">/);
  assert.doesNotMatch(html, /id="devert-offer"/);
  assert.doesNotMatch(html, /id="devert-max-payment"/);
  assert.match(fs.readFileSync(path.join(__dirname, '../js/devert-tab.mjs'), 'utf8'), /api\/devert\/ads/);
  assert.match(fs.readFileSync(path.join(__dirname, '../js/devert-tab.mjs'), 'utf8'), /api\/devert\/ads\?wallet=/);
  assert.match(fs.readFileSync(path.join(__dirname, '../js/devert-tab.mjs'), 'utf8'), /renderAdLibrary/);
  assert.match(fs.readFileSync(path.join(__dirname, '../css/styles.css'), 'utf8'), /#devert-search-results \{/);
  assert.match(fs.readFileSync(path.join(__dirname, '../css/styles.css'), 'utf8'), /\.devert-library-card/);
  assert.match(fs.readFileSync(path.join(__dirname, '../discord-bot/index.js'), 'utf8'), /getDevertAdsForWallet\(address/);
  assert.doesNotMatch(html, /id="devert-profile"/);
  assert.doesNotMatch(html, /id="devert-mute-ads"|id="devert-listen-radio"|id="devert-listen-ads"/);
  assert.equal((html.match(/id="devert-max-payment"/g) || []).length, 0);
  const panel = fs.readFileSync(path.join(__dirname, '../js/devert-tab.mjs'), 'utf8');
  // Every importer must share one radio-sync URL, or browsers load two copies with separate radio state.
  const radioSyncTags = new Set(fs.readdirSync(path.join(__dirname, '../js'))
    .filter(name => /\.m?js$/.test(name))
    .flatMap(name => [...fs.readFileSync(path.join(__dirname, '../js', name), 'utf8').matchAll(/\.\/radio-sync\.js(\?v=[^'"]*)?['"]/g)].map(match => match[1] || '')));
  assert.match(panel, /from '\.\/radio-sync\.js\?v=[^']+'/);
  assert.equal(radioSyncTags.size, 1, `radio-sync.js imported with mixed cache tags: ${[...radioSyncTags].join(', ')}`);
  assert.match(panel, /document\.addEventListener\('wallet-connected', refresh\)/);
  assert.match(panel, /adMediaStatus\.textContent = 'Submitted for review\.';\s*await refresh\(\)/);
  assert.match(panel, /scanPending \? 3_000 : 30_000/);
});

function fixture({ nativeBalance = 1_000_000_000_000_000_000n, allowance = 0n } = {}) {
  const calls = { approvals: [], simulations: [], purchases: [], steps: [] };
  let currentChainId = 8453n;
  const provider = {
    getNetwork: async () => ({ chainId: currentChainId }),
    getBlock: async () => ({ timestamp: 1_800_000_000 }),
    getFeeData: async () => ({ maxFeePerGas: FEE_CAP, maxPriorityFeePerGas: 50_000_000n, gasPrice: FEE_CAP }),
    getBalance: async () => nativeBalance,
  };
  const signer = { provider, getAddress: async () => ADVERTISER };
  const createCampaign = async (...args) => {
    calls.purchases.push(args);
    return { hash: '0xabc', wait: async () => ({ status: 1 }) };
  };
  createCampaign.staticCall = async (...args) => { calls.simulations.push(args); };
  const contract = {
    target: CONTRACT_ADDRESS,
    campaignWeek: async () => 1n,
    quoteCampaign: async () => ({ minimumOfferUnits: OFFER, bumpedCampaignId: 0n }),
    quoteSchedulerGasTopUp: async fee => 500_000n * fee,
    createCampaign,
  };
  let currentAllowance = allowance;
  const usdc = {
    target: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: async () => 6,
    balanceOf: async () => 5_000_000n,
    allowance: async () => currentAllowance,
    approve: async (_spender, amount) => {
      calls.approvals.push(amount);
      currentAllowance = amount;
      return { wait: async () => ({ status: 1 }) };
    },
  };
  return { signer, contract, usdc, calls, readCampaigns: async () => ({ chainId: 8453, contractAddress: CONTRACT_ADDRESS, campaigns: [] }),
    setChainId: chainId => { currentChainId = chainId; } };
}

test('DeVert purchase attaches the current worker-gas top-up and keeps USDC approval exact', async () => {
  const { purchaseDevertCampaign } = await import('../js/devert-tab.mjs');
  const state = fixture();
  const hash = await purchaseDevertCampaign({ ...state, title: 'Campaign', audioURI: 'ipfs://bafy-audio',
    weeks: 1, onStep: message => state.calls.steps.push(message) });
  const expectedTopUp = 500_000n * FEE_CAP;
  assert.equal(hash, '0xabc');
  assert.deepEqual(state.calls.approvals, [5_000_000n]);
  assert.equal(state.calls.simulations[0][4].value, expectedTopUp);
  assert.equal(state.calls.simulations[0][4].maxFeePerGas, FEE_CAP);
  assert.equal(state.calls.simulations[0][4].maxPriorityFeePerGas, 50_000_000n);
  assert.equal(state.calls.purchases[0][4].value, expectedTopUp);
  assert.ok(state.calls.steps.some(message => /worker-gas top-up/.test(message)));
});

test('DeVert purchase rejects a duplicate paid term before approval, including removed campaigns', async () => {
  const { purchaseDevertCampaign } = await import('../js/devert-tab.mjs');
  for (const removed of [false, true]) {
    const state = fixture();
    state.readCampaigns = async () => ({ chainId: 8453, contractAddress: CONTRACT_ADDRESS, campaigns: [{ advertiser: ADVERTISER, audioURI: 'ipfs://bafy-audio',
      startedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 100_000).toISOString(), removed }] });
    await assert.rejects(purchaseDevertCampaign({ ...state, title: 'Campaign', audioURI: 'ipfs://bafy-audio', weeks: 1 }),
      /already has a paid campaign/);
    assert.equal(state.calls.approvals.length, 0);
    assert.equal(state.calls.purchases.length, 0);
  }
});

test('expired advert can purchase a fresh $5 campaign and availability failures never charge', async () => {
  const { purchaseDevertCampaign } = await import('../js/devert-tab.mjs');
  const state = fixture();
  state.readCampaigns = async () => ({ chainId: 8453, contractAddress: CONTRACT_ADDRESS, campaigns: [{ advertiser: ADVERTISER, audioURI: 'ipfs://bafy-audio',
    startedAt: new Date(Date.now() - 2000).toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() }] });
  await purchaseDevertCampaign({ ...state, title: 'Campaign', audioURI: 'ipfs://bafy-audio', weeks: 1 });
  assert.equal(state.calls.purchases[0][2], 5_000_000n);
  const unavailable = fixture();
  unavailable.readCampaigns = async () => { throw new Error('Campaign RPC unavailable'); };
  await assert.rejects(purchaseDevertCampaign({ ...unavailable, title: 'Campaign', audioURI: 'ipfs://bafy-audio', weeks: 1 }), /RPC unavailable/);
  assert.equal(unavailable.calls.approvals.length, 0);
});

test('campaign availability is rechecked after approval and refuses mismatched contract snapshots', async () => {
  const { purchaseDevertCampaign } = await import('../js/devert-tab.mjs');
  const state = fixture();
  let checks = 0;
  state.readCampaigns = async () => ({
    chainId: 8453, contractAddress: CONTRACT_ADDRESS,
    campaigns: ++checks === 1 ? [] : [{ advertiser: ADVERTISER, audioURI: 'ipfs://bafy-audio',
      startedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 100_000).toISOString() }],
  });
  await assert.rejects(purchaseDevertCampaign({ ...state, title: 'Campaign', audioURI: 'ipfs://bafy-audio', weeks: 1 }),
    /already has a paid campaign/);
  assert.equal(state.calls.approvals.length, 1);
  assert.equal(state.calls.purchases.length, 0);
  const wrongContract = fixture();
  wrongContract.readCampaigns = async () => ({ chainId: 8453, contractAddress: ADVERTISER, campaigns: [] });
  await assert.rejects(purchaseDevertCampaign({ ...wrongContract, title: 'Campaign', audioURI: 'ipfs://bafy-audio', weeks: 1 }),
    /configured Base contract/);
  assert.equal(wrongContract.calls.approvals.length, 0);
});

test('DeVert purchase scales the worker-gas top-up with campaign duration', async () => {
  const { purchaseDevertCampaign } = await import('../js/devert-tab.mjs');
  const state = fixture({ nativeBalance: 5_000_000_000_000_000n });
  state.usdc.balanceOf = async () => 20_000_000n;
  await purchaseDevertCampaign({ ...state, title: 'Campaign', audioURI: 'ipfs://bafy-audio', weeks: 3 });
  assert.equal(state.calls.purchases[0][4].value, 3n * 500_000n * FEE_CAP);
});

test('DeVert purchase rejects insufficient top-up ETH before prompting for USDC approval', async () => {
  const { purchaseDevertCampaign } = await import('../js/devert-tab.mjs');
  const topUp = 500_000n * FEE_CAP;
  const state = fixture({ nativeBalance: topUp - 1n });
  await assert.rejects(purchaseDevertCampaign({ ...state, title: 'Campaign', audioURI: 'ipfs://bafy-audio',
    weeks: 1 }), /Insufficient Base ETH for the scheduler top-up/);
  assert.deepEqual(state.calls.approvals, []);
  assert.deepEqual(state.calls.purchases, []);
});

test('DeVert purchase uses the legacy gasPrice quote when maxFeePerGas is unavailable', async () => {
  const { purchaseDevertCampaign } = await import('../js/devert-tab.mjs');
  const state = fixture({ allowance: 5_000_000n });
  state.signer.provider.getFeeData = async () => ({ gasPrice: 1_000_000_000n });
  await purchaseDevertCampaign({ ...state, title: 'Campaign', audioURI: 'ipfs://bafy-audio',
    weeks: 1 });
  assert.equal(state.calls.purchases[0][4].value, 500_000_000_000_000n);
  assert.equal(state.calls.purchases[0][4].gasPrice, 1_000_000_000n);
});

test('DeVert purchase switches the wallet to Base and waits for allowance confirmation before creating the campaign', async () => {
  const { purchaseDevertCampaign } = await import('../js/devert-tab.mjs');
  const state = fixture();
  state.setChainId(1n);
  let allowanceReads = 0;
  let allowance = 0n;
  state.usdc.allowance = async () => {
    allowanceReads++;
    return allowanceReads >= 3 ? allowance : 0n;
  };
  state.usdc.approve = async (spender, amount) => {
    state.calls.approvals.push(amount);
    allowance = amount;
    return { wait: async () => ({ status: 1 }) };
  };
  const requests = [];
  const previousWindow = global.window;
  global.window = { ethereum: { request: async ({ method, params }) => {
    requests.push([method, params]);
    if (method === 'wallet_switchEthereumChain') state.setChainId(8453n);
  } } };
  try {
    const hash = await purchaseDevertCampaign({ ...state, title: 'Campaign', audioURI: 'ipfs://bafy-audio', weeks: 1 });
    assert.equal(hash, '0xabc');
    assert.equal(requests[0][0], 'wallet_switchEthereumChain');
    assert.equal(allowanceReads >= 3, true);
    assert.deepEqual(state.calls.approvals, [5_000_000n]);
    assert.deepEqual(state.calls.simulations[0][4].value, 500_000n * FEE_CAP);
  } finally {
    global.window = previousWindow;
  }
});

test('Ads Only mirrors only an audible live AdLoop state and its radio play position', async () => {
  const { normalizeAdLoopNowPlaying } = await import('../js/devert-tab.mjs');
  const state = { ready: true, nowPlaying: { campaignId: '9', radioPlayId: 'adloop:9:1',
    title: 'Campaign 9', ipfsCid: 'bafy-nine', mediaType: 'audio/mp4', audible: true, positionMs: 42_000 } };
  assert.deepEqual(normalizeAdLoopNowPlaying(state), {
    playId: 'adloop:9:1', title: 'Campaign 9', ipfsCid: 'bafy-nine', mediaType: 'audio/mp4', videoUrl: '',
    positionMs: 42_000,
  });
  assert.equal(normalizeAdLoopNowPlaying({ ...state, ready: false }), null);
  assert.equal(normalizeAdLoopNowPlaying({ ...state, nowPlaying: { ...state.nowPlaying, audible: false } }), null);
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.match(html, /Vote on current VertLoop ad/);
});
