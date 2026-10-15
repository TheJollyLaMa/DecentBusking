import { JsonRpcProvider, Network, keccak256 } from 'ethers';

// Tiered RPC routing (#205): cheap reads go public-first, history scans and
// our own transactions go paid-first, and every endpoint has a circuit breaker
// so a rate-limited host is skipped instead of hammered.

const KNOWN_PUBLIC_HOSTS = new Set([
  'mainnet.base.org', 'base-rpc.publicnode.com', 'base.drpc.org', 'base.llamarpc.com',
  '1rpc.io', 'base.meowrpc.com', 'base-mainnet.public.blastapi.io',
]);
export const DEFAULT_PUBLIC_BASE_URLS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org'];

// Approximate Alchemy compute-unit costs; unknown methods count as 20.
const CU_COSTS = {
  eth_chainId: 0, eth_blockNumber: 10, eth_call: 26, eth_getBalance: 19, eth_getLogs: 75,
  eth_getBlockByNumber: 16, eth_getBlockByHash: 16, eth_getTransactionReceipt: 15, eth_getTransactionByHash: 17,
  eth_getTransactionCount: 26, eth_estimateGas: 87, eth_sendRawTransaction: 250, eth_gasPrice: 19,
  eth_maxPriorityFeePerGas: 10, eth_feeHistory: 10, eth_getCode: 26,
};
const CRITICAL_METHODS = new Set(['eth_sendRawTransaction', 'eth_getTransactionCount', 'eth_estimateGas']);
const TIMEOUTS = { read: 4000, logs: 10000, critical: 15000 };
const SMALL_LOG_RANGE = 500;
const RATE_LIMIT_CODES = new Set([-32005, -32011, -32016, -32090, 429]);
const RATE_LIMIT_TEXT = /rate.?limit|request limit|too many requests|exceeded.*(quota|capacity|compute)|capacity|throughput|unavailable|archive|personal token|timeout|temporarily/i;
const RANGE_TEXT = /block range|ranges? over \d+ blocks|range (is )?too (large|wide)|query returned more than|too many (results|logs)|response size|limited to \d+|log response size exceeded|max.*range|range.*exceed/i;
const ALREADY_SENT_TEXT = /already known|known transaction|nonce too low|already imported/i;

export function isPaidRpcUrl(url) {
  try {
    return !KNOWN_PUBLIC_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function uniqueUrls(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

/** Builds the public and paid Base endpoint lists from env vars and payroll-assets.json. */
export function baseRpcEndpointsFromEnv(env = process.env, assets = {}) {
  const publicUrls = uniqueUrls(env.BASE_PUBLIC_RPC_URLS
    ? env.BASE_PUBLIC_RPC_URLS.split(',')
    : [assets.rpcUrl, ...(assets.rpcFallbackUrls || []), ...DEFAULT_PUBLIC_BASE_URLS]);
  const overrides = uniqueUrls([env.ALCHEMY_BASE_URL, env.BASE_RPC_URL, env.BASE_LOGS_RPC_URL, env.PAYROLL_ARCHIVE_RPC_URL]);
  const paidUrls = overrides.filter(isPaidRpcUrl);
  for (const url of overrides) if (!isPaidRpcUrl(url) && !publicUrls.includes(url)) publicUrls.unshift(url);
  return { publicUrls, paidUrls };
}

function endpointLabel(url, tier, index) {
  try {
    return `${tier}#${index + 1} ${new URL(url).hostname}`;
  } catch {
    return `${tier}#${index + 1}`;
  }
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

function parseBlock(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) return Number.parseInt(value, 16);
  return null;
}

const toHex = value => `0x${value.toString(16)}`;

class RpcAttemptError extends Error {
  constructor(message, { kind, ambiguous = false } = {}) {
    super(message);
    this.kind = kind;
    this.ambiguous = ambiguous;
  }
}

export function classifyRpcError(error) {
  const message = `${error?.message || ''} ${typeof error?.data === 'string' ? error.data : ''}`;
  if (RANGE_TEXT.test(message)) return 'range';
  if (RATE_LIMIT_CODES.has(Number(error?.code)) || RATE_LIMIT_TEXT.test(message)) return 'limit';
  return 'final';
}

// Pay-as-you-go spend guard: about 73M CU/month at a $33 cap is roughly 2.3M CU/day.
export const DEFAULT_DAILY_CU_SOFT_LIMIT = 2_000_000;

export function createRpcRouter({
  chainId = 8453,
  publicUrls = [],
  paidUrls = [],
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeouts = TIMEOUTS,
  dailyCuSoftLimit = Infinity,
  breakerBaseMs = 30_000,
  breakerMaxMs = 5 * 60_000,
  minLogRange = 10,
} = {}) {
  const endpoints = [
    ...paidUrls.map((url, index) => ({ url, tier: 'paid', label: endpointLabel(url, 'paid', index) })),
    ...publicUrls.map((url, index) => ({ url, tier: 'public', label: endpointLabel(url, 'public', index) })),
  ].map(endpoint => ({
    ...endpoint, requests: 0, ok: 0, failed: 0, rateLimited: 0, latencies: [],
    strikes: 0, openUntil: 0, lastError: '',
  }));
  if (!endpoints.length) throw new Error('At least one RPC URL is required');
  const paid = endpoints.filter(endpoint => endpoint.tier === 'paid');
  const pub = endpoints.filter(endpoint => endpoint.tier === 'public');
  const inflight = new Map();
  const cache = new Map();
  const consumers = {};
  const usage = { day: '', dayCu: 0, minute: 0, minuteCu: 0, byMethod: {} };
  let requestId = 0;

  function chargeCu(method) {
    const time = now();
    const day = new Date(time).toISOString().slice(0, 10);
    const minute = Math.floor(time / 60_000);
    if (usage.day !== day) Object.assign(usage, { day, dayCu: 0, byMethod: {} });
    if (usage.minute !== minute) Object.assign(usage, { minute, minuteCu: 0 });
    const cost = CU_COSTS[method] ?? 20;
    usage.dayCu += cost;
    usage.minuteCu += cost;
    usage.byMethod[method] = (usage.byMethod[method] || 0) + cost;
  }

  const overBudget = () => usage.day === new Date(now()).toISOString().slice(0, 10) && usage.dayCu >= dailyCuSoftLimit;

  function classify(method, kind) {
    if (method === 'eth_getLogs') return 'logs';
    if (CRITICAL_METHODS.has(method)) return 'critical';
    return kind;
  }

  function logRange(params) {
    const filter = params?.[0] || {};
    if (filter.blockHash) return 0;
    const from = parseBlock(filter.fromBlock);
    const to = parseBlock(filter.toBlock);
    return from == null || to == null ? Infinity : Math.max(0, to - from + 1);
  }

  function orderFor(cls, method, params) {
    let first = paid;
    let second = pub;
    // Over the daily soft budget only transaction-path methods stay paid-first.
    if (cls === 'read' || (overBudget() && !CRITICAL_METHODS.has(method))) [first, second] = [pub, paid];
    if (cls === 'logs' && logRange(params) <= SMALL_LOG_RANGE) [first, second] = [pub, paid];
    const ordered = [...first, ...second];
    const time = now();
    return [...ordered.filter(endpoint => endpoint.openUntil <= time), ...ordered.filter(endpoint => endpoint.openUntil > time)];
  }

  function trip(endpoint, message) {
    endpoint.strikes += 1;
    endpoint.openUntil = now() + Math.min(breakerMaxMs, breakerBaseMs * 2 ** (endpoint.strikes - 1));
    endpoint.lastError = String(message || '').slice(0, 160);
  }

  async function attempt(endpoint, method, params, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = now();
    endpoint.requests += 1;
    if (endpoint.tier === 'paid') chargeCu(method);
    try {
      let response;
      try {
        response = await fetchImpl(endpoint.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
          signal: controller.signal,
        });
      } catch (error) {
        throw new RpcAttemptError(controller.signal.aborted ? `timeout after ${timeoutMs}ms` : error.message, { kind: 'limit', ambiguous: true });
      }
      if (!response.ok) {
        const errorBody = await response.json().catch(() => null);
        const rpcError = errorBody?.error;
        if (rpcError && classifyRpcError(rpcError) === 'range') throw new RpcAttemptError(rpcError.message, { kind: 'range' });
        const kind = [401, 403, 408, 429].includes(response.status) || response.status >= 500 ? 'limit' : 'final';
        const detail = rpcError?.message ? `: ${String(rpcError.message).slice(0, 120)}` : '';
        throw new RpcAttemptError(`HTTP ${response.status}${detail}`, { kind, ambiguous: response.status >= 500 });
      }
      let body;
      try {
        body = await response.json();
      } catch {
        throw new RpcAttemptError('Invalid JSON-RPC response', { kind: 'limit', ambiguous: true });
      }
      if (body?.error) {
        const kind = classifyRpcError(body.error);
        if (kind === 'final') return { error: body.error };
        throw new RpcAttemptError(body.error.message || 'RPC error', { kind });
      }
      endpoint.latencies.push(now() - started);
      if (endpoint.latencies.length > 200) endpoint.latencies.shift();
      return { result: body?.result ?? null };
    } finally {
      clearTimeout(timer);
    }
  }

  async function dispatch(cls, method, params) {
    let lastError = null;
    let rangeError = null;
    let ambiguousSend = false;
    for (const endpoint of orderFor(cls, method, params)) {
      try {
        const outcome = await attempt(endpoint, method, params, timeouts[cls] || timeouts.read);
        if (outcome.error && method === 'eth_sendRawTransaction' && ambiguousSend && ALREADY_SENT_TEXT.test(outcome.error.message || '')) {
          endpoint.ok += 1;
          return { result: keccak256(params[0]) };
        }
        endpoint.ok += 1;
        endpoint.strikes = 0;
        return outcome;
      } catch (error) {
        endpoint.failed += 1;
        lastError = error;
        if (error.kind === 'range') {
          rangeError = error;
          endpoint.lastError = String(error.message).slice(0, 160);
          continue;
        }
        if (error.kind === 'limit') {
          endpoint.rateLimited += 1;
          trip(endpoint, error.message);
        }
        if (error.ambiguous && method === 'eth_sendRawTransaction') ambiguousSend = true;
      }
    }
    throw rangeError || lastError || new Error('No RPC endpoint available');
  }

  // A range error from every endpoint means the filter spans too many blocks or logs: split and merge.
  async function getLogs(params) {
    try {
      return await dispatch('logs', 'eth_getLogs', params);
    } catch (error) {
      const filter = params?.[0] || {};
      const from = parseBlock(filter.fromBlock);
      const to = parseBlock(filter.toBlock);
      if (error.kind !== 'range' || from == null || to == null || to - from + 1 <= minLogRange) throw error;
      const middle = from + Math.floor((to - from) / 2);
      const left = await getLogs([{ ...filter, fromBlock: toHex(from), toBlock: toHex(middle) }]);
      if (left.error) return left;
      const right = await getLogs([{ ...filter, fromBlock: toHex(middle + 1), toBlock: toHex(to) }]);
      if (right.error) return right;
      return { result: [...(left.result || []), ...(right.result || [])] };
    }
  }

  async function request(kind, method, params = []) {
    const cls = classify(method, kind);
    if (method === 'eth_chainId') return { result: toHex(chainId) };
    const key = cls === 'critical' ? null : `${method}:${JSON.stringify(params)}`;
    if (method === 'eth_blockNumber') {
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now()) return hit.value;
    }
    if (key && inflight.has(key)) return inflight.get(key);
    const task = (method === 'eth_getLogs' ? getLogs(params) : dispatch(cls, method, params)).then(value => {
      if (method === 'eth_blockNumber' && !value.error) cache.set(key, { value, expiresAt: now() + 2000 });
      return value;
    });
    if (key) {
      inflight.set(key, task);
      task.finally(() => inflight.delete(key)).catch(() => {});
    }
    return task;
  }

  class TieredJsonRpcProvider extends JsonRpcProvider {
    constructor(kind) {
      const network = Network.from(chainId);
      super('http://127.0.0.1:0', network, { staticNetwork: network, batchMaxCount: 1 });
      this.rpcKind = kind;
    }

    async _send(payload) {
      const list = Array.isArray(payload) ? payload : [payload];
      return Promise.all(list.map(async item => {
        try {
          const outcome = await request(this.rpcKind, item.method, item.params);
          return outcome.error ? { id: item.id, error: outcome.error } : { id: item.id, result: outcome.result };
        } catch (error) {
          return { id: item.id, error: { code: -32603, message: `All RPC endpoints failed: ${error.message}` } };
        }
      }));
    }
  }

  const providers = {};
  function provider(kind = 'read', consumer = '') {
    if (!['read', 'logs', 'critical'].includes(kind)) throw new Error(`Unknown RPC tier: ${kind}`);
    if (consumer) consumers[consumer] = kind;
    providers[kind] ||= new TieredJsonRpcProvider(kind);
    return providers[kind];
  }

  function health() {
    const time = now();
    return {
      chainId,
      tiers: { paid: paid.length, public: pub.length },
      consumers: { ...consumers },
      computeUnits: {
        today: usage.day === new Date(time).toISOString().slice(0, 10) ? usage.dayCu : 0,
        lastMinute: usage.minute === Math.floor(time / 60_000) ? usage.minuteCu : 0,
        dailySoftLimit: Number.isFinite(dailyCuSoftLimit) ? dailyCuSoftLimit : null,
        overBudget: overBudget(),
        todayByMethod: usage.day === new Date(time).toISOString().slice(0, 10) ? { ...usage.byMethod } : {},
      },
      endpoints: endpoints.map(endpoint => ({
        label: endpoint.label,
        tier: endpoint.tier,
        requests: endpoint.requests,
        ok: endpoint.ok,
        failed: endpoint.failed,
        rateLimited: endpoint.rateLimited,
        p50Ms: percentile(endpoint.latencies, 0.5),
        p95Ms: percentile(endpoint.latencies, 0.95),
        breaker: endpoint.openUntil > time ? { open: true, retryInMs: endpoint.openUntil - time } : { open: false },
        lastError: endpoint.lastError,
      })),
    };
  }

  function describe() {
    return Object.entries(consumers).map(([name, kind]) => `${name}=${kind}`).join(', ');
  }

  return { provider, request, health, describe };
}
