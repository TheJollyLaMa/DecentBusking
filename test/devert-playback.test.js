const test = require('node:test');
const assert = require('node:assert/strict');
const { id } = require('node:module').createRequire(require('node:path').join(__dirname, '../discord-bot/package.json'))('ethers');

const NOW = 1_800_000_000_000;
const WEEK_ID = Math.floor(NOW / (7 * 24 * 60 * 60 * 1000));
const address = value => `0x${value.repeat(40)}`;

function campaign(campaignId, overrides = {}) {
  return { campaignId, advertiser: address('1'), title: `Campaign ${campaignId}`, audioURI: `ipfs://bafy-${campaignId}`,
    startedAt: new Date(NOW - 60_000).toISOString(), expiresAt: new Date(NOW + 7 * 86400000 - 60_000).toISOString(),
    weekId: WEEK_ID, offerUnits: '5000000', paidUnits: '5000000', djukeBoosts: 0, mainRadioPlays: 0, devertPlays: 0, ...overrides };
}

function harness({ campaigns = [], slots = 0, impressions = 0, failImpression = false, failMusic = false, save = async () => 'ipfs://journal' } = {}) {
  const recorded = new Set();
  const musicBatches = [];
  const impressionCalls = [];
  const contract = {
    target: address('2'), runner: { provider: { getBlock: async () => ({ timestamp: NOW / 1000 }) } },
    campaignWeek: async () => BigInt(WEEK_ID),
    usedImpressionIds: async impressionId => recorded.has(impressionId),
    reportCompletedMusicPlays: async playIds => {
      if (failMusic) throw new Error('temporary music RPC failure');
      musicBatches.push(playIds);
      return { wait: async () => ({ status: 1 }) };
    },
    recordCampaignPlay: async (campaignId, mainRadio, impressionId) => {
      impressionCalls.push({ campaignId: String(campaignId), mainRadio, impressionId });
      if (failImpression) throw new Error('temporary RPC failure');
      recorded.add(impressionId);
      return { wait: async () => ({ status: 1 }) };
    },
  };
  contract.reportCompletedMusicPlays.staticCall = async () => {};
  contract.recordCampaignPlay.staticCall = async () => {};
  const state = { schemaVersion: 1, musicWeekId: null, pendingMusicPlayIds: [], seenMusicPlayIds: [], impressions: [] };
  let saves = 0;
  const runtime = null;
  return { contract, recorded, musicBatches, impressionCalls, state, get saves() { return saves; },
    setSave(fn) { save = fn; }, save: async snapshot => { saves++; await save(snapshot); Object.assign(state, snapshot); return 'ipfs://journal'; },
    readCampaigns: async () => ({ chainId: 8453, snapshotAt: new Date(NOW).toISOString(), weekId: WEEK_ID,
      campaigns, market: { slots, seated: Math.min(slots, campaigns.length), lowestSeatedOfferUnits: campaigns[0]?.offerUnits || '0', mainRadioImpressions: impressions } }),
    unused: runtime };
}

async function makeRuntime(fixture) {
  const { createDevertPlaybackRuntime } = await import('../discord-bot/devert-playback.js');
  const runtime = createDevertPlaybackRuntime({ contract: fixture.contract, provider: fixture.contract.runner.provider,
    restore: async () => fixture.state.schemaVersion === 1 ? structuredClone(fixture.state) : null,
    save: fixture.save, readCampaigns: fixture.readCampaigns, now: () => NOW });
  await runtime.initialize();
  return runtime;
}

test('DeVert music milestone journal batches ten audible unique plays and retries safely', async () => {
  const fixture = harness();
  const runtime = await makeRuntime(fixture);
  for (let index = 0; index < 9; index++) {
    assert.equal(await runtime.recordCompletedMusicPlay({ playId: id(`song-${index}`), audibleMs: 30_000 }), true);
  }
  assert.equal(fixture.musicBatches.length, 0);
  assert.equal(fixture.state.pendingMusicPlayIds.length, 9);
  await runtime.recordCompletedMusicPlay({ playId: id('song-9'), audibleMs: 30_000 });
  assert.deepEqual(fixture.musicBatches, [[...Array.from({ length: 10 }, (_, index) => id(id(`song-${index}`)))] ]);
  assert.equal(fixture.state.pendingMusicPlayIds.length, 0);
  assert.equal(await runtime.recordCompletedMusicPlay({ playId: id('song-9'), audibleMs: 30_000 }), false);
  assert.equal(await runtime.recordCompletedMusicPlay({ playId: id('short'), audibleMs: 29_999 }), false);
});

test('DeVert flushes a complete music milestone from the durable journal after restart', async () => {
  const fixture = harness({ failMusic: true });
  const firstRun = await makeRuntime(fixture);
  for (let index = 0; index < 9; index++) await firstRun.recordCompletedMusicPlay({ playId: id(`restart-song-${index}`), audibleMs: 30_000 });
  await assert.rejects(firstRun.recordCompletedMusicPlay({ playId: id('restart-song-9'), audibleMs: 30_000 }), /temporary music RPC/);
  assert.equal(fixture.state.pendingMusicPlayIds.length, 10);
  fixture.contract.reportCompletedMusicPlays = async playIds => {
    fixture.musicBatches.push(playIds);
    return { wait: async () => ({ status: 1 }) };
  };
  fixture.contract.reportCompletedMusicPlays.staticCall = async () => {};
  await makeRuntime(fixture);
  assert.equal(fixture.musicBatches.length, 1);
  assert.equal(fixture.state.pendingMusicPlayIds.length, 0);
});

test('DeVert impression is checkpointed before its chain write and retry uses the same idempotency key', async () => {
  const fixture = harness({ failImpression: true });
  const runtime = await makeRuntime(fixture);
  await assert.rejects(runtime.recordCampaignImpression({ campaignId: '7', radioPlayId: 'radio-play-1', mainRadio: true, audibleMs: 30_000 }), /temporary RPC/);
  const pending = fixture.state.impressions[0];
  assert.equal(pending.state, 'pending');
  assert.equal(fixture.impressionCalls[0].impressionId, pending.impressionId);
  fixture.contract.recordCampaignPlay = async (campaignId, mainRadio, impressionId) => {
    fixture.impressionCalls.push({ campaignId: String(campaignId), mainRadio, impressionId });
    fixture.recorded.add(impressionId);
    return { wait: async () => ({ status: 1 }) };
  };
  fixture.contract.recordCampaignPlay.staticCall = async () => {};
  const retry = await makeRuntime(fixture);
  assert.equal(retry.getState().impressions[0].state, 'recorded');
  assert.equal(fixture.impressionCalls[1].impressionId, pending.impressionId);
});

test('DeVert uses only the main-radio queue and advances by confirmed impressions', async () => {
  const campaigns = [campaign('low', { offerUnits: '5000000', devertPlays: 0 }),
    campaign('high', { offerUnits: '8000000', devertPlays: 4 })];
  const fixture = harness({ campaigns, slots: 2, impressions: 0 });
  const runtime = await makeRuntime(fixture);
  const main = await runtime.nextMainRadioAd();
  assert.equal(main.track.trackId, 'devert:high');
  assert.equal(main.mainRadio, true);
  campaigns.find(item => item.campaignId === 'high').mainRadioPlays = 1;
  const afterOne = harness({ campaigns, slots: 2, impressions: 1 });
  const next = await makeRuntime(afterOne);
  assert.equal((await next.nextMainRadioAd()).track.trackId, 'devert:low');
});

test('main-radio listener votes are durable and reorder only seated campaigns', async () => {
  const campaigns = [campaign('1', { offerUnits: '8000000' }), campaign('2', { offerUnits: '7000000' }),
    campaign('3', { offerUnits: '5000000' })];
  const fixture = harness({ campaigns, slots: 2 });
  const runtime = await makeRuntime(fixture);
  const voteA = { campaignId: '1', radioPlayId: 'devert:1:play-1', voterId: 'listener-browser-0001', vote: -1 };
  const voteB = { campaignId: '2', radioPlayId: 'devert:2:play-1', voterId: 'listener-browser-0002', vote: 1 };
  assert.equal((await runtime.recordMainRadioAdVote(voteA)).duplicate, false);
  assert.equal((await runtime.recordMainRadioAdVote(voteB)).duplicate, false);
  assert.equal((await runtime.recordMainRadioAdVote(voteB)).duplicate, true);
  assert.equal(fixture.state.adVotes.length, 2);
  assert.equal((await runtime.nextMainRadioAd()).track.trackId, 'devert:2');
  assert.ok(fixture.state.adVotes.every(entry => entry.campaignId !== '3'));
});

test('AdLoop queue includes active unseated campaigns and ranks DJuke boosts before prior loop plays', async () => {
  const campaigns = [campaign('low', { offerUnits: '5000000', devertPlays: 0 }),
    campaign('boosted', { offerUnits: '5000000', djukeBoosts: 1, devertPlays: 4 }),
    campaign('expired', { expiresAt: new Date(NOW - 1).toISOString() })];
  const fixture = harness({ campaigns, slots: 0, impressions: 0 });
  const runtime = await makeRuntime(fixture);
  const first = await runtime.nextDevertLoopAd();
  assert.equal(first.track.trackId, 'devert:boosted');
  assert.equal(first.mainRadio, false);
  const second = await runtime.nextDevertLoopAd({ excludeCampaignIds: ['boosted'] });
  assert.equal(second.track.trackId, 'devert:low');
});
