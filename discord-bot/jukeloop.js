// discord-bot/jukeloop.js
// JukeLoop — 24/7 community radio that plays audio files posted in the
// #DecentJukebox channel on a rolling, rating-weighted playlist.
//
// How it works:
//  1. On startup `backfillFromChannel()` is called to harvest all historic
//     audio attachments from #DecentJukebox and register them in the
//     playlist-store.  Only tracks not already stored are added.
//  2. A `JukeLoopSession` joins the configured JukeLoop voice channel and
//     starts playing tracks in a weighted-random order that loops forever.
//  3. For each track, the bot posts a "Now Playing" announcement in the
//     JukeLoop text channel and pre-adds 👍 / 👎 reaction buttons.
//  4. When the *next* track starts, the bot fetches the previous announcement
//     message, reads the 👍 / 👎 counts, and passes the delta to the
//     playlist-store so ratings accumulate over time.
//  5. After each full pass through the playlist the queue is re-shuffled
//     (using fresh weights) so newly accumulated ratings take effect.
//
// Discord CDN URLs carry expiring tokens, so we never store URLs.  Instead
// we store the message ID + channel ID and call `channel.messages.fetch()`
// right before playback to obtain a fresh URL.

import { spawn } from 'child_process';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} from '@discordjs/voice';
import {
  loadPlaylist,
  addTrack,
  applyRating,
  getWeightedShuffledPlaylist,
  getPlaylist,
} from './playlist-store.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const AUDIO_EXTENSIONS_RE = /\.(mp3|m4a|wav|ogg|flac|aac|opus|weba)$/i;
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';

// Delay between the end of one track and the start of the next (ms).
// Gives Discord a moment to flush the connection before the next resource
// is attached and provides a natural pause for listeners.
const BETWEEN_TRACK_DELAY_MS = 1_500;

// How long to wait before retrying when the playlist is empty (ms).
const EMPTY_PLAYLIST_RETRY_MS = 60_000;

// ── Per-guild session registry ────────────────────────────────────────────────

/** @type {Map<string, JukeLoopSession>} guildId → active session */
const _sessions = new Map();

/**
 * Return the active JukeLoopSession for a guild, or null.
 * @param {string} guildId
 * @returns {JukeLoopSession|null}
 */
export function getJukeLoopSession(guildId) {
  return _sessions.get(guildId) ?? null;
}

/**
 * Create (or replace) the JukeLoopSession for a guild.
 *
 * @param {string} guildId
 * @param {object} opts
 * @param {import('discord.js').VoiceBasedChannel}  opts.voiceChannel
 * @param {import('discord.js').TextBasedChannel}   opts.textChannel
 * @param {import('discord.js').Client}             opts.client
 * @returns {JukeLoopSession}
 */
export function createJukeLoopSession(guildId, opts) {
  const existing = _sessions.get(guildId);
  if (existing) existing.destroy();
  const session = new JukeLoopSession(opts);
  _sessions.set(guildId, session);
  return session;
}

// ── FFmpeg helper ─────────────────────────────────────────────────────────────

/**
 * Spawn FFmpeg to transcode an HTTP(S) audio URL to raw 16-bit LE PCM at
 * 48 kHz stereo — the format expected by @discordjs/voice's StreamType.Raw.
 *
 * @param {string} url
 * @returns {{ stream: import('stream').Readable, ffmpegProcess: import('child_process').ChildProcess }}
 */
function createFFmpegStream(url) {
  const args = [
    '-reconnect',           '1',
    '-reconnect_streamed',  '1',
    '-reconnect_delay_max', '5',
    '-i',                   url,
    '-analyzeduration',     '0',
    '-loglevel',            '0',
    '-vn',
    '-f',  's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1',
  ];
  const ffmpegProcess = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  ffmpegProcess.on('error', (err) =>
    console.error('[jukeloop] FFmpeg spawn error:', err.message),
  );
  return { stream: ffmpegProcess.stdout, ffmpegProcess };
}

// ── JukeLoopSession ───────────────────────────────────────────────────────────

export class JukeLoopSession {
  /**
   * @param {object} opts
   * @param {import('discord.js').VoiceBasedChannel} opts.voiceChannel  - JukeLoop voice channel
   * @param {import('discord.js').TextBasedChannel}  opts.textChannel   - JukeLoop text channel
   * @param {import('discord.js').Client}            opts.client        - Discord client (for re-fetching CDN URLs)
   */
  constructor({ voiceChannel, textChannel, client }) {
    this.voiceChannel = voiceChannel;
    this.textChannel  = textChannel;
    this.client       = client;

    this._destroyed   = false;
    this._ffmpeg      = null;
    this.connection   = null;
    this.player       = createAudioPlayer();

    /** Shuffled queue for the current loop pass */
    this._queue      = [];
    this._queueIndex = 0;

    /** The "Now Playing" announcement message for the track *currently* playing */
    this._announcementMsg = null;
    /** The track entry currently playing (so we can store ratings when it ends) */
    this._currentTrack    = null;

    this.player.on(AudioPlayerStatus.Idle, () => {
      if (!this._destroyed) {
        setTimeout(() => {
          this._playNext().catch((err) =>
            console.error('[jukeloop] Unhandled error in _playNext:', err),
          );
        }, BETWEEN_TRACK_DELAY_MS);
      }
    });

    this.player.on('error', (err) => {
      console.error('[jukeloop] Audio player error:', err.message);
      if (!this._destroyed) {
        setTimeout(() => {
          this._playNext().catch(() => {});
        }, BETWEEN_TRACK_DELAY_MS);
      }
    });
  }

  // ── Connection ──────────────────────────────────────────────────────────────

  /** Join the JukeLoop voice channel and subscribe the audio player to it. */
  async connect() {
    this.connection = joinVoiceChannel({
      channelId:      this.voiceChannel.id,
      guildId:        this.voiceChannel.guild.id,
      adapterCreator: this.voiceChannel.guild.voiceAdapterCreator,
    });

    await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
    this.connection.subscribe(this.player);

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Give Discord a moment to reconnect before giving up
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (!this._destroyed) this.destroy();
      }
    });
  }

  // ── Playback ────────────────────────────────────────────────────────────────

  /** Begin the infinite JukeLoop. */
  async start() {
    if (this._destroyed) return;
    this._refreshQueue();
    await this._playNext();
  }

  /** (Re)build the shuffled queue from the current weighted playlist. */
  _refreshQueue() {
    this._queue      = getWeightedShuffledPlaylist();
    this._queueIndex = 0;
  }

  /**
   * Fetch a fresh (non-expired) attachment URL for a track entry.
   * Returns null if the message or attachment can no longer be found.
   *
   * @param {import('./playlist-store.js').TrackEntry} track
   * @returns {Promise<string|null>}
   */
  async _getFreshUrl(track) {
    try {
      const channel = await this.client.channels.fetch(track.channelId).catch(() => null);
      if (!channel) return null;
      const msg = await channel.messages.fetch(track.messageId).catch(() => null);
      if (!msg) return null;
      const attachment = msg.attachments.find(
        (a) => a.name === track.filename,
      );
      return attachment?.url ?? null;
    } catch {
      return null;
    }
  }

  async _playNext() {
    // Kill any lingering FFmpeg process
    if (this._ffmpeg) {
      try { this._ffmpeg.kill(); } catch {}
      this._ffmpeg = null;
    }

    if (this._destroyed) return;

    // Collect ratings from the previous track's announcement
    await this._collectReactions();

    // Refill + reshuffle if we've exhausted the current pass
    if (this._queueIndex >= this._queue.length) {
      this._refreshQueue();
    }

    // Nothing to play → wait and retry
    if (this._queue.length === 0) {
      await this.textChannel
        .send(
          '📭 The JukeLoop playlist is empty.\n' +
          'Post audio files (MP3, M4A, etc.) in <#' + this.textChannel.id + '> to add tracks!',
        )
        .catch(() => {});
      setTimeout(() => {
        if (!this._destroyed) this._playNext().catch(() => {});
      }, EMPTY_PLAYLIST_RETRY_MS);
      return;
    }

    const track = this._queue[this._queueIndex];
    this._queueIndex++;
    this._currentTrack    = track;
    this._announcementMsg = null;

    // Resolve a fresh CDN URL
    const url = await this._getFreshUrl(track);
    if (!url) {
      console.warn(`[jukeloop] Could not fetch URL for "${track.title}" (${track.messageId}), skipping.`);
      await this.textChannel
        .send(`⚠️ Skipping **${track.title}** — the original upload could not be found.`)
        .catch(() => {});
      this._currentTrack = null;
      await this._playNext();
      return;
    }

    try {
      const { stream, ffmpegProcess } = createFFmpegStream(url);
      this._ffmpeg = ffmpegProcess;

      const resource = createAudioResource(stream, { inputType: StreamType.Raw });
      this.player.play(resource);

      // Announce the track and add reaction buttons
      const totalTracks = getPlaylist().length;
      const msg = await this.textChannel
        .send(
          `🎵 Now playing: **${track.title}** by *${track.uploader}* ` +
          `(${this._queueIndex}/${totalTracks}) — rate this track!\n` +
          `React 👍 to boost it or 👎 to send it lower in the rotation.`,
        )
        .catch(() => null);

      if (msg) {
        await msg.react('👍').catch(() => {});
        await msg.react('👎').catch(() => {});
        this._announcementMsg = msg;
      }

      console.log(`[jukeloop] Now playing: "${track.title}" by ${track.uploader}`);
    } catch (err) {
      console.error('[jukeloop] Failed to start track:', err.message);
      await this.textChannel
        .send(`⚠️ Skipping **${track.title}**: ${err.message}`)
        .catch(() => {});
      this._currentTrack    = null;
      this._announcementMsg = null;
      await this._playNext();
    }
  }

  /**
   * Read 👍 / 👎 counts from the last "Now Playing" message and persist them.
   * Called automatically when the next track is about to start.
   */
  async _collectReactions() {
    if (!this._announcementMsg || !this._currentTrack) return;

    const msgRef   = this._announcementMsg;
    const trackRef = this._currentTrack;

    // Clear refs first so any re-entrant call is a no-op
    this._announcementMsg = null;
    this._currentTrack    = null;

    try {
      const fresh = await msgRef.fetch().catch(() => null);
      if (!fresh) return;

      const thumbsUp   = fresh.reactions.cache.get('👍');
      const thumbsDown = fresh.reactions.cache.get('👎');

      // Subtract 1 to exclude the bot's own seed reaction
      const likes    = Math.max(0, (thumbsUp?.count   ?? 0) - 1);
      const dislikes = Math.max(0, (thumbsDown?.count ?? 0) - 1);

      applyRating(trackRef.messageId, likes, dislikes);

      if (likes > 0 || dislikes > 0) {
        console.log(
          `[jukeloop] Ratings for "${trackRef.title}": +${likes} 👍 / -${dislikes} 👎`,
        );
      }
    } catch (err) {
      console.error('[jukeloop] Error collecting reactions:', err.message);
    }
  }

  /** Stop all playback and disconnect from the voice channel. */
  destroy() {
    this._destroyed = true;
    _sessions.delete(this.voiceChannel.guild.id);
    if (this._ffmpeg) {
      try { this._ffmpeg.kill(); } catch {}
      this._ffmpeg = null;
    }
    if (this.connection) {
      try { this.connection.destroy(); } catch {}
      this.connection = null;
    }
    try { this.player.stop(true); } catch {}
  }
}

// ── Channel backfill ──────────────────────────────────────────────────────────

/**
 * Scan the DecentJukebox text channel for historic audio uploads and register
 * any that are not already in the playlist store.
 *
 * Fetches messages in reverse-chronological batches (100 per request, the
 * Discord API maximum) until all messages have been seen.  Only messages
 * posted by non-bot users that contain audio attachments are considered.
 *
 * @param {import('discord.js').TextBasedChannel} jukeboxChannel
 * @returns {Promise<number>} Number of new tracks added to the store
 */
export async function backfillFromChannel(jukeboxChannel) {
  let added   = 0;
  let lastId  = undefined;

  console.log(`[jukeloop] Backfilling historic uploads from #${jukeboxChannel.name ?? jukeboxChannel.id}…`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    /** @type {import('discord.js').Collection<string, import('discord.js').Message>} */
    const batch = await jukeboxChannel.messages
      .fetch(lastId ? { limit: 100, before: lastId } : { limit: 100 })
      .catch(() => null);

    if (!batch || batch.size === 0) break;

    for (const msg of batch.values()) {
      if (msg.author.bot) continue;

      for (const attachment of msg.attachments.values()) {
        if (!AUDIO_EXTENSIONS_RE.test(attachment.name ?? '')) continue;

        const filename = attachment.name;
        const title    = filename
          .replace(/\.[^.]+$/, '')
          .replace(/[-_]+/g, ' ')
          .trim() || filename;

        const wasAdded = addTrack({
          messageId:  msg.id,
          channelId:  jukeboxChannel.id,
          filename,
          title,
          uploader:   msg.author.tag ?? msg.author.username ?? 'Unknown',
          uploaderId: msg.author.id,
        });

        if (wasAdded) added++;
      }
    }

    lastId = batch.last()?.id;
    if (batch.size < 100) break;
  }

  console.log(`[jukeloop] Backfill complete — added ${added} new track(s).`);
  return added;
}
