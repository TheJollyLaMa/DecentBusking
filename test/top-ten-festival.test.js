const test = require('node:test');
const assert = require('node:assert/strict');

test('festival distinguishes opening ranks, headliner and encores and cleans up on exit', async (t) => {
  const { mountTopTenFestival } = await import('../js/top-ten-festival.mjs');
  const listeners = new Map();
  const nodes = [];
  function node() {
    const classes = new Set();
    const result = {
      children: [],
      style: { setProperty() {} },
      classList: {
        add: value => classes.add(value),
        remove: value => classes.delete(value),
        contains: value => classes.has(value),
        toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); },
      },
      listeners: new Map(),
      addEventListener(name, handler) { this.listeners.set(name, handler); },
      removeEventListener(name, handler) { if (this.listeners.get(name) === handler) this.listeners.delete(name); },
      focus() {},
      setAttribute(name, value) { this[name] = value; },
      getAttribute(name) { return this[name] ?? null; },
      append(...children) { this.children.push(...children); },
      after(child) { this.next = child; },
      remove() { this.removed = true; },
    };
    nodes.push(result);
    return result;
  }
  const previousDocument = global.document;
  const doc = {
    hidden: false,
    body: node(),
    createElement: node,
    createElementNS: () => node(),
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name, handler) => { if (listeners.get(name) === handler) listeners.delete(name); },
  };
  global.document = doc;
  t.after(() => { global.document = previousDocument; });
  const heading = node();
  const panel = node();
  panel.querySelector = () => heading;
  const festival = mountTopTenFestival(panel);
  const banner = heading.next;
  const position = nodes.find(entry => entry.className === 'hype-position');
  assert.ok(panel.classList.contains('is-hype-festival'));
  assert.ok(doc.body.classList.contains('top-ten-festival-open'));
  assert.equal(nodes.find(entry => entry.className === 'hype-stage')['aria-hidden'], 'true');
  const symbols = nodes.map(entry => entry.textContent || '').join('');
  for (const symbol of ['⚸', '♀︎', '☿', '🏆', '🐇', '🕳️', '🦙', '🧞‍♂️', '🧞‍♀️', '🌝', '🎸', '🎤', '🎹', '🥁']) {
    assert.ok(symbols.includes(symbol), `Missing festival character: ${symbol}`);
  }
  assert.doesNotMatch(symbols, /🐸|🐈|🪐/u);
  assert.equal(nodes.filter(entry => entry.className === 'hype-bandmate').length, 4);
  const runaway = nodes.find(entry => entry.className === 'hype-runaway');
  assert.equal(runaway.children[0].className, 'hype-runaway-bunny');
  assert.equal(runaway.children[0].textContent, '🐇');
  const stageHole = nodes.find(entry => entry.className === 'hype-rabbit-hole');
  assert.equal(stageHole.children[0].className, 'top-ten-spy-peek');
  assert.equal(stageHole.children[0].children[0].textContent, '🕵️');
  for (const [animal, symbol] of [['fox', '🦊'], ['rat', '🐀'], ['bird', '💸']]) {
    assert.equal(nodes.find(entry => entry.className === `hype-runaway hype-runaway-${animal}`).children[0].textContent, symbol);
  }
  assert.equal(nodes.some(entry => /hype-crowd|hype-fan/.test(entry.className)), false, 'crowd row removed so the equalizer stays visible');
  assert.equal(nodes.find(entry => entry.className === 'hype-title-top').textContent, 'Top 10');
  assert.equal(nodes.find(entry => entry.className === 'hype-title-show').textContent, 'Friday Night Hype');
  const meterToggle = nodes.find(entry => entry.className === 'hype-meter-toggle');
  const equalizer = nodes.find(entry => entry.className === 'hype-equalizer');
  meterToggle.listeners.get('click')();
  assert.equal(equalizer.classList.contains('is-wave'), true);
  assert.equal(meterToggle.textContent, 'Bars');
  assert.equal(meterToggle['aria-pressed'], 'true');
  meterToggle.listeners.get('click')();
  assert.equal(equalizer.classList.contains('is-wave'), false);
  assert.equal(meterToggle.textContent, 'Wave');
  const info = nodes.find(entry => entry.className === 'hype-info-button');
  const popover = nodes.find(entry => entry.className === 'hype-info-popover');
  assert.equal(banner.children[0], info, 'info button leads the banner (upper-left)');
  assert.equal(popover.hidden, true);
  assert.match(popover.textContent, /Friday at 8pm.*SUN\/MON close.*payout amounts are decided/);
  info.listeners.get('click')({ stopPropagation() {} });
  assert.equal(popover.hidden, false);
  assert.equal(info['aria-expanded'], 'true');
  let stopped = false;
  banner.listeners.get('keydown')({ key: 'Escape', stopPropagation() { stopped = true; } });
  assert.equal(popover.hidden, true);
  assert.equal(stopped, true);
  festival.update({ openingRank: 10 });
  assert.equal(position.textContent, 'OPENING #10');
  assert.equal(banner.classList.contains('is-headliner'), false);
  festival.update({ openingRank: 1, title: 'The top song' });
  assert.equal(banner.classList.contains('is-headliner'), true);
  assert.match(nodes.find(entry => entry.className === 'hype-chart-explainer').textContent, /The top song/);
  festival.update({ openingRank: 1, encore: true });
  assert.equal(position.textContent, 'ENCORE');
  assert.equal(banner.classList.contains('is-headliner'), false);
  doc.hidden = true;
  listeners.get('visibilitychange')();
  assert.equal(banner.classList.contains('is-paused'), true);
  festival.destroy();
  assert.equal(listeners.size, 0);
  assert.equal(banner.listeners.has('keydown'), false);
  assert.equal(banner.removed, true);
  assert.equal(panel.classList.contains('is-hype-festival'), false);
  assert.equal(doc.body.classList.contains('top-ten-festival-open'), false);
});

test('equalizer bars are driven by the real audio spectrum, not a canned loop', async (t) => {
  const { mountTopTenFestival, spectrumBars } = await import('../js/top-ten-festival.mjs');
  const quiet = spectrumBars(new Uint8Array(128));
  assert.equal(quiet.length, 24);
  assert.ok(quiet.every(level => level === 0.04), 'silence rests flat');
  const bassHit = new Uint8Array(128); bassHit[1] = 255; bassHit[2] = 255;
  const bass = spectrumBars(bassHit);
  assert.equal(bass[0], 1);
  assert.equal(bass[1], 1);
  assert.equal(bass[2], 0.04, 'each low bar has its own frequency band');
  assert.equal(bass.at(-1), 0.04, 'highs stay down when only bass is present');
  const decayed = spectrumBars(new Uint8Array(128), 24, bass);
  assert.ok(decayed[0] < 1 && decayed[0] > 0.5, 'bars fall back smoothly instead of snapping');

  const nodes = [];
  const node = () => {
    const classes = new Set();
    const result = { children: [], style: { transform: '', props: {}, setProperty(k, v) { this.props[k] = v; } }, listeners: new Map(),
      classList: { add: v => classes.add(v), remove: v => classes.delete(v), contains: v => classes.has(v),
        toggle(v, on) { if (on) classes.add(v); else classes.delete(v); } },
      addEventListener(n, h) { this.listeners.set(n, h); }, removeEventListener(n) { this.listeners.delete(n); },
      setAttribute(n, v) { this[n] = v; }, getAttribute(n) { return this[n] ?? null; }, focus() {},
      append(...c) { this.children.push(...c); }, after(c) { this.next = c; }, remove() {} };
    nodes.push(result);
    return result;
  };
  const frames = [];
  const saved = { document: global.document, raf: global.requestAnimationFrame, caf: global.cancelAnimationFrame };
  global.document = { hidden: false, body: node(), createElement: node, createElementNS: () => node(), addEventListener() {}, removeEventListener() {} };
  global.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  global.cancelAnimationFrame = () => {};
  t.after(() => { global.document = saved.document; global.requestAnimationFrame = saved.raf; global.cancelAnimationFrame = saved.caf; });
  const panel = node();
  panel.classList.add('is-open');
  panel.querySelector = () => node();
  let playing = true;
  const festival = mountTopTenFestival(panel, { readSpectrum(out) { if (!playing) return false; out.fill(0); out.fill(255, 1, 5); return true; } });
  const equalizer = nodes.find(entry => entry.className === 'hype-equalizer');
  const bars = equalizer.children.slice(0, 24);
  frames.shift()();
  assert.equal(bars[0].style.transform, 'scaleY(1.000)');
  assert.equal(bars.at(-1).style.transform, 'scaleY(0.040)');
  assert.ok(equalizer.classList.contains('is-live'));
  playing = false;
  for (let i = 0; i < 40; i++) frames.shift()();
  assert.equal(bars[0].style.transform, 'scaleY(0.040)', 'no audio means the meter settles flat');
  assert.equal(equalizer.classList.contains('is-live'), false);
  panel.classList.remove('is-open');
  frames.shift()();
  assert.equal(frames.length, 0, 'meter stops scheduling frames while the panel is minimized');
  festival.resume();
  assert.equal(frames.length, 1, 'reopening restarts the meter');
  festival.destroy();
});
