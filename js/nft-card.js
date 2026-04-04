// js/nft-card.js — DecentBusking
// NFT detail panel — mirrors the listing style used in DecentMarket.
// Rendered when a user clicks on a floating NFT mesh in the space field.

import { fetchNFTMetaById } from './space.js';

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

  // Wire parent-play button if present
  const parentPlayBtn = content.querySelector('.nft-parent-play-btn');
  if (parentPlayBtn) {
    parentPlayBtn.addEventListener('click', () => _playParent(nft.parentTokenId));
  }

  // Fetch live price if contract configured
  _loadLivePrice(nft).then(priceEth => {
    const priceEl = content.querySelector('.nft-price-value');
    if (priceEl && priceEth !== null) {
      priceEl.textContent = `${priceEth} ETH`;
    }
  });

  // Fetch and render parent NFT info if this is a remix
  if (nft.parentTokenId) {
    fetchNFTMetaById(nft.parentTokenId).then(parentMeta => {
      const parentSection = content.querySelector('.nft-parent-section');
      if (!parentSection || !parentMeta) return;
      const cfg = window.DecentConfig || {};
      const gateway = cfg.ipfsGateway || 'https://w3s.link/ipfs/';
      const parentAudioUrl = (parentMeta.audioUrl || parentMeta.animation_url || '')
        .replace('ipfs://', gateway);
      const parentTitle = _esc(parentMeta.name || parentMeta.title || `Track #${nft.parentTokenId}`);
      const parentArtist = _esc(_shortAddr(parentMeta.artist || parentMeta.creator || ''));
      const royaltyPct = nft.royaltyChain?.royaltyPct ?? '';
      parentSection.innerHTML = `
        <div class="nft-parent-card">
          <span class="nft-parent-badge">🔗 Remix of</span>
          <strong>#${nft.parentTokenId} — ${parentTitle}</strong>
          ${parentArtist ? `<span class="nft-parent-artist">by ${parentArtist}</span>` : ''}
          ${royaltyPct !== '' ? `<span class="nft-royalty-badge">💸 ${royaltyPct}% royalty upstream</span>` : ''}
          ${parentAudioUrl ? `<audio class="nft-parent-audio" controls src="${_esc(parentAudioUrl)}"></audio>` : ''}
        </div>`;
    });
  }
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

  const royaltyChain = nft.royaltyChain;
  const royaltyRow = royaltyChain?.royaltyPct != null
    ? `<dt>Royalty Upstream</dt><dd>${_esc(String(royaltyChain.royaltyPct))}%</dd>`
    : '';

  // Placeholder section shown for remixes — populated async after parent fetch
  const parentSection = nft.parentTokenId
    ? `<div class="nft-parent-section">
         <div class="nft-parent-card nft-parent-loading">⏳ Loading parent track #${nft.parentTokenId}…</div>
       </div>`
    : '';

  return `
    <h3>🎵 ${_esc(nft.name || nft.title || `Track #${nft.tokenId}`)}</h3>

    ${audioUrl ? `<audio controls src="${_esc(audioUrl)}"></audio>` : ''}

    ${parentSection}

    <dl class="nft-meta">
      <dt>Token ID</dt><dd>#${nft.tokenId ?? '?'}</dd>
      ${shortCreator ? `<dt>Artist</dt><dd>${_esc(shortCreator)}</dd>` : ''}
      ${shortOwner   ? `<dt>Owner</dt><dd>${_esc(shortOwner)}</dd>`   : ''}
      <dt>Minted</dt><dd>${_esc(mintedDate)} ${ageLabel ? `<em style="color:var(--text-dim)">(${_esc(ageLabel)})</em>` : ''}</dd>
      ${royaltyRow}
      ${nft.tipWallet ? `<dt>Tip Wallet</dt><dd style="font-size:0.8em">${_esc(_shortAddr(nft.tipWallet))}</dd>` : ''}
    </dl>

    <p class="nft-price">
      Price: <strong class="nft-price-value">loading…</strong>
    </p>

    <button class="nft-buy-btn">🎵 Buy &amp; Support</button>
  `;
}

// ── Parent Track Playback ─────────────────────────────────────────────────
async function _playParent(parentTokenId) {
  if (!parentTokenId) return;
  const { setNowPlaying } = await import('./stage.js');
  const meta = await fetchNFTMetaById(parentTokenId);
  if (!meta) return;
  const cfg = window.DecentConfig || {};
  const gateway = cfg.ipfsGateway || 'https://w3s.link/ipfs/';
  const audioUrl = (meta.audioUrl || meta.animation_url || '').replace('ipfs://', gateway);
  setNowPlaying({
    title: meta.name || meta.title || `Track #${parentTokenId}`,
    artist: meta.artist || meta.creator || '',
    audioUrl,
  });
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

    const signer = window._wallet?.signer;
    if (!signer) {
      alert('🦊 Please connect your wallet via the header first.');
      if (buyBtn) buyBtn.disabled = false;
      return;
    }

    const chainId = window._wallet.chainId;
    if (chainId !== null && Number(chainId) !== (cfg.chainId || 10)) {
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
