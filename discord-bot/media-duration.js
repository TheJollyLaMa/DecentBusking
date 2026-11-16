import { spawn } from 'node:child_process';
import { verifiedRecordingDuration, recordingMediaIdentity } from '../js/radio-duration.mjs';

export function probeMediaDuration(url, { signal, timeoutMs = 120_000, spawnImpl = spawn } = {}) {
  const media = new URL(url);
  if (!['https:', 'http:'].includes(media.protocol)) throw new Error('Duration probing requires an HTTP media source');
  return new Promise((resolve, reject) => {
    let bytes = 0, settled = false;
    const child = spawnImpl(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-rw_timeout', '10000000',
      '-i', media.href, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'], signal });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('Media duration probe timed out'));
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (!Number.isSafeInteger(bytes)) {
        child.kill('SIGKILL');
        finish(new Error('Media duration probe exceeds measurable sample limit'));
      }
    });
    child.once('error', error => {
      child.kill('SIGKILL');
      finish(new Error(`Media duration probe unavailable (${error.code || error.name})`));
    });
    child.once('close', code => {
      if (settled) return;
      if (code !== 0) return finish(new Error(`Media duration probe failed (${code})`));
      if (!bytes || bytes % 2 !== 0) return finish(new Error('Media has no valid measurable audio duration'));
      finish(null, bytes / (48000 * 2));
    });
  });
}

export function createDurationBackfill({ getTracks, resolveUrl, save, probe = probeMediaDuration, timeoutMs = 150_000,
  now = () => Date.now(), batchSize = 2, log = console }) {
  let task = null;
  let closed = false;
  const controller = new AbortController();
  return {
    run() {
      if (closed) return Promise.resolve();
      if (task) return task;
      task = (async () => {
        const candidates = getTracks().filter(track => !track.isDevertAd && verifiedRecordingDuration(track) === null &&
          !(track.durationProbe?.nextAttemptAt > now())).slice(0, batchSize);
        for (const track of candidates) {
          if (closed) break;
          const identity = recordingMediaIdentity(track);
          const attempts = (track.durationProbe?.attempts || 0) + 1;
          await save(track.trackId, { identity, status: 'pending', attempts, nextAttemptAt: now() + 60_000 });
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
          let abort;
          try {
            const seconds = await Promise.race([
              (async () => {
                let url;
                try { url = await resolveUrl(track, { signal }); }
                catch { throw new Error('Recording media unavailable for duration probing'); }
                if (!url) throw new Error('Recording media unavailable for duration probing');
                signal.throwIfAborted();
                return probe(url, { signal });
              })(),
              new Promise((_, reject) => {
                abort = () => reject(new Error('Media duration lookup/probe deadline reached'));
                if (signal.aborted) abort();
                else signal.addEventListener('abort', abort, { once: true });
              }),
            ]);
            if (closed) break;
            await save(track.trackId, { identity, seconds, status: 'verified', attempts });
          } catch (error) {
            if (closed) break;
            log.warn('[radio-duration]', track.trackId, error.message);
            await save(track.trackId, { identity, status: 'failed', attempts, error: error.message,
              nextAttemptAt: now() + Math.min(3600_000, 60_000 * 2 ** Math.min(attempts - 1, 6)) });
          } finally {
            signal.removeEventListener('abort', abort);
          }
        }
      })().finally(() => { task = null; });
      return task;
    },
    close() { closed = true; controller.abort(); },
  };
}
