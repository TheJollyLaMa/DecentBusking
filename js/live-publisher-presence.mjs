const PREFIX = 'decentbusking:live-publisher:v1:';
const CHANGE = 'decentbusking-live-publisher-change';
const LEASE_MS = 90_000;

// Local listening protection only: never an authorization or a server-side lock.
export function createLivePublisherPresence({ serviceUrl, environment = globalThis, now = () => Date.now(),
  onError = error => console.warn('[live-publisher-presence]', error.message) }) {
  const prefix = `${PREFIX}${encodeURIComponent(serviceUrl.replace(/\/+$/, ''))}:`;
  let key, bookingId, timer;
  const storage = () => {
    if (!environment.localStorage) throw new Error('Browser storage is unavailable; mute the public radio manually while performing.');
    return environment.localStorage;
  };
  const changed = () => environment.dispatchEvent(new environment.CustomEvent(CHANGE, { detail: { prefix } }));
  function publish() {
    storage().setItem(key, JSON.stringify({ bookingId, expiresAt: now() + LEASE_MS }));
    changed();
  }
  function stop() {
    environment.clearInterval(timer);
    timer = null;
    bookingId = null;
    if (!key) return true;
    try {
      storage().removeItem(key);
      changed();
      key = null;
      return true;
    } catch (error) { onError(error); return false; }
  }
  return {
    start(id) {
      if (typeof id !== 'string' || !id || id.length > 200) throw new Error('A booking is required for local return protection.');
      environment.clearInterval(timer);
      bookingId = id;
      try {
        key ||= `${prefix}${environment.crypto.randomUUID()}`;
        publish();
        timer = environment.setInterval(() => {
          try { publish(); }
          catch (error) { environment.clearInterval(timer); timer = null; onError(error); }
        }, 10_000);
        return true;
      } catch (error) { onError(error); return false; }
    },
    stop,
    isPublishing(id) {
      const saved = storage();
      let publishing = false;
      for (let index = 0; index < saved.length; index++) {
        const itemKey = saved.key(index);
        if (!itemKey?.startsWith(prefix)) continue;
        const raw = saved.getItem(itemKey);
        if (!raw) continue;
        const entry = JSON.parse(raw);
        if (typeof entry?.bookingId !== 'string' || !Number.isFinite(entry.expiresAt)) {
          throw new Error('Local publisher notice is invalid; mute the public radio manually while performing.');
        }
        if (entry.bookingId === id && entry.expiresAt > now() && entry.expiresAt <= now() + LEASE_MS) publishing = true;
      }
      return publishing;
    },
    watch(listener) {
      const changedHere = event => { if (event.detail?.prefix === prefix) listener(); };
      const changedElsewhere = event => { if (event.key === null || event.key?.startsWith(prefix)) listener(); };
      environment.addEventListener(CHANGE, changedHere);
      environment.addEventListener('storage', changedElsewhere);
      return () => {
        environment.removeEventListener(CHANGE, changedHere);
        environment.removeEventListener('storage', changedElsewhere);
      };
    },
  };
}
