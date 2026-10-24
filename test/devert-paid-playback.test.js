const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

async function tierSession(t, tier, name) {
  const { JukeLoopSession } = await import('../discord-bot/jukeloop.js');
  const player = new EventEmitter();
  player.state = { status: 'playing' };
  player.play = () => {};
  player.stop = () => {};
  const calls = [];
  const inputs = [];
  const paid = { record: { requestId: `paid-${name}`, kind: 'devert', tier },
    track: { trackId: `paid-${name}`, title: 'Priority advert', campaignId: '7', mediaType: 'audio/mpeg' } };
  const ordinary = [8, 9].map(n => ({ campaignId: String(n), mainRadio: true,
    track: { trackId: `devert:${n}`, title: `Ordinary ${n}` } }));
  const session = new JukeLoopSession({
    voiceChannel: { guild: { id: name } }, client: {}, textChannel: { send: async () => ({}) },
    audioPlayer: player, djuke: {
      nextPaid: async options => { calls.push(options); return tier === 1 || options.allowBump ? paid : null; },
      fail: async () => {}, release: async () => {}, complete: async () => {},
    },
    devertPlayback: { nextMainRadioAd: async () => ordinary, isCampaignRemoved: () => false },
    createStream: () => {
      const stream = new PassThrough();
      stream.write(Buffer.alloc(19200));
      inputs.push(stream);
      const ffmpegProcess = new EventEmitter();
      ffmpegProcess.kill = () => {};
      return { stream, ffmpegProcess };
    },
  });
  t.after(() => session.destroy());
  session._getFreshUrl = async track => `https://media.example/${track.trackId}`;
  session._persistMainRadioAdState = async () => {};
  session._queue = [{ trackId: 'ordinary-music', title: 'Music' }];
  session._queueIndex = 0;
  return { session, calls, paid, ordinary, player, inputs };
}

test('a base-price bump cannot add an extra break, while double price can play after any song', async t => {
  for (const tier of [0, 1]) {
    const { session, calls } = await tierSession(t, tier, `slot-tier-${tier}`);
    session._musicSinceAd = 3;
    const prepared = await session._prepareNextPlayback();
    assert.equal(calls[0].allowBump, false);
    assert.equal(prepared.track.trackId, tier === 0 ? 'ordinary-music' : 'paid-slot-tier-1');
    session._disposePrepared(prepared);
  }
});

test('a queue bump replaces one normal advert slot and consumes cadence, without expanding the break', { timeout: 5000 }, async t => {
  const { DEVERT_SONGS_PER_MAIN_AD } = await import('../js/devert-scheduler.mjs');
  const { session, ordinary, player, inputs } = await tierSession(t, 0, 'bump-normal-slot');
  session._musicSinceAd = DEVERT_SONGS_PER_MAIN_AD;
  const prepared = await session._prepareNextPlayback();
  assert.equal(prepared.paid.record.tier, 0);
  assert.equal(session._preparedDevertAd, ordinary[0]);
  assert.equal(session._startPrepared(prepared), true);
  assert.equal(session._preparedDevertAd, null);
  assert.deepEqual(session._pendingDevertAds, [ordinary[1]], 'only the second original slot remains');
  session._playNext = async () => {};
  session._nowPlaying.audible = true;
  session._nowPlaying.startedAt = Date.now() - 5000;
  inputs[0].end();
  prepared.ffmpegProcess.emit('exit', 0, null);
  for await (const packet of prepared.resource.playStream) {
    assert.ok(packet.length > 0);
    prepared.resource.playbackDuration += 20;
  }
  player.emit('idle');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session._musicSinceAd, 0, 'normal-slot bump resets the normal advert cadence');
  assert.equal(session._musicPlayCount, 1);
});

test('a prefetched bump waits if the unlocking song does not count', async t => {
  const { DEVERT_SONGS_PER_MAIN_AD } = await import('../js/devert-scheduler.mjs');
  const { session } = await tierSession(t, 0, 'bump-short-song');
  session._musicSinceAd = DEVERT_SONGS_PER_MAIN_AD - 1;
  const prepared = await session._prepareNextPlayback(null, { projectedMusicSinceAd: DEVERT_SONGS_PER_MAIN_AD });
  assert.equal(prepared.paid.record.tier, 0);
  assert.equal(session._breakAwaitingUnlock, true);
  assert.equal(session._startPrepared(prepared), false);
});

test('an immediate purchase replaces a prepared bump but not one already playing', async t => {
  const { session, paid } = await tierSession(t, 0, 'preempt-bump');
  const released = [];
  session._preparedNext = { paid, track: paid.track, devertAd: { paidRequest: true },
    ffmpegProcess: { kill() {} } };
  session.djuke.release = async record => released.push(record.requestId);
  let selectionOptions;
  const immediate = { record: { kind: 'devert', tier: 1, requestId: 'immediate' }, track: { trackId: 'immediate' } };
  session.djuke.nextPaid = async options => { selectionOptions = options; return immediate; };
  session._prepareNextPlayback = async next => ({ paid: next, track: next.track });
  session._checkPreparedPaidPriority();
  await session._prepareTask;
  assert.deepEqual(selectionOptions, { allowBump: false, includeSongs: false });
  assert.deepEqual(released, [paid.record.requestId]);
  assert.equal(session._preparedNext.paid, immediate);
});

test('failed preemption retains the prepared bump and releases the immediate reservation', async t => {
  const { session, paid } = await tierSession(t, 0, 'preempt-checkpoint-failure');
  const original = { paid, track: paid.track, devertAd: { paidRequest: true }, ffmpegProcess: { kill() {} } };
  session._preparedNext = original;
  const releases = [];
  session.djuke.release = async record => {
    if (record === paid.record) throw new Error('Mirror temporarily offline');
    releases.push(record.requestId);
  };
  session.djuke.nextPaid = async () => ({ record: { requestId: 'immediate', kind: 'devert', tier: 1 } });
  session._checkPreparedPaidPriority();
  await session._prepareTask;
  assert.equal(session._preparedNext, original);
  assert.deepEqual(releases, ['immediate']);
});

for (const ending of ['natural', 'interrupted', 'error']) {
  test(`paid advert ${ending} ending preserves ordinary advert cadence and pending recordings`, async t => {
    const { createJukeLoopSession } = await import('../discord-bot/jukeloop.js');
    const player = new EventEmitter();
    player.state = { status: 'idle' };
    player.stop = () => {};
    const completed = [];
    const session = createJukeLoopSession(`paid-ad-${ending}`, {
      voiceChannel: { guild: { id: `paid-ad-${ending}` } },
      textChannel: { send: async () => ({}) }, client: {}, audioPlayer: player,
      djuke: { complete: async (...args) => completed.push(args), fail: async () => {} },
    });
    t.after(() => session.destroy());
    session._playNext = async () => {};
    const ordinary = { campaignId: 'ordinary' };
    session._preparedDevertAd = ordinary;
    session._pendingDevertAds = [ordinary];
    session._musicSinceAd = 9;
    session._musicPlayCount = 12;
    session._currentTrack = { trackId: 'devert-paid:0' };
    session._currentPaid = { requestId: 'paid-ad-0', kind: 'devert' };
    session._currentDevertAd = { campaignId: '9', paidRequest: true };
    session._nowPlaying = { trackId: 'devert-paid:0', playId: 'paid-play',
      startedAt: Date.now() - 40_000, audible: true };
    session._ffmpeg = { exitCode: ending === 'natural' ? 0 : null, kill() {} };
    session._activeAudio = { resource: {}, completion: {
      finish: async () => ({ finished: ending === 'natural', reason: ending === 'natural' ? 'clean_eof' : 'audio_stream_incomplete' }),
      interrupt() {},
    } };
    if (ending === 'error') player.emit('error', new Error('Test audio failure'));
    else player.emit('idle');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(session._musicSinceAd, 9);
    assert.equal(session._musicPlayCount, 12);
    assert.equal(session._preparedDevertAd, ordinary);
    assert.deepEqual(session._pendingDevertAds, [ordinary]);
    assert.equal(completed.length, 1);
    assert.equal(completed[0][0].kind, 'devert');
    assert.equal(completed[0][1]?.finished === true, ending === 'natural');
  });
}

test('prepared paid advert rechecks on-chain eligibility after the changeover and defers at protected-show boundaries', async t => {
  const { createJukeLoopSession } = await import('../discord-bot/jukeloop.js');
  for (const blockedBy of ['removal', 'weekly_top10', 'live_performance', 'during-recheck']) {
    const player = new EventEmitter();
    player.state = { status: 'idle' };
    player.stop = () => {};
    const released = [];
    let checks = 0;
    let starts = 0;
    let showType = ['removal', 'during-recheck'].includes(blockedBy) ? 'normal_rotation' : blockedBy;
    const session = createJukeLoopSession(`paid-ad-boundary-${blockedBy}`, {
      voiceChannel: { guild: { id: `paid-ad-boundary-${blockedBy}` } },
      textChannel: { send: async () => ({}) }, client: {}, audioPlayer: player,
      djuke: { canPlay: async () => {
        checks++;
        if (blockedBy === 'during-recheck') { showType = 'weekly_top10'; return true; }
        return false;
      }, release: async record => released.push(record.requestId) },
    });
    t.after(() => session.destroy());
    session._preparedNext = { paid: { record: { requestId: 'paid-ad-0', kind: 'devert' } },
      devertAd: { paidRequest: true }, ffmpegProcess: { kill() {} } };
    session._waitForChangeover = async prepared => prepared;
    session.getShowState = () => ({ activeShow: { id: 'test-show', type: showType } });
    const start = session._startPrepared.bind(session);
    session._startPrepared = prepared => { const result = start(prepared); if (result) starts++; return result; };
    await session._playNext();
    assert.equal(starts, 0);
    assert.equal(checks, ['removal', 'during-recheck'].includes(blockedBy) ? 1 : 0);
    assert.deepEqual(released, ['paid-ad-0']);
  }
});
