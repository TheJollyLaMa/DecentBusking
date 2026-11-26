import { pathToFileURL } from 'node:url';
import { pinCommunityManifest } from '../js/pinner-rewards.mjs';

export function pinnerSetupConfig(config) {
  const next = structuredClone(config);
  const addresses = Array.isArray(next.Addresses?.API) ? next.Addresses.API : [next.Addresses?.API];
  if (!addresses.length || addresses.some(address =>
    !/^\/(?:ip4\/127\.0\.0\.1|ip6\/::1)\/tcp\/\d+$/.test(address || ''))) {
    throw new Error('IPFS API must already listen on loopback only. Refusing to expose or rewrite its address.');
  }
  next.API ||= {};
  next.API.HTTPHeaders ||= {};
  for (const [key, additions] of [
    ['Access-Control-Allow-Origin', ['https://thejollylama.github.io']],
    ['Access-Control-Allow-Methods', ['PUT', 'POST', 'GET']],
  ]) {
    const existing = next.API.HTTPHeaders[key] || [];
    if (!Array.isArray(existing) || existing.some(value => typeof value !== 'string')) throw new Error(`Invalid IPFS ${key} configuration`);
    if (existing.includes('*')) throw new Error('Wildcard CORS is already configured. Review it manually before enabling rewards.');
    next.API.HTTPHeaders[key] = [...new Set([...existing, ...additions])];
  }
  next.Swarm ||= {};
  next.Swarm.DisableNatPortMap = false;
  return next;
}

export async function setupPinnerNode({ configPath } = {}) {
  const fs = await import('node:fs/promises');
  const { homedir } = await import('node:os');
  const path = await import('node:path');
  const file = configPath || path.join(process.env.IPFS_PATH || path.join(homedir(), '.ipfs'), 'config');
  const source = await fs.readFile(file, 'utf8');
  const next = pinnerSetupConfig(JSON.parse(source));
  const output = `${JSON.stringify(next, null, 2)}\n`;
  if (JSON.stringify(JSON.parse(source)) === JSON.stringify(next)) return { changed: false };
  const suffix = `${Date.now()}-${crypto.randomUUID()}`;
  const backupPath = `${file}.dbusk-backup-${suffix}`;
  const temporary = `${file}.dbusk-${suffix}.tmp`;
  await fs.writeFile(backupPath, source, { flag: 'wx', mode: 0o600 });
  try {
    await fs.writeFile(temporary, output, { flag: 'wx', mode: 0o600 });
    if (await fs.readFile(file, 'utf8') !== source) throw new Error('IPFS configuration changed during setup; retry after reviewing it. The original backup is retained.');
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
  return { changed: true, backupPath };
}

export async function diagnosePinnerNode({ ipfsApiUrl = 'http://127.0.0.1:5001', fetchImpl = fetch } = {}) {
  const base = new URL(ipfsApiUrl);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password) {
    throw new Error('Diagnostics require a loopback HTTP IPFS API.');
  }
  const response = await fetchImpl(`${base.origin}/api/v0/swarm/addrs/autonat`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`IPFS reachability check failed (${response.status})`);
  const value = await response.json();
  if (!['Public', 'Private', 'Unknown'].includes(value.reachability)) throw new Error('IPFS returned an unknown reachability response');
  return value.reachability;
}

export function createCommunityPinnerClient({ serviceUrl = 'https://decentbusking.onrender.com',
  ipfsApiUrl = 'http://127.0.0.1:5001', carGatewayUrl, fetchImpl = fetch, onProgress = () => {} } = {}) {
  const service = new URL(serviceUrl);
  if (service.protocol !== 'https:' || service.username || service.password) throw new Error('Community manifest service must use HTTPS');
  return async () => {
    const response = await fetchImpl(`${service.toString().replace(/\/$/, '')}/api/pinners/manifest`, {
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Community manifest unavailable (${response.status})`);
    const manifest = await response.json();
    return pinCommunityManifest({ manifest, provider: 'local', ipfsApiUrl, carGatewayUrl, fetchImpl, onProgress });
  };
}

async function main() {
  if (process.argv.includes('--setup')) {
    const result = await setupPinnerNode();
    console.info(result.changed
      ? `[community-pinner] Settings saved with a private backup at ${result.backupPath}. Restart IPFS Desktop from its menu to load them.`
      : '[community-pinner] Local settings are already configured.');
    console.info('[community-pinner] UPnP/NAT-PMP mapping is enabled; your router/firewall or ISP may still block incoming connections. Never expose the API on port 5001. No pins were removed.');
    console.info('[community-pinner] After IPFS restarts, run this command with --diagnose, then --watch to keep your copy synchronized.');
    return;
  }
  if (process.argv.includes('--diagnose')) {
    const reachability = await diagnosePinnerNode({ ipfsApiUrl: process.env.IPFS_API_URL || undefined });
    console.info(`[community-pinner] Reachability: ${reachability}. ${reachability === 'Public'
      ? 'Ready for independent node verification; enrollment and admin approval are still required.'
      : 'Allow IPFS through your firewall and enable router UPnP or forward the swarm TCP/UDP port. CGNAT may require another connection or host. Never forward port 5001.'}`);
    if (reachability !== 'Public') process.exitCode = 1;
    return;
  }
  const poll = createCommunityPinnerClient({ serviceUrl: process.env.DBUSK_SERVICE_URL || undefined,
    ipfsApiUrl: process.env.IPFS_API_URL || undefined, carGatewayUrl: process.env.PINNER_CAR_GATEWAY || undefined });
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
