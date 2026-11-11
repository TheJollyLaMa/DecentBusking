import { listenerAudioStatus } from './live-audio.mjs';

let sdkPromise;
export function loadLiveAudioSdk(serviceUrl) {
  if (globalThis.LivekitClient) return Promise.resolve(globalThis.LivekitClient);
  sdkPromise ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${serviceUrl.replace(/\/$/, '')}/api/live-audio/client.js`;
    script.onload = () => globalThis.LivekitClient ? resolve(globalThis.LivekitClient) : reject(new Error('Audio client unavailable'));
    script.onerror = () => { sdkPromise = null; reject(new Error('Audio client unavailable')); };
    document.head.append(script);
  });
  return sdkPromise;
}

export async function roomRequest(serviceUrl, path, input, token, fetchImpl = fetch) {
  const response = await fetchImpl(`${serviceUrl.replace(/\/$/, '')}/api/live-audio/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(input), signal: AbortSignal.timeout(
      path === 'session' || ['check', 'arm', 'cancel'].includes(input.action) ? 60_000 : 10_000), cache: 'no-store',
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Live audio is unavailable');
  return result;
}

export function createLiveAudioListener({ audio, serviceUrl, onStatus, sdkLoader = loadLiveAudioSdk,
  request = roomRequest, now = () => Date.now() }) {
  let room, track, state, stateAt = 0, lastPacketAt = 0, packets = 0;
  let generation = 0, connecting = false, retryAt = 0, timer, blocked = false, checking = false;
  const report = reason => onStatus?.({
    status: listenerAudioStatus({ phase: state?.phase, serverStatus: now() - stateAt > 12_000 ? 'RECONNECTING' : state?.status,
      connected: room?.state === 'connected', playing: !audio.paused && !blocked,
      lastPacketAt, now: now() }), blocked, reason: reason || (blocked ? 'Tap Play to hear the live performance' : ''),
  });
  async function check() {
    if (checking) return;
    checking = true;
    const current = generation, observedTrack = track;
    try {
      if (now() - stateAt > 60_000) {
        await disconnect();
        report('Radio control connection lost; live audio stopped');
        return;
      }
      const stats = await track?.getRTCStatsReport();
      if (current !== generation || observedTrack !== track) return;
      let count = 0;
      stats?.forEach(entry => {
        if (entry.type === 'inbound-rtp' && (entry.kind || entry.mediaType) === 'audio') {
          count += Number(entry.packetsReceived || 0);
        }
      });
      if (count > packets) lastPacketAt = now();
      packets = count;
      report();
    } catch { report('Live audio is reconnecting'); }
    finally { checking = false; }
  }
  async function connect() {
    if (connecting || room || now() < retryAt || !state?.armed || state.phase !== 'live') return;
    connecting = true;
    const current = ++generation;
    try {
      const sdk = await sdkLoader(serviceUrl);
      const grant = await request(serviceUrl, 'listen', { bookingId: state.bookingId });
      if (current !== generation) return;
      const next = new sdk.Room({ adaptiveStream: false, dynacast: false });
      room = next;
      const subscribe = (publication, participant) => {
        if (participant.identity === grant.publisherIdentity && publication.kind === sdk.Track.Kind.Audio) publication.setSubscribed(true);
      };
      next.on(sdk.RoomEvent.TrackPublished, subscribe);
      next.on(sdk.RoomEvent.TrackSubscribed, (remote, publication, participant) => {
        if (current !== generation || remote.kind !== sdk.Track.Kind.Audio || participant.identity !== grant.publisherIdentity) return;
        track?.detach(audio);
        track = remote; packets = 0; lastPacketAt = 0;
        remote.attach(audio);
        void audio.play().then(() => {
          if (current === generation) { blocked = false; report(); }
        }).catch(() => {
          if (current === generation) { blocked = true; report(); }
        });
      });
      next.on(sdk.RoomEvent.TrackUnsubscribed, remote => {
        if (track === remote) { track.detach(audio); track = null; lastPacketAt = 0; report(); }
      });
      next.on(sdk.RoomEvent.Reconnecting, () => { lastPacketAt = 0; report(); });
      next.on(sdk.RoomEvent.Disconnected, () => {
        if (current !== generation) return;
        track?.detach(audio); track = null; room = null; lastPacketAt = 0; retryAt = now() + 5000; report();
      });
      await next.connect(grant.url, grant.token, { autoSubscribe: false });
      if (current !== generation) { await next.disconnect(); return; }
      for (const participant of next.remoteParticipants.values()) {
        for (const publication of participant.trackPublications.values()) subscribe(publication, participant);
      }
      clearInterval(timer); timer = setInterval(() => { void check(); }, 1000);
      report();
    } catch (error) {
      if (current === generation) {
        await disconnect();
        retryAt = now() + 5000;
        report(error.message);
      }
    } finally { if (current === generation) connecting = false; }
  }
  async function disconnect() {
    ++generation; connecting = false; clearInterval(timer);
    const previous = room; room = null;
    track?.detach(audio); track = null; audio.pause(); audio.srcObject = null; lastPacketAt = 0;
    await previous?.disconnect().catch(() => {});
  }
  return {
    update(next) {
      const changed = state?.bookingId !== next?.bookingId;
      state = next; stateAt = now();
      if (!next || next.phase !== 'live' || !next.armed) { void disconnect(); return; }
      if (changed) void disconnect().then(connect);
      else void connect();
      report();
    },
    async play() {
      await room?.startAudio();
      await audio.play(); blocked = false; report();
    },
    disconnect,
  };
}

export function createLiveAudioFaultSlate() {
  let panel, context, timer;
  function stop() {
    clearTimeout(timer);
    panel?.remove(); panel = null;
    void context?.close().catch(() => {}); context = null;
  }
  return {
    stop,
    play({ message, remainingMs, volume = 0 }) {
      stop();
      const duration = Math.max(0, Math.min(5000, remainingMs));
      if (!duration) return;
      panel = document.createElement('aside');
      panel.setAttribute('role', 'status');
      panel.className = 'live-audio-fault';
      const bars = document.createElement('div'); bars.className = 'live-audio-color-bars'; bars.setAttribute('aria-hidden', 'true');
      const text = document.createElement('p'); text.textContent = message;
      const dismiss = document.createElement('button'); dismiss.textContent = 'Dismiss / silence'; dismiss.onclick = stop;
      panel.append(bars, text, dismiss); document.body.append(panel);
      const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (AudioContext && volume > 0) {
        try {
          context = new AudioContext();
          const output = context.createGain(), start = context.currentTime, seconds = duration / 1000;
          output.gain.setValueAtTime(0, start);
          output.gain.linearRampToValueAtTime(Math.min(1, volume) * 0.008, start + Math.min(0.1, seconds / 2));
          output.gain.linearRampToValueAtTime(0, start + seconds);
          output.connect(context.destination);
          const noise = context.createBufferSource(), tone = context.createOscillator(), toneGain = context.createGain();
          const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * seconds), context.sampleRate);
          const samples = buffer.getChannelData(0);
          for (let i = 0; i < samples.length; i++) samples[i] = (Math.random() * 2 - 1) * 0.5;
          noise.buffer = buffer; noise.connect(output);
          tone.frequency.value = 440; toneGain.gain.value = 0.25; tone.connect(toneGain).connect(output);
          noise.start(); tone.start(); noise.stop(start + seconds); tone.stop(start + seconds);
          void context.resume().catch(() => {});
        } catch { /* The visual/text slate remains available when Web Audio is blocked. */ }
      }
      timer = setTimeout(stop, duration);
    },
  };
}
