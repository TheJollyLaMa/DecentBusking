import { Events } from 'discord.js';

export async function loginDiscordClient(client, token, { timeoutMs = 120000, log = console, onUnavailable } = {}) {
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
      log.log(`[discord] ${firstLine}`);
    }
  };
  const shardError = (error, shardId) => log.error(`[discord] Shard ${shardId} error: ${error.message}`);
  const shardDisconnect = (event, shardId) => log.warn(`[discord] Shard ${shardId} disconnected (code ${event.code})`);
  const rateLimited = data => log.warn(`[discord] REST rate limited: global=${data.global}, retry after ${data.timeToReset}ms`);
  const response = (request, result) => {
    if (request.path === '/gateway/bot') {
      const retryAfter = result.headers.get('retry-after');
      log.log(`[discord] Gateway discovery HTTP ${result.status}; retry-after=${retryAfter || 'none'}`);
      const retryAfterMs = Number(retryAfter) * 1000;
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
  log.log('[discord] Starting gateway login; waiting for client readiness.');
  armTimeout(timeoutMs);
  try {
    await Promise.race([
      Promise.all([client.login(token), connected]),
      deadline,
    ]);
    log.log('[discord] Gateway login ready.');
  } finally {
    clearTimeout(timer);
    client.removeListener(Events.ClientReady, ready);
    client.removeListener(Events.Debug, debug);
    client.rest.removeListener('response', response);
    // Keep error/rate-limit diagnostics after startup, without logging payloads or tokens.
  }
}
