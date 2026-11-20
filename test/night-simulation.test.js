const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { join } = require('node:path');
const fs = require('node:fs');
const { Wallet } = require('../discord-bot/node_modules/ethers');

const directory = join(__dirname, `.night-simulation-fixtures-${process.pid}`);
fs.mkdirSync(directory, { recursive: true });
process.env.JUKELOOP_PLAYLIST_PATH = join(directory, 'playlist.json');
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

const SEC = 1000, MIN = 60 * SEC;
// Friday 20 November 2026, 21:00 New York (EST): the real Live #2 slot. Act A 21:00-21:20, act B 21:20-21:40.
const START = Date.parse('2026-11-21T02:00:00Z');
const OWNER = `0x${'1'.repeat(40)}`, ORIGIN = 'https://radio.example';
const PROGRAM = { leadInSeconds: 120, outroSeconds: 300 };
const wallets = { 'act-a': Wallet.createRandom(), 'act-b': Wallet.createRandom() };
const pcm = () => ({ sampleRate: 48000, channels: 1, data: new Int16Array(48000), samplesPerChannel: 48000 });
const at = ms => `T${ms >= START ? '+' : '-'}${Math.floor(Math.abs(ms - START) / MIN)}:${String(Math.floor(Math.abs(ms - START) % MIN / SEC)).padStart(2, '0')}`;

// Real production modules on a fake clock: the live-audio service (state machine, policy, admission), the real
// recorder, the real JukeLoopSession radio. Only transport, storage, uploads and wall-clock time are doubles.
async function night(t, { programs = { 'act-a': PROGRAM, 'act-b': PROGRAM }, recovery = false, assets = false } = {}) {
  const clock = { now: START - 75 * MIN };
  t.mock.method(Date, 'now', () => clock.now);
  const { createLiveAudioService } = await import('../discord-bot/live-audio.js');
  const { createLiveRecorder } = await import('../discord-bot/live-recording.js');
  const recordingConsent = await import('../js/live-recording-consent.mjs');
  const { JukeLoopSession } = await import('../discord-bot/jukeloop.js');
  const iso = ms => new Date(ms).toISOString();
  const booking = (id, start) => ({ id, eventId: `friday-live:${id}`, wallet: wallets[id].address, title: `Act ${id}`,
    displayName: `Act ${id}`, startUtc: iso(start), endUtc: iso(start + 20 * MIN),
    payoutPolicy: assets ? 'asset-guaranteed-v1' : 'pilot-guaranteed-v1',
    status: 'funded', acknowledged: true, amountUnits: assets ? '20000000000000000' : '20000000', mode: 'phase1' });
  const world = {
    bookings: [booking('act-a', START), booking('act-b', START + 20 * MIN)],
    saved: { version: 1, rooms: [] }, journal: { version: 1, recordings: [] },
    uploads: [], ingests: [], cancellations: [], closed: [], timeline: [], violations: [], cuts: [], errors: [],
    playing: new Set(), onAir: new Set(), paid: { queue: ['paid-1', 'paid-2'], released: [] },
  };
  const original = JSON.stringify(world.bookings);
  const processes = [];
  let proc, count = 0;

  async function boot() {
    const receivers = new Map();
    const player = new EventEmitter();
    player.state = { status: 'idle' }; player.play = () => {}; player.stop = () => {};
    const session = new JukeLoopSession({ client: {}, audioPlayer: player, websitePlayback: true,
      djuke: { hasActivePlaylist: () => false, getActivePlaylistBatchId: () => null, hasPendingSelection: () => false,
        release: async record => { world.paid.released.push(record.requestId); } } });
    session.setLivePerformanceEvents(world.bookings.map(b => ({ id: b.eventId, type: 'live_performance', title: b.title,
      startUtc: b.startUtc, endUtc: b.endUtc, status: 'scheduled' })));
    const recorder = createLiveRecorder({ enabled: true, segmentSeconds: 10, now: () => clock.now,
      ...(recovery ? { persistFrameTimes: true, submitRelease: async () => { throw Error('A performer-approved release is required'); } } : {}),
      store: { restore: async () => structuredClone(world.journal), save: async value => { world.journal = structuredClone(value); } },
      upload: async (bytes, name) => {
        world.uploads.push({ name, bytes: bytes.length, at: clock.now });
        return `ipfs://${createHash('sha256').update(bytes).digest('hex')}`;
      },
      download: async () => Buffer.from('unused'),
      encode: async segments => Buffer.from(JSON.stringify(segments)),
      ingest: async value => {
        world.ingests.push({ id: value.booking.id, incomplete: value.incomplete, seconds: value.durationSeconds, at: clock.now });
        return { trackId: `track:${value.booking.id}` };
      },
      log: { error: (...args) => world.errors.push(args.join(' ')) } });
    await recorder.initialize();
    const transport = { ready: true, ingressEnabled: false, listenerLimit: 10,
      monitor: async (b, frame, onPcm) => { receivers.set(b.id, { frame, pcm: onPcm }); },
      connect: async b => ({ expiresAt: b.broadcast?.accessUntil || Date.parse(b.endUtc) }),
      listener: async b => ({ bookingId: b.id, end: b.broadcast?.authorizedEndAt || Date.parse(b.endUtc) }),
      suspendListeners: async () => {}, resumeListeners: () => {},
      close: async b => { world.closed.push({ id: b.id, at: clock.now }); }, stop: async () => {} };
    const service = createLiveAudioService({ getBookings: async () => ({ bookings: world.bookings }), ownerWallet: OWNER,
      store: { restore: async () => structuredClone(world.saved), save: async value => { world.saved = structuredClone(value); } },
      transport, recorder, programs, recoveryEnabled: recovery, now: () => clock.now, verify: (_message, signature) => signature,
      onPolicy: policy => session.setLiveAudioPolicy(policy),
      onCancel: (b, reason) => world.cancellations.push({ id: b.id, reason }),
      withBroadcastHandoff: (apply, safety) => session.withBroadcastHandoff(apply, safety) });
    proc = { receivers, session, recorder, service };
    processes.push(proc);
  }
  t.after(async () => { for (const p of processes) { p.session.destroy(); await p.service.stop(); } });

  const showKey = show => show.type === 'live_performance' ? `live:${(show.event?.id || show.id).replace('friday-live:', '')}`
    : show.type === 'live_audio_ads' ? show.id.replace(/^live-/, '').replace('-ads', '')
      : show.type === 'normal_rotation' ? /Waiting/.test(show.label || '') ? 'radio:waiting' : 'radio' : show.type;
  const room = id => world.saved.rooms.find(r => r.bookingId === id);
  const endReason = id => room(id)?.allocation?.endReason || (room(id)?.cancelledAt ? 'cancelled' : 'booked-end');

  function observe() {
    const key = showKey(proc.session.getShowState().activeShow);
    if (world.timeline.at(-1)?.key !== key) world.timeline.push({ at: clock.now, key });
    const running = world.saved.rooms.filter(r => r.allocation?.startedAt && !r.allocation.endedAt && !r.cancelledAt);
    if (running.length > 1) world.violations.push(`${at(clock.now)} two allocated acts are on air`);
    const spans = world.saved.rooms.filter(r => r.allocation?.startedAt)
      .map(r => ({ id: r.bookingId, from: r.allocation.startedAt, to: r.allocation.endedAt ?? clock.now }));
    for (const x of spans) for (const y of spans) {
      if (x.id < y.id && x.from < y.to && y.from < x.to) world.violations.push(`${at(clock.now)} effective windows of ${x.id} and ${y.id} overlap`);
    }
    if (JSON.stringify(world.bookings) !== original) world.violations.push(`${at(clock.now)} guaranteed-pay booking terms changed`);
    const live = key.startsWith('live:') ? key.slice(5) : null;
    for (const id of world.onAir) {
      if (id === live) continue;
      world.onAir.delete(id);
      if (world.playing.has(id)) world.cuts.push({ id, at: clock.now, reason: endReason(id) });
    }
    if (live) world.onAir.add(live);
  }

  async function advance(to, { step = 10 * SEC } = {}) {
    while (clock.now < to) {
      clock.now = Math.min(clock.now + (world.playing.size ? Math.min(step, SEC) : step), to);
      for (const id of world.playing) {
        const r = proc.receivers.get(id);
        if (r) { r.frame({ samples: 960 }); r.pcm(pcm()); }
      }
      await proc.service.tick();
      observe();
    }
  }
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

  const pass = async (id, wallet = OWNER) => {
    const c = await proc.service.challenge({ bookingId: id, wallet }, ORIGIN);
    return proc.service.authorize({ challengeId: c.challengeId, signature: wallet }, ORIGIN);
  };
  const performerPass = id => pass(id, wallets[id].address.toLowerCase());
  const state = p => proc.service.command(p.token, { action: 'state' }, ORIGIN);
  const send = async (p, action, payload = {}) => {
    const s = await state(p);
    return proc.service.command(p.token, { action: `broadcast-${action}`, commandId: `desk-command-${++count}`,
      expectedRevision: action.startsWith('recovery-') ? s.recovery.revision : s.broadcast?.revision || 0, ...payload }, ORIGIN);
  };
  const direction = async (p, action, payload = {}) => {
    const s = await proc.service.command(p.token, { action: 'direction-state' }, ORIGIN);
    return proc.service.command(p.token, { action: `direction-${action}`, epoch: s.epoch,
      ...(action !== 'heartbeat' ? { commandId: `direction-${++count}` } : {}),
      ...(!['message', 'heartbeat'].includes(action) ? { expectedRevision: s.revision } : {}), ...payload }, ORIGIN);
  };
  const allow = async (p, id) => {
    const wallet = wallets[id].address.toLowerCase(), issuedAt = clock.now;
    const version = recordingConsent.LIVE_RECORDING_ALLOCATED_CONSENT_VERSION;
    const signature = await wallets[id].signMessage(recordingConsent.liveRecordingConsentMessage(
      { bookingId: id, wallet, origin: ORIGIN, issuedAt, enabled: true, version }));
    return proc.service.command(p.token, { action: 'recording-consent', enabled: true, issuedAt, signature, consentVersion: version }, ORIGIN);
  };
  const check = async (p, id, kind) => {
    world.playing.add(id);
    await advance(clock.now + 6 * SEC);
    await proc.service.command(p.token, { action: 'check', check: kind, confirmed: true }, ORIGIN);
    world.playing.delete(id);
  };

  const passes = {};
  // Rooms open at T-70, both performers consent to the allocated-set recording, both slots soundcheck and arm.
  async function preflight() {
    await advance(START - 69 * MIN);
    passes.ownerA = await pass('act-a'); passes.artistA = await performerPass('act-a');
    await allow(passes.artistA, 'act-a');
    await advance(START - 60 * MIN);
    await check(passes.ownerA, 'act-a', 't60');
    await advance(START - 49 * MIN);
    passes.ownerB = await pass('act-b'); passes.artistB = await performerPass('act-b');
    await allow(passes.artistB, 'act-b');
    await advance(START - 30 * MIN);
    await check(passes.ownerB, 'act-b', 't60');
    await advance(START - 15 * MIN);
    await check(passes.ownerA, 'act-a', 't15');
    await proc.service.command(passes.ownerA.token, { action: 'arm' }, ORIGIN);
  }
  // Producer desk before the show: allocate A, pair B behind it, and let B choose the full set.
  async function desk() {
    await advance(START - 6 * MIN);
    await send(passes.ownerA, 'enable');
    passes.ownerA = await pass('act-a');
    await send(passes.ownerA, 'reserve-next', { nextBookingId: 'act-b', nextToken: passes.ownerB.token, expectedNextRevision: 0 });
    passes.ownerB = await pass('act-b'); passes.artistB = await performerPass('act-b');
    await send(passes.artistB, 'choice', { choice: 'full' });
    passes.artistA = await performerPass('act-a');
  }
  async function takeLive(id, owner, artist, readyAt = clock.now) {
    await advance(readyAt);
    world.playing.add(id);
    await advance(clock.now + 2 * SEC);
    await direction(artist, 'readiness', { ready: true });
    return send(owner, 'take', { confirmed: true });
  }
  // The next act's second private soundcheck and arming, done backstage while the current act is on air.
  async function readyNext(id, owner) {
    await check(owner, id, 't15');
    await proc.service.command(owner.token, { action: 'arm' }, ORIGIN);
  }
  async function restart() {
    await proc.service.stop(); proc.session.destroy();
    await boot();
  }
  // The performer declares the set finished, stops publishing, then the producer ends it normally.
  async function finishAct(id, owner, artist) {
    await send(artist, 'finished');
    world.playing.delete(id);
    return send(owner, 'end', { mode: 'normal', confirmed: true });
  }
  const lease = (id = 'handoff-check') => proc.service.prepareDeployment({ id, expiresAt: clock.now + 5 * MIN });
  const rel = ms => ms == null ? null : at(ms);
  const brief = () => ({
    timeline: world.timeline.map(e => `${at(e.at)} ${e.key}`),
    violations: world.violations, cuts: world.cuts.map(c => `${c.id}@${at(c.at)}:${c.reason}`),
    ingests: world.ingests.map(i => `${i.id} incomplete=${i.incomplete} ${i.seconds}s @${at(i.at)}`),
    closed: world.closed.map(c => `${c.id}@${at(c.at)}`), errors: world.errors,
    alloc: Object.fromEntries(['act-a', 'act-b'].map(id => {
      const a = room(id)?.allocation;
      return [id, a && { planned: rel(a.plannedStartAt), start: rel(a.startedAt), end: rel(a.endedAt), reason: a.endReason,
        encoreMin: a.encoreMs / MIN, choice: a.choice, durMin: a.durationMs / MIN, delayNotice: rel(a.delayNotifiedAt),
        priorityFollowup: a.priorityFollowup }];
    })),
  });
  const timeline = () => world.timeline.map(entry => entry.key);

  await boot();
  return { world, clock, advance, settle, pass, performerPass, state, send, direction, allow, check, preflight, desk, takeLive, readyNext,
    restart, finishAct, lease, brief, passes, timeline, room, showKey, start: START,
    get proc() { return proc; }, original, play: id => world.playing.add(id), stop: id => world.playing.delete(id) };
}

const attempt = async fn => { try { await fn(); return 'accepted'; } catch (error) { return `${error.code || error.name}: ${error.message}`; } };
// Soundchecks, the producer desk, act A on air, and act B warmed up backstage at T+6.
const upTo = async n => {
  await n.preflight(); await n.desk();
  await n.takeLive('act-a', n.passes.ownerA, n.passes.artistA, START);
  await n.advance(START + 6 * MIN);
  await n.readyNext('act-b', n.passes.ownerB);
};
// What listeners hear, from act A's lead-in onward.
const show = n => n.timeline().slice(n.timeline().indexOf('lead-in:act-a'));
const prepared = n => n.world.journal.recordings.filter(r => r.status === 'ready' && r.result?.cid);
const outcomes = n => prepared(n).map(r => [r.bookingId, r.incomplete]);
const SMOOTH = ['lead-in:act-a', 'radio:waiting', 'live:act-a', 'outro:act-a', 'lead-in:act-b', 'radio:waiting', 'live:act-b', 'outro:act-b', 'radio'];
const OVERRUN = ['lead-in:act-a', 'radio:waiting', 'live:act-a', 'outro:act-a', 'radio:waiting', 'live:act-b', 'outro:act-b', 'radio'];
// Rules every night must keep, however the performers and the desk behave.
async function soundNight(n) {
  await n.settle();
  assert.deepEqual(n.world.violations, [], 'airtime never overlaps and the guaranteed terms never change');
  assert.deepEqual(n.world.errors, []);
  const ids = prepared(n).map(r => r.bookingId);
  assert.equal(new Set(ids).size, ids.length, 'each recording is prepared once');
  assert.deepEqual(n.world.ingests, [], 'no automatic mint intake before performer release approval');
  assert.equal(new Set(n.world.closed.map(c => c.id)).size, n.world.closed.length, 'each room is closed once');
  assert.equal(n.timeline().at(-1), 'radio', 'the radio is back in normal rotation');
  assert.ok(n.world.journal.recordings.every(r => ['ready', 'empty'].includes(r.status)), 'no recording is left processing');
  assert.equal((await n.lease('handoff-night-end')).ready, true, 'a deployment can safely start');
}

test('act A finishes early: a clean handoff to act B, then the ads and radio resume exactly once', async t => {
  const n = await night(t, { assets: true }); await upTo(n);
  await n.advance(START + 14 * MIN);
  await n.finishAct('act-a', n.passes.ownerA, n.passes.artistA);
  await n.advance(START + 19 * MIN);
  assert.equal(n.room('act-b').allocation.plannedStartAt, START + 20 * MIN, 'an early finish never pulls act B ahead of its booked start');
  await n.takeLive('act-b', n.passes.ownerB, n.passes.artistB, START + 20 * MIN);
  await n.advance(START + 33 * MIN);
  await n.finishAct('act-b', n.passes.ownerB, n.passes.artistB);
  await n.advance(START + 45 * MIN);
  assert.deepEqual(show(n), SMOOTH);
  assert.deepEqual(n.world.cuts, [], 'nobody is cut off mid-song');
  assert.deepEqual(outcomes(n), [['act-a', false], ['act-b', false]]);
  for (const b of n.world.bookings) {
    const preview = await n.proc.service.previewRecording({ bookingId: b.id, wallet: b.wallet });
    assert.equal(preview.previewOnly, true);
    assert.ok(preview.sourceSamples > 0);
  }
  assert.deepEqual(n.world.closed.map(c => c.id), ['act-a', 'act-b']);
  await soundNight(n);
});

test('mid-song at the booked end, the producer approves five more minutes after a wrap-up cue', async t => {
  const n = await night(t); await upTo(n);
  await n.advance(START + 18 * MIN);
  await n.direction(n.passes.ownerA, 'cue', { kind: 'wrap-up' });
  const seen = await n.proc.service.command(n.passes.artistA.token, { action: 'direction-state' }, ORIGIN);
  await n.advance(START + 19.5 * MIN);
  const encore = await n.send(n.passes.ownerA, 'encore', { additionalMs: 5 * MIN, nextToken: n.passes.ownerB.token });
  await n.advance(START + 21 * MIN);
  const midway = { onAir: [...n.world.onAir], key: n.timeline().at(-1), bNotice: n.room('act-b').allocation.delayNotifiedAt != null };
  await n.advance(START + 24 * MIN);
  await n.finishAct('act-a', n.passes.ownerA, n.passes.artistA);
  await n.takeLive('act-b', n.passes.ownerB, n.passes.artistB, n.room('act-b').allocation.plannedStartAt);
  await n.advance(START + 41 * MIN);
  await n.finishAct('act-b', n.passes.ownerB, n.passes.artistB);
  await n.advance(START + 50 * MIN);
  assert.equal(seen.cue?.kind, 'wrap-up', 'the performer sees the wrap-up cue');
  assert.equal(encore.applied, true);
  assert.deepEqual(midway, { onAir: ['act-a'], key: 'live:act-a', bNotice: true }, 'act A keeps the stage past its booked end and act B is told');
  assert.deepEqual(show(n), OVERRUN);
  assert.deepEqual(n.world.cuts, []);
  assert.deepEqual(outcomes(n), [['act-a', false], ['act-b', false]]);
  assert.equal(n.room('act-a').allocation.encoreMs, 5 * MIN);
  assert.equal(n.room('act-b').allocation.plannedStartAt, START + 29 * MIN, 'act B starts after the extension and the five-minute outro');
  assert.ok(n.room('act-b').allocation.startedAt - n.room('act-b').allocation.plannedStartAt <= 5 * SEC, 'act B goes live promptly');
  await soundNight(n);
});

test('two extensions are capped at ten minutes, retries are idempotent, and no time can be bought after the cut', async t => {
  const n = await night(t); await upTo(n);
  await n.advance(START + 19 * MIN);
  const rev = (await n.state(n.passes.ownerA)).broadcast?.revision || 0;
  const ask = (additionalMs, extra = {}) => n.send(n.passes.ownerA, 'encore', { additionalMs, nextToken: n.passes.ownerB.token, ...extra });
  const first = await ask(5 * MIN, { commandId: 'encore-first-0001', expectedRevision: rev });
  const retry = await ask(5 * MIN, { commandId: 'encore-first-0001', expectedRevision: rev });
  const reuse = await attempt(() => ask(9 * MIN, { commandId: 'encore-first-0001', expectedRevision: rev }));
  const afterFirst = n.room('act-a').allocation.encoreMs / MIN;
  await n.advance(START + 24 * MIN);
  await ask(5 * MIN);
  const third = await attempt(() => ask(MIN));
  await n.advance(START + 31 * MIN);
  const afterCut = await attempt(() => ask(MIN));
  await n.takeLive('act-b', n.passes.ownerB, n.passes.artistB, n.room('act-b').allocation.plannedStartAt);
  await n.advance(START + 52 * MIN);
  await n.finishAct('act-b', n.passes.ownerB, n.passes.artistB);
  await n.advance(START + 60 * MIN);
  assert.equal(first.applied, true);
  assert.equal(retry.applied, false, 'a retried click is recognised and not applied twice');
  assert.match(reuse, /already used for a different decision/);
  assert.equal(afterFirst, 5, 'the retry did not add a second five minutes');
  assert.match(third, /at most ten cumulative encore minutes/);
  assert.match(afterCut, /already ended|expired/);
  assert.equal(n.room('act-a').allocation.encoreMs, 10 * MIN);
  assert.deepEqual(n.world.cuts.map(c => [c.id, c.reason]), [['act-a', 'authorization-expired']], 'at the cap act A is closed, as promised');
  assert.deepEqual(outcomes(n), [['act-a', true], ['act-b', false]]);
  assert.deepEqual(show(n), OVERRUN);
  await soundNight(n);
});

test('the delayed act declines: nothing is published for it, the radio resumes and a deployment is never blocked', async t => {
  const n = await night(t); await upTo(n);
  await n.advance(START + 19.5 * MIN);
  await n.send(n.passes.ownerA, 'encore', { additionalMs: 5 * MIN, nextToken: n.passes.ownerB.token });
  await n.send(n.passes.artistB, 'choice', { choice: 'decline' });
  await n.advance(START + 24 * MIN);
  await n.finishAct('act-a', n.passes.ownerA, n.passes.artistA);
  await n.advance(START + 45 * MIN);
  const early = await n.lease('handoff-early');
  await n.advance(START + 90 * MIN);
  assert.equal(early.ready, true, 'a declined act leaves nothing pending, so a deployment may start straight away');
  assert.equal(n.room('act-b').allocation.endReason, 'declined');
  assert.ok(!prepared(n).some(r => r.bookingId === 'act-b'), 'a declined act has nothing to publish');
  assert.deepEqual(show(n), ['lead-in:act-a', 'radio:waiting', 'live:act-a', 'outro:act-a', 'radio']);
  assert.deepEqual(n.world.cuts, []);
  assert.deepEqual(outcomes(n), [['act-a', false]]);
  await soundNight(n);
});

test('the delayed act plays a short set and earns a priority follow-up invitation', async t => {
  const n = await night(t); await upTo(n);
  await n.advance(START + 19.5 * MIN);
  await n.send(n.passes.ownerA, 'encore', { additionalMs: 5 * MIN, nextToken: n.passes.ownerB.token });
  await n.send(n.passes.artistB, 'choice', { choice: 'short', durationMs: 10 * MIN });
  await n.advance(START + 24 * MIN);
  await n.finishAct('act-a', n.passes.ownerA, n.passes.artistA);
  await n.takeLive('act-b', n.passes.ownerB, n.passes.artistB, n.room('act-b').allocation.plannedStartAt);
  await n.advance(START + 36 * MIN);
  await n.finishAct('act-b', n.passes.ownerB, n.passes.artistB);
  await n.advance(START + 50 * MIN);
  assert.equal(n.room('act-b').allocation.priorityFollowup, true);
  assert.equal(n.room('act-b').allocation.endReason, 'producer-finished');
  assert.deepEqual(n.world.cuts, []);
  assert.deepEqual(outcomes(n), [['act-a', false], ['act-b', false]]);
  assert.deepEqual(show(n), OVERRUN);
  await soundNight(n);
});

test('a short set that nobody ends is closed at its authorized end and the radio resumes', async t => {
  const n = await night(t);
  await n.preflight(); await n.desk();
  await n.send(n.passes.artistB, 'choice', { choice: 'short', durationMs: 12 * MIN });
  await n.takeLive('act-a', n.passes.ownerA, n.passes.artistA, START);
  await n.advance(START + 6 * MIN);
  await n.readyNext('act-b', n.passes.ownerB);
  await n.advance(START + 14 * MIN);
  await n.finishAct('act-a', n.passes.ownerA, n.passes.artistA);
  await n.takeLive('act-b', n.passes.ownerB, n.passes.artistB, START + 20 * MIN);
  await n.advance(START + 40 * MIN);
  assert.deepEqual(n.world.cuts.map(c => [c.id, c.reason]), [['act-b', 'authorization-expired']], 'no automatic overtime: the stage closes at the authorized end');
  assert.deepEqual(outcomes(n), [['act-a', false], ['act-b', true]]);
  assert.deepEqual(show(n), SMOOTH);
  await soundNight(n);
});

test('the worker restarts mid-set: the stage and radio carry on, a deployment waits, and the recording is labelled interrupted', async t => {
  const n = await night(t); await upTo(n);
  await n.advance(START + 8 * MIN);
  const before = n.room('act-a').allocation.startedAt;
  await n.restart();
  const stale = await attempt(() => n.state(n.passes.ownerA));
  n.passes.ownerA = await n.pass('act-a'); n.passes.artistA = await n.performerPass('act-a');
  n.passes.ownerB = await n.pass('act-b'); n.passes.artistB = await n.performerPass('act-b');
  const keyBeforeTick = n.showKey(n.proc.session.getShowState().activeShow);
  const handoffMidSet = await n.lease('handoff-mid-set');
  await n.advance(START + 14 * MIN);
  const keyAfter = n.timeline().at(-1);
  await n.finishAct('act-a', n.passes.ownerA, n.passes.artistA);
  await n.takeLive('act-b', n.passes.ownerB, n.passes.artistB, START + 20 * MIN);
  await n.advance(START + 33 * MIN);
  await n.finishAct('act-b', n.passes.ownerB, n.passes.artistB);
  await n.advance(START + 45 * MIN);
  assert.equal(n.room('act-a').allocation.startedAt, before, 'a restart does not restart the set clock');
  assert.match(stale, /Room authorization expired; reconnect your wallet/);
  assert.equal(keyBeforeTick, 'live:act-a');
  assert.equal(keyAfter, 'live:act-a', 'the radio does not flicker while the worker comes back');
  assert.equal(handoffMidSet.ready, false, 'a deployment waits while a set is being recorded');
  assert.deepEqual(show(n), SMOOTH);
  assert.deepEqual(n.world.cuts, []);
  assert.deepEqual(outcomes(n), [['act-a', true], ['act-b', false]]);
  await soundNight(n);
});

test('a late publisher, a ten-second blip and a thirty-second loss follow the new fifteen-second policy', async t => {
  const n = await night(t); await upTo(n);
  await n.advance(START + 8 * MIN);
  n.stop('act-a'); await n.advance(START + 8 * MIN + 10 * SEC); n.play('act-a');
  await n.advance(START + 10 * MIN);
  const afterBlip = { live: n.timeline().at(-1), ended: n.room('act-a').allocation.endedAt };
  await n.finishAct('act-a', n.passes.ownerA, n.passes.artistA);
  await n.advance(START + 20 * MIN);
  const early = await attempt(() => n.send(n.passes.ownerB, 'take', { confirmed: true }));
  await n.advance(START + 25 * MIN);
  const waiting = n.timeline().at(-1);
  await n.takeLive('act-b', n.passes.ownerB, n.passes.artistB, START + 25 * MIN);
  await n.advance(START + 31 * MIN);
  n.stop('act-b'); await n.advance(START + 31 * MIN + 30 * SEC);
  const lost = n.room('act-b').allocation;
  await n.advance(START + 50 * MIN);
  assert.deepEqual(afterBlip, { live: 'live:act-a', ended: null }, 'a ten-second dropout does not end the set');
  assert.match(early, /Take requires the chosen, ready, soundchecked performer and fresh verified audio/);
  assert.equal(waiting, 'radio:waiting', 'while act B is late the radio keeps playing');
  assert.equal(lost.endReason, 'audio-loss');
  assert.deepEqual(show(n), ['lead-in:act-a', 'radio:waiting', 'live:act-a', 'outro:act-a', 'radio', 'lead-in:act-b', 'radio:waiting',
    'live:act-b', 'live:act-b:fault', 'cancellation:act-b', 'radio']);
  assert.deepEqual(outcomes(n), [['act-a', true], ['act-b', true]]);
  await soundNight(n);
});

// The performer declares the set finished and stops publishing; the producer ends it `producerDelaySeconds` later, unless the room notices first.
async function quietEnding(t, producerDelaySeconds) {
  const n = await night(t); await upTo(n);
  await n.advance(START + 14 * MIN);
  await n.send(n.passes.artistA, 'finished');
  n.stop('act-a');
  await n.advance(START + 14 * MIN + producerDelaySeconds * SEC);
  const ended = await attempt(() => n.send(n.passes.ownerA, 'end', { mode: 'normal', confirmed: true }));
  await n.advance(START + 19 * MIN);
  await n.takeLive('act-b', n.passes.ownerB, n.passes.artistB, START + 20 * MIN);
  await n.advance(START + 33 * MIN);
  await n.finishAct('act-b', n.passes.ownerB, n.passes.artistB);
  await n.advance(START + 45 * MIN);
  return { n, ended };
}

test('the performer stops the microphone and the producer ends the set 10 seconds later: a normal ending', async t => {
  const { n, ended } = await quietEnding(t, 10);
  assert.equal(ended, 'accepted');
  assert.equal(n.room('act-a').allocation.endReason, 'producer-finished');
  assert.deepEqual(n.world.cuts, []);
  assert.deepEqual(show(n), SMOOTH);
  // Known limitation: the completeness check tolerates only 5 s of silence, so a quiet tail this long labels the whole
  // recording "(partial recording)". Keeping the microphone on until the producer ends the set avoids it (next test).
  assert.deepEqual(outcomes(n), [['act-a', true], ['act-b', false]]);
  await soundNight(n);
});

test('a performer who keeps the microphone on until the producer ends the set gets a complete recording', async t => {
  const n = await night(t); await upTo(n);
  await n.advance(START + 14 * MIN);
  await n.send(n.passes.artistA, 'finished');
  await n.advance(START + 14 * MIN + 20 * SEC);
  await n.send(n.passes.ownerA, 'end', { mode: 'normal', confirmed: true });
  n.stop('act-a');
  await n.advance(START + 19 * MIN);
  await n.takeLive('act-b', n.passes.ownerB, n.passes.artistB, START + 20 * MIN);
  await n.advance(START + 33 * MIN);
  await n.finishAct('act-b', n.passes.ownerB, n.passes.artistB);
  await n.advance(START + 45 * MIN);
  assert.deepEqual(outcomes(n), [['act-a', false], ['act-b', false]]);
  assert.deepEqual(show(n), SMOOTH);
  await soundNight(n);
});

test('the performer stops the microphone and nobody ends the set: it closes as a normal ending, never as an audio fault', async t => {
  const { n, ended } = await quietEnding(t, 90);
  assert.match(ended, /already ended/);
  const a = n.room('act-a').allocation;
  assert.equal(a.endReason, 'producer-finished');
  assert.ok(a.endedAt - a.finishedAt <= 2 * SEC, 'the set ended when the performer finished, not when the silence was noticed');
  assert.deepEqual(show(n), SMOOTH, 'no fault slate and no recovery-ads window');
  assert.deepEqual(n.world.cancellations, []);
  assert.deepEqual(n.world.cuts, []);
  assert.deepEqual(outcomes(n), [['act-a', false], ['act-b', false]]);
  await soundNight(n);
});

test('an operator cut mid-song is recorded as interrupted and act B still goes on at its booked time', async t => {
  const n = await night(t); await upTo(n);
  await n.advance(START + 10 * MIN);
  await n.send(n.passes.ownerA, 'end', { mode: 'operator-cut', confirmed: true });
  await n.advance(START + 19 * MIN);
  await n.takeLive('act-b', n.passes.ownerB, n.passes.artistB, START + 20 * MIN);
  await n.advance(START + 33 * MIN);
  await n.finishAct('act-b', n.passes.ownerB, n.passes.artistB);
  await n.advance(START + 45 * MIN);
  assert.deepEqual(n.world.cuts.map(c => [c.id, c.reason]), [['act-a', 'operator-cut']]);
  assert.deepEqual(outcomes(n), [['act-a', true], ['act-b', false]]);
  assert.deepEqual(show(n), ['lead-in:act-a', 'radio:waiting', 'live:act-a', 'outro:act-a', 'radio', 'lead-in:act-b', 'radio:waiting', 'live:act-b', 'outro:act-b', 'radio'], 'the radio fills the gap between the early cut and the next booked lead-in');
  await soundNight(n);
});

test('the producer never takes act B: the room closes as not ready, nothing is published and the radio plays on', async t => {
  const n = await night(t); await upTo(n);
  await n.advance(START + 14 * MIN);
  await n.finishAct('act-a', n.passes.ownerA, n.passes.artistA);
  await n.advance(START + 60 * MIN);
  const b = n.room('act-b').allocation;
  assert.equal(b.endReason, 'not-ready');
  assert.equal(b.startedAt, null);
  assert.ok(!show(n).includes('live:act-b'));
  assert.deepEqual(outcomes(n), [['act-a', false]]);
  await soundNight(n);
});

test('a double-clicked take is recognised: a retried command does nothing and a fresh one cannot restart the set', async t => {
  const n = await night(t); await upTo(n);
  await n.advance(START + 14 * MIN);
  await n.finishAct('act-a', n.passes.ownerA, n.passes.artistA);
  await n.advance(START + 19 * MIN);
  const rev = (await n.state(n.passes.ownerB)).broadcast?.revision || 0;
  const take = () => n.send(n.passes.ownerB, 'take', { confirmed: true, commandId: 'take-act-b-0001', expectedRevision: rev });
  await n.advance(START + 20 * MIN);
  n.play('act-b'); await n.advance(START + 20 * MIN + 2 * SEC);
  await n.direction(n.passes.artistB, 'readiness', { ready: true });
  assert.equal((await take()).applied, true);
  const startedAt = n.room('act-b').allocation.startedAt;
  assert.equal((await take()).applied, false, 'the same click twice is applied once');
  assert.notEqual(await attempt(() => n.send(n.passes.ownerB, 'take', { confirmed: true })), 'accepted', 'a new click cannot take a live act again');
  assert.equal(n.room('act-b').allocation.startedAt, startedAt);
  await n.advance(START + 33 * MIN);
  await n.finishAct('act-b', n.passes.ownerB, n.passes.artistB);
  await n.advance(START + 45 * MIN);
  assert.deepEqual(outcomes(n), [['act-a', false], ['act-b', false]]);
  await soundNight(n);
});

test('recovery rehearsal: commercials preserve the set, explicit return resumes real audio and the recording retains its gap', async t => {
  const n = await night(t, { recovery: true }); await upTo(n);
  await n.advance(START + 8 * MIN);
  n.stop('act-a');
  await n.advance(START + 8 * MIN + 6 * SEC, { step: SEC });
  await n.send(n.passes.ownerA, 'recovery-hold', { additionalMs: 30000 });
  const deadline = n.room('act-a').recovery.deadline;
  await n.send(n.passes.ownerA, 'recovery-filler', { mode: 'adverts', confirmed: true });
  assert.equal(n.showKey(n.proc.session.getShowState().activeShow), 'recovery:act-a');
  assert.equal(n.room('act-a').allocation.endedAt, null);
  n.play('act-a');
  await n.advance(START + 8 * MIN + 12 * SEC);
  assert.equal((await n.state(n.passes.ownerA)).phase, 'recovering', 'private recovered packets never return automatically from filler');
  await n.direction(n.passes.artistA, 'readiness', { ready: true });
  await n.direction(n.passes.artistA, 'heartbeat');
  await n.send(n.passes.ownerA, 'recovery-return', { confirmed: true });
  assert.equal(n.room('act-a').recovery.usedMs, 30000);
  assert.equal(deadline, START + 8 * MIN + 45 * SEC);
  await n.advance(START + 14 * MIN);
  await n.finishAct('act-a', n.passes.ownerA, n.passes.artistA);
  await n.advance(START + 19 * MIN);
  await n.takeLive('act-b', n.passes.ownerB, n.passes.artistB, START + 20 * MIN);
  await n.advance(START + 33 * MIN); await n.finishAct('act-b', n.passes.ownerB, n.passes.artistB);
  await n.advance(START + 45 * MIN); await n.settle();
  assert.deepEqual(n.world.violations, []);
  assert.deepEqual(n.world.errors, []);
  assert.equal(n.world.cancellations.length, 0);
  const a = n.world.journal.recordings.find(r => r.bookingId === 'act-a');
  const b = n.world.journal.recordings.find(r => r.bookingId === 'act-b');
  assert.equal(a.status, 'ready'); assert.equal(a.incomplete, true); assert.equal(a.interrupted, true);
  assert.equal(b.status, 'ready'); assert.equal(b.incomplete, false);
  assert.ok(a.segments.some((segment, i) => i && segment.firstFrameAt - a.segments[i - 1].lastFrameAt > 2000),
    'received segment timestamps retain the genuine interruption instead of manufacturing filler PCM');
  assert.deepEqual(n.world.ingests, [], 'no automatic release or invented performance evidence from filler');
  assert.equal(n.timeline().at(-1), 'radio');
});

test('recovery rehearsal: a held radio window expires once through the existing audio-loss terminal path', async t => {
  const n = await night(t, { recovery: true }); await upTo(n);
  await n.advance(START + 8 * MIN); n.stop('act-a');
  await n.advance(START + 8 * MIN + 6 * SEC, { step: SEC });
  await n.send(n.passes.ownerA, 'recovery-hold', { additionalMs: 60000 });
  await n.send(n.passes.ownerA, 'recovery-filler', { mode: 'radio', confirmed: true });
  const deadline = n.room('act-a').recovery.deadline;
  assert.equal(n.proc.session.getShowState().activeShow.type, 'normal_rotation', 'radio plays before timeout, while recovery remains possible');
  await n.advance(deadline - 1, { step: SEC });
  assert.equal(n.room('act-a').allocation.endedAt, null);
  await n.advance(deadline, { step: 1 });
  assert.equal(n.room('act-a').allocation.endReason, 'audio-loss');
  await n.advance(deadline + 6000, { step: SEC }); await n.settle();
  assert.equal(n.world.cancellations.length, 1);
  assert.equal(n.world.cancellations[0].id, 'act-a');
  assert.deepEqual(n.world.violations, []);
  assert.deepEqual(n.world.errors, []);
  assert.match(await attempt(() => n.pass('act-a')), /closes|cancelled/);
});

test('recovery rehearsal: explicitly ready paired next act may advance early without overlapping or changing escrow', async t => {
  const n = await night(t, { recovery: true }); await upTo(n);
  await n.advance(START + 8 * MIN); n.stop('act-a');
  await n.advance(START + 8 * MIN + 6 * SEC, { step: SEC });
  n.play('act-b'); await n.advance(START + 8 * MIN + 8 * SEC, { step: SEC });
  await n.direction(n.passes.artistB, 'readiness', { ready: true });
  await n.direction(n.passes.artistB, 'heartbeat');
  const next = await n.state(n.passes.ownerB);
  await n.send(n.passes.ownerA, 'advance-next', { confirmed: true, nextToken: n.passes.ownerB.token,
    expectedNextRevision: next.broadcast.revision });
  await n.advance(START + 9 * MIN); await n.settle();
  assert.equal(n.room('act-a').allocation.endReason, 'operator-cut');
  assert.equal(n.room('act-a').allocation.endedAt, n.room('act-b').allocation.startedAt);
  assert.equal(n.proc.session.getShowState().activeShow.event.id, 'friday-live:act-b');
  assert.deepEqual(n.world.violations, []);
  assert.equal(JSON.stringify(n.world.bookings), n.original);
  assert.equal(n.world.cancellations.length, 0, 'existing operator-cut lifecycle does not settle or financially cancel twice');
  assert.equal(n.world.journal.recordings.find(r => r.bookingId === 'act-b').segments.length, 0,
    'early live readiness is not consent to capture pre-contract audio');
});
