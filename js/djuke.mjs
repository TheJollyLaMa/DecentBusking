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
  const fraction = String(units % 1000000n).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${units / 1000000n}.${fraction}`;
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
export const USDC_BROWSER_ABI = [
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
];

export async function payForDjukeSong({ signer, djuke, usdc, songId, maxPriceUnits, gasQuote = null, onStep = () => {} }) {
  if (Number((await signer.provider.getNetwork()).chainId) !== 8453) throw new Error('Switch your wallet to Base');
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
    const recovered = ethers.verifyTypedData({ name: 'DecentJukeBox', version: '0.2', chainId: 8453, verifyingContract: djuke.target }, types, gasQuote, gasQuote.signature);
    if (recovered.toLowerCase() !== worker.toLowerCase()) throw new Error('Invalid worker gas signature');
    if (await signer.provider.getBalance(address) < contribution) throw new Error('Insufficient Base ETH for worker gas contribution');
  }
  if (await usdc.allowance(address, djuke.target) < price) {
    onStep(`Approve exactly ${formatDjukeUsdc(price)} USDC`);
    if ((await (await usdc.approve(djuke.target, price)).wait())?.status !== 1) throw new Error('USDC approval did not confirm');
  }
  const args = gasQuote ? [songId, maxPriceUnits, BigInt(gasQuote.fulfillmentCostWei), gasQuote.deadline, gasQuote.signature,
    { value: BigInt(gasQuote.contributionWei) }] : [songId, maxPriceUnits];
  const request = gasQuote ? djuke.requestPlayWithGas : djuke.requestPlay;
  await request.staticCall(...args);
  onStep('Confirm your DJuke request');
  const transaction = await request(...args);
  onStep('Waiting for Base confirmation…');
  if ((await transaction.wait())?.status !== 1) throw new Error('DJuke request did not confirm');
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
  const connect = document.getElementById('djuke-connect');
  const paymentStatus = document.getElementById('djuke-payment-state');
  const tiers = document.getElementById('djuke-price-tiers');
  const pay = document.getElementById('djuke-pay');
  const gasStatus = document.getElementById('djuke-gas-status');
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
      (window.DecentConfig?.djukeContractVersion !== '0.2' || !!gasQuote && gasQuote.deadline > Date.now() / 1000);
    pay.disabled = !ready;
    pay.title = paymentsLive() ? 'Pay to queue the selected song' : 'DJuke payments are not live yet';
  };
  const refreshGasQuote = async () => {
    gasQuote = null;
    const check = ++gasGeneration;
    if (gasStatus) gasStatus.textContent = '';
    syncPayButton();
    const songId = selectedSongId();
    if (window.DecentConfig?.djukeContractVersion !== '0.2' || !songId || !window._wallet?.address) return;
    if (gasStatus) gasStatus.textContent = 'Estimating worker gas';
    try {
      const response = await fetch(`${window.DecentConfig.ipfsUploadServiceUrl}/api/djuke/gas-quote?${new URLSearchParams({ listener: window._wallet.address, songId })}`, { signal: AbortSignal.timeout(15000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Gas quote unavailable');
      if (check !== gasGeneration) return;
      gasQuote = result;
      if (gasStatus) gasStatus.textContent = `Worker gas: ${ethers.formatEther(result.contributionWei)} ETH on Base (2x estimate), plus your transaction gas`;
    } catch (error) { if (check === gasGeneration && gasStatus) gasStatus.textContent = error.message; }
    syncPayButton();
  };
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const renderSongs = () => {
    const previous = select.value;
    const tracks = filterDjukeSongs(live?.tracks, search?.value || '');
    select.replaceChildren(node('option', tracks.length ? 'Select one song' : 'No matching songs'));
    for (const track of tracks) {
      const option = node('option', track.artist ? `${track.title} - ${track.artist}` : track.title);
      option.value = track.trackId;
      select.append(option);
    }
    select.value = tracks.some(track => track.trackId === previous) ? previous : '';
    select.disabled = !tracks.length;
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
    renderTiers(null);
    status.textContent = message;
    syncPayButton();
  };
  const updateWallet = () => {
    const address = window._wallet?.address;
    connect.disabled = !!address;
    connect.hidden = !!address;
    connect.querySelector('span:last-child').textContent = 'Connect Wallet';
    if (!busy) {
      paymentStatus.textContent = !paymentsLive() ? 'Payments not live'
        : !address ? 'Connect a Base wallet to queue a song'
        : window._wallet?.chainId !== 8453 ? 'Switch your wallet to Base' : 'Pick a song, then queue it';
    }
    syncPayButton();
  };
  async function refresh() {
    clearTimeout(timer);
    if (!isOpen()) return;
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
      live = snapshot;
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
    const songId = selectedSongId();
    if (!paymentsLive() || !songId || !live?.priceUnits) return;
    if (window.DecentConfig?.djukeContractVersion === '0.2' && (!gasQuote || gasQuote.deadline <= Date.now() / 1000)) {
      refreshGasQuote();
      return;
    }
    runPayment(() => payForDjukeSong({ ...contracts(), songId, maxPriceUnits: BigInt(live.priceUnits), gasQuote,
      onStep: message => { paymentStatus.textContent = message; } }),
    'Queued! Your song plays after the paid requests ahead of it.');
  });
  select.addEventListener('change', refreshGasQuote);
  search?.addEventListener('input', () => { renderSongs(); refreshGasQuote(); });
  const close = () => {
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
  document.getElementById('djuke-close').addEventListener('click', () => { close(); toggle.focus(); });
  document.getElementById('djuke-refresh').addEventListener('click', refresh);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && isOpen()) { close(); toggle.focus(); }
  });
  document.addEventListener('left-drawer-open', event => { if (event.detail !== 'djuke' && isOpen()) close(); });
  document.addEventListener('click', event => {
    if (isOpen() && !panel.contains(event.target) && !toggle.contains(event.target)) close();
  });
  connect.addEventListener('click', async () => {
    if (!window._wallet?.connect || !window.ethereum) {
      paymentStatus.textContent = 'Wallet provider unavailable · payments not live';
      return;
    }
    connect.disabled = true;
    try { await window._wallet.connect(); }
    finally { updateWallet(); }
  });
  document.addEventListener('wallet-connected', updateWallet);
  document.addEventListener('wallet-disconnected', updateWallet);
  document.addEventListener('wallet-connected', refreshGasQuote);
  document.addEventListener('wallet-disconnected', refreshGasQuote);
  renderTiers(null);
  import('https://cdn.jsdelivr.net/npm/lucide@0.468.0/+esm').then(icons => {
    for (const element of document.querySelectorAll('[data-djuke-icon]')) {
      const icon = icons[element.dataset.djukeIcon];
      if (icon) element.replaceChildren(icons.createElement(icon, { 'aria-hidden': 'true' }));
    }
  }).catch(() => {});
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initDjuke, { once: true });