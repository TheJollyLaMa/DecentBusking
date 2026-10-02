import { Interface, JsonRpcProvider, verifyMessage } from 'ethers';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;
const MINT_EVENT_ABI = [
  'event EditionMinted(uint256 indexed tokenId, address indexed to, uint256 amount, address indexed minter)',
];

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