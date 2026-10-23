const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

function client() {
  const value = new EventEmitter();
  value.rest = new EventEmitter();
  return value;
}

function logger() {
  const lines = [];
  return { lines, log: (...args) => lines.push(args.join(' ')),
    warn: (...args) => lines.push(args.join(' ')), error: (...args) => lines.push(args.join(' ')) };
}

test('Discord telemetry counts all REST errors but never captures identities, credentials, payloads or query strings', async () => {
  const { createDiscordDiagnostics, discordRoute } = await import('../discord-bot/discord-diagnostics.js');
  const log = logger();
  const diagnostics = createDiscordDiagnostics({ now: () => 1000, log });
  const bot = client();
  const detach = diagnostics.bot('dbusker').attach(bot);
  assert.equal(discordRoute('/webhooks/123456/secret-token/messages/@original?token=secret'), '/webhooks/:id/:id/messages/:id');
  bot.rest.emit('response', {
    method: 'POST', path: '/channels/123456/messages?secret=query',
    options: { headers: { authorization: 'secret' } }, data: { content: 'private-message' },
  }, { status: 403, headers: new Headers({ 'x-ratelimit-bucket': 'secret', 'cf-ray': 'secret' }) });
  bot.rest.emit('response', { method: 'GET', route: '/users/@me' }, { status: 200, headers: new Headers() });
  bot.emit('error', new Error('secret'));
  const report = diagnostics.report().bots.dbusker;
  assert.deepEqual(report.totals, { requests: 2, errors: 1, invalid: 1, rateLimits: 0 });
  assert.equal(report.routes[0].route, '/channels/:id/messages');
  assert.equal(report.recent[0].bucket, null);
  diagnostics.maintenance();
  assert.doesNotMatch(JSON.stringify(diagnostics.report()) + log.lines.join('\n'), /secret|private-message|123456|authorization/);
  detach();
  assert.equal(bot.rest.listenerCount('response'), 0);
  assert.equal(bot.rest.listenerCount('rateLimited'), 0);
  assert.equal(bot.listenerCount('error'), 0);
});

test('rolling invalid counts exclude shared-resource 429s, include 401/403/unscoped 429, and expire', async () => {
  const { createDiscordDiagnostics } = await import('../discord-bot/discord-diagnostics.js');
  let now = 1_000_000;
  const diagnostics = createDiscordDiagnostics({ now: () => now, log: logger() });
  const bot = client();
  diagnostics.bot('dbusker').attach(bot);
  for (const [status, scope] of [[401, 'user'], [403, 'user'], [429, 'shared'], [429, 'unknown'], [500, 'unknown']]) {
    bot.rest.emit('response', { method: 'GET', path: '/channels/123/messages' },
      { status, headers: new Headers({ 'x-ratelimit-scope': scope }) });
  }
  assert.equal(diagnostics.report().bots.dbusker.invalidLast10Minutes, 3);
  assert.equal(diagnostics.report().bots.dbusker.totals.errors, 5);
  now += 600_000;
  assert.equal(diagnostics.report().bots.dbusker.invalidLast10Minutes, 0);
  assert.equal(diagnostics.report().bots.dbusker.totals.invalid, 3);
});

test('gateway restrictions retain scope, edge correlation and format, and persist a shared conservative login cooldown', async () => {
  const { createDiscordDiagnostics } = await import('../discord-bot/discord-diagnostics.js');
  let saved;
  const store = { restore: async () => null, save: async value => { saved = structuredClone(value); return 'ipfs://cooldown'; } };
  const diagnostics = createDiscordDiagnostics({ store, now: () => 1000, log: logger() });
  await diagnostics.restore();
  const bot = client();
  diagnostics.bot('dbusker').attach(bot);
  diagnostics.bot('dbusker').setState('connecting');
  diagnostics.bot('devert-loop').setState('connecting');
  bot.rest.emit('response', { method: 'GET', path: '/gateway/bot' }, {
    status: 429, headers: new Headers({ 'retry-after': '66000', 'content-type': 'text/html',
      'cf-ray': 'abcdef0123456789-EWR' }),
  });
  await diagnostics.flush();
  assert.equal(saved.networkCooldownUntil, 66_001_000);
  assert.equal(diagnostics.bot('devert-loop').notBefore(), 66_001_000);
  for (const name of ['dbusker', 'devert-loop']) {
    assert.equal(diagnostics.report().bots[name].phase, 'cooldown');
    assert.equal(diagnostics.report().bots[name].retryAt, 66_001_000);
  }
  const restarted = createDiscordDiagnostics({ store: { restore: async () => saved }, now: () => 2000, log: logger() });
  await restarted.restore();
  assert.equal(restarted.bot('dbusker').notBefore(), 66_001_000);
  assert.equal(restarted.report().bots.dbusker.lastRestriction.edgeRequestId, 'abcdef0123456789-EWR');
  assert.equal(restarted.report().bots.dbusker.lastRestriction.responseFormat, 'html');
  assert.equal(restarted.report().bots.dbusker.lastRestriction.scope, 'unknown');
  assert.equal(restarted.report().bots.dbusker.totals.requests, 0, 'in-memory counts must not pretend to survive restarts');
});

test('route-specific throttles do not block unrelated bot login, global throttles do not imply an IP ban', async () => {
  const { createDiscordDiagnostics } = await import('../discord-bot/discord-diagnostics.js');
  const diagnostics = createDiscordDiagnostics({ now: () => 1000, log: logger() });
  const bot = client();
  diagnostics.bot('dbusker').attach(bot);
  bot.rest.emit('response', { method: 'POST', route: '/channels/:id/messages' },
    { status: 429, headers: new Headers({ 'retry-after': '30', 'x-ratelimit-scope': 'shared' }) });
  assert.equal(diagnostics.bot('dbusker').notBefore(), 0);
  diagnostics.bot('dbusker').setState('ready');
  bot.rest.emit('response', { method: 'GET', route: '/users/@me' },
    { status: 429, headers: new Headers({ 'retry-after': '30', 'x-ratelimit-global': 'true' }) });
  assert.equal(diagnostics.bot('dbusker').notBefore(), 31000);
  assert.equal(diagnostics.bot('devert-loop').notBefore(), 0);
  assert.equal(diagnostics.report().bots.dbusker.phase, 'ready', 'a REST throttle must not mark an established gateway offline');
});

test('diagnostic memory and logs stay bounded during an error storm and summaries flag invalid-request spikes', async () => {
  const { createDiscordDiagnostics } = await import('../discord-bot/discord-diagnostics.js');
  const log = logger();
  const diagnostics = createDiscordDiagnostics({ now: () => 1000, log });
  const bot = client();
  diagnostics.bot('dbusker').attach(bot);
  for (let i = 0; i < 1000; i++) {
    bot.rest.emit('response', { method: 'GET', path: `/channels/${i}/messages` }, { status: 403, headers: new Headers() });
  }
  assert.equal(log.lines.length, 1, 'repeated errors are summarized, not logged one per request');
  diagnostics.maintenance();
  const count = log.lines.length;
  diagnostics.maintenance();
  assert.equal(log.lines.length, count, 'unchanged summaries are not repeated');
  assert.match(log.lines.at(-1), /"invalidRequestWarning":true/);
  const report = diagnostics.report().bots.dbusker;
  assert.equal(report.recent.length, 30);
  assert.equal(report.routes.length, 1);
  assert.equal(report.routes[0].count, 1000);
});

test('cooldown persistence failures are explicit, retried by maintenance, and corrupt restore never authorizes login', async () => {
  const { createDiscordDiagnostics } = await import('../discord-bot/discord-diagnostics.js');
  let fail = true;
  const log = logger();
  const diagnostics = createDiscordDiagnostics({
    now: () => 1000, log, store: { restore: async () => null, save: async () => {
      if (fail) throw new Error('secret-store-details'); return 'ipfs://saved';
    } },
  });
  await diagnostics.restore();
  const bot = client();
  diagnostics.bot('dbusker').attach(bot);
  bot.rest.emit('response', { path: '/gateway/bot' }, { status: 429, headers: new Headers({ 'retry-after': '5' }) });
  await assert.rejects(diagnostics.flush(), /secret-store-details/);
  assert.equal(diagnostics.report().persistence, 'failed');
  assert.equal(diagnostics.bot('dbusker').notBefore(), 6000);
  assert.doesNotMatch(log.lines.join('\n'), /secret-store-details/);
  fail = false;
  diagnostics.maintenance();
  await diagnostics.flush();
  assert.equal(diagnostics.report().persistence, 'saved');
  const corrupt = createDiscordDiagnostics({ store: { restore: async () => ({ schemaVersion: 999 }) }, log });
  await assert.rejects(corrupt.restore(), /Invalid Discord/);
  assert.equal(corrupt.report().persistence, 'restore-failed');
});

test('Retry-After seconds and dates and reset-after are parsed conservatively', async () => {
  const { discordRetryAt } = await import('../discord-bot/discord-diagnostics.js');
  assert.equal(discordRetryAt(new Headers({ 'retry-after': '0.25' }), 1000), 1250);
  assert.equal(discordRetryAt(new Headers({ 'retry-after': 'Thu, 01 Jan 1970 00:00:05 GMT' }), 1000), 5000);
  assert.equal(discordRetryAt(new Headers({ 'retry-after': '2', 'x-ratelimit-reset-after': '4' }), 1000), 5000);
  assert.equal(discordRetryAt(new Headers({ 'retry-after': 'not-a-date' }), 1000), 0);
});

test('connection lifecycle and rate-limit waits remain observable after login', async () => {
  const { createDiscordDiagnostics } = await import('../discord-bot/discord-diagnostics.js');
  const diagnostics = createDiscordDiagnostics({ log: logger() });
  const bot = client();
  diagnostics.bot('dbusker').attach(bot);
  bot.emit('clientReady', bot);
  assert.equal(diagnostics.report().bots.dbusker.phase, 'ready');
  bot.emit('shardDisconnect', { code: 1006 }, 0);
  assert.equal(diagnostics.report().bots.dbusker.phase, 'disconnected');
  bot.rest.emit('rateLimited', { route: '/webhooks/123/secret', global: false, timeToReset: 1000, url: 'secret' });
  assert.doesNotMatch(JSON.stringify(diagnostics.report()), /secret|123/);
});
