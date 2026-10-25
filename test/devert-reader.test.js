const test = require('node:test');
const assert = require('node:assert/strict');

const BLOCK_NUMBER = 99;
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const TIMESTAMP = 1_800_000_000;
const WEEK_ID = Math.floor(TIMESTAMP / (7 * 24 * 60 * 60));

test('DeVert scheduler reuses the DJuke worker key unless an explicit scheduler key is configured', async () => {
  const { resolveDevertSchedulerPrivateKey } = await import('../discord-bot/devert.js');
  assert.equal(resolveDevertSchedulerPrivateKey({ DJUKE_FULFILLER_PRIVATE_KEY: 'worker-key' }), 'worker-key');
  assert.equal(resolveDevertSchedulerPrivateKey({ DEVERT_SCHEDULER_PRIVATE_KEY: 'devert-key',
    DJUKE_FULFILLER_PRIVATE_KEY: 'worker-key' }), 'devert-key');
  assert.equal(resolveDevertSchedulerPrivateKey({}), null);
});

test('DeVert applies one confirmed DJuke request to its advertiser’s sole active campaign once', async () => {
  const { applyDevertDjukeBoosts } = await import('../discord-bot/devert.js');
  const advertiser = `0x${'11'.repeat(20)}`;
  const used = new Set();
  const calls = [];
  const contract = {
    usedDjukeRequests: async requestId => used.has(String(requestId)),
    applyDJukeBoost: async (campaignId, requestId) => {
      calls.push([campaignId, requestId]);
      used.add(String(requestId));
      return { wait: async () => ({ status: 1 }) };
    },
  };
  contract.applyDJukeBoost.staticCall = async () => {};
  const readCampaigns = async () => ({ chainId: 8453, paused: false, campaigns: [{ campaignId: '7', advertiser,
    startedAt: new Date(TIMESTAMP - 60_000).toISOString(), expiresAt: new Date(TIMESTAMP + 60_000).toISOString() }] });
  const readDjukeState = async () => ({ requests: [{ chainRequestId: '33', payer: advertiser, amountUnits: '250000' }] });
  const options = { contract, readCampaigns, readDjukeState, now: () => TIMESTAMP };
  assert.equal(await applyDevertDjukeBoosts(options), 1);
  assert.deepEqual(calls, [[7n, 33n]]);
  assert.equal(await applyDevertDjukeBoosts(options), 0);
  assert.deepEqual(calls, [[7n, 33n]]);
});

test('DeVert leaves DJuke boosts unapplied when the payer has multiple active campaigns', async () => {
  const { applyDevertDjukeBoosts } = await import('../discord-bot/devert.js');
  const advertiser = `0x${'11'.repeat(20)}`;
  let calls = 0;
  const contract = { usedDjukeRequests: async () => false, applyDJukeBoost: async () => { calls++; } };
  contract.applyDJukeBoost.staticCall = async () => {};
  const warnings = [];
  const campaigns = ['7', '8'].map(campaignId => ({ campaignId, advertiser,
    startedAt: new Date(TIMESTAMP - 60_000).toISOString(), expiresAt: new Date(TIMESTAMP + 60_000).toISOString() }));
  const result = await applyDevertDjukeBoosts({ contract, readCampaigns: async () => ({ chainId: 8453, paused: false, campaigns }),
    readDjukeState: async () => ({ requests: [{ chainRequestId: '33', payer: advertiser, amountUnits: '250000' }] }),
    now: () => TIMESTAMP, log: { warn: message => warnings.push(message), log() {} } });
  assert.equal(result, 0);
  assert.equal(calls, 0);
  assert.match(warnings[0], /multiple active campaigns/);
});

function fakeProvider({ chainId = 8453, blockHashes = [BLOCK_HASH, BLOCK_HASH] } = {}) {
  let reads = 0;
  return {
    getNetwork: async () => ({ chainId: BigInt(chainId) }),
    getBlockNumber: async () => BLOCK_NUMBER + 1,
    getBlock: async number => {
      assert.equal(number, BLOCK_NUMBER);
      return { number, hash: blockHashes[Math.min(reads++, blockHashes.length - 1)], timestamp: TIMESTAMP };
    },
  };
}

function campaign(overrides = {}) {
  return {
    advertiser: `0x${'11'.repeat(20)}`,
    title: 'Artist announcement',
    audioURI: 'ipfs://bafy-advert-audio',
    startedAt: BigInt(TIMESTAMP - 60),
    expiresAt: BigInt(TIMESTAMP - 60 + 7 * 24 * 60 * 60),
    weekId: BigInt(WEEK_ID),
    offerUnits: 5_000_000n,
    paidUnits: 5_000_000n,
    djukeBoosts: 0n,
    mainRadioPlays: 1n,
    devertPlays: 0n,
    ...overrides,
  };
}

function fakeContract({ record = campaign() } = {}) {
  return {
    campaignWeek: async timestamp => BigInt(Math.floor(Number(timestamp) / (7 * 24 * 60 * 60))),
    getWeekCampaignIds: async (weekId, options) => {
      assert.equal(Number(weekId), WEEK_ID);
      assert.equal(options.blockTag, BLOCK_NUMBER);
      return [7n];
    },
    getCampaign: async (campaignId, options) => {
      assert.equal(campaignId, 7n);
      assert.equal(options.blockTag, BLOCK_NUMBER);
      return record;
    },
    mainRadioMarket: async (weekId, options) => {
      assert.equal(Number(weekId), WEEK_ID);
      assert.equal(options.blockTag, BLOCK_NUMBER);
      return { slots: 4n, seated: 2n, lowestSeatedOfferUnits: 6_000_000n, mainRadioImpressions: 1n };
    },
    paused: async () => false,
  };
}

test('DeVert reader returns a canonical confirmed Base campaign snapshot', async () => {
  const { createDevertCampaignReader } = await import('../discord-bot/devert.js');
  const read = createDevertCampaignReader({
    contractAddress: `0x${'22'.repeat(20)}`,
    provider: fakeProvider(),
    contract: fakeContract(),
  });
  const snapshot = await read();
  assert.equal(snapshot.chainId, 8453);
  assert.equal(snapshot.blockNumber, BLOCK_NUMBER);
  assert.equal(snapshot.blockHash, BLOCK_HASH);
  assert.equal(snapshot.weekId, WEEK_ID);
  assert.equal(snapshot.paused, false);
  assert.equal(snapshot.campaigns[0].campaignId, '7');
  assert.equal(snapshot.campaigns[0].offerUnits, '5000000');
  assert.equal(snapshot.campaigns[0].startedAt, new Date((TIMESTAMP - 60) * 1000).toISOString());
  assert.deepEqual(snapshot.market, { slots: 4, seated: 2, lowestSeatedOfferUnits: '6000000', mainRadioImpressions: 1 });
});

test('DeVert reader includes a still-active campaign indexed from the previous week', async () => {
  const { createDevertCampaignReader } = await import('../discord-bot/devert.js');
  const previousWeekCampaign = fakeContract({ record: campaign({ weekId: BigInt(WEEK_ID - 1) }) });
  const read = createDevertCampaignReader({
    contractAddress: `0x${'22'.repeat(20)}`,
    provider: fakeProvider(),
    contract: previousWeekCampaign,
  });
  const snapshot = await read();
  assert.equal(snapshot.weekId, WEEK_ID);
  assert.equal(snapshot.campaigns[0].weekId, WEEK_ID - 1);
});

test('sponsored campaign snapshots verify contract version and gate checkout on platform ETH', async () => {
  const { createDevertCampaignReader } = await import('../discord-bot/devert.js');
  for (const balance of [999_999_999_999_999n, 1_000_000_000_000_000n]) {
    const provider = fakeProvider();
    provider.getBalance = async address => {
      assert.equal(address, `0x${'33'.repeat(20)}`);
      return balance;
    };
    const contract = { ...fakeContract(), CONTRACT_VERSION: async () => '0.2',
      schedulerWallet: async () => `0x${'33'.repeat(20)}` };
    const read = createDevertCampaignReader({ contractAddress: `0x${'22'.repeat(20)}`,
      provider, contract, version: '0.2' });
    const result = await read();
    assert.equal(result.version, '0.2');
    assert.equal(result.workerFunding.available, balance >= 1_000_000_000_000_000n);
    assert.equal(result.workerFunding.balanceWei, balance.toString());
    contract.CONTRACT_VERSION = async () => '0.1';
    await assert.rejects(read(), /version mismatch/);
    contract.CONTRACT_VERSION = async () => '0.2';
    provider.getBalance = async () => { throw new Error('RPC unavailable'); };
    await assert.rejects(read(), /RPC unavailable/);
  }
});

test('DeVert reader rejects wrong-chain and reorged snapshots', async () => {
  const { createDevertCampaignReader } = await import('../discord-bot/devert.js');
  const wrongChain = createDevertCampaignReader({
    contractAddress: `0x${'22'.repeat(20)}`,
    provider: fakeProvider({ chainId: 1 }),
    contract: fakeContract(),
  });
  await assert.rejects(wrongChain(), /Base-only/);

  const reorged = createDevertCampaignReader({
    contractAddress: `0x${'22'.repeat(20)}`,
    provider: fakeProvider({ blockHashes: [BLOCK_HASH, `0x${'cd'.repeat(32)}`] }),
    contract: fakeContract(),
  });
  await assert.rejects(reorged(), /canonical/);
});

test('DeVert reader refuses malformed campaign media and incomplete campaign reads', async () => {
  const { createDevertCampaignReader } = await import('../discord-bot/devert.js');
  const makeReader = record => createDevertCampaignReader({
    contractAddress: `0x${'22'.repeat(20)}`,
    provider: fakeProvider(),
    contract: fakeContract({ record }),
  });
  await assert.rejects(makeReader(campaign({ audioURI: 'https://example.invalid/ad.mp3' }))(), /Invalid DeVert campaign/);
  await assert.rejects(makeReader(null)(), /Invalid DeVert campaign/);
});
