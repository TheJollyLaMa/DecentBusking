import { Contract, id, isAddress } from 'ethers';
import { devertQueueAbi, DEVERT_QUEUE_USDC, quoteDevertRequest } from '../js/devert-queue.mjs';
import { createDjukePlaybackJournal, createDjukeRuntime } from './djuke.js';

export function createDevertQueueCatalogSync({ contract, removals, readCampaigns, resolveApprovedMedia, beforeRemove = async () => {} }) {
  const confirmedRemovals = new Set();
  const confirmedApprovals = new Set();
  let task;
  const reconcile = async () => {
    for (const { campaignId } of removals.list()) {
      if (confirmedRemovals.has(campaignId)) continue;
      await beforeRemove(campaignId);
      if (!await contract.removedCampaigns(BigInt(campaignId))) {
        const tx = await contract.removeCampaign(BigInt(campaignId));
        if ((await tx.wait(2))?.status !== 1) throw new Error(`Paid advert removal failed: ${tx.hash}`);
      }
      confirmedRemovals.add(campaignId);
    }
    const catalog = await readCampaigns();
    for (const campaign of catalog.campaigns) {
      if (campaign.removed || confirmedRemovals.has(campaign.campaignId) || confirmedApprovals.has(campaign.campaignId)) continue;
      const cid = campaign.audioURI?.startsWith('ipfs://') ? campaign.audioURI.slice(7) : '';
      if (!cid || !resolveApprovedMedia(campaign, cid)) continue;
      if (await contract.removedCampaigns(BigInt(campaign.campaignId))) {
        confirmedRemovals.add(campaign.campaignId);
        continue;
      }
      if (!await contract.approvedCampaigns(BigInt(campaign.campaignId))) {
        const tx = await contract.approveCampaign(BigInt(campaign.campaignId));
        if ((await tx.wait(2))?.status !== 1) throw new Error(`Paid advert approval failed: ${tx.hash}`);
      }
      confirmedApprovals.add(campaign.campaignId);
    }
    return [...confirmedApprovals].filter(campaignId => !confirmedRemovals.has(campaignId));
  };
  return () => { task ||= reconcile().finally(() => { task = null; }); return task; };
}

export function paidAdvertTrack(request, resolveCampaignMedia = () => null) {
  const cid = request.audioURI?.startsWith('ipfs://') ? request.audioURI.slice(7) : '';
  if (!cid || /[?#\s]/.test(cid)) throw new Error('Paid advert has an invalid IPFS recording');
  const media = resolveCampaignMedia(request, cid);
  const mediaType = media?.mediaType || '';
  return { trackId: `devert-paid:${request.chainRequestId}`, campaignId: request.campaignId,
    title: request.title, ipfsCid: cid, uploader: 'DeVert advertiser', advertiser: request.advertiser,
    filename: media?.filename || 'paid-ad.mp3', mediaType,
    videoUrl: media?.videoUrl || (mediaType === 'video/mp4' ? request.audioURI : ''), isDevertAd: true,
    paidTier: request.tier ?? 1 };
}

export function createDevertQueueReader({ provider, contractAddress, contract, paymentsEnabled = false,
  getApprovedCampaignIds = () => [], getPlaybackStatus = () => ({ ready: true, reason: null }), cacheMs = 0, version = 1 }) {
  if (!isAddress(contractAddress) || /^0x0{40}$/i.test(contractAddress)) throw new Error('Invalid paid advert queue address');
  const abi = devertQueueAbi(version);
  const queue = contract || new Contract(contractAddress, abi, provider);
  let task;
  let cached;
  let cachedAt = 0;
  const read = async () => {
    if (Number((await provider.getNetwork()).chainId) !== 8453) throw new Error('Paid advert queue is Base-only');
    const blockNumber = await provider.getBlockNumber() - 1;
    const before = await provider.getBlock(blockNumber);
    if (blockNumber < 0 || !before?.hash) throw new Error('Paid advert confirmation block unavailable');
    const options = { blockTag: blockNumber };
    if (version === 2 && Number(await queue.queueVersion(options)) !== 2) throw new Error('Paid advert queue version mismatch');
    const [headValue, nextValue, countValue, price, paused, token] = await Promise.all([
      queue.headRequestId(options), queue.nextRequestId(options), queue.pendingCount(options),
      queue.quote(options), queue.paused(options), queue.paymentToken(options),
    ]);
    const head = Number(headValue), next = Number(nextValue), pendingCount = Number(countValue);
    if (![head, next, pendingCount].every(n => Number.isSafeInteger(n) && n >= 0) ||
        next < head || next - head > 128 || pendingCount > next - head ||
        BigInt(price) !== quoteDevertRequest(pendingCount) || token.toLowerCase() !== DEVERT_QUEUE_USDC.toLowerCase()) {
      throw new Error('Invalid paid advert queue snapshot');
    }
    const requests = [], recentRefunds = [];
    const rows = [];
    for (let start = Math.max(0, head - 128); start < next; start += 8) {
      const ids = Array.from({ length: Math.min(8, next - start) }, (_, i) => start + i);
      rows.push(...await Promise.all(ids.map(async n => ({ n, raw: await queue.getRequest(n, options) }))));
    }
    const removed = new Map();
    const campaignIds = [...new Set(rows.map(({ raw }) => raw.campaignId.toString()))];
    for (let start = 0; start < campaignIds.length; start += 8) {
      await Promise.all(campaignIds.slice(start, start + 8).map(async campaignId => {
        removed.set(campaignId, await queue.removedCampaigns(campaignId, options));
      }));
    }
    for (const { n, raw } of rows) {
      const campaignId = raw.campaignId.toString();
      const tier = version === 1 ? 1 : Number(raw.tier);
      if (!isAddress(raw.payer) || !isAddress(raw.advertiser) || BigInt(raw.amount) <= 0n ||
          !raw.title || !raw.audioURI?.startsWith('ipfs://') || ![0, 1, 2].includes(Number(raw.status)) ||
          ![0, 1].includes(tier)) throw new Error('Invalid paid advert request');
      const request = { requestId: `8453:${contractAddress.toLowerCase()}:${n}`, chainRequestId: String(n),
        campaignId, payer: raw.payer, amountUnits: raw.amount.toString(), title: raw.title,
        audioURI: raw.audioURI, advertiser: raw.advertiser, songId: id(`devert-paid:${n}`),
        revision: '0', trackId: `devert-paid:${n}`, playable: true, tier };
      if (Number(raw.status) === 0) {
        if (removed.get(campaignId)) recentRefunds.push(request);
        else if (n >= head) requests.push(request);
        else throw new Error('Paid advert FIFO head is inconsistent');
      }
    }
    const approvedCampaignIds = [];
    const candidates = [...new Set(getApprovedCampaignIds())];
    for (let start = 0; start < candidates.length; start += 8) {
      const approved = await Promise.all(candidates.slice(start, start + 8).map(async campaignId =>
        await queue.approvedCampaigns(campaignId, options) && !await queue.removedCampaigns(campaignId, options) ? campaignId : null));
      approvedCampaignIds.push(...approved.filter(campaignId => campaignId !== null));
    }
    if (requests.length !== pendingCount || (await provider.getBlock(blockNumber))?.hash !== before.hash) throw new Error('Paid advert queue changed during verification');
    if (version === 2) {
      for (const tier of [0, 1]) {
        const [tierHead, tierPrice] = await Promise.all([
          queue.headRequestIdForTier(tier, options), queue.quoteForTier(tier, options),
        ]);
        const expectedHead = requests.find(request => request.tier === tier)?.chainRequestId ?? String(next);
        if (String(tierHead) !== expectedHead || BigInt(tierPrice) !== quoteDevertRequest(pendingCount, tier)) {
          throw new Error('Paid advert tier head or quote mismatch');
        }
      }
      if ((await provider.getBlock(blockNumber))?.hash !== before.hash) throw new Error('Paid advert queue changed during verification');
    }
    return { chainId: 8453, contractAddress, version, blockNumber, blockHash: before.hash, requests, recentRefunds, approvedCampaignIds,
      pendingCount, priceUnits: price.toString(), immediatePriceUnits: version === 2 ? (BigInt(price) * 2n).toString() : null,
      paused, paymentsEnabled: version === 2 && paymentsEnabled && !paused && next - head < 128 };
  };
  return async () => {
    let state;
    if (cached && Date.now() - cachedAt < cacheMs) state = structuredClone(cached);
    else {
      task ||= read().then(state => { cached = state; cachedAt = Date.now(); return state; }).finally(() => { task = null; });
      state = await task;
    }
    const playback = getPlaybackStatus();
    return { ...state, playbackReady: playback.ready, playbackReason: playback.reason,
      paymentsEnabled: state.paymentsEnabled && playback.ready };
  };
}

export function createDevertQueueRuntime({ readState, store, contract, isCampaignRemoved = () => false, resolveCampaignMedia, log = console }) {
  let tracks = new Map();
  const removingCampaigns = new Set();
  const readPlayable = async () => {
    const state = await readState();
    tracks = new Map(state.requests.map(request => [request.trackId, paidAdvertTrack(request, resolveCampaignMedia)]));
    return state;
  };
  const journal = createDjukePlaybackJournal(store);
  const runtime = createDjukeRuntime({ readState: readPlayable, journal,
    getTrack: trackId => tracks.get(trackId), minAudibleMs: 1000, log,
    preserveMissingRequest: async (record, state) => {
      if (!['playing', 'played'].includes(record.state)) return false;
      if (state.recentRefunds?.some(request => request.requestId === record.requestId)) return true;
      if (!/^\d+$/.test(record.chainRequestId || '')) return false;
      const request = await contract.getRequest(BigInt(record.chainRequestId));
      return Number(request.status) === 0 && await contract.removedCampaigns(request.campaignId);
    },
    canPlayRequest: (request, state) => !state.paused && !removingCampaigns.has(String(request.campaignId)) &&
      !isCampaignRemoved(request.campaignId),
    selectRequest: (state, pending, { allowBump = false } = {}) => {
      const eligible = state.requests.filter(request => !removingCampaigns.has(String(request.campaignId)) &&
        !isCampaignRemoved(request.campaignId) && pending.some(record => record.requestId === request.requestId));
      const request = eligible.find(request => (request.tier ?? 1) === 1) ||
        (allowBump ? eligible.find(request => request.tier === 0) : null);
      return request ? pending.find(record => record.requestId === request.requestId) : null;
    },
    fulfill: async ({ chainRequestId, playId }) => {
      const tx = await contract.fulfill(BigInt(chainRequestId), id(playId));
      if ((await tx.wait(2))?.status !== 1) throw new Error(`Paid advert settlement did not confirm: ${tx.hash}`);
      return tx.hash;
    } });
  let claimSerial = Promise.resolve();
  return {
    nextPaid(options) {
      const run = claimSerial.then(async () => {
        try {
          const selection = await runtime.nextPaid(options);
          if (selection) {
            selection.record.kind = 'devert';
            selection.record.tier = selection.track.paidTier;
          }
          return selection;
        } catch (error) {
          if (error.code === 'DEVERT_QUEUE_PAUSED') return null;
          throw error;
        }
      });
      claimSerial = run.catch(() => {});
      return run;
    },
    complete(record, play) {
      if (play?.finished !== true) return runtime.fail(record, new Error('Advert did not finish naturally; payment remains queued'));
      return runtime.complete(record, play);
    },
    fail: runtime.fail,
    release: runtime.release,
    async prepareCampaignRemoval(campaignId) {
      const id = String(campaignId);
      removingCampaigns.add(id);
      await claimSerial;
      const state = await runtime.reconcile();
      const refunds = new Map((state.recentRefunds || []).map(request => [request.requestId, request.campaignId]));
      const active = runtime.getJournalState().find(record =>
        (String(record.campaignId) === id || refunds.get(record.requestId) === id) &&
        (record.state === 'playing' || record.state === 'played'));
      if (active) throw new Error(`Campaign removal deferred until paid request ${active.requestId} finishes or settles`);
    },
    async canPlay(record) {
      const request = await contract.getRequest(BigInt(record.chainRequestId));
      if (record.tier === 0 && await contract.headRequestIdForTier(1) < await contract.nextRequestId()) return false;
      return Number(request.status) === 0 && !removingCampaigns.has(request.campaignId.toString()) &&
        !isCampaignRemoved(request.campaignId.toString()) &&
        !await contract.paused() && !await contract.removedCampaigns(request.campaignId);
    },
  };
}

export function combinePaidQueues({ songs, adverts, log = console, timeoutMs = 10000 }) {
  const selecting = new Set();
  const select = async (runtime, options, label) => {
    if (!runtime || selecting.has(runtime)) return null;
    selecting.add(runtime);
    let timedOut = false;
    let timer;
    const pending = Promise.resolve().then(() => runtime.nextPaid(options));
    pending.then(async selection => {
      if (timedOut && selection) {
        await runtime.release(selection.record, new Error('Queue selection completed after the radio moved on'));
      }
    }).catch(error => {
      if (timedOut) log.warn(`[${label}] Late queue selection/release failed: ${error.message}`);
    }).finally(() => selecting.delete(runtime));
    try {
      return await Promise.race([pending, new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('Queue selection timed out; music rotation continues'));
        }, timeoutMs);
      })]);
    } catch (error) {
      log.warn(`[${label}] Paid selection deferred: ${error.message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    async nextPaid({ allowBump = false, includeSongs = true } = {}) {
      if (adverts) {
        const ad = await select(adverts, { allowBump }, 'devert-queue');
        if (ad) return ad;
      }
      return includeSongs ? select(songs, undefined, 'djuke') : null;
    },
    complete(record, play) { return (record.kind === 'devert' ? adverts : songs).complete(record, play); },
    fail(record, error) { return (record.kind === 'devert' ? adverts : songs).fail(record, error); },
    release(record, error) { return (record.kind === 'devert' ? adverts : songs).release(record, error); },
    canPlay(record) { return record.kind === 'devert' ? adverts.canPlay(record) : true; },
  };
}
