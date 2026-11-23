import { createPublicBroadcastListener, getAudibleBroadcast } from './public-broadcast-client.mjs?v=20261120-boundary-sync';
import { createPublicRadioVideo } from './public-radio-video.mjs';

export function createSyncedPlaybackMeter(expectedMs) {
  let previous, countedThrough = 0, syncedMs = 0;
  return sample => {
    if (!sample) {
      previous = undefined;
      return syncedMs;
    }
    const { position, audioTime, frameTime, time } = sample;
    if (![position, audioTime, frameTime, time].every(Number.isFinite) || position < 0 ||
        Math.abs(position - frameTime) > 750) {
      previous = undefined;
      return syncedMs;
    }
    if (previous) {
      const step = position - previous.position;
      const audioStep = audioTime - previous.audioTime;
      const videoStep = frameTime - previous.frameTime;
      const elapsed = time - previous.time;
      if (step > 0 && step <= 750 && audioStep > 0 && videoStep > 0 &&
          elapsed > 0 && elapsed <= 750 && Math.abs(audioStep - step) <= 100 &&
          Math.abs(videoStep - step) <= 150 && Math.abs(elapsed - step) <= 150) {
        const end = Math.min(expectedMs, position);
        syncedMs += Math.max(0, end - Math.max(previous.position, countedThrough));
        countedThrough = Math.max(end, countedThrough);
      }
    }
    previous = sample;
    return syncedMs;
  };
}

export async function verifyRadioPlayback(job, serviceUrl) {
  const audio = document.createElement('audio');
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  document.body.append(audio, video);
  const measure = createSyncedPlaybackMeter(job.expectedMs);
  let frame, frameCallback, stateTimer, sampleTimer, controller, transport, syncedMs = 0, seen = false, running = true;
  const player = createPublicRadioVideo({ video, mediaUrl: cid => `${serviceUrl}/api/radio/media?cid=${encodeURIComponent(cid)}`,
    onActive() {}, onError() { measure(null); } });
  const listener = createPublicBroadcastListener({ audio, serviceUrl, telemetry: null });
  try {
    const frameReady = (at, data) => {
      frame = { at, time: data.mediaTime * 1000 };
      frameCallback = video.requestVideoFrameCallback(frameReady);
    };
    frameCallback = video.requestVideoFrameCallback(frameReady);
    return await new Promise(resolve => {
      const finish = reason => {
        console.info(`[dmtv-proof] ${reason}; synced ${Math.round(syncedMs)} of ${job.expectedMs} ms`);
        resolve(syncedMs);
      };
      async function poll() {
        controller = new AbortController();
        try {
          const response = await fetch(`${serviceUrl}/api/radio`, {
            cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]),
          });
          if (!response.ok) throw new Error('Public radio state unavailable');
          const next = (await response.json()).publicBroadcast;
          if (transport?.stateUrl && next?.url === transport.url) {
            try {
              const edge = await fetch(transport.stateUrl, {
                cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
              });
              if (edge.ok) {
                const state = (await edge.json()).publicBroadcast;
                if (state?.url === next.url) next.programHistory = state.programHistory || next.programHistory;
              }
            } catch (error) {
              console.warn('Using public radio origin after edge state read failed', error.name);
            }
          }
          if (running) {
            transport = next;
            listener.update(next);
          }
        } catch (error) {
          console.warn('Public radio verification state read failed', error.name);
        } finally {
          controller = null;
        }
      }
      void poll();
      stateTimer = setInterval(() => { if (!controller) void poll(); }, 2000);
      sampleTimer = setInterval(() => {
        if (Date.now() >= job.deadline || audio.error || video.error) {
          finish(Date.now() >= job.deadline ? 'deadline' : audio.error ? `audio error ${audio.error.code}` : `video error ${video.error.code}`);
          return;
        }
        const audible = getAudibleBroadcast();
        const program = audible?.program;
        if (program?.playId !== job.playId || program.ipfsCid !== job.ipfsCid || program.mediaType !== 'video/mp4') {
          if (seen && program && program.playId !== job.playId) finish(`program changed to ${program.playId}`);
          measure(null);
          return;
        }
        seen = true;
        const time = performance.now();
        // The listener's program clock is sampled; interpolate with the audio element between events.
        const position = audible.at - program.at + (audio.currentTime - audible.mediaTime) * 1000;
        player.update({ ...audible, at: program.at + position });
        if (audio.paused || audio.seeking || video.paused || video.seeking || audio.readyState < 3 ||
            video.readyState < 3 || !frame || time - frame.at > 400) {
          measure(null);
          return;
        }
        syncedMs = measure({ position, audioTime: audio.currentTime * 1000, frameTime: frame.time, time });
        if (syncedMs >= job.expectedMs / 2) finish('verified');
      }, 200);
    });
  } finally {
    running = false;
    clearInterval(stateTimer);
    clearInterval(sampleTimer);
    controller?.abort();
    if (frameCallback != null) video.cancelVideoFrameCallback(frameCallback);
    listener.stop();
    player.stop();
    audio.remove();
    video.remove();
  }
}
