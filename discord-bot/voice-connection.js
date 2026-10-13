const DEFAULT_RECONNECT_DELAY_MS = attempt => Math.min(2_000 * (2 ** Math.max(0, attempt - 1)), 60_000);

export function getVoiceReconnectDelay(attempt) {
  return DEFAULT_RECONNECT_DELAY_MS(attempt);
}

export function createVoiceConnectionSupervisor({
  name = 'voice',
  voiceChannel,
  player,
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  joinOptions = () => ({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
  }),
  subscribe = connection => connection.subscribe(player),
  retryDelay = getVoiceReconnectDelay,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = console,
  onReady = () => {},
} = {}) {
  if (!voiceChannel || !joinVoiceChannel || !entersState || !VoiceConnectionStatus) {
    throw new Error('Voice connection supervisor requires a voice channel and voice helpers');
  }

  let connection = null;
  let stopped = false;
  let voiceConnected = false;
  let reconnecting = false;
  let reconnectTimer = null;
  let reconnectSleepResolve = null;
  let reconnectTask = null;
  let reconnectAttempt = 0;
  let connectedAt = 0;
  let disconnectedAt = 0;
  let hasConnected = false;
  let suppressDestroyed = false;

  const clearReconnectTimer = () => {
    if (reconnectTimer) {
      clearTimer(reconnectTimer);
      reconnectTimer = null;
    }
    if (reconnectSleepResolve) {
      const resolve = reconnectSleepResolve;
      reconnectSleepResolve = null;
      resolve();
    }
  };

  const destroyConnection = () => {
    if (!connection) return;
    suppressDestroyed = true;
    try { connection.destroy(); } catch {}
    suppressDestroyed = false;
    connection = null;
  };

  const onConnectionReady = async nextConnection => {
    const wasConnected = hasConnected;
    connection = nextConnection;
    voiceConnected = true;
    reconnecting = false;
    reconnectAttempt = 0;
    clearReconnectTimer();
    subscribe(nextConnection);
    const elapsedMs = disconnectedAt ? Math.max(0, now() - disconnectedAt) : 0;
    if (wasConnected) log.log(`[${name}] voice: reconnected after ${Math.max(1, Math.round(elapsedMs / 1000))}s`);
    else log.log(`[${name}] voice: connected to ${voiceChannel.name}.`);
    hasConnected = true;
    connectedAt = now();
    disconnectedAt = 0;
    await onReady(nextConnection, { reconnected: wasConnected && elapsedMs > 0, elapsedMs });
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTask) return reconnectTask;
    reconnecting = true;
    voiceConnected = false;
    reconnectTask = (async () => {
      for (;;) {
        if (stopped) return null;
        const attempt = ++reconnectAttempt;
        if (attempt > 1) {
          const delay = retryDelay(attempt);
          log.log(`[${name}] voice: retrying in ${Math.round(delay / 1000)}s`);
          await new Promise(resolve => {
            reconnectSleepResolve = resolve;
            reconnectTimer = setTimer(() => {
              reconnectTimer = null;
              const sleepResolve = reconnectSleepResolve;
              reconnectSleepResolve = null;
              sleepResolve?.();
            }, delay);
          });
          if (stopped) return null;
        }
        destroyConnection();
        const nextConnection = joinVoiceChannel(joinOptions());
        connection = nextConnection;
        nextConnection.on('error', error => {
          log.warn(`[${name}] Voice connection error in ${voiceChannel.name} (${voiceChannel.id}):`, error.message);
        });
        nextConnection.on(VoiceConnectionStatus.Disconnected, handleDisconnected);
        nextConnection.on(VoiceConnectionStatus.Destroyed, handleDestroyed);
        try {
          await entersState(nextConnection, VoiceConnectionStatus.Ready, 30_000);
          if (stopped) {
            destroyConnection();
            return null;
          }
          if (connection !== nextConnection) continue;
          await onConnectionReady(nextConnection);
          return nextConnection;
        } catch (error) {
          if (stopped) return null;
          log.warn(`[${name}] voice: reconnect failed (${error.message}); retrying…`);
          suppressDestroyed = true;
          try { nextConnection.destroy(); } catch {}
          suppressDestroyed = false;
          voiceConnected = false;
          reconnecting = true;
          disconnectedAt ||= now();
        }
      }
    })().finally(() => {
      reconnectTask = null;
    });
    return reconnectTask;
  };

  async function handleDisconnected() {
    if (stopped) return;
    voiceConnected = false;
    reconnecting = true;
    disconnectedAt ||= now();
    log.log(`[${name}] voice: Disconnected → Connecting…`);
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      if (!stopped) scheduleReconnect();
    }
  }

  function handleDestroyed() {
    if (stopped || suppressDestroyed) return;
    voiceConnected = false;
    reconnecting = true;
    disconnectedAt ||= now();
    log.warn(`[${name}] voice: Destroyed → rejoining…`);
    scheduleReconnect();
  }

  async function connect() {
    const task = scheduleReconnect();
    await task;
    return connection;
  }

  function stop() {
    stopped = true;
    clearReconnectTimer();
    reconnecting = false;
    voiceConnected = false;
    destroyConnection();
  }

  function getState() {
    return {
      voiceConnected,
      reconnecting,
      connectedAt: connectedAt || null,
      reconnectingSince: disconnectedAt || null,
    };
  }

  return {
    connect,
    stop,
    getState,
    get connection() {
      return connection;
    },
  };
}
