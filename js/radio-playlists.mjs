import { currentPayrollPeriod, payrollPeriods } from './payroll-week.mjs';

// Definitions are reusable; calendar events reference a rule, never a mutable track list.
export const RADIO_PLAYLISTS = Object.freeze([
  Object.freeze({ id: 'songs-awaiting-your-vote', title: 'Songs Awaiting Your Vote',
    revision: 1, selector: 'no-votes-ever', rule: 'All-time human upvotes = 0 AND downvotes = 0 (site + Discord).',
    invitation: 'Vote up OR down — help these songs find their place in the rotation.' }),
  Object.freeze({ id: 'top10-hour', title: 'Top 10 Hour', revision: 1, selector: 'weekly-chart',
    ranking: 'weekly-score', limit: 10, rule: 'This payroll week’s highest net votes, then qualified plays.',
    invitation: 'Listen and vote on the website.' }),
  Object.freeze({ id: 'rising-stars', title: 'Rising Stars', revision: 1, selector: 'weekly-growth',
    ranking: 'weekly-growth', limit: 0, rule: 'Positive net votes this week, improving on last week, with recorded votes in both weeks.',
    invitation: 'Help our rising artists keep climbing — vote on the website.' }),
]);

export function validateRadioPreset(value) {
  if (!value || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(value.id || '') ||
    typeof value.title !== 'string' || !value.title.trim() || value.title.length > 100 ||
    !['no-votes-ever', 'weekly-chart', 'weekly-growth'].includes(value.selector) ||
    !['shuffle', 'weekly-score', 'weekly-growth'].includes(value.ranking) ||
    !Number.isInteger(value.limit) || value.limit < 0 || value.limit > 100 ||
    !Number.isInteger(value.revision) || value.revision < 1) throw new Error('Invalid radio preset');
  return { id: value.id, title: value.title.trim(), revision: value.revision, selector: value.selector,
    ranking: value.ranking, limit: value.limit,
    rule: ({ 'no-votes-ever': 'No human votes ever.', 'weekly-chart': 'Current payroll-week votes and plays.',
      'weekly-growth': 'Positive weekly net score, improving over the previous week; votes recorded in both weeks.' })[value.selector],
    invitation: 'Listen and vote on the DecentBusking website.' };
}

export function radioPlaylistDefinition(id, customDefinition) {
  if (customDefinition) {
    const definition = validateRadioPreset(customDefinition);
    if (definition.id !== id) throw new Error('Preset ID does not match event');
    return definition;
  }
  const definition = RADIO_PLAYLISTS.find(item => item.id === id);
  if (!definition) throw new Error('Unknown radio playlist definition');
  return definition;
}

export function isEligibleRadioMusic(track) {
  return !!track?.trackId && !track.isDevertAd && track.enabled !== false && track.available !== false &&
    (track.source !== 'site' || track.mintStatus === 'minted') &&
    (!track.mediaType || (typeof track.mediaType === 'string' && (track.mediaType.startsWith('audio/') || track.mediaType === 'video/mp4')));
}

export function playlistTrackReason(track, definition, now = Date.now()) {
  if (!isEligibleRadioMusic(track)) return 'Recording is no longer eligible or available';
  const week = currentPayrollPeriod(now).week;
  if (definition.selector === 'weekly-chart') {
    const votes = Number(track.payrollVotes?.[week]);
    const plays = Number(track.payrollPlays?.[week]);
    return Number.isFinite(votes) && votes !== 0 || Number.isFinite(plays) && plays > 0
      ? null : 'No votes or qualified plays this payroll week';
  }
  if (definition.selector === 'weekly-growth') {
    const previous = payrollPeriods(2, now)[0].week;
    const currentVotes = track.payrollVotes?.[week];
    const previousVotes = track.payrollVotes?.[previous];
    return Number.isFinite(currentVotes) && Number.isFinite(previousVotes) &&
      currentVotes > 0 && currentVotes > previousVotes ? null : 'No verified positive week-over-week growth';
  }
  if (definition.selector !== 'no-votes-ever') throw new Error('Unsupported radio playlist selector');
  if (![track.likes, track.dislikes].every(value => Number.isSafeInteger(value) && value >= 0) || track.voteTotalsComplete === false) {
    return 'Unknown or incomplete all-time human vote totals';
  }
  const historicVote = Object.values(track.discordRatings || {}).some(counts => counts.likes > 0 || counts.dislikes > 0) ||
    [track.weeklyVotes, track.payrollVotes].some(totals => Object.values(totals || {}).some(value => Number(value) !== 0));
  if (track.likes !== 0 || track.dislikes !== 0 || track.everHumanVoted === true || historicVote) return 'Received a human vote';
  return null;
}

export function previewRadioPlaylist(id, catalog, { definition: customDefinition, now = Date.now() } = {}) {
  const definition = radioPlaylistDefinition(id, customDefinition);
  const eligible = catalog.filter(isEligibleRadioMusic);
  let tracks = eligible.filter(track => !playlistTrackReason(track, definition, now));
  const week = currentPayrollPeriod(now).week;
  const previous = payrollPeriods(2, now)[0].week;
  const score = track => definition.ranking === 'weekly-growth'
    ? Number(track.payrollVotes?.[week] || 0) - Number(track.payrollVotes?.[previous] || 0)
    : Number(track.payrollVotes?.[week] || 0);
  if (definition.ranking && definition.ranking !== 'shuffle') {
    tracks.sort((a, b) => score(b) - score(a) ||
      Number(b.payrollPlays?.[week] || 0) - Number(a.payrollPlays?.[week] || 0) || a.trackId.localeCompare(b.trackId));
  }
  if (definition.limit) tracks = tracks.slice(0, definition.limit);
  const unknownCount = eligible.filter(track => playlistTrackReason(track, definition, now)?.startsWith('Unknown')).length;
  const durations = tracks.map(track => Number(track.durationMs) || Number(track.durationSeconds) * 1000);
  return { ...definition, count: tracks.length, unknownCount,
    estimatedDurationMs: durations.every(value => Number.isFinite(value) && value > 0) ? durations.reduce((a, b) => a + b, 0) : null,
    tracks: tracks.map(track => ({ trackId: track.trackId, title: track.title, artist: track.uploader })) };
}
