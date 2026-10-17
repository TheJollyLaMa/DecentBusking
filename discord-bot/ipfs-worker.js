import { Contract, Interface, JsonRpcProvider, verifyMessage } from 'ethers';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MEDIA_TYPES, mediaTypeFor, normalizeMediaCid, buildSubmissionAuthorizationMessage } from './media.js';
import { validateLivePerformanceSchedule, validateWeeklyScheduleOverrides } from '../js/radio-schedule.mjs';
import { buildFundWeeklyArchive } from '../js/fund-archive.mjs';
import { catalogPage } from '../js/nft-loader.js';
import { uploadToIPFS } from './ipfs.js';
import { readRawBody } from './alchemy-webhook.js';
import { fetchMintMetadata } from './mint-sync.js';
import { buildArtworkUpdateAuthorizationMessage, buildArtworkUpdateMetadata } from '../js/artwork-update.mjs';
import { buildDevertRemovalMessage } from '../js/devert-campaigns.mjs';

const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
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
  getRadioSchedule,
  saveRadioSchedule,
  getDjukeState,
  getDjukeGasQuote,
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
  getEarnings,
  getDjukeTopEarners,
  ensResolver,
  reconcilePayment,
  onRadioVote,
  onMediaSubmission,
  artworkUpdateQueue,
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
  const paymentLimits = new Map();
  function limitArtist(address) {
    const time = now();
    for (const [key, entry] of artistLimits) {
      if (entry.until <= time) artistLimits.delete(key);
    }
    const key = address.toLowerCase();
    const entry = artistLimits.get(key) || { count: 0, until: time + 60 * 60 * 1000 };
    if (entry.count >= 20 || (!artistLimits.has(key) && artistLimits.size >= 2000)) {
      throw new Error('Artist submission limit reached; try again later');
    }
    entry.count++;
    artistLimits.set(key, entry);
  }

  return async function handleRequest(request, response) {
    const requestUrl = new URL(request.url, 'http://localhost');
    const origin = String(request.headers.origin || '');
    const corsOrigin = origins.has(origin) ? origin : '';

    try {
      if (request.method === 'POST' && ['/api/checkpoint-mirror/claim', '/api/checkpoint-mirror/ack'].includes(requestUrl.pathname)) {
        if (!checkpointMirror) { sendJson(response, 404, { error: 'Checkpoint mirroring is not configured' }); return; }
        const authorization = String(request.headers.authorization || '');
        checkpointMirror.authorize(authorization);
        const result = requestUrl.pathname.endsWith('/claim')
          ? { job: checkpointMirror.claim(authorization) }
          : checkpointMirror.acknowledge(authorization, await readJson(request));
        sendJson(response, 200, result);
        return;
      }
      const uploadRoute = requestUrl.pathname === '/api/ipfs/upload-url' ||
        requestUrl.pathname === '/api/ipfs/submission-upload-url' ||
        requestUrl.pathname === '/api/ipfs/upload-batch-urls';
      if (request.method === 'OPTIONS') {
        response.writeHead(uploadRoute ? 204 : (corsOrigin ? 204 : 403), {
          ...(uploadRoute || corsOrigin ? { 'access-control-allow-origin': corsOrigin || origin || '*', vary: 'origin' } : {}),
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
      if (requestUrl.pathname === '/api/creator/profile' && request.method === 'GET') {
        if (!creatorProfiles) throw new Error('Creator profiles are not configured');
        sendJson(response, 200, creatorProfiles.get(requestUrl.searchParams.get('address')), '*');
        return;
      }
      if (request.method === 'POST' && ['/api/creator/profile', '/api/creator/link-discord', '/api/creator/watchlist'].includes(requestUrl.pathname)) {
        if (!corsOrigin) throw new Error('Origin is not allowed');
        if (!creatorProfiles) throw new Error('Creator profiles are not configured');
        const body = await readJson(request);
        const result = requestUrl.pathname.endsWith('link-discord')
          ? creatorProfiles.startLink(body, origin)
          : requestUrl.pathname.endsWith('watchlist')
            ? await creatorProfiles.updateWatchlist(body, origin)
            : await creatorProfiles.update(body, origin);
        sendJson(response, 200, result, corsOrigin);
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
          if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
          else response.end();
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
          before: params.get('before') || '',
          after: params.get('after') || '',
        }), '*');
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
      if (request.method === 'GET' && requestUrl.pathname === '/api/funds') {
        if (!getFunds) throw new Error('Fund balances are not configured');
        sendJson(response, 200, await getFunds(), '*', 'public, max-age=60, stale-while-revalidate=30');
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
        if (!corsOrigin) throw new Error('Origin is not allowed');
        if (!onRadioVote) throw new Error('Radio voting is not configured');
        const { playId, voterId, vote } = await readJson(request);
        sendJson(response, 200, await onRadioVote({ playId, voterId, vote }), corsOrigin);
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
        if (artworkCid) normalizeMediaCid(artworkCid);
        const recovered = verifyMessage(buildSubmissionAuthorizationMessage({ ...body, origin }), signature).toLowerCase();
        if (recovered !== address.toLowerCase()) throw new Error('Submission signature does not match the artist wallet');
        if (hasConsumedSignature(signature)) throw new Error('Submission authorization has already been used');
        limitArtist(address);
        consumedSignatures.set(signature, now() + MAX_SIGNATURE_AGE_MS);
        try {
          const track = await onMediaSubmission({ address, title: title.trim(), artist: artist.trim(), ipfsCid,
            mediaType, filename, recipient, artworkCid: artworkCid ? normalizeMediaCid(artworkCid) : '', tipWallet, parentTokenId, isDevertAd });
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
      sendJson(response, 400, { error: error.message }, corsOrigin);
    }
  };
}
