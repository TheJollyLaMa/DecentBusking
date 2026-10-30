export const RADIO_AD_TRANSITION_MS = 3000;

export function createRadioAdTransition() {
  const stage = document.createElement('div');
  stage.id = 'radio-ad-transition';
  stage.hidden = true;
  stage.setAttribute('aria-hidden', 'true');
  const video = document.createElement('video');
  video.src = new URL('../img/radio-snow.mp4', import.meta.url).href;
  video.muted = true;
  video.playsInline = true;
  video.loop = true;
  video.preload = 'auto';
  stage.append(video);
  document.body.append(stage);
  let finish = null;
  let timer = null;
  let context = null;
  let output = null;
  let volume = 0;

  function setVolume(value) {
    volume = Math.max(0, Math.min(1, value));
    if (output && context) output.gain.setValueAtTime(volume * 0.12, context.currentTime);
  }

  function stop() {
    clearTimeout(timer);
    stage.hidden = true;
    video.pause();
    if (context) {
      void context.close().catch(error => console.warn('[radio] Could not close tuning audio:', error.message));
      context = null;
      output = null;
    }
    const resolve = finish;
    finish = null;
    resolve?.();
  }

  function play() {
    stop();
    stage.hidden = false;
    video.currentTime = 0;
    if (!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      void video.play().catch(error => console.warn('[radio] Snow playback unavailable:', error.message));
    }
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (AudioContext) {
      try {
        context = new AudioContext();
        const noise = context.createBufferSource();
        const buffer = context.createBuffer(1, context.sampleRate * 3, context.sampleRate);
        const samples = buffer.getChannelData(0);
        for (let index = 0; index < samples.length; index++) samples[index] = Math.random() * 2 - 1;
        noise.buffer = buffer;
        const filter = context.createBiquadFilter();
        filter.type = 'bandpass';
        filter.Q.value = 6;
        const start = context.currentTime;
        filter.frequency.setValueAtTime(180, start);
        filter.frequency.exponentialRampToValueAtTime(2600, start + 1);
        filter.frequency.exponentialRampToValueAtTime(350, start + 2.8);
        const envelope = context.createGain();
        envelope.gain.setValueAtTime(0, start);
        envelope.gain.linearRampToValueAtTime(1, start + 0.3);
        envelope.gain.setValueAtTime(1, start + 2.3);
        envelope.gain.linearRampToValueAtTime(0, start + 3);
        output = context.createGain();
        setVolume(volume);
        noise.connect(filter).connect(envelope).connect(output).connect(context.destination);
        noise.start();
        noise.stop(start + 3);
        void context.resume().catch(error => console.warn('[radio] Tuning audio unavailable:', error.message));
      } catch (error) {
        console.warn('[radio] Could not create tuning audio:', error.message);
      }
    }
    return new Promise(resolve => {
      finish = resolve;
      timer = setTimeout(stop, RADIO_AD_TRANSITION_MS);
    });
  }

  return { play, stop, setVolume };
}
