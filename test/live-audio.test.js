const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet } = require('../discord-bot/node_modules/ethers');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const fs = require('node:fs/promises');
const path = require('node:path');

const START = Date.parse('2026-11-14T02:00:00Z');
const ORIGIN = 'https://radio.example';
const owner = Wallet.createRandom(), artist = Wallet.createRandom(), stranger = Wallet.createRandom();
const booking = () => ({ id: 'existing-funded-booking', wallet: artist.address, eventId: 'dated-live-event',
  title: 'Private fixture', startUtc: new Date(START).toISOString(), endUtc: new Date(START + 20 * 60_000).toISOString(),
  status: 'funded', acknowledged: true, payoutPolicy: 'pilot-guaranteed-v1', amountUnits: '20000000' });

async function setup(options = {}) {
  const { createLiveAudioService } = await import('../discord-bot/live-audio.js');
  let time = START - 60 * 60_000, persisted = { version: 1, rooms: [] }, receiver;
  const b = booking(), policies = [], cancellations = [], closed = [];
  const transport = {
    ready: true, ingressEnabled: true,
    monitor: async (_b, callback) => { receiver = callback; },
    connect: async (_b, role) => ({ role, token: 'private-grant' }),
    obs: async () => ({ url: 'https://whip.example', streamKey: 'fixture-secret' }),
    listener: async () => ({ token: 'read-only-fixture' }),
    close: async b => { closed.push(b.id); },
    stop: async () => {},
  };
  const store = { restore: async () => structuredClone(persisted), save: async value => { persisted = structuredClone(value); } };
  const base = { getBookings: async () => ({ bookings: [b] }), ownerWallet: owner.address, transport, store,
    now: () => time, onPolicy: value => policies.push(value), onCancel: (b, reason) => cancellations.push({ b, reason }) };
  const service = createLiveAudioService({ ...base, ...options });
  async function authorize(wallet = owner, origin = ORIGIN) {
    const challenge = await service.challenge({ bookingId: b.id, wallet: wallet.address }, origin);
    const result = await service.authorize({ challengeId: challenge.challengeId,
      signature: await wallet.signMessage(challenge.message) }, origin);
    return result;
  }
  async function prepare() {
    const auth = await authorize();
    receiver({ samples: 960 });
    await service.command(auth.token, { action: 'check', check: 't60', confirmed: true }, ORIGIN);
    time = START - 15 * 60_000; receiver({ samples: 960 });
    await service.command(auth.token, { action: 'check', check: 't15', confirmed: true }, ORIGIN);
    await service.command(auth.token, { action: 'arm' }, ORIGIN);
    return auth;
  }
  return { service, authorize, prepare, transport, store, base, b, policies, cancellations, closed,
    at: value => { time = value; }, frame: samples => receiver({ samples }),
    persisted: () => structuredClone(persisted) };
}

test('live audio is fail-closed without explicit hosting and durable state', async () => {
  const { createLiveAudioService } = await import('../discord-bot/live-audio.js');
  const service = createLiveAudioService({ ownerWallet: owner.address, transport: { ready: false } });
  assert.equal(service.configured, false);
  assert.equal((await service.state('anything')).status, 'OFF-AIR');
  await assert.rejects(service.listener('anything'), /unavailable/);
});

test('healthy packet updates do not upload checkpoints; outage and recovery each persist once', async () => {
  const f = await setup();
  await f.prepare();
  const save = f.store.save;
  let writes = 0;
  f.store.save = async value => { writes++; await save(value); };
  for (let elapsed = 0; elapsed <= 30_000; elapsed += 1000) {
    f.at(START + elapsed); f.frame(960); await f.service.tick();
  }
  assert.equal(writes, 0);
  assert.equal((await f.service.state(f.b.id)).status, 'ON-AIR');
  f.at(START + 36_000); await f.service.tick();
  assert.equal(writes, 1);
  f.at(START + 37_000); f.frame(960); await f.service.tick();
  assert.equal(writes, 2);
  f.at(START + 43_000); f.frame(960); await f.service.tick();
  assert.equal(writes, 2);
});

test('a stalled lifecycle checkpoint is bounded and closes existing media, never claiming recovery', async () => {
  const f = await setup({ checkpointTimeoutMs: 20 });
  const auth = await f.prepare();
  f.store.save = () => new Promise(() => {});
  await assert.rejects(f.service.command(auth.token, { action: 'cancel', confirmed: true }, ORIGIN), /checkpoint failed/);
  assert.equal(f.service.configured, false);
  assert.equal((await f.service.state(f.b.id)).status, 'OFF-AIR');
  assert.deepEqual(f.closed, [f.b.id]);
});

test('booking wallet signatures are origin-bound, fresh, one-use and reject unrelated wallets', async () => {
  const f = await setup();
  await assert.rejects(f.authorize(stranger), /Only this booking/);
  const c = await f.service.challenge({ bookingId: f.b.id, wallet: artist.address }, ORIGIN);
  const signed = { challengeId: c.challengeId, signature: await artist.signMessage(c.message) };
  await assert.rejects(f.service.authorize(signed, 'https://evil.example'), /expired/);
  await assert.rejects(f.service.authorize({ ...signed, signature: await stranger.signMessage(c.message) }, ORIGIN), /does not match/);
  const auth = await f.service.authorize(signed, ORIGIN);
  assert.equal(auth.role, 'publisher');
  await assert.rejects(f.service.authorize(signed, ORIGIN), /already used/);
  await assert.rejects(f.service.command(auth.token, { action: 'arm' }, ORIGIN), /Only the configured owner/);
  await assert.rejects(f.service.command(auth.token, { action: 'connect' }, 'https://evil.example'), /expired/);
  const late = await f.service.challenge({ bookingId: f.b.id, wallet: artist.address }, ORIGIN);
  f.at(START - 57 * 60_000);
  await assert.rejects(f.service.authorize({ challengeId: late.challengeId, signature: await artist.signMessage(late.message) }, ORIGIN), /expired/);
});

test('funding, acknowledgement and pilot policy are checked rather than inferred from a wallet', async () => {
  for (const [field, value] of [['status', 'draft'], ['acknowledged', false], ['cancelled', true], ['payoutPolicy', 'legacy']]) {
    const f = await setup(); f.b[field] = value;
    await assert.rejects(f.authorize(), /funded|uncancelled|acknowledged/);
  }
});

test('owner control does not grant publishing; only the booking wallet can request browser or OBS input', async () => {
  const f = await setup(), operator = await f.authorize();
  await assert.rejects(f.service.command(operator.token, { action: 'connect', publish: true }, ORIGIN), /Only the booked performer/);
  await assert.rejects(f.service.command(operator.token, { action: 'obs' }, ORIGIN), /Only the booked performer/);
  assert.equal((await f.service.command(operator.token, { action: 'connect' }, ORIGIN)).role, 'owner');
  const performer = await f.authorize(artist);
  assert.equal((await f.service.command(performer.token, { action: 'connect', publish: true }, ORIGIN)).role, 'publisher');
});

test('private T−60/T−15 checks need fresh receiver audio, correct windows and owner confirmation', async () => {
  const f = await setup(), auth = await f.authorize();
  await assert.rejects(f.service.listener(f.b.id), /soundchecks are private/);
  await assert.rejects(f.service.command(auth.token, { action: 'arm' }, ORIGIN), /Both private/);
  await assert.rejects(f.service.command(auth.token, { action: 'check', check: 't60', confirmed: true }, ORIGIN), /No fresh audio/);
  f.frame(0);
  await assert.rejects(f.service.command(auth.token, { action: 'check', check: 't60', confirmed: true }, ORIGIN), /No fresh audio/);
  f.frame(960);
  await f.service.command(auth.token, { action: 'check', check: 't60', confirmed: true }, ORIGIN);
  await assert.rejects(f.service.command(auth.token, { action: 'check', check: 't15', confirmed: true }, ORIGIN), /matching/);
  const publicView = await f.service.state(f.b.id);
  assert.equal(publicView.checks, undefined);
  assert.equal(publicView.privateAudioFresh, undefined);
  assert.equal(publicView.verifiedAudioAt, null);
});

test('delivered silence is healthy, a short outage reconnects, and sixty seconds cancels exactly once', async () => {
  const f = await setup(); await f.prepare();
  f.at(START); f.frame(960); await f.service.tick();
  assert.equal((await f.service.state(f.b.id)).status, 'ON-AIR');
  await f.service.listener(f.b.id);
  f.at(START + 6000);
  assert.equal((await f.service.state(f.b.id)).status, 'RECONNECTING');
  f.at(START + 59_999); await f.service.tick();
  assert.equal(f.cancellations.length, 0);
  f.frame(960); await f.service.tick();
  f.at(START + 119_998); await f.service.tick();
  assert.equal(f.cancellations.length, 0);
  f.at(START + 119_999); await f.service.tick();
  assert.equal(f.cancellations.length, 1);
  assert.equal(f.cancellations[0].b.amountUnits, '20000000');
  assert.match(f.cancellations[0].reason, /60 seconds.*fee is unchanged/);
  assert.equal((await f.service.state(f.b.id)).policy.mode, 'fault');
  await f.service.tick(); assert.equal(f.cancellations.length, 1);
  await assert.rejects(f.service.listener(f.b.id), /unavailable/);
  await assert.rejects(f.authorize(), /cancelled/);
});

test('stalled booking RPC cannot block the audio deadline; stale verification denies new access', async () => {
  const b = booking();
  let stalled = false, calls = 0;
  const f = await setup({ getBookings: () => {
    calls++;
    return stalled ? new Promise(() => {}) : Promise.resolve({ bookings: [b] });
  } });
  await f.prepare();
  f.at(START); f.frame(960); await f.service.tick();
  stalled = true;
  f.at(START + 59_999); await f.service.tick();
  const pendingCalls = calls;
  await assert.rejects(f.authorize(artist), /verification unavailable/);
  assert.equal(calls, pendingCalls, 'one in-flight booking refresh is shared');
  assert.equal(f.cancellations.length, 0);
  f.at(START + 60_000); await f.service.tick();
  assert.equal((await f.service.state(b.id)).policy.mode, 'fault');
  assert.equal(f.cancellations.length, 1);
});

test('cancellation recovery never replaces another explicitly reserved radio event', async () => {
  const { applyLiveAudioShow } = await import('../js/live-audio.mjs');
  const reserved = { id: 'next', type: 'live_performance', event: { id: 'next', title: 'Next performer' } };
  for (const mode of ['fault', 'adverts', 'radio']) {
    assert.equal(applyLiveAudioShow(reserved, { eventId: 'previous', bookingId: 'old', mode }), reserved);
  }
});

test('the website and scheduler both prefer the next live booking over a previous recovery window', async () => {
  const b = booking(), next = { ...booking(), id: 'next', eventId: 'next-event',
    startUtc: b.endUtc, endUtc: new Date(START + 40 * 60_000).toISOString() };
  const f = await setup({ getBookings: async () => ({ bookings: [b, next] }) });
  await f.store.save({ version: 1, rooms: [
    { bookingId: b.id, armed: false, checks: {}, cancelledAt: START + 19 * 60_000, reason: 'Prior cancellation' },
    { bookingId: next.id, armed: true, checks: { t60: 'checked', t15: 'checked' } },
  ] });
  f.at(START + 20 * 60_000 + 1000);
  await f.service.tick();
  assert.equal(f.policies.at(-1).bookingId, next.id);
  assert.equal((await f.service.current()).bookingId, next.id);
});

test('cancelled room persists the bounded slate, ten-minute ad window and original booking end', async () => {
  const f = await setup(); await f.prepare();
  f.at(START + 60_000); await f.service.tick();
  const at = f.persisted().rooms[0].cancelledAt;
  f.at(at + 4999); assert.equal((await f.service.state(f.b.id)).policy.mode, 'fault');
  f.at(at + 5000); assert.equal((await f.service.state(f.b.id)).policy.mode, 'adverts');
  f.at(at + 604_999); assert.equal((await f.service.state(f.b.id)).policy.mode, 'adverts');
  f.at(at + 605_000); assert.equal((await f.service.state(f.b.id)).policy.mode, 'radio');
  assert.equal(f.b.status, 'funded');
  f.at(START + 20 * 60_000); assert.equal((await f.service.state(f.b.id)).policy, null);
});

test('a funded pilot with missed soundchecks still cancels after sixty seconds instead of leaving radio paused', async () => {
  const f = await setup();
  f.at(START + 60_000);
  await f.service.tick();
  assert.equal(f.persisted().rooms.length, 1);
  assert.equal(f.cancellations.length, 1);
  assert.match(f.cancellations[0].reason, /not armed within 60 seconds/);
  assert.equal((await f.service.state(f.b.id)).policy.mode, 'fault');
});

test('restart does not invent healthy audio or reset an expired disconnect deadline', async () => {
  const f = await setup(); await f.prepare();
  f.at(START); f.frame(960); await f.service.tick();
  f.at(START + 6000); await f.service.tick();
  f.at(START + 60_000);
  const { createLiveAudioService } = await import('../discord-bot/live-audio.js');
  const restarted = createLiveAudioService(f.base);
  assert.equal((await restarted.state(f.b.id)).status, 'RECONNECTING');
  await restarted.tick();
  assert.equal((await restarted.state(f.b.id)).status, 'RECONNECTING', 'receiver gets a bounded rejoin probe');
  f.at(START + 65_000); await restarted.tick();
  assert.equal((await restarted.state(f.b.id)).phase, 'cancelled');
  assert.equal(f.cancellations.length, 1);
});

test('a healthy checkpoint does not turn a short process restart into an invented sixty-second outage', async () => {
  const f = await setup(); await f.prepare();
  f.at(START); f.frame(960); await f.service.tick();
  f.at(START + 60_000);
  const { createLiveAudioService } = await import('../discord-bot/live-audio.js');
  const restarted = createLiveAudioService(f.base);
  await restarted.tick();
  f.at(START + 62_000); f.frame(960); await restarted.tick();
  assert.equal((await restarted.state(f.b.id)).status, 'ON-AIR');
  assert.equal(f.cancellations.length, 0);
});

test('calendar-hook and provider cleanup delays cannot hold the fault/ad-window state hostage', async () => {
  const f = await setup({ onCancel: () => new Promise(() => {}) });
  await f.prepare();
  f.transport.close = () => new Promise(() => {});
  f.at(START + 60_000); await f.service.tick();
  assert.equal((await f.service.state(f.b.id)).policy.mode, 'fault');
  f.at(START + 65_000); await f.service.tick();
  assert.equal((await f.service.state(f.b.id)).policy.mode, 'adverts');
});

test('failed persistence never arms a public room; explicit operator cancellation is also supported', async () => {
  const f = await setup(), auth = await f.prepare();
  await assert.rejects(f.service.command(auth.token, { action: 'cancel' }, ORIGIN), /Confirm cancellation/);
  const result = await f.service.command(auth.token, { action: 'cancel', confirmed: true }, ORIGIN);
  assert.equal(result.phase, 'cancelled');
  const g = await setup(); await g.authorize();
  g.store.save = async () => { throw new Error('disk full'); };
  g.frame(960);
  const ownerSession = await g.authorize();
  await assert.rejects(g.service.command(ownerSession.token, { action: 'check', check: 't60', confirmed: true }, ORIGIN), /checkpoint failed/);
  assert.equal(g.service.configured, false);
});

test('public listener admission is bounded at ten pending grants and never opens backstage', async () => {
  const f = await setup(); await f.prepare();
  await assert.rejects(f.service.listener(f.b.id), /private/);
  f.at(START); f.frame(960);
  for (let i = 0; i < 10; i++) await f.service.listener(f.b.id);
  await assert.rejects(f.service.listener(f.b.id), /admission busy/);
});

test('file checkpoint round-trips only lifecycle metadata and survives service restart', async t => {
  const { createLiveAudioFileStore } = await import('../discord-bot/live-audio.js');
  const filename = path.join(__dirname, `.live-audio-state-${process.pid}.json`);
  t.after(async () => { await fs.rm(filename, { force: true }); await fs.rm(`${filename}.next`, { force: true }); });
  const store = createLiveAudioFileStore(filename);
  assert.deepEqual(await store.restore(), { version: 1, rooms: [] });
  const value = { version: 1, rooms: [{ bookingId: 'fixture', armed: false, checks: {}, cancelledAt: 123, reason: 'fixture' }] };
  await store.save(value);
  assert.deepEqual(await createLiveAudioFileStore(filename).restore(), value);
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
});

test('transport grants are receive-only for listeners and microphone-only for the booked wallet', async () => {
  const { createLiveAudioTransport, receivedAudioPackets } = await import('../discord-bot/live-audio-transport.js');
  const transport = createLiveAudioTransport({ enabled: true, url: 'wss://fixture.livekit.cloud', apiKey: 'fixture', apiSecret: 'fixture-secret',
    now: () => START, roomClient: { createRoom: async () => {}, listParticipants: async () => [] }, ingressClient: {} });
  const b = booking();
  const decode = grant => JSON.parse(Buffer.from(grant.token.split('.')[1], 'base64url'));
  const listener = decode(await transport.listener(b));
  assert.equal(listener.video.canPublish, false); assert.equal(listener.video.canPublishData, false);
  const publisher = decode(await transport.connect(b, 'publisher'));
  assert.equal(publisher.sub, `performer:${artist.address.toLowerCase()}`);
  assert.deepEqual(publisher.video.canPublishSources, ['microphone']);
  assert.equal(publisher.video.canSubscribe, false);
  assert.equal(listener.video.room, publisher.video.room);
  assert.equal(receivedAudioPackets({ subscriberStats: [{ stats: { case: 'inboundRtp', value: {
    stream: { kind: 'audio' }, received: { packetsReceived: 7n } } } }] }), 7n);
  assert.equal(receivedAudioPackets({ subscriberStats: [{ stats: { case: 'inboundRtp', value: {
    stream: { kind: 'video' }, received: { packetsReceived: 9n } } } }] }), 0n);
  await assert.rejects(transport.obs(b), /disabled/);
});

test('OBS uses separately enabled WHIP and revokes existing ingress rather than reusing a leaked key', async () => {
  const { createLiveAudioTransport } = await import('../discord-bot/live-audio-transport.js');
  const calls = [];
  const transport = createLiveAudioTransport({ enabled: true, ingressEnabled: true, url: 'wss://fixture.livekit.cloud',
    apiKey: 'fixture', apiSecret: 'fixture-secret', roomClient: { createRoom: async () => {}, deleteRoom: async () => {} },
    ingressClient: {
      listIngress: async () => [{ ingressId: 'old' }],
      deleteIngress: async id => calls.push(['delete', id]),
      createIngress: async (type, options) => { calls.push(['create', type, options]); return { url: 'https://fixture-whip', streamKey: 'private' }; },
    } });
  const result = await transport.obs(booking());
  assert.equal(calls[0][0], 'delete'); assert.equal(calls[1][2].enableTranscoding, false);
  assert.equal(result.protocol, 'WHIP'); assert.equal(result.whipEndpoint, 'https://fixture-whip/private');
  await transport.close(booking()); assert.equal(calls[2][0], 'delete');
});

test('HTTP room routes require allowed origins, keep private grants no-store, and redact provider errors', async () => {
  const { handleLiveAudioRequest } = await import('../discord-bot/live-audio-http.js');
  async function call(url, method, origin, input = {}, service = { configured: true }) {
    const request = Readable.from([JSON.stringify(input)]);
    Object.assign(request, { url, method, headers: { origin, authorization: 'Bearer fixture' } });
    const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
    await handleLiveAudioRequest(request, response, { service, allowedOrigins: [ORIGIN] });
    return response;
  }
  assert.equal((await call('/api/live-audio/listen', 'POST', 'https://evil.example')).status, 403);
  const privateResponse = await call('/api/live-audio/control', 'POST', ORIGIN, { action: 'obs' },
    { configured: true, command: async () => ({ streamKey: 'private' }) });
  assert.equal(privateResponse.headers['cache-control'], 'no-store');
  const failed = await call('/api/live-audio/listen', 'POST', ORIGIN, {}, {
    configured: true, listener: async () => { throw new Error('upstream rejected token secret-abcd'); },
  });
  assert.doesNotMatch(failed.body, /secret-abcd/);
  const preflight = await call('/api/live-audio/control', 'OPTIONS', ORIGIN);
  assert.match(preflight.headers['access-control-allow-headers'], /authorization/);
});

test('cancellation scheduler uses paid-ad priority but never consumes a DJuke song or fabricates unavailable ads', async t => {
  const { JukeLoopSession } = await import('../discord-bot/jukeloop.js');
  const player = new EventEmitter(); player.state = { status: 'idle' }; player.stop = () => {};
  const selections = [];
  const session = new JukeLoopSession({ client: {}, audioPlayer: player, websitePlayback: true,
    djuke: { nextPaid: async options => { selections.push(options); return null; } },
    devertPlayback: { nextMainRadioAd: async () => [] },
    saveMainRadioAdState: async () => 'ipfs://fixture' });
  t.after(() => session.destroy());
  session._queue = [{ trackId: 'song', title: 'Must not play' }];
  session.setLiveAudioPolicy({ bookingId: 'b', mode: 'adverts' });
  assert.equal(await session._prepareNextPlayback(), null);
  assert.equal(selections[0].includeSongs, false);
  assert.equal(selections[0].allowBump, true);
  assert.match(session.getPlaybackStatus().reason, /no delivery is being claimed/);
  session.setLiveAudioPolicy({ bookingId: 'b', mode: 'live', title: 'Live', eventId: 'live' });
  assert.equal(await session._prepareNextPlayback(), undefined);
  assert.equal(selections.length, 1);
});

test('listener ON-AIR requires local packet progression and playback, not merely a connected room', async () => {
  const { listenerAudioStatus } = await import('../js/live-audio.mjs');
  const state = { phase: 'live', serverStatus: 'ON-AIR', connected: true, playing: true, lastPacketAt: 10000, now: 11000 };
  assert.equal(listenerAudioStatus(state), 'ON-AIR');
  for (const update of [{ playing: false }, { connected: false }, { lastPacketAt: 0 }, { now: 16000 }, { serverStatus: 'RECONNECTING' }]) {
    assert.equal(listenerAudioStatus({ ...state, ...update }), 'RECONNECTING');
  }
  assert.equal(listenerAudioStatus({ ...state, phase: 'cancelled' }), 'OFF-AIR');
});

test('worker receiver requires both decoded frames and advancing inbound packets; concealment alone is not delivery', async t => {
  const { createLiveAudioTransport } = await import('../discord-bot/live-audio-transport.js');
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: START });
  let controller, packetCount = 0n, fresh = 0;
  const participant = { identity: `performer:${artist.address.toLowerCase()}`, trackPublications: new Map() };
  class Room extends EventEmitter {
    remoteParticipants = new Map();
    async connect() { this.emit('trackSubscribed', { kind: 1 }, { sid: 'audio' }, participant); }
    async getRtcStats() { return { subscriberStats: [{ stats: { case: 'inboundRtp', value: {
      stream: { kind: 'audio' }, received: { packetsReceived: packetCount } } } }] }; }
    async disconnect() {}
  }
  class AudioStream {
    constructor() { return new ReadableStream({ start(c) { controller = c; } }); }
  }
  const transport = createLiveAudioTransport({ enabled: true, url: 'wss://fixture.livekit.cloud',
    apiKey: 'fixture', apiSecret: 'fixture-secret', roomClient: { createRoom: async () => {} }, ingressClient: {},
    rtcLoader: async () => ({ Room, AudioStream, TrackKind: { KIND_AUDIO: 1 } }) });
  t.after(() => transport.stop());
  await transport.monitor(booking(), () => { fresh++; });
  const frame = () => controller.enqueue({ samplesPerChannel: 960, data: new Int16Array(960) });
  frame(); await new Promise(setImmediate);
  packetCount = 10n; t.mock.timers.tick(1000); await new Promise(setImmediate);
  assert.equal(fresh, 1, 'delivered zero-amplitude frames count');
  frame(); await new Promise(setImmediate);
  t.mock.timers.tick(1000); await new Promise(setImmediate);
  assert.equal(fresh, 1, 'concealed/repeated decoded frames without new packets do not count');
  packetCount = 11n; frame(); await new Promise(setImmediate);
  t.mock.timers.tick(1000); await new Promise(setImmediate);
  assert.equal(fresh, 2);
});

test('website listener handles autoplay blocking, packet freshness and teardown with no live credentials', async t => {
  const { createLiveAudioListener } = await import('../js/live-audio-client.mjs');
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: START });
  let blocked = true, count = 0;
  const statuses = [];
  const audio = { paused: true, srcObject: null,
    async play() { if (blocked) throw new Error('autoplay blocked'); this.paused = false; },
    pause() { this.paused = true; } };
  const track = { kind: 'audio', attach(target) { target.srcObject = {}; }, detach(target) { target.srcObject = null; },
    async getReceiverStats() { return { packetsReceived: count }; } };
  class Room extends EventEmitter {
    state = 'connecting'; remoteParticipants = new Map();
    async connect() { this.state = 'connected'; this.emit('subscribed', track, {}, { identity: 'booked-performer' }); }
    async disconnect() { this.state = 'disconnected'; }
    async startAudio() {}
  }
  const listener = createLiveAudioListener({ audio, serviceUrl: 'https://worker.example', onStatus: s => statuses.push(s),
    sdkLoader: async () => ({ Room, Track: { Kind: { Audio: 'audio' } }, RoomEvent: {
      TrackPublished: 'published', TrackSubscribed: 'subscribed', TrackUnsubscribed: 'unsubscribed',
      Reconnecting: 'reconnecting', Disconnected: 'disconnected' } }),
    request: async () => ({ url: 'wss://fixture', token: 'fixture-only', publisherIdentity: 'booked-performer' }) });
  t.after(() => listener.disconnect());
  const state = { bookingId: 'b', phase: 'live', armed: true, status: 'ON-AIR' };
  listener.update(state); await new Promise(setImmediate);
  assert.equal(statuses.at(-1).blocked, true);
  assert.equal(statuses.at(-1).status, 'RECONNECTING');
  blocked = false; await listener.play(); count = 10;
  t.mock.timers.tick(1000); await new Promise(setImmediate);
  assert.equal(statuses.at(-1).status, 'ON-AIR');
  t.mock.timers.tick(6000); await new Promise(setImmediate);
  assert.equal(statuses.at(-1).status, 'RECONNECTING');
  listener.update({ ...state, phase: 'cancelled' }); await new Promise(setImmediate);
  assert.equal(audio.paused, true); assert.equal(audio.srcObject, null);
});

test('a late token response cannot attach a previous booking after the radio has switched rooms', async t => {
  const { createLiveAudioListener } = await import('../js/live-audio-client.mjs');
  let release;
  const joined = [];
  class Room extends EventEmitter {
    state = 'connecting'; remoteParticipants = new Map();
    async connect(_url, token) { joined.push(token); this.state = 'connected'; }
    async disconnect() { this.state = 'disconnected'; }
  }
  const audio = { paused: true, pause() {}, srcObject: null };
  const listener = createLiveAudioListener({ audio, serviceUrl: 'https://worker.example',
    sdkLoader: async () => ({ Room, Track: { Kind: { Audio: 'audio' } }, RoomEvent: {
      TrackPublished: 'published', TrackSubscribed: 'subscribed', TrackUnsubscribed: 'unsubscribed',
      Reconnecting: 'reconnecting', Disconnected: 'disconnected' } }),
    request: async (_url, _path, input) => input.bookingId === 'old'
      ? new Promise(resolve => { release = resolve; })
      : { url: 'wss://fixture', token: 'new-booking', publisherIdentity: 'new-performer' } });
  t.after(() => listener.disconnect());
  listener.update({ bookingId: 'old', phase: 'live', armed: true, status: 'ON-AIR' });
  await new Promise(setImmediate);
  listener.update({ bookingId: 'new', phase: 'live', armed: true, status: 'ON-AIR' });
  await new Promise(setImmediate);
  release({ url: 'wss://fixture', token: 'old-booking', publisherIdentity: 'old-performer' });
  await new Promise(setImmediate);
  assert.deepEqual(joined, ['new-booking']);
});
