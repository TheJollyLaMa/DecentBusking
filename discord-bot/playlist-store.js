// discord-bot/playlist-store.js
// Persistent playlist store for JukeLoop.
//
// Tracks are sourced from the #DecentJukebox text channel. Each entry stores
// the Discord message ID and channel ID so that the attachment URL can always
// be re-fetched (Discord CDN URLs carry expiring tokens).
//
// Ratings accumulate from 👍 / 👎 reactions collected after each play and are
// used to compute a weight for the weighted-random shuffle so popular tracks
// play more often.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = process.env.JUKELOOP_PLAYLIST_PATH || join(__dirname, 'jukeloop-playlist.json');
const MIN_WEEKLY_PLAY_MS = 30_000;
const NEW_TRACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function getUtcWeekKey(date = new Date()) {
  const day = new Date(date);
  day.setUTCHours(0, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const year = day.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((day - yearStart) / 86400000) + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * @typedef {Object} TrackEntry
 * @property {string} trackId    - Stable playlist identity (Discord attachment ID when available)
 * @property {string} messageId  - Discord message ID of the original upload
 * @property {string} [attachmentId] - Discord attachment ID
 * @property {string} channelId  - Discord channel ID where the file was posted
 * @property {string} filename   - Original attachment filename (e.g. "song.mp3")
 * @property {string} title      - Human-readable title (filename without extension)
 * @property {string} uploader   - Discord username/tag of the uploader
 * @property {string} uploaderId - Discord user ID of the uploader
 * @property {'pending'|'pinned'|'failed'|'disabled'|'untracked'} pinStatus
 * @property {string} [ipfsCid]  - Raw audio CID after a successful pin
 * @property {string} [pinError] - Last IPFS pin error, when pinStatus is failed
 * @property {'unminted'|'requested'|'minted'} mintStatus
 * @property {string} [mintRecipient] - Artist wallet requested as the mint and royalty recipient
 * @property {string} [mintRequestedAt] - ISO-8601 request timestamp
 * @property {string} [artworkCid] - Artist-supplied NFT artwork CID
 * @property {string} [tokenId] - On-chain token ID after owner approval
 * @property {string} [mintTxHash] - Product mint transaction hash
 * @property {number} likes      - Cumulative 👍 reactions counted across all plays
 * @property {number} dislikes   - Cumulative 👎 reactions counted across all plays
 * @property {number} plays      - Total number of times the track has been played
 * @property {string[]} [ratedMessageIds] - Discord announcements already included in totals
 * @property {string} addedAt    - ISO-8601 timestamp when the track was first added
 */

/** @type {TrackEntry[]} */
let _playlist = [];
let _remoteSaver = null;
let _remoteSaveQueue = Promise.resolve();

// ── Persistence ───────────────────────────────────────────────────────────────

function _normalizePlaylist(playlist) {
  return playlist.map((track) => ({
    ...track,
    trackId: track.trackId || getTrackId(track),
    pinStatus: track.pinStatus || (track.ipfsCid ? 'pinned' : 'untracked'),
    mintStatus: track.mintStatus || 'unminted',
  }));
}

/** Load the playlist from a restored snapshot or the local runtime cache. */
export function loadPlaylist(restoredPlaylist = null) {
  if (Array.isArray(restoredPlaylist)) {
    _playlist = _normalizePlaylist(restoredPlaylist);
    console.log(`[playlist-store] Restored ${_playlist.length} track(s) from IPFS`);
    try {
      writeFileSync(STORE_PATH, JSON.stringify(_playlist, null, 2), 'utf8');
    } catch (err) {
      console.warn('[playlist-store] Could not refresh local playlist cache:', err.message);
    }
  } else if (existsSync(STORE_PATH)) {
    try {
      const raw = readFileSync(STORE_PATH, 'utf8');
      _playlist = _normalizePlaylist(JSON.parse(raw));
      console.log(`[playlist-store] Loaded ${_playlist.length} track(s) from ${STORE_PATH}`);
    } catch (err) {
      console.error('[playlist-store] Failed to parse playlist file, starting empty:', err.message);
      _playlist = [];
    }
  } else {
    _playlist = [];
  }
  return _playlist;
}

/** Configure the durable snapshot writer used after every mutation. */
export function configureRemotePersistence(saveSnapshot) {
  _remoteSaver = saveSnapshot;
  _remoteSaveQueue = Promise.resolve();
}

/** Wait until all queued remote snapshots have completed. */
export function waitForRemotePersistence() {
  return _remoteSaveQueue;
}

function _save() {
  try {
    writeFileSync(STORE_PATH, JSON.stringify(_playlist, null, 2), 'utf8');
  } catch (err) {
    console.error('[playlist-store] Failed to save playlist:', err.message);
  }
  if (_remoteSaver) {
    const snapshot = structuredClone(_playlist);
    _remoteSaveQueue = _remoteSaveQueue
      .then(() => _remoteSaver(snapshot))
      .catch((err) => console.error('[playlist-store] Failed to checkpoint playlist to IPFS:', err.message));
  }
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Return the stable identity for a playlist entry.
 * New Discord uploads use the attachment snowflake; legacy entries fall back
 * to message ID + filename so multiple attachments from one message survive.
 *
 * @param {{ attachmentId?: string, messageId: string, filename: string }} track
 * @returns {string}
 */
export function getTrackId(track) {
  return track.attachmentId || `${track.messageId}:${track.filename}`;
}

/**
 * Add a track to the playlist (idempotent — keyed on attachment identity).
 *
 * @param {Omit<TrackEntry, 'likes'|'dislikes'|'plays'|'addedAt'>} track
 * @returns {boolean} true if the track was newly added, false if already present
 */
export function addTrack(track) {
  const trackId = getTrackId(track);
  if (_playlist.some((existing) => existing.trackId === trackId)) return false;
  _playlist.push({
    ...track,
    trackId,
    mintStatus: track.mintStatus || 'unminted',
    likes:    0,
    dislikes: 0,
    plays:    0,
    addedAt:  new Date().toISOString(),
  });
  _save();
  return true;
}

export function submitMediaTrack({ address, title, artist, ipfsCid, mediaType, filename, recipient, artworkCid, tipWallet, parentTokenId }) {
  const trackId = `site:${address.toLowerCase()}:${ipfsCid}`;
  const existing = _playlist.find(track => track.trackId === trackId);
  if (existing) return existing;
  addTrack({ attachmentId: trackId, source: 'site', uploaderId: `wallet:${address.toLowerCase()}`,
    uploader: artist, title, ipfsCid, mediaType, filename, pinStatus: 'pinned', artworkCid,
    tipWallet: tipWallet || recipient, parentTokenId,
    mintStatus: 'requested', mintRecipient: recipient, mintRequestedAt: new Date().toISOString() });
  return _playlist.find(track => track.trackId === trackId);
}

/**
 * Persist the outcome of an IPFS pin attempt.
 * @param {string} trackId
 * @param {{ status: 'pending'|'pinned'|'failed'|'disabled'|'untracked', ipfsCid?: string, error?: string }} result
 * @param {{ save?: boolean }} [options] - Pass save:false when batching, then call savePlaylist()
 * @returns {TrackEntry|null}
 */
export function updateTrackPin(trackId, result, { save = true } = {}) {
  const track = _playlist.find((entry) => entry.trackId === trackId);
  if (!track) return null;

  track.pinStatus = result.status;
  if (result.ipfsCid) track.ipfsCid = result.ipfsCid;
  if (result.error) track.pinError = result.error;
  else delete track.pinError;
  if (save) _save();
  return track;
}

/** Persist batched mutations locally and to the remote checkpoint. */
export function savePlaylist() {
  _save();
}

/**
 * Mark tracks minted from on-chain DecentNFT records (audio CID → token ID),
 * so lost local state can never re-queue an existing NFT. Checkpoints once.
 * @param {Map<string, string>} tokenIdByAudioCid
 * @returns {number} Tracks newly marked minted
 */
export function applyOnChainMints(tokenIdByAudioCid, { artistWalletByAudioCid = new Map() } = {}) {
  let changed = 0;
  for (const track of _playlist) {
    const tokenId = track.ipfsCid && tokenIdByAudioCid.get(track.ipfsCid);
    if (!tokenId) continue;
    let updated = false;
    if (track.mintStatus !== 'minted') {
      track.mintStatus = 'minted';
      track.tokenId = tokenId;
      track.mintedAt ??= new Date().toISOString();
      updated = true;
    }
    const artistWallet = artistWalletByAudioCid.get(track.ipfsCid);
    if (!track.mintRecipient && /^0x[0-9a-fA-F]{40}$/.test(artistWallet || '')) {
      track.mintRecipient = artistWallet;
      updated = true;
    }
    if (updated) changed++;
  }
  if (changed) _save();
  return changed;
}

/** Apply corrected display titles in one checkpoint; returns how many changed. */
export function restoreTrackTitles(updates) {
  let changed = 0;
  for (const { trackId, legacyTrackId, title } of updates) {
    const track = _playlist.find((entry) => entry.trackId === trackId || entry.trackId === legacyTrackId);
    if (!track || !title || track.title === title) continue;
    track.title = title;
    changed++;
  }
  if (changed) _save();
  return changed;
}

/** Queue a pinned track for manual owner-wallet mint approval. */
export function requestTrackMint(trackId, uploaderId, recipient, artworkCid) {
  const track = _playlist.find((entry) => entry.trackId === trackId);
  if (!track || track.uploaderId !== uploaderId) return null;
  if (track.pinStatus !== 'pinned' || !track.ipfsCid || track.mintStatus === 'minted') return null;

  track.mintStatus = 'requested';
  track.mintRecipient = recipient;
  track.mintRequestedAt = new Date().toISOString();
  if (artworkCid) track.artworkCid = artworkCid;
  _save();
  return track;
}

/**
 * Queue every pinned, unminted, not-yet-requested upload by one Discord user,
 * oldest first, for owner-wallet minting to `recipient`. Checkpoints once.
 * `artworkCid` becomes the default image for queued and already-requested tracks without artwork.
 * @returns {{ queued: TrackEntry[], skipped: number }} skipped = uploads not on IPFS yet
 */
export function queueUploaderMints(uploaderId, recipient, { artworkCid, now = Date.now() } = {}) {
  const uploads = _playlist
    .filter((track) => track.uploaderId === uploaderId && track.mintStatus === 'unminted')
    .sort((first, second) => Date.parse(first.addedAt) - Date.parse(second.addedAt));
  const ready = uploads.filter((track) => track.pinStatus === 'pinned' && track.ipfsCid);
  ready.forEach((track, index) => {
    track.mintStatus = 'requested';
    track.mintRecipient = recipient;
    // Offset by index so the queue keeps posting order.
    track.mintRequestedAt = new Date(now + index).toISOString();
  });
  let artworkAdded = 0;
  if (artworkCid) {
    for (const track of _playlist) {
      if (track.uploaderId !== uploaderId || track.mintStatus !== 'requested' || track.artworkCid) continue;
      track.artworkCid = artworkCid;
      artworkAdded++;
    }
  }
  if (ready.length || artworkAdded) _save();
  return { queued: ready, skipped: uploads.length - ready.length };
}

/** Record a manually approved owner-wallet mint. */
export function completeTrackMint(trackId, { tokenId, txHash }) {
  const track = _playlist.find((entry) => entry.trackId === trackId);
  if (!track || track.mintStatus !== 'requested') return null;

  track.mintStatus = 'minted';
  track.tokenId = String(tokenId);
  track.mintTxHash = txHash;
  track.mintedAt = new Date().toISOString();
  _save();
  return track;
}

/**
 * Remove a track by its Discord upload message ID.
 * @param {string} messageId
 * @returns {TrackEntry|null} The removed entry, or null if not found.
 */
export function removeTrack(trackId) {
  const idx = _playlist.findIndex((track) => track.trackId === trackId);
  if (idx === -1) return null;
  const [removed] = _playlist.splice(idx, 1);
  _save();
  return removed;
}

/**
 * Merge a Discord message's current reaction counts into the master vote totals.
 * Repeated snapshots apply only their delta; this never increments play counts.
 *
 * @param {string} trackId
 * @param {number} newLikes    - Current human 👍 count for this message
 * @param {number} newDislikes - Current human 👎 count for this message
 * @param {string} messageId
 */
export function applyRating(trackId, newLikes, newDislikes, messageId, { initialCounts, save = true, weekly = true, now = Date.now() } = {}) {
  const track = _playlist.find((entry) => entry.trackId === trackId);
  if (!track) return null;
  const likes = Math.max(0, Number(newLikes) || 0);
  const dislikes = Math.max(0, Number(newDislikes) || 0);
  track.discordRatings ||= {};
  const previous = messageId && Object.hasOwn(track.discordRatings, messageId) ? track.discordRatings[messageId] : initialCounts;
  const legacy = messageId && track.ratedMessageIds?.includes(messageId) && !previous;
  const delta = legacy ? 0 : likes - (previous?.likes || 0) - dislikes + (previous?.dislikes || 0);
  if (weekly && delta) {
    const week = getUtcWeekKey(new Date(now));
    track.weeklyVotes ||= {};
    track.weeklyVotes[week] = (track.weeklyVotes[week] || 0) + delta;
  }
  track.likes = Math.max(0, (track.likes || 0) + (legacy ? 0 : likes - (previous?.likes || 0)));
  track.dislikes = Math.max(0, (track.dislikes || 0) + (legacy ? 0 : dislikes - (previous?.dislikes || 0)));
  if (messageId) track.discordRatings[messageId] = { likes, dislikes };
  if (messageId && !track.ratedMessageIds?.includes(messageId)) track.ratedMessageIds = [...(track.ratedMessageIds || []), messageId].slice(-500);
  if (save) _save();
  return track;
}

export function applySiteVote(trackId, vote, { now = Date.now() } = {}) {
  if (vote !== 1 && vote !== -1) throw new Error('Invalid vote');
  const track = _playlist.find((entry) => entry.trackId === trackId);
  if (!track) throw new Error('Track is no longer in the playlist');
  if (vote === 1) track.likes += 1;
  else track.dislikes += 1;
  const week = getUtcWeekKey(new Date(now));
  track.weeklyVotes ||= {};
  track.weeklyVotes[week] = (track.weeklyVotes[week] || 0) + vote;
  _save();
  return track;
}

/** Reconcile many Discord announcements atomically and checkpoint once. */
export function reconcileRatings(events) {
  let reconciled = 0;
  const floors = new Map();
  const observed = new Map();
  const recoveredTracks = new Set();
  for (const { trackId, likes, dislikes } of events) {
    const counts = observed.get(trackId) || { likes: 0, dislikes: 0 };
    counts.likes += Math.max(0, Number(likes) || 0);
    counts.dislikes += Math.max(0, Number(dislikes) || 0);
    observed.set(trackId, counts);
  }
  for (const { trackId, legacyTotals } of events) {
    if (!legacyTotals) continue;
    const floor = floors.get(trackId) || { likes: 0, dislikes: 0, plays: 0 };
    for (const field of ['likes', 'dislikes', 'plays']) floor[field] = Math.max(floor[field], Number(legacyTotals[field]) || 0);
    floors.set(trackId, floor);
  }
  for (const track of _playlist) {
    const floor = floors.get(track.trackId);
    if (!floor || track.discordLegacyTotalsRecovered) continue;
    floor.likes = Math.max(floor.likes, observed.get(track.trackId)?.likes || 0);
    floor.dislikes = Math.max(floor.dislikes, observed.get(track.trackId)?.dislikes || 0);
    for (const field of ['likes', 'dislikes', 'plays']) track[field] = Math.max(track[field] || 0, floor[field]);
    track.discordLegacyTotalsRecovered = true;
    recoveredTracks.add(track.trackId);
    reconciled++;
  }
  for (const { trackId, likes, dislikes, messageId, playId, legacyTotals } of events) {
    const track = _playlist.find((entry) => entry.trackId === trackId);
    if (!track || !messageId) continue;
    const alreadyRated = track.ratedMessageIds?.includes(messageId) || Object.hasOwn(track.discordRatings || {}, messageId);
    const before = JSON.stringify([track.likes, track.dislikes, track.discordRatings?.[messageId]]);
    applyRating(trackId, likes, dislikes, messageId, { save: false, weekly: false,
      initialCounts: legacyTotals || recoveredTracks.has(trackId) ? { likes, dislikes } : undefined });
    if (!alreadyRated && !playId && !legacyTotals && !track.audibleMessageIds?.includes(messageId)) track.plays = (track.plays || 0) + 1;
    if (!alreadyRated || before !== JSON.stringify([track.likes, track.dislikes, track.discordRatings?.[messageId]])) reconciled++;
  }
  if (reconciled > 0) _save();
  return reconciled;
}

/** Count one completed, audible play in its UTC week; retries are idempotent by playId. */
export function recordAudiblePlay(trackId, { playId, startedAt, endedAt, audibleMs, firstWeekBonus = false, announcementId } = {}) {
  if (!playId || !Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return { counted: false, reason: 'invalid-event' };
  if (!Number.isFinite(audibleMs) || audibleMs < MIN_WEEKLY_PLAY_MS) return { counted: false, reason: 'under-30-seconds' };
  const track = _playlist.find((entry) => entry.trackId === trackId);
  if (!track) return { counted: false, reason: 'track-not-found' };
  const week = getUtcWeekKey(new Date(endedAt));
  track.weeklyPlayIds ||= {};
  track.weeklyPlayIds[week] ||= [];
  if (track.weeklyPlayIds[week].includes(playId)) return { counted: false, reason: 'duplicate' };
  track.recordedPlayIds ||= [];
  if (track.recordedPlayIds.includes(playId)) return { counted: false, reason: 'duplicate' };
  track.weeklyPlays ||= {};
  track.weeklyPlays[week] = (track.weeklyPlays[week] || 0) + 1;
  track.plays = (track.plays || 0) + 1;
  if (announcementId) track.audibleMessageIds = [...new Set([...(track.audibleMessageIds || []), announcementId])].slice(-5000);
  track.weeklyPlayIds[week].push(playId);
  track.weeklyPlayIds[week] = track.weeklyPlayIds[week].slice(-5000);
  if (firstWeekBonus) track.firstWeekBonusUsed = true;
  track.recordedPlayIds.push(playId);
  track.recordedPlayIds = track.recordedPlayIds.slice(-5000);
  _save();
  return { counted: true, week, weeklyPlays: track.weeklyPlays[week] };
}

export function getWeeklyPlayReport(week, { wallet } = {}) {
  return buildPlayReport(week, wallet);
}

export function getAllTimePlayReport({ wallet } = {}) {
  return buildPlayReport(null, wallet);
}

function buildPlayReport(week, wallet) {
  const allTime = week === null;
  const targetWallet = typeof wallet === 'string' ? wallet.toLowerCase() : null;
  const tracks = _playlist
    .filter((track) => allTime ? (track.plays || track.likes || track.dislikes || 0) > 0 : (track.weeklyPlays?.[week] || 0) > 0 || Boolean(track.weeklyVotes?.[week]))
    .filter((track) => !targetWallet || track.mintRecipient?.toLowerCase() === targetWallet)
    .map((track) => ({
      trackId: track.trackId,
      title: track.title,
      artist: track.uploader,
      wallet: track.mintRecipient || null,
      uploadedAt: track.addedAt || null,
      plays: allTime ? track.plays || 0 : track.weeklyPlays?.[week] || 0,
      votes: allTime ? (track.likes || 0) - (track.dislikes || 0) : track.weeklyVotes?.[week] || 0,
      likes: track.likes || 0,
      dislikes: track.dislikes || 0,
    }))
    .sort((first, second) => second.plays - first.plays || first.title.localeCompare(second.title));
  const artists = new Map();
  for (const track of tracks) {
    const artist = artists.get(track.artist) || { artist: track.artist, wallet: track.wallet, plays: 0, tracks: 0, likes: 0, dislikes: 0 };
    artist.plays += track.plays;
    artist.likes += track.likes;
    artist.dislikes += track.dislikes;
    artist.tracks++;
    artists.set(track.artist, artist);
  }
  return {
    week: allTime ? 'all-time' : week,
    qualification: allTime ? 'All-time recorded plays, including legacy Discord announcement counts. Votes are all-time.'
      : 'Completed Discord playback with at least 30 audible seconds; one event per play ID.',
    totalPlays: tracks.reduce((total, track) => total + track.plays, 0),
    trackCount: tracks.length,
    artists: [...artists.values()].sort((first, second) => second.plays - first.plays),
    tracks,
  };
}

export function getWeeklyPlayWeeks() {
  return [...new Set(_playlist.flatMap((track) => [...Object.keys(track.weeklyPlays || {}), ...Object.keys(track.weeklyVotes || {})]))].sort();
}

export function getWeeklyPlayHistory({ weeks = 12, now = Date.now(), wallet, includeAllTime = false } = {}) {
  const current = getUtcWeekKey(new Date(now));
  const [year, weekNumber] = current.split('-W').map(Number);
  const monday = new Date(Date.UTC(year, 0, 4 + (weekNumber - 1) * 7));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const history = [];
  for (let offset = Math.max(1, Math.min(52, Number(weeks) || 12)) - 1; offset >= 0; offset--) {
    const start = new Date(monday);
    start.setUTCDate(start.getUTCDate() - offset * 7);
    const week = getUtcWeekKey(start);
    history.push({ ...getWeeklyPlayReport(week, { wallet }), current: week === current });
  }
  if (includeAllTime) history.push(getAllTimePlayReport({ wallet }));
  return history;
}

// ── Read helpers ──────────────────────────────────────────────────────────────

/** Return a shallow copy of the raw (unsorted) playlist. */
export function getPlaylist() {
  return [..._playlist];
}

/** Return unminted uploads belonging to one Discord user, newest first. */
export function getMintBacklog(uploaderId) {
  return _playlist
    .filter((track) => track.uploaderId === uploaderId && track.mintStatus !== 'minted')
    .sort((first, second) => Date.parse(second.addedAt) - Date.parse(first.addedAt));
}

/** Return owner-wallet mint requests, oldest first. */
export function getMintRequests() {
  return _playlist
    .filter((track) => track.mintStatus === 'requested')
    .sort((first, second) => Date.parse(first.mintRequestedAt) - Date.parse(second.mintRequestedAt));
}

/**
 * Compute the playback weight for a track.
 * Formula: max(0.1, 1 + likes − dislikes × 0.5)
 *
 * A brand-new track has weight 1.0.
 * Each 👍 adds 1; each 👎 removes 0.5.  Minimum weight is 0.1 so even heavily
 * down-voted tracks still occasionally appear.
 *
 * @param {TrackEntry} track
 * @returns {number}
 */
export function getWeight(track) {
  return Math.max(0.1, 1.0 + track.likes - track.dislikes * 0.5);
}

/**
 * Return a weighted-random shuffled copy of the playlist.
 *
 * Uses repeated weighted reservoir sampling: at each step a track is drawn
 * with probability proportional to its weight and removed from the candidate
 * pool, producing a fully-ordered sequence where higher-rated tracks appear
 * earlier (and thus play sooner in each loop pass).
 *
 * @returns {TrackEntry[]}
 */
export function getWeightedShuffledPlaylist(now = Date.now()) {
  const eligible = _playlist.filter(track => track.source !== 'site' || track.mintStatus === 'minted');
  if (eligible.length === 0) return [];

  // Build mutable candidate array with weights
  const candidates = eligible.map((track) => ({ track, weight: getWeight(track) }));
  const result = [];

  while (candidates.length > 0) {
    const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
    let rand = Math.random() * totalWeight;
    let chosen = candidates.length - 1; // fallback
    for (let i = 0; i < candidates.length; i++) {
      rand -= candidates[i].weight;
      if (rand <= 0) {
        chosen = i;
        break;
      }
    }
    result.push(candidates[chosen].track);
    candidates.splice(chosen, 1);
  }

  const fresh = result
    .map((track, index) => ({ track, index, addedAt: Date.parse(track.addedAt || 0) }))
    .filter((entry) => !entry.track.firstWeekBonusUsed && entry.addedAt > 0 && now >= entry.addedAt && now - entry.addedAt < NEW_TRACK_WINDOW_MS);
  for (const entry of fresh.sort((first, second) => second.index - first.index)) {
    const target = (entry.index + Math.floor(result.length / 2)) % result.length;
    result.splice(target, 0, { ...entry.track, firstWeekBonus: true });
  }
  return result;
}

/**
 * Return the top N tracks sorted by net score (likes − dislikes×0.5), descending.
 * @param {number} [n=10]
 * @returns {TrackEntry[]}
 */
export function getTopTracks(n = 10) {
  return [..._playlist]
    .sort((a, b) => getWeight(b) - getWeight(a))
    .slice(0, n);
}

/** The message ID of the most recently added track (for incremental backfill). */
export function getLatestMessageId() {
  const discordTracks = _playlist.filter(track => /^\d+$/.test(track.messageId || ''));
  if (discordTracks.length === 0) return null;
  // Messages with larger IDs are newer (Discord snowflake IDs are monotonically
  // increasing and sortable as BigInt).
  return discordTracks.reduce((latest, t) => {
    return BigInt(t.messageId) > BigInt(latest) ? t.messageId : latest;
  }, discordTracks[0].messageId);
}
