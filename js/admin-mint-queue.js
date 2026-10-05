export function buildAdminAuthorizationMessage({ address, origin, issuedAt }) {
  return [
    'DecentBusking admin mint queue',
    `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

let cachedAuthorization = null;
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
