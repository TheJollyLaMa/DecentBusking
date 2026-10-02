// Pins Discord-only #DecentJukebox uploads to IPFS so every past post streams
// from the decentralized archive instead of expiring Discord CDN links.

import * as playlistStore from './playlist-store.js';

const STALE_PENDING_MS = 10 * 60_000;
const AUDIO_MIME_TYPES = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
  flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/ogg', weba: 'audio/webm',
};

let _running = null;

/** True when a track still lives only on Discord. Fresh 'pending' pins are left to the upload handler. */
export function needsIpfsPin(track, now = Date.now()) {
  if (track.ipfsCid) return false;
  if (track.pinStatus === 'pending') return now - Date.parse(track.addedAt || 0) > STALE_PENDING_MS;
  return true;
}

export function audioMimeType(filename = '') {
  return AUDIO_MIME_TYPES[filename.split('.').pop()?.toLowerCase()] || 'audio/mpeg';
}

/** Look up the original Discord attachment for a playlist entry, or null if it is gone. */
export async function fetchDiscordAttachment(client, track) {
  const channel = await client.channels.fetch(track.channelId).catch(() => null);
  const message = await channel?.messages?.fetch(track.messageId).catch(() => null);
  if (!message) return null;
  return message.attachments.get(track.attachmentId)
    ?? message.attachments.find((attachment) => attachment.name === track.filename)
    ?? null;
}

/**
 * Pin every Discord-only track to IPFS, one at a time.
 * Concurrent calls share the run already in progress.
 *
 * @returns {Promise<{ pinned: number, failed: number, remaining: number }>}
 */
export function backfillIpfsPins(options) {
  if (!_running) {
    _running = _backfill(options).finally(() => { _running = null; });
  }
  return _running;
}

async function _backfill({
  client,
  upload,
  maxBytes,
  delayMs = 1_500,
  checkpointEvery = 5,
  fetchAttachment = fetchDiscordAttachment,
  fetchImpl = fetch,
  store = playlistStore,
  log = console,
}) {
  const queue = store.getPlaylist().filter((track) => needsIpfsPin(track));
  if (!queue.length) return { pinned: 0, failed: 0, remaining: 0 };
  log.log(`[ipfs-backfill] ${queue.length} track(s) are not on IPFS yet; pinning…`);

  let pinned = 0;
  let failed = 0;
  let unsaved = 0;
  for (const queued of queue) {
    const track = store.getPlaylist().find((entry) => entry.trackId === queued.trackId);
    if (!track || !needsIpfsPin(track)) continue;

    try {
      const attachment = await fetchAttachment(client, track);
      if (!attachment) throw new Error('Original Discord upload no longer exists');
      if (attachment.size > maxBytes) throw new Error(`File is too large to pin (${Math.round(attachment.size / 1024 / 1024)} MB)`);

      const response = await fetchImpl(attachment.url);
      if (!response.ok) throw new Error(`HTTP ${response.status} downloading attachment`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const uri = await upload(buffer, track.filename, attachment.contentType || audioMimeType(track.filename));
      store.updateTrackPin(track.trackId, { status: 'pinned', ipfsCid: uri.replace('ipfs://', '') }, { save: false });
      pinned++;
      log.log(`[ipfs-backfill] Pinned "${track.title}" → ${uri}`);
    } catch (err) {
      store.updateTrackPin(track.trackId, { status: 'failed', error: err.message }, { save: false });
      failed++;
      log.warn(`[ipfs-backfill] Could not pin "${track.title}": ${err.message}`);
    }

    if (++unsaved >= checkpointEvery) {
      store.savePlaylist();
      unsaved = 0;
    }
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (unsaved) store.savePlaylist();

  const remaining = store.getPlaylist().filter((track) => needsIpfsPin(track)).length;
  log.log(`[ipfs-backfill] Done — pinned ${pinned}, failed ${failed}, ${remaining} still Discord-only.`);
  return { pinned, failed, remaining };
}
