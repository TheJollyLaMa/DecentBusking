export function buildAdminAuthorizationMessage({ address, origin, issuedAt }) {
  return [
    'DecentBusking admin mint queue',
    `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

let cachedAuthorization = null;
const MAX_ARTWORK_BYTES = 10 * 1024 * 1024;

export async function resolveMintArtwork({ file, cid = '', defaultCid = '', serviceUrl, upload, fetchImpl = globalThis.fetch }) {
  const value = cid.trim();
  if (file && value) throw new Error('Choose one artwork source: a file up to 10 MB, or an image/GIF CID');
  if (file) {
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_ARTWORK_BYTES || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
      throw new Error('Artwork must be PNG, JPEG, WebP, or GIF up to 10 MB; use a CID for a larger image');
    }
    return upload(file);
  }
  if (value) {
    if (!serviceUrl) throw new Error('Artwork CID validation service is not configured');
    const response = await fetchImpl(`${serviceUrl.replace(/\/$/, '')}/api/ipfs/artwork-cid?${new URLSearchParams({ cid: value })}`, { signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    if (!response.ok || !result.cid) throw new Error(result.error || 'Enter an image file CID or ipfs://CID');
    return `ipfs://${result.cid}`;
  }
  if (!defaultCid) throw new Error('No default artwork is available; choose a file or artwork CID before minting');
  return `ipfs://${defaultCid}`;
}
const AUTHORIZATION_REUSE_MS = 4 * 60 * 1000;

export function clearMintQueueAuthorization() {
  cachedAuthorization = null;
}

export async function fetchMintQueue({ serviceUrl, signer, address, origin, fetchImpl = globalThis.fetch, now = Date.now }) {
  if (!serviceUrl) throw new Error('The Render worker URL is not configured');
  if (!signer || !address) throw new Error('Connect your wallet before loading the mint queue');
  const endpoint = `${serviceUrl.replace(/\/$/, '')}/api/mint-queue`;
  const key = JSON.stringify([endpoint, address.toLowerCase(), origin]);
  if (!cachedAuthorization || cachedAuthorization.key !== key || cachedAuthorization.signer !== signer || cachedAuthorization.expiresAt <= now()) {
    const issuedAt = new Date(now()).toISOString();
    const authorization = { address, origin, issuedAt };
    cachedAuthorization = { key, signer, authorization, expiresAt: now() + AUTHORIZATION_REUSE_MS,
      signature: Promise.resolve().then(() => signer.signMessage(buildAdminAuthorizationMessage(authorization))) };
  }
  const session = cachedAuthorization;
  let signature;
  try {
    signature = await session.signature;
  } catch (error) {
    if (cachedAuthorization === session) clearMintQueueAuthorization();
    throw error;
  }
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...session.authorization, signature }),
  });
  if (!response.ok) {
    if (cachedAuthorization === session) clearMintQueueAuthorization();
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `Mint queue request failed (${response.status})`);
  }
  const result = await response.json();
  return Array.isArray(result.requests) ? result.requests : [];
}
