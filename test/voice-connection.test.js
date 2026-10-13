const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

test('voice connection supervisor reconnects on disconnect and reports reconnecting state', async () => {
  const { createVoiceConnectionSupervisor } = await import('../discord-bot/voice-connection.js');
  const connectionEvents = [];
  const connections = [];
  class MockConnection extends EventEmitter {
    constructor(id) {
      super();
      this.id = id;
      this.subscribed = 0;
    }
    subscribe() { this.subscribed++; }
    destroy() { this.emit('destroyed'); }
  }
  const joinVoiceChannel = () => {
    const connection = new MockConnection(`conn-${connections.length + 1}`);
    connections.push(connection);
    return connection;
  };
  const entersState = async (connection, state) => {
    connectionEvents.push([connection.id, state]);
    if (state === 'ready') return;
    throw new Error('voice timeout');
  };
  const supervisor = createVoiceConnectionSupervisor({
    name: 'test-voice',
    voiceChannel: { name: 'Test Voice', id: 'voice-1', guild: { id: 'guild-1', voiceAdapterCreator: {} } },
    joinVoiceChannel,
    entersState,
    VoiceConnectionStatus: { Ready: 'ready', Disconnected: 'disconnected', Signalling: 'signalling', Connecting: 'connecting', Destroyed: 'destroyed' },
    retryDelay: () => 0,
    log: { log() {}, warn() {}, error() {} },
  });

  await supervisor.connect();
  assert.equal(connections.length, 1);
  assert.equal(connections[0].subscribed, 1);
  assert.equal(supervisor.getState().voiceConnected, true);

  connections[0].emit('disconnected');
  assert.equal(supervisor.getState().voiceConnected, false);
  assert.equal(supervisor.getState().reconnecting, true);

  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(connections.length, 2);
  assert.equal(connections[1].subscribed, 1);
  assert.equal(supervisor.getState().voiceConnected, true);
  assert.equal(supervisor.getState().reconnecting, false);
  assert.ok(connectionEvents.some(([, state]) => state === 'signalling' || state === 'connecting'));
  supervisor.stop();
});

test('voice connection supervisor stops without rejoining after retry delay', async () => {
  const { createVoiceConnectionSupervisor } = await import('../discord-bot/voice-connection.js');
  const timers = [];
  let joins = 0;
  class MockConnection extends EventEmitter {
    subscribe() {}
    destroy() { this.emit('destroyed'); }
  }
  const supervisor = createVoiceConnectionSupervisor({
    name: 'test-voice',
    voiceChannel: { name: 'Test Voice', id: 'voice-1', guild: { id: 'guild-1', voiceAdapterCreator: {} } },
    joinVoiceChannel: () => { joins++; return new MockConnection(); },
    entersState: async (_connection, state) => {
      if (state === 'ready') throw new Error('startup failed');
      throw new Error('voice timeout');
    },
    VoiceConnectionStatus: { Ready: 'ready', Disconnected: 'disconnected', Signalling: 'signalling', Connecting: 'connecting', Destroyed: 'destroyed' },
    retryDelay: () => 123,
    setTimer: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimer: timer => { timer.cleared = true; },
    log: { log() {}, warn() {}, error() {} },
  });

  const connectPromise = supervisor.connect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(joins, 1);
  assert.equal(timers[0].delay, 123);
  supervisor.stop();
  timers[0].callback();
  await connectPromise;
  assert.equal(joins, 1);
});

test('voice reconnect delay caps at one minute', async () => {
  const { getVoiceReconnectDelay } = await import('../discord-bot/voice-connection.js');
  assert.equal(getVoiceReconnectDelay(1), 2_000);
  assert.equal(getVoiceReconnectDelay(2), 4_000);
  assert.equal(getVoiceReconnectDelay(6), 60_000);
  assert.equal(getVoiceReconnectDelay(10), 60_000);
});
