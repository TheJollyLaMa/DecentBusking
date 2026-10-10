import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { CID } from 'multiformats/cid';
import { checkpointContentCid } from './checkpoint-mirror.js';
import { ensureLocalRecursivePin } from './ipfs.js';

export function createLocalCheckpointMirrorClient({ serviceUrl, secret, ipfsApiUrl = 'http://127.0.0.1:5001', fetchImpl = fetch }) {
  const remote = new URL(serviceUrl);
  const local = new URL(ipfsApiUrl);
  if (remote.protocol !== 'https:' && !(remote.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(remote.hostname))) {
    throw new Error('Mirror service must use HTTPS or loopback HTTP');
  }
  if (!['http:', 'https:'].includes(local.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(local.hostname)) {
    throw new Error('Local mirror must use loopback Kubo');
  }
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw new Error('Dedicated mirror secret is required');
  const base = serviceUrl.replace(/\/$/, '');
  const api = ipfsApiUrl.replace(/\/$/, '');
  const post = async (route, body) => {
    const response = await fetchImpl(`${base}/api/checkpoint-mirror/${route}`, { method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(body || {}), redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Checkpoint mirror service returned ${response.status}`);
    return response.json();
  };
  return async function poll() {
    const { job } = await post('claim');
    if (!job) return { idle: true };
    if (typeof job.jobId !== 'string' || typeof job.contentBase64 !== 'string' || job.contentBase64.length > 2800000) {
      throw new Error('Invalid checkpoint mirror job');
    }
    const bytes = Buffer.from(job.contentBase64, 'base64');
    if (bytes.length < 1 || bytes.length > 2 * 1024 * 1024) throw new Error('Checkpoint mirror payload exceeds limit');
    const expectedCid = CID.parse(job.expectedCid).toV1().toString();
    if (await checkpointContentCid(bytes) !== expectedCid) throw new Error('Checkpoint payload CID mismatch');
    const snapshot = JSON.parse(bytes.toString('utf8'));
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.playlist)) throw new Error('Only playlist checkpoints may be mirrored');
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/json' }), 'decentbusking-jukeloop-state.json');
    const response = await fetchImpl(`${api}/api/v0/add?cid-version=1&raw-leaves=true&chunker=size-262144&pin=false`,
      { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Local checkpoint import failed (${response.status})`);
    const result = JSON.parse((await response.text()).trim().split('\n').at(-1));
    if (CID.parse(result.Hash).toV1().toString() !== expectedCid) throw new Error('Kubo returned a different checkpoint CID');
    await ensureLocalRecursivePin({ cid: expectedCid, ipfsApiUrl, fetchImpl });
    await post('ack', { jobId: job.jobId, cid: expectedCid, recursivePinned: true });
    return { idle: false, cid: expectedCid, bytes: bytes.length };
  };
}

async function main() {
  const poll = createLocalCheckpointMirrorClient({ serviceUrl: process.env.PUBLIC_WORKER_URL,
    secret: process.env.CHECKPOINT_MIRROR_SECRET, ipfsApiUrl: process.env.IPFS_API_URL || 'http://127.0.0.1:5001' });
  if (!process.argv.includes('--watch')) { console.log(JSON.stringify(await poll())); return; }
  const run = async () => {
    try { const result = await poll(); if (!result.idle) console.log(`[checkpoint-mirror] Verified local pin ${result.cid}`); }
    catch (error) { console.error(`[checkpoint-mirror] ${error.message}`); }
    setTimeout(run, 5000);
  };
  await run();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}