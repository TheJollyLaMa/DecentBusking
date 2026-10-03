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

test('radio corrects a play-time position reset while still silent, before fading in', async () => {
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