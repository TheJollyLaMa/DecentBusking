/**
 * Optional, local-only headphone monitoring; off until start() is called.
 * Prefer an audio interface's direct monitoring (no browser latency). Callers
 * must warn about headphone use/feedback before enabling this in either room.
 * This helper never captures, records, publishes, or stops the supplied track.
 *
 * start(localTrack, volume = 0.25) resolves true when connected, false if
 * superseded/stopped. setVolume(volume) accepts finite numbers from 0 to 1.
 * stop() disconnects immediately and resolves when its AudioContext is closed.
 * setOutput(deviceId) routes monitoring to that output and retains the choice
 * across stop/start. An empty ID means the system default.
 * Await start()/stop() and surface failures to the user.
 */
export function createInputMonitor(environment = globalThis) {
  let generation = 0;
  let active = null;
  let outputId = '';

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
      if (outputId) {
        if (typeof session.context.setSinkId !== 'function') throw new Error('Output selection is unsupported. Choose your interface in system sound settings.');
        await session.context.setSinkId(outputId);
        if (request !== generation) return false;
      }
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

  async function setOutput(deviceId) {
    if (typeof deviceId !== 'string') throw new TypeError('Audio output must be a device ID.');
    const session = active;
    if (session) {
      if (typeof session.context.setSinkId !== 'function') throw new Error('Output selection is unsupported. Choose your interface in system sound settings.');
      await session.context.setSinkId(deviceId);
      if (active !== session) return false;
    }
    outputId = deviceId;
    return true;
  }

  return { start, setVolume, setOutput, stop };
}

/**
 * Bind identical opt-in controls in practice and backstage. toggle is a
 * checkbox; volume is a 0..1 range input; status is a dedicated status element.
 * getTrack() must return the current LiveKit localTrack (or null).
 * Call/await stop() on every disconnect and before replacing the input.
 * stop() retains listeners so the same controls can be used after reconnecting.
 */
export function bindInputMonitor({ toggle, volume, status, getTrack, output, outputDevices, outputStatus, audio }, environment = globalThis) {
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

  if (output && outputDevices && outputStatus) {
    const AudioContext = environment.AudioContext || environment.webkitAudioContext;
    const devices = environment.navigator?.mediaDevices;
    const supported = typeof AudioContext?.prototype?.setSinkId === 'function' &&
      (!audio || typeof audio.setSinkId === 'function') && typeof devices?.enumerateDevices === 'function';
    output.disabled = !supported;
    outputDevices.disabled = !supported;
    outputStatus.textContent = supported ? 'Output: system default. Choose your interface/headphones below.'
      : 'This browser cannot select an output. Choose your interface in your computer’s sound output settings.';
    let selectedOutput = '', changing = false;
    async function changeOutput(id) {
      if (audio) await audio.setSinkId(id);
      try {
        const applied = await monitor.setOutput(id);
        if (!applied) throw new Error('Monitor changed during output selection. Choose the output again.');
      } catch (error) {
        if (audio) {
          try { await audio.setSinkId(selectedOutput); }
          catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Output routing failed; previous listening output could not be restored.'); }
        }
        throw error;
      }
      selectedOutput = id;
      const label = output.selectedOptions[0]?.textContent || 'Selected output';
      outputStatus.textContent = `Output selected: ${label}. Applies to headphone monitor and room listening, not microphone input.`;
    }
    async function choose(fn) {
      if (changing) return;
      changing = true; output.disabled = true; outputDevices.disabled = true;
      outputStatus.textContent = 'Choosing audio output…';
      try { await fn(); }
      catch (error) {
        output.value = selectedOutput;
        outputStatus.textContent = `Output selection failed: ${error.message}. Check browser permission or use system sound settings.`;
      } finally { changing = false; output.disabled = false; outputDevices.disabled = false; }
    }
    output.addEventListener('change', () => choose(() => changeOutput(output.value)));
    outputDevices.addEventListener('click', () => choose(async () => {
      const granted = typeof devices.selectAudioOutput === 'function' ? await devices.selectAudioOutput() : null;
      const available = (await devices.enumerateDevices()).filter(device => device.kind === 'audiooutput' && device.deviceId);
      if (granted && !available.some(device => device.deviceId === granted.deviceId)) available.push(granted);
      if (!available.length) throw new Error('No audio outputs exposed. Allow microphone access/list inputs first, then try again.');
      const option = (value, text) => {
        const node = environment.document.createElement('option');
        node.value = value; node.textContent = text; return node;
      };
      output.replaceChildren(option('', 'System default output'),
        ...available.map((device, index) => option(device.deviceId, device.label || `Audio output ${index + 1}`)));
      output.value = granted?.deviceId || selectedOutput;
      if (granted) await changeOutput(granted.deviceId);
      else {
        if (output.value !== selectedOutput) throw new Error('Your selected output is no longer available. Choose another output.');
        outputStatus.textContent = 'Outputs listed. Choose your interface/headphones from the selector.';
      }
    }));
  }

  return { stop };
}
