import { canSetDevertListenMode, getDevertAdsMuted, setDevertAdsMuted, setDevertListenMode } from './radio-sync.js';

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function formatUsdc(units) {
  try {
    const amount = BigInt(units);
    const whole = amount / 1_000_000n;
    const fraction = String(amount % 1_000_000n).padStart(6, '0').replace(/0+$/, '');
    return `${whole}${fraction ? `.${fraction}` : ''} USDC offer`;
  } catch {
    return 'Offer unavailable';
  }
}

function formatEth(units) {
  const amount = BigInt(units);
  const whole = amount / 1_000_000_000_000_000_000n;
  const fraction = String(amount % 1_000_000_000_000_000_000n).padStart(18, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} ETH`;
}

async function getSchedulerTopUpQuote(signer, contract, advertiser) {
  const feeData = await signer.provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (typeof maxFeePerGas !== 'bigint' || maxFeePerGas <= 0n) throw new Error('Current Base gas fee is unavailable');
  const amount = await contract.quoteSchedulerGasTopUp(maxFeePerGas);
  if (await signer.provider.getBalance(advertiser) < amount) {
    throw new Error(`Insufficient Base ETH for the scheduler top-up (${formatEth(amount)}); transaction gas is additional`);
  }
  const overrides = { value: amount };
  if (feeData.maxFeePerGas != null) {
    overrides.maxFeePerGas = feeData.maxFeePerGas;
    if (feeData.maxPriorityFeePerGas != null) overrides.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
  } else {
    overrides.gasPrice = feeData.gasPrice;
  }
  return { amount, overrides };
}

function activeCampaigns(snapshot, now = Date.now()) {
  if (!snapshot || snapshot.chainId !== 8453 || !Array.isArray(snapshot.campaigns)) return [];
  return snapshot.campaigns.filter(campaign => {
    const start = Date.parse(campaign.startedAt);
    const end = Date.parse(campaign.expiresAt);
    return Number.isFinite(start) && Number.isFinite(end) && start <= now && now < end;
  }).sort((first, second) => Number(second.djukeBoosts || 0) - Number(first.djukeBoosts || 0) ||
    Number(first.mainRadioPlays || 0) - Number(second.mainRadioPlays || 0) ||
    (BigInt(second.offerUnits) > BigInt(first.offerUnits) ? 1 : BigInt(second.offerUnits) < BigInt(first.offerUnits) ? -1 : 0));
}

export function seatedDevertPreviewCampaigns(snapshot, now = Date.now()) {
  if (!snapshot || snapshot.paused !== false || !snapshot.market) return [];
  const slots = Number(snapshot.market.slots);
  const seated = Number(snapshot.market.seated);
  if (!Number.isSafeInteger(slots) || !Number.isSafeInteger(seated) || slots <= 0 || seated <= 0) return [];
  return activeCampaigns(snapshot, now).slice(0, seated);
}

export const DEVERT_BROWSER_ABI = [
  'function campaignWeek(uint256 timestamp) pure returns(uint64)',
  'function quoteCampaign(uint64 weekId) view returns(uint128 minimumOfferUnits,uint256 bumpedCampaignId)',
  'function quoteSchedulerGasTopUp(uint256 maxFeePerGas) pure returns(uint256)',
  'function createCampaign(string title,string audioURI,uint128 offerUnits,uint128 maxPaymentUnits) payable returns(uint256)',
];
export const DEVERT_USDC_ABI = [
  'function decimals() view returns(uint8)',
  'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)',
];
export const DEVERT_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export async function purchaseDevertCampaign({ signer, contract, usdc, title, audioURI, offerUnits, maxPaymentUnits, onStep = () => {} }) {
  if (Number((await signer.provider.getNetwork()).chainId) !== 8453) throw new Error('Switch your wallet to Base');
  if (usdc.target.toLowerCase() !== DEVERT_USDC_ADDRESS.toLowerCase() || Number(await usdc.decimals()) !== 6) {
    throw new Error('Configured token is not native Base USDC');
  }
  if (typeof offerUnits !== 'bigint' || typeof maxPaymentUnits !== 'bigint' || offerUnits < 5_000_000n || offerUnits > maxPaymentUnits) {
    throw new Error('Offer must be at least 5 USDC and no greater than your maximum');
  }
  const campaignTitle = String(title || '').trim();
  const mediaUri = String(audioURI || '').trim();
  if (!campaignTitle || campaignTitle.length > 160 || !mediaUri.startsWith('ipfs://') || mediaUri.length > 256) {
    throw new Error('Enter a campaign title and valid IPFS audio URI');
  }
  const block = await signer.provider.getBlock('latest');
  const weekId = await contract.campaignWeek(block.timestamp);
  const quote = await contract.quoteCampaign(weekId);
  if (offerUnits < quote.minimumOfferUnits) throw new Error(`Current minimum offer is ${formatUsdc(quote.minimumOfferUnits.toString())}`);
  const advertiser = await signer.getAddress();
  if (await usdc.balanceOf(advertiser) < offerUnits) throw new Error('Insufficient Base USDC balance');
  let gasQuote = await getSchedulerTopUpQuote(signer, contract, advertiser);
  if (await usdc.allowance(advertiser, contract.target) < offerUnits) {
    onStep(`Approve exactly ${formatUsdc(offerUnits.toString())}; estimated scheduler top-up ${formatEth(gasQuote.amount)} plus transaction gas`);
    const approval = await usdc.approve(contract.target, offerUnits);
    if ((await approval.wait())?.status !== 1) throw new Error('USDC approval did not confirm');
  }
  gasQuote = await getSchedulerTopUpQuote(signer, contract, advertiser);
  await contract.createCampaign.staticCall(campaignTitle, mediaUri, offerUnits, maxPaymentUnits, gasQuote.overrides);
  onStep(`Confirm the seven-day campaign purchase: ${formatUsdc(offerUnits.toString())} plus ${formatEth(gasQuote.amount)} scheduler top-up; transaction gas is separate`);
  const transaction = await contract.createCampaign(campaignTitle, mediaUri, offerUnits, maxPaymentUnits, gasQuote.overrides);
  onStep('Waiting for Base confirmation…');
  if ((await transaction.wait())?.status !== 1) throw new Error('Campaign purchase did not confirm');
  return transaction.hash;
}

export function initDevertTab() {
  const panel = document.getElementById('devert-panel');
  const toggle = document.getElementById('devert-tab');
  if (!panel || !toggle) return;
  const closeButton = document.getElementById('devert-close');
  const refreshButton = document.getElementById('devert-refresh');
  const campaignList = document.getElementById('devert-campaigns');
  const campaignStatus = document.getElementById('devert-campaign-status');
  const radioStatus = document.getElementById('devert-radio-status');
  const purchaseForm = document.getElementById('devert-purchase-form');
  const purchaseButton = document.getElementById('devert-purchase');
  const purchaseStatus = document.getElementById('devert-purchase-status');
  const minimumOffer = document.getElementById('devert-minimum-offer');
  const walletButton = document.getElementById('devert-connect-wallet');
  const radioModeButton = document.getElementById('devert-listen-radio');
  const adsModeButton = document.getElementById('devert-listen-ads');
  const muteAdsInput = document.getElementById('devert-mute-ads');
  const previewPlayer = document.getElementById('devert-ad-preview');
  const listenStatus = document.getElementById('devert-listen-status');
  let generation = 0;
  let timer;
  let snapshot = null;
  let purchaseBusy = false;
  let previewCampaigns = [];
  let previewIndex = 0;
  let previewCampaignKey = '';
  let previewLoopToken = 0;
  const failedPreviewIds = new Set();

  function syncListenControls() {
    const adsOnly = previewPlayer.dataset.listenMode === 'ads-only';
    radioModeButton.setAttribute('aria-pressed', String(!adsOnly));
    adsModeButton.setAttribute('aria-pressed', String(adsOnly));
    const canSwitch = canSetDevertListenMode();
    radioModeButton.disabled = !canSwitch;
    adsModeButton.disabled = !canSwitch || previewCampaigns.length === 0;
    muteAdsInput.checked = getDevertAdsMuted();
    muteAdsInput.disabled = adsOnly;
    previewPlayer.hidden = !adsOnly;
  }

  function playNextAdPreview() {
    const token = ++previewLoopToken;
    const candidates = previewCampaigns.filter(campaign => !failedPreviewIds.has(campaign.campaignId));
    if (previewPlayer.dataset.listenMode !== 'ads-only') return;
    if (!candidates.length) {
      previewPlayer.pause();
      previewPlayer.removeAttribute('src');
      previewPlayer.load();
      listenStatus.textContent = 'No playable seated ads are available to preview right now.';
      return;
    }
    const campaign = candidates[previewIndex++ % candidates.length];
    const cid = campaign.audioURI.slice('ipfs://'.length);
    const gateway = (window.DecentConfig?.ipfsGateway || 'https://gateway.pinata.cloud/ipfs/').replace(/\/?$/, '/');
    previewPlayer.dataset.campaignId = campaign.campaignId;
    previewPlayer.src = `${gateway}${cid}`;
    listenStatus.textContent = `Ads-only preview: ${campaign.title}. This does not count as a paid impression.`;
    previewPlayer.play().catch(() => {
      if (token !== previewLoopToken) return;
      listenStatus.textContent = `Tap play to preview ${campaign.title}. Previews do not count as paid impressions.`;
    });
  }

  function updateAdPreviewQueue(nextCampaigns) {
    const nextKey = nextCampaigns.map(campaign => campaign.campaignId).join(',');
    if (nextKey === previewCampaignKey) return;
    const currentId = previewPlayer.dataset.campaignId;
    previewCampaignKey = nextKey;
    previewCampaigns = nextCampaigns;
    for (const campaignId of failedPreviewIds) {
      if (!previewCampaigns.some(campaign => campaign.campaignId === campaignId)) failedPreviewIds.delete(campaignId);
    }
    const currentIndex = previewCampaigns.findIndex(campaign => campaign.campaignId === currentId);
    previewIndex = currentIndex >= 0 ? currentIndex : 0;
    if (previewPlayer.dataset.listenMode === 'ads-only') playNextAdPreview();
    syncListenControls();
  }

  function syncCheckout() {
    const address = window.DecentConfig?.devertContractAddress || '';
    const wallet = window._wallet;
    const confirmedContract = !!address && !!snapshot && snapshot.contractAddress?.toLowerCase() === address.toLowerCase();
    const verifiedContract = confirmedContract && snapshot.paused === false;
    purchaseForm.hidden = !verifiedContract;
    walletButton.hidden = !verifiedContract || !!wallet?.address;
    purchaseButton.disabled = !verifiedContract || !wallet?.signer || wallet.chainId !== 8453 || purchaseBusy;
    if (!address) minimumOffer.textContent = 'Campaign checkout is unavailable until a DeVert contract is deployed and configured.';
    else if (confirmedContract && snapshot.paused) minimumOffer.textContent = 'Campaign checkout is paused until the owner activates DeVert after service rehearsal.';
    else if (!verifiedContract) minimumOffer.textContent = 'Waiting for a confirmed campaign snapshot from the configured contract.';
    else if (!wallet?.address) minimumOffer.textContent = 'Connect a Base wallet to purchase a campaign.';
    else if (wallet.chainId !== 8453) minimumOffer.textContent = 'Switch your wallet to Base to purchase a campaign.';
    else minimumOffer.textContent = 'Campaigns require the USDC offer plus a gas-priced Base ETH scheduler top-up; transaction gas is separate.';
  }

  async function submitCampaign(event) {
    event.preventDefault();
    if (purchaseBusy || !snapshot) return;
    const address = window.DecentConfig?.devertContractAddress || '';
    const signer = window._wallet?.signer;
    if (!address || !signer || window._wallet?.chainId !== 8453) { syncCheckout(); return; }
    purchaseBusy = true;
    syncCheckout();
    try {
      const contract = new ethers.Contract(address, DEVERT_BROWSER_ABI, signer);
      const usdc = new ethers.Contract(DEVERT_USDC_ADDRESS, DEVERT_USDC_ABI, signer);
      const offerUnits = ethers.parseUnits(document.getElementById('devert-offer').value, 6);
      const maxPaymentUnits = ethers.parseUnits(document.getElementById('devert-max-payment').value, 6);
      const hash = await purchaseDevertCampaign({ signer, contract, usdc,
        title: document.getElementById('devert-title').value,
        audioURI: document.getElementById('devert-audio-uri').value,
        offerUnits, maxPaymentUnits,
        onStep: message => { purchaseStatus.textContent = message; },
      });
      purchaseStatus.textContent = `Campaign confirmed: ${hash}`;
      await refresh();
    } catch (error) {
      purchaseStatus.textContent = error.shortMessage || error.reason || error.message;
    } finally {
      purchaseBusy = false;
      syncCheckout();
    }
  }

  const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';
  const close = () => {
    clearTimeout(timer);
    generation++;
    if (previewPlayer.dataset.listenMode === 'ads-only') {
      previewPlayer.pause();
      previewPlayer.dataset.listenMode = 'radio';
      setDevertListenMode('radio');
    }
    ++previewLoopToken;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open DVert advertising');
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    panel.inert = true;
    document.body.classList.remove('devert-open');
  };
  radioModeButton.addEventListener('click', () => {
    if (!setDevertListenMode('radio')) {
      listenStatus.textContent = 'Finish archive playback or the current new-song preview before switching listening modes.';
      return;
    }
    previewPlayer.pause();
    previewPlayer.dataset.listenMode = 'radio';
    listenStatus.textContent = 'Following the main radio. You can mute sponsored ads on this device.';
    syncListenControls();
  });
  adsModeButton.addEventListener('click', () => {
    if (!previewCampaigns.length) return;
    if (!setDevertListenMode('ads-only')) {
      listenStatus.textContent = 'Finish archive playback or the current new-song preview before switching to Ads Only.';
      return;
    }
    previewPlayer.dataset.listenMode = 'ads-only';
    syncListenControls();
    playNextAdPreview();
  });
  muteAdsInput.addEventListener('change', () => {
    setDevertAdsMuted(muteAdsInput.checked);
    listenStatus.textContent = muteAdsInput.checked
      ? 'Sponsored ads are muted on this device; other listeners are unaffected.'
      : 'Sponsored ads are audible on this device.';
  });
  previewPlayer.addEventListener('ended', () => {
    if (previewPlayer.dataset.listenMode === 'ads-only') playNextAdPreview();
  });
  previewPlayer.addEventListener('error', () => {
    const campaignId = previewPlayer.dataset.campaignId;
    if (campaignId) failedPreviewIds.add(campaignId);
    if (previewPlayer.dataset.listenMode === 'ads-only') playNextAdPreview();
  });
  document.addEventListener('radio-source-mode-change', () => {
    if (previewPlayer.dataset.listenMode === 'ads-only') {
      previewPlayer.pause();
      previewPlayer.dataset.listenMode = 'radio';
      setDevertListenMode('radio');
    }
    syncListenControls();
  });
  syncListenControls();
  async function refresh() {
    clearTimeout(timer);
    if (!isOpen()) return;
    const request = ++generation;
    const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
    if (!service) {
      snapshot = null;
      campaignStatus.textContent = 'DVert campaign service is not configured.';
      radioStatus.textContent = 'Main radio ad scheduling is not live yet.';
      syncCheckout();
      return;
    }
    campaignStatus.textContent = 'Loading confirmed campaigns…';
    try {
      const response = await fetch(`${service}/api/devert`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      const result = await response.json();
      if (request !== generation || !isOpen()) return;
      if (response.status === 404) throw new Error('Campaign contract is not deployed');
      if (!response.ok) throw new Error(result.error || `Campaigns unavailable (${response.status})`);
      snapshot = result;
      updateAdPreviewQueue(seatedDevertPreviewCampaigns(snapshot));
      campaignList.replaceChildren();
      const campaigns = activeCampaigns(snapshot);
      for (const campaign of campaigns) {
        const item = node('li', undefined, 'devert-campaign');
        const details = node('span', undefined, 'devert-campaign-details');
        const priority = Number(campaign.djukeBoosts || 0);
        details.append(node('strong', campaign.title),
          node('span', `${formatUsdc(campaign.offerUnits)}${priority ? ` · DJuke boosts ${priority}` : ''} · expires ${new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
          }).format(new Date(campaign.expiresAt))}`));
        item.append(details);
        campaignList.append(item);
      }
      campaignStatus.textContent = campaigns.length ? `${campaigns.length} active campaign${campaigns.length === 1 ? '' : 's'} · confirmed Base snapshot #${snapshot.blockNumber}` : 'No active campaigns right now.';
      radioStatus.textContent = 'Campaigns are scheduled into the main radio rotation.';
      syncCheckout();
    } catch (error) {
      if (request !== generation || !isOpen()) return;
      snapshot = null;
      campaignList.replaceChildren();
      campaignStatus.textContent = error.message;
      radioStatus.textContent = 'Main radio ad scheduling is not live yet.';
      syncCheckout();
    }
    if (isOpen()) timer = setTimeout(refresh, 30000);
  }
  toggle.addEventListener('click', event => {
    event.stopPropagation();
    if (isOpen()) { close(); return; }
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Close DVert advertising');
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    panel.inert = false;
    document.body.classList.add('devert-open');
    document.dispatchEvent(new CustomEvent('left-drawer-open', { detail: 'devert' }));
    refresh();
  });
  closeButton?.addEventListener('click', () => { close(); toggle.focus(); });
  refreshButton?.addEventListener('click', refresh);
  purchaseForm?.addEventListener('submit', submitCampaign);
  walletButton?.addEventListener('click', () => window._wallet?.connect?.());
  document.addEventListener('wallet-connected', syncCheckout);
  document.addEventListener('wallet-disconnected', syncCheckout);
  document.getElementById('devert-profile')?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('open-creator-profile'));
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && isOpen()) { close(); toggle.focus(); }
  });
  document.addEventListener('left-drawer-open', event => { if (event.detail !== 'devert' && isOpen()) close(); });
  document.addEventListener('click', event => {
    if (isOpen() && !panel.contains(event.target) && !toggle.contains(event.target)) close();
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initDevertTab); else initDevertTab();
}
