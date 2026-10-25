import { createRadioAnnouncements, deserializeAnnouncements } from './radio-announcements.js';
import { createLiveBookings } from './live-bookings.js';
// discord-bot/index.js
// DecentBusking Discord Bot — entry point
//
// Features:
//  • Watches #DecentJukebox for audio file uploads and pins them to IPFS,
//    replies with a rich embed containing a "🎸 Mint This As A DNFT" deep-link,
//    AND adds the track to the JukeLoop playlist.
//  • JukeLoop: 24/7 audio stream in the JukeLoop voice channel, sourced from
//    #DecentJukebox uploads, ordered by 👍/👎 weighted ratings.
//  • /radio play <cid>  — bot joins your voice channel and streams all tracks
//                         from an IPFS album directory; announces each track.
//  • /radio skip|pause|stop — playback controls for the active radio session.
//  • /jukebox play <cid> — bot DMs you a numbered playlist of stream links.
//  • /jukeloop remove <title> — admin: remove a track from the JukeLoop playlist.
//  • /jukeloop stats          — show the top-rated JukeLoop tracks.
//  • /jukeloop volume <level> — (currently informational; voice volume is fixed).
//
// The bot does NOT hold an on-chain signing key. Artists queue mint requests;
// an authorized owner reviews them and confirms transactions in the browser.

import { RADIO_PLAYLISTS, previewRadioPlaylist } from '../js/radio-playlists.mjs';
import {
  Client,
  GatewayIntentBits,
  Events,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  Partials,
} from 'discord.js';

import http from 'http'; 
import fs from 'node:fs';
import { Contract, Interface, Wallet, id } from 'ethers';
import { createPaymentLedger, verifyRepositoryPayment } from './payment-ledger.js';
import { BUDGET_MODES, DEFAULT_MONTHLY_CU_BUDGET, baseRpcEndpointsFromEnv, createRpcRouter } from './rpc-router.js';
import { createRpcProxy } from './rpc-proxy.js';
import { createAlchemyWebhook } from './alchemy-webhook.js';
import { createFundLedger } from './fund-ledger.js';
import { createWeeklyPayflow, findBlockAtOrBefore, readClosingFundBalance } from './weekly-payflow.js';
import { createWeeklyPayrollReporter } from './weekly-payroll-report.js';
import { payrollPeriodFromKey, PAYROLL_TIME_ZONE } from '../js/payroll-week.mjs';

import { loadConfig }    from './config.js';
import { uploadToIPFS, createIpfsUploader }  from './ipfs.js';
import { backfillIpfsPins } from './ipfs-backfill.js';
import { syncMintedTracksFromChain, createVerifiedMintQueueReader, discoverPinataMetadataGateway, readOwnedDevertAds, resolveDevertCampaignMedia, resolveApprovedDevertCampaignMedia } from './mint-sync.js';
import { nftCatalogPage } from '../js/nft-loader.js';
import { supportsDjukeAlbumsAndGas } from '../js/djuke-version.mjs';
import { createDjukeQueueReader, createDjukePlaybackJournal, createDjukeRuntime, createDjukeFulfiller, createDjukeSongRegistrar, verifyDjukePlaylistWorker, DJUKE_ABI, DJUKE_PLAYLIST_WORKER_ABI } from './djuke.js';
import { createDevertQueueReader, createDevertQueueRuntime, createDevertQueueCatalogSync, combinePaidQueues } from './devert-queue.js';
import { devertQueueAbi } from '../js/devert-queue.mjs';
import { applyDevertDjukeBoosts, createDevertCampaignReader, DEVERT_ABI, resolveDevertSchedulerPrivateKey } from './devert.js';
import { createDevertPlaybackRuntime, initializeDevertPlaybackWithRetry } from './devert-playback.js';
import { startDevertLoopWorker, startDevertWebsiteLoopWorker } from './devert-loop.js';
import { DISCORD_REST_OPTIONS, loginDiscordClient, recoverDiscordConnection, watchDiscordSession } from './discord-login.js';
import { createDiscordDiagnostics } from './discord-diagnostics.js';
import { DEFAULT_WORKER_MIN_BALANCE_WEI } from '../js/worker-gas.mjs';
import { createWorkerReserve } from './worker-reserve.js';
import { createPinataStateStore, recoverVerifiedPlaylistBaseline } from './ipfs-state.js';
import { resolveAlbumArtist, checkpointReviewedAlbumImport } from './album-import.js';
import { createCheckpointMirror } from './checkpoint-mirror.js';
import { buildCommunityPinManifest } from '../js/pinner-rewards.mjs';
import { createCreatorProfiles } from './creator-profiles.js';
import { createArtworkUpdateQueue } from './artwork-updates.js';
import { createDjukeGasQuoteReader, createDjukePlaylistGasQuoteReader, DJUKE_GAS_ABI, DJUKE_PLAYLIST_GAS_ABI } from './djuke-gas.js';
import { createDjukePlaylistBatchReconciler, djukePlaylistReadiness, playlistBatchEventAbi, legacyPlaylistReceipts, playlistPlaybackFailure, playlistLaneStatus } from './djuke-playlist-batches.js';
import { createEnsResolver } from './ens-resolver.js';
import { createDevertRemovals } from './devert-removals.js';
import { ensureCheckpointGroups } from './checkpoint-groups.js';
import { createMintTransactionVerifier, createArtworkUpdateTransactionVerifier, createWorkerRequestHandler } from './ipfs-worker.js';
import { buildMintEmbed, buildMintRequestComponents } from './embed.js';
import { createMintRequestInteractionHandler, ensureDefaultMintArtwork } from './mint-interactions.js';
import { ROUTER_START_BLOCK, createEarningsLedger } from '../js/creator-earnings.mjs';
import { createSubmissionIntake, buildWalletButtons } from './submission-intake.js';
import { mediaTypeFor, normalizeMediaCid, MEDIA_TYPES, DISCORD_UPLOAD_MAX_BYTES, isDiscordAttachmentWithinLimit } from './media.js';
import { shouldHandleDevertLoopSubmission } from './submission-routing.js';
import { fetchTrackList, createSession, getSession } from './radio.js';
import {
  loadPlaylist,
  configureRemotePersistence,
  waitForRemotePersistence,
  addTrack,
  submitMediaTrack,
  getTrackId,
  getPlaylist,
  getMintBacklog,
  getMintRequests,
  getDevertAdsForWallet,
  mergeDevertAdsForWallet,
  queueUploaderMints,
  getTopTracks,
  removeTrack,
  requestTrackMint,
  completeTrackMint,
  updateTrackPin,
  hasPayrollHistoryRecovery,
  mergePayrollHistorySnapshot,
  seedPlaylistFromPayrollSnapshot,
  getWeeklyPlayHistory,
  getWeeklyPlayReport,
  getWeeklyPlayWeeks,
  getUtcWeekKey,
} from './playlist-store.js';
import { buildWeeklyPlayReportMessage } from './weekly-play-report.js';
import {
  createJukeLoopSession,
  getActiveJukeLoopSession,
  getJukeLoopSession,
  getJukeLoopNowPlaying,
  getJukeLoopUpNext,
  updateJukeLoopRadioSchedule,
  submitJukeLoopVote,
  buildRadioState,
  getVoiceRetryDelay,
  reconcileJukeLoopHistory,
  backfillFromChannel,
  getAttachmentTitle,
  synchronizeDiscordRating,
  setDedicatedIpfsGateways,
  buildIpfsGatewayUrl,
  resolveStreamableIpfsUrl,
} from './jukeloop.js';
import {
  upsertLivePerformanceEvent,
  removeLivePerformanceEvent,
  serializeLiveSchedule,
  deserializeLiveSchedule,
  defaultRadioSchedule,
} from '../js/radio-schedule.mjs';

const _jukeLoopRestartTimers = new Map();
const _jukeLoopRestartAttempts = new Map();
let _djukeRuntime = null;
let _radioPaidQueues = null;
let _devertPlaybackRuntime = null;
let _devertPlaybackInitialization = null;
let _devertLoopWorker = null;
let _devertSchedulerContract = null;
let _devertBoostTask = null;
const _devertBoostsInFlight = new Set();
const _devertAdsOnChainCache = new Map();
const _devertAdsOnChainScans = new Map();
let liveScheduleStore = null;
let livePerformanceEvents = [];
let liveWeeklySchedule = {};
let liveScheduleReady = false;
let _mintSyncTask = null;
const _mintTokenCaches = new Map();
let _nftCatalog = null;
let _nftCatalogCheckedAt = 0;
let _nftCatalogError = '';
let _nftMetadataGateways = null;
let _dedicatedGatewayTask = null;

/** Discover the account's dedicated Pinata gateway once; null when unavailable. */
function discoverDedicatedGateway(config) {
  if (!_dedicatedGatewayTask) {
    _dedicatedGatewayTask = (config.pinataJwt
      ? discoverPinataMetadataGateway({ pinataJwt: config.pinataJwt })
      : Promise.reject(new Error('PINATA_JWT is not configured')))
      .then(gateway => {
        setDedicatedIpfsGateways([gateway]);
        return gateway;
      })
      .catch(error => {
        console.warn('[ipfs] Dedicated Pinata gateway discovery failed, using public gateways:', error.message);
        _dedicatedGatewayTask = null;
        return null;
      });
  }
  return _dedicatedGatewayTask;
}
const IPFS_BACKFILL_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STATE_RESTORE_ATTEMPTS = 3;
const WEEKLY_REPORT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PAYROLL_RECOVERY_CIDS = [
  'bafybeiamfpzoadbpbjbu4usncdlxpgbg3p5besebug7tofsipmp2g2mply',
  'bafkreigl2kr22jpet5emu4umwuoznzyzth7gsm7vzld74seammdbqoakjm',
];

async function runWeeklyPlayReport(client, config) {
  const channelId = config.jukeLoopTextChannelId;
  if (!channelId) return;
  const now = Date.now();
  const currentWeek = getUtcWeekKey(new Date(now));
  const previousWeek = getUtcWeekKey(new Date(now - 7 * 24 * 60 * 60 * 1000));
  const [currentYear, currentWeekNumber] = currentWeek.split('-W').map(Number);
  const weekStart = new Date(Date.UTC(currentYear, 0, 4 + (currentWeekNumber - 1) * 7));
  weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7));
  if (now < weekStart.getTime() + 5 * 60 * 1000) return;
  if (!getWeeklyPlayWeeks().includes(previousWeek)) return;
  const report = getWeeklyPlayReport(previousWeek);
  if (!report.totalPlays) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.messages) return;
  const marker = `jukeloop-weekly-report:${previousWeek}`;
  const monday = new Date(`${previousWeek.slice(0, 4)}-01-04T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() + (Number(previousWeek.slice(6)) - 1) * 7 - ((monday.getUTCDay() + 6) % 7));
  let before;
  let alreadyPosted = false;
  for (let page = 0; page < 40; page++) {
    const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch((err) => {
      console.warn('[weekly-play-report] Could not check existing reports:', err.message);
      return null;
    });
    if (messages === null) return;
    if (!messages?.size) break;
    for (const message of messages.values()) {
      if (message.content?.includes(marker)) { alreadyPosted = true; break; }
    }
    if (alreadyPosted) break;
    const last = messages.last();
    before = last?.id;
    if (!last || last.createdTimestamp < monday.getTime() || messages.size < 100) break;
  }
  if (alreadyPosted) return;
  await channel.send(buildWeeklyPlayReportMessage(report));
  console.log(`[weekly-play-report] Posted ${previousWeek}: ${report.totalPlays} qualifying plays.`);
}

// Background pollers slow down when the Alchemy budget is tight; user-facing and transaction paths are unaffected.
const BUDGET_POLL_FLOOR_MS = { [BUDGET_MODES.conserve]: 3 * 60_000, [BUDGET_MODES.criticalOnly]: 5 * 60_000, [BUDGET_MODES.exhausted]: 5 * 60_000 };
// With verified Alchemy webhooks pushing changes, chain pollers become a slow safety net.
const WEBHOOK_SAFETY_POLL_MS = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY
  ? Math.max(60_000, Number(process.env.WEBHOOK_SAFETY_POLL_MS || 5 * 60_000)) : 0;
function budgetPaced(task) {
  let lastRun = 0;
  return () => {
    const floor = Math.max(BUDGET_POLL_FLOOR_MS[getRpcRouter().mode()] || 0, WEBHOOK_SAFETY_POLL_MS);
    if (Date.now() - lastRun < floor) return undefined;
    lastRun = Date.now();
    return task();
  };
}

let _rpcRouter = null;
let flushRpcUsage = async () => {};
function getRpcRouter() {
  if (!_rpcRouter) {
    const assets = JSON.parse(fs.readFileSync(new URL('../payroll-assets.json', import.meta.url), 'utf8'));
    const { publicUrls, paidUrls } = baseRpcEndpointsFromEnv(process.env, assets);
    const monthlyBudget = Number(process.env.ALCHEMY_MONTHLY_CU_BUDGET || 0);
    const reserveFraction = Number(process.env.ALCHEMY_CU_RESERVE_FRACTION);
    const dailySoftLimit = Number(process.env.ALCHEMY_DAILY_CU_SOFT_LIMIT || 0);
    _rpcRouter = createRpcRouter({
      chainId: 8453, publicUrls, paidUrls,
      monthlyCuBudget: paidUrls.length ? (monthlyBudget > 0 ? monthlyBudget : DEFAULT_MONTHLY_CU_BUDGET) : Infinity,
      ...(process.env.ALCHEMY_CU_RESERVE_FRACTION && reserveFraction >= 0 && reserveFraction < 1 ? { reserveFraction } : {}),
      ...(dailySoftLimit > 0 ? { dailyCuSoftLimit: dailySoftLimit } : {}),
      onModeChange: (mode, previous) => console.warn(`[rpc] Alchemy budget mode ${previous} -> ${mode}`),
    });
    if (!paidUrls.length) console.warn('[rpc] No paid Base RPC configured (ALCHEMY_BASE_URL); using public endpoints only.');
  }
  return _rpcRouter;
}

function syncMintedTracks(config, { required = false } = {}) {
  if (!_mintSyncTask) {
    _mintSyncTask = Promise.resolve().then(async () => {
      if (!_nftMetadataGateways) {
        const dedicated = await discoverDedicatedGateway(config);
        _nftMetadataGateways = [
          ...(dedicated ? [dedicated] : []),
          'https://gateway.pinata.cloud/ipfs/',
          'https://ipfs.orbitor.dev/ipfs/',
          'https://ipfs.io/ipfs/',
        ];
      }
      return syncMintedTracksFromChain({
        rpcUrl: config.baseRpcUrl,
        provider: getRpcRouter().provider('read', 'mint-sync'),
        contractAddress: config.nftContractAddress,
        contractAddresses: config.nftContractAddresses,
        tokenCaches: _mintTokenCaches,
        metadataGateways: _nftMetadataGateways,
        onCatalog: nfts => { _nftCatalog = nfts; _nftCatalogCheckedAt = Date.now(); },
      });
    }).then(result => { _nftCatalogError = ''; return result; })
      .catch(error => { _nftCatalogError = error.message; throw error; })
      .finally(() => { _mintSyncTask = null; });
  }
  return required ? _mintSyncTask
    : _mintSyncTask.catch((err) => console.warn('[mint-sync] Could not read DecentNFT mints:', err.message));
}

/** Pin Discord-only uploads in the background and announce what was archived. */
function runIpfsBackfill(client, config) {
  if (config.disableMintFlow) return;
  backfillIpfsPins({
    client,
    upload: createIpfsUploader({
      provider: config.ipfsUploadProvider,
      pinataJwt: config.pinataJwt,
      pinataApiUrl: config.pinataApiUrl,
      ipfsApiUrl: config.ipfsApiUrl,
    }),
    maxBytes: MAX_FILE_BYTES,
  })
    .then(async ({ pinned, remaining }) => {
      await syncMintedTracks(config);
      if (!pinned || !config.jukeLoopTextChannelId) return;
      const channel = await client.channels.fetch(config.jukeLoopTextChannelId).catch(() => null);
      await channel?.send({
        content: `📌 Archived **${pinned}** past #DecentJukebox upload${pinned === 1 ? '' : 's'} to IPFS — ` +
        `${pinned === 1 ? 'it' : 'they'} can now stream on DecentBusking.` +
        (remaining ? ` ${remaining} upload${remaining === 1 ? '' : 's'} couldn’t be archived yet; retrying later.` : ''),
        flags: MessageFlags.SuppressNotifications,
      }).catch(() => {});
    })
    .catch((err) => console.error('[ipfs-backfill] Run failed:', err.message));
}

function clearScheduledJukeLoopRestart(config) {
  const key = config.jukeLoopTextChannelId || config.jukeLoopVoiceChannelId;
  const timer = _jukeLoopRestartTimers.get(key);
  if (timer) clearTimeout(timer);
  _jukeLoopRestartTimers.delete(key);
}

function scheduleJukeLoopRestart(client, config, reason) {
  const key = config.jukeLoopTextChannelId || config.jukeLoopVoiceChannelId;
  if (!key || _jukeLoopRestartTimers.has(key)) return;
  const attempt = (_jukeLoopRestartAttempts.get(key) || 0) + 1;
  _jukeLoopRestartAttempts.set(key, attempt);
  const delayMs = getVoiceRetryDelay(attempt);
  console.warn(`[jukeloop] ${reason}; retrying radio in ${Math.round(delayMs / 1000)}s.`);
  const timer = setTimeout(() => {
    _jukeLoopRestartTimers.delete(key);
    startWebsiteRadio(client, config).catch((error) =>
      console.error('[jukeloop] Scheduled restart failed:', error.message),
    );
  }, delayMs);
  _jukeLoopRestartTimers.set(key, timer);
}

// ── Audio MIME-type detection ─────────────────────────────────────────────────
const AUDIO_MIME_PREFIXES  = ['audio/'];
const AUDIO_EXTENSIONS_RE  = /\.(mp3|wav|ogg|flac|m4a|aac|opus|weba|mp4)$/i;
const IMAGE_EXTENSIONS_RE  = /\.(png|jpe?g|webp|gif)$/i;

const MAX_FILE_BYTES = DISCORD_UPLOAD_MAX_BYTES;
const MAX_ARTWORK_BYTES = 10 * 1024 * 1024; // 10 MB
const BASE_MULTICALL3_ADDRESS = '0xca11bde05977b3631167028862be2a173976ca11';
const MULTICALL3_ABI = ['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[] returnData)'];
const NFT_BALANCE_ABI = ['function balanceOf(address,uint256) view returns(uint256)'];
const DEVERT_OWNERSHIP_BATCH_SIZE = 32;

// Keyed by avatar hash so a changed Discord avatar is pinned again.
const _avatarCids = new Map();

/** Pin a member's Discord avatar to IPFS as default NFT artwork; returns its CID or null. */
async function pinDiscordAvatar(user, config) {
  const cacheKey = `${user.id}:${user.avatar || 'default'}`;
  if (_avatarCids.has(cacheKey)) return _avatarCids.get(cacheKey);
  try {
    const response = await fetch(user.displayAvatarURL({ extension: user.avatar?.startsWith('a_') ? 'gif' : 'png', size: 1024 }), { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || 'image/png';
    const extension = contentType.includes('gif') ? 'gif' : 'png';
    const uri = await uploadToIPFS(
      Buffer.from(await response.arrayBuffer()),
      `discord-avatar-${user.id}.${extension}`,
      contentType,
      {
        provider: config.ipfsUploadProvider,
        pinataJwt: config.pinataJwt,
        pinataApiUrl: config.pinataApiUrl,
        ipfsApiUrl: config.ipfsApiUrl,
      },
    );
    const cid = uri.replace('ipfs://', '');
    _avatarCids.set(cacheKey, cid);
    return cid;
  } catch (err) {
    console.warn(`[mint] Could not pin Discord avatar for ${user.tag ?? user.id}:`, err.message);
    return null;
  }
}

/**
 * Return true if the attachment looks like an audio file.
 * Discord reports contentType as null for some uploads, so we also
 * fall back to the filename extension.
 *
 * @param {import('discord.js').Attachment} attachment
 */
function isAudioAttachment(attachment) {
  const mime = attachment.contentType || '';
  if (mime === 'video/mp4') return true;
  if (AUDIO_MIME_PREFIXES.some((p) => mime.startsWith(p))) return true;
  return AUDIO_EXTENSIONS_RE.test(attachment.name || '');
}

function isImageAttachment(attachment) {
  return (attachment.contentType || '').startsWith('image/') || IMAGE_EXTENSIONS_RE.test(attachment.name || '');
}

// ── Slash command definitions ─────────────────────────────────────────────────

// Discord embed description max is 4 096 chars; use 3 900 to leave formatting headroom.
const MAX_EMBED_CHUNK_SIZE = 3900;

// Error message shown when no audio tracks are found in an IPFS directory.
const NO_TRACKS_MSG =
  '❌ No audio tracks found in that IPFS directory. Make sure the CID points to a directory containing `.mp3`, `.m4a`, `.wav`, `.ogg`, `.flac`, `.aac`, or `.opus` files.';

const SLASH_COMMANDS = [
  new SlashCommandBuilder().setName('creator-link').setDescription('Link your Discord identity to a wallet-signed creator profile')
    .addStringOption(option => option.setName('code').setDescription('Private link code from your creator profile').setRequired(true)),
  new SlashCommandBuilder()
    .setName('radio')
    .setDescription('Community radio — stream an IPFS album to a Discord voice channel')
    .addSubcommand((sub) =>
      sub
        .setName('play')
        .setDescription('Join your voice channel and stream an IPFS album directory')
        .addStringOption((opt) =>
          opt
            .setName('cid')
            .setDescription('IPFS CID or ipfs:// URL of the album directory')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('skip').setDescription('Skip to the next track'),
    )
    .addSubcommand((sub) =>
      sub.setName('pause').setDescription('Pause or resume playback'),
    )
    .addSubcommand((sub) =>
      sub.setName('stop').setDescription('Stop the radio and disconnect from voice'),
    ),

  new SlashCommandBuilder()
    .setName('jukebox')
    .setDescription('Personal jukebox — receive a private IPFS playlist via DM')
    .addSubcommand((sub) =>
      sub
        .setName('play')
        .setDescription('Get a private numbered playlist for an IPFS album directory')
        .addStringOption((opt) =>
          opt
            .setName('cid')
            .setDescription('IPFS CID or ipfs:// URL of the album directory')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('backlog')
        .setDescription('Show your audio uploads that have not been minted yet'),
    )
    .addSubcommand((sub) =>
      sub.setName('submit').setDescription('Submit an IPFS audio or MP4 file for owner-approved minting')
        .addStringOption(opt => opt.setName('cid').setDescription('File CID or ipfs://CID (for uploads over the Discord limit)').setRequired(true))
        .addStringOption(opt => opt.setName('title').setDescription('Track title').setRequired(true).setMaxLength(120))
        .addStringOption(opt => opt.setName('wallet').setDescription('Artist Base wallet').setRequired(true))
        .addStringOption(opt => opt.setName('format').setDescription('Media format').setRequired(true)
          .addChoices(...Object.entries(MEDIA_TYPES).map(([extension, type]) => ({ name: extension.toUpperCase(), value: extension })))),
    )
    .addSubcommand((sub) =>
      sub
        .setName('request-mint')
        .setDescription('Request an owner-approved mint to your wallet')
        .addStringOption((opt) =>
          opt.setName('track_id').setDescription('Track ID shown in /jukebox backlog').setRequired(true),
        )
        .addStringOption((opt) =>
          opt.setName('wallet').setDescription('Base wallet that receives the NFT and royalties').setRequired(true),
        )
        .addAttachmentOption((opt) =>
          opt.setName('artwork').setDescription('Optional PNG, JPEG, WebP, or GIF NFT artwork'),
        ),
    ),

  new SlashCommandBuilder()
    .setName('jukeloop')
    .setDescription('JukeLoop admin commands — manage the community radio playlist')
    .addSubcommand((sub) =>
      sub
        .setName('stats')
        .setDescription('Show the top-rated tracks in the JukeLoop playlist'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('(Admin) Remove a track from the JukeLoop playlist by title')
        .addStringOption((opt) =>
          opt
            .setName('title')
            .setDescription('Part of the track title to search for (case-insensitive)')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('mint-queue').setDescription('(Admin) Show pending owner-wallet mint requests'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('queue-uploads')
        .setDescription('(Admin) Queue every archived, unminted upload by one artist for minting')
        .addUserOption((opt) =>
          opt.setName('uploader').setDescription('Discord member whose uploads should be queued').setRequired(true),
        )
        .addStringOption((opt) =>
          opt.setName('wallet').setDescription('Artist Base wallet that receives the NFTs and royalties').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('restart').setDescription('(Admin) Reconnect and restart JukeLoop radio'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('live-add')
        .setDescription('(Admin) Schedule a live performance block in the JukeLoop voice channel')
        .addStringOption((opt) => opt.setName('title').setDescription('Performer or show name').setRequired(true))
        .addStringOption((opt) => opt.setName('start_utc').setDescription('Start time in ISO 8601 UTC, e.g. 2026-10-10T20:00:00Z').setRequired(true))
        .addStringOption((opt) => opt.setName('end_utc').setDescription('End time in ISO 8601 UTC').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName('live-list').setDescription('List active and upcoming live performance blocks'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('live-cancel')
        .setDescription('(Admin) Cancel a scheduled live performance block')
        .addStringOption((opt) => opt.setName('event_id').setDescription('Event ID from /jukeloop live-list').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('mark-minted')
        .setDescription('(Admin) Record a completed owner-wallet mint')
        .addStringOption((opt) =>
          opt.setName('track_id').setDescription('Track ID from the mint queue').setRequired(true),
        )
        .addStringOption((opt) =>
          opt.setName('token_id').setDescription('Minted DecentNFT token ID').setRequired(true),
        )
        .addStringOption((opt) =>
          opt.setName('tx_hash').setDescription('Base mint transaction hash').setRequired(true),
        ),
    ),
].map((cmd) => cmd.toJSON());

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const config = loadConfig();
  config.checkpointStorage = config.pinataJwt ? await ensureCheckpointGroups({ pinataJwt: config.pinataJwt }) : {};
  const discordAbort = new AbortController();
  const discordCooldownStore = config.pinataJwt ? createPinataStateStore({
    ...config.checkpointStorage, pinataJwt: config.pinataJwt, uploadUrl: config.pinataApiUrl,
    filesApiUrl: config.pinataFilesApiUrl, gateway: config.ipfsGateway,
    name: 'decentbusking-discord-cooldowns.json',
    tags: { app: 'decentbusking', kind: 'discord-cooldowns', schema: '1' },
    restoreLatestOnly: true, serialize: value => value, deserialize: value => value,
  }) : null;
  const discordDiagnostics = createDiscordDiagnostics({ store: discordCooldownStore });
  const checkpointMirror = process.env.CHECKPOINT_MIRROR_SECRET
    ? createCheckpointMirror({ secret: process.env.CHECKPOINT_MIRROR_SECRET }) : null;
  const devertSchedulerPrivateKey = resolveDevertSchedulerPrivateKey();
  let readDevertState;
  let devertSchedulerReady = false;
  let devertRemovals;
  if (process.env.DEVERT_CONTRACT_ADDRESS) {
    try {
      readDevertState = createDevertCampaignReader({
        provider: getRpcRouter().provider('read', 'devert-reader'),
        contractAddress: process.env.DEVERT_CONTRACT_ADDRESS,
        confirmations: Number(process.env.DEVERT_CONFIRMATIONS || 2),
        version: process.env.DEVERT_CONTRACT_VERSION || '0.1',
      });
      if (config.pinataJwt) {
        const removalKind = process.env.DEVERT_CONTRACT_VERSION === '0.2'
          ? `devert-removals-${process.env.DEVERT_CONTRACT_ADDRESS.toLowerCase()}` : 'devert-removals';
        const removalStore = createPinataStateStore({ ...config.checkpointStorage, pinataJwt: config.pinataJwt, uploadUrl: config.pinataApiUrl,
          filesApiUrl: config.pinataFilesApiUrl, gateway: config.ipfsGateway,
          name: `decentbusking-${removalKind}.json`, tags: { app: 'decentbusking', kind: removalKind, schema: '1' },
          serialize: value => value, deserialize: value => value });
        devertRemovals = createDevertRemovals(removalStore);
        await initializeDevertPlaybackWithRetry({ initialize: () => devertRemovals.initialize() });
      }
      const readChainCampaigns = readDevertState;
      readDevertState = async () => {
        const snapshot = await readChainCampaigns();
        return { ...snapshot, ...(snapshot.version === '0.2' ? {
          checkout: { available: devertSchedulerReady && snapshot.workerFunding.available,
            reason: !devertSchedulerReady ? 'Campaign scheduler is not ready. Please try again shortly.'
              : snapshot.workerFunding.reason },
        } : {}), campaigns: snapshot.campaigns.map(campaign => ({
          ...campaign, removed: devertRemovals ? devertRemovals.isRemoved(campaign.campaignId) : false,
        })) };
      };
    } catch (error) {
      console.warn('[devert] Read-only campaign endpoint disabled:', error.message);
    }
  }
  if (readDevertState && devertSchedulerPrivateKey && config.pinataJwt) {
    const scheduler = new Wallet(devertSchedulerPrivateKey, getRpcRouter().provider('critical', 'devert-scheduler'));
    const contract = new Contract(process.env.DEVERT_CONTRACT_ADDRESS, DEVERT_ABI, scheduler);
    if (process.env.DEVERT_CONTRACT_VERSION === '0.2') {
      const djukeWorker = new Contract(process.env.DJUKE_CONTRACT_ADDRESS, ['function gasWorker() view returns(address)'], scheduler.provider);
      const expected = await contract.schedulerWallet();
      if (expected.toLowerCase() !== scheduler.address.toLowerCase() ||
          (await djukeWorker.gasWorker()).toLowerCase() !== scheduler.address.toLowerCase()) {
        throw new Error('Sponsored DVert must use the shared, admin-monitored DJuke worker');
      }
    }
    _devertSchedulerContract = contract;
    const workerMinBalanceWei = process.env.WORKER_MIN_BALANCE_WEI
      ? BigInt(process.env.WORKER_MIN_BALANCE_WEI) : DEFAULT_WORKER_MIN_BALANCE_WEI;
    const schedulerJournalKind = process.env.DEVERT_CONTRACT_VERSION === '0.2'
      ? `devert-main-radio-${process.env.DEVERT_CONTRACT_ADDRESS.toLowerCase()}` : 'devert-main-radio';
    const journalStore = createPinataStateStore({ ...config.checkpointStorage, pinataJwt: config.pinataJwt, uploadUrl: config.pinataApiUrl,
      filesApiUrl: config.pinataFilesApiUrl, gateway: config.ipfsGateway, name: `decentbusking-${schedulerJournalKind}.json`,
      tags: { app: 'decentbusking', kind: schedulerJournalKind, schema: '1' }, serialize: value => value,
      deserialize: value => value });
    _devertPlaybackRuntime = createDevertPlaybackRuntime({ contract, provider: scheduler.provider,
      restore: journalStore.restore, save: journalStore.save, readCampaigns: readDevertState,
      workerAddress: scheduler.address, workerMinBalanceWei,
      resolveCampaignMedia: (campaign, cid) => resolveDevertCampaignMedia(campaign, cid, {
        playlist: getPlaylist(), nfts: _nftCatalog || [],
      }), isCampaignRemoved: campaignId => devertRemovals ? devertRemovals.isRemoved(campaignId) : false });
    _devertPlaybackInitialization = initializeDevertPlaybackWithRetry({
      initialize: () => _devertPlaybackRuntime.initialize(),
    }).then(() => {
      devertSchedulerReady = true;
      console.log(`[devert] Durable scheduler journal ready; scheduler ${scheduler.address}.`);
    });
  } else if (process.env.DEVERT_CONTRACT_ADDRESS) {
    console.warn('[devert] Campaign reads are configured, but audio scheduling is disabled until a DeVert/DJuke worker key and PINATA_JWT are available.');
  }
  if (readDevertState && devertSchedulerPrivateKey && config.pinataJwt) {
    const missingDevertLoopSettings = ['DVERT_LOOP_DISCORD_TOKEN', 'VERT_LOOP_CHANNEL_ID', 'VERTLOOP_VOICE_CHANNEL_ID']
      .filter(name => !process.env[name]);
    if (process.env.DVERT_LOOP_DISCORD_ENABLED !== 'true') {
      _devertLoopWorker = await startDevertWebsiteLoopWorker({ playback: _devertPlaybackRuntime });
    } else if (missingDevertLoopSettings.length) {
      console.warn(`[devert-loop] Not started; missing environment variables: ${missingDevertLoopSettings.join(', ')}`);
    } else {
      void recoverDiscordConnection({
        diagnostics: discordDiagnostics, name: 'devert-loop', signal: discordAbort.signal,
        onConnected: worker => { _devertLoopWorker = worker; },
        connect: () => startDevertLoopWorker({
          token: process.env.DVERT_LOOP_DISCORD_TOKEN,
          diagnostics: discordDiagnostics.bot('devert-loop'), signal: discordAbort.signal,
          voiceChannelId: process.env.VERTLOOP_VOICE_CHANNEL_ID, textChannelId: process.env.VERT_LOOP_CHANNEL_ID,
          playback: _devertPlaybackRuntime,
          onAdMessage: process.env.DVERT_LOOP_AD_INTAKE_ENABLED === 'true' ? async message => {
            if (message.channelId === config.jukeboxChannelId && /^!devert-ad\b/i.test(message.content)) {
              await handleDevertLoopSubmission(message, config, creatorProfiles);
            }
          } : undefined,
        }),
      })
        .catch(() => console.error('[devert-loop] Discord recovery supervisor failed; inspect diagnostics.'));
    }
  }
  const creatorStore = config.pinataJwt ? createPinataStateStore({ ...config.checkpointStorage, pinataJwt: config.pinataJwt,
    uploadUrl: config.pinataApiUrl, filesApiUrl: config.pinataFilesApiUrl, gateway: config.ipfsGateway,
    name: 'decentbusking-creator-profiles.json', tags: { app: 'decentbusking', kind: 'creator-profiles', schema: '1' },
    serialize: value => value, deserialize: value => value }) : null;
  const artworkUpdateStore = config.pinataJwt ? createPinataStateStore({ ...config.checkpointStorage, pinataJwt: config.pinataJwt,
    uploadUrl: config.pinataApiUrl, filesApiUrl: config.pinataFilesApiUrl, gateway: config.ipfsGateway,
    name: 'decentbusking-artwork-updates.json', tags: { app: 'decentbusking', kind: 'artwork-updates', schema: '1' },
    serialize: value => ({ schemaVersion: 1, requests: value }),
    deserialize: value => {
      if (Array.isArray(value)) return value;
      if (value?.schemaVersion === 1 && Array.isArray(value.requests)) return value.requests;
      throw new Error('Invalid artwork update checkpoint');
    } }) : null;
  const artworkUpdateQueue = createArtworkUpdateQueue({
    restore: artworkUpdateStore ? artworkUpdateStore.restore : async () => [],
    save: artworkUpdateStore ? artworkUpdateStore.save : async () => {},
  });
  await artworkUpdateQueue.initialize();
  config.jukeLoopMainRadioAdStore = config.pinataJwt ? createPinataStateStore({
    ...config.checkpointStorage,
    pinataJwt: config.pinataJwt,
    uploadUrl: config.pinataApiUrl,
    filesApiUrl: config.pinataFilesApiUrl,
    gateway: config.ipfsGateway,
    name: 'decentbusking-main-radio-ad-state.json',
    tags: { app: 'decentbusking', kind: 'main-radio-ad-state', schema: '1' },
    serialize: value => value,
    deserialize: value => value,
  }) : null;
  config.topTenHypeStore = config.pinataJwt ? createPinataStateStore({
    ...config.checkpointStorage,
    pinataJwt: config.pinataJwt,
    uploadUrl: config.pinataApiUrl,
    filesApiUrl: config.pinataFilesApiUrl,
    gateway: config.ipfsGateway,
    name: 'decentbusking-friday-top10-hype.json',
    restoreLatestOnly: true,
    tags: { app: 'decentbusking', kind: 'friday-top10-hype', schema: '1' },
    beforeUpload: checkpointMirror ? (bytes, options) => checkpointMirror.mirror(bytes, options) : undefined,
    serialize: value => value,
    deserialize: value => value,
  }) : null;
  config.playlistShowStore = config.pinataJwt ? createPinataStateStore({
    ...config.checkpointStorage, pinataJwt: config.pinataJwt, uploadUrl: config.pinataApiUrl,
    filesApiUrl: config.pinataFilesApiUrl, gateway: config.ipfsGateway,
    name: 'decentbusking-playlist-shows.json', restoreLatestOnly: true,
    tags: { app: 'decentbusking', kind: 'playlist-shows', schema: '1' },
    beforeUpload: checkpointMirror ? (bytes, options) => checkpointMirror.mirror(bytes, options) : undefined,
    serialize: value => value, deserialize: value => value,
  }) : null;
  const creatorProfiles = creatorStore ? createCreatorProfiles({ restore: creatorStore.restore, save: creatorStore.save }) : null;
  let creatorProfilesReady = false;
  const initializeCreators = () => creatorProfiles?.initialize().then(() => { creatorProfilesReady = true; })
    .catch(error => console.warn('[creator-profiles]', error.message));
  initializeCreators();
  setInterval(initializeCreators, 30000).unref();

  let client;
  config.getDiscordClient = () => client;
  let discordOfflineReason = 'Main radio is offline';
  let playlistReady = false;
  let playlistStateStore = null;
  let queueReviewedAlbumImport = null;
  let albumImportTask = null;
  const getVerifiedMintRequests = createVerifiedMintQueueReader({
    reconcile: async () => {
      if (!playlistReady) throw new Error('Playlist is restoring; please retry shortly');
      await syncMintedTracks(config, { required: true });
    },
    getRequests: getMintRequests,
  });
  const mapArtworkUpdateRequest = request => ({
    trackId: request.requestId,
    requestType: 'artwork-update',
    title: request.title || `Token #${request.tokenId}`,
    uploader: request.creator || 'Unknown artist',
    uploaderId: request.creator || '',
    recipient: request.creator || '',
    ipfsCid: request.currentMetadata?.animation_url || request.currentMetadata?.audioUrl || '',
    artworkCid: request.newImageCid || '',
    filename: `token-${request.tokenId}.json`,
    mediaType: '',
    tipWallet: request.creator || '',
    parentTokenId: 0,
    isDevertAd: false,
    requestedAt: request.requestedAt,
    tokenId: String(request.tokenId),
    contractAddress: request.contractAddress,
    currentArtworkCid: String(request.oldImageUri || '').replace(/^ipfs:\/\//i, ''),
    currentMetadataUri: request.oldUri || '',
    metadataUri: request.metadataUri || '',
    status: request.status,
  });
  const handleMintRequestInteraction = createMintRequestInteractionHandler({
    getPlaylist,
    requestTrackMint,
    waitForPersistence: waitForRemotePersistence,
    getDefaultArtwork: user => pinDiscordAvatar(user, config),
    uploadArtwork: async artwork => {
      const response = await fetch(artwork.url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} downloading artwork`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_ARTWORK_BYTES) throw new Error('Artwork is larger than 10 MB');
      const extension = (artwork.name || '').split('.').pop().toLowerCase();
      const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[extension] || artwork.contentType;
      const uri = await uploadToIPFS(buffer, artwork.name || 'artwork.png', type, {
        provider: config.ipfsUploadProvider,
        pinataJwt: config.pinataJwt,
        pinataApiUrl: config.pinataApiUrl,
        ipfsApiUrl: config.ipfsApiUrl,
      });
      return uri.replace('ipfs://', '');
    },
  });
  const submissionIntake = createSubmissionIntake({
    siteUrl: config.siteUrl,
    isAdmin: interaction => interaction.memberPermissions?.has('ManageMessages') || interaction.memberPermissions?.has('Administrator'),
    onChoose: async ({ choice, record, interaction, resume }) => {
      if (choice === 'song') {
        const attachment = record.attachment;
        const filename = attachment.name || 'track.mp3';
        const track = {
          attachmentId: attachment.id,
          messageId: record.message.id,
          channelId: record.message.channelId,
          filename,
          mediaType: mediaTypeFor(filename, attachment.contentType),
          title: getAttachmentTitle(attachment),
          uploader: record.message.author.tag ?? record.message.author.username ?? 'Unknown',
          uploaderId: record.message.author.id,
          pinStatus: config.disableMintFlow ? 'disabled' : 'pending',
        };
        const trackId = getTrackId(track);
        addTrack(track);
        if (!config.disableMintFlow) await handleAudioAttachment(record.message, attachment, config, trackId);
        return { handled: true };
      }
      const linked = creatorProfiles?.getByDiscordId(record.message.author.id);
      const result = await handleDevertLoopSubmission(record.message, config, creatorProfiles, {
        submissionKey: record.key,
        linked,
      });
      if (result?.awaitingLink) return { keepPending: true };
      return { handled: true };
    },
  });
  const verifyMintTransaction = createMintTransactionVerifier({
    provider: getRpcRouter().provider('read', 'mint-verify'),
    contractAddress: config.nftContractAddress,
    contractAddresses: config.nftContractAddresses,
    ownerWallet: config.mintOwnerWallet,
  });
  const reconcileMint = async ({ trackId, tokenId, txHash }) => {
    const queuedTrack = getPlaylist().find((track) => track.trackId === trackId);
    if (!queuedTrack) throw new Error('No mint queue track has that track ID');
    const verified = await verifyMintTransaction({ tokenId, txHash });
    const requestedRecipient = queuedTrack.mintRecipient || config.mintOwnerWallet;
    if (verified.recipient.toLowerCase() !== requestedRecipient.toLowerCase()) {
      throw new Error('Mint recipient does not match the requested artist wallet');
    }
    if (queuedTrack.mintStatus === 'minted') {
      const completedTrack = completeTrackMint(trackId, { tokenId, txHash, contractAddress: verified.contractAddress });
      if (!completedTrack) throw new Error(`Track is already reconciled to token ${queuedTrack.tokenId}`);
      console.log(`[mint-sync] Mint completion already reconciled for ${trackId} as token ${tokenId}.`);
      return completedTrack;
    }
    if (queuedTrack.mintStatus !== 'requested') throw new Error(`Track is not pending mint approval (status: ${queuedTrack.mintStatus})`);
    await announceCompletedMint(client, config, {
      ...queuedTrack,
      tokenId: String(tokenId),
      mintTxHash: txHash,
    });
    const completedTrack = completeTrackMint(trackId, { tokenId, txHash, contractAddress: verified.contractAddress });
    if (!completedTrack) throw new Error('Mint request could not be reconciled');
    return completedTrack;
  };

  // Alchemy spend survives restarts so monthly budget pacing stays honest.
  const rpcUsageStore = config.pinataJwt ? createPinataStateStore({ ...config.checkpointStorage, pinataJwt: config.pinataJwt,
    uploadUrl: config.pinataApiUrl, filesApiUrl: config.pinataFilesApiUrl, gateway: config.ipfsGateway,
    name: 'decentbusking-rpc-usage.json', tags: { app: 'decentbusking', kind: 'rpc-usage', schema: '1' },
    serialize: value => value, deserialize: value => value }) : null;
  if (rpcUsageStore) {
    let lastSavedUsage = '';
    let usageRestored = false;
    const saveRpcUsage = async () => {
      if (!usageRestored) return; // never overwrite the month's total with only post-boot spend
      const snapshot = getRpcRouter().usageSnapshot();
      const key = JSON.stringify(snapshot);
      if (key === lastSavedUsage || !snapshot.month) return;
      await rpcUsageStore.save(snapshot);
      lastSavedUsage = key;
    };
    flushRpcUsage = () => saveRpcUsage().catch(error => console.warn('[rpc] Usage save failed:', error.message));
    const restoreRpcUsage = () => rpcUsageStore.restore()
      .then(snapshot => {
        usageRestored = true;
        if (getRpcRouter().restoreUsage(snapshot)) console.log(`[rpc] Restored Alchemy usage: ${snapshot.monthCu} CU this month.`);
      })
      .catch(error => console.warn('[rpc] Usage restore failed; will retry:', error.message));
    restoreRpcUsage();
    setInterval(() => (usageRestored ? flushRpcUsage() : restoreRpcUsage()), 15 * 60_000).unref();
  }

  const payrollAssets = JSON.parse(fs.readFileSync(new URL('../payroll-assets.json', import.meta.url), 'utf8'));
  const paymentStore = config.pinataJwt ? createPinataStateStore({ ...config.checkpointStorage, pinataJwt: config.pinataJwt,
    uploadUrl: config.pinataApiUrl, filesApiUrl: config.pinataFilesApiUrl, gateway: config.ipfsGateway,
    name: 'decentbusking-payment-ledger.json', tags: { app: 'decentbusking', kind: 'payment-ledger', schema: '1' },
    serialize: value => value, deserialize: (value, uri) => ({ ...value, snapshotUri: uri }) }) : null;
  const paymentProvider = getRpcRouter().provider('read', 'payroll-and-funds');
  const dispatchedPayments = new Set();
  let repositorySyncError = '';
  const syncRepositoryLedger = async payment => {
    const token = process.env.PAYROLL_GITHUB_TOKEN;
    if (!token || dispatchedPayments.has(payment.workReference) || payment.fundId !== id(payrollAssets.fundSlug)) return;
    try {
      const queueResponse = await fetch('https://raw.githubusercontent.com/TheJollyLaMa/DecentBusking/main/payroll-queue.json', { cache: 'no-store' });
      if (!queueResponse.ok) throw new Error('Repository queue unavailable');
      const queue = await queueResponse.json();
      for (const entry of queue.pending || []) {
        const currency = String(entry.currency || '').toUpperCase();
        if (!payrollAssets.assets[currency]) continue;
        const base = `${entry.issueRef}:${entry.contributorGithub}:${entry.role || 'contributor'}`;
        if (id(currency === 'ART' ? base : `${base}:${currency}`) !== payment.workReference) continue;
        await verifyRepositoryPayment({ entry, config: payrollAssets, txHash: payment.txHash, provider: paymentProvider });
        const response = await fetch('https://api.github.com/repos/TheJollyLaMa/DecentBusking/actions/workflows/settle-payroll.yml/dispatches', {
          method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
          body: JSON.stringify({ ref: 'main', inputs: { contributor_github: entry.contributorGithub, issue_ref: entry.issueRef,
            role: entry.role || 'contributor', currency, tx_hash: payment.txHash } }) });
        if (!response.ok) throw new Error(`Repository ledger dispatch failed (${response.status})`);
        dispatchedPayments.add(payment.workReference);
      }
      repositorySyncError = '';
    } catch (error) { repositorySyncError = error.message; console.warn('[repository-ledger]', error.message); }
  };
  const paymentLedger = createPaymentLedger({ provider: paymentProvider,
    routerAddress: payrollAssets.routerAddress, startBlock: process.env.PAYROLL_START_BLOCK ? Number(process.env.PAYROLL_START_BLOCK) : undefined,
    restore: paymentStore ? paymentStore.restore : undefined, save: paymentStore ? paymentStore.save : undefined, onVerified: syncRepositoryLedger });
  let paymentLedgerReady = false;
  let paymentLedgerTask = null;
  const comparePayments = () => {
    if (!paymentLedgerTask) paymentLedgerTask = (paymentLedgerReady ? paymentLedger.compare() : paymentLedger.initialize())
      .then(() => { paymentLedgerReady = true; })
      .catch(error => console.warn('[payment-ledger]', error.message))
      .finally(() => { paymentLedgerTask = null; });
    return paymentLedgerTask;
  };
  comparePayments();
  setInterval(budgetPaced(comparePayments), 15_000).unref();

  const payflowStore = config.pinataJwt ? createPinataStateStore({ ...config.checkpointStorage, pinataJwt: config.pinataJwt,
    uploadUrl: config.pinataApiUrl, filesApiUrl: config.pinataFilesApiUrl, gateway: config.ipfsGateway,
    name: 'decentbusking-weekly-payflow.json', tags: { app: 'decentbusking', kind: 'weekly-payflow', schema: '1' },
    serialize: value => value, deserialize: value => value }) : null;
  const payflowRouter = new Contract(payrollAssets.routerAddress, [
    'function funds(bytes32) view returns(string metadataUri,bool active,bool exists)',
    'function fundBalances(bytes32,address) view returns(uint256)',
    'function approvedAssets(address) view returns(bool)',
    'function completedWorkReferences(bytes32) view returns(bool)',
    'event FundFunded(bytes32 indexed fundId, address indexed asset, address indexed funder, uint256 amount)',
  ], paymentProvider);
  const archiveProvider = getRpcRouter().provider('logs', 'payroll-archive');
  const archivePayflowRouter = new Contract(payrollAssets.routerAddress, [
    'function fundBalances(bytes32,address) view returns(uint256)',
    'function completedWorkReferences(bytes32) view returns(bool)',
  ], archiveProvider);
  const closingBlocks = new Map();
  const getClosingBalance = async ({ report, fundSlug, allocations }) => {
    if (!closingBlocks.has(report.week)) {
      const end = Date.parse(payrollPeriodFromKey(report.week).endAt) / 1000;
      closingBlocks.set(report.week, await findBlockAtOrBefore(archiveProvider, end));
    }
    const blockTag = closingBlocks.get(report.week);
    return readClosingFundBalance({ router: archivePayflowRouter, fundSlug,
      assetAddress: payrollAssets.assets.USDC.address, blockTag, allocations });
  };
  const payflow = createWeeklyPayflow({ router: payflowRouter, config: payrollAssets,
    getReports: () => getWeeklyPlayHistory({ weeks: 12, calendar: 'new-york' }),
    upload: createIpfsUploader({ provider: config.ipfsUploadProvider, pinataJwt: config.pinataJwt, pinataApiUrl: config.pinataApiUrl, ipfsApiUrl: config.ipfsApiUrl }),
    restore: payflowStore ? payflowStore.restore : undefined,
    getClosingBalance,
    save: payflowStore ? payflowStore.save : async () => { throw new Error('Durable weekly payflow requires configured Pinata snapshots'); } });
  let payflowReady = false;
  let payflowTask = null;
  const refreshPayflow = () => {
    if (!playlistReady) return Promise.resolve();
    if (!payflowTask) payflowTask = (payflowReady ? payflow.tick() : payflow.initialize())
      .then(() => { payflowReady = true; })
      .catch(error => console.warn('[weekly-payflow]', error.message))
      .finally(() => { payflowTask = null; });
    return payflowTask;
  };
  setInterval(budgetPaced(refreshPayflow), 15_000).unref();

  const payrollReportStore = config.pinataJwt ? createPinataStateStore({ ...config.checkpointStorage,
    pinataJwt: config.pinataJwt, uploadUrl: config.pinataApiUrl, filesApiUrl: config.pinataFilesApiUrl,
    gateway: config.ipfsGateway, name: 'decentbusking-weekly-payroll-reports.json',
    tags: { app: 'decentbusking', kind: 'weekly-payroll-reports', schema: '1' },
    serialize: value => value, deserialize: value => value }) : null;
  const payrollReporter = createWeeklyPayrollReporter({
    config: payrollAssets, channelId: config.jukeboxChannelId,
    siteUrl: config.siteUrl,
    getWeeklyPayflow: () => payflow.getState(),
    getPaymentLedger: () => ({ ...paymentLedger.getState(), ready: paymentLedgerReady }),
    getReports: () => getWeeklyPlayHistory({ weeks: 52, calendar: 'new-york' }),
    getChannel: () => client.channels.fetch(config.jukeboxChannelId),
    restore: payrollReportStore?.restore, save: payrollReportStore?.save,
  });
  const refreshPayrollReports = () => payrollReporter.tick()
    .catch(error => console.warn('[weekly-payroll-report]', error.message));
  setInterval(refreshPayrollReports, 15_000).unref();

  const fundStore = config.pinataJwt ? createPinataStateStore({ ...config.checkpointStorage, pinataJwt: config.pinataJwt,
    uploadUrl: config.pinataApiUrl, filesApiUrl: config.pinataFilesApiUrl, gateway: config.ipfsGateway,
    name: 'decentbusking-fund-ledger.json', tags: { app: 'decentbusking', kind: 'fund-ledger', schema: '1' },
    serialize: value => value, deserialize: value => value }) : null;
  const fundLedger = createFundLedger({
    provider: paymentProvider,
    router: payflowRouter,
    config: { ...payrollAssets, devertContractAddress: process.env.DEVERT_CONTRACT_ADDRESS,
      devertQueueContractAddress: process.env.DEVERT_QUEUE_CONTRACT_ADDRESS,
      devertQueueVersion: Number(process.env.DEVERT_QUEUE_VERSION || 1) },
    getWeeklyPayflow: () => payflow.getState(),
    readDevertState: () => readDevertState?.(),
    readDjukeState: () => readDjukeState?.(),
    restore: fundStore ? fundStore.restore : undefined,
    save: fundStore ? fundStore.save : undefined,
    schedule: fundStore ? fundStore.schedule : undefined,
    // The settlement router has no events before its deployment block, so never scan from genesis.
    startBlock: Math.max(ROUTER_START_BLOCK, Number(process.env.PAYROLL_START_BLOCK || 0)),
    chunkSize: Number(process.env.FUND_SCAN_CHUNK_SIZE || 10000),
  });
  let fundLedgerReady = false;
  let fundLedgerTask = null;
  const refreshFundLedger = () => {
    if (!fundLedgerTask) fundLedgerTask = (fundLedgerReady ? fundLedger.refresh() : fundLedger.initialize())
      .then(() => { fundLedgerReady = true; })
      .catch(error => console.warn('[fund-ledger]', error.message))
      .finally(() => { fundLedgerTask = null; });
    return fundLedgerTask;
  };
  setInterval(budgetPaced(refreshFundLedger), 60_000).unref();
  refreshFundLedger();
  const earningsStore = config.pinataJwt ? createPinataStateStore({
    ...config.checkpointStorage,
    pinataJwt: config.pinataJwt,
    uploadUrl: config.pinataApiUrl,
    filesApiUrl: config.pinataFilesApiUrl,
    gateway: config.ipfsGateway,
    name: 'decentbusking-earnings-index.json',
    tags: { app: 'decentbusking', kind: 'earnings-index', schema: '1' },
    serialize: value => value,
    deserialize: value => value,
  }) : null;
  const earningsLedger = createEarningsLedger({
    ethers: { Interface, id },
    provider: getRpcRouter().provider('logs', 'earnings-index'),
    restore: earningsStore ? earningsStore.restore : async () => null,
    save: earningsStore ? earningsStore.save : async () => '',
    schedule: earningsStore ? earningsStore.schedule : undefined,
    startBlock: process.env.ROUTER_START_BLOCK ? Number(process.env.ROUTER_START_BLOCK) : undefined,
    chunkSize: Number(process.env.EARNINGS_SCAN_CHUNK_SIZE || 2000),
  });
  let earningsLedgerReady = false;
  let earningsLedgerTask = null;
  const refreshEarningsLedger = () => {
    if (!earningsLedgerTask) earningsLedgerTask = (earningsLedgerReady ? earningsLedger.refresh() : earningsLedger.initialize())
      .then(() => { earningsLedgerReady = true; })
      .catch(error => console.warn('[earnings-ledger]', error.message))
      .finally(() => { earningsLedgerTask = null; });
    return earningsLedgerTask;
  };
  setInterval(budgetPaced(refreshEarningsLedger), 60_000).unref();
  refreshEarningsLedger();

  const reserveEnabled = process.env.WORKER_RESERVE_ENABLED === 'true';
  if (reserveEnabled && (!process.env.WORKER_RESERVE_PRIVATE_KEY || !config.pinataJwt)) {
    throw new Error('Approved reserve signer and durable reserve storage are required for worker top-ups');
  }
  const reserveProvider = getRpcRouter().provider('critical', 'worker-reserve');
  const reserveSigner = reserveEnabled ? new Wallet(process.env.WORKER_RESERVE_PRIVATE_KEY, reserveProvider) : null;
  const reserveStore = reserveEnabled ? createPinataStateStore({ ...config.checkpointStorage,
    pinataJwt: config.pinataJwt, uploadUrl: config.pinataApiUrl, filesApiUrl: config.pinataFilesApiUrl,
    gateway: config.ipfsGateway, name: `decentbusking-worker-reserve-${reserveSigner.address.toLowerCase()}.json`,
    restoreLatestOnly: true, tags: { app: 'decentbusking', kind: `worker-reserve-${reserveSigner.address.toLowerCase()}`, schema: '1' },
    serialize: value => value, deserialize: value => value }) : null;
  const workerReserve = process.env.DJUKE_FULFILLER_PRIVATE_KEY ? createWorkerReserve({
    provider: reserveProvider, signer: reserveSigner, enabled: reserveEnabled,
    workerAddress: new Wallet(process.env.DJUKE_FULFILLER_PRIVATE_KEY).address,
    restore: () => reserveStore.restore(), save: value => reserveStore.save(value),
  }) : null;
  const checkWorkerReserve = async () => {
    if (!workerReserve) return;
    try {
      const result = await workerReserve.check();
      if (result.low || result.pending || result.confirmed) console.log('[worker-reserve]', JSON.stringify(result));
    } catch (error) { console.error('[worker-reserve] Refill unavailable:', error.message); }
  };
  setInterval(checkWorkerReserve, 300_000).unref();
  const djukeAddress = process.env.DJUKE_CONTRACT_ADDRESS;
  const historicalPlaylistReceipts = legacyPlaylistReceipts(process.env.DJUKE_LEGACY_PLAYLIST_RECEIPTS, djukeAddress);
  const sponsoredDjuke = process.env.DJUKE_CONTRACT_VERSION === '0.5';
  const quoteSigner = supportsDjukeAlbumsAndGas(process.env.DJUKE_CONTRACT_VERSION) && process.env.DJUKE_FULFILLER_PRIVATE_KEY
    ? new Wallet(process.env.DJUKE_FULFILLER_PRIVATE_KEY, getRpcRouter().provider('critical', 'djuke-gas-quote')) : null;
  const getDjukeGasQuote = quoteSigner ? createDjukeGasQuoteReader({ provider: quoteSigner.provider, signer: quoteSigner,
    sponsored: sponsoredDjuke,
    contract: new Contract(djukeAddress, [...DJUKE_ABI, ...DJUKE_GAS_ABI, 'function quote() view returns(uint256)'], quoteSigner),
    fulfillmentGasUnits: BigInt(process.env.DJUKE_FULFILLMENT_GAS_UNITS || '1000000') }) : null;
  const playlistContractEnabled = process.env.DJUKE_PLAYLIST_BATCH_ENABLED === 'true' &&
    ['0.4', '0.5'].includes(process.env.DJUKE_CONTRACT_VERSION) &&
    process.env.DJUKE_PLAYLIST_BATCH_VERSION === process.env.DJUKE_CONTRACT_VERSION &&
    process.env.DJUKE_PLAYLIST_BATCH_ADDRESS?.toLowerCase() === djukeAddress?.toLowerCase() && !!quoteSigner;
  let playlistWorkerReady = false;
  let initializePlaylistWorker = null;
  const readDjukePlaylistGasQuote = playlistContractEnabled ? createDjukePlaylistGasQuoteReader({ provider: quoteSigner.provider,
    sponsored: sponsoredDjuke,
    signer: quoteSigner, contract: new Contract(djukeAddress, [...DJUKE_ABI, ...DJUKE_GAS_ABI, ...DJUKE_PLAYLIST_GAS_ABI], quoteSigner),
    fulfillmentGasUnits: BigInt(process.env.DJUKE_FULFILLMENT_GAS_UNITS || '1000000') }) : null;
  let playlistBatchJournal = null;
  let playlistBatchEventsReady = false;
  const playlistBatchStartBlock = /^\d+$/.test(process.env.DJUKE_PLAYLIST_BATCH_START_BLOCK || '')
    ? Number(process.env.DJUKE_PLAYLIST_BATCH_START_BLOCK) : NaN;
  const playlistBatchWorkerEnabled = playlistContractEnabled && process.env.DJUKE_PLAYLIST_BATCH_ENABLED === 'true' &&
    Number.isSafeInteger(playlistBatchStartBlock) && playlistBatchStartBlock >= 0 && !!checkpointMirror && !!config.pinataJwt;
  if (playlistBatchWorkerEnabled) {
    const batchStore = createPinataStateStore({ ...config.checkpointStorage, pinataJwt: config.pinataJwt,
      uploadUrl: config.pinataApiUrl, filesApiUrl: config.pinataFilesApiUrl, gateway: config.ipfsGateway,
      name: `decentbusking-djuke-${djukeAddress.toLowerCase()}-playlist-batches.json`, requireLocalMirror: true,
      tags: { app: 'decentbusking', kind: `djuke-playlist-batches-${djukeAddress.toLowerCase()}`, schema: '2' },
      serialize: value => value, deserialize: value => value, beforeUpload: (bytes, options) => checkpointMirror.mirror(bytes, options) });
    const eventContract = new Contract(djukeAddress, [...DJUKE_ABI, ...playlistBatchEventAbi()], getRpcRouter().provider('logs', 'djuke-playlist-events'));
    playlistBatchJournal = createDjukePlaylistBatchReconciler({ provider: eventContract.runner.provider, contract: eventContract,
      restore: batchStore.restore, save: batchStore.save, startBlock: playlistBatchStartBlock });
  }
  const getDjukePlaylistReadiness = async () => djukePlaylistReadiness({
    version: process.env.DJUKE_CONTRACT_VERSION,
    configured: playlistContractEnabled, contractAddress: djukeAddress, batchEventsDurable: !!playlistBatchJournal && playlistBatchEventsReady,
    workerReady: playlistWorkerReady && (!sponsoredDjuke || (!!quoteSigner &&
      await quoteSigner.provider.getBalance(quoteSigner.address) >= 1_000_000_000_000_000n)),
    paymentsEnabled: process.env.DJUKE_PAYMENTS_ENABLED === 'true',
    mirrorAvailable: !!checkpointMirror?.status().available,
  });
  const getDjukePlaylistGasQuote = readDjukePlaylistGasQuote ? async input => {
    const readiness = await getDjukePlaylistReadiness();
    if (!readiness.ready) throw new Error(readiness.reason);
    return readDjukePlaylistGasQuote(input);
  } : null;
  const readDjukeQueueState = djukeAddress ? createDjukeQueueReader({
    provider: getRpcRouter().provider('read', 'djuke-reader'), contractAddress: djukeAddress,
    playlistLaneEnabled: playlistBatchWorkerEnabled,
    getPlaylistBatches: () => {
      if (!playlistBatchEventsReady) return [];
      const tracks = new Map(getPlaylist().map(track => [id(track.trackId).toLowerCase(), track]));
      const nowPlaying = getJukeLoopNowPlaying();
      const batches = playlistBatchJournal.getState();
      const recent = batches.filter(batch => batch.status !== 'pending').slice(-50);
      const records = _djukeRuntime?.getJournalState() || [];
      const hasPlaybackEvidence = record => _djukeRuntime?.hasPlaybackEvidence?.(record) === true;
      return [...historicalPlaylistReceipts, ...batches.filter(batch => batch.status === 'pending' || recent.includes(batch)).map(batch => {
        const saved = creatorProfilesReady ? creatorProfiles.findPlaylistRevision(batch.payer, batch.songIds) : null;
        return { batchId: batch.batchId, contractAddress: djukeAddress, name: saved?.name || `Playlist #${batch.batchId}`,
          payer: batch.payer, status: batch.status, transactionHash: batch.transactionHash,
          resolutionTransactionHash: batch.resolutionTransactionHash,
          subtotalUnits: batch.subtotalUnits, feeUnits: batch.feeUnits,
          refundedUnits: batch.refundedSongUnits !== undefined && batch.refundedFeeUnits !== undefined
            ? (BigInt(batch.refundedSongUnits) + BigInt(batch.refundedFeeUnits)).toString() : null,
          playing: !!nowPlaying?.audible && nowPlaying.djukePlaylist?.batchId === batch.batchId,
          workerGasSponsored: sponsoredDjuke,
          playbackFailure: playlistPlaybackFailure(batch, records, djukeAddress),
          ...(saved ? { playlistId: saved.id, revision: saved.revision } : {}),
          songs: batch.songIds.map((songId, index) => {
            const laneId = batch.laneIds[index];
            const track = tracks.get(songId.toLowerCase());
            return { songId, laneId, title: track?.title || 'Recording awaiting catalog recovery',
              artist: track?.uploader || '', status: playlistLaneStatus({ batch, index, contractAddress: djukeAddress, nowPlaying, records, hasPlaybackEvidence }) };
          }) };
      })];
    },
    paymentsEnabled: process.env.DJUKE_PAYMENTS_ENABLED === 'true',
    getPlaylist: () => {
      if (!playlistReady) throw new Error('DJuke catalog is restoring');
      return getPlaylist();
    },
  }) : undefined;
  const readDjukeState = readDjukeQueueState;
  const syncDevertDjukeBoosts = () => {
    if (!readDevertState || !readDjukeState || !_devertSchedulerContract || _devertBoostTask) return _devertBoostTask;
    _devertBoostTask = applyDevertDjukeBoosts({ contract: _devertSchedulerContract,
      readCampaigns: readDevertState, readDjukeState, inFlightRequests: _devertBoostsInFlight })
      .catch(error => console.warn('[devert] DJuke campaign boost deferred:', error.shortMessage || error.message))
      .finally(() => { _devertBoostTask = null; });
    return _devertBoostTask;
  };
  if (readDevertState && readDjukeState && _devertSchedulerContract) {
    setTimeout(syncDevertDjukeBoosts, 30_000).unref();
    setInterval(budgetPaced(syncDevertDjukeBoosts), 60_000).unref();
  }
  if (readDjukeState && process.env.DJUKE_FULFILLER_PRIVATE_KEY) {
    const worker = new Wallet(process.env.DJUKE_FULFILLER_PRIVATE_KEY, getRpcRouter().provider('critical', 'djuke-registrar'));
    const registerSongs = createDjukeSongRegistrar({ contract: new Contract(djukeAddress, DJUKE_ABI, worker),
      getPlaylist: () => (playlistReady ? getPlaylist() : []), onRegistered: songIds => readDjukeState.invalidate(songIds) });
    const runRegistrar = () => registerSongs().catch(error => console.warn('[djuke] Song registration deferred:', error.shortMessage || error.message));
    setTimeout(runRegistrar, 30_000).unref();
    setInterval(budgetPaced(runRegistrar), 120_000).unref();
  }
  if (readDjukeState && process.env.DJUKE_FULFILLER_PRIVATE_KEY && checkpointMirror && config.pinataJwt) {
    const fulfiller = new Wallet(process.env.DJUKE_FULFILLER_PRIVATE_KEY, getRpcRouter().provider('critical', 'djuke-fulfiller'));
    const journalStore = createPinataStateStore({ ...config.checkpointStorage, pinataJwt: config.pinataJwt, uploadUrl: config.pinataApiUrl,
      filesApiUrl: config.pinataFilesApiUrl, gateway: config.ipfsGateway, name: 'decentbusking-djuke-journal.json',
      requireLocalMirror: playlistBatchWorkerEnabled,
      tags: { app: 'decentbusking', kind: 'djuke-journal', schema: '1' }, serialize: value => value,
      deserialize: value => value, beforeUpload: (bytes, options) => checkpointMirror.mirror(bytes, options) });
    _djukeRuntime = createDjukeRuntime({
      readState: async () => {
        if (playlistBatchJournal) {
          if (!playlistBatchEventsReady) throw new Error('Playlist batch journal is restoring');
          await playlistBatchJournal.reconcile();
        }
        return readDjukeState();
      },
      journal: createDjukePlaybackJournal(journalStore),
      fulfill: createDjukeFulfiller(new Contract(djukeAddress, DJUKE_ABI, fulfiller)),
      refundPlaylistBatch: playlistBatchJournal ? (() => {
        const contract = new Contract(djukeAddress, [...DJUKE_ABI, ...playlistBatchEventAbi()], fulfiller);
        const pending = new Map();
        return batchId => {
          const key = String(batchId);
          if (!pending.has(key)) pending.set(key, (async () => {
            const known = playlistBatchJournal.getState().find(batch => batch.batchId === key);
            if (known?.status === 'refunded' || known?.status === 'settled') return;
            try {
              const transaction = await contract.refundUndeliveredPlaylist(key);
              if ((await transaction.wait())?.status !== 1) throw new Error(`Playlist suffix refund failed: ${transaction.hash}`);
            } catch (error) {
              await playlistBatchJournal.reconcile();
              const current = playlistBatchJournal.getState().find(batch => batch.batchId === key);
              if (current?.status !== 'refunded') throw error;
            }
            await playlistBatchJournal.reconcile();
          })().finally(() => pending.delete(key)));
          return pending.get(key);
        };
      })() : undefined,
      onVerifiedRequests: async state => {
        if (!_devertSchedulerContract || !readDevertState) return;
        await applyDevertDjukeBoosts({ contract: _devertSchedulerContract, readCampaigns: readDevertState,
          djukeState: state, inFlightRequests: _devertBoostsInFlight });
      },
      getTrack: trackId => getPlaylist().find(track => track.trackId === trackId) || null,
    });
    if (playlistBatchWorkerEnabled) {
      await verifyDjukePlaylistWorker({ provider: fulfiller.provider, workerAddress: fulfiller.address, version: process.env.DJUKE_CONTRACT_VERSION,
        contract: new Contract(djukeAddress, [...DJUKE_GAS_ABI, ...DJUKE_PLAYLIST_WORKER_ABI], fulfiller) });
      initializePlaylistWorker = async () => {
        await initializeDevertPlaybackWithRetry({ initialize: async () => {
          if (!playlistBatchEventsReady) {
            await playlistBatchJournal.initialize();
            playlistBatchEventsReady = true;
          }
          await _djukeRuntime.reconcile();
        } });
        playlistWorkerReady = true;
      };
    }
    console.log(`[djuke] Paid queue enabled; fulfiller ${fulfiller.address}.`);
  } else if (readDjukeState) {
    console.warn('[djuke] Queue is read-only: DJUKE_FULFILLER_PRIVATE_KEY, CHECKPOINT_MIRROR_SECRET and PINATA_JWT are all required for paid playback.');
  }

  let readDevertQueue;
  let paidAdRuntime;
  let syncPaidAdRemovals;
  const paidAdAddress = process.env.DEVERT_QUEUE_CONTRACT_ADDRESS;
  const paidAdVersion = Number(process.env.DEVERT_QUEUE_VERSION || 1);
  if (paidAdAddress) {
    let approvedAdCampaignIds = [];
    const provider = getRpcRouter().provider('critical', 'devert-paid-queue');
    const canFulfill = !!(readDevertState && devertSchedulerPrivateKey && checkpointMirror && config.pinataJwt && devertRemovals);
    readDevertQueue = createDevertQueueReader({ provider, contractAddress: paidAdAddress, version: paidAdVersion,
      paymentsEnabled: canFulfill && process.env.DEVERT_QUEUE_PAYMENTS_ENABLED === 'true',
      getPlaybackStatus: () => {
        if (!canFulfill) return { ready: false, reason: 'Paid advert worker is not configured' };
        if (!checkpointMirror.status().available) return { ready: false, reason: 'Local checkpoint mirror is offline' };
        const session = getActiveJukeLoopSession();
        if (!session) return { ready: false, reason: discordOfflineReason };
        return session.getPlaybackStatus();
      },
      getApprovedCampaignIds: () => approvedAdCampaignIds, cacheMs: 5000 });
    if (canFulfill) {
      const worker = new Wallet(devertSchedulerPrivateKey, provider);
      const queueContract = new Contract(paidAdAddress, devertQueueAbi(paidAdVersion), worker);
      if ((await queueContract.campaigns()).toLowerCase() !== process.env.DEVERT_CONTRACT_ADDRESS?.toLowerCase()) {
        throw new Error('Paid advert queue uses a different campaign contract');
      }
      if (!await queueContract.hasRole(await queueContract.FULFILLER_ROLE(), worker.address)) {
        throw new Error('Paid advert worker does not have the queue fulfiller role');
      }
      syncPaidAdRemovals = createDevertQueueCatalogSync({
        contract: queueContract, removals: devertRemovals, readCampaigns: readDevertState,
        beforeRemove: campaignId => paidAdRuntime?.prepareCampaignRemoval(campaignId),
        resolveApprovedMedia: (campaign, cid) => resolveApprovedDevertCampaignMedia(campaign, cid, {
          playlist: getPlaylist(), nfts: _nftCatalog || [],
        }),
      });
      const readConfirmedQueue = readDevertQueue;
      readDevertQueue = async () => {
        approvedAdCampaignIds = await syncPaidAdRemovals();
        return readConfirmedQueue();
      };
      setInterval(() => syncPaidAdRemovals().catch(error => console.warn('[devert-queue] Catalog reconciliation pending:', error.message)), 15000).unref();
      const store = createPinataStateStore({ ...config.checkpointStorage, pinataJwt: config.pinataJwt,
        uploadUrl: config.pinataApiUrl, filesApiUrl: config.pinataFilesApiUrl, gateway: config.ipfsGateway,
        name: paidAdVersion === 1 ? 'decentbusking-devert-paid-journal.json'
          : `decentbusking-devert-paid-${paidAdAddress.toLowerCase()}-journal.json`,
        requireLocalMirror: true,
        tags: { app: 'decentbusking', kind: paidAdVersion === 1 ? 'devert-paid-journal'
          : `devert-paid-${paidAdAddress.toLowerCase()}`, schema: '1' },
        serialize: value => value, deserialize: value => value, beforeUpload: (bytes, options) => checkpointMirror.mirror(bytes, options) });
      const paidAdRuntimeBase = createDevertQueueRuntime({ readState: readConfirmedQueue, store, contract: queueContract,
        isCampaignRemoved: campaignId => devertRemovals.isRemoved(campaignId),
        resolveCampaignMedia: (campaign, cid) => resolveDevertCampaignMedia(campaign, cid, {
          playlist: getPlaylist(), nfts: _nftCatalog || [],
        }) });
      paidAdRuntime = {
        ...paidAdRuntimeBase,
        async nextPaid(options) {
          approvedAdCampaignIds = await syncPaidAdRemovals();
          return paidAdRuntimeBase.nextPaid(options);
        },
      };
    } else console.warn('[devert-queue] Read-only: scheduler, durable mirror, Pinata and campaign removal state are required.');
  }
  _radioPaidQueues = (_djukeRuntime || paidAdRuntime)
    ? combinePaidQueues({ songs: _djukeRuntime, adverts: paidAdRuntime }) : null;

  console.log(`[rpc] Base tiers: ${getRpcRouter().health().tiers.paid} paid, ${getRpcRouter().health().tiers.public} public; consumers: ${getRpcRouter().describe()}`);
  const alchemyWebhook = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY ? createAlchemyWebhook({
    signingKey: process.env.ALCHEMY_WEBHOOK_SIGNING_KEY,
    routes: [
      { label: 'live-performance-escrow', addresses: [process.env.LIVE_PERFORMANCE_ESCROW_ADDRESS],
        refresh: [() => liveBookings.getState()] },
      { label: 'router', addresses: [payrollAssets.routerAddress],
        refresh: [comparePayments, refreshPayflow, refreshFundLedger, refreshEarningsLedger] },
      { label: 'devert', addresses: [process.env.DEVERT_CONTRACT_ADDRESS], refresh: [syncDevertDjukeBoosts, refreshFundLedger] },
      { label: 'djuke', addresses: [djukeAddress], refresh: [syncDevertDjukeBoosts, refreshFundLedger] },
      { label: 'devert-paid-queue', addresses: [paidAdAddress], refresh: [refreshFundLedger] },
      { label: 'nft', addresses: config.nftContractAddresses || [config.nftContractAddress], refresh: [() => syncMintedTracks(config)] },
    ],
  }) : null;
  if (alchemyWebhook) console.log(`[alchemy-webhook] Enabled; chain pollers relaxed to every ${WEBHOOK_SAFETY_POLL_MS / 1000}s as a safety net.`);
  const announcementStore = config.pinataJwt ? createPinataStateStore({
    ...config.checkpointStorage, pinataJwt: config.pinataJwt, uploadUrl: config.pinataApiUrl,
    filesApiUrl: config.pinataFilesApiUrl, gateway: config.ipfsGateway,
    name: 'decentbusking-radio-announcements.json', restoreLatestOnly: true,
    tags: { app: 'decentbusking', kind: 'radio-announcements', schema: '1' },
    serialize: value => value, deserialize: deserializeAnnouncements,
    beforeUpload: checkpointMirror ? (bytes, options) => checkpointMirror.mirror(bytes, options) : undefined,
  }) : null;
  const radioAnnouncements = createRadioAnnouncements({
    store: announcementStore, getClient: () => config.getDiscordClient?.() || client,
    ownerWallet: config.mintOwnerWallet, channelId: config.announceChannelId,
    defaultMention: config.announceDefaultMention, voiceChannelId: config.jukeLoopVoiceChannelId,
    listenUrl: config.siteUrl,
    canAnnounce: () => discordDiagnostics.bot('dbusker').notBefore() <= Date.now(),
    getSchedule: () => ({ ready: liveScheduleReady, schedule: defaultRadioSchedule(liveWeeklySchedule), events: livePerformanceEvents }),
  });
  setInterval(() => { void radioAnnouncements.tick(); }, 15_000).unref();
  const liveBookingStore = config.pinataJwt ? createPinataStateStore({ ...config.checkpointStorage,
    pinataJwt: config.pinataJwt, uploadUrl: config.pinataApiUrl, filesApiUrl: config.pinataFilesApiUrl,
    gateway: config.ipfsGateway, name: 'decentbusking-live-bookings.json',
    tags: { app: 'decentbusking', kind: 'live-bookings', schema: '1' },
    serialize: value => value, deserialize: value => value,
    beforeUpload: checkpointMirror ? (bytes, options) => checkpointMirror.mirror(bytes, options) : undefined }) : null;
  const liveBookings = createLiveBookings({ provider: paymentProvider, ownerWallet: config.mintOwnerWallet,
    escrowAddress: process.env.LIVE_PERFORMANCE_ESCROW_ADDRESS || '',
    escrowStartBlock: Number(process.env.LIVE_PERFORMANCE_ESCROW_START_BLOCK || 0), ensResolver: createEnsResolver(),
    restore: liveBookingStore ? liveBookingStore.restore : undefined, save: liveBookingStore ? liveBookingStore.save : undefined,
    getSchedule: () => ({ events: livePerformanceEvents, weeklySchedule: liveWeeklySchedule, ready: liveScheduleReady }),
    saveSchedule: async ({ events, weeklySchedule }) => {
      if (!liveScheduleReady || !liveScheduleStore) throw new Error('Durable schedule unavailable');
      const uri = await liveScheduleStore.save({ events, weeklySchedule });
      if (!/^ipfs:\/\//.test(uri || '')) throw new Error('Live schedule checkpoint did not confirm');
      livePerformanceEvents = events;
      liveWeeklySchedule = weeklySchedule;
      updateJukeLoopRadioSchedule({ events, schedule: defaultRadioSchedule(weeklySchedule) });
    },
  });
  const requestHandler = createWorkerRequestHandler({
    radioAnnouncements,
    liveBookings,
    alchemyWebhook,
    checkpointMirror,
    creatorProfiles,
    getDjukeState: readDjukeState,
    getDjukePlaylistGasQuote,
    getDjukePlaylistReadiness,
    getNftCatalog: async options => {
      if (!playlistReady) throw new Error('Playlist is restoring; retry shortly');
      if (Date.now() - _nftCatalogCheckedAt >= 60000) syncMintedTracks(config);
      if (!_nftCatalog) throw new Error(_nftCatalogError ? `NFT catalog unavailable: ${_nftCatalogError}` : 'NFT catalog is restoring; retry shortly');
      return { ...nftCatalogPage(_nftCatalog, options), lastCheckedAt: new Date(_nftCatalogCheckedAt).toISOString(),
        refreshError: _nftCatalogError };
    },
    getRadioSchedule: () => ({
      timeZone: PAYROLL_TIME_ZONE,
      playlistDefinitions: [...RADIO_PLAYLISTS, ...(liveWeeklySchedule.presets || [])].map(definition => playlistReady
        ? previewRadioPlaylist(definition.id, getPlaylist(), { definition: RADIO_PLAYLISTS.includes(definition) ? undefined : definition })
        : { ...definition, count: null, unknownCount: null, estimatedDurationMs: null, tracks: [] }),
      schedule: defaultRadioSchedule(liveWeeklySchedule),
      weeklySchedule: liveWeeklySchedule,
      events: livePerformanceEvents.filter(event => Date.parse(event.endUtc) > Date.now() - 7 * 86400_000),
      ready: liveScheduleReady,
      reminders: radioAnnouncements.reminderStatus(),
    }),
    saveRadioSchedule: async ({ events, weeklySchedule }) => {
      if (!liveScheduleReady || !liveScheduleStore) throw new Error('Live calendar is unavailable for durable updates');
      await liveScheduleStore.save({ events, weeklySchedule });
      livePerformanceEvents = events;
      liveWeeklySchedule = weeklySchedule;
      updateJukeLoopRadioSchedule({ events, schedule: defaultRadioSchedule(weeklySchedule) });
    },
    getPinnerManifest: () => {
      if (!playlistReady) throw new Error('Playlist is restoring');
      return buildCommunityPinManifest({ checkpointCid: playlistStateStore?.getLatestSnapshotUri()?.slice(7) || '',
        tracks: getPlaylist().filter(track => track.ipfsCid && track.pinStatus === 'pinned'),
        albumRoots: payrollAssets.communityAlbumRoots || [] });
    },
    getDjukeGasQuote,
    onReviewedAlbumImport: async () => {
      if (!playlistReady) throw new Error('Playlist is restoring; retry shortly');
      if (!queueReviewedAlbumImport) throw new Error('Reviewed album import is not configured');
      albumImportTask ||= queueReviewedAlbumImport().finally(() => { albumImportTask = null; });
      return albumImportTask;
    },
    allowedOrigins: config.allowedOrigins,
    radioAllowedOrigins: config.radioAllowedOrigins,
    ownerWallet: config.mintOwnerWallet || '0x0000000000000000000000000000000000000000',
    pinataJwt: config.pinataJwt,
    pinataSignUrl: config.pinataSignUrl,
    verifyMintTransaction,
    verifyArtworkUpdateTransaction: createArtworkUpdateTransactionVerifier({
      provider: getRpcRouter().provider('read', 'artwork-verify'),
      contractAddress: config.nftContractAddress,
      contractAddresses: config.nftContractAddresses,
      ownerWallet: config.mintOwnerWallet,
    }),
    onMintComplete: reconcileMint,
    onMediaSubmission: async (submission) => {
      if (!playlistReady) throw new Error('Playlist is restoring; please retry shortly');
      const track = submitMediaTrack(submission);
      await waitForRemotePersistence();
      return track;
    },
    artworkUpdateQueue,
    rpcUrl: config.baseRpcUrl,
    rpcProvider: getRpcRouter().provider('read', 'worker-reads'),
    getRpcHealth: () => getRpcRouter().health(),
    rpcProxy: createRpcProxy({
      request: (method, params) => getRpcRouter().request('fallback', method, params),
      allowedContracts: [
        process.env.LIVE_PERFORMANCE_ESCROW_ADDRESS,
        ...(config.nftContractAddresses || [config.nftContractAddress]),
        process.env.DJUKE_CONTRACT_ADDRESS || '0x5d07489163feBCdB39C9F579CCC36dff5A067FF9',
        process.env.DEVERT_CONTRACT_ADDRESS || '0x135Cbc573F87637158eb3186C87c584fb0B34CD9',
        process.env.DEVERT_QUEUE_CONTRACT_ADDRESS,
        payrollAssets.routerAddress,
        ...Object.values(payrollAssets.assets || {}).map(asset => asset?.address),
      ],
    }),
    pinataApiUrl: config.pinataApiUrl,
    ipfsApiUrl: config.ipfsApiUrl,
    getMintQueue: async () => {
      const mintRequests = (await getVerifiedMintRequests()).map((track) => ({
        trackId: track.trackId,
        title: track.title,
        uploader: track.uploader,
        uploaderId: track.uploaderId,
        recipient: track.mintRecipient,
        ipfsCid: track.ipfsCid,
        artworkCid: track.artworkCid || null,
        filename: track.filename,
        mediaType: mediaTypeFor(track.filename, track.mediaType),
        tipWallet: track.tipWallet || track.mintRecipient,
        parentTokenId: track.parentTokenId || 0,
        isDevertAd: track.isDevertAd === true,
        ...(track.creatorSplits ? { creatorSplits: track.creatorSplits } : {}),
        requestedAt: track.mintRequestedAt,
        requestType: 'mint',
      }));
      return mintRequests.concat(artworkUpdateQueue.getPendingRequests().map(mapArtworkUpdateRequest))
        .sort((first, second) => Date.parse(first.requestedAt || 0) - Date.parse(second.requestedAt || 0));
    },
    getRadioState: async () => {
      const jukeLoopSession = getActiveJukeLoopSession();
      let paidQueue = null;
      if (readDevertQueue) {
        try {
          paidQueue = await readDevertQueue();
        } catch (error) {
          console.warn('[devert-queue] Radio queue status unavailable:', error.message);
          paidQueue = { unavailable: true, reason: 'Paid advert queue could not be verified' };
        }
      }
      const mainRadioAdCountdown = jukeLoopSession ? await jukeLoopSession.getMainRadioAdCountdown(Date.now(), paidQueue) : null;
      const nowPlaying = getJukeLoopNowPlaying();
      const adVotes = nowPlaying?.isDevert
        ? _devertPlaybackRuntime?.getMainRadioAdVoteSummary(nowPlaying.playId) ?? null : null;
      return {
        ...buildRadioState({
          nowPlaying,
          playback: jukeLoopSession?.getPlaybackStatus() || { status: 'offline', ready: false, reason: discordOfflineReason },
          adVotes,
          upNext: getJukeLoopUpNext(),
          playlist: getPlaylist(),
          mainRadioAdCountdown,
          ...jukeLoopSession?.getShowState(),
        }),
        paymentLedger: {
          endpoint: '/api/payroll/ledger',
          snapshotUri: paymentLedger.getState().snapshotUri,
          lastCheckedAt: paymentLedger.getState().lastCheckedAt,
          ready: paymentLedgerReady,
        },
        discord: { ready: client?.isReady() === true, reason: client?.isReady() ? null : discordOfflineReason,
          diagnostics: discordDiagnostics.report() },
      };
    },
    getRadioMediaUrl: async cid => {
      const session = getActiveJukeLoopSession();
      if (!session) return null;
      const track = [session._currentTrack, getJukeLoopUpNext(), ...getPlaylist()]
        .find(entry => entry?.ipfsCid === cid);
      if (!track) return null;
      const gateway = await discoverDedicatedGateway(config) || config.ipfsGateway;
      return await resolveStreamableIpfsUrl(gateway, cid) ||
        (track.messageId ? session._getFreshUrl({ ...track, ipfsCid: null }) : null);
    },
    getDevertState: readDevertState,
    getDevertQueue: readDevertQueue,
    removeDevertCampaign: devertRemovals ? async payload => {
      const removal = await devertRemovals.remove(payload);
      await getActiveJukeLoopSession()?.removeDevertCampaign(payload.campaignId);
      _devertLoopWorker?.removeCampaign(payload.campaignId);
      if (syncPaidAdRemovals) await syncPaidAdRemovals();
      return removal;
    } : undefined,
    getFunds: async () => fundLedger.getCurrentState(),
    getEarnings: async ({ address }) => {
      const state = earningsLedger.getAddressState(address);
      if (!playlistReady || !state.entries.some(entry => entry.songId)) return state;
      const titles = new Map(getPlaylist().map(track => [id(track.trackId), track.title || track.filename || '']));
      return { ...state, entries: state.entries.map(entry => (entry.songId && titles.get(entry.songId)
        ? { ...entry, trackTitle: titles.get(entry.songId) } : entry)) };
    },
    getDjukeTopEarners: () => earningsLedger.getDjukeTopEarners(),
    ensResolver: createEnsResolver(),
    getDevertAds: async ({ address }) => {
      if (!playlistReady) throw new Error('Advert library is restoring; retry shortly');
      const snapshot = await readDevertState?.();
      const normalizedAddress = address.toLowerCase();
      const localAds = getDevertAdsForWallet(address, snapshot?.campaigns || []);
      const cached = _devertAdsOnChainCache.get(normalizedAddress);
      let scanPending = _devertAdsOnChainScans.has(normalizedAddress);
      let chainResult = cached && (cached.expiresAt > Date.now() || scanPending) ? cached.result : null;
      if (!chainResult) {
        scanPending = true;
        if (!_devertAdsOnChainScans.has(normalizedAddress)) {
          const scan = (async () => {
            try {
              const provider = getRpcRouter().provider('read', 'devert-ads-scan');
              const multicall = new Contract(BASE_MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
              const balanceInterface = new Interface(NFT_BALANCE_ABI);
              const currentCollection = config.nftContractAddress.toLowerCase();
              const orderedAddresses = [...config.nftContractAddresses].sort((first, second) =>
                Number(second.toLowerCase() === currentCollection) - Number(first.toLowerCase() === currentCollection));
              const collections = orderedAddresses.map(contractAddress => ({ contractAddress,
                contract: new Contract(contractAddress, [
                  'function nextTokenId() view returns(uint256)',
                  'function uri(uint256) view returns(string)',
                ], provider) }));
              const ownershipReader = async (collection, owner, tokenIds) => {
                const calls = tokenIds.map(tokenId => ({ target: collection.contractAddress, allowFailure: true,
                  callData: balanceInterface.encodeFunctionData('balanceOf', [owner, tokenId]) }));
                const results = await multicall.aggregate3(calls);
                return results.map(({ success, returnData }) => success
                  ? { balance: balanceInterface.decodeFunctionResult('balanceOf', returnData)[0] }
                  : { error: new Error('Multicall ownership check failed') });
              };
              const result = await readOwnedDevertAds({ collections, address: normalizedAddress,
                ownershipConcurrency: DEVERT_OWNERSHIP_BATCH_SIZE, ownershipReader,
                onProgress: progress => _devertAdsOnChainCache.set(normalizedAddress, {
                  result: progress, expiresAt: Date.now() + 60_000,
                }),
                log: { warn: message => console.warn(message) } });
              _devertAdsOnChainCache.set(normalizedAddress, { result,
                expiresAt: Date.now() + (result.metadataUnavailable || result.ownershipUnavailable ? 60_000 : 5 * 60_000) });
            } catch (error) {
              console.warn(`[devert] Wallet ad scan failed for ${normalizedAddress}: ${error.message}`);
              _devertAdsOnChainCache.set(normalizedAddress, { result: { ads: [], metadataUnavailable: 1, ownershipUnavailable: 0 },
                expiresAt: Date.now() + 60_000 });
            } finally {
              _devertAdsOnChainScans.delete(normalizedAddress);
            }
          })();
          _devertAdsOnChainScans.set(normalizedAddress, scan);
        }
        chainResult = { ads: [], metadataUnavailable: 0, ownershipUnavailable: 0 };
      }
      const mergedAds = mergeDevertAdsForWallet(localAds, chainResult.ads);
      for (const ad of mergedAds) {
        const campaign = snapshot?.campaigns?.find(item => item.advertiser?.toLowerCase() === normalizedAddress &&
          item.audioURI === `ipfs://${ad.ipfsCid}` && Date.parse(item.startedAt) <= Date.now() && Date.now() < Date.parse(item.expiresAt));
        ad.state = campaign ? 'active' : ad.mintStatus === 'minted' ? 'ready' : 'pending';
        ad.removed = campaign?.removed === true;
        ad.campaignId = campaign?.campaignId || null;
        ad.expiresAt = campaign?.expiresAt || null;
        ad.secondsRemaining = campaign ? Math.max(0, Math.ceil((Date.parse(campaign.expiresAt) - Date.now()) / 1000)) : 0;
      }
      return { ads: mergedAds,
        metadataUnavailable: chainResult.metadataUnavailable,
        ownershipUnavailable: chainResult.ownershipUnavailable,
        scanPending };
    },
    getDevertLoopState: () => _devertLoopWorker?.getState() || { ready: false, nowPlaying: null, voiceConnected: false },
    onDevertLoopVote: payload => _devertLoopWorker ? _devertLoopWorker.submitVote(payload) : Promise.reject(new Error('VertLoop is not ready')),
    getRadioHistory: async ({ weeks, wallet, includeAllTime, calendar }) => getWeeklyPlayHistory({ weeks, wallet, includeAllTime, calendar }),
    getWeeklyPayflow: ({ wallet }) => payflow.getState({ wallet }),
    getPaymentLedger: () => ({ ...paymentLedger.getState(), ready: paymentLedgerReady,
      payrollAnnouncements: payrollReporter.getState(),
      repositorySync: process.env.PAYROLL_GITHUB_TOKEN ? repositorySyncError || 'automatic dispatch configured' : 'manual GitHub ledger workflow; PAYROLL_GITHUB_TOKEN not configured' }),
    reconcilePayment: async txHash => {
      if (!paymentLedgerReady) throw new Error('Payment ledger is restoring; retry shortly');
      return paymentLedger.reconcile(txHash);
    },
    onRadioVote: submitJukeLoopVote,
  });
  const port = process.env.PORT || 10000;
  http.createServer(requestHandler).listen(port, () => {
    console.log(`Health check and IPFS worker listening on port ${port}`);
  });

  // Restore durable state before Discord backfill or JukeLoop starts.
  if (config.ipfsUploadProvider === 'pinata') {
    const stateStore = createPinataStateStore({
      ...config.checkpointStorage,
      pinataJwt: config.pinataJwt,
      uploadUrl: config.pinataApiUrl,
      filesApiUrl: config.pinataFilesApiUrl,
      gateway: config.ipfsGateway,
      beforeUpload: checkpointMirror ? (bytes, options) => checkpointMirror.mirror(bytes, options) : undefined,
    });
    playlistStateStore = stateStore;
    liveScheduleStore = createPinataStateStore({
      ...config.checkpointStorage,
      pinataJwt: config.pinataJwt,
      uploadUrl: config.pinataApiUrl,
      filesApiUrl: config.pinataFilesApiUrl,
      gateway: config.ipfsGateway,
      name: 'decentbusking-live-schedule.json',
      tags: { app: 'decentbusking', kind: 'live-schedule', schema: '1' },
      serialize: serializeLiveSchedule,
      deserialize: deserializeLiveSchedule,
    });
    try {
      const restoredSchedule = await liveScheduleStore.restore() || { events: [], weeklySchedule: {} };
      livePerformanceEvents = restoredSchedule.events || [];
      liveWeeklySchedule = restoredSchedule.weeklySchedule || {};
      // Owner-authorized cancellation of the mock show; never affects future Friday occurrences.
      const mockShowId = 'friday-live-performance:2026-10-16';
      if (Date.now() < Date.parse('2026-10-17T02:00:00Z') &&
          !livePerformanceEvents.some(event => event.id === mockShowId && event.status === 'cancelled')) {
        livePerformanceEvents = [...livePerformanceEvents.filter(event => event.id !== mockShowId), {
          id: mockShowId, type: 'live_performance', title: 'Friday Live Performance Block',
          startUtc: '2026-10-17T01:00:00.000Z', endUtc: '2026-10-17T02:00:00.000Z', priority: 200,
          status: 'cancelled', cancellationReason: 'This week was a mock-up and building session. No live performance tonight; regular radio continues.',
        }];
        await liveScheduleStore.save({ events: livePerformanceEvents, weeklySchedule: liveWeeklySchedule });
      }
      liveScheduleReady = true;
      console.log(`[radio-schedule] Restored ${livePerformanceEvents.length} live event(s).`);
    } catch (error) {
      liveScheduleReady = false;
      console.warn('[radio-schedule] Calendar restore failed; admin calendar edits are disabled:', error.message);
    }
    let restoredPlaylist = null;
    // An empty start would checkpoint over the real playlist, so retry transient failures first.
    for (let attempt = 1; attempt <= STATE_RESTORE_ATTEMPTS; attempt++) {
      try {
        restoredPlaylist = await stateStore.restore();
        break;
      } catch (err) {
        console.warn(`[ipfs-state] Remote restore attempt ${attempt} failed:`, err.message);
        if (attempt < STATE_RESTORE_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));
      }
    }
    const recovery = await recoverVerifiedPlaylistBaseline(restoredPlaylist, {
      store: stateStore,
      cid: 'bafybeibzxkm6ttknixv5w4ywjczazrw6dp7aqi7bszw5waav5im3wursau',
      savedAt: '2026-10-15T22:33:36.952Z', week: 'NY-2026-10-12', expectedTracks: 268,
      expectedPlays: 1136, expectedVotes: 120,
      expectedSongs: [
        { trackId: '1556130244510097426', votes: 17, plays: 29 },
        { trackId: '1559282391413952582', votes: 8, plays: 23 },
      ],
    });
    restoredPlaylist = recovery.playlist;
    if (recovery.recovered) console.log(`[playlist-recovery] Restored approved 2026-10-15 22:33:36 baseline; checkpoint ${recovery.uri}.`);
    loadPlaylist(restoredPlaylist);
    configureRemotePersistence(stateStore.save, { schedule: stateStore.schedule, flush: stateStore.flush });
    const payrollRecoveryCids = restoredPlaylist.some(track => track.playlistBaselineCid)
      ? [] : (process.env.JUKELOOP_PAYROLL_RECOVERY_CID || PAYROLL_RECOVERY_CIDS.join(','))
        .split(',').map(cid => cid.trim()).filter(Boolean);
    let recoveryCids = payrollRecoveryCids;
    if (!getPlaylist().length && recoveryCids.length) {
      const baselineCid = recoveryCids[0];
      try {
        const baseline = await stateStore.restoreCid(baselineCid, { attempts: 4, baseDelayMs: 15_000 });
        const tracks = seedPlaylistFromPayrollSnapshot(baseline, baselineCid, stateStore.getLatestSnapshotSavedAt());
        await waitForRemotePersistence();
        console.log(`[payroll-recovery] Seeded ${tracks} tracks from ${baselineCid}; saved weekly history restored.`);
        recoveryCids = recoveryCids.slice(1);
      } catch (error) {
        console.warn('[payroll-recovery] Archived playlist could not seed the empty store:', error.message);
      }
    }
    for (const payrollRecoveryCid of recoveryCids) {
      if (hasPayrollHistoryRecovery(payrollRecoveryCid)) continue;
      try {
        const archivedPlaylist = await stateStore.restoreCid(payrollRecoveryCid, { attempts: 4, baseDelayMs: 15_000 });
        const merged = mergePayrollHistorySnapshot(archivedPlaylist, payrollRecoveryCid,
          { snapshotSavedAt: stateStore.getLatestSnapshotSavedAt() });
        if (merged.mergedTracks) {
          await waitForRemotePersistence();
          console.log(`[payroll-recovery] Added ${merged.addedPlays} plays/${merged.addedVotes} votes and corrected ${merged.correctedPlays} plays/${merged.correctedVotes} votes from ${payrollRecoveryCid} across ${merged.mergedTracks} tracks.`);
        }
      } catch (error) {
        console.warn('[payroll-recovery] Archived playback counters were not merged:', error.message);
      }
    }
    if (process.env.DBUSK_IMPORT_REVIEWED_ALBUMS === 'true') {
      try {
        if (!Array.isArray(restoredPlaylist) || !restoredPlaylist.length) throw new Error('Verified remote playlist restore required for album import');
        const plan = JSON.parse(fs.readFileSync(new URL('../docs/reports/album-import-candidates.json', import.meta.url), 'utf8'));
        const artist = resolveAlbumArtist(restoredPlaylist, { name: 'thejollylama', wallet: config.mintOwnerWallet });
        const imported = await checkpointReviewedAlbumImport({ playlist: restoredPlaylist, plan, artist, save: stateStore.save,
          mirrorBeforePublication: true,
          verifyMirrorAvailable: async () => {},
        });
        if (imported.added.length) loadPlaylist(imported.playlist);
        console.log(`[album-import] Added ${imported.added.length}; skipped ${imported.skipped.length}. Checkpoint: ${imported.checkpointUri || 'already imported'}`);
      } catch (error) {
        console.warn('[album-import] No album state adopted:', error.message);
      }
    }
    queueReviewedAlbumImport = async () => {
      if (!getPlaylist().length) {
        throw new Error('Verified nonempty Pinata playlist restore required for album import');
      }
      const plan = JSON.parse(fs.readFileSync(new URL('../docs/reports/album-import-candidates.json', import.meta.url), 'utf8'));
      const artist = resolveAlbumArtist(getPlaylist(), { name: 'thejollylama', wallet: config.mintOwnerWallet });
      const imported = await checkpointReviewedAlbumImport({ playlist: getPlaylist(), plan, artist, save: stateStore.save,
        queueForMint: true,
        mirrorBeforePublication: true,
        verifyMirrorAvailable: async () => {},
      });
      if (imported.added.length || imported.queued.length) loadPlaylist(imported.playlist);
      console.log(`[album-import] Added ${imported.added.length}; queued ${imported.queued.length}; skipped ${imported.skipped.length}. No NFTs minted. Checkpoint: ${imported.checkpointUri || 'already imported'}`);
      return { added: imported.added.length, queued: imported.queued.length, skipped: imported.skipped.length,
        checkpointUri: imported.checkpointUri, minted: 0 };
    };
    playlistReady = true;
    if (process.env.DBUSK_IMPORT_REVIEWED_ALBUMS === 'true') {
      albumImportTask ||= queueReviewedAlbumImport().finally(() => { albumImportTask = null; });
      try { await albumImportTask; }
      catch (error) { console.warn('[album-import] No album state adopted:', error.message); }
    }
    if (!restoredPlaylist && getPlaylist().length > 0) {
      try {
        await stateStore.save(getPlaylist());
        console.log('[ipfs-state] Seeded Pinata from the local playlist cache.');
      } catch (err) {
        console.warn('[ipfs-state] Could not seed initial checkpoint:', err.message);
      }
    }
  } else {
    liveScheduleStore = null;
    livePerformanceEvents = [];
    liveWeeklySchedule = {};
    liveScheduleReady = false;
    loadPlaylist();
    playlistReady = true;
  }
  if (initializePlaylistWorker) void initializePlaylistWorker()
    .catch(error => console.warn('[djuke] Playlist worker initialization pending:', error.message));
  refreshPayflow();
  syncMintedTracks(config);

  async function connectMainDiscord() {
    client = new Client({
      rest: DISCORD_REST_OPTIONS,
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    });
    const connectionClient = client;
    const detachDiagnostics = discordDiagnostics.bot('dbusker').attach(connectionClient);
    const sessionWatch = watchDiscordSession(connectionClient);
    const broadcast = getActiveJukeLoopSession();
    if (broadcast) {
      broadcast.client = connectionClient;
      broadcast.textChannel = null;
      broadcast._discordOutputsAttached = false;
      broadcast._discordOutputsBlocked = false;
    }

    const reactionUpdates = new Map();
    const handleReaction = change => (reaction, user) => {
      const emoji = reaction.emoji.name?.startsWith('👍') ? '👍' : reaction.emoji.name?.startsWith('👎') ? '👎' : null;
      if (user.bot || !emoji || ![config.jukeLoopTextChannelId, config.jukeboxChannelId].includes(reaction.message.channelId)) return;
      const receivedAt = Date.now();
      const key = reaction.message.id;
      const pending = (reactionUpdates.get(key) || Promise.resolve()).then(async () => {
        const message = await reaction.message.fetch();
        synchronizeDiscordRating(message, client.user.id, { change, emoji, now: receivedAt });
      }).catch(error => console.warn('[ratings] Could not synchronize Discord reaction:', error.message));
      reactionUpdates.set(key, pending);
      pending.finally(() => { if (reactionUpdates.get(key) === pending) reactionUpdates.delete(key); });
    };
    client.on(Events.MessageReactionAdd, handleReaction(1));
    client.on(Events.MessageReactionRemove, handleReaction(-1));

    client.once(Events.ClientReady, async (readyClient) => {
      if (discordAbort.signal.aborted || client !== readyClient) return;
      console.log(`[jukebox-bot] Logged in as ${readyClient.user.tag}`);
      console.log(`[jukebox-bot] Watching channel ID: ${config.jukeboxChannelId}`);

      // Discord outputs must never gate the website broadcast.
      readyClient.rest.put(Routes.applicationCommands(readyClient.user.id), { body: SLASH_COMMANDS }).then(() => {
        console.log('[jukebox-bot] Slash commands registered globally.');
      }).catch(err => {
        console.error('[jukebox-bot] Failed to register slash commands:', err.message);
      });

      // ── JukeLoop startup ───────────────────────────────────────────────────────
      if (config.jukeLoopTextChannelId) {
        void startJukeLoop(readyClient, config);
      } else {
        console.log(
          '[jukeloop] JUKE_LOOP_TEXT_CHANNEL_ID not set — ' +
          'JukeLoop disabled.',
        );
      }
      runWeeklyPlayReport(readyClient, config).catch((err) => console.error('[weekly-play-report] Failed:', err.message));
    });

    client.on(Events.MessageCreate, async (message) => {
      // Ignore bots and messages outside the configured channel
      if (message.author.bot) return;
      const devertCommand = message.channelId === config.jukeboxChannelId && /^!devert-ad\b/i.test(message.content || '');
      if (devertCommand && process.env.DVERT_LOOP_DISCORD_ENABLED === 'true' &&
          process.env.DVERT_LOOP_AD_INTAKE_ENABLED === 'true') return;
      if (devertCommand || shouldHandleDevertLoopSubmission(message, {
        jukeboxChannelId: config.jukeboxChannelId,
        vertLoopChannelId: process.env.VERT_LOOP_CHANNEL_ID,
        adIntakeEnabled: process.env.DVERT_LOOP_DISCORD_ENABLED === 'true' &&
          process.env.DVERT_LOOP_AD_INTAKE_ENABLED === 'true',
      })) {
        await handleDevertLoopSubmission(message, config, creatorProfiles);
        return;
      }
      const intakeChannels = new Set([config.jukeboxChannelId, config.jukeLoopTextChannelId, process.env.VERT_LOOP_CHANNEL_ID].filter(Boolean));
      if (!intakeChannels.has(message.channelId)) return;

      const audioAttachments = [...message.attachments.values()].filter(isAudioAttachment);
      if (!audioAttachments.length) return;
      for (const attachment of audioAttachments) {
        await submissionIntake.prompt(message, attachment, message.channelId === process.env.VERT_LOOP_CHANNEL_ID ? 'advert' : 'song');
      }
    });

    // ── Slash command interactions ───────────────────────────────────────────────
    client.on(Events.InteractionCreate, async (interaction) => {
      try {
        if (await submissionIntake.handleInteraction(interaction)) return;
        if (await handleMintRequestInteraction(interaction)) return;
      } catch (error) {
        console.error('[mint-request] Interaction failed:', error.message);
        if (interaction.isRepliable?.() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'Could not open the NFT request. Please retry.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        return;
      }
      if (!interaction.isChatInputCommand()) return;

      if (interaction.commandName === 'creator-link') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          if (!creatorProfiles) throw new Error('Creator profiles are not configured');
          const user = await interaction.user.fetch();
          await creatorProfiles.confirmDiscord(interaction.options.getString('code', true), user);
          await interaction.editReply('Discord identity verified. Refresh your Profile to see the link.');
        } catch (error) { await interaction.editReply(error.message); }
        return;
      }

      if (interaction.commandName === 'radio') {
        await handleRadioCommand(interaction, config);
      } else if (interaction.commandName === 'jukebox') {
        await handleJukeboxCommand(interaction, config);
      } else if (interaction.commandName === 'jukeloop') {
        await handleJukeLoopCommand(interaction, config, { reconcileMint });
      }
    });

    try {
      await loginDiscordClient(connectionClient, config.discordToken, {
        signal: discordAbort.signal, notBefore: null,
        onUnavailable: reason => { discordOfflineReason = reason; },
      });
      return { closed: sessionWatch.closed, stop: async () => {
        const currentBroadcast = getActiveJukeLoopSession();
        if (currentBroadcast?.client === connectionClient) {
          currentBroadcast._voiceConnection?.stop();
          currentBroadcast._voiceConnection = null;
          currentBroadcast.connection = null;
          currentBroadcast.textChannel = null;
          currentBroadcast._discordOutputsAttached = false;
        }
        await connectionClient.destroy();
        sessionWatch.dispose();
        detachDiagnostics();
      } };
    } catch (error) {
      await connectionClient.destroy();
      sessionWatch.dispose();
      detachDiagnostics();
      throw error;
    }
  }

  let mainDiscordConnection;
  void recoverDiscordConnection({
    connect: connectMainDiscord, diagnostics: discordDiagnostics, name: 'dbusker', signal: discordAbort.signal,
    onUnavailable: reason => { discordOfflineReason = reason; },
    onConnected: connection => { mainDiscordConnection = connection; },
  })
    .catch(() => console.error('[discord] Recovery supervisor failed; inspect diagnostics.'));
  if (config.jukeLoopTextChannelId) void startWebsiteRadio(client, config);
  setInterval(() => discordDiagnostics.maintenance(), 60_000).unref();
  setInterval(() => {
    if (client?.isReady()) runIpfsBackfill(client, config);
  }, IPFS_BACKFILL_INTERVAL_MS).unref();
  setInterval(() => {
    if (client?.isReady()) runWeeklyPlayReport(client, config)
      .catch(err => console.error('[weekly-play-report] Failed:', err.message));
  }, WEEKLY_REPORT_CHECK_INTERVAL_MS).unref();
  setInterval(() => {
    const broadcast = getActiveJukeLoopSession();
    if (client?.isReady() && broadcast?.websitePlayback &&
        !broadcast._discordOutputsAttached && !broadcast._discordOutputsBlocked) {
      void startJukeLoop(client, config);
    }
  }, 60_000).unref();

  const shutdown = async (signal) => {
    console.log(`[jukebox-bot] ${signal} received; flushing IPFS state checkpoint.`);
    let exitCode = 0;
    discordAbort.abort();
    try {
      await Promise.all([waitForRemotePersistence(), fundStore?.flush(), earningsStore?.flush(),
        Promise.race([flushRpcUsage(), new Promise(resolve => setTimeout(resolve, 5000))]),
        discordDiagnostics.flush()]);
    } catch (error) {
      exitCode = 1;
      console.error('[jukebox-bot] Shutdown checkpoint failed:', error.message);
    }
    await mainDiscordConnection?.stop();
    _devertLoopWorker?.stop();
    await client?.destroy();
    getActiveJukeLoopSession()?.destroy();
    process.exit(exitCode);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

// ── /radio command handler ────────────────────────────────────────────────────

/**
 * Handle all `/radio` subcommands.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {ReturnType<typeof loadConfig>} config
 */
async function handleRadioCommand(interaction, config) {
  const sub = interaction.options.getSubcommand();

  // Controls that require an already-active session
  if (sub === 'skip' || sub === 'pause' || sub === 'stop') {
    const session = getSession(interaction.guildId);
    if (!session) {
      await interaction.reply({ content: '📻 No radio session is active right now.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (sub === 'skip') {
      session.skip();
      await interaction.reply('⏭️ Skipping to the next track…');
    } else if (sub === 'pause') {
      const nowPaused = session.togglePause();
      await interaction.reply(nowPaused ? '⏸️ Radio paused.' : '▶️ Radio resumed.');
    } else {
      session.stop();
      await interaction.reply('⏹️ Radio stopped and disconnected.');
    }
    return;
  }

  // /radio play <cid>
  const cid = interaction.options.getString('cid', true).trim();

  // The caller must be in a voice channel
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    await interaction.reply({
      content: '🎙️ You must be in a voice channel to start the radio.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  try {
    const tracks = await fetchTrackList(cid, config.ipfsGateway);
    if (tracks.length === 0) {
      await interaction.editReply(NO_TRACKS_MSG);
      return;
    }

    const session = createSession(interaction.guildId, {
      voiceChannel,
      textChannel: interaction.channel,
    });

    await session.connect();
    await interaction.editReply(
      `📻 Radio starting — found **${tracks.length}** track(s) from \`${cid}\`. Joining <#${voiceChannel.id}>…`,
    );
    await session.start(tracks);
  } catch (err) {
    console.error('[radio] Error starting radio:', err);
    await interaction.editReply(`❌ Failed to start radio: ${err.message}`);
  }
}

// ── /jukebox command handler ──────────────────────────────────────────────────

/**
 * Handle all `/jukebox` subcommands.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {ReturnType<typeof loadConfig>} config
 */
async function handleJukeboxCommand(interaction, config) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'submit') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const ipfsCid = normalizeMediaCid(interaction.options.getString('cid', true));
      const recipient = interaction.options.getString('wallet', true).trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) throw new Error('Enter a valid Base wallet address');
      const extension = interaction.options.getString('format', true);
      if (!MEDIA_TYPES[extension]) throw new Error('Unsupported media format');
      const track = { attachmentId: `cid:${interaction.user.id}:${ipfsCid}`, messageId: interaction.id,
        channelId: config.jukeboxChannelId, filename: `track.${extension}`, mediaType: MEDIA_TYPES[extension],
        title: interaction.options.getString('title', true).trim(), uploader: interaction.user.tag || interaction.user.username,
        uploaderId: interaction.user.id, pinStatus: 'pinned', ipfsCid };
      addTrack(track);
      const existing = getPlaylist().find(entry => entry.trackId === getTrackId(track));
      const artworkCid = existing?.artworkCid || await pinDiscordAvatar(interaction.user, config);
      if (!artworkCid) throw new Error('Could not archive your Discord profile image; retry or use Request NFT with custom artwork');
      const queued = requestTrackMint(getTrackId(track), interaction.user.id, recipient, artworkCid);
      if (!queued) throw new Error('That file is already minted or cannot be queued');
      await waitForRemotePersistence();
      await interaction.editReply(`Queued **${queued.title}** for owner approval. Track ID: \`${queued.trackId}\`. Artwork: ${existing?.artworkCid ? 'existing image' : 'your Discord profile image'}. You can replace it with a 10 MB image upload or image/GIF CID in Admin. MP4 audio plays in voice; video plays on DecentBusking.`);
    } catch (error) {
      await interaction.editReply(`Submission failed: ${error.message}`);
    }
    return;
  }

  if (sub === 'request-mint') {
    const trackId = interaction.options.getString('track_id', true).trim();
    const wallet = interaction.options.getString('wallet', true).trim();
    const artwork = interaction.options.getAttachment('artwork');
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      await interaction.reply({ content: '❌ Enter a valid `0x` Base wallet address.', flags: MessageFlags.Ephemeral });
      return;
    }

    const ownedTrack = getPlaylist().find((track) =>
      track.trackId === trackId &&
      track.uploaderId === interaction.user.id &&
      track.pinStatus === 'pinned' &&
      track.ipfsCid &&
      track.mintStatus !== 'minted'
    );
    if (!ownedTrack) {
      await interaction.reply({
        content: '❌ That track is not yours, is not pinned to IPFS yet, or has already been minted.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (artwork && (!isImageAttachment(artwork) || artwork.size > MAX_ARTWORK_BYTES)) {
      await interaction.reply({
        content: '❌ Artwork must be a PNG, JPEG, WebP, or GIF no larger than 10 MB.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let artworkCid;
    try {
      if (artwork) {
        const response = await fetch(artwork.url);
        if (!response.ok) throw new Error(`HTTP ${response.status} downloading artwork`);
        const buffer = Buffer.from(await response.arrayBuffer());
        const artworkUri = await uploadToIPFS(
          buffer,
          artwork.name || 'artwork.png',
          artwork.contentType || 'image/png',
          {
            provider: config.ipfsUploadProvider,
            pinataJwt: config.pinataJwt,
            pinataApiUrl: config.pinataApiUrl,
            ipfsApiUrl: config.ipfsApiUrl,
          },
        );
        artworkCid = artworkUri.replace('ipfs://', '');
      } else {
        artworkCid = await pinDiscordAvatar(interaction.user, config) || undefined;
      }
    } catch (err) {
      await interaction.editReply(`❌ Artwork upload failed: ${err.message}`);
      return;
    }

    const track = requestTrackMint(trackId, interaction.user.id, wallet, artworkCid);
    if (!track) {
      await interaction.editReply('❌ The mint request changed while the artwork was uploading. Please retry.');
      return;
    }

    await interaction.editReply({
      content:
        `✅ Mint request submitted for **${track.title}** — no NFT has been minted yet.\n` +
        `Recipient and royalty wallet: \`${wallet}\`\n` +
        (track.artworkCid ? `Artwork CID: \`${track.artworkCid}\`\n` : '') +
        'Next, the contract owner must approve it from `/jukeloop mint-queue`. ' +
        'After both Base transactions confirm, the NFT will mint directly to that wallet and the bot will announce it publicly.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === 'backlog') {
    const tracks = getMintBacklog(interaction.user.id);
    if (tracks.length === 0) {
      await interaction.reply({
        content: '✅ You have no unminted DecentJukebox uploads in the tracked playlist.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const lines = tracks.slice(0, 20).map((track, index) => {
      if (track.mintStatus === 'requested') {
        return `**${index + 1}. ${track.title}** — awaiting owner approval for \`${track.mintRecipient}\``;
      }
      if (track.pinStatus === 'pinned' && track.ipfsCid) {
        return `**${index + 1}. ${track.title}** — ready · track ID: \`${track.trackId}\``;
      }
      if (track.pinStatus === 'failed') {
        return `**${index + 1}. ${track.title}** — IPFS pin failed; retrying automatically`;
      }
      if (track.pinStatus === 'pending') {
        return `**${index + 1}. ${track.title}** — IPFS pin in progress`;
      }
      return `**${index + 1}. ${track.title}** — queued for IPFS archiving`;
    });
    const more = tracks.length > 20 ? `\n\n…and ${tracks.length - 20} more upload(s).` : '';
    await interaction.reply({
      content:
        `🎸 **Your unminted track backlog**\n\n${lines.join('\n')}${more}\n\n` +
        'For a ready track, use `/jukebox request-mint track_id:<id> wallet:<your Base wallet>`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub !== 'play') return;

  const cid = interaction.options.getString('cid', true).trim();

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const tracks = await fetchTrackList(cid, config.ipfsGateway);
    if (tracks.length === 0) {
      await interaction.editReply(NO_TRACKS_MSG);
      return;
    }

    // Build a numbered playlist with clickable stream links
    const listLines = tracks.map((url, i) => {
      const filename = url.split('/').pop();
      const name     = filename ? decodeURIComponent(filename) : `Track ${i + 1}`;
      return `**${i + 1}.** [${name}](${url})`;
    });

    // Chunk into blocks ≤ MAX_EMBED_CHUNK_SIZE chars to stay within Discord's embed limit
    const chunks = [];
    let current  = '';
    for (const line of listLines) {
      const next = current ? `${current}\n${line}` : line;
      if (next.length > MAX_EMBED_CHUNK_SIZE) {
        chunks.push(current);
        current = line;
      } else {
        current = next;
      }
    }
    if (current) chunks.push(current);

    const buildEmbed = (description, isFirst) => {
      const embed = new EmbedBuilder().setColor(0x9b59b6).setDescription(description);
      if (isFirst) {
        embed
          .setTitle('🎧 Your Personal IPFS Playlist')
          .setFooter({ text: `CID: ${cid} · DecentBusking Jukebox` })
          .setTimestamp(new Date());
      }
      return embed;
    };

    // Try to DM the user; fall back to ephemeral channel replies if DMs are closed
    try {
      await interaction.user.send({ embeds: [buildEmbed(chunks[0], true)] });
      for (const chunk of chunks.slice(1)) {
        await interaction.user.send({ embeds: [buildEmbed(chunk, false)] });
      }
      await interaction.editReply('📬 Your private playlist has been sent to your DMs!');
    } catch {
      // DMs disabled — reply ephemerally in the channel
      await interaction.editReply({ embeds: [buildEmbed(chunks[0], true)] });
      for (const chunk of chunks.slice(1)) {
        await interaction.followUp({ embeds: [buildEmbed(chunk, false)], flags: MessageFlags.Ephemeral });
      }
    }
  } catch (err) {
    console.error('[jukebox] Error fetching playlist:', err);
    await interaction.editReply(`❌ Failed to fetch playlist: ${err.message}`);
  }
}

// ── Per-attachment handler ────────────────────────────────────────────────────

async function handleDevertLoopSubmission(message, config, profiles, { submissionKey = '', linked: linkedOverride = null } = {}) {
  const linked = linkedOverride || profiles?.getByDiscordId(message.author.id);
  if (!linked) {
    const components = buildWalletButtons({ linkUrl: config.siteUrl, key: submissionKey }).filter(row => row.components.length);
    await message.reply({
      content: 'Link your wallet first.',
      components,
      allowedMentions: { parse: [] },
    }).catch(() => {});
    return { awaitingLink: true };
  }

  let title = '';
  let ipfsCid = '';
  let mediaType = '';
  let filename = '';
  const attachment = [...message.attachments.values()].find(isAudioAttachment);
  if (attachment) {
    title = getAttachmentTitle(attachment);
    filename = attachment.name || 'ad.mp4';
    mediaType = mediaTypeFor(filename, attachment.contentType);
    if (!isDiscordAttachmentWithinLimit(attachment)) {
      await message.reply(`This attachment is ${(attachment.size / 1024 / 1024).toFixed(1)} MB. Upload it in the DVert panel, then post !devert-ad ${title} | ipfs://CID | ${mediaType}.`).catch(() => {});
      return;
    }
    try {
      const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} downloading attachment`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const uri = await uploadToIPFS(bytes, filename, mediaType || 'audio/mpeg', {
        provider: config.ipfsUploadProvider, pinataJwt: config.pinataJwt, pinataApiUrl: config.pinataApiUrl,
        ipfsApiUrl: config.ipfsApiUrl,
      });
      ipfsCid = normalizeMediaCid(uri);
    } catch (error) {
      await message.reply(`Ad upload failed: ${error.message}`).catch(() => {});
      return;
    }
  } else {
    const match = message.content.match(/^!devert-ad\s+([^|]{1,120})\s*\|\s*(ipfs:\/\/\S+)\s*\|\s*(audio\/[a-z0-9.+-]+|video\/mp4)\s*$/i);
    if (!match) {
      await message.reply('Submit `!devert-ad Title | ipfs://CID | video/mp4` after uploading large media through the DVert panel.').catch(() => {});
      return;
    }
    title = match[1].trim();
    mediaType = match[3].toLowerCase();
    if (!Object.values(MEDIA_TYPES).includes(mediaType)) {
      await message.reply('Use a supported audio media type or `video/mp4`.').catch(() => {});
      return;
    }
    filename = `${title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80) || 'devert-ad'}.${mediaType === 'video/mp4' ? 'mp4' : 'audio'}`;
    try { ipfsCid = normalizeMediaCid(match[2]); }
    catch (error) { await message.reply(error.message).catch(() => {}); return; }
  }

  const address = linked.address;
  const track = submitMediaTrack({ address, title, artist: linked.displayName || message.author.globalName || message.author.username,
    ipfsCid, mediaType, filename, recipient: address, isDevertAd: true });
  await waitForRemotePersistence();
  await message.reply(`Ad media added to the owner NFT mint queue: **${track.title}** · ${track.trackId} · ipfs://${track.ipfsCid}`).catch(() => {});
  return { queued: track };
}

/**
 * Download an audio attachment, pin it to IPFS, and reply with the mint embed.
 *
 * @param {import('discord.js').Message}    message
 * @param {import('discord.js').Attachment} attachment
 * @param {ReturnType<typeof loadConfig>}   config
 */
async function handleAudioAttachment(message, attachment, config, trackId) {
  const filename = attachment.name || 'track.mp3';
  const mimeType = mediaTypeFor(filename, attachment.contentType) || 'audio/mpeg';
  const title = getAttachmentTitle(attachment);

  const uploaderTag = message.author.tag || message.author.username || 'Unknown User';

  console.log(`[jukebox-bot] Audio detected: "${filename}" from ${uploaderTag}`);

  // Acknowledge immediately so the user knows something is happening
  let workingMsg;
  try {
    workingMsg = await message.reply(`⏳ Pinning **${title}** to IPFS…`);
  } catch (err) {
    console.error('[jukebox-bot] Could not send acknowledgement:', err.message);
  }

  try {
    // 1. Guard against oversized files before downloading
    if (attachment.size > MAX_FILE_BYTES) {
      throw new Error(
        `File is too large (${(attachment.size / 1024 / 1024).toFixed(1)} MB). ` +
        `Maximum Discord attachment size is 10 MB. Use /jukebox submit with the file CID, or upload through DecentBusking instead.`
      );
    }

    // 2. Download the file
    const response = await fetch(attachment.url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} downloading attachment`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    console.log(`[jukebox-bot] Downloaded ${buffer.length} bytes for "${filename}"`);

    // 2. Upload to IPFS
    const ipfsUri = await uploadToIPFS(
      buffer,
      filename,
      mimeType,
      {
        provider: config.ipfsUploadProvider,
        pinataJwt: config.pinataJwt,
        pinataApiUrl: config.pinataApiUrl,
        ipfsApiUrl: config.ipfsApiUrl,
      },
    );
    // ipfsUri is "ipfs://<CID>"
    const ipfsCid = ipfsUri.replace('ipfs://', '');
    console.log(`[jukebox-bot] Pinned to IPFS: ${ipfsCid}`);
    updateTrackPin(trackId, { status: 'pinned', ipfsCid });

    // 3. Reply with the track ID used by the private owner-approval queue
    const embed = buildMintEmbed({ title, ipfsCid, trackId, uploaderTag });
    await message.reply({ embeds: [embed], components: buildMintRequestComponents(trackId) });

    // 4. Clean up the working message
    if (workingMsg) await workingMsg.delete().catch(() => {});

  } catch (err) {
    console.error(`[jukebox-bot] Error processing "${filename}":`, err);
    updateTrackPin(trackId, { status: 'failed', error: err.message });
    const errText = `❌ Failed to pin **${title}** to IPFS: ${err.message}`;
    try {
      if (workingMsg) {
        await workingMsg.edit(errText);
      } else {
        await message.reply(errText);
      }
    } catch (_) {}
  }
}

// ── URL builder ───────────────────────────────────────────────────────────────

/**
 * Build the DecentBusking pre-filled mint URL.
 *
 * @param {string} siteUrl  - e.g. "https://thejollylama.github.io/DecentBusking"
 * @param {string} title    - Track title
 * @param {string} ipfsCid  - Raw CID (no ipfs:// prefix)
 * @param {string} [artist] - Discord uploader tag (optional)
 * @returns {string}
 */
export function buildMintUrl(siteUrl, title, ipfsCid, artist, workerUrl, trackId) {
  const params = new URLSearchParams({ title, ipfs: ipfsCid });
  if (artist) params.set('recipient', artist);
  if (workerUrl) params.set('worker', workerUrl);
  if (trackId) params.set('track', trackId);
  return `${siteUrl}/?${params.toString()}`;
}

async function announceCompletedMint(client, config, track) {
  const txUrl = `${config.blockExplorerUrl}/tx/${track.mintTxHash}`;
  const archiveUrl = `${config.siteUrl}/`;
  const embed = new EmbedBuilder()
    .setColor(0xf0c040)
    .setTitle(`🎉 New DecentNFT minted: ${track.title}`)
    .setDescription(
      `${track.source === 'site' ? 'An artist' : `<@${track.uploaderId}>`}'s track is now live on Base and in the DecentBusking archive.\n` +
      `[Open DecentBusking](${archiveUrl}) · [View transaction](${txUrl})`,
    )
    .addFields(
      { name: 'Token', value: `#${track.tokenId}`, inline: true },
      { name: 'Artist wallet', value: `\`${track.mintRecipient}\``, inline: false },
    )
    .setTimestamp();

  const channelIds = new Set([config.jukeboxChannelId, config.jukeLoopTextChannelId].filter(Boolean));
  const results = await Promise.all([...channelIds].map(async (channelId) => {
    const channel = await client?.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) return false;
    return channel.send({ embeds: [embed] }).then(() => true).catch(() => false);
  }));
  if (!results.some(Boolean)) throw new Error('Mint verified, but no public Discord channel accepted the announcement');
}

// ── JukeLoop startup helper ───────────────────────────────────────────────────

/**
 * Start the website broadcast before attaching any Discord outputs.
 *
 * @param {import('discord.js').Client} client
 * @param {ReturnType<typeof loadConfig>} config
 */
async function startWebsiteRadio(client, config) {
  clearScheduledJukeLoopRestart(config);
  const existing = getActiveJukeLoopSession();
  if (existing && !existing._destroyed) return existing;
  try {
    await discoverDedicatedGateway(config);
    const session = createJukeLoopSession('website-radio', {
      websitePlayback: true,
      client: config.getDiscordClient?.() || client,
      ipfsGateway: config.ipfsGateway,
      djuke: _radioPaidQueues,
      livePerformanceEvents,
      schedule: defaultRadioSchedule(liveWeeklySchedule),
      devertPlayback: _devertPlaybackRuntime,
      mainRadioAdStateStore: config.jukeLoopMainRadioAdStore,
      topTenHypeStore: config.topTenHypeStore,
      playlistShowStore: config.playlistShowStore,
      onTerminalDisconnect: () => scheduleJukeLoopRestart(session.client, config, 'Website playback stalled'),
    });
    await session.start();
    session.client = config.getDiscordClient?.() || client;
    _jukeLoopRestartAttempts.delete(config.jukeLoopTextChannelId);
    console.log('[jukeloop] Website broadcast started independently of Discord.');
    if (session.client?.isReady()) void startJukeLoop(session.client, config);
    return session;
  } catch (error) {
    getJukeLoopSession('website-radio')?.destroy();
    console.error('[jukeloop] Website startup failed:', error.message);
    scheduleJukeLoopRestart(client, config, 'Website startup failed');
    return null;
  }
}

async function startJukeLoop(client, config) {
  const broadcast = getActiveJukeLoopSession();
  if (broadcast?.websitePlayback) {
    if (broadcast._discordOutputsAttached) return true;
    broadcast._discordOutputsAttached = true;
    try {
      const textChannel = await client.channels.fetch(config.jukeLoopTextChannelId);
      if (broadcast._destroyed || getActiveJukeLoopSession() !== broadcast) return false;
      if (!textChannel?.isTextBased()) throw new Error('Radio announcement channel is not a text channel');
      const permissions = textChannel.permissionsFor?.(client.user);
      if (permissions && !permissions.has(['ViewChannel', 'SendMessages'])) {
        throw Object.assign(new Error('Radio text channel requires ViewChannel and SendMessages permissions'), { code: 50013 });
      }
      broadcast.textChannel = textChannel;
      if (broadcast._nowPlaying && !broadcast._nowPlaying.hype) {
        const track = broadcast._currentTrack;
        void broadcast._announcePrepared({
          track, devertAd: broadcast._currentDevertAd, paid: broadcast._currentPaid,
          playlistShow: broadcast._nowPlaying.playlistShow,
          url: track.ipfsCid ? buildIpfsGatewayUrl(config.ipfsGateway, track.ipfsCid) : '',
        }, broadcast._nowPlaying.playId)
          .catch(error => console.warn('[jukeloop] Current-track announcement deferred:', error.message));
      }
      if (config.jukeLoopVoiceChannelId && config.jukeLoopVoiceEnabled && !broadcast._voiceConnection) {
        const voiceChannel = await client.channels.fetch(config.jukeLoopVoiceChannelId);
        if (broadcast._destroyed || getActiveJukeLoopSession() !== broadcast) return false;
        if (!voiceChannel) throw new Error('Optional radio voice channel was not found');
        broadcast.voiceChannel = voiceChannel;
        void broadcast.connect().catch(error => console.warn('[jukeloop] Optional voice unavailable:', error.message));
      }
      (async () => {
        const jukeboxCh = await client.channels.fetch(config.jukeboxChannelId);
        if (jukeboxCh) await backfillFromChannel(jukeboxCh);
        await runIpfsBackfill(client, config);
        const count = await reconcileJukeLoopHistory(textChannel, client.user.id);
        console.log(`[jukeloop] Reconciled ${count} historical playback announcement(s).`);
      })().catch(error => console.warn('[jukeloop] Startup history reconciliation deferred:', error.message));
      console.log('[jukeloop] Discord outputs attached; website playback was not restarted.');
    } catch (error) {
      broadcast._discordOutputsAttached = false;
      broadcast._discordOutputsBlocked = error.status === 403 || [50001, 50013].includes(error.code);
      console.warn('[jukeloop] Discord outputs unavailable; website playback continues:', error.message);
    }
    return true;
  }
  return false;
}

// ── /jukeloop command handler ─────────────────────────────────────────────────

/**
 * Handle all `/jukeloop` subcommands.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {ReturnType<typeof loadConfig>} config
 */
async function handleJukeLoopCommand(interaction, config, { reconcileMint }) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'live-list') {
    if (!liveScheduleReady) {
      await interaction.reply({ content: '⚠️ The live calendar is unavailable because its durable schedule could not be restored.', flags: MessageFlags.Ephemeral });
      return;
    }
    const upcoming = livePerformanceEvents.filter(event => Date.parse(event.endUtc) > Date.now()).slice(0, 10);
    const lines = upcoming.map(event => {
      const start = new Date(event.startUtc).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
      const end = new Date(event.endUtc).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
      return `• **${event.title}** · ${start} to ${end} · ID ${event.id}`;
    });
    const more = livePerformanceEvents.filter(event => Date.parse(event.endUtc) > Date.now()).length > upcoming.length;
    await interaction.reply({
      content: lines.length ? `📅 **Live performance calendar**\n${lines.join('\n')}${more ? '\n…and more' : ''}` : '📅 No active or upcoming live performance blocks.',
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (sub === 'live-add' || sub === 'live-cancel') {
    if (!interaction.memberPermissions?.has('ManageMessages')) {
      await interaction.reply({ content: '🔒 You need **Manage Messages** to change the live calendar.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (!liveScheduleReady || !liveScheduleStore) {
      await interaction.reply({ content: '⚠️ The live calendar is read-only because durable Pinata scheduling is unavailable.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      let nextEvents;
      if (sub === 'live-add') {
        const title = interaction.options.getString('title', true).trim();
        const startUtc = interaction.options.getString('start_utc', true).trim();
        const endUtc = interaction.options.getString('end_utc', true).trim();
        nextEvents = upsertLivePerformanceEvent(livePerformanceEvents, {
          id: interaction.id,
          title,
          startUtc,
          endUtc,
        });
        await liveScheduleStore.save({ events: nextEvents, weeklySchedule: liveWeeklySchedule });
        livePerformanceEvents = nextEvents;
        updateJukeLoopRadioSchedule({ events: nextEvents, schedule: defaultRadioSchedule(liveWeeklySchedule) });
        await interaction.editReply(`✅ Scheduled **${title}** from ${new Date(startUtc).toISOString()} to ${new Date(endUtc).toISOString()} UTC. Event ID: \`${interaction.id}\`.`);
      } else {
        const eventId = interaction.options.getString('event_id', true).trim();
        if (!livePerformanceEvents.some(event => event.id === eventId)) throw new Error('No live event has that ID');
        nextEvents = removeLivePerformanceEvent(livePerformanceEvents, eventId);
        await liveScheduleStore.save({ events: nextEvents, weeklySchedule: liveWeeklySchedule });
        livePerformanceEvents = nextEvents;
        updateJukeLoopRadioSchedule({ events: nextEvents, schedule: defaultRadioSchedule(liveWeeklySchedule) });
        await interaction.editReply(`✅ Cancelled live performance event \`${eventId}\`.`);
      }
    } catch (error) {
      await interaction.editReply(`❌ ${error.message}`);
    }
    return;
  }

  if (sub === 'restart') {
    if (!interaction.memberPermissions?.has('ManageMessages')) {
      await interaction.reply({
        content: '🔒 You need **Manage Messages** to restart JukeLoop.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      clearScheduledJukeLoopRestart(config);
      _jukeLoopRestartAttempts.delete(config.jukeLoopTextChannelId);
      getActiveJukeLoopSession()?.destroy();
      const restarted = await startWebsiteRadio(interaction.client, config);
      await interaction.editReply(
        restarted
          ? '✅ Website radio restarted. Discord outputs reconnect independently.'
          : '❌ Website radio could not restart. Check the Render playback logs.',
      );
    } catch (err) {
      await interaction.editReply(`❌ JukeLoop restart failed: ${err.message}`);
    }
    return;
  }

  if (sub === 'mint-queue' || sub === 'mark-minted' || sub === 'queue-uploads') {
    if (!interaction.memberPermissions?.has('ManageMessages')) {
      await interaction.reply({ content: '🔒 You need **Manage Messages** to manage mint requests.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === 'queue-uploads') {
      const uploader = interaction.options.getUser('uploader', true);
      const wallet = interaction.options.getString('wallet', true).trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
        await interaction.reply({ content: '❌ Enter a valid `0x` Base wallet address.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const artworkCid = await pinDiscordAvatar(uploader, config);
      const { queued, skipped } = queueUploaderMints(uploader.id, wallet, { artworkCid });
      await interaction.editReply({
        content: queued.length
          ? `✅ Queued **${queued.length}** upload${queued.length === 1 ? '' : 's'} by ${uploader} for minting to \`${wallet}\`, oldest first.\n` +
            (artworkCid ? `Default artwork: ${uploader}’s Discord avatar (pinned to IPFS).\n` : '') +
            (skipped ? `${skipped} more aren’t on IPFS yet and will need queueing again after they’re archived.\n` : '') +
            'Click through them in the DecentBusking Admin panel or `/jukeloop mint-queue`.'
          : `ℹ️ No archived, unminted uploads by ${uploader} to queue` +
            (skipped ? ` (${skipped} still waiting for IPFS archiving).` : '.'),
      });
      return;
    }

    if (sub === 'mark-minted') {
      const trackId = interaction.options.getString('track_id', true).trim();
      const tokenId = interaction.options.getString('token_id', true).trim();
      const txHash = interaction.options.getString('tx_hash', true).trim();
      if (!/^\d+$/.test(tokenId) || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        await interaction.reply({ content: '❌ Enter a numeric token ID and a full transaction hash.', flags: MessageFlags.Ephemeral });
        return;
      }
      try {
        const track = await reconcileMint({ trackId, tokenId, txHash });
        await interaction.reply({
          content: `✅ Verified and announced **${track.title}** as DecentNFT #${tokenId}.`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        await interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    const requests = getMintRequests();
    if (requests.length === 0) {
      await interaction.reply({ content: '✅ The owner-wallet mint queue is empty.', flags: MessageFlags.Ephemeral });
      return;
    }
    const footer = 'Open a link, connect the contract owner wallet, and confirm both Base transactions. ' +
      'Completion is verified and announced automatically. The DecentBusking Admin panel lists every request.';
    const lines = [];
    let length = footer.length + 120;
    for (const [index, track] of requests.entries()) {
      const approvalUrl = buildMintUrl(
        config.siteUrl,
        track.title,
        track.ipfsCid,
        track.mintRecipient,
        config.publicWorkerUrl,
        track.trackId,
      );
      const line =
        `**${index + 1}. ${track.title}** by ${track.uploader}\n` +
        `Track: \`${track.trackId}\` · Recipient: \`${track.mintRecipient}\` · [mint with owner wallet](${approvalUrl})`;
      if (lines.length && length + line.length + 2 > 2000) break;
      lines.push(line);
      length += line.length + 2;
    }
    const shown = lines.length < requests.length ? `, showing the oldest ${lines.length}` : '';
    await interaction.reply({
      content:
        `🔑 **Owner-wallet mint queue** (${requests.length} pending${shown})\n\n${lines.join('\n\n')}\n\n${footer}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === 'stats') {
    const top = getTopTracks(10);
    if (top.length === 0) {
      await interaction.reply({ content: '📭 The JukeLoop playlist is empty.', flags: MessageFlags.Ephemeral });
      return;
    }

    const lines = top.map((t, i) => {
      const score  = (t.likes - t.dislikes * 0.5).toFixed(1);
      const rating = `👍 ${t.likes}  👎 ${t.dislikes}  ▶️ ${t.plays}`;
      return `**${i + 1}.** ${t.title} — *${t.uploader}*\n  ${rating}  (score: ${score})`;
    });

    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle('📊 JukeLoop — Top Tracks')
      .setDescription(lines.join('\n\n'))
      .setFooter({ text: `${getPlaylist().length} track(s) total · DecentBusking JukeLoop` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === 'remove') {
    // Admin-only: requires ManageMessages permission
    if (!interaction.memberPermissions?.has('ManageMessages')) {
      await interaction.reply({
        content: '🔒 You need the **Manage Messages** permission to remove JukeLoop tracks.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const query   = interaction.options.getString('title', true).toLowerCase();
    const matches = getPlaylist().filter((t) => t.title.toLowerCase().includes(query));

    if (matches.length === 0) {
      await interaction.reply({
        content: `❌ No JukeLoop tracks found matching **"${query}"**.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (matches.length > 1) {
      const list = matches.slice(0, 5).map((t) => `• **${t.title}** by ${t.uploader}`).join('\n');
      await interaction.reply({
        content: `⚠️ Multiple tracks match **"${query}"** — please be more specific:\n${list}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const removed = removeTrack(matches[0].trackId);
    if (removed) {
      await interaction.reply({
        content: `🗑️ Removed **${removed.title}** by *${removed.uploader}* from the JukeLoop playlist.`,
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.reply({ content: '❌ Track could not be removed.', flags: MessageFlags.Ephemeral });
    }
    return;
  }
}

main().catch((err) => {
  console.error('[jukebox-bot] Fatal error:', err);
  process.exit(1);
});
