import { Interface, JsonRpcProvider, verifyMessage } from 'ethers';
import { MEDIA_TYPES, mediaTypeFor, normalizeMediaCid, buildSubmissionAuthorizationMessage } from './media.js';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const SIGNED_UPLOAD_OVERHEAD_BYTES = 64 * 1024;
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;
const MINT_EVENT_ABI = [
  'event EditionMinted(uint256 indexed tokenId, address indexed to, uint256 amount, address indexed minter)',
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

export function buildAdminAuthorizationMessage({ address, origin, issuedAt }) {
  return [
    'DecentBusking admin mint queue',
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

function sendJson(response, status, body, corsOrigin = '') {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...(corsOrigin ? { 'access-control-allow-origin': corsOrigin, vary: 'origin' } : {}),
  });
  response.end(JSON.stringify(body));
}

export async function requestPinataSignedUrl({ pinataJwt, pinataSignUrl, name, size, type, fetchImpl = fetch }) {
  const response = await fetchImpl(pinataSignUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${pinataJwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      network: 'public',
      date: Math.floor(Date.now() / 1000),
      expires: 60,
      max_file_size: size + SIGNED_UPLOAD_OVERHEAD_BYTES,
      allow_mime_types: [type],
      filename: name,
    }),
  });
  if (!response.ok) throw new Error(`Pinata signing failed (${response.status})`);
  const result = await response.json();
  const url = result.data || result.url;
  if (!url) throw new Error('Pinata did not return a signed upload URL');
  return url;
}

export function createMintTransactionVerifier({ rpcUrl, contractAddress, ownerWallet, provider }) {
  const rpcProvider = provider || new JsonRpcProvider(rpcUrl);
  const contract = contractAddress.toLowerCase();
  const owner = ownerWallet.toLowerCase();
  const iface = new Interface(MINT_EVENT_ABI);

  return async function verifyMint({ tokenId, txHash }) {
    const [transaction, receipt] = await Promise.all([
      rpcProvider.getTransaction(txHash),
      rpcProvider.getTransactionReceipt(txHash),
    ]);
    if (!transaction || !receipt || receipt.status !== 1) throw new Error('Mint transaction is not confirmed');
    // Smart accounts (EIP-7702) route through delegation contracts, so trust DecentNFT's own event, not tx.to/from.

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== contract) continue;
      try {
        const event = iface.parseLog(log);
        if (event?.name === 'EditionMinted' && event.args.tokenId.toString() === String(tokenId)) {
          if (event.args.minter.toLowerCase() !== owner) throw new Error('Edition was not minted by the configured owner');
          return { recipient: event.args.to, amount: event.args.amount.toString() };
        }
      } catch (error) {
        if (error.message.includes('configured owner')) throw error;
      }
    }
    throw new Error('Mint transaction does not contain the claimed EditionMinted event');
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
  getRadioState,
  getRadioHistory,
  onRadioVote,
  onMediaSubmission,
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
      if (request.method === 'OPTIONS') {
        response.writeHead(corsOrigin ? 204 : 403, {
          ...(corsOrigin ? { 'access-control-allow-origin': corsOrigin, vary: 'origin' } : {}),
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        });
        response.end();
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/health') {
        sendJson(response, 200, { ok: true, ipfsProvider: pinataJwt ? 'pinata' : 'unconfigured' }, '*');
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
        sendJson(response, 200, { weeks: await getRadioHistory({ weeks, wallet, includeAllTime }) }, '*');
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
        sendJson(response, 200, { requests: await getMintQueue() }, corsOrigin);
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/media/submit') {
        if (!corsOrigin) throw new Error('Origin is not allowed');
        if (!onMediaSubmission) throw new Error('Media submissions are not configured');
        const body = await readJson(request);
        const { address, signature, issuedAt, title, artist, mediaType, filename, recipient,
          artworkCid = '', tipWallet = '', parentTokenId = 0 } = body;
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
            !Number.isSafeInteger(parentTokenId) || parentTokenId < 0) throw new Error('Invalid tip wallet or parent token');
        const ipfsCid = normalizeMediaCid(body.ipfsCid);
        if (artworkCid) normalizeMediaCid(artworkCid);
        const recovered = verifyMessage(buildSubmissionAuthorizationMessage({ ...body, origin }), signature).toLowerCase();
        if (recovered !== address.toLowerCase()) throw new Error('Submission signature does not match the artist wallet');
        if (hasConsumedSignature(signature)) throw new Error('Submission authorization has already been used');
        limitArtist(address);
        consumedSignatures.set(signature, now() + MAX_SIGNATURE_AGE_MS);
        try {
          const track = await onMediaSubmission({ address, title: title.trim(), artist: artist.trim(), ipfsCid,
            mediaType, filename, recipient, artworkCid: artworkCid ? normalizeMediaCid(artworkCid) : '', tipWallet, parentTokenId });
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
        await onMintComplete({ trackId, tokenId: String(tokenId), txHash, recipient: verified.recipient });
        sendJson(response, 200, { ok: true }, corsOrigin);
        return;
      }
      const artistUpload = requestUrl.pathname === '/api/ipfs/submission-upload-url';
      if (request.method !== 'POST' || (!artistUpload && requestUrl.pathname !== '/api/ipfs/upload-url')) {
        sendJson(response, 404, { error: 'Not found' }, corsOrigin);
        return;
      }
      if (!corsOrigin) throw new Error('Origin is not allowed');

      const body = await readJson(request);
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
      if (!Number.isFinite(issuedAtMs) || Math.abs(now() - issuedAtMs) > MAX_SIGNATURE_AGE_MS) {
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