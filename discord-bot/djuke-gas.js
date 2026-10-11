import { Contract, Transaction } from 'ethers';

export const GAS_QUOTE_TYPES = { GasQuote: [
  { name: 'listener', type: 'address' }, { name: 'songId', type: 'bytes32' }, { name: 'maxPrice', type: 'uint256' },
  { name: 'fulfillmentCostWei', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
] };

export const DJUKE_GAS_ABI = [
  'function gasWorker() view returns(address)', 'function maxGasContributionWei() view returns(uint256)',
  'function gasQuoteNonces(address) view returns(uint256)',
  'function requestPlayWithGas(bytes32,uint256,uint256,uint256,bytes) payable returns(uint256)',
];

export function createDjukeGasQuoteReader({ provider, contract, signer, fulfillmentGasUnits = 1000000n, oracle,
  now = () => Date.now() }) {
  const gasLimit = BigInt(fulfillmentGasUnits);
  if (gasLimit < 100000n || gasLimit > 2000000n) throw new Error('Invalid fulfillment gas budget');
  const feeOracle = oracle || new Contract('0x420000000000000000000000000000000000000F', ['function getL1Fee(bytes) view returns(uint256)'], provider);
  return async ({ listener, songId }) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(listener || '') || !/^0x[0-9a-fA-F]{64}$/.test(songId || '')) throw new Error('Invalid gas quote identity');
    if (Number((await provider.getNetwork()).chainId) !== 8453) throw new Error('Gas funding is Base-only');
    const worker = await signer.getAddress();
    const [expectedWorker, cap, nonce, maxPrice, song, fees, requestId, workerNonce] = await Promise.all([
      contract.gasWorker(), contract.maxGasContributionWei(), contract.gasQuoteNonces(listener), contract.quote(), contract.getSong(songId),
      provider.getFeeData(), contract.nextRequestId(), provider.getTransactionCount(worker),
    ]);
    if (expectedWorker.toLowerCase() !== worker.toLowerCase()) throw new Error('Gas quote signer does not match contract worker');
    if (!song.enabled) throw new Error('Song is not registered for DJuke');
    const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice;
    if (!maxFeePerGas || maxFeePerGas <= 0n) throw new Error('Gas price unavailable');
    const data = contract.interface.encodeFunctionData('fulfill', [requestId, songId, 0, `0x${'ff'.repeat(32)}`]);
    const transaction = Transaction.from({ type: 2, chainId: 8453, to: contract.target, gasLimit, nonce: workerNonce,
      maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n, data });
    const l1Fee = await feeOracle.getL1Fee(transaction.unsignedSerialized);
    const fulfillmentCostWei = gasLimit * maxFeePerGas + l1Fee;
    if (fulfillmentCostWei <= 0n || fulfillmentCostWei * 2n > cap) throw new Error('Estimated worker gas exceeds the contract cap');
    const deadline = Math.floor(now() / 1000) + 120;
    const quote = { listener, songId, maxPrice: maxPrice.toString(), fulfillmentCostWei: fulfillmentCostWei.toString(),
      nonce: nonce.toString(), deadline };
    const domain = { name: 'DecentJukeBox', version: '0.2', chainId: 8453, verifyingContract: contract.target };
    const signature = await signer.signTypedData(domain, GAS_QUOTE_TYPES, quote);
    return { ...quote, signature, contractAddress: contract.target, worker, contributionWei: (fulfillmentCostWei * 2n).toString(),
      executionGasBudget: gasLimit.toString(), estimatedL1FeeWei: l1Fee.toString(), chainId: 8453 };
  };
}