const test = require('node:test');
const assert = require('node:assert/strict');

test('Hype pins the real chart, updates live ranks independently, and restores drawer state at handoff', async t => {
  const globals = ['document', 'window', 'fetch', 'setTimeout', 'clearTimeout'];
  const original = Object.fromEntries(globals.map(key => [key, global[key]]));
  t.after(() => { for (const key of globals) global[key] = original[key]; });
  class Node extends EventTarget {
    constructor() {
      super();
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.className = '';
      this.style = { setProperty() {} };
      this.scrollTop = 0;
      const classes = () => new Set(this.className.split(' ').filter(Boolean));
      this.classList = {
        contains: name => classes().has(name),
        add: name => { this.className = [...classes().add(name)].join(' '); },
        remove: name => { const next = classes(); next.delete(name); this.className = [...next].join(' '); },
        toggle: (name, enabled) => enabled ? this.classList.add(name) : this.classList.remove(name),
      };
    }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    before(node) { node.parent = this.parent; this.parent.children.splice(this.parent.children.indexOf(this), 0, node); }
    after(node) { node.parent = this.parent; this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, node); }
    remove() { this.parent.children = this.parent.children.filter(node => node !== this); }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    querySelectorAll(selector) {
      const names = selector.split(',').map(part => part.trim().replace(/^\./, '').split('[')[0]);
      return this.children.flatMap(child => [...(names.some(name => child.classList.contains(name)) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getBoundingClientRect() { return { top: 0, bottom: 60, left: 0, width: 400, height: 60 }; }
    focus() { document.activeElement = this; }
    scrollIntoView() { this.scrolled = true; }
  }
  const ids = Object.fromEntries(['top-ten-tab', 'top-ten-panel', 'top-ten-content', 'top-ten-status', 'top-ten-week', 'top-ten-panel-close']
    .map(id => [id, new Node()]));
  const panel = ids['top-ten-panel'];
  const heading = new Node();
  heading.className = 'top-ten-panel-heading';
  heading.append(ids['top-ten-week'], ids['top-ten-panel-close']);
  panel.append(heading, ids['top-ten-status'], ids['top-ten-content']);
  ids['top-ten-tab'].setAttribute('aria-expanded', 'false');
  const doc = new EventTarget();
  doc.body = new Node();
  doc.body.append(ids['top-ten-tab'], panel);
  doc.getElementById = id => ids[id] || null;
  doc.createElement = () => new Node();
  doc.createElementNS = () => new Node();
  doc.hidden = false;
  doc.activeElement = null;
  global.document = doc;
  global.window = { DecentConfig: { ipfsUploadServiceUrl: 'https://worker.test' },
    matchMedia: () => Object.assign(new EventTarget(), { matches: true }) };
  const timers = new Map();
  let timerId = 0;
  global.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
  global.clearTimeout = id => timers.delete(id);
  const tracks = [{ trackId: 'a', title: 'A', artist: 'Artist', votes: 10, plays: 1 },
    { trackId: 'b', title: 'B', artist: 'Artist', votes: 5, plays: 1 }];
  const now = Date.now();
  const hype = { instanceId: 'preview', status: 'ready', startAt: new Date(now - 1000).toISOString(),
    endAt: new Date(now + 3600_000).toISOString(), tracks: tracks.map((track, index) => ({ ...track, openingRank: index + 1 })), skipped: [] };
  let radio = { serverTime: now, activeShow: { id: 'friday-top10-hype' }, topTenHype: hype,
    nowPlaying: { trackId: 'b', title: 'B', hype: { openingRank: 2, encore: false } } };
  global.fetch = async url => ({ ok: true, json: async () => url.includes('/history')
    ? { weeks: [{ current: true, week: 'NY-2026-10-12', tracks }] }
    : url.includes('/payroll') ? { ready: false } : radio });
  const { initTopTenBoard } = await import('../js/top-ten-board.mjs');
  initTopTenBoard();
  const publish = () => doc.dispatchEvent(new CustomEvent('dbusk-radio-state', { detail: radio }));
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
  publish();
  await settle();
  assert.equal(ids['top-ten-tab'].getAttribute('aria-expanded'), 'true');
  assert.equal(ids['top-ten-panel-close'].getAttribute('aria-disabled'), null, 'Hype panel can be minimized');
  assert.equal(panel.querySelectorAll('.hype-festival').length, 1);
  assert.equal(panel.querySelectorAll('.top-ten-playlist-add').length, 2);
  doc.dispatchEvent(new Event('click'));
  assert.equal(ids['top-ten-tab'].getAttribute('aria-expanded'), 'true', 'stray page clicks do not hide the Hype board');
  ids['top-ten-panel-close'].dispatchEvent(new Event('click'));
  assert.equal(ids['top-ten-tab'].getAttribute('aria-expanded'), 'false', 'close button minimizes during Hype');
  publish();
  assert.equal(ids['top-ten-tab'].getAttribute('aria-expanded'), 'false', 'radio polls do not re-open a minimized Hype panel');
  assert.equal(panel.querySelectorAll('.hype-festival').length, 1, 'festival stays mounted while minimized');
  ids['top-ten-tab'].dispatchEvent(new Event('click'));
  await settle();
  assert.equal(ids['top-ten-tab'].getAttribute('aria-expanded'), 'true');
  const escape = new Event('keydown'); escape.key = 'Escape'; doc.dispatchEvent(escape);
  assert.equal(ids['top-ten-tab'].getAttribute('aria-expanded'), 'false', 'Escape minimizes during Hype');
  ids['top-ten-tab'].dispatchEvent(new Event('click'));
  await settle();
  doc.dispatchEvent(new CustomEvent('left-drawer-open', { detail: 'djuke' }));
  assert.equal(ids['top-ten-tab'].getAttribute('aria-expanded'), 'false', 'another drawer may take over during Hype');
  ids['top-ten-tab'].dispatchEvent(new Event('click'));
  await settle();
  tracks[1].votes = 20;
  const refresh = [...timers.values()].find(timer => timer.delay === 15000);
  await refresh.callback();
  const first = panel.querySelector('.top-ten-song');
  assert.equal(first.dataset.trackId, 'b');
  assert.equal(first.querySelector('.top-ten-opening-rank').textContent, 'Opening #2 · live #1');
  assert.equal(panel.querySelector('.hype-position').textContent, 'OPENING #2');
  radio = { serverTime: now, activeShow: { type: 'live_performance', id: 'friday-live-performance' } };
  publish();
  assert.equal(panel.querySelectorAll('.hype-festival').length, 0);
  assert.equal(panel.querySelectorAll('.top-ten-opening-rank').length, 0);
  assert.equal(ids['top-ten-panel-close'].getAttribute('aria-disabled'), null);
  assert.equal(ids['top-ten-tab'].getAttribute('aria-expanded'), 'false');
  ids['top-ten-tab'].dispatchEvent(new Event('click'));
  await settle();
  assert.equal(ids['top-ten-tab'].getAttribute('aria-expanded'), 'true');
  radio = { serverTime: now, activeShow: { id: 'friday-top10-hype' }, topTenHype: hype, nowPlaying: null };
  publish();
  radio = { serverTime: now, activeShow: { id: 'normal-rotation' } };
  publish();
  assert.equal(ids['top-ten-tab'].getAttribute('aria-expanded'), 'true', 'preserve a panel the listener had already opened');
  radio = { serverTime: now, activeShow: { id: 'friday-top10-hype' }, topTenHype: { ...hype, endAt: new Date(now + 2000).toISOString() } };
  publish();
  const deadline = [...timers.values()].find(timer => timer.delay === 2000);
  deadline.callback();
  assert.equal(panel.querySelectorAll('.hype-festival').length, 0, 'known deadline cleans up even without another server response');
});
