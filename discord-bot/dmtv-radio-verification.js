import { randomUUID } from 'node:crypto';

export function createDmtvRadioVerification({ now = Date.now, log = console } = {}) {
  let lastReady = -Infinity;
  let active;
  const ready = () => now() - lastReady < 12_000;

  function finish(ok, reason) {
    if (!active) return;
    const job = active;
    active = undefined;
    clearTimeout(job.timer);
    if (!ok) log.warn(`[dmtv] Radio video verification failed: ${reason}`);
    job.resolve(ok);
  }

  return {
    ready,
    start({ playId, ipfsCid, expectedMs }) {
      if (active || !ready() || !playId || !/^[a-z0-9]{20,120}$/i.test(ipfsCid) ||
          !Number.isSafeInteger(expectedMs) || expectedMs <= 0 || expectedMs > 7_200_000) {
        log.warn('[dmtv] Radio video verification could not start');
        return Promise.resolve(false);
      }
      const deadline = now() + expectedMs + 45_000;
      return new Promise(resolve => {
        active = { data: { id: randomUUID(), playId, ipfsCid, expectedMs, deadline }, startedAt: now(), resolve };
        active.timer = setTimeout(() => finish(false, 'timed out'), expectedMs + 45_000);
        active.timer.unref?.();
      });
    },
    exchange(message) {
      if (message?.version !== 1 || typeof message.ready !== 'boolean') {
        throw new Error('Invalid DMTv verifier message');
      }
      if (message.ready) lastReady = now();
      else lastReady = -Infinity;
      const { result } = message;
      if (result && active?.data.id === result.id) {
        const { expectedMs, deadline } = active.data;
        const ok = now() <= deadline && now() - active.startedAt >= expectedMs / 2 && Number.isFinite(result.syncedMs) &&
          result.syncedMs >= expectedMs / 2 && result.syncedMs <= expectedMs;
        finish(ok, 'less than half was verified');
      }
      return { job: active?.data ?? null };
    },
  };
}

export function attachDmtvRadioVerification(queue, verifier, log = console) {
  const outcomes = new WeakMap();
  return {
    ...queue,
    startPlayback(record, program) {
      if (outcomes.has(record)) return;
      const outcome = verifier.start(program).then(ok => ok
        ? queue.completeVerifiedRadio(record, program.playId)
        : queue.fail(record));
      outcomes.set(record, outcome);
      void outcome.catch(error => log.warn(`[dmtv] Radio outcome deferred: ${error.code || 'checkpoint or RPC unavailable'}`));
    },
    complete(record) { return outcomes.get(record) || queue.fail(record); },
    fail(record) { return outcomes.get(record) || queue.fail(record); },
    release(record) { return outcomes.get(record) || queue.release(record); },
  };
}
