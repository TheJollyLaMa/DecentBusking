import { ensureBaseNetwork, approvalNotice, waitForAllowance } from './base-chain.mjs';
import { formatUsdcUnits } from './usdc-format.mjs?v=20261015-usdc-cents';

export const DEVERT_QUEUE_ABI = [
  'function quote() view returns(uint256)',
  'function paused() view returns(bool)',
  'function paymentToken() view returns(address)',
  'function campaigns() view returns(address)',
  'function hasRole(bytes32,address) view returns(bool)',
  'function FULFILLER_ROLE() view returns(bytes32)',
  'function pendingCount() view returns(uint256)',
  'function headRequestId() view returns(uint256)',
  'function nextRequestId() view returns(uint256)',
  'function removedCampaigns(uint256) view returns(bool)',
  'function approvedCampaigns(uint256) view returns(bool)',
  'function approveCampaign(uint256)',
  'function getRequest(uint256) view returns((uint256 campaignId,address payer,uint256 amount,uint8 status,string title,string audioURI,address advertiser))',
  'function requestAd(uint256 campaignId,uint256 maxPrice) returns(uint256)',
  'function fulfill(uint256 requestId,bytes32 playbackProof)',
  'function removeCampaign(uint256 campaignId)',
  'function claimRefund(uint256 requestId)',
  'event AdRequested(uint256 indexed requestId,uint256 indexed campaignId,address indexed payer,uint256 amount)',
  'event AdFulfilled(uint256 indexed requestId,bytes32 indexed playbackProof)',
  'event AdRefunded(uint256 indexed requestId,address indexed payer,uint256 amount)',
];
export const DEVERT_QUEUE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export function quoteDevertRequest(count) {
  if (!Number.isSafeInteger(count) || count < 0 || count > 128) throw new Error('Invalid paid advert queue count');
  return 1_000_000n * 2n ** BigInt(Math.floor(count / 7));
}

export async function purchaseDevertRequest({ signer, queue, usdc, campaignId, maxPriceUnits, onStep = () => {} }) {
  await ensureBaseNetwork(signer.provider);
  if (!/^\d+$/.test(String(campaignId)) || typeof maxPriceUnits !== 'bigint' || maxPriceUnits <= 0n) throw new Error('Choose an active advert and refresh its queue price');
  if (String(usdc.target).toLowerCase() !== DEVERT_QUEUE_USDC.toLowerCase() ||
      String(await queue.paymentToken()).toLowerCase() !== DEVERT_QUEUE_USDC.toLowerCase() ||
      Number(await usdc.decimals()) !== 6) throw new Error('Native Base USDC required');
  const address = await signer.getAddress();
  const price = BigInt(await queue.quote());
  if (price > maxPriceUnits) throw new Error('Paid advert queue price increased; refresh before paying');
  if (await usdc.balanceOf(address) < price) throw new Error(`You need ${formatUsdcUnits(price)} USDC on Base`);
  if (await usdc.allowance(address, queue.target) < price) {
    onStep(approvalNotice(formatUsdcUnits(price)));
    if ((await (await usdc.approve(queue.target, price)).wait(2))?.status !== 1) throw new Error('USDC approval did not confirm');
    await waitForAllowance(usdc, address, queue.target, price);
  }
  onStep('Checking the paid advert request…');
  await queue.requestAd.staticCall(BigInt(campaignId), maxPriceUnits);
  onStep('Confirm your paid advert request in the wallet…');
  const transaction = await queue.requestAd(BigInt(campaignId), maxPriceUnits);
  onStep(`Request pending: ${transaction.hash}`);
  const receipt = await transaction.wait(2);
  if (receipt?.status !== 1) throw new Error(`Paid advert request failed: ${transaction.hash}`);
  const event = receipt.logs.filter(log => log.address.toLowerCase() === queue.target.toLowerCase())
    .map(log => queue.interface.parseLog(log)).find(log => log?.name === 'AdRequested');
  if (!event) throw new Error(`Payment confirmed but request receipt needs reconciliation: ${transaction.hash}`);
  return { txHash: transaction.hash, requestId: event.args.requestId.toString(), priceUnits: price };
}

export async function claimDevertRefund({ signer, queue, requestId, onStep = () => {} }) {
  await ensureBaseNetwork(signer.provider);
  if (!/^\d+$/.test(String(requestId))) throw new Error('Enter the numeric request ID from your payment receipt');
  const request = await queue.getRequest(BigInt(requestId));
  if (request.payer.toLowerCase() !== (await signer.getAddress()).toLowerCase()) throw new Error('Only the paying wallet can claim this refund');
  if (Number(request.status) !== 0 || !await queue.removedCampaigns(request.campaignId)) throw new Error('This request has no removal refund available');
  onStep('Confirm your full USDC refund in the wallet…');
  const tx = await queue.claimRefund(BigInt(requestId));
  onStep(`Refund pending: ${tx.hash}`);
  if ((await tx.wait(2))?.status !== 1) throw new Error(`Refund failed: ${tx.hash}`);
  return tx.hash;
}
