export function createInputMeter({ level, state, note }) {
  let analyser, timer;
  return {
    start(sdk, track) {
      state.textContent = 'Microphone on';
      try {
        analyser = sdk.createAudioAnalyser(track, { cloneTrack: true });
        timer = setInterval(() => {
          level.value = Math.min(1, Math.max(0, analyser.calculateVolume()));
        }, 100);
        note.textContent = 'Speak or sing to move the meter. Local input only; delivery and operator listening are separate checks.';
      } catch {
        note.textContent = 'Input meter unavailable in this browser. Use the independent delivery check and operator listening.';
      }
    },
    async stop() {
      clearInterval(timer); timer = null;
      const previous = analyser; analyser = null;
      level.value = 0; state.textContent = 'Microphone off';
      if (previous) {
        try { await previous.cleanup(); }
        catch { note.textContent = 'Input meter could not close normally. Your microphone track has been stopped.'; }
      }
    },
  };
}
