import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function waitForRadioDeployment({ serviceUrl, secret, id = randomUUID(), fetchImpl = fetch,
  now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = 25 * 60_000, log = console } = {}) {
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(serviceUrl || '') || !secret || secret.length < 32) {
    throw new Error('An existing HTTPS radio service and deployment authorization are required');
  }
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const response = await fetchImpl(`${serviceUrl}/api/radio/deployment`, {
      method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'drain', id }), signal: AbortSignal.timeout(60000), redirect: 'error' });
    if (!response.ok) throw new Error(`Radio handoff refused (${response.status}); deployment must not restart paid playback`);
    const status = await response.json();
    if (status.deploymentId !== id || !status.draining || !(status.expiresAt > now())) {
      throw new Error('Radio handoff lease is not verified; refusing deployment');
    }
    if (status.ready === true) {
      log.info('[radio-deploy] Paid playback drained; new purchases remain queued until the replacement worker starts.');
      return status;
    }
    log.info(`[radio-deploy] Waiting for protected paid playback${status.activePlaylistBatchId
      ? ` in playlist ${status.activePlaylistBatchId}` : ''}${status.liveRecordingPending
      ? ' and live performance recording' : ''}; no audio was stopped.`);
    await sleep(2000);
  }
  throw new Error('Radio handoff timed out; leave the current worker playing and retry deployment later');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await waitForRadioDeployment({ serviceUrl: process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_WORKER_URL,
      secret: process.env.CHECKPOINT_MIRROR_SECRET, id: process.env.RENDER_GIT_COMMIT || randomUUID() });
  } catch (error) {
    console.error(`[radio-deploy] ${error.message}`);
    process.exitCode = 1;
  }
}
