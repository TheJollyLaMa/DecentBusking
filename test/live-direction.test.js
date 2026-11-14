const test = require('node:test');
const assert = require('node:assert/strict');

const START = Date.parse('2026-11-20T02:00:00Z');
const owner = `0x${'1'.repeat(40)}`, artist = `0x${'2'.repeat(40)}`;

async function setup(t) {
  const { createLiveDirection, LIVE_DIRECTION_LIMITS } = await import('../discord-bot/live-direction.js');
  let at = START, id = 0;
  const direction = createLiveDirection({ now: () => at });
  t.after(() => direction.clear());
  const booking = { id: 'artist-a', wallet: artist, startUtc: new Date(START).toISOString(),
    endUtc: new Date(START + 20 * 60000).toISOString(), status: 'funded' };
  const session = role => ({ bookingId: booking.id, role: role === 'owner' ? 'owner' : 'publisher',
    wallet: role === 'owner' ? owner : artist });
  const call = (role, input, b = booking) => direction.command({ booking: b, session: session(role), input });
  const state = (role = 'owner', cursor) => call(role, { action: 'direction-state', ...(cursor ? { cursor } : {}) });
  const send = (role, action, payload = {}) => {
    const s = state(role);
    return call(role, { action: `direction-${action}`, epoch: s.epoch,
      ...(action !== 'heartbeat' ? { commandId: `command-${++id}` } : {}),
      ...(!['heartbeat', 'message'].includes(action) ? { expectedRevision: s.revision } : {}), ...payload });
  };
  return { direction, booking, session, call, state, send, limits: LIVE_DIRECTION_LIMITS,
    time: value => { at = value; }, restart: () => {
      const next = createLiveDirection({ now: () => at });
      t.after(() => next.clear());
      return next;
    } };
}

test('private direction starts unknown with exact owner/performer capabilities and no time-changing controls', async t => {
  const f = await setup(t), state = f.state(), performer = f.state('artist');
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.bookingId, f.booking.id);
  assert.equal(state.revision, 0);
  assert.deepEqual(state.performerPresence, { lastSeenAt: null, expiresAt: null });
  assert.deepEqual(state.readiness, { ready: null, updatedAt: null, expiresAt: null });
  assert.equal(state.cue, null); assert.equal(state.finished, null); assert.equal(state.delay, null);
  assert.deepEqual(state.messages, []);
  assert.equal(state.chat.persistence, 'memory-only');
  assert.equal(state.chat.expiresAt, Date.parse(f.booking.endUtc));
  assert.equal(state.capabilities.cue, true);
  assert.equal(state.capabilities.notifyDelay, true);
  assert.equal(state.capabilities.acknowledgeCue, false);
  assert.equal(state.capabilities.declareFinished, false);
  assert.equal(performer.capabilities.cue, false);
  assert.equal(performer.capabilities.acknowledgeCue, true);
  assert.equal(performer.capabilities.declareFinished, true);
  assert.equal(state.capabilities.endBroadcast, false);
  assert.equal(state.capabilities.takeLive, false);
  assert.equal(state.limits.pollIntervalMs, 3000);
});

test('private direction rejects wrong roles, caller-selected rooms, forged roles and time controls', async t => {
  const f = await setup(t);
  for (const action of ['heartbeat', 'readiness', 'finished', 'acknowledge-cue', 'acknowledge-delay']) {
    assert.throws(() => f.send('owner', action), e => e.status === 403);
  }
  for (const action of ['cue', 'notify-delay']) assert.throws(() => f.send('artist', action), e => e.status === 403);
  assert.throws(() => f.call('owner', { action: 'direction-state', bookingId: 'other' }), e => e.status === 403);
  assert.throws(() => f.direction.command({ booking: f.booking,
    session: { bookingId: 'other', role: 'owner', wallet: owner }, input: { action: 'direction-state' } }), e => e.status === 403);
  assert.throws(() => f.direction.command({ booking: f.booking,
    session: { bookingId: f.booking.id, role: 'publisher', wallet: owner }, input: { action: 'direction-state' } }), e => e.status === 403);
  assert.throws(() => f.send('artist', 'message', { text: 'private', senderRole: 'owner' }), /Unexpected/);
  for (const action of ['end-broadcast', 'take-live', 'extend']) assert.throws(() => f.send('owner', action), /Unknown/);
});

test('cue acknowledgement, finished declaration and delay receipt remain independent', async t => {
  const f = await setup(t);
  const cue = f.send('owner', 'cue', { kind: 'wrap-up' }).state.cue;
  f.send('artist', 'acknowledge-cue', { cueId: cue.id });
  let state = f.state();
  assert.equal(state.cue.acknowledgedAt, START);
  assert.equal(state.finished, null);
  assert.equal(state.readiness.ready, null);
  const delay = f.send('owner', 'notify-delay', { status: 'stand-by' }).state.delay;
  assert.equal(delay.estimatedStartUtc, null);
  assert.equal(delay.expiresAt, Date.parse(f.booking.endUtc));
  f.send('artist', 'acknowledge-delay', { noticeId: delay.id });
  assert.equal(f.state().finished, null);
  f.send('artist', 'finished');
  state = f.state();
  assert.equal(state.finished.at, START);
  assert.equal(state.delay.acknowledgedAt, START);
  assert.equal(state.capabilities.endBroadcast, false);
  assert.equal(f.booking.endUtc, new Date(START + 20 * 60000).toISOString());
});

test('direction commands are idempotent before revision checks and reject ID reuse and stale decisions', async t => {
  const f = await setup(t), initial = f.state();
  const input = { action: 'direction-cue', kind: 'another-song', epoch: initial.epoch,
    expectedRevision: initial.revision, commandId: 'stable-command' };
  assert.equal(f.call('owner', input).applied, true);
  assert.equal(f.call('owner', input).applied, false);
  assert.equal(f.state().revision, 1);
  assert.throws(() => f.call('owner', { ...input, kind: 'wrap-up' }), e => e.code === 'DIRECTION_ID_REUSED');
  assert.throws(() => f.call('owner', { ...input, commandId: 'another-command' }), e => e.code === 'DIRECTION_STALE');
  assert.throws(() => f.send('owner', 'cue', { kind: 'wrap-up', expectedRevision: -1 }), /revision/);
  const newer = f.send('owner', 'cue', { kind: 'wrap-up' });
  assert.throws(() => f.send('artist', 'acknowledge-cue', { cueId: 'stable-command' }), /superseded/);
  f.time(START + f.limits.cueTtlMs);
  assert.throws(() => f.send('artist', 'acknowledge-cue', { cueId: newer.state.cue.id }), /expired/);
});

test('only performer heartbeats establish presence and refresh still-fresh readiness without revision churn', async t => {
  const f = await setup(t);
  f.state(); f.state('artist');
  assert.equal(f.state().performerPresence.lastSeenAt, null);
  f.send('artist', 'readiness', { ready: true });
  const revision = f.state().revision;
  assert.equal(f.state().performerPresence.lastSeenAt, null, 'readiness does not invent a heartbeat');
  f.time(START + 15000);
  f.send('artist', 'heartbeat');
  assert.equal(f.state().performerPresence.lastSeenAt, START + 15000);
  assert.equal(f.state().performerPresence.expiresAt, START + 45000);
  assert.equal(f.state().readiness.expiresAt, START + 75000);
  assert.equal(f.state().revision, revision);
  f.send('owner', 'message', { text: 'Stay ready, timing unchanged.' });
  assert.equal(f.state().revision, revision);
  f.time(START + 75000);
  assert.equal(f.state().readiness.ready, null);
  f.send('artist', 'heartbeat');
  assert.equal(f.state().readiness.ready, null, 'an expired declaration is never revived by reconnecting');
  f.send('artist', 'readiness', { ready: false });
  assert.equal(f.state().readiness.ready, false);
  assert.equal(f.state().revision, revision + 1);
});

test('chat is plain text with bounded messages and snapshots cannot mutate server state', async t => {
  const f = await setup(t);
  f.send('owner', 'message', { text: '  <script>not markup</script>\r\nArtist A only  ', commandId: 'message-once' });
  const s = f.state();
  assert.equal(s.messages[0].text, '<script>not markup</script>\nArtist A only');
  assert.equal(s.messages[0].senderRole, 'owner');
  const retry = f.send('owner', 'message', { text: '  <script>not markup</script>\r\nArtist A only  ', commandId: 'message-once' });
  assert.equal(retry.applied, false);
  assert.equal(retry.state.messages.length, 1);
  assert.equal(f.state('artist', s.cursor).messages.length, 0);
  f.send('artist', 'message', { text: 'I can hear you.' });
  assert.equal(f.state('owner', s.cursor).messages[0].senderRole, 'performer');
  assert.throws(() => f.send('owner', 'message', { text: 'x'.repeat(501) }), /length limit/);
  assert.throws(() => f.send('owner', 'message', { text: '\u0000secret' }), /plain text/);
  assert.throws(() => f.send('owner', 'message', { text: ' ' }), /plain text/);
  s.messages[0].text = 'mutated';
  s.capabilities.cue = false;
  assert.match(f.state().messages[0].text, /Artist A only/);
  assert.equal(f.state().capabilities.cue, true);
});

test('bookings have isolated transcripts and per-booking cursor sequences', async t => {
  const f = await setup(t);
  f.send('owner', 'message', { text: 'Private artist A note' });
  const b = { ...f.booking, id: 'artist-b', wallet: `0x${'3'.repeat(40)}` };
  const input = { action: 'direction-state' };
  const s = f.direction.command({ booking: b, session: { bookingId: b.id, role: 'owner', wallet: owner }, input });
  assert.deepEqual(s.messages, []);
  assert.equal(s.cursor.sequence, 0);
  assert.equal(s.performerPresence.lastSeenAt, null);
  assert.equal(f.state().cursor.sequence, 1);
});

test('restart requires a new epoch, reports cursor reset and retains no private conversation', async t => {
  const f = await setup(t);
  f.send('owner', 'message', { text: 'Must not survive restart' });
  f.send('artist', 'readiness', { ready: true });
  f.send('owner', 'cue', { kind: 'another-song' });
  const old = f.state(), restarted = f.restart();
  const next = restarted.command({ booking: f.booking, session: f.session('owner'),
    input: { action: 'direction-state', cursor: old.cursor } });
  assert.notEqual(next.epoch, old.epoch);
  assert.equal(next.resetRequired, true);
  assert.equal(next.revision, 0);
  assert.deepEqual(next.messages, []);
  assert.equal(next.cue, null);
  assert.equal(next.readiness.ready, null);
  assert.throws(() => restarted.command({ booking: f.booking, session: f.session('owner'),
    input: { action: 'direction-message', text: 'Do not resend', commandId: 'old-command', epoch: old.epoch } }),
  e => e.code === 'DIRECTION_RESET');
});

test('chat rate limits and retained ring bounds are explicit without forgetting command IDs', async t => {
  const f = await setup(t);
  let first;
  for (let n = 0; n < 101; n++) {
    f.time(START + Math.floor(n / 20) * 61000);
    const result = f.send('owner', 'message', { text: `Message ${n}`, commandId: `message-${String(n).padStart(4, '0')}` });
    first ||= result.state.cursor;
    if (n === 19) assert.throws(() => f.send('owner', 'message', { text: 'Too many' }), e => e.status === 429);
  }
  const state = f.state('owner', { epoch: first.epoch, sequence: 0 });
  assert.equal(state.messages.length, 100);
  assert.equal(state.messages[0].text, 'Message 1');
  assert.equal(state.resetRequired, true);
  const retry = f.send('owner', 'message', { text: 'Message 0', commandId: 'message-0000' });
  assert.equal(retry.applied, false);
  assert.equal(retry.state.messages.length, 100);
});

test('message TTL, booked end, cancellation and explicit clear remove private state', async t => {
  const f = await setup(t);
  f.booking.endUtc = new Date(START + 60 * 60000).toISOString();
  f.send('owner', 'message', { text: 'Short retention' });
  const cursor = f.state().cursor;
  f.time(START + f.limits.messageRetentionMs);
  assert.equal(f.state('owner', cursor).messages.length, 0);
  assert.equal(f.state('owner', { ...cursor, sequence: 0 }).resetRequired, true);
  f.send('owner', 'message', { text: 'Cancel removes this too' });
  f.direction.prune([{ ...f.booking, cancelled: true }]);
  assert.equal(f.state().messages.length, 0);
  f.send('owner', 'message', { text: 'Explicit stop' });
  f.direction.clear();
  assert.equal(f.state().messages.length, 0);
  f.time(Date.parse(f.booking.endUtc) - 1000);
  const cue = f.send('owner', 'cue', { kind: 'wrap-up' }).state.cue;
  assert.equal(cue.expiresAt, Date.parse(f.booking.endUtc));
  f.time(Date.parse(f.booking.endUtc));
  assert.throws(() => f.state(), e => e.code === 'DIRECTION_CLOSED');
});

test('direction rejects malformed inputs, invalid cursors and pre-show finished declarations', async t => {
  const f = await setup(t);
  for (const input of [null, [], { action: 'direction-state', cursor: { epoch: 'x', sequence: -1 } },
    { action: 'direction-state', cursor: { epoch: 'x', sequence: 1, injected: true } }]) {
    assert.throws(() => f.call('owner', input), /private|direction/i);
  }
  for (const [action, payload] of [['cue', { kind: 'extend-ten-minutes' }], ['notify-delay', { status: 'approved-new-start' }],
    ['readiness', { ready: 'yes' }]]) {
    assert.throws(() => f.send(action === 'readiness' ? 'artist' : 'owner', action, payload), /Invalid/);
  }
  f.time(START - 1);
  assert.throws(() => f.send('artist', 'finished'), /booked start/);
});

test('bounded command receipts reject overflow without allowing an old ID to replay', async t => {
  const f = await setup(t), initial = f.state();
  for (let n = 0; n < f.limits.maxCommands; n++) {
    f.time(START + Math.floor(n / 30) * 61000);
    f.send('owner', 'cue', { kind: 'wrap-up', commandId: `bounded-${n}` });
  }
  assert.throws(() => f.send('owner', 'cue', { kind: 'wrap-up' }), e => e.code === 'DIRECTION_CAPACITY');
  const duplicate = f.call('owner', { action: 'direction-cue', epoch: initial.epoch,
    commandId: 'bounded-0', expectedRevision: 0, kind: 'wrap-up' });
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.state.revision, f.limits.maxCommands);
  assert.equal(duplicate.state.cue.id, `bounded-${f.limits.maxCommands - 1}`);
  assert.equal(f.send('artist', 'heartbeat').state.performerPresence.lastSeenAt,
    START + Math.floor((f.limits.maxCommands - 1) / 30) * 61000);
});

test('room memory capacity is bounded and expired rooms release their allocation', async t => {
  const f = await setup(t);
  const open = id => f.direction.command({ booking: { ...f.booking, id },
    session: { bookingId: id, wallet: owner, role: 'owner' }, input: { action: 'direction-state' } });
  for (let n = 0; n < f.limits.maxRooms; n++) open(`capacity-${n}`);
  assert.throws(() => open('overflow'), e => e.code === 'DIRECTION_CAPACITY');
  f.time(Date.parse(f.booking.endUtc));
  f.direction.prune();
  f.booking.endUtc = new Date(START + 40 * 60000).toISOString();
  assert.equal(open('next-show').bookingId, 'next-show');
});
