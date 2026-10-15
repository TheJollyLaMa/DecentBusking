// ENS lookups go through the worker (paid mainnet RPC, server-side cache) and
// fall back to the public ENS RPC in the browser when the worker is unreachable.
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const TIMEOUT_MS = 6000;
const cache = new Map();
let pendingBatch = null;

function config() {
  return globalThis.window?.DecentConfig || {};
}

function serviceUrl() {
  return String(config().ipfsUploadServiceUrl || '').replace(/\/$/, '');
}

function memo(key, load) {
  if (!cache.has(key)) cache.set(key, load().catch(error => { cache.delete(key); throw error; }));
  return cache.get(key);
}

async function fetchWorker(path) {
  const base = serviceUrl();
  if (!base || typeof fetch !== 'function') throw new Error('ENS worker is not configured');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
  try {
    const response = await fetch(`${base}${path}`, { signal: controller?.signal });
    if (!response.ok) throw new Error(`ENS worker returned ${response.status}`);
    return await response.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withFallbackProvider(operation) {
  const ethers = globalThis.window?.ethers;
  if (!ethers?.JsonRpcProvider) throw new Error('ENS lookup unavailable');
  const provider = new ethers.JsonRpcProvider(config().ensRpcUrl || 'https://ethereum-rpc.publicnode.com', 1);
  try {
    return await operation(provider);
  } finally {
    provider.destroy?.();
  }
}

async function directLookup(address) {
  return withFallbackProvider(async provider => {
    const name = await provider.lookupAddress(address);
    if (!name) return null;
    const forward = await provider.resolveName(name);
    if (String(forward || '').toLowerCase() !== address) return null;
    primeForward(name, address);
    return name;
  });
}

function primeForward(name, address) {
  const key = `name:${String(name).toLowerCase()}`;
  if (!cache.has(key)) cache.set(key, Promise.resolve(address));
}

function flushBatch() {
  const batch = pendingBatch;
  pendingBatch = null;
  const addresses = [...batch.keys()];
  for (let index = 0; index < addresses.length; index += 25) {
    const chunk = addresses.slice(index, index + 25);
    fetchWorker(`/api/ens/lookup?addresses=${chunk.join(',')}`)
      .then(data => {
        for (const address of chunk) {
          const name = data?.results?.[address] ?? null;
          if (name) primeForward(name, address);
          batch.get(address).resolve(name);
        }
      })
      .catch(() => {
        for (const address of chunk) {
          directLookup(address).then(batch.get(address).resolve, batch.get(address).reject);
        }
      });
  }
}

/** Reverse-resolves an address to its forward-verified primary ENS name, or null. */
export function lookupEnsName(address) {
  const key = String(address || '').toLowerCase();
  if (!ADDRESS_PATTERN.test(key)) return Promise.resolve(null);
  return memo(`addr:${key}`, () => new Promise((resolve, reject) => {
    if (!pendingBatch) {
      pendingBatch = new Map();
      setTimeout(flushBatch, 0);
    }
    pendingBatch.set(key, { resolve, reject });
  }));
}

/** Forward-resolves an ENS name to an address, or null. */
export function resolveEnsName(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key.includes('.')) return Promise.resolve(null);
  return memo(`name:${key}`, async () => {
    try {
      const data = await fetchWorker(`/api/ens/resolve?name=${encodeURIComponent(key)}`);
      return data?.address || null;
    } catch {
      return withFallbackProvider(provider => provider.resolveName(key));
    }
  });
}

/** Returns raw avatar/banner/header records for an ENS name. */
export function fetchEnsRecords(name) {
  const key = String(name || '').trim().toLowerCase();
  return memo(`records:${key}`, async () => {
    try {
      return await fetchWorker(`/api/ens/records?name=${encodeURIComponent(key)}`);
    } catch {
      return withFallbackProvider(async provider => {
        const resolver = await provider.getResolver(key);
        if (!resolver) return { name: key, avatar: '', texts: {} };
        const [avatar, banner, header] = await Promise.all([
          resolver.getAvatar().catch(() => null),
          resolver.getText('banner').catch(() => ''),
          resolver.getText('header').catch(() => ''),
        ]);
        return { name: key, avatar: typeof avatar === 'string' ? avatar : avatar?.url || '', texts: { banner, header } };
      });
    }
  });
}

/**
 * Drop-in for the subset of the ethers provider API our ENS helpers use
 * (lookupAddress, resolveName, getResolver), backed by the worker.
 */
export const workerEnsProvider = Object.freeze({
  lookupAddress: lookupEnsName,
  resolveName: resolveEnsName,
  async getResolver(name) {
    const records = fetchEnsRecords(name);
    return {
      getAvatar: async () => (await records).avatar || null,
      getText: async key => (await records).texts?.[key] || '',
    };
  },
  destroy() {},
});

export function _resetEnsClientCache() {
  cache.clear();
  pendingBatch = null;
}
