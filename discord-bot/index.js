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

import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  Partials,
} from 'discord.js';

import http from 'http'; 
import fs from 'node:fs';
import { Contract, JsonRpcProvider, Wallet, id } from 'ethers';
import { createPaymentLedger, verifyRepositoryPayment } from './payment-ledger.js';
import { createWeeklyPayflow } from './weekly-payflow.js';
import { payrollPeriodFromKey, PAYROLL_TIME_ZONE } from '../js/payroll-week.mjs';

import { loadConfig }    from './config.js';
import { uploadToIPFS, createIpfsUploader }  from './ipfs.js';
import { backfillIpfsPins } from './ipfs-backfill.js';
import { syncMintedTracksFromChain, createVerifiedMintQueueReader } from './mint-sync.js';
import { createDjukeQueueReader, createDjukePlaybackJournal, createDjukeRuntime, createDjukeFulfiller, createDjukeSongRegistrar, DJUKE_ABI } from './djuke.js';
import { createDevertCampaignReader } from './devert.js';
import { createPinataStateStore } from './ipfs-state.js';
import { resolveAlbumArtist, checkpointReviewedAlbumImport } from './album-import.js';
import { createCheckpointMirror } from './checkpoint-mirror.js';
import { buildCommunityPinManifest } from '../js/pinner-rewards.mjs';
import { createMintTransactionVerifier, createWorkerRequestHandler } from './ipfs-worker.js';
import { buildMintEmbed, buildMintRequestComponents } from './embed.js';
import { createMintRequestInteractionHandler, ensureDefaultMintArtwork } from './mint-interactions.js';
import { mediaTypeFor, normalizeMediaCid, MEDIA_TYPES, DISCORD_UPLOAD_MAX_BYTES, isDiscordAttachmentWithinLimit } from './media.js';
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
  queueUploaderMints,
  getTopTracks,
  removeTrack,
  requestTrackMint,
  completeTrackMint,
  updateTrackPin,
  getWeeklyPlayHistory,
  getWeeklyPlayReport,
  getWeeklyPlayWeeks,
  getUtcWeekKey,
} from './playlist-store.js';
import { buildWeeklyPlayReportMessage } from './weekly-play-report.js';
import {
  createJukeLoopSession,
  getJukeLoopSession,
  getJukeLoopNowPlaying,
  updateJukeLoopRadioSchedule,
  submitJukeLoopVote,
  buildRadioState,
  getVoiceRetryDelay,
  reconcileJukeLoopHistory,
  backfillFromChannel,
  getAttachmentTitle,
  synchronizeDiscordRating,
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
let liveScheduleStore = null;
let livePerformanceEvents = [];
let liveWeeklySchedule = {};
let liveScheduleReady = false;
let _mintSyncTask = null;
const IPFS_BACKFILL_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STATE_RESTORE_ATTEMPTS = 3;
const WEEKLY_REPORT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

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

function syncMintedTracks(config, { required = false } = {}) {
  if (!_mintSyncTask) {
    _mintSyncTask = syncMintedTracksFromChain({
      rpcUrl: config.baseRpcUrl,
      contractAddress: config.nftContractAddress,
      contractAddresses: config.nftContractAddresses,
    }).finally(() => { _mintSyncTask = null; });
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
      await channel?.send(
        `📌 Archived **${pinned}** past #DecentJukebox upload${pinned === 1 ? '' : 's'} to IPFS — ` +
        `${pinned === 1 ? 'it' : 'they'} can now stream on DecentBusking.` +
        (remaining ? ` ${remaining} upload${remaining === 1 ? '' : 's'} couldn’t be archived yet; retrying later.` : ''),
      ).catch(() => {});
    })
    .catch((err) => console.error('[ipfs-backfill] Run failed:', err.message));
}

function clearScheduledJukeLoopRestart(config) {
  const key = config.jukeLoopVoiceChannelId;
  const timer = _jukeLoopRestartTimers.get(key);
  if (timer) clearTimeout(timer);
  _jukeLoopRestartTimers.delete(key);
}

function scheduleJukeLoopRestart(client, config, reason) {
  const key = config.jukeLoopVoiceChannelId;
  if (!key || _jukeLoopRestartTimers.has(key)) return;
  const attempt = (_jukeLoopRestartAttempts.get(key) || 0) + 1;
  _jukeLoopRestartAttempts.set(key, attempt);
  const delayMs = getVoiceRetryDelay(attempt);
  console.warn(`[jukeloop] ${reason}; retrying voice connection in ${Math.round(delayMs / 1000)}s.`);
  const timer = setTimeout(() => {
    _jukeLoopRestartTimers.delete(key);
    startJukeLoop(client, config).catch((error) =>
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
  const checkpointMirror = process.env.CHECKPOINT_MIRROR_SECRET
    ? createCheckpointMirror({ secret: process.env.CHECKPOINT_MIRROR_SECRET }) : null;
  let readDevertState;
  if (process.env.DEVERT_CONTRACT_ADDRESS) {
    try {
      readDevertState = createDevertCampaignReader({
        rpcUrl: config.baseRpcUrl,
        contractAddress: process.env.DEVERT_CONTRACT_ADDRESS,
        confirmations: Number(process.env.DEVERT_CONFIRMATIONS || 2),
      });
    } catch (error) {
      console.warn('[devert] Read-only campaign endpoint disabled:', error.message);
    }
  }

  let client;
  let playlistReady = false;
  let playlistStateStore = null;
  const getVerifiedMintRequests = createVerifiedMintQueueReader({
    reconcile: async () => {
      if (!playlistReady) throw new Error('Playlist is restoring; please retry shortly');
      await syncMintedTracks(config, { required: true });
    },
    getRequests: getMintRequests,
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
  const verifyMintTransaction = createMintTransactionVerifier({
    rpcUrl: config.baseRpcUrl,
    contractAddress: config.nftContractAddress,
    ownerWallet: config.mintOwnerWallet,
  });
  const reconcileMint = async ({ trackId, tokenId, txHash }) => {
    const pendingTrack = getPlaylist().find((track) => track.trackId === trackId && track.mintStatus === 'requested');
    if (!pendingTrack) throw new Error('No pending mint request has that track ID');
    const verified = await verifyMintTransaction({ tokenId, txHash });
    if (verified.recipient.toLowerCase() !== pendingTrack.mintRecipient.toLowerCase()) {
      throw new Error('Mint recipient does not match the requested artist wallet');
    }
    await announceCompletedMint(client, config, {
      ...pendingTrack,
      tokenId: String(tokenId),
      mintTxHash: txHash,
    });
    const completedTrack = completeTrackMint(trackId, { tokenId, txHash, contractAddress: config.nftContractAddress });
    if (!completedTrack) throw new Error('Mint request could not be reconciled');
    return completedTrack;
  };

  const payrollAssets = JSON.parse(fs.readFileSync(new URL('../payroll-assets.json', import.meta.url), 'utf8'));
  const paymentStore = config.pinataJwt ? createPinataStateStore({ pinataJwt: config.pinataJwt,
    uploadUrl: config.pinataApiUrl, filesApiUrl: config.pinataFilesApiUrl, gateway: config.ipfsGateway,
    name: 'decentbusking-payment-ledger.json', tags: { app: 'decentbusking', kind: 'payment-ledger', schema: '1' },
    retainSnapshots: Infinity, serialize: value => value, deserialize: (value, uri) => ({ ...value, snapshotUri: uri }) }) : null;
  const paymentProvider = new JsonRpcProvider(payrollAssets.rpcUrl);
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
  setInterval(comparePayments, 15_000).unref();

  const payflowStore = config.pinataJwt ? createPinataStateStore({ pinataJwt: config.pinataJwt,
    uploadUrl: config.pinataApiUrl, filesApiUrl: config.pinataFilesApiUrl, gateway: config.ipfsGateway,
    name: 'decentbusking-weekly-payflow.json', tags: { app: 'decentbusking', kind: 'weekly-payflow', schema: '1' },
    retainSnapshots: Infinity, serialize: value => value, deserialize: value => value }) : null;
  const payflowRouter = new Contract(payrollAssets.routerAddress, [
    'function funds(bytes32) view returns(string metadataUri,bool active,bool exists)',
    'function fundBalances(bytes32,address) view returns(uint256)',
    'function approvedAssets(address) view returns(bool)',
    'function completedWorkReferences(bytes32) view returns(bool)',
  ], paymentProvider);
  const closingBlocks = new Map();
  const getClosingBalance = async ({ report, fundSlug, allocations }) => {
    if (!closingBlocks.has(report.week)) {
      const end = Date.parse(payrollPeriodFromKey(report.week).endAt) / 1000;
      let low = 0; let high = await paymentProvider.getBlockNumber();
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const block = await paymentProvider.getBlock(middle);
        if (!block) throw new Error('Closing block could not be verified');
        if (Number(block.timestamp) < end) low = middle; else high = middle - 1;
      }
      closingBlocks.set(report.week, low);
    }
    const blockTag = closingBlocks.get(report.week);
    if (await paymentProvider.getCode(payrollAssets.routerAddress, blockTag) === '0x') return 0n;
    const balance = await payflowRouter.fundBalances(id(fundSlug), payrollAssets.assets.USDC.address, { blockTag });
    let reserved = 0n;
    for (const record of allocations) for (const entry of record.allocation.entries) {
      if (!await payflowRouter.completedWorkReferences(id(entry.workReferenceText), { blockTag })) reserved += BigInt(entry.amountUnits);
    }
    return balance > reserved ? balance - reserved : 0n;
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
  setInterval(refreshPayflow, 15_000).unref();

  const djukeAddress = process.env.DJUKE_CONTRACT_ADDRESS;
  const readDjukeState = djukeAddress ? createDjukeQueueReader({
    rpcUrl: config.baseRpcUrl, contractAddress: djukeAddress,
    paymentsEnabled: process.env.DJUKE_PAYMENTS_ENABLED === 'true',
    getPlaylist: () => {
      if (!playlistReady) throw new Error('DJuke catalog is restoring');
      return getPlaylist();
    },
  }) : undefined;
  if (readDjukeState && process.env.DJUKE_FULFILLER_PRIVATE_KEY) {
    const worker = new Wallet(process.env.DJUKE_FULFILLER_PRIVATE_KEY, new JsonRpcProvider(config.baseRpcUrl));
    const registerSongs = createDjukeSongRegistrar({ contract: new Contract(djukeAddress, DJUKE_ABI, worker),
      getPlaylist: () => (playlistReady ? getPlaylist() : []), onRegistered: songIds => readDjukeState.invalidate(songIds) });
    const runRegistrar = () => registerSongs().catch(error => console.warn('[djuke] Song registration deferred:', error.shortMessage || error.message));
    setTimeout(runRegistrar, 30_000).unref();
    setInterval(runRegistrar, 120_000).unref();
  }
  if (readDjukeState && process.env.DJUKE_FULFILLER_PRIVATE_KEY && checkpointMirror && config.pinataJwt) {
    const fulfiller = new Wallet(process.env.DJUKE_FULFILLER_PRIVATE_KEY, new JsonRpcProvider(config.baseRpcUrl));
    const journalStore = createPinataStateStore({ pinataJwt: config.pinataJwt, uploadUrl: config.pinataApiUrl,
      filesApiUrl: config.pinataFilesApiUrl, gateway: config.ipfsGateway, name: 'decentbusking-djuke-journal.json',
      tags: { app: 'decentbusking', kind: 'djuke-journal', schema: '1' }, serialize: value => value,
      deserialize: value => value, beforeUpload: bytes => checkpointMirror.mirror(bytes) });
    _djukeRuntime = createDjukeRuntime({
      readState: readDjukeState,
      journal: createDjukePlaybackJournal(journalStore),
      fulfill: createDjukeFulfiller(new Contract(djukeAddress, DJUKE_ABI, fulfiller)),
      getTrack: trackId => getPlaylist().find(track => track.trackId === trackId) || null,
    });
    console.log(`[djuke] Paid queue enabled; fulfiller ${fulfiller.address}.`);
  } else if (readDjukeState) {
    console.warn('[djuke] Queue is read-only: DJUKE_FULFILLER_PRIVATE_KEY, CHECKPOINT_MIRROR_SECRET and PINATA_JWT are all required for paid playback.');
  }

  const requestHandler = createWorkerRequestHandler({
    checkpointMirror,
    getDjukeState: readDjukeState,
    getRadioSchedule: () => ({
      timeZone: PAYROLL_TIME_ZONE,
      schedule: defaultRadioSchedule(liveWeeklySchedule),
      weeklySchedule: liveWeeklySchedule,
      events: livePerformanceEvents.filter(event => Date.parse(event.endUtc) > Date.now()),
      ready: liveScheduleReady,
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
    allowedOrigins: config.allowedOrigins,
    ownerWallet: config.mintOwnerWallet || '0x0000000000000000000000000000000000000000',
    pinataJwt: config.pinataJwt,
    pinataSignUrl: config.pinataSignUrl,
    verifyMintTransaction,
    onMintComplete: reconcileMint,
    onMediaSubmission: async (submission) => {
      if (!playlistReady) throw new Error('Playlist is restoring; please retry shortly');
      const track = submitMediaTrack(submission);
      await waitForRemotePersistence();
      return track;
    },
    getMintQueue: async () => (await ensureDefaultMintArtwork({ requests: await getVerifiedMintRequests(),
      getUser: userId => client?.users.fetch(userId).catch(() => null), getDefaultArtwork: user => pinDiscordAvatar(user, config),
      requestTrackMint, waitForPersistence: waitForRemotePersistence })).map((track) => ({
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
      requestedAt: track.mintRequestedAt,
    })),
    getRadioState: async () => ({ ...buildRadioState({
      nowPlaying: getJukeLoopNowPlaying(),
      playlist: getPlaylist(),
    }), paymentLedger: { endpoint: '/api/payroll/ledger', snapshotUri: paymentLedger.getState().snapshotUri,
      lastCheckedAt: paymentLedger.getState().lastCheckedAt, ready: paymentLedgerReady } }),
    getDevertState: readDevertState,
    getRadioHistory: async ({ weeks, wallet, includeAllTime, calendar }) => getWeeklyPlayHistory({ weeks, wallet, includeAllTime, calendar }),
    getWeeklyPayflow: ({ wallet }) => payflow.getState({ wallet }),
    getPaymentLedger: () => ({ ...paymentLedger.getState(), ready: paymentLedgerReady,
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
      pinataJwt: config.pinataJwt,
      uploadUrl: config.pinataApiUrl,
      filesApiUrl: config.pinataFilesApiUrl,
      gateway: config.ipfsGateway,
      beforeUpload: checkpointMirror ? bytes => checkpointMirror.mirror(bytes) : undefined,
    });
    playlistStateStore = stateStore;
    liveScheduleStore = createPinataStateStore({
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
    loadPlaylist(restoredPlaylist);
    configureRemotePersistence(stateStore.save);
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
  }
  playlistReady = true;
  refreshPayflow();
  syncMintedTracks(config);

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });

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
    console.log(`[jukebox-bot] Logged in as ${readyClient.user.tag}`);
    console.log(`[jukebox-bot] Watching channel ID: ${config.jukeboxChannelId}`);

    // Register global slash commands
    const rest = new REST({ version: '10' }).setToken(config.discordToken);
    try {
      await rest.put(Routes.applicationCommands(readyClient.user.id), { body: SLASH_COMMANDS });
      console.log('[jukebox-bot] Slash commands registered globally.');
    } catch (err) {
      console.error('[jukebox-bot] Failed to register slash commands:', err.message);
    }

    // ── JukeLoop startup ───────────────────────────────────────────────────────
    if (config.jukeLoopVoiceChannelId && config.jukeLoopTextChannelId) {
      await startJukeLoop(readyClient, config);
    } else {
      console.log(
        '[jukeloop] JUKE_LOOP_VOICE_CHANNEL_ID or JUKE_LOOP_TEXT_CHANNEL_ID not set — ' +
        'JukeLoop disabled.',
      );
    }
    setInterval(() => runIpfsBackfill(readyClient, config), IPFS_BACKFILL_INTERVAL_MS);
    runWeeklyPlayReport(readyClient, config).catch((err) => console.error('[weekly-play-report] Failed:', err.message));
    setInterval(() => runWeeklyPlayReport(readyClient, config).catch((err) => console.error('[weekly-play-report] Failed:', err.message)), WEEKLY_REPORT_CHECK_INTERVAL_MS);
  });

  client.on(Events.MessageCreate, async (message) => {
    // Ignore bots and messages outside the configured channel
    if (message.author.bot) return;
    if (message.channelId !== config.jukeboxChannelId) return;

    const audioAttachments = [...message.attachments.values()].filter(isAudioAttachment);
    if (!audioAttachments.length) return;

    for (const attachment of audioAttachments) {
      if (!isDiscordAttachmentWithinLimit(attachment)) {
        await message.reply('Discord media attachments must be no larger than 10 MB. Use /jukebox submit with a file CID, or upload through DecentBusking instead.').catch(() => {});
        continue;
      }
      const filename = attachment.name || 'track.mp3';
      const title    = getAttachmentTitle(attachment);
      const track = {
        attachmentId: attachment.id,
        messageId:  message.id,
        channelId:  message.channelId,
        filename,
        mediaType: mediaTypeFor(filename, attachment.contentType),
        title,
        uploader:   message.author.tag ?? message.author.username ?? 'Unknown',
        uploaderId: message.author.id,
        pinStatus:  config.disableMintFlow ? 'disabled' : 'pending',
      };
      const trackId = getTrackId(track);

      // Persist upload provenance even when voice playback is temporarily disabled.
      addTrack(track);

      // ── Existing IPFS / mint flow (opt-out with DISABLE_MINT_FLOW=true) ──────
      if (!config.disableMintFlow) {
        await handleAudioAttachment(message, attachment, config, trackId);
      }
    }
  });

  // ── Slash command interactions ───────────────────────────────────────────────
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (await handleMintRequestInteraction(interaction)) return;
    } catch (error) {
      console.error('[mint-request] Interaction failed:', error.message);
      if (interaction.isRepliable?.() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Could not open the NFT request. Please retry.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'radio') {
      await handleRadioCommand(interaction, config);
    } else if (interaction.commandName === 'jukebox') {
      await handleJukeboxCommand(interaction, config);
    } else if (interaction.commandName === 'jukeloop') {
      await handleJukeLoopCommand(interaction, config, { reconcileMint });
    }
  });

  await client.login(config.discordToken);

  const shutdown = async (signal) => {
    console.log(`[jukebox-bot] ${signal} received; flushing IPFS state checkpoint.`);
    await waitForRemotePersistence();
    client.destroy();
    process.exit(0);
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
 * Resolve JukeLoop channels, backfill historic tracks, and start the session.
 *
 * @param {import('discord.js').Client} client
 * @param {ReturnType<typeof loadConfig>} config
 */
async function startJukeLoop(client, config) {
  clearScheduledJukeLoopRestart(config);
  let guildId = null;
  try {
    const voiceChannel = await client.channels.fetch(config.jukeLoopVoiceChannelId).catch(() => null);
    const textChannel  = await client.channels.fetch(config.jukeLoopTextChannelId).catch(() => null);
    const jukeboxCh    = await client.channels.fetch(config.jukeboxChannelId).catch(() => null);

    if (!voiceChannel) {
      console.error('[jukeloop] Could not find voice channel:', config.jukeLoopVoiceChannelId);
      scheduleJukeLoopRestart(client, config, 'Voice channel lookup failed');
      return false;
    }
    if (!textChannel) {
      console.error('[jukeloop] Could not find text channel:', config.jukeLoopTextChannelId);
      scheduleJukeLoopRestart(client, config, 'Text channel lookup failed');
      return false;
    }
    guildId = voiceChannel.guild.id;

    // Backfill all historic uploads from #DecentJukebox
    if (jukeboxCh) {
      await backfillFromChannel(jukeboxCh);
      runIpfsBackfill(client, config);
    } else {
      console.warn('[jukeloop] Could not access #DecentJukebox for backfill:', config.jukeboxChannelId);
    }

    const recoveredRatings = await reconcileJukeLoopHistory(textChannel, client.user.id);
    if (recoveredRatings > 0) {
      console.log(`[jukeloop] Reconciled ${recoveredRatings} historical playback announcement(s).`);
    }

    const session = createJukeLoopSession(guildId, {
      voiceChannel,
      textChannel,
      client,
      ipfsGateway: config.ipfsGateway,
      djuke: _djukeRuntime,
      livePerformanceEvents,
      schedule: defaultRadioSchedule(liveWeeklySchedule),
      onTerminalDisconnect: () => {
        scheduleJukeLoopRestart(client, config, 'Voice reconnect timed out');
      },
    });

    await session.connect();
    console.log('[jukeloop] Connected to voice channel, starting playback…');
    await textChannel
      .send('📻 **JukeLoop is live!** The community radio is starting up — tracks from #DecentJukebox are on the way.')
      .catch(() => {});
    await session.start();
    _jukeLoopRestartAttempts.delete(config.jukeLoopVoiceChannelId);
    return true;
  } catch (err) {
    console.error('[jukeloop] Failed to start JukeLoop:', err.message);
    if (guildId) getJukeLoopSession(guildId)?.destroy();
    scheduleJukeLoopRestart(client, config, `Voice startup failed: ${err.message}`);
    return false;
  }
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
      _jukeLoopRestartAttempts.delete(config.jukeLoopVoiceChannelId);
      const restarted = await startJukeLoop(interaction.client, config);
      await interaction.editReply(
        restarted
          ? '✅ JukeLoop reconnected and restarted.'
          : '❌ JukeLoop could not reconnect. Check the configured voice/text channels and Render logs.',
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
