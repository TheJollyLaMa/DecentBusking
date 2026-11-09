const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet } = require('../discord-bot/node_modules/ethers');
const { randomBytes } = require('node:crypto');
const owner = Wallet.createRandom(), guest = Wallet.createRandom(), stranger = Wallet.createRandom();
const origin = 'https://radio.example', otherOrigin = 'https://evil.example';

async function fixture(options = {}) {
  const { createRehearsalService } = await import('../discord-bot/rehearsal.js');
  const clock = options.clock || { now: Date.parse('2026-11-09T02:00:00Z') };
  const durable = options.durable || { value: { version: 1, rooms: [] } };
  const calls = [], monitors = [];
  const store = {
    async restore() { if (options.restoreFailure) throw Error('restore'); return structuredClone(durable.value); },
    async save(value) { if (options.saveFailure) throw Error('save'); durable.value = structuredClone(value); return 'ipfs://x'; },
  };
  const transport = {
    ready: true, async close(b) { calls.push(['close', b.id]); if (options.closeFailure) throw Error('close'); },
    async rehearsalConnect(b, wallet, publish) { calls.push(['connect', b.id, wallet, publish]); return { token: 'secret' }; },
    async monitor(b, cb) { calls.push(['monitor', b.id]); monitors.push(cb); },
  };
  const service = createRehearsalService({ ownerWallet: owner.address, store, transport, now: () => clock.now });
  async function sign(wallet, input, requestOrigin = origin) {
    const challenge = await service.challenge({ ...input, wallet: wallet.address }, requestOrigin);
    return service.authorize({ challengeId: challenge.challengeId, signature: await wallet.signMessage(challenge.message) }, requestOrigin);
  }
  async function create(minutes = 60) { return sign(owner, { action: 'create', guest: guest.address, minutes }); }
  return { service, clock, calls, monitors, durable, sign, create };
}

test('signed owner invitation and guest consent stay separate from booking, public radio and payment', async () => {
  const f = await fixture();
  await assert.rejects(f.sign(stranger, { action: 'create', guest: guest.address, minutes: 60 }), /Only the owner/);
  const a = await f.create(), id = a.state.id;
  assert.match(id, /^rehearsal:[0-9a-f]{64}$/);
  assert.equal(a.role, 'owner'); assert.equal(a.state.phase, 'private');
  await assert.rejects(f.sign(stranger, { action: 'join', id }), /unavailable/);
  const challenge = await f.service.challenge({ action: 'join', id, wallet: guest.address }, origin);
  assert.match(challenge.message, /consent to private live audio/);
  assert.match(challenge.message, /No public radio, recording, booking, payment/);
  const sig = await guest.signMessage(challenge.message);
  await assert.rejects(f.service.authorize({ challengeId: challenge.challengeId, signature: sig }, otherOrigin), /expired/);
  const g = await f.service.authorize({ challengeId: challenge.challengeId, signature: sig }, origin);
  await assert.rejects(f.service.authorize({ challengeId: challenge.challengeId, signature: sig }, origin), /expired/);
  assert.equal(g.role, 'guest');
  await assert.rejects(f.service.command(g.token, { action: 'end', confirmed: true }, origin), /unauthorized/);
  await assert.rejects(f.service.command(g.token, { action: 'arm' }, origin), /unauthorized/);
  await assert.rejects(f.service.command(g.token, { action: 'check' }, origin), /unauthorized/);
  await assert.rejects(f.service.command(g.token, { action: 'connect' }, otherOrigin), /expired/);
  await f.service.command(g.token, { action: 'connect', publish: true }, origin);
  await f.service.command(a.token, { action: 'connect', publish: true }, origin);
  assert.deepEqual(f.calls.filter(c => c[0] === 'connect').map(c => c[3]), [true, true]);
  assert.equal((await f.service.command(a.token, { action: 'state' }, origin)).privateAudioFresh, false);
  f.monitors[0]({ samples: 1 });
  assert.equal((await f.service.command(a.token, { action: 'state' }, origin)).privateAudioFresh, true);
  await f.service.command(a.token, { action: 'end', confirmed: true }, origin);
  assert.ok(f.calls.some(c => c[0] === 'close'));
  await assert.rejects(f.service.command(g.token, { action: 'state' }, origin), /expired/);
  assert.equal(f.durable.value.rooms[0].endedAt, f.clock.now);
  f.clock.now += 36_000; await f.service.tick();
  assert.deepEqual(f.durable.value.rooms, []);
});

test('origin, replay, identity, deadline, inactivity and restart fail closed', async () => {
  const f = await fixture();
  const c = await f.service.challenge({ action: 'create', wallet: owner.address, guest: guest.address, minutes: 1 }, origin);
  await assert.rejects(f.service.authorize({ challengeId: c.challengeId, signature: await stranger.signMessage(c.message) }, origin), /does not match/);
  await assert.rejects(f.service.authorize({ challengeId: c.challengeId, signature: await owner.signMessage(c.message) }, origin), /expired/);
  const a = await f.create(1);
  await f.service.command(a.token, { action: 'connect', publish: false }, origin);
  f.clock.now += 31_000; await f.service.tick();
  assert.ok(f.calls.some(c => c[0] === 'close'));
  await assert.rejects(f.service.command(a.token, { action: 'state' }, origin), /expired/);
  f.clock.now += 36_000; await f.service.tick();
  const b = await f.create(1);
  const restart = await fixture({ durable: f.durable, clock: f.clock });
  await restart.service.tick();
  assert.ok(restart.calls.some(c => c[0] === 'close'));
  await assert.rejects(restart.sign(guest, { action: 'join', id: b.state.id }), /unavailable/);
  f.clock.now += 70_000; await restart.service.tick();
  assert.deepEqual(f.durable.value.rooms, []);
  const c2 = await restart.create(1);
  restart.clock.now += 60_001;
  await assert.rejects(restart.sign(guest, { action: 'join', id: c2.state.id }), /unavailable/);
  assert.ok(restart.calls.some(c => c[0] === 'close' && c[1] === c2.state.id));
});

test('storage restore or save failure closes access; failed close retains durable cleanup tombstone', async () => {
  const badRestore = await fixture({ restoreFailure: true });
  await assert.rejects(badRestore.create(), /restore failed/);
  assert.equal(badRestore.service.configured, false);
  const badSave = await fixture({ saveFailure: true });
  await assert.rejects(badSave.create(), /checkpoint failed/);
  assert.equal(badSave.service.configured, false);
  const f = await fixture({ closeFailure: true }), a = await f.create();
  await f.service.command(a.token, { action: 'end', confirmed: true }, origin);
  f.clock.now += 36_000; await f.service.tick();
  assert.equal(f.durable.value.rooms.length, 1);
  assert.ok(f.durable.value.rooms[0].endedAt);
  const options = {}, retry = await fixture(options), active = await retry.create();
  await retry.service.command(active.token, { action: 'connect', publish: true }, origin);
  options.saveFailure = true;
  await assert.rejects(retry.service.command(active.token, { action: 'end', confirmed: true }, origin), /checkpoint failed/);
  const before = retry.calls.filter(c => c[0] === 'close').length;
  await retry.service.tick();
  assert.ok(retry.calls.filter(c => c[0] === 'close').length > before, 'failed service continues provider cleanup');
});

test('encrypted hosted checkpoints restore latest and reject bad key, latest corruption and upload failure', async () => {
  const { createRehearsalStore } = await import('../discord-bot/rehearsal-store.js');
  const files = [], key = randomBytes(32).toString('hex'); let serial = 0, gatewayFails = false, uploadFails = false;
  async function fetchImpl(url, init = {}) {
    const target = new URL(url);
    if (init.method === 'POST') {
      if (uploadFails) return new Response('fail', { status: 500 });
      const bytes = Buffer.from(await init.body.get('file').arrayBuffer());
      const cid = `cid${++serial}`;
      files.unshift({ id: `id${serial}`, cid, name: init.body.get('name'),
        keyvalues: JSON.parse(init.body.get('keyvalues')), created_at: new Date(Date.UTC(2026, 10, 9, 0, 0, serial)).toISOString(), bytes });
      return Response.json({ data: { cid } });
    }
    if (init.method === 'DELETE') return Response.json({});
    if (target.pathname === '/v3/gateways') return Response.json({ data: { rows: [] } });
    if (target.pathname.endsWith('/public')) return Response.json({ data: { files: files.map(({ bytes, ...file }) => file) } });
    const found = files.find(f => target.pathname.endsWith(`/ipfs/${f.cid}`));
    return gatewayFails || !found ? new Response('fail', { status: 503 }) : new Response(found.bytes);
  }
  const make = k => createRehearsalStore({ storageKey: k, pinataJwt: 'fixture', fetchImpl,
    gateway: 'https://gateway.example', gatewayAccessToken: '', log: { warn() {} } });
  const store = make(key);
  assert.deepEqual(await store.restore(), { version: 1, rooms: [] });
  const value = { version: 1, rooms: [{ id: `rehearsal:${'a'.repeat(64)}`, guest: guest.address.toLowerCase(), expiresAt: 123456, endedAt: 0 }] };
  await store.save(value);
  assert.equal(files[0].bytes.toString().includes(value.rooms[0].guest), false);
  assert.deepEqual(await make(key).restore(), value);
  await assert.rejects(make(randomBytes(32).toString('hex')).restore(), /restore failed/);
  gatewayFails = true; await assert.rejects(make(key).restore(), /restore failed/); gatewayFails = false;
  uploadFails = true;
  await assert.rejects(store.save({ version: 1, rooms: [] })); uploadFails = false;
  gatewayFails = true;
  await assert.rejects(store.save({ version: 1, rooms: [] }), /restore failed/);
  gatewayFails = false;
  files[1].created_at = files[0].created_at;
  await assert.rejects(make(key).restore(), /Ambiguous latest/);
  files[1].created_at = new Date(Date.UTC(2026, 10, 9, 0, 0, 1)).toISOString();
  files[0].bytes = Buffer.from('{}');
  await assert.rejects(make(key).restore(), /restore failed/);
  store.close();
});

test('transport grants both signed rehearsal roles microphone and subscribe only in their distinct room', async () => {
  const { createLiveAudioTransport, liveAudioRoomName, rehearsalRoomName } = await import('../discord-bot/live-audio-transport.js');
  const created = [];
  const transport = createLiveAudioTransport({ enabled: true, url: 'wss://fixture.livekit.cloud', apiKey: 'key',
    apiSecret: 'secret', roomClient: { async createRoom(room) { created.push(room); } } });
  const b = { id: `rehearsal:${'a'.repeat(64)}`, wallet: guest.address, owner: owner.address, rehearsal: true,
    endUtc: new Date(Date.now() + 60_000).toISOString() };
  for (const wallet of [owner.address, guest.address]) {
    const grant = await transport.rehearsalConnect(b, wallet, true);
    const payload = JSON.parse(Buffer.from(grant.token.split('.')[1], 'base64url'));
    assert.equal(payload.video.room, rehearsalRoomName(b.id));
    assert.notEqual(payload.video.room, liveAudioRoomName(b.id));
    assert.equal(payload.video.canPublish, true);
    assert.equal(payload.video.canSubscribe, true);
    assert.equal(payload.video.canPublishData, false);
    assert.deepEqual(payload.video.canPublishSources, ['microphone']);
    assert.ok(payload.exp - payload.nbf <= 30);
  }
  assert.ok(created.every(r => r.name === rehearsalRoomName(b.id)));
  assert.ok(created.every(r => r.maxParticipants === 3));
});

test('HTTP denies other origins and redacts errors without exposing public listen routes', async () => {
  const { handleRehearsalRequest } = await import('../discord-bot/rehearsal-http.js');
  const invoke = async (path, reqOrigin, service) => {
    const request = { url: `/api/private-rehearsal/${path}`, method: 'POST', headers: { origin: reqOrigin },
      async *[Symbol.asyncIterator]() { yield '{}'; } };
    const response = { writeHead(code, headers) { this.code = code; this.headers = headers; },
      end(body) { this.body = JSON.parse(body); } };
    await handleRehearsalRequest(request, response, { service, allowedOrigins: [origin] });
    return response;
  };
  const service = { configured: true, async challenge() { throw Error('provider secret'); } };
  assert.equal((await invoke('challenge', otherOrigin, service)).code, 403);
  const error = await invoke('challenge', origin, service);
  assert.equal(error.code, 400); assert.doesNotMatch(JSON.stringify(error.body), /provider secret/);
  assert.equal(error.headers['cache-control'], 'no-store');
  assert.equal((await invoke('listen', origin, service)).code, 404);
});

test('browser mock signs owner invitation and publishes privately without a public-radio call', async t => {
  const f = await fixture(), saved = new Map(), elements = new Map(), events = {}, calls = [];
  const keys = ['window', 'document', 'location', 'fetch', 'LivekitClient', 'setInterval'];
  for (const key of keys) saved.set(key, global[key]);
  t.after(() => { for (const [key, value] of saved) {
    if (value === undefined) delete global[key]; else global[key] = value;
  } });
  for (const id of ['status', 'create', 'guest', 'minutes', 'create-room', 'join', 'join-room', 'controls',
    'invitation', 'deadline', 'end', 'input', 'devices', 'publish', 'listen', 'leave', 'audio']) {
    elements.set(id, { hidden: false, disabled: false, textContent: '', value: '',
      pause() {}, play: async () => {}, replaceChildren() {} });
  }
  elements.get('guest').value = guest.address; elements.get('minutes').value = '60';
  global.document = { getElementById: id => elements.get(id) };
  global.location = { href: 'https://radio.example/rehearsal.html' };
  global.window = { DecentConfig: { ipfsUploadServiceUrl: 'https://worker.example' },
    ethereum: { async request({ method, params }) {
      if (method === 'eth_requestAccounts') return [owner.address];
      return owner.signMessage(Buffer.from(params[0].slice(2), 'hex'));
    }, on() {} }, addEventListener(name, cb) { events[name] = cb; }, confirm: () => true };
  global.setInterval = () => 1;
  class Room {
    constructor() { this.remoteParticipants = new Map(); this.localParticipant = { async publishTrack() {} }; }
    on() {} async connect() {} async disconnect() {} async startAudio() {}
  }
  global.LivekitClient = { Room, RoomEvent: { TrackPublished: 'published', TrackSubscribed: 'subscribed',
    TrackUnsubscribed: 'unsubscribed', Disconnected: 'disconnected' },
  Track: { Kind: { Audio: 'audio' }, Source: { Microphone: 'microphone' } },
  async createLocalAudioTrack() { return { stop() {} }; } };
  global.fetch = async (url, opts = {}) => {
    calls.push(url);
    const path = new URL(url).pathname.split('/').pop();
    if (path === 'status') return { ok: true, json: async () => ({ configured: true }) };
    const input = JSON.parse(opts.body || '{}');
    let data;
    if (path === 'challenge') data = await f.service.challenge(input, origin);
    else if (path === 'session') data = await f.service.authorize(input, origin);
    else data = await f.service.command(opts.headers.authorization.slice(7), input, origin);
    return { ok: true, json: async () => data };
  };
  await import(`../js/rehearsal.mjs?test=${Date.now()}`);
  assert.equal(elements.get('create-room').disabled, false);
  await elements.get('create-room').onclick();
  assert.equal(elements.get('controls').hidden, false);
  assert.match(elements.get('invitation').textContent, /rehearsal=/);
  await elements.get('publish').onclick();
  assert.match(elements.get('status').textContent, /Publishing and listening privately/);
  assert.ok(f.calls.some(c => c[0] === 'connect' && c[3] === true));
  assert.ok(calls.every(url => url.includes('/api/private-rehearsal/')));
  events.pagehide();
});
