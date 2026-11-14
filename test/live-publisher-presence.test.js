const test = require('node:test');
const assert = require('node:assert/strict');

async function fixture() {
  const { createLivePublisherPresence } = await import('../js/live-publisher-presence.mjs');
  const data = new Map(), tabs = [];
  let time = 1000, identity = 0;
  const errors = [];
  function tab(serviceUrl = 'https://worker.example') {
    const listeners = new Map(), timers = new Set();
    const environment = {
      crypto: { randomUUID: () => `fixture-${++identity}` },
      CustomEvent: class { constructor(type, detail) { this.type = type; Object.assign(this, detail); } },
      addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
      dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); },
      setInterval(fn) { timers.add(fn); return fn; },
      clearInterval(fn) { timers.delete(fn); },
    };
    environment.localStorage = {
      get length() { return data.size; },
      key(index) { return [...data.keys()][index] ?? null; },
      getItem(key) { return data.get(key) ?? null; },
      setItem(key, value) {
        data.set(key, value);
        for (const other of tabs) if (other !== environment) other.dispatchEvent({ type: 'storage', key });
      },
      removeItem(key) {
        data.delete(key);
        for (const other of tabs) if (other !== environment) other.dispatchEvent({ type: 'storage', key });
      },
    };
    tabs.push(environment);
    const presence = createLivePublisherPresence({ serviceUrl, environment, now: () => time, onError: error => errors.push(error.message) });
    return { presence, environment, timers, listeners };
  }
  return { tab, data, errors, at(value) { time = value; } };
}

test('matching performer presence suppresses only the same booking and worker, without storing credentials', async () => {
  const f = await fixture(), publisher = f.tab(), radio = f.tab(), elsewhere = f.tab('https://other.example');
  assert.equal(radio.presence.isPublishing('show'), false);
  assert.equal(publisher.presence.start('show'), true);
  assert.equal(radio.presence.isPublishing('show'), true);
  assert.equal(radio.presence.isPublishing('next-show'), false);
  assert.equal(elsewhere.presence.isPublishing('show'), false);
  const entry = JSON.parse([...f.data.values()][0]);
  assert.deepEqual(Object.keys(entry).sort(), ['bookingId', 'expiresAt']);
  publisher.presence.stop();
  assert.equal(radio.presence.isPublishing('show'), false);
});

test('same-tab and other-tab listeners update immediately and unsubscribe cleanly', async () => {
  const f = await fixture(), publisher = f.tab(), radio = f.tab();
  const local = [], remote = [];
  const stopLocal = publisher.presence.watch(() => local.push(publisher.presence.isPublishing('show')));
  const stopRemote = radio.presence.watch(() => remote.push(radio.presence.isPublishing('show')));
  publisher.presence.start('show');
  publisher.presence.stop();
  assert.deepEqual(local, [true, false]);
  assert.deepEqual(remote, [true, false]);
  stopLocal(); stopRemote();
  publisher.presence.start('show');
  assert.deepEqual(remote, [true, false]);
  publisher.presence.stop();
});

test('one publisher cannot release another; stale crashed-tab notices expire and heartbeats extend a live notice', async () => {
  const f = await fixture(), first = f.tab(), second = f.tab(), radio = f.tab();
  first.presence.start('show'); second.presence.start('show');
  first.presence.stop();
  assert.equal(radio.presence.isPublishing('show'), true);
  f.at(85000);
  for (const tick of second.timers) tick();
  f.at(100000);
  assert.equal(radio.presence.isPublishing('show'), true);
  f.at(175000);
  assert.equal(radio.presence.isPublishing('show'), false);
  second.presence.stop();
  assert.equal(f.data.size, 0);
});

test('blocked storage, failed renewal and invalid notices are explicit rather than proof of protection', async () => {
  const f = await fixture(), publisher = f.tab(), radio = f.tab();
  publisher.environment.localStorage.setItem = () => { throw Error('Storage blocked'); };
  assert.equal(publisher.presence.start('show'), false);
  assert.match(f.errors[0], /Storage blocked/);
  assert.equal(publisher.timers.size, 0);
  const working = f.tab();
  working.presence.start('show');
  working.environment.localStorage.setItem = () => { throw Error('Renewal blocked'); };
  for (const tick of working.timers) tick();
  assert.equal(working.timers.size, 0);
  assert.match(f.errors.at(-1), /Renewal blocked/);
  f.data.set([...f.data.keys()][0], '{"bookingId":"show","expiresAt":null}');
  assert.throws(() => radio.presence.isPublishing('show'), /notice is invalid/);
  for (const id of ['', null, 'x'.repeat(201)]) assert.throws(() => working.presence.start(id), /booking is required/);
});
