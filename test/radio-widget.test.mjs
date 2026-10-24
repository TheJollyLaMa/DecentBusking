import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from '../widget/radio-widget.js';
import { radioMediaUrl, readRadioVotes } from '../js/radio-client.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const cid = 'bafy' + 'a'.repeat(55);
const snapshot = () => ({
  activeShow: { label: 'Songs Awaiting Your Vote' },
  nowPlaying: { playId: 'play-1', trackId: 'track-1', title: 'A song', uploader: 'artist.eth', ipfsCid: cid, positionMs: 42000 },
});

// A small DOM/media boundary; tests invoke the actual module mount and DOM listeners.
class Element extends EventTarget {
  constructor(tag, document) {
    super(); this.tagName = tag; this.ownerDocument = document;
    this.attributes = {}; this.dataset = {}; this.children = []; this.textContent = '';
    this.paused = true; this.duration = 120; this.currentTime = 0;
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key]; }
  removeAttribute(key) { delete this.attributes[key]; if (key === 'src') this.src = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  attachShadow() { return (this.shadowRoot = new Element('shadow', this.ownerDocument)); }
  async play() { if (this.playError) throw this.playError; this.paused = false; this.plays = (this.plays || 0) + 1; }
  pause() { this.paused = true; }
  load() {}
  fire(type) { this.dispatchEvent(new Event(type)); }
}
function setup({ fetchImpl, head, storage = new Map(), options = {} } = {}) {
  const window = new EventTarget();
  window.localStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) };
  const document = { defaultView: window, createElement: tag => new Element(tag, document) };
  const element = new Element('div', document);
  let posts = 0, net = 3, current = snapshot(), offline = false, voteError = false;
  const signals = [];
  const mediaRequests = [];
  const fetcher = async (url, init) => {
    signals.push(init.signal);
    if (offline) throw new TypeError('CORS/network failure');
    if (url.includes('/media?')) {
      mediaRequests.push(url);
      return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'audio/mpeg' } });
    }
    if (url.endsWith('/vote')) {
      posts++;
      const body = JSON.parse(init.body);
      if (voteError) return { ok: false, json: async () => ({ error: 'Vote rejected' }) };
      net += body.vote;
      return { ok: true, json: async () => ({ playId: body.playId, vote: body.vote }) };
    }
    return { ok: true, json: async () => url.includes('/history') ? { weeks: [{ current: true, tracks: [{ trackId: 'track-1', votes: net }] }] } : current };
  };
  const controller = mount(element, {
    head, fetchImpl: fetchImpl || fetcher, volume: 0.08,
    stations: [{ id: 'wqxr', label: 'WQXR', url: 'https://stream.wqxr.org/wqxr-web' }], ...options,
  });
  const all = () => {
    const visit = node => [node, ...node.children.flatMap(visit)];
    return visit(element.shadowRoot || element);
  };
  const label = text => all().find(node => node.getAttribute('aria-label') === text);
  return {
    controller, element, window, storage, signals, mediaRequests, all, label,
    audio: () => all().find(node => node.tagName === 'audio'),
    button: () => all().find(node => node.tagName === 'button' && /radio$/.test(node.getAttribute('aria-label') || '')),
    posts: () => posts,
    setCurrent: value => { current = value; }, setOffline: () => { offline = true; }, setVoteError: value => { voteError = value; },
  };
}
async function playing(h) { await flush(); h.button().fire('click'); await flush(); await flush(); }
const text = h => h.all().map(node => node.textContent).join(' ');

test('the public radio widget preloads the next source, finishes the current play and never replays an ended ID', async t => {
  const h = setup();
  t.after(() => h.controller.destroy());
  const first = snapshot();
  const next = { ...first.nowPlaying, playId: 'play-2', trackId: 'track-2', title: 'Next song',
    ipfsCid: 'bafy' + 'b'.repeat(55), mediaType: 'audio/mpeg', positionMs: 0 };
  h.setCurrent({ ...first, upNext: next });
  await playing(h);
  await flush(); await flush();
  assert.equal(h.audio().crossOrigin, 'anonymous');
  assert.equal(h.mediaRequests.length, 1, 'download the next source while the first song is playing');
  assert.equal(h.audio().plays, 1);
  h.setCurrent({ ...first, nowPlaying: next, upNext: null });
  h.audio().ended = true;
  h.audio().fire('ended');
  await new Promise(resolve => setTimeout(resolve, 800));
  await flush();
  assert.match(h.audio().src, /^blob:/);
  assert.equal(h.audio().plays, 2);
  assert.equal(h.mediaRequests.length, 1);
  h.audio().fire('ended');
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(h.audio().plays, 2, 'a repeated state snapshot is not another playback');
});

test('the widget cancels preloads on pause and respects data-saver connections', async t => {
  const h = setup();
  t.after(() => h.controller.destroy());
  h.window.navigator = { connection: { saveData: true } };
  h.setCurrent({ ...snapshot(), upNext: { ipfsCid: 'bafy' + 'b'.repeat(55) } });
  await playing(h);
  assert.equal(h.mediaRequests.length, 0);
  h.button().fire('click');
  h.window.navigator.connection.saveData = false;
  await playing(h);
  await flush();
  assert.equal(h.mediaRequests.length, 1);
  h.button().fire('click');
  assert.ok(h.signals.some(signal => signal.aborted), 'pause aborts the speculative media request');
});

test('real mount is inert, scoped, quiet, uses late shared head and destroys/remounts idempotently', async t => {
  let subscribed = 0, unsubscribed = 0, connects = 0;
  const head = {
    getWallet: () => ({ snapshot: () => ({ address: '0xabc', ensName: 'host.eth' }), connect: () => connects++ }),
    getIpfs: () => ({ snapshot: () => ({ provider: 'local' }) }),
    on: (event, callback) => { assert.equal(event, 'wallet'); subscribed++; callback(); return () => unsubscribed++; },
  };
  const h = setup(); t.after(() => h.controller.destroy());
  await flush();
  assert.equal(h.audio().plays, undefined);
  assert.equal(h.audio().volume, 0.08);
  assert.equal(h.label('Upvote current track').disabled, true);
  assert.equal(h.element.children.length, 0);
  h.window.DecentHead = head;
  h.window.dispatchEvent(new Event('decenthead:ready'));
  assert.match(text(h), /host.eth/);
  assert.equal(subscribed, 1); assert.equal(connects, 0);
  h.controller.destroy(); h.controller.destroy();
  assert.equal(unsubscribed, 1); assert.equal(h.element.shadowRoot.children.length, 0);
  h.window.dispatchEvent(new Event('decenthead:ready'));
  assert.equal(subscribed, 1);
  const again = mount(h.element, { head, fetchImpl: async () => ({ ok: true, json: async () => ({ nowPlaying: null }) }) });
  again.destroy();
  assert.equal(unsubscribed, 2);
});

test('host renderer owns layout without a shadow or second engine and cleans up on remount', async t => {
  let selectStation, updates = [], destroyed = 0;
  const render = ({ element, document, controls, selectStation: select }) => {
    selectStation = select;
    const row = document.createElement('nav');
    row.append(controls.play, controls.volume, controls.up, controls.down, controls.net);
    element.replaceChildren(row, controls.now, controls.status, controls.audio);
    return { update: state => updates.push(state), destroy: () => destroyed++ };
  };
  const h = setup({ options: { render, initialStation: 'wqxr' } });
  t.after(() => h.controller.destroy());
  assert.equal(h.element.shadowRoot, undefined);
  assert.equal(h.element.children[0].tagName, 'nav');
  assert.equal(h.audio().plays, undefined);
  assert.equal(updates.at(-1).station.id, 'wqxr');
  selectStation('missing', { play: true });
  assert.equal(h.audio().plays, undefined);
  selectStation('dbusk', { play: true });
  await flush(); await flush();
  assert.match(h.audio().src, /\/api\/radio\/media\?cid=/);
  assert.equal(h.label('Upvote current track').disabled, false);
  assert.match(updates.at(-1).now, /A song/);
  const up = h.label('Upvote current track');
  h.controller.destroy();
  up.fire('click'); selectStation('dbusk', { play: true });
  await flush();
  assert.equal(h.posts(), 0);
  assert.equal(destroyed, 1);
  assert.equal(h.element.children.length, 0);
  const again = mount(h.element, { render, initialStation: 'wqxr',
    stations: [{ id: 'wqxr', url: 'https://example.com/live' }] });
  again.destroy();
  assert.equal(destroyed, 2);
});

test('default renderer exposes stable parts, theme tokens and reduced-motion-safe styles', t => {
  const h = setup(); t.after(() => h.controller.destroy());
  for (const part of ['panel', 'controls', 'play', 'station', 'volume', 'up', 'down', 'net', 'now', 'status', 'settings', 'session']) {
    assert.ok(h.all().find(node => node.getAttribute('part') === part), part);
  }
  const css = h.all().find(node => node.tagName === 'style').textContent;
  for (const token of ['color', 'background', 'border', 'accent', 'padding', 'gap', 'radius', 'max-width']) {
    assert.ok(css.includes(`--dbusk-${token}`), token);
  }
  assert.match(css, /prefers-reduced-motion:no-preference/);
});

test('stream uses proxy and seeks, renders show/title/artist, votes share tallies and persistent duplicate rules', async t => {
  const h = setup(); t.after(() => h.controller.destroy());
  await playing(h);
  assert.equal(h.audio().src, radioMediaUrl('https://decentbusking.onrender.com/api/radio', cid));
  h.audio().fire('loadedmetadata');
  assert.ok(h.audio().currentTime >= 42);
  assert.match(text(h), /Songs Awaiting Your Vote · A song — artist.eth/);
  const up = h.label('Upvote current track');
  assert.equal(up.disabled, false);
  up.fire('click');
  assert.equal(up.getAttribute('aria-pressed'), 'true');
  assert.match(text(h), /Recording vote/);
  await flush(); await flush();
  assert.equal(h.posts(), 1);
  assert.equal(up.disabled, true);
  assert.match(text(h), /Vote recorded/);
  assert.equal(readRadioVotes(h.window.localStorage, 'https://decentbusking.onrender.com/api/radio').get('play-1'), 1);
  h.controller.destroy();
  const again = setup({ storage: h.storage }); t.after(() => again.controller.destroy());
  await playing(again);
  again.label('Upvote current track').fire('click');
  await flush();
  assert.equal(again.posts(), 0);
  assert.equal(again.label('Upvote current track').disabled, true);
});

test('vote errors roll back optimistic score/choice and allow retry', async t => {
  const h = setup(); t.after(() => h.controller.destroy());
  await playing(h); h.setVoteError(true);
  const net = h.all().find(node => node.tagName === 'output');
  assert.equal(net.textContent, '+3');
  h.label('Downvote current track').fire('click');
  assert.equal(net.textContent, '+2');
  await flush(); await flush();
  assert.equal(net.textContent, '+3');
  assert.equal(h.label('Downvote current track').getAttribute('aria-pressed'), 'false');
  assert.equal(h.label('Downvote current track').disabled, false);
  assert.match(text(h), /Vote not recorded: Vote rejected/);
  h.setVoteError(false); h.label('Downvote current track').fire('click'); await flush(); await flush();
  assert.match(text(h), /Vote recorded/);
});

test('station changes never autoplay on inert mount and WQXR cannot vote', async t => {
  const h = setup(); t.after(() => h.controller.destroy());
  await flush();
  const station = h.label('Radio station');
  station.value = 'wqxr'; station.fire('change');
  assert.equal(h.audio().plays, undefined);
  h.button().fire('click'); await flush();
  assert.equal(h.audio().src, 'https://stream.wqxr.org/wqxr-web');
  assert.equal(h.label('Upvote current track').disabled, true);
  station.value = 'dbusk'; station.fire('change'); await flush(); await flush();
  assert.match(h.audio().src, /\/api\/radio\/media\?cid=/);
  assert.equal(h.label('Upvote current track').disabled, false);
});

test('offline, empty schedules, unavailable media and autoplay errors disable votes', async t => {
  const h = setup(); t.after(() => h.controller.destroy());
  await flush(); h.setOffline(); h.button().fire('click'); await flush();
  assert.match(text(h), /unavailable/);
  assert.equal(h.audio().paused, true);
  assert.equal(h.label('Upvote current track').disabled, true);
  const empty = setup(); t.after(() => empty.controller.destroy());
  empty.setCurrent({ nowPlaying: null, activeShow: { label: 'Live' }, playback: { status: 'cooldown' } });
  await playing(empty);
  assert.match(text(empty), /Live · cooldown/);
  assert.equal(empty.label('Upvote current track').disabled, true);
  const bad = setup(); t.after(() => bad.controller.destroy());
  await flush(); bad.audio().playError = Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
  await playing(bad);
  assert.match(text(bad), /Autoplay blocked/);
  assert.equal(bad.label('Upvote current track').disabled, true);
});

test('destroy aborts active work, pauses and prevents late async DOM changes', async () => {
  let resolve, signal;
  const h = setup({ fetchImpl: (url, init) => {
    signal = init.signal;
    return new Promise(done => { resolve = done; });
  } });
  // The initial fetch starts synchronously before setup returns; use its deferred response.
  await flush();
  h.controller.destroy();
  assert.equal(signal.aborted, true);
  resolve({ ok: true, json: async () => snapshot() });
  await flush();
  assert.equal(h.element.shadowRoot.children.length, 0);
});

test('media errors and compact/theme controls stay local to each mount', async t => {
  const h = setup(); t.after(() => h.controller.destroy());
  await playing(h);
  const panel = h.all().find(node => node.tagName === 'section');
  const compact = h.all().find(node => node.textContent === 'Compact');
  compact.fire('click');
  assert.equal(panel.dataset.compact, 'true');
  const theme = h.label('Radio theme');
  theme.value = 'light'; theme.fire('change');
  assert.equal(panel.dataset.theme, 'light');
  h.audio().fire('error');
  assert.equal(h.audio().paused, true);
  assert.equal(h.label('Upvote current track').disabled, true);
  assert.match(text(h), /Media unavailable/);
});

test('a replaced recording cannot stop the next track with a delayed play rejection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup(); t.after(() => h.controller.destroy());
  await flush();
  let rejectPrevious;
  const originalPlay = h.audio().play.bind(h.audio());
  h.audio().play = () => {
    h.audio().play = originalPlay;
    return new Promise((_resolve, reject) => { rejectPrevious = reject; });
  };
  h.button().fire('click');
  await flush(); await flush();
  const next = snapshot();
  next.nowPlaying = { ...next.nowPlaying, playId: 'play-2', title: 'Next recording' };
  h.setCurrent(next);
  t.mock.timers.tick(8000);
  await flush(); await flush();
  assert.equal(h.audio().paused, false);
  assert.equal(h.button().getAttribute('aria-label'), 'Pause DBusk radio');
  rejectPrevious(Object.assign(new Error('The old media was replaced'), { name: 'AbortError' }));
  await flush();
  assert.equal(h.audio().paused, false);
  assert.equal(h.button().getAttribute('aria-label'), 'Pause DBusk radio');
  assert.equal(h.label('Upvote current track').disabled, false);
  assert.doesNotMatch(text(h), /Media unavailable/);
});

test('another mounted listener cannot repeat a persisted vote in the same origin', async t => {
  const storage = new Map();
  const first = setup({ storage }), second = setup({ storage });
  t.after(() => { first.controller.destroy(); second.controller.destroy(); });
  await playing(first); await playing(second);
  first.label('Upvote current track').fire('click');
  await flush(); await flush();
  second.label('Downvote current track').fire('click');
  await flush();
  assert.equal(second.posts(), 0);
  assert.equal(second.label('Downvote current track').disabled, true);
});
