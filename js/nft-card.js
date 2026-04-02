// js/nft-card.js — DecentBusking
// NFT detail panel — mirrors the listing style used in DecentMarket.
// Rendered when a user clicks on a floating NFT mesh in the space field.

// Minimal DecentNFT ABI — only what we need for buying
const BUY_ABI = [
  'function buy(uint256 tokenId) external payable',
  'function getPrice(uint256 tokenId) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
];

// ── Public API ───────────────────────────────────────────────────────────
export function renderNFTCard(nft) {
  const panel = document.getElementById('nft-panel');
  const content = document.getElementById('nft-panel-content');
  const closeBtn = document.getElementById('nft-panel-close');

  if (!panel || !content) return;

  content.innerHTML = _buildCardHTML(nft);
  panel.classList.remove('hidden');

  // Wire close button
  if (closeBtn) {
    closeBtn.onclick = () => panel.classList.add('hidden');
  }

  // Wire buy button (rendered inside content)
  const buyBtn = content.querySelector('.nft-buy-btn');
  if (buyBtn) {
    buyBtn.addEventListener('click', () => _handleBuy(nft));
  }

  // Fetch live price if contract configured
  _loadLivePrice(nft).then(priceEth => {
    const priceEl = content.querySelector('.nft-price-value');
    if (priceEl && priceEth !== null) {
      priceEl.textContent = `${priceEth} ETH`;
    }
  });
}

// ── Card HTML ─────────────────────────────────────────────────────────────
function _buildCardHTML(nft) {
  const cfg = window.DecentConfig || {};
  const gateway = cfg.ipfsGateway || 'https://w3s.link/ipfs/';

  const audioUrl = (nft.audioUrl || nft.animation_url || '')
    .replace('ipfs://', gateway);

  const shortCreator = _shortAddr(nft.artist || nft.creator || '');
  const shortOwner = _shortAddr(nft.owner || '');
  const mintedDate   = nft.mintedAt
    ? new Date(nft.mintedAt).toLocaleDateString()
    : '—';
  const ageLabel     = nft.mintedAt ? _ageLabel(new Date(nft.mintedAt)) : '';
  const parentRef    = nft.parentTokenId
    ? `<dt>Covers</dt><dd>#${nft.parentTokenId}</dd>`
    : '';

  return `
    <h3>🎵 ${_esc(nft.name || nft.title || `Track #${nft.tokenId}`)}</h3>

    ${audioUrl ? `<audio controls src="${_esc(audioUrl)}"></audio>` : ''}

    <dl class="nft-meta">
      <dt>Token ID</dt><dd>#${nft.tokenId ?? '?'}</dd>
      ${shortCreator ? `<dt>Artist</dt><dd>${_esc(shortCreator)}</dd>` : ''}
      ${shortOwner   ? `<dt>Owner</dt><dd>${_esc(shortOwner)}</dd>`   : ''}
      <dt>Minted</dt><dd>${_esc(mintedDate)} ${ageLabel ? `<em style="color:var(--text-dim)">(${_esc(ageLabel)})</em>` : ''}</dd>
      ${parentRef}
      ${nft.tipWallet ? `<dt>Tip Wallet</dt><dd style="font-size:0.8em">${_esc(_shortAddr(nft.tipWallet))}</dd>` : ''}
    </dl>

    <p class="nft-price">
      Price: <strong class="nft-price-value">loading…</strong>
    </p>

    <button class="nft-buy-btn">🎵 Buy &amp; Support</button>
  `;
}

// ── Live Price Fetch ───────────────────────────────────────────────────────
async function _loadLivePrice(nft) {
  const cfg = window.DecentConfig || {};
  if (!cfg.contractAddress || cfg.contractAddress === '0x0000000000000000000000000000000000000000') {
    return null;
  }
  if (!nft.tokenId) return null;

  try {
    const provider = new ethers.JsonRpcProvider(
      `https://mainnet.optimism.io`
    );
    const contract = new ethers.Contract(cfg.contractAddress, BUY_ABI, provider);
    const priceWei = await contract.getPrice(nft.tokenId);
    return ethers.formatEther(priceWei);
  } catch {
    return null;
  }
}

// ── Buy Handler ───────────────────────────────────────────────────────────
async function _handleBuy(nft) {
  const cfg = window.DecentConfig || {};
  const buyBtn = document.querySelector('.nft-buy-btn');

  if (!window.ethereum) {
    alert('🦊 MetaMask not detected. Install it to buy NFTs.');
    return;
  }

  if (!cfg.contractAddress || cfg.contractAddress === '0x0000000000000000000000000000000000000000') {
    alert('⚠️ Contract address not configured.');
    return;
  }

  try {
    if (buyBtn) buyBtn.disabled = true;

    const provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send('eth_requestAccounts', []);
    const signer = await provider.getSigner();

    const network = await provider.getNetwork();
    if (Number(network.chainId) !== (cfg.chainId || 10)) {
      alert(`⚠️ Switch MetaMask to chain ID ${cfg.chainId || 10} (Optimism).`);
      if (buyBtn) buyBtn.disabled = false;
      return;
    }

    const contract = new ethers.Contract(cfg.contractAddress, BUY_ABI, signer);
    const priceWei = await contract.getPrice(nft.tokenId);

    const tx = await contract.buy(nft.tokenId, { value: priceWei });
    if (buyBtn) buyBtn.textContent = '⏳ Confirming…';
    await tx.wait();

    if (buyBtn) buyBtn.textContent = '✅ Purchased!';
    setTimeout(() => {
      document.getElementById('nft-panel')?.classList.add('hidden');
    }, 2000);
  } catch (err) {
    alert(`❌ Purchase failed: ${err.message}`);
    if (buyBtn) buyBtn.disabled = false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function _shortAddr(addr = '') {
  return addr.length > 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function _esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _ageLabel(date) {
  const ms = Date.now() - date.getTime();
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1 month ago' : `${months} months ago`;
}
