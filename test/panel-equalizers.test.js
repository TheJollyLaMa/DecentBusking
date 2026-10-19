const test = require('node:test');
const assert = require('node:assert/strict');

test('both LCD meters follow real bands, rest without audio and suspend when closed, hidden or reduced', async t => {
  const keys = ['window', 'document', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const original = Object.fromEntries(keys.map(key => [key, global[key]]));
  t.after(() => { for (const key of keys) global[key] = original[key]; });
  const reduced = Object.assign(new EventTarget(), { matches: false });
  global.window = { matchMedia: () => reduced };
  global.document = Object.assign(new EventTarget(), { hidden: false });
  let observer;
  global.MutationObserver = class {
    constructor(callback) { observer = callback; }
    observe() {}
    disconnect() {}
  };
  const frames = new Map();
  let id = 0;
  global.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  global.cancelAnimationFrame = key => frames.delete(key);
  const step = () => { const [key, callback] = frames.entries().next().value; frames.delete(key); callback(); };
  const makeMeter = () => {
    const classes = new Set();
    const panel = { hidden: false, getAttribute: () => panel.hidden ? 'true' : 'false' };
    return { panel, closest: () => panel, children: Array.from({ length: 16 }, () => ({ style: {} })),
      classList: { remove: name => classes.delete(name),
        toggle: (name, on) => on ? classes.add(name) : classes.delete(name), contains: name => classes.has(name) } };
  };
  const meters = [makeMeter(), makeMeter()];
  let live = true;
  let reads = 0;
  const { mountPanelEqualizers } = await import('../js/panel-equalizers.mjs');
  const dispose = mountPanelEqualizers({ root: { querySelectorAll: () => meters }, readSpectrum(data) {
    reads++; data.fill(0); data[1] = 255; return live;
  } });
  step();
  assert.equal(reads, 1, 'all visible meters share one spectrum read per frame');
  for (const meter of meters) {
    assert.equal(meter.children[0].style.transform, 'scaleY(1)');
    assert.equal(meter.children.at(-1).style.transform, 'scaleY(0.04)');
    assert.equal(meter.classList.contains('is-live'), true);
  }
  live = false;
  for (let i = 0; i < 25; i++) step();
  assert.equal(meters[0].children[0].style.transform, 'scaleY(0.04)');
  assert.equal(meters[0].classList.contains('is-live'), false);
  meters.forEach(meter => { meter.panel.hidden = true; });
  observer();
  assert.equal(frames.size, 0);
  meters[1].panel.hidden = false;
  observer();
  assert.equal(frames.size, 1);
  reduced.matches = true;
  reduced.dispatchEvent(new Event('change'));
  assert.equal(frames.size, 0);
  reduced.matches = false;
  reduced.dispatchEvent(new Event('change'));
  assert.equal(frames.size, 1);
  document.hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(frames.size, 0);
  dispose();
});
