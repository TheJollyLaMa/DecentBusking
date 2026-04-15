// discord-bot/radio.js
// IPFS track-list fetcher and per-guild RadioSession manager.
//
// RadioSession streams audio files from an IPFS directory to a Discord voice
// channel using FFmpeg for transcoding and @discordjs/voice for playback.

import { spawn }  from 'child_process';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} from '@discordjs/voice';

// ── IPFS helpers ──────────────────────────────────────────────────────────────

const AUDIO_EXTENSIONS_RE = /\.(mp3|m4a|wav|ogg|flac|aac|opus)$/i;

/**
 * Fetch an ordered list of audio track URLs from an IPFS directory.
 * The function fetches the HTTP gateway directory listing HTML and parses
 * every href that ends with a recognised audio extension.
 *
 * @param {string} cid     - IPFS CID (with or without ipfs:// prefix)
 * @param {string} gateway - IPFS HTTP gateway base URL (e.g. https://w3s.link)
 * @returns {Promise<string[]>} Sorted array of full HTTP track URLs
 */
export async function fetchTrackList(cid, gateway) {
  const normalizedCid = cid.replace(/^ipfs:\/\//, '').trim();
  const dirUrl = `${gateway.replace(/\/$/, '')}/ipfs/${normalizedCid}/`;

  const response = await fetch(dirUrl);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching IPFS directory at ${dirUrl}`);
  }

  const html   = await response.text();
  const tracks = [];

  // Parse href attributes from the directory listing HTML.
  // Handles relative paths (track.mp3), root-relative (/ipfs/CID/track.mp3),
  // and absolute URLs.
  const hrefRe = /href="([^"]+)"/g;
  let match;
  while ((match = hrefRe.exec(html)) !== null) {
    const href = match[1];
    // Skip navigation fragments, query-only links, and parent-dir links
    if (href.startsWith('#') || href.startsWith('?') || href === '../') continue;
    if (AUDIO_EXTENSIONS_RE.test(href)) {
      try {
        tracks.push(new URL(href, dirUrl).toString());
      } catch {
        // Ignore malformed hrefs
      }
    }
  }

  return tracks.sort();
}

// ── FFmpeg stream helper ──────────────────────────────────────────────────────

/** Path to the ffmpeg binary — override via the FFMPEG_PATH env var. */
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';

/**
 * Spawn FFmpeg to pull an HTTP(S) audio URL and output raw 16-bit LE PCM
 * at 48 kHz stereo (the format expected by @discordjs/voice's StreamType.Raw).
 *
 * @param {string} url - Full HTTP URL of the audio file
 * @returns {{ stream: import('stream').Readable, process: import('child_process').ChildProcess }}
 */
function createFFmpegStream(url) {
  const args = [
    '-reconnect',            '1',
    '-reconnect_streamed',   '1',
    '-reconnect_delay_max',  '5',
    '-i',                    url,
    '-analyzeduration',      '0',
    '-loglevel',             '0',
    '-vn',
    '-f',  's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1',
  ];

  const ffmpeg = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  ffmpeg.on('error', (err) => console.error('[radio] FFmpeg spawn error:', err.message));
  return { stream: ffmpeg.stdout, process: ffmpeg };
}

// ── Per-guild session registry ────────────────────────────────────────────────

/** @type {Map<string, RadioSession>} guildId → active session */
const sessions = new Map();

/**
 * Return the active RadioSession for a guild, or null.
 * @param {string} guildId
 * @returns {RadioSession|null}
 */
export function getSession(guildId) {
  return sessions.get(guildId) ?? null;
}

/**
 * Create a new RadioSession for a guild, destroying any existing session first.
 *
 * @param {string} guildId
 * @param {{ voiceChannel: import('discord.js').VoiceBasedChannel, textChannel: import('discord.js').TextBasedChannel }} opts
 * @returns {RadioSession}
 */
export function createSession(guildId, opts) {
  const existing = sessions.get(guildId);
  if (existing) existing.destroy();
  const session = new RadioSession(opts);
  sessions.set(guildId, session);
  return session;
}

// ── RadioSession ──────────────────────────────────────────────────────────────

export class RadioSession {
  /**
   * @param {object} opts
   * @param {import('discord.js').VoiceBasedChannel} opts.voiceChannel
   * @param {import('discord.js').TextBasedChannel}  opts.textChannel
   */
  constructor({ voiceChannel, textChannel }) {
    this.voiceChannel  = voiceChannel;
    this.textChannel   = textChannel;
    this.queue         = [];
    this.trackIndex    = 0;
    this.isPaused      = false;
    this._destroyed    = false;
    this.connection    = null;
    this._ffmpeg       = null; // current FFmpeg child process
    this.player        = createAudioPlayer();

    this.player.on(AudioPlayerStatus.Idle, () => this._playNext());
    this.player.on('error', (err) => {
      console.error('[radio] Audio player error:', err.message);
      this._playNext();
    });
  }

  // ── Connection ──────────────────────────────────────────────────────────────

  /** Join the voice channel and subscribe the audio player to it. */
  async connect() {
    this.connection = joinVoiceChannel({
      channelId:      this.voiceChannel.id,
      guildId:        this.voiceChannel.guild.id,
      adapterCreator: this.voiceChannel.guild.voiceAdapterCreator,
    });

    await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
    this.connection.subscribe(this.player);

    // Auto-clean-up if the bot is disconnected from outside
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.destroy();
      }
    });
  }

  // ── Playback ────────────────────────────────────────────────────────────────

  /**
   * Load a track list into the queue and start playback from the beginning.
   * @param {string[]} tracks - Array of HTTP audio URLs
   */
  async start(tracks) {
    this.queue      = tracks;
    this.trackIndex = 0;
    await this._playNext();
  }

  async _playNext() {
    // Kill any lingering FFmpeg process from the previous track
    if (this._ffmpeg) {
      try { this._ffmpeg.kill(); } catch {}
      this._ffmpeg = null;
    }

    // If the session was explicitly stopped, don't post a "finished" message
    if (this._destroyed) return;

    if (this.trackIndex >= this.queue.length) {
      await this.textChannel
        .send('✅ Radio playlist finished. Disconnecting from voice channel.')
        .catch(() => {});
      this.destroy();
      return;
    }

    const url       = this.queue[this.trackIndex];
    const filename  = url.split('/').pop();
    const trackName = filename ? decodeURIComponent(filename) : `Track ${this.trackIndex + 1}`;
    this.trackIndex++;

    try {
      const { stream, process: ffmpeg } = createFFmpegStream(url);
      this._ffmpeg = ffmpeg;

      const resource = createAudioResource(stream, { inputType: StreamType.Raw });
      this.player.play(resource);

      await this.textChannel
        .send(`🎵 Now Playing (${this.trackIndex}/${this.queue.length}): **${trackName}**`)
        .catch(() => {});
    } catch (err) {
      console.error('[radio] Failed to start track:', err.message);
      await this.textChannel
        .send(`⚠️ Skipping **${trackName}**: ${err.message}`)
        .catch(() => {});
      await this._playNext();
    }
  }

  // ── Controls ────────────────────────────────────────────────────────────────

  /** Skip the current track and move to the next one. */
  skip() {
    // Calling stop(true) forces the player into Idle state, which triggers _playNext.
    this.player.stop(true);
  }

  /**
   * Toggle between paused and playing.
   * @returns {boolean} true if now paused, false if now resumed
   */
  togglePause() {
    if (this.isPaused) {
      this.player.unpause();
      this.isPaused = false;
    } else {
      this.player.pause();
      this.isPaused = true;
    }
    return this.isPaused;
  }

  /** Stop playback, clear the queue, and disconnect from voice. */
  stop() {
    this.queue      = [];
    this.trackIndex = 0;
    this.destroy();
    // stop() after destroy() so the Idle event (if it fires) sees _destroyed=true
    this.player.stop(true);
  }

  /** Tear down the voice connection and remove this session from the registry. */
  destroy() {
    this._destroyed = true;
    sessions.delete(this.voiceChannel.guild.id);
    if (this._ffmpeg) {
      try { this._ffmpeg.kill(); } catch {}
      this._ffmpeg = null;
    }
    if (this.connection) {
      try { this.connection.destroy(); } catch {}
      this.connection = null;
    }
  }
}
