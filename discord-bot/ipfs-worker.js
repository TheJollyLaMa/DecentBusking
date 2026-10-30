import { liveAuthorization } from '../js/live-bookings.mjs';
import { AbiCoder, Contract, Interface, JsonRpcProvider, keccak256, toUtf8Bytes, verifyMessage, verifyTypedData } from 'ethers';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MEDIA_TYPES, mediaTypeFor, normalizeMediaCid, buildSubmissionAuthorizationMessage } from './media.js';
import { validateLivePerformanceSchedule, validateWeeklyScheduleOverrides, validateRadioProgrammingConflicts } from '../js/radio-schedule.mjs';
import { buildFundWeeklyArchive } from '../js/fund-archive.mjs';
import { catalogPage } from '../js/nft-loader.js';
import { uploadToIPFS } from './ipfs.js';
import { readRawBody } from './alchemy-webhook.js';
import { buildGatewayUrl, fetchMintMetadata } from './mint-sync.js';
import { buildArtworkUpdateAuthorizationMessage, buildArtworkUpdateMetadata } from '../js/artwork-update.mjs';
import { buildDevertRemovalMessage } from '../js/devert-campaigns.mjs';
import { buildRadioCalendar, radioCalendarOccurrences } from '../js/radio-calendar.mjs';
import { detectSubmissionMedia, mediaFilename, validateCreatorSplits } from '../js/submission-media.mjs';
import {
  buildAlbumSplitTypedData, buildAlbumTrackRemovalAuthorizationMessage, buildSongAlbumMigrationTypedData,
  buildSongSplitTypedData, validateCreatorSplitRows,
} from '../js/creator-splits.mjs';

const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
async function readMediaProbe(response) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(65536);
  let length = 0;
  try {
    while (length < bytes.length) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const count = Math.min(chunk.value.length, bytes.length - length);
      bytes.set(chunk.value.subarray(0, count), length);
      length += count;
    }
  } finally {
    await reader.cancel();
  }
  return bytes.subarray(0, length);
}

async function probeMediaGateways(cid, range, gateways, fetchImpl, deadline) {
  const failures = [];
  for (const gateway of gateways) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      failures.push('probe time budget exhausted');
      break;
    }
    const url = buildGatewayUrl(gateway, cid);
    const host = new URL(url).hostname;
    try {
      const response = await fetchImpl(url, {
        headers: { Range: range }, signal: AbortSignal.timeout(Math.min(8000, remaining)),
      });
      const bytes = await readMediaProbe(response);
      if (!bytes.length) throw new Error('empty response');
      return { bytes, type: response.headers.get('content-type')?.split(';')[0] };
    } catch (error) {
      const detail = /^HTTP \d+$|^empty response$/.test(error.message) ? error.message : 'network, timeout or stream error';
      failures.push(`${host}: ${detail}`);
      console.warn(`[ipfs] Media probe failed (${host}, ${range}): ${detail}`);
    }
  }
  throw new Error(`Could not read the IPFS file to detect its format. IPFS gateways are unavailable (${failures.join('; ')}). Retry shortly; you do not need to upload it again.`);
}

const SIGNED_UPLOAD_OVERHEAD_BYTES = 64 * 1024;
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;
const MAX_UPLOAD_SIGNATURE_AGE_MS = 15 * 60 * 1000;
const MINT_EVENT_ABI = [
  'event EditionMinted(uint256 indexed tokenId, address indexed to, uint256 amount, address indexed minter)',
];
const ARTWORK_EVENT_ABI = [
  'event URI(string value,uint256 indexed id)',
];
const NFT_ARTWORK_ABI = [
  'function uri(uint256 tokenId) view returns (string)',
  'function creatorOf(uint256 tokenId) view returns (address)',
  'function totalMinted(uint256 tokenId) view returns (uint256)',
];
const CREATOR_SPLIT_ABI = [
  'function getSong(bytes32) view returns ((string audioURI,bool enabled,address[] recipients,uint16[] sharesBps))',
  'function getAlbum(bytes32) view returns ((address mainOwner,string title,string manifestURI,uint256 revision,uint256 listenPrice,uint256 albumPrice,address[] recipients,uint16[] sharesBps,string[] positions,bytes32[] songIds))',
  'function songAlbum(bytes32) view returns (bytes32)',
  'function songHasCustomSplit(bytes32) view returns (bool)',
  'function songSplitRevision(bytes32) view returns (uint256)',
  'function CONTRACT_VERSION() view returns (string)',
  'event AlbumSongRemoved(bytes32 indexed albumId,bytes32 indexed songId)',
];

export function buildUploadAuthorizationMessage({ address, origin, name, size, type, issuedAt, purpose }) {
  return [
    purpose === 'submission' ? 'DecentBusking artist media upload authorization' : 'DecentBusking IPFS upload authorization',
    `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`,
    `File: ${name}`,
    `Size: ${size}`,
    `Type: ${type}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

export function buildUploadBatchAuthorizationMessage({ address, origin, issuedAt, files }) {
  return [
    'DecentBusking IPFS metadata batch upload authorization',
    `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`,
    `Issued At: ${issuedAt}`,
    `Files: ${JSON.stringify(files)}`,
  ].join('\n');
}

export function buildAdminAuthorizationMessage({ address, origin, issuedAt }) {
  return [
    'DecentBusking admin mint queue',
    `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

export function buildRadioScheduleAuthorizationMessage({ address, origin, issuedAt, events, weeklySchedule = {} }) {
  return [
    'DecentBusking radio schedule update',
    `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`,
    `Issued At: ${issuedAt}`,
    `Events: ${JSON.stringify(events)}`,
    `Weekly Schedule: ${JSON.stringify(weeklySchedule)}`,
  ].join('\n');
}

export function buildReviewedAlbumImportAuthorizationMessage({ address, origin, issuedAt }) {
  return [
    'DecentBusking reviewed album import and owner mint queue',
    `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32 * 1024) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response, status, body, corsOrigin = '', cacheControl = 'no-store') {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': cacheControl,
    ...(corsOrigin ? { 'access-control-allow-origin': corsOrigin, vary: 'origin' } : {}),
  });
  response.end(JSON.stringify(body));
}

function sendCorsError(response, origin, error) {
  sendJson(response, 403, { error }, origin || '*');
}

const ARTWORK_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export async function requestPinataSignedUrl({ pinataJwt, pinataSignUrl, name, size, type, fetchImpl = fetch }) {
  const headers = { 'content-type': 'application/json' };
  if (pinataJwt) headers.authorization = `Bearer ${pinataJwt}`;
  const response = await fetchImpl(pinataSignUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      network: 'public',
      date: Math.floor(Date.now() / 1000),
      expires: 15 * 60,
      max_file_size: size + SIGNED_UPLOAD_OVERHEAD_BYTES,
      allow_mime_types: ARTWORK_MIME_TYPES.includes(type) ? ARTWORK_MIME_TYPES : [type],
      filename: name,
    }),
  });
  if (!response.ok) throw new Error(`Pinata signing failed (${response.status})`);
  const result = await response.json();
  const url = result.data || result.url;
  if (!url) throw new Error('Pinata did not return a signed upload URL');
  return url;
}

export function createMintTransactionVerifier({ rpcUrl, contractAddress, contractAddresses = [], ownerWallet, provider }) {
  const rpcProvider = provider || new JsonRpcProvider(rpcUrl);
  const contracts = new Set([contractAddress, ...contractAddresses].filter(Boolean).map(address => address.toLowerCase()));
  if (!contracts.size) throw new Error('At least one DecentNFT contract address is required');
  const owner = ownerWallet.toLowerCase();
  const iface = new Interface(MINT_EVENT_ABI);

  return async function verifyMint({ tokenId, txHash }) {
    const [transaction, receipt] = await Promise.all([
      rpcProvider.getTransaction(txHash),
      rpcProvider.getTransactionReceipt(txHash),
    ]);
    if (!transaction || !receipt || receipt.status !== 1) throw new Error('Mint transaction is not confirmed');
    // Smart accounts (EIP-7702) route through delegation contracts, so trust DecentNFT's own event, not tx.to/from.

    const matches = [];
    for (const log of receipt.logs) {
      const emittedBy = log.address?.toLowerCase();
      if (!contracts.has(emittedBy)) continue;
      try {
        const event = iface.parseLog(log);
        if (event?.name === 'EditionMinted' && event.args.tokenId.toString() === String(tokenId)) {
          if (event.args.minter.toLowerCase() !== owner) throw new Error('Edition was not minted by the configured owner');
          matches.push({ recipient: event.args.to, amount: event.args.amount.toString(), contractAddress: log.address });
        }
      } catch (error) {
        if (error.message.includes('configured owner')) throw error;
      }
    }
    if (matches.length !== 1) throw new Error('Mint transaction does not contain exactly one claimed EditionMinted event');
    return matches[0];
  };
}

export function createArtworkUpdateTransactionVerifier({ rpcUrl, contractAddress, contractAddresses = [], ownerWallet, provider }) {
  const rpcProvider = provider || new JsonRpcProvider(rpcUrl);
  const contracts = new Set([contractAddress, ...contractAddresses].filter(Boolean).map(address => address.toLowerCase()));
  if (!contracts.size) throw new Error('At least one DecentNFT contract address is required');
  const owner = ownerWallet.toLowerCase();
  const iface = new Interface(ARTWORK_EVENT_ABI);

  return async function verifyArtworkUpdate({ tokenId, txHash, expectedUri }) {
    const [transaction, receipt] = await Promise.all([
      rpcProvider.getTransaction(txHash),
      rpcProvider.getTransactionReceipt(txHash),
    ]);
    if (!transaction || !receipt || receipt.status !== 1) throw new Error('Artwork update transaction is not confirmed');
    if (transaction.from?.toLowerCase() !== owner) throw new Error('Artwork update was not submitted by the configured owner');
    const matches = [];
    for (const log of receipt.logs) {
      if (!contracts.has(log.address?.toLowerCase())) continue;
      try {
        const event = iface.parseLog(log);
        if (event?.name === 'URI' && event.args.id.toString() === String(tokenId)) {
          if (expectedUri && String(event.args.value) !== String(expectedUri)) {
            throw new Error('Artwork update URI does not match the queued request');
          }
          matches.push({ metadataUri: event.args.value, contractAddress: log.address });
        }
      } catch (error) {
        if (error.message.includes('queued request')) throw error;
      }
    }
    if (matches.length !== 1) throw new Error('Artwork update transaction does not contain exactly one URI event');
    return { ...matches[0], txHash: receipt.hash || transaction.hash };
  };
}

export function createWorkerRequestHandler({
  allowedOrigins,
  radioAllowedOrigins = [],
  ownerWallet,
  pinataJwt,
  pinataSignUrl = 'https://uploads.pinata.cloud/v3/files/sign',
  verifyMintTransaction,
  onMintComplete,
  getMintQueue,
  getNftCatalog,
  onReviewedAlbumImport,
  creatorProfiles,
  getRadioState,
  getRadioMediaUrl,
  getMediaGateways = async () => [],
  getRadioSchedule,
  saveRadioSchedule,
  radioAnnouncements,
  getDjukeState,
  getDjukeGasQuote,
  getDjukePlaylistGasQuote,
  getDjukePlaylistReadiness,
  getDevertState,
  getDevertQueue,
  removeDevertCampaign,
  getDevertAds,
  getDevertLoopState,
  onDevertLoopVote,
  getPinnerManifest,
  checkpointMirror,
  getRadioHistory,
  getWeeklyPayflow,
  getPaymentLedger,
  getFunds,
  liveBookings,
  getEarnings,
  getDjukeTopEarners,
  ensResolver,
  reconcilePayment,
  onRadioVote,
  promotions,
  onMediaSubmission,
  artworkUpdateQueue,
  creatorSplitUpdateQueue,
  onCreatorSplitUpdate,
  onCreatorAlbumTrackRemoved,
  verifyCreatorSplitProposer,
  djukeContractAddress = '',
  verifyArtworkUpdateTransaction,
  rpcUrl = 'https://mainnet.base.org',
  rpcProvider = null,
  getRpcHealth,
  rpcProxy = null,
  alchemyWebhook = null,
  pinataApiUrl = 'https://uploads.pinata.cloud/v3/files',
  ipfsApiUrl = 'http://127.0.0.1:5001',
  fetchImpl = fetch,
  now = () => Date.now(),
}) {
  const origins = new Set(allowedOrigins);
  const radioOrigins = new Set([...allowedOrigins, ...radioAllowedOrigins]);
  const expectedOwner = ownerWallet.toLowerCase();
  const consumedSignatures = new Map();
  function hasConsumedSignature(signature) {
    const time = now();
    for (const [key, expires] of consumedSignatures) {
      if (expires < time) consumedSignatures.delete(key);
    }
    return consumedSignatures.has(signature);
  }
  const artistLimits = new Map();
  const splitProposalLimits = new Map();
  const paymentLimits = new Map();
  function limitWalletOperation(limits, address, message) {
    const time = now();
    for (const [key, entry] of limits) {
      if (entry.until <= time) limits.delete(key);
    }
    const key = address.toLowerCase();
    const entry = limits.get(key) || { count: 0, until: time + 60 * 60 * 1000 };
    if (entry.count >= 20 || (!limits.has(key) && limits.size >= 2000)) {
      throw new Error(message);
    }
    entry.count++;
    limits.set(key, entry);
  }
  const limitArtist = address => limitWalletOperation(artistLimits, address, 'Artist submission limit reached; try again later');
  const limitSplitProposal = address => limitWalletOperation(splitProposalLimits, address, 'Split proposal limit reached; try again later');
  const splitContract = () => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(djukeContractAddress || '')) throw new Error('DJuke contract is not configured');
    return new Contract(djukeContractAddress, CREATOR_SPLIT_ABI, rpcProvider || new JsonRpcProvider(rpcUrl));
  };
  const sameAddresses = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    left.every((value, index) => String(value).toLowerCase() === String(right[index]).toLowerCase());
  const sameNumbers = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    left.every((value, index) => Number(value) === Number(right[index]));
  const sameStrings = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    left.every((value, index) => String(value) === String(right[index]));
  const readSplitState = async (kind, resourceId, targetAlbumId = '') => {
    const contract = splitContract();
    if (kind === 'album') {
      const album = await contract.getAlbum(resourceId);
      if (!album.mainOwner || /^0x0{40}$/i.test(album.mainOwner)) throw new Error('Album not found');
      const contractVersion = await contract.CONTRACT_VERSION();
      const inheritingSongIds = [];
      if (contractVersion === '0.6') {
        for (const songId of album.songIds) {
          if (!await contract.songHasCustomSplit(songId)) inheritingSongIds.push(songId);
        }
      } else inheritingSongIds.push(...album.songIds);
      return { contract, title: album.title, audioURI: '', revision: String(album.revision), mainOwner: album.mainOwner,
        recipients: [...album.recipients], sharesBps: [...album.sharesBps].map(Number), positions: [...album.positions],
        songIds: [...album.songIds], inheritingSongIds, contractVersion };
    }
    if (kind === 'song') {
      const song = await contract.getSong(resourceId);
      if (!song.audioURI || song.enabled === false) throw new Error('DJuke song is not registered or enabled');
      if (await contract.songAlbum(resourceId) !== '0x' + '0'.repeat(64) &&
          await contract.CONTRACT_VERSION() !== '0.6') {
        throw new Error('Custom splits for album songs require DJuke v0.6');
      }
      return { contract, audioURI: song.audioURI, revision: '', mainOwner: '',
        recipients: [...song.recipients], sharesBps: [...song.sharesBps].map(Number), positions: [] };
    }
    if (kind === 'migration') {
      if (!/^0x[0-9a-fA-F]{64}$/.test(targetAlbumId || '')) throw new Error('A target album is required');
      if (await contract.CONTRACT_VERSION() !== '0.6') throw new Error('Existing-song album migration requires DJuke v0.6');
      targetAlbumId = targetAlbumId.toLowerCase();
      const [song, currentAlbumId, album] = await Promise.all([
        contract.getSong(resourceId), contract.songAlbum(resourceId), contract.getAlbum(targetAlbumId),
      ]);
      if (!song.audioURI || song.enabled === false) throw new Error('DJuke song is not registered or enabled');
      if (!album.mainOwner || /^0x0{40}$/i.test(album.mainOwner)) throw new Error('Target album not found');
      if (currentAlbumId !== '0x' + '0'.repeat(64) && currentAlbumId.toLowerCase() !== targetAlbumId.toLowerCase()) {
        throw new Error('Song already belongs to another album');
      }
      const useAlbumDefault = !await contract.songHasCustomSplit(resourceId) &&
        song.recipients.length === 1 && Number(song.sharesBps[0]) === 10000;
      return { contract, title: album.title, audioURI: song.audioURI, revision: String(album.revision), mainOwner: album.mainOwner,
        recipients: [...song.recipients], sharesBps: [...song.sharesBps].map(Number), positions: [],
        albumId: targetAlbumId, currentAlbumId, useAlbumDefault,
        albumRecipients: [...album.recipients], albumSharesBps: [...album.sharesBps].map(Number),
        albumPositions: [...album.positions] };
    }
    throw new Error('Unsupported split proposal type');
  };
  const splitTypedData = (kind, resourceId, state, proposed) => kind === 'album'
    ? buildAlbumSplitTypedData({
      ethers: { AbiCoder, keccak256 },
      contractAddress: djukeContractAddress,
      albumId: resourceId,
      revision: state.revision,
      recipients: proposed.recipients,
      sharesBps: proposed.sharesBps,
      positions: proposed.positions,
    })
    : kind === 'migration'
      ? buildSongAlbumMigrationTypedData({
        ethers: { AbiCoder, keccak256, toUtf8Bytes },
        contractAddress: djukeContractAddress,
        albumId: state.albumId,
        songId: resourceId,
        albumRevision: state.revision,
        audioURI: state.audioURI,
        currentRecipients: state.recipients,
        currentSharesBps: state.sharesBps,
        albumRecipients: state.albumRecipients,
        albumSharesBps: state.albumSharesBps,
        albumPositions: state.albumPositions,
        useAlbumDefault: state.useAlbumDefault,
      })
      : buildSongSplitTypedData({
      ethers: { AbiCoder, keccak256, toUtf8Bytes },
      contractAddress: djukeContractAddress,
      songId: resourceId,
      audioURI: state.audioURI,
      currentRecipients: state.recipients,
      currentSharesBps: state.sharesBps,
      recipients: proposed.recipients,
      sharesBps: proposed.sharesBps,
      positions: proposed.positions,
    });
  const splitIsCurrent = (request, state) => request.kind === 'album'
    ? state.revision === request.revision && sameAddresses(state.recipients, request.currentRecipients) &&
      sameNumbers(state.sharesBps, request.currentSharesBps) && sameStrings(state.positions, request.currentPositions)
    : request.kind === 'migration'
      ? state.currentAlbumId === '0x' + '0'.repeat(64) && state.albumId.toLowerCase() === request.albumId.toLowerCase() &&
        state.revision === request.revision && state.audioURI === request.audioURI &&
        sameAddresses(state.recipients, request.currentRecipients) && sameNumbers(state.sharesBps, request.currentSharesBps) &&
        state.useAlbumDefault === request.useAlbumDefault &&
        sameAddresses(state.albumRecipients, request.albumRecipients) && sameNumbers(state.albumSharesBps, request.albumSharesBps) &&
        sameStrings(state.albumPositions, request.albumPositions)
      : state.audioURI === request.audioURI && sameAddresses(state.recipients, request.currentRecipients) &&
        sameNumbers(state.sharesBps, request.currentSharesBps);
  const verifySplitSignature = (request, address, signature, state) => {
    const recovered = verifyTypedData(request.typedData.domain, request.typedData.types,
      request.typedData.value, signature).toLowerCase();
    if (recovered !== String(address || '').toLowerCase()) throw new Error('Split approval signature does not match the connected wallet');
    if (!state.recipients.some(owner => owner.toLowerCase() === recovered)) throw new Error('Only a current split recipient can approve');
    return recovered;
  };

  return async function handleRequest(request, response) {
    const requestUrl = new URL(request.url, 'http://localhost');
    const origin = String(request.headers.origin || '');
    const corsOrigin = origins.has(origin) ? origin : '';
    const radioCorsOrigin = radioOrigins.has(origin) ? origin : '';

    try {
      if (request.method === 'POST' && ['/api/checkpoint-mirror/claim', '/api/checkpoint-mirror/ack'].includes(requestUrl.pathname)) {
        if (!checkpointMirror) { sendJson(response, 404, { error: 'Checkpoint mirroring is not configured' }); return; }
        const authorization = String(request.headers.authorization || '');
        checkpointMirror.authorize(authorization);
        const result = requestUrl.pathname.endsWith('/claim')
          ? { job: checkpointMirror.claimWait
            ? await checkpointMirror.claimWait(authorization, requestUrl.searchParams.get('wait') === '0' ? 0 : 10000)
            : checkpointMirror.claim(authorization) }
          : checkpointMirror.acknowledge(authorization, await readJson(request));
        sendJson(response, 200, result);
        return;
      }
      const uploadRoute = requestUrl.pathname === '/api/ipfs/upload-url' ||
        requestUrl.pathname === '/api/ipfs/submission-upload-url' ||
        requestUrl.pathname === '/api/ipfs/upload-batch-urls';
      if (request.method === 'OPTIONS') {
        const preflightOrigin = requestUrl.pathname === '/api/radio/vote' ? radioCorsOrigin : corsOrigin;
        response.writeHead(uploadRoute ? 204 : (preflightOrigin ? 204 : 403), {
          ...(uploadRoute || preflightOrigin ? { 'access-control-allow-origin': preflightOrigin || origin || '*', vary: 'origin' } : {}),
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type, range',
        });
        response.end();
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/health') {
        const rpc = getRpcHealth?.();
        sendJson(response, 200, { ok: true, ipfsProvider: pinataJwt ? 'pinata' : 'unconfigured',
          ...(rpc ? { rpc: { ...rpc.tiers, computeUnits: rpc.computeUnits } } : {}) }, '*');
        return;
      }
      if (requestUrl.pathname === '/api/promotions' && ['GET', 'POST'].includes(request.method)) {
        response.setHeader('Cache-Control', 'no-store');
        if (!promotions) throw new Error('Promotions unavailable: configure encrypted promotions storage before creating offers');
        if (request.method === 'GET') {
          sendJson(response, 200, await promotions.publicState(), '*');
        } else {
          if (!corsOrigin) throw new Error('Origin is not allowed');
          sendJson(response, 200, await promotions.execute(await readJson(request), origin), corsOrigin);
        }
        return;
      }
      if (requestUrl.pathname === '/api/creator/profile' && request.method === 'GET') {
        if (!creatorProfiles) throw new Error('Creator profiles are not configured');
        sendJson(response, 200, creatorProfiles.get(requestUrl.searchParams.get('address')), '*');
        return;
      }
      if (requestUrl.pathname === '/api/creator/playlists' && request.method === 'GET') {
        if (!creatorProfiles) throw new Error('Creator profiles are not configured');
        const query = String(requestUrl.searchParams.get('query') || '').slice(0, 60);
        sendJson(response, 200, { playlists: creatorProfiles.discoverPlaylists(query) }, '*');
        return;
      }
      if (request.method === 'POST' && ['/api/creator/profile', '/api/creator/link-discord', '/api/creator/watchlist', '/api/creator/playlists', '/api/creator/playlists/copy'].includes(requestUrl.pathname)) {
        if (!corsOrigin) throw new Error('Origin is not allowed');
        if (!creatorProfiles) throw new Error('Creator profiles are not configured');
        const body = await readJson(request);
        const result = requestUrl.pathname.endsWith('link-discord')
          ? creatorProfiles.startLink(body, origin)
          : requestUrl.pathname.endsWith('watchlist')
            ? await creatorProfiles.updateWatchlist(body, origin)
            : requestUrl.pathname.endsWith('/copy')
              ? await creatorProfiles.savePlaylistCopy(body, origin)
              : requestUrl.pathname.endsWith('playlists')
                ? await creatorProfiles.savePlaylist(body, origin)
                : await creatorProfiles.update(body, origin);
        sendJson(response, 200, result, corsOrigin);
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/ipfs/media-type') {
        const cid = normalizeMediaCid(requestUrl.searchParams.get('cid'));
        const deadline = Date.now() + 30000;
        const gateways = [...new Set([
          ...await getMediaGateways(),
          'https://gateway.pinata.cloud/ipfs/',
          'https://ipfs.io/ipfs/',
        ].filter(Boolean))].slice(0, 3);
        const upstream = await probeMediaGateways(cid, 'bytes=0-65535', gateways, fetchImpl, deadline);
        let bytes = upstream.bytes;
        const text = new TextDecoder('latin1').decode(bytes);
        if (text.slice(4, 8) === 'ftyp' && !text.includes('vide') && !text.includes('soun')) {
          const { bytes: tail } = await probeMediaGateways(cid, 'bytes=-65536', gateways, fetchImpl, deadline);
          const combined = new Uint8Array(bytes.length + tail.length);
          combined.set(bytes);
          combined.set(tail, bytes.length);
          bytes = combined;
        }
        const mediaType = detectSubmissionMedia(bytes, { type: upstream.type });
        sendJson(response, 200, { cid, mediaType, filename: mediaFilename(mediaType) }, '*');
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/ipfs/artwork-cid') {
        const value = requestUrl.searchParams.get('cid') || '';
        if (!value || value.length > 160) throw new Error('Enter a valid image file CID');
        sendJson(response, 200, { cid: normalizeMediaCid(value) }, '*');
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/radio') {
        if (!getRadioState) {
          sendJson(response, 404, { error: 'Radio is not configured' }, '*');
          return;
        }
        sendJson(response, 200, await getRadioState(), '*');
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/radio/media') {
        const cid = requestUrl.searchParams.get('cid') || '';
        if (!/^[a-zA-Z0-9]{20,120}$/.test(cid)) {
          sendJson(response, 400, { error: 'Invalid radio media CID' }, '*');
          return;
        }
        if (!getRadioMediaUrl) {
          sendJson(response, 503, { error: 'Radio media is not configured' }, '*');
          return;
        }
        const url = await getRadioMediaUrl(cid);
        if (!url) {
          sendJson(response, 404, { error: 'Radio recording is unavailable' }, '*');
          return;
        }
        const controller = new AbortController();
        const abort = () => controller.abort();
        response.once('close', abort);
        const timeout = setTimeout(abort, 30_000);
        try {
          const upstream = await fetchImpl(url, {
            headers: request.headers.range ? { range: request.headers.range } : {},
            signal: controller.signal,
          });
          clearTimeout(timeout);
          if (![200, 206, 416].includes(upstream.status)) {
            await upstream.body?.cancel();
            console.warn(`[radio] Media gateway returned HTTP ${upstream.status}`);
            sendJson(response, 502, { error: 'Radio media gateway is unavailable' }, '*');
            return;
          }
          const headers = {
            'access-control-allow-origin': '*',
            'access-control-expose-headers': 'content-length, content-range, accept-ranges',
            'cache-control': 'public, max-age=300',
          };
          for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
            const value = upstream.headers.get(name);
            if (value) headers[name] = value;
          }
          response.writeHead(upstream.status, headers);
          if (upstream.body) {
            const media = Readable.fromWeb(upstream.body);
            media.on('error', error => console.warn('[radio] Upstream media stream failed:', error.message));
            await pipeline(media, response);
          } else response.end();
        } catch (error) {
          if (!response.destroyed) {
            console.warn('[radio] Media stream failed:', error.name);
            if (response.headersSent) response.destroy();
            else sendJson(response, 502, { error: 'Radio media stream failed' }, '*');
          }
        } finally {
          clearTimeout(timeout);
          response.off('close', abort);
        }
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/radio/calendar.ics') {
        if (!getRadioSchedule) {
          sendJson(response, 404, { error: 'Radio schedule is not configured' }, '*');
          return;
        }
        const schedule = await getRadioSchedule();
        if (schedule.ready === false) {
          sendJson(response, 503, { error: 'Radio calendar is temporarily unavailable; retain your existing subscription' }, '*');
          return;
        }
        const generatedAt = now();
        const calendar = buildRadioCalendar(radioCalendarOccurrences(schedule, { now: generatedAt }), { now: generatedAt });
        response.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8',
          'Content-Disposition': 'inline; filename="decentbusking-radio.ics"',
          'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' });
        response.end(calendar);
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname.startsWith('/api/radio/announcements/')) {
        if (!corsOrigin) throw new Error('Origin is not allowed');
        if (!radioAnnouncements) throw new Error('Radio announcements are not configured');
        const action = requestUrl.pathname.slice('/api/radio/announcements/'.length);
        sendJson(response, 200, await radioAnnouncements.handle(action, await readJson(request), origin), corsOrigin);
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/radio/schedule') {
        if (!getRadioSchedule) {
          sendJson(response, 404, { error: 'Radio schedule is not configured' }, '*');
          return;
        }
        sendJson(response, 200, await getRadioSchedule(), '*');
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/radio/schedule') {
        if (!corsOrigin) throw new Error('Origin is not allowed');
        if (!getRadioSchedule || !saveRadioSchedule) throw new Error('Radio schedule editing is not configured');
        const body = await readJson(request);
        const issuedAt = Date.parse(body.issuedAt);
        if (!/^0x[0-9a-fA-F]{40}$/.test(body.address || '') || typeof body.signature !== 'string' ||
            !Number.isFinite(issuedAt) || Math.abs(now() - issuedAt) > MAX_SIGNATURE_AGE_MS) {
          throw new Error('Invalid or expired schedule authorization');
        }
        if (hasConsumedSignature(body.signature)) throw new Error('Schedule authorization has already been used');
        const events = validateLivePerformanceSchedule(body.events, { now: now() });
        const weeklySchedule = validateWeeklyScheduleOverrides(body.weeklySchedule || {});
        const message = buildRadioScheduleAuthorizationMessage({ address: body.address, origin, issuedAt: body.issuedAt, events, weeklySchedule });
        const recovered = verifyMessage(message, body.signature).toLowerCase();
        if (recovered !== body.address.toLowerCase() || recovered !== expectedOwner) throw new Error('Schedule authorization is not from the radio owner');
        validateRadioProgrammingConflicts(events, weeklySchedule, { now: now() });
        consumedSignatures.set(body.signature, now() + MAX_SIGNATURE_AGE_MS);
        await saveRadioSchedule({ events, weeklySchedule });
        sendJson(response, 200, await getRadioSchedule(), corsOrigin);
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/djuke/earners') {
        if (!getDjukeTopEarners) {
          sendJson(response, 503, { error: 'DJuke earnings index is not configured' }, '*');
          return;
        }
        try {
          sendJson(response, 200, await getDjukeTopEarners(), '*', 'public, max-age=30');
        } catch (error) {
          sendJson(response, 503, { error: error.message }, '*');
        }
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/djuke') {
        if (!getDjukeState) {
          sendJson(response, 404, { error: 'DJuke is not deployed or configured' }, '*');
          return;
        }
        sendJson(response, 200, await getDjukeState(), '*');
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/nfts') {
        if (!getNftCatalog) { sendJson(response, 404, { error: 'NFT catalog is not configured' }, '*'); return; }
        const params = requestUrl.searchParams;
        sendJson(response, 200, await getNftCatalog({
          offset: Number(params.get('offset') || 0),
          limit: Number(params.get('limit') || 25),
          query: params.get('query') || '',
          artist: params.get('artist') || '',
          wallet: params.get('wallet') || '',
          before: params.get('before') || '',
          after: params.get('after') || '',
        }), '*');
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/creator/split-proposals') {
        if (!corsOrigin) throw new Error('Origin is not allowed');
        if (!creatorSplitUpdateQueue) throw new Error('Creator split approvals are not configured');
        const body = await readJson(request);
        const resourceId = String(body.resourceId || '').toLowerCase();
        if (!/^0x[0-9a-fA-F]{64}$/.test(resourceId) ||
            !/^0x[0-9a-fA-F]{40}$/.test(body.address || '') ||
            typeof body.signature !== 'string' || !body.signature ||
            typeof body.title !== 'string' || body.title.length > 160) {
          throw new Error('Invalid split proposal');
        }
        const state = await readSplitState(body.kind, resourceId, body.albumId);
        if (['album', 'migration'].includes(body.kind) && String(body.revision) !== state.revision) {
          throw new Error('Album changed; reload before proposing this update');
        }
        const isCurrentOwner = state.recipients.some(owner => owner.toLowerCase() === body.address.toLowerCase());
        const isCreator = body.kind === 'song' && !isCurrentOwner && verifyCreatorSplitProposer &&
          /^0x[0-9a-fA-F]{40}$/.test(body.nftContractAddress || '') &&
          /^\d+$/.test(String(body.nftTokenId || '')) &&
          await verifyCreatorSplitProposer({
            address: body.address,
            contractAddress: body.nftContractAddress,
            tokenId: String(body.nftTokenId),
          });
        if (!isCurrentOwner && !isCreator) {
          throw new Error('Only a current split recipient or verified NFT creator can start this proposal');
        }
        let proposed;
        if (body.kind === 'migration') {
          proposed = {
            recipients: state.useAlbumDefault ? state.albumRecipients : state.recipients,
            sharesBps: state.useAlbumDefault ? state.albumSharesBps : state.sharesBps,
            positions: state.useAlbumDefault ? state.albumPositions : state.recipients.map(() => ''),
          };
        } else {
          const proposedRows = validateCreatorSplitRows((body.recipients || []).map((wallet, index) => ({
            wallet, shareBps: Number(body.sharesBps?.[index]), position: String(body.positions?.[index] || ''),
          })));
          if (proposedRows.length !== body.recipients.length ||
              body.sharesBps?.length !== proposedRows.length || body.positions?.length !== proposedRows.length) {
            throw new Error('Incomplete proposed split');
          }
          proposed = {
            recipients: proposedRows.map(row => row.wallet),
            sharesBps: proposedRows.map(row => row.shareBps),
            positions: proposedRows.map(row => row.position),
          };
        }
        const typedData = splitTypedData(body.kind, resourceId, state, proposed);
        const recovered = verifyTypedData(typedData.domain, typedData.types, typedData.value, body.signature).toLowerCase();
        if (recovered !== body.address.toLowerCase()) throw new Error('Split proposal signature does not match the connected wallet');
        limitSplitProposal(recovered);
        const expiresAt = new Date(now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const requestRecord = await creatorSplitUpdateQueue.queueRequest({
          requestType: 'split-update',
          kind: body.kind,
          resourceId,
          ...(body.kind === 'migration' ? { albumId: state.albumId } : {}),
          ...(body.kind === 'migration' ? { albumTitle: state.title } : {}),
          ...(body.kind === 'migration' ? {
            useAlbumDefault: state.useAlbumDefault, albumRecipients: state.albumRecipients,
            albumSharesBps: state.albumSharesBps, albumPositions: state.albumPositions,
          } : {}),
          title: body.title.trim() || `${body.kind === 'album' ? 'Album' : 'Song'} ${resourceId.slice(0, 10)}`,
          contractAddress: djukeContractAddress.toLowerCase(),
          audioURI: state.audioURI,
          revision: state.revision,
          currentRecipients: state.recipients,
          currentSharesBps: state.sharesBps,
          currentPositions: state.positions,
          ...(body.kind === 'album' ? { currentSongIds: state.songIds } : {}),
          recipients: proposed.recipients,
          sharesBps: proposed.sharesBps,
          positions: proposed.positions,
          owners: state.recipients,
          typedData,
          initiatorAddress: body.address,
          initiatorIsCreator: isCreator,
          approvals: isCurrentOwner
            ? [{ address: body.address, signature: body.signature, approvedAt: new Date(now()).toISOString() }]
            : [],
          expiresAt,
        });
        sendJson(response, 200, { request: requestRecord }, corsOrigin);
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/creator/split-status') {
        if (!creatorSplitUpdateQueue || !rpcProvider) throw new Error('Creator split approvals are not configured');
        const contractVersion = await splitContract().CONTRACT_VERSION();
        sendJson(response, 200, { available: true, chainId: 8453,
          contractAddress: djukeContractAddress.toLowerCase(), contractVersion }, '*');
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/creator/split-proposal') {
        if (!creatorSplitUpdateQueue) throw new Error('Creator split approvals are not configured');
        const requestRecord = creatorSplitUpdateQueue.getRequest(requestUrl.searchParams.get('requestId'));
        if (!requestRecord) { sendJson(response, 404, { error: 'Split proposal not found' }, '*'); return; }
        sendJson(response, 200, { request: requestRecord }, '*');
        return;
      }
      const splitApprovalMatch = requestUrl.pathname.match(/^\/api\/creator\/split-proposals\/([0-9a-f-]+)\/approve$/i);
      if (request.method === 'POST' && splitApprovalMatch) {
        if (!corsOrigin) throw new Error('Origin is not allowed');
        if (!creatorSplitUpdateQueue) throw new Error('Creator split approvals are not configured');
        const body = await readJson(request);
        if (!/^0x[0-9a-fA-F]{40}$/.test(body.address || '') || typeof body.signature !== 'string' || !body.signature) {
          throw new Error('Invalid split approval');
        }
        const proposal = creatorSplitUpdateQueue.getRequest(splitApprovalMatch[1]);
        if (!proposal) throw new Error('Split proposal not found');
        if (proposal.status === 'expired' || Date.parse(proposal.expiresAt) <= now()) throw new Error('Split proposal has expired');
        if (proposal.status !== 'pending') throw new Error('Split proposal is no longer pending');
        const state = await readSplitState(proposal.kind, proposal.resourceId, proposal.albumId);
        if (!splitIsCurrent(proposal, state)) throw new Error('On-chain split changed; create a new proposal');
        const recovered = verifySplitSignature(proposal, body.address, body.signature, state);
        const updated = await creatorSplitUpdateQueue.addApproval(proposal.requestId, {
          address: recovered,
          signature: body.signature,
          approvedAt: new Date(now()).toISOString(),
        });
        sendJson(response, 200, { request: updated }, corsOrigin);
        return;
      }
      const splitCompleteMatch = requestUrl.pathname.match(/^\/api\/creator\/split-proposals\/([0-9a-f-]+)\/complete$/i);
      if (request.method === 'POST' && splitCompleteMatch) {
        if (!corsOrigin) throw new Error('Origin is not allowed');
        if (!creatorSplitUpdateQueue || !rpcProvider) throw new Error('Creator split reconciliation is not configured');
        const body = await readJson(request);
        const issuedAt = Date.parse(body.issuedAt);
        if (!/^0x[0-9a-fA-F]{40}$/.test(body.address || '') || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash || '') ||
            typeof body.signature !== 'string' || !Number.isFinite(issuedAt) || Math.abs(now() - issuedAt) > MAX_SIGNATURE_AGE_MS) {
          throw new Error('Invalid split completion authorization');
        }
        const message = [
          'DecentBusking creator split update completion',
          `Wallet: ${body.address.toLowerCase()}`,
          `Origin: ${origin}`,
          `Proposal: ${splitCompleteMatch[1]}`,
          `Transaction: ${body.txHash.toLowerCase()}`,
          `Issued At: ${body.issuedAt}`,
        ].join('\n');
        const recovered = verifyMessage(message, body.signature).toLowerCase();
        if (recovered !== body.address.toLowerCase()) throw new Error('Split completion signature does not match the connected wallet');
        const proposal = creatorSplitUpdateQueue.getRequest(splitCompleteMatch[1]);
        if (!proposal) throw new Error('Split proposal not found');
        if (proposal.status === 'expired' || Date.parse(proposal.expiresAt) <= now()) throw new Error('Split proposal has expired');
        if (proposal.status !== 'pending' || proposal.approvals.length !== proposal.owners.length) {
          throw new Error('Fully approved split proposal not found');
        }
        const [transaction, receipt] = await Promise.all([
          rpcProvider.getTransaction(body.txHash),
          rpcProvider.getTransactionReceipt(body.txHash),
        ]);
        if (!transaction || !receipt || Number(receipt.status) !== 1 ||
            String(transaction.to || '').toLowerCase() !== djukeContractAddress.toLowerCase() ||
            String(transaction.from || '').toLowerCase() !== recovered) {
          throw new Error('Split update transaction could not be verified');
        }
        const state = await readSplitState(proposal.kind, proposal.resourceId, proposal.albumId);
        if (proposal.kind === 'song' && recovered !== expectedOwner) {
          throw new Error('Only the configured owner can complete song split updates');
        }
        if (proposal.kind === 'album') {
          const currentOwner = proposal.owners.some(owner => owner.toLowerCase() === recovered);
          const admin = recovered === expectedOwner;
          const manager = recovered === String(state.mainOwner).toLowerCase();
          const initiator = recovered === String(proposal.initiatorAddress || '').toLowerCase();
          if (state.contractVersion === '0.6'
            ? !currentOwner && !admin && !manager && !initiator
            : !manager) {
            throw new Error('Wallet cannot submit this album split update');
          }
        }
        if (proposal.kind === 'migration' && recovered !== String(state.mainOwner).toLowerCase()) {
          throw new Error('Only the album manager can complete this migration');
        }
        if (proposal.kind === 'migration' &&
            await state.contract.songHasCustomSplit(proposal.resourceId) !== !proposal.useAlbumDefault) {
          throw new Error('On-chain song default/custom mode does not match the approved proposal');
        }
        const expectedAlbum = proposal.kind === 'migration' ? proposal.albumId.toLowerCase() : '';
        if ((proposal.kind === 'migration' && String(state.currentAlbumId).toLowerCase() !== expectedAlbum) ||
            !sameAddresses(state.recipients, proposal.recipients) || !sameNumbers(state.sharesBps, proposal.sharesBps) ||
            (proposal.kind === 'album' && !sameStrings(state.positions, proposal.positions)) ||
            (proposal.kind === 'album' && BigInt(state.revision) !== BigInt(proposal.revision) + 1n) ||
            (proposal.kind === 'migration' && (state.revision !== proposal.revision ||
              !sameAddresses(state.albumRecipients, proposal.albumRecipients) ||
              !sameNumbers(state.albumSharesBps, proposal.albumSharesBps) ||
              !sameStrings(state.albumPositions, proposal.albumPositions)))) {
          throw new Error('On-chain split does not match the approved proposal');
        }
        if (proposal.kind === 'album') {
          for (const songId of state.inheritingSongIds) {
            const song = await state.contract.getSong(songId);
            if (!sameAddresses([...song.recipients], proposal.recipients) ||
                !sameNumbers([...song.sharesBps], proposal.sharesBps) ||
                (state.contractVersion === '0.6' &&
                  String(await state.contract.songSplitRevision(songId)) !== state.revision)) {
              throw new Error('Album default saved, but inheriting songs still need synchronization');
            }
          }
        }
        if (onCreatorSplitUpdate) await onCreatorSplitUpdate({
          proposal: proposal.kind === 'album' ? { ...proposal, currentSongIds: state.inheritingSongIds } : proposal,
          txHash: body.txHash,
        });
        sendJson(response, 200, await creatorSplitUpdateQueue.completeRequest(proposal.requestId, { txHash: body.txHash }), corsOrigin);
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/creator/album-track-removal') {
        if (!corsOrigin) throw new Error('Origin is not allowed');
        if (!rpcProvider || !onCreatorAlbumTrackRemoved) throw new Error('Album track reconciliation is not configured');
        const body = await readJson(request);
        const issuedAt = Date.parse(body.issuedAt);
        if (!/^0x[0-9a-fA-F]{40}$/.test(body.address || '') ||
            !/^0x[0-9a-fA-F]{64}$/.test(body.albumId || '') ||
            !/^0x[0-9a-fA-F]{64}$/.test(body.songId || '') ||
            !/^0x[0-9a-fA-F]{64}$/.test(body.txHash || '') ||
            typeof body.signature !== 'string' || !Number.isFinite(issuedAt) ||
            Math.abs(now() - issuedAt) > MAX_SIGNATURE_AGE_MS) {
          throw new Error('Invalid album track reconciliation authorization');
        }
        if (hasConsumedSignature(body.signature)) {
          throw new Error('Album track reconciliation authorization has already been used');
        }
        const recovered = verifyMessage(buildAlbumTrackRemovalAuthorizationMessage({ ...body, origin }), body.signature).toLowerCase();
        if (recovered !== body.address.toLowerCase()) {
          throw new Error('Album track reconciliation signature does not match the connected wallet');
        }
        const [transaction, receipt] = await Promise.all([
          rpcProvider.getTransaction(body.txHash),
          rpcProvider.getTransactionReceipt(body.txHash),
        ]);
        if (!transaction || !receipt || Number(receipt.status) !== 1 ||
            String(transaction.to || '').toLowerCase() !== djukeContractAddress.toLowerCase() ||
            String(transaction.from || '').toLowerCase() !== recovered) {
          throw new Error('Album track removal transaction could not be verified');
        }
        const eventInterface = new Interface(CREATOR_SPLIT_ABI);
        const removed = (receipt.logs || []).some(log => {
          if (String(log.address || '').toLowerCase() !== djukeContractAddress.toLowerCase()) return false;
          try {
            const event = eventInterface.parseLog(log);
            return event?.name === 'AlbumSongRemoved' &&
              String(event.args.albumId).toLowerCase() === body.albumId.toLowerCase() &&
              String(event.args.songId).toLowerCase() === body.songId.toLowerCase();
          } catch {
            return false;
          }
        });
        if (!removed) throw new Error('Transaction does not prove removal of this album track');
        if (await splitContract().songAlbum(body.songId) !== `0x${'0'.repeat(64)}`) {
          throw new Error('Song is still assigned to an album on-chain');
        }
        await onCreatorAlbumTrackRemoved({
          albumId: body.albumId.toLowerCase(),
          songId: body.songId.toLowerCase(),
          txHash: body.txHash.toLowerCase(),
        });
        consumedSignatures.set(body.signature, now() + MAX_SIGNATURE_AGE_MS);
        sendJson(response, 200, { reconciled: true, songId: body.songId.toLowerCase() }, corsOrigin);
        return;
      }
      const splitRejectMatch = requestUrl.pathname.match(/^\/api\/creator\/split-proposals\/([0-9a-f-]+)\/reject$/i);
      if (request.method === 'POST' && splitRejectMatch) {
        if (!corsOrigin) throw new Error('Origin is not allowed');
        if (!creatorSplitUpdateQueue) throw new Error('Creator split approvals are not configured');
        const body = await readJson(request);
        const issuedAt = Date.parse(body.issuedAt);
        if (!/^0x[0-9a-fA-F]{40}$/.test(body.address || '') || typeof body.signature !== 'string' ||
            !Number.isFinite(issuedAt) || Math.abs(now() - issuedAt) > MAX_SIGNATURE_AGE_MS) {
          throw new Error('Invalid split rejection authorization');
        }
        const message = buildAdminAuthorizationMessage({ address: body.address, origin, issuedAt: body.issuedAt });
        const recovered = verifyMessage(message, body.signature).toLowerCase();
        if (recovered !== expectedOwner) throw new Error('Only the configured owner can reject split proposals');
        sendJson(response, 200, await creatorSplitUpdateQueue.rejectRequest(splitRejectMatch[1], body.reason || 'rejected'), corsOrigin);
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/devert/queue') {
        if (!getDevertQueue) {
          sendJson(response, 200, { configured: false, paymentsEnabled: false, requests: [], recentRefunds: [] }, '*');
          return;
        }
        sendJson(response, 200, { configured: true, ...await getDevertQueue() }, '*');
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/devert') {
        if (!getDevertState) {
          sendJson(response, 404, { error: 'DeVert is not deployed or configured' }, '*');
          return;
        }
        sendJson(response, 200, await getDevertState(), '*');
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/devert/remove') {
        if (!corsOrigin) throw new Error('Origin is not allowed');
        if (!getDevertState || !removeDevertCampaign) throw new Error('Campaign removal is unavailable');
        const body = await readJson(request);
        if (!/^0x[0-9a-f]{40}$/i.test(body.address || '') || !/^\d+$/.test(body.campaignId || '') ||
          typeof body.signature !== 'string' || !Number.isFinite(Date.parse(body.issuedAt)) ||
          Math.abs(now() - Date.parse(body.issuedAt)) > MAX_SIGNATURE_AGE_MS) throw new Error('Invalid or expired campaign removal authorization');
        if (hasConsumedSignature(body.signature)) throw new Error('Campaign removal authorization has already been used');
        const recovered = verifyMessage(buildDevertRemovalMessage({ ...body, origin }), body.signature).toLowerCase();
        const snapshot = await getDevertState();
        const campaign = snapshot.campaigns.find(item => item.campaignId === body.campaignId);
        if (recovered !== body.address.toLowerCase() || !campaign ||
          (recovered !== expectedOwner && recovered !== campaign.advertiser.toLowerCase())) throw new Error('Only the advertiser or radio owner can remove this campaign');
        consumedSignatures.set(body.signature, now() + MAX_SIGNATURE_AGE_MS);
        sendJson(response, 200, await removeDevertCampaign({ campaignId: body.campaignId, address: recovered }), corsOrigin);
        return;
      }
      if ((request.method === 'GET' || request.method === 'POST') && requestUrl.pathname === '/api/devert/ads') {
        if (!getDevertAds) { sendJson(response, 404, { error: 'Advert library is not configured' }, '*'); return; }
        const body = request.method === 'POST' ? await readJson(request) : {};
        const address = (requestUrl.searchParams.get('wallet') || requestUrl.searchParams.get('address') ||
          body.wallet || body.address || '').toString();
        if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Invalid wallet address');
        const library = await getDevertAds({ address });
        sendJson(response, 200, Array.isArray(library) ? { ads: library } : library, request.method === 'GET' ? '*' : corsOrigin);
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/devert/loop') {
        if (!getDevertLoopState) { sendJson(response, 200, { ready: false, nowPlaying: null, voiceConnected: false }, '*'); return; }
        sendJson(response, 200, await getDevertLoopState(), '*');
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/devert/loop/vote') {
        if (!corsOrigin) throw new Error('Origin is not allowed');
        if (!onDevertLoopVote) throw new Error('VertLoop voting is not configured');
        const { playId, voterId, vote } = await readJson(request);
        if (typeof playId !== 'string' || !playId || typeof voterId !== 'string' ||
            !/^[a-zA-Z0-9_-]{16,128}$/.test(voterId) || vote !== 1 && vote !== -1) throw new Error('Invalid VertLoop vote');
        sendJson(response, 200, await onDevertLoopVote({ playId, voterId, vote }), corsOrigin);
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/pinners/manifest') {
        if (!getPinnerManifest) { sendJson(response, 404, { error: 'Pin manifest is not configured' }, '*'); return; }
        sendJson(response, 200, await getPinnerManifest(), '*');
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/djuke/playlist-readiness') {
        sendJson(response, 200, getDjukePlaylistReadiness ? await getDjukePlaylistReadiness() : { ready: false }, '*');
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/djuke/playlist-gas-quote') {
        if (!getDjukePlaylistGasQuote) throw new Error('DJuke v0.4 playlist gas funding is not configured');
        const songIds = requestUrl.searchParams.getAll('songId');
        sendJson(response, 200, await getDjukePlaylistGasQuote({ listener: requestUrl.searchParams.get('listener'), songIds }), '*');
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/djuke/gas-quote') {
        if (!getDjukeGasQuote) throw new Error('DJuke v0.2 gas funding is not configured');
        sendJson(response, 200, await getDjukeGasQuote({ listener: requestUrl.searchParams.get('listener'), songId: requestUrl.searchParams.get('songId') }), '*');
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/payroll/ledger') {
        if (!getPaymentLedger) throw new Error('Payment ledger is not configured');
        sendJson(response, 200, await getPaymentLedger(), '*');
        return;
      }
      if (requestUrl.pathname === '/api/live-bookings/acknowledge' && request.method === 'POST') {
        if (!corsOrigin) throw new Error('Origin is not allowed');
        if (!liveBookings) { sendJson(response, 503, { error: 'Live bookings are not configured' }, '*'); return; }
        const body = await readJson(request);
        if (!/^0x[0-9a-fA-F]{40}$/.test(body.address || '') || typeof body.id !== 'string' ||
            typeof body.signature !== 'string' || body.signature.length > 1000) {
          throw new Error('Invalid performer acknowledgement');
        }
        sendJson(response, 200, await liveBookings.acknowledgePerformer({
          id: body.id, address: body.address, signature: body.signature,
        }), corsOrigin, 'no-store');
        return;
      }
      if (requestUrl.pathname === '/api/live-bookings' && ['GET', 'POST'].includes(request.method)) {
        if (!liveBookings) { sendJson(response, 503, { error: 'Live bookings are not configured' }, '*'); return; }
        if (request.method === 'GET') { sendJson(response, 200, await liveBookings.getState(), '*', 'no-store'); return; }
        if (!corsOrigin) throw new Error('Origin is not allowed');
        const body = await readJson(request);
        if (typeof body.signature !== 'string' || !Number.isFinite(Date.parse(body.issuedAt)) ||
            Math.abs(now() - Date.parse(body.issuedAt)) > MAX_SIGNATURE_AGE_MS || !body.command ||
            String(body.address || '').toLowerCase() !== expectedOwner) throw new Error('Invalid owner booking authorization');
        const message = liveAuthorization({ ...body, origin });
        if (verifyMessage(message, body.signature).toLowerCase() !== expectedOwner) throw new Error('Only the owner wallet may manage live bookings');
        if (hasConsumedSignature(body.signature)) throw new Error('Booking authorization already used; refresh before retry');
        consumedSignatures.set(body.signature, now() + MAX_SIGNATURE_AGE_MS);
        sendJson(response, 200, await liveBookings.execute(body.command), corsOrigin);
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/funds') {
        if (!getFunds) throw new Error('Fund balances are not configured');
        const funds = await getFunds();
        if (liveBookings && funds.funds?.['dbusk-live-performers']) {
          try {
            const live = await liveBookings.getState();
            funds.funds['dbusk-live-performers'] = { ...funds.funds['dbusk-live-performers'], bookings: live.bookings,
              escrowAddress: live.escrowAddress, description: live.notice,
              escrowTotals: live.escrowConfigured ? live.bookings.filter(b => b.mode === 'phase1').reduce((totals, b) => {
                totals.paidUnits = (BigInt(totals.paidUnits) + BigInt(b.paidUnits || 0)).toString();
                totals.refundedUnits = (BigInt(totals.refundedUnits) + BigInt(b.refundUnits || 0)).toString();
                const locked = b.status === 'funded' ? b.amountUnits : b.status === 'approved' ? b.approvedUnits : '0';
                totals.lockedUnits = (BigInt(totals.lockedUnits) + BigInt(locked || 0)).toString();
                return totals;
              }, { lockedUnits: '0', paidUnits: '0', refundedUnits: '0' }) : null };
          } catch (error) { funds.funds['dbusk-live-performers'].bookingError = error.message; }
        }
        sendJson(response, 200, funds, '*', 'public, max-age=60, stale-while-revalidate=30');
        return;
      }
      if (request.method === 'GET' && /^\/api\/funds\/[^/]+\/weeks$/.test(requestUrl.pathname)) {
        try {
          const fundSlug = decodeURIComponent(requestUrl.pathname.split('/')[3] || '');
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fundSlug)) {
            sendJson(response, 400, { error: 'Invalid fund slug' }, '*'); return;
          }
          if (!getFunds || !getWeeklyPayflow) {
            sendJson(response, 503, { error: 'Fund payout history is not configured' }, '*'); return;
          }
          const [funds, weekly] = await Promise.all([getFunds(), getWeeklyPayflow({})]);
          if (funds?.ready === false || weekly?.ready === false || funds?.lastError || weekly?.lastError) {
            sendJson(response, 503, { error: 'Fund payout history is still indexing; retry shortly' }, '*'); return;
          }
          const fund = funds?.funds?.[fundSlug];
          if (!fund) { sendJson(response, 404, { error: 'Unknown fund' }, '*'); return; }
          sendJson(response, 200, buildFundWeeklyArchive({ fundSlug, fund, weeklyPayflow: weekly }), '*', 'public, max-age=30, stale-while-revalidate=60');
        } catch {
          sendJson(response, 503, { error: 'Weekly fund archive unavailable; retry shortly' }, '*');
        }
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname.startsWith('/api/earnings/')) {
        if (!getEarnings) throw new Error('Earnings index is not configured');
        const address = requestUrl.pathname.split('/').pop();
        if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) throw new Error('Invalid wallet address');
        sendJson(response, 200, await getEarnings({ address }), '*', 'public, max-age=30, stale-while-revalidate=30');
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/rpc') {
        if (!corsOrigin) throw new Error('Origin is not allowed');
        if (!rpcProxy) throw new Error('RPC proxy is not configured');
        const ip = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim() || request.socket?.remoteAddress || 'unknown';
        const { status, body } = await rpcProxy.handle(await readJson(request), ip);
        sendJson(response, status, body, corsOrigin);
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/webhooks/alchemy') {
        if (!alchemyWebhook) { sendJson(response, 404, { error: 'Alchemy webhooks are not configured' }); return; }
        const { status, body } = alchemyWebhook.handle(await readRawBody(request),
          String(request.headers['x-alchemy-signature'] || ''));
        sendJson(response, status, body);
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/rpc-health') {
        if (!getRpcHealth) throw new Error('RPC routing is not configured');
        sendJson(response, 200, { ...getRpcHealth(), ...(alchemyWebhook ? { webhook: alchemyWebhook.health() } : {}) }, '*', 'no-store');
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname.startsWith('/api/ens/')) {
        if (!ensResolver) throw new Error('ENS lookups are not configured');
        const kind = requestUrl.pathname.slice('/api/ens/'.length);
        let lookup;
        if (kind === 'lookup') {
          const addresses = [...new Set(String(requestUrl.searchParams.get('addresses') || '').split(',')
            .map(value => value.trim().toLowerCase()).filter(Boolean))];
          if (!addresses.length || addresses.length > 25) throw new Error('Provide 1-25 comma-separated addresses');
          if (addresses.some(address => !/^0x[0-9a-f]{40}$/.test(address))) throw new Error('Invalid wallet address');
          lookup = async () => {
            const results = await Promise.all(addresses.map(address => ensResolver.lookupAddress(address)));
            return { results: Object.fromEntries(results.map(result => [result.address, result.name])) };
          };
        } else if (kind === 'resolve') {
          const name = requestUrl.searchParams.get('name');
          lookup = () => ensResolver.resolveName(name);
        } else if (kind === 'records') {
          const name = requestUrl.searchParams.get('name');
          lookup = () => ensResolver.records(name);
        } else {
          throw new Error('Unknown ENS route');
        }
        let data;
        try {
          data = await lookup();
        } catch (error) {
          if (/^Invalid /.test(error.message)) throw error;
          sendJson(response, 502, { error: 'ENS lookup unavailable' }, '*');
          return;
        }
        sendJson(response, 200, data, '*', 'public, max-age=300, stale-while-revalidate=600');
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/payroll/weekly') {
        if (!getWeeklyPayflow) throw new Error('Weekly payflow is not configured');
        const wallet = requestUrl.searchParams.get('wallet');
        if (wallet && !/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error('Invalid artist wallet');
        sendJson(response, 200, await getWeeklyPayflow({ wallet }), '*');
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/payroll/reconcile') {
        if (!corsOrigin) throw new Error('Origin is not allowed');
        if (!reconcilePayment) throw new Error('Payment reconciliation is not configured');
        const { txHash } = await readJson(request);
        if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || '')) throw new Error('Invalid payment transaction hash');
        const limit = paymentLimits.get(origin) || { count: 0, until: now() + 60_000 };
        if (limit.until <= now()) { limit.count = 0; limit.until = now() + 60_000; }
        if (++limit.count > 120) throw new Error('Payment reconciliation limit reached; retry shortly');
        paymentLimits.set(origin, limit);
        sendJson(response, 200, await reconcilePayment(txHash), corsOrigin);
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/radio/history') {
        if (!getRadioHistory) {
          sendJson(response, 404, { error: 'Radio history is not configured' }, '*');
          return;
        }
        const requestedWeeks = Number(requestUrl.searchParams.get('weeks') || 12);
        const weeks = Number.isFinite(requestedWeeks) ? Math.max(1, Math.min(52, Math.floor(requestedWeeks))) : 12;
        const wallet = requestUrl.searchParams.get('wallet');
        if (wallet && !/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error('Invalid wallet filter');
        const includeAllTime = requestUrl.searchParams.get('includeAllTime') === '1';
        const calendar = requestUrl.searchParams.get('calendar') === 'new-york' ? 'new-york' : undefined;
        sendJson(response, 200, { weeks: await getRadioHistory({ weeks, wallet, includeAllTime, ...(calendar ? { calendar } : {}) }) }, '*');
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/mint-queue/pending-count') {
        if (!getMintQueue) throw new Error('Mint queue is not configured');
        const requests = await getMintQueue();
        sendJson(response, 200, { count: Array.isArray(requests) ? requests.filter(item => item?.status !== 'completed' && item?.status !== 'rejected').length : 0 }, '*');
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/radio/vote') {
        if (!radioCorsOrigin) throw new Error('Origin is not allowed');
        if (!onRadioVote) throw new Error('Radio voting is not configured');
        const { playId, voterId, vote } = await readJson(request);
        sendJson(response, 200, await onRadioVote({ playId, voterId, vote }), radioCorsOrigin);
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/mint-queue') {
        if (!corsOrigin) throw new Error('Origin is not allowed');
        if (!getMintQueue) throw new Error('Mint queue is not configured');
        const body = await readJson(request);
        const { address, signature, issuedAt } = body;
        const issuedAtMs = Date.parse(issuedAt);
        if (!address || !signature || !Number.isFinite(issuedAtMs)) throw new Error('Incomplete admin authorization');
        if (Math.abs(now() - issuedAtMs) > MAX_SIGNATURE_AGE_MS) throw new Error('Admin authorization has expired');
        const message = buildAdminAuthorizationMessage({ address, origin, issuedAt });
        const recovered = verifyMessage(message, signature).toLowerCase();
        if (recovered !== address.toLowerCase() || recovered !== expectedOwner) {
          throw new Error('Admin authorization is not from the mint owner');
        }
        if (body.limit !== undefined || body.offset !== undefined) {
          catalogPage([], { offset: body.offset ?? 0, limit: body.limit ?? 20 }, 20);
        }
        const requests = await getMintQueue();
        if (body.limit === undefined && body.offset === undefined) {
          sendJson(response, 200, { requests }, corsOrigin);
        } else {
          const page = catalogPage(requests, { offset: body.offset ?? 0, limit: body.limit ?? 20 }, 20);
          sendJson(response, 200, { requests: page.items, total: page.total, nextOffset: page.nextOffset }, corsOrigin);
        }
        return;
      }
      if (requestUrl.pathname === '/api/artwork-update' && request.method === 'GET') {
        if (!artworkUpdateQueue) throw new Error('Artwork updates are not configured');
        const tokenId = requestUrl.searchParams.get('tokenId');
        const contractAddress = requestUrl.searchParams.get('contractAddress') || requestUrl.searchParams.get('contract');
        const requestItem = artworkUpdateQueue.getRequest({ tokenId, contractAddress });
        sendJson(response, 200, { request: requestItem || null }, '*');
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/artwork-update') {
        if (!corsOrigin) throw new Error('Origin is not allowed');
        if (!artworkUpdateQueue) throw new Error('Artwork updates are not configured');
        const body = await readJson(request);
        const issuedAt = Date.parse(body.issuedAt);
        const expiresAt = Date.parse(body.expiresAt);
        if (!/^0x[0-9a-fA-F]{40}$/.test(body.address || '') || typeof body.signature !== 'string' ||
            !/^0x[0-9a-fA-F]{40}$/.test(body.contractAddress || '') || !Number.isSafeInteger(Number(body.tokenId)) ||
            !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt || expiresAt - issuedAt > 15 * 60 * 1000 ||
            Math.abs(now() - issuedAt) > MAX_SIGNATURE_AGE_MS) {
          throw new Error('Invalid or expired artwork update authorization');
        }
        if (hasConsumedSignature(body.signature)) throw new Error('Artwork update authorization has already been used');
        if (typeof body.artworkCid !== 'string') throw new Error('Invalid artwork CID');
        const message = buildArtworkUpdateAuthorizationMessage({
          address: body.address,
          origin,
          chainId: Number(body.chainId || 8453),
          contractAddress: body.contractAddress,
          tokenId: Number(body.tokenId),
          artworkCid: body.artworkCid,
          nonce: body.nonce,
          issuedAt: body.issuedAt,
          expiresAt: body.expiresAt,
        });
        const recovered = verifyMessage(message, body.signature).toLowerCase();
        if (recovered !== body.address.toLowerCase()) throw new Error('Artwork update signature mismatch: check the connected signing wallet and client/worker message format');
        const artworkCid = normalizeMediaCid(body.artworkCid);
        const contract = new Contract(body.contractAddress, NFT_ARTWORK_ABI, rpcProvider || new JsonRpcProvider(rpcUrl));
        const creator = String(await contract.creatorOf(Number(body.tokenId)).catch(() => '') || '').toLowerCase();
        if (!creator || creator !== body.address.toLowerCase()) throw new Error('Only the token creator can request artwork changes');
        const currentUri = await contract.uri(Number(body.tokenId));
        const currentMetadata = await fetchMintMetadata(currentUri, fetchImpl, { attempts: 3 });
        const newMetadata = buildArtworkUpdateMetadata(currentMetadata, `ipfs://${artworkCid}`);
        const newMetadataUri = await uploadToIPFS(
          Buffer.from(JSON.stringify(newMetadata, null, 2)),
          `token-${body.tokenId}-artwork.json`,
          'application/json',
          { provider: pinataJwt ? 'pinata' : 'local', pinataJwt, pinataApiUrl, ipfsApiUrl, fetchImpl },
        );
        const requestRecord = await artworkUpdateQueue.queueRequest({
          requestType: 'artwork-update',
          title: String(newMetadata.name || newMetadata.title || `Token #${body.tokenId}`),
          tokenId: Number(body.tokenId),
          chainId: Number(body.chainId || 8453),
          contractAddress: body.contractAddress,
          creator: body.address,
          requestedAt: new Date().toISOString(),
          oldUri: currentUri,
          oldImageUri: String(currentMetadata.image || ''),
          newImageCid: artworkCid,
          newImageUri: `ipfs://${artworkCid}`,
          metadataUri: newMetadataUri,
          currentMetadata: currentMetadata,
        });
        consumedSignatures.set(body.signature, now() + MAX_SIGNATURE_AGE_MS);
        sendJson(response, 200, { request: requestRecord, pending: artworkUpdateQueue.getPendingCount() }, corsOrigin);
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/artwork-update-complete') {
        if (!corsOrigin) throw new Error('Origin is not allowed');
        if (!artworkUpdateQueue || !verifyArtworkUpdateTransaction) throw new Error('Artwork update reconciliation is not configured');
        const body = await readJson(request);
        const issuedAt = Date.parse(body.issuedAt);
        if (!/^0x[0-9a-fA-F]{40}$/.test(body.address || '') || typeof body.signature !== 'string' ||
            !Number.isFinite(issuedAt) || Math.abs(now() - issuedAt) > MAX_SIGNATURE_AGE_MS ||
            !body.requestId || !/^0x[0-9a-fA-F]{64}$/.test(String(body.txHash || ''))) {
          throw new Error('Invalid artwork update completion payload');
        }
        if (hasConsumedSignature(body.signature)) throw new Error('Artwork update completion authorization has already been used');
        const message = buildAdminAuthorizationMessage({ address: body.address, origin, issuedAt: body.issuedAt });
        const recovered = verifyMessage(message, body.signature).toLowerCase();
        if (recovered !== body.address.toLowerCase() || recovered !== expectedOwner) {
          throw new Error('Artwork update completion authorization is not from the configured owner');
        }
        const requestItem = artworkUpdateQueue.getRequest({ requestId: body.requestId });
        if (!requestItem) throw new Error('Artwork update request not found');
        const verified = await verifyArtworkUpdateTransaction({
          tokenId: requestItem.tokenId,
          txHash: body.txHash,
          expectedUri: requestItem.metadataUri,
        });
        consumedSignatures.set(body.signature, now() + MAX_SIGNATURE_AGE_MS);
        sendJson(response, 200, await artworkUpdateQueue.completeRequest(requestItem.requestId, {
          txHash: verified.txHash,
          metadataUri: verified.metadataUri,
        }), corsOrigin);
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/artwork-update-reject') {
        if (!corsOrigin) throw new Error('Origin is not allowed');
        if (!artworkUpdateQueue) throw new Error('Artwork update reconciliation is not configured');
        const body = await readJson(request);
        const issuedAt = Date.parse(body.issuedAt);
        if (!/^0x[0-9a-fA-F]{40}$/.test(body.address || '') || typeof body.signature !== 'string' ||
            !Number.isFinite(issuedAt) || Math.abs(now() - issuedAt) > MAX_SIGNATURE_AGE_MS || !body.requestId) {
          throw new Error('Invalid artwork update rejection payload');
        }
        if (hasConsumedSignature(body.signature)) throw new Error('Artwork update rejection authorization has already been used');
        const message = buildAdminAuthorizationMessage({ address: body.address, origin, issuedAt: body.issuedAt });
        const recovered = verifyMessage(message, body.signature).toLowerCase();
        if (recovered !== body.address.toLowerCase() || recovered !== expectedOwner) {
          throw new Error('Artwork update rejection authorization is not from the configured owner');
        }
        consumedSignatures.set(body.signature, now() + MAX_SIGNATURE_AGE_MS);
        sendJson(response, 200, await artworkUpdateQueue.rejectRequest(body.requestId, body.reason || 'rejected'), corsOrigin);
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/admin/reviewed-album-import') {
        if (!corsOrigin) throw new Error('Origin is not allowed');
        if (!onReviewedAlbumImport) throw new Error('Reviewed album import is not configured');
        const body = await readJson(request);
        const issuedAt = Date.parse(body.issuedAt);
        if (!/^0x[0-9a-fA-F]{40}$/.test(body.address || '') || typeof body.signature !== 'string' ||
            !Number.isFinite(issuedAt) || Math.abs(now() - issuedAt) > MAX_SIGNATURE_AGE_MS) {
          throw new Error('Invalid or expired album-import authorization');
        }
        if (hasConsumedSignature(body.signature)) throw new Error('Album-import authorization has already been used');
        const message = buildReviewedAlbumImportAuthorizationMessage({ address: body.address, origin, issuedAt: body.issuedAt });
        const recovered = verifyMessage(message, body.signature).toLowerCase();
        if (recovered !== body.address.toLowerCase() || recovered !== expectedOwner) throw new Error('Album-import authorization is not from the configured owner');
        consumedSignatures.set(body.signature, now() + MAX_SIGNATURE_AGE_MS);
        sendJson(response, 200, await onReviewedAlbumImport(), corsOrigin);
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/media/submit') {
        if (!corsOrigin) throw new Error('Origin is not allowed');
        if (!onMediaSubmission) throw new Error('Media submissions are not configured');
        const body = await readJson(request);
        const { address, signature, issuedAt, title, artist, mediaType, filename, recipient,
          artworkCid = '', tipWallet = '', parentTokenId = 0, isDevertAd = false } = body;
        if (!/^0x[0-9a-fA-F]{40}$/.test(address || '') || !signature ||
            !Number.isFinite(Date.parse(issuedAt)) || Math.abs(now() - Date.parse(issuedAt)) > MAX_SIGNATURE_AGE_MS) {
          throw new Error('Invalid or expired submission authorization');
        }
        if (typeof title !== 'string' || !title.trim() || title.length > 120 ||
            typeof artist !== 'string' || !artist.trim() || artist.length > 80 ||
            typeof filename !== 'string' || filename.length > 160 || /[\/\\\r\n]/.test(filename) ||
            !Object.values(MEDIA_TYPES).includes(mediaType) || mediaTypeFor(filename) !== mediaType) throw new Error('Invalid media details');
        if (!/^0x[0-9a-fA-F]{40}$/.test(recipient || '') ||
            (address.toLowerCase() !== expectedOwner && recipient.toLowerCase() !== address.toLowerCase())) {
          throw new Error('Artists must submit to their own connected wallet');
        }
        if ((tipWallet && !/^0x[0-9a-fA-F]{40}$/.test(tipWallet)) ||
          !Number.isSafeInteger(parentTokenId) || parentTokenId < 0 || typeof isDevertAd !== 'boolean') throw new Error('Invalid tip wallet or parent token');
        const ipfsCid = normalizeMediaCid(body.ipfsCid);
        const creatorSplits = validateCreatorSplits(body.creatorSplits, recipient);
        if (artworkCid) normalizeMediaCid(artworkCid);
        const recovered = verifyMessage(buildSubmissionAuthorizationMessage({ ...body, origin }), signature).toLowerCase();
        if (recovered !== address.toLowerCase()) throw new Error('Submission signature does not match the artist wallet');
        if (hasConsumedSignature(signature)) throw new Error('Submission authorization has already been used');
        limitArtist(address);
        consumedSignatures.set(signature, now() + MAX_SIGNATURE_AGE_MS);
        try {
          const track = await onMediaSubmission({ address, title: title.trim(), artist: artist.trim(), ipfsCid,
            mediaType, filename, recipient, artworkCid: artworkCid ? normalizeMediaCid(artworkCid) : '', tipWallet, parentTokenId, isDevertAd, creatorSplits });
          sendJson(response, 200, { trackId: track.trackId, status: track.mintStatus }, corsOrigin);
        } catch (error) {
          consumedSignatures.delete(signature);
          throw error;
        }
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/mint-complete') {
        if (!corsOrigin) throw new Error('Origin is not allowed');
        if (!verifyMintTransaction || !onMintComplete) throw new Error('Mint reconciliation is not configured');
        const body = await readJson(request);
        const { trackId, tokenId, txHash } = body;
        if (!trackId || !/^\d+$/.test(String(tokenId)) || !/^0x[0-9a-fA-F]{64}$/.test(String(txHash))) {
          throw new Error('Invalid mint completion payload');
        }
        const verified = await verifyMintTransaction({ tokenId: String(tokenId), txHash });
        await onMintComplete({ trackId, tokenId: String(tokenId), txHash, recipient: verified.recipient,
          contractAddress: verified.contractAddress });
        sendJson(response, 200, { ok: true }, corsOrigin);
        return;
      }
      const artistUpload = requestUrl.pathname === '/api/ipfs/submission-upload-url';
      const batchUpload = requestUrl.pathname === '/api/ipfs/upload-batch-urls';
      if (request.method !== 'POST' || (!artistUpload && !batchUpload && requestUrl.pathname !== '/api/ipfs/upload-url')) {
        sendJson(response, 404, { error: 'Not found' }, corsOrigin);
        return;
      }
      if (!corsOrigin) {
        sendCorsError(response, origin, 'This site address isn’t authorized for uploads');
        return;
      }

      const body = await readJson(request);
      if (batchUpload) {
        const { address, signature, origin: signedOrigin, issuedAt, files } = body;
        if (!/^0x[0-9a-fA-F]{40}$/.test(address || '') || !signature || signedOrigin !== origin ||
            !Array.isArray(files) || files.length < 1 || files.length > 20) {
          throw new Error('Incomplete metadata batch authorization');
        }
        if (files.some(file => !file || typeof file.name !== 'string' || !file.name || file.name.length > 160 ||
            !Number.isInteger(file.size) || file.size < 1 || file.size > MAX_UPLOAD_BYTES || file.type !== 'application/json')) {
          throw new Error('Metadata batch must contain valid JSON files no larger than 250 MB');
        }
        const issuedAtMs = Date.parse(issuedAt);
        if (!Number.isFinite(issuedAtMs) || Math.abs(now() - issuedAtMs) > MAX_UPLOAD_SIGNATURE_AGE_MS) {
          throw new Error('Upload authorization has expired');
        }
        const recovered = verifyMessage(buildUploadBatchAuthorizationMessage({ address, origin: signedOrigin, issuedAt, files }), signature).toLowerCase();
        if (recovered !== expectedOwner) throw new Error('Upload authorization is not from the mint owner');
        if (hasConsumedSignature(signature)) throw new Error('Upload authorization has already been used');
        consumedSignatures.set(signature, now() + MAX_SIGNATURE_AGE_MS);
        const urls = await Promise.all(files.map(file => requestPinataSignedUrl({
          pinataJwt, pinataSignUrl, ...file, fetchImpl,
        })));
        sendJson(response, 200, { urls }, corsOrigin);
        return;
      }
      const { address, signature, name, size, type, issuedAt } = body;
      if (!/^0x[0-9a-fA-F]{40}$/.test(address || '') || !signature || typeof name !== 'string' || !name || name.length > 160 || typeof type !== 'string' || !issuedAt) throw new Error('Incomplete upload authorization');
      if (!Number.isInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES) throw new Error('Invalid upload size');
      if (!['application/json', 'video/mp4'].includes(type) && !type.startsWith('audio/') && !type.startsWith('image/')) {
        throw new Error('Unsupported upload type');
      }
      if (artistUpload && !Object.values(MEDIA_TYPES).includes(type) && !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)) {
        throw new Error('Artist uploads must be supported audio, MP4, or artwork');
      }
      const issuedAtMs = Date.parse(issuedAt);
      if (!Number.isFinite(issuedAtMs) || Math.abs(now() - issuedAtMs) > MAX_UPLOAD_SIGNATURE_AGE_MS) {
        throw new Error('Upload authorization has expired');
      }

      const message = buildUploadAuthorizationMessage({ address, origin, name, size, type, issuedAt, purpose: artistUpload ? 'submission' : undefined });
      const recovered = verifyMessage(message, signature).toLowerCase();
      if (recovered !== address.toLowerCase() || (!artistUpload && recovered !== expectedOwner)) {
        throw new Error('Upload authorization is not from the mint owner');
      }
      if (hasConsumedSignature(signature)) throw new Error('Upload authorization has already been used');
      if (artistUpload) limitArtist(address);
      consumedSignatures.set(signature, now() + MAX_SIGNATURE_AGE_MS);

      const url = await requestPinataSignedUrl({
        pinataJwt,
        pinataSignUrl,
        name,
        size,
        type,
        fetchImpl,
      });
      sendJson(response, 200, { url }, corsOrigin);
    } catch (error) {
      sendJson(response, 400, { error: error.message },
        requestUrl.pathname === '/api/radio/vote' ? radioCorsOrigin : corsOrigin);
    }
  };
}
