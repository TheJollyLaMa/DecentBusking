// Shared by the DJuke drawer and the standalone DJuke widget; keep it free of radio/player imports.
// On-chain `delivered` events trail settlement, so the live `playing` lane and heard `played` lanes drive the count.
export function playlistBatchProgress(batch) {
  const songs = Array.isArray(batch?.songs) ? batch.songs : [];
  const count = status => songs.filter(song => song.status === status).length;
  const total = songs.length;
  const delivered = count('delivered');
  const played = count('played');
  const remaining = count('pending');
  const playing = songs.findIndex(song => song.status === 'playing');
  const name = batch?.name || 'Playlist';
  return {
    total, delivered, played, remaining, position: playing >= 0 ? playing + 1 : null,
    heading: playing >= 0
      ? `${name} · Song ${playing + 1} of ${total} · ${remaining} remaining`
      : `${name} · ${remaining} of ${total} songs remaining`,
    progress: `${delivered} / ${total} songs delivered${played ? ` · ${played} played, settling` : ''}${
      playing >= 0 ? ` · now playing song ${playing + 1}` : ''}`,
  };
}
