import { devertQueueAbi, DEVERT_QUEUE_USDC, purchaseDevertRequest, quoteDevertRequest } from './devert-queue.mjs?v=20261017-mercury-release';
import { USDC_BROWSER_ABI } from './usdc-abi.mjs';
import { formatUsdcUnits } from './usdc-format.mjs?v=20261017-mercury-release';

export function validateDevertPaidSnapshot(state, configuredAddress) {
  if (state?.configured === false) return state;
  if (!state || state.chainId !== 8453 || !/^0x[0-9a-f]{40}$/i.test(configuredAddress || '') ||
      state.contractAddress?.toLowerCase() !== configuredAddress.toLowerCase() ||
      !Array.isArray(state.requests) || !Array.isArray(state.recentRefunds) ||
      !Array.isArray(state.approvedCampaignIds ?? []) ||
      state.requests.length !== state.pendingCount ||
      String(state.priceUnits) !== quoteDevertRequest(state.pendingCount).toString()) throw new Error('Paid advert queue configuration or quote does not match');
  if (state.version !== 1 && state.version !== 2) throw new Error('Unsupported paid advert queue version');
  if (state.version === 1 && state.paymentsEnabled) throw new Error('Legacy single-tier checkout must remain disabled');
  if (state.version === 2 && (state.immediatePriceUnits !== quoteDevertRequest(state.pendingCount, 1).toString() ||
      state.requests.some(request => request.tier !== 0 && request.tier !== 1))) throw new Error('Paid advert tier quote does not match');
  return state;
}

export function filterDevertCampaigns(campaigns, query) {
  const term = query.trim().toLowerCase();
  return campaigns.filter(campaign => !term ||
    [campaign.title, campaign.advertiser, campaign.artist, campaign.campaignId]
      .some(value => String(value || '').toLowerCase().includes(term)));
}

export function initDevertPaidQueue(environment = {}) {
  const document = environment.document || globalThis.document;
  const window = environment.window || globalThis.window;
  const ethers = environment.ethers || globalThis.ethers || window?.ethers;
  const fetch = environment.fetch || globalThis.fetch;
  const setInterval = environment.setInterval || globalThis.setInterval;
  const clearInterval = environment.clearInterval || globalThis.clearInterval;
  const listen = environment.listen || ((target, ...args) => target?.addEventListener(...args));
  const button = document.getElementById('devert-paid-queue-button');
  if (!button) return;
  const price = document.getElementById('devert-paid-price');
  const immediateButton = document.getElementById('devert-paid-immediate-button');
  const immediatePrice = document.getElementById('devert-paid-immediate-price');
  const select = document.getElementById('devert-paid-campaign');
  const search = document.getElementById('devert-search');
  const searchStatus = document.getElementById('devert-search-state');
  const count = document.getElementById('devert-paid-count');
  const list = document.getElementById('devert-paid-requests');
  const status = document.getElementById('devert-paid-status');
  const receipt = document.getElementById('devert-paid-receipt');
  let activeCampaigns = [];
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
    button.disabled = busy || snapshot?.version !== 2 || !snapshot?.paymentsEnabled || snapshot.playbackReady === false || !wallet?.signer || wallet.chainId !== 8453 || !select.value;
    immediateButton.disabled = button.disabled;
    const help = busy ? 'Payment in progress'
      : snapshot?.playbackReady === false ? snapshot.playbackReason || 'Paid playback unavailable'
      : !snapshot?.paymentsEnabled ? 'Priority checkout is not live yet'
        : !wallet?.signer ? 'Connect your Base wallet to queue an advert'
          : wallet.chainId !== 8453 ? 'Switch your wallet to Base'
            : !select.value ? 'Choose an active advert first' : '';
    button.title = help || 'Queue bump: next normal advert break. Does not buy or extend a campaign.';
    immediateButton.title = help || 'Pay 2× for an extra break after this song. Protected shows finish first.';
  };
  const renderCampaigns = () => {
    const previous = select.value;
    const visible = filterDevertCampaigns(activeCampaigns, search.value);
    select.replaceChildren();
    for (const campaign of visible) {
      const option = document.createElement('option');
      option.value = campaign.campaignId;
      option.textContent = campaign.title;
      option.title = `Campaign #${campaign.campaignId} · ${campaign.advertiser}`;
      select.append(option);
    }
    if (!visible.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = activeCampaigns.length ? 'No matching adverts' : 'No active approved adverts';
      select.append(option);
    } else if (visible.some(campaign => campaign.campaignId === previous)) select.value = previous;
    select.disabled = !visible.length;
    searchStatus.textContent = search.value.trim()
      ? `${visible.length} matching advert${visible.length === 1 ? '' : 's'}` : '';
    controls();
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
        immediatePrice.textContent = 'Not live';
        status.textContent = 'Paid advert requests are not enabled yet. No payment will be requested.';
        count.textContent = '—';
        list.replaceChildren();
        activeCampaigns = [];
        renderCampaigns();
        return;
      }
      const campaignResponse = await fetch(`${service}/api/devert`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      if (!campaignResponse.ok) throw new Error(`Approved adverts unavailable (${campaignResponse.status})`);
      const campaigns = await campaignResponse.json();
      if (campaigns.chainId !== 8453 || !Array.isArray(campaigns.campaigns)) throw new Error('Invalid campaign catalog');
      if (request !== generation) return;
      activeCampaigns = campaigns.campaigns.filter(campaign =>
        state.approvedCampaignIds?.includes(campaign.campaignId) && !campaigns.paused && !campaign.removed &&
        Date.parse(campaign.startedAt) <= Date.now() && Date.parse(campaign.expiresAt) > Date.now());
      renderCampaigns();
      list.replaceChildren();
      for (const entry of [...state.requests].sort((a, b) => b.tier - a.tier || Number(a.chainRequestId) - Number(b.chainRequestId))) {
        const item = row('', list);
        item.title = `Request #${entry.chainRequestId} · payer ${entry.payer}`;
        const title = document.createElement('strong');
        title.textContent = entry.title;
        const detail = document.createElement('span');
        detail.textContent = `${entry.tier === 0 ? 'Next ad break' : 'After this song'} · ${formatUsdcUnits(BigInt(entry.amountUnits))} USDC`;
        item.append(title, detail);
      }
      if (!state.requests.length) row('No paid requests', list);
      snapshot = state;
      count.textContent = String(state.pendingCount);
      price.textContent = formatUsdcUnits(BigInt(state.priceUnits));
      immediatePrice.textContent = state.version === 2 ? formatUsdcUnits(BigInt(state.immediatePriceUnits)) : 'Not live';
      status.textContent = state.playbackReady === false
        ? `${state.playbackReason || 'Paid playback unavailable'}. Existing payments remain queued; checkout is temporarily disabled.`
        : state.paused ? 'Priority queue paused.'
        : state.version !== 2 || !state.paymentsEnabled ? 'Priority checkout not live yet.'
        : !activeCampaigns.length ? 'No active approved adverts yet.'
        : !window._wallet?.signer ? 'Connect a Base wallet to queue an ad.' : '';
    } catch (error) {
      if (request === generation) {
        snapshot = null;
        price.textContent = 'Unavailable';
        immediatePrice.textContent = 'Unavailable';
        count.textContent = '—';
        list.replaceChildren();
        activeCampaigns = [];
        renderCampaigns();
        status.textContent = error.message;
      }
    } finally { if (request === generation) controls(); }
  };
  const transact = async (tier = 0) => {
    if (busy) return;
    busy = true;
    generation++;
    controls();
    try {
      const signer = environment.getSigner ? await environment.getSigner() : window._wallet?.signer;
      const walletAddress = window._wallet?.address;
      if (!signer || !address()) throw new Error('Connect a Base wallet and configure the paid advert contract');
      const check = message => {
        if (window._wallet?.signer !== signer || window._wallet?.address !== walletAddress || window._wallet?.chainId !== 8453) {
          throw new Error('Wallet or network changed. Check your pending transaction before retrying.');
        }
        status.textContent = message;
      };
      const queue = new ethers.Contract(address(), devertQueueAbi(snapshot?.version ?? 1), signer);
      if (!snapshot?.paymentsEnabled) throw new Error('Paid advert checkout is not enabled');
      const usdc = new ethers.Contract(DEVERT_QUEUE_USDC, USDC_BROWSER_ABI, signer);
      const result = await purchaseDevertRequest({ signer, queue, usdc, campaignId: select.value,
        tier, maxPriceUnits: BigInt(tier === 1 ? snapshot.immediatePriceUnits : snapshot.priceUnits), onStep: check,
        onConfirmed: environment.onConfirmed });
      receipt.textContent = `Request #${result.requestId} queued${tier === 1 ? ' for after-song priority' : ' for the next normal ad break'}. Funds are distributed automatically after completed playback. `;
      link(receipt, result.txHash, 'View payment receipt');
      busy = false;
      await refresh();
    } catch (error) {
      snapshot = null;
      status.textContent = error.shortMessage || error.message;
    }
    finally { busy = false; controls(); }
  };
  listen(button, 'click', () => transact());
  listen(immediateButton, 'click', () => transact(1));
  listen(select, 'change', controls);
  listen(search, 'input', renderCampaigns);
  listen(document.getElementById('devert-paid-refresh'), 'click', refresh);
  listen(document, 'wallet-connected', refresh);
  listen(document, 'wallet-disconnected', refresh);
  listen(document, 'wallet-chain-changed', refresh);
  listen(document, 'left-drawer-open', event => { if (event.detail === 'devert') refresh(); });
  const timer = setInterval(() => {
    if (document.getElementById('devert-panel')?.classList.contains('is-open') && !busy) refresh();
  }, 30000);
  controls();
  return { refresh, destroy() { generation++; clearInterval(timer); } };
}
