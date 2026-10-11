export function buildAdminAuthorizationMessage({ address, origin, issuedAt }) {
  return [
    'DecentBusking admin mint queue',
    `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`,
    `Issued At: ${issuedAt}`,
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

export async function importReviewedAlbums({ serviceUrl, signer, address, origin, fetchImpl = globalThis.fetch, now = Date.now }) {
  if (!serviceUrl || !signer || !address) throw new Error('Connect the owner wallet before importing reviewed albums');
  const issuedAt = new Date(now()).toISOString();
  const authorization = { address, origin, issuedAt };
  const signature = await signer.signMessage(buildReviewedAlbumImportAuthorizationMessage(authorization));
  const response = await fetchImpl(`${serviceUrl.replace(/\/$/, '')}/api/admin/reviewed-album-import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...authorization, signature }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Reviewed album import failed (${response.status})`);
  if (!Number.isSafeInteger(result.added) || !Number.isSafeInteger(result.queued) || !Number.isSafeInteger(result.skipped) || result.minted !== 0) {
    throw new Error('Invalid reviewed album import response');
  }
  return result;
}

export const PRODUCT_BATCH_ABI = [
  'function registerAndMintProductsBatch((address recipient,uint256 amount,uint256 maxSupply,string tokenURI,address royaltyReceiver,uint96 royaltyFeeBps)[] products) returns (uint256[] tokenIds)',
  'event TokenRegistered(uint256 indexed tokenId,address indexed creator,uint256 maxSupply,uint8 kind,string uri)',
  'event EditionMinted(uint256 indexed tokenId,address indexed to,uint256 amount,address indexed minter)',
];

export function splitMintBatches(indices, batchSize = 20) {
  if (!Array.isArray(indices) || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 20) {
    throw new Error('Mint batch size must be between 1 and 20');
  }
  const batches = [];
  for (let start = 0; start < indices.length; start += batchSize) batches.push(indices.slice(start, start + batchSize));
  return batches;
}

export async function mintPreparedProductsBatch({ contract, products, owner, maxGas = 8000000n, onBroadcast = () => {} }) {
  if (!Array.isArray(products) || products.length === 0 || products.length > 20) throw new Error('Select 1 to 20 songs per batch');
  const metadataUris = products.map(product => product.tokenURI);
  if (metadataUris.some(uri => typeof uri !== 'string' || !uri.startsWith('ipfs://')) ||
    new Set(metadataUris).size !== metadataUris.length) throw new Error('Batch metadata URIs must be unique IPFS URIs');
  const gas = await contract.registerAndMintProductsBatch.estimateGas(products);
  const gasLimit = gas * 120n / 100n;
  if (gasLimit > maxGas) throw new Error('Batch gas is too high; select fewer songs');
  const transaction = await contract.registerAndMintProductsBatch(products, { gasLimit });
  onBroadcast(transaction.hash);
  const receipt = await transaction.wait();
  if (receipt?.status !== 1) throw new Error(`Batch did not confirm: ${transaction.hash}`);
  const registered = [];
  const minted = [];
  for (const log of receipt.logs) {
    if (log.address?.toLowerCase() !== contract.target.toLowerCase()) continue;
    let event;
    try { event = contract.interface.parseLog(log); } catch { continue; }
    if (event?.name === 'TokenRegistered') registered.push(event.args);
    if (event?.name === 'EditionMinted') minted.push(event.args);
  }
  const tokenIds = products.map(product => {
    const registrations = registered.filter(event => event.uri === product.tokenURI &&
      event.creator.toLowerCase() === owner.toLowerCase() && BigInt(event.kind) === 0n);
    if (registrations.length !== 1) throw new Error(`Confirmed batch ${transaction.hash}: ambiguous registration proof`);
    const tokenId = registrations[0].tokenId;
    const editions = minted.filter(event => event.tokenId === tokenId && event.to.toLowerCase() === product.recipient.toLowerCase() &&
      event.minter.toLowerCase() === owner.toLowerCase() && event.amount === BigInt(product.amount));
    if (editions.length !== 1) throw new Error(`Confirmed batch ${transaction.hash}: missing mint proof`);
    return String(tokenId);
  });
  return { tokenIds, txHash: receipt.hash || transaction.hash };
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
