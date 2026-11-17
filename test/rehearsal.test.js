const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet } = require('../discord-bot/node_modules/ethers');
const { randomBytes } = require('node:crypto');
const owner = Wallet.createRandom(), engineer = Wallet.createRandom(), guest = Wallet.createRandom(), stranger = Wallet.createRandom();
const origin = 'https://radio.example', otherOrigin = 'https://evil.example';

async function fixture(options = {}) {
  const { createRehearsalService } = await import('../discord-bot/rehearsal.js');
  const clock = options.clock || { now: Date.parse('2026-11-09T02:00:00Z') };
  const durable = options.durable || { value: { version: 1, rooms: [] } };
  const calls = [], monitors = [];
  const store = {
    async restore() { if (options.restoreFailure) throw Error('restore'); return structuredClone(durable.value); },
    async save(value) {
      if (options.saveFailure) throw Error('save');
      if (options.saveDelayMs) await new Promise(resolve => setTimeout(resolve, options.saveDelayMs));
      durable.value = structuredClone(value); return 'ipfs://x';
    },
  };
  const transport = {
    ready: true, async close(b) { calls.push(['close', b.id]); if (options.closeFailure) throw Error('close'); },
    async rehearsalConnect(b, wallet, publish) { calls.push(['connect', b.id, wallet, publish]); return { token: 'secret' }; },
    async rehearsalRemove(b, wallet) { calls.push(['remove', b.id, wallet]); if (options.removeFailure) throw Error('provider private URL'); },
    async monitor(b, cb) { calls.push(['monitor', b.id]); monitors.push(cb); },
  };
  const service = createRehearsalService({ ownerWallet: owner.address, engineerWallets: [engineer.address],
    store, transport, now: () => clock.now, getBookings: options.getBookings || (async () => ({ bookings:
      [guest, stranger].map(wallet => ({ wallet: wallet.address, acknowledged: true, cancelled: true, status: 'paid' })) })) });
  async function sign(wallet, input = { action: 'enter' }, requestOrigin = origin) {
    const challenge = await service.challenge({ ...input, wallet: wallet.address }, requestOrigin);
    return service.authorize({ challengeId: challenge.challengeId, signature: await wallet.signMessage(challenge.message) }, requestOrigin);
  }
  const enter = wallet => {
    const room = durable.value.rooms.find(r => !r.endedAt && r.expiresAt > clock.now);
    return sign(wallet, room ? { action: 'join', roomId: room.id } : { action: 'enter' });
  };
  const cmd = (who, input, requestOrigin = origin) => service.command(who.token, input, requestOrigin);
  return { service, clock, calls, monitors, durable, sign, enter, cmd };
}

test('checkpoint budget permits a verified save longer than ten seconds without reopening failed writes', async t => {
  const f = await fixture({ saveDelayMs: 11000 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = f.enter(owner);
  await new Promise(setImmediate);
  t.mock.timers.tick(10001);
  assert.equal(f.service.configured, true);
  t.mock.timers.tick(999);
  const authorized = await pending;
  assert.equal(authorized.role, 'engineer');
  assert.equal(f.durable.value.rooms.length, 1);
});

test('host eligibility includes past accepted invitations, never token holdings or an unaccepted booking', async () => {
  const f = await fixture({ getBookings: async () => ({ bookings: [
    { wallet: guest.address, acknowledged: true, cancelled: true, status: 'paid' },
    { wallet: stranger.address, acknowledged: false, status: 'draft' },
  ] }) });
  assert.equal((await f.service.eligibility(guest.address)).canHost, true);
  assert.equal((await f.service.eligibility(owner.address)).canHost, true);
  assert.equal((await f.service.eligibility(stranger.address)).canHost, false);
  await assert.rejects(f.sign(stranger, { action: 'create' }), /Only administrators and performers/);
  await assert.rejects(f.sign(stranger, { action: 'join' }), /complete rehearsal invitation/);
  const host = await f.sign(guest, { action: 'create' });
  const invited = await f.sign(stranger, { action: 'join', roomId: host.state.id });
  assert.equal(invited.role, 'musician', 'link guests need no accepted booking');
  await f.cmd(host, { action: 'end', confirmed: true });
  await assert.rejects(f.sign(stranger, { action: 'join', roomId: host.state.id }), /invitation expired/);
  const broken = await fixture({ getBookings: async () => { throw Error('provider secret'); } });
  await assert.rejects(broken.service.eligibility(guest.address), /history could not be verified/);
});

test('separate rehearsals isolate invites, people, microphone grants, removals and closure', async () => {
  const f = await fixture();
  const a = await f.sign(guest, { action: 'create' }), b = await f.sign(stranger, { action: 'create' });
  assert.notEqual(a.state.id, b.state.id);
  const bandmate = Wallet.createRandom();
  const joined = await f.sign(bandmate, { action: 'join', roomId: a.state.id });
  assert.equal((await f.cmd(a, { action: 'state' })).people.length, 2);
  assert.equal((await f.cmd(b, { action: 'state' })).people.length, 1);
  await f.cmd(joined, { action: 'connect', publish: true, roomId: b.state.id });
  assert.equal(f.calls.find(call => call[0] === 'connect')[1], a.state.id, 'a command cannot redirect its room-scoped pass');
  await assert.rejects(f.sign(bandmate, { action: 'join', roomId: `rehearsal:${'a'.repeat(64)}` }), /invitation expired/);
  await f.cmd(a, { action: 'remove', wallet: bandmate.address });
  await assert.rejects(f.cmd(joined, { action: 'state' }), /sign in again/);
  const inOtherRoom = await f.sign(bandmate, { action: 'join', roomId: b.state.id });
  assert.equal(inOtherRoom.state.id, b.state.id, 'removal is limited to one rehearsal');
  await f.cmd(a, { action: 'end', confirmed: true });
  assert.equal((await f.cmd(b, { action: 'state' })).phase, 'private');
  assert.ok(f.calls.filter(call => call[0] === 'close').every(call => call[1] !== b.state.id));
  const failing = await fixture({ removeFailure: true });
  const host = await failing.enter(owner), member = await failing.enter(guest);
  await assert.rejects(failing.cmd(host, { action: 'remove', wallet: guest.address }), /active audio removal was not confirmed/);
  await assert.rejects(failing.cmd(member, { action: 'state' }), /sign in again/);
});

test('accepted performers host a private rehearsal, invite guests and rejoin its explicit link', async () => {
  const f = await fixture();
  const challenge = await f.service.challenge({ action: 'enter', wallet: guest.address }, origin);
  assert.match(challenge.message, /PRIVATE REHEARSAL ROOM/);
  assert.match(challenge.message, /consent to private live audio with the people invited to this rehearsal/);
  assert.match(challenge.message, /No public radio, recording, booking, payment/);
  const g = await f.service.authorize({ challengeId: challenge.challengeId, signature: await guest.signMessage(challenge.message) }, origin);
  const s = await f.enter(stranger), e = await f.enter(engineer);
  assert.equal(new Set([g.state.id, s.state.id, e.state.id]).size, 1);
  assert.deepEqual([g.role, s.role, e.role], ['host', 'musician', 'engineer']);
  assert.equal(f.durable.value.rooms.length, 1);
  assert.equal(f.durable.value.rooms[0].host, guest.address.toLowerCase());
  const people = (await f.cmd(g, { action: 'state' })).people;
  assert.equal(people.length, 3);
  assert.deepEqual(people.filter(p => p.you).map(p => p.wallet), [guest.address.toLowerCase()]);
  assert.equal(people.find(p => p.wallet === engineer.address.toLowerCase()).role, 'engineer');
  const again = await f.enter(guest);
  assert.equal(again.state.id, g.state.id, 'a lost page signs in again and lands in the running session');
  assert.equal((await f.cmd(again, { action: 'state' })).people.length, 3, 'one person, not a duplicate');
  for (const action of ['end', 'remove', 'arm']) {
    await assert.rejects(f.cmd(s, { action, confirmed: true, wallet: guest.address }), /unauthorized/);
  }
  await f.cmd(g, { action: 'connect', publish: true });
  await f.cmd(s, { action: 'connect', publish: true });
  assert.deepEqual(f.calls.filter(c => c[0] === 'connect').map(c => [c[2], c[3]]),
    [[guest.address.toLowerCase(), true], [stranger.address.toLowerCase(), true]]);
  assert.equal((await f.cmd(g, { action: 'state' })).privateAudioFresh, false);
  f.monitors[0]({ samples: 1, sources: [`rehearsal:${guest.address.toLowerCase()}`] });
  const mine = await f.cmd(g, { action: 'state' }), theirs = await f.cmd(s, { action: 'state' });
  assert.equal(mine.privateAudioFresh, true);
  assert.equal(theirs.privateAudioFresh, false, 'delivery is checked per person');
  assert.equal(theirs.anyAudioFresh, true);
});

test('passes stay alive while in use, Stop audio keeps the pass, and the session closes when everyone leaves', async () => {
  const f = await fixture();
  const g = await f.enter(guest);
  await f.cmd(g, { action: 'connect', publish: true });
  await f.cmd(g, { action: 'leave' });
  assert.equal((await f.cmd(g, { action: 'state' })).phase, 'private', 'stopping audio does not sign you out');
  for (let i = 0; i < 6; i++) { f.clock.now += 4 * 60_000; await f.cmd(g, { action: 'state' }); }
  f.clock.now += 5 * 60_000 + 1;
  await assert.rejects(f.cmd(g, { action: 'state' }), /sign in again/);
  assert.ok(f.calls.some(c => c[0] === 'close' && c[1] === g.state.id), 'an abandoned session closes');
  f.clock.now += 36_000; await f.service.tick();
  const a = await f.enter(guest), b = await f.enter(stranger);
  assert.notEqual(a.state.id, g.state.id);
  await f.cmd(a, { action: 'exit' });
  assert.equal((await f.cmd(b, { action: 'state' })).people.length, 1, 'others stay when one person leaves');
  await f.cmd(b, { action: 'exit' });
  assert.ok(f.calls.some(c => c[0] === 'close' && c[1] === a.state.id), 'the last person out closes the session');
  const next = await f.enter(guest);
  assert.notEqual(next.state.id, a.state.id, 'a new isolated rehearsal need not wait for another room tombstone');
  await f.cmd(next, { action: 'exit' });
  f.clock.now += 36_000; await f.service.tick();
  assert.deepEqual(f.durable.value.rooms, []);
});

test('engineers remove someone or close the session; the room holds six people', async () => {
  const f = await fixture();
  const e = await f.enter(engineer), g = await f.enter(guest), s = await f.enter(stranger);
  await assert.rejects(f.cmd(e, { action: 'remove', wallet: engineer.address }), /another non-engineer/);
  await assert.rejects(f.cmd(e, { action: 'remove', wallet: owner.address }), /another non-engineer/);
  const after = await f.cmd(e, { action: 'remove', wallet: guest.address });
  assert.equal(after.people.some(p => p.wallet === guest.address.toLowerCase()), false);
  assert.deepEqual(f.calls.find(c => c[0] === 'remove'), ['remove', e.state.id, guest.address.toLowerCase()]);
  await assert.rejects(f.cmd(g, { action: 'state' }), /sign in again/);
  await assert.rejects(f.enter(guest), /removed this wallet/);
  assert.deepEqual(f.durable.value.rooms[0].removed, [guest.address.toLowerCase()]);
  const band = Array.from({ length: 4 }, () => Wallet.createRandom());
  for (const wallet of band) await f.enter(wallet);
  await assert.rejects(f.enter(Wallet.createRandom()), /full \(6 people\)/);
  assert.equal((await f.enter(stranger)).state.id, e.state.id, 'someone already inside can always rejoin');
  await f.cmd(e, { action: 'end', confirmed: true });
  await assert.rejects(f.cmd(s, { action: 'state' }), /sign in again/);
  f.clock.now += 36_000; await f.service.tick();
  const fresh = await f.enter(guest);
  assert.notEqual(fresh.state.id, e.state.id, 'a removal lasts only for that session');
});

test('origin, replay, identity, four-hour limit and restart fail closed', async () => {
  const f = await fixture();
  const c = await f.service.challenge({ action: 'enter', wallet: owner.address }, origin);
  await assert.rejects(f.service.authorize({ challengeId: c.challengeId, signature: await stranger.signMessage(c.message) }, origin), /does not match/);
  await assert.rejects(f.service.authorize({ challengeId: c.challengeId, signature: await owner.signMessage(c.message) }, origin), /expired/);
  const c2 = await f.service.challenge({ action: 'enter', wallet: guest.address }, origin);
  await assert.rejects(f.service.authorize({ challengeId: c2.challengeId, signature: await guest.signMessage(c2.message) }, otherOrigin), /expired/);
  await assert.rejects(f.service.challenge({ action: 'public', wallet: owner.address }, origin), /Unknown rehearsal action/);
  const a = await f.enter(owner);
  await assert.rejects(f.cmd(a, { action: 'connect' }, otherOrigin), /sign in again/);
  for (let i = 0; i < 59; i++) { f.clock.now += 4 * 60_000; await f.cmd(a, { action: 'state' }); }
  f.clock.now += 4 * 60_000;
  await assert.rejects(f.cmd(a, { action: 'state' }), /sign in again/);
  assert.ok(f.calls.some(x => x[0] === 'close' && x[1] === a.state.id), 'sessions close after four hours');
  f.clock.now += 36_000; await f.service.tick();
  const b = await f.enter(guest);
  const restart = await fixture({ durable: f.durable, clock: f.clock });
  await restart.service.tick();
  assert.ok(restart.calls.some(x => x[0] === 'close' && x[1] === b.state.id));
  await assert.rejects(restart.cmd(b, { action: 'state' }), /sign in again/);
  f.clock.now += 36_000; await restart.service.tick();
  assert.deepEqual(f.durable.value.rooms, []);
  assert.notEqual((await restart.enter(guest)).state.id, b.state.id);
});

test('storage restore or save failure closes access; failed close retains durable cleanup tombstone', async () => {
  const badRestore = await fixture({ restoreFailure: true });
  await assert.rejects(badRestore.enter(owner), /restore failed/);
  assert.equal(badRestore.service.configured, false);
  const badSave = await fixture({ saveFailure: true });
  await assert.rejects(badSave.enter(guest), /checkpoint failed/);
  assert.equal(badSave.service.configured, false);
  const f = await fixture({ closeFailure: true }), a = await f.enter(owner);
  await f.cmd(a, { action: 'end', confirmed: true });
  f.clock.now += 36_000; await f.service.tick();
  assert.equal(f.durable.value.rooms.length, 1);
  assert.ok(f.durable.value.rooms[0].endedAt);
  const options = {}, retry = await fixture(options), active = await retry.enter(owner);
  await retry.cmd(active, { action: 'connect', publish: true });
  options.saveFailure = true;
  await assert.rejects(retry.cmd(active, { action: 'end', confirmed: true }), /checkpoint failed/);
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
  const make = (k, options = {}) => createRehearsalStore({ storageKey: k, pinataJwt: 'fixture', fetchImpl,
    gateway: 'https://gateway.example', gatewayAccessToken: '', log: { warn() {} }, ...options });
  const store = make(key, { retentionDays: 7, groupId: 'live-group', archiveGroupId: 'archive-group' });
  assert.deepEqual(await store.restore(), { version: 1, rooms: [] });
  const value = { version: 1, rooms: [{ id: `rehearsal:${'a'.repeat(64)}`, guest: guest.address.toLowerCase(), expiresAt: 123456, endedAt: 0 }] };
  await store.save(value);
  assert.equal(files[0].bytes.toString().includes(value.rooms[0].guest), false);
  assert.equal(JSON.parse(files[0].bytes)._checkpoint, undefined, 'hosted lifecycle does not inherit daily archival writes');
  assert.deepEqual(await make(key).restore(), value, 'legacy owner-invited rooms still restore');
  const shared = { version: 1, rooms: [{ id: `rehearsal:${'b'.repeat(64)}`, removed: [stranger.address.toLowerCase()], expiresAt: 123456, endedAt: 0 }] };
  await store.save(shared);
  assert.deepEqual(await make(key).restore(), shared);
  const { validateRehearsalState } = await import('../discord-bot/rehearsal-store.js');
  assert.throws(() => validateRehearsalState({ version: 1, rooms: [{ ...shared.rooms[0], removed: ['nope'] }] }), /Invalid/);
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

test('transport gives every signed person a wallet identity in the private rehearsal room and can remove them', async () => {
  const { createLiveAudioTransport, liveAudioRoomName, rehearsalRoomName } = await import('../discord-bot/live-audio-transport.js');
  const created = [], removed = [];
  const transport = createLiveAudioTransport({ enabled: true, url: 'wss://fixture.livekit.cloud', apiKey: 'key',
    apiSecret: 'secret', roomClient: { async createRoom(room) { created.push(room); },
      async removeParticipant(room, identity) { removed.push([room, identity]); } } });
  const b = { id: `rehearsal:${'a'.repeat(64)}`, rehearsal: true, endUtc: new Date(Date.now() + 60_000).toISOString() };
  for (const wallet of [owner.address, guest.address, stranger.address]) {
    const grant = await transport.rehearsalConnect(b, wallet, true);
    assert.equal(grant.identity, `rehearsal:${wallet.toLowerCase()}`);
    assert.equal(grant.publisherIdentity, undefined);
    const payload = JSON.parse(Buffer.from(grant.token.split('.')[1], 'base64url'));
    assert.equal(payload.sub, grant.identity);
    assert.equal(payload.video.room, rehearsalRoomName(b.id));
    assert.notEqual(payload.video.room, liveAudioRoomName(b.id));
    assert.equal(payload.video.canPublish, true);
    assert.equal(payload.video.canSubscribe, true);
    assert.equal(payload.video.canPublishData, false);
    assert.deepEqual(payload.video.canPublishSources, ['microphone']);
    assert.ok(payload.exp - payload.nbf <= 30);
  }
  assert.ok(created.every(r => r.name === rehearsalRoomName(b.id)));
  assert.ok(created.every(r => r.maxParticipants === 8));
  await transport.rehearsalRemove(b, guest.address);
  assert.deepEqual(removed, [[rehearsalRoomName(b.id), `rehearsal:${guest.address.toLowerCase()}`]]);
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

test('browser mock opens an isolated room, gates the booth, plays invited bandmates and shows host tools', async t => {
  const f = await fixture({ clock: { now: Date.now() } }), saved = new Map(), elements = new Map(), events = {}, calls = [], intervals = [];
  const keys = ['window', 'document', 'location', 'history', 'fetch', 'LivekitClient', 'setInterval', 'Option'];
  for (const key of keys) saved.set(key, global[key]);
  t.after(async () => { events.pagehide?.(); await new Promise(setImmediate); for (const [key, value] of saved) {
    if (value === undefined) delete global[key]; else global[key] = value;
  } });
  for (const id of ['status', 'join', 'join-room', 'controls', 'invitation', 'deadline', 'end', 'input', 'devices',
    'publish', 'listen', 'leave', 'audio', 'remote-audio', 'people', 'engineer-tools', 'remove-who', 'remove',
    'delivery', 'mic-state', 'mic-level', 'meter-note', 'next-step', 'monitor-toggle', 'monitor-volume', 'monitor-mix', 'monitor-status',
    'booth-mode', 'booth-radio-off', 'booth-status', 'invite-link', 'copy-invite']) {
    elements.set(id, { hidden: false, disabled: false, textContent: '', value: '', dataset: {}, listeners: {}, children: [],
      setAttribute() {}, addEventListener(name, fn) { this.listeners[name] = fn; }, pause() {}, play: async () => {},
      replaceChildren(...items) { this.children = items; }, append(item) { this.children.push(item); } });
  }
  global.Option = class { constructor(text, value) { this.text = text; this.value = value; } };
  global.document = { getElementById: id => elements.get(id) };
  global.location = new URL('https://radio.example/rehearsal.html');
  global.history = { replaceState(_state, _title, url) {
    const target = new URL(url, global.location.href);
    assert.match(target.hash, /room=rehearsal/);
  } };
  let accountChanged;
  global.window = { DecentConfig: { ipfsUploadServiceUrl: 'https://worker.example' },
    ethereum: { async request({ method, params }) {
      if (method === 'eth_requestAccounts') {
        assert.match(elements.get('status').textContent, /Opening MetaMask/);
        accountChanged?.([owner.address]);
        return [owner.address];
      }
      return owner.signMessage(Buffer.from(params[0].slice(2), 'hex'));
    }, on(name, callback) { if (name === 'accountsChanged') accountChanged = callback; } },
    addEventListener(name, cb) { events[name] = cb; }, confirm: () => true };
  global.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return 1; };
  let liveRoom;
  class Room {
    constructor() { this.remoteParticipants = new Map(); this.localParticipant = { async publishTrack() {} }; this.handlers = {}; liveRoom = this; }
    on(name, fn) { this.handlers[name] = fn; } async connect() {} async disconnect() {} async startAudio() {}
  }
  global.LivekitClient = { Room, RoomEvent: { TrackPublished: 'published', TrackSubscribed: 'subscribed',
    TrackUnsubscribed: 'unsubscribed', Disconnected: 'disconnected' },
  Track: { Kind: { Audio: 'audio' }, Source: { Microphone: 'microphone' } },
  createAudioAnalyser(_track, options) {
    assert.equal(options.cloneTrack, true, 'meter owns a clone so headphone routing cannot silence its input');
    return { calculateVolume: () => .4, async cleanup() {} };
  },
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
    if (input.action === 'connect') data = { ...data, identity: `rehearsal:${owner.address.toLowerCase()}` };
    return { ok: true, json: async () => data };
  };
  await import(`../js/rehearsal.mjs?test=${Date.now()}`);
  assert.equal(elements.get('join-room').disabled, false);
  assert.equal(elements.get('join').hidden, false, 'anyone sees the sign-in without an invitation link');
  await elements.get('join-room').onclick();
  assert.equal(elements.get('controls').hidden, false);
  assert.equal(elements.get('join').hidden, true);
  assert.match(elements.get('status').textContent, /You're in/);
  assert.match(elements.get('invitation').textContent, /this rehearsal only/);
  assert.match(elements.get('invite-link').value, /rehearsal\.html#room=rehearsal/);
  assert.equal(elements.get('end').hidden, false);
  assert.equal(elements.get('engineer-tools').hidden, false);
  assert.match(elements.get('people').textContent, /You · engineer/);
  assert.equal(elements.get('publish').disabled, true, 'booth setup gates the microphone');
  assert.match(elements.get('next-step').textContent, /Set up your booth first/);
  await elements.get('publish').onclick();
  assert.match(elements.get('status').textContent, /Booth setup: choose how you will hear yourself/);
  assert.ok(!f.calls.some(c => c[0] === 'connect' && c[3] === true), 'an unready booth never publishes');
  elements.get('booth-mode').value = 'direct';
  elements.get('booth-mode').listeners.change();
  elements.get('booth-radio-off').checked = true;
  elements.get('booth-radio-off').listeners.change();
  assert.equal(elements.get('publish').disabled, false);
  await elements.get('publish').onclick();
  assert.match(elements.get('status').textContent, /Microphone on/);
  assert.match(elements.get('next-step').textContent, /Try a few notes/);
  intervals.find(entry => entry.ms === 100).fn();
  assert.equal(elements.get('mic-level').value, .4);
  const bandmate = await f.enter(guest);
  const track = (attached = []) => ({ kind: 'audio', attach() { const node = { play: async () => {}, remove() { node.removed = true; } }; attached.push(node); return node; }, detach() {} });
  const subscribed = [];
  liveRoom.handlers.subscribed(track(subscribed), {}, { identity: `rehearsal:${owner.address.toLowerCase()}` });
  assert.equal(subscribed.length, 0, 'you never hear your own remote echo');
  const theirs = track(subscribed);
  liveRoom.handlers.subscribed(theirs, {}, { identity: `rehearsal:${guest.address.toLowerCase()}` });
  assert.equal(elements.get('remote-audio').children.length, 1, 'a bandmate plays on their own element');
  f.monitors[0]({ samples: 1, sources: [`rehearsal:${owner.address.toLowerCase()}`] });
  intervals.find(entry => entry.ms === 2000).fn();
  await new Promise(setImmediate);
  assert.match(elements.get('delivery').textContent, /Your audio is reaching the room/);
  assert.match(elements.get('people').textContent, /You · engineer · 🎙 sending/);
  assert.equal(elements.get('remove-who').children.at(-1).value, guest.address.toLowerCase());
  elements.get('remove-who').value = guest.address.toLowerCase();
  await elements.get('remove').onclick();
  assert.match(elements.get('status').textContent, /Removed from this session/);
  await assert.rejects(f.cmd(bandmate, { action: 'state' }), /sign in again/);
  liveRoom.handlers.unsubscribed(theirs, {}, { identity: `rehearsal:${guest.address.toLowerCase()}` });
  assert.equal(subscribed[0].removed, true);
  assert.ok(calls.every(url => url.includes('/api/private-rehearsal/')));
  await elements.get('leave').onclick();
  assert.match(elements.get('status').textContent, /To try again/);
  intervals.find(entry => entry.ms === 2000).fn();
  await new Promise(setImmediate);
  assert.equal(elements.get('controls').hidden, false, 'Stop audio keeps you signed in');
  global.window.ethereum.request = async () => { const error = Error('request pending'); error.code = -32002; throw error; };
  await elements.get('join-room').onclick();
  assert.match(elements.get('status').textContent, /MetaMask already has a pending request/);
  assert.equal(elements.get('status').dataset.error, 'true');
  events.pagehide();
});
