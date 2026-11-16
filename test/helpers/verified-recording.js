function verifiedRecording(track, seconds = track.durationSeconds ?? (track.durationMs === undefined ? 180 : track.durationMs / 1000)) {
  const mediaIdentity = track.ipfsCid ? `ipfs:${track.ipfsCid}` :
    track.attachmentId ? `discord:${track.channelId || ''}:${track.attachmentId}` :
      `track:${track.trackId || ''}:${track.messageId || ''}:${track.filename || ''}`;
  return { ...track, durationSeconds: seconds,
    durationVerification: { seconds, source: 'ffmpeg-decode', mediaIdentity, longForm: seconds > 600,
      verifiedAt: '2026-10-01T00:00:00Z' } };
}

module.exports = { verifiedRecording };
