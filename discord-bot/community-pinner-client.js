import { pathToFileURL } from 'node:url';
import { pinCommunityManifest } from '../js/pinner-rewards.mjs';

export function createCommunityPinnerClient({ serviceUrl = 'https://decentbusking.onrender.com',
  ipfsApiUrl = 'http://127.0.0.1:5001', fetchImpl = fetch, onProgress = () => {} } = {}) {
  const service = new URL(serviceUrl);
  if (service.protocol !== 'https:' || service.username || service.password) throw new Error('Community manifest service must use HTTPS');
  return async () => {
    const response = await fetchImpl(`${service.toString().replace(/\/$/, '')}/api/pinners/manifest`, {
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Community manifest unavailable (${response.status})`);
    const manifest = await response.json();
    return pinCommunityManifest({ manifest, provider: 'local', ipfsApiUrl, fetchImpl, onProgress });
  };
}

async function main() {
  const poll = createCommunityPinnerClient({ serviceUrl: process.env.DBUSK_SERVICE_URL || undefined,
    ipfsApiUrl: process.env.IPFS_API_URL || undefined });
  do {
    try {
      const result = await poll();
      console.info(`[community-pinner] Verified ${result.successes.length} pins; ${result.failures.length} failed. This is synchronization, not a reward receipt.`);
      if (result.failures.length) {
        console.error(`[community-pinner] ${result.failures[0].error}. Check node storage and connectivity; no pins are removed.`);
        if (!process.argv.includes('--watch')) process.exitCode = 1;
      }
    } catch (error) {
      console.error(`[community-pinner] ${error.message}`);
      if (!process.argv.includes('--watch')) process.exitCode = 1;
    }
    if (!process.argv.includes('--watch')) return;
    await new Promise(resolve => setTimeout(resolve, 15 * 60000));
  } while (true);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`[community-pinner] ${error.message}`); process.exitCode = 1; });
}
