import { DEVERT_QUEUE_ABI, DEVERT_QUEUE_USDC, purchaseDevertRequest, claimDevertRefund, quoteDevertRequest } from './devert-queue.mjs';
import { USDC_BROWSER_ABI } from './djuke.mjs';
import { formatUsdcUnits } from './usdc-format.mjs?v=20261015-usdc-cents';

export function validateDevertPaidSnapshot(state, configuredAddress) {
  if (state?.configured === false) return state;
  if (!state || state.chainId !== 8453 || !/^0x[0-9a-f]{40}$/i.test(configuredAddress || '') ||
      state.contractAddress?.toLowerCase() !== configuredAddress.toLowerCase() ||
      !Array.isArray(state.requests) || !Array.isArray(state.recentRefunds) ||
      !Array.isArray(state.approvedCampaignIds ?? []) ||
      state.requests.length !== state.pendingCount ||
      String(state.priceUnits) !== quoteDevertRequest(state.pendingCount).toString()) throw new Error('Paid advert queue configuration or quote does not match');
  return state;
}

export function initDevertPaidQueue() {
  const button = document.getElementById('devert-paid-queue-button');
  if (!button) return;
  const price = document.getElementById('devert-paid-price');
  const select = document.getElementById('devert-paid-campaign');
  const list = document.getElementById('devert-paid-requests');
  const refunds = document.getElementById('devert-paid-refunds');
  const status = document.getElementById('devert-paid-status');
  const receipt = document.getElementById('devert-paid-receipt');
  const refundId = document.getElementById('devert-paid-refund-id');
  const refundButton = document.getElementById('devert-paid-refund');
  let snapshot = null;
  let busy = false;
  let generation = 0;
  const config = () => window.DecentConfig || {};
  const address = () => config().devertQueueContractAddress || '';
  const row = (text, parent) => {
    const item = document.createElement('li');
    item.textContent = text;
    parent.append(item);
    return item;
  };
  const link = (parent, txHash, text) => {
    const anchor = document.createElement('a');
    anchor.href = `https://basescan.org/tx/${txHash}`;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = text;
    parent.append(anchor);
  };
  const controls = () => {
    const wallet = window._wallet;
    button.disabled = busy || !snapshot?.paymentsEnabled || !wallet?.signer || wallet.chainId !== 8453 || !select.value;
    refundButton.disabled = busy || !address() || !wallet?.signer || wallet.chainId !== 8453 || !/^\d+$/.test(refundId.value.trim());
  };
  const refresh = async () => {
    if (busy) return;
    const request = ++generation;
    snapshot = null;
    controls();
    const service = (config().ipfsUploadServiceUrl || '').replace(/\/$/, '');
    try {
      let state = { configured: false };
      if (address()) {
        if (!service) throw new Error('Paid advert queue service is not configured');
        const response = await fetch(`${service}/api/devert/queue`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error(`Paid advert queue unavailable (${response.status})`);
        state = validateDevertPaidSnapshot(await response.json(), address());
      }
      if (request !== generation) return;
      if (state.configured === false) {
        price.textContent = 'Not live';
        status.textContent = 'Paid advert requests are not enabled yet. No payment will be requested.';
        list.replaceChildren();
        select.replaceChildren();
        refunds.replaceChildren();
        return;
      }
      const campaignResponse = await fetch(`${service}/api/devert`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      if (!campaignResponse.ok) throw new Error(`Approved adverts unavailable (${campaignResponse.status})`);
      const campaigns = await campaignResponse.json();
      if (campaigns.chainId !== 8453 || !Array.isArray(campaigns.campaigns)) throw new Error('Invalid campaign catalog');
      if (request !== generation) return;
      const previous = select.value;
      select.replaceChildren();
      for (const campaign of campaigns.campaigns) {
        if (!state.approvedCampaignIds?.includes(campaign.campaignId) || campaigns.paused || campaign.removed ||
            Date.parse(campaign.startedAt) > Date.now() || Date.parse(campaign.expiresAt) <= Date.now()) continue;
        const option = document.createElement('option');
        option.value = campaign.campaignId;
        option.textContent = `#${campaign.campaignId} · ${campaign.title}`;
        select.append(option);
      }
      if ([...select.options].some(option => option.value === previous)) select.value = previous;
      list.replaceChildren();
      for (const entry of state.requests) row(`#${entry.chainRequestId} · ${entry.title} · ${formatUsdcUnits(BigInt(entry.amountUnits))} USDC · payer ${entry.payer}`, list);
      if (!state.requests.length) row('No paid advert requests. Ordinary adverts continue on rotation.', list);
      refunds.replaceChildren();
      for (const entry of state.recentRefunds.filter(entry => entry.payer.toLowerCase() === window._wallet?.address?.toLowerCase())) {
        row(`Request #${entry.chainRequestId}: ${formatUsdcUnits(BigInt(entry.amountUnits))} USDC refund available. Enter its request ID below.`, refunds);
      }
      snapshot = state;
      price.textContent = `${formatUsdcUnits(BigInt(state.priceUnits))} USDC`;
      status.textContent = state.paused ? 'Paid advert queue is paused. Removal refunds remain available.'
        : !state.paymentsEnabled ? 'Paid advert checkout is disabled; existing requests are shown read-only.'
        : !select.options.length ? 'No active approved adverts are confirmed yet. Catalog approval may still be syncing.'
        : `${state.pendingCount} pending · FIFO · after the current track · deferred during protected shows.`;
    } catch (error) {
      if (request === generation) {
        snapshot = null;
        price.textContent = 'Unavailable';
        status.textContent = error.message;
      }
    } finally { if (request === generation) controls(); }
  };
  const transact = async refund => {
    if (busy) return;
    busy = true;
    generation++;
    controls();
    try {
      const signer = window._wallet?.signer;
      const walletAddress = window._wallet?.address;
      if (!signer || !address()) throw new Error('Connect a Base wallet and configure the paid advert contract');
      const check = message => {
        if (window._wallet?.signer !== signer || window._wallet?.address !== walletAddress || window._wallet?.chainId !== 8453) {
          throw new Error('Wallet or network changed. Check your pending transaction before retrying.');
        }
        status.textContent = message;
      };
      const queue = new ethers.Contract(address(), DEVERT_QUEUE_ABI, signer);
      if (refund) {
        const txHash = await claimDevertRefund({ signer, queue, requestId: refundId.value.trim(), onStep: check });
        status.textContent = 'Full removal refund confirmed. ';
        link(status, txHash, 'View refund');
      } else {
        if (!snapshot?.paymentsEnabled) throw new Error('Paid advert checkout is not enabled');
        const usdc = new ethers.Contract(DEVERT_QUEUE_USDC, USDC_BROWSER_ABI, signer);
        const result = await purchaseDevertRequest({ signer, queue, usdc, campaignId: select.value,
          maxPriceUnits: BigInt(snapshot.priceUnits), onStep: check });
        refundId.value = result.requestId;
        receipt.textContent = `Paid advert request #${result.requestId} confirmed—not yet played. Keep this ID for refund recovery. `;
        link(receipt, result.txHash, 'View payment receipt');
        status.textContent = 'Payment confirmed. Refresh to see the updated queue.';
      }
    } catch (error) { status.textContent = error.shortMessage || error.message; }
    finally { busy = false; snapshot = null; controls(); }
  };
  button.addEventListener('click', () => transact(false));
  refundButton.addEventListener('click', () => transact(true));
  select.addEventListener('change', controls);
  refundId.addEventListener('input', controls);
  document.getElementById('devert-paid-refresh').addEventListener('click', refresh);
  document.addEventListener('wallet-connected', refresh);
  document.addEventListener('wallet-disconnected', refresh);
  document.addEventListener('wallet-chain-changed', refresh);
  document.addEventListener('left-drawer-open', event => { if (event.detail === 'devert') refresh(); });
  setInterval(() => {
    if (document.getElementById('devert-panel')?.classList.contains('is-open') && !busy) refresh();
  }, 30000);
  controls();
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initDevertPaidQueue, { once: true });
