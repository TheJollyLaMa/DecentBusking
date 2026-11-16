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
  paused = false,
  balance = 1_000_000_000_000_000_000n,
  workerAddress = address('3'),
  workerMinBalanceWei = 0n,
  save = async () => 'ipfs://journal',
  resolveCampaignMedia = () => null,
  competitionEnabled = false,
  readCampaign,
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
  return { contract, recorded, musicBatches, impressionCalls, state, resolveCampaignMedia, competitionEnabled, readCampaign, get saves() { return saves; },
    workerAddress, workerMinBalanceWei, setPaused(next) { paused = next; }, setBalance(next) { balance = next; }, setSave(fn) { save = fn; }, save: async snapshot => { saves++; await save(snapshot); Object.assign(state, snapshot); return 'ipfs://journal'; },
    readCampaigns: async () => ({ chainId: 8453, paused, snapshotAt: new Date(NOW).toISOString(), weekId: WEEK_ID,
      campaigns, market: { slots, seated: Math.min(slots, campaigns.length), lowestSeatedOfferUnits: campaigns[0]?.offerUnits || '0', mainRadioImpressions: impressions } }),
    unused: runtime };
}

async function makeRuntime(fixture) {
  const { createDevertPlaybackRuntime } = await import('../discord-bot/devert-playback.js');
  const runtime = createDevertPlaybackRuntime({ contract: fixture.contract, provider: fixture.contract.runner.provider,
    restore: async () => fixture.state.schemaVersion === 1 ? structuredClone(fixture.state) : null,
    save: fixture.save, readCampaigns: fixture.readCampaigns, now: () => fixture.now ?? NOW, resolveCampaignMedia: fixture.resolveCampaignMedia,
    workerAddress: fixture.workerAddress, workerMinBalanceWei: fixture.workerMinBalanceWei,
    competitionEnabled: fixture.competitionEnabled, readCampaign: fixture.readCampaign });
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

test('paused cutover restores the scheduler without submitting its backlog and resumes after activation', async () => {
  const fixture = harness({ paused: true });
  const pending = Array.from({ length: 20 }, (_, index) => id(`paused-song-${index}`));
  Object.assign(fixture.state, { musicWeekId: WEEK_ID, pendingMusicPlayIds: [...pending], seenMusicPlayIds: [...pending] });
  fixture.contract.reportCompletedMusicPlays.staticCall = async () => {
    assert.equal((await fixture.readCampaigns()).paused, false, 'paused reports must never be submitted');
  };
  const runtime = await makeRuntime(fixture);
  assert.equal(fixture.musicBatches.length, 0);
  assert.deepEqual(runtime.getState().pendingMusicPlayIds, pending);
  await runtime.recordCompletedMusicPlay({ playId: id('paused-new-song'), audibleMs: 30_000 });
  assert.equal(fixture.musicBatches.length, 0);
  assert.equal(fixture.state.pendingMusicPlayIds.length, 21);
  fixture.setPaused(false);
  await runtime.recordCompletedMusicPlay({ playId: id('activated-new-song'), audibleMs: 30_000 });
  assert.deepEqual(fixture.musicBatches, [pending.slice(0, 10), pending.slice(10)]);
  assert.equal(fixture.state.pendingMusicPlayIds.length, 2);
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

test('expired campaign impressions remain in the journal without blocking scheduler restore or active ads', async () => {
  const expired = campaign('1', { expiresAt: new Date(NOW - 1_000).toISOString() });
  const active = campaign('2');
  const fixture = harness({ campaigns: [expired, active], slots: 10 });
  const pendingId = id('expired-main-radio');
  fixture.state.impressions = [{ impressionId: pendingId, campaignId: '1', mainRadio: true,
    radioPlayId: 'expired-main-radio', recordedAt: new Date(NOW - 60_000).toISOString(), state: 'pending' }];
  let contractAttempts = 0;
  fixture.contract.recordCampaignPlay.staticCall = async () => {
    contractAttempts++;
    throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', reason: 'Campaign inactive' });
  };

  const runtime = await makeRuntime(fixture);

  assert.equal(contractAttempts, 0);
  assert.equal(fixture.state.impressions[0].state, 'pending');
  assert.equal(fixture.state.impressions[0].nextRetryAt, Number.MAX_SAFE_INTEGER);
  assert.equal((await runtime.nextMainRadioAd()).campaignId, '2');
  assert.equal(contractAttempts, 0);
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

test('advert vote tallies carry across plays and into weekly history without voter IDs', async () => {
  const { summarizeMainRadioAdverts, withAdvertTallies } = await import('../discord-bot/devert-playback.js');
  const fixture = harness({ campaigns: [campaign('1'), campaign('2')], slots: 2 });
  const runtime = await makeRuntime(fixture);
  await runtime.recordMainRadioAdVote({ campaignId: '1', radioPlayId: 'devert:1:play-1', voterId: 'listener-browser-0001', vote: 1 });
  await runtime.recordMainRadioAdVote({ campaignId: '1', radioPlayId: 'devert:1:play-1', voterId: 'listener-browser-0002', vote: 1 });
  await runtime.recordMainRadioAdVote({ campaignId: '1', radioPlayId: 'devert:1:play-2', voterId: 'listener-browser-0001', vote: -1 });
  const summary = runtime.getMainRadioAdVoteSummary('devert:1:play-2', '1');
  assert.deepEqual({ ...summary, campaign: { ...summary.campaign } },
    { up: 0, down: 1, net: -1, campaign: { campaignId: '1', up: 2, down: 1, net: 1, plays: 2 } });
  assert.deepEqual({ ...runtime.getMainRadioAdVoteSummary('devert:2:play-1', '2').campaign },
    { campaignId: '2', plays: 0, up: 0, down: 0, net: 0 });

  const rows = summarizeMainRadioAdverts({ periodOf: at => new Date(at).toISOString().slice(0, 10),
    impressions: [{ campaignId: '2', radioPlayId: 'p-a', mainRadio: true, recordedAt: '2026-10-27T10:00:00Z' },
      { campaignId: '2', radioPlayId: 'loop', mainRadio: false, recordedAt: '2026-10-27T10:00:00Z' },
      { campaignId: '2', radioPlayId: 'p-b', mainRadio: true, recordedAt: '2026-10-28T10:00:00Z' }],
    adVotes: [{ campaignId: '2', radioPlayId: 'p-a', voterId: 'secret-voter-0001', vote: -1, recordedAt: '2026-10-27T10:01:00Z' }] });
  assert.deepEqual(rows.map(row => ({ ...row })), [
    { period: '2026-10-27', campaignId: '2', up: 0, down: 1, plays: 1, net: -1 },
    { period: '2026-10-28', campaignId: '2', up: 0, down: 0, plays: 1, net: 0 }]);

  const reports = withAdvertTallies([{ week: 'NY-2026-10-26', tracks: [] }, { week: 'all-time', tracks: [] }], runtime,
    { periodOf: () => 'NY-2026-10-26', titles: new Map([['1', 'Shop Local']]) });
  assert.deepEqual(reports.map(report => report.adverts.map(row => ({ ...row }))), [
    [{ campaignId: '1', up: 2, down: 1, plays: 2, net: 1, title: 'Shop Local' }],
    [{ campaignId: '1', up: 2, down: 1, plays: 2, net: 1, title: 'Shop Local' }]]);
  assert.ok(!JSON.stringify(reports).includes('listener-browser'));
  assert.equal(await runtime.recordPaidAdvertPlay({ campaignId: '1', radioPlayId: 'devert-paid:9:1', audibleMs: 1000 }), false);
  assert.equal(await runtime.recordPaidAdvertPlay({ campaignId: '1', radioPlayId: 'devert-paid:9:1', audibleMs: 60_000 }), true);
  assert.equal(await runtime.recordPaidAdvertPlay({ campaignId: '1', radioPlayId: 'devert-paid:9:1', audibleMs: 60_000 }), true);
  assert.equal(fixture.state.paidPlays.length, 1, 'paid advert plays are durable and idempotent');
  assert.equal(runtime.getMainRadioAdVoteSummary('devert-paid:9:1', '1').campaign.plays, 3);
  const restored = await makeRuntime(fixture);
  assert.equal(restored.getMainRadioAdVoteSummary('x', '1').campaign.plays, 3);
  assert.deepEqual(withAdvertTallies([{ week: 'w' }], { getMainRadioAdvertTallies: () => { throw new Error('not ready'); } })
    .map(report => report.adverts), [null]);
});

test('accepted advert receipts preserve totals, report weeks and deduplication after raw pruning and restart', async () => {
  const { currentPayrollPeriod } = await import('../js/payroll-week.mjs');
  const fixture = harness();
  const original = { campaignId: '1', radioPlayId: 'old-play', voterId: 'listener-browser-0001', vote: -1,
    recordedAt: '2026-11-02T04:59:59.999Z' };
  fixture.state.adVotes = [original, ...Array.from({ length: 1999 }, (_, index) => ({
    campaignId: '2', radioPlayId: `new-play-${index}`, voterId: 'listener-browser-0001', vote: 1,
    recordedAt: '2026-11-02T05:00:00.000Z',
  }))];
  fixture.now = Date.parse('2026-11-02T05:00:00.001Z');
  const runtime = await makeRuntime(fixture);
  assert.equal(fixture.state.adVoteLedger.history, 'retained-history-only');
  assert.ok(!JSON.stringify(fixture.state.adVoteLedger).includes(original.voterId));
  await runtime.recordMainRadioAdVote({ ...original, campaignId: '2', radioPlayId: 'newest-play', vote: 1 });
  assert.equal(fixture.state.adVotes.length, 2000);
  assert.ok(!fixture.state.adVotes.some(entry => entry.radioPlayId === original.radioPlayId));
  const restored = await makeRuntime(fixture);
  assert.deepEqual(await restored.recordMainRadioAdVote({ ...original, campaignId: '2', vote: 1 }),
    { campaignId: '1', radioPlayId: 'old-play', vote: -1, duplicate: true });
  assert.deepEqual(restored.getMainRadioAdVoteSummary(original.radioPlayId), { up: 0, down: 1, net: -1 });
  assert.deepEqual(restored.getState().adVoteLedger.totals,
    [{ campaignId: '1', up: 0, down: 1, net: -1 }, { campaignId: '2', up: 2000, down: 0, net: 2000 }]);
  assert.deepEqual(restored.getMainRadioAdvertTallies(at => currentPayrollPeriod(at).week)
    .map(({ period, campaignId, up, down, net }) => ({ period, campaignId, up, down, net })), [
    { period: 'NY-2026-10-26', campaignId: '1', up: 0, down: 1, net: -1 },
    { period: 'NY-2026-11-02', campaignId: '2', up: 2000, down: 0, net: 2000 },
  ]);
});

test('failed advert receipt persistence leaves both tallies and duplicate keys retryable', async () => {
  const fixture = harness();
  const runtime = await makeRuntime(fixture);
  const before = runtime.getState();
  const vote = { campaignId: '1', radioPlayId: 'failure-play', voterId: 'listener-browser-0001', vote: 1 };
  fixture.setSave(async () => { throw new Error('checkpoint unavailable'); });
  await assert.rejects(runtime.recordMainRadioAdVote(vote), /checkpoint unavailable/);
  assert.deepEqual(runtime.getState(), before);
  fixture.setSave(async () => 'ipfs://journal');
  assert.equal((await runtime.recordMainRadioAdVote(vote)).duplicate, false);
  assert.equal((await runtime.recordMainRadioAdVote(vote)).duplicate, true);
  assert.deepEqual(runtime.getState().adVoteLedger.totals, [{ campaignId: '1', up: 1, down: 0, net: 1 }]);
});

test('advert ledger migration must checkpoint successfully and corrupt totals never silently reset', async () => {
  const fixture = harness();
  fixture.state.adVotes = [{ campaignId: '1', radioPlayId: 'retained-play', voterId: 'listener-browser-0001', vote: 1,
    recordedAt: new Date(NOW).toISOString() }];
  fixture.setSave(async () => { throw new Error('migration unavailable'); });
  await assert.rejects(makeRuntime(fixture), /migration unavailable/);
  assert.equal(fixture.state.adVoteLedger, undefined);
  fixture.setSave(async () => 'ipfs://journal');
  const runtime = await makeRuntime(fixture);
  assert.equal(runtime.getMainRadioAdVoteSummary('retained-play', '1').campaign.up, 1);
  fixture.state.adVoteLedger.totals[0].up = 0;
  await assert.rejects(makeRuntime(fixture), /totals do not match/);
  assert.equal(fixture.state.adVoteLedger.receipts.length, 1);
});

function competitionFixture(campaigns = [campaign('1')], options = {}) {
  const fixture = harness({ campaigns, competitionEnabled: true,
    resolveCampaignMedia: () => ({ filename: 'ad.mp3', mediaType: 'audio/mpeg' }), ...options });
  fixture.now = Date.parse('2026-11-01T12:00:00Z');
  const read = fixture.readCampaigns;
  fixture.readCampaigns = async () => ({ ...await read(), snapshotAt: new Date(fixture.now).toISOString() });
  return fixture;
}

const advertVote = (campaignId, play = `vote-${campaignId}`, vote = 1) => ({
  campaignId, radioPlayId: play, voterId: 'listener-browser-0001', vote,
});

test('all tied positive net winners receive exactly the DST-aware next week, with separate free accounting', async () => {
  const fixture = competitionFixture([campaign('1'), campaign('2'), campaign('3')]);
  const runtime = await makeRuntime(fixture);
  for (const campaignId of ['1', '2']) await runtime.recordMainRadioAdVote(advertVote(campaignId));
  await runtime.recordMainRadioAdVote(advertVote('3', 'down', -1));
  fixture.now = Date.parse('2026-11-02T05:00:00Z');
  await Promise.all([runtime.reconcileAdvertCompetition(), runtime.reconcileAdvertCompetition()]);
  const state = runtime.getState().competition;
  assert.equal(state.closedWeeks.length, 1);
  assert.equal(state.closedWeeks[0].winners.length, 2);
  assert.equal(Date.parse(state.closedWeeks[0].endAt) - Date.parse(state.closedWeeks[0].startAt), 169 * 3600000);
  assert.deepEqual(state.grants.map(({ rewardWeek, startAt, endAt }) => ({ rewardWeek, startAt, endAt })), [
    { rewardWeek: 'NY-2026-11-02', startAt: '2026-11-02T05:00:00.000Z', endAt: '2026-11-09T05:00:00.000Z' },
    { rewardWeek: 'NY-2026-11-02', startAt: '2026-11-02T05:00:00.000Z', endAt: '2026-11-09T05:00:00.000Z' },
  ]);
  const ads = await runtime.nextMainRadioAd({ count: 4 });
  assert.deepEqual(new Set(ads.map(ad => ad.campaignId)), new Set(['1', '2']));
  const ad = ads[0];
  assert.equal(await runtime.canPlayCampaign(ad.campaignId, ad), true);
  const play = { ...ad, radioPlayId: 'free-audible', startedAt: fixture.now, audibleMs: 30000 };
  fixture.now += 30000;
  await runtime.recordCompetitionAdvertPlay(play);
  await runtime.recordCompetitionAdvertPlay(play);
  assert.equal(runtime.getState().competition.plays.length, 1);
  assert.equal(runtime.getState().impressions.length, 0);
  assert.equal(runtime.getState().paidPlays.length, 0);
  assert.equal(fixture.impressionCalls.length, 0);
  await assert.rejects(runtime.recordCampaignImpression(play), /separate competition accounting/);
  await assert.rejects(runtime.recordPaidAdvertPlay(play), /cannot be counted as paid/);
  const restarted = await makeRuntime(fixture);
  assert.equal(restarted.getState().competition.grants.length, 2);
  assert.equal(restarted.getState().competition.plays.length, 1);
  fixture.now = Date.parse('2026-11-09T05:00:00Z');
  assert.equal(await restarted.canPlayCampaign(ad.campaignId, ad), false);
  assert.deepEqual(await restarted.nextMainRadioAd({ count: 4 }), []);
});

test('renewals share wallet plus exact URI totals and reward-week votes may earn a consecutive reward', async () => {
  const original = campaign('1');
  const renewed = campaign('2', { audioURI: original.audioURI, title: 'Renewed title' });
  const fixture = competitionFixture([original, renewed, campaign('3')]);
  const runtime = await makeRuntime(fixture);
  await runtime.recordMainRadioAdVote(advertVote('1'));
  await runtime.recordMainRadioAdVote(advertVote('2'));
  await runtime.recordMainRadioAdVote(advertVote('3'));
  fixture.now = Date.parse('2026-11-02T05:00:00Z');
  await runtime.reconcileAdvertCompetition();
  assert.equal(runtime.getState().competition.grants.length, 1);
  assert.equal(runtime.getState().competition.closedWeeks[0].ranking[0].net, 2);
  await runtime.recordMainRadioAdVote(advertVote('2', 'reward-week-vote'));
  fixture.now = Date.parse('2026-11-09T05:00:00Z');
  await runtime.reconcileAdvertCompetition();
  const grants = runtime.getState().competition.grants;
  assert.equal(grants.length, 2);
  assert.equal(grants[0].advertId, grants[1].advertId);
  assert.deepEqual(grants.map(grant => grant.rewardWeek), ['NY-2026-11-02', 'NY-2026-11-09']);
  assert.equal(runtime.getState().competition.lifetimeTotals.find(row => row.advertId === grants[0].advertId).up, 3);
});

test('delayed recovery never shifts an expired reward, and empty or nonpositive weeks award nothing', async () => {
  const fixture = competitionFixture();
  const runtime = await makeRuntime(fixture);
  await runtime.recordMainRadioAdVote(advertVote('1'));
  fixture.now = Date.parse('2026-11-16T05:00:00Z');
  await runtime.reconcileAdvertCompetition();
  assert.deepEqual(runtime.getState().competition.grants.map(grant => grant.rewardWeek), ['NY-2026-11-02']);
  assert.equal(await runtime.nextMainRadioAd(), null);
  await runtime.recordMainRadioAdVote(advertVote('1', 'negative', -1));
  await runtime.recordMainRadioAdVote(advertVote('1', 'zero'));
  fixture.now = Date.parse('2026-11-23T05:00:00Z');
  await runtime.reconcileAdvertCompetition();
  assert.equal(runtime.getState().competition.closedWeeks.at(-1).ranking[0].net, 0);
  assert.equal(runtime.getState().competition.grants.length, 1);
  assert.equal(runtime.getState().competition.closedWeeks.find(week => week.week === 'NY-2026-11-09').winners.length, 0);
});

test('closure checkpoint failures are visible and retryable without duplicate or partially granted rewards', async () => {
  const fixture = competitionFixture();
  const runtime = await makeRuntime(fixture);
  await runtime.recordMainRadioAdVote(advertVote('1'));
  fixture.now = Date.parse('2026-11-02T05:00:00Z');
  fixture.setSave(async () => { throw new Error('closure checkpoint unavailable'); });
  await assert.rejects(runtime.reconcileAdvertCompetition(), /closure checkpoint unavailable/);
  assert.equal(runtime.getState().competition.grants.length, 0);
  assert.equal(runtime.getAdvertCompetitionStatus().retryable, true);
  assert.match(runtime.getAdvertCompetitionStatus().lastError, /closure checkpoint unavailable/);
  fixture.setSave(async () => 'ipfs://journal');
  await runtime.reconcileAdvertCompetition();
  assert.equal(runtime.getAdvertCompetitionStatus().ready, true);
  assert.equal(runtime.getState().competition.grants.length, 1);
  const ad = await runtime.nextMainRadioAd();
  const play = { ...ad, radioPlayId: 'retryable-free-play', startedAt: fixture.now, audibleMs: 30000 };
  fixture.now += 30000;
  fixture.setSave(async () => { throw new Error('free receipt checkpoint unavailable'); });
  await assert.rejects(runtime.recordCompetitionAdvertPlay(play), /free receipt checkpoint unavailable/);
  assert.equal(runtime.getState().competition.plays.length, 0);
  fixture.setSave(async () => 'ipfs://journal');
  await runtime.recordCompetitionAdvertPlay(play);
  assert.equal(runtime.getState().competition.plays.length, 1);
});

test('spring DST uses a 167-hour source week and nonpositive weeks never win', async () => {
  const fixture = competitionFixture();
  fixture.now = Date.parse('2027-03-14T12:00:00Z');
  const runtime = await makeRuntime(fixture);
  await runtime.recordMainRadioAdVote(advertVote('1', 'spring-down', -1));
  fixture.now = Date.parse('2027-03-15T04:00:00Z');
  await runtime.reconcileAdvertCompetition();
  const week = runtime.getState().competition.closedWeeks.at(-1);
  assert.equal(Date.parse(week.endAt) - Date.parse(week.startAt), 167 * 3600000);
  assert.equal(week.ranking[0].net, -1);
  assert.equal(week.winners.length, 0);
  assert.equal(runtime.getState().competition.grants.length, 0);
});

test('reward grants themselves honor spring and fall DST instead of adding seven fixed UTC days', async () => {
  for (const [voteAt, closeAt, endAt, hours] of [
    ['2027-03-07T12:00:00Z', '2027-03-08T05:00:00Z', '2027-03-15T04:00:00.000Z', 167],
    ['2026-10-25T12:00:00Z', '2026-10-26T04:00:00Z', '2026-11-02T05:00:00.000Z', 169],
  ]) {
    const fixture = competitionFixture();
    fixture.now = Date.parse(voteAt);
    const runtime = await makeRuntime(fixture);
    await runtime.recordMainRadioAdVote(advertVote('1'));
    fixture.now = Date.parse(closeAt);
    await runtime.reconcileAdvertCompetition();
    const [grant] = runtime.getState().competition.grants;
    assert.equal(grant.endAt, endAt);
    assert.equal(Date.parse(grant.endAt) - Date.parse(grant.startAt), hours * 3600000);
  }
});

test('corrupt or duplicated reward grants fail restore instead of extending eligibility', async () => {
  const fixture = competitionFixture();
  const runtime = await makeRuntime(fixture);
  await runtime.recordMainRadioAdVote(advertVote('1'));
  fixture.now = Date.parse('2026-11-02T05:00:00Z');
  await runtime.reconcileAdvertCompetition();
  const valid = structuredClone(fixture.state);
  fixture.state.competition.grants[0].endAt = '2026-11-16T05:00:00.000Z';
  await assert.rejects(makeRuntime(fixture), /Invalid advert competition reward grant/);
  Object.assign(fixture.state, structuredClone(valid));
  fixture.state.competition.grants.push(structuredClone(fixture.state.competition.grants[0]));
  await assert.rejects(makeRuntime(fixture), /Invalid advert competition reward grant/);
});

test('advert identity ignores wallet case but never merges another wallet or an altered exact media URI', async () => {
  const { advertIdentity } = await import('../discord-bot/advert-competition.js');
  const original = campaign('1', { advertiser: `0x${'a'.repeat(40)}` });
  assert.equal(advertIdentity(original), advertIdentity({ ...original, advertiser: `0x${'A'.repeat(40)}` }));
  assert.notEqual(advertIdentity(original), advertIdentity({ ...original, advertiser: address('2') }));
  assert.notEqual(advertIdentity(original), advertIdentity({ ...original, audioURI: `${original.audioURI}/audio.mp3` }));
});

test('missing historical identity blocks closure until verified metadata becomes available', async () => {
  let available = false;
  const fixture = competitionFixture([], { readCampaign: async () => available ? campaign('1') : null });
  fixture.state.adVotes = [{ ...advertVote('1'), recordedAt: new Date(fixture.now).toISOString() }];
  const runtime = await makeRuntime(fixture);
  fixture.now = Date.parse('2026-11-02T05:00:00Z');
  await runtime.reconcileAdvertCompetition();
  assert.equal(runtime.getAdvertCompetitionStatus().retryable, true);
  assert.equal(runtime.getState().competition.grants.length, 0);
  available = true;
  await runtime.reconcileAdvertCompetition();
  assert.equal(runtime.getAdvertCompetitionStatus().ready, true);
  assert.equal(runtime.getState().competition.grants.length, 1);
});

test('startup recovers missed weeks from verified historical media even with no worker gas or current campaigns', async () => {
  const fixture = competitionFixture([], { balance: 0n, workerMinBalanceWei: 1n,
    readCampaign: async campaignId => campaign(campaignId) });
  fixture.state.adVotes = [{ ...advertVote('1'), recordedAt: new Date(fixture.now).toISOString() }];
  fixture.now = Date.parse('2026-11-16T05:00:00Z');
  const runtime = await makeRuntime(fixture);
  assert.equal(runtime.getAdvertCompetitionStatus().ready, true);
  assert.deepEqual(runtime.getState().competition.grants.map(grant => grant.rewardWeek), ['NY-2026-11-02']);
  assert.equal(await runtime.nextMainRadioAd(), null);
  assert.equal(fixture.impressionCalls.length, 0);
});

test('rewards respect removal, valid media, pause and existing paid campaign priority', async () => {
  const campaigns = [campaign('1')];
  let mediaValid = true;
  const fixture = competitionFixture(campaigns, { slots: 1,
    resolveCampaignMedia: () => mediaValid ? { mediaType: 'audio/mpeg' } : null });
  const runtime = await makeRuntime(fixture);
  await runtime.recordMainRadioAdVote(advertVote('1'));
  fixture.now = Date.parse('2026-11-02T05:00:00Z');
  await runtime.reconcileAdvertCompetition();
  mediaValid = false;
  assert.equal(await runtime.nextMainRadioAd(), null);
  mediaValid = true;
  campaigns[0].removed = true;
  assert.equal(await runtime.nextMainRadioAd(), null);
  campaigns[0].removed = false;
  fixture.setPaused(true);
  assert.equal(await runtime.nextMainRadioAd(), null);
  fixture.setPaused(false);
  campaigns.push(campaign('2', { startedAt: new Date(fixture.now - 1000).toISOString(),
    expiresAt: new Date(fixture.now + 86400000).toISOString() }));
  const paid = await runtime.nextMainRadioAd();
  assert.equal(paid.campaignId, '2');
  assert.equal(paid.competitionReward, undefined);
  const ads = await runtime.nextMainRadioAd({ count: 2 });
  assert.equal(ads[0].campaignId, '2');
  assert.equal(ads[1].campaignId, '1');
  assert.ok(ads[1].competitionReward);
  campaigns[1].title = 'Paid campaign changed';
  fixture.setSave(async () => { throw new Error('competition catalog checkpoint unavailable'); });
  const paidDuringFailure = await runtime.nextMainRadioAd({ count: 2 });
  assert.deepEqual(paidDuringFailure.map(ad => ad.campaignId), ['2']);
  assert.equal(runtime.getAdvertCompetitionStatus().retryable, true);
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
