import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { broadcastProgram, createBroadcastUploader, createPublicBroadcast } from './public-broadcast.js';

const monotonicNow = () => Number(process.hrtime.bigint()) / 1e6;
const MAX_PENDING_FRAMES = 50;

export function createPublicBroadcastWorker({ enabled = false, edgeUrl, token,
  ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg', log = console, WorkerImpl = Worker, restartDelayMs = 5000 } = {}) {
  if (enabled) createBroadcastUploader({ baseUrl: edgeUrl, token });
  const pendingFrames = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  let thread, starting, resolveStart, stopping = false, restartTimer, failureTimer, failure = null, failureDetails;
  let reader, policy, protectedUntil = 0;
  let latest = enabled ? { enabled: true, transport: 'hls', status: 'buffering', reason: null } : { enabled: false };
  const fail = (code, details) => {
    if (failure || stopping) return;
    failure = code;
    failureDetails = details;
    log.error('[public-broadcast]', code, ...(details ? [details] : []));
    const active = thread;
    if (active) {
      active.postMessage({ type: 'stop' });
      failureTimer = setTimeout(() => {
        if (thread === active) {
          log.error('[public-broadcast] WORKER_STOP_TIMEOUT');
          void active.terminate().catch(() => log.error('[public-broadcast] WORKER_TERMINATE_FAILED'));
        }
      }, 15000);
      failureTimer.unref();
    }
  };
  function scheduleRestart() {
    if (stopping || restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!stopping) launch();
    }, restartDelayMs);
    restartTimer.unref();
  }
  function launch() {
    Atomics.store(pendingFrames, 0, 0);
    let active;
    try {
      active = new WorkerImpl(new URL(import.meta.url), { workerData: { edgeUrl, token, ffmpeg, pendingFrames } });
    } catch {
      failure = null;
      fail('ENCODER_WORKER_START_FAILED');
      resolveStart?.();
      scheduleRestart();
      return;
    }
    if (failure) log.info?.('[public-broadcast] Restarting encoder');
    failure = null; failureDetails = null;
    latest = { enabled: true, transport: 'hls', status: 'buffering', reason: null };
    thread = active;
    active.on('message', message => {
      if (thread !== active || stopping || failure) return;
      latest = message.snapshot;
      if (latest.status === 'unavailable') {
        fail(latest.reason || 'ENCODER_WORKER_FAILED', latest.reasonDetails);
        resolveStart?.();
        return;
      }
      if (message.type === 'ready') resolveStart?.();
      if (message.type === 'state') {
        const reply = result => {
          if (thread === active && !stopping && !failure) active.postMessage({ type: 'state', id: message.id, ...result });
        };
        Promise.resolve().then(() => reader()).then(state => reply({ state })).catch(() => {
          log.error('[public-broadcast] STATE_READ_FAILED');
          reply({ failed: true });
        });
      }
    });
    active.on('error', () => { fail('ENCODER_WORKER_FAILED'); resolveStart?.(); });
    active.on('exit', () => {
      clearTimeout(failureTimer);
      thread = null;
      if (!stopping) {
        if (!failure) fail('ENCODER_WORKER_EXITED');
        scheduleRestart();
      }
      resolveStart?.();
    });
    if (policy) active.postMessage({ type: 'policy', policy });
    if (reader) active.postMessage({ type: 'reader' });
  }
  const sendAudio = message => {
    if (!thread || stopping || failure || latest.status === 'unavailable') return false;
    const pending = Atomics.load(pendingFrames, 0);
    if (pending >= MAX_PENDING_FRAMES) { fail('PCM_BUFFER_LIMIT', { stage: 'ipc', pendingFrames: pending }); return false; }
    Atomics.add(pendingFrames, 0, 1);
    thread.postMessage({ ...message, receivedAt: monotonicNow() });
    return true;
  };
  return {
    enabled,
    start() {
      if (!enabled || stopping) return Promise.resolve();
      return starting ||= new Promise(resolve => {
        resolveStart = resolve;
        launch();
      });
    },
    setPolicy(next) { policy = next; thread?.postMessage({ type: 'policy', policy }); },
    setStateReader(next) { reader = next; thread?.postMessage({ type: 'reader' }); },
    radioPacket(packet, track) {
      if (!enabled || policy?.mode === 'live') return;
      if (sendAudio({ type: 'radio', packet,
        track: { ...broadcastProgram(track, Date.now()), protected: !!track.protected } }) && track.protected) {
        protectedUntil = Date.now() + 40000;
      }
    },
    liveFrame(booking, frame) {
      if (!enabled || policy?.mode !== 'live' || policy.bookingId !== booking.id || booking.rehearsal === true) return;
      if (sendAudio({ type: 'live', booking: { id: booking.id, title: booking.title,
        displayName: booking.displayName, wallet: booking.wallet }, frame })) protectedUntil = Date.now() + 40000;
    },
    snapshot() {
      return failure ? { ...latest, enabled: true, transport: 'hls', status: 'unavailable', reason: failure,
        ...(failureDetails ? { reasonDetails: failureDetails } : {}) } : latest;
    },
    pendingDrain: () => enabled && Date.now() < protectedUntil,
    async stop() {
      if (stopping) return;
      stopping = true;
      clearTimeout(restartTimer);
      clearTimeout(failureTimer);
      resolveStart?.();
      const active = thread;
      if (!active) return;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          log.error('[public-broadcast] WORKER_STOP_TIMEOUT');
          void active.terminate().then(resolve, reject);
        }, 15000);
        active.once('exit', () => { clearTimeout(timer); resolve(); });
        active.postMessage({ type: 'stop' });
      });
    },
  };
}

if (!isMainThread) {
  const broadcaster = createPublicBroadcast({ enabled: true, monotonicNow,
    uploader: createBroadcastUploader({ baseUrl: workerData.edgeUrl, token: workerData.token }), ffmpeg: workerData.ffmpeg });
  const stateRequests = new Map();
  let nextRequest = 0, stopped = false;
  const snapshots = setInterval(() => parentPort.postMessage({ type: 'snapshot', snapshot: broadcaster.snapshot() }), 500);
  snapshots.unref();
  await broadcaster.start();
  parentPort.on('message', message => {
    if (stopped) return;
    if (message.type === 'radio' || message.type === 'live') {
      if (message.type === 'radio') broadcaster.radioPacket(Buffer.from(message.packet), message.track, message.receivedAt);
      else broadcaster.liveFrame(message.booking, message.frame, message.receivedAt);
      Atomics.sub(workerData.pendingFrames, 0, 1);
    } else if (message.type === 'policy') broadcaster.setPolicy(message.policy);
    else if (message.type === 'reader') broadcaster.setStateReader(() => new Promise((resolve, reject) => {
      const id = ++nextRequest;
      stateRequests.set(id, { resolve, reject });
      parentPort.postMessage({ type: 'state', id, snapshot: broadcaster.snapshot() });
    }));
    else if (message.type === 'state') {
      const pending = stateRequests.get(message.id);
      if (pending) {
        stateRequests.delete(message.id);
        if (message.failed) pending.reject(new Error('Public radio state unavailable'));
        else pending.resolve(message.state);
      }
    } else if (message.type === 'stop') {
      stopped = true;
      clearInterval(snapshots);
      for (const pending of stateRequests.values()) pending.reject(new Error('Broadcast stopped'));
      stateRequests.clear();
      void broadcaster.stop().then(() => parentPort.close()).catch(() => {
        console.error('[public-broadcast] WORKER_STOP_FAILED');
        parentPort.close();
        process.exitCode = 1;
      });
    }
  });
  parentPort.postMessage({ type: 'ready', snapshot: broadcaster.snapshot() });
}
