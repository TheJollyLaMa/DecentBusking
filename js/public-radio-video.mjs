export function createPublicRadioVideo({ video, mediaUrl, onActive, onError }) {
  let playId = null;
  let pending = false;
  let failed = false;
  let generation = 0;
  let previousMuted;

  function stop() {
    if (playId === null) return;
    generation++;
    playId = null;
    pending = failed = false;
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.muted = previousMuted;
    onActive(false);
  }

  function update(audible) {
    const program = audible?.program;
    if (!program?.playId || program.live || program.mediaType !== 'video/mp4' ||
        !/^[a-z0-9]{20,120}$/i.test(program.ipfsCid || '') ||
        !Number.isFinite(audible.at) || !Number.isFinite(program.at)) {
      stop();
      return;
    }

    if (playId !== program.playId) {
      stop();
      playId = program.playId;
      previousMuted = video.muted;
      video.muted = true;
      video.src = mediaUrl(program.ipfsCid);
    }
    if (video.error && !failed) {
      failed = true;
      onActive(false);
      onError('Video unavailable; radio audio continues.');
    }
    if (failed || video.readyState < 1) return;
    const target = Math.max(0, (audible.at - program.at) / 1000);
    if (Number.isFinite(video.duration) && target >= video.duration) {
      video.pause();
      onActive(false);
      return;
    }
    if (Math.abs(video.currentTime - target) > 0.6 && !video.seeking) video.currentTime = target;
    if (pending || video.seeking || video.readyState < 2) return;
    if (!video.paused) { onActive(true); return; }
    pending = true;
    const current = generation;
    void video.play().then(() => {
      if (current === generation) onActive(true);
    }).catch(error => {
      if (current !== generation || error.name === 'AbortError') return;
      failed = true;
      onActive(false);
      onError('Video could not play; radio audio continues.');
    }).finally(() => { if (current === generation) pending = false; });
  }
  return { update, stop };
}
