// Definitions are reusable; calendar events reference an ID, never a mutable track list.
export const RADIO_PLAYLISTS = Object.freeze([
  Object.freeze({ id: 'songs-awaiting-your-vote', title: 'Songs Awaiting Your Vote',
    revision: 1, selector: 'no-votes-ever', rule: 'All-time human upvotes = 0 AND downvotes = 0 (site + Discord).',
    invitation: 'Vote up OR down — help these songs find their place in the rotation.' }),
]);

export function radioPlaylistDefinition(id) {
  const definition = RADIO_PLAYLISTS.find(item => item.id === id);
  if (!definition) throw new Error('Unknown radio playlist definition');
  return definition;
}

export function isEligibleRadioMusic(track) {
  return !!track?.trackId && !track.isDevertAd && track.enabled !== false && track.available !== false &&
    (track.source !== 'site' || track.mintStatus === 'minted') &&
    (!track.mediaType || (typeof track.mediaType === 'string' && (track.mediaType.startsWith('audio/') || track.mediaType === 'video/mp4')));
}

export function playlistTrackReason(track, definition) {
  if (!isEligibleRadioMusic(track)) return 'Recording is no longer eligible or available';
  if (definition.selector !== 'no-votes-ever') throw new Error('Unsupported radio playlist selector');
  if (![track.likes, track.dislikes].every(value => Number.isSafeInteger(value) && value >= 0) || track.voteTotalsComplete === false) {
    return 'Unknown or incomplete all-time human vote totals';
  }
  const historicVote = Object.values(track.discordRatings || {}).some(counts => counts.likes > 0 || counts.dislikes > 0) ||
    [track.weeklyVotes, track.payrollVotes].some(totals => Object.values(totals || {}).some(value => Number(value) !== 0));
  if (track.likes !== 0 || track.dislikes !== 0 || track.everHumanVoted === true || historicVote) return 'Received a human vote';
  return null;
}

export function previewRadioPlaylist(id, catalog) {
  const definition = radioPlaylistDefinition(id);
  const eligible = catalog.filter(isEligibleRadioMusic);
  const tracks = eligible.filter(track => !playlistTrackReason(track, definition));
  const unknownCount = eligible.filter(track => playlistTrackReason(track, definition)?.startsWith('Unknown')).length;
  const durations = tracks.map(track => Number(track.durationMs) || Number(track.durationSeconds) * 1000);
  return { ...definition, count: tracks.length, unknownCount,
    estimatedDurationMs: durations.every(value => Number.isFinite(value) && value > 0) ? durations.reduce((a, b) => a + b, 0) : null,
    tracks: tracks.map(track => ({ trackId: track.trackId, title: track.title, artist: track.uploader })) };
}
