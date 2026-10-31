const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const FRIDAY_LIVE = Date.parse('2026-10-30T21:01:00-04:00');
const occurrenceId = 'friday-live-performance:2026-10-30';
const ad = id => ({ campaignId: String(id), mainRadio: true,
  track: { trackId: `ad:${id}`, title: `Advert ${id}`, filename: 'ad.mp4', mediaType: 'video/mp4' } });

async function setup(t, campaigns = [], options = {}, mockClock = true) {
  const { JukeLoopSession } = await import('../discord-bot/jukeloop.js');
  if (mockClock) t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: FRIDAY_LIVE });
  const player = new EventEmitter();
  player.state = { status: 'idle' };
  player.play = () => { player.state = { status: 'playing' }; };
  player.stop = () => {};
  const streams = [];
  const selections = [];
  const snapshots = [];
  const session = new JukeLoopSession({
    client: {}, audioPlayer: player, websitePlayback: true,
    devertPlayback: {
      nextMainRadioAd: async request => { selections.push(request); return campaigns; },
      isCampaignRemoved: () => false,
    },
    saveMainRadioAdState: async state => { snapshots.push(state); return 'ipfs://test-checkpoint'; },
    createStream: () => {
      const stream = new PassThrough();
      stream.write(Buffer.from('ready audio'));
      streams.push(stream);
      const ffmpegProcess = new EventEmitter();
      ffmpegProcess.kill = () => {};
      return { stream, ffmpegProcess };
    },
    ...options,
  });
  session._queue = [{ trackId: 'music', title: 'Next song', filename: 'song.mp3' }];
  session._getFreshUrl = async track => `https://media.example/${track.trackId}`;
  session._announcePrepared = async () => {};
  session._primeNext = () => {};
  t.after(() => { session.destroy(); streams.forEach(stream => stream.destroy()); });
  return { session, selections, snapshots };
}

for (const count of [0, 1, 3, 4, 6]) {
  test(`unbooked live slot plays ${Math.min(count, 4)} of ${count} available ads once, then music`, async t => {
    const { session, selections, snapshots } = await setup(t, Array.from({ length: count }, (_, i) => ad(i + 1)));
    session._musicSinceAd = 6;
    for (let i = 0; i < Math.min(count, 4); i++) {
      const prepared = await session._prepareNextPlayback();
      assert.equal(prepared.track.trackId, `ad:${i + 1}`);
      assert.equal(prepared.devertAd.mainRadio, true);
      assert.equal(session._breakAwaitingUnlock, false);
      assert.equal(session._startPrepared(prepared), true);
      session._currentDevertAd = null;
    }
    const music = await session._prepareNextPlayback();
    assert.equal(music.track.trackId, 'music');
    assert.equal(music.devertAd, null);
    session._disposePrepared(music);
    const again = await session._prepareNextPlayback();
    assert.equal(again.track.trackId, 'music');
    session._disposePrepared(again);
    assert.equal(selections.length, 1, 'one fallback selection for the entire occurrence');
    assert.equal(selections[0].count, 4);
    assert.equal(session.getPlaybackStatus().status === 'paused', false);
    assert.equal(snapshots.at(-1).unbookedLiveOccurrenceId, occurrenceId);
  });
}

test('fallback deduplicates campaigns already queued and does not poll paid requests between ads', async t => {
  const { session, selections } = await setup(t, [ad(1), ad(2), ad(2), ad(3), ad(4)], {
    djuke: { nextPaid: () => assert.fail('fallback ads must not be displaced by paid polling') },
  });
  session._preparedDevertAd = ad(1);
  session._breakAwaitingUnlock = true;
  for (const id of [1, 2, 3, 4]) {
    const prepared = await session._prepareNextPlayback();
    assert.equal(prepared.devertAd.campaignId, String(id));
    session._startPrepared(prepared);
    session._currentDevertAd = null;
  }
  assert.equal(selections[0].count, 3);
  assert.ok(selections[0].excludeCampaignIds.includes('1'));
});

test('missing, thrown and undecodable advert media skip to music without refilling the break', async t => {
  const { session, selections } = await setup(t, [ad(1), ad(2), ad(3)]);
  const createStream = session._createStream;
  session._getFreshUrl = async track => {
    if (track.trackId === 'ad:1') return null;
    if (track.trackId === 'ad:2') throw new Error('Gateway unavailable');
    return `https://media.example/${track.trackId}`;
  };
  session._createStream = async url => {
    if (url.endsWith('ad:3')) throw new Error('Decoder unavailable');
    return createStream(url);
  };
  const prepared = await session._prepareNextPlayback();
  assert.equal(prepared.track.trackId, 'music');
  assert.equal(selections.length, 1);
  assert.equal(session._pendingDevertAds.length, 0);
  session._disposePrepared(prepared);
});

test('ad selection outage returns directly to music and logs an explicit skip reason', async t => {
  const { session } = await setup(t, [], {
    devertPlayback: { nextMainRadioAd: async () => { throw new Error('Campaign service unavailable'); } },
  });
  const prepared = await session._prepareNextPlayback();
  assert.equal(prepared.track.trackId, 'music');
  assert.match(session._lastMainRadioAdSkip.reason, /selection unavailable/);
  session._disposePrepared(prepared);
});

test('stalled advert selection is bounded and late results cannot replace music', async t => {
  const { session } = await setup(t, [], {
    devertPlayback: { nextMainRadioAd: () => new Promise(resolve => { release = resolve; }) },
  });
  let release;
  const preparing = session._prepareNextPlayback();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(10000);
  const prepared = await preparing;
  assert.equal(prepared.track.trackId, 'music');
  release([ad(1)]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session._preparedDevertAd, null);
  session._disposePrepared(prepared);
});

test('durable occurrence marker restores remaining ads without creating another break', async t => {
  const { session, selections } = await setup(t, [ad(1), ad(2), ad(3), ad(4)]);
  await session._ensureUnbookedLiveFallback(session.getShowState().activeShow);
  const first = await session._prepareNextPlayback();
  session._startPrepared(first);
  const saved = session._snapshotMainRadioAdState();
  assert.equal(saved.pendingDevertAds.length, 3);
  const restored = await setup(t, [], { restoreMainRadioAdState: async () => saved }, false);
  await restored.session._ensureMainRadioAdState();
  const next = await restored.session._prepareNextPlayback();
  assert.equal(next.devertAd.campaignId, '2');
  assert.equal(restored.selections.length, 0);
  assert.equal(selections.length, 1);
  restored.session._disposePrepared(next);
});

test('explicit booked event remains live and never selects fallback adverts', async t => {
  const { session, selections } = await setup(t, [ad(1)], {
    livePerformanceEvents: [{ id: 'booked', title: 'Booked artist', type: 'live_performance',
      startUtc: new Date(FRIDAY_LIVE - 60000).toISOString(),
      endUtc: new Date(FRIDAY_LIVE + 3600000).toISOString() }],
  });
  assert.equal(await session._prepareNextPlayback(), undefined);
  assert.equal(session.getPlaybackStatus().status, 'paused');
  assert.equal(selections.length, 0);
});
