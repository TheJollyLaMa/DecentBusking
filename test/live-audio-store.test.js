const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Wallet } = require('../discord-bot/node_modules/ethers');

const START = Date.parse('2026-11-14T02:00:00Z');
const ORIGIN = 'https://radio.example';
const KEY = randomBytes(32).toString('hex');
const owner = Wallet.createRandom(), artist = Wallet.createRandom();
const booking = { id: 'existing-funded-booking', wallet: artist.address, title: 'Private fixture',
  startUtc: new Date(START).toISOString(), endUtc: new Date(START + 20 * 60_000).toISOString(),
  status: 'funded', acknowledged: true, payoutPolicy: 'pilot-guaranteed-v1' };
const SECRETS = ['private-grant-fixture', 'fixture-stream-key', 'whip.example'];

function fakePinata() {
  const files = [], uploads = [];
  let serial = 0, failGateway = false;
  return {
    files, uploads,
    set failGateway(value) { failGateway = value; },
    async fetchImpl(url, init = {}) {
      const { checkpointContentCid } = await import('../discord-bot/checkpoint-mirror.js');
      const target = new URL(url);
      if (init.method === 'POST') {
        const file = init.body.get('file');
        const bytes = new Uint8Array(await file.arrayBuffer());
        const cid = await checkpointContentCid(bytes);
        uploads.push(Buffer.from(bytes).toString());
        files.unshift({ id: `file-${++serial}`, cid, name: init.body.get('name'),
          keyvalues: JSON.parse(init.body.get('keyvalues')), created_at: new Date(Date.UTC(2026, 10, 9, 0, 0, serial)).toISOString(), bytes });
        return Response.json({ data: { cid } });
      }
      if (init.method === 'DELETE') {
        const id = target.pathname.split('/').pop();
        files.splice(files.findIndex(file => file.id === id), 1);
        return Response.json({});
      }
      if (target.pathname === '/v3/gateways') return Response.json({ data: { rows: [] } });
      if (target.pathname.endsWith('/public')) {
        return Response.json({ data: { files: files.filter(file => file.name === target.searchParams.get('name'))
          .map(({ bytes, ...file }) => file) } });
      }
      const cid = target.pathname.split('/ipfs/')[1];
      const found = files.find(file => file.cid === cid);
      if (failGateway || !found) return new Response('missing', { status: 504 });
      return new Response(found.bytes);
    },
  };
}

async function fixture({ pinata = fakePinata(), mirrorOnline = true, key = KEY } = {}) {
  const { createLiveAudioPinataStore } = await import('../discord-bot/live-audio-store.js');
  const { checkpointContentCid } = await import('../discord-bot/checkpoint-mirror.js');
  const mirrored = [];
  const checkpointMirror = { async mirror(bytes, options) {
    if (!mirrorOnline) throw new Error('Local checkpoint mirror is offline; no Pinata upload attempted');
    assert.equal(options.required, true);
    mirrored.push(Buffer.from(bytes).toString());
    return checkpointContentCid(bytes);
  } };
  const store = createLiveAudioPinataStore({ storageKey: key, checkpointMirror, pinataJwt: 'test-jwt',
    fetchImpl: pinata.fetchImpl, gateway: 'https://gateway.example', gatewayAccessToken: '', log: { warn() {} } });
  return { store, pinata, mirrored };
}

async function service(store, clock) {
  const { createLiveAudioService } = await import('../discord-bot/live-audio.js');
  let receiver;
  const transport = { ready: true, ingressEnabled: true,
    monitor: async (_b, callback) => { receiver = callback; },
    connect: async () => ({ token: SECRETS[0] }),
    obs: async () => ({ protocol: 'WHIP', whipEndpoint: `https://${SECRETS[2]}/w/${SECRETS[1]}` }),
    listener: async () => ({ token: SECRETS[0] }), close: async () => {}, stop: async () => {} };
  const s = createLiveAudioService({ getBookings: async () => ({ bookings: [booking] }), ownerWallet: owner.address,
    transport, store, now: () => clock.time, onPolicy() {}, onCancel() {} });
  const authorize = async wallet => {
    const c = await s.challenge({ bookingId: booking.id, wallet: wallet.address }, ORIGIN);
    return s.authorize({ challengeId: c.challengeId, signature: await wallet.signMessage(c.message) }, ORIGIN);
  };
  return { s, authorize, frame: () => receiver({ samples: 960 }) };
}

test('live audio lifecycle survives restart through encrypted, mirrored Pinata state without secrets', async () => {
  const clock = { time: START - 60 * 60_000 };
  const first = await fixture();
  const live = await service(first.store, clock);
  const ownerAuth = await live.authorize(owner);
  const artistAuth = await live.authorize(artist);
  await live.s.command(artistAuth.token, { action: 'connect', publish: true }, ORIGIN);
  await live.s.command(artistAuth.token, { action: 'obs' }, ORIGIN);
  live.frame();
  await live.s.command(ownerAuth.token, { action: 'check', check: 't60', confirmed: true }, ORIGIN);
  clock.time = START - 15 * 60_000; live.frame();
  await live.s.command(ownerAuth.token, { action: 'check', check: 't15', confirmed: true }, ORIGIN);
  await live.s.command(ownerAuth.token, { action: 'arm' }, ORIGIN);

  assert.ok(first.pinata.uploads.length >= 3);
  assert.deepEqual(first.mirrored, first.pinata.uploads, 'mirror receives identical bytes before each publication');
  for (const text of first.pinata.uploads) {
    assert.equal(JSON.parse(text).schema, 'encrypted-live-audio-v1');
    for (const plain of [booking.id, ownerAuth.token, artistAuth.token, ...SECRETS, 't60', 'armed', KEY]) {
      assert.equal(text.includes(plain), false, `public checkpoint must not contain ${plain}`);
    }
  }
  assert.ok(first.pinata.files.every(file => file.name === 'decentbusking-live-audio-encrypted.json' &&
    file.keyvalues.kind === 'live-audio-encrypted'));

  clock.time = START + 1000;
  const second = await fixture({ pinata: first.pinata });
  const restarted = await service(second.store, clock);
  const restored = await second.store.restore();
  assert.equal(restored.rooms[0].armed, true);
  assert.ok(restored.rooms[0].checks.t60 && restored.rooms[0].checks.t15);
  const state = await restarted.s.state(booking.id);
  assert.equal(state.armed, true);
  assert.equal(state.status, 'RECONNECTING', 'restored checkpoint is not receiver evidence');
  assert.equal(state.verifiedAudioAt, null);
  await assert.rejects(restarted.s.command(ownerAuth.token, { action: 'state' }, ORIGIN), /expired/, 'sessions are memory-only');
  await restarted.s.tick();
  restarted.frame();
  assert.equal((await restarted.s.state(booking.id)).status, 'ON-AIR', 'only a new receiver frame proves delivery');
});

test('save is awaited: mirror outage rejects, publishes nothing and closes room controls', async () => {
  const clock = { time: START - 60 * 60_000 };
  const f = await fixture({ mirrorOnline: false });
  const live = await service(f.store, clock);
  await assert.rejects(live.authorize(owner), /checkpoint failed/);
  assert.equal(f.pinata.uploads.length, 0);
  assert.equal(live.s.configured, false);
  assert.equal((await live.s.state(booking.id)).status, 'OFF-AIR');
});

test('restore is explicit: empty starts clean; wrong key, tampering and gateway loss fail closed', async () => {
  const { store } = await fixture();
  assert.deepEqual(await store.restore(), { version: 1, rooms: [] });
  const seeded = await fixture();
  await seeded.store.save({ version: 1, rooms: [{ bookingId: 'b', armed: false, checks: {}, lastVerifiedAt: 0 }] });

  const wrong = await fixture({ pinata: seeded.pinata, key: randomBytes(32).toString('hex') });
  await assert.rejects(wrong.store.restore(), /restore failed/);
  const clock = { time: START - 60 * 60_000 };
  const closed = await service(wrong.store, clock);
  await assert.rejects(closed.s.state(booking.id), /restore failed/);

  seeded.pinata.failGateway = true;
  await assert.rejects((await fixture({ pinata: seeded.pinata })).store.restore(), /restore failed/);
  seeded.pinata.failGateway = false;

  const latest = seeded.pinata.files[0];
  const envelope = JSON.parse(Buffer.from(latest.bytes).toString());
  envelope.data = Buffer.from('{"version":1,"rooms":[]}').toString('base64');
  latest.bytes = new TextEncoder().encode(JSON.stringify(envelope));
  await assert.rejects((await fixture({ pinata: seeded.pinata })).store.restore(), /restore failed/);
});

test('a newer unreadable checkpoint never rolls back to an older room state', async () => {
  const f = await fixture();
  await f.store.save({ version: 1, rooms: [{ bookingId: 'b', armed: false, checks: {}, lastVerifiedAt: 0 }] });
  await f.store.save({ version: 1, rooms: [{ bookingId: 'b', armed: false, checks: {}, lastVerifiedAt: 0,
    cancelledAt: 5, reason: 'Cancelled', cancelNoticePending: false }] });
  f.pinata.files[0].bytes = new TextEncoder().encode('{"schema":"encrypted-live-audio-v1"}');
  await assert.rejects((await fixture({ pinata: f.pinata })).store.restore(), /restore failed/);
});

test('only allowlisted lifecycle fields and a dedicated key are accepted', async () => {
  const { createLiveAudioPinataStore, liveAudioStateCodec, validateLiveAudioState } = await import('../discord-bot/live-audio-store.js');
  const room = { bookingId: 'b', armed: false, checks: {}, lastVerifiedAt: 0 };
  for (const bad of [{ ...room, token: SECRETS[0] }, { ...room, whipEndpoint: SECRETS[2] },
    { ...room, checks: { obs: SECRETS[1] } }, { ...room, cancelledAt: 1 }, { ...room, lastVerifiedAt: -1 }]) {
    assert.throws(() => validateLiveAudioState({ version: 1, rooms: [bad] }), /Invalid live audio checkpoint/);
  }
  assert.throws(() => validateLiveAudioState({ version: 1, rooms: [room, room] }), /Invalid/);
  assert.throws(() => validateLiveAudioState({ version: 1, rooms: [], streamKey: 'x' }), /Invalid/);
  const f = await fixture();
  await assert.rejects(f.store.save({ version: 1, rooms: [{ ...room, token: SECRETS[0] }] }), /Invalid/);
  assert.equal(f.pinata.uploads.length + f.mirrored.length, 0);
  assert.throws(() => liveAudioStateCodec('short'), /LIVE_AUDIO_STORAGE_KEY/);
  assert.throws(() => liveAudioStateCodec(KEY, { distinctFrom: [KEY.toUpperCase()] }), /dedicated/);
  assert.throws(() => createLiveAudioPinataStore({ storageKey: KEY, pinataJwt: 'x' }), /checkpoint mirror/);
  assert.throws(() => createLiveAudioPinataStore({ storageKey: KEY, checkpointMirror: { mirror() {} } }), /PINATA_JWT/);
});
