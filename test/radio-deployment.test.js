const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');

test('deployment handoff is leased, exclusive, expires safely and never stops the playing batch', async () => {
  const { createRadioDeploymentGate } = await import('../discord-bot/radio-deployment.js');
  const { JukeLoopSession } = await import('../discord-bot/jukeloop.js');
  let now = Date.now(), active = '5', selections = 0;
  const player = new EventEmitter(); player.state = { status: 'playing' };
  player.stop = () => { throw Error('Deployment must not stop paid audio'); };
  const session = new JukeLoopSession({ voiceChannel: { guild: { id: 'drain' } }, client: {}, audioPlayer: player,
    djuke: { getActivePlaylistBatchId: () => active, hasActivePlaylist: () => active !== null,
      prepareForDeployment: async () => {}, hasPendingSelection: () => selections > 0 } });
  session._currentPaid = { requestId: 'paid-1', playlistBatchId: '5' };
  const gate = createRadioDeploymentGate({ getSession: () => session, now: () => now, leaseMs: 120000 });
  try {
    assert.equal((await gate({ action: 'drain', id: 'release-1' })).ready, false);
    assert.equal(session._paidStartAllowed({ playlistBatchId: '5' }), true);
    assert.equal(session._paidStartAllowed({ playlistBatchId: '6' }), false);
    assert.equal(session._paidStartAllowed({ kind: 'devert' }), false);
    await assert.rejects(gate({ action: 'drain', id: 'release-2' }), /Another deployment/);
    active = null; session._currentPaid = null; selections++;
    assert.equal((await gate({ action: 'drain', id: 'release-1' })).ready, false, 'late paid selections still block replacement');
    selections = 0;
    session._paidBookkeepingTask = Promise.resolve();
    assert.equal((await gate({ action: 'drain', id: 'release-1' })).ready, false, 'completion bookkeeping still blocks replacement');
    session._paidBookkeepingTask = null;
    assert.equal((await gate({ action: 'drain', id: 'release-1' })).ready, true);
    assert.equal(session._paidStartAllowed({}), false, 'new purchases wait through the safe deployment boundary');
    await gate({ action: 'cancel', id: 'release-1' });
    assert.equal(session._paidStartAllowed({}), true, 'failed/cancelled release restores queue service');
    now += 121000;
    assert.equal((await gate({ action: 'drain', id: 'release-2' })).deploymentId, 'release-2');
  } finally { session.player.stop = () => {}; session.destroy(); }
});

test('predeploy command waits for real drain readiness and fails closed on unavailable or unverified handoff', async () => {
  const { waitForRadioDeployment } = await import('../discord-bot/radio-predeploy.js');
  let now = 1000, attempts = 0;
  const options = { serviceUrl: 'https://radio.example', secret: 'a'.repeat(32), id: 'release',
    now: () => now, sleep: async ms => { now += ms; }, log: { info() {} } };
  const result = await waitForRadioDeployment({ ...options, fetchImpl: async (_url, init) => {
    assert.equal(JSON.parse(init.body).action, 'drain');
    return Response.json({ deploymentId: 'release', draining: true, expiresAt: now + 120000, ready: ++attempts > 2 });
  } });
  assert.equal(result.ready, true); assert.equal(attempts, 3);
  await assert.rejects(waitForRadioDeployment({ ...options, fetchImpl: async () => new Response('', { status: 404 }) }), /refused/);
  await assert.rejects(waitForRadioDeployment({ ...options, fetchImpl: async () => Response.json({
    deploymentId: 'other', draining: true, expiresAt: now + 120000, ready: true }) }), /lease is not verified/);
  await assert.rejects(waitForRadioDeployment({ ...options, timeoutMs: 1, fetchImpl: async () => Response.json({
    deploymentId: 'release', draining: true, expiresAt: now + 120000, ready: false }) }), /timed out/);
});

test('deployment gate extends and cancels the same recording lease without overriding paid readiness', async () => {
  const { createRadioDeploymentGate } = await import('../discord-bot/radio-deployment.js');
  let time = 1000, paidReady = false, recordingReady = true;
  const leases = [];
  const session = { drainForDeployment: async expiresAt => ({ draining: expiresAt > 0, ready: paidReady, expiresAt }) };
  const gate = createRadioDeploymentGate({ getSession: () => session, now: () => time,
    getLiveHandoff: async lease => { leases.push(lease); return { ready: recordingReady }; } });
  assert.equal((await gate({ action: 'drain', id: 'repair' })).ready, false, 'Durable recording does not bypass paid playback');
  assert.equal(leases.length, 1);
  paidReady = true;
  assert.equal((await gate({ action: 'drain', id: 'repair' })).ready, true);
  assert.deepEqual(leases.at(-1), { action: 'drain', id: 'repair', expiresAt: time + 900000 });
  recordingReady = false;
  assert.equal((await gate({ action: 'drain', id: 'repair' })).ready, false);
  await gate({ action: 'cancel', id: 'repair' });
  assert.deepEqual(leases.at(-1), { action: 'cancel', id: 'repair', expiresAt: 0 });
});

test('deployment rechecks extended recording proof and releases paid holds even if live cancellation fails', async () => {
  const { createRadioDeploymentGate } = await import('../discord-bot/radio-deployment.js');
  const paidLeases = [];
  let checks = 0;
  const gate = createRadioDeploymentGate({ now: () => 1000,
    getSession: () => ({ drainForDeployment: async expiresAt => {
      paidLeases.push(expiresAt); return { ready: true };
    } }),
    getLiveHandoff: async ({ action }) => {
      if (action === 'cancel') throw Error('fixture cancellation failure');
      checks++;
      return checks === 1 ? { ready: true, recordingCheckpointVerified: true } : { ready: false };
    } });
  const status = await gate({ action: 'drain', id: 'repair' });
  assert.equal(status.ready, false, 'Initial proof cannot authorize a failed extended lease');
  assert.equal(status.recordingCheckpointVerified, undefined);
  await assert.rejects(gate({ action: 'cancel', id: 'repair' }), /cancellation failure/);
  assert.equal(paidLeases.at(-1), 0, 'Live cancellation error must not strand paid playback');
});

test('deployment endpoint requires server authorization and does not expand public radio permissions', async () => {
  const { createWorkerRequestHandler } = await import('../discord-bot/ipfs-worker.js');
  let called = 0;
  const handler = createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: '0x1111111111111111111111111111111111111111',
    authorizeRadioDeployment: value => { if (value !== 'Bearer private-fixture') throw Error('Denied'); },
    radioDeployment: async body => { called++; return { ready: false, deploymentId: body.id }; } });
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const denied = await fetch(`${base}/api/radio/deployment`, { method: 'POST', body: '{}' });
    assert.equal(denied.status, 403); assert.equal(called, 0);
    const allowed = await fetch(`${base}/api/radio/deployment`, { method: 'POST',
      headers: { authorization: 'Bearer private-fixture', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'drain', id: 'release' }) });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).ready, false); assert.equal(called, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('deployment drain retains and releases a late underlying durable selection before reporting ready', async () => {
  const { createDjukeRuntime, createDjukePlaybackJournal } = await import('../discord-bot/djuke.js');
  const { combinePaidQueues } = await import('../discord-bot/devert-queue.js');
  let releaseRead;
  const read = new Promise(resolve => { releaseRead = resolve; });
  const journal = createDjukePlaybackJournal({ restore: async () => null, save: async () => 'ipfs://durable' });
  const runtime = createDjukeRuntime({ journal, timeoutMs: 1, readState: async () => read,
    fulfill: async () => {}, getTrack: trackId => ({ trackId }), log: { warn() {} } });
  const queue = combinePaidQueues({ songs: runtime });
  await assert.rejects(runtime.nextPaid(), /timed out/);
  assert.equal(queue.hasPendingSelection(), true, 'the inner timeout is not a completed drain');
  const draining = queue.prepareForDeployment();
  releaseRead({ requests: [{ requestId: 'later-single', trackId: 'song', songId: 'hash', playable: true }] });
  await draining;
  assert.equal(queue.hasPendingSelection(), false);
  assert.equal(journal.getState()[0].state, 'pending', 'late reservation is released, never played or fulfilled');
});

test('cancelling a deployment releases its hold even when financial verification is unavailable', async () => {
  const { JukeLoopSession } = await import('../discord-bot/jukeloop.js');
  const player = new EventEmitter(); player.stop = () => {};
  const session = new JukeLoopSession({ voiceChannel: { guild: { id: 'cancel-failed-drain' } }, client: {}, audioPlayer: player,
    djuke: { prepareForDeployment: async () => { throw Error('Required mirror unavailable'); } } });
  try {
    session._deploymentDrainUntil = Date.now() + 120000;
    assert.deepEqual(await session.drainForDeployment(0), { draining: false, ready: false });
    assert.equal(session._paidStartAllowed({}), true);
  } finally { session.destroy(); }
});

test('failed late verification remains an explicit error but cannot poison every later deployment attempt', async () => {
  const { createDjukeRuntime, createDjukePlaybackJournal } = await import('../discord-bot/djuke.js');
  let rejectRead;
  const read = new Promise((_resolve, reject) => { rejectRead = reject; });
  const runtime = createDjukeRuntime({ timeoutMs: 1, readState: () => read,
    journal: createDjukePlaybackJournal({ restore: async () => null, save: async () => 'ipfs://durable' }),
    fulfill: async () => {}, getTrack: () => null, log: { warn() {} } });
  await assert.rejects(runtime.nextPaid(), /timed out/);
  const draining = runtime.prepareForDeployment();
  rejectRead(Error('Required mirror unavailable'));
  await assert.rejects(draining, /Required mirror unavailable/);
  assert.equal(runtime.hasPendingSelection(), false);
  await runtime.prepareForDeployment();
});

test('an active live recording blocks replacement even at an empty paid boundary', async () => {
  const { createRadioDeploymentGate } = await import('../discord-bot/radio-deployment.js');
  let recording = true;
  const gate = createRadioDeploymentGate({
    getSession: () => ({ drainForDeployment: async expiresAt => ({ ready: true, draining: expiresAt > 0, expiresAt }) }),
    getLiveHandoff: () => ({ ready: !recording }),
  });
  const waiting = await gate({ action: 'drain', id: 'live-recording-release' });
  assert.equal(waiting.ready, false);
  assert.equal(waiting.liveRecordingPending, true);
  recording = false;
  assert.equal((await gate({ action: 'drain', id: 'live-recording-release' })).ready, true);
});
