const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { MessageFlags } = require('discord.js');

test('AdLoop exposes the live play and records only completed audible non-main impressions', async () => {
  const { createDevertLoopController } = await import('../discord-bot/devert-loop.js');
  const player = new EventEmitter();
  const impressions = [];
  const timers = [];
  const ad = { campaignId: '17', track: { title: 'Advert', ipfsCid: 'bafy-ad', mediaType: 'video/mp4' } };
  const announcements = [];
  let now = 10_000;
  player.play = () => {};
  const controller = createDevertLoopController({
    player,
    playback: {
      nextDevertLoopAd: async () => ad,
      recordCampaignImpression: async impression => impressions.push(impression),
    },
    voiceChannel: { name: 'AdLoop' },
    textChannel: { send: message => { announcements.push(message); return Promise.resolve(); } },
    resolveAdUrl: async cid => `https://gateway.example/ipfs/${cid}`,
    createStream: () => ({ stdout: {}, kill() {} }),
    createResource: stream => stream,
    now: () => now,
    setTimer: (callback, delay) => { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; },
    clearTimer: () => {},
    log: { log() {}, warn() {}, error() {} },
  });

  await controller.start();
  assert.deepEqual(announcements, [{ content: '📢 **AdLoop:** Advert', flags: MessageFlags.SuppressNotifications }]);
  assert.equal(controller.getState().ready, true);
  assert.equal(controller.getState().nowPlaying.audible, false);
  assert.deepEqual(impressions, []);
  player.emit('stateChange', { status: 'buffering' }, { status: 'playing' });
  now += 35_000;
  assert.equal(controller.getState().nowPlaying.positionMs, 35_000);
  player.emit('idle');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(impressions.map(({ campaignId, radioPlayId, mainRadio, audibleMs }) => ({ campaignId, radioPlayId, mainRadio, audibleMs })), [
    { campaignId: '17', radioPlayId: 'devert-loop:17:10000', mainRadio: false, audibleMs: 35_000 },
  ]);
  assert.equal(controller.getState().nowPlaying, null);
  assert.equal(timers[0].delay, 1_500);
  controller.stop();
});

test('AdLoop retries unstreamable campaigns without reporting an impression', async () => {
  const { createDevertLoopController } = await import('../discord-bot/devert-loop.js');
  const player = new EventEmitter();
  const timers = [];
  let impressions = 0;
  player.play = () => {};
  const controller = createDevertLoopController({
    player, playback: { nextDevertLoopAd: async () => ({ campaignId: '18', track: { ipfsCid: 'bafy' } }),
      recordCampaignImpression: async () => { impressions++; } },
    voiceChannel: { name: 'AdLoop' }, resolveAdUrl: async () => null,
    createStream: () => { throw new Error('must not stream without a URL'); }, createResource: stream => stream,
    now: () => 100, setTimer: (callback, delay) => { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; },
    clearTimer: () => {}, log: { log() {}, warn() {}, error() {} },
  });
  await controller.start();
  assert.equal(controller.getState().nowPlaying, null);
  assert.equal(impressions, 0);
  assert.equal(timers[0].delay, 1_000);
  controller.stop();
});