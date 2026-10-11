import { canSetDevertListenMode, getDevertAdsMuted, setDevertAdsMuted, setDevertListenMode } from './radio-sync.js?v=20261010-listens';
import { createBrowserIpfsUploader } from './ipfs-upload.js';
import { submitMediaForApproval } from './mint-submission.js';

const MAX_DEVERT_MEDIA_BYTES = 250 * 1024 * 1024;

function mediaTypeForAdFile(file) {
  const declared = String(file.type || '').toLowerCase();
  if (declared === 'video/mp4' || declared.startsWith('audio/')) return declared;
  const extension = file.name.split('.').pop().toLowerCase();
  return ({ mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
    aac: 'audio/aac', opus: 'audio/ogg', weba: 'audio/webm', mp4: 'video/mp4' })[extension] || '';
}

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

export function normalizeAdLoopNowPlaying(state) {
  const item = state?.nowPlaying;
  if (state?.ready !== true || !item?.audible || typeof item.radioPlayId !== 'string' ||
      typeof item.ipfsCid !== 'string' || !item.ipfsCid || !Number.isFinite(Number(item.positionMs))) return null;
  return { playId: item.radioPlayId, title: item.title || 'DeVert ad', ipfsCid: item.ipfsCid,
    mediaType: item.mediaType || 'audio/mpeg', positionMs: Math.max(0, Number(item.positionMs)) };
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
  } else overrides.gasPrice = feeData.gasPrice;
  return { amount, overrides };
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
    throw new Error('Enter a campaign title and valid IPFS media URI');
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
  const adMediaFile = document.getElementById('devert-ad-file');
  const adMediaArtist = document.getElementById('devert-ad-artist');
  const adMediaQueueButton = document.getElementById('devert-ad-queue');
  const adMediaStatus = document.getElementById('devert-ad-queue-status');
  const minimumOffer = document.getElementById('devert-minimum-offer');
  const walletButton = document.getElementById('devert-connect-wallet');
  const radioModeButton = document.getElementById('devert-listen-radio');
  const adsModeButton = document.getElementById('devert-listen-ads');
  const muteAdsInput = document.getElementById('devert-mute-ads');
  const previewPlayer = document.getElementById('devert-ad-preview');
  const adVoteButtons = [document.getElementById('devert-vote-up'), document.getElementById('devert-vote-down')];
  const adVoteStatus = document.getElementById('devert-vote-status');
  let adVoteBusy = false;
  const votedAdPlays = new Set();
  const listenStatus = document.getElementById('devert-listen-status');
  let generation = 0;
  let refreshTimer;
  let adLoopTimer;
  let adLoopState = null;
  let adLoopPlayId = null;
  let adLoopPositionReceivedAt = 0;
  let previewToken = 0;
  let snapshot = null;
  let purchaseBusy = false;
  let adMediaBusy = false;

  const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';

  function syncListenControls() {
    const adsOnly = previewPlayer.dataset.listenMode === 'ads-only';
    const canSwitch = canSetDevertListenMode();
    radioModeButton.setAttribute('aria-pressed', String(!adsOnly));
    adsModeButton.setAttribute('aria-pressed', String(adsOnly));
    radioModeButton.disabled = !canSwitch;
    adsModeButton.disabled = !canSwitch || adLoopState?.ready !== true;
    muteAdsInput.checked = getDevertAdsMuted();
    muteAdsInput.disabled = adsOnly;
    previewPlayer.hidden = !adsOnly;
    const playId = normalizeAdLoopNowPlaying(adLoopState)?.playId;
    for (const button of adVoteButtons) {
      if (button) button.disabled = !adsOnly || !playId || adVoteBusy || votedAdPlays.has(playId);
    }
  }

  function stopAdLoopMirror(message = '') {
    ++previewToken;
    previewPlayer.pause();
    previewPlayer.removeAttribute('src');
    previewPlayer.load();
    adLoopPlayId = null;
    if (message) listenStatus.textContent = message;
  }

  async function voteOnAd(vote) {
    const item = normalizeAdLoopNowPlaying(adLoopState);
    if (!item || adVoteBusy || previewPlayer.dataset.listenMode !== 'ads-only') return;
    adVoteBusy = true;
    syncListenControls();
    try {
      const storageKey = 'decentbusking:listener:v1';
      let voterId = localStorage.getItem(storageKey);
      if (!/^[a-zA-Z0-9_-]{16,128}$/.test(voterId || '')) {
        voterId = crypto.randomUUID();
        localStorage.setItem(storageKey, voterId);
      }
      const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
      const response = await fetch(`${service}/api/devert/loop/vote`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playId: item.playId, voterId, vote }), signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Ad vote failed');
      votedAdPlays.add(item.playId);
      adVoteStatus.textContent = 'Vote recorded';
    } catch (error) {
      adVoteStatus.textContent = error.message;
    } finally {
      adVoteBusy = false;
      syncListenControls();
    }
  }

  function syncAdLoopAudio(state) {
    if (previewPlayer.dataset.listenMode !== 'ads-only') return;
    const item = normalizeAdLoopNowPlaying(state);
    if (!item) {
      if (adLoopPlayId) stopAdLoopMirror('AdLoop is between ads; waiting for the next spot.');
      else listenStatus.textContent = state?.ready ? 'AdLoop is waiting for an eligible campaign.' : 'AdLoop is not configured yet.';
      return;
    }
    adLoopPositionReceivedAt = performance.now();
    const expectedPosition = () => (item.positionMs + performance.now() - adLoopPositionReceivedAt) / 1000;
    const gateway = (window.DecentConfig?.ipfsGateway || 'https://gateway.pinata.cloud/ipfs/').replace(/\/?$/, '/');
    if (adLoopPlayId !== item.playId) {
      const token = ++previewToken;
      adLoopPlayId = item.playId;
      previewPlayer.pause();
      previewPlayer.src = `${gateway}${item.ipfsCid}`;
      previewPlayer.load();
      const syncAndPlay = () => {
        if (token !== previewToken || previewPlayer.dataset.listenMode !== 'ads-only') return;
        if (Number.isFinite(previewPlayer.duration) && expectedPosition() < previewPlayer.duration - 1) {
          try { previewPlayer.currentTime = expectedPosition(); } catch {}
        }
        previewPlayer.play().catch(() => {
          listenStatus.textContent = `Tap play to mirror AdLoop: ${item.title}. This does not count as a paid impression.`;
        });
      };
      previewPlayer.addEventListener('loadedmetadata', syncAndPlay, { once: true });
      listenStatus.textContent = `Mirroring live AdLoop: ${item.title}. This does not count as a paid impression.`;
      return;
    }
    if (previewPlayer.readyState >= 2 && !previewPlayer.seeking && Number.isFinite(previewPlayer.duration) &&
        Math.abs(previewPlayer.currentTime - expectedPosition()) > 8 && expectedPosition() < previewPlayer.duration - 1) {
      try { previewPlayer.currentTime = expectedPosition(); } catch {}
    }
    if (previewPlayer.paused) previewPlayer.play().catch(() => {});
  }

  async function readAdLoopState() {
    const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
    if (!service) return { ready: false, nowPlaying: null };
    const response = await fetch(`${service}/api/devert/loop`, { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`AdLoop state unavailable (${response.status})`);
    return response.json();
  }

  async function refreshAdLoop() {
    if (!isOpen()) return;
    try {
      adLoopState = await readAdLoopState();
      syncAdLoopAudio(adLoopState);
      syncListenControls();
    } catch (error) {
      adLoopState = { ready: false, nowPlaying: null };
      if (previewPlayer.dataset.listenMode === 'ads-only') stopAdLoopMirror(`${error.message}; retrying.`);
      syncListenControls();
    }
  }

  function startAdLoopMirror() {
    clearInterval(adLoopTimer);
    refreshAdLoop();
    adLoopTimer = setInterval(refreshAdLoop, 5_000);
    adLoopTimer.unref?.();
  }

  function stopAdLoopPlayback() {
    clearInterval(adLoopTimer);
    adLoopTimer = null;
    stopAdLoopMirror();
  }

  function syncCheckout() {
    const address = window.DecentConfig?.devertContractAddress || '';
    const wallet = window._wallet;
    const confirmedContract = !!address && !!snapshot && snapshot.contractAddress?.toLowerCase() === address.toLowerCase();
    const verifiedContract = confirmedContract && snapshot.paused === false;
    purchaseForm.hidden = !verifiedContract;
    walletButton.hidden = !verifiedContract || !!wallet?.address;
    purchaseButton.disabled = !verifiedContract || !wallet?.signer || wallet.chainId !== 8453 || purchaseBusy;
    adMediaQueueButton.disabled = !verifiedContract || !wallet?.signer || wallet.chainId !== 8453 || adMediaBusy || !adMediaFile.files?.[0];
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
        offerUnits, maxPaymentUnits, onStep: message => { purchaseStatus.textContent = message; } });
      purchaseStatus.textContent = `Campaign confirmed: ${hash}`;
      await refresh();
    } catch (error) {
      purchaseStatus.textContent = error.shortMessage || error.reason || error.message;
    } finally {
      purchaseBusy = false;
      syncCheckout();
    }
  }

  async function queueAdMedia() {
    if (adMediaBusy) return;
    const file = adMediaFile.files?.[0];
    const wallet = window._wallet;
    if (!file || !wallet?.signer || wallet.chainId !== 8453) {
      adMediaStatus.textContent = 'Choose ad media and connect a Base wallet first.';
      return;
    }
    if (file.size < 1 || file.size > MAX_DEVERT_MEDIA_BYTES) {
      adMediaStatus.textContent = 'Ad media must be no larger than 250 MB.';
      return;
    }
    const mediaType = mediaTypeForAdFile(file);
    if (!mediaType) { adMediaStatus.textContent = 'Choose a supported audio file or MP4 video.'; return; }
    const title = document.getElementById('devert-title').value.trim();
    if (!title || title.length > 120) { adMediaStatus.textContent = 'Enter the campaign title before queuing ad media.'; return; }
    adMediaBusy = true;
    syncCheckout();
    try {
      const config = window.DecentConfig || {};
      const upload = createBrowserIpfsUploader({ provider: config.ipfsUploadProvider || 'pinata',
        serviceUrl: config.ipfsUploadServiceUrl, ipfsApiUrl: config.ipfsApiUrl, signer: wallet.signer,
        address: wallet.address, origin: window.location.origin, purpose: 'submission' });
      adMediaStatus.textContent = `Uploading ${file.name} to IPFS…`;
      const ipfsUri = await upload(file);
      if (!/^ipfs:\/\/[^/\s]+$/.test(ipfsUri)) throw new Error('Ad upload did not return a file CID');
      adMediaStatus.textContent = 'Requesting owner mint review…';
      const result = await submitMediaForApproval({ serviceUrl: config.ipfsUploadServiceUrl,
        signer: wallet.signer, address: wallet.address, origin: window.location.origin,
        media: { title, artist: adMediaArtist.value.trim() || wallet.address, ipfsCid: ipfsUri,
          mediaType, filename: file.name, recipient: wallet.address, isDevertAd: true } });
      document.getElementById('devert-audio-uri').value = ipfsUri;
      adMediaStatus.textContent = `IPFS media queued for owner NFT review (${result.trackId}). Campaign purchase is separate.`;
    } catch (error) {
      adMediaStatus.textContent = error.shortMessage || error.reason || error.message;
    } finally {
      adMediaBusy = false;
      syncCheckout();
    }
  }

  function close() {
    clearTimeout(refreshTimer);
    generation++;
    stopAdLoopPlayback();
    if (previewPlayer.dataset.listenMode === 'ads-only') {
      previewPlayer.dataset.listenMode = 'radio';
      setDevertListenMode('radio');
    }
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open DVert advertising');
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    panel.inert = true;
    document.body.classList.remove('devert-open');
    syncListenControls();
  }

  radioModeButton.addEventListener('click', () => {
    if (!setDevertListenMode('radio')) { listenStatus.textContent = 'Finish archive playback or the current new-song preview first.'; return; }
    stopAdLoopPlayback();
    previewPlayer.dataset.listenMode = 'radio';
    listenStatus.textContent = 'Following the main radio. You can mute sponsored ads on this device.';
    syncListenControls();
  });
  adsModeButton.addEventListener('click', () => {
    if (adLoopState?.ready !== true) return;
    if (!setDevertListenMode('ads-only')) { listenStatus.textContent = 'Finish archive playback or the current new-song preview first.'; return; }
    previewPlayer.dataset.listenMode = 'ads-only';
    syncListenControls();
    startAdLoopMirror();
  });
  muteAdsInput.addEventListener('change', () => {
    setDevertAdsMuted(muteAdsInput.checked);
    listenStatus.textContent = muteAdsInput.checked ? 'Sponsored ads are muted on this device; other listeners are unaffected.'
      : 'Sponsored ads are audible on this device.';
  });
  document.addEventListener('radio-source-mode-change', () => {
    if (previewPlayer.dataset.listenMode === 'ads-only' && !canSetDevertListenMode()) {
      stopAdLoopPlayback();
      previewPlayer.dataset.listenMode = 'radio';
      setDevertListenMode('radio');
    }
    syncListenControls();
  });
  previewPlayer.addEventListener('error', () => listenStatus.textContent = 'Could not mirror the current AdLoop stream. Retrying shortly.');
  syncListenControls();

  async function refresh() {
    clearTimeout(refreshTimer);
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
      const response = await fetch(`${service}/api/devert`, { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
      const result = await response.json();
      if (request !== generation || !isOpen()) return;
      if (response.status === 404) throw new Error('Campaign contract is not deployed');
      if (!response.ok) throw new Error(result.error || `Campaigns unavailable (${response.status})`);
      snapshot = result;
      campaignList.replaceChildren();
      const campaigns = activeCampaigns(snapshot);
      for (const campaign of campaigns) {
        const item = node('li', undefined, 'devert-campaign');
        const details = node('span', undefined, 'devert-campaign-details');
        const boosts = Number(campaign.djukeBoosts || 0);
        details.append(node('strong', campaign.title), node('span',
          `${formatUsdc(campaign.offerUnits)}${boosts ? ` · DJuke boosts ${boosts}` : ''} · expires ${new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
          }).format(new Date(campaign.expiresAt))}`));
        item.append(details);
        campaignList.append(item);
      }
      campaignStatus.textContent = campaigns.length ? `${campaigns.length} active campaign${campaigns.length === 1 ? '' : 's'} · confirmed Base snapshot #${snapshot.blockNumber}` : 'No active campaigns right now.';
      radioStatus.textContent = 'Main-radio ads follow the ten-song program; AdLoop is a separate 24/7 channel.';
      await checkAdLoopReady();
      syncCheckout();
    } catch (error) {
      if (request !== generation || !isOpen()) return;
      snapshot = null;
      campaignList.replaceChildren();
      campaignStatus.textContent = error.message;
      radioStatus.textContent = 'Main-radio ad scheduling is not live yet.';
      syncCheckout();
    }
    if (isOpen()) refreshTimer = setTimeout(refresh, 30_000);
  }

  async function checkAdLoopReady() {
    const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
    if (!service) { adLoopState = { ready: false }; syncListenControls(); return; }
    try {
      const response = await fetch(`${service}/api/devert/loop`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      adLoopState = response.ok ? await response.json() : { ready: false };
    } catch { adLoopState = { ready: false }; }
    syncListenControls();
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
    if (setDevertListenMode('ads-only')) {
      previewPlayer.dataset.listenMode = 'ads-only';
      startAdLoopMirror();
      syncListenControls();
    }
    refresh();
  });
  closeButton?.addEventListener('click', () => { close(); toggle.focus(); });
  refreshButton?.addEventListener('click', refresh);
  purchaseForm?.addEventListener('submit', submitCampaign);
  adVoteButtons[0]?.addEventListener('click', () => voteOnAd(1));
  adVoteButtons[1]?.addEventListener('click', () => voteOnAd(-1));
  adMediaFile?.addEventListener('change', syncCheckout);
  adMediaQueueButton?.addEventListener('click', queueAdMedia);
  walletButton?.addEventListener('click', () => window._wallet?.connect?.());
  document.addEventListener('wallet-connected', syncCheckout);
  document.addEventListener('wallet-disconnected', syncCheckout);
  document.getElementById('devert-profile')?.addEventListener('click', () => document.dispatchEvent(new CustomEvent('open-creator-profile')));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && isOpen()) { close(); toggle.focus(); } });
  document.addEventListener('left-drawer-open', event => { if (event.detail !== 'devert' && isOpen()) close(); });
  document.addEventListener('click', event => { if (isOpen() && !panel.contains(event.target) && !toggle.contains(event.target)) close(); });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initDevertTab);
  else initDevertTab();
}