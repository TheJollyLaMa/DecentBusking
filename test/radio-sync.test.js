const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function radioSyncSource() {
  const formatter = fs.readFileSync(path.join(__dirname, '../js/usdc-format.mjs'), 'utf8')
    .replace('export function formatUsdcUnits', 'function _formatUsdcUnits');
  const source = fs.readFileSync(path.join(__dirname, '../js/radio-sync.js'), 'utf8')
    .replace(/^import[^\n]*\n/gm, '')
    .replace(/export /g, '');
  return `${formatter}\n${source}`;
}

test('radio footer places Saved after votes and video before audio mute without changing control IDs', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const footer = html.slice(html.indexOf('<footer id="radio-footer">'), html.indexOf('</decent-foot>'));
  const media = footer.slice(footer.indexOf('class="radio-media-controls"'), footer.indexOf('class="radio-title-window"'));
  const votes = footer.slice(footer.indexOf('class="radio-voting-controls"'), footer.indexOf('id="now-playing-artist"'));
  assert.ok(media.indexOf('id="radio-video-toggle"') < media.indexOf('id="radio-mute"'));
  assert.match(media, /id="radio-video-toggle"/);
  assert.match(media, /id="radio-mute"/);
  assert.match(votes, /id="now-playing-watchlist-btn"/);
  assert.ok(votes.indexOf('id="radio-vote-net"') < votes.indexOf('id="now-playing-watchlist-btn"'));
  for (const id of ['radio-video-toggle', 'radio-mute', 'now-playing-watchlist-btn']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1);
  }
});


test('radio stays silent until a delayed initial seek completes', async () => {
  const source = radioSyncSource();
  let seekable = false;
  let position = 0;
  const audio = {
    duration: 180,
    volume: 0,
    paused: true,
    seeking: false,
    readyState: 4,
    seekable: {
      get length() { return seekable ? 1 : 0; },
      start: () => 0,
      end: () => 180,
    },
    get currentTime() { return position; },
    set currentTime(value) {
      position = value;
      audio.seeking = true;
      setTimeout(() => { audio.seeking = false; }, 60);
    },
  };
  const context = vm.createContext({ performance, setTimeout, clearTimeout, console, audio });
  vm.runInContext(`${source}\n_audio = audio; globalThis.prepare = _prepareRadioSeek;`, context);
  let completed = false;
  const pending = context.prepare(() => 25, 0).then((result) => {
    completed = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(completed, false);
  assert.equal(position, 0);
  assert.equal(audio.paused, true);
  seekable = true;
  assert.equal(await pending, true);
  assert.equal(position, 25);
  assert.equal(audio.seeking, false);
  assert.equal(audio.volume, 0);
  assert.equal(audio.paused, true);
});

test('radio rejects a finished seek that landed at zero and waits for buffered sync', async () => {
  const source = radioSyncSource();
  let position = 0;
  let assignments = 0;
  const audio = {
    duration: 180, volume: 0, paused: true, seeking: false, readyState: 1,
    seekable: { length: 1, start: () => 0, end: () => 180 },
    get currentTime() { return position; },
    set currentTime(value) {
      if (++assignments > 1) position = value;
    },
  };
  const context = vm.createContext({ performance, setTimeout, clearTimeout, console, audio });
  vm.runInContext(`${source}\n_audio = audio; globalThis.prepare = _prepareRadioSeek;`, context);
  let completed = false;
  const pending = context.prepare(() => 25, 0).then((result) => { completed = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(completed, false);
  assert.equal(position, 0);
  audio.readyState = 4;
  assert.equal(await pending, true);
  assert.ok(assignments >= 2);
  assert.equal(position, 25);
  assert.equal(audio.volume, 0);
});

test('radio corrects a play-time position reset while silent, then starts immediately in sync', async () => {
  const source = radioSyncSource().replace('const FADE_IN_MS = 1_500;', 'const FADE_IN_MS = 1;');
  const audiblePositions = [];
  let position = 0;
  let volume = 0;
  const audio = new EventTarget();
  Object.assign(audio, {
    duration: 180, paused: true, seeking: false, readyState: 1,
    seekable: { length: 1, start: () => 0, end: () => 180 },
    pause() { this.paused = true; },
    removeAttribute() {}, querySelectorAll: () => [], appendChild() {},
    load() {
      setTimeout(() => { this.readyState = 4; this.dispatchEvent(new Event('loadedmetadata')); }, 0);
    },
    async play() { this.paused = false; position = 0; },
  });
  Object.defineProperties(audio, {
    currentTime: { get: () => position, set: (value) => { position = value; } },
    volume: { get: () => volume, set: (value) => {
      volume = value;
      if (value > 0 && !audio.paused) audiblePositions.push(position);
    } },
  });
  const context = vm.createContext({ performance, setTimeout, clearTimeout, console, audio,
    document: { createElement: () => ({}) } });
  vm.runInContext(`${source}\n_audio = audio; globalThis.switchTrack = _switchTo;`, context);
  await context.switchTrack({ title: 'Radio', artist: 'Artist', url: 'https://audio.example/song', offset: () => 25 });
  assert.ok(audiblePositions.length > 0);
  assert.ok(audiblePositions.every((seconds) => seconds === 25));
  assert.equal(position, 25);
  assert.equal(volume, 1);
});

test('radio still starts playback when the gateway cannot seek yet', async () => {
  const source = radioSyncSource();
  let position = 0;
  let volume = 0;
  const audio = new EventTarget();
  Object.assign(audio, {
    duration: 180,
    paused: true,
    seeking: false,
    readyState: 1,
    seekable: { length: 0, start: () => 0, end: () => 0 },
    pause() { this.paused = true; },
    removeAttribute() {},
    querySelectorAll: () => [],
    appendChild() {},
    load() {
      setTimeout(() => { this.readyState = 4; this.dispatchEvent(new Event('loadedmetadata')); }, 0);
    },
    async play() { this.paused = false; position = 0; },
  });
  Object.defineProperties(audio, {
    currentTime: { get: () => position, set: (value) => { position = value; } },
    volume: { get: () => volume, set: (value) => { volume = value; } },
  });
  const context = vm.createContext({ performance, setTimeout, clearTimeout, console, audio,
    document: { createElement: () => ({}) } });
  vm.runInContext(`${source}\n_audio = audio; _audioPlayer = audio; globalThis.switchTrack = _switchTo;`, context);
  await context.switchTrack({ title: 'Radio', artist: 'Artist', url: 'https://audio.example/song', offset: () => 25 });
  assert.equal(audio.paused, false);
  assert.equal(position, 0);
  assert.equal(volume, 1);
});

test('radio keeps the current song playing until it ends before switching the next track at the live offset', async () => {
  const source = radioSyncSource();
  let position = 90;
  const audio = new EventTarget();
  Object.assign(audio, {
    duration: 180,
    paused: false,
    seeking: false,
    readyState: 4,
    seekable: { length: 1, start: () => 0, end: () => 180 },
    pause() { this.paused = true; },
    removeAttribute() {},
    querySelectorAll: () => [],
    appendChild() {},
    load() {},
    async play() { this.paused = false; position = 0; },
  });
  Object.defineProperties(audio, {
    currentTime: { get: () => position, set: (value) => { position = value; } },
    volume: { get: () => 1, set: () => {} },
  });

  const context = vm.createContext({ performance, setTimeout, clearTimeout, console, audio,
    window: { DecentConfig: { ipfsGateway: 'https://gateway.example/ipfs/' } } });
  vm.runInContext(`${source}\n_audio = audio; _loadedPlayId = 'track-1'; _radio = {
    playId: 'track-2', title: 'Next', uploader: 'Artist', ipfsCid: 'bafy-next',
    filename: 'next.mp3', receivedAt: performance.now(), positionMs: 12_000,
  }; globalThis.started = []; _switchTo = options => started.push(options); _syncRadio();`, context);
  assert.equal(audio.paused, false);
  assert.equal(vm.runInContext('started.length', context), 0);

  vm.runInContext('_audio.paused = true; _syncRadio();', context);
  assert.equal(vm.runInContext('started.length', context), 1);
  assert.equal(Math.round(vm.runInContext('started[0].offset()', context)), 12);
});

test('radio sync renders the shared main-radio countdown in the footer and broadcasts state', async () => {
  const source = radioSyncSource();
  const nodes = new Map();
  const listeners = new Map();
  function element(id) {
    if (nodes.has(id)) return nodes.get(id);
    const handlers = new Map();
    const item = {
      id,
      hidden: false,
      paused: true,
      volume: 1,
      value: '100',
      textContent: '',
      style: { setProperty() {} },
      classList: { toggle() {}, add() {}, remove() {} },
      addEventListener(name, callback) { handlers.set(name, callback); },
      setAttribute() {},
      removeAttribute() {},
      querySelector(selector) {
        if (selector === '[data-volume-on]' || selector === '[data-volume-off]') return { hidden: false };
        return null;
      },
      focus() {},
      pause() {},
      play: async () => {},
      load() {},
    };
    nodes.set(id, item);
    return item;
  }
  const document = {
    readyState: 'loading',
    defaultView: { CustomEvent },
    getElementById: element,
    querySelectorAll: () => [],
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(callback);
    },
    dispatchEvent(event) {
      for (const callback of listeners.get(event.type) || []) callback(event);
    },
  };
  const states = [];
  const context = vm.createContext({
    performance,
    setTimeout,
    clearTimeout,
    console,
    document,
    CustomEvent,
    states,
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        serverTime: 100,
        nowPlaying: null,
        recent: [],
        mainRadioAdCountdown: { status: 'countdown', remainingSongs: 3, includesCurrentSong: false },
      }),
    }),
    window: { DecentConfig: { ipfsUploadServiceUrl: 'https://service.example' } },
  });
  vm.runInContext(`${source}\ndocument.readyState = 'complete';\ndocument.addEventListener('dbusk-radio-state', (event) => states.push(event.detail));\ninitRadioSync();`, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(element('radio-ad-countdown').textContent, 'next ad after 3 more songs');
  assert.equal(states.at(-1).mainRadioAdCountdown.remainingSongs, 3);
});

test('radio sync does not force-seek an actively playing track on poll', () => {
  const source = radioSyncSource();
  const audio = {
    paused: false,
    currentTime: 3,
  };
  const context = vm.createContext({ performance, setTimeout, clearTimeout, console, audio });
  vm.runInContext(`${source}\n_audio = audio; _loadedPlayId = 'play-1'; _radio = { playId: 'play-1', positionMs: 18_000, receivedAt: performance.now() }; var seekCalls = 0; _seekTo = () => { seekCalls += 1; return true; }; _syncRadio();`, context);
  assert.equal(vm.runInContext('seekCalls', context), 0);
  assert.equal(audio.currentTime, 3);
});

test('radio sync uses a friendly worker-gas message instead of surfacing raw balance errors', () => {
  const source = radioSyncSource();
  const context = vm.createContext({ performance, setTimeout, clearTimeout, console });
  vm.runInContext(`${source}\nglobalThis.formatStatus = formatMainRadioAdCountdown;`, context);
  assert.equal(vm.runInContext(`formatStatus({ status: 'unavailable', reason: 'worker gas low' })`, context),
    'Ad reporting paused – worker gas low');
  assert.equal(vm.runInContext(`formatStatus({ status: 'unavailable', reason: 'something else' })`, context),
    'Main radio ad: unavailable (something else)');
});

test('compact footer countdown distinguishes this song, next song and longer waits', () => {
  const context = vm.createContext({ console });
  vm.runInContext(radioSyncSource(), context);
  for (const [remainingSongs, includesCurrentSong, expected] of [
    [0, false, 'next ad after this song'], [1, false, 'next ad after next song'],
    [6, false, 'next ad after 6 more songs'], [1, true, 'next ad after this song'],
    [2, true, 'next ad after next song'], [7, true, 'next ad after 6 more songs'],
  ]) {
    const actual = vm.runInContext(`formatMainRadioAdCountdown({status:'countdown', remainingSongs:${remainingSongs},
      includesCurrentSong:${includesCurrentSong}}, {compact:true})`, context);
    assert.equal(actual, expected);
  }
  assert.equal(vm.runInContext(`formatMainRadioAdCountdown({status:'up_next'}, {compact:true})`, context), 'next ad after this song');
  assert.equal(vm.runInContext(`formatMainRadioAdCountdown({status:'playing'}, {compact:true})`, context), 'ad playing now');
});

test('radio sponsor tags format DJuke and DeVert labels with short addresses', () => {
  const source = radioSyncSource();
  const context = vm.createContext({ performance, setTimeout, clearTimeout, console });
  vm.runInContext(`${source}\nglobalThis.formatSponsor = formatRadioSponsor;`, context);
  assert.equal(vm.runInContext(`formatSponsor({ kind: 'djuke', wallet: '0x4051c7f0f9f0c7f0f9f0c7f0f9f0c7f0f9f0235f', amountUnits: '1000000', requestId: '8453:1' }, 'thejollylama.eth').text`,
    context), '💸 DJuke · bumped by thejollylama.eth · 1.00 USDC');
  assert.equal(vm.runInContext(`formatSponsor({ kind: 'devert', wallet: '0x4051c7f0f9f0c7f0f9f0c7f0f9f0c7f0f9f0235f', campaignId: '42' }).text`,
    context), '📣 DeVert ad · sponsored by 0x4051…235f');
});

test('radio sync waits for playback to start before broadcasting now-playing details', () => {
  const source = radioSyncSource();
  const events = [];
  const document = new EventTarget();
  document.addEventListener('dbusk-now-playing', (event) => events.push(event.detail));
  const audio = {
    paused: true,
    ended: false,
    readyState: 4,
    volume: 1,
    muted: false,
    pause() { this.paused = true; },
    removeAttribute() {},
    querySelectorAll: () => [],
    appendChild() {},
    load() {},
  };
  const context = vm.createContext({
    performance,
    setTimeout,
    clearTimeout,
    console,
    audio,
    document,
    CustomEvent,
    window: { DecentConfig: { ipfsGateway: 'https://gateway.example/ipfs/' } },
  });
  vm.runInContext(`${source}\n_audio = audio; _mode = 'radio'; _radio = {
    playId: 'play-42',
    trackId: 'track-42',
    title: 'Signal Fire',
    uploader: 'Synth Artist',
    ipfsCid: 'bafy-fire',
    filename: 'signal-fire.mp3',
    receivedAt: performance.now(),
    positionMs: 0,
    sponsor: { kind: 'djuke', wallet: '0x1111111111111111111111111111111111111111', amountUnits: '1000000', requestId: '8453:1' },
  }; _switchTo = () => {}; _syncRadio();`, context);
  assert.equal(events.length, 0);
});

test('radio sync resumes a reloaded listener at the live offset instead of the track start', async () => {
  const source = radioSyncSource();
  const started = [];
  const audio = {
    paused: true,
    volume: 0,
    muted: false,
    duration: 180,
    readyState: 4,
    seeking: false,
    seekable: { length: 1, start: () => 0, end: () => 180 },
    pause() { this.paused = true; },
    removeAttribute() {},
    querySelectorAll: () => [],
    appendChild() {},
    load() {},
    async play() { this.paused = false; },
  };
  const context = vm.createContext({
    performance,
    setTimeout,
    clearTimeout,
    console,
    audio,
    started,
    window: { DecentConfig: { ipfsGateway: 'https://gateway.example/ipfs/' } },
  });
  vm.runInContext(`${source}\n_audio = audio; _audioPlayer = audio; _radio = {
    playId: 'play-live',
    title: 'Live Now',
    uploader: 'Synth Artist',
    ipfsCid: 'bafy-live',
    receivedAt: performance.now() - 90_000,
    positionMs: 12_000,
  }; _switchTo = options => started.push(options); _syncRadio();`, context);
  assert.equal(started.length, 1);
  assert.equal(Math.round(started[0].offset()), 102);
});

test('radio gateway URLs normalize the configured base and prefer worker media when configured', () => {
  const context = vm.createContext({
    performance,
    setTimeout,
    clearTimeout,
    console,
    window: { DecentConfig: { ipfsGateway: 'https://gateway.example/ipfs/' } },
  });
  vm.runInContext(`${radioSyncSource()}\nglobalThis.gatewayUrls = _gatewayUrls('bafy-song');`, context);
  assert.deepEqual(Array.from(context.gatewayUrls), [
    'https://gateway.example/ipfs/bafy-song',
  ]);

  vm.runInContext("window.DecentConfig.ipfsGateway = 'https://gateway.example'; gatewayUrls = _gatewayUrls('bafy-song');", context);
  assert.equal(context.gatewayUrls[0], 'https://gateway.example/ipfs/bafy-song');
  vm.runInContext("window.DecentConfig.ipfsUploadServiceUrl = 'https://worker.example/'; gatewayUrls = _gatewayUrls('bafy-song');", context);
  assert.deepEqual(Array.from(context.gatewayUrls), [
    'https://worker.example/api/radio/media?cid=bafy-song',
    'https://gateway.example/ipfs/bafy-song',
  ]);
});

test('radio retries alternate IPFS gateways when the configured gateway fails', async () => {
  const source = radioSyncSource();
  const sources = [];
  const events = [];
  const document = new EventTarget();
  document.addEventListener('dbusk-now-playing', (event) => events.push(event.detail));
  const audio = new EventTarget();
  Object.assign(audio, {
    duration: 180,
    paused: true,
    seeking: false,
    readyState: 1,
    volume: 0,
    seekable: { length: 1, start: () => 0, end: () => 180 },
    pause() { this.paused = true; },
    removeAttribute() {},
    querySelectorAll: () => [],
    appendChild(sourceNode) { sources.push(sourceNode.src); },
    load() {
      const eventName = sources.at(-1).startsWith('https://primary.example/')
        ? 'error'
        : 'loadedmetadata';
      setTimeout(() => {
        this.readyState = 4;
        this.dispatchEvent(new Event(eventName));
      }, 0);
    },
    async play() { this.paused = false; },
  });
  const context = vm.createContext({ performance, setTimeout, clearTimeout, console, audio, document, CustomEvent });
  document.createElement = () => ({});
  vm.runInContext(`${source}
    _audio = audio; _audioPlayer = audio; _mode = 'radio'; _loadedPlayId = 'play-1';
    _radio = { playId: 'play-1', receivedAt: performance.now(), positionMs: 0 };
    globalThis.switchTrack = _switchTo;`, context);

  await context.switchTrack({
    title: 'Signal Fire',
    artist: 'Synth Artist',
    url: 'https://primary.example/ipfs/bafy-fire',
    fallbackUrls: ['https://dweb.link/ipfs/bafy-fire'],
    mime: 'audio/mpeg',
    nowPlaying: {
      source: 'radio',
      playId: 'play-1',
      audioUrl: 'https://primary.example/ipfs/bafy-fire',
      ipfsCid: 'bafy-fire',
    },
  });

  assert.deepEqual(sources, [
    'https://primary.example/ipfs/bafy-fire',
    'https://dweb.link/ipfs/bafy-fire',
  ]);
  assert.equal(events[0].audioUrl, 'https://dweb.link/ipfs/bafy-fire');
  assert.equal(audio.paused, false);
});

test('failed radio gateway attempts clear the loaded play so the same track can retry', async () => {
  const source = radioSyncSource();
  const audio = new EventTarget();
  Object.assign(audio, {
    paused: true,
    volume: 0,
    pause() { this.paused = true; },
    removeAttribute() {},
    querySelectorAll: () => [],
    appendChild() {},
    load() { setTimeout(() => this.dispatchEvent(new Event('error')), 0); },
  });
  const activity = {
    hidden: true,
    textContent: '',
    classList: { remove() {}, add() {} },
  };
  const context = vm.createContext({
    performance,
    setTimeout,
    clearTimeout,
    console,
    audio,
    activity,
    document: { createElement: () => ({}) },
  });
  vm.runInContext(`${source}
    _audio = audio; _audioPlayer = audio; _mode = 'radio'; _loadedPlayId = 'play-1';
    _radio = { playId: 'play-1' }; _activityEl = activity;
    globalThis.switchTrack = _switchTo;`, context);

  await context.switchTrack({
    title: 'Unavailable',
    artist: 'Synth Artist',
    url: 'https://primary.example/ipfs/bafy-fire',
    fallbackUrls: ['https://dweb.link/ipfs/bafy-fire'],
    mime: 'audio/mpeg',
    nowPlaying: { playId: 'play-1' },
  });

  assert.equal(vm.runInContext('_loadedPlayId', context), null);
  assert.match(activity.textContent, /Couldn’t load this track from IPFS/);
});

test('switchTo broadcasts now-playing after the site audio begins and stops on pause', async () => {
  const source = radioSyncSource();
  const events = [];
  const stopped = [];
  const document = new EventTarget();
  document.addEventListener('dbusk-now-playing', (event) => events.push(event.detail));
  document.addEventListener('dbusk-now-playing-stopped', (event) => stopped.push(event.detail));
  let position = 0;
  const audio = new EventTarget();
  Object.assign(audio, {
    duration: 180,
    paused: true,
    seeking: false,
    readyState: 1,
    seekable: { length: 1, start: () => 0, end: () => 180 },
    pause() { this.paused = true; this.dispatchEvent(new Event('pause')); },
    removeAttribute() {},
    querySelectorAll: () => [],
    appendChild() {},
    load() {
      setTimeout(() => { this.readyState = 4; this.dispatchEvent(new Event('loadedmetadata')); }, 0);
    },
    async play() { this.paused = false; position = 0; },
  });
  Object.defineProperties(audio, {
    currentTime: { get: () => position, set: (value) => { position = value; } },
    volume: { get: () => 0, set: () => {} },
  });
  const context = vm.createContext({
    performance,
    setTimeout,
    clearTimeout,
    console,
    audio,
    document,
    CustomEvent,
    window: { DecentConfig: { ipfsGateway: 'https://gateway.example/ipfs/' } },
  });
  document.createElement = () => ({ });
  vm.runInContext(`${source}\n_audio = audio; _audioPlayer = audio; globalThis.switchTrack = _switchTo;`, context);
  await context.switchTrack({
    title: 'Signal Fire',
    artist: 'Synth Artist',
    url: 'https://audio.example/song',
    mime: 'audio/mpeg',
    nowPlaying: {
      source: 'radio',
      playId: 'play-42',
      trackId: 'track-42',
      title: 'Signal Fire',
      artist: 'Synth Artist',
      audioUrl: 'https://gateway.example/ipfs/bafy-fire',
      mediaType: 'audio/mpeg',
      ipfsCid: 'bafy-fire',
      nft: null,
      sponsor: { kind: 'djuke', wallet: '0x1111111111111111111111111111111111111111', amountUnits: '1000000', requestId: '8453:1' },
    },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'radio');
  assert.equal(events[0].playId, 'play-42');
  assert.equal(events[0].trackId, 'track-42');
  assert.equal(events[0].title, 'Signal Fire');
  assert.equal(events[0].artist, 'Synth Artist');
  assert.equal(events[0].audioUrl, 'https://gateway.example/ipfs/bafy-fire');
  assert.equal(events[0].mediaType, 'audio/mpeg');
  assert.equal(events[0].ipfsCid, 'bafy-fire');
  assert.equal(events[0].nft, null);
  assert.deepEqual(events[0].sponsor, { kind: 'djuke', wallet: '0x1111111111111111111111111111111111111111', amountUnits: '1000000', requestId: '8453:1' });
  audio.pause();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(stopped.length > 0, true);
});

test('switchTo reveals now-playing before tune-in when autoplay is blocked', async () => {
  const source = radioSyncSource();
  const events = [];
  const document = new EventTarget();
  document.addEventListener('dbusk-now-playing', (event) => events.push(event.detail));
  const audio = new EventTarget();
  let position = 0;
  Object.assign(audio, {
    duration: 180,
    paused: true,
    seeking: false,
    readyState: 1,
    seekable: { length: 1, start: () => 0, end: () => 180 },
    pause() { this.paused = true; this.dispatchEvent(new Event('pause')); },
    removeAttribute() {},
    querySelectorAll: () => [],
    appendChild() {},
    load() {
      setTimeout(() => { this.readyState = 4; this.dispatchEvent(new Event('loadedmetadata')); }, 0);
    },
    async play() { throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' }); },
  });
  Object.defineProperties(audio, {
    currentTime: { get: () => position, set: (value) => { position = value; } },
    volume: { get: () => 0, set: () => {} },
  });
  document.createElement = () => ({ });
  const context = vm.createContext({
    performance,
    setTimeout,
    clearTimeout,
    console,
    audio,
    document,
    CustomEvent,
    window: { DecentConfig: { ipfsGateway: 'https://gateway.example/ipfs/' } },
  });
  vm.runInContext(`${source}\n_audio = audio; _audioPlayer = audio; globalThis.switchTrack = _switchTo;`, context);
  await context.switchTrack({
    title: 'Signal Fire',
    artist: 'Synth Artist',
    url: 'https://audio.example/song',
    mime: 'audio/mpeg',
    nowPlaying: {
      source: 'radio',
      playId: 'play-42',
      trackId: 'track-42',
      title: 'Signal Fire',
      artist: 'Synth Artist',
      audioUrl: 'https://gateway.example/ipfs/bafy-fire',
      mediaType: 'audio/mpeg',
      ipfsCid: 'bafy-fire',
      nft: null,
    },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].playId, 'play-42');
  assert.equal(events[0].title, 'Signal Fire');
  assert.equal(audio.paused, true);
});

test('site votes post only the current play and anonymous browser ID, with no wallet', async () => {
  const source = radioSyncSource();
  const context = vm.createContext({ AbortSignal, console });
  vm.runInContext(source, context);
  const result = await context.sendRadioVote({ radioUrl: 'https://worker.example/api/radio', playId: 'track:1',
    voterId: 'anonymous-browser-123', vote: 1,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://worker.example/api/radio/vote');
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { playId: 'track:1', voterId: 'anonymous-browser-123', vote: 1 });
      return new Response(JSON.stringify({ playId: 'track:1', vote: 1, duplicate: false }));
    },
  });
  assert.equal(result.vote, 1);
  await assert.rejects(context.sendRadioVote({ radioUrl: 'https://worker.example/api/radio',
    fetchImpl: async () => new Response(JSON.stringify({ error: 'This play has ended' }), { status: 400 }) }), /ended/);
});

test('confirmed radio votes notify the chart, but failed votes do not', async () => {
  const events = [];
  const context = vm.createContext({ AbortSignal, console, CustomEvent,
    document: { dispatchEvent: event => events.push(event) },
    localStorage: { getItem: () => 'anonymous-browser-123', setItem() {} },
    window: { DecentConfig: { radioUrl: 'https://worker.example/api/radio' } },
  });
  vm.runInContext(radioSyncSource(), context);
  vm.runInContext(`_mode = 'radio'; _radio = { playId: 'play-1' };
    _anonymousListenerId = () => 'anonymous-browser-123';
    sendRadioVote = async ({playId, vote}) => ({playId, vote});
    _renderVoting = () => {};`, context);
  await vm.runInContext('_castRadioVote(1)', context);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'dbusk-radio-vote-recorded');
  assert.equal(events[0].detail.vote, 1);
  vm.runInContext(`_radio = { playId: 'play-2' }; sendRadioVote = async () => { throw new Error('offline'); };`, context);
  await vm.runInContext('_castRadioVote(-1)', context);
  assert.equal(events.length, 1);
});

test('footer net votes refresh from weekly totals, handle errors and distinguish advert plays', async () => {
  const counter = { textContent: '', setAttribute(name, value) { this[name] = value; } };
  let votes = 3;
  let fail = false;
  let finish;
  const context = vm.createContext({ URL, AbortSignal, console: { warn() {} }, counter,
    window: { DecentConfig: { ipfsUploadServiceUrl: 'https://worker.example' } },
    fetch: async url => {
      assert.equal(url, 'https://worker.example/api/radio/history?weeks=1&calendar=new-york');
      if (fail) throw new Error('offline');
      return { ok: true, json: async () => ({ weeks: [{ current: true, tracks: [{ trackId: 'song', votes }] }] }) };
    },
  });
  vm.runInContext(`${radioSyncSource()}\n_voteNetEl = counter; _mode = 'radio'; _radioReachable = true;
    _radio = { playId: 'play-1', trackId: 'song' };`, context);
  await vm.runInContext('_refreshVoteNet()', context);
  assert.equal(counter.textContent, '+3');
  assert.match(counter['aria-label'], /3 net votes this week/);
  votes = -2;
  await vm.runInContext('_refreshVoteNet()', context);
  assert.equal(counter.textContent, '-2');
  votes = 0;
  await vm.runInContext('_refreshVoteNet()', context);
  assert.equal(counter.textContent, '0');
  fail = true;
  await vm.runInContext('_refreshVoteNet()', context);
  assert.equal(counter.textContent, '—', 'failed refresh does not present stale totals as live');
  context.fetch = () => new Promise(resolve => { finish = resolve; });
  const pending = vm.runInContext('_refreshVoteNet()', context);
  vm.runInContext("_radio = { playId: 'ad-1', isDevert: true, adVotes: { up: 4, down: 1, net: 3 } };", context);
  await vm.runInContext('_refreshVoteNet()', context);
  finish({ ok: true, json: async () => ({ weeks: [{ current: true, tracks: [{ trackId: 'song', votes: 99 }] }] }) });
  await pending;
  assert.equal(counter.textContent, '+3', 'late song response cannot overwrite advert votes');
  assert.match(counter['aria-label'], /this advert play/);
  vm.runInContext("_mode = 'archive'; _renderVoting();", context);
  assert.equal(counter.textContent, '—');
});

test('vote counter animates real changes only, with notes up, a hole down and reduced motion support', () => {
  const animations = [];
  const particles = [];
  let reduced = false;
  const number = { textContent: '', animate: (...args) => animations.push(args) };
  const effects = { ownerDocument: { createElement: () => ({ style: { setProperty() {} } }) },
    replaceChildren() { particles.length = 0; }, appendChild: node => particles.push(node) };
  const counter = { dataset: {}, querySelector: selector => selector === '[data-vote-number]' ? number : effects };
  const context = vm.createContext({ counter, window: { matchMedia: () => ({ matches: reduced }) } });
  vm.runInContext(`${radioSyncSource()}\n_voteNetEl = counter; _renderVoteNetValue(2, 'play-1');`, context);
  assert.equal(number.textContent, '+2');
  assert.equal(animations.length, 0, 'initial total does not pretend to be a vote');
  vm.runInContext("_renderVoteNetValue(3, 'play-1')", context);
  assert.equal(counter.dataset.trend, 'up');
  assert.equal(particles.length, 4);
  assert.equal(animations.length, 1);
  vm.runInContext("_renderVoteNetValue(3, 'play-1')", context);
  assert.equal(animations.length, 1, 'unchanged polls do not replay the celebration');
  vm.runInContext("_renderVoteNetValue(1, 'play-1')", context);
  assert.equal(counter.dataset.trend, 'down');
  assert.equal(particles.length, 1);
  assert.equal(particles[0].textContent, '🕳️');
  assert.equal(animations.length, 2);
  vm.runInContext("_renderVoteNetValue(20, 'play-2')", context);
  assert.equal(animations.length, 2, 'track changes are not vote gains');
  reduced = true;
  vm.runInContext("_renderVoteNetValue(21, 'play-2')", context);
  assert.equal(number.textContent, '+21');
  assert.equal(animations.length, 2);
  assert.equal(particles.length, 0);
});

test('confirmed footer votes refresh the server total rather than guessing a local increment', async () => {
  const context = vm.createContext({ AbortSignal, console, CustomEvent,
    document: { dispatchEvent() {} }, localStorage: { setItem() {} } });
  vm.runInContext(`${radioSyncSource()}\n_mode = 'radio'; _radio = { playId: 'song-play' };
    _anonymousListenerId = () => 'listener'; _radioUrl = () => 'https://worker.example/api/radio';
    sendRadioVote = async ({playId, vote}) => ({playId, vote});
    globalThis.refreshes = 0; _refreshVoteNet = async () => { refreshes++; };`, context);
  await vm.runInContext('_castRadioVote(-1)', context);
  assert.equal(context.refreshes, 1);
});

test('DeVert main-radio ads allow live-program votes while non-radio previews remain disabled', () => {
  const source = radioSyncSource();
  const button = { dataset: { radioVote: '1' }, disabled: false, setAttribute() {} };
  const context = vm.createContext({ performance, setTimeout, clearTimeout, console, button });
  vm.runInContext(`${source}\n_voteButtons = [button]; _mode = 'radio'; _radioReachable = true;\n` +
    `_radio = { playId: 'devert:1:play', ipfsCid: 'bafy-ad', isDevert: true }; _renderVoting();`,
    context);
  assert.equal(button.disabled, false);
  vm.runInContext("_devertListenMode = 'ads-only'; _renderVoting();", context);
  assert.equal(button.disabled, true);
});

test('MP4 playback uses one video stream and returns cleanly to audio with radio preferences intact', async () => {
  const source = radioSyncSource();
  const makePlayer = () => {
    const player = new EventTarget();
    Object.assign(player, { volume: 0, muted: false, duration: 180, currentTime: 0, paused: true,
      readyState: 4, seeking: false, seekable: { length: 1, start: () => 0, end: () => 180 },
      pause() { this.paused = true; }, removeAttribute() {}, querySelectorAll: () => [], appendChild() {},
      load() { setTimeout(() => this.dispatchEvent(new Event('loadedmetadata')), 0); },
      async play() { this.paused = false; } });
    return player;
  };
  const audio = makePlayer();
  const video = makePlayer();
  const stage = { hidden: true };
  const context = vm.createContext({ performance, setTimeout, clearTimeout, console, audio, video, stage,
    document: { createElement: () => ({}) } });
  vm.runInContext(`${source}\n_audio = audio; _audioPlayer = audio; _videoPlayer = video; _videoStage = stage;
    _radioMuted = true; _radioVolume = 0.4; globalThis.switchTrack = _switchTo;`, context);
  await context.switchTrack({ title: 'Video', artist: 'Artist', url: 'https://media.example/movie', mime: 'video/mp4', offset: () => 25 });
  assert.equal(audio.paused, true);
  assert.equal(video.paused, false);
  assert.equal(video.currentTime, 25);
  assert.equal(video.muted, true);
  assert.equal(video.volume, 0.4);
  assert.equal(stage.hidden, false);
  await context.switchTrack({ title: 'Audio', artist: 'Artist', url: 'https://media.example/song.mp3' });
  assert.equal(video.paused, true);
  assert.equal(audio.paused, false);
  assert.equal(audio.muted, true);
  assert.equal(audio.volume, 0.4);
  assert.equal(stage.hidden, true);
});

test('radio sync promotes a video stream when the state preserves an IPFS video source', async () => {
  const source = radioSyncSource();
  const started = [];
  const audio = { paused: true, volume: 0, muted: false };
  const context = vm.createContext({
    performance,
    setTimeout,
    clearTimeout,
    console,
    audio,
    started,
    window: { DecentConfig: { ipfsGateway: 'https://gateway.example/ipfs/' } },
  });
  vm.runInContext(`${source}\n_audio = audio; _audioPlayer = audio; _radio = {
    playId: 'play-video',
    title: 'Video Ad',
    uploader: 'Advertiser',
    ipfsCid: 'bafy-video',
    videoUrl: 'ipfs://bafy-video',
    mediaType: '',
    filename: '',
    receivedAt: performance.now(),
    positionMs: 0,
  }; _switchTo = options => started.push(options); _syncRadio();`, context);
  assert.equal(started.length, 1);
  assert.equal(started[0].mime, 'video/mp4');
  assert.equal(started[0].nowPlaying.videoUrl, 'ipfs://bafy-video');
});

test('radio sync prefers the visible video player when a main-radio ad exposes video metadata over an audio filename', async () => {
  const source = radioSyncSource();
  const started = [];
  const audio = { paused: true, volume: 0, muted: false };
  const context = vm.createContext({
    performance,
    setTimeout,
    clearTimeout,
    console,
    audio,
    started,
    window: { DecentConfig: { ipfsGateway: 'https://gateway.example/ipfs/' } },
  });
  vm.runInContext(`${source}\n_audio = audio; _audioPlayer = audio; _videoPlayer = { paused: true, volume: 0, muted: false, duration: 180,
    currentTime: 0, seekable: { length: 1, start: () => 0, end: () => 180 }, readyState: 4, seeking: false, play() { this.paused = false; },
    pause() { this.paused = true; }, removeAttribute() {}, querySelectorAll: () => [], appendChild() {}, load() {} };
    _videoStage = { hidden: true }; _radio = {
      playId: 'play-video',
      title: 'Video Ad',
      uploader: 'Advertiser',
      ipfsCid: 'bafy-video',
      videoUrl: 'ipfs://bafy-video',
      mediaType: '',
      filename: 'ad.mp3',
      receivedAt: performance.now(),
      positionMs: 0,
    }; _switchTo = options => started.push(options); _syncRadio();`, context);
  assert.equal(started.length, 1);
  assert.equal(started[0].mime, 'video/mp4');
  assert.equal(started[0].nowPlaying.videoUrl, 'ipfs://bafy-video');
});

test('radio volume survives fades and mute does not affect archive playback', async () => {
  const source = radioSyncSource();
  const audio = { volume: 0, muted: false };
  const saved = new Map();
  const context = vm.createContext({ performance, setTimeout, console, audio,
    localStorage: { setItem: (key, value) => saved.set(key, value) } });
  vm.runInContext(`${source}\n_audio = audio; _setRadioVolume(0.3); globalThis.fade = () => _fadeIn(0, 1);`, context);
  await context.fade();
  assert.equal(audio.volume, 0.3);
  vm.runInContext('_radioMuted = true; _saveAudioPreferences();', context);
  await context.fade();
  assert.equal(audio.muted, true);
  assert.equal(audio.volume, 0.3);
  assert.deepEqual(JSON.parse(saved.get('decentbusking:radio-audio:v1')),
    { volume: 0.3, muted: true });
  vm.runInContext("_mode = 'archive';", context);
  await context.fade();
  assert.equal(audio.muted, false);
  assert.equal(audio.volume, 1);
  vm.runInContext("_mode = 'radio';", context);
  await context.fade();
  assert.equal(audio.muted, true);
  assert.equal(audio.volume, 0.3);
  vm.runInContext('_setRadioVolume(0.65);', context);
  assert.equal(audio.muted, false);
  assert.equal(audio.volume, 0.65);
});

test('DVert audio toggle fades out main radio and can return without hijacking archive playback', async () => {
  const source = radioSyncSource();
  const audio = { paused: false, pause() { this.paused = true; } };
  const context = vm.createContext({ performance, setTimeout, clearTimeout, console, audio });
  vm.runInContext(`${source}\n_audio = audio; _mode = 'radio'; globalThis.setListenMode = setDevertListenMode;\n` +
    `globalThis.canSwitchListenMode = canSetDevertListenMode;`, context);
  assert.equal(context.canSwitchListenMode(), true);
  assert.equal(context.setListenMode('ads-only'), true);
  assert.equal(audio.paused, false);
  assert.equal(vm.runInContext('_devertListenMode', context), 'ads-only');
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(audio.paused, true);
  vm.runInContext("_mode = 'archive';", context);
  assert.equal(context.setListenMode('ads-only'), false);
  assert.equal(context.setListenMode('radio'), true);
  assert.equal(vm.runInContext('_devertListenMode', context), 'radio');
});

test('legacy sponsored-ad mute preference does not skip a main-radio ad', () => {
  const source = radioSyncSource();
  const context = vm.createContext({ performance, setTimeout, clearTimeout, console,
    window: { DecentConfig: { ipfsGateway: 'https://gateway.example/ipfs/' } } });
  vm.runInContext(`${source}\n_radio = { playId: 'ad-play', title: 'Campaign', uploader: 'Advertiser',
    ipfsCid: 'bafy-ad', isDevert: true, receivedAt: performance.now(), positionMs: 0 };\n` +
    `globalThis.started = []; _switchTo = options => started.push(options); _syncRadio();`, context);
  assert.equal(vm.runInContext('started.length', context), 1);
  assert.equal(vm.runInContext('started[0].title', context), 'Campaign');
  assert.equal(vm.runInContext("typeof _devertAdsMuted", context), 'undefined');
});

test('recorded browser votes survive reload and reset only for another radio play', () => {
  const source = radioSyncSource();
  const buttons = [1, -1].map((vote) => ({ dataset: { radioVote: String(vote) }, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; } }));
  const context = vm.createContext({ buttons, window: { DecentConfig: { ipfsUploadServiceUrl: 'https://worker.example' } },
    localStorage: { getItem: () => JSON.stringify([['play-1', 1]]) } });
  vm.runInContext(`${source}\n_voteButtons = buttons; _radio = { playId: 'play-1', ipfsCid: 'audio' }; _restoreVotes(); _renderVoting();`, context);
  assert.ok(buttons.every((button) => button.disabled));
  assert.equal(buttons[0].attributes['aria-pressed'], 'true');
  vm.runInContext("_radio.playId = 'play-2'; _renderVoting();", context);
  assert.ok(buttons.every((button) => !button.disabled));
  vm.runInContext("_mode = 'archive'; _renderVoting();", context);
  assert.ok(buttons.every((button) => button.disabled));
});
function preloadHarness({ bytes = 4, contentLength = null, extra = {} } = {}) {
  const source = radioSyncSource();
  const fetches = [];
  const revoked = [];
  let created = 0;
  const fetchImpl = async (url, { signal } = {}) => {
    fetches.push({ url, signal });
    const data = new Uint8Array(bytes);
    let sent = false;
    return {
      ok: true,
      status: 200,
      headers: { get: name => (name === 'content-length' ? String(contentLength ?? bytes) : 'audio/mp4') },
      body: { getReader: () => ({
        read: async () => {
          if (signal?.aborted) throw new Error('aborted');
          if (sent) return { done: true };
          sent = true;
          return { done: false, value: data };
        },
        cancel: async () => {},
      }) },
    };
  };
  const context = vm.createContext({
    performance, setTimeout, clearTimeout, console: { ...console, info() {}, warn() {} }, Blob, AbortController,
    fetch: fetchImpl,
    URL: { createObjectURL: () => `blob:preload-${++created}`, revokeObjectURL: url => revoked.push(url) },
    window: { DecentConfig: { ipfsGateway: 'https://gateway.example/ipfs/' } },
    ...extra,
  });
  vm.runInContext(source, context);
  return { context, fetches, revoked };
}

test('radio starts the next song from 0:00 after the previous song played to its end', () => {
  const source = radioSyncSource();
  const context = vm.createContext({ performance, setTimeout, clearTimeout, console,
    window: { DecentConfig: { ipfsGateway: 'https://gateway.example/ipfs/' } } });
  vm.runInContext(`${source}\n_audio = { paused: true }; _mode = 'radio'; _loadedPlayId = 'song-1';
    globalThis.started = []; _switchTo = options => started.push(options); _poll = () => {};
    _onEnded();
    globalThis.fastPoll = _handoffActive();
    _radio = { playId: 'song-2', title: 'Next', uploader: 'Artist', ipfsCid: 'bafy-2', receivedAt: performance.now(), positionMs: 3_000 };
    _syncRadio();`, context);
  assert.equal(vm.runInContext('fastPoll', context), true, 'polls quickly while waiting for the next song');
  assert.equal(vm.runInContext('started.length', context), 1);
  assert.equal(vm.runInContext('started[0].offset()', context), 0);
  assert.equal(vm.runInContext('started[0].preloadCid', context), 'bafy-2');
  assert.equal(vm.runInContext('_radioHandoff', context), null);
});

test('radio handoff survives the JukeLoop changeover gap and still starts the next song from 0:00', () => {
  const source = radioSyncSource();
  const context = vm.createContext({ performance, setTimeout, clearTimeout, console,
    window: { DecentConfig: { ipfsGateway: 'https://gateway.example/ipfs/' } } });
  vm.runInContext(`${source}\n_audio = { paused: true }; _mode = 'radio'; _loadedPlayId = 'song-1';
    _upNext = { title: 'Next Song', ipfsCid: 'bafy-2' };
    globalThis.started = []; _switchTo = options => started.push(options); _poll = () => {};
    _onEnded(); _radio = null; _syncRadio();
    _radio = { playId: 'song-2', title: 'Next', ipfsCid: 'bafy-2', receivedAt: performance.now(), positionMs: 1_200 };
    _syncRadio();`, context);
  assert.equal(vm.runInContext('started[0].offset()', context), 0);
});

test('radio still syncs to the live position when a continuous listener has fallen far behind', () => {
  const source = radioSyncSource();
  const context = vm.createContext({ performance, setTimeout, clearTimeout, console,
    window: { DecentConfig: { ipfsGateway: 'https://gateway.example/ipfs/' } } });
  vm.runInContext(`${source}\n_audio = { paused: true }; _mode = 'radio'; _loadedPlayId = 'song-1';
    globalThis.started = []; _switchTo = options => started.push(options); _poll = () => {};
    _onEnded();
    _radio = { playId: 'song-2', title: 'Next', ipfsCid: 'bafy-2', receivedAt: performance.now(), positionMs: 60_000 };
    _syncRadio();`, context);
  assert.equal(Math.round(vm.runInContext('started[0].offset()', context)), 60);
});

test('radio preloads the published next item once and hands the in-memory copy to the player', async () => {
  const { context, fetches } = preloadHarness();
  vm.runInContext(`_mode = 'radio'; _upNext = { trackId: 'next', title: 'Next', ipfsCid: 'bafy-next', filename: 'next.m4a' };
    _maybePreload(); _maybePreload();`, context);
  assert.equal(fetches.length, 1, 'one bounded download per upcoming item');
  assert.equal(fetches[0].url, 'https://gateway.example/ipfs/bafy-next');
  await vm.runInContext('_preload.done', context);
  assert.equal(vm.runInContext('_preload.status', context), 'ready');

  assert.equal(await vm.runInContext(`_takePreload('bafy-other')`, context), null);
  const entry = await vm.runInContext(`_takePreload('bafy-next')`, context);
  assert.equal(entry.blobUrl, 'blob:preload-1');
  assert.equal(vm.runInContext('_preload', context), null);
});

test('radio switchTo plays a ready preload from memory and releases the previous blob', async () => {
  const { context, revoked } = preloadHarness();
  const player = new EventTarget();
  const sources = [];
  Object.assign(player, { volume: 0, muted: false, duration: 180, currentTime: 0, paused: true, readyState: 4, seeking: false,
    seekable: { length: 1, start: () => 0, end: () => 180 }, pause() { this.paused = true; }, removeAttribute() {},
    querySelectorAll: () => [], appendChild(node) { sources.push(node.src); },
    load() { setTimeout(() => this.dispatchEvent(new Event('loadedmetadata')), 0); }, async play() { this.paused = false; } });
  context.player = player;
  context.document = { createElement: () => ({}) };
  vm.runInContext(`_audio = player; _audioPlayer = player; _mode = 'radio'; _activeBlobUrl = 'blob:old-song';
    _upNext = { trackId: 'next', title: 'Next', ipfsCid: 'bafy-next', filename: 'next.m4a' }; _maybePreload();`, context);
  await vm.runInContext('_preload.done', context);
  await vm.runInContext(`_switchTo({ title: 'Next', artist: 'Artist', url: 'https://gateway.example/ipfs/bafy-next', mime: 'audio/mp4', preloadCid: 'bafy-next' })`, context);
  assert.deepEqual(sources, ['blob:preload-1']);
  assert.deepEqual(revoked, ['blob:old-song']);
  assert.equal(player.paused, false);
  const diagnostics = vm.runInContext('getRadioTransitionDiagnostics()', context);
  assert.equal(diagnostics.transitions.at(-1).media, 'preload');
  assert.equal(diagnostics.transitions.at(-1).startedAtS, 0);
});

test('radio drops a stale preload when the next item changes and skips files over the preload limit', async () => {
  const { context, fetches, revoked } = preloadHarness();
  vm.runInContext(`_mode = 'radio'; _upNext = { title: 'First pick', ipfsCid: 'bafy-a' }; _maybePreload();`, context);
  await vm.runInContext('_preload.done', context);
  vm.runInContext(`_upNext = { title: 'Replacement', ipfsCid: 'bafy-b' }; _maybePreload();`, context);
  assert.deepEqual(revoked, ['blob:preload-1']);
  assert.equal(fetches.length, 2);
  assert.equal(fetches[0].signal.aborted, true);

  const big = preloadHarness({ contentLength: 200 * 1024 * 1024 });
  vm.runInContext(`_mode = 'radio'; _upNext = { title: 'Huge video', ipfsCid: 'bafy-huge' }; _maybePreload();`, big.context);
  await vm.runInContext('_preload.done', big.context);
  assert.equal(vm.runInContext('_preload.status', big.context), 'failed');
  assert.equal(await vm.runInContext(`_takePreload('bafy-huge')`, big.context), null, 'oversized media streams normally');
});

test('radio does not preload for blocked, ads-only, archive or data-saver listeners', () => {
  for (const setup of [`_blocked = true`, `_devertListenMode = 'ads-only'`, `_mode = 'archive'`, `navigator.connection.saveData = true`]) {
    const { context, fetches } = preloadHarness({ extra: { navigator: { connection: {} } } });
    vm.runInContext(`_mode = 'radio'; ${setup}; _upNext = { title: 'Next', ipfsCid: 'bafy-next' }; _maybePreload();`, context);
    assert.equal(fetches.length, 0, setup);
  }
});

test('radio keeps the live item preloaded while this browser is still finishing the previous song', async () => {
  const { context, fetches, revoked } = preloadHarness();
  vm.runInContext(`_mode = 'radio'; _loadedPlayId = 'play-a';
    _radio = { playId: 'play-a', ipfsCid: 'bafy-a' }; _upNext = { title: 'B', ipfsCid: 'bafy-b' }; _maybePreload();`, context);
  await vm.runInContext('_preload.done', context);
  vm.runInContext(`_radio = { playId: 'play-b', title: 'B', ipfsCid: 'bafy-b' }; _upNext = { title: 'C', ipfsCid: 'bafy-c' }; _maybePreload();`, context);
  assert.equal(vm.runInContext('_preload.cid', context), 'bafy-b', 'B stays ready until this browser starts it');
  assert.deepEqual(revoked, []);
  assert.equal(fetches.length, 1);

  const entry = await vm.runInContext(`_takePreload('bafy-b')`, context);
  assert.equal(entry.blobUrl, 'blob:preload-1');
  vm.runInContext(`_loadedPlayId = 'play-b'; _maybePreload();`, context);
  assert.equal(vm.runInContext('_preload.cid', context), 'bafy-c');
});

test('radio cancels an in-flight preload when the listener stops being eligible', () => {
  for (const change of [`_blocked = true`, `setDevertListenMode('ads-only')`, `navigator.connection.saveData = true; _maybePreload()`]) {
    const { context, fetches } = preloadHarness({ extra: { navigator: { connection: {} } } });
    vm.runInContext(`_mode = 'radio'; _upNext = { title: 'Next', ipfsCid: 'bafy-next' }; _maybePreload();
      _setLabel = () => {}; _fadeMainRadioOut = () => {}; _setTrack = () => {}; _setActivity = () => {}; _renderVoting = () => {};
      ${change}; _maybePreload();`, context);
    assert.equal(fetches[0].signal.aborted, true, change);
    assert.equal(vm.runInContext('_preload', context), null, change);
  }
});
