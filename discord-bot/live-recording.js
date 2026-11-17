import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { verifyMessage } from 'ethers';
import { LIVE_RECORDING_MAX_SONGS, LIVE_RECORDING_MAX_SONG_SAMPLES, LIVE_RECORDING_SAMPLE_RATE,
  catalogRecordingAuthorizationMessage, catalogRecordingReleaseApprovalMessage, recordingReleaseApprovalMessage,
  recordingSourceSamples, validateCatalogRecordingDraft, validateRecordingDraft } from '../js/live-recording-edit.mjs';
import { liveRecordingConsentMessage, LIVE_RECORDING_CONSENT_VERSION, LIVE_RECORDING_ALLOCATED_CONSENT_VERSION } from '../js/live-recording-consent.mjs';
import { liveBroadcastEnd, liveBroadcastStart } from '../js/live-broadcast.mjs';
import { createPinataStateStore } from './ipfs-state.js';
import { LiveAudioError } from './live-audio-errors.js';
import { buildGatewayUrl } from './mint-sync.js';

const RATE = LIVE_RECORDING_SAMPLE_RATE, BYTES_PER_SECOND = RATE * 2;
const CATALOG_SOURCE_MAX_BYTES = 100 * 1024 * 1024;
const CATALOG_SOURCE_MAX_SAMPLES = RATE * 60 * 120;
const CATALOG_SEGMENT_BYTES = BYTES_PER_SECOND * 30;
const AAD = Buffer.from('dbusk-live-recording-state-v1');
const safeCid = value => typeof value === 'string' && /^[a-zA-Z0-9]{20,120}$/.test(value);
const keysOnly = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => keys.includes(key));
const safeAddress = value => /^0x[0-9a-f]{40}$/i.test(value || '');
const catalogBookingId = nftId => `catalog-${createHash('sha256').update(nftId).digest('hex')}`;
const catalogBooking = source => ({ id: catalogBookingId(source.nftId), wallet: source.artistWallet,
  title: source.title, displayName: source.artistName || source.artistWallet, artworkCid: source.artworkCid });

function validateCatalogSource(source) {
  if (!source || !keysOnly(source, ['nftId', 'chainId', 'contractAddress', 'tokenId', 'artistWallet', 'artistName',
    'sourceCid', 'title', 'mediaType', 'tipWallet', 'artworkCid', 'authorization']) ||
      source.chainId !== 8453 || !/^8453:0x[0-9a-f]{40}:\d{1,20}$/i.test(source.nftId || '') ||
      !/^0x[0-9a-f]{40}$/i.test(source.contractAddress || '') ||
      !Number.isSafeInteger(source.tokenId) || source.tokenId < 0 ||
      source.nftId.toLowerCase() !== `8453:${source.contractAddress.toLowerCase()}:${source.tokenId}` ||
      !safeAddress(source.artistWallet) || !safeCid(source.sourceCid) ||
      typeof source.title !== 'string' || !source.title.trim() || source.title.length > 200 ||
      typeof source.mediaType !== 'string' || !source.mediaType.startsWith('audio/') ||
      source.tipWallet !== undefined && !safeAddress(source.tipWallet) ||
      source.artworkCid !== undefined && !safeCid(source.artworkCid) ||
      !keysOnly(source.authorization, ['origin', 'nonce', 'expiresAt', 'signature']) ||
      typeof source.authorization.origin !== 'string' || !Number.isSafeInteger(source.authorization.expiresAt) ||
      !/^[a-f0-9]{64}$/i.test(source.authorization.nonce || '') ||
      typeof source.authorization.signature !== 'string' || source.authorization.signature.length > 1000) {
    throw Error('Catalog recording source is unavailable or unsupported');
  }
  const message = catalogRecordingAuthorizationMessage({
    nftId: source.nftId, wallet: source.artistWallet, origin: source.authorization.origin,
    nonce: source.authorization.nonce, expiresAt: source.authorization.expiresAt, sourceCid: source.sourceCid,
  });
  if (verifyMessage(message, source.authorization.signature).toLowerCase() !== source.artistWallet.toLowerCase()) {
    throw Error('Catalog recording edit authorization is invalid');
  }
  return source;
}

async function decodeCatalogRecording(source, { downloadSource, upload, timeoutMs = 180_000 }) {
  if (typeof downloadSource !== 'function') throw Error('Catalog recording source download is unavailable');
  const response = await downloadSource(source.sourceCid);
  if (!response?.ok || !response.body) throw Error(`Original catalog recording is unavailable${response?.status ? ` (${response.status})` : ''}`);
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > CATALOG_SOURCE_MAX_BYTES) {
    throw Error('Original recording exceeds the 100 MB processing limit');
  }
  const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror',
    '-i', 'pipe:0', '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'],
  { stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostics = '', inputError, inputBytes = 0, outputBytes = 0;
  const segments = [];
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-2000); });
  child.stdin.on('error', error => { inputError = error; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error(
      `Original recording decode failed (${code}): ${diagnostics || 'unsupported or invalid audio'}`)));
  });
  exited.catch(() => {});
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
  const input = (async () => {
    for await (const chunk of response.body) {
      inputBytes += chunk.byteLength;
      if (inputBytes > CATALOG_SOURCE_MAX_BYTES) throw Error('Original recording exceeds the 100 MB processing limit');
      if (inputError) throw inputError;
      if (!child.stdin.write(chunk)) await Promise.race([
        once(child.stdin, 'drain'), exited.then(() => { throw Error('Decoder stopped before the source download completed'); }),
      ]);
    }
    child.stdin.end();
  })();
  const output = (async () => {
    let current = Buffer.alloc(CATALOG_SEGMENT_BYTES), filled = 0, segmentIndex = 0;
    for await (const chunk of child.stdout) {
      let offset = 0;
      while (offset < chunk.length) {
        const take = Math.min(CATALOG_SEGMENT_BYTES - filled, chunk.length - offset);
        chunk.copy(current, filled, offset, offset + take);
        filled += take; offset += take; outputBytes += take;
        if (outputBytes > CATALOG_SOURCE_MAX_SAMPLES * 2) throw Error('Decoded recording exceeds the 120-minute processing limit');
        if (filled === CATALOG_SEGMENT_BYTES) {
          const uri = await upload(pcmWav(current), `catalog-${source.tokenId}-${segmentIndex++}.wav`, 'audio/wav');
          const cid = uri.replace(/^ipfs:\/\//, '');
          if (!safeCid(cid)) throw Error('Invalid decoded recording segment CID');
          segments.push({ cid, bytes: current.length, waveform: waveformFor(current) });
          current = Buffer.alloc(CATALOG_SEGMENT_BYTES); filled = 0;
        }
      }
    }
    if (filled) {
      if (filled % 2 !== 0) throw Error('Decoded recording ended on an invalid sample boundary');
      const pcm = current.subarray(0, filled);
      const uri = await upload(pcmWav(pcm), `catalog-${source.tokenId}-${segmentIndex}.wav`, 'audio/wav');
      const cid = uri.replace(/^ipfs:\/\//, '');
      if (!safeCid(cid)) throw Error('Invalid decoded recording segment CID');
      segments.push({ cid, bytes: pcm.length, waveform: waveformFor(pcm) });
    }
  })();
  try {
    await Promise.all([input, output, exited]);
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.allSettled([input, output, exited]);
    throw error;
  } finally { clearTimeout(timer); }
  const sourceSamples = outputBytes / 2;
  if (!Number.isSafeInteger(sourceSamples) || sourceSamples < RATE * 3 / 2 ||
      sourceSamples > CATALOG_SOURCE_MAX_SAMPLES || !segments.length || segments.length > 500) {
    throw Error('Original recording must contain 1.5 seconds to 120 minutes of measurable audio');
  }
  return { segments, sourceSamples };
}
function waveformFor(pcm, limit = 120) {
  const samples = pcm.length / 2, bins = Math.min(samples, limit), points = [];
  for (let bin = 0; bin < bins; bin++) {
    const start = Math.floor(bin * samples / bins), end = Math.floor((bin + 1) * samples / bins);
    let min = 32767, max = -32768;
    for (let sample = start; sample < end; sample++) {
      const value = pcm.readInt16LE(sample * 2);
      if (value < min) min = value;
      if (value > max) max = value;
    }
    points.push([min / 32768, max / 32768]);
  }
  return points;
}

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
    const catalog = r?.catalogSource;
    const isCatalog = catalog !== undefined;
    const consentValid = isCatalog ? r.consent === undefined :
      keysOnly(r.consent, ['enabled', 'issuedAt', 'signature', 'origin', 'version']) &&
      typeof r.consent?.enabled === 'boolean' && Number.isSafeInteger(r.consent.issuedAt) &&
      typeof r.consent.signature === 'string';
    const catalogValid = !isCatalog || (() => {
      try {
        validateCatalogSource(catalog);
        return catalog.artistWallet.toLowerCase() === String(r.wallet || '').toLowerCase() &&
          r.result?.cid === catalog.sourceCid;
      } catch { return false; }
    })();
    if (!keysOnly(r, ['bookingId', 'wallet', 'consent', 'catalogSource', 'segments', 'status', 'interrupted', 'incomplete', 'result', 'trackId', 'error',
      'draft', 'releaseChoice', 'releaseApproval', 'releases']) ||
        typeof r.bookingId !== 'string' || ids.has(r.bookingId) || !/^0x[0-9a-f]{40}$/i.test(r.wallet || '') ||
        !consentValid || !catalogValid || !Array.isArray(r.segments) || r.segments.length > 500 ||
        r.segments.some(s => !keysOnly(s, ['cid', 'bytes', 'waveform', 'firstFrameAt', 'lastFrameAt']) || !safeCid(s.cid) || !Number.isSafeInteger(s.bytes) || s.bytes <= 0 ||
          s.bytes > BYTES_PER_SECOND * 30 || s.bytes % 2 !== 0 ||
          (s.firstFrameAt !== undefined || s.lastFrameAt !== undefined) &&
            (!Number.isSafeInteger(s.firstFrameAt) || s.firstFrameAt < 0 ||
              !Number.isSafeInteger(s.lastFrameAt) || s.lastFrameAt <= s.firstFrameAt) ||
          s.waveform !== undefined && (!Array.isArray(s.waveform) || s.waveform.length > 120 ||
            s.waveform.some(point => !Array.isArray(point) || point.length !== 2 ||
              point.some(value => !Number.isFinite(value) || value < -1 || value > 1) || point[0] > point[1]))) ||
        !['waiting', 'recording', 'processing', 'ready', 'submitted', 'revoked', 'empty'].includes(r.status) ||
        (r.interrupted !== undefined && typeof r.interrupted !== 'boolean') ||
        (r.incomplete !== undefined && typeof r.incomplete !== 'boolean') ||
        (r.error !== undefined && (typeof r.error !== 'string' || r.error.length > 3000)) ||
        (r.trackId !== undefined && (typeof r.trackId !== 'string' || r.trackId.length > 300)) ||
        (r.result && (!keysOnly(r.result, ['cid', 'durationSeconds', 'durationSamples', 'sampleRate']) || !safeCid(r.result.cid) ||
          !Number.isFinite(r.result.durationSeconds) || r.result.durationSeconds <= 0 ||
          r.result.durationSamples !== undefined && (!Number.isSafeInteger(r.result.durationSamples) || r.result.durationSamples <= 0) ||
          r.result.sampleRate !== undefined && r.result.sampleRate !== RATE)) ||
        (r.draft !== undefined && !r.result) ||
        (r.draft !== undefined && (isCatalog ? validateCatalogRecordingDraft : validateRecordingDraft)
          (r.draft, recordingSourceSamples(r.segments)) === null) ||
        (r.releaseChoice !== undefined && !['deferred', 'full', 'split'].includes(r.releaseChoice)) ||
        (r.releaseApproval !== undefined && (!keysOnly(r.releaseApproval, ['choice', 'issuedAt', 'signature', 'messageHash']) ||
          !['defer', 'full', 'split'].includes(r.releaseApproval.choice) || !Number.isSafeInteger(r.releaseApproval.issuedAt) ||
          typeof r.releaseApproval.signature !== 'string' || r.releaseApproval.signature.length > 1000 ||
          !/^[a-f0-9]{64}$/.test(r.releaseApproval.messageHash || ''))) ||
        (        r.releases !== undefined && (!Array.isArray(r.releases) || r.releases.length > 500 ||
          r.releases.some(release => !keysOnly(release, ['releaseId', 'choice', 'title', 'albumTitle', 'trackNumber', 'startSample',
            'endSample', 'sourceCid', 'cid', 'durationSamples', 'trackId', 'status', 'error', 'approvalMessageHash',
            'approvalSignature', 'approvedAt', 'incomplete', 'parentReleaseId']) ||
            typeof release.releaseId !== 'string' || !/^[a-f0-9]{64}$/.test(release.releaseId) ||
            !['full', 'split'].includes(release.choice) || typeof release.title !== 'string' || release.title.length > 120 ||
            typeof release.albumTitle !== 'string' || release.albumTitle.length > 120 ||
            !Number.isSafeInteger(release.trackNumber) || release.trackNumber < 1 ||
            !Number.isSafeInteger(release.startSample) || !Number.isSafeInteger(release.endSample) ||
            release.startSample < 0 || release.endSample <= release.startSample ||
            !safeCid(release.sourceCid) || release.cid !== undefined && !safeCid(release.cid) ||
            !Number.isSafeInteger(release.durationSamples) || release.durationSamples !== release.endSample - release.startSample ||
            release.trackId !== undefined && (typeof release.trackId !== 'string' || release.trackId.length > 300) ||
            !['pending', 'encoding', 'uploading', 'queued', 'failed'].includes(release.status) ||
            release.error !== undefined && (typeof release.error !== 'string' || release.error.length > 3000) ||
            typeof release.approvalMessageHash !== 'string' || !/^[a-f0-9]{64}$/.test(release.approvalMessageHash) ||
            typeof release.approvalSignature !== 'string' || release.approvalSignature.length > 1000 ||
            !Number.isSafeInteger(release.approvedAt) || typeof release.incomplete !== 'boolean' ||
            release.parentReleaseId !== undefined && !/^[a-f0-9]{64}$/.test(release.parentReleaseId))))) throw Error('Invalid recording journal');
    if (!isCatalog) {
      const message = liveRecordingConsentMessage({ bookingId: r.bookingId, wallet: r.wallet,
        origin: r.consent.origin, issuedAt: r.consent.issuedAt, enabled: r.consent.enabled, version: r.consent.version });
      if (verifyMessage(message, r.consent.signature).toLowerCase() !== r.wallet.toLowerCase()) throw Error('Invalid recording permission signature');
    }
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

export async function encodeRecording(segments, download, { workDirectory = tmpdir() } = {}) {
  const dir = await mkdtemp(join(workDirectory, 'dbusk-recording-'));
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

export async function encodeRecordingRange(segments, download, startSample, endSample) {
  const totalSamples = recordingSourceSamples(segments);
  if (!Number.isSafeInteger(startSample) || !Number.isSafeInteger(endSample) ||
      startSample < 0 || endSample > totalSamples || endSample - startSample < RATE / 2 ||
      endSample - startSample > LIVE_RECORDING_MAX_SONG_SAMPLES) throw Error('Recording export range is outside the allowed bounds');
  const durationSeconds = (endSample - startSample) / RATE;
  const fadeSeconds = Math.min(0.01, durationSeconds / 4);
  const audioFilter = `volume=0.89125094,afade=t=in:st=0:d=${fadeSeconds},afade=t=out:st=${durationSeconds - fadeSeconds}:d=${fadeSeconds}`;
  const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', 'pipe:0', '-af', audioFilter,
    '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostics = '', inputError, outputError;
  const output = [];
  let outputLength = 0;
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-2000); });
  child.stdin.on('error', error => { inputError = error; });
  child.stdout.on('data', chunk => {
    outputLength += chunk.length;
    if (outputLength > 45 * 1024 * 1024) {
      outputError = Error('Recording export exceeds the 45 MB limit');
      child.kill('SIGTERM');
    } else output.push(chunk);
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 && !outputError ? resolve() :
      reject(outputError || Error(`Recording encoder failed (${code}): ${diagnostics}`)));
  });
  exited.catch(() => {});
  const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
  try {
    let sourceStart = 0;
    for (const segment of segments) {
      const segmentSamples = segment.bytes / 2;
      const from = Math.max(startSample, sourceStart), to = Math.min(endSample, sourceStart + segmentSamples);
      if (from < to) {
        const wav = await download(segment.cid);
        if (!Buffer.isBuffer(wav) || wav.length !== segment.bytes + 44 ||
            wav.toString('ascii', 0, 4) !== 'RIFF' || wav.readUInt32LE(24) !== RATE ||
            wav.readUInt16LE(22) !== 1 || wav.readUInt16LE(34) !== 16 || wav.readUInt32LE(40) !== segment.bytes) {
          throw Error('Recording segment failed verification');
        }
        if (inputError) throw inputError;
        const pcmStart = 44 + (from - sourceStart) * 2;
        const pcmEnd = 44 + (to - sourceStart) * 2;
        if (!child.stdin.write(wav.subarray(pcmStart, pcmEnd))) await Promise.race([
          once(child.stdin, 'drain'), exited.then(() => { throw Error('Recording encoder ended before input completed'); }),
        ]);
      }
      sourceStart += segmentSamples;
      if (sourceStart >= endSample) break;
    }
    child.stdin.end();
    await exited;
    return Buffer.concat(output, outputLength);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited.catch(() => {});
  }
}

export function createLiveRecorder({ enabled = false, store, upload, download, ingest, submitRelease = ingest,
  encode = encodeRecording, encodeRange = encodeRecordingRange, downloadSource,
  decodeSource = decodeCatalogRecording, getRelease = () => null,
  now = () => Date.now(), log = console, segmentSeconds = 30, resumeDelayMs = 0,
  persistFrameTimes = process.env.LIVE_RECORDING_FRAME_TIMES_ENABLED === 'true',
  finalizationTimeoutMs = 120000 } = {}) {
  if (!Number.isInteger(segmentSeconds) || segmentSeconds < 1 || segmentSeconds > 30) throw Error('Invalid recording segment length');
  const available = enabled && !!store && !!upload && !!download && !!submitRelease;
  let state, initializing, tail = Promise.resolve(), working = false, buffered = 0;
  const captureErrors = new Map(), interruptedCaptures = new Set(), finalizationErrors = new Map(), finalizationTasks = new Map();
  const editTasks = new Map(), catalogEditTasks = new Map(), catalogApprovalTasks = new Map();
  let initializationError = '';
  let chunks = [], bytes = 0, activeId, lastFrameAt = 0;
  let segmentFirstFrameAt, segmentLastFrameAt;
  let deployment = null, preparingDeployment = false;
  // A replaced worker may still be retrying during deploy overlap; let it exit before resuming its checkpoint.
  const resumeAt = now() + resumeDelayMs;
  const deploymentPaused = () => preparingDeployment || !!(deployment && deployment.expiresAt > now());
  const record = id => state?.recordings.find(r => r.bookingId === id);
  const canEditRecord = r => !!r && (r.catalogSource
    ? r.catalogSource.artistWallet.toLowerCase() === r.wallet.toLowerCase()
    : r.consent?.enabled === true);
  const normalizeDraft = (r, draft, sourceSamples) => r.catalogSource
    ? validateCatalogRecordingDraft(draft, sourceSamples)
    : validateRecordingDraft(draft, sourceSamples);
  const serial = (fn, { captureFailure = true, bookingId = activeId } = {}) => {
    const task = tail.then(fn); tail = task.catch(error => {
      if (captureFailure && bookingId) captureErrors.set(bookingId, error.message);
      log.error('[live-recording]', error.message);
    }); return task;
  };
  const save = async next => { await store.save(validateRecordingState(next)); state = next; };
  const sourceFor = r => r?.result && r.segments.length ? recordingSourceSamples(r.segments) : 0;
  const releaseMintStatus = release => {
    const queued = release.trackId ? getRelease(release.trackId) : null;
    return queued?.mintStatus === 'minted' ? 'minted' : queued?.mintStatus === 'requested' ? 'queued' : release.status;
  };
  function editState(booking) {
    const r = record(booking.id), sourceSamples = sourceFor(r);
    if (!r || !r.result || !sourceSamples || !canEditRecord(r) || !['ready', 'submitted'].includes(r.status)) {
      return { available: false, status: r?.status || 'waiting', error: r?.error || '' };
    }
    const albumTitle = String(r.catalogSource?.title || booking.title || 'Live performance').slice(0, 120);
    const trackTitle = albumTitle.slice(0, 80).trimEnd();
    const cutCount = r.catalogSource
      ? Math.min(4, Math.max(3, Math.ceil(sourceSamples / LIVE_RECORDING_MAX_SONG_SAMPLES)))
      : 1;
    const songs = Array.from({ length: cutCount }, (_, index) => {
      const startSample = Math.floor(index * sourceSamples / cutCount);
      const endSample = Math.floor((index + 1) * sourceSamples / cutCount);
      return { title: `${trackTitle} - Track ${index + 1}`.slice(0, 100), startSample, endSample };
    });
    const draft = r.draft || { revision: 0, albumTitle, songs };
    let sampleStart = 0;
    const waveform = [];
    for (const segment of r.segments) {
      const segmentSamples = segment.bytes / 2;
      for (let index = 0; index < (segment.waveform || []).length; index++) {
        const [min, max] = segment.waveform[index];
        waveform.push({ startSample: sampleStart + Math.floor(index * segmentSamples / segment.waveform.length),
          endSample: sampleStart + Math.floor((index + 1) * segmentSamples / segment.waveform.length), min, max });
      }
      sampleStart += segmentSamples;
    }
    return {
      available: true, bookingId: booking.id, wallet: r.wallet, status: r.status,
      sourceType: r.catalogSource ? 'catalog' : 'live',
      ...(r.catalogSource ? { catalogSource: {
        nftId: r.catalogSource.nftId, chainId: r.catalogSource.chainId,
        contractAddress: r.catalogSource.contractAddress, tokenId: r.catalogSource.tokenId,
        artistWallet: r.catalogSource.artistWallet, title: r.catalogSource.title,
      } } : {}),
      sourceCid: r.result.cid, sourceSamples, sampleRate: RATE,
      durationSeconds: sourceSamples / RATE, incomplete: r.incomplete === true,
      ...(r.consent ? { consent: { version: r.consent.version, issuedAt: r.consent.issuedAt } } : {}),
      decision: r.releaseChoice || 'undecided', draft, waveform,
      releases: (r.releases || []).map(release => ({ ...release, status: releaseMintStatus(release) })),
    };
  }
  async function persistRelease(bookingId, releaseId, mutate) {
    await serial(async () => {
      const next = structuredClone(state), target = next.recordings.find(r => r.bookingId === bookingId);
      const release = target?.releases?.find(item => item.releaseId === releaseId);
      if (!release) throw Error('Approved recording release is unavailable');
      mutate(release, target);
      await save(next);
    }, { captureFailure: false, bookingId });
  }
  async function processRelease(booking, releaseId) {
    const existing = editTasks.get(releaseId);
    if (existing) return existing;
    const task = (async () => {
      let release = record(booking.id)?.releases?.find(item => item.releaseId === releaseId);
      if (!release) throw Error('Approved recording release is unavailable');
      if (release.status === 'queued' && release.trackId) return release;
      let cid = release.cid;
      try {
        if (release.choice === 'full') {
          release = { ...release, cid: release.sourceCid };
          cid = release.cid;
        } else if (!release.cid) {
          await persistRelease(booking.id, releaseId, target => { target.status = 'encoding'; target.error = ''; });
          const current = record(booking.id);
          const audio = await boundedFinalization(booking.id, `edit-encode:${releaseId}`,
            () => encodeRange(current.segments, download, release.startSample, release.endSample));
          finalizationTasks.delete(`${booking.id}:edit-encode:${releaseId}`);
          if (!Buffer.isBuffer(audio) || audio.length > 45 * 1024 * 1024) throw Error('Recording export exceeds the 45 MB limit');
          await persistRelease(booking.id, releaseId, target => { target.status = 'uploading'; });
          const uri = await boundedFinalization(booking.id, `edit-upload:${releaseId}`,
            () => upload(audio, `live-${releaseId.slice(0, 20)}.mp3`, 'audio/mpeg'));
          finalizationTasks.delete(`${booking.id}:edit-upload:${releaseId}`);
          cid = uri.replace(/^ipfs:\/\//, '');
          if (!safeCid(cid)) throw Error('Invalid recording export CID');
          await persistRelease(booking.id, releaseId, target => { target.cid = cid; target.status = 'uploading'; });
          release = record(booking.id).releases.find(item => item.releaseId === releaseId);
        }
        if (!release.cid) throw Error('Recording export CID is unavailable');
        const current = record(booking.id);
        const queued = await boundedFinalization(booking.id, `edit-queue:${releaseId}`, () => submitRelease({ booking, release: { ...release, cid },
          source: { cid: current.result.cid, segments: current.segments, sampleRate: RATE,
            durationSamples: sourceFor(current) }, catalogSource: current.catalogSource,
          consent: current.consent, incomplete: current.incomplete === true }));
        finalizationTasks.delete(`${booking.id}:edit-queue:${releaseId}`);
        if (!queued?.trackId) throw Error('Recording release was not added to the mint queue');
        await persistRelease(booking.id, releaseId, target => {
          target.cid = cid; target.trackId = queued.trackId; target.status = 'queued'; target.error = '';
        });
        return record(booking.id).releases.find(item => item.releaseId === releaseId);
      } catch (error) {
        await persistRelease(booking.id, releaseId, target => { target.status = 'failed'; target.error = String(error.message).slice(0, 3000); })
          .catch(() => {});
        throw error;
      }
    })();
    editTasks.set(releaseId, task);
    try { return await task; }
    finally { editTasks.delete(releaseId); }
  }
  async function approveEdit(booking, { choice, issuedAt, signature }, wallet, origin) {
    await initialize();
    const r = record(booking.id), sourceSamples = sourceFor(r);
    if (!r || !r.result || !sourceSamples || r.wallet.toLowerCase() !== String(wallet || '').toLowerCase() ||
        r.wallet.toLowerCase() !== booking.wallet.toLowerCase() || !canEditRecord(r) ||
        !['ready', 'submitted'].includes(r.status)) throw Error('Recording is not available for performer approval');
    if (!Number.isSafeInteger(issuedAt) || Math.abs(now() - issuedAt) > 300000 || issuedAt > now() + 30000) {
      throw Error('Recording approval expired; review and sign again');
    }
    const draft = choice === 'defer' ? null : normalizeDraft(r, r.draft || editState(booking).draft, sourceSamples);
    if (r.catalogSource && choice === 'split' && (draft.songs.length < 3 || draft.songs.length > 4)) {
      throw Error('Approve three or four named cuts for a catalog split');
    }
    const message = r.catalogSource
      ? catalogRecordingReleaseApprovalMessage({ nftId: r.catalogSource.nftId, wallet: r.wallet, origin,
        sourceCid: r.result.cid, sourceSamples, choice, draft, issuedAt })
      : recordingReleaseApprovalMessage({ bookingId: booking.id, wallet: r.wallet, origin,
        sourceCid: r.result.cid, sourceSamples, choice, draft, issuedAt, incomplete: r.incomplete === true });
    if (verifyMessage(message, signature).toLowerCase() !== r.wallet.toLowerCase()) {
      throw Error('Recording approval signature does not match the booked performer');
    }
    const messageHash = createHash('sha256').update(message).digest('hex');
    if (choice === 'defer') {
      await serial(async () => {
        const next = structuredClone(state), target = next.recordings.find(item => item.bookingId === booking.id);
        target.releaseChoice = 'deferred';
        target.releaseApproval = { choice, issuedAt, signature, messageHash };
        await save(next);
      }, { captureFailure: false, bookingId: booking.id });
      return editState(booking);
    }
    const plans = choice === 'full'
      ? [{ title: draft.albumTitle, albumTitle: draft.albumTitle, trackNumber: 1, startSample: 0, endSample: sourceSamples }]
      : draft.songs.map((song, index) => ({ ...song, albumTitle: draft.albumTitle, trackNumber: index + 1 }));
    const releasePlans = plans.map(plan => {
      const planHash = createHash('sha256').update(JSON.stringify({ bookingId: booking.id, sourceCid: r.result.cid,
        ...(r.catalogSource ? { nftId: r.catalogSource.nftId } : {}),
        choice, title: plan.title, albumTitle: plan.albumTitle, trackNumber: plan.trackNumber,
        startSample: plan.startSample, endSample: plan.endSample })).digest('hex');
      const fullReleases = (r.releases || []).filter(item => item.choice === 'full');
      const parent = choice === 'split'
        ? fullReleases.find(item => releaseMintStatus(item) === 'minted') ||
          [...fullReleases].reverse().find(item => ['queued', 'failed'].includes(releaseMintStatus(item)))
        : null;
      return { ...plan, releaseId: planHash, choice, sourceCid: r.result.cid,
        durationSamples: plan.endSample - plan.startSample, approvalMessageHash: messageHash,
        approvalSignature: signature, approvedAt: issuedAt, incomplete: r.incomplete === true,
        ...(parent ? { parentReleaseId: parent.releaseId } : {}) };
    });
    const planIds = new Set(releasePlans.map(plan => plan.releaseId));
    for (const previous of r.releases || []) {
      if (previous.choice !== choice || planIds.has(previous.releaseId)) continue;
      if (releaseMintStatus(previous) !== 'minted' && previous.status !== 'failed') {
        throw Error('A release of this type is already awaiting mint review; wait before creating another version');
      }
    }
    await serial(async () => {
      const next = structuredClone(state), target = next.recordings.find(item => item.bookingId === booking.id);
      if (!target.releases) target.releases = [];
      target.releaseChoice = choice;
      target.releaseApproval = { choice, issuedAt, signature, messageHash };
      for (const plan of releasePlans) {
        if (target.releases.some(item => item.releaseId === plan.releaseId)) continue;
        target.releases.push({ ...plan, status: 'pending' });
      }
      await save(next);
    }, { captureFailure: false, bookingId: booking.id });
    for (const plan of releasePlans) await processRelease(booking, plan.releaseId);
    return editState(booking);
  }
  async function prepareCatalogEdit(input, authorization) {
    if (!available) throw new LiveAudioError('Catalog recording editing is unavailable');
    await initialize();
    if (deploymentPaused()) throw new LiveAudioError('Catalog recording editing is paused for a verified deployment handoff');
    const source = validateCatalogSource({ ...input, authorization });
    const existing = catalogEditTasks.get(source.nftId);
    if (existing) return existing;
    const task = (async () => {
      const booking = catalogBooking(source);
      const current = record(booking.id);
      if (current) {
        if (!current.catalogSource || current.catalogSource.sourceCid !== source.sourceCid ||
            current.catalogSource.artistWallet.toLowerCase() !== source.artistWallet.toLowerCase()) {
          throw new LiveAudioError('This NFT identity is already linked to a different source; refresh the verified catalog item');
        }
        await serial(async () => {
          const next = structuredClone(state);
          const target = next.recordings.find(item => item.bookingId === booking.id);
          target.catalogSource.authorization = source.authorization;
          await save(next);
        }, { captureFailure: false, bookingId: booking.id });
        return editState(booking);
      }
      const decoded = await decodeSource(source, { downloadSource, upload, timeoutMs: finalizationTimeoutMs * 3 });
      const nextRecord = {
        bookingId: booking.id, wallet: source.artistWallet.toLowerCase(), catalogSource: source,
        segments: decoded.segments, status: 'ready',
        result: { cid: source.sourceCid, durationSamples: decoded.sourceSamples, sampleRate: RATE,
          durationSeconds: decoded.sourceSamples / RATE },
        releaseChoice: 'deferred',
      };
      await serial(async () => {
        const next = structuredClone(state);
        if (next.recordings.some(item => item.bookingId === booking.id)) {
          throw new LiveAudioError('This catalog recording was prepared in another session; reload its draft');
        }
        next.recordings.push(nextRecord);
        await save(next);
      }, { captureFailure: false, bookingId: booking.id });
      return editState(booking);
    })();
    catalogEditTasks.set(source.nftId, task);
    try { return await task; }
    finally { catalogEditTasks.delete(source.nftId); }
  }
  const catalogSourceMatches = (stored, current) => !!stored && !!current &&
    stored.nftId.toLowerCase() === current.nftId.toLowerCase() &&
    stored.sourceCid === current.sourceCid &&
    stored.artistWallet.toLowerCase() === current.artistWallet.toLowerCase() &&
    stored.chainId === current.chainId && stored.contractAddress.toLowerCase() === current.contractAddress.toLowerCase() &&
    stored.tokenId === current.tokenId && stored.title === current.title &&
    stored.artistName === current.artistName && stored.mediaType === current.mediaType &&
    stored.artworkCid === current.artworkCid;
  async function boundedFinalization(bookingId, step, work) {
    const key = `${bookingId}:${step}`;
    let task = finalizationTasks.get(key);
    if (!task) {
      task = Promise.resolve().then(work);
      finalizationTasks.set(key, task);
      task.catch(() => { if (finalizationTasks.get(key) === task) finalizationTasks.delete(key); });
    }
    let timer;
    try {
      return await Promise.race([task, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Recording finalization timed out; retry remains pending')), finalizationTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
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
      initializationError = '';
    }).catch(error => { initializing = null; initializationError = 'Recording journal verification is unavailable'; throw error; });
    return initializing;
  }
  function flush() {
    if (!bytes) return;
    const pcm = Buffer.concat(chunks, bytes), id = activeId;
    const timing = persistFrameTimes ? { firstFrameAt: segmentFirstFrameAt, lastFrameAt: segmentLastFrameAt } : {};
    const interrupted = record(id)?.interrupted || interruptedCaptures.has(id);
    chunks = []; bytes = 0; buffered++;
    void serial(async () => {
      try {
        const r = record(id);
        if (!r?.consent.enabled) return;
        const uri = await upload(pcmWav(pcm), `live-${id.replace(/[^a-z0-9]/gi, '-')}-${r.segments.length}.wav`, 'audio/wav');
        const cid = uri.replace(/^ipfs:\/\//, '');
        if (!safeCid(cid)) throw Error('Invalid recording segment CID');
        const next = structuredClone(state), target = next.recordings.find(r => r.bookingId === id);
        target.segments.push({ cid, bytes: pcm.length, waveform: waveformFor(pcm), ...timing });
        if (interrupted) target.interrupted = true;
        target.status = 'recording'; await save(next);
      } finally { buffered--; }
    }, { bookingId: id });
  }
  function stopCapture(booking) {
    if (activeId !== booking.id) return;
    flush(); activeId = null; lastFrameAt = 0;
  }
  return {
    available, initialize, stopCapture,
    deploymentPaused,
    cancelDeployment(id) {
      if (deployment && deployment.expiresAt > now() && deployment.id !== id) throw Error('Another deployment holds the recording handoff');
      deployment = null;
    },
    async prepareDeployment({ id, expiresAt, bookings }) {
      if (!/^[a-zA-Z0-9:_-]{1,100}$/.test(id || '') || !Number.isFinite(expiresAt) ||
          expiresAt <= now() || expiresAt > now() + 15 * 60_000 || !Array.isArray(bookings)) {
        throw Error('Invalid recording deployment lease');
      }
      if (!available) return { ready: true };
      if (preparingDeployment || deployment && deployment.expiresAt > now() && deployment.id !== id) {
        throw Error('Another deployment holds the recording handoff');
      }
      await initialize();
      if (preparingDeployment || deployment && deployment.expiresAt > now() && deployment.id !== id) {
        throw Error('Another deployment holds the recording handoff');
      }
      if (working || buffered || bytes || activeId || finalizationTasks.size || editTasks.size ||
          catalogEditTasks.size || catalogApprovalTasks.size) return { ready: false };
      if (bookings.some(b => b.acknowledged && ['funded', 'approved'].includes(b.status) &&
          (!Number.isFinite(Date.parse(b.startUtc)) || !Number.isFinite(Date.parse(b.endUtc))))) {
        throw Error('Booking times unavailable for recording handoff');
      }
      if (bookings.some(b => b.acknowledged && ['funded', 'approved'].includes(b.status) &&
          !b.cancelled && liveBroadcastEnd(b) > now() && liveBroadcastStart(b) < expiresAt)) {
        return { ready: false };
      }
      const pending = state.recordings.filter(r => r.consent?.enabled && ['waiting', 'recording', 'processing'].includes(r.status));
      if (pending.some(r => {
        const b = bookings.find(b => b.id === r.bookingId);
        return !b || b.wallet?.toLowerCase() !== r.wallet.toLowerCase() ||
          !Number.isFinite(liveBroadcastEnd(b)) || liveBroadcastEnd(b) > now() ||
          r.status === 'recording' || !r.segments.length;
      })) return { ready: false };
      preparingDeployment = true;
      deployment = { id, expiresAt };
      try {
        await tail;
        if (working || buffered || bytes || activeId || finalizationTasks.size || editTasks.size ||
            catalogEditTasks.size || catalogApprovalTasks.size) return { ready: false };
        const restored = validateRecordingState(await store.restore());
        if (JSON.stringify(restored) !== JSON.stringify(state)) throw Error('Recording handoff checkpoint does not match the canonical recorder');
        if (expiresAt <= now()) throw Error('Recording handoff lease expired during verification');
        return { ready: true, recordingCheckpointVerified: true };
      } finally { preparingDeployment = false; }
    },
    status(booking) {
      const r = record(booking.id);
      const consentVersion = r?.consent.version || LIVE_RECORDING_CONSENT_VERSION;
      return { available, consented: r?.consent.enabled === true,
        consentVersion, consentScope: consentVersion === LIVE_RECORDING_ALLOCATED_CONSENT_VERSION ? 'allocated-set' : 'scheduled-set',
        scopeLimited: !!booking.broadcast && consentVersion !== LIVE_RECORDING_ALLOCATED_CONSENT_VERSION,
        canChange: available && !deploymentPaused() && now() < liveBroadcastEnd(booking) && !['processing', 'submitted'].includes(r?.status),
        status: r?.status || 'waiting', error: initializationError || captureErrors.get(booking.id) || finalizationErrors.get(booking.id) || r?.error || '',
        editAvailable: !!(r?.result && ['ready', 'submitted'].includes(r.status)),
        releaseDecision: r?.releaseChoice || 'undecided',
        ...(r?.trackId ? { trackId: r.trackId } : {}) };
    },
    async editState(booking) {
      if (!available) throw new LiveAudioError('Recording editing is unavailable');
      await initialize();
      return editState(booking);
    },
    prepareCatalogEdit,
    async catalogEditState(source) {
      if (!available) throw new LiveAudioError('Catalog recording editing is unavailable');
      await initialize();
      const booking = catalogBooking(source), current = record(booking.id);
      if (!catalogSourceMatches(current?.catalogSource, source)) {
        throw new LiveAudioError('Catalog source changed or its durable edit journal is unavailable; reopen from the verified catalog');
      }
      return editState(booking);
    },
    async saveCatalogEdit(source, draft, wallet) {
      await initialize();
      const booking = catalogBooking(source), current = record(booking.id);
      if (!catalogSourceMatches(current?.catalogSource, source) ||
          current.wallet.toLowerCase() !== String(wallet || '').toLowerCase()) {
        throw new LiveAudioError('Only the artist may edit the verified catalog source');
      }
      return this.saveEdit(booking, draft, wallet);
    },
    async approveCatalogEdit(source, command, wallet, origin) {
      if (!available) throw new LiveAudioError('Catalog recording editing is unavailable');
      if (deploymentPaused()) throw new LiveAudioError('Catalog recording editing is paused for a verified deployment handoff');
      await initialize();
      const booking = catalogBooking(source), current = record(booking.id);
      if (!catalogSourceMatches(current?.catalogSource, source) ||
          current.wallet.toLowerCase() !== String(wallet || '').toLowerCase()) {
        throw new LiveAudioError('Only the artist may approve releases from the verified catalog source');
      }
      if (deploymentPaused()) throw new LiveAudioError('Catalog recording editing is paused for a verified deployment handoff');
      const existing = catalogApprovalTasks.get(source.nftId);
      if (existing) return existing;
      const task = approveEdit(booking, command, wallet, origin);
      catalogApprovalTasks.set(source.nftId, task);
      try { return await task; }
      finally { catalogApprovalTasks.delete(source.nftId); }
    },
    async saveEdit(booking, draft, wallet) {
      if (!available || deploymentPaused()) throw new LiveAudioError('Recording editing is unavailable');
      await initialize();
      const current = record(booking.id), sourceSamples = sourceFor(current);
      if (!current || current.wallet.toLowerCase() !== String(wallet || '').toLowerCase() ||
          current.wallet.toLowerCase() !== booking.wallet.toLowerCase() || !canEditRecord(current) ||
          !current.result || !['ready', 'submitted'].includes(current.status)) {
        throw new LiveAudioError(current?.catalogSource
          ? 'Only the artist can edit this verified catalog recording'
          : 'Only the booked performer can edit this finalized recording');
      }
      const normalized = normalizeDraft(current, draft, sourceSamples);
      await serial(async () => {
        const next = structuredClone(state), target = next.recordings.find(item => item.bookingId === booking.id);
        const expectedRevision = (target.draft?.revision ?? 0) + 1;
        if (normalized.revision !== expectedRevision) throw new LiveAudioError('This edit was superseded; reload the latest version');
        target.draft = normalized;
        target.releaseChoice ||= 'deferred';
        await save(next);
      }, { captureFailure: false, bookingId: booking.id });
      return editState(booking);
    },
    approveEdit,
    async consent(booking, input, wallet, origin) {
      if (!available) throw new LiveAudioError('Live recording is not configured');
      if (deploymentPaused()) throw new LiveAudioError('Recording controls paused for a verified deployment handoff');
      await initialize();
      if (wallet.toLowerCase() !== booking.wallet.toLowerCase() || typeof input.enabled !== 'boolean' ||
          now() >= liveBroadcastEnd(booking) || Math.abs(now() - input.issuedAt) > 300000 ||
          input.issuedAt > now() + 30000 || input.issuedAt <= (record(booking.id)?.consent.issuedAt || 0)) throw new LiveAudioError('Recording permission expired or does not match the performer');
      const version = input.consentVersion === undefined ? LIVE_RECORDING_CONSENT_VERSION : input.consentVersion;
      const message = liveRecordingConsentMessage({ bookingId: booking.id, wallet, origin, issuedAt: input.issuedAt, enabled: input.enabled, version });
      if (verifyMessage(message, input.signature).toLowerCase() !== booking.wallet.toLowerCase()) throw new LiveAudioError('Recording signature does not match the performer');
      // Stop accepting frames immediately while revocation is being persisted.
      if (!input.enabled) { activeId = null; chunks = []; bytes = 0; }
      await serial(async () => {
        if (deploymentPaused()) throw new LiveAudioError('Recording controls paused for a verified deployment handoff');
        if (input.issuedAt <= (record(booking.id)?.consent.issuedAt || 0)) throw new LiveAudioError('Recording permission has already been superseded');
        const next = structuredClone(state);
        let r = next.recordings.find(r => r.bookingId === booking.id);
        if (['processing', 'submitted'].includes(r?.status)) throw new LiveAudioError('Recording publication has already started');
        if (!r) {
          r = { bookingId: booking.id, wallet: booking.wallet.toLowerCase(), segments: [], status: 'waiting' };
          next.recordings.push(r);
        }
        r.consent = { enabled: input.enabled, issuedAt: input.issuedAt, signature: input.signature, origin, version };
        r.status = input.enabled ? 'waiting' : 'revoked'; await save(next);
        captureErrors.delete(booking.id);
      }, { bookingId: booking.id });
    },
    capture(booking, frame) {
      const r = record(booking.id), at = now();
      if (!available || !r?.consent.enabled || !['waiting', 'recording'].includes(r.status) ||
          booking.broadcast && !booking.broadcast.actualStartedAt ||
          at < liveBroadcastStart(booking) || at >= liveBroadcastEnd(booking) || captureErrors.has(booking.id)) return;
      if (r.consent.version !== LIVE_RECORDING_ALLOCATED_CONSENT_VERSION &&
          (at < Date.parse(booking.startUtc) || at >= Date.parse(booking.endUtc))) return;
      if (deploymentPaused()) {
        captureErrors.set(booking.id, 'Unexpected live capture during recording deployment handoff');
        log.error('[live-recording]', captureErrors.get(booking.id));
        return;
      }
      if (frame.sampleRate !== RATE || frame.channels !== 1 || !(frame.data instanceof Int16Array)) {
        captureErrors.set(booking.id, 'Unexpected recording audio format'); log.error('[live-recording]', captureErrors.get(booking.id)); return;
      }
      if (buffered >= 4) { captureErrors.set(booking.id, 'Recording upload backlog exceeded; capture stopped'); log.error('[live-recording]', captureErrors.get(booking.id)); return; }
      if (activeId && activeId !== booking.id) { captureErrors.set(booking.id, 'Another live recording is active'); log.error('[live-recording]', captureErrors.get(booking.id)); return; }
      activeId = booking.id;
      if (lastFrameAt && at - lastFrameAt > 2000) {
        r.interrupted = true;
        interruptedCaptures.add(booking.id);
      }
      lastFrameAt = at;
      if (!bytes) segmentFirstFrameAt = at;
      // Include the final frame's samples, not the producer's later room-close time.
      segmentLastFrameAt = at + Math.ceil(frame.data.length / RATE * 1000);
      const data = Buffer.from(new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength));
      chunks.push(data); bytes += data.length;
      if (bytes >= BYTES_PER_SECOND * segmentSeconds) flush();
    },
    async tick(bookings) {
      if (!available || working || deploymentPaused()) return;
      working = true;
      try {
        await initialize();
        for (const booking of bookings) {
          let r = record(booking.id);
          if (!r || !r.consent.enabled || ['ready', 'submitted', 'empty'].includes(r.status)) continue;
          if (now() < liveBroadcastEnd(booking) && !booking.cancelled) continue;
          if (r.status === 'processing' && now() < resumeAt) continue;
          stopCapture(booking);
          await tail;
          r = record(booking.id);
          if (!r.segments.length) {
            const next = structuredClone(state); next.recordings.find(r => r.bookingId === booking.id).status = 'empty';
            await serial(() => save(next)); continue;
          }
          try {
            await serial(async () => {
              const next = structuredClone(state), target = next.recordings.find(r => r.bookingId === booking.id);
              target.status = 'processing'; target.error = captureErrors.get(booking.id) || finalizationErrors.get(booking.id) || target.error || ''; await save(next);
            }, { captureFailure: false, bookingId: booking.id });
            r = record(booking.id);
            let result = r.result;
            if (!result) {
              const audio = await boundedFinalization(booking.id, 'encode', () => encode(r.segments, download));
              const uri = await boundedFinalization(booking.id, 'upload', () => upload(audio, 'live-performance.mp3', 'audio/mpeg'));
              const durationSamples = r.segments.reduce((n, s) => n + s.bytes / 2, 0);
              result = { cid: uri.replace(/^ipfs:\/\//, ''), durationSamples, sampleRate: RATE,
                durationSeconds: durationSamples / RATE };
              if (!safeCid(result.cid)) throw Error('Invalid finalized recording CID');
              await serial(async () => {
                const next = structuredClone(state); next.recordings.find(r => r.bookingId === booking.id).result = result; await save(next);
              }, { captureFailure: false, bookingId: booking.id });
              finalizationTasks.delete(`${booking.id}:encode`);
              finalizationTasks.delete(`${booking.id}:upload`);
            }
            const timedSegments = r.segments.every(s => s.firstFrameAt !== undefined && s.lastFrameAt !== undefined);
            const expectedSeconds = timedSegments
              ? (Math.max(...r.segments.map(s => s.lastFrameAt)) - Math.min(...r.segments.map(s => s.firstFrameAt))) / 1000
              : (liveBroadcastEnd(booking) - liveBroadcastStart(booking)) / 1000;
            const incomplete = !!(r.interrupted || captureErrors.has(booking.id) ||
              booking.broadcast && booking.broadcast.endReason !== 'producer-finished' ||
              result.durationSeconds < expectedSeconds - 5);
            await serial(async () => {
              const next = structuredClone(state), target = next.recordings.find(r => r.bookingId === booking.id);
              target.status = 'ready'; target.incomplete = incomplete; target.error = ''; await save(next);
            }, { captureFailure: false, bookingId: booking.id });
            finalizationErrors.delete(booking.id);
          } catch (error) {
            finalizationErrors.set(booking.id, error.message);
            log.error('[live-recording] Finalization deferred:', error.message);
          }
        }
      } catch (error) {
        log.error('[live-recording] Finalization deferred:', error.message);
      } finally { working = false; }
    },
    deploymentState() { return { ready: (!available || !!state) && !working && !buffered && !bytes &&
      !editTasks.size && !catalogEditTasks.size &&
      !catalogApprovalTasks.size &&
      !(state?.recordings.some(r => r.consent?.enabled && ['recording', 'processing'].includes(r.status))) }; },
    async flush() { flush(); await tail; },
  };
}
