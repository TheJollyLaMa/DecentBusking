const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

function client() {
  const value = new EventEmitter();
  value.rest = new EventEmitter();
  return value;
}

test('Discord login waits for client readiness, not merely a resolved login call, and never logs token debug output', async () => {
  const { loginDiscordClient } = await import('../discord-bot/discord-login.js');
  const bot = client();
  const logs = [];
  bot.login = async () => {
    bot.emit('debug', 'Provided token: sensitive');
    bot.emit('debug', '[WS => Shard 0] Connecting to gateway\nsensitive payload');
    bot.rest.emit('rateLimited', { global: true, timeToReset: 5000 });
    bot.rest.emit('response', { path: '/gateway/bot', options: { token: 'sensitive' } },
      { status: 429, headers: new Map([['retry-after', '5']]) });
  };
  let done = false;
  const pending = loginDiscordClient(bot, 'sensitive', {
    log: { log: text => logs.push(text), warn: text => logs.push(text), error: text => logs.push(text) },
  }).then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false);
  bot.emit('clientReady', bot);
  await pending;
  assert.equal(done, true);
  assert.match(logs.join('\n'), /Connecting to gateway/);
  assert.match(logs.join('\n'), /retry after 5000ms/);
  assert.match(logs.join('\n'), /Gateway discovery HTTP 429; retry-after=5/);
  assert.doesNotMatch(logs.join('\n'), /sensitive/);
  assert.equal(bot.listenerCount('debug'), 0);
});

test('Discord startup fails explicitly on a stuck login so the service can restart', async () => {
  const { loginDiscordClient } = await import('../discord-bot/discord-login.js');
  const bot = client();
  bot.login = () => new Promise(() => {});
  await assert.rejects(loginDiscordClient(bot, 'token', { timeoutMs: 5, log: { log() {} } }), /did not become ready/);
  assert.equal(bot.listenerCount('clientReady'), 0);
});

test('Discord startup honors an explicit HTTP 429 cooldown instead of repeatedly restarting', async () => {
  const { loginDiscordClient } = await import('../discord-bot/discord-login.js');
  const bot = client();
  const reasons = [];
  bot.login = async () => {
    bot.rest.emit('response', { path: '/gateway/bot' },
      { status: 429, headers: new Map([['retry-after', '0.1']]) });
  };
  const pending = loginDiscordClient(bot, 'token', {
    timeoutMs: 5,
    log: { log() {}, warn() {} },
    onUnavailable: reason => reasons.push(reason),
  });
  const outcome = pending.then(() => 'ready', () => 'timeout');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(reasons[0], /Discord connection rate limited; retry after/);
  bot.emit('clientReady', bot);
  assert.equal(await outcome, 'ready');
});

test('a preserved cooldown prevents any gateway request until the recorded retry time', async () => {
  const { loginDiscordClient } = await import('../discord-bot/discord-login.js');
  const bot = client();
  let attempts = 0;
  const reasons = [];
  bot.login = async () => { attempts++; bot.emit('clientReady', bot); };
  const pending = loginDiscordClient(bot, 'token', {
    notBefore: new Date(Date.now() + 80).toISOString(), timeoutMs: 10,
    log: { log() {}, warn() {} }, onUnavailable: reason => reasons.push(reason),
  });

  test('recovery retries transient failures with increasing backoff and returns the successful fresh connection', async () => {
    const { recoverDiscordConnection } = await import('../discord-bot/discord-login.js');
    const { createDiscordDiagnostics } = await import('../discord-bot/discord-diagnostics.js');
    const log = { log() {}, warn() {}, error() {} };
    const diagnostics = createDiscordDiagnostics({ log });
    let attempts = 0;
    const delays = [];
    const result = await recoverDiscordConnection({
      name: 'dbusker', diagnostics, log, notBefore: null,
      wait: async ms => { delays.push(ms); },
      connect: async () => {
        if (++attempts < 3) throw Object.assign(new Error('private'), { code: 'ECONNRESET' });
        return { connected: true };
      },
    });
    assert.equal(attempts, 3);
    assert.ok(delays[0] >= 29000 && delays[1] >= 59000);
    assert.equal(result.connected, true);
    assert.equal(diagnostics.report().bots.dbusker.phase, 'ready');
    assert.equal(diagnostics.report().bots.dbusker.failures, 2);
  });

  test('fatal token, permission and intent failures stop retries and expose only a safe operator reason', async () => {
    const { recoverDiscordConnection } = await import('../discord-bot/discord-login.js');
    const { createDiscordDiagnostics } = await import('../discord-bot/discord-diagnostics.js');
    for (const failure of [{ code: 'TokenInvalid' }, { status: 401 }, { status: 403 }, { code: 4014 }]) {
      const log = { log() {}, warn() {}, error() {} };
      const diagnostics = createDiscordDiagnostics({ log });
      let attempts = 0;
      const reasons = [];
      const result = await recoverDiscordConnection({
        name: 'dbusker', diagnostics, log, notBefore: null,
        onUnavailable: value => reasons.push(value),
        connect: async () => { attempts++; throw Object.assign(new Error('private'), failure); },
        wait: () => assert.fail('fatal failures must never retry automatically'),
      });
      assert.equal(result, null);
      assert.equal(attempts, 1);
      assert.equal(diagnostics.report().bots.dbusker.phase, 'blocked');
      assert.doesNotMatch(reasons.join(' '), /private/);
    }
  });

  test('recovery restores cooldown before making any connection and can be cancelled without sending a request', async () => {
    const { recoverDiscordConnection } = await import('../discord-bot/discord-login.js');
    const { createDiscordDiagnostics } = await import('../discord-bot/discord-diagnostics.js');
    const log = { log() {}, warn() {}, error() {} };
    const controller = new AbortController();
    const diagnostics = createDiscordDiagnostics({ log, store: { restore: async () => ({
      schemaVersion: 1, networkCooldownUntil: Date.now() + 60000, bots: {},
    }) } });
    const pending = recoverDiscordConnection({
      name: 'dbusker', diagnostics, signal: controller.signal, notBefore: null, log,
      connect: () => assert.fail('must not connect during a restored cooldown'),
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(diagnostics.report().bots.dbusker.phase, 'cooldown');
    controller.abort();
    assert.equal(await pending, null);
    assert.equal(diagnostics.report().bots.dbusker.phase, 'stopped');
  });

  test('a failed cooldown restore is retried before any Discord request, never treated as an empty journal', async () => {
    const { recoverDiscordConnection } = await import('../discord-bot/discord-login.js');
    const { createDiscordDiagnostics } = await import('../discord-bot/discord-diagnostics.js');
    const log = { log() {}, warn() {}, error() {} };
    let restores = 0;
    const diagnostics = createDiscordDiagnostics({ log, store: { restore: async () => {
      if (++restores === 1) throw new Error('storage unavailable');
      return null;
    } } });
    let connections = 0;
    await recoverDiscordConnection({
      name: 'dbusker', diagnostics, log, notBefore: null, wait: async () => {},
      connect: async () => { connections++; assert.equal(restores, 2); return {}; },
    });
    assert.equal(connections, 1);
  });

  test('aborting a pending login removes temporary listeners and aborting after connect cleans up the connection', async () => {
    const { loginDiscordClient, recoverDiscordConnection } = await import('../discord-bot/discord-login.js');
    const { createDiscordDiagnostics } = await import('../discord-bot/discord-diagnostics.js');
    const bot = client();
    const controller = new AbortController();
    bot.login = () => new Promise(() => {});
    const log = { log() {}, warn() {}, error() {} };
    const pending = loginDiscordClient(bot, 'token', { signal: controller.signal, log });
    controller.abort();
    await assert.rejects(pending, /abort/i);
    assert.equal(bot.listenerCount('clientReady'), 0);
    assert.equal(bot.listenerCount('shardError'), 0);
    assert.equal(bot.rest.listenerCount('rateLimited'), 0);
    const lateAbort = new AbortController();
    let stopped = false;
    const diagnostics = createDiscordDiagnostics({ log });
    assert.equal(await recoverDiscordConnection({
      diagnostics, name: 'dbusker', log, signal: lateAbort.signal, notBefore: null,
      connect: async () => { lateAbort.abort(); return { stop: () => { stopped = true; } }; },
    }), null);
    assert.equal(stopped, true);
  });

  test('session invalidation reconnects a fresh client, fatal gateway closure stops, and active shutdown releases resources', async () => {
    const { recoverDiscordConnection, watchDiscordSession } = await import('../discord-bot/discord-login.js');
    const { createDiscordDiagnostics } = await import('../discord-bot/discord-diagnostics.js');
    const log = { log() {}, warn() {}, error() {} };
    const diagnostics = createDiscordDiagnostics({ log });
    const clients = [];
    let stopped = 0;
    await recoverDiscordConnection({
      name: 'dbusker', diagnostics, log, notBefore: null, wait: async () => {},
      connect: async () => {
        const bot = client();
        clients.push(bot);
        const watch = watchDiscordSession(bot);
        setImmediate(() => clients.length === 1
          ? bot.emit('invalidated')
          : bot.emit('shardDisconnect', { code: 4014 }, 0));
        return { closed: watch.closed, stop: () => { stopped++; watch.dispose(); } };
      },
    });

    test('main-bot recovery replaces failed clients, monitors command registration and never stops website audio', async () => {
      const fs = require('node:fs');
      const path = require('node:path');
      const vm = require('node:vm');
      const { Events } = await import('../discord-bot/node_modules/discord.js/src/index.js');
      const { recoverDiscordConnection, loginDiscordClient, watchDiscordSession } = await import('../discord-bot/discord-login.js');
      const { createDiscordDiagnostics } = await import('../discord-bot/discord-diagnostics.js');
      const log = { log() {}, warn() {}, error() {} };
      const diagnostics = createDiscordDiagnostics({ log });
      const controller = new AbortController();
      const clients = [];
      let outputs = 0;
      const broadcast = { player: { stop: () => assert.fail('Discord recovery must not stop website audio') } };
      class MockClient extends EventEmitter {
        constructor() {
          super();
          this.rest = new EventEmitter();
          this.rest.put = async () => this.rest.emit('response',
            { method: 'PUT', route: '/applications/:id/commands' }, { status: 200, headers: new Headers() });
          clients.push(this);
          this.user = { id: 'bot', tag: 'DBusker' };
        }
        isReady() { return this.ready === true; }
        async login() {
          if (clients.length === 1) throw Object.assign(new Error('connection interrupted'), { code: 'ECONNRESET' });
          this.ready = true;
          this.emit(Events.ClientReady, this);
        }
        async destroy() { this.destroyed = true; this.ready = false; }
      }
      const source = fs.readFileSync(path.join(__dirname, '../discord-bot/index.js'), 'utf8');
      const start = source.indexOf('  async function connectMainDiscord() {');
      const end = source.indexOf('\n  let mainDiscordConnection;', start);
      const context = vm.createContext({
        Client: MockClient, client: undefined, Events, GatewayIntentBits: {}, Partials: {}, console: log,
        discordDiagnostics: diagnostics, discordAbort: controller, discordOfflineReason: '',
        loginDiscordClient, watchDiscordSession, getActiveJukeLoopSession: () => broadcast,
        config: { discordToken: 'secret', jukeLoopTextChannelId: 'text' },
        Routes: { applicationCommands: () => '/applications/bot/commands' }, SLASH_COMMANDS: [],
        startJukeLoop: async () => { outputs++; },
        runWeeklyPlayReport: async () => {},
      });
      vm.runInContext(source.slice(start, end), context);
      await recoverDiscordConnection({
        diagnostics, name: 'dbusker', log, notBefore: null, signal: controller.signal,
        wait: async () => {}, connect: () => context.connectMainDiscord(),
        onConnected: () => controller.abort(),
      });
      assert.equal(clients.length, 2);
      assert.ok(clients.every(bot => bot.destroyed));
      assert.equal(broadcast.client, clients[1]);
      assert.equal(outputs, 1, 'outputs attach once on the successful client only');
      assert.equal(diagnostics.report().bots.dbusker.totals.requests, 1, 'command registration uses the monitored REST client');
      assert.ok(clients.every(bot => bot.rest.listenerCount('response') === 0));
    });
    assert.equal(clients.length, 2);
    assert.equal(stopped, 2);
    assert.equal(diagnostics.report().bots.dbusker.phase, 'blocked');
    assert.equal(clients[0].listenerCount('invalidated'), 0);

    const controller = new AbortController();
    await recoverDiscordConnection({
      name: 'dbusker', diagnostics, log, notBefore: null, signal: controller.signal,
      connect: async () => ({ closed: new Promise(() => {}), stop: () => { stopped++; } }),
      onConnected: () => controller.abort(),
    });
    assert.equal(stopped, 3);
    assert.equal(diagnostics.report().bots.dbusker.phase, 'stopped');
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(attempts, 0);
  assert.match(reasons[0], /cooldown/);
  await pending;
  assert.equal(attempts, 1);
  await assert.rejects(loginDiscordClient(bot, 'token', { notBefore: 'invalid' }), /valid timestamp/);
});
