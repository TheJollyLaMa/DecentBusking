import { radioCalendarOccurrences, newYorkInputToUtc } from './radio-calendar.mjs';

export function renderPlaylistShowPreview(payload) {
  const output = document.getElementById('admin-radio-playlist-preview');
  const type = document.getElementById('admin-radio-event-type')?.value;
  const playlistSelect = document.getElementById('admin-radio-event-playlist');
  if (playlistSelect) playlistSelect.disabled = type !== 'playlist_show';
  if (!output) return;
  if (type !== 'playlist_show') { output.textContent = ''; return; }
  const definition = payload?.playlistDefinitions?.find(item => item.id === document.getElementById('admin-radio-event-playlist')?.value);
  if (!definition) { output.textContent = 'Playlist preview unavailable — refresh the calendar after the worker deploys.'; return; }
  const duration = definition.estimatedDurationMs == null ? 'duration unknown' : `estimated ${Math.round(definition.estimatedDurationMs / 60_000)} minutes`;
  const parts = [definition.rule, `${definition.count ?? 'Unknown'} matching tracks · ${duration}.`,
    `${definition.unknownCount ?? 'Unknown'} tracks excluded for unknown/incomplete vote totals.`,
    'Preview only: the pool is snapshotted and shuffled at show start. Empty/exhausted pool → normal rotation. Paid DJuke requests wait until the show ends; ordinary DeVert breaks keep their cadence.'];
  try {
    const start = Date.parse(newYorkInputToUtc(document.getElementById('admin-radio-event-start').value));
    const end = Date.parse(newYorkInputToUtc(document.getElementById('admin-radio-event-end').value));
    if (definition.estimatedDurationMs > end - start) parts.push('The pool exceeds this slot; songs remaining at the handoff will not be drained past the end.');
    const id = document.getElementById('admin-radio-event-id').value;
    const conflicts = radioCalendarOccurrences(payload, { now: start, days: 1, pastDays: 0 }).filter(event =>
      event.id !== id && event.status !== 'cancelled' && Date.parse(event.startUtc) < end && start < Date.parse(event.endUtc));
    if (conflicts.length) parts.push(`Overlaps: ${conflicts.map(event => event.title).join(', ')}. Live/Top10 take precedence; overlapping playlist bookings are rejected.`);
  } catch { /* Dates are optional while drafting. */ }
  output.textContent = parts.join(' ');
}
