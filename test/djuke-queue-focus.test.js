const test = require('node:test');
const assert = require('node:assert/strict');

const requestId = '8453:0xf51d2f7892cf9d49e14df4afdf227a59ee170a51:playlist:1';
const playing = { playback: { status: 'playing' }, nowPlaying: { sponsor: { kind: 'djuke', requestId } } };

test('on-air identity requires actual DJuke playback, not a pending head or matching song title', async () => {
  const { audibleDjukeRequest } = await import('../js/djuke-queue-focus.mjs');
  assert.equal(audibleDjukeRequest(playing), requestId);
  for (const state of [null, {}, { ...playing, playback: { status: 'preparing' } },
    { ...playing, nowPlaying: null }, { ...playing, nowPlaying: { title: 'Same title' } },
    { ...playing, nowPlaying: { sponsor: { kind: 'devert', requestId } } }]) {
    assert.equal(audibleDjukeRequest(state), null);
  }
});

test('centering scrolls only the queue container and clamps first and last rows', async () => {
  const { centerQueueRow } = await import('../js/djuke-queue-focus.mjs');
  let scroll;
  const container = { scrollHeight: 600, clientHeight: 200, scrollTop: 50,
    getBoundingClientRect: () => ({ top: 100 }), scrollTo: options => { scroll = options; } };
  centerQueueRow(container, { getBoundingClientRect: () => ({ top: 350, height: 40 }) });
  assert.deepEqual(scroll, { top: 220, behavior: 'smooth' });
  centerQueueRow(container, { getBoundingClientRect: () => ({ top: 0, height: 40 }) }, 'instant');
  assert.deepEqual(scroll, { top: 0, behavior: 'instant' });
  centerQueueRow(container, { getBoundingClientRect: () => ({ top: 1000, height: 40 }) });
  assert.equal(scroll.top, 400);
});

test('queue marker follows exact lanes, clears for gaps and cut-ins, and preserves manual scrolling', async () => {
  const { mountDjukeQueueFocus } = await import('../js/djuke-queue-focus.mjs');
  const listeners = {};
  let open = true, scrolls = 0;
  const viewport = { top: 0, bottom: 200, height: 200 };
  const list = { scrollHeight: 600, clientHeight: 200, scrollTop: 0,
    getBoundingClientRect: () => viewport, scrollTo() { scrolls++; }, closest: () => null };
  const row = id => ({ dataset: { djukeRequest: id, state: 'pending' }, attributes: {}, label: {},
    classList: { toggle(name, value) { this[name] = value; } },
    setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; },
    querySelector() { return this.label; }, closest: () => list,
    getBoundingClientRect: () => ({ top: 50, bottom: 90, height: 40 }) });
  const current = row(requestId), oldContract = row(requestId.replace('0xf51d', '0xbbcb')), other = row(requestId.replace(/1$/, '2'));
  const queue = { querySelectorAll: () => [current, oldContract, other], getBoundingClientRect: () => viewport };
  const focus = mountDjukeQueueFocus({ queue, isOpen: () => open, initialState: playing,
    root: { addEventListener(name, callback) { listeners[name] = callback; } } });
  const update = detail => listeners['dbusk-radio-state']({ detail });
  focus.sync();
  assert.equal(current.attributes['aria-current'], 'true');
  assert.equal(current.label.textContent, '♫ On air');
  assert.equal(oldContract.attributes['aria-current'], undefined);
  assert.equal(scrolls, 1);
  focus.sync();
  update(playing);
  assert.equal(scrolls, 1, 'unchanged events and refreshed rows must not fight manual scroll');
  focus.sync({ force: true });
  assert.equal(scrolls, 2, 'reopening centers the current song');
  update({ ...playing, playback: { status: 'preparing' } });
  assert.equal(current.attributes['aria-current'], undefined);
  assert.equal(current.label.textContent, 'pending');
  update({ ...playing, nowPlaying: { sponsor: { kind: 'djuke', requestId: 'main:42' } } });
  assert.equal(current.attributes['aria-current'], undefined);
  open = false;
  update({ ...playing, nowPlaying: { sponsor: { kind: 'djuke', requestId: other.dataset.djukeRequest } } });
  assert.equal(scrolls, 2);
  assert.equal(other.attributes['aria-current'], 'true');
  open = true;
  focus.sync();
  assert.equal(scrolls, 3);
});
