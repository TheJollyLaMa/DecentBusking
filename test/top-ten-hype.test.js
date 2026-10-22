const test = require('node:test');
const assert = require('node:assert/strict');

const opening = Date.parse('2026-10-17T00:00:00Z');

async function setup(count = 10) {
  const { createTopTenHype } = await import('../discord-bot/top-ten-hype.js');
  const { resolveActiveShow } = await import('../js/radio-schedule.mjs');
  const playlist = Array.from({ length: count }, (_, index) => ({ trackId: `song-${index}`, title: `Song ${index}`, uploader: 'Artist' }));
  const report = { current: true, week: 'NY-2026-10-12',
    tracks: playlist.map((track, index) => ({ trackId: track.trackId, votes: count - index, plays: 1 })) };
  let saved = null;
  let writes = 0;
  const store = {
    restore: async () => saved && structuredClone(saved),
    save: async snapshot => { saved = structuredClone(snapshot); writes++; return 'ipfs://checkpoint'; },
  };
  const show = resolveActiveShow({ now: opening });
  const runtime = createTopTenHype({ store, now: () => opening });
  const ensure = { show, playlist, report };
  await runtime.ensure(ensure);
  return { runtime, store, show, playlist, report, ensure, createTopTenHype,
    saved: () => saved, writes: () => writes };
}

test('Friday snapshot counts from #10 to #1 despite changing votes, then labels fixed-order encores', async () => {
  const context = await setup();
  const { runtime, playlist, report, ensure } = context;
  report.tracks.reverse().forEach((track, index) => { track.votes = 100 - index; });
  await runtime.ensure(ensure);
  assert.equal(context.writes(), 1);
  const heard = [];
  for (let index = 0; index < 10; index++) {
    const song = runtime.next(playlist);
    heard.push(song.openingRank);
    assert.equal(song.encore, false);
    await runtime.advance(song);
  }
  assert.deepEqual(heard, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.equal(runtime.next(playlist).openingRank, 10);
  assert.equal(runtime.next(playlist).encore, true);
});

test('durable restart restores opening selection and position without re-snapshotting or replaying started songs', async () => {
  const context = await setup(3);
  const first = context.runtime.next(context.playlist);
  await context.runtime.advance(first);
  const restarted = context.createTopTenHype({ store: context.store, now: () => opening + 120_000 });
  context.report.tracks[0].votes = -100;
  await restarted.ensure(context.ensure);
  assert.equal(context.writes(), 2);
  assert.equal(restarted.next(context.playlist).openingRank, 2);
  assert.equal(restarted.publicState(context.show).tracks[0].trackId, 'song-0');
  assert.equal(restarted.publicState(context.show).lastStarted.openingRank, 3);
  assert.equal(restarted.publicState(context.show).lateSnapshot, false);
});

test('missing recordings are recorded as skips, do not change opening ranks, and cannot consume the same position twice', async () => {
  const context = await setup(3);
  const selection = context.runtime.next([]);
  assert.equal(selection.track, undefined);
  await context.runtime.advance(selection, 'Recording unavailable');
  assert.equal(context.runtime.next(context.playlist).openingRank, 2);
  assert.equal(context.runtime.publicState(context.show).skipped[0].openingRank, 3);
  await assert.rejects(context.runtime.advance(selection), /position changed/);
  await context.runtime.recordFailure(context.runtime.next(context.playlist).trackId, 'Audio playback failed');
  assert.equal(context.runtime.next(context.playlist).openingRank, 2, 'reporting a playback error must not consume another place');
  assert.equal(context.runtime.publicState(context.show).skipped.length, 2);
});

test('empty opening chart stays empty, never silently becomes regular rotation or a later chart', async () => {
  const context = await setup(0);
  assert.equal(context.runtime.next([]), null);
  context.report.tracks.push({ trackId: 'later', votes: 10, plays: 1 });
  await context.runtime.ensure({ ...context.ensure, playlist: [{ trackId: 'later' }] });
  assert.equal(context.runtime.publicState(context.show).status, 'empty');
  assert.equal(context.writes(), 1);
});

test('checkpoint failures block countdown and preserve position until retry succeeds', async () => {
  const context = await setup(2);
  const song = context.runtime.next(context.playlist);
  const save = context.store.save;
  context.store.save = async () => { throw new Error('storage offline'); };
  await assert.rejects(context.runtime.advance(song), /storage offline/);
  assert.equal(context.runtime.next(context.playlist).openingRank, 2);
  assert.equal(context.runtime.publicState(context.show).status, 'unavailable');
  context.store.save = save;
  await context.runtime.advance(song);
  assert.equal(context.runtime.next(context.playlist).openingRank, 1);
  assert.equal(context.runtime.publicState(context.show).status, 'ready');
});

test('no durable store, failed restore, and unconfirmed saves never create a success-shaped countdown', async () => {
  const context = await setup(1);
  const missing = context.createTopTenHype({ now: () => opening });
  await assert.rejects(missing.ensure(context.ensure), /durable/);
  const failed = context.createTopTenHype({ store: { restore: async () => { throw new Error('restore failed'); } } });
  await assert.rejects(failed.ensure(context.ensure), /restore failed/);
  const unconfirmed = context.createTopTenHype({ store: { restore: async () => null, save: async () => null }, now: () => opening });
  await assert.rejects(unconfirmed.ensure(context.ensure), /did not confirm/);
});

test('a new Friday gets a new snapshot; a late first capture is explicitly flagged; other shows have no Hype state', async () => {
  const context = await setup(2);
  const { resolveActiveShow } = await import('../js/radio-schedule.mjs');
  const nextFriday = opening + 7 * 86400_000;
  const late = context.createTopTenHype({ store: context.store, now: () => nextFriday + 60_000 });
  const show = resolveActiveShow({ now: nextFriday });
  await late.ensure({ ...context.ensure, show, report: { ...context.report, week: 'NY-2026-10-19' } });
  assert.equal(late.publicState(show).lateSnapshot, true);
  assert.equal(late.publicState(show).cursor, 0);
  assert.equal(late.publicState({ id: 'weekly-top10-final-listen' }), null);
  assert.equal(late.publicState({ id: 'normal-rotation' }), null);
});

test('Friday instance bounds are stable across the hour and DST, with the exact scheduled 9pm handoff', async () => {
  const { resolveActiveShow } = await import('../js/radio-schedule.mjs');
  for (const timestamp of ['2026-10-17T00:00:00Z', '2026-11-07T01:00:00Z']) {
    const start = Date.parse(timestamp);
    const first = resolveActiveShow({ now: start });
    const last = resolveActiveShow({ now: start + 3599_999 });
    assert.equal(last.instanceId, first.instanceId);
    assert.equal(Date.parse(first.startAt), start);
    assert.equal(Date.parse(first.endAt), start + 3600_000);
    assert.equal(resolveActiveShow({ now: start - 1 }).type, 'normal_rotation');
    assert.equal(resolveActiveShow({ now: start + 3600_000 }).type, 'live_performance');
  }
});

test('initial checkpoint retries preserve the first observed opening chart while votes change', async () => {
  const context = await setup(3);
  let snapshot = null;
  const store = { restore: async () => null, save: async () => { throw new Error('checkpoint offline'); } };
  const runtime = context.createTopTenHype({ store, now: () => opening });
  await assert.rejects(runtime.ensure(context.ensure), /checkpoint offline/);
  context.report.tracks[2].votes = 100;
  store.save = async value => { snapshot = value; return 'ipfs://confirmed'; };
  await runtime.ensure(context.ensure);
  assert.equal(snapshot.tracks[0].trackId, 'song-0');
  assert.equal(runtime.next(context.playlist).trackId, 'song-2');
});
