// js/stage.js?v=20261030-ad-cutoff — DecentBusking
// Hat (tip) + Guitar Case (mint) interactions and the now-playing banner.

import { openMintModal } from './mint.js?v=20261030-ad-cutoff';
import { initRadioSync, playArchiveTrack, getRadioStateSnapshot } from './radio-sync.js?v=20261030-ad-cutoff';
import { readLiveTipTarget } from './live-tip-target.mjs?v=20261114-live-direction';
import { announcePaymentCelebration } from './payment-celebration.mjs';
import { resolveNowPlayingNFT } from './space.js?v=20261030-ad-cutoff';
import { nftArtistLabel, nftIdentity } from './nft-loader.js?v=20261012-paging';
import { TIP_ABI, createTipContext, verifyAttributedTipReceipt } from './tip-protocol.mjs';
import { applyCreatorWatchlistButton, creatorWatchlistEntrySnapshot, getCreatorWatchlistState, isCreatorWatchlisted, toggleCreatorWatchlist } from './watchlist.mjs?v=20261030-ad-cutoff';

let _tipPlayingTrack = null;
let _tipHistory = [];
let _tipSelectionIndex = -1;
let _tipSnapshot = null;
let _tipLiveTrack = null;
let _tipPending = null;
let _tipSourceMode = 'radio';
let _tipLookupGeneration = 0;
let _tipBusy = false;
let _tipSelectionState = 'idle';
let _tipSelectionMessage = '';
let _watchlistTrack = null;
let _watchlistResolvedNFT = null;
let _watchlistLookupGeneration = 0;
let _watchlistBusy = false;
let _watchlistLookupError = '';
const _tipHistoryLimit = 12;

// ── Public API ────────────────────────────────────────────────────────────
export function initStage() {
  document.addEventListener('radio-source-mode-change', event => { _tipSourceMode = event.detail; });
  document.addEventListener('dbusk-now-playing', (event) => {
    _recordTipPlayingTrack(event.detail);
    _watchlistTrack = event.detail ? { ...event.detail } : null;
    _watchlistResolvedNFT = event.detail?.nft || null;
    void _resolveWatchlistTrack(event.detail || {});
    if (!_tipBusy && !_tipSnapshot && !_tipHistory.length) _renderTipState();
  });
  document.addEventListener('dbusk-now-playing-stopped', () => {
    _tipPlayingTrack = null;
    _watchlistTrack = null;
    _watchlistResolvedNFT = null;
    _renderWatchlistState();
  });
  document.addEventListener('creator-watchlist-changed', () => _renderWatchlistState());
  document.addEventListener('wallet-connected', () => _renderWatchlistState());
  document.addEventListener('wallet-disconnected', () => _renderWatchlistState());
  _bindHat();
  _bindGuitarCase();
  _bindWatchlistButton();
  _bindTipModal();
  initRadioSync();
}

// Play a selected archive NFT; the synced JukeLoop radio is muted until the
// listener returns to it.
export function setNowPlaying({ title = '—', artist = '', audioUrl = '', mediaType = '', nft = null } = {}) {
  if (!audioUrl) return;
  const cfg = window.DecentConfig || {};
  const gateway = cfg.ipfsGateway || 'https://gateway.pinata.cloud/ipfs/';
  // Browsers cannot play ipfs:// directly.
  const httpUrl = /^ipfs:\/\//i.test(audioUrl)
    ? audioUrl.replace(/^ipfs:\/\//i, gateway)
    : audioUrl;

  if (!/^https?:\/\//i.test(httpUrl)) {
    console.warn('[stage] setNowPlaying: rejected non-HTTP(S) audio URL:', httpUrl);
    return;
  }
  playArchiveTrack({ title, artist, audioUrl: httpUrl, mediaType, nft });
}

function _watchlistButton() {
  return document.getElementById('now-playing-watchlist-btn');
}

function _watchlistStatus() {
  return document.getElementById('now-playing-watchlist-status');
}

function _renderWatchlistState({ loading = false, resolving = false, saving = false } = {}) {
  const button = _watchlistButton();
  const status = _watchlistStatus();
  if (!button) return;
  button.classList.remove('hidden');
  button.textContent = '👀';
  if (!_watchlistTrack) {
    button.disabled = true;
    button.title = 'Play a verified NFT to save it to your watchlist';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', 'false');
    if (status) status.textContent = '';
    return;
  }
  const nft = _watchlistResolvedNFT || _watchlistTrack?.nft || null;
  const state = applyCreatorWatchlistButton(button, nft, { loading, resolving, saving, unavailable: !!_watchlistTrack && !nft && !loading && !resolving });
  button.textContent = '👀';
  if (status) {
    status.textContent = state.mode === 'saved'
      ? 'Saved to your watchlist.'
      : state.mode === 'pending'
        ? 'Verifying the exact NFT…'
        : state.mode === 'unavailable'
          ? _watchlistLookupError || ''
        : state.mode === 'loading'
          ? 'Loading your watchlist…'
          : '';
  }
}

async function _resolveWatchlistTrack(detail) {
  const lookup = ++_watchlistLookupGeneration;
  _watchlistLookupError = '';
  if (!detail) {
    _watchlistResolvedNFT = null;
    _renderWatchlistState();
    return;
  }
  if (detail.nft) {
    _watchlistResolvedNFT = detail.nft;
    _renderWatchlistState();
    return;
  }
  _renderWatchlistState({ resolving: true });
  try {
    const nft = await resolveNowPlayingNFT(detail, { requireMediaMatch: true });
    if (lookup !== _watchlistLookupGeneration) return;
    _watchlistResolvedNFT = nft;
    _renderWatchlistState({ resolving: false });
  } catch (error) {
    if (lookup !== _watchlistLookupGeneration) return;
    console.warn('[stage] NFT verification failed:', error.message);
    _watchlistLookupError = `NFT verification unavailable: ${error.message}`;
    _watchlistResolvedNFT = null;
    _renderWatchlistState({ resolving: false });
  }
}

// ── Hat (tip) ─────────────────────────────────────────────────────────────
function _bindHat() {
  const hatBtn = document.getElementById('hat-btn');
  if (!hatBtn) return;

  hatBtn.addEventListener('click', async () => {
    const modal = document.getElementById('tip-modal');
    if (!modal) return;
    const wasHidden = modal.classList.contains('hidden');
    modal.classList.remove('hidden');
    if (!wasHidden || _tipBusy || _tipPending || _tipSelectionState === 'sent') {
      _renderTipState();
      return;
    }
    if (_tipSelectionState === 'loading') {
      ++_tipLookupGeneration;
      _tipSelectionState = 'idle';
      _tipSelectionMessage = '';
    }
    const serviceUrl = window.DecentConfig?.ipfsUploadServiceUrl;
    if (serviceUrl && _tipSourceMode !== 'archive' && _tipPlayingTrack?.source !== 'archive') {
      const generation = ++_tipLookupGeneration;
      _tipLiveTrack = null;
      _tipSnapshot = null;
      _tipSelectionState = 'loading';
      _tipSelectionMessage = 'Verifying the current broadcast and tip recipient...';
      _renderTipWallet('');
      _renderTipState();
      try {
        const known = getRadioStateSnapshot()?.liveAudio;
        const expectedBookingId = known?.phase === 'live' && known.policy?.mode === 'live' ? known.bookingId : undefined;
        const target = await readLiveTipTarget({ serviceUrl, expectedBookingId });
        if (generation !== _tipLookupGeneration) return;
        if (target) {
          _tipLiveTrack = { source: 'live', bookingId: target.bookingId, artist: target.artist, title: target.title };
          _tipSnapshot = Object.freeze({ ...target, trackKey: _tipTrackKey(_tipLiveTrack),
            ..._tipRoute({ source: 'live', bookingId: target.bookingId }) });
          _tipSelectionState = 'ready';
          _tipSelectionMessage = '';
          _renderTipWallet(target.wallet);
          _renderTipState();
          return;
        }
        _tipSelectionState = 'idle';
        _tipSelectionMessage = '';
      } catch (error) {
        if (generation !== _tipLookupGeneration) return;
        _tipSelectionState = 'error';
        _tipSelectionMessage = `Could not verify the current tip recipient: ${error.message}`;
        _renderTipState();
        return;
      }
    }
    const latestIndex = _tipHistory.length - 1;
    if (latestIndex < 0) {
      _tipSelectionIndex = -1;
      _renderTipState();
      _showStatus('tip-status', 'No song is playing. Play a song before opening the tip hat.', true);
      return;
    }
    await _selectTipHistoryEntry(latestIndex, { openModal: true });
  });
}

function _renderTipWallet(wallet) {
  const label = document.getElementById('tip-to-label');
  label.replaceChildren();
  label.removeAttribute('title');
  label.removeAttribute('aria-label');
  if (!wallet) {
    label.textContent = 'Recipient wallet not yet verified.';
    return;
  }
  label.title = wallet;
  label.setAttribute('aria-label', `Tip recipient wallet: ${wallet}`);
  const address = document.createElement('span');
  address.className = 'tip-wallet-address';
  address.setAttribute('aria-hidden', 'true');
  address.append(wallet.slice(0, 6));
  for (let index = 0; index < 4; index += 1) {
    const icon = document.createElement('img');
    icon.src = 'img/Ens_Eth_Breathe.png';
    icon.alt = '';
    icon.width = 20;
    icon.height = 20;
    address.append(icon);
  }
  address.append(wallet.slice(-4));
  label.append(address);
}

function _closeTipModal() {
  ++_tipLookupGeneration;
  document.getElementById('tip-modal')?.classList.add('hidden');
  if (!_tipBusy && !_tipPending) {
    _tipSnapshot = null;
    _tipLiveTrack = null;
    _tipSelectionState = 'idle';
    _tipSelectionMessage = '';
  }
}

// ── Guitar Case (mint) ────────────────────────────────────────────────────
function _bindGuitarCase() {
  const btn = document.getElementById('guitar-case-btn');
  if (!btn) return;

  btn.addEventListener('click', () => {
    openMintModal();
  });
}

function _bindWatchlistButton() {
  const button = _watchlistButton();
  if (!button) return;
  button.addEventListener('click', async () => {
    if (!window._wallet?.address || !window._wallet?.signer) {
      await window._wallet?.connect?.();
      _renderWatchlistState({ loading: getCreatorWatchlistState().loading });
      return;
    }
    if (!_watchlistResolvedNFT && _watchlistTrack) await _resolveWatchlistTrack(_watchlistTrack);
    const nft = _watchlistResolvedNFT || _watchlistTrack?.nft;
    if (!nft) {
      _renderWatchlistState();
      if (_watchlistStatus()) _watchlistStatus().textContent = _watchlistLookupError || 'Could not match this playback to a verified NFT.';
      return;
    }
    _watchlistBusy = true;
    _renderWatchlistState({ saving: true });
    try {
      const save = !isCreatorWatchlisted(nft);
      await toggleCreatorWatchlist(creatorWatchlistEntrySnapshot(nft));
      _renderWatchlistState();
      if (_watchlistStatus()) _watchlistStatus().textContent = save ? 'Saved to your watchlist.' : 'Removed from your watchlist.';
    } catch (error) {
      _renderWatchlistState();
      if (_watchlistStatus()) _watchlistStatus().textContent = error.message;
    } finally {
      _watchlistBusy = false;
      _renderWatchlistState();
    }
  });
  _renderWatchlistState({ loading: getCreatorWatchlistState().loading });
}

// ── Tip modal wiring ──────────────────────────────────────────────────────
function _bindTipModal() {
  const sendBtn = document.getElementById('tip-send-btn');
  const cancelBtn = document.getElementById('tip-cancel-btn');
  const prevBtn = document.getElementById('tip-prev-btn');
  const nextBtn = document.getElementById('tip-next-btn');
  const modal = document.getElementById('tip-modal');

  if (cancelBtn) {
    cancelBtn.addEventListener('click', _closeTipModal);
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', _handleSendTip);
  }

  prevBtn?.addEventListener('click', () => _stepTipHistory(-1));
  nextBtn?.addEventListener('click', () => _stepTipHistory(1));

  // Close on backdrop click
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) _closeTipModal();
    });
  }
}

function _stepTipHistory(direction) {
  if (_tipBusy || _tipPending || _tipLiveTrack) return;
  const nextIndex = _tipSelectionIndex + direction;
  if (nextIndex < 0 || nextIndex >= _tipHistory.length) return;
  return _selectTipHistoryEntry(nextIndex);
}

async function _handleSendTip() {
  const amountInput = document.getElementById('tip-amount');
  const sendBtn = document.getElementById('tip-send-btn');
  const cfg = window.DecentConfig || {};
  if (_tipBusy || _tipSelectionState === 'sent') return;

  _showStatus('tip-status', '');

  const tip = _tipSnapshot;
  if (!tip) {
    _showStatus('tip-status', 'No verified recipient. Open the hat while a song is playing.', true);
    return;
  }

  let amountWei;
  try {
    amountWei = _tipPending?.amountWei ?? ethers.parseEther(String(amountInput?.value || '').trim());
    if (amountWei <= 0n) throw new Error('Tip amount must be positive');
  } catch {
    _showStatus('tip-status', '⚠️ Enter a valid tip amount.', true);
    return;
  }

  if (!window.ethereum) {
    _showStatus('tip-status', '🦊 MetaMask not detected.', true);
    return;
  }

  try {
    _tipBusy = true;
    _renderTipState();
    sendBtn.disabled = true;
    _showStatus('tip-status', '⏳ Waiting for MetaMask…');

    const signer = window._wallet?.signer;
    if (!signer && !_tipPending) {
      _tipSelectionState = 'ready';
      _tipSelectionMessage = '🦊 Please connect your wallet via the header first.';
      _showStatus('tip-status', '🦊 Please connect your wallet via the header first.', true);
      return;
    }

    const provider = _tipPending?.provider || signer.provider;
    const chainId = Number((await provider.getNetwork()).chainId);
    const expectedChain = tip.chainId || cfg.chainId || 8453;
    if (chainId !== expectedChain) {
      _tipSelectionState = _tipPending ? 'pending' : 'ready';
      _tipSelectionMessage = `⚠️ Switch MetaMask to ${tip.chainName || cfg.chainName || 'Base Mainnet'} (chain ID ${expectedChain}).`;
      _showStatus('tip-status', _tipSelectionMessage, true);
      return;
    }

    let receipt;
    if (_tipPending) {
      receipt = await provider.getTransactionReceipt(_tipPending.txHash);
    } else {
      const intent = { ...tip, recipient: tip.wallet, amountWei: amountWei.toString() };
      let tx;
      if (tip.routerAddress) {
        intent.payer = await signer.getAddress();
        if (await provider.getCode(tip.routerAddress) === '0x') throw new Error('The configured tip contract is not deployed on this chain');
        const context = createTipContext(intent);
        const contract = new ethers.Contract(tip.routerAddress, TIP_ABI, signer);
        tx = await contract.tip(tip.wallet, context.sourceKind, context.contextRef, { value: amountWei, chainId: expectedChain });
      } else {
        tx = await signer.sendTransaction({ to: tip.wallet, value: amountWei, chainId: expectedChain });
      }
      _tipPending = { provider, txHash: tx.hash, intent, amountWei };
      _tipSelectionState = 'pending';
      _showStatus('tip-status', 'Tip submitted. Waiting for on-chain confirmation...');
      try {
        receipt = await tx.wait();
      } catch (error) {
        if (error.code !== 'TRANSACTION_REPLACED' || error.receipt?.status !== 1) throw error;
        if (error.cancelled) {
          _tipPending = null;
          throw new Error('The wallet cancelled or replaced this tip. Check the replacement transaction before trying again.');
        }
        receipt = error.receipt;
        _tipPending.txHash = receipt.hash;
      }
    }
    if (receipt?.status === 0) {
      _tipPending = null;
      throw new Error('Tip was not confirmed successfully');
    }
    if (receipt?.status !== 1) throw new Error('Tip confirmation is still pending');
    if (tip.routerAddress) {
      if (receipt.hash?.toLowerCase() !== _tipPending.txHash.toLowerCase()) throw new Error('Receipt does not match the submitted tip transaction');
      verifyAttributedTipReceipt({ receipt, routerAddress: tip.routerAddress, intent: _tipPending.intent, ethers });
    }
    const txHash = receipt.hash || _tipPending.txHash;
    _tipPending = null;
    _tipSelectionState = 'sent';
    _tipSelectionMessage = `✅ Tip confirmed for ${tip.artist} — ${tip.title}. ${tip.routerAddress ? 'DecentBusking source recorded on-chain. ' : ''}TX: ${_shortAddr(txHash)}`;
    _showStatus('tip-status', _tipSelectionMessage);
    announcePaymentCelebration({
      chainId,
      txHash,
      amountText: ethers.formatEther(amountWei),
      assetText: 'ETH',
      summary: `Tip to ${tip.artist} for ${tip.title} (${_shortAddr(tip.wallet)})`,
      txLabel: 'Tip confirmed',
    });
  } catch (err) {
    if (err.receipt?.status === 0) _tipPending = null;
    _tipSelectionState = _tipPending ? 'pending' : 'ready';
    _tipSelectionMessage = _tipPending
      ? `Tip submitted (${_tipPending.txHash}), not yet verified: ${err.message}. Recheck this payment; do not send it again.`
      : `❌ ${err.message || 'Transaction failed'}`;
    _showStatus('tip-status', _tipSelectionMessage, true);
  } finally {
    _tipBusy = false;
    _renderTipState();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function _tipRoute({ source, bookingId, nft }) {
  const cfg = window.DecentConfig || {};
  const routerAddress = cfg.tipRouterAddress ?? '';
  const chainId = cfg.chainId || 8453;
  if (typeof routerAddress !== 'string' || (routerAddress &&
      (!/^0x[0-9a-fA-F]{40}$/.test(routerAddress) || /^0x0{40}$/i.test(routerAddress)))) {
    throw new Error('Tip attribution is configured with an invalid contract; direct fallback is disabled');
  }
  if (routerAddress && chainId !== 8453) throw new Error('DecentBusking tip attribution is Base-only');
  const nftId = routerAddress && source !== 'live' ? nftIdentity(nft) : undefined;
  if (nftId && nft.chainId !== undefined && nft.chainId !== chainId) throw new Error('The recording identity belongs to another chain');
  const route = { source, bookingId, nftId, routerAddress, chainId, chainName: cfg.chainName || 'Base Mainnet' };
  if (routerAddress) createTipContext(route);
  return route;
}

function _tipTrackKey(track = {}) {
  return [
    track.bookingId || '',
    track.playId || '',
    track.trackId || '',
    track.audioUrl || '',
    track.ipfsCid || '',
    track.title || '',
    track.artist || '',
  ].join('|');
}

function _recordTipPlayingTrack(detail) {
  if (!detail) {
    _tipPlayingTrack = null;
    return;
  }
  const track = { ...detail };
  _tipPlayingTrack = track;
  const key = _tipTrackKey(track);
  if (!key) return;
  const latest = _tipHistory[_tipHistory.length - 1];
  if (latest && latest.key === key) {
    latest.track = track;
    if (_tipSelectionIndex === _tipHistory.length - 1) _renderTipState();
    return;
  }
  _tipHistory.push({ key, track });
  if (_tipHistory.length > _tipHistoryLimit) {
    const overflow = _tipHistory.length - _tipHistoryLimit;
    _tipHistory.splice(0, overflow);
    _tipSelectionIndex = Math.max(-1, _tipSelectionIndex - overflow);
  }
  if (_tipSelectionIndex === -1) _tipSelectionIndex = _tipHistory.length - 1;
  const modal = document.getElementById('tip-modal');
  if (modal && !modal.classList.contains('hidden')) {
    if (_tipSelectionState === 'idle' && _tipSelectionIndex === _tipHistory.length - 1) {
      void _selectTipHistoryEntry(_tipSelectionIndex);
      return;
    }
    _renderTipState();
  }
}

function _selectedTipEntry() {
  if (_tipLiveTrack) return { key: _tipTrackKey(_tipLiveTrack), track: _tipLiveTrack };
  return _tipHistory[_tipSelectionIndex] || null;
}

function _tipHistoryLabel() {
  if (_tipLiveTrack) return 'Live performer · recipient locked for this tip';
  if (_tipSelectionIndex < 0 || !_tipHistory.length) return '';
  const position = `${_tipSelectionIndex + 1} of ${_tipHistory.length}`;
  if (_tipSelectionIndex === _tipHistory.length - 1) return `Played song ${position} · Current song`;
  const newer = _tipHistory.length - 1 - _tipSelectionIndex;
  return `Played song ${position} · Previously played · ${newer} newer track${newer === 1 ? '' : 's'} available`;
}

function _syncTipNavState() {
  const prevBtn = document.getElementById('tip-prev-btn');
  const nextBtn = document.getElementById('tip-next-btn');
  const hasSelection = _tipSelectionIndex >= 0 && _tipSelectionIndex < _tipHistory.length;
  const atStart = !hasSelection || _tipSelectionIndex <= 0;
  const atEnd = !hasSelection || _tipSelectionIndex >= _tipHistory.length - 1;
  if (prevBtn) prevBtn.disabled = _tipBusy || !!_tipPending || !!_tipLiveTrack || atStart;
  if (nextBtn) nextBtn.disabled = _tipBusy || !!_tipPending || !!_tipLiveTrack || atEnd;
}

function _renderTipState() {
  const sendBtn = document.getElementById('tip-send-btn');
  const entry = _selectedTipEntry();
  const track = (_tipBusy || _tipPending || _tipSelectionState === 'sent') && _tipSnapshot
    ? _tipSnapshot : entry?.track || _tipPlayingTrack;
  const hasSelection = Boolean(track);
  const artistEl = document.getElementById('tip-artist');
  const songEl = document.getElementById('tip-song');
  const positionEl = document.getElementById('tip-track-position');
  if (artistEl) artistEl.textContent = track?.artist || 'Unknown artist';
  if (songEl) songEl.textContent = track?.title || 'No song playing';
  if (positionEl) positionEl.textContent = _tipHistoryLabel();
  const routeEl = document.getElementById('tip-route');
  if (routeEl) routeEl.textContent = _tipSnapshot?.routerAddress
    ? `100% to the artist via the DecentBusking tip contract. On-chain source: ${_tipSnapshot.source === 'live' ? 'live performance' : _tipSnapshot.source === 'archive' ? 'archive recording' : 'radio recording'}.`
    : 'Legacy direct ETH tip. No DecentBusking source is recorded on-chain until the tip contract is enabled.';
  if (sendBtn) sendBtn.textContent = _tipPending ? 'Recheck tip' : '💸 Send Tip';
  _syncTipNavState();
  if (_tipSelectionState === 'loading') {
    _showStatus('tip-status', _tipSelectionMessage || 'Looking up this song\'s tip wallet...');
    if (sendBtn) sendBtn.disabled = true;
    return;
  }
  if (_tipSelectionState === 'error') {
    if (sendBtn) sendBtn.disabled = true;
    _showStatus('tip-status', _tipSelectionMessage, true);
    return;
  }
  if (!hasSelection) {
    _tipSnapshot = null;
    _tipSelectionState = 'idle';
    _tipSelectionMessage = '';
    _renderTipWallet('');
    if (sendBtn) sendBtn.disabled = true;
    _showStatus('tip-status', 'No song is playing. Play a song before opening the tip hat.', true);
    return;
  }
  if (_tipBusy) {
    if (sendBtn) sendBtn.disabled = true;
    return;
  }
  if (_tipPending) {
    if (sendBtn) sendBtn.disabled = false;
    _showStatus('tip-status', _tipSelectionMessage, true);
    return;
  }
  if (_tipSelectionState === 'sent') {
    if (sendBtn) sendBtn.disabled = true;
    _showStatus('tip-status', _tipSelectionMessage || '', false);
    return;
  }
  if (!_tipSnapshot || _tipSnapshot.trackKey !== _tipTrackKey(track)) {
    _tipSnapshot = null;
    _tipSelectionState = 'loading';
    _tipSelectionMessage = _tipSelectionIndex === _tipHistory.length - 1
      ? 'Looking up this song\'s tip wallet...'
      : 'Looking up this previously played song\'s tip wallet...';
    _renderTipWallet('');
  }
  if (sendBtn) sendBtn.disabled = !_tipSnapshot || !window.ethereum;
  if (_tipSnapshot) {
    _tipSelectionState = 'ready';
    if (!_tipSelectionMessage || _tipSelectionMessage === 'Loading…') {
      _tipSelectionMessage = window.ethereum ? '' : '🦊 MetaMask not detected. Install it to send tips.';
    }
    _showStatus('tip-status', _tipSelectionMessage, Boolean(_tipSelectionMessage));
  }
}

async function _selectTipHistoryEntry(index, { openModal = false } = {}) {
  const modal = document.getElementById('tip-modal');
  if (index < 0 || index >= _tipHistory.length || _tipBusy || _tipPending) return;
  _tipSelectionIndex = index;
  if (openModal && modal) modal.classList.remove('hidden');
  const entry = _selectedTipEntry();
  if (!entry) return;
  const track = entry.track || {};
  const generation = ++_tipLookupGeneration;
  _tipSelectionState = 'loading';
  _tipSelectionMessage = index === _tipHistory.length - 1
    ? 'Looking up this song\'s tip wallet...'
    : 'Looking up this previously played song\'s tip wallet...';
  _tipSnapshot = null;
  _renderTipState();
  try {
    const nft = track.nft || await resolveNowPlayingNFT(track, { requireMediaMatch: true });
    if (generation !== _tipLookupGeneration || _tipSelectionIndex !== index) return;
    const wallet = nft?.tipWallet || '';
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet) || /^0x0{40}$/i.test(wallet)) {
      _tipSnapshot = null;
      _tipSelectionState = 'error';
      _tipSelectionMessage = 'No verified tip wallet is available for this song. Tips are disabled.';
      _renderTipWallet('');
      _showStatus('tip-status', _tipSelectionMessage, true);
      _syncTipNavState();
      return;
    }
    track.nft = nft;
    _tipHistory[index] = { ...entry, track };
    _tipSnapshot = Object.freeze({
      wallet,
      artist: nftArtistLabel(nft),
      title: track.title || nft.name || nft.title || 'Unknown song',
      trackKey: _tipTrackKey(track),
      ..._tipRoute({ source: track.source === 'archive' ? 'archive' : 'radio', nft }),
    });
    document.getElementById('tip-artist').textContent = _tipSnapshot.artist;
    document.getElementById('tip-song').textContent = _tipSnapshot.title;
    _renderTipWallet(wallet);
    _tipSelectionState = 'ready';
    _tipSelectionMessage = window.ethereum ? '' : '🦊 MetaMask not detected. Install it to send tips.';
    _showStatus('tip-status', window.ethereum ? '' : '🦊 MetaMask not detected. Install it to send tips.', !window.ethereum);
    _renderTipState();
  } catch (error) {
    if (generation !== _tipLookupGeneration || _tipSelectionIndex !== index) return;
    _tipSnapshot = null;
    _tipSelectionState = 'error';
    _tipSelectionMessage = `Could not verify this song's tip wallet: ${error.message}`;
    _renderTipWallet('');
    _showStatus('tip-status', _tipSelectionMessage, true);
    _syncTipNavState();
  }
}

function _showStatus(elId, msg, isError = false) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function _shortAddr(addr = '') {
  return addr.length > 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
