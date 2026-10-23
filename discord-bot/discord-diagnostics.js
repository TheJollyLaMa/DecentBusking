import { Events } from 'discord.js';

const WINDOW_MS = 10 * 60_000;
const MAX_EVENTS = 30;
const BOTS = ['dbusker', 'devert-loop'];
const ROUTE_PARTS = new Set([
  'gateway', 'bot', 'channels', 'messages', 'reactions', 'users', '@me',
  'guilds', 'members', 'roles', 'applications', 'commands', 'permissions',
  'interactions', 'callback', 'webhooks', 'original', 'bulk-delete',
]);

export function discordRoute(value) {
  return '/' + String(value || '').split('?')[0].split('/').filter(Boolean).slice(0, 10)
    .map(part => ROUTE_PARTS.has(part) ? part : ':id').join('/');
}

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function restriction(value) {
  if (!value) return null;
  return {
    at: number(value.at), route: discordRoute(value.route),
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(value.method) ? value.method : 'OTHER',
    status: 429, retryAt: number(value.retryAt),
    scope: ['user', 'global', 'shared'].includes(value.scope) ? value.scope : 'unknown',
    global: value.global === true,
    responseFormat: ['json', 'html'].includes(value.responseFormat) ? value.responseFormat : 'other',
    edgeRequestId: /^[a-f0-9]{16,32}-[A-Z]{3}$/.test(value.edgeRequestId || '') ? value.edgeRequestId : null,
  };
}

export function discordRetryAt(headers, now = Date.now()) {
  const retry = headers.get('retry-after');
  const seconds = number(retry);
  const date = retry && seconds === null ? Date.parse(retry) : NaN;
  const reset = number(headers.get('x-ratelimit-reset-after'));
  return Math.max(seconds === null ? 0 : now + Math.ceil(seconds * 1000),
    Number.isFinite(date) ? date : 0, reset === null ? 0 : now + Math.ceil(reset * 1000));
}

export function discordFailure(error) {
  const code = String(error?.code || '');
  return {
    code: /^\d{3,6}$/.test(code) || /^(TokenInvalid|DisallowedIntents|InvalidIntents|SessionInvalidated|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT)$/.test(code) ? code : 'unknown',
    status: number(error?.status),
  };
}

export function createDiscordDiagnostics({ store, now = Date.now, log = console } = {}) {
  const bots = new Map();
  let restored = false;
  let restoreTask;
  let saveTask = Promise.resolve();
  let loginTask = Promise.resolve();
  let persistence = store ? 'restoring' : 'not-configured';
  let networkCooldownUntil = 0;
  let lastSummary = '';
  const get = name => {
    if (!BOTS.includes(name)) throw new Error('Unknown Discord diagnostic client');
    if (!bots.has(name)) bots.set(name, {
      phase: 'idle', retryAt: null, cooldownUntil: 0, failures: 0,
      totals: { requests: 0, errors: 0, invalid: 0, rateLimits: 0 },
      invalidSeconds: new Map(), routes: new Map(), recent: [], lastRestriction: null,
    });
    return bots.get(name);
  };
  const event = (name, value) => {
    const bot = get(name);
    bot.recent.push({ at: now(), ...value });
    if (bot.recent.length > MAX_EVENTS) bot.recent.shift();
  };
  const prune = bot => {
    const oldest = Math.floor((now() - WINDOW_MS) / 1000);
    for (const second of bot.invalidSeconds.keys()) if (second <= oldest) bot.invalidSeconds.delete(second);
  };
  const persist = () => {
    if (!store) return;
    const value = { schemaVersion: 1, networkCooldownUntil,
      bots: Object.fromEntries([...bots].map(([name, bot]) => [name, {
        cooldownUntil: bot.cooldownUntil, lastRestriction: bot.lastRestriction,
      }])) };
    saveTask = saveTask.catch(() => {}).then(async () => {
      try {
        const uri = await store.save(value);
        if (typeof uri !== 'string' || !uri.startsWith('ipfs://')) throw new Error('Discord cooldown checkpoint was not durable');
        persistence = 'saved';
      } catch (error) {
        persistence = 'failed';
        log.error('[discord] Cooldown checkpoint failed; current process still honors the deadline.');
        throw error;
      }
    });
    // The response event cannot await storage; flush() exposes failure to callers.
    void saveTask.catch(() => {});
  };
  const report = () => ({
    windowMs: WINDOW_MS, windowResolutionMs: 1000, persistence, networkCooldownUntil,
    bots: Object.fromEntries([...bots].map(([name, bot]) => {
      prune(bot);
      return [name, {
        phase: bot.phase, retryAt: bot.retryAt, cooldownUntil: bot.cooldownUntil,
        failures: bot.failures, totals: { ...bot.totals },
        invalidLast10Minutes: [...bot.invalidSeconds.values()].reduce((sum, count) => sum + count, 0),
        lastRestriction: restriction(bot.lastRestriction),
        routes: [...bot.routes.values()].map(({ lastLogAt, ...route }) => ({ ...route })),
        recent: bot.recent.map(entry => ({ ...entry })),
      }];
    })),
  });
  return {
    report,
    withLogin(connect) {
      const task = loginTask.then(connect);
      loginTask = task.catch(() => {});
      return task;
    },
    maintenance() {
      if (persistence === 'failed') persist();
      const summary = Object.fromEntries([...bots].map(([name, bot]) => {
        prune(bot);
        const invalid = [...bot.invalidSeconds.values()].reduce((sum, count) => sum + count, 0);
        return [name, { phase: bot.phase, totals: { ...bot.totals }, invalidLast10Minutes: invalid,
          invalidRequestWarning: invalid >= 100, retryAt: bot.retryAt, cooldownUntil: bot.cooldownUntil,
          lastRestriction: restriction(bot.lastRestriction) }];
      }));
      const text = JSON.stringify({ persistence, bots: summary });
      if (text !== lastSummary) {
        log.log(`[discord] Diagnostic summary ${text}`);
        lastSummary = text;
      }
    },
    async restore() {
      if (restored) return;
      if (!restoreTask) restoreTask = (async () => {
        try {
          const value = await store?.restore();
          if (value) {
            if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.networkCooldownUntil) ||
                value.networkCooldownUntil < 0 || !value.bots || typeof value.bots !== 'object') {
              throw new Error('Invalid Discord cooldown checkpoint');
            }
            networkCooldownUntil = Math.max(networkCooldownUntil, value.networkCooldownUntil);
            for (const name of BOTS) {
              if (!value.bots[name]) continue;
              const deadline = value.bots[name].cooldownUntil;
              if (!Number.isSafeInteger(deadline) || deadline < 0) throw new Error('Invalid Discord cooldown deadline');
              get(name).cooldownUntil = Math.max(get(name).cooldownUntil, deadline);
              get(name).lastRestriction = restriction(value.bots[name].lastRestriction);
            }
          }
          restored = true;
          persistence = store ? 'restored' : 'not-configured';
        } catch (error) {
          persistence = 'restore-failed';
          log.error('[discord] Cooldown restore failed; Discord login remains paused, website playback continues.');
          restoreTask = null;
          throw error;
        }
      })();
      return restoreTask;
    },
    flush: () => saveTask,
    bot(name) {
      const bot = get(name);
      return {
        notBefore: () => Math.max(networkCooldownUntil, bot.cooldownUntil),
        setState(phase, { retryAt = null, failure } = {}) {
          if (!['idle', 'restoring', 'cooldown', 'connecting', 'ready', 'disconnected', 'backoff', 'blocked', 'stopped'].includes(phase)) {
            throw new Error('Invalid Discord connection phase');
          }
          bot.phase = phase;
          bot.retryAt = retryAt;
          if (failure) bot.failures++;
          event(name, { type: phase, ...(failure ? discordFailure(failure) : {}), retryAt });
        },
        attach(client) {
          const response = (request, result) => {
            // discord.js emits a cloned response; retain metadata, not an unread body.
            if (typeof result.body?.cancel === 'function') {
              void result.body.cancel().catch(() => log.warn(`[discord:${name}] Diagnostic response copy could not be released.`));
            }
            const status = number(result.status);
            const route = discordRoute(request.route || request.path);
            const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(request.method).toUpperCase())
              ? String(request.method).toUpperCase() : 'OTHER';
            const rawScope = result.headers.get('x-ratelimit-scope');
            const scope = ['user', 'global', 'shared'].includes(rawScope) ? rawScope : 'unknown';
            const global = result.headers.get('x-ratelimit-global') === 'true' || scope === 'global';
            const retryAt = status === 429 ? discordRetryAt(result.headers, now()) : 0;
            bot.totals.requests++;
            if (status >= 400) bot.totals.errors++;
            if (status === 429) bot.totals.rateLimits++;
            const invalid = status === 401 || status === 403 || (status === 429 && scope !== 'shared');
            if (invalid) {
              bot.totals.invalid++;
              prune(bot);
              const second = Math.floor(now() / 1000);
              bot.invalidSeconds.set(second, (bot.invalidSeconds.get(second) || 0) + 1);
            }
            if (status < 400) return;
            const metadata = { type: 'http-error', method, route, status, scope, global, retryAt: retryAt || null,
              responseFormat: result.headers.get('content-type')?.includes('application/json') ? 'json'
                : result.headers.get('content-type')?.includes('text/html') ? 'html' : 'other',
              edgeRequestId: /^[a-f0-9]{16,32}-[A-Z]{3}$/.test(result.headers.get('cf-ray') || '')
                ? result.headers.get('cf-ray') : null,
              bucket: /^[a-f0-9]{8,64}$/.test(result.headers.get('x-ratelimit-bucket') || '')
                ? result.headers.get('x-ratelimit-bucket') : null,
              remaining: number(result.headers.get('x-ratelimit-remaining')),
              limit: number(result.headers.get('x-ratelimit-limit')),
              resetAfterMs: number(result.headers.get('x-ratelimit-reset-after')) === null ? null
                : Number(result.headers.get('x-ratelimit-reset-after')) * 1000 };
            event(name, metadata);
            const key = `${method} ${route} ${status}`;
            if (!bot.routes.has(key) && bot.routes.size >= 64) bot.routes.delete(bot.routes.keys().next().value);
            const entry = bot.routes.get(key) || { method, route, status, count: 0, lastLogAt: -Infinity };
            entry.count++;
            bot.routes.set(key, entry);
            if (now() - entry.lastLogAt >= 60_000) {
              log.warn(`[discord:${name}] ${JSON.stringify({ ...metadata, count: entry.count,
                invalidLast10Minutes: [...bot.invalidSeconds.values()].reduce((sum, count) => sum + count, 0) })}`);
              entry.lastLogAt = now();
            }
            if (retryAt > now() && (global || route === '/gateway/bot')) {
              bot.lastRestriction = restriction({ at: now(), ...metadata });
              bot.cooldownUntil = Math.max(bot.cooldownUntil, retryAt);
              // An unscoped gateway restriction may be IP-based: pause both bot logins conservatively.
              if (route === '/gateway/bot' && scope === 'unknown') networkCooldownUntil = Math.max(networkCooldownUntil, retryAt);
              for (const connection of bots.values()) {
                const deadline = Math.max(networkCooldownUntil, connection.cooldownUntil);
                if (connection.phase !== 'ready' && deadline > now()) {
                  connection.phase = 'cooldown';
                  connection.retryAt = deadline;
                }
              }
              persist();
            }
          };
          const rateLimited = data => {
            event(name, { type: 'rate-limit-wait', route: discordRoute(data.route),
              global: data.global === true, waitMs: number(data.retryAfter ?? data.timeToReset) });
          };
          const ready = () => { bot.phase = 'ready'; bot.retryAt = null; event(name, { type: 'ready' }); };
          const disconnected = (close, shard) => {
            bot.phase = 'disconnected';
            event(name, { type: 'shard-disconnect', code: number(close.code), shard: number(shard) });
            log.warn(`[discord:${name}] Gateway disconnected; code=${number(close.code)}, shard=${number(shard)}`);
          };
          const error = value => {
            event(name, { type: 'client-error', ...discordFailure(value) });
            log.error(`[discord:${name}] Client error ${JSON.stringify(discordFailure(value))}`);
          };
          client.rest.on('response', response);
          client.rest.on('rateLimited', rateLimited);
          client.on(Events.ClientReady, ready);
          client.on(Events.ShardDisconnect, disconnected);
          client.on(Events.Error, error);
          client.on(Events.ShardError, error);
          client.on(Events.ShardResume, ready);
          return () => {
            client.rest.off('response', response);
            client.rest.off('rateLimited', rateLimited);
            client.off(Events.ClientReady, ready);
            client.off(Events.ShardDisconnect, disconnected);
            client.off(Events.Error, error);
            client.off(Events.ShardError, error);
            client.off(Events.ShardResume, ready);
          };
        },
      };
    },
  };
}
