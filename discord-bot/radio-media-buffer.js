import { mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Finish the HTTP transfer before a real-time decoder can backpressure the gateway. */
export async function bufferRadioMedia(url, { fetchImpl = fetch, signal,
  maxBytes = 256 * 1024 * 1024, timeoutMs = 90_000 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dbusk-paid-media-'));
  const path = join(directory, 'recording');
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    const transferSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(url, { signal: transferSignal });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error(`Paid media download failed (HTTP ${response.status})`);
    }
    const length = response.headers.get('content-length');
    const expected = length === null ? null : Number(length);
    if (expected !== null && (!Number.isSafeInteger(expected) || expected < 1 || expected > maxBytes)) {
      await response.body.cancel();
      throw new Error('Paid media download exceeds the size limit or has an invalid length');
    }
    let bytes = 0;
    const limit = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        callback(bytes > maxBytes ? new Error('Paid media download exceeds the size limit') : null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(path, { flags: 'wx' }),
      { signal: transferSignal });
    if (bytes === 0 || (expected !== null && bytes !== expected)) throw new Error('Paid media download was incomplete');
    return { path, bytes, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
