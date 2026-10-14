import { id, isAddress } from 'ethers';
import { planDevertQueues } from '../js/devert-scheduler.mjs';
import { DEFAULT_WORKER_MIN_BALANCE_WEI, readWorkerGasState } from '../js/worker-gas.mjs';

const SCHEMA_VERSION = 1;
const MUSIC_PLAYS_PER_MAIN_AD = 10;
const MUSIC_BATCH_SIZE = 10;
const MAX_SAVED_IDS = 2000;
const MIN_AUDIBLE_MS = 30_000;
const INITIAL_RESTORE_RETRY_MS = 5_000;
const MAX_RESTORE_RETRY_MS = 5 * 60_000;
const VERTLOOP_IMPRESSION_MIN_INTERVAL_MS = 60 * 60_000;
const WORKER_GAS_CHECK_MS = 60_000;
const WORKER_GAS_DAILY_BURN_WEI = 86_000_000_000_000n;

function isInsufficientFundsError(error) {
  return /insufficient funds/i.test(error?.shortMessage || error?.message || '') || error?.code === 'INSUFFICIENT_FUNDS';
}

export async function initializeDevertPlaybackWithRetry({ initialize, wait = delay => new Promise(resolve => setTimeout(resolve, delay)), log = console }) {
  let attempt = 0;
  while (true) {
    try {
      return await initialize();
    } catch (error) {
      attempt++;
      const delay = Math.min(MAX_RESTORE_RETRY_MS, INITIAL_RESTORE_RETRY_MS * 2 ** Math.min(attempt - 1, 16));
      log.warn(`[devert] Durable scheduler restore attempt ${attempt} failed; retrying in ${Math.ceil(delay / 1000)}s: ${error.message}`);
      await wait(delay);
    }
  }
}

function emptyJournal() {
  return { schemaVersion: SCHEMA_VERSION, musicWeekId: null, pendingMusicPlayIds: [], seenMusicPlayIds: [], impressions: [], adVotes: [] };
}

function validateJournal(value) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION ||
    value.musicWeekId !== null && (!Number.isSafeInteger(value.musicWeekId) || value.musicWeekId < 0) ||
    !Array.isArray(value.pendingMusicPlayIds) || !Array.isArray(value.seenMusicPlayIds) || !Array.isArray(value.impressions) ||
    value.adVotes !== undefined && !Array.isArray(value.adVotes)) {
    throw new Error('Invalid DeVert playback journal');
  }
  const impressionIds = new Set();
  for (const entry of value.impressions) {
    if (!entry || typeof entry.impressionId !== 'string' || !/^0x[0-9a-f]{64}$/i.test(entry.impressionId) ||
      !['pending', 'recorded'].includes(entry.state) || !Number.isSafeInteger(Number(entry.campaignId)) ||
      typeof entry.mainRadio !== 'boolean' || entry.nextRetryAt !== undefined && (!Number.isSafeInteger(entry.nextRetryAt) || entry.nextRetryAt < 0) ||
      entry.submittedAt !== undefined && !Number.isFinite(Date.parse(entry.submittedAt))) throw new Error('Invalid DeVert impression journal entry');
    if (impressionIds.has(entry.impressionId)) throw new Error('Duplicate DeVert impression journal entry');
    impressionIds.add(entry.impressionId);
  }
  if (value.pendingMusicPlayIds.some(playId => typeof playId !== 'string' || !/^0x[0-9a-f]{64}$/i.test(playId)) ||
    value.seenMusicPlayIds.some(playId => typeof playId !== 'string' || !/^0x[0-9a-f]{64}$/i.test(playId))) {
    throw new Error('Invalid DeVert music-play journal entry');
  }
  const adVotes = value.adVotes || [];
  const voteKeys = new Set();
  for (const entry of adVotes) {
    if (!entry || !/^\d+$/.test(String(entry.campaignId)) || typeof entry.radioPlayId !== 'string' || !entry.radioPlayId ||
      typeof entry.voterId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(entry.voterId) ||
      entry.vote !== 1 && entry.vote !== -1) throw new Error('Invalid DeVert radio ad vote');
    const key = `${entry.radioPlayId}:${entry.voterId}`;
    if (voteKeys.has(key)) throw new Error('Duplicate DeVert radio ad vote');
    voteKeys.add(key);
  }
  return structuredClone({ ...value, adVotes });
}

export function createDevertPlaybackRuntime({ contract, provider = contract?.runner?.provider, restore, save,
  readCampaigns, resolveCampaignMedia = () => null, now = () => Date.now(), minimumAudibleMs = MIN_AUDIBLE_MS, log = console,
  workerAddress, workerMinBalanceWei = DEFAULT_WORKER_MIN_BALANCE_WEI, workerDailyBurnWei = WORKER_GAS_DAILY_BURN_WEI, workerGasReader = readWorkerGasState,
  workerGasCheckMs = WORKER_GAS_CHECK_MS }) {
  if (!contract || typeof restore !== 'function' || typeof save !== 'function' || typeof readCampaigns !== 'function') {
    throw new Error('DeVert playback requires a contract and durable journal store');
  }
  if (!provider || !isAddress(contract.target)) throw new Error('DeVert playback needs a Base provider and contract');
  let journal = emptyJournal();
  let initialized = false;
  let queue = Promise.resolve();
  let retryTimer = null;
  let workerGasState = null;
  let workerGasCheckedAt = 0;
  let workerGasWarningAt = 0;
  let insufficientFundsBalanceWei = null;
  const workerWallet = workerAddress && isAddress(workerAddress) ? workerAddress : null;
  const vertLoopNextRetryAtByCampaign = new Map();

  const run = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const commit = async next => {
    const validated = validateJournal(next);
    const uri = await save(structuredClone(validated));
    if (typeof uri !== 'string' || !uri.startsWith('ipfs://')) throw new Error('DeVert playback journal was not durably checkpointed');
    journal = validated;
  };
  const requireReady = () => { if (!initialized) throw new Error('DeVert playback journal is not initialized'); };

  const warnWorkerGas = state => {
    if (!state || state.checkedAt <= workerGasWarningAt) return;
    workerGasWarningAt = state.checkedAt;
    if (state.unavailable) {
      log.warn(`[devert] Worker gas check unavailable${workerWallet ? ` for ${workerWallet}` : ''}: ${state.reason}`);
      return;
    }
    if (state.lowBalance) {
      const thresholdWei = state.thresholdWei ?? workerMinBalanceWei;
      log.warn(`[devert] Worker gas low${workerWallet ? ` for ${workerWallet}` : ''}: ${state.balanceWei} wei (threshold ${thresholdWei} wei; runway ~${state.runwayDays ?? 'unknown'} day${state.runwayDays === 1 ? '' : 's'})`);
    }
  };

  const hydrateVertLoopRetryState = () => {
    vertLoopNextRetryAtByCampaign.clear();
    const campaignRetryAt = new Map();
    for (const entry of journal.impressions) {
      if (entry.mainRadio || entry.state !== 'recorded') continue;
      const submittedAt = Number.isFinite(Date.parse(entry.submittedAt || entry.recordedAt || ''))
        ? Date.parse(entry.submittedAt || entry.recordedAt) : 0;
      const nextEligibleAt = submittedAt > 0 ? submittedAt + VERTLOOP_IMPRESSION_MIN_INTERVAL_MS : 0;
      if (nextEligibleAt > 0) campaignRetryAt.set(entry.campaignId, Math.max(campaignRetryAt.get(entry.campaignId) || 0, nextEligibleAt));
    }
    for (const [campaignId, retryAt] of campaignRetryAt) vertLoopNextRetryAtByCampaign.set(campaignId, retryAt);
    journal = {
      ...journal,
      impressions: journal.impressions.map(entry => {
        if (entry.mainRadio) return entry;
        if (entry.state === 'recorded') {
          return entry;
        }
        const submittedAt = Number.isFinite(Date.parse(entry.submittedAt || entry.recordedAt || ''))
          ? Date.parse(entry.submittedAt || entry.recordedAt) : 0;
        const retryFloor = vertLoopNextRetryAtByCampaign.get(entry.campaignId) || 0;
        const nextRetryAt = Number.isSafeInteger(entry.nextRetryAt) && entry.nextRetryAt > 0
          ? Math.max(entry.nextRetryAt, retryFloor) : Math.max(retryFloor, submittedAt || now());
        return nextRetryAt === entry.nextRetryAt ? entry : { ...entry, nextRetryAt };
      }),
    };
    // Collapse any legacy VertLoop backlog to the oldest pending entry per campaign.
    const keptVertLoopPending = new Set();
    journal = {
      ...journal,
      impressions: journal.impressions.filter(entry => {
        if (entry.mainRadio || entry.state !== 'pending') return true;
        if (keptVertLoopPending.has(entry.campaignId)) return false;
        keptVertLoopPending.add(entry.campaignId);
        return true;
      }),
    };
  };

  const refreshWorkerGasState = async ({ force = false } = {}) => {
    if (!workerWallet || typeof workerGasReader !== 'function') {
      workerGasState = { checkedAt: now(), unavailable: true, lowBalance: false, reason: 'worker wallet unavailable', workerAddress: workerWallet };
      return workerGasState;
    }
    if (!force && workerGasState && now() - workerGasCheckedAt < workerGasCheckMs) return workerGasState;
    try {
      const state = await workerGasReader({ provider, workerAddress: workerWallet, minBalanceWei: workerMinBalanceWei, estimatedDailyBurnWei: workerDailyBurnWei });
      workerGasCheckedAt = now();
      // A node-reported shortfall stays latched until the balance actually rises, even if it clears the threshold.
      let lowBalance = Boolean(state.lowBalance);
      if (insufficientFundsBalanceWei !== null) {
        if (typeof state.balanceWei === 'bigint' && state.balanceWei > insufficientFundsBalanceWei) insufficientFundsBalanceWei = null;
        else lowBalance = true;
      }
      workerGasState = { ...state, lowBalance, checkedAt: workerGasCheckedAt };
    } catch (error) {
      workerGasCheckedAt = now();
      workerGasState = {
        checkedAt: workerGasCheckedAt,
        unavailable: true,
        lowBalance: false,
        reason: error?.shortMessage || error?.message || 'worker gas check failed',
        workerAddress: workerWallet,
      };
    }
    warnWorkerGas(workerGasState);
    return workerGasState;
  };

  const canSpendWorkerGas = async () => {
    const state = await refreshWorkerGasState();
    return state && !state.unavailable && !state.lowBalance;
  };

  const markInsufficientFunds = async error => {
    let balanceWei = null;
    try { if (workerWallet) balanceWei = await provider.getBalance(workerWallet); } catch {}
    if (typeof balanceWei !== 'bigint') balanceWei = typeof workerGasState?.balanceWei === 'bigint' ? workerGasState.balanceWei : 0n;
    insufficientFundsBalanceWei = balanceWei;
    workerGasState = {
      checkedAt: now(),
      unavailable: false,
      lowBalance: true,
      reason: error?.shortMessage || error?.message || 'worker gas low',
      workerAddress: workerWallet,
      balanceWei,
      thresholdWei: workerMinBalanceWei,
      runwayDays: 0,
    };
    workerGasCheckedAt = workerGasState.checkedAt;
    warnWorkerGas(workerGasState);
  };

  async function flushMusicBatch() {
    if (journal.pendingMusicPlayIds.length < MUSIC_BATCH_SIZE) return false;
    if (!await canSpendWorkerGas()) return false;
    const block = await provider.getBlock('latest');
    const chainWeek = Number(await contract.campaignWeek(block.timestamp));
    if (chainWeek !== journal.musicWeekId) {
      await commit({ ...journal, musicWeekId: chainWeek, pendingMusicPlayIds: [] });
      return false;
    }
    const batch = journal.pendingMusicPlayIds.slice(0, MUSIC_BATCH_SIZE);
    try {
      await contract.reportCompletedMusicPlays.staticCall(batch);
      const transaction = await contract.reportCompletedMusicPlays(batch);
      if ((await transaction.wait(2))?.status !== 1) throw new Error(`DeVert music-play report failed: ${transaction.hash}`);
    } catch (error) {
      if (!isInsufficientFundsError(error)) throw error;
      await markInsufficientFunds(error);
      return false;
    }
    await commit({ ...journal, pendingMusicPlayIds: journal.pendingMusicPlayIds.slice(batch.length) });
    return true;
  }

  async function submitImpression(entry) {
    if (entry.state === 'recorded') return entry;
    if (!entry.mainRadio && Number.isSafeInteger(entry.nextRetryAt) && entry.nextRetryAt > now()) return false;
    if (!await canSpendWorkerGas()) return false;
    if (await contract.usedImpressionIds(entry.impressionId)) {
      const submittedAt = new Date(now()).toISOString();
      const nextEligibleAt = !entry.mainRadio ? Date.parse(submittedAt) + VERTLOOP_IMPRESSION_MIN_INTERVAL_MS : 0;
      const next = { ...journal, impressions: journal.impressions.map(item => {
        if (item.impressionId === entry.impressionId) return { ...item, state: 'recorded', submittedAt };
        if (!entry.mainRadio && item.state === 'pending' && item.campaignId === entry.campaignId) {
          return { ...item, nextRetryAt: Math.max(Number.isSafeInteger(item.nextRetryAt) ? item.nextRetryAt : 0, nextEligibleAt) };
        }
        return item;
      }) };
      await commit(next);
      if (!entry.mainRadio) {
        vertLoopNextRetryAtByCampaign.set(entry.campaignId, Math.max(vertLoopNextRetryAtByCampaign.get(entry.campaignId) || 0, nextEligibleAt));
      }
      return next.impressions.find(item => item.impressionId === entry.impressionId);
    }
    try {
      await contract.recordCampaignPlay.staticCall(BigInt(entry.campaignId), entry.mainRadio, entry.impressionId);
      const transaction = await contract.recordCampaignPlay(BigInt(entry.campaignId), entry.mainRadio, entry.impressionId);
      if ((await transaction.wait(2))?.status !== 1) throw new Error(`DeVert impression failed: ${transaction.hash}`);
      const submittedAt = new Date(now()).toISOString();
      const nextEligibleAt = !entry.mainRadio ? Date.parse(submittedAt) + VERTLOOP_IMPRESSION_MIN_INTERVAL_MS : 0;
      const next = { ...journal, impressions: journal.impressions.map(item => {
        if (item.impressionId === entry.impressionId) {
          return { ...item, state: 'recorded', submittedAt, transactionHash: transaction.hash };
        }
        if (!entry.mainRadio && item.state === 'pending' && item.campaignId === entry.campaignId) {
          return { ...item, nextRetryAt: Math.max(Number.isSafeInteger(item.nextRetryAt) ? item.nextRetryAt : 0, nextEligibleAt) };
        }
        return item;
      }) };
      await commit(next);
      if (!entry.mainRadio) {
        vertLoopNextRetryAtByCampaign.set(entry.campaignId, Math.max(vertLoopNextRetryAtByCampaign.get(entry.campaignId) || 0, nextEligibleAt));
      }
      return next.impressions.find(item => item.impressionId === entry.impressionId);
    } catch (error) {
      if (!isInsufficientFundsError(error)) throw error;
      await markInsufficientFunds(error);
      return false;
    }
  }

  async function retryPendingImpressions({ force = false } = {}) {
    if (!journal.impressions.some(item => item.state === 'pending')) return false;
    const state = await refreshWorkerGasState({ force });
    if (!state || state.unavailable || state.lowBalance) return false;
    let progressed = false;
    for (const impressionId of journal.impressions.filter(item => item.state === 'pending').map(item => item.impressionId)) {
      const entry = journal.impressions.find(item => item.impressionId === impressionId && item.state === 'pending');
      if (!entry) continue;
      const submitted = await submitImpression(entry);
      if (submitted && submitted.state === 'recorded') progressed = true;
    }
    return progressed;
  }

  const retryDeferredWork = async () => {
    if (!initialized) return false;
    const force = Boolean(workerGasState?.lowBalance || workerGasState?.unavailable);
    const state = await refreshWorkerGasState({ force });
    if (!state || state.unavailable || state.lowBalance) return false;
    let progressed = false;
    while (journal.pendingMusicPlayIds.length >= MUSIC_BATCH_SIZE) {
      const flushed = await flushMusicBatch();
      if (!flushed) break;
      progressed = true;
    }
    if (await retryPendingImpressions({ force })) progressed = true;
    return progressed;
  };

  const startRetryTimer = () => {
    if (retryTimer) return;
    retryTimer = setInterval(() => {
      run(() => retryDeferredWork().catch(error => log.warn(`[devert] Deferred worker retry failed: ${error.message}`)));
    }, workerGasCheckMs);
    retryTimer.unref?.();
  };

  function campaignTrack(campaign, kind) {
    const ipfsCid = campaign.audioURI.slice('ipfs://'.length);
    const media = resolveCampaignMedia(campaign, ipfsCid);
    const mediaType = media?.mediaType || (media?.videoUrl ? 'video/mp4' : '');
    return { campaignId: campaign.campaignId, source: 'devert', kind, trackId: `devert:${campaign.campaignId}`,
      title: campaign.title, uploader: 'DeVert advertiser',
      filename: media?.filename || `devert-${campaign.campaignId}.${mediaType === 'video/mp4' ? 'mp4' : 'mp3'}`,
      mediaType, videoUrl: media?.videoUrl || (mediaType === 'video/mp4' ? `ipfs://${ipfsCid}` : ''),
      ipfsCid, pinStatus: 'untracked' };
  }

  return {
    initialize: () => run(async () => {
      const restored = await restore();
      journal = restored ? validateJournal(restored) : emptyJournal();
      hydrateVertLoopRetryState();
      initialized = true;
      startRetryTimer();
      await retryDeferredWork();
      return structuredClone(journal);
    }),
    recordCompletedMusicPlay: ({ playId, audibleMs }) => run(async () => {
      requireReady();
      if (typeof playId !== 'string' || !playId || playId.length > 256) throw new Error('Invalid completed music play ID');
      if (!Number.isSafeInteger(audibleMs) || audibleMs < minimumAudibleMs) return false;
      const musicPlayId = id(playId);
      const block = await provider.getBlock('latest');
      const weekId = Number(await contract.campaignWeek(block.timestamp));
      const pendingMusicPlayIds = journal.musicWeekId === weekId ? [...journal.pendingMusicPlayIds] : [];
      const seen = new Set(journal.seenMusicPlayIds);
      if (seen.has(musicPlayId)) return false;
      pendingMusicPlayIds.push(musicPlayId);
      const nextSeen = [...journal.seenMusicPlayIds, musicPlayId].slice(-MAX_SAVED_IDS);
      await commit({ ...journal, musicWeekId: weekId, pendingMusicPlayIds, seenMusicPlayIds: nextSeen });
      await retryDeferredWork();
      return true;
    }),
    async nextMainRadioAd({ excludeCampaignIds = [], count = 1 } = {}) {
      requireReady();
      await retryPendingImpressions({ force: Boolean(workerGasState?.lowBalance || workerGasState?.unavailable) });
      const snapshot = await readCampaigns();
      if (snapshot.chainId !== 8453 || snapshot.paused || !Array.isArray(snapshot.campaigns) ||
        snapshot.market.mainRadioImpressions >= snapshot.market.slots) return null;
      const at = Date.parse(snapshot.snapshotAt);
      const plan = planDevertQueues({ campaigns: snapshot.campaigns,
        completedSongPlays: snapshot.market.slots * MUSIC_PLAYS_PER_MAIN_AD, now: at });
      const excluded = new Set(excludeCampaignIds.map(String));
      const voteScores = new Map();
      for (const entry of journal.adVotes) {
        voteScores.set(entry.campaignId, (voteScores.get(entry.campaignId) || 0) + entry.vote);
      }
      const limit = Number.isSafeInteger(count) && count > 0 ? count : 1;
      const campaigns = plan.mainRadio.filter(item => !excluded.has(item.campaignId))
        .sort((first, second) => (voteScores.get(second.campaignId) || 0) - (voteScores.get(first.campaignId) || 0))
        .slice(0, limit);
      if (limit === 1) {
        const [campaign] = campaigns;
        return campaign ? { campaignId: campaign.campaignId, mainRadio: true, track: campaignTrack(campaign, 'main-radio') } : null;
      }
      return campaigns.map(campaign => ({ campaignId: campaign.campaignId, mainRadio: true, track: campaignTrack(campaign, 'main-radio') }));
    },
    recordMainRadioAdVote: ({ campaignId, radioPlayId, voterId, vote }) => run(async () => {
      requireReady();
      if (!/^\d+$/.test(String(campaignId)) || typeof radioPlayId !== 'string' || !radioPlayId ||
          typeof voterId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(voterId) || (vote !== 1 && vote !== -1)) {
        throw new Error('Invalid DeVert radio ad vote');
      }
      const existing = journal.adVotes.find(entry => entry.radioPlayId === radioPlayId && entry.voterId === voterId);
      if (existing) return { campaignId: existing.campaignId, radioPlayId, vote: existing.vote, duplicate: true };
      const entry = { campaignId: String(campaignId), radioPlayId, voterId, vote, recordedAt: new Date(now()).toISOString() };
      await commit({ ...journal, adVotes: [...journal.adVotes, entry].slice(-MAX_SAVED_IDS) });
      return { campaignId: entry.campaignId, radioPlayId, vote, duplicate: false };
    }),
    async nextDevertLoopAd({ excludeCampaignIds = [] } = {}) {
      requireReady();
      await retryPendingImpressions({ force: Boolean(workerGasState?.lowBalance || workerGasState?.unavailable) });
      const snapshot = await readCampaigns();
      if (snapshot.chainId !== 8453 || snapshot.paused || !Array.isArray(snapshot.campaigns)) return null;
      const nowMs = Date.parse(snapshot.snapshotAt);
      const excluded = new Set(excludeCampaignIds.map(String));
      const campaign = snapshot.campaigns.filter(item => {
        const start = Date.parse(item.startedAt);
        const end = Date.parse(item.expiresAt);
        return start <= nowMs && nowMs < end && !excluded.has(String(item.campaignId));
      }).sort((first, second) => Number(second.djukeBoosts || 0) - Number(first.djukeBoosts || 0) ||
        Number(first.devertPlays || 0) - Number(second.devertPlays || 0) ||
        (BigInt(second.offerUnits) > BigInt(first.offerUnits) ? 1 : BigInt(second.offerUnits) < BigInt(first.offerUnits) ? -1 :
          String(first.campaignId).localeCompare(String(second.campaignId))));
      return campaign[0] ? { campaignId: String(campaign[0].campaignId), mainRadio: false,
        track: campaignTrack(campaign[0], 'devert-loop') } : null;
    },
    recordCampaignImpression: ({ campaignId, radioPlayId, mainRadio, audibleMs }) => run(async () => {
      requireReady();
      if (!Number.isSafeInteger(audibleMs) || audibleMs < minimumAudibleMs) return false;
      if (!/^\d+$/.test(String(campaignId)) || typeof radioPlayId !== 'string' || !radioPlayId) throw new Error('Invalid DeVert impression identity');
      const impressionId = id(`devert-impression:${campaignId}:${radioPlayId}:${mainRadio ? 'main' : 'broadcast'}`);
      let entry = journal.impressions.find(item => item.impressionId === impressionId);
      if (entry?.state === 'recorded') return true;
      if (!entry) {
        // VertLoop coalesces: at most one pending or recently recorded impression per campaign per window.
        if (mainRadio !== true) {
          const key = String(campaignId);
          const hasPending = journal.impressions.some(item => !item.mainRadio && item.state === 'pending' && item.campaignId === key);
          if (hasPending || (vertLoopNextRetryAtByCampaign.get(key) || 0) > now()) return false;
        }
        entry = { impressionId, campaignId: String(campaignId), mainRadio: mainRadio === true, radioPlayId,
          recordedAt: new Date(now()).toISOString(), state: 'pending', nextRetryAt: mainRadio === true ? 0
            : Math.max(vertLoopNextRetryAtByCampaign.get(String(campaignId)) || 0, now()) };
        await commit({ ...journal, impressions: [...journal.impressions, entry].slice(-MAX_SAVED_IDS) });
      }
      await submitImpression(entry);
      return true;
    }),
    getState: () => { requireReady(); return structuredClone(journal); },
    getWorkerGasState: async () => structuredClone(await refreshWorkerGasState()),
  };
}