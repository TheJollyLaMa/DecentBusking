import { prepareRelease } from '../js/release-batch.mjs';
import { MEDIA_TYPES, normalizeMediaCid } from './media.js';

export const prepareMediaRelease = rows => prepareRelease(rows, normalizeMediaCid, MEDIA_TYPES);

// Preflight the entire release before touching the live array. Keep existing IDs,
// votes, payout settings, mint dates and moderation decisions on retries.
export function planRelease(playlist, tracks, { source, uploader, uploaderId, wallet, artworkCid = '', now = new Date().toISOString() }) {
  if (!['site', 'discord'].includes(source) || !uploaderId || !uploader || !/^0x[0-9a-f]{40}$/i.test(wallet) || /^0x0{40}$/i.test(wallet)) throw Error('Missing verified release artist');
  const address = wallet.toLowerCase();
  const updates = [], results = [];
  const occupied = new Map();
  const slot = m => JSON.stringify([m.album.toLowerCase(), m.position]);
  for (const track of playlist) {
    if (track.mintRecipient?.toLowerCase() === address) {
      for (const m of track.releaseAlbums || []) occupied.set(slot(m), track.ipfsCid);
    }
  }
  for (const item of tracks) {
    const same = playlist.filter(t => t.ipfsCid === item.cid);
    const existing = same.find(t => t.uploaderId === uploaderId && (t.source || 'discord') === source);
    if (same.length && (!existing || same.length > 1 || existing.isDevertAd ||
        (existing.mintRecipient && existing.mintRecipient.toLowerCase() !== address))) {
      throw Error(`${item.title}: this CID already belongs to another submission; ask the owner to review`);
    }
    const trackId = existing?.trackId || `${source === 'site' ? 'site:' + address : 'cid:' + uploaderId}:${item.cid}`;
    const albums = [...(existing?.releaseAlbums || [])];
    for (const m of item.memberships) {
      const old = albums.find(a => a.album.toLowerCase() === m.album.toLowerCase());
      if ((old && old.position !== m.position) || (occupied.has(slot(m)) && occupied.get(slot(m)) !== item.cid)) {
        throw Error(`${m.album}: track ${m.position} conflicts with an existing release; review the order`);
      }
      occupied.set(slot(m), item.cid);
      if (!old) albums.push(m);
    }
    const track = existing ? { ...existing } : {
      source, attachmentId: trackId, trackId, uploaderId, uploader, title: item.title, filename: `track.${item.format}`,
      mediaType: MEDIA_TYPES[item.format], pinStatus: 'pinned', ipfsCid: item.cid, likes: 0, dislikes: 0, plays: 0, addedAt: now,
    };
    if (existing && !['unminted', 'requested', 'minted'].includes(track.mintStatus)) throw Error(`${item.title}: track needs owner review`);
    if (existing && track.pinStatus !== 'pinned') throw Error(`${item.title}: waiting for a verified pin`);
    if (existing && (existing.title !== item.title || (existing.mediaType && existing.mediaType !== MEDIA_TYPES[item.format]))) {
      throw Error(`${item.title}: this recording already has a different title or media type`);
    }
    if (track.mintStatus === 'minted' && albums.length !== (existing.releaseAlbums || []).length) {
      throw Error(`${item.title}: already minted; use the owner album editor instead`);
    }
    const already = ['minted', 'requested'].includes(track.mintStatus);
    if (!already) Object.assign(track, { mintStatus: 'requested', mintRequestedAt: now, mintRecipient: wallet });
    if (track.mintStatus !== 'minted') {
      track.releaseAlbums = albums;
      track.artworkCid ||= artworkCid;
      track.tipWallet ||= wallet;
    }
    updates.push({ existing, track });
    results.push({ trackId, title: track.title, cid: item.cid, status: track.mintStatus, already });
  }
  return { updates, results };
}
