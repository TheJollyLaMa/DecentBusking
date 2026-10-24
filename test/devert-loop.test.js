const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { createRequire } = require('node:module');

const botRequire = createRequire(path.join(__dirname, '../discord-bot/package.json'));
const { MessageFlags } = botRequire('discord.js');

test('configured DVert Discord credentials do not start Discord unless explicitly enabled', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../discord-bot/index.js'), 'utf8');
  const settings = source.indexOf('const missingDevertLoopSettings');
  const startup = source.slice(source.lastIndexOf('  if (readDevertState', settings),
    source.indexOf('  const creatorStore', settings));
  for (const enabled of [undefined, 'false', 'true']) {
    let websiteStarts = 0;
    let discordStarts = 0;
    const context = vm.createContext({
      process: { env: { DVERT_LOOP_DISCORD_ENABLED: enabled, DVERT_LOOP_DISCORD_TOKEN: 'configured',
        VERT_LOOP_CHANNEL_ID: 'text', VERTLOOP_VOICE_CHANNEL_ID: 'voice', DVERT_LOOP_AD_INTAKE_ENABLED: 'true' } },
      readDevertState: () => {}, devertSchedulerPrivateKey: 'configured', config: { pinataJwt: 'configured' },
      _devertPlaybackRuntime: {}, _devertLoopWorker: null,
      discordDiagnostics: { bot: () => ({}) }, discordAbort: { signal: {} },
      startDevertWebsiteLoopWorker: async () => { websiteStarts++; return { delivery: 'website' }; },
      startDevertLoopWorker: async () => { discordStarts++; return {}; },
      recoverDiscordConnection: async options => options.onConnected(await options.connect()),
      console,
    });
    await vm.runInContext(`(async () => { ${startup} })()`, context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(websiteStarts, enabled === 'true' ? 0 : 1);
    assert.equal(discordStarts, enabled === 'true' ? 1 : 0);
  }
});

test('website loop advances without a voice subscriber and exposes no Discord connection', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../discord-bot/devert-loop.js'), 'utf8');
  let playerOptions;
  let controllerOptions;
  let started = false;
  const player = {};
  const context = vm.createContext({
    NoSubscriberBehavior: { Play: 'play' },
    createAudioPlayer: options => { playerOptions = options; return player; },
    createDevertLoopController: options => {
      controllerOptions = options;
      return { start: async () => { started = true; }, getState: () => ({ ready: true, nowPlaying: null }) };
    },
    console: { log() {} },
  });
  vm.runInContext(source.slice(source.indexOf('export async function startDevertWebsiteLoopWorker'),
    source.indexOf('export async function startDevertLoopWorker')).replace('export ', ''), context);
  const worker = await context.startDevertWebsiteLoopWorker({ playback: {} });
  assert.equal(started, true);
  assert.equal(playerOptions.behaviors.noSubscriber, 'play');
  assert.equal(controllerOptions.player, player);
  assert.equal(controllerOptions.textChannel, undefined);
  assert.equal(controllerOptions.recordImpressions, false);
  assert.equal(worker.getState().delivery, 'website');
  assert.equal(worker.getState().discord.enabled, false);
  assert.equal(worker.getState().discord.voiceConnected, false);
  assert.equal(worker.getState().voiceConnected, undefined);
});

test('website-only controller retains browser playback and votes without broadcast impressions or posts', async () => {
  const { createDevertLoopController } = await import('../discord-bot/devert-loop.js');
  const { normalizeAdLoopNowPlaying } = await import('../js/devert-tab.mjs');
  const player = new EventEmitter();
  let now = 10_000;
  const timers = [];
  const votes = [];
  player.play = () => {};
  player.stop = () => player.emit('idle');
  const controller = createDevertLoopController({
    player, recordImpressions: false,
    playback: {
      nextDevertLoopAd: async () => ({ campaignId: '17', track: { title: 'Website ad', ipfsCid: 'bafy-ad' } }),
      recordCampaignImpression: () => assert.fail('no broadcast impression for a website-only media clock'),
      recordMainRadioAdVote: async vote => { votes.push(vote); return vote; },
    },
    voiceChannel: { name: 'website only' },
    resolveAdUrl: async () => 'https://media.example/ad',
    createStream: () => ({ stdout: {}, kill() {} }), createResource: stream => stream,
    now: () => now,
    setTimer: (callback, delay) => { timers.push({ callback, delay }); return { unref() {} }; },
    clearTimer() {}, log: { log() {}, warn() {}, error() {} },
  });
  await controller.start();
  player.emit('stateChange', { status: 'buffering' }, { status: 'playing' });
  now += 35_000;
  assert.equal(normalizeAdLoopNowPlaying(controller.getState()).positionMs, 35_000);
  await controller.submitVote({ playId: 'devert-loop:17:10000', voterId: 'listener-browser-0001', vote: 1 });
  assert.equal(votes.length, 1);
  player.emit('idle');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers[0].delay, 1_500);
  await timers[0].callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.getState().nowPlaying.radioPlayId, 'devert-loop:17:45000');
  controller.stop();
  assert.equal(controller.getState().ready, false);
  assert.equal(controller.getState().nowPlaying, null);
  assert.equal(timers.length, 1);
});

test('stopping a loop during campaign lookup cannot start later media or announcements', async () => {
  const { createDevertLoopController } = await import('../discord-bot/devert-loop.js');
  let resolveAd;
  const player = new EventEmitter();
  const controller = createDevertLoopController({
    player, playback: { nextDevertLoopAd: () => new Promise(resolve => { resolveAd = resolve; }) },
    voiceChannel: { name: 'website only' },
    resolveAdUrl: () => assert.fail('must not look up media after stopping'),
    textChannel: { send: () => assert.fail('must not announce after stopping') },
  });
  const starting = controller.start();
  controller.stop();
  resolveAd({ campaignId: '17', track: { ipfsCid: 'bafy-ad' } });
  await starting;
  assert.equal(controller.getState().nowPlaying, null);
});

test('website media clock actually plays PCM with no Discord voice connection', async () => {
  const { Readable } = require('node:stream');
  const { createAudioPlayer, entersState, AudioPlayerStatus, NoSubscriberBehavior } = botRequire('@discordjs/voice');
  const { createDevertLoopController } = await import('../discord-bot/devert-loop.js');
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  const controller = createDevertLoopController({
    player, recordImpressions: false,
    playback: { nextDevertLoopAd: async () => ({ campaignId: '17', track: { title: 'Local test', ipfsCid: 'local-test' } }),
      recordCampaignImpression: () => assert.fail('not a paid broadcast') },
    voiceChannel: { name: 'website only' },
    resolveAdUrl: async () => 'local-test',
    createStream: () => {
      const stdout = Readable.from([Buffer.alloc(48_000 * 2 * 2)]);
      return { stdout, kill: () => stdout.destroy() };
    },
    log: { log() {}, warn() {}, error() {} },
  });
  try {
    await controller.start();
    await entersState(player, AudioPlayerStatus.Playing, 3_000);
    assert.equal(controller.getState().nowPlaying.audible, true);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.ok(controller.getState().nowPlaying.positionMs > 0);
  } finally {
    controller.stop();
  }
  assert.equal(player.state.status, AudioPlayerStatus.Idle);
});

test('VertLoop uses a separate voice registry without replacing DBusker connection', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const { joinVoiceChannel, getVoiceConnection, createAudioPlayer } = botRequire('@discordjs/voice');
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
    GatewayIntentBits: {}, DISCORD_REST_OPTIONS: {}, joinVoiceChannel, entersState: async () => {}, VoiceConnectionStatus: {},
    createVoiceConnectionSupervisor: options => {
      const connection = options.joinVoiceChannel(options.joinOptions());
      options.subscribe?.(connection);
      return {
        connection,
        connect: async () => { await options.onReady?.(connection, { reconnected: false, elapsedMs: 0 }); },
        stop() { connection.destroy(); },
        getState: () => ({ voiceConnected: true, reconnecting: false }),
      };
    },
    createAudioPlayer, loginDiscordClient: (client, token) => client.login(token),
    watchDiscordSession: () => ({ closed: new Promise(() => {}), dispose() {} }),
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
    textChannel: { send: message => { announcements.push(message); return Promise.resolve({
      id: 'ad-announcement', react: () => assert.fail('must not seed Discord reactions'),
    }); } },
    resolveAdUrl: async cid => `https://gateway.example/ipfs/${cid}`,
    createStream: () => ({ stdout: {}, kill() {} }),
    createResource: stream => stream,
    now: () => now,
    setTimer: (callback, delay) => { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; },
    clearTimer: () => {},
    log: { log() {}, warn() {}, error() {} },
  });

  await controller.start();
  assert.deepEqual(announcements, [{ content: '📢 **AdLoop:** Advert\n[Listen and vote on DecentBusking](https://thejollylama.github.io/DecentBusking/)', flags: MessageFlags.SuppressNotifications,
    allowedMentions: { parse: [] } }]);
  assert.equal(controller.getState().ready, true);
  assert.equal(controller.getState().nowPlaying.audible, false);
  assert.equal(controller.getState().nowPlaying.mediaType, 'video/mp4');
  assert.equal(controller.getState().nowPlaying.videoUrl, 'ipfs://bafy-ad');
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

test('VertLoop FFmpeg caps an ad output at 120 seconds', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require('node:path').join(__dirname, '../discord-bot/devert-loop.js'), 'utf8');
  let argumentsUsed;
  const context = vm.createContext({ FFMPEG_BIN: 'ffmpeg', DEVERT_MAX_AD_SECONDS: 120,
    spawn: (_binary, args) => { argumentsUsed = args; return { on() {} }; } });
  vm.runInContext(source.slice(source.indexOf('function createStream('), source.indexOf('export function createDevertLoopController')), context);
  context.createStream('https://media.example/ad.mp4');
  assert.equal(argumentsUsed[argumentsUsed.indexOf('-t') + 1], '120');
});

test('VertLoop removal stops the current ad and rejects one removed during media lookup', async () => {
  const { createDevertLoopController } = await import('../discord-bot/devert-loop.js');
  const player = new EventEmitter();
  let plays = 0;
  let stops = 0;
  let kills = 0;
  let removed = false;
  player.play = () => { plays++; };
  player.stop = () => { stops++; };
  const controller = createDevertLoopController({ player,
    playback: { nextDevertLoopAd: async () => ({ campaignId: '1', track: { title: 'Ad', ipfsCid: 'cid' } }),
      isCampaignRemoved: () => removed },
    voiceChannel: { name: 'AdLoop' }, resolveAdUrl: async () => 'https://example.test/ad',
    createStream: () => ({ stdout: {}, kill: () => { kills++; } }), createResource: stream => stream,
    setTimer: () => ({ unref() {} }), clearTimer() {}, log: { log() {}, warn() {} } });
  await controller.start();
  controller.removeCampaign('2');
  assert.equal(stops, 0);
  controller.removeCampaign('1');
  assert.equal(stops, 1);
  assert.equal(kills, 1);
  assert.equal(controller.getState().nowPlaying, null);
  removed = true;
  await controller.start();
  assert.equal(plays, 1);
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