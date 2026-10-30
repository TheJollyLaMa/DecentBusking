const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness({ reducedMotion = false, audioAvailable = true } = {}) {
  const stage = { hidden: true, setAttribute() {}, append() {} };
  const video = { plays: 0, pauses: 0, play() { this.plays++; return Promise.resolve(); }, pause() { this.pauses++; } };
  const timers = new Map();
  const gains = [];
  let closed = 0;
  const param = () => ({ value: 0, setValueAtTime(value) { this.value = value; },
    linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = () => ({ connect(next) { return next; }, start() {}, stop() {} });
  class AudioContext {
    sampleRate = 100;
    currentTime = 0;
    destination = {};
    createBufferSource = node;
    createBuffer(_channels, length) { return { getChannelData: () => new Float32Array(length) }; }
    createBiquadFilter() { return { ...node(), Q: {}, frequency: param() }; }
    createGain() { const gain = { ...node(), gain: param() }; gains.push(gain); return gain; }
    resume() { return Promise.resolve(); }
    close() { closed++; return Promise.resolve(); }
  }
  const context = vm.createContext({
    console, URL,
    document: { createElement: tag => tag === 'video' ? video : stage, body: { append() {} } },
    AudioContext: audioAvailable ? AudioContext : undefined,
    matchMedia: () => ({ matches: reducedMotion }),
    setTimeout: (callback, delay) => { timers.set(1, { callback, delay }); return 1; },
    clearTimeout: id => timers.delete(id),
  });
  const source = fs.readFileSync(path.join(__dirname, '../js/radio-ad-transition.mjs'), 'utf8')
    .replace(/export /g, '')
    .replace('import.meta.url', '"https://busking.example/js/radio-ad-transition.mjs"');
  vm.runInContext(`${source}\nglobalThis.transition = createRadioAdTransition();`, context);
  return { transition: context.transition, stage, video, timers, gains, closed: () => closed };
}

test('snow is the supplied muted video and transitions last three seconds outside ad content', async () => {
  const { transition, stage, video, timers, closed } = harness();
  transition.setVolume(0.5);
  const pending = transition.play();
  assert.equal(stage.hidden, false);
  assert.equal(video.src, 'https://busking.example/img/radio-snow.mp4');
  assert.equal(video.muted, true, 'the recording audio is never mixed into radio playback');
  assert.equal(video.plays, 1);
  assert.equal(timers.get(1).delay, 3000);
  timers.get(1).callback();
  await pending;
  assert.equal(stage.hidden, true);
  assert.equal(closed(), 1);
});

test('tuning audio follows live volume/mute changes and cancellation closes its audio context', async () => {
  const { transition, gains, closed, timers, stage } = harness();
  transition.setVolume(0.5);
  const pending = transition.play();
  const output = gains.at(-1);
  assert.equal(output.gain.value, 0.06);
  transition.setVolume(0);
  assert.equal(output.gain.value, 0);
  transition.stop();
  await pending;
  assert.equal(closed(), 1);
  assert.equal(timers.size, 0);
  assert.equal(stage.hidden, true);
});

test('reduced motion avoids moving snow and lack of Web Audio never blocks the transition', async () => {
  const { transition, video, timers } = harness({ reducedMotion: true, audioAvailable: false });
  const pending = transition.play();
  assert.equal(video.plays, 0);
  timers.get(1).callback();
  await pending;
});
