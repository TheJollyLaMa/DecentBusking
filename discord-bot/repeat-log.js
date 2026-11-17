export const REPEAT_LOG_INTERVAL_MS = 60_000;

export function createRepeatLog({ log = console, intervalMs = REPEAT_LOG_INTERVAL_MS,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const entries = new Map();
  function flush(entry) {
    entry.timer = null;
    if (entry.repeats) {
      log.warn(`${entry.message} (repeated ${entry.repeats} times)`);
      entry.repeats = 0;
    }
  }
  return {
    warn(key, message) {
      let entry = entries.get(key);
      if (!entry) {
        entry = { message, repeats: 0, timer: null };
        entries.set(key, entry);
        log.warn(message);
      } else {
        entry.repeats++;
      }
      if (!entry.timer) {
        entry.timer = setTimer(() => flush(entry), intervalMs);
        entry.timer.unref?.();
      }
    },
    recover(prefix, message) {
      let found = false;
      for (const [key, entry] of entries) {
        if (!key.startsWith(prefix)) continue;
        if (entry.timer) clearTimer(entry.timer);
        flush(entry);
        entries.delete(key);
        found = true;
      }
      if (found) log.info(message);
    },
  };
}
