import { id, isAddress } from 'ethers';
import { planDevertQueues } from '../js/devert-scheduler.mjs';

const SCHEMA_VERSION = 1;
const MUSIC_PLAYS_PER_MAIN_AD = 10;
const MUSIC_BATCH_SIZE = 10;
const MAX_SAVED_IDS = 2000;
const MIN_AUDIBLE_MS = 30_000;

function emptyJournal() {
  return { schemaVersion: SCHEMA_VERSION, musicWeekId: null, pendingMusicPlayIds: [], seenMusicPlayIds: [], impressions: [] };
}

function validateJournal(value) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION ||
    value.musicWeekId !== null && (!Number.isSafeInteger(value.musicWeekId) || value.musicWeekId < 0) ||
    !Array.isArray(value.pendingMusicPlayIds) || !Array.isArray(value.seenMusicPlayIds) || !Array.isArray(value.impressions)) {
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
  return structuredClone(value);
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
      const campaign = plan.mainRadio.find(item => !excluded.has(item.campaignId));
      return campaign ? { campaignId: campaign.campaignId, mainRadio: true, track: campaignTrack(campaign, 'main-radio') } : null;
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