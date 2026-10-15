import { JsonRpcProvider, Network, ensNormalize } from 'ethers';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const RECORD_KEYS = ['avatar', 'banner', 'header'];

export function ensRpcUrlsFromEnv(env = process.env) {
  return [...new Set([env.ALCHEMY_ETH_URL, env.ENS_RPC_URL, 'https://ethereum-rpc.publicnode.com']
    .map(url => String(url || '').trim()).filter(Boolean))];
}

export function normalizeEnsName(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 255 || !text.includes('.')) throw new Error('Invalid ENS name');
  try {
    return ensNormalize(text);
  } catch {
    throw new Error('Invalid ENS name');
  }
}

// Mainnet ENS lookups for the browser, so paid RPC keys stay on the worker.
// Providers are tried in order (paid first, public fallback) and results are cached.
export function createEnsResolver({
  urls = ensRpcUrlsFromEnv(),
  createProvider = url => new JsonRpcProvider(url, Network.from(1), { staticNetwork: Network.from(1) }),
  ttlMs = 6 * 60 * 60 * 1000,
  negativeTtlMs = 15 * 60 * 1000,
  maxEntries = 5000,
  now = () => Date.now(),
} = {}) {
  if (!urls.length) throw new Error('At least one ENS RPC URL is required');
  const providers = urls.map(url => createProvider(url));
  const cache = new Map();

  async function withProviders(operation) {
    let lastError;
    for (const provider of providers) {
      try {
        return await operation(provider);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('ENS lookup unavailable');
  }

  function cached(key, load, isEmpty) {
    const hit = cache.get(key);
    if (hit && (hit.pending || hit.expiresAt > now())) {
      cache.delete(key);
      cache.set(key, hit);
      return hit.pending || Promise.resolve(hit.value);
    }
    const pending = load().then(value => {
      cache.set(key, { value, expiresAt: now() + (isEmpty(value) ? negativeTtlMs : ttlMs) });
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      return value;
    }, error => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, { pending });
    return pending;
  }

  async function resolveName(rawName) {
    const name = normalizeEnsName(rawName);
    return cached(`name:${name}`, () => withProviders(async provider => {
      const address = await provider.resolveName(name);
      return { name, address: address || null };
    }), value => !value.address);
  }

  async function lookupAddress(rawAddress) {
    if (!ADDRESS_PATTERN.test(String(rawAddress || ''))) throw new Error('Invalid wallet address');
    const address = String(rawAddress).toLowerCase();
    return cached(`addr:${address}`, () => withProviders(async provider => {
      const name = await provider.lookupAddress(address);
      if (!name) return { address, name: null };
      const forward = await provider.resolveName(name);
      return { address, name: String(forward || '').toLowerCase() === address ? name : null };
    }), value => !value.name);
  }

  async function records(rawName) {
    const name = normalizeEnsName(rawName);
    return cached(`records:${name}`, () => withProviders(async provider => {
      const resolver = await provider.getResolver(name);
      if (!resolver) return { name, avatar: '', texts: {} };
      const [avatar, ...texts] = await Promise.all([
        resolver.getAvatar().catch(() => null),
        ...RECORD_KEYS.map(key => resolver.getText(key).catch(() => '')),
      ]);
      return {
        name,
        avatar: typeof avatar === 'string' ? avatar : avatar?.url || '',
        texts: Object.fromEntries(RECORD_KEYS.map((key, index) => [key, texts[index] || ''])),
      };
    }), () => false);
  }

  return { lookupAddress, resolveName, records, urls };
}
