// Read-only Base JSON-RPC proxy for browsers whose public RPC calls failed (#205).
// The paid key never leaves the worker; strict allow-lists and rate limits keep it from becoming an open relay.

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const BLOCK_TAG = /^(latest|safe|finalized|0x[0-9a-fA-F]{1,16})$/;
export const RPC_PROXY_MAX_BATCH = 10;

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export function createRpcProxy({
  request,
  allowedContracts = [],
  perIpPerMinute = 120,
  globalPerMinute = 1500,
  now = () => Date.now(),
}) {
  const contracts = new Set(allowedContracts.filter(Boolean).map(address => String(address).toLowerCase()));
  const perIp = new Map();
  let globalWindow = { minute: 0, count: 0 };

  function validate(method, params) {
    if (!Array.isArray(params)) return 'params must be an array';
    switch (method) {
      case 'eth_chainId':
      case 'eth_blockNumber':
        return params.length ? 'unexpected params' : '';
      case 'eth_call': {
        const [call, tag = 'latest'] = params;
        if (!call || typeof call !== 'object' || !ADDRESS.test(call.to || '')) return 'eth_call needs a contract address';
        if (!contracts.has(call.to.toLowerCase())) return 'contract is not allow-listed';
        if (call.data != null && !/^0x[0-9a-fA-F]*$/.test(call.data)) return 'invalid call data';
        if (String(call.data || '').length > 8 * 1024) return 'call data too large';
        if (params.length > 2 || !BLOCK_TAG.test(String(tag))) return 'invalid block tag';
        return '';
      }
      case 'eth_getCode':
        if (!ADDRESS.test(params[0] || '') || !contracts.has(params[0].toLowerCase())) return 'contract is not allow-listed';
        return params.length <= 2 && BLOCK_TAG.test(String(params[1] ?? 'latest')) ? '' : 'invalid block tag';
      case 'eth_getBalance':
        return ADDRESS.test(params[0] || '') && params.length <= 2 && BLOCK_TAG.test(String(params[1] ?? 'latest')) ? '' : 'invalid params';
      case 'eth_getTransactionReceipt':
        return params.length === 1 && HASH.test(params[0] || '') ? '' : 'invalid transaction hash';
      case 'eth_getBlockByNumber':
        return params.length === 2 && BLOCK_TAG.test(String(params[0])) && params[1] === false ? '' : 'only block headers are available';
      default:
        return 'method is not available through the DecentBusking proxy';
    }
  }

  function take(ip, count) {
    const minute = Math.floor(now() / 60_000);
    if (globalWindow.minute !== minute) globalWindow = { minute, count: 0 };
    if (perIp.size > 5000) for (const [key, entry] of perIp) if (entry.minute !== minute) perIp.delete(key);
    const entry = perIp.get(ip)?.minute === minute ? perIp.get(ip) : { minute, count: 0 };
    if (entry.count + count > perIpPerMinute || globalWindow.count + count > globalPerMinute) return false;
    entry.count += count;
    globalWindow.count += count;
    perIp.set(ip, entry);
    return true;
  }

  async function one(item) {
    if (!item || typeof item !== 'object' || item.jsonrpc !== '2.0' || typeof item.method !== 'string') {
      return rpcError(item?.id, -32600, 'Invalid request');
    }
    const params = item.params ?? [];
    const problem = validate(item.method, params);
    if (problem) return rpcError(item.id, -32601, problem);
    try {
      const outcome = await request(item.method, params);
      return outcome.error
        ? { jsonrpc: '2.0', id: item.id, error: outcome.error }
        : { jsonrpc: '2.0', id: item.id, result: outcome.result };
    } catch (error) {
      return rpcError(item.id, -32603, `Base RPC unavailable: ${String(error.message || error).slice(0, 120)}`);
    }
  }

  async function handle(body, ip = 'unknown') {
    const batch = Array.isArray(body);
    const items = batch ? body : [body];
    if (!items.length || items.length > RPC_PROXY_MAX_BATCH) {
      return { status: 400, body: rpcError(null, -32600, `Send 1-${RPC_PROXY_MAX_BATCH} requests per batch`) };
    }
    if (!take(ip, items.length)) return { status: 429, body: rpcError(null, -32005, 'Rate limit reached; try again shortly') };
    const results = await Promise.all(items.map(one));
    return { status: 200, body: batch ? results : results[0] };
  }

  return { handle };
}
