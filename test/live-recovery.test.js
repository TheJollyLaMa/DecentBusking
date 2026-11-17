const test = require('node:test');
const assert = require('node:assert/strict');

const START = Date.parse('2026-11-21T02:00:00Z');
const OWNER = `0x${'1'.repeat(40)}`, ARTIST = `0x${'2'.repeat(40)}`, NEXT = `0x${'3'.repeat(40)}`;
const ORIGIN = 'https://radio.example';
const iso = at => new Date(at).toISOString();

async function fixture(t, options = {}) {
  const { createLiveAudioService } = await import('../discord-bot/live-audio.js');
  const { validateLiveAudioState } = await import('../discord-bot/live-audio-store.js');
  let at = START - 1000, sequence = 0, service, receivers, suspended;
  const bookings = [
    { id: 'act-a', wallet: ARTIST, eventId: 'live:a', startUtc: iso(START), endUtc: iso(START + 20 * 60000) },
    { id: 'act-b', wallet: NEXT, eventId: 'live:b', startUtc: iso(START + 20 * 60000), endUtc: iso(START + 40 * 60000) },
  ].map(b => ({ ...b, mode: 'phase1', title: b.id, status: 'funded', acknowledged: true,
    payoutPolicy: 'pilot-guaranteed-v1', amountUnits: '20000000' }));
  const originalBookings = structuredClone(bookings);
  let saved = { version: 1, rooms: bookings.map(b => ({ bookingId: b.id, armed: true,
    checks: { t60: iso(START - 3600000), t15: iso(START - 900000) }, lastVerifiedAt: 0 })) };
  const cancellations = [], captures = [], stops = [], policies = [], services = [], handoffs = [], closed = [];
  let busy = false, writes = 0;
  const store = { restore: async () => structuredClone(saved), save: async value => {
    validateLiveAudioState(value); saved = structuredClone(value); writes++;
  } };
  async function boot(extra = {}) {
    receivers = new Map(); suspended = new Set();
    service = createLiveAudioService({
      getBookings: async () => ({ bookings }), ownerWallet: OWNER, store, recoveryEnabled: true,
      now: () => at, verify: (_message, signature) => signature,
      recorder: { available: true, status: () => ({ consented: false }),
        capture: (b, frame) => captures.push({ id: b.id, at, frame }),
        stopCapture: b => stops.push({ id: b.id, at }), tick: async () => {} },
      transport: { ready: true, monitor: async (b, packet, pcm) => receivers.set(b.id, { packet, pcm }),
        suspendListeners: async b => { suspended.add(b.id); await options.onSuspend?.(b); },
        resumeListeners: b => { suspended.delete(b.id); },
        connect: async () => ({}), listener: async b => {
          assert.equal(suspended.has(b.id), false); return { bookingId: b.id };
        }, close: async b => closed.push(b.id), stop: async () => {} },
      onPolicy: p => policies.push(p), onCancel: (b, reason) => cancellations.push({ id: b.id, reason }),
      withBroadcastHandoff: async (apply, safety) => {
        handoffs.push(safety);
        if (busy) throw Error('A paid item is still playing');
        return apply();
      }, ...options, ...extra,
    });
    services.push(service);
    await service.tick();
    return service;
  }
  const authorize = async (id = 'act-a', wallet = OWNER) => {
    const c = await service.challenge({ bookingId: id, wallet }, ORIGIN);
    return service.authorize({ challengeId: c.challengeId, signature: wallet }, ORIGIN);
  };
  const state = pass => service.command(pass.token, { action: 'state' }, ORIGIN);
  const command = async (pass, action, fields = {}) => {
    const s = await state(pass);
    return service.command(pass.token, { action: `broadcast-${action}`, commandId: `recovery-command-${++sequence}`,
      expectedRevision: action.startsWith('recovery-') ? s.recovery.revision : s.broadcast?.revision || 0, ...fields }, ORIGIN);
  };
  const direction = async (pass, action, fields = {}) => {
    const s = await service.command(pass.token, { action: 'direction-state' }, ORIGIN);
    return service.command(pass.token, { action: `direction-${action}`, epoch: s.epoch,
      ...(action !== 'heartbeat' ? { commandId: `direction-command-${++sequence}` } : {}),
      ...(!['heartbeat', 'message'].includes(action) ? { expectedRevision: s.revision } : {}), ...fields }, ORIGIN);
  };
  const frame = (id = 'act-a') => {
    const r = receivers.get(id);
    assert.ok(r, 'independent receiver exists');
    r.packet({ samples: 960 }); r.pcm({ samplesPerChannel: 960, data: new Int16Array(960) });
  };
  const ready = async pass => { await direction(pass, 'readiness', { ready: true }); await direction(pass, 'heartbeat'); };
  await boot();
  const owner = await authorize(), artist = await authorize('act-a', ARTIST);
  at = START; frame(); await service.tick();
  t.after(async () => { for (const s of services) await s.stop(); });
  return {
    get service() { return service; }, get suspended() { return suspended; },
    owner, artist, authorize, state, command, direction, ready, frame, boot, store, bookings, originalBookings,
    cancellations, captures, stops, policies, handoffs, closed,
    at: value => { at = value; }, busy: value => { busy = value; },
    room: (id = 'act-a') => structuredClone(saved.rooms.find(r => r.bookingId === id)),
    journal: () => structuredClone(saved), writes: () => writes,
    drop: async () => { at = START + 6000; await service.tick(); },
    tick: () => service.tick(),
  };
}

test('new no-action default cancels at exactly 15 seconds, once, without changing guaranteed terms', async t => {
  const f = await fixture(t);
  await f.drop();
  f.at(START + 14999); await f.tick();
  assert.equal((await f.state(f.owner)).phase, 'live');
  f.at(START + 15000); await f.tick();
  assert.equal(f.room().cancelledAt, START + 15000);
  assert.match(f.room().reason, /15 seconds.*fee is unchanged/);
  await f.tick(); await new Promise(resolve => setImmediate(resolve)); await f.tick();
  assert.equal(f.cancellations.length, 1);
  assert.deepEqual(f.bookings, f.originalBookings);
  await assert.rejects(f.authorize(), /cancelled/);
});

test('hold is explicit, producer-only, revisioned and cumulative across requests, reconnect and encrypted journal restore', async t => {
  const f = await fixture(t);
  await f.drop();
  await assert.rejects(f.command(f.artist, 'recovery-hold', { additionalMs: 1000 }), e => e.status === 403);
  const first = { action: 'broadcast-recovery-hold', commandId: 'repeatable-hold', expectedRevision: 0, additionalMs: 20000 };
  await assert.rejects(f.service.command(f.owner.token, first, 'https://wrong.example'), /authorization/);
  assert.equal((await f.service.command(f.owner.token, first, ORIGIN)).applied, true);
  assert.equal((await f.service.command(f.owner.token, first, ORIGIN)).applied, false);
  assert.equal(f.room().recovery.usedMs, 20000);
  const newPass = await f.authorize();
  await f.command(newPass, 'recovery-hold', { additionalMs: 40000 });
  assert.equal(f.room().recovery.deadline, START + 75000);
  assert.equal(f.room().recovery.usedMs, 60000);
  await assert.rejects(f.command(newPass, 'recovery-hold', { additionalMs: 1 }), /cumulative budget/);
  await assert.rejects(f.command(newPass, 'recovery-hold', { additionalMs: -1 }), /cumulative budget/);
  await assert.rejects(f.command(newPass, 'recovery-hold', { additionalMs: 1, deadline: START + 999999 }), /Invalid recovery/);
  const { liveAudioStateCodec } = await import('../discord-bot/live-audio-store.js');
  const codec = liveAudioStateCodec('12'.repeat(32)), before = f.journal();
  assert.deepEqual(codec.deserialize(codec.serialize(before)), before);
  f.at(START + 30000); await f.boot();
  const restored = await f.authorize();
  assert.equal((await f.state(restored)).recovery.remainingMs, 0);
  await assert.rejects(f.command(restored, 'recovery-hold', { additionalMs: 1000 }), /cumulative budget/);
  f.at(START + 74999); await f.tick();
  assert.equal(f.room().cancelledAt, undefined);
  f.at(START + 75000); f.frame(); await f.tick();
  assert.equal(f.room().cancelledAt, START + 75000, 'late packets do not revive the expired journal deadline');
});

test('unused hold survives successful recovery, and a later outage cannot reset the cumulative cap', async t => {
  const f = await fixture(t);
  await f.drop();
  await f.command(f.owner, 'recovery-hold', { additionalMs: 40000 });
  f.at(START + 25000); f.frame(); await f.tick();
  assert.equal(f.room().lossSince, 0);
  assert.equal(f.room().recovery.usedMs, 40000);
  f.at(START + 31000); await f.tick();
  await f.command(await f.authorize(), 'recovery-hold', { additionalMs: 20000 });
  assert.equal(f.room().recovery.deadline, START + 60000);
  await assert.rejects(f.command(f.owner, 'recovery-hold', { additionalMs: 1 }), /cumulative budget/);
  assert.deepEqual(f.bookings, f.originalBookings);
});

test('filler restore re-suspends public seats without resetting its deadline or treating packets as an authorized return', async t => {
  const f = await fixture(t);
  await f.drop();
  await f.command(f.owner, 'recovery-hold', { additionalMs: 10000 });
  await f.command(f.owner, 'recovery-filler', { mode: 'radio', confirmed: true });
  f.at(START + 12000); await f.boot();
  const owner = await f.authorize();
  assert.equal(f.suspended.has('act-a'), true);
  assert.equal((await f.state(owner)).recovery.deadline, START + 25000);
  assert.equal((await f.state(owner)).recovery.usedMs, 10000);
  f.frame(); await f.tick();
  assert.equal((await f.state(owner)).phase, 'recovering');
  await assert.rejects(f.command(owner, 'recovery-return', { confirmed: true }), /readiness/);
  f.at(START + 25000); f.frame(); await f.tick();
  assert.equal(f.room().cancelledAt, START + 25000);
});

for (const mode of ['adverts', 'radio']) {
  test(`immediate ${mode} keeps original set recoverable, records no filler, and requires explicit safe verified return`, async t => {
    const f = await fixture(t);
    await f.drop();
    await f.command(f.owner, 'recovery-hold', { additionalMs: 30000 });
    const deadline = f.room().recovery.deadline;
    await f.command(f.owner, 'recovery-filler', { mode, confirmed: true });
    assert.equal(f.policies.at(-1).mode, mode);
    assert.equal(f.policies.at(-1).breakKind, 'recovery');
    assert.equal(f.room().recovery.deadline, deadline);
    assert.equal(f.room().cancelledAt, undefined);
    assert.equal(f.suspended.has('act-a'), true);
    const captures = f.captures.length;
    await assert.rejects(f.service.listener('act-a'), /unavailable/);
    await assert.rejects(f.command(f.owner, 'recovery-return', { confirmed: true }), /readiness.*audio/);
    f.at(START + 10000); f.frame(); await f.tick();
    assert.equal((await f.state(f.owner)).phase, 'recovering');
    assert.equal((await f.state(f.owner)).status, 'OFF-AIR');
    assert.equal(f.captures.length, captures, 'reconnected private audio and commercials are not on-air performance capture');
    await assert.rejects(f.command(f.owner, 'recovery-return', { confirmed: true }), /readiness/);
    await f.ready(f.artist);
    f.busy(true);
    await assert.rejects(f.command(f.owner, 'recovery-return', { confirmed: true }), e => e.code === 'BROADCAST_BUSY');
    assert.equal(f.room().recovery.filler, mode);
    f.busy(false);
    await f.command(f.owner, 'recovery-return', { confirmed: true });
    assert.equal(f.room().recovery.filler, null);
    assert.equal(f.suspended.has('act-a'), false);
    assert.equal((await f.state(f.owner)).status, 'ON-AIR');
    assert.equal(f.policies.at(-1).mode, 'live');
    f.frame();
    assert.equal(f.captures.length, captures + 1);
    assert.deepEqual(await f.service.listener('act-a'), { bookingId: 'act-a' });
    assert.equal(f.cancellations.length, 0);
    assert.ok(f.handoffs.every(safety => safety.protectAd === true));
  });
}

test('switching filler and retrying an ad command never grants time; recovered packets cannot extend a filler deadline', async t => {
  const f = await fixture(t);
  await f.drop();
  const input = { action: 'broadcast-recovery-filler', commandId: 'commercials-once', expectedRevision: 0, mode: 'adverts', confirmed: true };
  await f.service.command(f.owner.token, input, ORIGIN);
  const writes = f.writes(), policies = f.policies.length;
  assert.equal((await f.service.command(f.owner.token, input, ORIGIN)).applied, false);
  assert.equal(f.writes(), writes);
  assert.ok(f.policies.length >= policies, 'watchdog can refresh the same policy without starting another ad');
  await f.command(f.owner, 'recovery-filler', { mode: 'radio', confirmed: true });
  assert.equal(f.room().recovery.deadline, START + 15000);
  f.at(START + 15000); f.frame(); await f.tick();
  assert.equal(f.room().cancelledAt, START + 15000);
  assert.equal(f.policies.at(-1).mode, 'fault');
  await assert.rejects(f.command(f.owner, 'recovery-return', { confirmed: true }), /authorization/);
});

test('packets arriving during the public-listener suspension cannot leak private transition audio into capture', async t => {
  let whileSuspending;
  const f = await fixture(t, { onSuspend: async () => whileSuspending?.() });
  await f.drop();
  const captures = f.captures.length;
  whileSuspending = () => f.frame();
  await f.command(f.owner, 'recovery-filler', { mode: 'adverts', confirmed: true });
  assert.equal(f.captures.length, captures);
  assert.equal(f.room().recovery.filler, 'adverts');
});

test('reader-first writer gate leaves old checkpoints unchanged; explicit grace override remains available', async t => {
  const f = await fixture(t, { recoveryEnabled: false, graceMs: 60000 });
  await f.drop();
  await assert.rejects(f.command(f.owner, 'recovery-hold', { additionalMs: 1000 }), e => e.status === 503);
  assert.equal(f.room().recovery, undefined);
  f.at(START + 15000); await f.tick(); assert.equal(f.room().cancelledAt, undefined);
  f.at(START + 59999); await f.tick(); assert.equal(f.room().cancelledAt, undefined);
  f.at(START + 60000); await f.tick(); assert.equal(f.room().cancelledAt, START + 60000);
});

test('a hold cannot extend protected authorized airtime, and the producer countdown is capped at that end', async t => {
  const f = await fixture(t);
  const end = Date.parse(f.bookings[0].endUtc);
  f.at(end - 10000); f.frame(); await f.tick();
  f.at(end - 4000); await f.tick();
  assert.equal((await f.state(f.owner)).recovery.deadline, end);
  assert.equal((await f.state(f.owner)).broadcastCapabilities.recoveryHold, false);
  await assert.rejects(f.command(f.owner, 'recovery-hold', { additionalMs: 1000 }), /authorized set end/);
  await f.command(f.owner, 'recovery-filler', { mode: 'radio', confirmed: true });
  assert.equal(f.room().recovery.deadline, end);
  assert.deepEqual(f.bookings, f.originalBookings);
});

test('recovery checkpoint rejects unbounded, inconsistent or secret-bearing state while old rooms still restore', async () => {
  const { validateLiveAudioState } = await import('../discord-bot/live-audio-store.js');
  const old = { bookingId: 'old-room', armed: true, checks: {}, lossSince: START };
  assert.doesNotThrow(() => validateLiveAudioState({ version: 1, rooms: [old] }));
  const recovery = { revision: 1, usedMs: 60000, deadline: START + 75000, filler: 'radio', graceMs: 15000 };
  assert.doesNotThrow(() => validateLiveAudioState({ version: 1, rooms: [{ ...old, recovery }] }));
  for (const invalid of [{ ...recovery, usedMs: 60001 }, { ...recovery, revision: 0 },
    { ...recovery, deadline: START - 1 }, { ...recovery, deadline: START + 75001 }, { ...recovery, graceMs: 60001 },
    { ...recovery, deadline: null }, { ...recovery, filler: 'live' }, { ...recovery, token: 'secret' }]) {
    assert.throws(() => validateLiveAudioState({ version: 1, rooms: [{ ...old, recovery: invalid }] }), /recovery checkpoint/);
  }
});

async function pair(f) {
  await f.command(f.owner, 'enable');
  const nextOwner = await f.authorize('act-b'), nextArtist = await f.authorize('act-b', NEXT);
  await f.command(f.owner, 'reserve-next', { nextBookingId: 'act-b', nextToken: nextOwner.token, expectedNextRevision: 0 });
  await f.command(nextArtist, 'choice', { choice: 'full' });
  await f.drop();
  return { nextOwner, nextArtist };
}

test('no-next-act and non-owner advance are visible denials, never a fake message or implicit cancellation', async t => {
  const f = await fixture(t);
  await f.command(f.owner, 'enable'); await f.drop();
  assert.equal((await f.state(f.owner)).broadcastCapabilities.advanceNext, false);
  await assert.rejects(f.command(f.owner, 'advance-next', { confirmed: true, expectedNextRevision: 0 }), /No paired next/);
  await assert.rejects(f.command(f.artist, 'advance-next', { confirmed: true, expectedNextRevision: 0 }), e => e.status === 403);
  assert.equal(f.room().allocation.endedAt, null);
});

test('next-act communication reuses the exact booking thread; advance needs real readiness and atomically cuts the old set', async t => {
  const f = await fixture(t);
  const { nextOwner, nextArtist } = await pair(f);
  await f.direction(nextOwner, 'message', { text: 'Can you explicitly confirm readiness? Your guarantee is unchanged.' });
  const view = await f.service.command(nextArtist.token, { action: 'direction-state' }, ORIGIN);
  assert.match(view.messages.at(-1).text, /explicitly confirm/);
  const fields = async () => ({ confirmed: true, nextToken: nextOwner.token,
    expectedNextRevision: (await f.state(nextOwner)).broadcast.revision });
  await assert.rejects(f.command(f.owner, 'advance-next', { ...await fields(), nextToken: f.owner.token }), e => e.status === 403);
  await assert.rejects(f.command(f.owner, 'advance-next', await fields()), /ready.*audio/);
  await f.ready(nextArtist);
  await assert.rejects(f.command(f.owner, 'advance-next', await fields()), /ready.*audio/);
  f.frame('act-b');
  f.busy(true);
  await assert.rejects(f.command(f.owner, 'advance-next', await fields()), e => e.code === 'BROADCAST_BUSY');
  assert.equal(f.room().allocation.endedAt, null);
  f.busy(false);
  const input = { action: 'broadcast-advance-next', commandId: 'advance-once',
    expectedRevision: (await f.state(f.owner)).broadcast.revision, ...await fields() };
  assert.equal((await f.service.command(f.owner.token, input, ORIGIN)).applied, true);
  assert.equal((await f.service.command(f.owner.token, input, ORIGIN)).applied, false);
  assert.equal(f.room().allocation.endReason, 'operator-cut');
  assert.equal(f.room('act-b').allocation.startedAt, START + 6000);
  assert.ok(f.room('act-b').allocation.startedAt < Date.parse(f.bookings[1].startUtc), 'only this explicitly approved advance starts early');
  assert.equal(f.policies.at(-1).bookingId, 'act-b');
  assert.deepEqual(await f.service.listener('act-b'), { bookingId: 'act-b' });
  await assert.rejects(f.service.listener('act-a'), /unavailable/);
  await assert.rejects(f.command(f.owner, 'recovery-hold', { additionalMs: 1 }), /ended set|booked end/);
  assert.deepEqual(f.bookings, f.originalBookings);
  assert.equal(f.cancellations.length, 0, 'atomic operator cut uses existing allocated terminal path, not duplicate financial cancellation');
});

test('advance rejects stale/not-ready performer declarations, lost funding and protected schedule conflicts', async t => {
  const f = await fixture(t);
  const { nextOwner, nextArtist } = await pair(f);
  await f.command(f.owner, 'recovery-hold', { additionalMs: 60000 });
  const fields = async () => ({ confirmed: true, nextToken: nextOwner.token,
    expectedNextRevision: (await f.state(nextOwner)).broadcast.revision });
  await f.direction(nextArtist, 'readiness', { ready: false }); await f.direction(nextArtist, 'heartbeat');
  f.frame('act-b');
  await assert.rejects(f.command(f.owner, 'advance-next', await fields()), /ready.*audio/);
  await f.ready(nextArtist);
  f.at(START + 66001); f.frame('act-b');
  await assert.rejects(f.command(f.owner, 'advance-next', await fields()), /ready.*audio/);
  await f.ready(nextArtist);
  f.bookings.push({ ...f.bookings[1], id: 'protected-third', eventId: 'protected',
    startUtc: iso(START + 70000), endUtc: iso(START + 100000) });
  await assert.rejects(f.command(f.owner, 'advance-next', await fields()), /third-booking conflict/);
  assert.equal(f.room().allocation.endedAt, null);
  assert.equal(f.room('act-b').allocation.startedAt, null);
  f.bookings.pop();
  f.bookings[1].status = 'pending';
  await assert.rejects(f.command(f.owner, 'advance-next', await fields()), /funded|authorization/);
  assert.equal(f.room().allocation.endedAt, null);
});

test('recovery holds do not turn a durable finished declaration into encore time or an interrupted ending', async t => {
  const f = await fixture(t);
  await f.command(f.owner, 'enable'); await f.command(f.artist, 'finished');
  await f.drop();
  assert.equal((await f.state(f.owner)).broadcastCapabilities.recoveryHold, false);
  await assert.rejects(f.command(f.owner, 'recovery-hold', { additionalMs: 60000 }), /No unfinished set/);
  f.at(START + 15000); await f.tick();
  assert.equal(f.room().allocation.endReason, 'producer-finished');
  assert.equal(f.cancellations.length, 0);
  assert.equal(f.room().allocation.encoreMs, 0);
});

test('public suspension removes only public listeners; performer, health receiver and private producer remain', async () => {
  const { createLiveAudioTransport } = await import('../discord-bot/live-audio-transport.js');
  const removed = [];
  const transport = createLiveAudioTransport({ enabled: true, url: 'wss://fixture.livekit.cloud',
    apiKey: 'fixture', apiSecret: 'f'.repeat(32), now: () => START,
    roomClient: {
      listParticipants: async () => [{ identity: 'listener:one' }, { identity: 'listener:two' },
        { identity: `performer:${ARTIST}` }, { identity: 'health:act-a' }, { identity: 'owner:private' }],
      removeParticipant: async (_room, identity) => removed.push(identity),
    } });
  const booking = { id: 'act-a', wallet: ARTIST, endUtc: iso(START + 60000) };
  await transport.suspendListeners(booking);
  assert.deepEqual(removed, ['listener:one', 'listener:two']);
  await assert.rejects(transport.listener(booking), /suspended/);
  transport.resumeListeners(booking);
  assert.ok((await transport.listener(booking)).token);
});

test('currently shipped mirror contract rejects both old and recovery encrypted envelopes before any Kubo/provider write', async () => {
  const { liveAudioStateCodec } = await import('../discord-bot/live-audio-store.js');
  const { createLocalCheckpointMirrorClient } = await import('../discord-bot/checkpoint-mirror-client.js');
  const { checkpointContentCid } = await import('../discord-bot/checkpoint-mirror.js');
  const codec = liveAudioStateCodec('12'.repeat(32));
  for (const recovery of [undefined, { revision: 1, graceMs: 15000, usedMs: 10000, deadline: START + 25000, filler: 'radio' }]) {
    const room = { bookingId: 'act-a', armed: true, checks: {}, lossSince: START, ...(recovery ? { recovery } : {}) };
    const bytes = Buffer.from(JSON.stringify(codec.serialize({ version: 1, rooms: [room] })));
    const cid = await checkpointContentCid(bytes), calls = [];
    const poll = createLocalCheckpointMirrorClient({ serviceUrl: 'https://worker.example', secret: 's'.repeat(32),
      fetchImpl: async (url) => {
        calls.push(url);
        return { ok: true, json: async () => ({ job: { jobId: 'opaque-live-checkpoint', expectedCid: cid, contentBase64: bytes.toString('base64') } }) };
      } });
    await assert.rejects(poll(), /Only supported/);
    assert.deepEqual(calls, ['https://worker.example/api/checkpoint-mirror/claim']);
  }
});
