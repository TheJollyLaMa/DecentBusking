import { roomRequest } from './live-audio-client.mjs';
import { sharedPageListenerTelemetry, warnTelemetryUnavailable } from './live-listener-telemetry.mjs?v=20261117-lease-recovery';

let sdkPromise;
let audibleBroadcast = null;
export function getAudibleBroadcast(now = Date.now()) {
  return audibleBroadcast && now - audibleBroadcast.observedAt <= 12000 ? { ...audibleBroadcast } : null;
}
export function loadHlsSdk(serviceUrl) {
  if (globalThis.Hls) return Promise.resolve(globalThis.Hls);
  sdkPromise ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = setTimeout(() => failed(), 15000);
    function failed() {
      clearTimeout(timeout); script.remove(); sdkPromise = null;
      reject(new Error('Broadcast player could not load'));
    }
    script.src = `${serviceUrl}/api/radio/hls-client.js`;
    script.onload = () => {
      clearTimeout(timeout);
      if (globalThis.Hls) resolve(globalThis.Hls);
      else failed();
    };
    script.onerror = failed;
    document.head.append(script);
  });
  return sdkPromise;
}

export function broadcastProgramAt(history, at) {
  if (!Number.isFinite(at)) return null;
  return history?.findLast(entry => Number.isFinite(entry.at) && entry.at <= at) || null;
}

export function createPublicBroadcastListener({ audio, serviceUrl, onStatus, onProgram,
  sdkLoader = loadHlsSdk, now = Date.now, request = roomRequest,
  telemetry = sharedPageListenerTelemetry(serviceUrl) }) {
  let state, hls, url = null, generation = 0, timer, stateAt = 0, currentProgram = null;
  let opening = false, blocked = false, stopped = true, failed = false, recoveryAttempts = 0, telemetryBooking = null;
  let lastMediaTime = -1, lastProgressAt = now();
  const source = {};
  const report = reason => onStatus?.({ blocked, failed, reason,
    playing: !audio.paused && audio.readyState >= 2 && !failed });
  function record(method, ...args) {
    try { return telemetry?.[method]?.(...args); }
    catch { warnTelemetryUnavailable(); return undefined; }
  }
  const stop = () => {
    generation++; opening = false; stopped = true; clearInterval(timer); timer = null;
    audibleBroadcast = null;
    hls?.destroy(); hls = null; url = null; currentProgram = null; telemetryBooking = null;
    record('leave', source);
    audio.pause(); audio.removeAttribute('src'); audio.load();
  };
  function fail(reason) {
    stop(); failed = true; report(reason);
  }
  async function observe(program) {
    if (!program.live || !program.bookingId) {
      if (telemetryBooking) record('leave', source);
      telemetryBooking = null; return;
    }
    if (telemetryBooking === program.bookingId) {
      if (!audio.paused && !audio.muted && audio.volume > 0) record('audio', source);
      return;
    }
    telemetryBooking = program.bookingId;
    const beganAt = now(), current = generation;
    try {
      const pageId = record('grantPageId');
      const grant = await request(serviceUrl, 'listen', {
        transport: 'hls', bookingId: program.bookingId, ...(pageId ? { telemetryPageId: pageId } : {}),
      });
      if (current === generation && telemetryBooking === program.bookingId) {
        record('join', source, grant.telemetryToken, program.bookingId, beganAt, grant.telemetryRenewal);
      }
    } catch { warnTelemetryUnavailable(); }
  }
  function tick() {
    if (stopped) return;
    if (now() - stateAt > 60000) { fail('Radio control connection lost; broadcast stopped'); return; }
    if (audio.paused || audio.currentTime !== lastMediaTime) {
      lastMediaTime = audio.currentTime; lastProgressAt = now();
    }
    if (!audio.paused && !blocked && now() - lastProgressAt > 12000) {
      audibleBroadcast = null; record('suspend', source);
      if (now() - lastProgressAt > 30000) fail('The broadcast playlist stalled. Tap Play to retry; no live-room seat was joined.');
      else report('The broadcast has stalled; waiting for audio without switching to a live-room seat');
      return;
    }
    const origin = hls?.playingDate?.getTime?.() ??
      (typeof audio.getStartDate === 'function' ? audio.getStartDate().getTime() + audio.currentTime * 1000 : NaN);
    const program = broadcastProgramAt(state?.programHistory, origin);
    if (!program) audibleBroadcast = null;
    if (program) {
      audibleBroadcast = !audio.paused && audio.readyState >= 2 && !blocked
        ? { program, at: origin, observedAt: now() } : null;
      if (currentProgram?.playId !== program.playId) {
        currentProgram = program; onProgram?.(program);
      }
      void observe(program);
    }
    report(blocked ? 'Tap Play to hear the buffered radio broadcast'
      : 'Buffered radio: approximately 10–20 seconds behind the studio');
  }
  async function play() {
    await audio.play(); blocked = false; report();
  }
  async function connect() {
    if (opening || url || state?.status !== 'ready' || failed) return;
    opening = true; stopped = false;
    const current = ++generation, nextUrl = state.url;
    try {
      const parsed = new URL(nextUrl);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash ||
          !/^\/hls\/[a-f0-9]{32}\/index\.m3u8$/.test(parsed.pathname)) throw new Error('Invalid public broadcast address');
      if (audio.canPlayType('application/vnd.apple.mpegurl') && typeof audio.getStartDate === 'function') {
        audio.src = nextUrl;
      } else {
        const Hls = await sdkLoader(serviceUrl);
        if (current !== generation) return;
        if (!Hls.isSupported()) throw new Error('This browser does not support the broadcast player');
        // Past six segments (~24 s) behind the playlist edge, jump back to ~12 s instead of drifting; never speed up music.
        hls = new Hls({ liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 6,
          maxLiveSyncPlaybackRate: 1, maxBufferLength: 30, backBufferLength: 10 });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (current !== generation) return;
          if (!data.fatal) { report('Broadcast interrupted; reconnecting without switching to a live-room seat'); return; }
          record('suspend', source);
          if (data.details === 'bufferAddCodecError') {
            fail('This browser cannot decode the AAC broadcast. Try a current Safari or Chrome; no live-room seat was joined.');
            return;
          }
          if (++recoveryAttempts > 3) { fail('Broadcast unavailable. The producer can select the bounded direct-room fallback.'); return; }
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          else fail('Broadcast playback failed; no automatic live-room fallback was attempted');
        });
        hls.loadSource(nextUrl); hls.attachMedia(audio);
      }
      if (current !== generation) return;
      url = nextUrl; clearInterval(timer); timer = setInterval(tick, 1000);
      lastMediaTime = -1; lastProgressAt = now();
      timer.unref?.();
      try { await play(); }
      catch { if (current === generation) { blocked = true; report('Tap Play to hear the buffered radio broadcast'); } }
    } catch (error) {
      if (current === generation) fail(error.message);
    } finally { if (current === generation) opening = false; }
  }
  return {
    update(next) {
      const changed = state?.url !== next?.url;
      state = next; stateAt = now();
      if (changed) {
        if (!stopped) stop();
        failed = false; recoveryAttempts = 0;
      }
      if (!next?.selected) { if (!stopped) stop(); return; }
      if (next.status === 'unavailable') {
        if (!failed) fail('The public broadcast is unavailable; no live-room seat was joined');
        return;
      }
      if (url && url !== next.url) {
        stop(); failed = false; recoveryAttempts = 0;
      }
      if (!url && !failed) void connect();
      if (next.status !== 'ready') report('The public broadcast is buffering; no live-room seat was joined');
      else if (!stopped) tick();
    },
    play: async () => {
      if (failed) { failed = false; recoveryAttempts = 0; await connect(); }
      if (opening) return;
      await play();
    },
    stop,
  };
}
