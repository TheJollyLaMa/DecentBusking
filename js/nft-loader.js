const CACHE_TTL_MS = 60 * 60 * 1000;

export function configuredNftCollections(config = {}) {
  const addresses = [config.contractAddress, ...(config.additionalNftContractAddresses || [])];
  const unique = new Set();
  return addresses.filter(Boolean).map(address => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) throw new Error('Invalid NFT collection address');
    return address.toLowerCase();
  }).filter(address => {
    if (unique.has(address)) return false;
    unique.add(address);
    return true;
  }).map(contractAddress => ({ contractAddress, chainId: config.chainId || 8453 }));
}

export function nftIdentity({ chainId = 8453, contractAddress, tokenId }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(contractAddress || '') || !Number.isSafeInteger(tokenId) || tokenId < 0 ||
    !Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('Invalid NFT identity');
  return `${chainId}:${contractAddress.toLowerCase()}:${tokenId}`;
}

export async function readNftContract(call) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
}

function readCache(cacheKey, storage) {
  try {
    const parsed = JSON.parse((storage || globalThis.localStorage)?.getItem(`decentbusking:nfts:v1:${cacheKey}`) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function readCachedMintedTokens({ cacheKey, storage } = {}) {
  if (!cacheKey) return [];
  return Object.values(readCache(cacheKey, storage))
    .filter((entry) => entry?.nft && Number.isSafeInteger(entry.nft.tokenId) && entry.nft.metadataUri)
    .map((entry) => entry.nft)
    .sort((first, second) => first.tokenId - second.tokenId);
}

export async function loadMintedToken({ contract, tokenId, fetchMetadata, cacheKey, storage, now = Date.now(),
  contractAddress, chainId = 8453 }) {
  const cache = cacheKey ? readCache(cacheKey, storage) : {};
  const cached = cache[tokenId];
  const identity = contractAddress ? { chainId, contractAddress,
    nftId: nftIdentity({ chainId, contractAddress, tokenId }) } : {};
  if (cached?.nft?.tokenId === tokenId && now - cached.savedAt < CACHE_TTL_MS) return { ...cached.nft, ...identity };
  const minted = Number(await readNftContract(() => contract.totalMinted(tokenId)));
  if (minted === 0) return null;

  const uri = await readNftContract(() => contract.uri(tokenId));
  const [meta, creator] = await Promise.all([
    fetchMetadata(uri),
    contract.creatorOf(tokenId).catch(() => ''),
  ]);
  if (!meta) return null;
  const nft = {
    ...meta,
    tokenId,
    metadataUri: uri,
    mintedSupply: minted,
    creator: creator || meta.creator || meta.artist || '',
    ...identity,
  };
  if (cacheKey) {
    try {
      const latest = readCache(cacheKey, storage);
      latest[tokenId] = { savedAt: now, nft };
      (storage || globalThis.localStorage)?.setItem(`decentbusking:nfts:v1:${cacheKey}`, JSON.stringify(latest));
    } catch {}
  }
  return nft;
}
