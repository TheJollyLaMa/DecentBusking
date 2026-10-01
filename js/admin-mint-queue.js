export function buildAdminAuthorizationMessage({ address, origin, issuedAt }) {
  return [
    'DecentBusking admin mint queue',
    `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

export async function fetchMintQueue({ serviceUrl, signer, address, origin, fetchImpl = globalThis.fetch }) {
  if (!serviceUrl) throw new Error('The Render worker URL is not configured');
  const issuedAt = new Date().toISOString();
  const authorization = { address, origin, issuedAt };
  const signature = await signer.signMessage(buildAdminAuthorizationMessage(authorization));
  const response = await fetchImpl(`${serviceUrl.replace(/\/$/, '')}/api/mint-queue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...authorization, signature }),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `Mint queue request failed (${response.status})`);
  }
  const result = await response.json();
  return Array.isArray(result.requests) ? result.requests : [];
}
