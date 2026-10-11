const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { MessageFlags } = require('discord.js');

test('VertLoop uses a separate voice registry without replacing DBusker connection', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const { joinVoiceChannel, getVoiceConnection, createAudioPlayer } = await import('@discordjs/voice');
  const guildId = 'voice-isolation-test';
  const adapterCreator = () => ({ sendPayload: () => true, destroy() {} });
  const mainConnection = joinVoiceChannel({ channelId: 'jukeloop', guildId, adapterCreator });
  const voiceChannel = { id: 'vertloop', name: 'VertLoop', isVoiceBased: () => true,
    guild: { id: guildId, voiceAdapterCreator: adapterCreator } };
  class MockClient extends EventEmitter {
    constructor() {
      super();
      this.user = { id: 'ad-bot', tag: 'DVertLoop' };
      this.channels = { fetch: async () => voiceChannel };
    }
    async login() { this.emit('ready', this); }
    destroy() {}
  }
  const context = vm.createContext({ Client: MockClient, Events: { ClientReady: 'ready', Error: 'error' },
    GatewayIntentBits: {}, joinVoiceChannel, entersState: async () => {}, VoiceConnectionStatus: {},
    createAudioPlayer,
    createDevertLoopController: () => ({ start: async () => {}, stop() {}, getState: () => ({ ready: true }) }),
    console });
  const source = fs.readFileSync(require('node:path').join(__dirname, '../discord-bot/devert-loop.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('export async function startDevertLoopWorker')).replace('export ', ''), context);
  let worker;
  try {
    worker = await context.startDevertLoopWorker({ token: 'test', voiceChannelId: 'vertloop', playback: {} });
    assert.equal(getVoiceConnection(guildId), mainConnection);
    assert.equal(mainConnection.joinConfig.channelId, 'jukeloop');
    assert.equal(getVoiceConnection(guildId, 'devert:ad-bot').joinConfig.channelId, 'vertloop');
    worker.stop();
    worker = null;
    assert.equal(getVoiceConnection(guildId), mainConnection);
  } finally {
    worker?.stop();
    getVoiceConnection(guildId, 'devert:ad-bot')?.destroy();
    mainConnection.destroy();
  }
});

test('AdLoop exposes the live play and records only completed audible non-main impressions', async () => {
  const { createDevertLoopController } = await import('../discord-bot/devert-loop.js');
  const player = new EventEmitter();
  const impressions = [];
  const timers = [];
  const ad = { campaignId: '17', track: { title: 'Advert', ipfsCid: 'bafy-ad', mediaType: 'video/mp4' } };
  const announcements = [];
  const votes = [];
  let now = 10_000;
  player.play = () => {};
  const controller = createDevertLoopController({
    player,
    playback: {
      nextDevertLoopAd: async () => ad,
      recordCampaignImpression: async impression => impressions.push(impression),
      recordMainRadioAdVote: async vote => { votes.push(vote); return { ...vote, duplicate: false }; },
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
  assert.deepEqual(announcements, [{ content: '📢 **AdLoop:** Advert', flags: MessageFlags.SuppressNotifications,
    allowedMentions: { parse: [] } }]);
  assert.equal(controller.getState().ready, true);
  assert.equal(controller.getState().nowPlaying.audible, false);
  await assert.rejects(controller.submitVote({ playId: 'devert-loop:17:10000', voterId: 'listener-browser-0001', vote: 1 }), /audible/);
  assert.deepEqual(impressions, []);
  player.emit('stateChange', { status: 'buffering' }, { status: 'playing' });
  await assert.rejects(controller.submitVote({ playId: 'old-play', voterId: 'listener-browser-0001', vote: 1 }), /current/);
  await controller.submitVote({ playId: 'devert-loop:17:10000', voterId: 'listener-browser-0001', vote: 1 });
  assert.equal(votes[0].campaignId, '17');
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

test('VertLoop FFmpeg caps an ad output at 150 seconds', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require('node:path').join(__dirname, '../discord-bot/devert-loop.js'), 'utf8');
  let argumentsUsed;
  const context = vm.createContext({ FFMPEG_BIN: 'ffmpeg', DEVERT_MAX_AD_SECONDS: 150,
    spawn: (_binary, args) => { argumentsUsed = args; return { on() {} }; } });
  vm.runInContext(source.slice(source.indexOf('function createStream('), source.indexOf('export function createDevertLoopController')), context);
  context.createStream('https://media.example/ad.mp4');
  assert.equal(argumentsUsed[argumentsUsed.indexOf('-t') + 1], '150');
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