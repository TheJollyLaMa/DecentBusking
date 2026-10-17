const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

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
      }, fail: async record => released.push(record.requestId) },
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
