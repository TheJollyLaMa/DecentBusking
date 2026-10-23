export const BASE_CHAIN_ID = 8453;
export const BASE_CHAIN_HEX = `0x${BASE_CHAIN_ID.toString(16)}`;

const BASE_CHAIN_PARAMS = {
  chainId: BASE_CHAIN_HEX,
  chainName: 'Base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://mainnet.base.org'],
  blockExplorerUrls: ['https://basescan.org'],
};

export async function ensureBaseNetwork(provider) {
  if (Number((await provider.getNetwork()).chainId) === BASE_CHAIN_ID) return;
  if (typeof window === 'undefined' || !window.ethereum?.request) throw new Error('Switch your wallet to Base');
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_CHAIN_HEX }] });
  } catch (error) {
    if (error.code !== 4902) throw error;
    await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [BASE_CHAIN_PARAMS] });
  }
  if (Number((await provider.getNetwork()).chainId) !== BASE_CHAIN_ID) {
    throw new Error('Switch your wallet to Base');
  }
}

// Shown before every token approval so a wallet security banner doesn't surprise users.
export function approvalNotice(amountText, { workerContribution = true } = {}) {
  const amount = String(amountText).replace(/\s*USDC$/i, '');
  return `Set a spending allowance of exactly ${amount} USDC. Approval does not purchase playback. Review the separate purchase transaction for its USDC total, ${workerContribution ? 'any worker ETH contribution, and ' : 'and '}wallet network gas before confirming.`;
}

export async function waitForAllowance(token, owner, spender, minimumAmount, { retries = 10, delayMs = 50 } = {}) {
  for (let attempt = 0; attempt < retries; attempt++) {
    if (await token.allowance(owner, spender) >= minimumAmount) return;
    if (attempt + 1 < retries) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error('Waiting for approval to confirm timed out');
}

export function isMissingRevertData(error) {
  return error?.code === 'CALL_EXCEPTION' && /missing revert data/i.test(String(error?.message || ''));
}

export async function retryMissingRevertData(action, refresh) {
  try {
    return await action();
  } catch (error) {
    if (!isMissingRevertData(error)) throw error;
    if (refresh) await refresh();
    return action();
  }
}

// ── Read-only Base RPC for the browser (#205) ──
// Public endpoints first (free), each behind a small circuit breaker; if every public endpoint fails,
// fall back to the worker's /api/rpc proxy, which can use the paid tier without exposing its key.
export const DEFAULT_PUBLIC_BASE_RPC_URLS = Object.freeze([
  'https://base-rpc.publicnode.com',
  'https://mainnet.base.org',
  'https://base.gateway.tenderly.co',
  'https://base.drpc.org',
]);
const RATE_LIMIT_CODES = new Set([-32005, -32011, -32016, -32090, 429]);
const RATE_LIMIT_TEXT = /rate limit|request limit|too many|exceeded|capacity|throttl|personal token|free plan|timeout/i;
const READ_BATCH_MAX = 10;

export function baseReadEndpoints(config = globalThis.window?.DecentConfig || {}) {
  const publicUrls = [...new Set([config.rpcUrl, ...(config.rpcFallbackUrls || []), ...DEFAULT_PUBLIC_BASE_RPC_URLS]
    .map(url => String(url || '').trim()).filter(url => /^https:\/\//.test(url)))];
  const service = String(config.ipfsUploadServiceUrl || '').replace(/\/$/, '');
  return { publicUrls, workerUrl: /^https?:\/\//.test(service) ? `${service}/api/rpc` : '' };
}

function isLimitError(error) {
  return RATE_LIMIT_CODES.has(Number(error?.code)) || RATE_LIMIT_TEXT.test(String(error?.message || ''));
}

export function createBaseRpcTransport({
  publicUrls = [],
  workerUrl = '',
  fetchImpl = globalThis.fetch?.bind(globalThis),
  now = () => Date.now(),
  timeoutMs = 6000,
  workerTimeoutMs = 15000,
  breakerBaseMs = 30_000,
  breakerMaxMs = 5 * 60_000,
} = {}) {
  const endpoints = publicUrls.map(url => ({ url, openUntil: 0, strikes: 0 }));
  const worker = workerUrl ? { url: workerUrl, openUntil: 0, strikes: 0, worker: true } : null;

  function trip(endpoint) {
    endpoint.strikes += 1;
    endpoint.openUntil = now() + Math.min(breakerMaxMs, breakerBaseMs * 2 ** (endpoint.strikes - 1));
  }

  async function post(endpoint, payload) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), endpoint.worker ? workerTimeoutMs : timeoutMs) : null;
    try {
      const response = await fetchImpl(endpoint.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        ...(controller ? { signal: controller.signal } : {}),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body == null) throw Object.assign(new Error(`HTTP ${response.status}`), { body });
      const list = Array.isArray(body) ? body : [body];
      if (list.some(item => item?.error && isLimitError(item.error))) throw new Error('rate limited');
      return list;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // payload: one JSON-RPC request or a batch; resolves to an array of responses matched by id.
  async function send(payload) {
    const items = Array.isArray(payload) ? payload : [payload];
    const time = now();
    const ready = endpoints.filter(endpoint => endpoint.openUntil <= time);
    const order = [...ready, ...(worker ? [worker] : []), ...endpoints.filter(endpoint => endpoint.openUntil > time)];
    let lastError = null;
    for (const endpoint of order) {
      if (endpoint.worker && endpoint.openUntil > now()) continue;
      try {
        const results = await post(endpoint, Array.isArray(payload) ? items : items[0]);
        endpoint.strikes = 0;
        endpoint.openUntil = 0;
        return results;
      } catch (error) {
        lastError = error;
        trip(endpoint);
      }
    }
    throw new Error(`Base RPC unavailable${lastError?.message ? ` (${lastError.message})` : ''}`);
  }

  function health() {
    const time = now();
    return [...endpoints, ...(worker ? [worker] : [])].map(endpoint => ({
      host: new URL(endpoint.url).host, worker: !!endpoint.worker, open: endpoint.openUntil > time, strikes: endpoint.strikes,
    }));
  }

  return { send, health };
}

const readProviders = new Map();

// Shared ethers v6 provider for read-only Base calls in the browser. Never use it to send transactions.
export function getBaseReadProvider({ ethers = globalThis.window?.ethers || globalThis.ethers, config, fetchImpl } = {}) {
  if (!ethers?.JsonRpcProvider) return null;
  const endpoints = baseReadEndpoints(config || globalThis.window?.DecentConfig || {});
  if (typeof ethers.Network?.from !== 'function') return new ethers.JsonRpcProvider(endpoints.publicUrls[0]);
  const cacheKey = JSON.stringify(endpoints);
  if (!fetchImpl && readProviders.get(cacheKey)?.ethers === ethers) return readProviders.get(cacheKey).provider;
  const transport = createBaseRpcTransport({ ...endpoints, ...(fetchImpl ? { fetchImpl } : {}) });
  const network = ethers.Network.from(BASE_CHAIN_ID);
  class BaseReadProvider extends ethers.JsonRpcProvider {
    constructor() {
      super('https://base-rpc.invalid', network, { staticNetwork: network, batchMaxCount: READ_BATCH_MAX });
      this.transport = transport;
    }

    async _send(payload) {
      const items = Array.isArray(payload) ? payload : [payload];
      if (items.length === 1 && items[0].method === 'eth_chainId') return [{ id: items[0].id, result: BASE_CHAIN_HEX }];
      try {
        const results = await transport.send(items);
        const byId = new Map(results.map(result => [String(result?.id), result]));
        return items.map(item => byId.get(String(item.id)) || { id: item.id, error: { code: -32603, message: 'Missing RPC response' } });
      } catch (error) {
        return items.map(item => ({ id: item.id, error: { code: -32603, message: error.message } }));
      }
    }
  }
  const provider = new BaseReadProvider();
  if (!fetchImpl) {
    // Shared across modules: callers may still call destroy(), which must not break everyone else.
    provider.destroy = () => {};
    readProviders.set(cacheKey, { ethers, provider });
  }
  return provider;
}
