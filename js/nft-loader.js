const CACHE_TTL_MS = 60 * 60 * 1000;

export function audioCid(value) {
  return String(value || '').match(/^ipfs:\/\/(?:ipfs\/)?([^/?#]+)/)?.[1] || String(value || '').match(/\/ipfs\/([^/?#]+)/)?.[1] || '';
}

export function isMusicNft(nft) {
  const animation = String(nft?.animation_url || '').toLowerCase();
  return !!(nft && (nft.audioUrl || nft.videoUrl || nft.mediaType === 'video/mp4' ||
    /\.(mp3|mp4|wav|flac|m4a|ogg|opus|aac|weba)(\?|#|$)/i.test(animation) ||
    (animation.startsWith('ipfs://') && !/\.[a-z]{2,5}(\?|#|$)/.test(animation))));
}

export function nftArtistKey(nft) {
  return String(nft.artist || nft.creator || nft.uploader || 'Unknown artist').trim().toLowerCase();
}

export function nftArtistLabel(nft) {
  return nft.artistName || nft.uploader || nft.description?.match(/^Shared through DecentJukebox by (.+)$/)?.[1] ||
    nft.artist || nft.creator || 'Unknown artist';
}

export function catalogPage(items, { offset = 0, limit = 25 } = {}, maxLimit = 25) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new Error(`Invalid page: offset must be nonnegative and limit must be 1 to ${maxLimit}`);
  }
  return { items: items.slice(offset, offset + limit), total: items.length,
    nextOffset: offset + limit < items.length ? offset + limit : null };
}

// Accents are folded so "Jose" and "José" (precomposed or combining) match.
export function searchText(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function nftSearchTerms(query = '') {
  return searchText(query).trim().split(/\s+/).filter(Boolean);
}

/** Catalog artists ({value,label}) whose label contains every query word; exact, then prefix matches first. */
export function matchCatalogArtists(artists = [], query = '', limit = 5) {
  const terms = nftSearchTerms(query);
  if (!terms.length) return [];
  const whole = terms.join(' ');
  const rank = label => (label === whole ? 0 : label.startsWith(whole) ? 1 : 2);
  return (Array.isArray(artists) ? artists : [])
    .filter(artist => artist?.value && artist.label && artist.label !== 'Unknown artist')
    .map(artist => ({ artist, label: searchText(artist.label).trim() }))
    .filter(({ label }) => terms.every(term => label.includes(term)))
    .sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label))
    .slice(0, limit)
    .map(({ artist }) => artist);
}

/** The artist whose songs should light up as the user types: an exact label match, or the only match. */
export function autoHighlightArtist(matches = [], query = '') {
  const whole = nftSearchTerms(query).join(' ');
  if (!whole) return null;
  return matches.find(artist => searchText(artist.label).trim() === whole) || (matches.length === 1 ? matches[0] : null);
}

/** Newest-first songs, at most `limit`. */
export function latestSongs(nfts = [], limit = 10) {
  const time = nft => { const t = Date.parse(nft?.mintedAt || ''); return Number.isFinite(t) ? t : 0; };
  return [...(Array.isArray(nfts) ? nfts : [])].sort((a, b) => time(b) - time(a)).slice(0, limit);
}

/** True when every query word appears in the song title or artist fields. */
export function nftMatchesQuery(nft, query = '') {
  const terms = Array.isArray(query) ? query : nftSearchTerms(query);
  if (!terms.length) return true;
  const text = searchText([nft?.name, nft?.title, nftArtistLabel(nft || {}), nft?.artistName, nft?.uploader,
    nft?.artist, nft?.creator, nft?.djukeAlbumTitle, nft?.tokenId].filter(value => value != null && value !== '').join(' '));
  return terms.every(term => text.includes(term));
}

export function nftCatalogPage(nfts, { query = '', artist = '', wallet = '', before = '', after = '', ...paging } = {}) {
  const terms = nftSearchTerms(query);
  const lower = after ? Date.parse(after) : null;
  const upper = before ? Date.parse(before) : null;
  if ((after && !Number.isFinite(lower)) || (before && !Number.isFinite(upper))) throw new Error('Invalid timeline dates');
  const music = nfts.filter(isMusicNft);
  const artists = [...new Map(music.map(nft => [nftArtistKey(nft), nftArtistLabel(nft)])).entries()]
    .map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  const matching = music.filter(nft => {
    const date = Date.parse(nft.mintedAt);
    const splitWallets = Array.isArray(nft.creatorSplits) ? nft.creatorSplits.map(entry => entry?.wallet || entry?.address) : [];
    const walletMatch = !wallet || [nft.artist, nft.creator, ...splitWallets].some(value => String(value || '').toLowerCase() === wallet.toLowerCase());
    return (!artist || nftArtistKey(nft) === artist.toLowerCase()) && walletMatch && nftMatchesQuery(nft, terms) &&
      (lower === null || date >= lower) && (upper === null || date < upper);
  }).sort((a, b) => (Date.parse(b.mintedAt) || 0) - (Date.parse(a.mintedAt) || 0) || b.tokenId - a.tokenId ||
    a.contractAddress.localeCompare(b.contractAddress));
  const page = catalogPage(matching, paging);
  return { nfts: page.items.map(nft => ({ ...nft, nftId: nftIdentity(nft) })),
    total: page.total, nextOffset: page.nextOffset, artists };
}

export async function fetchNftCatalogPage({ config, offset = 0, query = '', artist = '', before = '', after = '',
  signal, fetchImpl = globalThis.fetch }) {
  const service = (config.ipfsUploadServiceUrl || '').replace(/\/$/, '');
  if (!service) throw new Error('NFT catalog service is not configured');
  const params = new URLSearchParams({ offset, limit: 25, query, artist, before, after });
  const response = await fetchImpl(`${service}/api/nfts?${params}`, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  const page = await response.json();
  if (!response.ok) throw new Error(page.error || `NFT catalog unavailable (${response.status})`);
  if (!Array.isArray(page.nfts) || page.nfts.length > 25 || !Array.isArray(page.artists) ||
    !Number.isSafeInteger(page.total) || page.total < page.nfts.length ||
    (page.nextOffset !== null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset))) {
    throw new Error('Invalid NFT catalog page');
  }
  const collections = new Set(configuredNftCollections(config).map(entry => entry.contractAddress));
  const seen = new Set();
  for (const nft of page.nfts) {
    if (nft.chainId !== (config.chainId || 8453) || !collections.has(String(nft.contractAddress).toLowerCase()) ||
      nft.nftId !== nftIdentity(nft) || seen.has(nft.nftId) || !isMusicNft(nft)) throw new Error('Invalid catalog NFT');
    seen.add(nft.nftId);
  }
  if (page.artists.some(artist => typeof artist?.value !== 'string' || typeof artist?.label !== 'string')) {
    throw new Error('Invalid catalog artists');
  }
  return page;
}

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

export function parseNftIdentitySearch(search = '') {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(String(search || ''));
  const chainId = Number.parseInt(params.get('chainId') || '', 10);
  const contractAddress = params.get('contract') || '';
  const tokenId = Number.parseInt(params.get('tokenId') || '', 10);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('Missing or invalid NFT chainId');
  if (!/^0x[0-9a-fA-F]{40}$/.test(contractAddress)) throw new Error('Missing or invalid NFT contract');
  if (!Number.isSafeInteger(tokenId) || tokenId < 0) throw new Error('Missing or invalid NFT tokenId');
  return { chainId, contractAddress: contractAddress.toLowerCase(), tokenId };
}

export function buildNftShareUrl(nft, baseUrl = globalThis.location?.href || 'https://example.com/') {
  const chainId = nft?.chainId ?? 8453;
  const contractAddress = nft?.contractAddress;
  const tokenId = nft?.tokenId;
  if (!/^0x[0-9a-fA-F]{40}$/.test(contractAddress || '') || !Number.isSafeInteger(tokenId) || tokenId < 0 ||
      !Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('Invalid NFT identity');
  const url = new URL(baseUrl);
  url.hash = '';
  url.search = '';
  url.searchParams.set('chainId', String(chainId));
  url.searchParams.set('contract', contractAddress.toLowerCase());
  url.searchParams.set('tokenId', String(tokenId));
  return url.toString();
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
