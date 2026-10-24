import {
  radioEndpoint, radioMediaUrl, readRadioState, sendRadioVote,
  radioListenerId, readRadioVotes, saveRadioVotes, readRadioNet, radioShowLabel,
} from '../js/radio-client.mjs';

const mounted = new WeakMap();
const DEFAULT_WORKER = 'https://decentbusking.onrender.com';
const CSS = `
:host{display:block;color:var(--dbusk-color,#eee);font:13px/1.4 system-ui,sans-serif}
.radio{background:var(--dbusk-background,#172321);border:var(--dbusk-border-width,1px) solid var(--dbusk-border,#638579);border-radius:var(--dbusk-radius,12px);padding:var(--dbusk-padding,12px);max-width:var(--dbusk-max-width,560px);box-sizing:border-box}
.radio[data-theme=light]{color:var(--dbusk-color,#172321);background:var(--dbusk-background,#f2f7f3)}
.controls,.settings{display:flex;align-items:center;flex-wrap:wrap;gap:var(--dbusk-gap,6px)}
button,select,input{font:inherit;accent-color:var(--dbusk-accent,#8acdb3)}
button,select{color:inherit;background:transparent;border:1px solid #78968a;border-radius:6px;padding:4px 7px}
button:disabled{opacity:.5}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--dbusk-accent,#8acdb3);outline-offset:2px}
input{width:70px}.brand{font-size:11px}.now{overflow:auto;white-space:nowrap;max-width:100%;scrollbar-width:thin;padding:6px 0}
.status{font-size:11px;min-height:1.4em}.settings{font-size:11px;margin-top:6px}.radio[data-compact=true]{padding:var(--dbusk-padding,6px)}.radio[data-compact=true] .brand{display:none}
@media(prefers-reduced-motion:no-preference){.now:focus-within{scroll-behavior:smooth}}
@media(prefers-color-scheme:light){.radio[data-theme=auto]{color:var(--dbusk-color,#172321);background:var(--dbusk-background,#f2f7f3)}}
`;

/** Mount a radio without connecting a wallet or starting audio. */
export function mount(element, options = {}) {
  if (!element?.ownerDocument || typeof element.attachShadow !== 'function') throw new TypeError('A DOM element is required');
  mounted.get(element)?.destroy();
  const document = element.ownerDocument;
  const window = document.defaultView;
  const customRender = typeof options.render === 'function';
  const root = customRender ? element : element.shadowRoot || element.attachShadow({ mode: 'open' });
  const node = (tag, text, attrs = {}) => {
    const value = document.createElement(tag);
    if (text) value.textContent = text;
    for (const [key, entry] of Object.entries(attrs)) value.setAttribute(key, String(entry));
    return value;
  };
  const style = node('style', CSS);
  // A shadow root cannot be detached; bridge light-DOM adapters on a reused host.
  if (customRender && element.shadowRoot) element.shadowRoot.replaceChildren(node('slot'));
  const panel = node('section', '', { class: 'radio', 'aria-label': 'DBusk radio' });
  panel.dataset.theme = ['dark', 'light', 'auto'].includes(options.theme) ? options.theme : 'auto';
  panel.dataset.compact = String(Boolean(options.compact));
  const brand = node('div', 'DBusk.decentagency.eth', { class: 'brand' });
  const controls = node('div', '', { class: 'controls' });
  const play = node('button', '▶', { type: 'button', 'aria-label': 'Play radio', 'aria-pressed': 'false' });
  const stations = [{ id: 'dbusk', label: 'DBusk', type: 'dbusk' }, ...(options.stations || []).filter(station =>
    station?.id && station.id !== 'dbusk' && /^https:\/\//.test(station.url || ''))];
  const stationInput = node('select', '', { 'aria-label': 'Radio station' });
  stations.forEach(station => {
    const option = node('option', station.label || station.id, { value: station.id });
    stationInput.append(option);
  });
  let station = stations.find(entry => entry.id === options.initialStation) || stations[0];
  stationInput.value = station.id;
  const volume = node('input', '', { type: 'range', min: 0, max: 1, step: 0.01, 'aria-label': 'Radio volume' });
  const up = node('button', '👍', { type: 'button', 'aria-label': 'Upvote current track', 'aria-pressed': 'false' });
  const down = node('button', '👎', { type: 'button', 'aria-label': 'Downvote current track', 'aria-pressed': 'false' });
  const netLabel = node('output', '—', { 'aria-label': 'Net votes unavailable' });
  const now = node('div', 'Radio paused', { class: 'now', role: 'status', 'aria-live': 'polite', tabindex: 0 });
  const status = node('div', '', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const settings = node('div', '', { class: 'settings' });
  const theme = node('select', '', { 'aria-label': 'Radio theme' });
  ['auto', 'dark', 'light'].forEach(value => theme.append(node('option', value, { value })));
  theme.value = panel.dataset.theme;
  const compact = node('button', 'Compact', { type: 'button', 'aria-pressed': panel.dataset.compact });
  const session = node('span', 'Guest listener');
  const audio = node('audio', '', { preload: 'none' });
  audio.volume = Number.isFinite(options.volume) ? Math.max(0, Math.min(1, options.volume)) : 0.5;
  volume.value = String(audio.volume);
  controls.append(play, stationInput, volume, up, down, netLabel);
  settings.append(theme, compact, session);
  panel.append(brand, controls, now, status, settings, audio);
  const parts = { panel, brand, controls, play, station: stationInput, volume, up, down, net: netLabel, now, status, settings, theme, compact, session, audio };
  for (const [name, control] of Object.entries(parts)) control.setAttribute('part', name);
  if (!customRender) root.replaceChildren(style, panel);

  const radioUrl = radioEndpoint(options.workerUrl || DEFAULT_WORKER);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  let storage = options.storage;
  if (!storage) { try { storage = window.localStorage; } catch {} }
  let listener;
  const votes = readRadioVotes(storage, radioUrl);
  let destroyed = false, listening = false, reachable = false, playable = false;
  let state = null, track = null, loaded = null, net = null, pending = false, optimistic = null;
  let generation = 0, mediaGeneration = 0, timer = null, metadata = null, offWallet = null, head = null, polling = false;
  const requests = new Set(), cleanups = [];
  let view = null;
  const on = (target, event, handler) => {
    target.addEventListener(event, handler);
    cleanups.push(() => target.removeEventListener(event, handler));
  };
  const request = async work => {
    const controller = new AbortController();
    requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15000);
    try { return await work(controller.signal); }
    finally { clearTimeout(timeout); requests.delete(controller); }
  };
  function render() {
    if (destroyed) return;
    for (const [id, value] of readRadioVotes(storage, radioUrl)) votes.set(id, value);
    const choice = votes.get(track?.playId);
    play.textContent = listening ? 'Ⅱ' : '▶';
    play.setAttribute('aria-pressed', String(listening));
    play.setAttribute('aria-label', `${listening ? 'Pause' : 'Play'} ${station.label || station.id} radio`);
    for (const [button, vote] of [[up, 1], [down, -1]]) {
      button.disabled = station.id !== 'dbusk' || !listening || !reachable || !playable ||
        !track?.playId || pending || choice !== undefined;
      button.setAttribute('aria-pressed', String((optimistic ?? choice) === vote));
    }
    netLabel.textContent = net === null ? '—' : net > 0 ? `+${net}` : String(net);
    netLabel.setAttribute('aria-label', net === null ? 'Net votes unavailable' : `${net} net votes ${track?.isDevert ? 'this advert play' : 'this week'}`);
    view?.update?.({ station, listening, now: now.textContent, status: status.textContent });
  }
  function clearAudio() {
    mediaGeneration++;
    metadata = null;
    loaded = null;
    playable = false;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  function cancel() {
    generation++;
    clearTimeout(timer);
    timer = null;
    for (const controller of requests) controller.abort();
    polling = false;
    pending = false;
    optimistic = null;
  }
  function failure(error, current) {
    if (destroyed || current !== generation) return;
    listening = false;
    clearAudio();
    status.textContent = error?.name === 'NotAllowedError' ? 'Autoplay blocked · press Play to listen' : 'Media unavailable · press Play to retry';
    render();
  }
  async function startAudio(current) {
    const media = mediaGeneration;
    try {
      await audio.play();
      if (destroyed || current !== generation || media !== mediaGeneration) return;
      playable = !audio.paused;
      render();
    } catch (error) {
      if (media === mediaGeneration) failure(error, current);
    }
  }
  function schedule(current, delay = 8000) {
    clearTimeout(timer);
    if (!destroyed && current === generation && station.id === 'dbusk') timer = setTimeout(() => void poll(current), delay);
  }
  async function poll(current) {
    if (destroyed || current !== generation || station.id !== 'dbusk' || polling) return;
    polling = true;
    try {
      const snapshot = await request(signal => readRadioState({ radioUrl, fetchImpl, signal }));
      if (destroyed || current !== generation) return;
      state = snapshot;
      reachable = true;
      const previous = track?.playId;
      track = snapshot.nowPlaying;
      if (previous !== track?.playId) { net = null; status.textContent = ''; }
      const media = radioMediaUrl(radioUrl, track?.ipfsCid);
      const show = radioShowLabel(snapshot);
      now.textContent = track
        ? `${show} · ${track.title || 'Untitled'}${track.artistEns || track.uploaderEns || track.uploader ? ` — ${track.artistEns || track.uploaderEns || track.uploader}` : ''}`
        : `${show} · ${snapshot.playback?.status || snapshot.status || 'between tracks'}`;
      if (!track || !media) {
        clearAudio();
        if (track) status.textContent = 'Track not available on IPFS yet';
      } else if (listening) {
        const id = `${track.playId || track.trackId || media}:${media}`;
        if (loaded !== id) {
          clearAudio();
          loaded = id;
          metadata = { current, id, position: Number(track.positionMs) / 1000 || 0, received: Date.now() };
          audio.src = media;
          void startAudio(current);
        } else if (audio.ended) status.textContent = 'Waiting for the next track';
      }
      render();
      if (!pending && track?.playId) {
        const playId = track.playId;
        try {
          const total = await request(signal => readRadioNet({ radioUrl, track, fetchImpl, signal }));
          if (!destroyed && current === generation && track?.playId === playId && !pending) net = total;
        } catch { if (!destroyed && current === generation && !pending) net = null; }
      }
    } catch {
      if (destroyed || current !== generation) return;
      reachable = false;
      track = null;
      net = null;
      clearAudio();
      now.textContent = 'DBusk radio unavailable · retrying';
      status.textContent = 'Network/CORS or Discord cooldown · playback and voting unavailable';
    } finally {
      if (!destroyed && current === generation) { polling = false; render(); schedule(current); }
    }
  }
  async function vote(value) {
    render();
    if (destroyed || up.disabled || down.disabled || pending || !track?.playId) return;
    const playId = track.playId, current = generation, oldNet = net;
    pending = true;
    optimistic = value;
    if (net !== null) net += value;
    status.textContent = 'Recording vote…';
    render();
    try {
      listener ||= radioListenerId(storage);
      const result = await request(signal => sendRadioVote({ radioUrl, playId, voterId: listener, vote: value, fetchImpl, signal }));
      if (result.playId !== playId || ![1, -1].includes(result.vote)) throw new Error('Invalid vote response');
      if (destroyed || current !== generation) return;
      votes.set(playId, result.vote);
      saveRadioVotes(storage, radioUrl, votes);
      if (track?.playId === playId) status.textContent = 'Vote recorded';
      try {
        const total = await request(signal => readRadioNet({ radioUrl, track, fetchImpl, signal }));
        if (!destroyed && current === generation && track?.playId === playId) net = total;
      } catch {}
    } catch (error) {
      if (destroyed || current !== generation) return;
      if (track?.playId === playId) { net = oldNet; status.textContent = `Vote not recorded: ${error.message}`; }
    } finally {
      if (!destroyed && current === generation) { pending = false; optimistic = null; render(); }
    }
  }
  function tune() {
    cancel();
    clearAudio();
    track = null;
    net = null;
    status.textContent = '';
    if (station.id === 'dbusk') { now.textContent = 'Tuning in to DBusk…'; void poll(generation); }
    else {
      now.textContent = `${station.label || station.id} · live stream`;
      if (listening) { audio.src = station.url; void startAudio(generation); }
    }
    render();
  }
  function attachHead(value) {
    if (destroyed || !value || value === head) return;
    offWallet?.();
    head = value;
    const walletChanged = () => {
      if (destroyed) return;
      const walletSession = head.getWallet?.();
      const wallet = walletSession?.snapshot?.() || walletSession;
      session.textContent = wallet?.ensName || wallet?.ens || wallet?.address || 'Guest listener';
      // Share the host session; anonymous radio votes remain anonymous until the API supports signed votes.
    };
    walletChanged();
    const off = head.on?.('wallet', walletChanged);
    offWallet = typeof off === 'function' ? off : () => head.off?.('wallet', walletChanged);
    head.getIpfs?.();
  }
  on(play, 'click', () => {
    listening = !listening;
    if (listening) tune();
    else { cancel(); clearAudio(); status.textContent = 'Radio paused'; render(); schedule(generation); }
  });
  function selectStation(id, { play: start = false } = {}) {
    if (destroyed) return;
    const selected = stations.find(entry => entry.id === id);
    if (!selected) return;
    station = selected;
    stationInput.value = station.id;
    if (start) listening = true;
    tune();
  }
  on(stationInput, 'change', () => selectStation(stationInput.value));
  on(volume, 'input', () => { audio.volume = Math.max(0, Math.min(1, Number(volume.value))); });
  on(theme, 'change', () => { panel.dataset.theme = theme.value; });
  on(compact, 'click', () => {
    panel.dataset.compact = String(panel.dataset.compact !== 'true');
    compact.setAttribute('aria-pressed', panel.dataset.compact);
  });
  on(up, 'click', () => void vote(1));
  on(down, 'click', () => void vote(-1));
  on(audio, 'error', () => { if (listening) failure(audio.error, generation); });
  on(audio, 'loadedmetadata', () => {
    if (!metadata || destroyed || metadata.current !== generation || metadata.id !== loaded) return;
    const position = metadata.position + (Date.now() - metadata.received) / 1000;
    if (Number.isFinite(audio.duration) && position < audio.duration - 2) audio.currentTime = Math.max(0, position);
    metadata = null;
  });
  on(audio, 'ended', () => {
    playable = false;
    if (station.id === 'dbusk') { status.textContent = 'Waiting for the next track'; schedule(generation, 750); render(); }
    else failure(new Error('Live stream ended'), generation);
  });
  on(window, 'storage', event => {
    if (event.key !== `decentbusking:votes:v1:${radioUrl}`) return;
    for (const [id, value] of readRadioVotes(storage, radioUrl)) votes.set(id, value);
    render();
  });
  on(window, 'decenthead:ready', () => attachHead(options.head || window.DecentHead));
  attachHead(options.head || window.DecentHead);
  const controller = {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      listening = false;
      cancel();
      offWallet?.();
      for (const cleanup of cleanups) cleanup();
      clearAudio();
      view?.destroy?.();
      root.replaceChildren();
      if (mounted.get(element) === controller) mounted.delete(element);
    },
  };
  mounted.set(element, controller);
  try {
    if (customRender) view = options.render({ element, document, controls: parts, stations: stations.map(entry => ({ ...entry })), selectStation });
  } catch (error) {
    controller.destroy();
    throw error;
  }
  tune();
  return controller;
}
