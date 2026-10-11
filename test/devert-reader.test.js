const test = require('node:test');
const assert = require('node:assert/strict');

const BLOCK_NUMBER = 99;
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const TIMESTAMP = 1_800_000_000;
const WEEK_ID = Math.floor(TIMESTAMP / (7 * 24 * 60 * 60));

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
      return { slots: 4n, seated: 2n, lowestSeatedOfferUnits: 6_000_000n };
    },
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
  assert.equal(snapshot.campaigns[0].campaignId, '7');
  assert.equal(snapshot.campaigns[0].offerUnits, '5000000');
  assert.equal(snapshot.campaigns[0].startedAt, new Date((TIMESTAMP - 60) * 1000).toISOString());
  assert.deepEqual(snapshot.market, { slots: 4, seated: 2, lowestSeatedOfferUnits: '6000000' });
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
