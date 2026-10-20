import { Events } from 'discord.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { discordFailure, discordRetryAt } from './discord-diagnostics.js';

export function watchDiscordSession(client) {
  let end;
  const closed = new Promise(resolve => { end = resolve; });
  const invalidated = () => end(Object.assign(new Error('Discord session invalidated'), { code: 'SessionInvalidated' }));
  const disconnected = close => {
    if ([4004, 4013, 4014].includes(close.code)) {
      end(Object.assign(new Error('Discord gateway requires operator attention'), { code: close.code }));
    }
  };
  client.on(Events.Invalidated, invalidated);
  client.on(Events.ShardDisconnect, disconnected);
  return {
    closed,
    dispose() {
      client.off(Events.Invalidated, invalidated);
      client.off(Events.ShardDisconnect, disconnected);
    },
  };
}

export async function recoverDiscordConnection({ connect, diagnostics, name, signal,
  log = console, wait = (ms, signal) => sleep(ms, undefined, { signal }),
  retryDelay = attempt => Math.min(30_000 * 2 ** Math.min(attempt - 1, 5), 15 * 60_000),
  notBefore = process.env.DISCORD_LOGIN_NOT_BEFORE, onUnavailable, onConnected } = {}) {
  const telemetry = diagnostics.bot(name);
  const configuredDeadline = notBefore ? Date.parse(notBefore) : 0;
  if (!Number.isFinite(configuredDeadline)) throw new Error('DISCORD_LOGIN_NOT_BEFORE must be a valid timestamp');
  let attempts = 0;
  try {
    while (!signal?.aborted) {
      try {
        telemetry.setState('restoring');
        await diagnostics.restore();
        let deadline = Math.max(configuredDeadline, telemetry.notBefore());
        while (deadline > Date.now()) {
          telemetry.setState('cooldown', { retryAt: deadline });
          onUnavailable?.(`Discord cooldown; retry after ${new Date(deadline).toISOString()}`);
          await wait(Math.min(deadline - Date.now(), 2147483647), signal);
          deadline = Math.max(configuredDeadline, telemetry.notBefore());
        }
        if (signal?.aborted) break;
        telemetry.setState('connecting');
        log.log(`[discord:${name}] Connecting; attempt=${attempts + 1}`);
        const connection = await connect();
        if (signal?.aborted) {
          await connection?.stop();
          break;
        }
        telemetry.setState('ready');
        onConnected?.(connection);
        if (!connection.closed) return connection;
        let abort;
        const stopped = new Promise(resolve => {
          abort = () => resolve(null);
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
        let failure;
        try {
          failure = await Promise.race([connection.closed, stopped]);
        } finally {
          signal?.removeEventListener('abort', abort);
          await connection.stop();
        }
        if (signal?.aborted) break;
        attempts = 0;
        throw failure || Object.assign(new Error('Discord session ended'), { code: 'SessionInvalidated' });
      } catch (error) {
        if (signal?.aborted) break;
        const failure = discordFailure(error);
        const fatal = failure.status === 401 || failure.status === 403 ||
          ['TokenInvalid', 'DisallowedIntents', 'InvalidIntents', '4004', '4013', '4014'].includes(failure.code);
        if (fatal) {
          telemetry.setState('blocked', { failure: error });
          onUnavailable?.(`Discord requires operator attention (code ${failure.code}, status ${failure.status})`);
          log.error(`[discord:${name}] Automatic login stopped: ${JSON.stringify(failure)}`);
          return null;
        }
        const retryAt = Math.max(Date.now() + retryDelay(++attempts), telemetry.notBefore());
        telemetry.setState('backoff', { retryAt, failure: error });
        onUnavailable?.(`Discord reconnect scheduled for ${new Date(retryAt).toISOString()}`);
        log.warn(`[discord:${name}] Transient failure ${JSON.stringify(failure)}; retry after ${new Date(retryAt).toISOString()}`);
        await wait(Math.min(Math.max(0, retryAt - Date.now()), 2147483647), signal);
      }
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
  }
  telemetry.setState('stopped');
  return null;
}

export async function loginDiscordClient(client, token, { timeoutMs = 120000, log = console, onUnavailable,
  notBefore = process.env.DISCORD_LOGIN_NOT_BEFORE, signal } = {}) {
  signal?.throwIfAborted();
  if (notBefore) {
    const timestamp = Date.parse(notBefore);
    if (!Number.isFinite(timestamp)) throw new Error('DISCORD_LOGIN_NOT_BEFORE must be a valid timestamp');
    const delay = timestamp - Date.now();
    if (delay > 2147483647) throw new Error('DISCORD_LOGIN_NOT_BEFORE exceeds the supported cooldown duration');
    if (delay > 0) {
      const reason = `Discord connection cooldown; retry after ${new Date(timestamp).toISOString()}`;
      log.warn(`[discord] ${reason}. Website playback is independent.`);
      onUnavailable?.(reason);
      await sleep(delay, undefined, { signal });
    }
  }
  let timer;
  let rejectTimeout;
  const deadline = new Promise((_, reject) => { rejectTimeout = reject; });
  const armTimeout = delay => {
    clearTimeout(timer);
    timer = setTimeout(() => rejectTimeout(new Error(`Discord login did not become ready within its startup deadline`)), delay);
  };
  let ready;
  const connected = new Promise(resolve => { ready = resolve; });
  client.once(Events.ClientReady, ready);
  const debug = message => {
    const firstLine = String(message).split('\n')[0];
    if (firstLine.startsWith('[WS =>') &&
        /connect|gateway|identif|ready|session|waiting for event/i.test(firstLine)) {
      log.log('[discord] Connecting to gateway; connection stage changed.');
    }
  };
  const shardError = error => log.error(`[discord] Shard error: ${JSON.stringify(discordFailure(error))}`);
  const shardDisconnect = (event, shardId) => log.warn(`[discord] Shard ${Number(shardId)} disconnected (code ${Number(event.code)})`);
  const rateLimited = data => log.warn(`[discord] REST rate limited: global=${data.global === true}, retry after ${Number(data.timeToReset)}ms`);
  const response = (request, result) => {
    if (request.path === '/gateway/bot') {
      const retryAfterMs = discordRetryAt(result.headers) - Date.now();
      log.log(`[discord] Gateway discovery HTTP ${Number(result.status)}; retry-after=${retryAfterMs > 0 ? Math.ceil(retryAfterMs / 1000) : 'none'}`);
      if (result.status === 429 && Number.isFinite(retryAfterMs) && retryAfterMs > 0 &&
          retryAfterMs + timeoutMs <= 2147483647) {
        const reason = `Discord connection rate limited; retry after ${new Date(Date.now() + retryAfterMs).toISOString()}`;
        log.warn(`[discord] ${reason}. Respecting Discord's cooldown without restarting.`);
        onUnavailable?.(reason);
        armTimeout(retryAfterMs + timeoutMs);
      }
    }
  };
  client.on(Events.Debug, debug);
  client.on(Events.ShardError, shardError);
  client.on(Events.ShardDisconnect, shardDisconnect);
  client.rest.on('rateLimited', rateLimited);
  client.rest.on('response', response);
  let abort;
  const aborted = new Promise((_, reject) => {
    abort = () => reject(signal.reason || new Error('Discord login aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  log.log('[discord] Starting gateway login; waiting for client readiness.');
  armTimeout(timeoutMs);
  try {
    await Promise.race([
      Promise.all([client.login(token), connected]),
      deadline,
      aborted,
    ]);
    log.log('[discord] Gateway login ready.');
  } finally {
    clearTimeout(timer);
    client.removeListener(Events.ClientReady, ready);
    client.removeListener(Events.Debug, debug);
    client.rest.removeListener('response', response);
    client.removeListener(Events.ShardError, shardError);
    client.removeListener(Events.ShardDisconnect, shardDisconnect);
    client.rest.removeListener('rateLimited', rateLimited);
    signal?.removeEventListener('abort', abort);
  }
}
