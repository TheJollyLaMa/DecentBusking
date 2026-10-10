import { randomUUID, timingSafeEqual } from 'node:crypto';
import { importer } from 'ipfs-unixfs-importer';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';
import { CID } from 'multiformats/cid';

export async function checkpointContentCid(bytes) {
  let cid;
  for await (const result of importer([{ content: bytes }], { put: async () => {} }, {
    cidVersion: 1, rawLeaves: true, chunker: fixedSize({ chunkSize: 262144 }),
  })) cid = result.cid.toV1().toString();
  return cid;
}

export function createCheckpointMirror({ secret, timeoutMs = 120000, maxBytes = 2 * 1024 * 1024,
  now = () => Date.now() }) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw new Error('Checkpoint mirror needs a dedicated secret of at least 32 bytes');
  const jobs = new Map();
  const availabilityWaiters = new Set();
  let lastPoll = null;
  const authenticate = authorization => {
    const actual = Buffer.from(authorization || '');
    const expected = Buffer.from(`Bearer ${secret}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Checkpoint mirror authorization failed');
  };
  const available = () => lastPoll !== null && now() - lastPoll <= 30000;
  return {
    authorize: authenticate,
    requireAvailable() { if (!available()) throw new Error('Local checkpoint mirror is offline; no Pinata upload attempted'); },
    waitAvailable() {
      if (available()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const waiter = { resolve, timer: setTimeout(() => {
          availabilityWaiters.delete(waiter);
          reject(new Error('Local checkpoint client did not connect; no Pinata upload attempted'));
        }, 30000) };
        availabilityWaiters.add(waiter);
      });
    },
    status() { return { available: available(), pending: jobs.size }; },
    claim(authorization) {
      authenticate(authorization);
      lastPoll = now();
      for (const waiter of availabilityWaiters) { clearTimeout(waiter.timer); waiter.resolve(); }
      availabilityWaiters.clear();
      const job = jobs.values().next().value;
      return job ? { jobId: job.jobId, expectedCid: job.expectedCid, contentBase64: job.contentBase64 } : null;
    },
    acknowledge(authorization, { jobId, cid, recursivePinned }) {
      authenticate(authorization);
      const job = jobs.get(jobId);
      if (!job) throw new Error('Unknown or expired checkpoint mirror job');
      if (recursivePinned !== true || CID.parse(cid).toV1().toString() !== job.expectedCid) throw new Error('Local checkpoint CID or recursive pin mismatch');
      clearTimeout(job.timer);
      jobs.delete(jobId);
      job.resolve(job.expectedCid);
      return { ok: true };
    },
    async mirror(bytes) {
      this.requireAvailable();
      if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > maxBytes) throw new Error('Checkpoint exceeds mirror size limit');
      if (jobs.size >= 2) throw new Error('Checkpoint mirror queue is full');
      const expectedCid = await checkpointContentCid(bytes);
      const jobId = randomUUID();
      const snapshot = Buffer.from(bytes).toString('base64');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          jobs.delete(jobId);
          reject(new Error('Local checkpoint mirror timed out; no Pinata upload attempted'));
        }, timeoutMs);
        jobs.set(jobId, { jobId, expectedCid, contentBase64: snapshot, resolve, timer });
      });
    },
  };
}