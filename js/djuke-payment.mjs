import { approvalNotice, ensureBaseNetwork, retryMissingRevertData, waitForAllowance } from './base-chain.mjs';
import { formatUsdcUnits } from './usdc-format.mjs';
import { DJUKE_SIGNING_DOMAIN_VERSION } from './djuke-version.mjs';

export const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const DJUKE_BROWSER_ABI = [
  'function CONTRACT_VERSION() view returns(string)',
  'function quote() view returns (uint256)',
  'function requestPlay(bytes32 songId, uint256 maxPrice) returns (uint256)',
  'function replaceRequest(uint256 requestId, bytes32 songId)',
  'function gasWorker() view returns(address)',
  'function maxGasContributionWei() view returns(uint256)',
  'function gasQuoteNonces(address) view returns(uint256)',
  'function requestPlayWithGas(bytes32,uint256,uint256,uint256,bytes) payable returns(uint256)',
];

// Both the platform drawer and the standalone widget use this checkout boundary.
export async function purchaseDjukeSong({ signer, djuke, usdc, songId, maxPriceUnits, gasQuote = null,
  ethers: library = globalThis.ethers, onStep = () => {}, signal, ensureChain = ensureBaseNetwork }) {
  signal?.throwIfAborted();
  await ensureChain(signer.provider);
  if (usdc.target.toLowerCase() !== BASE_USDC_ADDRESS.toLowerCase() || Number(await usdc.decimals()) !== 6) throw new Error('Configured token is not native Base USDC');
  if (!/^0x[0-9a-fA-F]{64}$/.test(songId || '')) throw new Error('Select a song');
  const address = await signer.getAddress();
  const price = await djuke.quote();
  if (price > maxPriceUnits) throw new Error(`Price rose to ${formatUsdcUnits(price)} USDC; refresh and try again`);
  if (await usdc.balanceOf(address) < price) throw new Error(`You need ${formatUsdcUnits(price)} USDC on Base`);
  if (gasQuote) {
    if (gasQuote.listener.toLowerCase() !== address.toLowerCase() || gasQuote.songId !== songId ||
        gasQuote.contractAddress.toLowerCase() !== djuke.target.toLowerCase() || gasQuote.chainId !== 8453 ||
        Number(gasQuote.deadline) <= Math.floor(Date.now() / 1000) || BigInt(gasQuote.maxPrice) !== maxPriceUnits) throw new Error('Refresh the DJuke payment quote');
    const [worker, cap, nonce] = await Promise.all([djuke.gasWorker(), djuke.maxGasContributionWei(), djuke.gasQuoteNonces(address)]);
    const contribution = BigInt(gasQuote.contributionWei);
    const version = await djuke.CONTRACT_VERSION();
    if (version === '0.5' && (contribution !== 0n || BigInt(gasQuote.fulfillmentCostWei) !== 0n)) throw new Error('DJuke v0.5 requires a verified USDC-only purchase quote');
    const sponsored = contribution === 0n && BigInt(gasQuote.fulfillmentCostWei) === 0n && version === '0.5';
    if ((!sponsored && contribution <= 0n) || contribution !== BigInt(gasQuote.fulfillmentCostWei) * 2n ||
        contribution > cap || String(nonce) !== String(gasQuote.nonce)) throw new Error('Invalid DJuke payment quote');
    const types = { GasQuote: [{ name: 'listener', type: 'address' }, { name: 'songId', type: 'bytes32' },
      { name: 'maxPrice', type: 'uint256' }, { name: 'fulfillmentCostWei', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' }] };
    const recovered = library.verifyTypedData({ name: 'DecentJukeBox', version: DJUKE_SIGNING_DOMAIN_VERSION, chainId: 8453,
      verifyingContract: djuke.target }, types, gasQuote, gasQuote.signature);
    if (recovered.toLowerCase() !== worker.toLowerCase()) throw new Error('Invalid DJuke payment signature');
    if (contribution > 0n && await signer.provider.getBalance(address) < contribution) throw new Error('Insufficient Base ETH for the legacy playback contribution');
  }
  if (await usdc.allowance(address, djuke.target) < price) {
    signal?.throwIfAborted();
    onStep(approvalNotice(formatUsdcUnits(price), { workerContribution: gasQuote !== null && BigInt(gasQuote.contributionWei) > 0n }));
    if ((await (await usdc.approve(djuke.target, price)).wait())?.status !== 1) throw new Error('USDC approval did not confirm');
    onStep('Confirming approval…');
    await waitForAllowance(usdc, address, djuke.target, price);
  }
  const args = gasQuote ? [songId, maxPriceUnits, BigInt(gasQuote.fulfillmentCostWei), gasQuote.deadline, gasQuote.signature,
    { value: BigInt(gasQuote.contributionWei) }] : [songId, maxPriceUnits];
  const request = gasQuote ? djuke.requestPlayWithGas : djuke.requestPlay;
  onStep('Creating request…');
  await retryMissingRevertData(() => request.staticCall(...args), async () => {
    onStep('Confirming approval…');
    await waitForAllowance(usdc, address, djuke.target, price);
  });
  onStep('Confirm your DJuke request');
  signal?.throwIfAborted();
  const transaction = await request(...args);
  onStep('Waiting for Base confirmation…');
  if ((await transaction.wait())?.status !== 1) throw new Error('DJuke request did not confirm');
  return { txHash: transaction.hash, priceUnits: price };
}

export async function replaceDjukeSong({ signer, djuke, chainRequestId, songId, signal }) {
  signal?.throwIfAborted();
  if (Number((await signer.provider.getNetwork()).chainId) !== 8453) throw new Error('Switch your wallet to Base');
  await djuke.replaceRequest.staticCall(BigInt(chainRequestId), songId);
  signal?.throwIfAborted();
  const transaction = await djuke.replaceRequest(BigInt(chainRequestId), songId);
  if ((await transaction.wait())?.status !== 1) throw new Error('Replacement did not confirm');
  return transaction.hash;
}
