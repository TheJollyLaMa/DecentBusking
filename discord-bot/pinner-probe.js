import { execFile, spawn } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import kubo from 'kubo';
import { CID } from 'multiformats/cid';
import { base36 } from 'multiformats/bases/base36';
import { base58btc } from 'multiformats/bases/base58';
import { decode } from 'multiformats/hashes/digest';

const run = promisify(execFile);
class PinnerUnavailableError extends Error {}
const unavailable = (error, signal) => error instanceof PinnerUnavailableError || signal.aborted ||
  error?.code === 'ABORT_ERR' || (error?.killed && error?.signal === 'SIGTERM') ||
  /deadline exceeded|timed? out|timeout|failed to dial|dial backoff|all dials failed|no good addresses|connection refused|block.*not found/i.test(String(error?.stderr || ''));
const blocked = new BlockList();
for (const [ip, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) {
  blocked.addSubnet(ip, prefix, 'ipv4');
}
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, prefix] of [['2001::', 32], ['2001:db8::', 32], ['2002::', 16]]) blocked.addSubnet(ip, prefix, 'ipv6');

export function normalizePinnerPeerId(value) {
  if (typeof value !== 'string' || value.length < 40 || value.length > 128) throw new Error('Enter a valid IPFS peer ID');
  let hash;
  if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(value) && (value.startsWith('Qm') || value.startsWith('12D3'))) {
    hash = decode(base58btc.decode(`z${value}`));
  } else {
    const cid = CID.parse(value, value.startsWith('k') ? base36.decoder : undefined);
    if (cid.code !== 0x72) throw new Error('Peer ID must use the libp2p-key codec');
    hash = cid.multihash;
  }
  if (![0, 0x12].includes(hash.code)) throw new Error('Unsupported IPFS peer identity');
  return base58btc.encode(hash.bytes).slice(1);
}

function publicPeerAddress(value, peerId) {
  const match = /^\/(ip4|ip6)\/([^/]+)\/(tcp|udp)\/(\d{1,5})(\/quic-v1)?(?:\/p2p\/([^/]+))?$/.exec(value);
  if (!match) return null;
  const [, kind, ip, transport, port, quic, peer] = match;
  const version = kind === 'ip4' ? 4 : 6;
  if (isIP(ip) !== version || Number(port) < 1 || Number(port) > 65535 ||
    (transport === 'udp') !== Boolean(quic) || (peer && normalizePinnerPeerId(peer) !== peerId)) return null;
  if (blocked.check(ip, version === 4 ? 'ipv4' : 'ipv6') || (version === 6 && !globalV6.check(ip, 'ipv6'))) return null;
  return `${value.replace(/\/p2p\/[^/]+$/, '')}/p2p/${peerId}`;
}

export async function resolvePinnerAddresses(peerId, { fetchImpl = fetch } = {}) {
  peerId = normalizePinnerPeerId(peerId);
  const response = await fetchImpl(`https://delegated-ipfs.dev/routing/v1/peers/${peerId}`, {
    headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Pinner peer-routing service unavailable (${response.status})`);
  const text = await response.text();
  if (text.length > 131072) throw new Error('Pinner peer-routing response exceeds the limit');
  const value = JSON.parse(text);
  if (!Array.isArray(value.Peers) || value.Peers.length > 100) throw new Error('Invalid pinner peer-routing response');
  const addresses = [];
  for (const peer of value.Peers) {
    if (normalizePinnerPeerId(peer.ID) !== peerId || !Array.isArray(peer.Addrs)) continue;
    for (const address of peer.Addrs.slice(0, 100)) {
      const safe = typeof address === 'string' ? publicPeerAddress(address, peerId) : null;
      if (safe) addresses.push(safe);
    }
  }
  return [...new Set(addresses)].slice(0, 4);
}

export function verifyPinnerBlock(cid, bytes) {
  const expected = CID.parse(cid).multihash;
  if (expected.code !== 0x12 || !createHash('sha256').update(bytes).digest().equals(Buffer.from(expected.digest))) {
    throw new PinnerUnavailableError('Pinner block does not match its CID');
  }
}

// Every probe has an empty repo and exactly one authenticated peer; cached blocks,
// Pinata, discovery, bootstrap peers and content-routing fallbacks cannot satisfy it.
export async function probeKuboPeer({ peerAddress, rootCid, ownershipCid, executable = kubo.path({ autoDownload: false }),
  choose = randomInt, timeoutMs = 45000 }) {
  CID.parse(rootCid);
  const directory = await mkdtemp(join(tmpdir(), 'dbusk-pinner-probe-'));
  const env = { PATH: process.env.PATH, HOME: directory, IPFS_PATH: directory };
  const signal = AbortSignal.timeout(timeoutMs);
  const command = (args, encoding = 'utf8', timeout) => run(executable, args, { env, signal, encoding, timeout, maxBuffer: 2097152 });
  let daemon, stopped;
  try {
    await command(['init', '--profile=test']);
    const configPath = join(directory, 'config');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.Bootstrap = [];
    config.Discovery.MDNS.Enabled = false;
    config.Routing.Type = 'none';
    if (config.AutoConf) config.AutoConf.Enabled = false;
    config.Addresses.Swarm = [];
    config.Addresses.Gateway = '';
    config.Addresses.API = `/unix${join(directory, 'api.sock')}`;
    await writeFile(configPath, JSON.stringify(config));
    signal.throwIfAborted();
    daemon = spawn(executable, ['daemon', '--routing=none'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    stopped = new Promise(resolve => daemon.once('close', resolve));
    await new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('Pinner probe startup timed out')); return; }
      const abort = () => reject(new Error('Pinner probe startup timed out'));
      signal.addEventListener('abort', abort, { once: true });
      const finish = (error) => {
        signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      };
      daemon.once('error', finish);
      daemon.once('exit', () => finish(new Error('Isolated pinner probe exited during startup')));
      let output = '';
      daemon.stdout.on('data', bytes => {
        output = (output + bytes.toString()).slice(-4096);
        if (output.includes('Daemon is ready')) finish();
      });
      daemon.stderr.resume();
    });
    const started = Date.now();
    try {
      let connected = false;
      for (const address of Array.isArray(peerAddress) ? peerAddress : [peerAddress]) {
        try { await command(['swarm', 'connect', address], 'utf8', 10000); connected = true; break; }
        catch (error) {
          if (signal.aborted || daemon.exitCode !== null || !unavailable(error, signal)) throw error;
        }
      }
      if (!connected) return { ok: false, blockCid: '', latencyMs: Date.now() - started, reason: 'Registered IPFS peer is not reachable' };
      if (ownershipCid) {
        const { stdout: bytes } = await command(['block', 'get', ownershipCid], 'buffer');
        verifyPinnerBlock(ownershipCid, bytes);
      }
      let cid = rootCid;
      const depth = choose(1, 5);
      for (let step = 0; step <= depth; step++) {
        const { stdout: bytes } = await command(['block', 'get', cid], 'buffer');
        verifyPinnerBlock(cid, bytes);
        if (step === depth) break;
        const { stdout } = await command(['refs', cid]);
        const links = stdout.trim().split(/\s+/).filter(Boolean);
        if (!links.length) break;
        cid = CID.parse(links[choose(links.length)]).toString();
      }
      return { ok: true, blockCid: cid, latencyMs: Date.now() - started };
    } catch (error) {
      if (daemon.exitCode !== null) throw new Error('Isolated pinner probe stopped unexpectedly', { cause: error });
      if (!unavailable(error, signal)) throw new Error('Pinner probe infrastructure failed; no availability result was recorded', { cause: error });
      return { ok: false, blockCid: '', latencyMs: Date.now() - started, reason: 'Peer could not serve the selected IPFS blocks' };
    }
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill('SIGTERM');
      const timer = setTimeout(() => daemon.kill('SIGKILL'), 3000);
      await stopped;
      clearTimeout(timer);
    }
    await rm(directory, { recursive: true, force: true });
  }
}

export function createPinnerProbe({ fetchImpl = fetch } = {}) {
  const executable = kubo.path({ autoDownload: false });
  return {
    initialize: () => run(executable, ['version'], { timeout: 15000 }),
    async check({ peerId, rootCid, ownershipCid }) {
      const addresses = await resolvePinnerAddresses(peerId, { fetchImpl });
      if (!addresses.length) return { ok: false, blockCid: '', latencyMs: 0, reason: 'No public TCP or QUIC address is advertised by this peer' };
      return probeKuboPeer({ peerAddress: addresses, rootCid, ownershipCid, executable });
    },
  };
}
