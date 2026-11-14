const test = require('node:test');
const assert = require('node:assert/strict');

async function fixture() {
  const { createPrivateRoomListener } = await import('../js/private-room-listener.mjs');
  const calls = [], rooms = [], reports = [];
  let load, waitDisconnect;
  const audio = { paused: true, srcObject: null, pause() { this.paused = true; }, async play() { this.paused = false; } };
  class Room {
    handlers = {};
    remoteParticipants = new Map();
    constructor() { rooms.push(this); }
    on(name, handler) { this.handlers[name] = handler; }
    async connect(_url, _token, options) { assert.equal(options.autoSubscribe, false); calls.push('connect'); }
    async startAudio() {}
    async disconnect() { calls.push('disconnect'); if (waitDisconnect) await waitDisconnect(); }
  }
  const sdk = { Room, RoomEvent: { TrackPublished: 'published', TrackSubscribed: 'subscribed',
    TrackUnsubscribed: 'unsubscribed', Disconnected: 'disconnected' }, Track: { Kind: { Audio: 'audio' } } };
  const listener = createPrivateRoomListener({
    audio, serviceUrl: 'worker', now: () => 100, onStatus: value => reports.push(value),
    sdkLoader: async () => load ? load() : sdk,
    request: async (_service, _path, input, token) => {
      calls.push({ input, token });
      return { url: 'livekit', token: 'listen-grant', publisherIdentity: 'performer' };
    },
  });
  const session = id => ({ role: 'owner', token: `${id}-pass`, expiresAt: 1000, state: { bookingId: id } });
  return { listener, audio, calls, rooms, reports, session, sdk,
    delayLoader(fn) { load = fn; }, delayDisconnect(fn) { waitDisconnect = fn; } };
}
test('private listener receives only selected publisher and never requests a microphone grant', async () => {
  const f = await fixture();
  await f.listener.connect(f.session('a'), 'a');
  assert.deepEqual(f.calls[0], { input: { action: 'connect', publish: false }, token: 'a-pass' });
  const subscribed = [];
  f.rooms[0].handlers.published({ kind: 'audio', setSubscribed: value => subscribed.push(value) }, { identity: 'other' });
  assert.deepEqual(subscribed, []);
  f.rooms[0].handlers.published({ kind: 'audio', setSubscribed: value => subscribed.push(value) }, { identity: 'performer' });
  assert.deepEqual(subscribed, [true]);
});
test('room switching awaits old disconnect and ignores old track callbacks', async () => {
  const f = await fixture();
  await f.listener.connect(f.session('a'), 'a');
  let finish;
  f.delayDisconnect(() => new Promise(resolve => { finish = resolve; }));
  const switching = f.listener.connect(f.session('b'), 'b');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.rooms.length, 1);
  const track = { kind: 'audio', attach() { throw new Error('Old track attached'); }, detach() {} };
  f.rooms[0].handlers.subscribed(track, {}, { identity: 'performer' });
  finish();
  await switching;
  assert.equal(f.rooms.length, 2);
  assert.deepEqual(f.calls.filter(item => typeof item === 'string'), ['connect', 'disconnect', 'connect']);
});
test('stop during grant setup prevents any late room connection', async () => {
  const f = await fixture();
  let finish;
  f.delayLoader(() => new Promise(resolve => { finish = resolve; }));
  const opening = f.listener.connect(f.session('a'), 'a');
  await new Promise(resolve => setImmediate(resolve));
  await f.listener.disconnect();
  finish(f.sdk);
  assert.equal(await opening, false);
  assert.equal(f.rooms.length, 0);
});
test('wrong-booking, performer and expired passes cannot open desk listening', async () => {
  const f = await fixture();
  await assert.rejects(f.listener.connect(f.session('a'), 'b'), /selected booking/);
  await assert.rejects(f.listener.connect({ ...f.session('a'), role: 'performer' }, 'a'), /owner/);
  assert.equal(await f.listener.connect({ ...f.session('a'), expiresAt: 1 }, 'a'), false);
  assert.equal(f.calls.length, 0);
});
