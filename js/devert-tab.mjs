import { canSetDevertListenMode, formatMainRadioAdCountdown, getRadioStateSnapshot, setDevertListenMode } from './devert-radio-adapter.mjs';
import { createBrowserIpfsUploader } from './ipfs-upload.js?v=20261015-mime-sniff';
import { buildIpfsGatewayUrls } from './ipfs-gateway.js';
import { submitMediaForApproval } from './mint-submission.js?v=20261017-mercury-release';
import { approvalNotice, ensureBaseNetwork, retryMissingRevertData, waitForAllowance } from './base-chain.mjs';
import { planDevertQueues, quoteDevertCampaign, DEVERT_SONGS_PER_MAIN_AD } from './devert-scheduler.mjs';
import { announcePaymentCelebration } from './devert-payment.mjs';
import { formatUsdcUnits } from './usdc-format.mjs?v=20261017-mercury-release';
import { activeDevertCampaign, removeDevertCampaign } from './devert-campaigns.mjs';

const MAX_DEVERT_MEDIA_BYTES = 250 * 1024 * 1024;

export function devertPublicQueue(snapshot) {
  if (snapshot?.chainId !== 8453 || !Number.isFinite(Date.parse(snapshot.snapshotAt))) {
    throw new Error('Invalid public queue snapshot');
  }
  const plan = planDevertQueues({ campaigns: snapshot.campaigns,
    completedSongPlays: snapshot.market?.slots * DEVERT_SONGS_PER_MAIN_AD,
    now: Date.parse(snapshot.snapshotAt) });
  const campaigns = [...plan.mainRadio, ...plan.mainRadioOverflow].filter(campaign => !campaign.removed);
  const quote = quoteDevertCampaign({ campaigns, mainRadioSlots: plan.mainRadioSlots });
  return { campaigns, minimumOfferUnits: quote.minimumOfferUnits };
}

async function readWalletAds(service, address) {
  if (!address) throw new Error('Connect your wallet to view your ads.');
  const response = await fetch(`${service}/api/devert/ads?wallet=${encodeURIComponent(address)}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(12_000),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || `Ad library unavailable (${response.status})`);
  }
  return { ads: Array.isArray(result.ads) ? result.ads : [], metadataUnavailable: Number(result.metadataUnavailable || 0),
    ownershipUnavailable: Number(result.ownershipUnavailable || 0), scanPending: result.scanPending === true };
}

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
    return `${formatUsdcUnits(units)} USDC`;
  } catch {
    return 'USDC unavailable';
  }
}

function formatEth(units) {
  const amount = BigInt(units);
  const whole = amount / 1_000_000_000_000_000_000n;
  const fraction = String(amount % 1_000_000_000_000_000_000n).padStart(18, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} ETH`;
}

function resolveAdArtworkUrl(uri, gateway) {
  const value = String(uri || '').trim();
  if (!value) return '';
  if (value.startsWith('ipfs://')) return buildIpfsGatewayUrls(value, gateway)[0] || '';
  return value;
}

function adSearchText(ad) {
  return [ad.title, ad.artist, ad.filename, ad.tokenId, ad.state, ad.mintStatus].filter(Boolean).join(' ').toLowerCase();
}

export function normalizeAdLoopNowPlaying(state) {
  const item = state?.nowPlaying;
  if (state?.ready !== true || !item?.audible || typeof item.radioPlayId !== 'string' ||
      typeof item.ipfsCid !== 'string' || !item.ipfsCid || !Number.isFinite(Number(item.positionMs))) return null;
  return { playId: item.radioPlayId, title: item.title || 'DeVert ad', ipfsCid: item.ipfsCid,
    mediaType: item.mediaType || (item.videoUrl ? 'video/mp4' : ''), videoUrl: item.videoUrl || '',
    positionMs: Math.max(0, Number(item.positionMs)) };
}

async function getSchedulerTopUpQuote(signer, contract, advertiser, weeks = 1) {
  const feeData = await signer.provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (typeof maxFeePerGas !== 'bigint' || maxFeePerGas <= 0n) throw new Error('Current Base gas fee is unavailable');
  const weeklyTopUp = await contract.quoteSchedulerGasTopUp(maxFeePerGas);
  const amount = weeklyTopUp * BigInt(weeks);
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

export async function purchaseDevertCampaign({ signer, contract, usdc, title, audioURI, weeks, readCampaigns, onStep = () => {}, onConfirmed = announcePaymentCelebration }) {
  await ensureBaseNetwork(signer.provider);
  if (usdc.target.toLowerCase() !== DEVERT_USDC_ADDRESS.toLowerCase() || Number(await usdc.decimals()) !== 6) {
    throw new Error('Configured token is not native Base USDC');
  }
  if (!Number.isSafeInteger(weeks) || weeks < 1) throw new Error('Choose at least one week');
  const offerUnits = 5_000_000n * BigInt(weeks);
  const maxPaymentUnits = offerUnits;
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
  const checkExisting = async () => {
    if (typeof readCampaigns !== 'function') throw new Error('Campaign availability must be checked before purchasing');
    const current = await readCampaigns();
    if (current.chainId !== 8453 || current.contractAddress?.toLowerCase() !== contract.target.toLowerCase() ||
      !Array.isArray(current.campaigns)) throw new Error('Campaign availability could not be verified for the configured Base contract');
    const existing = activeDevertCampaign(current.campaigns, advertiser, mediaUri);
    if (existing) throw new Error(`This advert already has a paid campaign until ${new Date(existing.expiresAt).toLocaleString()}. Removing it from playback does not end its paid term.`);
  };
  await checkExisting();
  if (await usdc.balanceOf(advertiser) < offerUnits) throw new Error('Insufficient Base USDC balance');
  let gasQuote = await getSchedulerTopUpQuote(signer, contract, advertiser, weeks);
  if (await usdc.allowance(advertiser, contract.target) < offerUnits) {
    onStep(`${approvalNotice(formatUsdc(offerUnits.toString()))} Estimated worker-gas top-up ${formatEth(gasQuote.amount)} plus transaction gas`);
    const approval = await usdc.approve(contract.target, offerUnits);
    if ((await approval.wait())?.status !== 1) throw new Error('USDC approval did not confirm');
    onStep('Confirming approval…');
    await waitForAllowance(usdc, advertiser, contract.target, offerUnits);
  }
  gasQuote = await getSchedulerTopUpQuote(signer, contract, advertiser, weeks);
  await checkExisting();
  onStep(`Creating campaign…`);
  await retryMissingRevertData(
    () => contract.createCampaign.staticCall(campaignTitle, mediaUri, offerUnits, maxPaymentUnits, gasQuote.overrides),
    async () => {
      onStep('Confirming approval…');
      await waitForAllowance(usdc, advertiser, contract.target, offerUnits);
    },
  );
  onStep(`Confirm the ${weeks}-week campaign purchase: ${formatUsdc(offerUnits.toString())} plus ${formatEth(gasQuote.amount)} worker-gas top-up; transaction gas is separate`);
  const transaction = await contract.createCampaign(campaignTitle, mediaUri, offerUnits, maxPaymentUnits, gasQuote.overrides);
  onStep('Waiting for Base confirmation…');
  if ((await transaction.wait(2))?.status !== 1) throw new Error('Campaign purchase did not confirm');
  onConfirmed({
    chainId: 8453,
    txHash: transaction.hash,
    amountText: formatUsdc(offerUnits.toString()),
    assetText: 'USDC',
    summary: `Campaign purchase confirmed · ${formatEth(gasQuote.amount)} worker-gas ETH included`,
    txLabel: 'Campaign purchase confirmed',
  });
  return transaction.hash;
}

export function initDevertTab(environment = {}) {
  const document = environment.document || globalThis.document;
  const window = environment.window || globalThis.window;
  const ethers = environment.ethers || globalThis.ethers || window?.ethers;
  const fetch = environment.fetch || globalThis.fetch;
  const setTimeout = environment.setTimeout || globalThis.setTimeout;
  const clearTimeout = environment.clearTimeout || globalThis.clearTimeout;
  const setInterval = environment.setInterval || globalThis.setInterval;
  const clearInterval = environment.clearInterval || globalThis.clearInterval;
  const listen = environment.listen || ((target, ...args) => target?.addEventListener(...args));
  const radio = environment.radio || { canSetDevertListenMode, formatMainRadioAdCountdown, getRadioStateSnapshot, setDevertListenMode };
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const panel = document.getElementById('devert-panel');
  const toggle = document.getElementById('devert-tab');
  if (!panel || !toggle) return;
  const closeButton = document.getElementById('devert-close');
  const infoButton = document.getElementById('devert-info');
  const instructions = document.getElementById('devert-instructions');
  const instructionsClose = document.getElementById('devert-instructions-close');
  const refreshButton = document.getElementById('devert-refresh');
  const searchInput = document.getElementById('devert-search');
  const searchResults = document.getElementById('devert-search-results');
  const priceDisplay = document.getElementById('devert-price');
  const publicQueue = document.getElementById('devert-queue');
  const queueStatus = document.getElementById('devert-queue-status');
  let currentAds = [];
  let adLibraryStatus = 'Connect your wallet to browse ads.';
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
  const audioModeButton = document.getElementById('devert-audio-mode');
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
  let audioModeBusy = false;
  let snapshot = null;
  let purchaseBusy = false;
  let adMediaBusy = false;
  let radioState = radio.getRadioStateSnapshot();

  const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';
  previewPlayer.dataset.listenMode ||= 'radio';

  function syncRadioStatus() {
    radioStatus.textContent = radio.formatMainRadioAdCountdown(radioState?.mainRadioAdCountdown, {
      disconnected: radioState?.mainRadioAdCountdown?.reason === 'disconnected',
    });
  }

  function syncListenControls() {
    const adsOnly = previewPlayer.dataset.listenMode === 'ads-only';
    const canSwitch = radio.canSetDevertListenMode();
    const reconnecting = adLoopState?.voiceConnected === false && adLoopState?.ready !== false;
    audioModeButton.setAttribute('aria-pressed', String(adsOnly));
    audioModeButton.setAttribute('aria-label', adsOnly ? 'Return to Main Radio' : 'Listen to VertLoop');
    audioModeButton.title = adsOnly ? 'Return to Main Radio' : 'Listen to VertLoop · 24/7 audio & video adverts';
    document.getElementById('devert-live-player').hidden = !adsOnly && !listenStatus.textContent;
    document.getElementById('devert-live-votes').hidden = !adsOnly;
    audioModeButton.disabled = !canSwitch || audioModeBusy || (!adsOnly && (reconnecting || adLoopState?.ready !== true));
    const playId = normalizeAdLoopNowPlaying(adLoopState)?.playId;
    previewPlayer.hidden = !adsOnly || !playId;
    for (const button of adVoteButtons) {
      if (button) button.disabled = !adsOnly || !playId || adVoteBusy || votedAdPlays.has(playId);
    }

    syncRadioStatus();
  }
  listen(document, 'dbusk-radio-state', (event) => {
    radioState = event.detail || null;
    syncRadioStatus();
  });

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
    if (state?.voiceConnected === false && state?.ready !== false) {
      if (adLoopPlayId) stopAdLoopMirror('VertLoop reconnecting…');
      else listenStatus.textContent = 'VertLoop reconnecting…';
      return;
    }
    const item = normalizeAdLoopNowPlaying(state);
    if (!item) {
      if (adLoopPlayId) stopAdLoopMirror('Between ads');
      else listenStatus.textContent = state?.ready ? 'No ads playing' : 'VertLoop offline';
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
          listenStatus.textContent = `Ready to play: ${item.title}`;
        });
      };
      listen(previewPlayer, 'loadedmetadata', syncAndPlay, { once: true });
      listenStatus.textContent = item.title;
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
    if (!service) return { ready: false, nowPlaying: null, voiceConnected: false };
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
      adLoopState = { ready: false, nowPlaying: null, voiceConnected: false };
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

  async function fadeOutAdAudio(durationMs = 350) {
    if (previewPlayer.paused) return;
    const initialVolume = previewPlayer.volume;
    const startedAt = performance.now();
    while (!environment.destroyed?.() && performance.now() - startedAt < durationMs) {
      previewPlayer.volume = initialVolume * Math.max(0, 1 - (performance.now() - startedAt) / durationMs);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    previewPlayer.pause();
    previewPlayer.volume = initialVolume;
  }

  function syncCheckout() {
    const address = window.DecentConfig?.devertContractAddress || '';
    const wallet = window._wallet;
    const confirmedContract = !!address && !!snapshot && snapshot.contractAddress?.toLowerCase() === address.toLowerCase();
    const verifiedContract = confirmedContract && snapshot.paused === false;
    const weeksValue = Number(document.getElementById('devert-weeks')?.value || 1);
    const weeks = Number.isSafeInteger(weeksValue) && weeksValue > 0 ? weeksValue : 1;
    const totalUnits = 5_000_000n * BigInt(weeks);
    const campaignTotal = document.getElementById('devert-campaign-total');
    purchaseForm.hidden = !verifiedContract;
    purchaseButton.disabled = !verifiedContract || !wallet?.signer || wallet.chainId !== 8453 || purchaseBusy;
    adMediaQueueButton.disabled = !verifiedContract || !wallet?.signer || wallet.chainId !== 8453 || adMediaBusy || !adMediaFile.files?.[0];
    if (campaignTotal) campaignTotal.textContent = `Total: ${weeks} × 5.00 USDC = ${formatUsdc(totalUnits.toString())} + worker-gas ETH`;
    if (!address) minimumOffer.textContent = 'Campaigns unavailable';
    else if (confirmedContract && snapshot.paused) minimumOffer.textContent = 'Campaign purchases paused';
    else if (!verifiedContract) minimumOffer.textContent = 'Connecting…';
    else if (!wallet?.address) minimumOffer.textContent = 'Connect in the page header to submit an ad';
    else if (wallet.chainId !== 8453) minimumOffer.textContent = 'Switch to Base';
    else minimumOffer.textContent = '';
  }

  function queueState(message, price = 'Unavailable') {
    publicQueue.replaceChildren();
    priceDisplay.textContent = price;
    queueStatus.textContent = message;
  }

  function renderPublicQueue(result) {
    const { campaigns, minimumOfferUnits } = devertPublicQueue(result);
    publicQueue.replaceChildren();
    for (const campaign of campaigns) {
      const item = node('li');
      item.append(node('strong', campaign.title),
        node('span', `Campaign #${campaign.campaignId} · ${campaign.advertiser}`));
      publicQueue.append(item);
    }
    priceDisplay.textContent = formatUsdc(minimumOfferUnits.toString()).replace(' USDC', '');
    queueStatus.textContent = campaigns.length
      ? `${campaigns.length} active campaigns · ordinary rotation (not the paid request queue)`
      : 'No active campaigns in ordinary rotation';
  }

  function selectAdForCampaign(ad) {
    if (ad.state !== 'ready') return;
    document.getElementById('devert-title').value = String(ad.title || '');
    document.getElementById('devert-audio-uri').value = `ipfs://${ad.ipfsCid}`;
    document.getElementById('devert-run-campaign').open = true;
    document.getElementById('devert-weeks').focus();
  }

  async function removeCampaign(campaignId, status) {
    if (!window.confirm('Remove this campaign from main radio and VertLoop? No refund. You cannot run this advert again until its paid term ends.')) return;
    status.textContent = 'Sign the campaign removal request in your wallet...';
    try {
      await removeDevertCampaign({ service: window.DecentConfig.ipfsUploadServiceUrl,
        signer: environment.getSigner ? await environment.getSigner() : window._wallet.signer, campaignId,
        fetchImpl: fetch });
      await refresh();
    } catch (error) {
      status.textContent = `Removal failed: ${error.message}`;
    }
  }

  function renderAdLibrary() {
    const query = searchInput.value.trim().toLowerCase();
    const gateway = (window.DecentConfig?.ipfsGateway || 'https://gateway.pinata.cloud/ipfs/').replace(/\/?$/, '/');
    const visibleAds = currentAds
      .slice()
      .sort((first, second) => (first.state === 'ready' ? 0 : first.state === 'active' ? 1 : 2) -
        (second.state === 'ready' ? 0 : second.state === 'active' ? 1 : 2) ||
        String(first.title || '').localeCompare(String(second.title || '')) ||
        String(first.tokenId || '').localeCompare(String(second.tokenId || '')))
      .filter(ad => !query || adSearchText(ad).includes(query));
    searchResults.replaceChildren();
    if (!visibleAds.length) {
      searchResults.append(node('li', query ? `No ads match “${query}”.` : adLibraryStatus, 'devert-library-empty'));
      return;
    }
    for (const ad of visibleAds) {
      const item = node('li', undefined, `devert-library-item${ad.state !== 'ready' ? ' is-pending' : ''}`);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'devert-library-card';
      card.disabled = ad.state !== 'ready';
      card.setAttribute('aria-label', ad.state === 'ready'
        ? `Use ${ad.title} in a campaign`
        : ad.state === 'active' ? `${ad.title}: ${ad.removed ? 'removed from playback; paid term ends' : 'campaign active until'} ${new Date(ad.expiresAt).toLocaleString()}`
          : `${ad.title} is waiting for mint`);
      if (ad.state !== 'ready') card.setAttribute('aria-disabled', 'true');
      const art = node('span', undefined, 'devert-library-art');
      const imageUrl = resolveAdArtworkUrl(ad.image || ad.artworkCid || '', gateway);
      if (imageUrl) {
        const image = document.createElement('img');
        image.className = 'devert-library-image';
        image.loading = 'lazy';
        image.decoding = 'async';
        image.alt = `${String(ad.title || 'Ad')} artwork`;
        image.src = imageUrl;
        art.append(image);
      } else {
        art.append(node('span', String(ad.title || 'AD').slice(0, 2).toUpperCase(), 'devert-library-fallback'));
      }
      const body = node('span', undefined, 'devert-library-copy');
      body.append(node('strong', ad.title), node('span',
        ad.state === 'active' ? `${ad.removed ? 'Removed from playback · paid term ends' : 'Campaign active until'} ${new Date(ad.expiresAt).toLocaleString()}`
          : ad.state === 'ready' ? 'Minted · ready to run'
            : 'Waiting for mint', 'devert-library-status'));
      if (ad.tokenId != null) body.append(node('span', `Token #${ad.tokenId}`, 'devert-library-meta'));
      card.append(art, body, node('span', ad.state === 'ready' ? 'Select'
        : ad.state === 'active' ? ad.removed ? 'Removed' : 'Active' : 'Pending', 'devert-library-badge'));
      if (ad.state === 'ready') listen(card, 'click', () => selectAdForCampaign(ad));
      item.append(card);
      searchResults.append(item);
    }
  }

  async function submitCampaign(event) {
    event.preventDefault();
    if (purchaseBusy || !snapshot) return;
    const address = window.DecentConfig?.devertContractAddress || '';
    if (!address || !window._wallet?.signer || window._wallet?.chainId !== 8453) { syncCheckout(); return; }
    purchaseBusy = true;
    syncCheckout();
    try {
      const signer = environment.getSigner ? await environment.getSigner() : window._wallet.signer;
      const contract = new ethers.Contract(address, DEVERT_BROWSER_ABI, signer);
      const usdc = new ethers.Contract(DEVERT_USDC_ADDRESS, DEVERT_USDC_ABI, signer);
      const weeks = Number(document.getElementById('devert-weeks').value);
      const hash = await purchaseDevertCampaign({ signer, contract, usdc,
        title: document.getElementById('devert-title').value,
        audioURI: document.getElementById('devert-audio-uri').value,
        weeks, readCampaigns: async () => {
          const response = await fetch(`${window.DecentConfig.ipfsUploadServiceUrl.replace(/\/$/, '')}/api/devert`,
            { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
          const state = await response.json();
          if (!response.ok) throw new Error(state.error || 'Campaign availability could not be verified');
          return state;
        }, onStep: message => { purchaseStatus.textContent = message; }, onConfirmed: environment.onConfirmed });
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
      const signer = environment.getSigner ? await environment.getSigner() : wallet.signer;
      const config = window.DecentConfig || {};
      const upload = createBrowserIpfsUploader({ provider: config.ipfsUploadProvider || 'pinata',
        serviceUrl: config.ipfsUploadServiceUrl, ipfsApiUrl: config.ipfsApiUrl, signer,
        address: wallet.address, origin: window.location.origin, purpose: 'submission' });
      adMediaStatus.textContent = `Uploading ${file.name} to IPFS…`;
      const ipfsUri = await (environment.uploadMedia ? environment.uploadMedia(file, { purpose: 'submission' }) : upload(file));
      if (environment.destroyed?.()) return;
      if (!/^ipfs:\/\/[^/\s]+$/.test(ipfsUri)) throw new Error('Ad upload did not return a file CID');
      document.getElementById('devert-audio-uri').value = ipfsUri;
      adMediaStatus.textContent = 'Confirm submission in your wallet…';
      const submitMedia = environment.submitMedia || submitMediaForApproval;
      await submitMedia({ serviceUrl: config.ipfsUploadServiceUrl, fetchImpl: fetch,
        signer, address: wallet.address, origin: window.location.origin,
        media: { title, artist: adMediaArtist.value.trim() || wallet.address, ipfsCid: ipfsUri,
          mediaType, filename: file.name, recipient: wallet.address, isDevertAd: true } });
      document.getElementById('devert-audio-uri').value = ipfsUri;
      adMediaStatus.textContent = 'Submitted for review.';
      await refresh();
    } catch (error) {
      adMediaStatus.textContent = error.shortMessage || error.reason || error.message;
    } finally {
      adMediaBusy = false;
      syncCheckout();
    }
  }

  async function close() {
    if (instructions.open) instructions.close();
    clearTimeout(refreshTimer);
    generation++;
    if (previewPlayer.dataset.listenMode === 'ads-only') {
      clearInterval(adLoopTimer);
      audioModeBusy = true;
      syncListenControls();
      await fadeOutAdAudio();
      stopAdLoopPlayback();
      previewPlayer.dataset.listenMode = 'radio';
      radio.setDevertListenMode('radio');
      audioModeBusy = false;
    } else stopAdLoopPlayback();
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open DVert advertising');
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    panel.inert = true;
    document.body.classList.remove('devert-open');
    listenStatus.textContent = '';
    syncListenControls();
  }

  listen(audioModeButton, 'click', async () => {
    if (audioModeBusy) return;
    audioModeBusy = true;
    syncListenControls();
    try {
      if (previewPlayer.dataset.listenMode === 'ads-only') {
        clearInterval(adLoopTimer);
        await fadeOutAdAudio();
        stopAdLoopPlayback();
        previewPlayer.dataset.listenMode = 'radio';
        radio.setDevertListenMode('radio');
        listenStatus.textContent = '';
      } else {
        if (adLoopState?.ready !== true) return;
        if (!radio.setDevertListenMode('ads-only')) { listenStatus.textContent = 'Finish archive playback or the current new-song preview first.'; return; }
        previewPlayer.dataset.listenMode = 'ads-only';
        startAdLoopMirror();
      }
    } finally {
      audioModeBusy = false;
      syncListenControls();
    }
  });
  listen(document, 'radio-source-mode-change', () => {
    if (previewPlayer.dataset.listenMode === 'ads-only' && !radio.canSetDevertListenMode()) {
      stopAdLoopPlayback();
      previewPlayer.dataset.listenMode = 'radio';
      radio.setDevertListenMode('radio');
    }
    syncListenControls();
  });
  listen(previewPlayer, 'error', () => listenStatus.textContent = 'Could not mirror the current AdLoop stream. Retrying shortly.');
  syncListenControls();

  async function refresh() {
    clearTimeout(refreshTimer);
    if (!isOpen()) return;
    const request = ++generation;
    let scanPending = false;
    let publicLoaded = false;
    queueState('Loading public queue…', 'Loading…');
    const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
    if (!service) {
      snapshot = null;
      queueState('Public queue unavailable: DVert campaign service is not configured.');
      currentAds = [];
      adLibraryStatus = 'DVert campaign service is not configured.';
      renderAdLibrary();
      campaignStatus.textContent = 'DVert campaign service is not configured.';
      syncRadioStatus();
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
      renderPublicQueue(result);
      publicLoaded = true;
      snapshot = result;
      campaignList.replaceChildren();
      const walletAddress = window._wallet?.address;
      let ads = [];
      let metadataUnavailable = 0;
      let ownershipUnavailable = 0;
      if (walletAddress) {
        const library = await readWalletAds(service, walletAddress);
        if (request !== generation || !isOpen()) return;
        ads = library.ads;
        metadataUnavailable = library.metadataUnavailable;
        ownershipUnavailable = library.ownershipUnavailable;
        scanPending = library.scanPending;
      }
      currentAds = ads;
      adLibraryStatus = !walletAddress ? 'Connect your wallet to browse minted and pending ads.'
        : scanPending && !ads.length ? 'Checking Base for wallet-owned ad NFTs. Your ads will appear automatically.'
          : scanPending ? `${ads.length} ad${ads.length === 1 ? '' : 's'} found; checking Base for other ads.`
            : metadataUnavailable && !ads.length ? 'IPFS gateways are rate-limiting NFT metadata. Your ad library could not be fully checked; refresh shortly.'
              : metadataUnavailable ? `${ads.length} ad${ads.length === 1 ? '' : 's'} found; ${metadataUnavailable} NFT metadata item${metadataUnavailable === 1 ? '' : 's'} could not be checked yet.`
                : ownershipUnavailable && !ads.length ? 'Wallet ownership could not be fully checked; refresh shortly.'
                  : ownershipUnavailable ? `${ads.length} ad${ads.length === 1 ? '' : 's'} found; some wallet ownership checks failed. Refresh shortly.`
                    : ads.length ? `${ads.length} ad${ads.length === 1 ? '' : 's'} linked to this wallet.` : 'No ads submitted from this wallet yet.';
      const paidTerms = result.campaigns.filter(campaign => walletAddress &&
        campaign.advertiser.toLowerCase() === walletAddress.toLowerCase() &&
        Date.parse(campaign.startedAt) <= Date.now() && Date.now() < Date.parse(campaign.expiresAt));
      if (paidTerms.length) {
        adLibraryStatus = `${paidTerms.length} campaign(s) within their paid term: ${
          paidTerms.map(campaign => `${campaign.title}${campaign.removed ? ' (removed from playback)' : ''} until ${
            new Date(campaign.expiresAt).toLocaleString()}`).join('; ')}. ${adLibraryStatus}`;
      }
      renderAdLibrary();
      const campaignRows = [...ads, ...paidTerms.filter(campaign => !ads.some(ad => ad.campaignId === campaign.campaignId))
        .map(campaign => ({ ...campaign, state: 'active', secondsRemaining:
          Math.max(0, Math.ceil((Date.parse(campaign.expiresAt) - Date.now()) / 1000)) }))];
      for (const ad of campaignRows) {
        const item = node('li', undefined, 'devert-campaign');
        const details = node('span', undefined, 'devert-campaign-details');
        const state = ad.state === 'active'
          ? `${ad.removed ? 'Removed from playback · paid term ends' : 'Active until'} ${new Date(ad.expiresAt).toLocaleString()}`
          : ad.state === 'ready' ? 'NFT minted · ready for campaign' : 'Waiting for admin mint';
        const remaining = ad.secondsRemaining > 0 ? ` · ${Math.floor(ad.secondsRemaining / 86400)}d ${Math.floor(ad.secondsRemaining % 86400 / 3600)}h left` : '';
        details.append(node('strong', ad.title), node('span', `${state}${remaining}`));
        item.append(details);
        if (ad.state === 'ready') {
          const select = node('button', 'Run Campaign', 'devert-use-ad');
          select.type = 'button';
          select.setAttribute('aria-label', `Use ${ad.title} in a campaign`);
          listen(select, 'click', () => selectAdForCampaign(ad));
          item.append(select);
        }
        if (ad.state === 'active' && !ad.removed) {
          const remove = node('button', 'Remove from playback', 'devert-use-ad');
          remove.type = 'button';
          listen(remove, 'click', () => removeCampaign(ad.campaignId, campaignStatus));
          item.append(remove);
        }
        campaignList.append(item);
      }
      campaignStatus.textContent = adLibraryStatus;
      syncRadioStatus();
      await checkAdLoopReady();
      syncCheckout();
    } catch (error) {
      if (request !== generation || !isOpen()) return;
      if (!publicLoaded) queueState(`Public queue unavailable: ${error.message}`);
      snapshot = null;
      currentAds = [];
      adLibraryStatus = error.message;
      renderAdLibrary();
      campaignList.replaceChildren();
      campaignStatus.textContent = error.message;
      syncRadioStatus();
      syncCheckout();
    }
    if (request === generation && isOpen()) refreshTimer = setTimeout(refresh, scanPending ? 3_000 : 30_000);
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

  listen(toggle, 'click', event => {
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
  listen(closeButton, 'click', async () => { await close(); toggle.focus(); });
  listen(infoButton, 'click', () => instructions.showModal());
  listen(instructionsClose, 'click', () => instructions.close());
  listen(instructions, 'close', () => {
    if (isOpen()) infoButton.focus();
  });
  listen(refreshButton, 'click', refresh);
  listen(document.getElementById('devert-queue-refresh'), 'click', refresh);
  listen(searchInput, 'input', renderAdLibrary);
  listen(purchaseForm, 'submit', submitCampaign);
  listen(document.getElementById('devert-weeks'), 'input', syncCheckout);
  listen(adVoteButtons[0], 'click', () => voteOnAd(1));
  listen(adVoteButtons[1], 'click', () => voteOnAd(-1));
  listen(adMediaFile, 'change', syncCheckout);
  listen(adMediaQueueButton, 'click', queueAdMedia);
  listen(document, 'wallet-connected', syncCheckout);
  listen(document, 'wallet-connected', refresh);
  listen(document, 'wallet-chain-changed', syncCheckout);
  listen(document, 'wallet-disconnected', () => {
    currentAds = [];
    adLibraryStatus = 'Connect your wallet to browse ads.';
    renderAdLibrary();
    syncCheckout();
    campaignList.replaceChildren();
    campaignStatus.textContent = 'Connect your wallet to view your ads.';
  });
  listen(document, 'keydown', event => { if (event.key === 'Escape' && isOpen() && !instructions.open) { close().then(() => toggle.focus()); } });
  listen(document, 'left-drawer-open', event => { if (event.detail !== 'devert' && isOpen()) close(); });
  listen(document, 'click', event => { if (isOpen() && !panel.contains(event.target) && !toggle.contains(event.target) && !instructions.contains(event.target)) close(); });
  return {
    refresh,
    destroy() {
      generation++;
      clearTimeout(refreshTimer);
      clearInterval(adLoopTimer);
      if (previewPlayer.dataset.listenMode === 'ads-only') radio.setDevertListenMode('radio');
      previewPlayer.dataset.listenMode = 'radio';
      stopAdLoopPlayback();
      if (instructions.open) instructions.close();
    },
  };
}