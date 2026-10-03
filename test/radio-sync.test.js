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