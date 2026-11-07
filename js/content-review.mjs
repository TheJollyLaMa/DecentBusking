export const CONTENT_REASONS = ['inappropriate', 'mislabeled', 'copyright', 'other'];

export function contentAuthorization({ address, origin, issuedAt, command }) {
  return ['DecentBusking content review v1', `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`, `Issued: ${issuedAt}`, `Command: ${JSON.stringify(command)}`].join('\n');
}

export function contentCid(item) {
  const value = String(item.ipfsCid || item.audioURI || item.audioUrl || item.videoUrl || item.animation_url || '');
  if (value.startsWith('ipfs://')) return value.slice(7);
  const match = value.match(/^https?:\/\/[^/]+\/ipfs\/([^?#]+)/);
  return match ? match[1] : item.ipfsCid || '';
}

export function contentTarget(item) {
  if (!item.contractAddress && item.nftReferences?.length) return contentTarget(item.nftReferences[0]);
  if (item.contractAddress && item.tokenId != null) {
    return { chainId: Number(item.chainId || 8453), contractAddress: item.contractAddress.toLowerCase(),
      tokenId: String(item.tokenId) };
  }
  if (item.trackId) return { trackId: String(item.trackId) };
  if (contentCid(item)) return { ipfsCid: contentCid(item) };
  throw new Error('This recording has no reviewable catalog identity');
}

export function contentKey(target) {
  if (target.chainId === 8453 && /^0x[0-9a-f]{40}$/i.test(target.contractAddress || '') &&
      /^\d+$/.test(target.tokenId || '')) {
    return `nft:8453:${target.contractAddress.toLowerCase()}:${BigInt(target.tokenId)}`;
  }
  if (typeof target.trackId === 'string' && target.trackId.length > 0 && target.trackId.length <= 200) {
    return `track:${target.trackId}`;
  }
  if (typeof target.ipfsCid === 'string' && target.ipfsCid.length > 0 && target.ipfsCid.length <= 250) {
    return `media:${target.ipfsCid}`;
  }
  throw new Error('Invalid content identity');
}

export function contentAliases(item) {
  const aliases = new Set();
  if (item.trackId) aliases.add(contentKey({ trackId: String(item.trackId) }));
  if (item.contractAddress && item.tokenId != null) aliases.add(contentKey(contentTarget(item)));
  for (const reference of item.nftReferences || []) aliases.add(contentKey(contentTarget(reference)));
  const cid = contentCid(item);
  if (cid) aliases.add(contentKey({ ipfsCid: cid }));
  return [...aliases];
}

export function radioContentAllowed(item, advert = false) {
  if (item?.contentReview?.scope === 'all-radio') return false;
  return advert || (item?.contentReview?.scope !== 'music-only' && !item?.isDevertAd);
}

export async function verifyRadioSongEligibility({ service, songId, fetchImpl = fetch, signal }) {
  if (!service) throw new Error('Radio eligibility service is not configured');
  const response = await fetchImpl(`${service.replace(/\/$/, '')}/api/djuke`, {
    cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Radio eligibility is unavailable; refresh before paying');
  const snapshot = await response.json();
  if (!Array.isArray(snapshot.tracks) || !snapshot.tracks.some(track => track.songId?.toLowerCase() === songId.toLowerCase())) {
    throw new Error('Recording is no longer eligible for radio; choose another song');
  }
}
