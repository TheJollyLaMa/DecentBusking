// js/nft-card.js — DecentBusking
// NFT detail panel — mirrors the listing style used in DecentMarket.
// Rendered when a user clicks on a floating NFT mesh in the space field.

import { fetchNFTMetaById } from './space.js?v=20261016-top10-eq';
import { buildNftShareUrl } from './nft-loader.js?v=20261012-paging';
import { returnToRadio } from './radio-sync.js?v=20261016-top10-hype';
import { applyCreatorWatchlistButton, creatorWatchlistEntrySnapshot, isCreatorWatchlisted, toggleCreatorWatchlist } from './watchlist.mjs';
import { canEditArtwork } from './artwork-update.mjs';
import { PENCIL_ICON } from './artwork-edit-badge.mjs';

// NFT currently shown in the single view; previews and purchases are handled explicitly.
let _cardNft = null;

function _cardAudioUrl(nft) {
  return nft ? (nft.videoUrl || nft.audioUrl || nft.animation_url || '') : '';
}

function _renderMute(content, muted) {
  const button = content?.querySelector('.nft-mute-btn');
  if (!button) return;
  const label = muted ? 'Unmute' : 'Mute';
  button.setAttribute('aria-pressed', String(muted));
  button.setAttribute('aria-label', label);
  button.title = label;
  button.textContent = muted ? '🔇' : '🔊';
}

function _renderPreviewButton(content, playing) {
  const button = content?.querySelector('.nft-preview-btn');
  if (!button) return;
  button.textContent = playing ? '⏹ Stop preview' : '▶ Preview';
  button.setAttribute('aria-pressed', String(playing));
  button.title = playing
    ? 'Stop the 30-second preview and return to the radio'
    : 'Play a free 30-second preview';
}

function _cardStatus(text) {
  const el = document.getElementById('nft-panel-content')?.querySelector('.nft-listen-status');
  if (el) el.textContent = text;
}

function _shareStatus(content, text, url = '') {
  const el = content?.querySelector('.nft-share-status');
  if (!el) return;
  if (url) {
    el.innerHTML = `${_esc(text)} <input class="nft-share-link" type="text" readonly value="${_esc(url)}" aria-label="Share link" />`;
    const input = el.querySelector('.nft-share-link');
    input?.focus?.();
    input?.select?.();
    return;
  }
  el.textContent = text;
}

document.addEventListener?.('dbusk-archive-mute', (event) => {
  if (_cardNft) _renderMute(document.getElementById('nft-panel-content'), event.detail.muted);
});
document.addEventListener?.('dbusk-listen-started', (event) => {
  if (!_cardNft || event.detail.song.audioUrl !== _cardAudioUrl(_cardNft)) return;
  _renderPreviewButton(document.getElementById('nft-panel-content'), event.detail.mode === 'preview');
  _cardStatus(event.detail.mode === 'preview'
    ? '🎧 Playing a 30-second preview. Press ⏹ Stop preview to return to the radio.'
    : '🎧 Playing the full track.');
});
document.addEventListener?.('dbusk-preview-ended', (event) => {
  if (!_cardNft || event.detail.song.audioUrl !== _cardAudioUrl(_cardNft)) return;
  event.preventDefault();
  _renderPreviewButton(document.getElementById('nft-panel-content'), false);
  _cardStatus('Preview ended. Returning to the radio.');
  returnToRadio();
});

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
    document.removeEventListener('creator-watchlist-changed', watchlistListener);
    panel.classList.add('hidden');
    content.querySelectorAll('audio').forEach((audio) => audio.pause());
    _renderPreviewButton(content, false);
    _cardNft = null;
    document.dispatchEvent?.(new CustomEvent('dbusk-preview-close', { detail: { nft } }));
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
  _cardNft = nft;
  const watchlistBtn = content.querySelector('.nft-watchlist-btn');
  const watchlistStatus = content.querySelector('.nft-watchlist-status');
  const renderWatchlist = (options = {}) => {
    if (!watchlistBtn) return;
    const state = applyCreatorWatchlistButton(watchlistBtn, nft, options);
    if (watchlistStatus) {
      watchlistStatus.textContent = state.mode === 'saved'
        ? 'Saved to your watchlist.'
        : state.mode === 'pending'
          ? 'Verifying the exact NFT…'
          : state.mode === 'loading'
            ? 'Loading your watchlist…'
            : state.mode === 'connect'
              ? 'Connect your wallet to save this NFT.'
              : '';
    }
  };
  renderWatchlist({ loading: false });
  const listenStatus = text => {
    const el = content.querySelector('.nft-listen-status');
    if (el) el.textContent = text;
  };
  const previewBtn = content.querySelector('.nft-preview-btn');
  previewBtn?.addEventListener('click', () => {
    if (previewBtn.getAttribute('aria-pressed') === 'true') {
      _renderPreviewButton(content, false);
      _cardStatus('Preview stopped. Returning to the radio.');
      document.dispatchEvent?.(new CustomEvent('dbusk-preview-close', { detail: { nft } }));
      return;
    }
    _cardStatus('▶ Starting preview…');
    document.dispatchEvent?.(new CustomEvent('dbusk-listen', { cancelable: true, detail: { nft } }));
  });
  content.querySelector('.nft-listen-btn')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const isVideo = nft.videoUrl || nft.mediaType === 'video/mp4';
    const purchase = new CustomEvent('dbusk-buy-listen', { cancelable: true, detail: { nft, status: listenStatus } });
    if (!document.dispatchEvent(purchase)) {
      button.disabled = true;
      const result = await purchase.detail.result;
      button.disabled = false;
      if (result !== 'failed' && isVideo) panel.close();
      return;
    }
    const { setNowPlaying } = await import('./stage.js?v=20261016-radio-preload');
    setNowPlaying({ nft, title: nft.name || nft.title, artist: nft.artist || nft.creator,
      audioUrl: nft.videoUrl || nft.audioUrl || nft.animation_url, mediaType: nft.mediaType || (nft.videoUrl ? 'video/mp4' : '') });
    if (isVideo) panel.close();
  });

  content.querySelector('.nft-mute-btn')?.addEventListener('click', async (event) => {
    const muted = event.currentTarget.getAttribute('aria-pressed') !== 'true';
    const { setArchiveMuted } = await import('./radio-sync.js?v=20261016-top10-hype');
    setArchiveMuted(muted);
  });
  import('./radio-sync.js?v=20261016-top10-hype')
    .then(({ archiveMuted }) => { if (_cardNft === nft) _renderMute(content, archiveMuted()); })
    .catch(() => {});

  content.querySelector('.nft-playlist-btn')?.addEventListener('click', event => {
    const button = event.currentTarget;
    const status = text => { button.textContent = text; };
    if (document.dispatchEvent(new CustomEvent('dbusk-playlist-add', { cancelable: true, detail: { nft, status } }))) {
      status('Playlists open soon');
    }
  });
  content.querySelector('.nft-artwork-edit-btn')?.addEventListener('click', () => {
    document.dispatchEvent?.(new CustomEvent('open-artwork-editor', { detail: { nft } }));
  });
  watchlistBtn?.addEventListener('click', async () => {
    if (!window._wallet?.address || !window._wallet?.signer) {
      await window._wallet?.connect?.();
      renderWatchlist();
      return;
    }
    renderWatchlist({ saving: true });
    try {
      await toggleCreatorWatchlist(creatorWatchlistEntrySnapshot(nft));
      renderWatchlist();
      if (watchlistStatus) watchlistStatus.textContent = isCreatorWatchlisted(nft)
        ? 'Saved to your watchlist.'
        : 'Removed from your watchlist.';
    } catch (error) {
      if (watchlistStatus) watchlistStatus.textContent = error.message;
      renderWatchlist();
    }
  });
  const watchlistListener = () => { if (_cardNft === nft) renderWatchlist(); };
  document.addEventListener('creator-watchlist-changed', watchlistListener);

  content.querySelector('.nft-share-btn')?.addEventListener('click', async () => {
    const title = nft.name || nft.title || `Track #${nft.tokenId}`;
    const artist = nft.artistName || nft.artist || nft.creator || '';
    const shareText = artist ? `${title} by ${artist}` : title;
    const shareUrl = buildNftShareUrl(nft, window.location.href);
    try {
      if (navigator.share && (!navigator.canShare || navigator.canShare({ title, text: shareText, url: shareUrl }))) {
        await navigator.share({ title, text: shareText, url: shareUrl });
        _shareStatus(content, 'Shared.');
        return;
      }
    } catch (error) {
      if (error?.name === 'AbortError') {
        _shareStatus(content, 'Share cancelled.');
        return;
      }
      console.warn('[nft-card] Native share failed:', error?.message || error);
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
        _shareStatus(content, 'Link copied.');
        return;
      }
    } catch (error) {
      console.warn('[nft-card] Clipboard copy failed:', error?.message || error);
      _shareStatus(content, 'Copy failed. Select this link:', shareUrl);
      return;
    }
    _shareStatus(content, 'Copy unavailable. Select this link:', shareUrl);
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
  const listenPrice = '0.25 USDC';

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
    <div class="nft-detail-artwork">
      ${/^https?:\/\//i.test(imageUrl) ? `<img class="nft-detail-image" src="${_esc(imageUrl)}" alt="Artwork for ${_esc(nft.name || nft.title || 'this NFT')}" />` : ''}
      ${canEditArtwork(nft, window._wallet?.address) ? `<button class="nft-artwork-edit-btn artwork-edit-badge" type="button" aria-label="Edit artwork" title="Edit artwork">${PENCIL_ICON}</button>` : ''}
    </div>
    <h3 id="nft-detail-title">${_esc(nft.name || nft.title || `Track #${nft.tokenId}`)}</h3>

    ${audioUrl ? `<div class="nft-play-row">
      <button class="nft-preview-btn nft-buy-btn" type="button" aria-pressed="false" title="Play a free 30-second preview">▶ Preview</button>
      <button class="nft-listen-btn nft-buy-btn" type="button" title="Pay with your wallet for the whole track without interruption">🎧 Listen (${listenPrice})</button>
      <button class="nft-mute-btn nft-buy-btn" type="button" aria-pressed="false" aria-label="Mute preview" title="Mute preview">🔊</button>
    </div>
    <p class="nft-listen-status" role="status" aria-live="polite"></p>` : ''}
    <div class="nft-card-actions">
      <button class="nft-playlist-btn nft-buy-btn" type="button">+ Playlist</button>
      <button class="nft-watchlist-btn nft-buy-btn" type="button" aria-pressed="false" title="Save to watchlist">👀 Save</button>
    </div>
    <p class="nft-watchlist-status" role="status" aria-live="polite"></p>
    ${/^0x[0-9a-fA-F]{40}$/.test(nft.artist || nft.creator || '') ? `<button class="nft-creator-profile nft-buy-btn" type="button" data-creator="${_esc(nft.artist || nft.creator)}" data-album="${_esc(nft.djukeAlbumId || '')}">Profile / Collaborators</button>` : ''}

    <button class="nft-share-btn nft-buy-btn" type="button" title="Share a link to this NFT">Share</button>
    <p class="nft-share-status" role="status" aria-live="polite"></p>

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
  const { setNowPlaying } = await import('./stage.js?v=20261016-radio-preload');
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
