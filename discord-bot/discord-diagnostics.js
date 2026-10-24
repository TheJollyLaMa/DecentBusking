import { Events } from 'discord.js';

const WINDOW_MS = 10 * 60_000;
const MAX_EVENTS = 30;
const MAX_RESTRICTIONS = 10;
const SNAPSHOT_INTERVAL_MS = 5 * 60_000;
const MAX_OBSERVATIONS = 6;
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

function trafficObservation(value) {
  if (!value) return null;
  return {
    at: number(value.at), startedAt: number(value.startedAt),
    bots: Object.fromEntries(BOTS.filter(name => value.bots?.[name]).map(name => {
      const bot = value.bots[name];
      return [name, {
        totals: Object.fromEntries(['requests', 'errors', 'invalid', 'rateLimits']
          .map(key => [key, number(bot.totals?.[key])])),
        invalidLast10Minutes: number(bot.invalidLast10Minutes),
        traffic: bot.traffic ? Object.fromEntries([
          'requestsLastSecond', 'requestsLastMinute', 'requestsLast10Minutes',
          'peakRequestsPerSecond', 'peakRequestsPerMinute',
        ].map(key => [key, number(bot.traffic[key])])) : null,
        routes: Array.isArray(bot.routes) ? bot.routes.slice(-64).map(route => ({
          method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method) ? route.method : 'OTHER',
          route: discordRoute(route.route), status: number(route.status),
          count: number(route.count), retries: number(route.retries),
        })) : [],
      }];
    })),
  };
}

function restriction(value) {
  if (!value) return null;
  return {
    at: number(value.at), route: discordRoute(value.route),
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(value.method) ? value.method : 'OTHER',
    status: 429, retryAt: number(value.retryAt),
    scope: ['user', 'global', 'shared'].includes(value.scope) ? value.scope : 'unknown',
    global: value.global === true,
    responseFormat: ['json', 'html', 'text'].includes(value.responseFormat) ? value.responseFormat : 'other',
    edgeRequestId: /^[a-f0-9]{16,32}-[A-Z]{3}$/.test(value.edgeRequestId || '') ? value.edgeRequestId : null,
    bucket: /^[a-f0-9]{8,64}$/.test(value.bucket || '') ? value.bucket : null,
    remaining: number(value.remaining), limit: number(value.limit), resetAfterMs: number(value.resetAfterMs),
    observation: trafficObservation(value.observation),
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
  const startedAt = now();
  let restored = false;
  let restoreTask;
  let saveTask = Promise.resolve();
  let loginTask = Promise.resolve();
  let persistence = store ? 'restoring' : 'not-configured';
  let networkCooldownUntil = 0;
  let lastSummary = '';
  let observations = [];
  let lastSnapshotAt = -Infinity;
  let trafficChanged = false;
  const get = name => {
    if (!BOTS.includes(name)) throw new Error('Unknown Discord diagnostic client');
    if (!bots.has(name)) bots.set(name, {
      phase: 'idle', retryAt: null, cooldownUntil: 0, failures: 0,
      totals: { requests: 0, errors: 0, invalid: 0, rateLimits: 0 },
      invalidSeconds: new Map(), routes: new Map(), recent: [], lastRestriction: null, restrictions: [],
      requestSeconds: new Map(), peakRequestsPerSecond: 0, peakRequestsPerMinute: 0,
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
    for (const second of bot.requestSeconds.keys()) if (second <= oldest) bot.requestSeconds.delete(second);
  };
  const traffic = bot => {
    prune(bot);
    const second = Math.floor(now() / 1000);
    let minute = 0;
    let tenMinutes = 0;
    for (const [at, count] of bot.requestSeconds) {
      tenMinutes += count;
      if (at > second - 60) minute += count;
    }
    return { requestsLastSecond: bot.requestSeconds.get(second) || 0,
      requestsLastMinute: minute, requestsLast10Minutes: tenMinutes,
      peakRequestsPerSecond: bot.peakRequestsPerSecond, peakRequestsPerMinute: bot.peakRequestsPerMinute };
  };
  const observation = () => trafficObservation({
    at: now(), startedAt, bots: Object.fromEntries([...bots].map(([name, bot]) => {
      const currentTraffic = traffic(bot);
      return [name, { totals: bot.totals, traffic: currentTraffic,
        invalidLast10Minutes: [...bot.invalidSeconds.values()].reduce((sum, count) => sum + count, 0),
        routes: [...bot.routes.values()] }];
    })),
  });
  const persist = () => {
    if (!store) return;
    const value = { schemaVersion: 1, networkCooldownUntil, observations: observations.slice(),
      bots: Object.fromEntries([...bots].map(([name, bot]) => [name, {
        cooldownUntil: bot.cooldownUntil, lastRestriction: bot.lastRestriction,
        restrictions: bot.restrictions.slice(),
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
    startedAt, windowMs: WINDOW_MS, windowResolutionMs: 1000, persistence, networkCooldownUntil,
    observations: observations.map(trafficObservation),
    bots: Object.fromEntries([...bots].map(([name, bot]) => {
      prune(bot);
      return [name, {
        phase: bot.phase, retryAt: bot.retryAt, cooldownUntil: bot.cooldownUntil,
        failures: bot.failures, totals: { ...bot.totals },
        traffic: traffic(bot),
        invalidLast10Minutes: [...bot.invalidSeconds.values()].reduce((sum, count) => sum + count, 0),
        lastRestriction: restriction(bot.lastRestriction),
        restrictions: bot.restrictions.map(restriction),
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
      if (restored && trafficChanged && now() - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
        observations.push(observation());
        if (observations.length > MAX_OBSERVATIONS) observations.shift();
        lastSnapshotAt = now();
        trafficChanged = false;
        persist();
      } else if (persistence === 'failed') persist();
      const summary = Object.fromEntries([...bots].map(([name, bot]) => {
        prune(bot);
        const invalid = [...bot.invalidSeconds.values()].reduce((sum, count) => sum + count, 0);
        return [name, { phase: bot.phase, totals: { ...bot.totals }, invalidLast10Minutes: invalid,
          invalidRequestWarning: invalid >= 100, retryAt: bot.retryAt, cooldownUntil: bot.cooldownUntil,
          lastRestriction: restriction(bot.lastRestriction), traffic: traffic(bot),
          routes: [...bot.routes.values()].map(({ lastLogAt, ...route }) => ({ ...route })) }];
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
            if (value.observations !== undefined && !Array.isArray(value.observations)) {
              throw new Error('Invalid Discord traffic observations');
            }
            observations = (value.observations || []).filter(Boolean).slice(-MAX_OBSERVATIONS).map(trafficObservation);
            for (const name of BOTS) {
              if (!value.bots[name]) continue;
              const deadline = value.bots[name].cooldownUntil;
              if (!Number.isSafeInteger(deadline) || deadline < 0) throw new Error('Invalid Discord cooldown deadline');
              get(name).cooldownUntil = Math.max(get(name).cooldownUntil, deadline);
              get(name).lastRestriction = restriction(value.bots[name].lastRestriction);
              const history = value.bots[name].restrictions;
              if (history !== undefined && !Array.isArray(history)) throw new Error('Invalid Discord restriction history');
              get(name).restrictions = (history || [value.bots[name].lastRestriction])
                .filter(Boolean).slice(-MAX_RESTRICTIONS).map(restriction);
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
            const second = Math.floor(now() / 1000);
            prune(bot);
            bot.requestSeconds.set(second, (bot.requestSeconds.get(second) || 0) + 1);
            bot.peakRequestsPerSecond = Math.max(bot.peakRequestsPerSecond, bot.requestSeconds.get(second));
            bot.peakRequestsPerMinute = Math.max(bot.peakRequestsPerMinute, traffic(bot).requestsLastMinute);
            trafficChanged = true;
            if (invalid) {
              bot.totals.invalid++;
              bot.invalidSeconds.set(second, (bot.invalidSeconds.get(second) || 0) + 1);
            }
            const key = `${method} ${route} ${status}`;
            if (!bot.routes.has(key) && bot.routes.size >= 64) bot.routes.delete(bot.routes.keys().next().value);
            const entry = bot.routes.get(key) || { method, route, status, count: 0, retries: 0, lastLogAt: -Infinity };
            entry.count++;
            if (number(request.retries) > 0) entry.retries++;
            bot.routes.set(key, entry);
            if (status < 400) return;
            const metadata = { type: 'http-error', method, route, status, scope, global, retryAt: retryAt || null,
              responseFormat: result.headers.get('content-type')?.includes('application/json') ? 'json'
                : result.headers.get('content-type')?.includes('text/html') ? 'html'
                  : result.headers.get('content-type')?.includes('text/plain') ? 'text' : 'other',
              edgeRequestId: /^[a-f0-9]{16,32}-[A-Z]{3}$/.test(result.headers.get('cf-ray') || '')
                ? result.headers.get('cf-ray') : null,
              bucket: /^[a-f0-9]{8,64}$/.test(result.headers.get('x-ratelimit-bucket') || '')
                ? result.headers.get('x-ratelimit-bucket') : null,
              remaining: number(result.headers.get('x-ratelimit-remaining')),
              limit: number(result.headers.get('x-ratelimit-limit')),
              resetAfterMs: number(result.headers.get('x-ratelimit-reset-after')) === null ? null
                : Number(result.headers.get('x-ratelimit-reset-after')) * 1000 };
            event(name, metadata);
            const shouldLog = now() - entry.lastLogAt >= 60_000;
            if (shouldLog) {
              log.warn(`[discord:${name}] ${JSON.stringify({ ...metadata, count: entry.count,
                invalidLast10Minutes: [...bot.invalidSeconds.values()].reduce((sum, count) => sum + count, 0),
                observation: observation() })}`);
              entry.lastLogAt = now();
            }
            const loginRestriction = retryAt > now() && (global || route === '/gateway/bot');
            if (status === 429 && (shouldLog || loginRestriction)) {
              const incident = restriction({ at: now(), ...metadata, observation: observation() });
              bot.restrictions.push(incident);
              if (bot.restrictions.length > MAX_RESTRICTIONS) bot.restrictions.shift();
              if (loginRestriction) bot.lastRestriction = incident;
            }
            if (loginRestriction) {
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
            }
            if (status === 429 && (shouldLog || loginRestriction)) persist();
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
