// Recovers which playlist tracks are already DecentNFT editions by reading Base,
// the source of truth when bot state is lost (e.g. a Render restart).

import { Contract, JsonRpcProvider, Interface, isAddress, id } from 'ethers';
import { CID } from 'multiformats/cid';
import * as playlistStore from './playlist-store.js';

const NFT_ABI = [
  'function nextTokenId() view returns (uint256)',
  'function totalMinted(uint256 tokenId) view returns (uint256)',
  'function uri(uint256 tokenId) view returns (string)',
];
const METADATA_GATEWAYS = [
  'https://ipfs.orbitor.dev/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://ipfs.io/ipfs/',
];
const cacheEvents = new Interface([
  'event URI(string value,uint256 indexed id)',
  'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
  'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
]);

export async function invalidateMintCache({ cache, provider, contractAddress }) {
  const blockNumber = await provider.getBlockNumber() - 1;
  const block = await provider.getBlock(blockNumber);
  if (!block?.hash) throw new Error('NFT cache confirmation block unavailable');
  if (cache.blockNumber === undefined || blockNumber < cache.blockNumber ||
      (await provider.getBlock(cache.blockNumber))?.hash !== cache.blockHash) {
    cache.tokens.clear();
  } else {
    for (let fromBlock = cache.blockNumber + 1; fromBlock <= blockNumber; fromBlock += 1000) {
      const logs = await provider.getLogs({ address: contractAddress, fromBlock,
        toBlock: Math.min(fromBlock + 999, blockNumber),
        topics: [[id('URI(string,uint256)'), id('TransferSingle(address,address,address,uint256,uint256)'),
          id('TransferBatch(address,address,address,uint256[],uint256[])')]] });
      for (const log of logs) {
        const event = cacheEvents.parseLog(log);
        if (event.name === 'URI' && event.args.id === (2n ** 256n - 1n)) cache.tokens.clear();
        else for (const tokenId of event.name === 'TransferBatch' ? event.args.ids : [event.args.id]) cache.tokens.delete(Number(tokenId));
      }
    }
  }
  return { blockNumber, blockHash: block.hash };
}

// The public Base RPC answers bursts with "over rate limit", so retry with backoff.
export async function withRetry(call, { attempts = 5, baseDelayMs = 1_000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (attempt >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
}

export function audioCidFromMetadata(metadata = {}) {
  const uri = metadata.animation_url || metadata.audioUrl || '';
  const path = uri.match(/^ipfs:\/\/(?:ipfs\/)?([^?#]+)/)?.[1] ?? uri.match(/\/ipfs\/([^?#]+)/)?.[1];
  if (!path) return null;
  const [root, ...segments] = path.split('/');
  let normalized = root;
  try { normalized = CID.parse(root).toV1().toString(); } catch {}
  return [normalized, ...segments].join('/');
}

export async function readOwnedDevertAds({ collections, address, fetchImpl = fetch, retry = {}, pauseMs = 0,
  ownershipConcurrency = 32, metadataConcurrency = 8, ownershipReader, metadataReader = fetchMintMetadata,
  onProgress, log = console } = {}) {
  if (!Array.isArray(collections) || !/^0x[0-9a-fA-F]{40}$/.test(address || '')) throw new Error('DeVert ad recovery requires collections and a wallet');
  if (!Number.isSafeInteger(ownershipConcurrency) || ownershipConcurrency < 1 ||
      !Number.isSafeInteger(metadataConcurrency) || metadataConcurrency < 1) throw new Error('Invalid ownership scan concurrency');
  const ads = new Map();
  let metadataUnavailable = 0;
  let ownershipUnavailable = 0;
  for (const collection of collections) {
    const nextTokenId = Number(await withRetry(() => collection.contract.nextTokenId(), retry));
    if (!Number.isSafeInteger(nextTokenId) || nextTokenId < 0 || nextTokenId > 100_000) throw new Error('Invalid NFT token range');
    for (let endTokenId = nextTokenId - 1; endTokenId >= 0; endTokenId -= ownershipConcurrency) {
      if (pauseMs && endTokenId < nextTokenId - 1) await new Promise(resolve => setTimeout(resolve, pauseMs));
      const tokenIds = Array.from({ length: Math.min(ownershipConcurrency, endTokenId + 1) }, (_, offset) => endTokenId - offset);
      let balances;
      try {
        balances = ownershipReader
          ? await ownershipReader(collection, address, tokenIds)
          : await Promise.all(tokenIds.map(async tokenId => {
            try { return { balance: await withRetry(() => collection.contract.balanceOf(address, tokenId), retry) }; }
            catch (error) { return { error }; }
          }));
        if (!Array.isArray(balances) || balances.length !== tokenIds.length) throw new Error('Invalid ownership batch response');
      } catch (error) {
        balances = tokenIds.map(() => ({ error }));
      }
      const ownedTokenIds = [];
      for (let index = 0; index < tokenIds.length; index++) {
        const tokenId = tokenIds[index];
        const ownership = balances[index];
        if (ownership.error) {
          ownershipUnavailable++;
          continue;
        }
        if (BigInt(ownership.balance) === 0n) continue;
        ownedTokenIds.push(tokenId);
      }
      for (let index = 0; index < ownedTokenIds.length; index += metadataConcurrency) {
        await Promise.all(ownedTokenIds.slice(index, index + metadataConcurrency).map(async tokenId => {
          try {
            const uri = await withRetry(() => collection.contract.uri(tokenId), retry);
            const metadata = await metadataReader(uri, fetchImpl, { attempts: 1 });
            const isAd = metadata.isDevertAd === true || /^DecentAdvert(?:isement)?(?:\b|[0-9_-])/i.test(String(metadata.name || ''));
            if (!isAd) return;
            const mediaUri = metadata.videoUrl || metadata.audioUrl || metadata.animation_url || '';
            const ipfsCid = audioCidFromMetadata({ ...metadata, audioUrl: mediaUri });
            if (!ipfsCid) return;
            ads.set(`${collection.contractAddress.toLowerCase()}:${tokenId}`, {
              trackId: `nft:${collection.contractAddress.toLowerCase()}:${tokenId}`,
              title: String(metadata.name || `DeVert ad #${tokenId}`), ipfsCid,
              mediaType: metadata.mediaType || (metadata.videoUrl ? 'video/mp4' : 'audio/mpeg'),
              filename: String(metadata.filename || ''), mintStatus: 'minted', tokenId: String(tokenId),
              state: 'ready', campaignId: null, expiresAt: null, secondsRemaining: 0,
            });
          } catch (error) {
            metadataUnavailable++;
            log.warn(`[mint-sync] Ad metadata unavailable for owned token ${tokenId}: ${error.message}`);
          }
        }));
      }
      onProgress?.({ ads: [...ads.values()], metadataUnavailable, ownershipUnavailable });
    }
    if (ownershipUnavailable) log.warn(`[mint-sync] ${ownershipUnavailable} ad library ownership check(s) failed; results may be incomplete.`);
  }
  return { ads: [...ads.values()], metadataUnavailable, ownershipUnavailable };
}

export async function discoverPinataMetadataGateway({ pinataJwt, fetchImpl = fetch,
  apiUrl = 'https://api.pinata.cloud/v3/gateways' } = {}) {
  if (!pinataJwt) throw new Error('PINATA_JWT is required to discover the dedicated metadata gateway');
  const response = await fetchImpl(`${apiUrl}?pageSize=1`, {
    headers: { Authorization: `Bearer ${pinataJwt}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Pinata gateway discovery failed (${response.status})`);
  const body = await response.json();
  const row = body?.data?.rows?.[0];
  let domain = row?.domain;
  if (typeof domain !== 'string' || !/^[a-z0-9.-]+$/i.test(domain)) {
    throw new Error('Pinata gateway discovery returned no valid domain');
  }
  if (!domain.includes('.')) domain = `${domain}.mypinata.cloud`;

  let tokenParam = '';
  if (row?.id) {
    try {
      const detailsUrl = `${apiUrl.replace(/\/?$/, '')}/${row.id}`;
      const detailsResp = await fetchImpl(detailsUrl, {
        headers: { Authorization: `Bearer ${pinataJwt}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (detailsResp.ok) {
        const detailsBody = await detailsResp.json();
        const accessTokens = detailsBody?.data?.settings?.restriction_policies?.accessTokens;
        if (Array.isArray(accessTokens) && accessTokens[0]?.value) {
          tokenParam = `?pinataGatewayToken=${encodeURIComponent(accessTokens[0].value)}`;
        }
      }
    } catch {
      // Best-effort gateway token discovery
    }
  }

  return `https://${domain}/ipfs/${tokenParam}`;
}

export function buildGatewayUrl(gateway, cidPath) {
  try {
    const url = new URL(gateway);
    const cleanPath = url.pathname.replace(/\/?$/, '/') + cidPath.replace(/^\/?/, '');
    url.pathname = cleanPath;
    return url.toString();
  } catch {
    return `${gateway.replace(/\/?$/, '/')}${cidPath.replace(/^\/?/, '')}`;
  }
}

export async function fetchMintMetadata(uri, fetchImpl, { attempts = 3, baseDelayMs = 1_000,
  gateways = METADATA_GATEWAYS, wait = delay => new Promise(resolve => setTimeout(resolve, delay)) } = {}) {
  const cidPath = uri.startsWith('ipfs://') ? uri.replace(/^ipfs:\/\/(ipfs\/)?/, '')
    : /^https?:\/\//.test(uri) ? new URL(uri).pathname.split('/ipfs/')[1] : null;
  const urls = [...new Set([
    ...(/^https?:\/\//.test(uri) ? [uri] : []),
    ...(cidPath ? gateways.map(gateway => buildGatewayUrl(gateway, cidPath)) : []),
  ])];
  const failures = new Map();
  for (let attempt = 0; attempt < attempts; attempt++) {
    let transient = false;
    for (const url of urls) {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (response?.ok) {
        const metadata = await response.json().catch(() => null);
        if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) return metadata;
        failures.set(url, 'invalid JSON metadata');
      } else {
        failures.set(url, response?.status || 'timeout/network error');
        if (!response || response.status === 429 || response.status >= 500) transient = true;
      }
    }
      if (!transient || attempt === attempts - 1) break;
      await wait(baseDelayMs * 2 ** attempt);
  }
  throw new Error(`NFT metadata could not be verified through any IPFS gateway: ${uri}. ${[...failures].map(([url, status]) => `${new URL(url).hostname}: ${status}`).join('; ')}. Mint queue remains locked to prevent duplicate mints; retry after gateway recovery.`);
}

/** Map audio CID → lowest minted token ID for every minted DecentNFT token. */
function markMetadataChecked(metadata, checkedAt) {
  Object.defineProperty(metadata, '_metadataCheckedAt', {
    value: checkedAt,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return metadata;
}

export async function readMintedAudioCids({ contract, fetchImpl = fetch, retry = {}, pauseMs = 250, artistWalletByAudioCid,
  tokenCache = new Map(), nfts = [], metadataGateways, metadataCacheMs = 300_000, now = Date.now }) {
  const tokenIdByAudioCid = new Map();
  const nextTokenId = Number(await withRetry(() => contract.nextTokenId(), retry));
  if (!Number.isSafeInteger(nextTokenId) || nextTokenId < 0) throw new Error('Invalid NFT token count');
  const fresh = cached => cached && now() - (cached._metadataCheckedAt ?? -Infinity) < metadataCacheMs;
  const load = async tokenId => {
    let cached = tokenCache.get(tokenId);
    if (!fresh(cached)) {
      const [mintedSupply, uri] = await Promise.all([
        withRetry(() => contract.totalMinted(tokenId), retry).then(Number),
        withRetry(() => contract.uri(tokenId), retry),
      ]);
      if (mintedSupply === 0) {
        tokenCache.delete(tokenId);
        return null;
      }
      if (cached?.metadataUri === uri) {
        cached.mintedSupply = mintedSupply;
        markMetadataChecked(cached, now());
        return cached;
      }
      const metadata = await fetchMintMetadata(uri, fetchImpl,
        metadataGateways?.length ? { gateways: metadataGateways } : undefined);
      cached = { ...metadata, tokenId, contractAddress: contract.target || contract.address || '',
        chainId: 8453, metadataUri: uri, mintedSupply };
      markMetadataChecked(cached, now());
      tokenCache.set(tokenId, cached);
    }
    return cached;
  };
  for (let start = 0; start < nextTokenId; start += 3) {
    const ids = Array.from({ length: Math.min(3, nextTokenId - start) }, (_, index) => start + index);
    if (pauseMs && ids.some(tokenId => !fresh(tokenCache.get(tokenId)))) await new Promise(resolve => setTimeout(resolve, pauseMs));
    const results = await Promise.allSettled(ids.map(load));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    for (const result of results) {
      const metadata = result.value;
      if (!metadata) continue;
      const contractAddress = contract.target || contract.address || '';
      nfts.push({ ...metadata, contractAddress: metadata.contractAddress || contractAddress, chainId: metadata.chainId || 8453 });
      const cid = audioCidFromMetadata(metadata);
      if (cid && !tokenIdByAudioCid.has(cid)) {
        tokenIdByAudioCid.set(cid, String(metadata.tokenId));
        if (typeof metadata.artist === 'string' && isAddress(metadata.artist)) artistWalletByAudioCid?.set(cid, metadata.artist);
      }
    }
  }
  return tokenIdByAudioCid;
}

/** Mark playlist tracks whose audio is already minted on Base. */
export async function readMintedCollections({ collections, fetchImpl = fetch, pauseMs, retry,
  tokenCaches = new Map(), nfts = [], metadataGateways, metadataCacheMs, now }) {
  if (!Array.isArray(collections) || !collections.length) throw new Error('NFT collections are required');
  const minted = new Map();
  const artistWalletByAudioCid = new Map();
  const tokenReferencesByAudioCid = new Map();
  const seen = new Set();
  for (const collection of collections) {
    const address = collection.contractAddress;
    if (!isAddress(address) || seen.has(address.toLowerCase())) throw new Error('Invalid or duplicate NFT collection');
    const cacheKey = address.toLowerCase();
    seen.add(cacheKey);
    let tokenCache = tokenCaches.get(cacheKey);
    if (!tokenCache) {
      tokenCache = new Map();
      tokenCaches.set(cacheKey, tokenCache);
    }
    const artists = new Map();
    const tokens = await readMintedAudioCids({ contract: collection.contract, fetchImpl, pauseMs, retry,
      artistWalletByAudioCid: artists, tokenCache, nfts, metadataGateways, metadataCacheMs, now });
    for (const [cid, tokenId] of tokens) {
      if (!minted.has(cid)) minted.set(cid, tokenId);
      if (!artistWalletByAudioCid.has(cid) && artists.has(cid)) artistWalletByAudioCid.set(cid, artists.get(cid));
      const references = tokenReferencesByAudioCid.get(cid) || [];
      references.push({ chainId: 8453, contractAddress: address, tokenId });
      tokenReferencesByAudioCid.set(cid, references);
    }
  }
  return { minted, artistWalletByAudioCid, tokenReferencesByAudioCid, nfts };
}

export async function syncMintedTracksFromChain({
  rpcUrl,
  contractAddress,
  contract,
  contractAddresses,
  collections,
  fetchImpl = fetch,
  store = playlistStore,
  log = console,
  pauseMs,
  tokenCaches = new Map(),
  metadataGateways,
  metadataCacheMs,
  now,
  onCatalog,
}) {
  let result;
  if (collections || contractAddresses?.length) {
    const provider = collections ? null : new JsonRpcProvider(rpcUrl);
    result = await readMintedCollections({ collections: collections || contractAddresses.map(address => ({
      contractAddress: address, contract: new Contract(address, NFT_ABI, provider),
    })), fetchImpl, pauseMs, tokenCaches, metadataGateways, metadataCacheMs, now });
  } else {
    const artistWalletByAudioCid = new Map();
    const minted = await readMintedAudioCids({
      contract: contract || new Contract(contractAddress, NFT_ABI, new JsonRpcProvider(rpcUrl)),
      fetchImpl, pauseMs, artistWalletByAudioCid, metadataGateways, metadataCacheMs, now,
    });
    result = { minted, artistWalletByAudioCid, nfts: [] };
  }
  onCatalog?.(result.nfts || []);
  const changed = store.applyOnChainMints(result.minted, result);
  if (changed) log.log(`[mint-sync] Marked ${changed} track(s) minted from DecentNFT on Base.`);
  return changed;
}

export function createVerifiedMintQueueReader({ reconcile, getRequests }) {
  let pending = null;
  return async () => {
    if (!pending) pending = Promise.resolve().then(reconcile).finally(() => { pending = null; });
    await pending;
    return getRequests();
  };
}
