import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as wait } from 'node:timers/promises';
import OpusScript from 'opusscript';

const FRAME_BYTES = 48000 * 2 * 2 / 50;
const PCM_BYTES_PER_MS = 48000 * 2 * 2 / 1000;
const PCM_MAX_MS = 60_000;
export const BROADCAST_RETENTION_MS = 120000;

export function createBroadcastStateReader(read, { now = Date.now, ttlMs = 1000 } = {}) {
  let value, checkedAt = -Infinity, pending;
  return async () => {
    if (value && now() - checkedAt < ttlMs) return value;
    pending ||= Promise.resolve().then(read).then(next => {
      value = next; checkedAt = now(); return next;
    }).finally(() => { pending = null; });
    return pending;
  };
}

export function parseBroadcastPlaylist(text) {
  if (!text.startsWith('#EXTM3U\n') || text.length > 32768 || !text.includes('#EXT-X-PROGRAM-DATE-TIME:')) {
    throw new Error('Invalid timestamped broadcast playlist');
  }
  const segments = text.split('\n').filter(line => line && !line.startsWith('#'));
  if (!segments.length || segments.length > 8 || segments.some(name => !/^segment-\d{9}\.ts$/.test(name))) {
    throw new Error('Invalid broadcast segment list');
  }
  return segments;
}

export function stereoPcm(frame) {
  if (frame.sampleRate !== 48000 || ![1, 2].includes(frame.channels) ||
      !(frame.data instanceof Int16Array) || frame.data.length !== frame.samplesPerChannel * frame.channels) {
    throw new Error('Unsupported delivered broadcast PCM');
  }
  const result = Buffer.alloc(frame.samplesPerChannel * 4);
  for (let i = 0; i < frame.samplesPerChannel; i++) {
    result.writeInt16LE(frame.data[i * frame.channels], i * 4);
    result.writeInt16LE(frame.data[i * frame.channels + (frame.channels === 2 ? 1 : 0)], i * 4 + 2);
  }
  return result;
}

export function broadcastProgram(track, at) {
  return {
    at,
    playId: String(track.playId || '').slice(0, 180),
    title: String(track.title || 'Community radio').slice(0, 200),
    artist: String(track.uploader || track.artist || '').slice(0, 100),
    live: track.live === true,
    ...(track.trackId ? { trackId: String(track.trackId).slice(0, 180) } : {}),
    ...(track.ipfsCid ? { ipfsCid: String(track.ipfsCid).slice(0, 120) } : {}),
    ...(track.mediaType === 'video/mp4' && !track.live && /^[a-z0-9]{20,120}$/i.test(track.ipfsCid || '')
      ? { mediaType: 'video/mp4' } : {}),
    isDevert: track.isDevert === true,
    ...(track.performer ? { performer: { wallet: track.performer.wallet,
      artist: String(track.performer.artist || '').slice(0, 100),
      title: String(track.performer.title || '').slice(0, 200) } } : {}),
    ...(track.bookingId ? { bookingId: String(track.bookingId).slice(0, 180) } : {}),
  };
}

export function dropBroadcastBoundaryTail(queue, previousRadioPlayId, nextProgram) {
  // A producer handoff does not mean the encoder has drained the previous song.
  if (nextProgram?.live || !String(previousRadioPlayId || '').startsWith('gap:') ||
      !nextProgram?.playId || nextProgram.playId === previousRadioPlayId) return 0;
  let droppedBytes = 0;
  for (let index = 0; index < queue.length;) {
    if (queue[index].program?.playId === previousRadioPlayId &&
        !queue[index].program.live && !queue[index].program.protected) {
      droppedBytes += queue[index].bytes?.length || 0;
      queue.splice(index, 1);
    } else {
      index++;
    }
  }
  return droppedBytes;
}

const isTransientEdgeError = error => error instanceof TypeError ||
  ['AbortError', 'TimeoutError'].includes(error?.name) || [408, 500, 502, 503, 504].includes(error?.status);

export function createBroadcastUploader({ baseUrl, token, fetchImpl = fetch, now = Date.now, log = console }) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash ||
      base.pathname !== '/' || !/^[a-zA-Z0-9_-]{32,200}$/.test(token || '')) {
    throw new Error('Broadcast requires an HTTPS edge origin and a private upload token');
  }
  return {
    baseUrl: base.origin,
    async put(key, bytes, type) {
      if (!/^[a-f0-9]{32}\/(?:index\.m3u8|state\.json|segment-\d{9}\.ts)$/.test(key)) throw new Error('Invalid broadcast object');
      const deadline = AbortSignal.timeout(8000);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetchImpl(`${base.origin}/hls/${key}`, {
            method: 'PUT', redirect: 'error',
            signal: deadline, body: bytes,
            headers: { authorization: `Bearer ${token}`, 'content-type': type,
              'x-broadcast-expires-at': String(now() + BROADCAST_RETENTION_MS) },
          });
          const rejection = response.ok ? null : Object.assign(
            new Error(`Broadcast edge upload failed (${response.status})`), { status: response.status });
          try { await response.body?.cancel(); } catch (error) { throw rejection || error; }
          if (rejection) throw rejection;
          return;
        } catch (error) {
          if (!isTransientEdgeError(error) || attempt === 2 || deadline.aborted) throw error;
          log.warn('[public-broadcast] EDGE_UPLOAD_RETRY', { attempt: attempt + 1,
            ...([408, 500, 502, 503, 504].includes(error?.status) ? { httpStatus: error.status } : {}) });
          await wait(250 * (attempt + 1), undefined, { signal: deadline });
        }
      }
    },
  };
}

export function createPublicBroadcast({ enabled = false, uploader, ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg',
  now = Date.now, monotonicNow = () => performance.now(), spawnImpl = spawn, log = console } = {}) {
  if (enabled && !uploader) throw new Error('Public HLS enabled without a configured edge publisher');
  let directory, encoder, decoder, timer, publishTimer, failure = null, stopping = false;
  let startedAt = 0, startedTick = 0, emitted = 0, queuedBytes = 0, publishedAt = 0, publishing = false, encoderClosed = false;
  let protectedUntil = 0;
  let failureDetails;
  let publicationStage = 'idle';
  let timelineOffsetMs = null;
  let firstInputAt = null;
  let readPublicState, statePublishedAt = 0, stateAttemptedAt = 0, lastInputAt = 0;
  let stateTask = null, stateIssue = null, stateIssueLoggedAt = -Infinity;
  let publishIssue = null, publishIssueLoggedAt = -Infinity;
  let lateAudio = null, lateAudioLoggedAt = -Infinity;
  let queuedRadioProgramId = null;
  let policy = null, previousPlaylist = '', inputBytes = 0, uploadBytes = 0;
  const runId = randomBytes(16).toString('hex'), queue = [], history = [], uploaded = new Set();
  const safeDetails = (stage, error) => ({ stage,
    ...(Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? { httpStatus: error.status } : {}),
    ...(['AbortError', 'TimeoutError'].includes(error?.name) ? { errorName: error.name } : {}) });
  const fail = (code, details) => {
    if (failure || stopping) return;
    failure = code;
    failureDetails = details;
    log.error('[public-broadcast]', code, ...(details ? [details] : []));
    clearInterval(timer); clearInterval(publishTimer);
    encoder?.kill();
    queue.length = 0; queuedBytes = 0;
  };
  function catchUpAtBoundary(nextProgram) {
    if (nextProgram?.live || queuedRadioProgramId == null) return;
    const droppedBytes = dropBroadcastBoundaryTail(queue, queuedRadioProgramId, nextProgram);
    queuedBytes = queue.reduce((sum, entry) => sum + entry.bytes.length, 0);
    if (!droppedBytes) return;
    const droppedMs = Math.round(droppedBytes / PCM_BYTES_PER_MS);
    lateAudio = { skips: (lateAudio?.skips || 0) + 1,
      droppedMs: (lateAudio?.droppedMs || 0) + droppedMs,
      lastStage: 'inter-song-gap', lastAt: now() };
    if (now() - lateAudioLoggedAt >= 10000) {
      lateAudioLoggedAt = now();
      log.warn?.('[public-broadcast] PCM_GAP_CATCHUP', {
        stage: 'inter-song-gap', droppedMs, skips: lateAudio.skips,
      });
    }
  }
  function push(bytes, program, receivedAt = monotonicNow()) {
    if (!enabled || !encoder || failure || stopping) return;
    if (bytes.length % 4 || bytes.length > PCM_BYTES_PER_MS * PCM_MAX_MS) {
      fail('PCM_BUFFER_LIMIT', { stage: 'pcm', queuedBytes, incomingBytes: bytes.length }); return;
    }
    if (!program.live) catchUpAtBoundary(program);
    queue.push({ bytes, program, receivedAt }); queuedBytes += bytes.length;
    if (!program.live) queuedRadioProgramId = program.playId;
    if (queuedBytes > PCM_BYTES_PER_MS * PCM_MAX_MS) {
      fail('PCM_BUFFER_LIMIT', { stage: 'pcm-buffer', queuedBytes, incomingBytes: bytes.length }); return;
    }
    if (firstInputAt === null) {
      firstInputAt = startedAt = now();
      startedTick = monotonicNow();
    }
    lastInputAt = now();
  }
  function emitFrame() {
    const output = Buffer.alloc(FRAME_BYTES);
    let offset = 0;
    const priming = !history.length && firstInputAt !== null && now() - firstInputAt < 80;
    while (!priming && queue.length && offset < FRAME_BYTES) {
      const entry = queue[0], count = Math.min(entry.bytes.length, FRAME_BYTES - offset);
      if (!history.length || history.at(-1).playId !== entry.program.playId) {
        history.push(broadcastProgram(entry.program, startedAt + (timelineOffsetMs || 0) + emitted * 20 + offset / 192));
        if (history.length > 64) history.shift();
      }
      entry.bytes.copy(output, offset, 0, count);
      entry.bytes = entry.bytes.subarray(count); queuedBytes -= count; offset += count;
      if (!entry.bytes.length) queue.shift();
    }
    if (!queue.length && lastInputAt && now() - lastInputAt > 1000 && !history.at(-1)?.playId.startsWith('gap:')) {
      history.push(broadcastProgram({ playId: `gap:${emitted}`, title: 'Waiting for public radio audio' },
        startedAt + (timelineOffsetMs || 0) + emitted * 20));
      if (history.length > 64) history.shift();
    }
    if (encoder.stdin.writableLength > FRAME_BYTES * 50) { fail('ENCODER_BACKPRESSURE'); return; }
    encoder.stdin.write(output);
    inputBytes += output.length; emitted++;
  }
  // Programme metadata is best-effort: a slow or failed state read must never silence or delay the audio.
  async function publishState() {
    let deadline, stage = 'state-read';
    try {
      const state = await Promise.race([Promise.resolve().then(readPublicState), new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Public radio state deadline exceeded')), 8000);
      })]).finally(() => clearTimeout(deadline));
      stage = 'state-size';
      const bytes = Buffer.from(JSON.stringify(state));
      if (bytes.length > 65536) throw new Error('Public radio state exceeds broadcast size limit');
      stage = 'state-upload';
      await uploader.put(`${runId}/state.json`, bytes, 'application/json');
      statePublishedAt = now(); uploadBytes += bytes.length;
      if (stateIssue) log.warn?.('[public-broadcast] STATE_PUBLISH_RECOVERED');
      stateIssue = null;
    } catch (error) {
      stateIssue = safeDetails(stage, error);
      if (now() - stateIssueLoggedAt >= 60000) {
        stateIssueLoggedAt = now();
        log.warn?.('[public-broadcast] STATE_PUBLISH_DEFERRED', stateIssue);
      }
    }
  }
  function scheduleState() {
    if (!readPublicState || stateTask || failure || stopping || now() - stateAttemptedAt < 2000) return;
    stateAttemptedAt = now();
    stateTask = publishState().finally(() => { stateTask = null; });
  }
  async function publish() {
    if (publishing || failure || stopping) return;
    publishing = true;
    try {
      let text;
      publicationStage = 'playlist-read';
      try { text = await readFile(join(directory, 'index.m3u8'), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (text === previousPlaylist) { scheduleState(); return; }
      const names = parseBroadcastPlaylist(text);
      if (timelineOffsetMs === null) {
        if (names[0] !== 'segment-000000000.ts') throw new Error('Initial broadcast clock was not observed');
        const firstAt = Date.parse(text.match(/#EXT-X-PROGRAM-DATE-TIME:(.+)/)[1]);
        if (!Number.isFinite(firstAt)) throw new Error('Invalid encoder programme clock');
        timelineOffsetMs = firstAt - startedAt;
        for (const program of history) program.at += timelineOffsetMs;
      }
      // Local staging stays bounded even while the edge is unreachable; the edge enforces expiry after a crash.
      publicationStage = 'cleanup';
      const first = Number(names[0].match(/\d+/)[0]);
      for (const name of await readdir(directory)) {
        if (/^segment-\d{9}\.ts$/.test(name) && Number(name.match(/\d+/)[0]) < first - 8) {
          await rm(join(directory, name)); uploaded.delete(name);
        }
      }
      for (const name of names) {
        if (uploaded.has(name)) continue;
        publicationStage = 'segment-read';
        const bytes = await readFile(join(directory, name));
        if (bytes.length > 256000) throw new Error('Broadcast segment exceeds encoded size limit');
        publicationStage = 'segment-upload';
        await uploader.put(`${runId}/${name}`, bytes, 'video/mp2t');
        uploadBytes += bytes.length; uploaded.add(name);
      }
      publicationStage = 'playlist-upload';
      await uploader.put(`${runId}/index.m3u8`, Buffer.from(text), 'application/vnd.apple.mpegurl');
      uploadBytes += Buffer.byteLength(text);
      previousPlaylist = text; publishedAt = now();
      if (publishIssue) log.warn?.('[public-broadcast] EDGE_PUBLISH_RECOVERED');
      publishIssue = null;
      scheduleState();
    } catch (error) {
      // A slow or briefly unavailable edge only delays publication; the next tick retries and status shows buffering.
      if (['segment-upload', 'playlist-upload'].includes(publicationStage) && isTransientEdgeError(error)) {
        publishIssue = safeDetails(publicationStage, error);
        if (now() - publishIssueLoggedAt >= 60000) {
          publishIssueLoggedAt = now();
          log.warn?.('[public-broadcast] EDGE_PUBLISH_DEFERRED', publishIssue);
        }
      } else fail('EDGE_PUBLISH_FAILED', safeDetails(publicationStage, error));
    }
    finally { publishing = false; }
  }
  return {
    enabled,
    async start() {
      if (!enabled || encoder) return;
      directory = await mkdtemp(join(tmpdir(), 'dbusk-hls-'));
      encoder = spawnImpl(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin',
        '-f', 's16le', '-ar', '48000', '-ac', '2', '-probesize', '32', '-analyzeduration', '0', '-i', 'pipe:0',
        '-vn', '-c:a', 'aac', '-b:a', '128k', '-f', 'hls', '-hls_time', '4',
        '-hls_list_size', '8', '-hls_flags', 'independent_segments+program_date_time+temp_file',
        '-hls_segment_filename', join(directory, 'segment-%09d.ts'), join(directory, 'index.m3u8')],
      { stdio: ['pipe', 'ignore', 'ignore'] });
      encoder.on('error', () => fail('ENCODER_START_FAILED'));
      encoder.on('exit', () => { if (!stopping) fail('ENCODER_EXITED'); });
      encoder.on('close', () => { encoderClosed = true; });
      encoder.stdin.on('error', () => fail('ENCODER_INPUT_FAILED'));
      timer = setInterval(() => {
        if (firstInputAt === null) return;
        const due = Math.floor((monotonicNow() - startedTick) / 20) - emitted;
        if (due > 25) { fail('ENCODER_CLOCK_STALLED', { stage: 'encoder-clock', behindFrames: due, queuedBytes }); return; }
        for (let i = 0; i < due && !failure; i++) emitFrame();
      }, 20);
      publishTimer = setInterval(() => { void publish(); }, 500);
      timer.unref?.(); publishTimer.unref?.();
    },
    setPolicy(next) { policy = next; },
    setStateReader(reader) { readPublicState = reader; },
    radioPacket(packet, track, receivedAt) {
      if (!enabled || failure || stopping || policy?.mode === 'live') return;
      try {
        decoder ||= new OpusScript(48000, 2, OpusScript.Application.AUDIO);
        push(Buffer.from(decoder.decode(packet)), track, receivedAt);
        if (track.protected) protectedUntil = now() + 40000;
      } catch { fail('RADIO_DECODE_FAILED'); }
    },
    liveFrame(booking, frame, receivedAt) {
      if (!enabled || policy?.mode !== 'live' || policy.bookingId !== booking.id ||
          booking.rehearsal === true || failure || stopping) return;
      try {
        push(stereoPcm(frame), { playId: `live:${booking.id}`, bookingId: booking.id,
          title: booking.title, artist: booking.displayName || booking.title || 'Live performer', live: true,
          performer: { wallet: booking.wallet, artist: booking.displayName || booking.title || 'Live performer',
            title: booking.title || 'Live performance' } }, receivedAt);
        protectedUntil = now() + 40000;
      }
      catch { fail('LIVE_PCM_INVALID'); }
    },
    snapshot() {
      if (!enabled) return { enabled: false };
      const cutoff = history.findLastIndex(entry => entry.at <= now() - BROADCAST_RETENTION_MS);
      return { enabled: true, transport: 'hls', status: failure ? 'unavailable'
        : history.length && publishedAt && now() - publishedAt < 12000 && (!readPublicState || statePublishedAt && now() - statePublishedAt < 12000) &&
          now() - startedAt >= 20000 ? 'ready' : 'buffering',
      reason: failure, ...(failureDetails ? { reasonDetails: failureDetails } : {}), ...(stateIssue ? { stateIssue } : {}),
      ...(publishIssue ? { publishIssue } : {}),
      ...(lateAudio ? { lateAudio: { ...lateAudio } } : {}),
      url: `${uploader.baseUrl}/hls/${runId}/index.m3u8`,
      ...(readPublicState ? { stateUrl: `${uploader.baseUrl}/hls/${runId}/state.json` } : {}),
      delaySeconds: { min: 10, max: 20 }, publishedAt,
      programHistory: history.slice(Math.max(0, cutoff)),
      inputBytes, uploadBytes, timelineOffsetMs };
    },
    pendingDrain: () => enabled && now() < protectedUntil,
    async stop() {
      stopping = true; clearInterval(timer); clearInterval(publishTimer);
      encoder?.stdin.end();
      if (encoder && !encoderClosed) {
        await new Promise(resolve => {
          const killTimer = setTimeout(() => encoder.kill(), 1000);
          encoder.once('close', () => { clearTimeout(killTimer); resolve(); });
        });
      }
      while (publishing || stateTask) await new Promise(resolve => setTimeout(resolve, 20));
      decoder?.delete();
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  };
}
