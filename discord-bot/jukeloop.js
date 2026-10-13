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
import { MessageFlags } from 'discord.js';
import { DEVERT_MAX_AD_SECONDS, DEVERT_SONGS_PER_MAIN_AD } from '../js/devert-scheduler.mjs';
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
  recordAudiblePlay,
  applySiteVote,
  reconcileRatings,
  getWeightedShuffledPlaylist,
  getPlaylist,
  getWeeklyPlayHistory,
  restoreTrackTitles,
} from './playlist-store.js';
import {
  defaultRadioSchedule,
  resolveActiveShow,
  rankRotationTracks,
  rankWeeklyTopTenTracks,
} from '../js/radio-schedule.mjs';
import { mediaTypeFor, isDiscordAttachmentWithinLimit } from './media.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const AUDIO_EXTENSIONS_RE = /\.(mp3|m4a|wav|ogg|flac|aac|opus|weba|mp4)$/i;
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';

const FADE_IN_SECONDS = 0.6;
const NEXT_TRACK_READY_TIMEOUT_MS = 20_000;
const DJUKE_PREFETCH_POLL_MS = 5_000;

// How long to wait before retrying when the playlist is empty (ms).
const EMPTY_PLAYLIST_RETRY_MS = 60_000;

export function getVoiceRetryDelay(attempt) {
  return Math.min(15_000 * (2 ** Math.max(0, attempt - 1)), 5 * 60_000);
}

/** Display title for an upload; Discord strips emoji and accents from `name` but keeps them in `title`. */
export function getAttachmentTitle(attachment) {
  const original = (attachment.title || '').replace(AUDIO_EXTENSIONS_RE, '').trim();
  if (original) return original;
  const filename = attachment.name || '';
  return filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || filename || 'Untitled';
}

/** Build a gateway URL for a raw IPFS CID. */
export function buildIpfsGatewayUrl(gateway, cid) {
  const base = gateway.replace(/\/$/, '');
  return `${base}${base.endsWith('/ipfs') ? '' : '/ipfs'}/${cid}`;
}

const FALLBACK_IPFS_GATEWAY = 'https://gateway.pinata.cloud';
const GATEWAY_PROBE_TIMEOUT_MS = 15_000;

/** True when the URL serves audio bytes; public gateways often answer 429 or redirect to dead hosts. */
export async function isUrlStreamable(url, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url, {
      headers: { range: 'bytes=0-0' },
      signal: AbortSignal.timeout(GATEWAY_PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => {});
    return response.status === 200 || response.status === 206;
  } catch {
    return false;
  }
}

/** First gateway URL (configured, then Pinata) that can actually stream the CID, or null. */
export async function resolveStreamableIpfsUrl(gateway, cid, fetchImpl = fetch) {
  const gateways = [...new Set([gateway, FALLBACK_IPFS_GATEWAY].filter(Boolean))];
  for (const candidate of gateways) {
    const url = buildIpfsGatewayUrl(candidate, cid);
    if (await isUrlStreamable(url, fetchImpl)) return url;
  }
  return null;
}

/** Public radio snapshot; positionMs lets browsers sync without trusting their own clocks. */
export function buildRadioState({ nowPlaying, playlist, now = Date.now(), recentLimit = 10 }) {
  const recent = playlist.filter(track => !track.isDevertAd && (track.source !== 'site' || track.mintStatus === 'minted'))
    .sort((first, second) => Date.parse(second.addedAt) - Date.parse(first.addedAt))
    .slice(0, recentLimit)
    .map((track) => ({
      trackId: track.trackId,
      title: track.title,
      uploader: track.uploader,
      filename: track.filename || null,
      mediaType: mediaTypeFor(track.filename, track.mediaType),
      ipfsCid: track.ipfsCid || null,
      addedAt: track.addedAt,
    }));
  return {
    serverTime: now,
    nowPlaying: nowPlaying && nowPlaying.audible !== false
      ? {
          playId: nowPlaying.playId || `${nowPlaying.trackId}:${nowPlaying.startedAt}`,
          trackId: nowPlaying.trackId,
          title: nowPlaying.title,
          uploader: nowPlaying.uploader,
          filename: nowPlaying.filename || null,
          mediaType: mediaTypeFor(nowPlaying.filename, nowPlaying.mediaType),
          ipfsCid: nowPlaying.ipfsCid || null,
          isDevert: nowPlaying.isDevert === true,
          startedAt: nowPlaying.startedAt,
          positionMs: Math.max(0, now - nowPlaying.startedAt),
        }
      : null,
    recent,
  };
}

export function buildNowPlayingMessage(track, { queueIndex, totalTracks, url, votingOpen = true, playId, paid = false }) {
  const listenLink = track.ipfsCid && /\/ipfs\//.test(url || '') ? `\n[Open IPFS audio](${url})` : '';
  const votingLine = votingOpen
    ? 'React 👍 to boost it or 👎 to send it lower in the rotation.'
    : 'This play has finished. Your 👍 / 👎 reactions still update the master tally.';
  return (
    `🎵 Now playing: **${track.title}** by *${track.uploader}* ` +
    `(${queueIndex}/${totalTracks})\n` +
    (paid ? '💸 **DJuke paid request**\n' : '') +
    `**All-time:** 👍 ${track.likes ?? 0} · 👎 ${track.dislikes ?? 0} · ▶️ ${track.plays ?? 0}\n` +
    `Track ID: ||${track.trackId}||\n` +
    (playId ? `Play ID: ||${playId}||\n` : '') +
    `${votingLine}${listenLink}`
  );
}

export function parseNowPlayingMessage(content) {
  const match = content.match(/^🎵 Now playing: \*\*(.+?)\*\* by \*(.+?)\*/);
  if (!match) return null;
  const trackId = content.match(/Track ID: \|\|(.+?)\|\|/)?.[1] || null;
  const playId = content.match(/Play ID: \|\|(.+?)\|\|/)?.[1];
  return { title: match[1], uploader: match[2], trackId, ...(playId ? { playId } : {}) };
}

function reactionCount(message, emoji) {
  return [...message.reactions.cache.values()]
    .filter(entry => entry.emoji.name?.startsWith(emoji))
    .reduce((total, reaction) => total + Math.max(0, (reaction.count || 0) - (reaction.me ? 1 : 0)), 0);
}

export function synchronizeDiscordRating(message, botUserId, { change, emoji, now = Date.now(), store = { getPlaylist, applyRating } } = {}) {
  const playlist = store.getPlaylist();
  const parsed = message.author?.id === botUserId ? parseNowPlayingMessage(message.content || '') : null;
  const uploads = message.author?.bot ? [] : playlist.filter(entry => entry.messageId === message.id && entry.uploaderId === message.author?.id);
  const track = parsed?.trackId ? playlist.find(entry => entry.trackId === parsed.trackId)
    : uploads.length === 1 ? uploads[0] : null;
  if (!track) return null;
  const likes = reactionCount(message, '👍');
  const dislikes = reactionCount(message, '👎');
  const initialCounts = change ? {
    likes: Math.max(0, likes - (emoji === '👍' ? change : 0)),
    dislikes: Math.max(0, dislikes - (emoji === '👎' ? change : 0)),
  } : undefined;
  return store.applyRating(track.trackId, likes, dislikes, message.id, { initialCounts, now });
}

/** Recover announcements that were abandoned by a restart before normal collection. */
export async function reconcileJukeLoopHistory(textChannel, botUserId, maxMessages = 500) {
  const playlist = getPlaylist();
  const events = [];
  let before;
  let scanned = 0;

  while (scanned < maxMessages) {
    const limit = Math.min(100, maxMessages - scanned);
    const batch = await textChannel.messages.fetch({ limit, ...(before ? { before } : {}) }).catch(() => null);
    if (!batch?.size) break;
    for (const message of batch.values()) {
      if (message.author.id !== botUserId) continue;
      const parsed = parseNowPlayingMessage(message.content);
      if (!parsed) continue;
      let track = parsed.trackId ? playlist.find((entry) => entry.trackId === parsed.trackId) : null;
      if (!track) {
        const matches = playlist.filter((entry) => entry.title === parsed.title && entry.uploader === parsed.uploader);
        if (matches.length === 1) [track] = matches;
      }
      if (!track) continue;
      events.push({
        trackId: track.trackId,
        messageId: message.id,
        likes: reactionCount(message, '👍'),
        dislikes: reactionCount(message, '👎'),
        playId: parsed.playId,
        legacyTotals: !parsed.playId ? (() => {
          const totals = message.content.match(/\*\*All-time:\*\* 👍 (\d+) · 👎 (\d+) · ▶️ (\d+)/);
          return totals ? { likes: Number(totals[1]), dislikes: Number(totals[2]), plays: Number(totals[3]) } : undefined;
        })() : undefined,
      });
    }
    scanned += batch.size;
    before = batch.last()?.id;
    if (batch.size < limit) break;
  }

  return reconcileRatings(events);
}

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

export async function submitJukeLoopVote({ playId, voterId, vote }, saveVote = applySiteVote) {
  if (typeof playId !== 'string' || playId.length > 160 ||
      typeof voterId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(voterId) ||
      (vote !== 1 && vote !== -1)) throw new Error('Invalid radio vote');
  const session = [..._sessions.values()].find((entry) =>
    !entry._destroyed && entry._nowPlaying?.audible && entry._nowPlaying.playId === playId);
  if (!session) throw new Error('This radio play has ended or is not audible yet');
  if (session._siteVotePlayId !== playId) {
    session._siteVotePlayId = playId;
    session._siteVoters = new Map();
  }
  const previous = session._siteVoters.get(voterId);
  if (previous !== undefined) return { playId, vote: previous, duplicate: true };
  if (session._siteVoters.size >= 5000) throw new Error('Voting capacity reached for this play');
  let acceptedVote = vote;
  let duplicate = false;
  if (session._nowPlaying.isDevert) {
    if (!session.devertPlayback?.recordMainRadioAdVote || !session._currentDevertAd) throw new Error('DeVert ad voting is not configured');
    const result = await session.devertPlayback.recordMainRadioAdVote({ campaignId: session._currentDevertAd.campaignId,
      radioPlayId: playId, voterId, vote });
    duplicate = result?.duplicate === true;
    if (duplicate) acceptedVote = result.vote;
  } else saveVote(session._nowPlaying.trackId, vote);
  session._siteVoters.set(voterId, acceptedVote);
  return { playId, vote: acceptedVote, duplicate };
}

/** The track currently audible in any JukeLoop voice session, or null. */
export function getJukeLoopNowPlaying() {
  for (const session of _sessions.values()) {
    if (session._nowPlaying) return { ...session._nowPlaying };
  }
  return null;
}

export function updateJukeLoopRadioSchedule({ events, schedule }) {
  for (const session of _sessions.values()) {
    if (Array.isArray(events)) session.setLivePerformanceEvents(events);
    if (Array.isArray(schedule)) session.setSchedule(schedule);
  }
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
function createFFmpegStream(url, { ad = false } = {}) {
  const args = [
    '-reconnect',           '1',
    '-reconnect_streamed',  '1',
    '-reconnect_delay_max', '5',
    '-i',                   url,
    ...(ad ? ['-t', String(DEVERT_MAX_AD_SECONDS)] : []),
    '-analyzeduration',     '0',
    '-loglevel',            '0',
    '-vn',
    // Ease each song in from silence so tracks never pop in at full volume.
    '-af', `afade=t=in:st=0:d=${FADE_IN_SECONDS}:curve=qsin`,
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

export function waitForAudioReady(stream, ffmpegProcess, timeoutMs = NEXT_TRACK_READY_TIMEOUT_MS) {
  if (stream.readableLength > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      stream.off('readable', ready);
      stream.off('error', failed);
      stream.off('end', ended);
      ffmpegProcess?.off?.('error', failed);
      ffmpegProcess?.off?.('exit', exited);
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    const failed = error => {
      cleanup();
      reject(error);
    };
    const ended = () => failed(new Error('FFmpeg ended before producing audio'));
    const exited = code => {
      if (stream.readableLength === 0) failed(new Error(`FFmpeg exited before producing audio (${code ?? 'unknown'})`));
    };
    stream.once('readable', ready);
    stream.once('error', failed);
    stream.once('end', ended);
    ffmpegProcess?.once?.('error', failed);
    ffmpegProcess?.once?.('exit', exited);
    timer = setTimeout(() => failed(new Error('Timed out preparing the next track')), timeoutMs);
    timer.unref?.();
  });
}

// ── JukeLoopSession ───────────────────────────────────────────────────────────

export class JukeLoopSession {
  /**
   * @param {object} opts
   * @param {import('discord.js').VoiceBasedChannel} opts.voiceChannel  - JukeLoop voice channel
   * @param {import('discord.js').TextBasedChannel}  opts.textChannel   - JukeLoop text channel
   * @param {import('discord.js').Client}            opts.client        - Discord client (for re-fetching CDN URLs)
    * @param {() => void} [opts.onTerminalDisconnect] - Called after Discord voice recovery fails
   */
    constructor({ voiceChannel, textChannel, client, ipfsGateway, onTerminalDisconnect, djuke, devertPlayback,
      schedule, livePerformanceEvents, audioPlayer, createStream }) {
    this.voiceChannel = voiceChannel;
    this.textChannel  = textChannel;
    this.client       = client;
    this.ipfsGateway  = ipfsGateway;
    this.onTerminalDisconnect = onTerminalDisconnect;
    this.djuke        = djuke || null;
    this.devertPlayback = devertPlayback || null;
    this._musicSinceAd = 0;
    this._currentDevertAd = null;
    this._failedDevertCampaignIds = new Set();
    this.schedule     = Array.isArray(schedule) ? schedule : defaultRadioSchedule();
    this.livePerformanceEvents = Array.isArray(livePerformanceEvents) ? livePerformanceEvents : [];
    this._liveEventId = null;
    this._activeShowKey = null;
    this._scheduleWatcher = null;
    this._started = false;
    this._currentPaid = null;
    this._djukeCooldownUntil = 0;
    this._createStream = createStream || createFFmpegStream;

    this._destroyed   = false;
    this._ffmpeg      = null;
    this._preparedNext = null;
    this._prepareTask = null;
    this._paidPollTimer = null;
    this._transitionTask = null;
    this._preparationEpoch = 0;
    this.connection   = null;
    this.player       = audioPlayer || createAudioPlayer();

    /** Shuffled queue for the current loop pass */
    this._queue      = [];
    this._queueIndex = 0;

    /** The "Now Playing" announcement message for the track *currently* playing */
    this._announcementMsg = null;
    this._announcementContext = null;
    /** The track entry currently playing (so we can store ratings when it ends) */
    this._currentTrack    = null;
    this._completedPlay   = null;
    /** Audible track and start time, published to the DecentBusking site. */
    this._nowPlaying      = null;

    this.player.on('stateChange', (oldState, newState) => {
      if (
        newState.status === AudioPlayerStatus.Playing &&
        this._nowPlaying && !this._nowPlaying.audible
      ) {
        this._nowPlaying.startedAt = Date.now();
        this._nowPlaying.audible = true;
        this._primeNext();
      }
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this._nowPlaying?.audible) {
        const endedAt = Date.now();
        this._completedPlay = {
          playId: this._nowPlaying.playId,
          trackId: this._nowPlaying.trackId,
          startedAt: this._nowPlaying.startedAt,
          endedAt,
          audibleMs: Math.max(0, endedAt - this._nowPlaying.startedAt),
          firstWeekBonus: this._nowPlaying.firstWeekBonus,
          announcementId: this._announcementMsg?.id,
        };
        if (this._currentDevertAd) this._musicSinceAd = 0;
        else if (this._completedPlay.audibleMs >= 30_000) this._musicSinceAd++;
        if (this.devertPlayback) {
          const durableRecord = this._currentDevertAd
            ? this.devertPlayback.recordCampaignImpression({ campaignId: this._currentDevertAd.campaignId,
                radioPlayId: this._nowPlaying.playId, mainRadio: this._currentDevertAd.mainRadio,
                audibleMs: this._completedPlay.audibleMs })
            : this.devertPlayback.recordCompletedMusicPlay({ playId: this._nowPlaying.playId,
                audibleMs: this._completedPlay.audibleMs });
          Promise.resolve(durableRecord)
            .catch(error => console.warn('[devert] Durable play record deferred:', error.message));
        }
      }
      this._collectReactions()
        .catch(error => console.warn('[jukeloop] Previous-track bookkeeping deferred:', error.message));
      this._currentDevertAd = null;
      this._nowPlaying = null;
      const activeShow = resolveActiveShow({
        now: Date.now(),
        schedule: this.schedule,
        livePerformanceEvents: this.livePerformanceEvents,
      });
      if (!this._destroyed && activeShow.type !== 'live_performance') {
        this._playNext().catch((err) =>
          console.error('[jukeloop] Unhandled error in _playNext:', err),
        );
      }
    });

    this.player.on('error', (err) => {
      console.error('[jukeloop] Audio player error:', err.message);
      if (this._currentDevertAd) {
        this._failedDevertCampaignIds.add(this._currentDevertAd.campaignId);
        this._currentDevertAd = null;
        this._nowPlaying = null;
        this._completedPlay = null;
        this._currentTrack = null;
        this._announcementMsg = null;
        this._announcementContext = null;
      }
      if (this._ffmpeg) {
        try { this._ffmpeg.kill(); } catch {}
        this._ffmpeg = null;
      }
      if (!this._destroyed) {
        this._collectReactions().catch(() => {});
        this._nowPlaying = null;
        this._playNext().catch(() => {});
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
    this.connection.on('error', error => {
      console.error(`[jukeloop] Voice connection error in ${this.voiceChannel.name} (${this.voiceChannel.id}):`, error.message);
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
        if (!this._destroyed) {
          console.warn('[jukeloop] Voice reconnect timed out; scheduling a fresh session.');
          this.destroy();
          this.onTerminalDisconnect?.();
        }
      }
    });
  }

  // ── Playback ────────────────────────────────────────────────────────────────

  /** Begin the infinite JukeLoop. */
  async start() {
    if (this._destroyed) return;
    this._started = true;
    this._syncScheduledShow({ requestPlayback: false });
    this._scheduleWatcher = setInterval(() => this._syncScheduledShow(), 1_000);
    this._scheduleWatcher.unref?.();
    this._refreshQueue();
    await this._playNext();
  }

  setLivePerformanceEvents(events) {
    this.livePerformanceEvents = Array.isArray(events) ? events : [];
    this._syncScheduledShow();
  }

  setSchedule(schedule) {
    this.schedule = Array.isArray(schedule) ? schedule : defaultRadioSchedule();
    this._syncScheduledShow();
  }

  _syncScheduledShow({ requestPlayback = true } = {}) {
    if (this._destroyed) return;
    const show = resolveActiveShow({
      now: Date.now(),
      schedule: this.schedule,
      livePerformanceEvents: this.livePerformanceEvents,
    });
    const event = show.type === 'live_performance' ? show.event : null;
    const eventId = event?.id || null;
    const previousEventId = this._liveEventId;
    const showKey = `${show.type}:${show.id || ''}`;

    if (eventId !== previousEventId) {
      this._liveEventId = eventId;
      if (event) {
        if (this.player.state.status !== AudioPlayerStatus.Idle) this.player.stop(true);
        this.textChannel.send({ content: `🔴 **Live performance block: ${event.title}** starts now.`,
          allowedMentions: { parse: [] }, flags: MessageFlags.SuppressNotifications,
        }).catch(() => {});
      } else if (previousEventId) {
        this.textChannel.send({ content: '📻 **Live performance block ended.** JukeLoop is resuming.',
          flags: MessageFlags.SuppressNotifications,
        }).catch(() => {});
      }
    }

    if (showKey !== this._activeShowKey) {
      this._preparationEpoch++;
      this._disposePrepared(this._preparedNext, 'Scheduled radio mode changed');
      this._preparedNext = null;
      const previousShowKey = this._activeShowKey;
      this._activeShowKey = showKey;
      if (show.type === 'weekly_top10' && !previousShowKey?.startsWith('weekly_top10:')) {
        const message = show.window === 'final-payroll-hour'
          ? `📊 **${show.label}** is live. Vote through the New York payroll cutoff at midnight for this week's chart.`
          : `📊 **${show.label}** is live. React 👍 or 👎 to vote in this week's chart.`;
        this.textChannel.send({ content: message, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressNotifications }).catch(() => {});
      } else if (previousShowKey?.startsWith('weekly_top10:') && show.type === 'normal_rotation') {
        const finalListenEnded = previousShowKey === 'weekly_top10:weekly-top10-final-listen';
        const message = finalListenEnded
          ? '📊 The weekly Top 10 final listen has ended at the payroll cutoff. Normal rotation resumes.'
          : '📊 The Top 10 hype hour has ended. Normal rotation resumes.';
        this.textChannel.send({ content: message, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressNotifications }).catch(() => {});
      }
      const enteringOrLeavingTopTen = previousShowKey &&
        (previousShowKey.startsWith('weekly_top10:') || show.type === 'weekly_top10');
      if (this._started && enteringOrLeavingTopTen && this.player.state.status !== AudioPlayerStatus.Idle) {
        this.player.stop(true);
      }
      if (this._started && show.type !== 'live_performance') this._refreshQueue();
    }

    if (!event && previousEventId && requestPlayback && this._started) {
      this._playNext().catch(error => console.error('[jukeloop] Could not resume after live event:', error.message));
    }
  }

  /** (Re)build the active queue for the current show slot. */
  _refreshQueue() {
    const activeShow = resolveActiveShow({
      now: Date.now(),
      schedule: this.schedule,
      livePerformanceEvents: this.livePerformanceEvents,
    });

    if (activeShow.type === 'weekly_top10') {
      const weeklyReport = getWeeklyPlayHistory({ weeks: 1, calendar: 'new-york' }).find(report => report.current);
      const topTenPool = rankWeeklyTopTenTracks(getPlaylist(), weeklyReport);
      this._queue = topTenPool.length > 0 ? topTenPool : getWeightedShuffledPlaylist();
    } else if (activeShow.type === 'live_performance') {
      this._queue = [];
    } else {
      this._queue = getWeightedShuffledPlaylist();
    }
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
    if (track.ipfsCid) {
      const ipfsUrl = await resolveStreamableIpfsUrl(this.ipfsGateway, track.ipfsCid);
      if (ipfsUrl) return ipfsUrl;
      console.warn(`[jukeloop] No IPFS gateway could stream "${track.title}"; using the Discord upload.`);
    }
    if (!track.channelId || !track.messageId) return null;

    try {
      const channel = await this.client.channels.fetch(track.channelId).catch(() => null);
      if (!channel) return null;
      const msg = await channel.messages.fetch(track.messageId).catch(() => null);
      if (!msg) return null;
      const attachment = msg.attachments.get(track.attachmentId)
        ?? msg.attachments.find((a) => a.name === track.filename);
      return attachment?.url ?? null;
    } catch {
      return null;
    }
  }

  async _prepareNextPlayback(forcedPaid = null) {
    if (this._destroyed) return null;
    const activeShow = resolveActiveShow({
      now: Date.now(),
      schedule: this.schedule,
      livePerformanceEvents: this.livePerformanceEvents,
    });
    if (activeShow.type === 'live_performance') return;

    // Paid DJuke requests jump ahead without consuming the free rotation slot.
    let paid = forcedPaid;
    if (!paid && this.djuke && activeShow.type !== 'weekly_top10' && Date.now() >= this._djukeCooldownUntil) {
      paid = await this.djuke.nextPaid();
      if (this._destroyed && paid) {
        await this.djuke.fail(paid.record, new Error('Radio stopped')).catch(() => {});
        return null;
      }
    }

    let devertAd = null;
    if (!paid && this.devertPlayback && this._musicSinceAd >= DEVERT_SONGS_PER_MAIN_AD && activeShow.type !== 'weekly_top10') {
      devertAd = await this.devertPlayback.nextMainRadioAd({ excludeCampaignIds: [...this._failedDevertCampaignIds] })
        .catch(error => { console.warn('[devert] Main-radio ad selection deferred:', error.message); return null; });
    }

    // Refill + reshuffle if we've exhausted the current pass
    if (!paid && !devertAd && this._queueIndex >= this._queue.length) {
      this._refreshQueue();
    }

    // Nothing to play → wait and retry
    if (!paid && !devertAd && this._queue.length === 0) {
      await this.textChannel
        .send({
          content: '📭 The JukeLoop playlist is empty.\n' +
          'Post audio files (MP3, M4A, etc.) in <#' + this.textChannel.id + '> to add tracks!',
          flags: MessageFlags.SuppressNotifications, allowedMentions: { parse: [] },
        })
        .catch(() => {});
      return null;
    }

    const track = paid ? paid.track : devertAd ? devertAd.track : this._queue[this._queueIndex];
    const queueIndex = !paid && !devertAd ? this._queueIndex : null;

    const url = await this._getFreshUrl(track);
    if (!url) {
      console.warn(`[jukeloop] Could not fetch URL for "${track.title}" (${track.messageId}), skipping.`);
      if (devertAd) this._failedDevertCampaignIds.add(devertAd.campaignId);
      await this.textChannel
        .send({ content: `⚠️ Skipping **${track.title}** — the original upload could not be found.`,
          flags: MessageFlags.SuppressNotifications,
        })
        .catch(() => {});
      if (paid && this.djuke) {
        await this.djuke.fail(paid.record, new Error('Paid recording could not be fetched')).catch(() => {});
        throw new Error(`Paid recording "${track.title}" could not be fetched`);
      }
      if (queueIndex !== null) this._queueIndex++;
      return this._prepareNextPlayback();
    }

    const showAfterMediaLookup = resolveActiveShow({
      now: Date.now(),
      schedule: this.schedule,
      livePerformanceEvents: this.livePerformanceEvents,
    });
    if (showAfterMediaLookup.type === 'live_performance') {
      if (paid && this.djuke) await this.djuke.fail(paid.record, new Error('Live performance block began before playback')).catch(() => {});
      return null;
    }

    try {
      const { stream, ffmpegProcess } = this._createStream(url, { ad: !!devertAd });
      await waitForAudioReady(stream, ffmpegProcess);
      if (this._destroyed) {
        try { ffmpegProcess.kill(); } catch {}
        if (paid && this.djuke) await this.djuke.fail(paid.record, new Error('Radio stopped')).catch(() => {});
        return null;
      }
      const resource = createAudioResource(stream, { inputType: StreamType.Raw });
      return { track, paid, devertAd, queueIndex, url, resource, ffmpegProcess };
    } catch (err) {
      console.error('[jukeloop] Failed to prepare track:', err.message);
      if (devertAd) {
        this._failedDevertCampaignIds.add(devertAd.campaignId);
      }
      await this.textChannel
        .send({ content: `⚠️ Skipping **${track.title}**: ${err.message}`, flags: MessageFlags.SuppressNotifications })
        .catch(() => {});
      if (paid && this.djuke) {
        await this.djuke.fail(paid.record, err).catch(() => {});
        throw err;
      }
      if (queueIndex !== null) this._queueIndex++;
      return this._prepareNextPlayback();
    }
  }

  _disposePrepared(prepared, reason = 'Prepared playback discarded') {
    if (!prepared) return;
    try { prepared.ffmpegProcess?.kill(); } catch {}
    if (prepared.paid?.record && this.djuke) {
      this.djuke.fail(prepared.paid.record, new Error(reason))
        .catch(error => console.warn('[jukeloop] Could not release prepared DJuke request:', error.message));
    }
  }

  _schedulePaidPriorityCheck() {
    clearTimeout(this._paidPollTimer);
    this._paidPollTimer = null;
    const activeShow = resolveActiveShow({
      now: Date.now(),
      schedule: this.schedule,
      livePerformanceEvents: this.livePerformanceEvents,
    });
    if (!this.djuke || !this._preparedNext || this._preparedNext.paid ||
      activeShow.type === 'weekly_top10' || activeShow.type === 'live_performance' ||
      this.player.state.status !== AudioPlayerStatus.Playing) return;
    this._paidPollTimer = setTimeout(() => {
      this._paidPollTimer = null;
      this._checkPreparedPaidPriority();
    }, DJUKE_PREFETCH_POLL_MS);
    this._paidPollTimer.unref?.();
  }

  _checkPreparedPaidPriority() {
    if (this._destroyed || this._prepareTask || !this._preparedNext || this._preparedNext.paid) return;
    const epoch = this._preparationEpoch;
    const task = (async () => {
      const paid = await this.djuke.nextPaid();
      if (!paid) {
        this._schedulePaidPriorityCheck();
        return this._preparedNext;
      }
      const regular = this._preparedNext;
      this._preparedNext = null;
      this._disposePrepared(regular);
      const prepared = await this._prepareNextPlayback(paid);
      if (epoch !== this._preparationEpoch) {
        this._disposePrepared(prepared, 'Scheduled radio mode changed');
        return null;
      }
      this._preparedNext = prepared;
      return prepared;
    })().catch(error => {
      console.warn('[jukeloop] DJuke priority check deferred:', error.message);
      this._schedulePaidPriorityCheck();
      return this._preparedNext;
    }).finally(() => {
      if (this._prepareTask === task) this._prepareTask = null;
    });
    this._prepareTask = task;
  }

  _primeNext() {
    if (this._destroyed || this._preparedNext || this._prepareTask) return;
    const epoch = this._preparationEpoch;
    const task = this._prepareNextPlayback()
      .then(prepared => {
        if (this._destroyed || epoch !== this._preparationEpoch) {
          this._disposePrepared(prepared, this._destroyed ? 'Radio stopped' : 'Scheduled radio mode changed');
          return null;
        }
        this._preparedNext = prepared;
        this._schedulePaidPriorityCheck();
        return prepared;
      })
      .catch(error => {
        console.warn('[jukeloop] Next track preparation deferred:', error.message);
        if (!this._destroyed && this.player.state.status === AudioPlayerStatus.Playing) {
          setTimeout(() => this._primeNext(), 1_000).unref?.();
        }
        return null;
      })
      .finally(() => {
        if (this._prepareTask === task) this._prepareTask = null;
      });
    this._prepareTask = task;
  }

  async _announcePrepared(prepared, playId) {
    const { track, devertAd, url } = prepared;
    const announcementContext = {
      playId,
      queueIndex: this._queueIndex,
      totalTracks: this._queue.length,
      url,
      paid: !!prepared.paid,
    };
    const message = devertAd
      ? `📢 **Sponsored campaign:** ${track.title} · campaign #${devertAd.campaignId}`
      : buildNowPlayingMessage(track, announcementContext);
    const msg = await this.textChannel
      .send({ content: message, flags: MessageFlags.SuppressNotifications, allowedMentions: { parse: [] } })
      .catch(() => null);
    if (!msg || devertAd || this._nowPlaying?.playId !== playId) return;
    await msg.react('👍').catch(() => {});
    await msg.react('👎').catch(() => {});
    if (this._nowPlaying?.playId === playId) {
      this._announcementMsg = msg;
      this._announcementContext = announcementContext;
    }
  }

  _startPrepared(prepared) {
    if (!prepared || this._destroyed) return false;
    if (this._ffmpeg && this._ffmpeg !== prepared.ffmpegProcess) {
      try { this._ffmpeg.kill(); } catch {}
    }
    this._ffmpeg = prepared.ffmpegProcess;
    this._currentPaid = prepared.paid?.record || null;
    this._currentDevertAd = prepared.devertAd;
    this._currentTrack = prepared.track;
    this._announcementMsg = null;
    this._announcementContext = null;
    if (prepared.queueIndex !== null && prepared.queueIndex === this._queueIndex) this._queueIndex++;
    const playId = `${prepared.track.trackId}:${Date.now()}`;
    this._nowPlaying = {
      playId,
      trackId: prepared.track.trackId,
      title: prepared.track.title,
      uploader: prepared.track.uploader,
      filename: prepared.track.filename || null,
      mediaType: mediaTypeFor(prepared.track.filename, prepared.track.mediaType),
      ipfsCid: prepared.track.ipfsCid || null,
      isDevert: !!prepared.devertAd,
      firstWeekBonus: prepared.track.firstWeekBonus === true,
      startedAt: Date.now(),
      audible: false,
    };
    this.player.play(prepared.resource);
    this._announcePrepared(prepared, playId)
      .catch(error => console.warn('[jukeloop] Now-playing announcement deferred:', error.message));
    console.log(`[jukeloop] Now playing: "${prepared.track.title}" by ${prepared.track.uploader}`);
    return true;
  }

  async _playNext() {
    if (this._destroyed) return;
    if (this._transitionTask) return this._transitionTask;
    const transition = (async () => {
      clearTimeout(this._paidPollTimer);
      this._paidPollTimer = null;
      let retryDelay = EMPTY_PLAYLIST_RETRY_MS;
      try {
        if (this._prepareTask) await this._prepareTask;
        let prepared = this._preparedNext;
        this._preparedNext = null;
        if (!prepared) prepared = await this._prepareNextPlayback();
        if (prepared) {
          this._startPrepared(prepared);
          return;
        }
      } catch (error) {
        retryDelay = 1_000;
        console.warn('[jukeloop] Next playback blocked:', error.message);
      }
      if (!this._destroyed) {
        const retry = setTimeout(() => this._playNext().catch(() => {}), retryDelay);
        retry.unref?.();
      }
    })().finally(() => {
      if (this._transitionTask === transition) this._transitionTask = null;
    });
    this._transitionTask = transition;
    return transition;
  }

  /**
   * Read 👍 / 👎 counts from the last "Now Playing" message and persist them.
   * Called automatically when the next track is about to start.
   */
  async _collectReactions() {
    const trackRef = this._currentTrack;
    const completedPlay = this._completedPlay;
    this._completedPlay = null;
    const paidRecord = this._currentPaid;
    this._currentPaid = null;
    const msgRef   = this._announcementMsg;
    const announcementContext = this._announcementContext;

    // Clear refs first so any re-entrant call is a no-op
    this._announcementMsg = null;
    this._currentTrack    = null;
    this._announcementContext = null;

    if (completedPlay?.trackId?.startsWith('devert:')) return;

    if (trackRef && completedPlay?.trackId === trackRef.trackId) {
      const recorded = recordAudiblePlay(trackRef.trackId, completedPlay);
      if (recorded.counted) {
        console.log(`[jukeloop] Counted weekly play for "${trackRef.title}" (${recorded.week}, ${Math.round(completedPlay.audibleMs / 1000)}s audible).`);
      }
    }
    if (paidRecord && this.djuke) {
      const play = trackRef && completedPlay?.trackId === trackRef.trackId ? completedPlay : null;
      await this.djuke.complete(paidRecord, play)
        .catch((err) => console.warn('[jukeloop] DJuke completion pending:', err.message));
    }
    if (!msgRef || !trackRef) return;

    try {
      const fresh = await msgRef.fetch().catch(() => null);
      if (!fresh) return;

      const likes = reactionCount(fresh, '👍');
      const dislikes = reactionCount(fresh, '👎');

      const updatedTrack = applyRating(trackRef.trackId, likes, dislikes, fresh.id);
      if (updatedTrack && announcementContext) {
        await fresh.edit(buildNowPlayingMessage(updatedTrack, {
          ...announcementContext,
          votingOpen: false,
        })).catch(() => {});
      }

      if (likes > 0 || dislikes > 0) {
        console.log(
          `[jukeloop] Ratings for "${trackRef.title}": +${likes} 👍 / -${dislikes} 👎`,
        );
      }
    } catch (err) {
      console.error('[jukeloop] Error collecting reactions:', err.message);
    }
  }

  /** Return an unplayed paid request to the queue and pause paid picks briefly. */
  async _releasePaid(reason) {
    const record = this._currentPaid;
    this._currentPaid = null;
    if (!record || !this.djuke) return;
    this._djukeCooldownUntil = Date.now() + 60_000;
    await this.djuke.fail(record, new Error(reason))
      .catch((err) => console.warn('[jukeloop] DJuke release failed:', err.message));
  }

  /** Stop all playback and disconnect from the voice channel. */
  destroy() {
    this._destroyed = true;
    clearTimeout(this._paidPollTimer);
    this._paidPollTimer = null;
    this._disposePrepared(this._preparedNext, 'Radio stopped');
    this._preparedNext = null;
    if (this._scheduleWatcher) {
      clearInterval(this._scheduleWatcher);
      this._scheduleWatcher = null;
    }
    this._nowPlaying = null;
    if (this._currentPaid && this.djuke) {
      this.djuke.fail(this._currentPaid, new Error('Radio stopped')).catch(() => {});
      this._currentPaid = null;
    }
    if (_sessions.get(this.voiceChannel.guild.id) === this) _sessions.delete(this.voiceChannel.guild.id);
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
export async function backfillFromChannel(jukeboxChannel, store = { addTrack, restoreTrackTitles }) {
  let added   = 0;
  let lastId  = undefined;
  const titles = [];

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
        if (!isDiscordAttachmentWithinLimit(attachment)) continue;

        const filename = attachment.name;
        const title    = getAttachmentTitle(attachment);
        titles.push({ trackId: attachment.id, legacyTrackId: `${msg.id}:${filename}`, title });

        const wasAdded = store.addTrack({
          attachmentId: attachment.id,
          messageId:  msg.id,
          channelId:  jukeboxChannel.id,
          filename,
          title,
          uploader:   msg.author.tag ?? msg.author.username ?? 'Unknown',
          uploaderId: msg.author.id,
          pinStatus:  'untracked',
        });

        if (wasAdded) added++;
      }
    }

    lastId = batch.last()?.id;
    if (batch.size < 100) break;
  }

  const retitled = store.restoreTrackTitles(titles);
  if (retitled) console.log(`[jukeloop] Restored ${retitled} original track title(s) with emoji/accents.`);
  console.log(`[jukeloop] Backfill complete — added ${added} new track(s).`);
  return added;
}
