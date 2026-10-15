import { JsonRpcProvider, Network, keccak256 } from 'ethers';

// Tiered RPC routing (#205): cheap reads go public-first, history scans and
// our own transactions go paid-first, and every endpoint has a circuit breaker
// so a rate-limited host is skipped instead of hammered.

const KNOWN_PUBLIC_HOSTS = new Set([
  'mainnet.base.org', 'base-rpc.publicnode.com', 'base.drpc.org', 'base.llamarpc.com',
  '1rpc.io', 'base.meowrpc.com', 'base-mainnet.public.blastapi.io', 'base.gateway.tenderly.co',
]);
// Ordered by what works without a key: Tenderly serves historical getLogs (<= ~500 blocks),
// publicnode serves recent logs and calls, blastapi and base.org serve calls.
export const DEFAULT_PUBLIC_BASE_URLS = [
  'https://base-rpc.publicnode.com', 'https://base.gateway.tenderly.co', 'https://mainnet.base.org',
  'https://base-mainnet.public.blastapi.io', 'https://base.drpc.org',
];

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
const RATE_LIMIT_TEXT = /rate.?limit|request limit|too many requests|exceeded.*(quota|capacity|compute)|capacity|throughput|unavailable|timeout|temporarily/i;
// The endpoint is healthy but cannot serve this request (e.g. archive data on a free tier).
const UNSUPPORTED_TEXT = /archive|personal token|not supported on free|upgrade to (a )?paid|method not (found|available|supported)/i;
// The paid account is out of money for the month, not just briefly throttled.
const EXHAUSTED_TEXT = /monthly|spending (limit|cap)|billing|out of (compute|cu)|credits? (exhausted|depleted)|plan limit/i;
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
  if (EXHAUSTED_TEXT.test(message)) return 'exhausted';
  if (UNSUPPORTED_TEXT.test(message)) return 'unsupported';
  if (RATE_LIMIT_CODES.has(Number(error?.code)) || RATE_LIMIT_TEXT.test(message)) return 'limit';
  return 'final';
}

// Budget for the paid tier, sized for a $33/month Alchemy cap. Our CU counts are estimates,
// so the default stays under the plan's ~73M CU to leave headroom.
export const DEFAULT_MONTHLY_CU_BUDGET = 60_000_000;
export const BUDGET_MODES = Object.freeze({
  normal: 'normal',              // paid-first for logs and transactions, public-first for reads
  conserve: 'conserve',          // ahead of the monthly pace: everything but transactions goes public-first
  criticalOnly: 'critical-only', // spendable budget used: paid tier only for transaction paths
  exhausted: 'exhausted',        // budget gone or Alchemy refused: public only, probe paid occasionally
});

function monthWindow(time) {
  const date = new Date(time);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return { key: date.toISOString().slice(0, 7), start, end, days: Math.round((end - start) / 86_400_000) };
}

export function createRpcRouter({
  chainId = 8453,
  publicUrls = [],
  paidUrls = [],
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeouts = TIMEOUTS,
  dailyCuSoftLimit = Infinity,
  monthlyCuBudget = Infinity,
  reserveFraction = 0.1,
  exhaustedProbeMs = 30 * 60_000,
  initialUsage = null,
  onModeChange = () => {},
  readCacheMs = 10_000,
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
  const usage = { day: '', dayCu: 0, minute: 0, minuteCu: 0, byMethod: {}, month: '', monthCu: 0 };
  // Adds usage persisted before a restart to what this process has spent since booting. Call once per snapshot.
  function restoreUsage(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    const window = monthWindow(now());
    let changed = false;
    if (snapshot.month === window.key && Number.isFinite(snapshot.monthCu) && snapshot.monthCu > 0) {
      if (usage.month !== window.key) Object.assign(usage, { month: window.key, monthCu: 0 });
      usage.monthCu += snapshot.monthCu;
      changed = true;
    }
    const today = new Date(now()).toISOString().slice(0, 10);
    if (snapshot.day === today && Number.isFinite(snapshot.dayCu) && snapshot.dayCu > 0) {
      if (usage.day !== today) Object.assign(usage, { day: today, dayCu: 0, byMethod: {} });
      usage.dayCu += snapshot.dayCu;
      changed = true;
    }
    return changed;
  }
  restoreUsage(initialUsage);
  let requestId = 0;
  let exhaustedUntil = 0;
  let lastMode = null;

  function budget() {
    const time = now();
    const window = monthWindow(time);
    const monthCu = usage.month === window.key ? usage.monthCu : 0;
    const today = new Date(time).toISOString().slice(0, 10);
    const dayCu = usage.day === today ? usage.dayCu : 0;
    if (!Number.isFinite(monthlyCuBudget)) {
      const mode = exhaustedUntil > time ? BUDGET_MODES.exhausted : dayCu >= dailyCuSoftLimit ? BUDGET_MODES.conserve : BUDGET_MODES.normal;
      return { mode, monthCu, dayCu, monthlyBudget: null };
    }
    const spendable = monthlyCuBudget * (1 - reserveFraction);
    const elapsed = (time - window.start) / (window.end - window.start);
    // Linear pace through the month plus one day of slack.
    const pacedTarget = Math.min(spendable, spendable * elapsed + spendable / window.days);
    let mode = BUDGET_MODES.normal;
    if (exhaustedUntil > time || monthCu >= monthlyCuBudget) mode = BUDGET_MODES.exhausted;
    else if (monthCu >= spendable) mode = BUDGET_MODES.criticalOnly;
    else if (monthCu > pacedTarget || dayCu >= dailyCuSoftLimit) mode = BUDGET_MODES.conserve;
    const elapsedMs = Math.max(time - window.start, 3_600_000);
    const projected = Math.round(monthCu / elapsedMs * (window.end - window.start));
    return {
      mode, monthCu, dayCu, monthlyBudget: monthlyCuBudget, reserve: Math.round(monthlyCuBudget * reserveFraction),
      pacedTarget: Math.round(pacedTarget), projectedMonthCu: projected,
      dailyAllowance: Math.round(Math.max(0, spendable - monthCu) / Math.max(1, (window.end - time) / 86_400_000)),
      month: window.key,
    };
  }

  function currentMode() {
    const { mode } = budget();
    if (mode !== lastMode) {
      const previous = lastMode;
      lastMode = mode;
      if (previous !== null) {
        try { onModeChange(mode, previous); } catch { /* observer errors never block RPC */ }
      }
    }
    return mode;
  }

  function chargeCu(method) {
    const time = now();
    const day = new Date(time).toISOString().slice(0, 10);
    const minute = Math.floor(time / 60_000);
    if (usage.day !== day) Object.assign(usage, { day, dayCu: 0, byMethod: {} });
    const month = day.slice(0, 7);
    if (usage.month !== month) Object.assign(usage, { month, monthCu: 0 });
    if (usage.minute !== minute) Object.assign(usage, { minute, minuteCu: 0 });
    const cost = CU_COSTS[method] ?? 20;
    usage.dayCu += cost;
    usage.minuteCu += cost;
    usage.monthCu += cost;
    usage.byMethod[method] = (usage.byMethod[method] || 0) + cost;
  }


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
    const mode = currentMode();
    const time = now();
    const transactionPath = CRITICAL_METHODS.has(method) || method === 'eth_getTransactionReceipt';
    let first = paid;
    let second = pub;
    if (cls === 'read' || (cls === 'logs' && logRange(params) <= SMALL_LOG_RANGE)) [first, second] = [pub, paid];
    // 'fallback' = the browser already tried public RPCs, so go paid-first while the budget allows.
    if (mode === BUDGET_MODES.conserve && !transactionPath) [first, second] = [pub, paid];
    if (mode === BUDGET_MODES.criticalOnly) {
      [first, second] = cls === 'critical' || transactionPath ? [paid, pub] : [pub, []];
    }
    if (mode === BUDGET_MODES.exhausted) {
      // Retry the paid tier once per probe window so a new month or raised cap is picked up.
      const probe = paid.length && exhaustedUntil <= time;
      [first, second] = [pub, probe && (cls === 'critical' || transactionPath) ? paid : []];
    }
    const ordered = [...first, ...second];
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
        const rpcKind = rpcError ? classifyRpcError(rpcError) : '';
        if (rpcKind === 'range' || rpcKind === 'unsupported') throw new RpcAttemptError(rpcError.message, { kind: rpcKind });
        if (rpcKind === 'exhausted') throw new RpcAttemptError(rpcError.message, { kind: endpoint.tier === 'paid' ? 'exhausted' : 'unsupported' });
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
        if (kind === 'exhausted' && endpoint.tier === 'public') throw new RpcAttemptError(body.error.message || 'RPC error', { kind: 'unsupported' });
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
        if (error.kind === 'unsupported') {
          endpoint.lastError = String(error.message).slice(0, 160);
          continue;
        }
        if (error.kind === 'exhausted') {
          exhaustedUntil = now() + exhaustedProbeMs;
          endpoint.lastError = String(error.message).slice(0, 160);
          currentMode();
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
    const cacheMs = method === 'eth_blockNumber' ? 2000
      : method === 'eth_call' && (cls === 'read' || cls === 'fallback') ? (currentMode() === BUDGET_MODES.normal ? readCacheMs : readCacheMs * 6) : 0;
    if (cacheMs) {
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now()) return hit.value;
    }
    if (key && inflight.has(key)) return inflight.get(key);
    const task = (method === 'eth_getLogs' ? getLogs(params) : dispatch(cls, method, params)).then(value => {
      if (cacheMs && !value.error) {
        cache.set(key, { value, expiresAt: now() + cacheMs });
        if (cache.size > 2000) {
          const time = now();
          for (const [entryKey, entry] of cache) if (entry.expiresAt <= time) cache.delete(entryKey);
          while (cache.size > 2000) cache.delete(cache.keys().next().value);
        }
      }
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
      budget: budget(),
      computeUnits: {
        today: usage.day === new Date(time).toISOString().slice(0, 10) ? usage.dayCu : 0,
        lastMinute: usage.minute === Math.floor(time / 60_000) ? usage.minuteCu : 0,
        dailySoftLimit: Number.isFinite(dailyCuSoftLimit) ? dailyCuSoftLimit : null,
        overBudget: currentMode() !== BUDGET_MODES.normal,
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

  function usageSnapshot() {
    return { month: usage.month, monthCu: usage.monthCu, day: usage.day, dayCu: usage.dayCu };
  }

  return { provider, request, health, describe, mode: currentMode, usageSnapshot, restoreUsage };
}
