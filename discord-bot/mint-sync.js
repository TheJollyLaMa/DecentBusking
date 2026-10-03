// Recovers which playlist tracks are already DecentNFT editions by reading Base,
// the source of truth when bot state is lost (e.g. a Render restart).

import { Contract, JsonRpcProvider } from 'ethers';
import * as playlistStore from './playlist-store.js';

const NFT_ABI = [
  'function nextTokenId() view returns (uint256)',
  'function totalMinted(uint256 tokenId) view returns (uint256)',
  'function uri(uint256 tokenId) view returns (string)',
];
const METADATA_GATEWAYS = ['https://gateway.pinata.cloud/ipfs/', 'https://ipfs.io/ipfs/'];

// The public Base RPC answers bursts with "over rate limit", so retry with backoff.
async function withRetry(call, { attempts = 5, baseDelayMs = 1_000 } = {}) {
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
  return uri.match(/^ipfs:\/\/(?:ipfs\/)?([^/?#]+)/)?.[1] ?? uri.match(/\/ipfs\/([^/?#]+)/)?.[1] ?? null;
}

async function fetchMetadata(uri, fetchImpl) {
  const cidPath = uri.replace(/^ipfs:\/\/(ipfs\/)?/, '');
  const urls = /^https?:\/\//.test(uri) ? [uri] : METADATA_GATEWAYS.map((gateway) => `${gateway}${cidPath}`);
  for (const url of urls) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (response?.ok) return response.json().catch(() => null);
  }
  return null;
}

/** Map audio CID → lowest minted token ID for every minted DecentNFT token. */
export async function readMintedAudioCids({ contract, fetchImpl = fetch, retry = {}, pauseMs = 250 }) {
  const tokenIdByAudioCid = new Map();
  const nextTokenId = Number(await withRetry(() => contract.nextTokenId(), retry));
  for (let tokenId = 0; tokenId < nextTokenId; tokenId++) {
    if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    if (Number(await withRetry(() => contract.totalMinted(tokenId), retry)) === 0) continue;
    const uri = await withRetry(() => contract.uri(tokenId), retry);
    const metadata = await fetchMetadata(uri, fetchImpl);
    const cid = audioCidFromMetadata(metadata || {});
    if (cid && !tokenIdByAudioCid.has(cid)) tokenIdByAudioCid.set(cid, String(tokenId));
  }
  return tokenIdByAudioCid;
}

/** Mark playlist tracks whose audio is already minted on Base. */
export async function syncMintedTracksFromChain({
  rpcUrl,
  contractAddress,
  contract = new Contract(contractAddress, NFT_ABI, new JsonRpcProvider(rpcUrl)),
  fetchImpl = fetch,
  store = playlistStore,
  log = console,
  pauseMs,
}) {
  const minted = await readMintedAudioCids({ contract, fetchImpl, pauseMs });
  const changed = store.applyOnChainMints(minted);
  if (changed) log.log(`[mint-sync] Marked ${changed} track(s) minted from DecentNFT on Base.`);
  return changed;
}
