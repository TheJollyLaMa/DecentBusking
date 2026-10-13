import { Contract, Transaction } from 'ethers';
import { DJUKE_SIGNING_DOMAIN_VERSION } from '../js/djuke-version.mjs';

export const GAS_QUOTE_TYPES = { GasQuote: [
  { name: 'listener', type: 'address' }, { name: 'songId', type: 'bytes32' }, { name: 'maxPrice', type: 'uint256' },
  { name: 'fulfillmentCostWei', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
] };

export const DJUKE_GAS_ABI = [
  'function gasWorker() view returns(address)', 'function maxGasContributionWei() view returns(uint256)',
  'function gasQuoteNonces(address) view returns(uint256)',
  'function requestPlayWithGas(bytes32,uint256,uint256,uint256,bytes) payable returns(uint256)',
];

// The L1 fee only depends on serialized size, so a wide placeholder nonce sizes the
// fulfillment conservatively without an extra eth_getTransactionCount per quote.
const SIZING_NONCE = 0xffffffff;

export function isRpcRateLimit(error) {
  const codes = [error?.code, error?.error?.code, error?.info?.error?.code];
  return codes.includes(-32007) || codes.includes(-32005) || codes.includes(429) ||
    /request limit|rate limit|too many requests|\b429\b/i.test(`${error?.shortMessage || ''} ${error?.message || ''} ${error?.error?.message || ''}`);
}

export async function withRpcRetry(task, { attempts = 4, delayMs = 400, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= attempts || !isRpcRateLimit(error)) throw error;
      await sleep(delayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * delayMs));
    }
  }
}

function cached(load, ttlMs, now) {
  let value, at = -Infinity, pending = null;
  return () => {
    if (now() - at < ttlMs) return Promise.resolve(value);
    pending ||= load().then(result => { value = result; at = now(); return result; }).finally(() => { pending = null; });
    return pending;
  };
}

export function createDjukeGasQuoteReader({ provider, contract, signer, fulfillmentGasUnits = 1000000n, oracle,
  now = () => Date.now(), staticCacheMs = 300000, feeCacheMs = 10000, retry = {} }) {
  const gasLimit = BigInt(fulfillmentGasUnits);
  if (gasLimit < 100000n || gasLimit > 2000000n) throw new Error('Invalid fulfillment gas budget');
  const feeOracle = oracle || new Contract('0x420000000000000000000000000000000000000F', ['function getL1Fee(bytes) view returns(uint256)'], provider);
  const call = task => withRpcRetry(task, retry);
  const readStatic = cached(async () => {
    if (Number((await call(() => provider.getNetwork())).chainId) !== 8453) throw new Error('Gas funding is Base-only');
    const [worker, expectedWorker, cap] = await Promise.all([signer.getAddress(), call(() => contract.gasWorker()),
      call(() => contract.maxGasContributionWei())]);
    if (expectedWorker.toLowerCase() !== worker.toLowerCase()) throw new Error('Gas quote signer does not match contract worker');
    return { worker, cap };
  }, staticCacheMs, now);
  const readFees = cached(() => call(() => provider.getFeeData()), feeCacheMs, now);
  const inFlight = new Map();
  async function buildQuote({ listener, songId }) {
    const { worker, cap } = await readStatic();
    const [nonce, maxPrice, song, fees, requestId] = await Promise.all([
      call(() => contract.gasQuoteNonces(listener)), call(() => contract.quote()), call(() => contract.getSong(songId)),
      readFees(), call(() => contract.nextRequestId()),
    ]);
    if (!song.enabled) throw new Error('Song is not registered for DJuke');
    const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice;
    if (!maxFeePerGas || maxFeePerGas <= 0n) throw new Error('Gas price unavailable');
    const data = contract.interface.encodeFunctionData('fulfill', [requestId, songId, 0, `0x${'ff'.repeat(32)}`]);
    const transaction = Transaction.from({ type: 2, chainId: 8453, to: contract.target, gasLimit, nonce: SIZING_NONCE,
      maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n, data });
    const l1Fee = await call(() => feeOracle.getL1Fee(transaction.unsignedSerialized));
    const fulfillmentCostWei = gasLimit * maxFeePerGas + l1Fee;
    if (fulfillmentCostWei <= 0n || fulfillmentCostWei * 2n > cap) throw new Error('Estimated worker gas exceeds the contract cap');
    const deadline = Math.floor(now() / 1000) + 120;
    const quote = { listener, songId, maxPrice: maxPrice.toString(), fulfillmentCostWei: fulfillmentCostWei.toString(),
      nonce: nonce.toString(), deadline };
    const domain = { name: 'DecentJukeBox', version: DJUKE_SIGNING_DOMAIN_VERSION, chainId: 8453, verifyingContract: contract.target };
    const signature = await signer.signTypedData(domain, GAS_QUOTE_TYPES, quote);
    return { ...quote, signature, contractAddress: contract.target, worker, contributionWei: (fulfillmentCostWei * 2n).toString(),
      executionGasBudget: gasLimit.toString(), estimatedL1FeeWei: l1Fee.toString(), chainId: 8453 };
  }
  return ({ listener, songId }) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(listener || '') || !/^0x[0-9a-fA-F]{64}$/.test(songId || '')) {
      return Promise.reject(new Error('Invalid gas quote identity'));
    }
    const key = `${listener.toLowerCase()}:${songId.toLowerCase()}`;
    if (!inFlight.has(key)) inFlight.set(key, buildQuote({ listener, songId }).finally(() => inFlight.delete(key)));
    return inFlight.get(key);
  };
}