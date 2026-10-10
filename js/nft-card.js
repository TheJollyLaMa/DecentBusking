// js/nft-card.js — DecentBusking
// NFT detail panel — mirrors the listing style used in DecentMarket.
// Rendered when a user clicks on a floating NFT mesh in the space field.

import { fetchNFTMetaById } from './space.js?v=20261010-listens';

// ── Public API ───────────────────────────────────────────────────────────
export function renderNFTCard(nft) {
  const panel = document.getElementById('nft-panel');
  const content = document.getElementById('nft-panel-content');
  const closeBtn = document.getElementById('nft-panel-close');

  if (!panel || !content) return;

  content.innerHTML = _buildCardHTML(nft);
  panel.classList.remove('hidden');
  if (!panel.open) panel.showModal();
  panel.oncancel = (event) => {
    event.preventDefault();
    panel.close();
  };
  panel.onkeydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      panel.close();
    }
  };
  panel.onclose = () => {
    panel.classList.add('hidden');
    content.querySelectorAll('audio').forEach((audio) => audio.pause());
  };
  panel.onclick = (event) => {
    const bounds = panel.getBoundingClientRect();
    if (event.target === panel && (event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom)) panel.close();
  };

  // Wire close button
  if (closeBtn) {
    closeBtn.onclick = () => panel.close();
  }
  content.querySelector('.nft-listen-btn')?.addEventListener('click', async () => {
    if (!document.dispatchEvent(new CustomEvent('dbusk-listen', { cancelable: true, detail: { nft } }))) {
      if (nft.videoUrl || nft.mediaType === 'video/mp4') panel.close();
      return;
    }
    const { setNowPlaying } = await import('./stage.js?v=20261010-listens');
    setNowPlaying({ title: nft.name || nft.title, artist: nft.artist || nft.creator,
      audioUrl: nft.videoUrl || nft.audioUrl || nft.animation_url, mediaType: nft.mediaType || (nft.videoUrl ? 'video/mp4' : '') });
    if (nft.videoUrl || nft.mediaType === 'video/mp4') panel.close();
  });

  content.querySelector('.nft-playlist-btn')?.addEventListener('click', event => {
    const button = event.currentTarget;
    const status = text => { button.textContent = text; };
    if (document.dispatchEvent(new CustomEvent('dbusk-playlist-add', { cancelable: true, detail: { nft, status } }))) {
      status('Playlists open soon');
    }
  });

  // Wire parent-play button if present
  const parentPlayBtn = content.querySelector('.nft-parent-play-btn');
  if (parentPlayBtn) {
    parentPlayBtn.addEventListener('click', () => _playParent(nft.parentTokenId));
  }

  // Fetch and render parent NFT info if this is a remix
  if (nft.parentTokenId) {
    fetchNFTMetaById(nft.parentTokenId).then(parentMeta => {
      const parentSection = content.querySelector('.nft-parent-section');
      if (!parentSection || !parentMeta) return;
      const cfg = window.DecentConfig || {};
      const gateway = cfg.ipfsGateway || 'https://gateway.pinata.cloud/ipfs/';
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
  const gateway = cfg.ipfsGateway || 'https://gateway.pinata.cloud/ipfs/';

  const audioUrl = (nft.videoUrl || nft.audioUrl || nft.animation_url || '')
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
  const marketUrl = _marketUrl(nft);
  const imageUrl = (nft.image || '').replace('ipfs://', gateway);
  const metadataUrl = (nft.metadataUri || '').replace('ipfs://', gateway);
  const contractAddress = nft.contractAddress || cfg.contractAddress;
  const explorerUrl = `${cfg.blockExplorerUrl || 'https://basescan.org'}/token/${contractAddress}?a=${encodeURIComponent(nft.tokenId)}`;

  return `
    ${/^https?:\/\//i.test(imageUrl) ? `<img class="nft-detail-image" src="${_esc(imageUrl)}" alt="Artwork for ${_esc(nft.name || nft.title || 'this NFT')}" />` : ''}
    <h3 id="nft-detail-title">${_esc(nft.name || nft.title || `Track #${nft.tokenId}`)}</h3>

    ${audioUrl ? '<button class="nft-listen-btn nft-buy-btn" type="button">▶ Play Track</button><button class="nft-playlist-btn nft-buy-btn" type="button">+ Playlist</button>' : ''}

    ${parentSection}

    <dl class="nft-meta">
      <dt>Token ID</dt><dd>#${_esc(String(nft.tokenId ?? '?'))}</dd>
      <dt>Network</dt><dd>${_esc(cfg.chainName || 'Base Mainnet')}</dd>
      ${nft.mintedSupply != null ? `<dt>Minted Editions</dt><dd>${_esc(String(nft.mintedSupply))}</dd>` : ''}
      <dt>Contract</dt><dd>${_esc(contractAddress || '')}</dd>
      ${shortCreator ? `<dt>Artist</dt><dd>${_esc(nft.artist || nft.creator)}</dd>` : ''}
      ${shortOwner   ? `<dt>Owner</dt><dd>${_esc(shortOwner)}</dd>`   : ''}
      <dt>Minted</dt><dd>${_esc(mintedDate)} ${ageLabel ? `<em style="color:var(--text-dim)">(${_esc(ageLabel)})</em>` : ''}</dd>
      ${royaltyRow}
      ${nft.tipWallet ? `<dt>Tip Wallet</dt><dd style="font-size:0.8em">${_esc(_shortAddr(nft.tipWallet))}</dd>` : ''}
      ${nft.description ? `<dt>Description</dt><dd>${_esc(nft.description)}</dd>` : ''}
      ${audioUrl ? `<dt>${nft.videoUrl || nft.mediaType === 'video/mp4' ? 'Video' : 'Audio'} URI</dt><dd>${_esc(nft.videoUrl || nft.audioUrl || nft.animation_url)}</dd>` : ''}
      ${nft.metadataUri ? `<dt>Metadata URI</dt><dd>${_esc(nft.metadataUri)}</dd>` : ''}
    </dl>

    <div class="nft-detail-links">
      <a href="${_esc(explorerUrl)}" target="_blank" rel="noopener noreferrer">BaseScan ↗</a>
      ${/^https?:\/\//i.test(metadataUrl) ? `<a href="${_esc(metadataUrl)}" target="_blank" rel="noopener noreferrer">Metadata ↗</a>` : ''}
      ${/^https?:\/\//i.test(audioUrl) ? `<a href="${_esc(audioUrl)}" target="_blank" rel="noopener noreferrer">IPFS ${nft.videoUrl || nft.mediaType === 'video/mp4' ? 'Video' : 'Audio'} ↗</a>` : ''}
    </div>
    <a class="nft-buy-btn" href="${_esc(marketUrl)}" target="_blank" rel="noopener">View in DecentMarket</a>
  `;
}

// ── Parent Track Playback ─────────────────────────────────────────────────
async function _playParent(parentTokenId) {
  if (!parentTokenId) return;
  const { setNowPlaying } = await import('./stage.js?v=20261010-listens');
  const meta = await fetchNFTMetaById(parentTokenId);
  if (!meta) return;
  const cfg = window.DecentConfig || {};
  const gateway = cfg.ipfsGateway || 'https://gateway.pinata.cloud/ipfs/';
  const audioUrl = (meta.videoUrl || meta.audioUrl || meta.animation_url || '').replace('ipfs://', gateway);
  setNowPlaying({
    title: meta.name || meta.title || `Track #${parentTokenId}`,
    artist: meta.artist || meta.creator || '',
    audioUrl,
    mediaType: meta.mediaType || (meta.videoUrl ? 'video/mp4' : ''),
  });
}

function _marketUrl(nft) {
  const cfg = window.DecentConfig || {};
  const url = new URL(cfg.marketUrl || 'https://thejollylama.github.io/DecentMarket/');
  if (cfg.chainId) url.searchParams.set('chainId', String(cfg.chainId));
  if (nft.contractAddress || cfg.contractAddress) url.searchParams.set('contract', nft.contractAddress || cfg.contractAddress);
  if (nft.tokenId != null) url.searchParams.set('tokenId', String(nft.tokenId));
  return url.toString();
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
