import { supportsDjukeAlbumsAndGas } from './djuke-version.mjs';
import { purchaseDjukeSong, replaceDjukeSong } from './djuke-payment.mjs';
import { announcePaymentCelebration } from './payment-celebration.mjs';
import { mountDjukeQueueFocus } from './djuke-queue-focus.mjs';
import { getRadioStateSnapshot } from './radio-sync.js?v=20261025-seamless-handoff';
import { formatUsdcUnits } from './usdc-format.mjs?v=20261017-mercury-release';
import { USDC_BROWSER_ABI } from './usdc-abi.mjs';
import { lookupEnsName } from './ens-client.mjs?v=20261016-ens-worker';
import { renderWalletAddress } from './fund-display.mjs?v=20261024-djuke-labels';
import { playlistBatchProgress } from './djuke-playlist-progress.mjs?v=20261025-seamless-handoff';
export { USDC_BROWSER_ABI };

export function playlistReceiptSummary(batch) {
  const { delivered, total, progress } = playlistBatchProgress(batch);
  const state = batch.status === 'settled' ? 'completed' : batch.status === 'refunded' ? 'refunded'
    : batch.status === 'confirming' ? 'confirming' : batch.playing ? 'playing' : 'queued';
  const label = { completed: 'Completed', refunded: 'Refunded', confirming: 'Verifying queue',
    playing: 'Playing', queued: 'Queued' }[state];
  const paid = batch.subtotalUnits != null && batch.feeUnits != null
    ? BigInt(batch.subtotalUnits) + BigInt(batch.feeUnits) : null;
  const refunded = batch.refundedUnits == null ? null : BigInt(batch.refundedUnits);
  const failure = batch.playbackFailure;
  const failedSong = failure && batch.songs.find(song => song.laneId === failure.laneId);
  const failureNote = failure && state !== 'completed'
    ? ` Song ${batch.songs.indexOf(failedSong) + 1 || '?'}${failedSong?.title ? ` (${failedSong.title})` : ''}: ${failure.reason.replace(/_/g, ' ')}. ${failure.attempts}/${failure.maxAttempts} attempts failed${failure.exhausted ? '; retries exhausted' : state === 'refunded' ? '; batch refunded' : '; retry pending'}.` : '';
  return { state, label, delivered, total, progress,
    payment: paid === null ? 'Payment details are being verified'
      : `Paid ${formatDjukeUsdc(paid)} USDC${state === 'refunded'
        ? refunded === null ? ' · Refund amount is being verified'
          : ` · Refunded ${formatDjukeUsdc(refunded)} USDC · Settled ${formatDjukeUsdc(paid - refunded)} USDC` : ''}`,
    note: (state === 'refunded'
      ? batch.workerGasSponsored ? 'Undelivered songs and unreleased fee returned to your wallet. Network gas is not refunded.'
        : 'Undelivered songs and playlist fee returned to your wallet. Worker ETH and network gas are not refunded.'
      : state === 'completed' ? 'Playback delivered and platform fee settled.'
        : state === 'confirming' ? 'Purchase confirmed on Base. Waiting for the verified queue; playback is not complete.'
          : 'Payment confirmed. Main paid requests may cut in; only delivered songs count toward completion.') + failureNote };
}

export function quoteDjuke(pendingCount) {
  if (!Number.isSafeInteger(pendingCount) || pendingCount < 0) throw new RangeError('Invalid pending queue count');
  const tier = Math.floor(pendingCount / 8);
  if (tier > 238) throw new RangeError('Queue price exceeds token transaction limits');
  const priceUnits = 250000n * (2n ** BigInt(tier));
  const fundUnits = priceUnits / 10n;
  return { tier, priceUnits, fundUnits, artistUnits: priceUnits - fundUnits };
}

export function formatDjukeUsdc(units) {
  if (typeof units !== 'bigint' || units < 0n) throw new RangeError('Invalid USDC amount');
  return formatUsdcUnits(units);
}

export function formatDjukeEth(units, precision = 6) {
  if (typeof units !== 'bigint' || units < 0n) throw new RangeError('Invalid ETH amount');
  if (!Number.isInteger(precision) || precision < 0 || precision > 18) throw new RangeError('Invalid ETH precision');
  if (precision === 0) return `${units / 1000000000000000000n}`;
  const wei = String(units % 1000000000000000000n).padStart(18, '0').slice(0, precision).replace(/0+$/, '');
  return wei ? `${units / 1000000000000000000n}.${wei}` : `${units / 1000000000000000000n}`;
}

export function splitDjukeCharges(priceUnits) {
  if (typeof priceUnits !== 'bigint' || priceUnits < 0n) throw new RangeError('Invalid USDC amount');
  const fundUnits = priceUnits / 10n;
  return { artistUnits: priceUnits - fundUnits, fundUnits };
}

export function readDjukeQueue(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.requests)) throw new Error('Invalid DJuke queue response');
  const ids = new Set();
  for (const request of snapshot.requests) {
    if (!request || typeof request.requestId !== 'string' || !request.requestId || ids.has(request.requestId) ||
      typeof request.title !== 'string' || !request.title || typeof request.trackId !== 'string' || !request.trackId) {
      throw new Error('Invalid DJuke request');
    }
    ids.add(request.requestId);
  }
  quoteDjuke(snapshot.requests.length);
  return snapshot.requests;
}

export function filterDjukeSongs(tracks, query = '') {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return (Array.isArray(tracks) ? tracks : []).filter(track => {
    if (!track || typeof track.trackId !== 'string' || typeof track.title !== 'string') return false;
    const text = [track.title, track.artist, track.creator, track.uploader].filter(value => typeof value === 'string').join(' ').toLowerCase();
    return terms.every(term => text.includes(term));
  });
}

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
export async function payForDjukeSong(options) {
  const { txHash, priceUnits } = await purchaseDjukeSong(options);
  announcePaymentCelebration({
    chainId: 8453,
    txHash,
    amountText: formatDjukeUsdc(priceUnits),
    assetText: 'USDC',
    summary: 'DJuke queue payment confirmed',
    txLabel: 'DJuke request confirmed',
    source: 'djuke',
  });
  return { txHash, priceUnits };
}

export async function replaceDjukeRequest(options) {
  return replaceDjukeSong(options);
}

export function initDjuke() {
  const panel = document.getElementById('djuke-panel');
  const toggle = document.getElementById('djuke-tab');
  if (!panel || !toggle) return;
  const queue = document.getElementById('djuke-queue');
  const status = document.getElementById('djuke-queue-state');
  const price = document.getElementById('djuke-price');
  const count = document.getElementById('djuke-count');
  const select = document.getElementById('djuke-song');
  const search = document.getElementById('djuke-search');
  const searchState = document.getElementById('djuke-search-state');
  const paymentStatus = document.getElementById('djuke-payment-state');
  const tiers = document.getElementById('djuke-price-tiers');
  const pay = document.getElementById('djuke-pay');
  const gasStatus = document.getElementById('djuke-gas-status');
  const instructions = document.getElementById('djuke-instructions');
  const info = document.getElementById('djuke-info');
  const earners = document.getElementById('djuke-earners');
  const earnerStatus = document.getElementById('djuke-earners-state');
  const receipts = document.getElementById('djuke-receipts');
  const receiptList = document.getElementById('djuke-receipt-list');
  const receiptStatus = document.getElementById('djuke-receipts-state');
  const profileDialog = document.getElementById('creator-profile');
  let profileAddress = '';
  const ownProfileOpen = () => !!profileDialog?.open && !!window._wallet?.address &&
    profileAddress.toLowerCase() === window._wallet.address.toLowerCase();
  let receiptSnapshot = [];
  let receiptKey = '';
  let provisionalReceipt = null;
  let earnersGeneration = 0;
  let walletPromptShown = false;
  let gasQuote = null;
  let gasGeneration = 0;
  let timer;
  let generation = 0;
  let live = null;
  let busy = false;
  const contractAddress = () => window.DecentConfig?.djukeContractAddress || '';
  const paymentsLive = () => !!live?.paymentsEnabled && !!contractAddress() &&
    contractAddress().toLowerCase() === String(live.contractAddress || '').toLowerCase();
  const selectedSongId = () => live?.tracks?.find(track => track.trackId === select.value)?.songId || '';
  const contracts = () => {
    const signer = window._wallet?.signer;
    if (!signer || typeof ethers === 'undefined') throw new Error('Connect your wallet first');
    return { signer, djuke: new ethers.Contract(contractAddress(), DJUKE_BROWSER_ABI, signer),
      usdc: new ethers.Contract(BASE_USDC_ADDRESS, USDC_BROWSER_ABI, signer) };
  };
  const syncPayButton = () => {
    const ready = paymentsLive() && !!window._wallet?.address && window._wallet?.chainId === 8453 && !!selectedSongId() && !busy &&
      (!supportsDjukeAlbumsAndGas(window.DecentConfig?.djukeContractVersion) || !!gasQuote && gasQuote.deadline > Date.now() / 1000);
    pay.disabled = busy || (!!window._wallet?.address && !ready);
    pay.title = !window._wallet?.address ? 'Queue Song'
      : paymentsLive() ? 'Pay to queue the selected song' : 'DJuke payments are not live yet';
  };
  let gasQuoteKey = '';
  const currentGasKey = () => `${window._wallet?.address?.toLowerCase() || ''}|${selectedSongId()}|${live?.priceUnits || ''}`;
  const refreshGasQuote = async ({ force = false } = {}) => {
    const key = currentGasKey();
    // Reuse a matching quote (or one already loading) so queue polls and typing don't hammer the worker RPC.
    if (force !== true && key === gasQuoteKey && (!gasQuote || gasQuote.deadline - 30 > Date.now() / 1000)) {
      syncPayButton();
      return;
    }
    gasQuote = null;
    gasQuoteKey = key;
    const check = ++gasGeneration;
    if (gasStatus) gasStatus.textContent = '';
    syncPayButton();
    const songId = selectedSongId();
    if (!supportsDjukeAlbumsAndGas(window.DecentConfig?.djukeContractVersion) || !songId || !window._wallet?.address) return;
    if (gasStatus) gasStatus.textContent = window.DecentConfig?.djukeContractVersion === '0.5'
      ? 'Verifying payment availability' : 'Estimating worker gas';
    try {
      const response = await fetch(`${window.DecentConfig.ipfsUploadServiceUrl}/api/djuke/gas-quote?${new URLSearchParams({ listener: window._wallet.address, songId })}`, { signal: AbortSignal.timeout(15000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Gas quote unavailable');
      if (check !== gasGeneration) return;
      gasQuote = result;
      renderGasStatus();
    } catch (error) {
      if (check !== gasGeneration) return;
      gasQuoteKey = '';
      if (gasStatus) gasStatus.replaceChildren();
      if (gasStatus) gasStatus.textContent = /request limit|rate limit|too many/i.test(error.message)
        ? 'Payment verification is busy; retrying shortly' : error.message;
    }
    syncPayButton();
  };
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const renderGasStatus = () => {
    if (!gasStatus) return;
    if (!gasQuote || !live?.priceUnits) {
      gasStatus.replaceChildren();
      return;
    }
    const priceUnits = BigInt(live.priceUnits);
    const { artistUnits, fundUnits } = splitDjukeCharges(priceUnits);
    const summary = node('section', undefined, 'djuke-gas-summary');
    summary.append(node('h4', 'Charge breakdown', 'djuke-gas-summary-title'));
    const list = node('dl', undefined, 'djuke-gas-summary-list');
    const rows = [
      ['Artist / collaborators', `${formatDjukeUsdc(artistUnits)} USDC`],
      ['Platform funds', `${formatDjukeUsdc(fundUnits)} USDC (8% pinning, 2% dev fund)`],
      ...(BigInt(gasQuote.contributionWei) > 0n
        ? [['Worker execution', `~${formatDjukeEth(BigInt(gasQuote.contributionWei))} ETH contribution`]] : []),
    ];
    for (const [label, value] of rows) {
      const row = node('div', undefined, 'djuke-gas-summary-row');
      row.append(node('dt', label), node('dd', value));
      list.append(row);
    }
    summary.append(list, node('p', BigInt(gasQuote.contributionWei) === 0n
      ? 'Only the USDC purchase and your normal Base network gas are payable by you.'
      : 'The disclosed worker ETH contribution funds automated playback on Base. Wallet network gas is additional.'));
    gasStatus.replaceChildren(summary);
  };
  let songOptionsKey = '';
  const renderSongs = ({ deferWhileFocused = false } = {}) => {
    if (deferWhileFocused && document.activeElement === select) return;
    const previous = select.value;
    const liveTracks = Array.isArray(live?.tracks) ? live.tracks : [];
    const tracks = filterDjukeSongs(liveTracks, search?.value || '');
    const previousTrack = liveTracks.find(track => track.trackId === previous);
    const options = previousTrack && !tracks.some(track => track.trackId === previousTrack.trackId)
      ? [...tracks, previousTrack] : tracks;
    const placeholderText = tracks.length ? 'Select one song' : 'No matching songs';
    const optionData = options.map(track => [track.trackId, track.artist ? `${track.title} - ${track.artist}` : track.title]);
    const key = JSON.stringify([placeholderText, optionData]);
    if (key !== songOptionsKey) {
      const scrollTop = select.scrollTop;
      const placeholder = node('option', placeholderText);
      placeholder.value = '';
      select.replaceChildren(placeholder);
      for (const [value, label] of optionData) {
        const option = node('option', label);
        option.value = value;
        select.append(option);
      }
      select.value = options.some(track => track.trackId === previous) ? previous : '';
      select.scrollTop = scrollTop;
      songOptionsKey = key;
    }
    if (searchState) searchState.textContent = tracks.length ? `${tracks.length} matching songs` : 'No matching songs';
    select.disabled = !options.length;
    syncPayButton();
  };
  const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';
  const renderTiers = pending => {
    tiers.replaceChildren();
    const currentTier = pending === null ? null : quoteDjuke(pending).tier;
    const shown = new Set([0, 1, 2, 3, 4]);
    if (currentTier !== null) shown.add(currentTier);
    for (const tier of [...shown].sort((first, second) => first - second)) {
      const row = node('tr', undefined, tier === currentTier ? 'is-current' : '');
      row.append(node('td', `${tier * 8}–${tier * 8 + 7}`), node('td', formatDjukeUsdc(quoteDjuke(tier * 8).priceUnits)));
      tiers.append(row);
    }
    const continuing = node('tr');
    const label = node('td', 'Every next 8');
    continuing.append(label, node('td', '×2'));
    tiers.append(continuing);
  };
  const unavailable = message => {
    live = null;
    queue.replaceChildren();
    price.textContent = '—';
    count.textContent = '—';
    if (!songOptionsKey) select.replaceChildren(node('option', 'Song catalog unavailable'));
    select.disabled = true;
    if (searchState) searchState.textContent = 'Song catalog unavailable; refresh to retry.';
    renderTiers(null);
    status.textContent = message;
    if (receiptStatus && !receipts.hidden) receiptStatus.textContent = 'Receipt updates unavailable. Last verified receipts remain below; refresh to retry.';
    syncPayButton();
  };
  const renderReceipts = () => {
    if (!receipts || !receiptList) return;
    const wallet = window._wallet?.address?.toLowerCase();
    const mine = receiptSnapshot.filter(batch => batch.payer?.toLowerCase() === wallet).slice(-5).reverse();
    if (provisionalReceipt && !mine.some(batch => batch.transactionHash === provisionalReceipt.transactionHash) &&
        provisionalReceipt.payer === wallet) mine.unshift(provisionalReceipt);
    receipts.hidden = !ownProfileOpen() || !mine.length;
    const key = JSON.stringify([wallet, mine]);
    if (key === receiptKey) return;
    receiptKey = key;
    const expanded = new Set([...receiptList.querySelectorAll?.('details[open]') || []].map(item => item.dataset.transaction));
    receiptList.replaceChildren();
    for (const batch of mine.slice(0, 5)) {
      const summary = playlistReceiptSummary(batch);
      const item = node('details', undefined, 'djuke-receipt');
      item.dataset.transaction = batch.transactionHash;
      item.dataset.state = summary.state;
      item.open = expanded.has(batch.transactionHash);
      const heading = node('summary');
      heading.append(node('span', batch.name, 'djuke-receipt-name'), node('span', summary.label, 'djuke-receipt-badge'));
      const progress = node('div', undefined, 'djuke-receipt-progress');
      progress.setAttribute('role', 'progressbar');
      progress.setAttribute('aria-label', 'Songs delivered');
      progress.setAttribute('aria-valuemin', '0');
      progress.setAttribute('aria-valuemax', String(summary.total));
      progress.setAttribute('aria-valuenow', String(summary.delivered));
      const fill = node('span');
      fill.style.width = `${summary.delivered / summary.total * 100}%`;
      progress.append(fill);
      const links = node('div', undefined, 'djuke-receipt-links');
      for (const [label, hash] of [['Purchase', batch.transactionHash],
        [summary.state === 'refunded' ? 'Refund on Base' : 'Settlement on Base', batch.resolutionTransactionHash]]) {
        if (!/^0x[0-9a-f]{64}$/i.test(hash || '')) continue;
        const link = node('a', label);
        link.href = `https://basescan.org/tx/${hash}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        links.append(link);
      }
      item.append(heading, progress, node('p', summary.progress, 'djuke-receipt-count'),
        node('p', summary.payment), node('p', summary.note), links);
      receiptList.append(item);
    }
  };
  const updateWallet = () => {
    const address = window._wallet?.address;
    if (!busy && walletPromptShown && address) {
      paymentStatus.textContent = '';
      walletPromptShown = false;
    }
    renderReceipts();
    syncPayButton();
  };
  async function refreshEarners() {
    const check = ++earnersGeneration;
    const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
    try {
      if (!service) throw new Error('DJuke earnings service is not configured');
      const response = await fetch(`${service}/api/djuke/earners`, { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(response.status === 404 || response.status === 503
        ? 'Earnings index unavailable; retry shortly.' : `Earnings unavailable (${response.status})`);
      const result = await response.json();
      if (result.chainId !== 8453 || result.asset !== 'USDC' || result.period !== 'all-time' ||
          !Array.isArray(result.earners) || result.earners.length > 3 ||
          result.earners.some(entry => !/^0x[0-9a-f]{40}$/i.test(entry.address) || !/^\d+$/.test(entry.totalUnits))) {
        throw new Error('Invalid DJuke earnings response');
      }
      if (check !== earnersGeneration || !isOpen()) return;
      earners.replaceChildren();
      result.earners.forEach((entry, index) => {
        const item = node('li');
        const link = node('a');
        link.href = `https://basescan.org/address/${entry.address}#tokentxns`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.title = entry.address;
        link.setAttribute('aria-label', `View payouts for ${entry.address}`);
        link.innerHTML = renderWalletAddress(entry.address);
        item.append(node('span', ['🥇', '🥈', '🥉'][index]), link,
          node('strong', formatDjukeUsdc(BigInt(entry.totalUnits))));
        earners.append(item);
        lookupEnsName(entry.address).then(name => {
          if (name && check === earnersGeneration && isOpen()) {
            link.textContent = name;
            link.setAttribute('aria-label', `View payouts for ${name}`);
          }
        }).catch(error => {
          if (check === earnersGeneration && isOpen()) {
            link.title = `${entry.address} · ENS unavailable: ${error.message}`;
          }
        });
      });
      earnerStatus.textContent = result.earners.length ? '' : 'No confirmed song-play payouts yet.';
    } catch (error) {
      if (check !== earnersGeneration || !isOpen()) return;
      earners.replaceChildren();
      earnerStatus.textContent = `Earnings unavailable: ${error.message}`;
    }
  }
  async function refresh() {
    clearTimeout(timer);
    if (!isOpen() && !ownProfileOpen()) return;
    if (isOpen()) refreshEarners();
    const requestGeneration = ++generation;
    if (!live) status.textContent = 'Loading queue…';
    const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
    try {
      if (!service) throw new Error('DJuke service is not configured');
      const response = await fetch(`${service}/api/djuke`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      if (response.status === 404) throw new Error('DJuke queue is not live yet');
      if (!response.ok) throw new Error(`Queue unavailable (${response.status})`);
      const snapshot = await response.json();
      const requests = readDjukeQueue(snapshot);
      if (requestGeneration !== generation || (!isOpen() && !ownProfileOpen())) return;
      receiptSnapshot = snapshot.playlistReceipts || [];
      if (receiptStatus) receiptStatus.textContent = '';
      renderReceipts();
      const wallet = window._wallet?.address?.toLowerCase();
      const queueKey = JSON.stringify([snapshot.contractAddress, requests, snapshot.playlistBatches, wallet, paymentsLive()]);
      if (queue.dataset.snapshot !== queueKey) {
        const scrollPositions = [...queue.querySelectorAll('.djuke-playlist-songs')].map(list => [list.dataset.batch, list.scrollTop]);
        const scrollTop = queue.scrollTop;
        queue.replaceChildren();
        requests.forEach((request, index) => {
          if (request.playlistLaneId !== undefined &&
              snapshot.playlistBatches?.some(batch => batch.batchId === request.playlistBatchId)) return;
          const item = node('li');
          item.dataset.djukeRequest = request.requestId;
          const details = node('span', undefined, 'djuke-request-details');
          details.append(node('strong', request.title), node('span', typeof request.artist === 'string' ? request.artist : ''));
          if (paymentsLive() && request.playable === false && wallet && String(request.payer).toLowerCase() === wallet) {
            const replace = node('button', 'Replace with selected song', 'djuke-replace');
            replace.type = 'button';
            replace.addEventListener('click', () => replaceRequest(request));
            details.append(node('span', 'This recording is unavailable — choose a replacement above.'), replace);
          }
          item.append(node('span', String(index + 1).padStart(2, '0'), 'djuke-request-number'), details);
          queue.append(item);
        });
        for (const batch of snapshot.playlistBatches || []) {
          const item = node('li', undefined, 'djuke-playlist-queue');
          const details = node('div', undefined, 'djuke-request-details');
          details.append(node('strong', playlistBatchProgress(batch).heading));
          const songs = node('ol');
          songs.className = 'djuke-playlist-songs';
          songs.dataset.batch = batch.batchId;
          for (const song of batch.songs) {
            const entry = node('li');
            entry.append(node('span', `${song.title}${song.artist ? ` — ${song.artist}` : ''}`));
            const label = node('span', song.status, 'djuke-queue-song-status');
            label.dataset.queueSongStatus = '';
            entry.append(label);
            entry.dataset.djukeRequest = `8453:${snapshot.contractAddress.toLowerCase()}:playlist:${song.laneId}`;
            entry.dataset.state = song.status;
            songs.append(entry);
          }
          details.append(songs);
          item.append(details);
          queue.append(item);
          songs.scrollTop = scrollPositions.find(([id]) => id === batch.batchId)?.[1] || 0;
        }
        queue.scrollTop = scrollTop;
        queue.dataset.snapshot = queueKey;
      }
      queueFocus.sync();
      const pendingCount = Number.isSafeInteger(snapshot.mainPending) && Number.isSafeInteger(snapshot.playlistPending)
        ? snapshot.mainPending + snapshot.playlistPending : requests.length;
      const quote = quoteDjuke(pendingCount);
      live = { ...snapshot, priceUnits: quote.priceUnits.toString() };
      price.textContent = formatDjukeUsdc(quote.priceUnits);
      count.textContent = String(pendingCount);
      renderTiers(pendingCount);
      status.textContent = pendingCount ? 'Main paid requests precede playlist songs' : 'No paid requests';
      renderSongs({ deferWhileFocused: true });
      updateWallet();
      refreshGasQuote();
    } catch (error) {
      if (requestGeneration !== generation || (!isOpen() && !ownProfileOpen())) return;
      delete queue.dataset.snapshot;
      unavailable(error.message);
    }
    if (isOpen() || ownProfileOpen()) timer = setTimeout(refresh, 15000);
  }
  async function runPayment(action, success) {
    if (busy) return;
    busy = true;
    syncPayButton();
    try {
      await action();
      paymentStatus.textContent = success;
    } catch (error) {
      paymentStatus.textContent = error.shortMessage || error.reason || error.message;
    } finally {
      busy = false;
      // Any payment attempt may consume the signed quote nonce; fetch a fresh one next time.
      gasQuote = null;
      gasQuoteKey = '';
      renderGasStatus();
      syncPayButton();
      refresh();
    }
  }
  function replaceRequest(request) {
    const songId = selectedSongId();
    if (!songId) { paymentStatus.textContent = 'Select a replacement song first'; return; }
    runPayment(() => replaceDjukeRequest({ ...contracts(), chainRequestId: request.chainRequestId, songId }),
      'Replacement confirmed. Your place in line and payment are unchanged.');
  }
  pay.addEventListener('click', () => {
    if (!window._wallet?.address) {
      walletPromptShown = true;
      paymentStatus.textContent = 'Connect your wallet in the header to queue a song';
      return;
    }
    const songId = selectedSongId();
    if (!paymentsLive() || !songId || !live?.priceUnits) return;
    if (supportsDjukeAlbumsAndGas(window.DecentConfig?.djukeContractVersion) && (!gasQuote || gasQuote.deadline <= Date.now() / 1000)) {
      refreshGasQuote({ force: true });
      return;
    }
    runPayment(() => payForDjukeSong({ ...contracts(), songId, maxPriceUnits: BigInt(live.priceUnits), gasQuote,
      onStep: message => { paymentStatus.textContent = message; } }),
    'Queued! Your song plays after the paid requests ahead of it.');
  });
  select.addEventListener('change', () => { renderSongs(); refreshGasQuote(); });
  const queueFocus = mountDjukeQueueFocus({ queue, isOpen, root: document, initialState: getRadioStateSnapshot() });
  select.addEventListener('blur', () => { if (live) renderSongs(); });
  search?.addEventListener('input', () => { renderSongs(); refreshGasQuote(); });
  const close = () => {
    if (instructions.open) instructions.close();
    earnersGeneration++;
    clearTimeout(timer);
    generation++;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open DJuke');
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    panel.inert = true;
    document.body.classList.remove('djuke-open');
    if (ownProfileOpen()) refresh();
  };
  toggle.addEventListener('click', event => {
    event.stopPropagation();
    if (isOpen()) { close(); return; }
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Close DJuke');
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    panel.inert = false;
    document.body.classList.add('djuke-open');
    queueFocus.sync({ force: true });
    document.dispatchEvent(new CustomEvent('left-drawer-open', { detail: 'djuke' }));
    updateWallet();
    refresh();
  });
  info.addEventListener('click', () => instructions.showModal());
  instructions.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      instructions.close();
    }
  });
  document.getElementById('djuke-instructions-close').addEventListener('click', () => instructions.close());
  instructions.addEventListener('close', () => { if (isOpen()) info.focus(); });
  document.getElementById('djuke-close').addEventListener('click', () => { close(); toggle.focus(); });
  document.getElementById('djuke-refresh').addEventListener('click', refresh);
  document.addEventListener('creator-profile-view-changed', event => {
    profileAddress = event.detail.address;
    renderReceipts();
    if (ownProfileOpen() || isOpen()) refresh();
    else { clearTimeout(timer); generation++; }
  });
  profileDialog?.addEventListener('close', () => {
    profileAddress = '';
    renderReceipts();
    if (!isOpen()) { clearTimeout(timer); generation++; }
  });
  document.addEventListener('djuke-radio-playlist-purchased', event => {
    const { txHash, totalUnits, name, songIds } = event.detail;
    provisionalReceipt = { transactionHash: txHash, payer: window._wallet?.address?.toLowerCase(),
      name, songs: songIds.map(songId => ({ songId, status: 'pending' })), status: 'confirming',
      subtotalUnits: String(totalUnits), feeUnits: '0' };
    renderReceipts();
    refresh();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && isOpen() && !instructions.open) { close(); toggle.focus(); }
  });
  document.addEventListener('left-drawer-open', event => { if (event.detail !== 'djuke' && isOpen()) close(); });
  document.addEventListener('click', event => {
    const path = event.composedPath();
    if (path.some(element => element.id === 'payment-celebration-root' && element.dataset.source === 'djuke')) return;
    if (isOpen() && !path.includes(panel) && !path.includes(toggle) && !path.includes(instructions)) close();
  });
  document.addEventListener('wallet-connected', updateWallet);
  document.addEventListener('wallet-disconnected', updateWallet);
  document.addEventListener('wallet-chain-changed', updateWallet);
  document.addEventListener('wallet-connected', refreshGasQuote);
  document.addEventListener('wallet-disconnected', refreshGasQuote);
  document.addEventListener('wallet-chain-changed', refreshGasQuote);
  renderTiers(null);
  import('https://cdn.jsdelivr.net/npm/lucide@0.468.0/+esm').then(icons => {
    for (const element of document.querySelectorAll('[data-djuke-icon]')) {
      const icon = icons[element.dataset.djukeIcon];
      if (icon) element.replaceChildren(icons.createElement(icon, { 'aria-hidden': 'true' }));
    }
  }).catch(() => {});
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initDjuke, { once: true });