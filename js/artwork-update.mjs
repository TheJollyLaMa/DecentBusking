const MAX_ARTWORK_BYTES = 10 * 1024 * 1024;
const ACCEPTED_ARTWORK_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export function buildArtworkUpdateAuthorizationMessage({
  address, origin, chainId = 8453, contractAddress, tokenId, artworkCid, nonce, issuedAt, expiresAt,
}) {
  return [
    'DecentBusking artwork update request',
    `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`,
    `Chain ID: ${chainId}`,
    `Contract: ${contractAddress.toLowerCase()}`,
    `Token ID: ${String(tokenId)}`,
    `Artwork CID: ${artworkCid}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expires At: ${expiresAt}`,
  ].join('\n');
}

export function buildArtworkUpdateMetadata(metadata = {}, imageUri) {
  return { ...metadata, image: imageUri };
}

export function canEditArtwork(nft = {}, walletAddress = '', linkedWallet = '') {
  const creator = String(nft.creator || nft.artist || '').toLowerCase();
  const wallet = String(walletAddress || '').toLowerCase();
  const linked = String(linkedWallet || '').toLowerCase();
  return !!creator && (creator === wallet || creator === linked);
}

export function validateArtworkFile(file) {
  if (!file) throw new Error('Choose a PNG, JPEG, WebP, or GIF file up to 10 MB');
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_ARTWORK_BYTES || !ACCEPTED_ARTWORK_TYPES.includes(file.type)) {
    throw new Error('Artwork must be PNG, JPEG, WebP, or GIF up to 10 MB');
  }
}

export async function submitArtworkUpdateRequest({
  serviceUrl,
  signer,
  address,
  origin,
  request,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
}) {
  if (!serviceUrl || !signer || !address) throw new Error('Connect the creator wallet before updating artwork');
  const issuedAt = new Date(now()).toISOString();
  const expiresAt = new Date(now() + 5 * 60 * 1000).toISOString();
  const payload = {
    address,
    origin,
    issuedAt,
    expiresAt,
    nonce: crypto.randomUUID(),
    chainId: Number(request.chainId || 8453),
    contractAddress: request.contractAddress,
    tokenId: Number(request.tokenId),
    artworkCid: request.artworkCid,
  };
  const signature = await signer.signMessage(buildArtworkUpdateAuthorizationMessage(payload));
  const response = await fetchImpl(`${serviceUrl.replace(/\/$/, '')}/api/artwork-update`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, signature }),
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Artwork update request failed (${response.status})`);
  return result;
}

export async function completeArtworkUpdateRequest({
  serviceUrl,
  signer,
  address,
  origin,
  requestId,
  txHash,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
}) {
  const issuedAt = new Date(now()).toISOString();
  const authorization = { address, origin, issuedAt };
  const signature = await signer.signMessage([
    'DecentBusking admin mint queue',
    `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`,
    `Issued At: ${issuedAt}`,
  ].join('\n'));
  const response = await fetchImpl(`${serviceUrl.replace(/\/$/, '')}/api/artwork-update-complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...authorization, signature, requestId, txHash }),
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Artwork update completion failed (${response.status})`);
  return result;
}

export async function rejectArtworkUpdateRequest({
  serviceUrl,
  signer,
  address,
  origin,
  requestId,
  reason = 'rejected',
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
}) {
  const issuedAt = new Date(now()).toISOString();
  const authorization = { address, origin, issuedAt };
  const signature = await signer.signMessage([
    'DecentBusking admin mint queue',
    `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`,
    `Issued At: ${issuedAt}`,
  ].join('\n'));
  const response = await fetchImpl(`${serviceUrl.replace(/\/$/, '')}/api/artwork-update-reject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...authorization, signature, requestId, reason }),
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Artwork update rejection failed (${response.status})`);
  return result;
}

export function extractArtworkPreviewUri(nft = {}, gateway = 'https://gateway.pinata.cloud/ipfs/') {
  const image = String(nft.image || nft.imageUrl || nft.thumbnailUrl || '').trim();
  if (!image) return '';
  if (image.startsWith('ipfs://')) return image.replace('ipfs://', `${gateway.replace(/\/$/, '')}/`);
  return image;
}
