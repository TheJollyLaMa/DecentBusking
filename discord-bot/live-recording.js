import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { verifyMessage } from 'ethers';
import { liveRecordingConsentMessage } from '../js/live-recording-consent.mjs';
import { createPinataStateStore } from './ipfs-state.js';
import { LiveAudioError } from './live-audio-errors.js';
import { buildGatewayUrl } from './mint-sync.js';

const RATE = 48000, BYTES_PER_SECOND = RATE * 2;
const AAD = Buffer.from('dbusk-live-recording-state-v1');
const safeCid = value => typeof value === 'string' && /^[a-zA-Z0-9]{20,120}$/.test(value);
const keysOnly = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => keys.includes(key));

export async function downloadRecordingSegment(cid, { gateway, fetchImpl = fetch } = {}) {
  if (!safeCid(cid)) throw Error('Invalid recording segment CID');
  const base = new URL(gateway);
  if (base.protocol !== 'https:' || base.username || base.password || base.hash) throw Error('Invalid recording gateway');
  base.pathname = `${base.pathname.replace(/\/$/, '').replace(/\/ipfs$/, '')}/ipfs/`;
  let response;
  try {
    response = await fetchImpl(buildGatewayUrl(base.toString(), cid), {
      signal: AbortSignal.timeout(30000), redirect: 'error',
    });
  } catch {
    // Do not persist fetch errors that may include gateway credentials in the URL.
    throw Error('Recording segment download failed (network, timeout or redirect)');
  }
  if (!response.ok) throw Error(`Recording segment download failed (${response.status})`);
  if (!response.body) throw Error('Recording segment download returned no body');
  const limit = BYTES_PER_SECOND * 30 + 44;
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    if (Number(response.headers.get('content-length')) > limit) throw Error('Recording segment exceeds size limit');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw Error('Recording segment exceeds size limit');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error.message === 'Recording segment exceeds size limit') throw error;
    throw Error('Recording segment download failed while reading body');
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

export function validateRecordingState(state) {
  if (!keysOnly(state, ['version', 'recordings']) || state.version !== 1 ||
      !Array.isArray(state.recordings) || state.recordings.length > 200) throw Error('Invalid recording journal');
  const ids = new Set();
  for (const r of state.recordings) {
    if (!keysOnly(r, ['bookingId', 'wallet', 'consent', 'segments', 'status', 'interrupted', 'result', 'trackId', 'error']) ||
        typeof r.bookingId !== 'string' || ids.has(r.bookingId) || !/^0x[0-9a-f]{40}$/i.test(r.wallet || '') ||
        !keysOnly(r.consent, ['enabled', 'issuedAt', 'signature', 'origin']) ||
        typeof r.consent?.enabled !== 'boolean' || !Number.isSafeInteger(r.consent.issuedAt) ||
        typeof r.consent.signature !== 'string' || !Array.isArray(r.segments) || r.segments.length > 360 ||
        r.segments.some(s => !keysOnly(s, ['cid', 'bytes']) || !safeCid(s.cid) || !Number.isSafeInteger(s.bytes) || s.bytes <= 0 ||
          s.bytes > BYTES_PER_SECOND * 30 || s.bytes % 2 !== 0) ||
        !['waiting', 'recording', 'processing', 'submitted', 'revoked', 'empty'].includes(r.status) ||
        (r.interrupted !== undefined && typeof r.interrupted !== 'boolean') ||
        (r.error !== undefined && (typeof r.error !== 'string' || r.error.length > 3000)) ||
        (r.trackId !== undefined && (typeof r.trackId !== 'string' || r.trackId.length > 300)) ||
        (r.result && (!keysOnly(r.result, ['cid', 'durationSeconds']) || !safeCid(r.result.cid) ||
          !Number.isFinite(r.result.durationSeconds) || r.result.durationSeconds <= 0))) throw Error('Invalid recording journal');
    const message = liveRecordingConsentMessage({ bookingId: r.bookingId, wallet: r.wallet,
      origin: r.consent.origin, issuedAt: r.consent.issuedAt, enabled: r.consent.enabled });
    if (verifyMessage(message, r.consent.signature).toLowerCase() !== r.wallet.toLowerCase()) throw Error('Invalid recording permission signature');
    ids.add(r.bookingId);
  }
  return state;
}

export function createLiveRecordingStore({ storageKey, ...options }) {
  if (!/^[a-f0-9]{64}$/i.test(storageKey || '')) throw Error('Dedicated live storage key required');
  const key = Buffer.from(storageKey, 'hex');
  const store = createPinataStateStore({ ...options, name: 'decentbusking-live-recordings-encrypted.json',
    tags: { app: 'decentbusking', kind: 'live-recordings-encrypted', schema: '1' },
    retentionDays: 0, archiveGroupId: undefined, requireLocalMirror: false, beforeUpload: undefined,
    fetchImpl: (url, init) => (options.fetchImpl || fetch)(url, { ...init, signal: AbortSignal.timeout(30000) }),
    restoreLatestOnly: true, rejectAmbiguousLatest: true,
    serialize(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(AAD);
      const data = Buffer.concat([cipher.update(JSON.stringify(validateRecordingState(value))), cipher.final()]);
      return { schema: 'live-recordings-v1', iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('base64') };
    },
    deserialize(value) {
      if (value?.schema !== 'live-recordings-v1' || !/^[a-f0-9]{24}$/.test(value.iv || '') ||
          !/^[a-f0-9]{32}$/.test(value.tag || '') || typeof value.data !== 'string') throw Error('Invalid encrypted recording journal');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'hex'));
      decipher.setAAD(AAD); decipher.setAuthTag(Buffer.from(value.tag, 'hex'));
      return validateRecordingState(JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString()));
    },
  });
  return {
    async restore() { return await store.restore() || { version: 1, recordings: [] }; },
    async save(value) {
      const uri = await store.save(value);
      const restored = await store.restore();
      if (store.getLatestSnapshotUri() !== uri || JSON.stringify(restored) !== JSON.stringify(value)) throw Error('Recording journal readback failed');
      return uri;
    },
    close: () => store.close(),
  };
}

export function pcmWav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(BYTES_PER_SECOND, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function encodeRecording(segments, download) {
  const dir = await mkdtemp(join(tmpdir(), 'dbusk-recording-'));
  const output = join(dir, 'performance.mp3');
  const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(RATE),
    '-ac', '1', '-i', 'pipe:0', '-c:a', 'libmp3lame', '-b:a', '192k', '-y', output], { stdio: ['pipe', 'ignore', 'pipe'] });
  let diagnostics = '', inputError;
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-2000); });
  child.stdin.on('error', error => { inputError = error; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error(`Recording encoder failed (${code}): ${diagnostics}`)));
  });
  exited.catch(() => {});
  const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
  try {
    for (const segment of segments) {
      const wav = await download(segment.cid);
      if (wav.length !== segment.bytes + 44 || wav.toString('ascii', 0, 4) !== 'RIFF' ||
          wav.readUInt32LE(24) !== RATE || wav.readUInt16LE(22) !== 1 || wav.readUInt16LE(34) !== 16) throw Error('Recording segment failed verification');
      if (inputError) throw inputError;
      if (!child.stdin.write(wav.subarray(44))) await Promise.race([
        once(child.stdin, 'drain'), exited.then(() => { throw Error('Recording encoder ended before input completed'); }),
      ]);
    }
    child.stdin.end(); await exited;
    return await readFile(output);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited.catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

export function createLiveRecorder({ enabled = false, store, upload, download, ingest,
  encode = encodeRecording, now = () => Date.now(), log = console, segmentSeconds = 30 } = {}) {
  if (!Number.isInteger(segmentSeconds) || segmentSeconds < 1 || segmentSeconds > 30) throw Error('Invalid recording segment length');
  const available = enabled && !!store && !!upload && !!download && !!ingest;
  let state, initializing, tail = Promise.resolve(), working = false, buffered = 0, captureError = '';
  let chunks = [], bytes = 0, activeId, lastFrameAt = 0;
  const record = id => state?.recordings.find(r => r.bookingId === id);
  const serial = fn => {
    const task = tail.then(fn); tail = task.catch(error => {
      captureError = error.message; log.error('[live-recording]', error.message);
    }); return task;
  };
  const save = async next => { await store.save(validateRecordingState(next)); state = next; };
  async function initialize() {
    if (!available) return;
    initializing ||= Promise.resolve().then(() => store.restore()).then(async restored => {
      state = validateRecordingState(restored);
      const next = structuredClone(state);
      let changed = false;
      for (const r of next.recordings) if (r.status === 'recording') {
        r.interrupted = true; r.status = 'waiting'; changed = true;
      }
      if (changed) await save(next);
    }).catch(error => { initializing = null; throw error; });
    return initializing;
  }
  function flush() {
    if (!bytes) return;
    const pcm = Buffer.concat(chunks, bytes), id = activeId;
    chunks = []; bytes = 0; buffered++;
    void serial(async () => {
      try {
        const r = record(id);
        if (!r?.consent.enabled) return;
        const uri = await upload(pcmWav(pcm), `live-${id.replace(/[^a-z0-9]/gi, '-')}-${r.segments.length}.wav`, 'audio/wav');
        const cid = uri.replace(/^ipfs:\/\//, '');
        if (!safeCid(cid)) throw Error('Invalid recording segment CID');
        const next = structuredClone(state), target = next.recordings.find(r => r.bookingId === id);
        target.segments.push({ cid, bytes: pcm.length });
        target.status = 'recording'; await save(next);
      } finally { buffered--; }
    });
  }
  return {
    available, initialize,
    status(booking) {
      const r = record(booking.id);
      return { available, consented: r?.consent.enabled === true,
        canChange: available && now() < Date.parse(booking.endUtc) && !['processing', 'submitted'].includes(r?.status),
        status: r?.status || 'waiting', error: captureError || r?.error || '',
        ...(r?.trackId ? { trackId: r.trackId } : {}) };
    },
    async consent(booking, input, wallet, origin) {
      if (!available) throw new LiveAudioError('Live recording is not configured');
      await initialize();
      if (wallet.toLowerCase() !== booking.wallet.toLowerCase() || typeof input.enabled !== 'boolean' ||
          now() >= Date.parse(booking.endUtc) || Math.abs(now() - input.issuedAt) > 300000 ||
          input.issuedAt > now() + 30000 || input.issuedAt <= (record(booking.id)?.consent.issuedAt || 0)) throw new LiveAudioError('Recording permission expired or does not match the performer');
      const message = liveRecordingConsentMessage({ bookingId: booking.id, wallet, origin, issuedAt: input.issuedAt, enabled: input.enabled });
      if (verifyMessage(message, input.signature).toLowerCase() !== booking.wallet.toLowerCase()) throw new LiveAudioError('Recording signature does not match the performer');
      // Stop accepting frames immediately while revocation is being persisted.
      if (!input.enabled) { activeId = null; chunks = []; bytes = 0; }
      await serial(async () => {
        if (input.issuedAt <= (record(booking.id)?.consent.issuedAt || 0)) throw new LiveAudioError('Recording permission has already been superseded');
        const next = structuredClone(state);
        let r = next.recordings.find(r => r.bookingId === booking.id);
        if (['processing', 'submitted'].includes(r?.status)) throw new LiveAudioError('Recording publication has already started');
        if (!r) {
          r = { bookingId: booking.id, wallet: booking.wallet.toLowerCase(), segments: [], status: 'waiting' };
          next.recordings.push(r);
        }
        r.consent = { enabled: input.enabled, issuedAt: input.issuedAt, signature: input.signature, origin };
        r.status = input.enabled ? 'waiting' : 'revoked'; await save(next);
        captureError = '';
      });
    },
    capture(booking, frame) {
      const r = record(booking.id), at = now();
      if (!available || !r?.consent.enabled || !['waiting', 'recording'].includes(r.status) ||
          at < Date.parse(booking.startUtc) || at >= Date.parse(booking.endUtc) || captureError) return;
      if (frame.sampleRate !== RATE || frame.channels !== 1 || !(frame.data instanceof Int16Array)) {
        captureError = 'Unexpected recording audio format'; log.error('[live-recording]', captureError); return;
      }
      if (buffered >= 4) { captureError = 'Recording upload backlog exceeded; capture stopped'; log.error('[live-recording]', captureError); return; }
      if (activeId && activeId !== booking.id) { captureError = 'Another live recording is active'; log.error('[live-recording]', captureError); return; }
      activeId = booking.id;
      if (lastFrameAt && at - lastFrameAt > 2000) r.interrupted = true;
      lastFrameAt = at;
      const data = Buffer.from(new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength));
      chunks.push(data); bytes += data.length;
      if (bytes >= BYTES_PER_SECOND * segmentSeconds) flush();
    },
    async tick(bookings) {
      if (!available || working) return;
      working = true;
      try {
        await initialize();
        for (const booking of bookings) {
          let r = record(booking.id);
          if (!r || !r.consent.enabled || ['submitted', 'empty'].includes(r.status)) continue;
          if (now() < Date.parse(booking.endUtc) && !booking.cancelled) continue;
          if (activeId === booking.id) { flush(); activeId = null; lastFrameAt = 0; }
          await tail;
          r = record(booking.id);
          if (!r.segments.length) {
            const next = structuredClone(state); next.recordings.find(r => r.bookingId === booking.id).status = 'empty';
            await serial(() => save(next)); continue;
          }
          await serial(async () => {
            let next = structuredClone(state), target = next.recordings.find(r => r.bookingId === booking.id);
            target.status = 'processing'; target.error = captureError || target.error || ''; await save(next);
            r = record(booking.id);
            let result = r.result;
            if (!result) {
              const audio = await encode(r.segments, download);
              const uri = await upload(audio, 'live-performance.mp3', 'audio/mpeg');
              result = { cid: uri.replace(/^ipfs:\/\//, ''), durationSeconds: r.segments.reduce((n, s) => n + s.bytes, 0) / BYTES_PER_SECOND };
              if (!safeCid(result.cid)) throw Error('Invalid finalized recording CID');
              next = structuredClone(state); next.recordings.find(r => r.bookingId === booking.id).result = result; await save(next);
            }
            const track = await ingest({ booking, ...result, consent: r.consent,
              incomplete: !!(r.interrupted || captureError || result.durationSeconds < (Date.parse(booking.endUtc) - Date.parse(booking.startUtc)) / 1000 - 5) });
            next = structuredClone(state); target = next.recordings.find(r => r.bookingId === booking.id);
            target.status = 'submitted'; target.trackId = track.trackId; await save(next);
          });
        }
      } catch (error) {
        captureError = error.message; log.error('[live-recording] Finalization deferred:', error.message);
      } finally { working = false; }
    },
    deploymentState() { return { ready: (!available || !!state) && !working && !buffered && !bytes &&
      !(state?.recordings.some(r => r.consent.enabled && ['recording', 'processing'].includes(r.status))) }; },
    async flush() { flush(); await tail; },
  };
}
