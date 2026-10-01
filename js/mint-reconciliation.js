export async function reportMintCompletion({ serviceUrl, trackId, tokenId, txHash, fetchImpl = globalThis.fetch }) {
  if (!serviceUrl || !trackId) return false;
  const response = await fetchImpl(`${serviceUrl.replace(/\/$/, '')}/api/mint-complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ trackId, tokenId: String(tokenId), txHash }),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `Mint reconciliation failed (${response.status})`);
  }
  return true;
}
