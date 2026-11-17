export const LONG_FORM_SECONDS = 600;
// Diagnostic only; matches the existing long-form/replay completion margin.
export const RADIO_SHORT_TOLERANCE_MS = 2000;

export function expectedRecordingMs(track) {
  const seconds = verifiedRecordingDuration(track);
  return seconds === null ? null : seconds * 1000;
}

export function radioCompletionDiagnostics(audibleMs, expectedMs) {
  const expected = Number.isFinite(expectedMs) && expectedMs > 0 && expectedMs <= Number.MAX_SAFE_INTEGER
    ? expectedMs : null;
  const known = expected !== null && Number.isFinite(audibleMs) && audibleMs >= 0;
  return {
    expectedMs: expected,
    completionRatio: known ? audibleMs / expected : null,
    short: known ? expected - audibleMs > RADIO_SHORT_TOLERANCE_MS : null,
    shortToleranceMs: RADIO_SHORT_TOLERANCE_MS,
  };
}

export function recordingMediaIdentity(track) {
  return track?.ipfsCid ? `ipfs:${track.ipfsCid}` :
    track?.attachmentId ? `discord:${track.channelId || ''}:${track.attachmentId}` :
      `track:${track?.trackId || ''}:${track?.messageId || ''}:${track?.filename || ''}`;
}

export function verifiedRecordingDuration(track) {
  const proof = track?.durationVerification;
  const seconds = proof?.seconds;
  if (!proof || !['ffmpeg-decode', 'live-capture', 'sample-range'].includes(proof.source) ||
      !Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > Number.MAX_SAFE_INTEGER ||
      !Number.isFinite(Date.parse(proof.verifiedAt)) || proof.mediaIdentity !== recordingMediaIdentity(track) ||
      proof.longForm !== (seconds > LONG_FORM_SECONDS) ||
      track.durationSeconds !== seconds ||
      (track.durationMs !== undefined && (!Number.isFinite(track.durationMs) ||
        Math.abs(track.durationMs - seconds * 1000) > 0.000001)) ||
      proof.source === 'sample-range' && (!Number.isSafeInteger(proof.startSample) ||
        !Number.isSafeInteger(proof.endSample) || !Number.isSafeInteger(proof.sampleRate) ||
        proof.startSample < 0 || proof.endSample <= proof.startSample || proof.sampleRate !== 48000 ||
        proof.endSample - proof.startSample !== track.durationSamples ||
        track.sampleRate !== proof.sampleRate ||
        proof.seconds !== (proof.endSample - proof.startSample) / proof.sampleRate ||
        proof.sourceCid !== track.catalogRecording?.sourceCid ||
        proof.startSample !== track.catalogRecording?.startSample ||
        proof.endSample !== track.catalogRecording?.endSample)) return null;
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

export function recordingSampleRangeProof(track, { sourceCid, startSample, endSample, sampleRate = 48000 } = {},
  now = Date.now()) {
  if (!Number.isSafeInteger(startSample) || !Number.isSafeInteger(endSample) || startSample < 0 ||
      endSample <= startSample || sampleRate !== 48000 || endSample - startSample !== track?.durationSamples ||
      sourceCid !== track?.catalogRecording?.sourceCid || startSample !== track?.catalogRecording?.startSample ||
      endSample !== track?.catalogRecording?.endSample) throw new Error('Invalid sample-derived recording duration');
  const seconds = (endSample - startSample) / sampleRate;
  return { seconds, source: 'sample-range', mediaIdentity: recordingMediaIdentity(track),
    longForm: seconds > LONG_FORM_SECONDS, verifiedAt: new Date(now).toISOString(),
    sourceCid, startSample, endSample, sampleRate };
}
