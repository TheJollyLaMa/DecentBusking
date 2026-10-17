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

test('DeVert scheduler restore retries transient failures with capped exponential backoff', async () => {
  const { initializeDevertPlaybackWithRetry } = await import('../discord-bot/devert-playback.js');
  const delays = [];
  let attempts = 0;
  const result = await initializeDevertPlaybackWithRetry({
    initialize: async () => {
      attempts++;
      if (attempts < 4) throw new Error('Pinata 429');
      return 'ready';
    },
    wait: async delay => delays.push(delay),
    log: { warn() {} },
  });
  assert.equal(result, 'ready');
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [5_000, 10_000, 20_000]);
});

function harness({
  campaigns = [],
  slots = 0,
  impressions = 0,
  failImpression = false,
  failMusic = false,
  balance = 1_000_000_000_000_000_000n,
  workerAddress = address('3'),
  workerMinBalanceWei = 0n,
  save = async () => 'ipfs://journal',
  resolveCampaignMedia = () => null,
} = {}) {
  const recorded = new Set();
  const musicBatches = [];
  const impressionCalls = [];
  const contract = {
    target: address('2'), runner: { provider: {
      getBlock: async () => ({ timestamp: NOW / 1000 }),
      getNetwork: async () => ({ chainId: 8453n }),
      getBalance: async () => balance,
    } },
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
  return { contract, recorded, musicBatches, impressionCalls, state, resolveCampaignMedia, get saves() { return saves; },
    workerAddress, workerMinBalanceWei, setBalance(next) { balance = next; }, setSave(fn) { save = fn; }, save: async snapshot => { saves++; await save(snapshot); Object.assign(state, snapshot); return 'ipfs://journal'; },
    readCampaigns: async () => ({ chainId: 8453, snapshotAt: new Date(NOW).toISOString(), weekId: WEEK_ID,
      campaigns, market: { slots, seated: Math.min(slots, campaigns.length), lowestSeatedOfferUnits: campaigns[0]?.offerUnits || '0', mainRadioImpressions: impressions } }),
    unused: runtime };
}

async function makeRuntime(fixture) {
  const { createDevertPlaybackRuntime } = await import('../discord-bot/devert-playback.js');
  const runtime = createDevertPlaybackRuntime({ contract: fixture.contract, provider: fixture.contract.runner.provider,
    restore: async () => fixture.state.schemaVersion === 1 ? structuredClone(fixture.state) : null,
    save: fixture.save, readCampaigns: fixture.readCampaigns, now: () => fixture.now ?? NOW, resolveCampaignMedia: fixture.resolveCampaignMedia,
    workerAddress: fixture.workerAddress, workerMinBalanceWei: fixture.workerMinBalanceWei });
  await runtime.initialize();
  return runtime;
}

test('removed campaigns stay out of both radio selections without changing on-chain paid terms', async () => {
  const removed = campaign('1', { removed: true });
  const available = campaign('2');
  const fixture = harness({ campaigns: [removed, available], slots: 10 });
  const runtime = await makeRuntime(fixture);
  assert.equal((await runtime.nextMainRadioAd()).campaignId, '2');
  assert.equal((await runtime.nextDevertLoopAd()).campaignId, '2');
  assert.equal(removed.expiresAt, campaign('1').expiresAt);
  assert.equal(await runtime.canPlayCampaign('1'), false);
  assert.equal(await runtime.canPlayCampaign('2'), true);
  assert.equal(await runtime.canPlayCampaign('missing'), false);
});

test('removing a seated campaign does not grant its on-chain seat to an overflow campaign', async () => {
  const fixture = harness({ campaigns: [campaign('1', { removed: true, offerUnits: '10000000' }), campaign('2')], slots: 1 });
  const runtime = await makeRuntime(fixture);
  assert.equal(await runtime.nextMainRadioAd(), null);
  assert.equal((await runtime.nextDevertLoopAd()).campaignId, '2');
});

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

test('DeVert defers worker-gas-spent reports below threshold and retries after funding', async () => {
  const fixture = harness({ balance: 0n, workerMinBalanceWei: 1n });
  const runtime = await makeRuntime(fixture);
  for (let index = 0; index < 10; index++) {
    assert.equal(await runtime.recordCompletedMusicPlay({ playId: id(`low-gas-song-${index}`), audibleMs: 30_000 }), true);
  }
  assert.equal(fixture.musicBatches.length, 0);
  assert.equal(fixture.state.pendingMusicPlayIds.length, 10);
  fixture.setBalance(2n);
  assert.equal(await runtime.recordCompletedMusicPlay({ playId: id('low-gas-song-10'), audibleMs: 30_000 }), true);
  assert.equal(fixture.musicBatches.length, 1);
  assert.equal(fixture.musicBatches[0].length, 10);
  assert.equal(fixture.state.pendingMusicPlayIds.length, 1);
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

test('a pending main-radio slot rejection does not block restore, VertLoop, or the next music milestone', async () => {
  const fixture = harness({ campaigns: [campaign('1')], slots: 1, impressions: 1 });
  const pendingId = id('pending-main-radio');
  fixture.state.impressions = [{ impressionId: pendingId, campaignId: '1', mainRadio: true,
    radioPlayId: 'pending-main-radio', recordedAt: new Date(NOW - 1000).toISOString(), state: 'pending' }];
  let attempts = 0;
  let slotAvailable = false;
  fixture.contract.recordCampaignPlay.staticCall = async (_campaignId, mainRadio) => {
    if (!mainRadio) return;
    attempts++;
    if (!slotAvailable) throw Object.assign(new Error('execution reverted'), {
      code: 'CALL_EXCEPTION', reason: 'No seated main-radio slot',
    });
  };
  const runtime = await makeRuntime(fixture);
  assert.equal(attempts, 1);
  assert.equal(fixture.state.impressions[0].state, 'pending');
  assert.equal(fixture.state.impressions[0].nextRetryAt, NOW + 60_000);
  assert.equal(await runtime.nextMainRadioAd(), null);
  assert.equal((await runtime.nextDevertLoopAd()).campaignId, '1');
  await runtime.recordCampaignImpression({ campaignId: '1', radioPlayId: 'new-loop', mainRadio: false, audibleMs: 30_000 });
  assert.equal(fixture.state.impressions.find(entry => !entry.mainRadio).state, 'recorded');
  assert.equal(fixture.state.impressions.find(entry => entry.mainRadio).nextRetryAt, NOW + 60_000,
    'VertLoop hourly throttling must not postpone main-radio reporting');
  await makeRuntime(fixture);
  assert.equal(attempts, 1, 'persisted cooldown survives restart');
  for (let index = 0; index < 10; index++) {
    await runtime.recordCompletedMusicPlay({ playId: id(`unblocked-song-${index}`), audibleMs: 30_000 });
  }
  assert.equal(fixture.musicBatches.length, 1, 'music reporting can unlock another main-radio slot');
  assert.equal(fixture.recorded.has(pendingId), false, 'unconfirmed receipts are never counted as confirmed impressions');
  slotAvailable = true;
  fixture.now = NOW + 60_000;
  await runtime.nextDevertLoopAd();
  assert.equal(attempts, 2);
  assert.equal(fixture.state.impressions.find(entry => entry.impressionId === pendingId).state, 'recorded');
  assert.equal(fixture.impressionCalls.filter(entry => entry.mainRadio).length, 1);
  assert.equal(fixture.impressionCalls.find(entry => entry.mainRadio).impressionId, pendingId);
});

test('unexpected main-radio reverts still surface rather than being classified as slot cooldowns', async () => {
  const fixture = harness();
  const runtime = await makeRuntime(fixture);
  fixture.contract.recordCampaignPlay.staticCall = async () => {
    throw Object.assign(new Error('unexpected contract failure'), { code: 'CALL_EXCEPTION', reason: 'Access denied' });
  };
  await assert.rejects(runtime.recordCampaignImpression({
    campaignId: '1', radioPlayId: 'unexpected-revert', mainRadio: true, audibleMs: 30_000,
  }), /unexpected contract failure/);
  assert.equal(fixture.state.impressions[0].nextRetryAt, 0);
});

test('DeVert coalesces VertLoop impressions to one on-chain record per campaign per hour', async () => {
  const fixture = harness({
    balance: 10n,
    workerMinBalanceWei: 1n,
    campaigns: [campaign('17', { offerUnits: '5000000', devertPlays: 0 })],
    slots: 0,
  });
  const runtime = await makeRuntime(fixture);
  assert.equal(await runtime.recordCampaignImpression({ campaignId: '17', radioPlayId: 'loop-1', mainRadio: false, audibleMs: 30_000 }), true);
  for (let loop = 2; loop <= 30; loop++) {
    assert.equal(await runtime.recordCampaignImpression({ campaignId: '17', radioPlayId: `loop-${loop}`, mainRadio: false, audibleMs: 30_000 }), false);
  }
  assert.equal(fixture.impressionCalls.length, 1);
  assert.equal(fixture.state.impressions.length, 1);
  fixture.now = NOW + 60 * 60_000;
  assert.equal(await runtime.recordCampaignImpression({ campaignId: '17', radioPlayId: 'loop-next-hour', mainRadio: false, audibleMs: 30_000 }), true);
  assert.equal(fixture.impressionCalls.length, 2);
  assert.ok(fixture.state.impressions.every(entry => entry.state === 'recorded'));
});

test('main-radio impressions are never throttled by the VertLoop window', async () => {
  const fixture = harness();
  const runtime = await makeRuntime(fixture);
  await runtime.recordCampaignImpression({ campaignId: '17', radioPlayId: 'loop-1', mainRadio: false, audibleMs: 30_000 });
  await runtime.recordCampaignImpression({ campaignId: '17', radioPlayId: 'main-1', mainRadio: true, audibleMs: 30_000 });
  await runtime.recordCampaignImpression({ campaignId: '17', radioPlayId: 'main-2', mainRadio: true, audibleMs: 30_000 });
  assert.deepEqual(fixture.impressionCalls.map(call => call.mainRadio), [false, true, true]);
});

test('DeVert ad tracks carry the verified advertiser address into playback state', async () => {
  const fixture = harness({
    campaigns: [campaign('42', { advertiser: address('4') })],
    slots: 1,
  });
  const runtime = await makeRuntime(fixture);
  const next = await runtime.nextMainRadioAd();
  assert.equal(next.track.advertiser, address('4'));
  assert.equal(next.campaignId, '42');
});

test('restoring a legacy VertLoop backlog keeps one pending entry per campaign and every main-radio entry', async () => {
  const fixture = harness({ balance: 0n, workerMinBalanceWei: 1n });
  const pending = (key, campaignId, mainRadio) => ({ impressionId: id(key), campaignId, mainRadio, radioPlayId: key,
    recordedAt: new Date(NOW - 1000).toISOString(), state: 'pending' });
  fixture.state.impressions = [pending('a1', '1', false), pending('a2', '1', false), pending('b1', '2', false),
    pending('m1', '1', true), pending('m2', '1', true), pending('a3', '1', false)];
  const runtime = await makeRuntime(fixture);
  assert.deepEqual(runtime.getState().impressions.map(entry => entry.radioPlayId), ['a1', 'b1', 'm1', 'm2']);
});

test('a node-reported insufficient-funds failure stays deferred until the worker balance rises', async () => {
  let balance = 5_000n;
  const fixture = harness({ workerMinBalanceWei: 1n });
  fixture.contract.runner.provider.getBalance = async () => balance;
  let failing = true;
  fixture.contract.recordCampaignPlay = async (campaignId, mainRadio, impressionId) => {
    fixture.impressionCalls.push({ campaignId: String(campaignId), mainRadio, impressionId });
    if (failing) throw Object.assign(new Error('insufficient funds for gas * price + value'), { code: 'INSUFFICIENT_FUNDS' });
    fixture.recorded.add(impressionId);
    return { wait: async () => ({ status: 1 }) };
  };
  fixture.contract.recordCampaignPlay.staticCall = async () => {};
  const runtime = await makeRuntime(fixture);
  assert.equal(await runtime.recordCampaignImpression({ campaignId: '9', radioPlayId: 'main-1', mainRadio: true, audibleMs: 30_000 }), true);
  assert.equal(fixture.impressionCalls.length, 1);
  assert.equal((await runtime.getWorkerGasState()).lowBalance, true);
  fixture.now = NOW + 5 * 60_000;
  assert.equal((await runtime.getWorkerGasState()).lowBalance, true, 'balance above threshold but unchanged must stay latched');
  await runtime.recordCampaignImpression({ campaignId: '9', radioPlayId: 'main-2', mainRadio: true, audibleMs: 30_000 });
  assert.equal(fixture.impressionCalls.length, 1, 'no RPC hammering while latched');
  failing = false;
  balance = 10n ** 15n;
  fixture.now = NOW + 10 * 60_000;
  assert.equal((await runtime.getWorkerGasState()).lowBalance, false);
  await runtime.nextMainRadioAd();
  assert.ok(runtime.getState().impressions.every(entry => entry.state === 'recorded'));
});

test('DeVert uses only the main-radio queue and advances by confirmed impressions', async () => {
  const campaigns = [campaign('low', { offerUnits: '5000000', devertPlays: 0 }),
    campaign('high', { offerUnits: '8000000', devertPlays: 4 })];
  const fixture = harness({ campaigns, slots: 2, impressions: 0 });
  const runtime = await makeRuntime(fixture);
  const main = await runtime.nextMainRadioAd();
  assert.equal(main.track.trackId, 'devert:high');
  assert.equal(main.mainRadio, true);
  assert.deepEqual((await runtime.nextMainRadioAd({ count: 2 })).map(ad => ad.track.trackId), ['devert:high', 'devert:low']);
  campaigns.find(item => item.campaignId === 'high').mainRadioPlays = 1;
  const afterOne = harness({ campaigns, slots: 2, impressions: 1 });
  const next = await makeRuntime(afterOne);
  assert.equal((await next.nextMainRadioAd()).track.trackId, 'devert:low');
});

test('DeVert main-radio video ads preserve a video source and mime type when metadata is sparse', async () => {
  const campaigns = [campaign('video', { audioURI: 'ipfs://bafy-video', offerUnits: '8000000' })];
  const fixture = harness({
    campaigns,
    slots: 2,
    resolveCampaignMedia: () => ({ videoUrl: 'ipfs://bafy-video', mediaType: '', filename: '' }),
  });
  const runtime = await makeRuntime(fixture);
  const ad = await runtime.nextMainRadioAd();
  assert.equal(ad.track.mediaType, 'video/mp4');
  assert.equal(ad.track.videoUrl, 'ipfs://bafy-video');
  assert.match(ad.track.filename, /\.mp4$/);
});

test('DeVert main-radio and VertLoop recover catalog video when the playlist has no advert', async () => {
  const { resolveDevertCampaignMedia } = await import('../discord-bot/mint-sync.js');
  const cid = 'bafybeiafj7ws74dbx5qvoci6tfyaxopzi5bgsqo6i2qwp3el3bpommsdim';
  const campaigns = [campaign('1', { audioURI: `ipfs://${cid}` })];
  const nfts = [{ name: 'DecentAdvert0001', artist: address('1'),
    audioUrl: `ipfs://${cid}`, mediaType: 'video/mp4', videoUrl: `ipfs://${cid}` }];
  const fixture = harness({ campaigns, slots: 1,
    resolveCampaignMedia: (entry, mediaCid) => resolveDevertCampaignMedia(entry, mediaCid, { nfts }) });
  const runtime = await makeRuntime(fixture);
  for (const ad of [await runtime.nextMainRadioAd(), await runtime.nextDevertLoopAd()]) {
    assert.equal(ad.track.mediaType, 'video/mp4');
    assert.equal(ad.track.videoUrl, `ipfs://${cid}`);
    assert.match(ad.track.filename, /\.mp4$/);
  }
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
  assert.deepEqual(runtime.getMainRadioAdVoteSummary(voteA.radioPlayId), { up: 0, down: 1, net: -1 });
  assert.deepEqual(runtime.getMainRadioAdVoteSummary(voteB.radioPlayId), { up: 1, down: 0, net: 1 });
  assert.deepEqual(runtime.getMainRadioAdVoteSummary('new-play'), { up: 0, down: 0, net: 0 });
  const restored = await makeRuntime(fixture);
  assert.deepEqual(restored.getMainRadioAdVoteSummary(voteA.radioPlayId), { up: 0, down: 1, net: -1 });
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
