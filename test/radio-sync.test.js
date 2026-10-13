const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('radio stays silent until a delayed initial seek completes', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/radio-sync.js'), 'utf8')
    .replace(/export /g, '');
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
  const source = fs.readFileSync(path.join(__dirname, '../js/radio-sync.js'), 'utf8').replace(/export /g, '');
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
  const source = fs.readFileSync(path.join(__dirname, '../js/radio-sync.js'), 'utf8')
    .replace(/export /g, '').replace('const FADE_IN_MS = 1_500;', 'const FADE_IN_MS = 1;');
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
  const source = fs.readFileSync(path.join(__dirname, '../js/radio-sync.js'), 'utf8').replace(/export /g, '');
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

test('radio keeps the current song playing until it ends before starting the next track from the top', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/radio-sync.js'), 'utf8')
    .replace(/export /g, '');
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
  assert.equal(vm.runInContext('started[0].offset()', context), 0);
});

test('radio sync does not force-seek an actively playing track on poll', () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/radio-sync.js'), 'utf8')
    .replace(/export /g, '');
  const audio = {
    paused: false,
    currentTime: 3,
  };
  const context = vm.createContext({ performance, setTimeout, clearTimeout, console, audio });
  vm.runInContext(`${source}\n_audio = audio; _loadedPlayId = 'play-1'; _radio = { playId: 'play-1', positionMs: 18_000, receivedAt: performance.now() }; var seekCalls = 0; _seekTo = () => { seekCalls += 1; return true; }; _syncRadio();`, context);
  assert.equal(vm.runInContext('seekCalls', context), 0);
  assert.equal(audio.currentTime, 3);
});

test('radio sync waits for playback to start before broadcasting now-playing details', () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/radio-sync.js'), 'utf8')
    .replace(/export /g, '');
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
  }; _switchTo = () => {}; _syncRadio();`, context);
  assert.equal(events.length, 0);
});

test('switchTo broadcasts now-playing after the site audio begins and stops on pause', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/radio-sync.js'), 'utf8')
    .replace(/export /g, '');
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
  audio.pause();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(stopped.length > 0, true);
});

test('switchTo reveals now-playing before tune-in when autoplay is blocked', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/radio-sync.js'), 'utf8')
    .replace(/export /g, '');
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
  const source = fs.readFileSync(path.join(__dirname, '../js/radio-sync.js'), 'utf8').replace(/export /g, '');
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

test('DeVert main-radio ads allow live-program votes while non-radio previews remain disabled', () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/radio-sync.js'), 'utf8').replace(/export /g, '');
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
  const source = fs.readFileSync(path.join(__dirname, '../js/radio-sync.js'), 'utf8').replace(/export /g, '');
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

test('radio volume survives fades and mute does not affect archive playback', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/radio-sync.js'), 'utf8').replace(/export /g, '');
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
  const source = fs.readFileSync(path.join(__dirname, '../js/radio-sync.js'), 'utf8').replace(/export /g, '');
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
  const source = fs.readFileSync(path.join(__dirname, '../js/radio-sync.js'), 'utf8').replace(/export /g, '');
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
  const source = fs.readFileSync(path.join(__dirname, '../js/radio-sync.js'), 'utf8').replace(/export /g, '');
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