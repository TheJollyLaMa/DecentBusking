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

async function fetchMetadata(uri, fetchImpl) {
  const cidPath = uri.replace(/^ipfs:\/\/(ipfs\/)?/, '');
  const urls = /^https?:\/\//.test(uri) ? [uri] : METADATA_GATEWAYS.map((gateway) => `${gateway}${cidPath}`);
  for (const url of urls) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (response?.ok) {
      const metadata = await response.json().catch(() => null);
      if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) return metadata;
    }
  }
  throw new Error('NFT metadata could not be verified through any IPFS gateway');
}

/** Map audio CID → lowest minted token ID for every minted DecentNFT token. */
export async function readMintedAudioCids({ contract, fetchImpl = fetch, retry = {}, pauseMs = 250, artistWalletByAudioCid }) {
  const tokenIdByAudioCid = new Map();
  const nextTokenId = Number(await withRetry(() => contract.nextTokenId(), retry));
  for (let tokenId = 0; tokenId < nextTokenId; tokenId++) {
    if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    if (Number(await withRetry(() => contract.totalMinted(tokenId), retry)) === 0) continue;
    const uri = await withRetry(() => contract.uri(tokenId), retry);
    const metadata = await fetchMetadata(uri, fetchImpl);
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
