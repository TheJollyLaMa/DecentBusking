// discord-bot/jukeloop.js
// JukeLoop — 24/7 community radio that plays audio files posted in the
// #DecentJukebox channel on a rolling, rating-weighted playlist.
//
// How it works:
//  1. On startup `backfillFromChannel()` is called to harvest all historic
//     audio attachments from #DecentJukebox and register them in the
//     playlist-store.  Only tracks not already stored are added.
//  2. A `JukeLoopSession` broadcasts tracks in weighted-random order forever.
//     Discord voice can subscribe without controlling website playback.
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
import { getAddress } from 'ethers';
import { MessageFlags } from 'discord.js';
import { DEVERT_MAX_AD_SECONDS, DEVERT_SONGS_PER_MAIN_AD } from '../js/devert-scheduler.mjs';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} from '@discordjs/voice';
import { createVoiceConnectionSupervisor } from './voice-connection.js';
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
import { createPlaylistShow } from './playlist-show.js';
import { playlistTrackReason, radioPlaylistDefinition } from '../js/radio-playlists.mjs';
import { createTopTenHype } from './top-ten-hype.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const AUDIO_EXTENSIONS_RE = /\.(mp3|m4a|wav|ogg|flac|aac|opus|weba|mp4)$/i;
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';

const FADE_IN_SECONDS = 0.6;
const NEXT_TRACK_READY_TIMEOUT_MS = 20_000;
export const PLAYBACK_RECOVERY_TIMEOUT_MS = 120_000;
/** Silence between songs so website listeners can start the next track from 0:00 together. */
export const CHANGEOVER_GAP_MS = 2_500;
const DJUKE_PREFETCH_POLL_MS = 5_000;
const PAID_FETCH_RETRY_MS = 60_000;
const MAIN_RADIO_STATE_SCHEMA_VERSION = 1;
const MAIN_RADIO_FAILED_CAMPAIGN_SONGS = DEVERT_SONGS_PER_MAIN_AD;
const MAIN_RADIO_FAILED_CAMPAIGN_MS = 10 * 60_000;

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

function checksumAddress(address) {
  try { return getAddress(address); } catch { return address; }
}

function normalizeSponsor(sponsor) {
  if (!sponsor) return null;
  if (sponsor.kind === 'djuke') {
    return {
      kind: 'djuke',
      wallet: checksumAddress(sponsor.wallet),
      amountUnits: String(sponsor.amountUnits),
      requestId: sponsor.requestId,
    };
  }
  if (sponsor.kind === 'devert') {
    return {
      kind: 'devert',
      wallet: checksumAddress(sponsor.wallet),
      campaignId: String(sponsor.campaignId),
    };
  }
  return null;
}

function shortAddress(address) {
  const value = String(address || '');
  return value.length > 10 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function formatUsdcUnits(units) {
  const value = BigInt(units || '0');
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${value / 1_000_000n}${fraction ? `.${fraction}` : ''}`;
}

function normalizeMainRadioAd(ad) {
  if (!ad || typeof ad !== 'object') return null;
  if (!/^\d+$/.test(String(ad.campaignId)) || typeof ad.mainRadio !== 'boolean' || !ad.track || typeof ad.track.trackId !== 'string') {
    throw new Error('Invalid DeVert main-radio ad journal entry');
  }
  return {
    campaignId: String(ad.campaignId),
    mainRadio: ad.mainRadio === true,
    track: structuredClone(ad.track),
  };
}

function validateMainRadioAdState(value) {
  if (!value || value.schemaVersion !== MAIN_RADIO_STATE_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.musicSinceAd) || value.musicSinceAd < 0 ||
    !Number.isSafeInteger(value.musicPlayCount) || value.musicPlayCount < 0 ||
    !Array.isArray(value.pendingDevertAds) || !Array.isArray(value.failedDevertCampaigns)) {
    throw new Error('Invalid DeVert main-radio ad journal');
  }
  return structuredClone({
    schemaVersion: MAIN_RADIO_STATE_SCHEMA_VERSION,
    musicSinceAd: value.musicSinceAd,
    musicPlayCount: value.musicPlayCount,
    preparedDevertAd: value.preparedDevertAd ? normalizeMainRadioAd(value.preparedDevertAd) : null,
    pendingDevertAds: value.pendingDevertAds.map(normalizeMainRadioAd),
    breakAwaitingUnlock: value.breakAwaitingUnlock === true,
    failedDevertCampaigns: value.failedDevertCampaigns.map(entry => {
      if (!entry || !/^\d+$/.test(String(entry.campaignId)) ||
        !Number.isSafeInteger(entry.failedAt) || entry.failedAt < 0 ||
        !Number.isSafeInteger(entry.musicPlayCount) || entry.musicPlayCount < 0) {
        throw new Error('Invalid DeVert main-radio failure journal entry');
      }
      return {
        campaignId: String(entry.campaignId),
        failedAt: entry.failedAt,
        musicPlayCount: entry.musicPlayCount,
      };
    }),
    lastSkip: value.lastSkip && typeof value.lastSkip === 'object'
      ? {
          reason: typeof value.lastSkip.reason === 'string' ? value.lastSkip.reason : '',
          campaignId: value.lastSkip.campaignId ? String(value.lastSkip.campaignId) : null,
          at: Number.isSafeInteger(value.lastSkip.at) && value.lastSkip.at >= 0 ? value.lastSkip.at : 0,
        }
      : null,
  });
}

/** Build a gateway URL for a raw IPFS CID. */
export function buildIpfsGatewayUrl(gateway, cid) {
  const [rawBase, query = ''] = gateway.split('?');
  const base = rawBase.replace(/\/$/, '');
  return `${base}${base.endsWith('/ipfs') ? '' : '/ipfs'}/${cid}${query ? `?${query}` : ''}`;
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

// The account's dedicated Pinata gateway; public gateways rate-limit shared hosting IPs.
let dedicatedIpfsGateways = [];
export function setDedicatedIpfsGateways(gateways) {
  dedicatedIpfsGateways = (Array.isArray(gateways) ? gateways : [gateways]).filter(value => typeof value === 'string' && value);
}

/** First gateway URL (configured, public Pinata, then dedicated Pinata) that can actually stream the CID, or null. */
export async function resolveStreamableIpfsUrl(gateway, cid, fetchImpl = fetch, extraGateways = dedicatedIpfsGateways) {
  const gateways = [...new Set([gateway, FALLBACK_IPFS_GATEWAY, ...extraGateways].filter(Boolean))];
  for (const candidate of gateways) {
    const url = buildIpfsGatewayUrl(candidate, cid);
    if (await isUrlStreamable(url, fetchImpl)) return url;
  }
  return null;
}

/** Public radio snapshot; positionMs lets browsers sync without trusting their own clocks. */
export function buildRadioState({ nowPlaying, upNext = null, playlist, now = Date.now(), recentLimit = 10, mainRadioAdCountdown = null, playback = null,
  activeShow = null, topTenHype = null, playlistShow = null, adVotes = null }) {
  const mediaTypeForTrack = (track) => (track.videoUrl || track.mediaType === 'video/mp4')
    ? 'video/mp4'
    : mediaTypeFor(track.filename, track.mediaType) || '';
  const recent = playlist.filter(track => !track.isDevertAd && (track.source !== 'site' || track.mintStatus === 'minted'))
    .sort((first, second) => Date.parse(second.addedAt) - Date.parse(first.addedAt))
    .slice(0, recentLimit)
    .map((track) => ({
      trackId: track.trackId,
      title: track.title,
      uploader: track.uploader,
      filename: track.filename || null,
      mediaType: mediaTypeForTrack(track),
      ipfsCid: track.ipfsCid || null,
      addedAt: track.addedAt,
    }));
  return {
    serverTime: now,
    playback,
    activeShow,
    topTenHype,
    playlistShow,
    nowPlaying: nowPlaying && nowPlaying.audible !== false
      ? (() => {
          const videoUrl = nowPlaying.videoUrl || (mediaTypeFor(nowPlaying.filename, nowPlaying.mediaType) === 'video/mp4'
            ? `ipfs://${nowPlaying.ipfsCid}`
            : '');
          const sponsor = normalizeSponsor(nowPlaying.sponsor);
          return {
            playId: nowPlaying.playId || `${nowPlaying.trackId}:${nowPlaying.startedAt}`,
            trackId: nowPlaying.trackId,
            title: nowPlaying.title,
            uploader: nowPlaying.uploader,
            filename: nowPlaying.filename || null,
            mediaType: mediaTypeForTrack(nowPlaying),
            ...(videoUrl ? { videoUrl } : {}),
            ipfsCid: nowPlaying.ipfsCid || null,
            isDevert: nowPlaying.isDevert === true,
            ...(nowPlaying.isDevert ? { adVotes } : {}),
            ...(nowPlaying.playlistShow ? { playlistShow: { ...nowPlaying.playlistShow } } : {}),
            ...(nowPlaying.hype ? { hype: { ...nowPlaying.hype } } : {}),
            ...(nowPlaying.djukePlaylist ? { djukePlaylist: { ...nowPlaying.djukePlaylist } } : {}),
            ...(sponsor ? { sponsor } : {}),
            startedAt: nowPlaying.startedAt,
            positionMs: Math.max(0, now - nowPlaying.startedAt),
          };
        })()
      : null,
    // The already-prepared next item, so browsers can preload it before the changeover.
    upNext: upNext?.trackId
      ? (() => {
          const mediaType = mediaTypeForTrack(upNext);
          const videoUrl = upNext.videoUrl || (mediaType === 'video/mp4' && upNext.ipfsCid ? `ipfs://${upNext.ipfsCid}` : '');
          return {
            trackId: upNext.trackId,
            title: upNext.title,
            uploader: upNext.uploader,
            filename: upNext.filename || null,
            mediaType,
            ...(videoUrl ? { videoUrl } : {}),
            ipfsCid: upNext.ipfsCid || null,
            isDevert: upNext.isDevert === true,
            ...(Number.isFinite(upNext.startsAt)
              ? { startsAt: upNext.startsAt, startsInMs: Math.max(0, upNext.startsAt - now) }
              : {}),
          };
        })()
      : null,
    recent,
    mainRadioAdCountdown: mainRadioAdCountdown ? { ...mainRadioAdCountdown } : null,
  };
}

export async function buildMainRadioAdCountdown({ session, now = Date.now(), songsPerMainAd = DEVERT_SONGS_PER_MAIN_AD, paidQueue = null } = {}) {
  if (!session) {
    return { status: 'unavailable', reason: 'radio session unavailable', updatedAt: now, includesCurrentSong: false };
  }

  const activeShow = resolveActiveShow({
    now,
    schedule: session.schedule,
    livePerformanceEvents: session.livePerformanceEvents,
  });
  const summary = {
    updatedAt: now,
    activeShow: {
      type: activeShow.type,
      label: activeShow.label || '',
      window: activeShow.window || '',
    },
    includesCurrentSong: false,
    ...(paidQueue ? { paidQueue: paidQueue.unavailable ? { unavailable: true, reason: paidQueue.reason } : {
      pendingCount: paidQueue.pendingCount,
      immediateCount: paidQueue.requests.filter(request => request.tier === 1).length,
      playbackReady: !paidQueue.paused && paidQueue.playbackReady,
      reason: paidQueue.paused ? 'Priority queue paused' : paidQueue.playbackReason,
    } } : {}),
    ...(session._lastMainRadioAdSkip ? { lastSkip: { ...session._lastMainRadioAdSkip } } : {}),
  };
  // Skips recorded during this call must be reported, not the snapshot taken above.
  const latestSkip = () => (session._lastMainRadioAdSkip ? { lastSkip: { ...session._lastMainRadioAdSkip } } : {});

  if (session._currentDevertAd) {
    const audible = session._nowPlaying?.audible === true;
    return {
      ...summary,
      status: audible ? 'playing' : 'up_next',
      campaignId: String(session._currentDevertAd.campaignId),
      title: session._currentDevertAd.track?.title || 'Main radio advert',
      mainRadio: true,
      remainingSongs: 0,
      includesCurrentSong: false,
    };
  }

  const queuedAd = session._preparedDevertAd || session._pendingDevertAds?.[0] || null;
  if (queuedAd) {
    return {
      ...summary,
      status: 'up_next',
      campaignId: String(queuedAd.campaignId),
      title: queuedAd.track?.title || 'Main radio advert',
      mainRadio: true,
      remainingSongs: 0,
      includesCurrentSong: false,
    };
  }

  if (!session.devertPlayback) {
    return { ...summary, status: 'unavailable', reason: 'main-radio scheduler unavailable' };
  }

  try {
    const gas = session.devertPlayback.getWorkerGasState ? await session.devertPlayback.getWorkerGasState() : null;
    if (gas?.lowBalance) {
      return {
        ...summary,
        status: 'unavailable',
        reason: 'worker gas low',
        workerAddress: gas.workerAddress || '',
        balanceWei: gas.balanceWei ?? null,
        thresholdWei: gas.thresholdWei ?? null,
        runwayDays: gas.runwayDays ?? null,
      };
    }
  } catch (error) {
    console.warn('[devert] Worker gas status unavailable:', error.message);
    return { ...summary, status: 'unavailable', reason: 'worker gas check unavailable' };
  }

  if (activeShow.type === 'live_performance' || activeShow.type === 'weekly_top10') {
    return {
      ...summary,
      status: 'paused',
      reason: activeShow.label || activeShow.type,
    };
  }

  const songsSinceAd = Number.isSafeInteger(session._musicSinceAd) ? session._musicSinceAd : 0;
  const remainingSongs = Math.max(0, songsPerMainAd - songsSinceAd);
  if (remainingSongs > 0) {
    return {
      ...summary,
      status: 'countdown',
      remainingSongs,
      mainRadio: true,
    };
  }

  let nextAd = null;
  try {
    nextAd = await session.devertPlayback.nextMainRadioAd({
      excludeCampaignIds: session._getActiveFailedDevertCampaignIds ? session._getActiveFailedDevertCampaignIds() : [],
      count: 1,
    });
  } catch (error) {
    const lowGas = error?.code === 'INSUFFICIENT_FUNDS' || /insufficient funds/i.test(error?.shortMessage || error?.message || '');
    if (!lowGas) console.warn('[devert] Main radio ad lookup failed:', error?.message || error);
    if (session._setMainRadioAdSkip) session._setMainRadioAdSkip(lowGas ? 'worker gas low' : 'main-radio scheduler unavailable', null);
    return {
      ...summary,
      ...latestSkip(),
      status: 'unavailable',
      reason: lowGas ? 'worker gas low' : 'main-radio scheduler unavailable',
    };
  }

  const campaign = Array.isArray(nextAd) ? nextAd[0] : nextAd;
  if (!campaign) {
    if (session._lastMainRadioAdSkip?.reason === 'selection deferred') {
      return {
        ...summary,
        status: 'unavailable',
        reason: 'main-radio scheduler unavailable',
      };
    }
    if (session._setMainRadioAdSkip) session._setMainRadioAdSkip('no eligible campaign available', null);
    return {
      ...summary,
      ...latestSkip(),
      status: 'none',
      reason: 'no eligible campaign available',
      remainingSongs: 0,
      mainRadio: true,
    };
  }

  return {
    ...summary,
    status: 'up_next',
    campaignId: String(campaign.campaignId),
    title: campaign.track?.title || 'Main radio advert',
    remainingSongs: 0,
    mainRadio: true,
  };
}

export function buildNowPlayingMessage(track, { queueIndex, totalTracks, url, votingOpen = true, playId, paid = false, sponsor = null, hype = null, playlistShow = null }) {
  const listenLink = track.ipfsCid && /\/ipfs\//.test(url || '') ? `\n[Open IPFS audio](${url})` : '';
  const idLine = `\nTrack \`${track.trackId}\`` + (playId ? ` · Play \`${playId}\`` : '');
  const votingLine = votingOpen
    ? 'React 👍 to boost it or 👎 to send it lower in the rotation.'
    : 'This play has finished. Your 👍 / 👎 reactions still update the master tally.';
  const sponsorLine = sponsor?.kind === 'djuke'
    ? `💸 **DJuke paid request** · bumped by \`${shortAddress(sponsor.wallet)}\` · ${formatUsdcUnits(sponsor.amountUnits)} USDC\n`
    : sponsor?.kind === 'devert'
      ? `📣 **DeVert ad** · sponsored by \`${shortAddress(sponsor.wallet)}\`\n`
      : '';
  return (
    `🎵 Now playing: **${track.title}** by *${track.uploader}* ` +
    `(${queueIndex}/${totalTracks})\n` +
    (hype ? `🎉 **Friday Top10 Hype${hype.encore ? ' · Encore' : ''}** · Opening chart #${hype.openingRank}${hype.openingRank === 1 && !hype.encore ? ' · 🏆 Opening-chart headliner!' : ''}\nLive votes can change the current chart; this play order is fixed.\n` : '') +
    (playlistShow ? `📻 **${playlistShow.title}** · Vote up OR down — help these songs find their place in the rotation.\n` : '') +
    (paid ? sponsorLine || '💸 **DJuke paid request**\n' : '') +
    `**All-time:** 👍 ${track.likes ?? 0} · 👎 ${track.dislikes ?? 0} · ▶️ ${track.plays ?? 0}\n` +
    `${idLine}\n` +
    `${votingLine}${listenLink}`
  );
}

export function parseNowPlayingMessage(content) {
  const match = content.match(/^🎵 Now playing: \*\*(.+?)\*\* by \*(.+?)\*/);
  if (!match) return null;
  const trackId = content.match(/Track(?: ID)?:? (?:\|\||`)(.+?)(?:\|\||`)/)?.[1] || null;
  const playId = content.match(/Play(?: ID)?:? (?:\|\||`)(.+?)(?:\|\||`)/)?.[1];
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

/** The prepared next item in any JukeLoop voice session, or null. */
export function getJukeLoopUpNext() {
  for (const session of _sessions.values()) {
    const upNext = session.getUpNext();
    if (upNext) return upNext;
  }
  return null;
}

export function getActiveJukeLoopSession() {
  return _sessions.values().next().value ?? null;
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
  session._sessionKey = guildId;
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
      stream.destroy();
      ffmpegProcess?.kill?.();
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
      schedule, livePerformanceEvents, audioPlayer, createStream, mainRadioAdStateStore, restoreMainRadioAdState, saveMainRadioAdState,
      topTenHype, topTenHypeStore, playlistShow, playlistShowStore, audioReadyTimeoutMs = NEXT_TRACK_READY_TIMEOUT_MS, websitePlayback = false }) {
    this.websitePlayback = websitePlayback;
    this._discordOutputsAttached = false;
    this._discordOutputsBlocked = false;
    this.voiceChannel = voiceChannel;
    this.textChannel  = textChannel;
    this.client       = client;
    this.ipfsGateway  = ipfsGateway;
    this.onTerminalDisconnect = onTerminalDisconnect;
    this._audioReadyTimeoutMs = audioReadyTimeoutMs;
    this._playbackIdleSince = null;
    this.djuke        = djuke || null;
    this.devertPlayback = devertPlayback || null;
    this._topTenHype = topTenHype || createTopTenHype({ store: topTenHypeStore });
    this._hypeNotice = null;
    this._playlistShow = playlistShow || createPlaylistShow({ store: playlistShowStore });
    this._mainRadioAdStateStore = mainRadioAdStateStore || null;
    this._restoreMainRadioAdState = restoreMainRadioAdState || this._mainRadioAdStateStore?.restore || null;
    this._saveMainRadioAdState = saveMainRadioAdState || this._mainRadioAdStateStore?.save || null;
    this._mainRadioAdStateReady = !this._restoreMainRadioAdState;
    this._mainRadioAdStateLoadTask = null;
    this._mainRadioAdStateSaveTask = Promise.resolve();
    this._musicSinceAd = 0;
    this._musicPlayCount = 0;
    this._currentDevertAd = null;
    this._preparedDevertAd = null;
    this._pendingDevertAds = [];
    this._failedDevertCampaigns = new Map();
    this._lastMainRadioAdSkip = null;
    this.schedule     = Array.isArray(schedule) ? schedule : defaultRadioSchedule();
    this.livePerformanceEvents = Array.isArray(livePerformanceEvents) ? livePerformanceEvents : [];
    this._liveEventId = null;
    this._activeShowKey = null;
    this._scheduleWatcher = null;
    this._started = false;
    this._currentPaid = null;
    this._djukeCooldownUntil = 0;
    this._paidFetchNotices = new Set();
    this._createStream = createStream || createFFmpegStream;

    this._destroyed   = false;
    this._ffmpeg      = null;
    this._preparedNext = null;
    this._prepareTask = null;
    this._paidPollTimer = null;
    this._transitionTask = null;
    this._preparationEpoch = 0;
    /** Earliest time the next item may start, and the item waiting out that changeover gap. */
    this._changeoverAt = 0;
    this._changeoverPrepared = null;
    /** True while the queued advert break was picked early and still needs the current song to count. */
    this._breakAwaitingUnlock = false;
    this.connection   = null;
    this._voiceConnection = null;
    this.player       = audioPlayer || createAudioPlayer(websitePlayback
      ? { behaviors: { noSubscriber: NoSubscriberBehavior.Play } }
      : {});

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
        this._changeoverAt = endedAt + CHANGEOVER_GAP_MS;
        this._completedPlay = {
          playId: this._nowPlaying.playId,
          trackId: this._nowPlaying.trackId,
          startedAt: this._nowPlaying.startedAt,
          endedAt,
          audibleMs: Math.max(0, endedAt - this._nowPlaying.startedAt),
          finished: this._ffmpeg?.exitCode === 0,
          firstWeekBonus: this._nowPlaying.firstWeekBonus,
          announcementId: this._announcementMsg?.id,
        };
        if (this._currentDevertAd && (!this._currentDevertAd.paidRequest ||
            (this._currentPaid?.tier === 0 && this._completedPlay.finished))) {
          this._musicSinceAd = 0;
          this._musicPlayCount++;
          this._persistMainRadioAdState();
        } else if (!this._currentDevertAd && this._completedPlay.audibleMs >= 30_000) {
          this._musicSinceAd++;
          this._musicPlayCount++;
          this._persistMainRadioAdState();
        }
        if (this.devertPlayback && this._currentPaid?.kind !== 'devert') {
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
      const paidAdvert = this._currentPaid?.kind === 'devert';
      if (this._nowPlaying?.playlistShow && !this._nowPlaying.playlistShow.fallback && !this._nowPlaying.isDevert) {
        this._playlistShow.recordSkip({ ...this._nowPlaying.playlistShow, trackId: this._nowPlaying.trackId }, `Audio playback failed: ${err.message}`)
          .catch(error => console.warn('[playlist-show] Failure checkpoint unavailable:', error.message));
      }
      if (this._nowPlaying?.hype) {
        this._topTenHype.recordFailure(this._nowPlaying.trackId, `Audio playback failed: ${err.message}`)
          .catch(error => console.error('[top10-hype] Failed to checkpoint audio failure:', error.message));
      }
      if (this._currentDevertAd) {
        if (!paidAdvert) this._recordMainRadioAdFailure(this._currentDevertAd.campaignId, 'audio player error');
        this._currentDevertAd = null;
        this._nowPlaying = null;
        this._completedPlay = null;
        this._currentTrack = null;
        this._announcementMsg = null;
        this._announcementContext = null;
      }
      if (!paidAdvert) {
        this._pendingDevertAds = [];
        this._preparedDevertAd = null;
        this._persistMainRadioAdState();
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
    this._voiceConnection = createVoiceConnectionSupervisor({
      name: 'jukeloop',
      voiceChannel: this.voiceChannel,
      player: this.player,
      joinVoiceChannel,
      entersState,
      VoiceConnectionStatus,
      subscribe: connection => connection.subscribe(this.player),
      onReady: async connection => { this.connection = connection; },
      log: console,
    });
    await this._voiceConnection.connect();
    this.connection = this._voiceConnection.connection;
  }

  // ── Playback ────────────────────────────────────────────────────────────────

  /** Begin the infinite JukeLoop. */
  async start() {
    if (this._destroyed) return;
    this._started = true;
    await this._ensureMainRadioAdState();
    this._syncScheduledShow({ requestPlayback: false });
    this._scheduleWatcher = setInterval(() => {
      this._syncScheduledShow();
      this._checkPlaybackHealth();
    }, 1_000);
    this._scheduleWatcher.unref?.();
    this._refreshQueue();
    await this._playNext();
  }

  getPlaybackStatus(now = Date.now()) {
    const show = this.getShowState().activeShow;
    if (show.type === 'live_performance') return { status: 'paused', ready: false, reason: show.label || 'Live performance' };
    const voice = this._voiceConnection?.getState();
    if (this._destroyed || (!this.websitePlayback && voice?.voiceConnected === false)) {
      return { status: 'recovering', ready: false, reason: 'Radio voice connection is recovering' };
    }
    if (this._nowPlaying?.audible && this.player.state.status === AudioPlayerStatus.Playing) {
      return { status: 'playing', ready: true, reason: null };
    }
    if (show.type === 'normal_rotation' && this.djuke?.hasPendingPlaylist?.()) {
      return { status: 'preparing', ready: false,
        reason: this._playlistRetryReason || 'Continuing the paid playlist; waiting for its durable checkpoint or settlement' };
    }
    if (!this._queue.length && !this._prepareTask && !this._transitionTask && !this._preparedNext &&
        !this._nowPlaying && !this._currentPaid && !this._currentDevertAd) {
      return { status: 'empty', ready: false, reason: 'No playable recordings are available' };
    }
    const idleMs = this._playbackIdleSince === null ? 0 : Math.max(0, now - this._playbackIdleSince);
    return { status: idleMs >= PLAYBACK_RECOVERY_TIMEOUT_MS ? 'recovering' : 'preparing',
      ready: false, reason: 'Radio is preparing the next recording', idleMs };
  }

  _checkPlaybackHealth(now = Date.now()) {
    if (this._destroyed || !this._started) return;
    const playback = this.getPlaybackStatus(now);
    if (playback.ready || playback.status === 'paused' || playback.status === 'empty') {
      this._playbackIdleSince = null;
      return;
    }
    this._playbackIdleSince ??= now;
    if (now - this._playbackIdleSince < PLAYBACK_RECOVERY_TIMEOUT_MS) return;
    console.error(`[jukeloop] Playback stalled for ${PLAYBACK_RECOVERY_TIMEOUT_MS / 1000}s; restarting the radio session.`);
    this.destroy();
    Promise.resolve(this.onTerminalDisconnect?.())
      .catch(error => console.error('[jukeloop] Playback recovery failed:', error.message));
  }

  _sendPlaybackNotice(content) {
    if (!this.textChannel || this.client?.isReady?.() === false) return;
    this.textChannel.send({ content, flags: MessageFlags.SuppressNotifications, allowedMentions: { parse: [] } })
      .catch(error => this._reportDiscordOutputFailure(error));
  }

  _reportDiscordOutputFailure(error) {
    if (error.status === 403 || [50001, 50013].includes(error.code)) {
      this._discordOutputsBlocked = true;
      this._discordOutputsAttached = false;
      this.textChannel = null;
      console.error('[jukeloop] Discord text output paused: missing access/permissions. Website broadcast continues; fix permissions and restart JukeLoop.');
    } else {
      console.warn('[jukeloop] Discord text delivery failed; inspect Discord REST diagnostics.');
    }
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
        this._sendPlaybackNotice(`🔴 **Live performance block: ${event.title}** starts now.`);
      } else if (previousEventId) {
        this._sendPlaybackNotice('📻 **Live performance block ended.** JukeLoop is resuming.');
      }
    }

    if (showKey !== this._activeShowKey) {
      this._preparationEpoch++;
      this._disposePrepared(this._preparedNext, 'Scheduled radio mode changed');
      this._preparedNext = null;
      const previousShowKey = this._activeShowKey;
      this._activeShowKey = showKey;
      if (show.type === 'normal_rotation' && show.cancelledOccurrenceId) {
        this._musicSinceAd = Math.max(this._musicSinceAd, DEVERT_SONGS_PER_MAIN_AD);
      }
      if (previousShowKey === 'weekly_top10:friday-top10-hype' && show.id !== 'friday-top10-hype') {
        if (show.type === 'normal_rotation') this._musicSinceAd = Math.max(this._musicSinceAd, DEVERT_SONGS_PER_MAIN_AD);
        this._sendPlaybackNotice('🎉 **Friday Top 10 hype hour has ended at the scheduled handoff.** Any remaining opening-chart songs will not overrun the next show.');
      }
      if (show.type === 'playlist_show') {
        this._playlistShow.ensure(show, getPlaylist()).catch(error => console.warn('[playlist-show]', error.message));
        this._sendPlaybackNotice(`📻 **${show.label}** · Vote up OR down! The opening pool is shuffled; voted songs are dropped before their turn.`);
      }
      if (show.instanceId && show.id === 'friday-top10-hype') {
        this._ensureTopTenHype(show).catch(error => console.error('[top10-hype] Opening chart blocked:', error.message));
      }
      if (show.type === 'weekly_top10' && !previousShowKey?.startsWith('weekly_top10:')) {
        const message = show.window === 'final-payroll-hour'
          ? `📊 **${show.label}** is live. Vote through the New York payroll cutoff at midnight for this week's chart.`
          : `📊 **${show.label}** is live. React 👍 or 👎 to vote in this week's chart.`;
        this._sendPlaybackNotice(message);
      } else if (previousShowKey?.startsWith('weekly_top10:') && previousShowKey !== 'weekly_top10:friday-top10-hype' && show.type === 'normal_rotation') {
        const finalListenEnded = previousShowKey === 'weekly_top10:weekly-top10-final-listen';
        const message = finalListenEnded
          ? '📊 The weekly Top 10 final listen has ended at the payroll cutoff. Normal rotation resumes.'
          : '📊 The Top 10 hype hour has ended. Normal rotation resumes.';
        this._sendPlaybackNotice(message);
      }
      const enteringOrLeavingTopTen = previousShowKey &&
        (previousShowKey.startsWith('weekly_top10:') || show.type === 'weekly_top10');
      if (this._started && enteringOrLeavingTopTen && this.player.state.status !== AudioPlayerStatus.Idle) {
        this.player.stop(true);
      }
      if (this._started && show.type !== 'live_performance') this._refreshQueue();
      if (requestPlayback && !previousEventId && this._started && show.id === 'friday-top10-hype' &&
        this.player.state.status === AudioPlayerStatus.Idle) {
        this._playNext().catch(error => console.error('[jukeloop] Scheduled playback blocked:', error.message));
      }
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
      if (activeShow.instanceId && activeShow.id === 'friday-top10-hype') {
        this._queue = [];
        this._queueIndex = 0;
        return;
      }
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

  _ensureTopTenHype(show) {
    return this._topTenHype.ensure({ show, playlist: getPlaylist(),
      report: getWeeklyPlayHistory({ weeks: 1, calendar: 'new-york' }).find(report => report.current) });
  }

  getShowState(now = Date.now()) {
    const activeShow = resolveActiveShow({ now, schedule: this.schedule, livePerformanceEvents: this.livePerformanceEvents });
    return { activeShow, topTenHype: this._topTenHype.publicState(activeShow), playlistShow: this._playlistShow.publicState(activeShow) };
  }

  async _skipHype(selection, reason, options) {
    await this._topTenHype.advance(selection, reason);
    this._sendPlaybackNotice(`⚠️ Friday Top10 opening #${selection.openingRank}: **${selection.title}** skipped — ${reason}`);
    return this._prepareNextPlayback(null, { ...options, hypeAttempts: (options.hypeAttempts || 0) + 1 });
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
    if (!track.channelId || !track.messageId || this.client?.isReady?.() === false) return null;

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

  /**
   * @param {object|null} [forcedPaid]
   * @param {{ projectedMusicSinceAd?: number|null, allowAds?: boolean }} [options]
   *   projectedMusicSinceAd selects a due advert while the song that unlocks it is still playing;
   *   allowAds=false prepares music only and leaves any selected advert queued.
   */
  async _prepareNextPlayback(forcedPaid = null, options = {}) {
    const { projectedMusicSinceAd = null, allowAds = true } = options;
    if (this._destroyed) return null;
    await this._ensureMainRadioAdState();
    this._pendingDevertAds = this._pendingDevertAds.filter(ad => !this.devertPlayback?.isCampaignRemoved?.(ad.campaignId));
    if (this._preparedDevertAd && this.devertPlayback?.isCampaignRemoved?.(this._preparedDevertAd.campaignId)) {
      this._preparedDevertAd = null;
    }
    const activeShow = resolveActiveShow({
      now: Date.now(),
      schedule: this.schedule,
      livePerformanceEvents: this.livePerformanceEvents,
    });
    if (activeShow.type === 'live_performance') return;
    if (activeShow.type === 'playlist_show' && forcedPaid && this.djuke) {
      await this.djuke.release(forcedPaid.record, new Error('Paid request deferred during playlist show'));
      forcedPaid = null;
    }
    const isHype = !!activeShow.instanceId && activeShow.id === 'friday-top10-hype';
    let hypeSelection = null;
    if (isHype) {
      await this._ensureTopTenHype(activeShow);
      const state = this._topTenHype.publicState(activeShow);
      if (!state.tracks.length || (options.hypeAttempts || 0) >= state.tracks.length) {
        const notice = !state.tracks.length ? 'The opening Top10 chart is empty. No countdown is available; waiting until the scheduled handoff.'
          : 'No opening-chart recording could be played. The countdown will retry; skipped places are shown in the live panel.';
        if (this._hypeNotice !== notice) {
          this._hypeNotice = notice;
          this._sendPlaybackNotice(`📊 ${notice}`);
        }
        return null;
      }
      hypeSelection = this._topTenHype.next(getPlaylist());
      if (!hypeSelection.track) return this._skipHype(hypeSelection, 'Recording is no longer eligible or available.', options);
    }

    const musicSinceAd = Number.isFinite(projectedMusicSinceAd) ? projectedMusicSinceAd : this._musicSinceAd;
    const normalSlotDue = allowAds && (musicSinceAd >= DEVERT_SONGS_PER_MAIN_AD ||
      (!!(this._preparedDevertAd || this._pendingDevertAds.length) && !this._breakAwaitingUnlock));
    // Only immediate adverts and DJuke songs buy an extra break between ordinary slots.
    let paid = isHype || activeShow.type === 'playlist_show' ? null : forcedPaid;
    if (!paid && this.djuke && activeShow.type !== 'playlist_show' && activeShow.type !== 'weekly_top10' && Date.now() >= this._djukeCooldownUntil) {
      paid = await this.djuke.nextPaid({ allowBump: normalSlotDue });
      if (this._destroyed && paid) {
        await this.djuke.release(paid.record, new Error('Radio stopped')).catch(() => {});
        return null;
      }
    }

    let devertAd = paid?.record.kind === 'devert'
      ? { campaignId: paid.track.campaignId, mainRadio: paid.record.tier === 0, paidRequest: true, track: paid.track } : null;
    let selectionDeferred = false;
    if (devertAd?.mainRadio && !this._preparedDevertAd && !this._pendingDevertAds.length && this.devertPlayback) {
      // Reserve the normal break so the bump replaces its first slot, not an additional break.
      const ads = await this.devertPlayback.nextMainRadioAd({
        excludeCampaignIds: this._getActiveFailedDevertCampaignIds(), count: 2,
      }).catch(error => {
        console.warn('[devert] Ordinary break companions deferred:', error.message);
        return [];
      });
      const selectedAds = Array.isArray(ads) ? ads : ads ? [ads] : [];
      [this._preparedDevertAd, ...this._pendingDevertAds] = selectedAds;
      this._preparedDevertAd ||= null;
      this._breakAwaitingUnlock = this._musicSinceAd < DEVERT_SONGS_PER_MAIN_AD;
      await this._persistMainRadioAdState();
    }
    if (!allowAds || isHype) {
      // Music only: keep any selected advert queued for its real slot.
    } else if (!paid && this._preparedDevertAd) {
      devertAd = this._preparedDevertAd;
    } else if (!paid && this._pendingDevertAds.length) {
      this._preparedDevertAd = this._pendingDevertAds.shift();
      devertAd = this._preparedDevertAd;
      this._persistMainRadioAdState();
    } else if (!paid && this.devertPlayback && musicSinceAd >= DEVERT_SONGS_PER_MAIN_AD && activeShow.type !== 'weekly_top10') {
      const ads = await this.devertPlayback.nextMainRadioAd({
        excludeCampaignIds: this._getActiveFailedDevertCampaignIds(),
        count: 2,
      }).catch(error => {
        selectionDeferred = true;
        this._setMainRadioAdSkip('selection deferred', null);
        console.warn('[devert] Main-radio ad selection deferred:', error.message);
        return null;
      });
      const selectedAds = Array.isArray(ads) ? ads : ads ? [ads] : [];
      if (selectedAds.length) {
        [this._preparedDevertAd, ...this._pendingDevertAds] = selectedAds;
        devertAd = this._preparedDevertAd;
        this._breakAwaitingUnlock = this._musicSinceAd < DEVERT_SONGS_PER_MAIN_AD;
        this._persistMainRadioAdState();
      } else {
        this._setMainRadioAdSkip('no eligible campaign available', null);
      }
    }

    let playlistSelection = null;
    if (activeShow.type === 'playlist_show' && !paid && !devertAd) {
      try {
        playlistSelection = await this._playlistShow.next(activeShow, getPlaylist());
      } catch (error) {
        console.warn('[playlist-show] Normal rotation fallback:', error.message);
      }
    }

    // Refill + reshuffle if we've exhausted the current pass
    if (!isHype && !playlistSelection && !paid && !devertAd && this._queueIndex >= this._queue.length) {
      this._refreshQueue();
    }

    if (!isHype && activeShow.type === 'normal_rotation' && !paid && !devertAd && this.djuke?.hasPendingPlaylist?.()) {
      return null;
    }

    // Nothing to play → wait and retry
    if (!isHype && !playlistSelection && !paid && !devertAd && this._queue.length === 0) {
      this._sendPlaybackNotice('📭 The JukeLoop playlist is empty.\n' +
        (this.textChannel ? 'Post audio files (MP3, M4A, etc.) in <#' + this.textChannel.id + '> to add tracks!' : 'Waiting for playable recordings.'));
      return null;
    }

    const track = hypeSelection ? hypeSelection.track : playlistSelection ? playlistSelection.track : paid ? paid.track : devertAd ? devertAd.track : this._queue[this._queueIndex];
    const queueIndex = !hypeSelection && !playlistSelection && !paid && !devertAd ? this._queueIndex : null;

    let url;
    try { url = await this._getFreshUrl(track); }
    catch (error) {
      if (paid?.record.playlistBatchId !== undefined) {
        await this._retryPlaylistMedia(paid.record, error);
        return null;
      }
      throw error;
    }
    if (this._destroyed) {
      if (paid && this.djuke) await this.djuke.release(paid.record, new Error('Radio stopped during media lookup'));
      return null;
    }
    if (!url) {
      console.warn(`[jukeloop] Could not fetch URL for "${track.title}" (${track.messageId}), skipping.`);
      if (hypeSelection) return this._skipHype(hypeSelection, 'The recording could not be fetched.', options);
      if (playlistSelection) {
        await this._playlistShow.advance(playlistSelection, 'The recording could not be fetched');
        return this._prepareNextPlayback(null, options);
      }
      if (devertAd && !devertAd.paidRequest) {
        this._recordMainRadioAdFailure(devertAd.campaignId, 'ad file could not be fetched');
        this._preparedDevertAd = null;
        this._persistMainRadioAdState();
      }
      const skipNoticeKey = paid ? `paid:${paid.record.requestId}` : null;
      if (!skipNoticeKey || !this._paidFetchNotices.has(skipNoticeKey)) {
        if (skipNoticeKey) this._paidFetchNotices.add(skipNoticeKey);
        this._sendPlaybackNotice(paid
            ? `⏳ Paid request **${track.title}** can't be fetched right now — it stays queued for retry.`
            : `⚠️ Skipping **${track.title}** — the original upload could not be found.`);
      }
      if (paid && this.djuke) {
        if (paid.record.playlistBatchId !== undefined) {
          await this._retryPlaylistMedia(paid.record, new Error('Paid recording could not be fetched'));
          return null;
        }
        // Keep the request queued, but let free rotation play instead of leaving the radio silent.
        this._djukeCooldownUntil = Date.now() + PAID_FETCH_RETRY_MS;
        await this.djuke.fail(paid.record, new Error('Paid recording could not be fetched')).catch(() => {});
        return this._prepareNextPlayback(null, options);
      }
      if (queueIndex !== null) this._queueIndex++;
      return this._prepareNextPlayback(null, options);
    }

    const showAfterMediaLookup = resolveActiveShow({
      now: Date.now(),
      schedule: this.schedule,
      livePerformanceEvents: this.livePerformanceEvents,
    });
    if (showAfterMediaLookup.type === 'live_performance') {
      if (paid && this.djuke) await this.djuke.release(paid.record, new Error('Live performance block began before playback')).catch(() => {});
      return null;
    }

    try {
      const { stream, ffmpegProcess } = this._createStream(url, { ad: !!devertAd });
      await waitForAudioReady(stream, ffmpegProcess, this._audioReadyTimeoutMs);
      if (this._destroyed) {
        try { ffmpegProcess.kill(); } catch {}
        if (paid && this.djuke) await this.djuke.release(paid.record, new Error('Radio stopped')).catch(() => {});
        return null;
      }
      const resource = createAudioResource(stream, { inputType: StreamType.Raw });
      return { track, paid, devertAd, queueIndex, url, resource, ffmpegProcess, hype: hypeSelection, playlistShow: playlistSelection,
        playlistShowContext: activeShow.type === 'playlist_show'
          ? { title: activeShow.label, instanceId: activeShow.instanceId, fallback: !playlistSelection && !devertAd } : null };
    } catch (err) {
      console.error('[jukeloop] Failed to prepare track:', err.message);
      if (hypeSelection) return this._skipHype(hypeSelection, err.message, options);
      if (playlistSelection) {
        await this._playlistShow.advance(playlistSelection, err.message);
        return this._prepareNextPlayback(null, options);
      }
      if (devertAd && !devertAd.paidRequest) {
        this._recordMainRadioAdFailure(devertAd.campaignId, err.message || 'ad playback failed');
        this._preparedDevertAd = null;
        this._persistMainRadioAdState();
      }
      if (paid && this.djuke) {
        if (paid.record.playlistBatchId !== undefined) {
          await this._retryPlaylistMedia(paid.record, err);
          return null;
        }
        this._sendPlaybackNotice(`⚠️ Skipping **${track.title}**: ${err.message}`);
        await this.djuke.fail(paid.record, err).catch(() => {});
        throw err;
      }
      this._sendPlaybackNotice(`⚠️ Skipping **${track.title}**: ${err.message}`);
      if (queueIndex !== null) this._queueIndex++;
      return this._prepareNextPlayback(null, options);
    }
  }

  _disposePrepared(prepared, reason = 'Prepared playback discarded') {
    if (!prepared) return;
    try { prepared.ffmpegProcess?.kill(); } catch {}
    if (prepared.paid?.record && this.djuke) {
      this.djuke.release(prepared.paid.record, new Error(reason))
        .catch(error => console.warn('[jukeloop] Could not release prepared DJuke request:', error.message));
    }

  }

  async _retryPlaylistMedia(record, error) {
    const result = await this.djuke.retryMedia(record, error);
    this._setPlaylistMediaRetry(result);
  }

  _setPlaylistMediaRetry(result) {
    if (result.retrying) {
      this._djukeCooldownUntil = Date.now() + 5000 * 2 ** (result.retryNumber - 1);
      this._playlistRetryReason = `Paid playlist media retry ${result.retryNumber}/${result.maxRetries}; payment stays queued. No new payment required.`;
      this._sendPlaybackNotice(`⏳ ${this._playlistRetryReason}`);
    } else {
      this._playlistRetryReason = '';
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
    if (!this.djuke || !this._preparedNext || (this._preparedNext.paid && this._preparedNext.paid.record.tier !== 0) ||
      activeShow.type === 'playlist_show' || activeShow.type === 'weekly_top10' || activeShow.type === 'live_performance' ||
      this.player.state.status !== AudioPlayerStatus.Playing) return;
    this._paidPollTimer = setTimeout(() => {
      this._paidPollTimer = null;
      this._checkPreparedPaidPriority();
    }, Math.max(DJUKE_PREFETCH_POLL_MS, this._djukeCooldownUntil - Date.now()));
    this._paidPollTimer.unref?.();
  }

  _checkPreparedPaidPriority() {
    if (this._destroyed || this._prepareTask || !this._preparedNext ||
        (this._preparedNext.paid && this._preparedNext.paid.record.tier !== 0)) return;
    const epoch = this._preparationEpoch;
    const task = (async () => {
      if (Date.now() < this._djukeCooldownUntil) {
        this._schedulePaidPriorityCheck();
        return this._preparedNext;
      }
      const preparedBump = this._preparedNext.paid?.record.kind === 'devert' && this._preparedNext.paid.record.tier === 0;
      const normalSlotDue = !!this._preparedNext.devertAd;
      const paid = await this.djuke.nextPaid({ allowBump: normalSlotDue && !preparedBump, includeSongs: !preparedBump });
      if (!paid) {
        this._schedulePaidPriorityCheck();
        return this._preparedNext;
      }
      if (this._destroyed || epoch !== this._preparationEpoch || !this._preparedNext) {
        await this.djuke.release(paid.record, new Error('Radio mode changed during priority selection'));
        return null;
      }
      const regular = this._preparedNext;
      if (regular.paid) {
        try {
          await this.djuke.release(regular.paid.record, new Error('Immediate advert took priority before playback'));
        } catch (error) {
          await this.djuke.release(paid.record, error)
            .catch(releaseError => console.warn('[jukeloop] Could not release immediate advert after failed preemption:', releaseError.message));
          throw error;
        }
      }
      this._preparedNext = null;
      this._disposePrepared(regular.paid ? { ...regular, paid: null } : regular);
      const prepared = await this._prepareNextPlayback(paid);
      if (epoch !== this._preparationEpoch) {
        this._disposePrepared(prepared, 'Scheduled radio mode changed');
        return null;
      }
      this._preparedNext = prepared;
      if (prepared && (!prepared.paid || prepared.paid.record.tier === 0)) this._schedulePaidPriorityCheck();
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
    // If the playing song is music, it should count toward the advert cadence when it ends.
    const projectedMusicSinceAd = this._currentDevertAd
      ? this._currentDevertAd.paidRequest && this._currentPaid?.tier !== 0 ? this._musicSinceAd : 0
      : this._musicSinceAd + 1;
    const task = this._prepareNextPlayback(null, { projectedMusicSinceAd })
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
    if (!this.textChannel || this.client?.isReady?.() === false) return;
    const { track, devertAd, url } = prepared;
    const announcementContext = {
      playId,
      queueIndex: prepared.playlistShow ? prepared.playlistShow.cursor + 1 : prepared.hype ? prepared.hype.cursor % prepared.hype.totalTracks + 1 : this._queueIndex,
      totalTracks: prepared.playlistShow ? prepared.playlistShow.totalTracks : prepared.hype ? prepared.hype.totalTracks : this._queue.length,
      hype: prepared.hype,
      playlistShow: prepared.playlistShow || prepared.playlistShowContext,
      url,
      paid: !!prepared.paid,
      sponsor: this._nowPlaying?.sponsor || null,
    };
    const message = devertAd
      ? `${prepared.playlistShowContext ? `📻 **${prepared.playlistShowContext.title}** · Vote up OR down on the songs!\n` : ''}📢 **Sponsored campaign:** ${track.title} · campaign #${devertAd.campaignId}`
      : buildNowPlayingMessage(track, announcementContext);
    const msg = await this.textChannel
      .send({ content: message, flags: MessageFlags.SuppressNotifications, allowedMentions: { parse: [] } })
      .catch(error => {
        this._reportDiscordOutputFailure(error);
        return null;
      });
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
    if (prepared.paid?.record.kind === 'devert' &&
        ['weekly_top10', 'live_performance'].includes(this.getShowState().activeShow.type)) {
      this._disposePrepared(prepared, 'Protected show began before paid advert playback');
      return false;
    }
    if (prepared.paid?.record.kind === 'devert' && prepared.paid.record.tier === 0 &&
        this._musicSinceAd < DEVERT_SONGS_PER_MAIN_AD && (this._breakAwaitingUnlock ||
        !(this._preparedDevertAd || this._pendingDevertAds.length))) {
      this._disposePrepared(prepared, 'Normal advert slot was not reached');
      return false;
    }
    if (prepared.devertAd && this.devertPlayback?.isCampaignRemoved?.(prepared.devertAd.campaignId)) {
      this._disposePrepared(prepared, 'Advert removed from playback');
      return false;
    }
    if (this._ffmpeg && this._ffmpeg !== prepared.ffmpegProcess) {
      try { this._ffmpeg.kill(); } catch {}
    }
    this._ffmpeg = prepared.ffmpegProcess;
    this._currentPaid = prepared.paid?.record || null;
    if (this._currentPaid) this._playlistRetryReason = '';
    this._currentDevertAd = prepared.devertAd;
    if (prepared.devertAd && !prepared.devertAd.paidRequest) this._breakAwaitingUnlock = false;
    this._currentTrack = prepared.track;
    this._announcementMsg = null;
    this._announcementContext = null;
    if (prepared.queueIndex !== null && prepared.queueIndex === this._queueIndex) this._queueIndex++;
    const playId = `${prepared.track.trackId}:${Date.now()}`;
    const videoUrl = prepared.track.videoUrl || (mediaTypeFor(prepared.track.filename, prepared.track.mediaType) === 'video/mp4'
      ? `ipfs://${prepared.track.ipfsCid}`
      : '');
    this._nowPlaying = {
      playId,
      trackId: prepared.track.trackId,
      title: prepared.track.title,
      uploader: prepared.track.uploader,
      filename: prepared.track.filename || null,
      mediaType: prepared.track.videoUrl || mediaTypeFor(prepared.track.filename, prepared.track.mediaType) === 'video/mp4'
        ? 'video/mp4'
        : mediaTypeFor(prepared.track.filename, prepared.track.mediaType) || '',
      ...(videoUrl ? { videoUrl } : {}),
      ipfsCid: prepared.track.ipfsCid || null,
      isDevert: !!prepared.devertAd,
      ...(prepared.paid?.record.playlist ? { djukePlaylist: { ...prepared.paid.record.playlist } } : {}),
      ...((prepared.playlistShow || prepared.playlistShowContext) ? { playlistShow: {
        title: (prepared.playlistShow || prepared.playlistShowContext).title,
        instanceId: (prepared.playlistShow || prepared.playlistShowContext).instanceId,
        fallback: prepared.playlistShowContext?.fallback === true } } : {}),
      ...(prepared.hype ? { hype: { openingRank: prepared.hype.openingRank, encore: prepared.hype.encore } } : {}),
      ...(prepared.paid ? {
        sponsor: {
          kind: prepared.paid.record.kind === 'devert' ? 'devert' : 'djuke',
          wallet: checksumAddress(prepared.paid.record.payer),
          amountUnits: prepared.paid.record.amountUnits,
          requestId: prepared.paid.record.requestId,
          ...(prepared.devertAd ? { campaignId: prepared.devertAd.campaignId } : {}),
        },
      } : prepared.devertAd ? {
        sponsor: {
          kind: 'devert',
          wallet: checksumAddress(prepared.devertAd.track.advertiser),
          campaignId: prepared.devertAd.campaignId,
        },
      } : {}),
      firstWeekBonus: prepared.track.firstWeekBonus === true,
      startedAt: Date.now(),
      audible: false,
    };
    if (prepared.devertAd?.paidRequest && prepared.paid.record.tier === 0) {
      if (this._preparedDevertAd) this._preparedDevertAd = null;
      else this._pendingDevertAds.shift();
      this._breakAwaitingUnlock = false;
      this._persistMainRadioAdState();
    } else if (prepared.devertAd && !prepared.devertAd.paidRequest) {
      this._preparedDevertAd = null;
      this._persistMainRadioAdState();
    }
    this.player.play(prepared.resource);
    this._announcePrepared(prepared, playId)
      .catch(error => console.warn('[jukeloop] Now-playing announcement deferred:', error.message));
    console.log(`[jukeloop] Now playing: "${prepared.track.title}" by ${prepared.track.uploader}`);
    return true;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** Hold the prepared item until the changeover gap ends; null if the radio mode changed meanwhile. */
  async _waitForChangeover(prepared) {
    const waitMs = this._changeoverAt - Date.now();
    if (!(waitMs > 0)) return prepared;
    const epoch = this._preparationEpoch;
    this._changeoverPrepared = prepared;
    try {
      await this._sleep(waitMs);
    } finally {
      if (this._changeoverPrepared === prepared) this._changeoverPrepared = null;
    }
    if (this._destroyed || epoch !== this._preparationEpoch) {
      this._disposePrepared(prepared, this._destroyed ? 'Radio stopped' : 'Scheduled radio mode changed');
      return null;
    }
    return prepared;
  }

  /** Public metadata for the prepared next item, with its start time while the changeover gap runs. */
  getUpNext() {
    if (this._destroyed) return null;
    const waiting = this._changeoverPrepared;
    const prepared = waiting || this._preparedNext;
    const track = prepared?.track;
    if (!track?.trackId) return null;
    return {
      trackId: track.trackId,
      title: track.title,
      uploader: track.uploader,
      filename: track.filename || null,
      mediaType: track.mediaType || '',
      ...(track.videoUrl ? { videoUrl: track.videoUrl } : {}),
      ipfsCid: track.ipfsCid || null,
      isDevert: !!prepared.devertAd,
      ...(waiting ? { startsAt: this._changeoverAt } : {}),
    };
  }

  async _playNext() {
    if (this._destroyed) return;
    if (this._transitionTask) return this._transitionTask;
    const transition = (async () => {
      clearTimeout(this._paidPollTimer);
      this._paidPollTimer = null;
      let retryDelay = EMPTY_PLAYLIST_RETRY_MS;
      let prepared = null;
      const epoch = this._preparationEpoch;
      try {
        if (this._prepareTask) await this._prepareTask;
        prepared = this._preparedNext;
        this._preparedNext = null;
        if (prepared && !prepared.paid && !prepared.devertAd && !prepared.hype &&
            this.getShowState().activeShow.type === 'normal_rotation' && this.djuke?.hasPendingPlaylist?.()) {
          this._disposePrepared(prepared, 'Paid playlist continues');
          prepared = null;
        }
        // Prefetch may have run before the last song unlocked the next advert slot.
        if (prepared && !prepared.hype && !prepared.paid && !prepared.devertAd && this.devertPlayback &&
          this._musicSinceAd >= DEVERT_SONGS_PER_MAIN_AD) {
          try {
            const refreshed = await this._prepareNextPlayback();
            if (refreshed) {
              this._disposePrepared(prepared);
              prepared = refreshed;
            }
          } catch (error) {
            console.warn('[devert] Transition-time ad selection deferred; keeping prepared music:', error.message);
          }
        }
        if (!prepared) prepared = await this._prepareNextPlayback();
        if (!prepared && this.djuke?.hasPendingPlaylist?.()) retryDelay = 1_000;
        if (prepared?.paid?.record.kind === 'devert' && prepared.paid.record.tier === 0 &&
            this._breakAwaitingUnlock && this._musicSinceAd < DEVERT_SONGS_PER_MAIN_AD) {
          await this.djuke.release(prepared.paid.record, new Error('Normal advert slot not reached yet'));
          this._disposePrepared({ ...prepared, paid: null });
          prepared = await this._prepareNextPlayback(null, { allowAds: false });
        }
        // An advert picked early stays queued if the song that should have unlocked it did not count.
        if (prepared?.devertAd && !prepared.paid && this._breakAwaitingUnlock &&
          this._musicSinceAd < DEVERT_SONGS_PER_MAIN_AD) {
          this._disposePrepared(prepared, 'Advert slot not reached yet');
          prepared = await this._prepareNextPlayback(null, { allowAds: false });
        }
        if (prepared?.devertAd && !prepared.devertAd.paidRequest && this.devertPlayback?.canPlayCampaign &&
          !await this.devertPlayback.canPlayCampaign(prepared.devertAd.campaignId)) {
          this._disposePrepared(prepared, 'Campaign expired or removed before playback');
          this._preparedDevertAd = null;
          await this._persistMainRadioAdState();
          prepared = null;
          retryDelay = 1_000;
        }
        if (prepared) {
          if (epoch !== this._preparationEpoch) {
            this._disposePrepared(prepared, 'Scheduled radio mode changed');
            prepared = null;
            retryDelay = 1_000;
          }
        }
        if (prepared) {
          prepared = await this._waitForChangeover(prepared);
          if (this._destroyed) return;
          if (!prepared) retryDelay = 1_000;
        }
        if (prepared) {
          const show = this.getShowState().activeShow;
          if ((prepared.playlistShowContext && ['live_performance', 'weekly_top10'].includes(show.type)) ||
            (prepared.playlistShow && show.instanceId !== prepared.playlistShow.instanceId) ||
            (show.type === 'playlist_show' && !prepared.playlistShow && !prepared.paid && !prepared.devertAd &&
              this._playlistShow.publicState(show)?.status === 'ready') ||
            show.type === 'live_performance' || (prepared.paid && ['weekly_top10', 'playlist_show'].includes(show.type)) || (prepared.hype
            ? show.instanceId !== prepared.hype.instanceId
            : show.id === 'friday-top10-hype')) {
            this._disposePrepared(prepared, 'Scheduled handoff reached');
            prepared = null;
            retryDelay = 1_000;
          }
        }
        if (prepared?.paid && this.djuke?.canPlay &&
            !await this.djuke.canPlay(prepared.paid.record)) {
          this._disposePrepared(prepared, 'Paid request changed or lost priority before playback');
          prepared = null;
          retryDelay = 1_000;
        }
        if (prepared) {
          if (prepared.hype) {
            await this._topTenHype.advance(prepared.hype);
            if (this._destroyed || epoch !== this._preparationEpoch ||
              this.getShowState().activeShow.instanceId !== prepared.hype.instanceId) {
              this._disposePrepared(prepared, 'Friday Top10 ended during checkpoint');
              prepared = null;
              retryDelay = 1_000;
            }
          }
          if (prepared?.playlistShow) {
            const selection = prepared.playlistShow;
            const definition = radioPlaylistDefinition(selection.playlistId);
            const reason = () => playlistTrackReason(getPlaylist().find(track => track.trackId === selection.trackId), definition);
            const skipReason = reason();
            await this._playlistShow.advance(selection, skipReason);
            const afterCheckpoint = reason() || (this._destroyed || epoch !== this._preparationEpoch ||
              this.getShowState().activeShow.instanceId !== selection.instanceId ? 'Scheduled handoff reached before audio started' : null);
            if (skipReason || afterCheckpoint) {
              if (!skipReason) await this._playlistShow.recordSkip(selection, afterCheckpoint);
              this._disposePrepared(prepared, skipReason || afterCheckpoint);
              prepared = null;
              retryDelay = 1_000;
            }
          }
          if (prepared && this._startPrepared(prepared)) return;
          retryDelay = 1_000;
        }
      } catch (error) {
        this._disposePrepared(prepared, 'Playback checkpoint failed');
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

    if (paidRecord?.kind === 'devert' && this.djuke) {
      await this.djuke.complete(paidRecord, completedPlay?.trackId === trackRef?.trackId ? completedPlay : null);
      return;
    }
    if (completedPlay?.trackId?.startsWith('devert:')) return;

    if (trackRef && completedPlay?.trackId === trackRef.trackId) {
      const recorded = recordAudiblePlay(trackRef.trackId, completedPlay);
      if (recorded.counted) {
        console.log(`[jukeloop] Counted weekly play for "${trackRef.title}" (${recorded.week}, ${Math.round(completedPlay.audibleMs / 1000)}s audible).`);
      }
    }
    if (paidRecord && this.djuke) {
      const play = trackRef && completedPlay?.trackId === trackRef.trackId ? completedPlay : null;
      const recovery = await this.djuke.complete(paidRecord, play)
        .catch((err) => console.warn('[jukeloop] DJuke completion pending:', err.message));
      if (paidRecord.playlistBatchId !== undefined && recovery) this._setPlaylistMediaRetry(recovery);
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

  async getMainRadioAdCountdown(now = Date.now(), paidQueue = null) {
    await this._ensureMainRadioAdState();
    return buildMainRadioAdCountdown({ session: this, now, paidQueue });
  }

  async removeDevertCampaign(campaignId) {
    const matches = ad => ad && String(ad.campaignId) === String(campaignId);
    this._pendingDevertAds = this._pendingDevertAds.filter(ad => !matches(ad));
    if (matches(this._preparedDevertAd)) this._preparedDevertAd = null;
    if (matches(this._preparedNext?.devertAd)) {
      this._disposePrepared(this._preparedNext, 'Advert removed from playback');
      this._preparedNext = null;
    }
    await this._persistMainRadioAdState();
    if (matches(this._currentDevertAd)) this.player.stop(true);
  }

  _ensureMainRadioAdState() {
    if (this._mainRadioAdStateReady) return Promise.resolve();
    if (!this._mainRadioAdStateLoadTask) {
      this._mainRadioAdStateLoadTask = (async () => {
        if (!this._restoreMainRadioAdState) {
          this._mainRadioAdStateReady = true;
          return;
        }
        try {
          const restored = await this._restoreMainRadioAdState();
          if (restored) this._applyMainRadioAdState(validateMainRadioAdState(restored));
        } catch (error) {
          console.warn('[devert] Main-radio ad state restore failed:', error.message);
        } finally {
          this._mainRadioAdStateReady = true;
        }
      })();
    }
    return this._mainRadioAdStateLoadTask;
  }

  _applyMainRadioAdState(state) {
    this._musicSinceAd = Number.isSafeInteger(state.musicSinceAd) ? state.musicSinceAd : 0;
    this._musicPlayCount = Number.isSafeInteger(state.musicPlayCount) ? state.musicPlayCount : 0;
    this._preparedDevertAd = state.preparedDevertAd;
    this._pendingDevertAds = Array.isArray(state.pendingDevertAds) ? state.pendingDevertAds : [];
    this._breakAwaitingUnlock = state.breakAwaitingUnlock === true && Boolean(this._preparedDevertAd || this._pendingDevertAds.length);
    this._failedDevertCampaigns = new Map((state.failedDevertCampaigns || []).map(entry => [String(entry.campaignId), {
      failedAt: entry.failedAt,
      musicPlayCount: entry.musicPlayCount,
    }]));
    this._lastMainRadioAdSkip = state.lastSkip || null;
    this._pruneExpiredFailedDevertCampaigns();
  }

  _snapshotMainRadioAdState() {
    return validateMainRadioAdState({
      schemaVersion: MAIN_RADIO_STATE_SCHEMA_VERSION,
      musicSinceAd: this._musicSinceAd,
      musicPlayCount: this._musicPlayCount,
      preparedDevertAd: this._preparedDevertAd,
      pendingDevertAds: this._pendingDevertAds,
      breakAwaitingUnlock: this._breakAwaitingUnlock,
      failedDevertCampaigns: [...this._failedDevertCampaigns.entries()].map(([campaignId, entry]) => ({
        campaignId,
        failedAt: entry.failedAt,
        musicPlayCount: entry.musicPlayCount,
      })),
      lastSkip: this._lastMainRadioAdSkip,
    });
  }

  _persistMainRadioAdState() {
    if (!this._saveMainRadioAdState || this._destroyed) return Promise.resolve(null);
    this._pruneExpiredFailedDevertCampaigns();
    const snapshot = this._snapshotMainRadioAdState();
    const next = async () => {
      const uri = await this._saveMainRadioAdState(structuredClone(snapshot));
      if (typeof uri !== 'string' || !uri.startsWith('ipfs://')) {
        throw new Error('Main-radio ad state was not durably checkpointed');
      }
      return uri;
    };
    this._mainRadioAdStateSaveTask = this._mainRadioAdStateSaveTask.then(next, next)
      .catch(error => {
        console.warn('[devert] Main-radio ad state save failed:', error.message);
      });
    return this._mainRadioAdStateSaveTask;
  }

  _setMainRadioAdSkip(reason, campaignId) {
    this._lastMainRadioAdSkip = {
      reason,
      campaignId: campaignId ? String(campaignId) : null,
      at: Date.now(),
    };
    console.warn(`[devert] main-radio ad skipped: ${reason}${campaignId ? ` (campaign ${campaignId})` : ''}`);
    void this._persistMainRadioAdState();
  }

  _recordMainRadioAdFailure(campaignId, reason) {
    const key = String(campaignId);
    this._failedDevertCampaigns.set(key, { failedAt: Date.now(), musicPlayCount: this._musicPlayCount });
    this._setMainRadioAdSkip(reason, key);
  }

  _pruneExpiredFailedDevertCampaigns() {
    const now = Date.now();
    let changed = false;
    for (const [campaignId, entry] of this._failedDevertCampaigns.entries()) {
      if (now - entry.failedAt >= MAIN_RADIO_FAILED_CAMPAIGN_MS ||
        this._musicPlayCount - entry.musicPlayCount >= MAIN_RADIO_FAILED_CAMPAIGN_SONGS) {
        this._failedDevertCampaigns.delete(campaignId);
        changed = true;
      }
    }
    return changed;
  }

  _getActiveFailedDevertCampaignIds() {
    this._pruneExpiredFailedDevertCampaigns();
    return [...this._failedDevertCampaigns.keys()];
  }

  /** Stop all playback and disconnect from the voice channel. */
  destroy() {
    this._destroyed = true;
    clearTimeout(this._paidPollTimer);
    this._paidPollTimer = null;
    this._disposePrepared(this._preparedNext, 'Radio stopped');
    this._preparedNext = null;
    this._pendingDevertAds = [];
    this._preparedDevertAd = null;
    if (this._scheduleWatcher) {
      clearInterval(this._scheduleWatcher);
      this._scheduleWatcher = null;
    }
    this._nowPlaying = null;
    if (this._currentPaid && this.djuke) {
      this.djuke.release(this._currentPaid, new Error('Radio stopped')).catch(() => {});
      this._currentPaid = null;
    }
    const sessionKey = this._sessionKey ?? this.voiceChannel?.guild.id;
    if (_sessions.get(sessionKey) === this) _sessions.delete(sessionKey);
    if (this._ffmpeg) {
      try { this._ffmpeg.kill(); } catch {}
      this._ffmpeg = null;
    }
    this._voiceConnection?.stop();
    this.connection = null;
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
