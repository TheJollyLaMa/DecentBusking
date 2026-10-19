import { Events } from 'discord.js';

export async function loginDiscordClient(client, token, { timeoutMs = 120000, log = console } = {}) {
  let timer;
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
  client.on(Events.Debug, debug);
  client.on(Events.ShardError, shardError);
  client.on(Events.ShardDisconnect, shardDisconnect);
  client.rest.on('rateLimited', rateLimited);
  log.log('[discord] Starting gateway login; waiting for client readiness.');
  try {
    await Promise.race([
      Promise.all([client.login(token), connected]),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Discord login did not become ready within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    log.log('[discord] Gateway login ready.');
  } finally {
    clearTimeout(timer);
    client.removeListener(Events.ClientReady, ready);
    client.removeListener(Events.Debug, debug);
    // Keep error/rate-limit diagnostics after startup, without logging payloads or tokens.
  }
}
