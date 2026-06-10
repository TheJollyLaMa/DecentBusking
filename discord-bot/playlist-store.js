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
const STORE_PATH = join(__dirname, 'jukeloop-playlist.json');

/**
 * @typedef {Object} TrackEntry
 * @property {string} messageId  - Discord message ID of the original upload
 * @property {string} channelId  - Discord channel ID where the file was posted
 * @property {string} filename   - Original attachment filename (e.g. "song.mp3")
 * @property {string} title      - Human-readable title (filename without extension)
 * @property {string} uploader   - Discord username/tag of the uploader
 * @property {string} uploaderId - Discord user ID of the uploader
 * @property {number} likes      - Cumulative 👍 reactions counted across all plays
 * @property {number} dislikes   - Cumulative 👎 reactions counted across all plays
 * @property {number} plays      - Total number of times the track has been played
 * @property {string} addedAt    - ISO-8601 timestamp when the track was first added
 */

/** @type {TrackEntry[]} */
let _playlist = [];

// ── Persistence ───────────────────────────────────────────────────────────────

/** Load the playlist from disk. Call once at startup. */
export function loadPlaylist() {
  if (existsSync(STORE_PATH)) {
    try {
      const raw = readFileSync(STORE_PATH, 'utf8');
      _playlist = JSON.parse(raw);
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

function _save() {
  try {
    writeFileSync(STORE_PATH, JSON.stringify(_playlist, null, 2), 'utf8');
  } catch (err) {
    console.error('[playlist-store] Failed to save playlist:', err.message);
  }
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Add a track to the playlist (idempotent — keyed on messageId).
 *
 * @param {Omit<TrackEntry, 'likes'|'dislikes'|'plays'|'addedAt'>} track
 * @returns {boolean} true if the track was newly added, false if already present
 */
export function addTrack(track) {
  if (_playlist.some((t) => t.messageId === track.messageId)) return false;
  _playlist.push({
    ...track,
    likes:    0,
    dislikes: 0,
    plays:    0,
    addedAt:  new Date().toISOString(),
  });
  _save();
  return true;
}

/**
 * Remove a track by its Discord upload message ID.
 * @param {string} messageId
 * @returns {TrackEntry|null} The removed entry, or null if not found.
 */
export function removeTrack(messageId) {
  const idx = _playlist.findIndex((t) => t.messageId === messageId);
  if (idx === -1) return null;
  const [removed] = _playlist.splice(idx, 1);
  _save();
  return removed;
}

/**
 * Record 👍 / 👎 reaction counts and increment the play counter for a track.
 * The counts are *added* to the stored totals (they accumulate over time).
 *
 * @param {string} messageId
 * @param {number} newLikes    - Net new 👍 since last collection
 * @param {number} newDislikes - Net new 👎 since last collection
 */
export function applyRating(messageId, newLikes, newDislikes) {
  const track = _playlist.find((t) => t.messageId === messageId);
  if (!track) return;
  track.likes    += newLikes;
  track.dislikes += newDislikes;
  track.plays    += 1;
  _save();
}

// ── Read helpers ──────────────────────────────────────────────────────────────

/** Return a shallow copy of the raw (unsorted) playlist. */
export function getPlaylist() {
  return [..._playlist];
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
export function getWeightedShuffledPlaylist() {
  if (_playlist.length === 0) return [];

  // Build mutable candidate array with weights
  const candidates = _playlist.map((track) => ({ track, weight: getWeight(track) }));
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
  if (_playlist.length === 0) return null;
  // Messages with larger IDs are newer (Discord snowflake IDs are monotonically
  // increasing and sortable as BigInt).
  return _playlist.reduce((latest, t) => {
    return BigInt(t.messageId) > BigInt(latest) ? t.messageId : latest;
  }, _playlist[0].messageId);
}
