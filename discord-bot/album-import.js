import { normalizeAlbumSongTitle } from './album-audit.js';
import { normalizeMediaCid, mediaTypeFor } from './media.js';

export function prepareAlbumPlaylistImport({ playlist, plan, artist, now = new Date().toISOString(), queueForMint = false }) {
  if (!Array.isArray(playlist) || plan?.duplicateMode !== 'title' || !Array.isArray(plan.tracks) || plan.uploadsRequired !== 0) {
    throw new Error('Reviewed title-based album plan and restored playlist are required');
  }
  if (!artist?.name || !artist.uploaderId || !/^0x[0-9a-fA-F]{40}$/.test(artist.wallet || '')) throw new Error('Verified album artist attribution is required');
  const next = structuredClone(playlist);
  const titleKeys = new Set(next.flatMap(track => [track.title, track.filename, track.name].filter(Boolean).map(normalizeAlbumSongTitle)));
  const existingCids = new Set(next.filter(track => track.ipfsCid).map(track => track.ipfsCid));
  const existingIds = new Set(next.map(track => track.trackId));
  const skipped = [];
  const added = [];
  const queued = [];
  for (const candidate of plan.tracks) {
    if (!candidate.dualPinVerified || !candidate.title || !candidate.sha256 || !Array.isArray(candidate.albums) || !candidate.albums.length) {
      throw new Error('Album candidate is not verified');
    }
    const cid = normalizeMediaCid(candidate.ipfsCid);
    const titleKey = normalizeAlbumSongTitle(candidate.title);
    const filenameKey = normalizeAlbumSongTitle(candidate.filename);
    const trackId = `album:${artist.wallet.toLowerCase()}:${cid}`;
    const existingTrack = next.find(track => track.trackId === trackId);
    if (existingTrack) {
      if (queueForMint && existingTrack.source === 'album' && existingTrack.ipfsCid === cid &&
          normalizeAlbumSongTitle(existingTrack.title) === titleKey && existingTrack.mintRecipient?.toLowerCase() === artist.wallet.toLowerCase() &&
          existingTrack.mintStatus === 'unminted') {
        existingTrack.mintStatus = 'requested';
        existingTrack.mintRequestedAt = now;
        queued.push(trackId);
      }
      skipped.push({ title: candidate.title, reason: 'already-present-title-or-audio' });
      continue;
    }
    if (titleKeys.has(titleKey) || titleKeys.has(filenameKey) || existingCids.has(cid) || existingIds.has(trackId)) {
      skipped.push({ title: candidate.title, reason: 'already-present-title-or-audio' });
      continue;
    }
    const mediaType = mediaTypeFor(candidate.filename);
    if (!mediaType) throw new Error('Unsupported album media type');
    const track = { trackId, attachmentId: trackId, source: 'album', title: candidate.title,
      filename: candidate.filename, mediaType, ipfsCid: cid, pinStatus: 'pinned',
      pinVerification: { pinata: true, local: true, verifiedAt: plan.sourceGeneratedAt },
      albums: [...new Set(candidate.albums)], contentSha256: candidate.sha256,
      uploader: artist.name, uploaderId: artist.uploaderId, mintRecipient: artist.wallet, tipWallet: artist.wallet,
      mintStatus: queueForMint ? 'requested' : 'unminted',
      ...(queueForMint ? { mintRequestedAt: now } : {}),
      likes: 0, dislikes: 0, plays: 0, addedAt: now, payrollTrackingStartedAt: now };
    next.push(track);
    added.push(trackId);
    if (queueForMint) queued.push(trackId);
    titleKeys.add(titleKey);
    titleKeys.add(filenameKey);
    existingCids.add(cid);
    existingIds.add(trackId);
  }
  return { playlist: next, added, queued, skipped };
}

export function resolveAlbumArtist(playlist, { name, wallet }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet || '')) throw new Error('Verified album artist wallet is required');
  const matches = playlist.filter(track => track.uploader === name);
  const ids = new Set(matches.map(track => track.uploaderId).filter(Boolean));
  if (ids.size !== 1) throw new Error('Album artist attribution is missing or ambiguous in restored playlist');
  if (matches.some(track => track.mintRecipient && track.mintRecipient.toLowerCase() !== wallet.toLowerCase())) {
    throw new Error('Album artist has conflicting wallet attribution in restored playlist');
  }
  return { name, wallet, uploaderId: [...ids][0] };
}

export async function checkpointReviewedAlbumImport({ playlist, plan, artist, save, mirrorCheckpoint, verifyMirrorAvailable,
  mirrorBeforePublication = false, queueForMint = false }) {
  const result = prepareAlbumPlaylistImport({ playlist, plan, artist, queueForMint });
  if (!result.added.length && !result.queued.length) return { ...result, checkpointUri: null };
  if (typeof save !== 'function') throw new Error('Durable album checkpoint writer required');
  if ((!mirrorBeforePublication && typeof mirrorCheckpoint !== 'function') || typeof verifyMirrorAvailable !== 'function') throw new Error('Local checkpoint mirror required');
  await verifyMirrorAvailable();
  const checkpointUri = await save(structuredClone(result.playlist));
  if (typeof checkpointUri !== 'string' || !checkpointUri.startsWith('ipfs://')) throw new Error('Album checkpoint did not confirm');
  try { if (!mirrorBeforePublication) await mirrorCheckpoint(checkpointUri); }
  catch (error) { throw new Error(`Album checkpoint ${checkpointUri} exists on Pinata but local mirror is pending; no state adopted. ${error.message}`); }
  return { ...result, checkpointUri };
}