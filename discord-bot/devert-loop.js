import { spawn } from 'node:child_process';
import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { AudioPlayerStatus, createAudioPlayer, createAudioResource, entersState,
  joinVoiceChannel, StreamType, VoiceConnectionStatus } from '@discordjs/voice';
import { resolveStreamableIpfsUrl } from './jukeloop.js';
import { DEVERT_MAX_AD_SECONDS } from '../js/devert-scheduler.mjs';

const MIN_AUDIBLE_MS = 30_000;
const RETRY_MS = 30_000;
const BETWEEN_ADS_MS = 1_500;
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';

function createStream(url) {
  const child = spawn(FFMPEG_BIN, ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', url, '-t', String(DEVERT_MAX_AD_SECONDS), '-analyzeduration', '0', '-loglevel', '0', '-vn',
    '-af', 'afade=t=in:st=0:d=0.6:curve=qsin', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'],
  { stdio: ['ignore', 'pipe', 'ignore'] });
  child.on('error', error => console.error('[devert-loop] FFmpeg:', error.message));
  return child;
}

export function createDevertLoopController({ player, playback, voiceChannel, textChannel,
  resolveAdUrl = cid => resolveStreamableIpfsUrl(process.env.IPFS_GATEWAY || 'https://dweb.link', cid),
  createStream: streamFactory = createStream, createResource = createAudioResource,
  now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
  minimumAudibleMs = MIN_AUDIBLE_MS, retryMs = RETRY_MS, betweenAdsMs = BETWEEN_ADS_MS, log = console }) {
  let current = null;
  let child = null;
  let stopped = false;
  let retryTimer = null;
  let errorIdlePending = false;
  let announcement = null;
  const failedCampaigns = new Map();

  const stopChild = () => {
    if (child) { try { child.kill(); } catch {} child = null; }
  };
  const scheduleNext = delay => {
    clearTimer(retryTimer);
    if (!stopped) {
      retryTimer = setTimer(() => runNext().catch(error => log.error('[devert-loop]', error.message)), delay);
      retryTimer?.unref?.();
    }
  };

  player.on('stateChange', (oldState, newState) => {
    if (newState.status === AudioPlayerStatus.Playing && oldState.status === AudioPlayerStatus.Buffering && current) {
      current.startedAt = now();
      current.audible = true;
    }
  });
  player.on(AudioPlayerStatus.Idle, async () => {
    if (errorIdlePending) { errorIdlePending = false; return; }
    stopChild();
    const completed = current;
    current = null;
    if (completed?.audible) {
      const audibleMs = now() - completed.startedAt;
      if (audibleMs >= minimumAudibleMs) {
        try {
          await playback.recordCampaignImpression({ campaignId: completed.campaignId,
            radioPlayId: completed.radioPlayId, mainRadio: false, audibleMs });
        } catch (error) {
          failedCampaigns.set(completed.campaignId, now() + 5 * 60_000);
          log.warn('[devert-loop] Durable impression pending:', error.message);
        }
      } else failedCampaigns.set(completed.campaignId, now() + 5 * 60_000);
    }
    scheduleNext(betweenAdsMs);
  });
  player.on('error', error => {
    if (current) failedCampaigns.set(current.campaignId, now() + 5 * 60_000);
    errorIdlePending = true;
    stopChild();
    current = null;
    log.warn('[devert-loop] Audio playback failed:', error.message);
    scheduleNext(retryMs);
  });

  async function runNext() {
    if (stopped || current) return;
    errorIdlePending = false;
    const timestamp = now();
    for (const [campaignId, retryAt] of failedCampaigns) if (retryAt <= timestamp) failedCampaigns.delete(campaignId);
    let ad;
    try { ad = await playback.nextDevertLoopAd({ excludeCampaignIds: [...failedCampaigns.keys()] }); }
    catch (error) { log.warn('[devert-loop] Campaign read failed:', error.message); scheduleNext(retryMs); return; }
    if (!ad) { scheduleNext(retryMs); return; }
    const url = await resolveAdUrl(ad.track.ipfsCid);
    if (!url) {
      failedCampaigns.set(ad.campaignId, timestamp + 5 * 60_000);
      log.warn(`[devert-loop] No gateway can stream campaign ${ad.campaignId}`);
      scheduleNext(1_000);
      return;
    }
    const radioPlayId = `devert-loop:${ad.campaignId}:${timestamp}`;
    announcement = null;
    child = streamFactory(url);
    current = { campaignId: ad.campaignId, radioPlayId, title: ad.track.title,
      ipfsCid: ad.track.ipfsCid, mediaType: ad.track.mediaType || 'audio/mpeg',
      startedAt: timestamp, audible: false };
    try { player.play(createResource(child.stdout, { inputType: StreamType.Raw })); }
    catch (error) {
      failedCampaigns.set(ad.campaignId, timestamp + 5 * 60_000);
      stopChild();
      current = null;
      log.warn('[devert-loop] Audio playback failed:', error.message);
      scheduleNext(retryMs);
      return;
    }
    announcement = await textChannel?.send({ content: `📢 **AdLoop:** ${ad.track.title}`, flags: MessageFlags.SuppressNotifications,
      allowedMentions: { parse: [] } }).catch(() => null);
    if (announcement?.react) {
      await announcement.react('👍').catch(() => {});
      await announcement.react('👎').catch(() => {});
    }
    log.log(`[devert-loop] Playing campaign ${ad.campaignId} in ${voiceChannel.name}.`);
  }

  return {
    start: runNext,
    async submitVote({ playId, voterId, vote, messageId }) {
      if (!current?.audible || playId && playId !== current.radioPlayId ||
          messageId && messageId !== announcement?.id) throw new Error('Vote only on the current audible VertLoop ad');
      return playback.recordMainRadioAdVote({ campaignId: current.campaignId,
        radioPlayId: current.radioPlayId, voterId, vote });
    },
    stop() { stopped = true; clearTimer(retryTimer); stopChild(); current = null; },
    getState() {
      return { ready: !stopped, nowPlaying: current ? { ...current, positionMs: current.audible ? Math.max(0, now() - current.startedAt) : 0 } : null };
    },
  };
}

export async function startDevertLoopWorker({ token, voiceChannelId, textChannelId, playback, onAdMessage, log = console }) {
  if (!token || !voiceChannelId || !playback) throw new Error('AdLoop requires a separate Discord token, voice channel, and DeVert scheduler');
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions,
    ...(onAdMessage ? [GatewayIntentBits.MessageContent] : [])] });
  let controller = null;
  let connection = null;
  let readyError;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  client.once(Events.ClientReady, async readyClient => {
    try {
      const voiceChannel = await readyClient.channels.fetch(voiceChannelId);
      const textChannel = textChannelId ? await readyClient.channels.fetch(textChannelId).catch(() => null) : null;
      if (!voiceChannel?.isVoiceBased()) throw new Error('VERTLOOP_VOICE_CHANNEL_ID must refer to a voice channel');
      connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator, group: `devert:${readyClient.user.id}` });
      connection.on('error', error => log.warn(`[devert-loop] Voice connection error in ${voiceChannel.name} (${voiceChannel.id}):`, error.message));
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
      const player = createAudioPlayer();
      connection.subscribe(player);
      controller = createDevertLoopController({ player, playback, voiceChannel, textChannel, log });
      player.on('error', error => log.warn('[devert-loop] Discord audio player:', error.message));
      await controller.start();
      log.log(`[devert-loop] Logged in as ${readyClient.user.tag}; joined ${voiceChannel.name}.`);
      resolveReady();
    } catch (error) {
      readyError = error;
      rejectReady(error);
    }
  });
  client.on(Events.Error, error => log.error('[devert-loop] Discord client:', error.message));
  client.on(Events.MessageCreate, message => {
    if (!message.author.bot && onAdMessage) Promise.resolve(onAdMessage(message))
      .catch(error => log.warn('[devert-loop] Ad intake failed:', error.message));
  });
  client.on(Events.MessageReactionAdd, (reaction, user) => {
    const vote = reaction.emoji.name === '👍' ? 1 : reaction.emoji.name === '👎' ? -1 : 0;
    if (!vote || user.bot || !controller || reaction.message.channelId !== textChannelId) return;
    controller.submitVote({ messageId: reaction.message.id, voterId: `discord:${user.id}`.replace(':', '_'), vote })
      .catch(error => log.warn('[devert-loop] Vote rejected:', error.message));
  });
  try { await client.login(token); await ready; }
  catch (error) { controller?.stop(); connection?.destroy(); client.destroy(); throw readyError || error; }
  return {
    getState: () => controller?.getState() || { ready: false, nowPlaying: null },
    submitVote: payload => controller ? controller.submitVote(payload) : Promise.reject(new Error('VertLoop is not ready')),
    stop() { controller?.stop(); connection?.destroy(); client.destroy(); },
  };
}