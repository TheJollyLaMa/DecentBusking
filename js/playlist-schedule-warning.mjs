import { radioCalendarOccurrences, RADIO_TIME_ZONE } from './radio-calendar.mjs?v=20261024-programming-calendar';

const ESTIMATED_SONG_MS = 4 * 60_000;
const PROTECTED_TYPES = new Set(['live_performance', 'playlist_show', 'weekly_top10']);

function duration(track) {
  const milliseconds = Number(track?.durationMs) || Number(track?.durationSeconds) * 1000;
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : null;
}

export function playlistScheduleConflict({ songIds, calendar, queue, radio, now = Date.now() }) {
  if (calendar?.ready !== true || !Array.isArray(calendar.schedule) || !Array.isArray(calendar.events)) {
    throw new Error('Public calendar is not ready. Retry Play Live before purchasing.');
  }
  if (calendar.events.some(event => !(Date.parse(event.endUtc) > Date.parse(event.startUtc)))) {
    throw new Error('Public calendar contains invalid show times. Retry Play Live before purchasing.');
  }
  if (!Array.isArray(queue?.tracks) || !Array.isArray(queue.requests) ||
      ![queue.mainPending, queue.playlistPending].every(count => Number.isSafeInteger(count) && count >= 0) ||
      !radio || !Object.hasOwn(radio, 'nowPlaying')) {
    throw new Error('Radio queue timing is unavailable. Retry Play Live before purchasing.');
  }
  const catalog = new Map(queue.tracks.map(track => [String(track.songId).toLowerCase(), track]));
  let estimatedSongs = 0;
  const songDuration = track => {
    const measured = duration(track);
    if (measured) return measured;
    estimatedSongs++;
    return ESTIMATED_SONG_MS;
  };
  const playlistMs = songIds.reduce((total, songId) => total + songDuration(catalog.get(songId.toLowerCase())), 0);
  const pending = queue.mainPending + queue.playlistPending;
  if (!Number.isSafeInteger(pending)) throw new Error('Invalid radio queue size. Retry Play Live before purchasing.');
  let queuedMs = 0;
  const playingRequest = radio.nowPlaying?.sponsor?.kind === 'djuke' ? radio.nowPlaying.sponsor.requestId : null;
  // The worker exposes only a bounded window into the pending playlist lane.
  for (const request of queue.requests.slice(0, pending)) {
    if (playingRequest && request.requestId === playingRequest) continue;
    queuedMs += songDuration(catalog.get(String(request?.songId).toLowerCase()));
  }
  const unseenPending = Math.max(0, pending - queue.requests.length);
  queuedMs += unseenPending * ESTIMATED_SONG_MS;
  estimatedSongs += unseenPending;
  let currentMs = 0;
  if (radio.nowPlaying) {
    const playing = radio.nowPlaying;
    const track = queue.tracks.find(item => item.trackId === playing.trackId);
    const measured = duration(playing) || duration(track);
    currentMs = measured
      ? Math.max(0, measured - Math.max(0, Number(playing.positionMs) || 0))
      : songDuration(null);
  }
  const waitMs = currentMs + queuedMs;
  const finish = now + waitMs + playlistMs;
  if (!Number.isFinite(new Date(finish).getTime())) throw new Error('Radio timing estimate is out of range. Retry Play Live before purchasing.');
  const events = radioCalendarOccurrences(calendar, {
    now, days: Math.min(90, Math.ceil((finish - now) / 86400_000) + 1), pastDays: 1,
  });
  const invalid = events.some(event => PROTECTED_TYPES.has(event.type) &&
    !(Date.parse(event.endUtc) > Date.parse(event.startUtc)));
  if (invalid) throw new Error('Public calendar contains invalid show times. Retry Play Live before purchasing.');
  const event = events.find(item => item.status !== 'cancelled' && PROTECTED_TYPES.has(item.type) &&
    Date.parse(item.startUtc) < finish && Date.parse(item.endUtc) > now);
  return event ? { event, playlistMs, waitMs, estimatedSongs, estimatedFinishUtc: new Date(finish).toISOString() } : null;
}

export async function checkPlaylistSchedule({ songIds, config, fetchImpl = fetch, signal }) {
  const service = String(config.ipfsUploadServiceUrl || '').replace(/\/$/, '');
  const load = async path => {
    const response = await fetchImpl(`${service}${path}`, { cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Could not check the public radio calendar and queue. Retry Play Live; no approval or purchase was requested.');
    return response.json();
  };
  const [calendar, queue, radio] = await Promise.all([
    load('/api/radio/schedule'), load('/api/djuke'), load('/api/radio'),
  ]);
  signal?.throwIfAborted();
  return playlistScheduleConflict({ songIds, calendar, queue, radio });
}

export function playlistConflictMessage(conflict) {
  const format = value => new Intl.DateTimeFormat('en-US', { timeZone: RADIO_TIME_ZONE,
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(value));
  const minutes = value => Math.ceil(value / 60_000);
  return `Possible Play Live schedule conflict\n\n"${conflict.event.title}"\n${format(conflict.event.startUtc)} – ${format(conflict.event.endUtc)}\n\n` +
    `Your mix is about ${minutes(conflict.playlistMs)} minutes, plus about ${minutes(conflict.waitMs)} minutes of current/queued audio. ` +
    (conflict.estimatedSongs ? 'Unknown song lengths use a rough 4-minute-per-song allowance. ' : '') +
    'This estimated window overlaps the protected block. Queue timing can change; exact start and finish times are not guaranteed.\n\n' +
    'Your playlist may wait or be set aside for the show. Remaining songs return to the queue afterward without another payment. ' +
    'There is no refund solely for that delay or interruption; separate failed-delivery refunds still apply.\n\n' +
    'Select OK to continue to checkout, or Cancel to keep your playlist without purchasing.';
}
