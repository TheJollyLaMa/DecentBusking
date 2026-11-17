const test = require('node:test');
const assert = require('node:assert/strict');
const START = Date.parse('2026-11-20T02:00:00Z'), MIN = 60000;
const OWNER = `0x${'1'.repeat(40)}`, A = `0x${'2'.repeat(40)}`, B = `0x${'3'.repeat(40)}`;
const ORIGIN = 'https://radio.example';

async function fixture(t, { third = false, recorder, handoff } = {}) {
  const { createLiveAudioService } = await import('../discord-bot/live-audio.js');
  let now = START + 5 * MIN, count = 0;
  const booking = (id, wallet, start) => ({ id, eventId: `event-${id}`, wallet, title: id,
    startUtc: new Date(start).toISOString(), endUtc: new Date(start + 20 * MIN).toISOString(),
    payoutPolicy: 'pilot-guaranteed-v1', status: 'funded', acknowledged: true, amountUnits: '20000000' });
  const bookings = [booking('artist-a', A, START), booking('artist-b', B, START + 20 * MIN)];
  if (third) bookings.push(booking('artist-c', `0x${'4'.repeat(40)}`, START + 45 * MIN));
  let saved = { version: 1, rooms: bookings.map(b => ({ bookingId: b.id, armed: true,
    checks: { t60: new Date(START - 60 * MIN).toISOString(), t15: new Date(START - 15 * MIN).toISOString() }, lastVerifiedAt: 0 })) };
  const receivers = new Map(), closed = [], captures = [], policies = [], cancellations = [];
  const store = { restore: async () => structuredClone(saved), save: async value => { saved = structuredClone(value); } };
  const transport = { ready: true, ingressEnabled: false,
    monitor: async (b, frame, pcm) => { receivers.set(b.id, { frame, pcm }); },
    connect: async b => ({ expiresAt: b.broadcast?.accessUntil || Date.parse(b.endUtc) }),
    listener: async b => ({ bookingId: b.id, end: b.broadcast?.authorizedEndAt || Date.parse(b.endUtc) }),
    close: async b => { closed.push(b.id); }, stop: async () => {} };
  const args = { getBookings: async () => ({ bookings }), ownerWallet: OWNER, store, transport, now: () => now,
    verify: (_message, signature) => signature, recorder,
    onPolicy: p => policies.push(p), onCancel: (...args) => cancellations.push(args),
    withBroadcastHandoff: handoff || (async apply => apply()) };
  const service = createLiveAudioService(args);
  t.after(() => service.stop());
  async function authorize(id = 'artist-a', wallet = OWNER, target = service) {
    const c = await target.challenge({ bookingId: id, wallet }, ORIGIN);
    return target.authorize({ challengeId: c.challengeId, signature: wallet }, ORIGIN);
  }
  const state = pass => service.command(pass.token, { action: 'state' }, ORIGIN);
  const send = async (pass, action, payload = {}) => {
    const s = await state(pass);
    return service.command(pass.token, { action: `broadcast-${action}`, commandId: `broadcast-${++count}`,
      expectedRevision: s.broadcast?.revision || 0, ...payload }, ORIGIN);
  };
  const direction = async (pass, action, payload = {}) => {
    const s = await service.command(pass.token, { action: 'direction-state' }, ORIGIN);
    return service.command(pass.token, { action: `direction-${action}`, epoch: s.epoch, commandId: `direction-${++count}`,
      ...(action !== 'message' ? { expectedRevision: s.revision } : {}), ...payload }, ORIGIN);
  };
  const feed = id => receivers.get(id)?.frame({ samples: 960 });
  await service.tick(); feed('artist-a'); feed('artist-b'); await service.tick();
  return { service, args, store, bookings, authorize, state, send, direction, feed, closed, captures, policies, cancellations,
    at: time => { now = time; }, saved: () => structuredClone(saved) };
}

test('paired allocation requires two scoped owner passes, preserves original terms and rejects third-booking cascade', async t => {
  const f = await fixture(t, { third: true }), a = await f.authorize(), b = await f.authorize('artist-b');
  const original = JSON.stringify(f.bookings);
  await assert.rejects(f.send(a, 'reserve-next', { nextBookingId: 'artist-b', nextToken: a.token, expectedNextRevision: 0 }), /exact next/);
  await f.send(a, 'reserve-next', { nextBookingId: 'artist-b', nextToken: b.token, expectedNextRevision: 0 });
  assert.equal((await f.state(b)).broadcast.plannedStartAt, START + 25 * MIN);
  await assert.rejects(f.send(a, 'encore', { additionalMs: 10 * MIN, nextToken: b.token }), /third-booking/);
  assert.equal((await f.state(a)).broadcast.encoreMs, 0);
  assert.equal(JSON.stringify(f.bookings), original);
  assert.doesNotMatch(JSON.stringify(f.saved()), new RegExp(a.token + '|' + b.token));
});

test('approved encore survives original end, old passes keep their expiry, and existing publication is not cleaned up', async t => {
  const f = await fixture(t), a = await f.authorize(), b = await f.authorize('artist-b');
  await f.direction(a, 'message', { text: 'Private session continues into the approved encore' });
  await f.send(a, 'reserve-next', { nextBookingId: 'artist-b', nextToken: b.token, expectedNextRevision: 0 });
  await f.send(a, 'encore', { additionalMs: 10 * MIN, nextToken: b.token });
  await assert.rejects(f.send(a, 'encore', { additionalMs: 1, nextToken: b.token }), /ten cumulative/);
  assert.equal(a.expiresAt, START + 20 * MIN);
  const allocatedPass = await f.authorize();
  assert.ok(allocatedPass.expiresAt > a.expiresAt);
  f.at(START + 20 * MIN); f.feed('artist-a'); f.feed('artist-b'); await f.service.tick();
  await assert.rejects(f.state(a), /expired/);
  const active = await f.service.current();
  assert.equal(active.bookingId, 'artist-a');
  assert.equal(active.phase, 'live');
  assert.equal(active.endUtc, new Date(START + 20 * MIN).toISOString());
  assert.equal(active.broadcast.authorizedEndAt, START + 30 * MIN);
  assert.equal(f.closed.includes('artist-a'), false);
  assert.equal((await f.service.listener('artist-a')).end, START + 30 * MIN);
  await assert.rejects(f.service.listener('artist-b'), /unavailable/);
  const backstage = await f.service.command(allocatedPass.token, { action: 'direction-state' }, ORIGIN);
  assert.equal(backstage.chat.expiresAt, active.broadcast.accessUntil);
  assert.equal(backstage.messages.length, 1, 'allocation refresh does not discard the same live-session chat');
  const cue = await f.direction(allocatedPass, 'cue', { kind: 'wrap-up' });
  assert.ok(cue.state.cue.expiresAt > Date.parse(active.endUtc));
  assert.doesNotMatch(JSON.stringify(active), /Private session continues|messages|cue/);
  for (const status of ['approved', 'paid']) {
    f.bookings[0].status = status;
    f.at(START + (status === 'paid' ? 22 : 21) * MIN); f.feed('artist-a'); await f.service.tick();
    assert.equal((await f.service.current()).bookingVerification.fresh, true);
    assert.equal((await f.service.current()).phase, 'live');
    assert.equal(f.service.completionState('artist-a').pending, true, 'financial settlement is not musical completion');
    const reentered = await f.authorize('artist-a', A);
    assert.equal(reentered.state.broadcast.phase, 'live');
    assert.equal(reentered.canPublish, true);
  }
});

test('delayed full set gets its own ten-minute encore and graceful finish is separate from advisory declarations', async t => {
  const f = await fixture(t), a = await f.authorize(), b = await f.authorize('artist-b');
  const pa = await f.authorize('artist-a', A), pb = await f.authorize('artist-b', B);
  await f.send(a, 'reserve-next', { nextBookingId: 'artist-b', nextToken: b.token, expectedNextRevision: 0 });
  await f.send(a, 'encore', { additionalMs: 10 * MIN, nextToken: b.token });
  await f.direction(pa, 'finished');
  await assert.rejects(f.send(a, 'end', { mode: 'normal', confirmed: true }), /performer finished/);
  await f.send(pa, 'finished');
  await f.send(a, 'end', { mode: 'normal', confirmed: true });
  assert.equal((await f.service.state('artist-a')).broadcast.endReason, 'producer-finished');
  await f.send(pb, 'choice', { choice: 'full' });
  f.at(START + 33 * MIN); f.feed('artist-b'); await f.service.tick();
  await f.direction(pb, 'readiness', { ready: true });
  await f.send(b, 'take', { confirmed: true });
  const allocatedB = await f.authorize('artist-b');
  assert.equal((await f.state(allocatedB)).broadcast.effectiveSetEndAt, START + 53 * MIN);
  await f.send(allocatedB, 'encore', { additionalMs: 10 * MIN });
  assert.equal((await f.state(allocatedB)).broadcast.authorizedEndAt, START + 63 * MIN);
  assert.equal(f.service.completionState('artist-b').pending, true);
  assert.equal(f.bookings[1].endUtc, new Date(START + 40 * MIN).toISOString());
  assert.equal(f.bookings[1].amountUnits, '20000000');
});

test('artist may choose a shortened delayed set without a fee penalty; reinvite is evidence only', async t => {
  const f = await fixture(t), a = await f.authorize(), b = await f.authorize('artist-b'), pb = await f.authorize('artist-b', B);
  await f.send(a, 'reserve-next', { nextBookingId: 'artist-b', nextToken: b.token, expectedNextRevision: 0 });
  await assert.rejects(f.send(b, 'choice', { choice: 'short', durationMs: 10 * MIN }), /booking role/);
  await f.send(pb, 'choice', { choice: 'short', durationMs: 10 * MIN });
  await f.send(a, 'end', { mode: 'operator-cut', confirmed: true });
  f.at(START + 26 * MIN); f.feed('artist-b');
  await f.direction(pb, 'readiness', { ready: true });
  await f.send(b, 'take', { confirmed: true });
  f.at(START + 35 * MIN); f.feed('artist-b');
  await f.send(pb, 'finished');
  await f.send(b, 'end', { mode: 'normal', confirmed: true });
  assert.equal(f.service.completionState('artist-b').priorityFollowup, true);
  assert.equal(f.bookings.length, 2);
  assert.equal(f.bookings[1].amountUnits, '20000000');
  assert.equal(f.cancellations.length, 0);
});

test('declining a delayed set is performer-only, terminal and does not cancel the guaranteed booking', async t => {
  const f = await fixture(t), a = await f.authorize(), b = await f.authorize('artist-b'), pb = await f.authorize('artist-b', B);
  await f.send(a, 'reserve-next', { nextBookingId: 'artist-b', nextToken: b.token, expectedNextRevision: 0 });
  await assert.rejects(f.send(b, 'choice', { choice: 'decline' }), /booking role/);
  await f.send(pb, 'choice', { choice: 'decline' });
  assert.equal((await f.service.state('artist-b')).broadcast.endReason, 'declined');
  assert.equal(f.service.completionState('artist-b').pending, false);
  assert.equal(f.bookings[1].status, 'funded');
  assert.equal(f.bookings[1].amountUnits, '20000000');
  assert.equal(f.bookings[1].cancelled, undefined);
  await assert.rejects(f.send(pb, 'choice', { choice: 'full' }), /already ended/);
  await assert.rejects(f.service.command(pb.token, { action: 'direction-state' }, ORIGIN), /closed/);
});

test('allocated end uses actual-end outro and a waiting next act never becomes an automatic broadcast', async t => {
  const f = await fixture(t), a = await f.authorize(), b = await f.authorize('artist-b');
  await f.send(a, 'reserve-next', { nextBookingId: 'artist-b', nextToken: b.token, expectedNextRevision: 0 });
  await f.send(a, 'end', { mode: 'operator-cut', confirmed: true });
  const ended = await f.service.state('artist-a');
  assert.equal(ended.broadcast.actualEndedAt, START + 5 * MIN);
  assert.equal(ended.policy.breakKind, 'outro');
  assert.equal(ended.policy.advertsEndAt, START + 10 * MIN);
  assert.equal((await f.service.current()).bookingId, 'artist-a');
  f.at(START + 21 * MIN); f.feed('artist-b'); await f.service.tick();
  const waiting = await f.service.current();
  assert.equal(waiting.bookingId, 'artist-b');
  assert.equal(waiting.phase, 'preflight');
  assert.equal(waiting.policy.breakKind, 'waiting');
  await assert.rejects(f.service.listener('artist-b'), /unavailable/);
  assert.equal(f.service.completionState('artist-b').pending, true);
});

test('allocated original-end deployment stays blocked until both pair allocations are durably terminal', async t => {
  let recordingProofs = 0;
  const f = await fixture(t, { recorder: { available: false, status: () => ({}),
    tick: async () => {}, prepareDeployment: async () => { recordingProofs++; return { ready: true, recordingCheckpointVerified: true }; } } });
  const a = await f.authorize(), b = await f.authorize('artist-b');
  await f.send(a, 'reserve-next', { nextBookingId: 'artist-b', nextToken: b.token, expectedNextRevision: 0 });
  await f.send(a, 'encore', { additionalMs: 10 * MIN, nextToken: b.token });
  const renewed = await f.authorize(), pb = await f.authorize('artist-b', B);
  f.at(START + 21 * MIN); f.feed('artist-a'); f.feed('artist-b'); await f.service.tick();
  const lease = { action: 'drain', id: 'deployment-proof', expiresAt: START + 35 * MIN };
  assert.deepEqual(f.service.broadcastDeploymentState(), { known: true, pending: true });
  assert.equal((await f.service.prepareDeployment(lease)).ready, false);
  await f.send(renewed, 'end', { mode: 'operator-cut', confirmed: true });
  assert.equal((await f.service.prepareDeployment(lease)).ready, false);
  await f.send(pb, 'choice', { choice: 'decline' });
  assert.deepEqual(f.service.broadcastDeploymentState(), { known: true, pending: false });
  assert.equal((await f.service.prepareDeployment(lease)).recordingCheckpointVerified, true);
  assert.equal(recordingProofs, 1);
});

test('invalid and repeated end decisions do not acquire new paid-playback holds', async t => {
  let holds = 0;
  const f = await fixture(t, { handoff: async apply => { holds++; return apply(); } }), a = await f.authorize();
  await f.send(a, 'enable');
  await assert.rejects(f.send(a, 'end', { mode: 'normal', confirmed: true }), /performer finished/);
  assert.equal(holds, 0);
  const command = { action: 'broadcast-end', commandId: 'one-terminal-decision',
    expectedRevision: 1, mode: 'operator-cut', confirmed: true };
  assert.equal((await f.service.command(a.token, command, ORIGIN)).applied, true);
  assert.equal((await f.service.command(a.token, command, ORIGIN)).applied, false);
  assert.equal(holds, 1);
});

test('durable decisions deduplicate across restart and expired authorization cannot be reopened', async t => {
  const f = await fixture(t), a = await f.authorize();
  const input = { action: 'broadcast-enable', commandId: 'durable-command-one', expectedRevision: 0 };
  const once = await f.service.command(a.token, input, ORIGIN);
  assert.equal(once.applied, true);
  const { createLiveAudioService } = await import('../discord-bot/live-audio.js');
  const next = createLiveAudioService(f.args); t.after(() => next.stop());
  const auth = await f.authorize('artist-a', OWNER, next);
  assert.equal((await next.command(auth.token, input, ORIGIN)).applied, false);
  assert.equal((await next.state('artist-a')).broadcast.revision, 1);
  f.at(START + 20 * MIN); f.feed('artist-a'); await next.tick();
  assert.equal((await next.state('artist-a')).broadcast.endReason, 'authorization-expired');
  assert.equal(f.service.completionState('artist-a').pending, true, 'old worker does not invent another worker completion');
  await assert.rejects(next.command(auth.token, { action: 'broadcast-encore', additionalMs: MIN,
    commandId: 'after-deadline', expectedRevision: 2 }, ORIGIN), /already ended|expired/);
});

test('verified audio loss cancels an allocated act at fifteen seconds and never reports graceful success', async t => {
  const f = await fixture(t), a = await f.authorize();
  await f.send(a, 'enable');
  f.at(START + 5 * MIN + 14999); await f.service.tick();
  assert.equal(f.cancellations.length, 0);
  f.at(START + 5 * MIN + 15000); await f.service.tick();
  assert.equal((await f.service.state('artist-a')).broadcast.endReason, 'audio-loss');
  assert.equal(f.cancellations.length, 1);
  assert.equal(f.cancellations[0][0].broadcast.endReason, 'audio-loss', 'server wiring can keep allocated broadcast and financial cancellation separate');
  assert.equal(f.bookings[0].amountUnits, '20000000');
});

test('a set the performer declared finished closes as the normal ending when its audio goes quiet, never as an audio-loss cancellation', async t => {
  const f = await fixture(t), a = await f.authorize(), pa = await f.authorize('artist-a', A);
  await f.send(a, 'enable');
  await f.send(pa, 'finished');
  f.at(START + 6 * MIN); f.feed('artist-a'); await f.service.tick();
  assert.equal((await f.service.state('artist-a')).broadcast.phase, 'live', 'the finished note does not stop the microphone or the broadcast');
  f.at(START + 6 * MIN + 14999); await f.service.tick();
  assert.equal((await f.service.state('artist-a')).broadcast.phase, 'live', 'the new fifteen-second grace has not expired');
  f.at(START + 6 * MIN + 15000); await f.service.tick();
  const ended = (await f.service.state('artist-a')).broadcast;
  assert.equal(ended.endReason, 'producer-finished');
  assert.equal(ended.actualEndedAt, START + 6 * MIN, 'the set ended when its audio stopped, not when the silence was noticed');
  assert.equal(f.cancellations.length, 0);
  assert.equal(f.service.completionState('artist-a').pending, false);
  assert.equal(f.service.completionState('artist-a').endReason, 'producer-finished');
  assert.equal(f.bookings[0].amountUnits, '20000000');
});

test('an approved encore withdraws the finished declaration, so a silent room is an audio fault again', async t => {
  const f = await fixture(t), a = await f.authorize(), b = await f.authorize('artist-b'), pa = await f.authorize('artist-a', A);
  await f.send(a, 'enable');
  await f.send(a, 'reserve-next', { nextBookingId: 'artist-b', nextToken: b.token, expectedNextRevision: 0 });
  await f.send(pa, 'finished');
  await f.send(a, 'encore', { additionalMs: 5 * MIN, nextToken: b.token });
  f.at(START + 6 * MIN); await f.service.tick();
  assert.equal((await f.service.state('artist-a')).broadcast.endReason, 'audio-loss');
  assert.equal(f.cancellations.length, 1);
});

test('production wiring preserves legacy schedule cancellation but never treats allocated audio loss as financial cancellation', async () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../discord-bot/index.js'), 'utf8');
  const callback = source.match(/onCancel: (\(booking, reason\) => [\s\S]*?),\n\s+}\);/);
  assert.ok(callback);
  const calls = [];
  const onCancel = require('node:vm').runInNewContext(`(${callback[1]})`, {
    liveBookings: { execute: async value => { calls.push(value); } },
  });
  await onCancel({ id: 'allocated', broadcast: { endReason: 'audio-loss' } }, 'No audio');
  assert.equal(calls.length, 0);
  await onCancel({ id: 'legacy' }, 'No audio');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'cancel');
  assert.equal(calls[0].id, 'legacy');
});

test('failed end persistence cannot commit a false successful terminal state', async t => {
  const f = await fixture(t), a = await f.authorize();
  await f.send(a, 'enable');
  const before = f.saved();
  f.store.save = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(f.send(a, 'end', { mode: 'operator-cut', confirmed: true }), /checkpoint failed/);
  assert.deepEqual(f.saved(), before);
  assert.equal((await f.service.state('artist-a')).configured, false);
});

test('a failed end recovers only canonical durable state and requires fresh passes instead of locking later acts forever', async t => {
  const f = await fixture(t), a = await f.authorize(), b = await f.authorize('artist-b');
  await f.send(a, 'reserve-next', { nextBookingId: 'artist-b', nextToken: b.token, expectedNextRevision: 0 });
  const save = f.store.save, restore = f.store.restore;
  f.store.save = async () => { throw Error('checkpoint outage'); };
  await assert.rejects(f.send(a, 'end', { mode: 'operator-cut', confirmed: true }), /checkpoint failed/);
  assert.equal(f.policies.at(-1).mode, 'fault');
  f.store.restore = async () => { throw Error('verification outage'); };
  await f.service.tick();
  assert.equal(f.service.configured, false);
  assert.equal(f.service.completionState('artist-a').known, false);
  f.store.save = save; f.store.restore = restore;
  await f.service.tick();
  assert.equal(f.service.configured, true);
  assert.equal(f.service.completionState('artist-a').pending, true);
  await assert.rejects(f.state(a), /expired/);
  const renewed = await f.authorize(), performerB = await f.authorize('artist-b', B);
  f.feed('artist-a');
  await f.send(renewed, 'end', { mode: 'operator-cut', confirmed: true });
  assert.equal(f.service.completionState('artist-a').pending, false);
  await f.send(performerB, 'choice', { choice: 'full' });
  f.at(START + 21 * MIN); f.feed('artist-b');
  await f.direction(performerB, 'readiness', { ready: true });
  const nextOwner = await f.authorize('artist-b');
  await f.send(nextOwner, 'take', { confirmed: true });
  assert.equal((await f.service.current()).bookingId, 'artist-b');
});
