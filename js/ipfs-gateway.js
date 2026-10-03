const FALLBACK_GATEWAYS = [
  'https://gateway.pinata.cloud/ipfs/',
  'https://peach-fast-pike-16.mypinata.cloud/ipfs/',
];

function gatewayUrl(gateway, cid) {
  const base = gateway.replace(/\/$/, '');
  return `${base}${base.endsWith('/ipfs') ? '' : '/ipfs'}/${cid}`;
}

export function buildIpfsGatewayUrls(uri, primaryGateway) {
  if (!uri?.startsWith('ipfs://')) return uri ? [uri] : [];
  const cid = uri.slice('ipfs://'.length);
  return [...new Set([primaryGateway, ...FALLBACK_GATEWAYS].filter(Boolean).map((gateway) => gatewayUrl(gateway, cid)))];
}

export async function fetchIpfsJson(uri, { primaryGateway, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const urls = buildIpfsGatewayUrls(uri, primaryGateway);
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) continue;
      return await response.json();
    } catch (_) {}
  }
  return null;
}
