const test = require('node:test');
const assert = require('node:assert/strict');

test('live row meter switches real frequency/time data, follows replacement rows and stops when hidden', async t => {
  const keys = ['document', 'window', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const original = Object.fromEntries(keys.map(key => [key, global[key]]));
  t.after(() => { for (const key of keys) global[key] = original[key]; });
  class Node extends EventTarget {
    constructor() {
      super(); this.children = []; this.style = {}; this.attributes = {};
      const classes = new Set();
      this.classList = { toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
        remove: name => classes.delete(name), contains: name => classes.has(name) };
    }
    append(child) { child.parent = this; this.children.push(child); }
    prepend(child) { child.parent = this; this.children.unshift(child); }
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key]; }
    getBoundingClientRect() { return { top: 100, bottom: 200, left: 0, width: 300 }; }
  }
  const doc = new Node();
  doc.createElement = doc.createElementNS = () => new Node();
  global.document = doc;
  const reduced = Object.assign(new EventTarget(), { matches: false });
  global.window = { matchMedia: () => reduced };
  let notify;
  global.MutationObserver = class { constructor(callback) { notify = callback; } observe() {} disconnect() {} };
  const frames = new Map();
  let frame = 0;
  global.requestAnimationFrame = callback => { frames.set(++frame, callback); return frame; };
  global.cancelAnimationFrame = id => frames.delete(id);
  const tick = () => { const [id, callback] = frames.entries().next().value; frames.delete(id); callback(); };
  const panel = new Node();
  panel.getBoundingClientRect = () => ({ top: 0, bottom: 400, left: 0, width: 300 });
  panel.setAttribute('aria-hidden', 'false');
  const content = new Node();
  let row = new Node();
  const firstRow = new Node();
  row.getBoundingClientRect = () => ({ top: 300, bottom: 400, left: 0, width: 300 });
  content.querySelector = selector => selector === '.top-ten-song' ? firstRow : row;
  const button = new Node();
  let live = true;
  let frequencyReads = 0;
  let waveReads = 0;
  const { mountTopTenLiveMeter } = await import('../js/top-ten-live-meter.mjs');
  const dispose = mountTopTenLiveMeter({ panel, content, button,
    readSpectrum(data) { frequencyReads++; data.fill(255); return live; },
    readWaveform(data) { waveReads++; data.fill(192); return live; } });
  tick();
  assert.equal(frequencyReads, 1);
  const oldMeter = panel.children[0];
  assert.equal(oldMeter.style.height, '100px', 'meter stays above the first row even when the playing song is lower');
  assert.equal(oldMeter.style.top, '0px');
  assert.equal(oldMeter.children[0].style.transform, 'scaleY(1)');
  button.dispatchEvent(new Event('click'));
  tick();
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(waveReads, 1);
  assert.match(oldMeter.children.at(-1).children[0].getAttribute('d'), /^M 0 58.96 C 4 58.96/);
  const previous = row;
  row = new Node();
  notify();
  assert.equal(previous.children.length, 0);
  assert.equal(panel.children[0].classList.contains('is-wave'), true, 'mode survives chart refresh');
  live = false;
  tick();
  assert.match(panel.children[0].children.at(-1).children[0].getAttribute('d'), /^M 0 50.00 C 4 50.00/);
  panel.setAttribute('aria-hidden', 'true');
  notify();
  assert.equal(frames.size, 0);
  panel.setAttribute('aria-hidden', 'false');
  notify();
  reduced.matches = true;
  reduced.dispatchEvent(new Event('change'));
  assert.equal(frames.size, 0);
  row = null;
  notify();
  assert.equal(frames.size, 0, 'no meter without a live song or advert');
  dispose();
});

test('filled waveform reduces amplitude and rounds peaks with averaged cubic curves', async () => {
  const { gentleWavePath } = await import('../js/top-ten-live-meter.mjs');
  const path = gentleWavePath(new Uint8Array(256).fill(255));
  assert.match(path, /^M 0 67.78 C /);
  assert.match(path, / L 256 100 L 0 100 Z$/);
  assert.equal((path.match(/ C /g) || []).length, 32);
  const noisy = Uint8Array.from({ length: 256 }, (_, index) => index % 2 ? 255 : 0);
  const start = Number(gentleWavePath(noisy).match(/^M 0 ([\d.]+)/)[1]);
  assert.ok(Math.abs(start - 50) < 4, 'averaging suppresses harsh sample-to-sample spikes');
});
