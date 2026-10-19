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
