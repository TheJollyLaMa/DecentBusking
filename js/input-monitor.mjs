/**
 * Optional, local-only headphone monitoring; off until start() is called.
 * Prefer an audio interface's direct monitoring (no browser latency). Callers
 * must warn about headphone use/feedback before enabling this in either room.
 * This helper never captures, records, publishes, or stops the supplied track.
 *
 * start(localTrack, volume = 0.25) resolves true when connected, false if
 * superseded/stopped. setVolume(volume) accepts finite numbers from 0 to 1.
 * stop() disconnects immediately and resolves when its AudioContext is closed.
 * Await start()/stop() and surface failures to the user.
 */
export function createInputMonitor(environment = globalThis) {
  let generation = 0;
  let active = null;

  function validateVolume(volume) {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      throw new RangeError('Input monitor volume must be a finite number between 0 and 1.');
    }
    return volume;
  }

  function dispose(session) {
    if (!session) return Promise.resolve();
    if (session.cleanup) return session.cleanup;
    const errors = [];
    for (const node of [session.source, session.gain]) {
      try { node?.disconnect(); } catch (error) { errors.push(error); }
    }
    let closing;
    try { closing = session.context.close(); } catch (error) { errors.push(error); }
    session.cleanup = Promise.resolve(closing)
      .catch(error => { errors.push(error); })
      .then(() => {
        if (errors.length) throw new AggregateError(errors, 'Input monitor teardown failed.');
      });
    return session.cleanup;
  }

  function stop() {
    generation++;
    const previous = active;
    active = null;
    return dispose(previous);
  }

  async function start(localTrack, volume = 0.25) {
    validateVolume(volume);
    const track = localTrack?.mediaStreamTrack;
    if (!track || track.kind !== 'audio' || track.readyState === 'ended') {
      throw new TypeError('Input monitoring requires a live local audio track.');
    }
    const AudioContext = environment.AudioContext || environment.webkitAudioContext;
    const MediaStream = environment.MediaStream;
    if (typeof AudioContext !== 'function' || typeof MediaStream !== 'function') {
      throw new Error('Browser input monitoring is unsupported: Web Audio and MediaStream are required.');
    }
    const closing = stop();
    const request = generation;
    await closing;
    if (request !== generation) return false;
    const session = { context: new AudioContext(), source: null, gain: null, cleanup: null };
    active = session;
    try {
      session.source = session.context.createMediaStreamSource(new MediaStream([track]));
      session.gain = session.context.createGain();
      session.gain.gain.value = volume;
      await session.context.resume();
      if (request !== generation) return false;
      if (session.context.state !== 'running') {
        throw new Error('Browser input monitoring could not start: the audio context is not running.');
      }
      session.source.connect(session.gain);
      session.gain.connect(session.context.destination);
      return true;
    } catch (error) {
      if (request !== generation) return false;
      active = null;
      try { await dispose(session); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Input monitoring failed and could not fully tear down.');
      }
      throw error;
    }
  }

  function setVolume(volume) {
    validateVolume(volume);
    if (active?.gain) active.gain.gain.value = volume;
  }

  return { start, setVolume, stop };
}

/**
 * Bind identical opt-in controls in practice and backstage. toggle is a
 * checkbox; volume is a 0..1 range input; status is a dedicated status element.
 * getTrack() must return the current LiveKit localTrack (or null).
 * Call/await stop() on every disconnect and before replacing the input.
 * stop() retains listeners so the same controls can be used after reconnecting.
 */
export function bindInputMonitor({ toggle, volume, status, getTrack }, environment = globalThis) {
  const monitor = createInputMonitor(environment);
  let revision = 0;
  const offMessage = 'Monitor off. Headphones required to avoid feedback; direct interface monitoring is recommended.';
  toggle.checked = false;
  toggle.setAttribute('aria-label', 'I am wearing headphones: enable browser input monitoring');
  volume.min = '0';
  volume.max = '1';
  volume.step = '0.01';
  volume.value = '0.25';
  status.setAttribute('role', 'status');
  status.textContent = offMessage;

  async function stop() {
    const request = ++revision;
    toggle.checked = false;
    status.textContent = offMessage;
    try { await monitor.stop(); } catch (error) {
      if (request === revision) status.textContent = `Input monitor error: ${error.message}`;
      throw error;
    }
  }

  async function fail(error, request) {
    if (request !== revision) return;
    const stopping = stop();
    status.textContent = `Input monitor error: ${error.message}`;
    try { await stopping; } catch { /* stop() has already surfaced the teardown error. */ }
  }

  toggle.addEventListener('change', async () => {
    if (!toggle.checked) {
      try { await stop(); } catch { /* stop() has already surfaced the error. */ }
      return;
    }
    const request = ++revision;
    try {
      const track = getTrack();
      if (!track) {
        await stop();
        if (request + 1 === revision) status.textContent = 'Start your microphone first, then enable headphone monitoring.';
        return;
      }
      status.textContent = 'Starting headphone monitor…';
      const started = await monitor.start(track, Number(volume.value));
      if (request === revision && started) {
        status.textContent = 'Headphone monitor on (browser latency). Direct interface monitoring is recommended.';
      }
    } catch (error) { await fail(error, request); }
  });

  volume.addEventListener('input', async () => {
    const request = revision;
    try { monitor.setVolume(Number(volume.value)); } catch (error) { await fail(error, request); }
  });

  return { stop };
}
