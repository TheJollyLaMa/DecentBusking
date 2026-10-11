// Recovers which playlist tracks are already DecentNFT editions by reading Base,
// the source of truth when bot state is lost (e.g. a Render restart).

import { Contract, JsonRpcProvider, isAddress } from 'ethers';
import { CID } from 'multiformats/cid';
import * as playlistStore from './playlist-store.js';

const NFT_ABI = [
  'function nextTokenId() view returns (uint256)',
  'function totalMinted(uint256 tokenId) view returns (uint256)',
  'function uri(uint256 tokenId) view returns (string)',
];
const METADATA_GATEWAYS = ['https://gateway.pinata.cloud/ipfs/', 'https://ipfs.io/ipfs/'];

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

export async function readOwnedDevertAds({ collections, address, fetchImpl = fetch, retry = {}, pauseMs = 40,
  metadataReader = fetchMintMetadata, log = console } = {}) {
  if (!Array.isArray(collections) || !/^0x[0-9a-fA-F]{40}$/.test(address || '')) throw new Error('DeVert ad recovery requires collections and a wallet');
  const ads = new Map();
  for (const collection of collections) {
    const nextTokenId = Number(await withRetry(() => collection.contract.nextTokenId(), retry));
    if (!Number.isSafeInteger(nextTokenId) || nextTokenId < 0 || nextTokenId > 100_000) throw new Error('Invalid NFT token range');
    for (let tokenId = 0; tokenId < nextTokenId; tokenId++) {
      if (pauseMs) await new Promise(resolve => setTimeout(resolve, pauseMs));
      let balance;
      try { balance = await withRetry(() => collection.contract.balanceOf(address, tokenId), retry); }
      catch (error) { log.warn(`[mint-sync] Ad library ownership check deferred for token ${tokenId}: ${error.message}`); continue; }
      if (BigInt(balance) === 0n) continue;
      try {
        const uri = await withRetry(() => collection.contract.uri(tokenId), retry);
        const metadata = await metadataReader(uri, fetchImpl, { attempts: 1 });
        const isAd = metadata.isDevertAd === true || /^DecentAdvert(?:isement)?(?:\b|[0-9_-])/i.test(String(metadata.name || ''));
        if (!isAd) continue;
        const mediaUri = metadata.videoUrl || metadata.audioUrl || metadata.animation_url || '';
        const ipfsCid = audioCidFromMetadata({ ...metadata, audioUrl: mediaUri });
        if (!ipfsCid) continue;
        ads.set(`${collection.contractAddress.toLowerCase()}:${tokenId}`, {
          trackId: `nft:${collection.contractAddress.toLowerCase()}:${tokenId}`,
          title: String(metadata.name || `DeVert ad #${tokenId}`), ipfsCid,
          mediaType: metadata.mediaType || (metadata.videoUrl ? 'video/mp4' : 'audio/mpeg'),
          filename: String(metadata.filename || ''), mintStatus: 'minted', tokenId: String(tokenId),
          state: 'ready', campaignId: null, expiresAt: null, secondsRemaining: 0,
        });
      } catch (error) {
        log.warn(`[mint-sync] Ad metadata unavailable for owned token ${tokenId}: ${error.message}`);
      }
    }
  }
  return [...ads.values()];
}

export async function fetchMintMetadata(uri, fetchImpl, { attempts = 3, baseDelayMs = 1_000,
  wait = delay => new Promise(resolve => setTimeout(resolve, delay)) } = {}) {
  const cidPath = uri.startsWith('ipfs://') ? uri.replace(/^ipfs:\/\/(ipfs\/)?/, '')
    : /^https?:\/\//.test(uri) ? new URL(uri).pathname.split('/ipfs/')[1] : null;
  const urls = [...new Set([
    ...(/^https?:\/\//.test(uri) ? [uri] : []),
    ...(cidPath ? METADATA_GATEWAYS.map(gateway => `${gateway}${cidPath}`) : []),
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
export async function readMintedAudioCids({ contract, fetchImpl = fetch, retry = {}, pauseMs = 250, artistWalletByAudioCid }) {
  const tokenIdByAudioCid = new Map();
  const nextTokenId = Number(await withRetry(() => contract.nextTokenId(), retry));
  for (let tokenId = 0; tokenId < nextTokenId; tokenId++) {
    if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    if (Number(await withRetry(() => contract.totalMinted(tokenId), retry)) === 0) continue;
    const uri = await withRetry(() => contract.uri(tokenId), retry);
    const metadata = await fetchMintMetadata(uri, fetchImpl);
    const cid = audioCidFromMetadata(metadata || {});
    if (cid && !tokenIdByAudioCid.has(cid)) {
      tokenIdByAudioCid.set(cid, String(tokenId));
      if (typeof metadata.artist === 'string' && isAddress(metadata.artist)) artistWalletByAudioCid?.set(cid, metadata.artist);
    }
  }
  return tokenIdByAudioCid;
}

/** Mark playlist tracks whose audio is already minted on Base. */
export async function readMintedCollections({ collections, fetchImpl = fetch, pauseMs, retry }) {
  if (!Array.isArray(collections) || !collections.length) throw new Error('NFT collections are required');
  const minted = new Map();
  const artistWalletByAudioCid = new Map();
  const tokenReferencesByAudioCid = new Map();
  const seen = new Set();
  for (const collection of collections) {
    const address = collection.contractAddress;
    if (!isAddress(address) || seen.has(address.toLowerCase())) throw new Error('Invalid or duplicate NFT collection');
    seen.add(address.toLowerCase());
    const artists = new Map();
    const tokens = await readMintedAudioCids({ contract: collection.contract, fetchImpl, pauseMs, retry,
      artistWalletByAudioCid: artists });
    for (const [cid, tokenId] of tokens) {
      if (!minted.has(cid)) minted.set(cid, tokenId);
      if (!artistWalletByAudioCid.has(cid) && artists.has(cid)) artistWalletByAudioCid.set(cid, artists.get(cid));
      const references = tokenReferencesByAudioCid.get(cid) || [];
      references.push({ chainId: 8453, contractAddress: address, tokenId });
      tokenReferencesByAudioCid.set(cid, references);
    }
  }
  return { minted, artistWalletByAudioCid, tokenReferencesByAudioCid };
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
}) {
  let result;
  if (collections || contractAddresses?.length) {
    const provider = collections ? null : new JsonRpcProvider(rpcUrl);
    result = await readMintedCollections({ collections: collections || contractAddresses.map(address => ({
      contractAddress: address, contract: new Contract(address, NFT_ABI, provider),
    })), fetchImpl, pauseMs });
  } else {
    const artistWalletByAudioCid = new Map();
    const minted = await readMintedAudioCids({
      contract: contract || new Contract(contractAddress, NFT_ABI, new JsonRpcProvider(rpcUrl)),
      fetchImpl, pauseMs, artistWalletByAudioCid,
    });
    result = { minted, artistWalletByAudioCid };
  }
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
