import { id, isAddress } from 'ethers';
import { planDevertQueues } from '../js/devert-scheduler.mjs';

const SCHEMA_VERSION = 1;
const MUSIC_PLAYS_PER_MAIN_AD = 10;
const MUSIC_BATCH_SIZE = 10;
const MAX_SAVED_IDS = 2000;
const MIN_AUDIBLE_MS = 30_000;
const INITIAL_RESTORE_RETRY_MS = 5_000;
const MAX_RESTORE_RETRY_MS = 5 * 60_000;

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
      typeof entry.mainRadio !== 'boolean') throw new Error('Invalid DeVert impression journal entry');
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
  readCampaigns, now = () => Date.now(), minimumAudibleMs = MIN_AUDIBLE_MS, log = console }) {
  if (!contract || typeof restore !== 'function' || typeof save !== 'function' || typeof readCampaigns !== 'function') {
    throw new Error('DeVert playback requires a contract and durable journal store');
  }
  if (!provider || !isAddress(contract.target)) throw new Error('DeVert playback needs a Base provider and contract');
  let journal = emptyJournal();
  let initialized = false;
  let queue = Promise.resolve();

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

  async function flushMusicBatch() {
    if (journal.pendingMusicPlayIds.length < MUSIC_BATCH_SIZE) return false;
    const block = await provider.getBlock('latest');
    const chainWeek = Number(await contract.campaignWeek(block.timestamp));
    if (chainWeek !== journal.musicWeekId) {
      await commit({ ...journal, musicWeekId: chainWeek, pendingMusicPlayIds: [] });
      return false;
    }
    const batch = journal.pendingMusicPlayIds.slice(0, MUSIC_BATCH_SIZE);
    await contract.reportCompletedMusicPlays.staticCall(batch);
    const transaction = await contract.reportCompletedMusicPlays(batch);
    if ((await transaction.wait(2))?.status !== 1) throw new Error(`DeVert music-play report failed: ${transaction.hash}`);
    await commit({ ...journal, pendingMusicPlayIds: journal.pendingMusicPlayIds.slice(batch.length) });
    return true;
  }

  async function submitImpression(entry) {
    if (entry.state === 'recorded') return entry;
    if (await contract.usedImpressionIds(entry.impressionId)) {
      const next = { ...journal, impressions: journal.impressions.map(item => item.impressionId === entry.impressionId ? { ...item, state: 'recorded' } : item) };
      await commit(next);
      return next.impressions.find(item => item.impressionId === entry.impressionId);
    }
    await contract.recordCampaignPlay.staticCall(BigInt(entry.campaignId), entry.mainRadio, entry.impressionId);
    const transaction = await contract.recordCampaignPlay(BigInt(entry.campaignId), entry.mainRadio, entry.impressionId);
    if ((await transaction.wait(2))?.status !== 1) throw new Error(`DeVert impression failed: ${transaction.hash}`);
    const next = { ...journal, impressions: journal.impressions.map(item => item.impressionId === entry.impressionId
      ? { ...item, state: 'recorded', transactionHash: transaction.hash } : item) };
    await commit(next);
    return next.impressions.find(item => item.impressionId === entry.impressionId);
  }

  async function retryPendingImpressions() {
    for (const entry of journal.impressions.filter(item => item.state === 'pending')) await submitImpression(entry);
  }

  function campaignTrack(campaign, kind) {
    const ipfsCid = campaign.audioURI.slice('ipfs://'.length);
    return { campaignId: campaign.campaignId, source: 'devert', kind, trackId: `devert:${campaign.campaignId}`,
      title: campaign.title, uploader: 'DeVert advertiser', filename: `devert-${campaign.campaignId}.mp3`,
      mediaType: 'audio/mpeg', ipfsCid, pinStatus: 'untracked' };
  }

  return {
    initialize: () => run(async () => {
      const restored = await restore();
      journal = restored ? validateJournal(restored) : emptyJournal();
      initialized = true;
      while (journal.pendingMusicPlayIds.length >= MUSIC_BATCH_SIZE) {
        try { await flushMusicBatch(); }
        catch (error) { log.warn(`[devert] Music-play report retry deferred: ${error.message}`); break; }
      }
      for (const entry of journal.impressions.filter(item => item.state === 'pending')) {
        await submitImpression(entry).catch(error => log.warn(`[devert] Impression retry deferred: ${error.message}`));
      }
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
      await flushMusicBatch();
      return true;
    }),
    async nextMainRadioAd({ excludeCampaignIds = [] } = {}) {
      requireReady();
      await retryPendingImpressions();
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
      const campaign = plan.mainRadio.filter(item => !excluded.has(item.campaignId))
        .sort((first, second) => (voteScores.get(second.campaignId) || 0) - (voteScores.get(first.campaignId) || 0))[0];
      return campaign ? { campaignId: campaign.campaignId, mainRadio: true, track: campaignTrack(campaign, 'main-radio') } : null;
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
      await retryPendingImpressions();
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
        entry = { impressionId, campaignId: String(campaignId), mainRadio: mainRadio === true, radioPlayId,
          recordedAt: new Date(now()).toISOString(), state: 'pending' };
        await commit({ ...journal, impressions: [...journal.impressions, entry].slice(-MAX_SAVED_IDS) });
      }
      await submitImpression(entry);
      return true;
    }),
    getState: () => { requireReady(); return structuredClone(journal); },
  };
}