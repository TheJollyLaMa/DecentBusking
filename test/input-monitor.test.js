const test = require('node:test');
const assert = require('node:assert/strict');

async function fixture(options = {}) {
  const { createInputMonitor, bindInputMonitor } = await import('../js/input-monitor.mjs');
  const contexts = [];
  const track = { kind: 'audio', readyState: 'live', stop() { throw Error('Must not stop input'); } };
  class MediaStream {
    constructor(tracks) { this.tracks = tracks; }
  }
  function node() {
    return {
      connections: [], disconnects: 0,
      connect(target) { this.connections.push(target); },
      disconnect() { this.disconnects++; this.connections = []; },
    };
  }
  class AudioContext {
    constructor() {
      this.state = 'suspended';
      this.destination = {};
      this.source = node();
      this.gainNode = { ...node(), gain: { value: 1 } };
      this.closes = 0;
      contexts.push(this);
    }
    createMediaStreamSource(stream) { this.stream = stream; return this.source; }
    createGain() { return this.gainNode; }
    async setSinkId(id) {
      if (options.outputError) throw options.outputError;
      this.sinkId = id;
    }
    async resume() {
      if (options.resume) await options.resume(this);
      else this.state = 'running';
    }
    async close() { this.closes++; this.state = 'closed'; if (options.closeError) throw options.closeError; }
  }
  return {
    monitor: createInputMonitor({ AudioContext, MediaStream }),
    createInputMonitor, bindInputMonitor, AudioContext, MediaStream, contexts, track,
  };
}

test('off by default; starts only the supplied track at a safe local gain', async () => {
  const f = await fixture();
  assert.equal(f.contexts.length, 0);
  f.monitor.setVolume(0.9);
  assert.equal(f.contexts.length, 0);
  assert.equal(await f.monitor.start({ mediaStreamTrack: f.track }), true);
  const c = f.contexts[0];
  assert.deepEqual(c.stream.tracks, [f.track]);
  assert.equal(c.gainNode.gain.value, 0.25);
  assert.deepEqual(c.source.connections, [c.gainNode]);
  assert.deepEqual(c.gainNode.connections, [c.destination]);
  f.monitor.setVolume(0);
  assert.equal(c.gainNode.gain.value, 0);
  f.monitor.setVolume(1);
  assert.equal(c.gainNode.gain.value, 1);
  await f.monitor.stop();
  assert.equal(f.track.readyState, 'live');
});

test('stop disconnects both nodes immediately and closes once; restart replaces the input', async () => {
  const f = await fixture();
  await f.monitor.start({ mediaStreamTrack: f.track }, 0.1);
  const first = f.contexts[0];
  const replacement = { ...f.track };
  assert.equal(await f.monitor.start({ mediaStreamTrack: replacement }, 0.4), true);
  assert.equal(first.closes, 1);
  assert.equal(first.source.disconnects, 1);
  assert.equal(first.gainNode.disconnects, 1);
  const second = f.contexts[1];
  assert.deepEqual(second.stream.tracks, [replacement]);
  assert.equal(second.gainNode.gain.value, 0.4);
  const stopped = f.monitor.stop();
  assert.deepEqual(second.source.connections, []);
  assert.deepEqual(second.gainNode.connections, []);
  await stopped;
  await f.monitor.stop();
  assert.equal(second.closes, 1);
});

test('stop during resume never reconnects after late completion', async () => {
  let resume;
  const f = await fixture({ resume: () => new Promise(resolve => { resume = resolve; }) });
  const pending = f.monitor.start({ mediaStreamTrack: f.track });
  await Promise.resolve();
  const c = f.contexts[0];
  await f.monitor.stop();
  resume();
  assert.equal(await pending, false);
  assert.deepEqual(c.source.connections, []);
  assert.deepEqual(c.gainNode.connections, []);
  assert.equal(c.closes, 1);
});

test('replacement during resume cannot reconnect the old input', async () => {
  let resume;
  const f = await fixture({ resume: c => {
    if (f.contexts.length === 1) return new Promise(resolve => { resume = resolve; });
    c.state = 'running';
  } });
  const pending = f.monitor.start({ mediaStreamTrack: f.track });
  await Promise.resolve();
  const first = f.contexts[0];
  assert.equal(await f.monitor.start({ mediaStreamTrack: { ...f.track } }), true);
  resume();
  assert.equal(await pending, false);
  assert.deepEqual(first.source.connections, []);
  assert.equal(first.closes, 1);
  assert.equal(f.contexts[1].source.connections.length, 1);
  await f.monitor.stop();
});

test('stop before asynchronous start setup cancels without creating a context', async () => {
  const f = await fixture();
  const pending = f.monitor.start({ mediaStreamTrack: f.track });
  await f.monitor.stop();
  assert.equal(await pending, false);
  assert.equal(f.contexts.length, 0);
});

test('unsupported features and invalid inputs fail explicitly', async () => {
  const f = await fixture();
  for (const environment of [{}, { AudioContext: f.AudioContext }, { MediaStream: f.MediaStream }]) {
    await assert.rejects(f.createInputMonitor(environment).start({ mediaStreamTrack: f.track }), /unsupported/);
  }
  for (const track of [undefined, {}, { mediaStreamTrack: { kind: 'video' } },
    { mediaStreamTrack: { kind: 'audio', readyState: 'ended' } }]) {
    await assert.rejects(f.monitor.start(track), /live local audio track/);
  }
  assert.equal(f.contexts.length, 0);
});

test('volume rejects nonfinite, nonnumeric, and out-of-range values without changing output', async () => {
  const f = await fixture();
  await f.monitor.start({ mediaStreamTrack: f.track });
  for (const volume of [-0.01, 1.01, NaN, Infinity, -Infinity, '0.5', null, undefined]) {
    assert.throws(() => f.monitor.setVolume(volume), RangeError);
    if (volume !== undefined) {
      await assert.rejects(f.monitor.start({ mediaStreamTrack: f.track }, volume), RangeError);
    }
  }
  assert.equal(f.contexts[0].gainNode.gain.value, 0.25);
  assert.equal(f.contexts.length, 1);
  await f.monitor.stop();
});

test('resume failures are surfaced and release owned resources', async () => {
  const failure = Error('Permission denied');
  const f = await fixture({ resume: () => { throw failure; } });
  await assert.rejects(f.monitor.start({ mediaStreamTrack: f.track }), error => error === failure);
  assert.equal(f.contexts[0].closes, 1);
  assert.equal(f.contexts[0].source.disconnects, 1);
  assert.equal(f.contexts[0].gainNode.disconnects, 1);
  await f.monitor.stop();
});

test('a context that remains suspended is an explicit failure, not successful monitoring', async () => {
  const f = await fixture({ resume: () => {} });
  await assert.rejects(f.monitor.start({ mediaStreamTrack: f.track }), /not running/);
  assert.equal(f.contexts[0].closes, 1);
});

test('close failures are surfaced by stop', async () => {
  const f = await fixture({ closeError: Error('close failed') });
  await f.monitor.start({ mediaStreamTrack: f.track });
  await assert.rejects(f.monitor.stop(), /teardown failed/);
  assert.equal(f.contexts[0].source.disconnects, 1);
  assert.equal(f.contexts[0].gainNode.disconnects, 1);
});

function control() {
  const listeners = {};
  return {
    checked: true, value: '1', attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, listener) { listeners[name] = listener; },
    async emit(name) { await listeners[name](); },
  };
}

test('output routes before monitor audio connects, changes live and survives stop/start', async () => {
  const f = await fixture();
  await f.monitor.setOutput('interface-headphones');
  await f.monitor.start({ mediaStreamTrack: f.track });
  assert.equal(f.contexts[0].sinkId, 'interface-headphones');
  await f.monitor.setOutput('second-output');
  assert.equal(f.contexts[0].sinkId, 'second-output');
  await f.monitor.stop();
  await f.monitor.start({ mediaStreamTrack: f.track });
  assert.equal(f.contexts[1].sinkId, 'second-output');
  await f.monitor.setOutput('');
  assert.equal(f.contexts[1].sinkId, '');
  await assert.rejects(f.monitor.setOutput(null), /device ID/);
  await f.monitor.stop();
});

test('output routing errors do not play silently on default or stop the input', async () => {
  const f = await fixture({ outputError: Error('output denied') });
  await f.monitor.setOutput('interface');
  await assert.rejects(f.monitor.start({ mediaStreamTrack: f.track }), /output denied/);
  assert.equal(f.contexts[0].gainNode.connections.length, 0);
  assert.equal(f.contexts[0].closes, 1);
  assert.equal(f.track.readyState, 'live');
});

test('binding selects permission-granted output for monitor and remote audio; denied choices stay explicit', async () => {
  const f = await fixture();
  const output = { ...control(), value: '', selectedOptions: [{ textContent: 'Interface headphones' }],
    replaceChildren(...options) { this.options = options; } };
  const outputDevices = control(), outputStatus = control(), toggle = control(), volume = control(), status = control();
  let denied = false;
  const audio = { async setSinkId(id) { this.sinkId = id; } };
  const binding = f.bindInputMonitor({ toggle, volume, status, output, outputDevices, outputStatus, audio,
    getTrack: () => ({ mediaStreamTrack: f.track }) }, {
    AudioContext: f.AudioContext, MediaStream: f.MediaStream, document: { createElement: () => ({}) },
    navigator: { mediaDevices: {
      async selectAudioOutput() { if (denied) throw Error('permission denied'); return { deviceId: 'interface', label: 'Interface headphones', kind: 'audiooutput' }; },
      async enumerateDevices() { return []; },
    } },
  });
  await outputDevices.emit('click');
  assert.equal(output.value, 'interface');
  assert.equal(audio.sinkId, 'interface');
  assert.match(outputStatus.textContent, /Output selected/);
  toggle.checked = true; await toggle.emit('change');
  assert.equal(f.contexts[0].sinkId, 'interface');
  denied = true; await outputDevices.emit('click');
  assert.match(outputStatus.textContent, /Output selection failed.*permission denied/);
  assert.equal(audio.sinkId, 'interface');
  assert.equal(output.disabled, false);
  await binding.stop();
});

test('unsupported output selection directs users to system settings without claiming success', async () => {
  const f = await fixture();
  const output = control(), outputDevices = control(), outputStatus = control();
  f.bindInputMonitor({ toggle: control(), volume: control(), status: control(), output, outputDevices, outputStatus,
    getTrack: () => null }, { MediaStream: f.MediaStream });
  assert.equal(output.disabled, true);
  assert.equal(outputDevices.disabled, true);
  assert.match(outputStatus.textContent, /cannot select an output.*sound output settings/);
});

async function bindingFixture(options = {}) {
  const f = await fixture(options);
  const toggle = control(), volume = control(), status = control();
  let current = null;
  const binding = f.bindInputMonitor({
    toggle, volume, status, getTrack: () => current,
  }, { AudioContext: f.AudioContext, MediaStream: f.MediaStream });
  return { ...f, binding, toggle, volume, status, setTrack(track) { current = track; } };
}

test('binding defaults off with headphone confirmation and missing mic guidance', async () => {
  const f = await bindingFixture();
  assert.equal(f.toggle.checked, false);
  assert.match(f.toggle.attributes['aria-label'], /wearing headphones/);
  assert.match(f.status.textContent, /direct interface monitoring/i);
  assert.equal(f.volume.value, '0.25');
  assert.equal(f.contexts.length, 0);
  f.toggle.checked = true;
  await f.toggle.emit('change');
  assert.equal(f.toggle.checked, false);
  assert.match(f.status.textContent, /Start your microphone first/);
  assert.equal(f.contexts.length, 0);
});

test('binding uses current input, wires volume and supports awaitable stop/reconnect', async () => {
  const f = await bindingFixture();
  f.setTrack({ mediaStreamTrack: f.track });
  f.toggle.checked = true;
  await f.toggle.emit('change');
  assert.match(f.status.textContent, /monitor on/);
  f.volume.value = '0.6';
  await f.volume.emit('input');
  assert.equal(f.contexts[0].gainNode.gain.value, 0.6);
  await f.binding.stop();
  assert.equal(f.toggle.checked, false);
  assert.equal(f.contexts[0].closes, 1);
  const replacement = { ...f.track };
  f.setTrack({ mediaStreamTrack: replacement });
  f.toggle.checked = true;
  await f.toggle.emit('change');
  assert.deepEqual(f.contexts[1].stream.tracks, [replacement]);
  f.toggle.checked = false;
  await f.toggle.emit('change');
  assert.equal(f.contexts[1].closes, 1);
});

test('binding surfaces start and volume errors and resets checkbox', async () => {
  const f = await bindingFixture({ resume: () => { throw Error('resume denied'); } });
  f.setTrack({ mediaStreamTrack: f.track });
  f.toggle.checked = true;
  await f.toggle.emit('change');
  assert.equal(f.toggle.checked, false);
  assert.match(f.status.textContent, /Input monitor error: resume denied/);
  const good = await bindingFixture();
  good.setTrack({ mediaStreamTrack: good.track });
  good.toggle.checked = true;
  await good.toggle.emit('change');
  good.volume.value = '2';
  await good.volume.emit('input');
  assert.equal(good.toggle.checked, false);
  assert.match(good.status.textContent, /Input monitor error:.*volume/);
  assert.equal(good.contexts[0].closes, 1);
});

test('binding stop during start prevents stale status and checkbox updates', async () => {
  let resume;
  const f = await bindingFixture({ resume: () => new Promise(resolve => { resume = resolve; }) });
  f.setTrack({ mediaStreamTrack: f.track });
  f.toggle.checked = true;
  const pending = f.toggle.emit('change');
  await Promise.resolve();
  await f.binding.stop();
  resume();
  await pending;
  assert.equal(f.toggle.checked, false);
  assert.match(f.status.textContent, /Monitor off/);
  assert.deepEqual(f.contexts[0].source.connections, []);
});

test('a late resume rejection after stop is cancellation, not a reconnect or UI error', async () => {
  let rejectResume;
  const f = await bindingFixture({ resume: () => new Promise((resolve, reject) => { rejectResume = reject; }) });
  f.setTrack({ mediaStreamTrack: f.track });
  f.toggle.checked = true;
  const pending = f.toggle.emit('change');
  await Promise.resolve();
  await f.binding.stop();
  rejectResume(Error('context closed during resume'));
  await pending;
  assert.equal(f.toggle.checked, false);
  assert.match(f.status.textContent, /Monitor off/);
  assert.equal(f.contexts[0].closes, 1);
});

test('partial connection failures disconnect both nodes and close context', async () => {
  const failure = Error('destination unavailable');
  const f = await fixture({ resume: c => {
    c.state = 'running';
    c.gainNode.connect = () => { throw failure; };
  } });
  await assert.rejects(f.monitor.start({ mediaStreamTrack: f.track }), error => error === failure);
  assert.deepEqual(f.contexts[0].source.connections, []);
  assert.equal(f.contexts[0].gainNode.disconnects, 1);
  assert.equal(f.contexts[0].closes, 1);
});

test('webkit AudioContext fallback is supported', async () => {
  const f = await fixture();
  const monitor = f.createInputMonitor({ webkitAudioContext: f.AudioContext, MediaStream: f.MediaStream });
  assert.equal(await monitor.start({ mediaStreamTrack: f.track }), true);
  await monitor.stop();
});

test('binding surfaces unsupported browsers and teardown failures without leaving checkbox enabled', async () => {
  const f = await fixture();
  const toggle = control(), volume = control(), status = control();
  f.bindInputMonitor({ toggle, volume, status, getTrack: () => ({ mediaStreamTrack: f.track }) }, {});
  toggle.checked = true;
  await toggle.emit('change');
  assert.equal(toggle.checked, false);
  assert.match(status.textContent, /Input monitor error:.*unsupported/);
  const broken = await bindingFixture({ closeError: Error('close failed') });
  broken.setTrack({ mediaStreamTrack: broken.track });
  broken.toggle.checked = true;
  await broken.toggle.emit('change');
  await assert.rejects(broken.binding.stop(), /teardown failed/);
  assert.equal(broken.toggle.checked, false);
  assert.match(broken.status.textContent, /Input monitor error:.*teardown failed/);
});
