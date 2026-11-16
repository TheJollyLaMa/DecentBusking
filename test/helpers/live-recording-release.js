function liveRecordingRelease({ booking, cid, consent, durationSeconds = 20, incomplete = false,
  releaseId = 'a'.repeat(64), choice = 'full', title = booking.title || 'Live performance',
  albumTitle = booking.title || 'Live performance', trackNumber = 1, startSample = 0 }) {
  const sampleRate = 48_000;
  const sourceDurationSamples = Math.round(durationSeconds * sampleRate);
  const endSample = startSample + sourceDurationSamples;
  const source = { cid, sampleRate, durationSamples: endSample,
    segments: [{ cid: 's'.repeat(46), bytes: endSample * 2 }] };
  const release = { releaseId, choice, title, albumTitle, trackNumber, startSample, endSample,
    durationSamples: sourceDurationSamples, sourceCid: cid, cid,
    approvalSignature: 'fixture-performer-approval', approvalMessageHash: 'b'.repeat(64), approvedAt: Date.now() };
  return { booking, release, source, consent: { ...consent, version: consent.version || 'dbusk-live-recording-v2' }, incomplete };
}

module.exports = { liveRecordingRelease };
