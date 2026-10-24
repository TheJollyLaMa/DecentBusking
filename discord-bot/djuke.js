import { Contract, JsonRpcProvider, id, isAddress } from 'ethers';
import { quoteDjuke } from '../js/djuke.mjs';
import { validateCreatorSplits } from '../js/submission-media.mjs';

export const DJUKE_ABI = [
  'function headRequestId() view returns (uint256)',
  'function nextRequestId() view returns (uint256)',
  'function getRequest(uint256 requestId) view returns ((bytes32 songId,address payer,uint256 amount,bool fulfilled,uint256 revision,address[] recipients,uint16[] sharesBps))',
  'function getSong(bytes32 songId) view returns ((string audioURI,bool enabled,address[] recipients,uint16[] sharesBps))',
  'function fulfill(uint256 requestId, bytes32 expectedSongId, uint256 expectedRevision, bytes32 playbackProof)',
  'function playlistPendingCount() view returns (uint256)',
  'function playlistHeadId() view returns (uint256)',
  'function playlistNextId() view returns (uint256)',
  'function getPlaylistItem(uint256 laneId) view returns (uint256 batchId,bytes32 songId,address payer,uint256 amount,uint8 status)',
  'function fulfillPlaylistSong(uint256 laneId,bytes32 expectedSongId,uint256 expectedRevision,bytes32 playbackProof)',
  'function refundUndeliveredPlaylist(uint256 batchId)',
  'function registerSong(bytes32 songId, string audioURI, address[] recipients, uint16[] sharesBps)',
  'function multicall(bytes[] data) returns (bytes[] results)',
];
export const DJUKE_PLAYLIST_WORKER_ABI = [
  'function CONTRACT_VERSION() view returns(string)',
  'function FULFILLER_ROLE() view returns(bytes32)',
  'function hasRole(bytes32,address) view returns(bool)',
];
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export async function verifyDjukePlaylistWorker({ provider, contract, workerAddress, version = '0.4' }) {
  if (Number((await provider.getNetwork()).chainId) !== 8453) throw new Error('DJuke playlists are Base-only');
  if (!['0.4', '0.5'].includes(version) || await contract.CONTRACT_VERSION() !== version) throw new Error(`DJuke playlist worker requires contract v${version}`);
  if ((await contract.gasWorker()).toLowerCase() !== workerAddress.toLowerCase()) throw new Error('DJuke playlist gas worker does not match');
  if (!await contract.hasRole(await contract.FULFILLER_ROLE(), workerAddress)) throw new Error('DJuke playlist worker lacks the fulfiller role');
}

export function djukeCatalog(playlist) {
  return playlist.filter(track => !track.isDevertAd && track.ipfsCid && /^0x[0-9a-fA-F]{40}$/.test(track.mintRecipient || '') &&
    (track.source !== 'site' || track.mintStatus === 'minted'))
    .map(track => ({ songId: id(track.trackId), track }));
}

async function readSongWithRetry(contract, songId, options, attempts, retryDelayMs) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await contract.getSong(...(options === undefined ? [songId] : [songId, options]));
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts && retryDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, retryDelayMs * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

export function createDjukeFulfiller(contract) {
  return async ({ chainRequestId, playlistLaneId, songId, revision, playId }) => {
    const transaction = playlistLaneId !== undefined
      ? await contract.fulfillPlaylistSong(BigInt(playlistLaneId), songId, BigInt(revision), id(playId))
      : await contract.fulfill(BigInt(chainRequestId), songId, BigInt(revision), id(playId));
    const receipt = await transaction.wait();
    if (receipt?.status !== 1) throw new Error(`DJuke fulfillment failed: ${transaction.hash}`);
    return transaction.hash;
  };
}

export function createDjukeSongRegistrar({ contract, getPlaylist, batchSize = 25, concurrency = 5,
  readRetryAttempts = 3, readRetryDelayMs = 200, onRegistered = () => {}, log = console }) {
  const known = new Set();
  let running = null;
  async function sync() {
    const missing = [];
    const entries = djukeCatalog(getPlaylist()).filter(({ songId }) => !known.has(songId));
    let lookupErrors = 0;
    for (let start = 0; start < entries.length; start += concurrency) {
      await Promise.all(entries.slice(start, start + concurrency).map(async entry => {
        try {
          const song = await readSongWithRetry(contract, entry.songId, undefined, readRetryAttempts, readRetryDelayMs);
          if (!song.audioURI) missing.push(entry);
          else if (song.audioURI === `ipfs://${entry.track.ipfsCid}`) {
            if (entry.track.creatorSplits) {
              const splits = validateCreatorSplits(entry.track.creatorSplits, entry.track.mintRecipient);
              if (song.recipients?.length !== splits.length || splits.some((split, index) =>
                song.recipients[index]?.toLowerCase() !== split.wallet.toLowerCase() || Number(song.sharesBps?.[index]) !== split.shareBps)) {
                log.warn(`[djuke] ${entry.track.trackId} has different registered creator splits; admin review needed. Existing requests retain their on-chain splits.`);
              }
            }
            known.add(entry.songId);
          }
          else { known.add(entry.songId); log.warn(`[djuke] ${entry.track.trackId} is registered with different audio; admin review needed`); }
        } catch {
          lookupErrors++;
        }
      }));
    }
    if (lookupErrors) log.warn(`[djuke] Could not verify ${lookupErrors} song registration(s); retrying on the next scan.`);
    let registered = 0;
    for (let start = 0; start < missing.length; start += batchSize) {
      const batch = missing.slice(start, start + batchSize);
      const calls = batch.map(({ songId, track }) => {
        const splits = validateCreatorSplits(track.creatorSplits, track.mintRecipient);
        return contract.interface.encodeFunctionData('registerSong',
          [songId, `ipfs://${track.ipfsCid}`, splits.map(entry => entry.wallet), splits.map(entry => entry.shareBps)]);
      });
      const transaction = await contract.multicall(calls);
      if ((await transaction.wait())?.status !== 1) throw new Error(`DJuke song registration failed: ${transaction.hash}`);
      for (const { songId } of batch) known.add(songId);
      registered += batch.length;
      onRegistered(batch.map(entry => entry.songId));
      log.log(`[djuke] Registered ${batch.length} song(s) for DJuke: ${transaction.hash}`);
    }
    return registered;
  }
  return () => {
    running ||= sync().finally(() => { running = null; });
    return running;
  };
}

export function createDjukePlaybackJournal({ restore, save, now = () => Date.now() }) {
  if (typeof restore !== 'function' || typeof save !== 'function') throw new Error('Durable DJuke checkpoint storage is required');
  let records = [];
  let initialized = false;
  let task = Promise.resolve();
  const run = operation => {
    const result = task.then(operation);
    task = result.catch(() => {});
    return result;
  };
  const copy = value => structuredClone(value);
  async function commit(next) {
    const fulfilled = next.filter(entry => entry.state === 'fulfilled');
    const kept = next.filter(entry => entry.state !== 'fulfilled' || fulfilled.indexOf(entry) >= fulfilled.length - 100);
    const uri = await save({ schemaVersion: 1, records: copy(kept) });
    if (typeof uri !== 'string' || !uri.startsWith('ipfs://')) throw new Error('DJuke checkpoint was not durable');
    records = kept;
  }
  const requireReady = () => { if (!initialized) throw new Error('DJuke journal is not restored'); };
  const update = (requestId, change) => run(async () => {
    requireReady();
    const next = copy(records);
    const record = next.find(entry => entry.requestId === requestId);
    if (!record) throw new Error('Unknown paid DJuke request');
    change(record);
    await commit(next);
    return copy(record);
  });
  return {
    initialize: () => run(async () => {
      const snapshot = await restore();
      if (snapshot && (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.records))) throw new Error('Invalid DJuke journal checkpoint');
      const next = copy(snapshot?.records || []);
      const seen = new Set();
      for (const record of next) {
        if (typeof record.requestId !== 'string' || !record.requestId || seen.has(record.requestId) ||
          !['pending', 'playing', 'played', 'fulfilled'].includes(record.state) ||
          (record.mediaFailures !== undefined && (!Number.isSafeInteger(record.mediaFailures) || record.mediaFailures < 0))) throw new Error('Invalid DJuke journal record');
        seen.add(record.requestId);
        if (record.state === 'playing') record.state = 'pending';
      }
      await commit(next);
      initialized = true;
    }),
    synchronize: (requests, { preserveMissing = () => false } = {}) => run(async () => {
      requireReady();
      const next = copy(records);
      const seen = new Set();
      for (const request of requests) {
        if (!request || typeof request.requestId !== 'string' || !request.requestId ||
          typeof request.trackId !== 'string' || !request.trackId || seen.has(request.requestId)) throw new Error('Invalid verified DJuke request');
        seen.add(request.requestId);
        const existing = next.find(entry => entry.requestId === request.requestId);
        const fields = {
          chainRequestId: request.chainRequestId,
          songId: request.songId,
          revision: request.revision,
          trackId: request.trackId,
          payer: request.payer,
          amountUnits: request.amountUnits,
          ...(request.tier !== undefined ? { tier: request.tier } : {}),
          ...(request.campaignId !== undefined ? { campaignId: String(request.campaignId) } : {}),
          ...(request.playlistLaneId !== undefined ? { playlistLaneId: String(request.playlistLaneId) } : {}),
          ...(request.playlistBatchId !== undefined ? { playlistBatchId: String(request.playlistBatchId) } : {}),
          ...(request.playlist ? { playlist: structuredClone(request.playlist) } : {}),
        };
        if (!existing) next.push({ requestId: request.requestId, ...fields, state: 'pending', attempts: 0 });
        else if (existing.state !== 'fulfilled') {
          const recordingChanged = existing.trackId !== request.trackId || existing.revision !== request.revision;
          Object.assign(existing, fields);
          if (recordingChanged) {
            existing.state = 'pending';
            delete existing.playId;
          }
        }
      }
      for (const record of next) {
        if (record.state !== 'fulfilled' && !seen.has(record.requestId) && !await preserveMissing(record)) {
          record.state = 'fulfilled';
        }
      }
      if (JSON.stringify(next) !== JSON.stringify(records)) await commit(next);
    }),
    peek: () => { requireReady(); const record = records.find(entry => entry.state !== 'fulfilled'); return record ? copy(record) : null; },
    peekPending: () => { requireReady(); const record = records.find(entry => entry.state === 'pending'); return record ? copy(record) : null; },
    resetPlayed: requestId => update(requestId, record => {
      if (record.state !== 'played') throw new Error('DJuke request has no completed playback');
      record.state = 'pending';
      delete record.playId;
    }),
    acquire: () => run(async () => {
      requireReady();
      const next = copy(records);
      const record = next.find(entry => entry.state !== 'fulfilled');
      if (!record || record.state !== 'pending') return null;
      record.state = 'playing';
      record.attempts++;
      record.startedAt = new Date(now()).toISOString();
      await commit(next);
      return copy(record);
    }),
    reserveNext: requestId => run(async () => {
      requireReady();
      const next = copy(records);
      const record = next.find(entry => entry.state === 'pending' && (requestId === undefined || entry.requestId === requestId));
      if (!record) return null;
      record.state = 'playing';
      record.attempts++;
      record.startedAt = new Date(now()).toISOString();
      await commit(next);
      return copy(record);
    }),
    fail: (requestId, error, { mediaFailure = false, media = null } = {}) => update(requestId, record => {
      if (record.state !== 'playing') throw new Error('DJuke request is not playing');
      record.state = 'pending';
      record.lastError = String(error || 'Playback failed');
      if (mediaFailure) {
        record.mediaFailures = (record.mediaFailures || 0) + 1;
        record.lastMediaError = record.lastError;
        record.lastMediaFailureAt = new Date(now()).toISOString();
        if (media) record.lastMedia = copy(media);
        else delete record.lastMedia;
      }
    }),
    complete: (requestId, { playId, audibleMs, finished, trackId, revision }) => update(requestId, record => {
      if (record.state !== 'playing' || (trackId !== undefined && (record.trackId !== trackId || record.revision !== revision))) {
        throw new Error('DJuke request is not playing that recording');
      }
      if (finished !== true || typeof playId !== 'string' || !playId ||
        !Number.isSafeInteger(audibleMs) || audibleMs <= 0) throw new Error('Completed audible playback evidence required');
      if (records.some(entry => entry.requestId !== requestId && entry.playId === playId)) throw new Error('Playback evidence already used');
      record.state = 'played';
      record.playId = playId;
      record.audibleMs = audibleMs;
    }),
    confirmFulfilled: requestId => update(requestId, record => {
      if (record.state !== 'played') throw new Error('DJuke request has no completed playback');
      record.state = 'fulfilled';
    }),
    getState: () => { requireReady(); return copy(records); },
  };
}

export function createDjukeQueueReader({ rpcUrl, contractAddress, getPlaylist, provider, contract, confirmations = 2,
  playlistLaneEnabled = false, paymentsEnabled = false, songCacheMs = 300000, concurrency = 5, readRetryAttempts = 3,
  readRetryDelayMs = 200, now = () => Date.now(), log = console, getPlaylistBatches = () => [] }) {
  if (!isAddress(contractAddress) || /^0x0{40}$/i.test(contractAddress)) throw new Error('Invalid DJuke contract address');
  if (!Number.isSafeInteger(confirmations) || confirmations < 2) throw new Error('DJuke needs at least two confirmations');
  const rpc = provider || new JsonRpcProvider(rpcUrl);
  const jukebox = contract || new Contract(contractAddress, DJUKE_ABI, rpc);
  const registrations = new Map();
  let task = null;
  async function registeredSongs(entries, options) {
    const stale = entries.filter(({ songId }) => !(now() - (registrations.get(songId)?.at ?? -Infinity) < songCacheMs));
    let lookupErrors = 0;
    for (let start = 0; start < stale.length; start += concurrency) {
      await Promise.all(stale.slice(start, start + concurrency).map(async ({ songId }) => {
        try {
          const song = await readSongWithRetry(jukebox, songId, options, readRetryAttempts, readRetryDelayMs);
          registrations.set(songId, { at: now(), song });
        } catch {
          lookupErrors++;
        }
      }));
    }
    if (lookupErrors) log.warn(`[djuke] Could not verify ${lookupErrors} song registration(s); omitting them from this snapshot.`);
    const tracks = entries.filter(({ songId, track }) => {
      const song = registrations.get(songId)?.song;
      return song?.enabled && song.audioURI === `ipfs://${track.ipfsCid}`;
    }).map(({ songId, track }) => ({ songId, trackId: track.trackId, title: track.title, ipfsCid: track.ipfsCid,
      artist: track.uploader || track.mintRecipient, creator: track.mintRecipient }));
    return { tracks, lookupErrors };
  }
  async function readSnapshot() {
    if (Number((await rpc.getNetwork()).chainId) !== 8453) throw new Error('DJuke is Base-only');
    const blockNumber = await rpc.getBlockNumber() - confirmations + 1;
    if (blockNumber < 0) throw new Error('DJuke confirmation block unavailable');
    const before = await rpc.getBlock(blockNumber);
    if (!before?.hash) throw new Error('DJuke confirmation block unavailable');
    const options = { blockTag: blockNumber };
    const [headValue, nextValue] = await Promise.all([jukebox.headRequestId(options), jukebox.nextRequestId(options)]);
    const head = Number(headValue);
    const next = Number(nextValue);
    if (![head, next].every(value => Number.isSafeInteger(value) && value >= 0) || next < head || next - head > 128) {
      throw new Error('DJuke queue needs a bounded complete snapshot');
    }
    const playlist = getPlaylist();
    const entries = djukeCatalog(playlist);
    const catalog = new Map(entries.map(({ songId, track }) => [songId, track]));
    const songs = new Map();
    const getSong = async songId => {
      if (!songs.has(songId)) songs.set(songId, await readSongWithRetry(jukebox, songId, options, readRetryAttempts, readRetryDelayMs));
      return songs.get(songId);
    };
    const requests = [];
    for (let requestId = head; requestId < next; requestId++) {
      const request = await jukebox.getRequest(requestId, options);
      if (request.fulfilled || !isAddress(request.payer) || request.amount <= 0n) throw new Error('Invalid pending DJuke request');
      const song = await getSong(request.songId);
      const track = catalog.get(request.songId);
      const mapped = track && song.audioURI === `ipfs://${track.ipfsCid}`;
      requests.push({ requestId: `8453:${contractAddress.toLowerCase()}:${requestId}`,
        chainRequestId: String(requestId), songId: request.songId,
        revision: String(request.revision),
        trackId: mapped ? track.trackId : `djuke:${request.songId}`,
        title: mapped ? track.title : 'Paid recording awaiting catalog recovery',
        artist: mapped ? track.uploader || track.mintRecipient : '',
        payer: request.payer, amountUnits: request.amount.toString(), playable: !!mapped });
    }
    const mainPending = requests.length;
    let playlistPending = 0;
    if (playlistLaneEnabled) {
      const [laneHead, laneNext, lanePending] = await Promise.all([jukebox.playlistHeadId(options), jukebox.playlistNextId(options), jukebox.playlistPendingCount(options)]);
      playlistPending = Number(lanePending);
      const start = Number(laneHead), end = Number(laneNext);
      if (![start, end, playlistPending].every(value => Number.isSafeInteger(value) && value >= 0) || end < start || playlistPending > end - start) throw new Error('DJuke playlist lane needs a bounded complete snapshot');
      for (let laneId = start; laneId < Math.min(end, start + 1); laneId++) {
        const item = await jukebox.getPlaylistItem(laneId, options);
        if (Number(item.status) !== 0) continue;
        if (!isAddress(item.payer) || item.amount <= 0n) throw new Error('Invalid pending DJuke playlist item');
        const song = await getSong(item.songId);
        const track = catalog.get(item.songId);
        const mapped = track && song.audioURI === `ipfs://${track.ipfsCid}`;
        requests.push({ requestId: `8453:${contractAddress.toLowerCase()}:playlist:${laneId}`,
          playlistLaneId: String(laneId), playlistBatchId: String(item.batchId), songId: item.songId,
          revision: '0', trackId: mapped ? track.trackId : `djuke:${item.songId}`,
          title: mapped ? track.title : 'Playlist recording awaiting catalog recovery',
          artist: mapped ? track.uploader || track.mintRecipient : '', payer: item.payer,
          amountUnits: item.amount.toString(), playable: !!mapped });
      }
    }
    const { tracks, lookupErrors: catalogReadErrors } = await registeredSongs(entries, options);
    if ((await rpc.getBlock(blockNumber))?.hash !== before.hash) throw new Error('DJuke snapshot changed during verification');
    const playlistReceipts = getPlaylistBatches();
    const playlistBatches = playlistReceipts.filter(batch => !['settled', 'refunded'].includes(batch.status));
    for (const request of requests) if (request.playlistBatchId !== undefined) {
      const batch = playlistBatches.find(batch => batch.batchId === request.playlistBatchId);
      if (batch) request.playlist = { batchId: batch.batchId, name: batch.name,
        songCount: batch.songs.length, remaining: batch.songs.filter(song => song.status === 'pending').length };
    }
    const quote = quoteDjuke(mainPending + playlistPending);
    return { chainId: 8453, contractAddress, usdcAddress: BASE_USDC, blockNumber, blockHash: before.hash,
      requests, mainPending, playlistPending, playlistBatches, playlistReceipts, tracks, catalogReadErrors, priceUnits: quote.priceUnits.toString(), paymentsEnabled };
  }
  const read = () => {
    if (!task) task = readSnapshot().finally(() => { task = null; });
    return task;
  };
  read.invalidate = songIds => { for (const songId of songIds) registrations.delete(songId); };
  return read;
}

export function createDjukeRuntime({ readState, journal, fulfill, getTrack, onVerifiedRequests, selectRequest, refundPlaylistBatch,
  preserveMissingRequest = () => false, canPlayRequest = () => true,
  minAudibleMs = 30000, timeoutMs = 10000, log = console }) {
  let initialized = null;
  let settling = Promise.resolve();
  let claimSerial = Promise.resolve();
  let pendingClaim = null;
  let restored = false;
  let pendingPlaylistCount = 0;
  const ready = () => { initialized ||= journal.initialize().then(() => { restored = true; })
    .catch(error => { initialized = null; throw error; }); return initialized; };
  const settleSerial = state => { const run = settling.then(() => settle(state)); settling = run.catch(() => {}); return run; };
  async function settle(state) {
    for (const record of journal.getState().filter(entry => entry.state === 'played')) {
      const request = state.requests.find(entry => entry.requestId === record.requestId);
      if (!request) {
        if (await preserveMissingRequest(record, state)) {
          log.warn(`[djuke] Played request ${record.requestId} is missing from the queue but remains refundable; preserving its checkpoint.`);
          return;
        }
        await journal.confirmFulfilled(record.requestId);
        continue;
      }
      if (request.playlistLaneId !== undefined && state.requests.some(entry => entry.playlistLaneId === undefined)) continue;
      try {
        const started = Date.now();
        await fulfill({ playlistLaneId: request.playlistLaneId, chainRequestId: request.chainRequestId, songId: record.songId, revision: record.revision, playId: record.playId });
        await journal.confirmFulfilled(record.requestId);
        log.info?.(`[djuke] Settlement confirmed ${record.requestId}; settlementAndCheckpointMs=${Date.now() - started}`);
      } catch (error) {
        if (/Paid recording changed/.test(error.shortMessage || error.message)) await journal.resetPlayed(record.requestId);
        else { log.warn(`[djuke] Fulfillment pending for ${record.requestId}: ${error.shortMessage || error.message}`); return; }
      }
    }
  }
  async function reconcile() {
    await ready();
    const state = await readState();
    pendingPlaylistCount = state.playlistPending ?? state.requests.filter(request => request.playlistLaneId !== undefined).length;
    if (onVerifiedRequests) Promise.resolve().then(() => onVerifiedRequests(state))
      .catch(error => log.warn(`[djuke] Confirmed-request hook deferred: ${error.message}`));
    await journal.synchronize(state.requests, { preserveMissing: record => preserveMissingRequest(record, state) });
    await settleSerial(state);
    return state;
  }
  async function claim(options) {
    const state = await reconcile();
    const pending = journal.getState().filter(record => record.state === 'pending');
    const main = state.requests.filter(request => request.playlistLaneId === undefined);
    const eligible = main.length ? main : state.requests.slice(0, 1);
    const candidates = pending.filter(record => eligible.some(request => request.requestId === record.requestId));
    const head = selectRequest ? selectRequest(state, candidates, options)
      : candidates.sort((a, b) => eligible.findIndex(request => request.requestId === a.requestId) - eligible.findIndex(request => request.requestId === b.requestId))[0];
    if (!head) return null;
    const request = state.requests.find(entry => entry.requestId === head.requestId);
    if (!request || !await canPlayRequest(request, state)) return null;
    if (request.playlistBatchId !== undefined && head.mediaFailures >= 4) {
      if (!refundPlaylistBatch) throw new Error('Playlist media retries exhausted but the refund handler is unavailable');
      await refundPlaylistBatch(request.playlistBatchId);
      return null;
    }
    const track = request?.playable ? getTrack(request.trackId) : null;
    if (!track) {
      if (request?.playlistBatchId && refundPlaylistBatch) {
        await refundPlaylistBatch(request.playlistBatchId);
        return null;
      }
      throw new Error(`Paid DJuke request ${head.requestId} is not playable`);
    }
    const record = await journal.reserveNext(head.requestId);
    return record ? { record, track } : null;
  }
  async function nextPaid(options) {
    pendingClaim ||= claim(options);
    const pending = pendingClaim;
    let timer;
    const timedOut = Symbol('timeout');
    let result;
    try {
      result = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(timedOut), timeoutMs); })]);
    } catch (error) {
      pendingClaim = null;
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (result === timedOut) throw new Error('DJuke queue check timed out; durable selection remains in progress');
    pendingClaim = null;
    return result;
  }
  async function retryMedia(record, error, media = null) {
    if (record.playlistBatchId === undefined) throw new Error('Bounded media retries require a radio playlist request');
    const updated = await journal.fail(record.requestId, error?.message || String(error), { mediaFailure: true, media });
    const maxRetries = 3;
    if (updated.mediaFailures <= maxRetries) {
      log.warn(`[djuke] Playlist ${record.playlistBatchId} lane ${record.playlistLaneId}: media retry ${updated.mediaFailures}/${maxRetries}; payment stays queued (${updated.lastError}).`);
      return { retrying: true, retryNumber: updated.mediaFailures, maxRetries };
    }
    if (!refundPlaylistBatch) throw new Error('Playlist media retries exhausted but the refund handler is unavailable');
    log.warn(`[djuke] Playlist ${record.playlistBatchId} lane ${record.playlistLaneId}: media retries exhausted; refunding undelivered songs and refundable fee.`);
    await refundPlaylistBatch(record.playlistBatchId);
    return { retrying: false, retryNumber: maxRetries, maxRetries };
  }
  return {
    nextPaid(options) {
      const run = claimSerial.then(() => nextPaid(options));
      claimSerial = run.catch(() => {});
      return run;
    },
    async complete(record, play) {
      if (record.playlistBatchId !== undefined && (!play || play.finished !== true || play.audibleMs < minAudibleMs)) {
        const reason = !play ? 'audio_evidence_missing'
          : play.finished !== true ? play.media?.reason || 'audio_stream_incomplete' : 'insufficient_audible_time';
        return retryMedia(record, new Error(`Playlist recording did not finish audibly (${reason})`),
          play?.media ? { ...play.media, reason } : null);
      }
      if (!play || play.audibleMs < minAudibleMs) {
        await journal.fail(record.requestId, 'Paid play was not audible long enough');
        if (record.playlistBatchId && refundPlaylistBatch) await refundPlaylistBatch(record.playlistBatchId);
        return;
      }
      const started = Date.now();
      await journal.complete(record.requestId, { playId: play.playId, audibleMs: play.audibleMs, finished: true,
        trackId: record.trackId, revision: record.revision });
      log.info?.(`[djuke] Playback checkpoint confirmed ${record.requestId}; checkpointMs=${Date.now() - started}`);
      readState().then(settleSerial).catch(error => log.warn(`[djuke] Fulfillment deferred: ${error.message}`));
    },
    async fail(record, error) {
      await journal.fail(record.requestId, error?.message || String(error));
      if (record.playlistBatchId && refundPlaylistBatch) await refundPlaylistBatch(record.playlistBatchId);
    },
    release(record, error) {
      return journal.fail(record.requestId, error?.message || String(error));
    },
    retryMedia,
    hasPendingPlaylist() {
      return restored && (pendingPlaylistCount > 0 ||
        journal.getState().some(record => record.playlistBatchId !== undefined && record.state !== 'fulfilled'));
    },
    async canPlay(record) {
      const state = await readState();
      const requests = state.requests;
      const eligible = requests.some(request => request.playlistLaneId === undefined)
        ? requests.filter(request => request.playlistLaneId === undefined) : requests.slice(0, 1);
      const request = eligible.find(request => request.requestId === record.requestId);
      return Boolean(request && request.playable && request.trackId === record.trackId &&
        request.revision === record.revision && await canPlayRequest(request, state));
    },
    reconcile,
    getJournalState: () => journal.getState(),
  };
}