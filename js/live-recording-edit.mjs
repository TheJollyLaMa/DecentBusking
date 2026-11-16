export const LIVE_RECORDING_SAMPLE_RATE = 48_000;
export const LIVE_RECORDING_MIN_RELEASE_SAMPLES = LIVE_RECORDING_SAMPLE_RATE / 2;
export const LIVE_RECORDING_MAX_SONG_SAMPLES = LIVE_RECORDING_SAMPLE_RATE * 30 * 60;
export const LIVE_RECORDING_MAX_SONGS = 50;

const validTitle = (value, limit) => typeof value === 'string' &&
  value.trim().length > 0 && value.trim().length <= limit && !/[\u0000-\u001f\u007f]/.test(value);

export function recordingSourceSamples(segments) {
  if (!Array.isArray(segments) || !segments.length) throw Error('Recording source is unavailable');
  const bytes = segments.reduce((total, segment) => {
    if (!Number.isSafeInteger(segment?.bytes) || segment.bytes <= 0 || segment.bytes % 2 !== 0) {
      throw Error('Recording source duration is invalid');
    }
    return total + segment.bytes;
  }, 0);
  const samples = bytes / 2;
  if (!Number.isSafeInteger(samples) || samples <= 0) throw Error('Recording source duration is invalid');
  return samples;
}

export function validateRecordingDraft(draft, totalSamples) {
  if (!Number.isSafeInteger(totalSamples) || totalSamples <= 0 ||
      !draft || typeof draft !== 'object' || Array.isArray(draft) ||
      Object.keys(draft).some(key => !['revision', 'albumTitle', 'songs'].includes(key)) ||
      !Number.isSafeInteger(draft.revision) || draft.revision < 0 ||
      !validTitle(draft.albumTitle, 120) ||
      !Array.isArray(draft.songs) || draft.songs.length < 1 || draft.songs.length > LIVE_RECORDING_MAX_SONGS) {
    throw Error('Invalid recording edit');
  }
  let previousEnd = 0;
  const titles = new Set();
  const songs = draft.songs.map((song, index) => {
    if (!song || typeof song !== 'object' || Array.isArray(song) ||
        Object.keys(song).some(key => !['title', 'startSample', 'endSample'].includes(key)) ||
        !validTitle(song.title, 100) ||
        !Number.isSafeInteger(song.startSample) || !Number.isSafeInteger(song.endSample) ||
        song.startSample < previousEnd || song.endSample > totalSamples ||
        song.endSample - song.startSample < LIVE_RECORDING_MIN_RELEASE_SAMPLES ||
        song.endSample - song.startSample > LIVE_RECORDING_MAX_SONG_SAMPLES) {
      throw Error(`Invalid song boundary or title at track ${index + 1}`);
    }
    const title = song.title.trim();
    const key = title.toLocaleLowerCase('en');
    if (titles.has(key)) throw Error('Song titles must be unique within the release');
    titles.add(key);
    previousEnd = song.endSample;
    return { title, startSample: song.startSample, endSample: song.endSample };
  });
  return { revision: draft.revision, albumTitle: draft.albumTitle.trim(), songs };
}

export function recordingReleaseApprovalMessage({ bookingId, wallet, origin, sourceCid, sourceSamples,
  choice, draft, issuedAt, incomplete = false }) {
  if (typeof bookingId !== 'string' || !bookingId || !/^0x[0-9a-f]{40}$/i.test(wallet || '') ||
      typeof origin !== 'string' || !origin || !/^[a-zA-Z0-9]{20,120}$/.test(sourceCid || '') ||
      !Number.isSafeInteger(sourceSamples) || sourceSamples <= 0 ||
      !['full', 'split', 'defer'].includes(choice) || !Number.isSafeInteger(issuedAt) ||
      typeof incomplete !== 'boolean') {
    throw Error('Invalid recording release approval');
  }
  const draftJson = JSON.stringify(draft);
  return [
    'DecentBusking live recording publication approval v1',
    `Booking: ${bookingId}`,
    `Performer: ${wallet.toLowerCase()}`,
    `Origin: ${origin}`,
    `Source CID: ${sourceCid}`,
    `Source samples: ${sourceSamples}`,
    `Choice: ${choice}`,
    `Draft: ${draftJson}`,
    `Incomplete capture: ${incomplete}`,
    `Issued at: ${new Date(issuedAt).toISOString()}`,
    'Each requested release is a separate immutable publication. This approval does not grant collaborator rights.',
  ].join('\n');
}
