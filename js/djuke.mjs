import { supportsDjukeAlbumsAndGas, DJUKE_SIGNING_DOMAIN_VERSION } from './djuke-version.mjs';
import { approvalNotice, ensureBaseNetwork, retryMissingRevertData, waitForAllowance } from './base-chain.mjs';
import { announcePaymentCelebration } from './payment-celebration.mjs';
import { formatUsdcUnits } from './usdc-format.mjs?v=20261017-mercury-release';
import { USDC_BROWSER_ABI } from './usdc-abi.mjs';
import { lookupEnsName } from './ens-client.mjs?v=20261016-ens-worker';
import { renderWalletAddress } from './fund-display.mjs?v=20261017-mercury-release';
export { USDC_BROWSER_ABI };

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
  'function quote() view returns (uint256)',
  'function requestPlay(bytes32 songId, uint256 maxPrice) returns (uint256)',
  'function replaceRequest(uint256 requestId, bytes32 songId)',
  'function gasWorker() view returns(address)',
  'function maxGasContributionWei() view returns(uint256)',
  'function gasQuoteNonces(address) view returns(uint256)',
  'function requestPlayWithGas(bytes32,uint256,uint256,uint256,bytes) payable returns(uint256)',
];
export async function payForDjukeSong({ signer, djuke, usdc, songId, maxPriceUnits, gasQuote = null, onStep = () => {} }) {
  await ensureBaseNetwork(signer.provider);
  if (usdc.target.toLowerCase() !== BASE_USDC_ADDRESS.toLowerCase() || Number(await usdc.decimals()) !== 6) throw new Error('Configured token is not native Base USDC');
  if (!/^0x[0-9a-fA-F]{64}$/.test(songId || '')) throw new Error('Select a song');
  const address = await signer.getAddress();
  const price = await djuke.quote();
  if (price > maxPriceUnits) throw new Error(`Price rose to ${formatDjukeUsdc(price)} USDC; refresh and try again`);
  if (await usdc.balanceOf(address) < price) throw new Error(`You need ${formatDjukeUsdc(price)} USDC on Base`);
  if (gasQuote) {
    if (gasQuote.listener.toLowerCase() !== address.toLowerCase() || gasQuote.songId !== songId ||
        gasQuote.contractAddress.toLowerCase() !== djuke.target.toLowerCase() || gasQuote.chainId !== 8453 ||
        Number(gasQuote.deadline) <= Math.floor(Date.now() / 1000) || BigInt(gasQuote.maxPrice) !== maxPriceUnits) throw new Error('Refresh the worker gas quote');
    const [worker, cap, nonce] = await Promise.all([djuke.gasWorker(), djuke.maxGasContributionWei(), djuke.gasQuoteNonces(address)]);
    const contribution = BigInt(gasQuote.contributionWei);
    if (contribution <= 0n || contribution !== BigInt(gasQuote.fulfillmentCostWei) * 2n || contribution > cap ||
        String(nonce) !== String(gasQuote.nonce)) throw new Error('Invalid worker gas quote');
    const types = { GasQuote: [{ name: 'listener', type: 'address' }, { name: 'songId', type: 'bytes32' },
      { name: 'maxPrice', type: 'uint256' }, { name: 'fulfillmentCostWei', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] };
    const recovered = ethers.verifyTypedData({ name: 'DecentJukeBox', version: DJUKE_SIGNING_DOMAIN_VERSION, chainId: 8453, verifyingContract: djuke.target }, types, gasQuote, gasQuote.signature);
    if (recovered.toLowerCase() !== worker.toLowerCase()) throw new Error('Invalid worker gas signature');
    if (await signer.provider.getBalance(address) < contribution) throw new Error('Insufficient Base ETH for worker gas contribution');
  }
  if (await usdc.allowance(address, djuke.target) < price) {
    onStep(approvalNotice(formatDjukeUsdc(price)));
    if ((await (await usdc.approve(djuke.target, price)).wait())?.status !== 1) throw new Error('USDC approval did not confirm');
    onStep('Confirming approval…');
    await waitForAllowance(usdc, address, djuke.target, price);
  }
  const args = gasQuote ? [songId, maxPriceUnits, BigInt(gasQuote.fulfillmentCostWei), gasQuote.deadline, gasQuote.signature,
    { value: BigInt(gasQuote.contributionWei) }] : [songId, maxPriceUnits];
  const request = gasQuote ? djuke.requestPlayWithGas : djuke.requestPlay;
  onStep('Creating request…');
  await retryMissingRevertData(
    () => request.staticCall(...args),
    async () => {
      onStep('Confirming approval…');
      await waitForAllowance(usdc, address, djuke.target, price);
    },
  );
  onStep('Confirm your DJuke request');
  const transaction = await request(...args);
  onStep('Waiting for Base confirmation…');
  if ((await transaction.wait())?.status !== 1) throw new Error('DJuke request did not confirm');
  announcePaymentCelebration({
    chainId: 8453,
    txHash: transaction.hash,
    amountText: formatDjukeUsdc(price),
    assetText: 'USDC',
    summary: 'DJuke queue payment confirmed',
    txLabel: 'DJuke request confirmed',
  });
  return { txHash: transaction.hash, priceUnits: price };
}

export async function replaceDjukeRequest({ signer, djuke, chainRequestId, songId }) {
  if (Number((await signer.provider.getNetwork()).chainId) !== 8453) throw new Error('Switch your wallet to Base');
  await djuke.replaceRequest.staticCall(BigInt(chainRequestId), songId);
  const transaction = await djuke.replaceRequest(BigInt(chainRequestId), songId);
  if ((await transaction.wait())?.status !== 1) throw new Error('Replacement did not confirm');
  return transaction.hash;
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
    if (gasStatus) gasStatus.textContent = 'Estimating worker gas';
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
        ? 'Worker gas estimate is busy; retrying shortly' : error.message;
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
      ['Worker wallet ETH contribution', `~${formatDjukeEth(BigInt(gasQuote.contributionWei))} ETH`],
    ];
    for (const [label, value] of rows) {
      const row = node('div', undefined, 'djuke-gas-summary-row');
      row.append(node('dt', label), node('dd', value));
      list.append(row);
    }
    summary.append(list, node('p', 'Worker ETH funds automated playback execution on Base so listeners do not face a surprise ETH prompt.'));
    gasStatus.replaceChildren(summary);
  };
  const renderSongs = () => {
    const previous = select.value;
    const liveTracks = Array.isArray(live?.tracks) ? live.tracks : [];
    const tracks = filterDjukeSongs(liveTracks, search?.value || '');
    const placeholder = node('option', tracks.length ? 'Select one song' : 'No matching songs');
    placeholder.value = '';
    select.replaceChildren(placeholder);
    const previousTrack = liveTracks.find(track => track.trackId === previous);
    const options = previousTrack && !tracks.some(track => track.trackId === previousTrack.trackId)
      ? [...tracks, previousTrack] : tracks;
    for (const track of options) {
      const option = node('option', track.artist ? `${track.title} - ${track.artist}` : track.title);
      option.value = track.trackId;
      select.append(option);
    }
    if (searchState) searchState.textContent = tracks.length ? `${tracks.length} matching songs` : 'No matching songs';
    select.value = options.some(track => track.trackId === previous) ? previous : '';
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
    select.replaceChildren(node('option', 'Song catalog unavailable'));
    select.disabled = true;
    if (searchState) searchState.textContent = 'Song catalog unavailable; refresh to retry.';
    renderTiers(null);
    status.textContent = message;
    syncPayButton();
  };
  const updateWallet = () => {
    const address = window._wallet?.address;
    if (!busy && walletPromptShown && address) {
      paymentStatus.textContent = '';
      walletPromptShown = false;
    }
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
    if (!isOpen()) return;
    refreshEarners();
    const requestGeneration = ++generation;
    status.textContent = 'Loading queue…';
    const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
    try {
      if (!service) throw new Error('DJuke service is not configured');
      const response = await fetch(`${service}/api/djuke`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      if (response.status === 404) throw new Error('DJuke queue is not live yet');
      if (!response.ok) throw new Error(`Queue unavailable (${response.status})`);
      const snapshot = await response.json();
      const requests = readDjukeQueue(snapshot);
      if (requestGeneration !== generation || !isOpen()) return;
      const wallet = window._wallet?.address?.toLowerCase();
      queue.replaceChildren();
      requests.forEach((request, index) => {
        const item = node('li');
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
      const quote = quoteDjuke(requests.length);
      live = { ...snapshot, priceUnits: quote.priceUnits.toString() };
      price.textContent = formatDjukeUsdc(quote.priceUnits);
      count.textContent = String(requests.length);
      renderTiers(requests.length);
      status.textContent = requests.length ? 'First paid · first played' : 'No paid requests';
      renderSongs();
      updateWallet();
      refreshGasQuote();
    } catch (error) {
      if (requestGeneration !== generation || !isOpen()) return;
      unavailable(error.message);
    }
    if (isOpen()) timer = setTimeout(refresh, 15000);
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
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && isOpen() && !instructions.open) { close(); toggle.focus(); }
  });
  document.addEventListener('left-drawer-open', event => { if (event.detail !== 'djuke' && isOpen()) close(); });
  document.addEventListener('click', event => {
    const path = event.composedPath();
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