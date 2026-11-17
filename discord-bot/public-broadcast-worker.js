import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { broadcastProgram, createBroadcastUploader, createPublicBroadcast } from './public-broadcast.js';

const monotonicNow = () => Number(process.hrtime.bigint()) / 1e6;
const MAX_PENDING_FRAMES = 50;

export function createPublicBroadcastWorker({ enabled = false, edgeUrl, token,
  ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg', log = console } = {}) {
  if (enabled) createBroadcastUploader({ baseUrl: edgeUrl, token });
  let thread, starting, resolveStart, stopping = false, exited = false, pendingFrames = 0, failure = null;
  let reader, policy, protectedUntil = 0;
  let latest = enabled ? { enabled: true, transport: 'hls', status: 'buffering', reason: null } : { enabled: false };
  const fail = code => {
    if (failure || stopping) return;
    failure = code;
    log.error('[public-broadcast]', code);
    thread?.postMessage({ type: 'stop' });
  };
  const sendAudio = message => {
    if (!thread || stopping || failure || latest.status === 'unavailable') return false;
    if (pendingFrames >= MAX_PENDING_FRAMES) { fail('PCM_BUFFER_LIMIT'); return false; }
    pendingFrames++;
    thread.postMessage({ ...message, receivedAt: monotonicNow() });
    return true;
  };
  return {
    enabled,
    start() {
      if (!enabled) return Promise.resolve();
      return starting ||= new Promise(resolve => {
        resolveStart = resolve;
        thread = new Worker(new URL(import.meta.url), { workerData: { edgeUrl, token, ffmpeg } });
        thread.on('message', message => {
          if (message.type === 'snapshot' || message.type === 'ready') {
            latest = message.snapshot;
            if (message.type === 'ready') resolve();
          } else if (message.type === 'ack') {
            pendingFrames--;
          } else if (message.type === 'state') {
            latest = message.snapshot;
            Promise.resolve().then(() => reader()).then(state => {
              if (!stopping) thread.postMessage({ type: 'state', id: message.id, state });
            }).catch(() => {
              log.error('[public-broadcast] STATE_READ_FAILED');
              if (!stopping) thread.postMessage({ type: 'state', id: message.id, failed: true });
            });
          }
        });
        thread.on('error', () => { fail('ENCODER_WORKER_FAILED'); resolve(); });
        thread.on('exit', () => { exited = true; if (!stopping && !failure) fail('ENCODER_WORKER_EXITED'); resolve(); });
        if (policy) thread.postMessage({ type: 'policy', policy });
        if (reader) thread.postMessage({ type: 'reader' });
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
      return failure ? { ...latest, enabled: true, transport: 'hls', status: 'unavailable', reason: failure } : latest;
    },
    pendingDrain: () => enabled && Date.now() < protectedUntil,
    async stop() {
      if (!thread || stopping || exited) return;
      stopping = true;
      const active = thread;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          log.error('[public-broadcast] WORKER_STOP_TIMEOUT');
          void active.terminate().then(resolve, reject);
        }, 15000);
        active.once('exit', () => { clearTimeout(timer); resolve(); });
        active.postMessage({ type: 'stop' });
      });
      resolveStart?.();
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
      parentPort.postMessage({ type: 'ack' });
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
