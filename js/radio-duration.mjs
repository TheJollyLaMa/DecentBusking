export const LONG_FORM_SECONDS = 600;

export function recordingMediaIdentity(track) {
  return track?.ipfsCid ? `ipfs:${track.ipfsCid}` :
    track?.attachmentId ? `discord:${track.channelId || ''}:${track.attachmentId}` :
      `track:${track?.trackId || ''}:${track?.messageId || ''}:${track?.filename || ''}`;
}

export function verifiedRecordingDuration(track) {
  const proof = track?.durationVerification;
  const seconds = proof?.seconds;
  if (!proof || !['ffmpeg-decode', 'live-capture'].includes(proof.source) ||
      !Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > Number.MAX_SAFE_INTEGER ||
      !Number.isFinite(Date.parse(proof.verifiedAt)) || proof.mediaIdentity !== recordingMediaIdentity(track) ||
      proof.longForm !== (seconds > LONG_FORM_SECONDS) ||
      track.durationSeconds !== seconds ||
      (track.durationMs !== undefined && (!Number.isFinite(track.durationMs) ||
        Math.abs(track.durationMs - seconds * 1000) > 0.000001))) return null;
  return seconds;
}

export function recordingDurationReason(track, { longForm = false } = {}) {
  const seconds = verifiedRecordingDuration(track);
  if (seconds === null) return 'Unknown or invalid verified recording duration; media probe required';
  if (longForm && seconds <= LONG_FORM_SECONDS) return 'Recording is not longer than 10 minutes';
  if (!longForm && seconds > LONG_FORM_SECONDS) return 'Recording over 10 minutes waits for designated long-form hours';
  return null;
}

export function recordingDurationProof(track, seconds, source, now = Date.now()) {
  if (!['ffmpeg-decode', 'live-capture'].includes(source) || !Number.isFinite(seconds) ||
      seconds <= 0 || seconds * 1000 > Number.MAX_SAFE_INTEGER) throw new Error('Invalid measured recording duration');
  return { seconds, source, mediaIdentity: recordingMediaIdentity(track),
    longForm: seconds > LONG_FORM_SECONDS, verifiedAt: new Date(now).toISOString() };
}
