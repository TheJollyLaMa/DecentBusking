import { verifyMessage } from 'ethers';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

export function buildUploadAuthorizationMessage({ address, origin, name, size, type, issuedAt }) {
  return [
    'DecentBusking IPFS upload authorization',
    `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`,
    `File: ${name}`,
    `Size: ${size}`,
    `Type: ${type}`,
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
      max_file_size: size,
      mime_types: [type],
      filename: name,
    }),
  });
  if (!response.ok) throw new Error(`Pinata signing failed (${response.status})`);
  const result = await response.json();
  const url = result.data || result.url;
  if (!url) throw new Error('Pinata did not return a signed upload URL');
  return url;
}

export function createWorkerRequestHandler({
  allowedOrigins,
  ownerWallet,
  pinataJwt,
  pinataSignUrl = 'https://uploads.pinata.cloud/v3/files/sign',
  fetchImpl = fetch,
  now = () => Date.now(),
}) {
  const origins = new Set(allowedOrigins);
  const expectedOwner = ownerWallet.toLowerCase();
  const consumedSignatures = new Set();

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
        sendJson(response, 200, { ok: true, ipfsProvider: pinataJwt ? 'pinata' : 'unconfigured' });
        return;
      }
      if (request.method !== 'POST' || requestUrl.pathname !== '/api/ipfs/upload-url') {
        sendJson(response, 404, { error: 'Not found' }, corsOrigin);
        return;
      }
      if (!corsOrigin) throw new Error('Origin is not allowed');

      const body = await readJson(request);
      const { address, signature, name, size, type, issuedAt } = body;
      if (!address || !signature || !name || !type || !issuedAt) throw new Error('Incomplete upload authorization');
      if (!Number.isInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES) throw new Error('Invalid upload size');
      if (!['application/json'].includes(type) && !type.startsWith('audio/') && !type.startsWith('image/')) {
        throw new Error('Unsupported upload type');
      }
      const issuedAtMs = Date.parse(issuedAt);
      if (!Number.isFinite(issuedAtMs) || Math.abs(now() - issuedAtMs) > MAX_SIGNATURE_AGE_MS) {
        throw new Error('Upload authorization has expired');
      }

      const message = buildUploadAuthorizationMessage({ address, origin, name, size, type, issuedAt });
      const recovered = verifyMessage(message, signature).toLowerCase();
      if (recovered !== address.toLowerCase() || recovered !== expectedOwner) {
        throw new Error('Upload authorization is not from the mint owner');
      }
      if (consumedSignatures.has(signature)) throw new Error('Upload authorization has already been used');
      consumedSignatures.add(signature);

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