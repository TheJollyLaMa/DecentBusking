const test = require('node:test');
const assert = require('node:assert/strict');

const fake = (props = {}) => ({ value: '', checked: false, disabled: false, textContent: '', dataset: {}, listeners: {},
  addEventListener(name, fn) { this.listeners[name] = fn; }, ...props });
const change = element => element.listeners.change();

test('booth setup blocks the mic until a monitor choice and radio-off confirmation are both made', async () => {
  const { bindBoothSetup } = await import('../js/booth-setup.mjs');
  const mode = fake(), radioOff = fake(), status = fake(), monitorToggle = fake();
  let changes = 0;
  const booth = bindBoothSetup({ mode, radioOff, status, monitorToggle, onChange: () => changes++ });
  assert.equal(booth.ready(), false);
  assert.match(booth.problem(), /choose how you will hear yourself/);
  mode.value = 'direct'; change(mode);
  assert.match(booth.problem(), /radio is off/);
  assert.equal(status.dataset.ready, 'false');
  radioOff.checked = true; change(radioOff);
  assert.equal(booth.ready(), true);
  assert.match(status.textContent, /Booth ready.*direct monitor on/);
  assert.equal(changes, 2);
  mode.value = 'something-else'; change(mode);
  assert.equal(booth.ready(), false, 'unknown modes never pass');
});

test('Hear my input is usable only for the browser fallback, and leaving it stops browser monitoring', async () => {
  const { bindBoothSetup } = await import('../js/booth-setup.mjs');
  const mode = fake(), radioOff = fake({ checked: true }), status = fake(), monitorToggle = fake();
  let stops = 0;
  bindBoothSetup({ mode, radioOff, status, monitorToggle, onMonitorDisallowed: () => { stops++; monitorToggle.checked = false; } });
  assert.equal(monitorToggle.disabled, true);
  mode.value = 'browser'; change(mode);
  assert.equal(monitorToggle.disabled, false);
  monitorToggle.checked = true;
  mode.value = 'direct'; change(mode);
  assert.equal(stops, 1);
  assert.equal(monitorToggle.disabled, true);
  assert.equal(monitorToggle.checked, false);
});

test('choices persist per tab so a mid-show reload can republish, and bad storage is ignored', async () => {
  const { bindBoothSetup } = await import('../js/booth-setup.mjs');
  const store = new Map();
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  const first = { mode: fake(), radioOff: fake(), status: fake(), monitorToggle: fake(), storage, key: 'k' };
  bindBoothSetup(first);
  first.mode.value = 'unplugged'; change(first.mode);
  first.radioOff.checked = true; change(first.radioOff);
  const reloaded = { mode: fake(), radioOff: fake(), status: fake(), monitorToggle: fake(), storage, key: 'k' };
  assert.equal(bindBoothSetup(reloaded).ready(), true);
  assert.equal(reloaded.mode.value, 'unplugged');
  store.set('k', '{not json');
  assert.equal(bindBoothSetup({ mode: fake(), radioOff: fake(), status: fake(), monitorToggle: fake(), storage, key: 'k' }).ready(), false);
  const blocked = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  const mode = fake();
  const booth = bindBoothSetup({ mode, radioOff: fake({ checked: true }), status: fake(), monitorToggle: fake(), storage: blocked });
  mode.value = 'direct'; change(mode);
  assert.equal(booth.ready(), true);
});

test('live shows allow only interface direct monitoring or unplugged, never the browser monitor', async () => {
  const { bindBoothSetup, SHOW_MODES } = await import('../js/booth-setup.mjs');
  assert.deepEqual([...SHOW_MODES], ['direct', 'unplugged']);
  const store = new Map([['live', JSON.stringify({ mode: 'browser', radioOff: true })]]);
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  const mode = fake(), monitorToggle = fake();
  const booth = bindBoothSetup({ mode, radioOff: fake(), status: fake(), monitorToggle, storage, key: 'live', modes: SHOW_MODES });
  assert.equal(mode.value, '', 'a saved practice-only choice is not restored for a show');
  assert.equal(booth.ready(), false);
  mode.value = 'browser'; change(mode);
  assert.equal(booth.ready(), false);
  assert.match(booth.problem(), /choose how you will hear yourself/);
  assert.equal(monitorToggle.disabled, true, 'Hear my input stays locked on air');
  for (const allowed of SHOW_MODES) {
    mode.value = allowed; change(mode);
    assert.equal(booth.ready(), true, `${allowed} is allowed on air`);
    assert.equal(monitorToggle.disabled, true);
  }
});
