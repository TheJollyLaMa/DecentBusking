// js/stage.js?v=20261030-ad-cutoff — DecentBusking
// Hat (tip) + Guitar Case (mint) interactions and the now-playing banner.

import { openMintModal } from './mint.js?v=20261030-ad-cutoff';
import { initRadioSync, playArchiveTrack, getRadioStateSnapshot } from './radio-sync.js?v=20261030-ad-cutoff';
import { readLiveTipTarget } from './live-tip-target.mjs?v=20261114-live-direction';
import { announcePaymentCelebration } from './payment-celebration.mjs';
import { resolveNowPlayingNFT } from './space.js?v=20261030-ad-cutoff';
import { nftArtistLabel, nftIdentity } from './nft-loader.js?v=20261012-paging';
import { NFT_STANDARDS, TIP_ABI, TIP_ASSET_ABI, TIP_SPLIT_ABI, createTipContext, normalizeNftGifts, normalizeTipSplit, splitTipAmounts, verifyAttributedTipReceipt, verifyNftGiftReceipt, verifySplitTipReceipt, verifyTokenTipReceipt } from './tip-protocol.mjs?v=20261123-song-splits';
import { getBaseReadProvider, waitForAllowance } from './base-chain.mjs?v=20261018-shared-provider';
import { BASE_USDC_ADDRESS } from './djuke-payment.mjs';
import { USDC_BROWSER_ABI } from './usdc-abi.mjs';
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
let _tipAsset = 'eth';
let _tipGifts = [];
let _watchlistTrack = null;
let _watchlistResolvedNFT = null;
let _watchlistLookupGeneration = 0;
let _watchlistBusy = false;
let _watchlistLookupError = '';
const _tipHistoryLimit = 12;
const TIP_ETH_QUOTE_URL = 'https://api.coinbase.com/v2/prices/ETH-USD/spot';
const TIP_QUOTE_CACHE_KEY = 'decentbusking:tip-eth-usdc:v1';
const TIP_QUOTE_CACHE_MS = 5 * 60 * 1000;
let _tipEthUsdcRate = null;
let _tipQuoteTask = null;

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
    void _refreshTipUsdcEstimate();
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

function _tipWalletAddress(wallet) {
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
  return address;
}

function _renderTipWallet(wallet, splits = null) {
  const label = document.getElementById('tip-to-label');
  label.replaceChildren();
  label.removeAttribute('title');
  label.removeAttribute('aria-label');
  if (splits) {
    label.title = splits.map(part => `${part.recipient} ${part.shareBps / 100}%`).join('\n');
    label.setAttribute('aria-label', `Tip split: ${label.title.replace(/\n/g, ', ')}`);
    for (const part of splits) {
      const share = document.createElement('span');
      share.className = 'tip-wallet-share';
      share.textContent = ` ${part.shareBps / 100}% `;
      label.append(_tipWalletAddress(part.recipient), share);
    }
    return;
  }
  if (!wallet) {
    label.textContent = 'Recipient wallet not yet verified.';
    return;
  }
  label.title = wallet;
  label.setAttribute('aria-label', `Tip recipient wallet: ${wallet}`);
  const address = _tipWalletAddress(wallet);
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'tip-wallet-copy';
  copy.textContent = 'Copy';
  copy.setAttribute('aria-label', `Copy recipient wallet ${wallet}`);
  copy.addEventListener('click', async () => {
    const copied = await globalThis.navigator?.clipboard?.writeText(wallet).then(() => true, () => false);
    copy.textContent = copied ? 'Copied' : 'Copy failed';
    clearTimeout(copy._resetTimer);
    copy._resetTimer = setTimeout(() => { copy.textContent = 'Copy'; }, 1800);
  });
  label.append(address, copy);
}

function _renderTipUsdcEstimate() {
  const estimate = document.getElementById('tip-usdc-estimate');
  if (!estimate) return;
  const amount = Number(document.getElementById('tip-amount')?.value);
  if (!Number.isFinite(amount) || amount <= 0) {
    estimate.textContent = '';
    return;
  }
  if (!Number.isFinite(_tipEthUsdcRate) || _tipEthUsdcRate <= 0) {
    estimate.textContent = 'USDC estimate unavailable';
    return;
  }
  const usdc = amount * _tipEthUsdcRate;
  const precision = usdc >= 100 ? 2 : usdc >= 1 ? 3 : 4;
  estimate.textContent = `(≈ ${usdc.toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: precision,
  })} USDC · ETH spot estimate)`;
}

async function _refreshTipUsdcEstimate() {
  _renderTipUsdcEstimate();
  const cached = (() => {
    try {
      const value = JSON.parse(globalThis.sessionStorage?.getItem(TIP_QUOTE_CACHE_KEY) || 'null');
      return Number.isFinite(value?.rate) && value.rate > 0 && Date.now() - value.savedAt < TIP_QUOTE_CACHE_MS
        ? value.rate : null;
    } catch { return null; }
  })();
  if (cached) {
    _tipEthUsdcRate = cached;
    _renderTipUsdcEstimate();
    return;
  }
  if (typeof fetch !== 'function') {
    const estimate = document.getElementById('tip-usdc-estimate');
    if (estimate) estimate.textContent = 'USDC estimate unavailable';
    return;
  }
  _tipQuoteTask ||= fetch(TIP_ETH_QUOTE_URL, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
    .then(async response => {
      const body = await response.json();
      if (!response.ok || !Number.isFinite(Number(body?.data?.amount)) || Number(body.data.amount) <= 0) {
        throw new Error('ETH quote unavailable');
      }
      _tipEthUsdcRate = Number(body.data.amount);
      try {
        globalThis.sessionStorage?.setItem(TIP_QUOTE_CACHE_KEY,
          JSON.stringify({ rate: _tipEthUsdcRate, savedAt: Date.now() }));
      } catch {}
      _renderTipUsdcEstimate();
    })
    .catch(() => {
      const estimate = document.getElementById('tip-usdc-estimate');
      if (estimate) estimate.textContent = 'USDC estimate unavailable';
    })
    .finally(() => { _tipQuoteTask = null; });
  await _tipQuoteTask;
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
  const amountInput = document.getElementById('tip-amount');

  if (cancelBtn) {
    cancelBtn.addEventListener('click', _closeTipModal);
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', _handleSendTip);
  }

  prevBtn?.addEventListener('click', () => _stepTipHistory(-1));
  nextBtn?.addEventListener('click', () => _stepTipHistory(1));
  amountInput?.addEventListener('input', _renderTipUsdcEstimate);
  document.getElementById('tip-asset-picker')?.addEventListener('click', event => {
    const asset = event.target.closest('[data-tip-asset]')?.dataset.tipAsset;
    if (!asset || _tipBusy || _tipPending || _tipSelectionState === 'sent') return;
    _tipAsset = asset;
    if (asset === 'nft' && !_tipGifts.length) _tipGifts.push(_newTipGift());
    _renderTipState();
  });
  document.getElementById('tip-gift-add')?.addEventListener('click', () => {
    if (_tipBusy || _tipPending || _tipGifts.length >= 32) return;
    _tipGifts.push(_newTipGift());
    _renderTipGifts();
  });

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

  const asset = _tipPending?.intent?.asset ?? _tipAssetFor(tip);
  // ETH in wei or USDC in 6-decimal units; NFT gifts carry no amount.
  let amountWei = 0n;
  if (asset !== 'nft') {
    try {
      const value = String(amountInput?.value || '').trim();
      amountWei = _tipPending?.amountWei ?? (asset === 'usdc' ? ethers.parseUnits(value, 6) : ethers.parseEther(value));
      if (amountWei <= 0n) throw new Error('Tip amount must be positive');
    } catch {
      _showStatus('tip-status', '⚠️ Enter a valid tip amount.', true);
      return;
    }
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
      let intent = { ...tip, asset, recipient: tip.wallet, amountWei: amountWei.toString() };
      let tx;
      if (asset !== 'eth') {
        ({ tx, intent } = await _submitAssetTip({ tip, asset, amount: amountWei, signer, provider, expectedChain }));
      } else if (tip.splits) {
        splitTipAmounts(amountWei, tip.splits);
        intent.payer = await signer.getAddress();
        if (await provider.getCode(tip.routerAddress) === '0x') throw new Error('The configured split tip contract is not deployed on this chain');
        const context = createTipContext(intent);
        const contract = new ethers.Contract(tip.routerAddress, TIP_SPLIT_ABI, signer);
        tx = await contract.tipSplit(tip.splits.map(part => part.recipient), tip.splits.map(part => part.shareBps),
          context.sourceKind, context.contextRef, { value: amountWei, chainId: expectedChain });
      } else if (tip.routerAddress) {
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
    if (tip.routerAddress || asset !== 'eth') {
      if (receipt.hash?.toLowerCase() !== _tipPending.txHash.toLowerCase()) throw new Error('Receipt does not match the submitted tip transaction');
      const verify = { receipt, routerAddress: asset === 'eth' ? tip.routerAddress : tip.assetRouterAddress, intent: _tipPending.intent, ethers };
      if (asset === 'usdc') verifyTokenTipReceipt(verify);
      else if (asset === 'nft') verifyNftGiftReceipt(verify);
      else if (tip.splits) verifySplitTipReceipt(verify);
      else verifyAttributedTipReceipt(verify);
    }
    const giftCount = _tipPending.intent.gifts?.length || 0;
    const txHash = receipt.hash || _tipPending.txHash;
    _tipPending = null;
    _tipSelectionState = 'sent';
    _tipSelectionMessage = `✅ ${asset === 'nft' ? '🎁' : 'Tip'} confirmed for ${tip.artist} — ${tip.title}. ${tip.routerAddress || asset !== 'eth' ? 'DecentBusking source recorded on-chain. ' : ''}TX: ${_shortAddr(txHash)}`;
    if (asset === 'nft') _tipGifts = [];
    _showStatus('tip-status', _tipSelectionMessage);
    announcePaymentCelebration({
      chainId,
      txHash,
      amountText: asset === 'nft' ? String(giftCount) : asset === 'usdc' ? ethers.formatUnits(amountWei, 6) : ethers.formatEther(amountWei),
      assetText: asset === 'nft' ? `NFT gift${giftCount === 1 ? '' : 's'}` : asset === 'usdc' ? 'USDC' : 'ETH',
      summary: `${asset === 'nft' ? 'Gift' : 'Tip'} to ${tip.artist} for ${tip.title} (${asset === 'nft' ? `${giftCount} NFT${giftCount === 1 ? '' : 's'}` : tip.splits ? `split ${tip.splits.length} ways` : _shortAddr(tip.wallet)})`,
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
function _tipRoute({ source, bookingId, nft, split = false }) {
  const cfg = window.DecentConfig || {};
  const routerAddress = (split ? cfg.tipSplitRouterAddress : cfg.tipRouterAddress) ?? '';
  const chainId = cfg.chainId || 8453;
  if (typeof routerAddress !== 'string' || (routerAddress &&
      (!/^0x[0-9a-fA-F]{40}$/.test(routerAddress) || /^0x0{40}$/i.test(routerAddress)))) {
    throw new Error('Tip attribution is configured with an invalid contract; direct fallback is disabled');
  }
  if (routerAddress && chainId !== 8453) throw new Error('DecentBusking tip attribution is Base-only');
  // USDC tips and NFT gifts use the v0.2 router for recordings; live tips stay ETH on the live ledger.
  const assetRouter = cfg.tipSplitRouterAddress || '';
  const assetRouterAddress = source !== 'live' && chainId === 8453 && /^0x[0-9a-fA-F]{40}$/.test(assetRouter) && !/^0x0{40}$/i.test(assetRouter) ? assetRouter : '';
  const nftId = (routerAddress || assetRouterAddress) && source !== 'live' ? nftIdentity(nft) : undefined;
  if (nftId && nft.chainId !== undefined && nft.chainId !== chainId) throw new Error('The recording identity belongs to another chain');
  const route = { source, bookingId, nftId, routerAddress, assetRouterAddress, chainId, chainName: cfg.chainName || 'Base Mainnet' };
  if (routerAddress || assetRouterAddress) createTipContext(route);
  return route;
}

function _tipAssetFor(tip) {
  return tip?.assetRouterAddress ? _tipAsset : 'eth';
}

function _tipOwners(tip) {
  return tip?.splits ? tip.splits.map(part => part.recipient) : tip?.wallet ? [tip.wallet] : [];
}

function _newTipGift() {
  return { collection: '', tokenId: '', amount: '1', recipient: 'all' };
}

const _NFT_PROBE_ABI = ['function supportsInterface(bytes4) view returns (bool)'];
const _ERC721_GIFT_ABI = [
  'function ownerOf(uint256) view returns (address)', 'function getApproved(uint256) view returns (address)',
  'function isApprovedForAll(address,address) view returns (bool)', 'function approve(address,uint256)',
];
const _ERC1155_GIFT_ABI = [
  'function balanceOf(address,uint256) view returns (uint256)', 'function isApprovedForAll(address,address) view returns (bool)',
  'function setApprovalForAll(address,bool)',
];

async function _nftStandard(collection, provider) {
  const probe = new ethers.Contract(collection, _NFT_PROBE_ABI, provider);
  try {
    if (await probe.supportsInterface('0x80ac58cd')) return NFT_STANDARDS.erc721;
    if (await probe.supportsInterface('0xd9b67a26')) return NFT_STANDARDS.erc1155;
  } catch { /* not ERC-165 */ }
  throw new Error(`${_shortAddr(collection)} is not an ERC-721 or ERC-1155 collection`);
}

async function _submitAssetTip({ tip, asset, amount, signer, provider, expectedChain }) {
  const router = tip.assetRouterAddress;
  if (!router) throw new Error('USDC tips and NFT gifts are not available for this song');
  if (await provider.getCode(router) === '0x') throw new Error('The configured tip contract is not deployed on this chain');
  const payer = await signer.getAddress();
  const intent = { ...tip, asset, payer, recipient: tip.wallet };
  const context = createTipContext(intent);
  const contract = new ethers.Contract(router, TIP_ASSET_ABI, signer);
  const options = { chainId: expectedChain };
  if (asset === 'usdc') {
    if (!await contract.allowedTokens(BASE_USDC_ADDRESS)) throw new Error('USDC tips are paused right now');
    if (tip.splits) splitTipAmounts(amount, tip.splits);
    intent.token = BASE_USDC_ADDRESS;
    intent.amountUnits = amount.toString();
    const usdc = new ethers.Contract(BASE_USDC_ADDRESS, USDC_BROWSER_ABI, signer);
    if (await usdc.balanceOf(payer) < amount) throw new Error('Not enough USDC in this wallet');
    if (await usdc.allowance(payer, router) < amount) {
      _showStatus('tip-status', `⏳ 1/2 · Approve exactly ${ethers.formatUnits(amount, 6)} USDC for this tip…`);
      await (await usdc.approve(router, amount, options)).wait();
      await waitForAllowance(usdc, payer, router, amount);
    }
    _showStatus('tip-status', '⏳ Confirm the tip in your wallet…');
    const tx = tip.splits
      ? await contract.tipTokenSplit(BASE_USDC_ADDRESS, tip.splits.map(part => part.recipient), tip.splits.map(part => part.shareBps),
        amount, context.sourceKind, context.contextRef, options)
      : await contract.tipToken(BASE_USDC_ADDRESS, tip.wallet, amount, context.sourceKind, context.contextRef, options);
    return { tx, intent };
  }

  const owners = _tipOwners(tip);
  const standards = new Map();
  for (const row of _tipGifts) {
    const key = String(row.collection || '').trim().toLowerCase();
    if (!ethers.isAddress(key)) throw new Error('Enter a valid NFT collection address');
    if (!standards.has(key)) standards.set(key, await _nftStandard(key, provider));
  }
  const expanded = _tipGifts.flatMap(row => {
    const collection = ethers.getAddress(String(row.collection).trim());
    const standard = standards.get(collection.toLowerCase());
    // The router refuses self-gifts, so a co-owner gifting "all owners" skips their own wallet.
    const recipients = row.recipient === 'all' ? owners.filter(owner => owner.toLowerCase() !== payer.toLowerCase()) : [row.recipient];
    if (!recipients.length || recipients.some(owner => owner.toLowerCase() === payer.toLowerCase())) throw new Error('You cannot gift an NFT to yourself');
    if (standard === NFT_STANDARDS.erc721 && recipients.length > 1) throw new Error('An ERC-721 NFT can go to one owner only');
    return recipients.map(recipient => ({ collection, standard, tokenId: String(row.tokenId).trim(), amount: standard === NFT_STANDARDS.erc721 ? '1' : String(row.amount).trim(), recipient }));
  });
  const gifts = normalizeNftGifts(expanded, owners);
  intent.gifts = gifts;
  const needs1155 = new Map();
  for (const gift of gifts) {
    if (gift.standard === NFT_STANDARDS.erc721) {
      const nft = new ethers.Contract(gift.collection, _ERC721_GIFT_ABI, signer);
      if ((await nft.ownerOf(gift.tokenId)).toLowerCase() !== payer.toLowerCase()) throw new Error(`You do not own NFT #${gift.tokenId}`);
      if ((await nft.getApproved(gift.tokenId)).toLowerCase() !== router.toLowerCase() && !await nft.isApprovedForAll(payer, router)) {
        _showStatus('tip-status', `⏳ Approve NFT #${gift.tokenId} for this gift…`);
        await (await nft.approve(router, gift.tokenId, options)).wait();
      }
    } else {
      const key = `${gift.collection.toLowerCase()}:${gift.tokenId}`;
      needs1155.set(key, (needs1155.get(key) || 0n) + BigInt(gift.amount));
    }
  }
  const approved1155 = new Set();
  for (const [key, total] of needs1155) {
    const [collection, tokenId] = key.split(':');
    const nft = new ethers.Contract(collection, _ERC1155_GIFT_ABI, signer);
    if (await nft.balanceOf(payer, tokenId) < total) throw new Error(`You hold fewer than ${total} of NFT #${tokenId}`);
    if (approved1155.has(collection) || await nft.isApprovedForAll(payer, router)) { approved1155.add(collection); continue; }
    _showStatus('tip-status', `⏳ Allow the tip contract to send from ${_shortAddr(collection)}…`);
    await (await nft.setApprovalForAll(router, true, options)).wait();
    approved1155.add(collection);
  }
  _showStatus('tip-status', '⏳ Confirm the gift in your wallet…');
  const tx = await contract.giftNfts(gifts.map(gift => [gift.collection, gift.standard, gift.tokenId, gift.amount, gift.recipient]),
    context.sourceKind, context.contextRef, options);
  return { tx, intent };
}

function _renderTipAsset() {
  const picker = document.getElementById('tip-asset-picker');
  const available = Boolean(_tipSnapshot?.assetRouterAddress);
  const asset = available ? _tipAsset : 'eth';
  const locked = _tipBusy || Boolean(_tipPending);
  if (picker) {
    picker.hidden = !available;
    picker.querySelectorAll('[data-tip-asset]').forEach(button => {
      button.setAttribute('aria-checked', String(button.dataset.tipAsset === asset));
      button.disabled = locked;
    });
  }
  const amountField = document.getElementById('tip-amount-field');
  const giftField = document.getElementById('tip-gift-field');
  if (amountField) amountField.hidden = asset === 'nft';
  if (giftField) giftField.hidden = asset !== 'nft';
  const unit = document.getElementById('tip-amount-unit');
  if (unit) unit.textContent = asset === 'usdc' ? '(USDC)' : '(ETH)';
  const estimate = document.getElementById('tip-usdc-estimate');
  if (estimate) estimate.hidden = asset !== 'eth';
  if (asset === 'nft') _renderTipGifts();
}

function _renderTipGifts() {
  const list = document.getElementById('tip-gift-list');
  if (!list) return;
  const owners = _tipOwners(_tipSnapshot);
  const shares = new Map((_tipSnapshot?.splits || []).map(part => [part.recipient.toLowerCase(), part.shareBps]));
  const locked = _tipBusy || Boolean(_tipPending);
  list.replaceChildren(..._tipGifts.map((gift, index) => {
    const row = document.createElement('li');
    row.className = 'tip-gift-row';
    const field = (name, placeholder, attrs = {}) => {
      const input = document.createElement('input');
      Object.assign(input, { value: gift[name], placeholder, disabled: locked, ...attrs });
      input.dataset.gift = name;
      input.setAttribute('aria-label', placeholder);
      input.addEventListener('input', () => { gift[name] = input.value; });
      return input;
    };
    const recipient = document.createElement('select');
    recipient.disabled = locked;
    recipient.setAttribute('aria-label', 'Gift to');
    const choices = owners.length > 1 ? [['all', '👥 All owners']] : [];
    owners.forEach(owner => choices.push([owner, `${_shortAddr(owner)}${shares.has(owner.toLowerCase()) ? ` · ${shares.get(owner.toLowerCase()) / 100}%` : ''}`]));
    if (!choices.some(([value]) => value === gift.recipient)) gift.recipient = choices[0]?.[0] || '';
    choices.forEach(([value, label]) => recipient.append(new Option(label, value, false, value === gift.recipient)));
    recipient.addEventListener('change', () => { gift.recipient = recipient.value; });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '✕';
    remove.disabled = locked;
    remove.setAttribute('aria-label', 'Remove this NFT');
    remove.addEventListener('click', () => {
      _tipGifts.splice(index, 1);
      if (!_tipGifts.length) _tipGifts.push(_newTipGift());
      _renderTipGifts();
    });
    row.append(field('collection', 'Collection 0x…', { spellcheck: false, autocomplete: 'off' }),
      field('tokenId', 'Token #', { inputMode: 'numeric' }), field('amount', 'Qty', { inputMode: 'numeric', title: 'ERC-1155 quantity (ERC-721 is always 1)' }),
      recipient, remove);
    return row;
  }));
  const add = document.getElementById('tip-gift-add');
  if (add) add.disabled = locked || _tipGifts.length >= 32;
}

const _DJUKE_SONG_ABI = ['function getSong(bytes32) view returns ((string audioURI,bool enabled,address[] recipients,uint16[] sharesBps))'];

// Tips follow the split the DJuke contract pays, not a cached catalog copy.
async function _readSongTipSplit(nft) {
  const cfg = window.DecentConfig || {};
  const routerAddress = cfg.tipSplitRouterAddress || '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(routerAddress) || /^0x0{40}$/i.test(routerAddress) ||
      !/^0x[0-9a-fA-F]{40}$/.test(cfg.djukeContractAddress || '') || !/^0x[0-9a-fA-F]{64}$/.test(nft?.djukeSongId || '')) return null;
  const contract = new ethers.Contract(cfg.djukeContractAddress, _DJUKE_SONG_ABI, getBaseReadProvider({ ethers }));
  const song = await contract.getSong(nft.djukeSongId);
  const splits = normalizeTipSplit([...song.recipients], [...song.sharesBps]);
  const expected = new Map(nft.creatorSplits.map(part => [String(part.wallet || part.address || '').toLowerCase(), Number(part.shareBps)]));
  if (expected.size !== splits.length || splits.some(part => expected.get(part.recipient.toLowerCase()) !== part.shareBps)) {
    throw new Error('The song split is being updated. Try again after the change is live.');
  }
  return splits;
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
  const asset = _tipAssetFor(_tipSnapshot);
  _renderTipAsset();
  if (routeEl) routeEl.textContent = asset === 'nft'
    ? '🎁 Straight from your wallet to the owners you pick.'
    : asset === 'usdc' && _tipSnapshot?.splits
    ? `$ Split between ${_tipSnapshot.splits.length} song owners, matching the song's on-chain split.`
    : asset === 'usdc'
    ? '$ 100% to the artist via the DecentBusking tip contract.'
    : _tipSnapshot?.splits
    ? `Split between ${_tipSnapshot.splits.length} song owners via the DecentBusking tip contract, matching the song's on-chain split.`
    : _tipSnapshot?.routerAddress
    ? `100% to the artist via the DecentBusking tip contract. On-chain source: ${_tipSnapshot.source === 'live' ? 'live performance' : _tipSnapshot.source === 'archive' ? 'archive recording' : 'radio recording'}.`
    : 'Legacy direct ETH tip. No DecentBusking source is recorded on-chain until the tip contract is enabled.';
  if (sendBtn) sendBtn.textContent = _tipPending ? 'Recheck tip' : asset === 'nft' ? '🎁 Send Gifts' : '💸 Send Tip';
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
    let splits = null;
    if (Array.isArray(nft?.creatorSplits) && nft.creatorSplits.length > 1) {
      splits = await _readSongTipSplit(nft);
      if (generation !== _tipLookupGeneration || _tipSelectionIndex !== index) return;
      if (!splits) {
        _tipSnapshot = null;
        _tipSelectionState = 'error';
        _tipSelectionMessage = 'This song is shared between owners, and split tips are not available right now. No tip was sent.';
        _renderTipWallet('');
        _showStatus('tip-status', _tipSelectionMessage, true);
        _syncTipNavState();
        return;
      }
    }
    track.nft = nft;
    _tipHistory[index] = { ...entry, track };
    _tipSnapshot = Object.freeze({
      wallet,
      ...(splits ? { splits } : {}),
      artist: nftArtistLabel(nft),
      title: track.title || nft.name || nft.title || 'Unknown song',
      trackKey: _tipTrackKey(track),
      ..._tipRoute({ source: track.source === 'archive' ? 'archive' : 'radio', nft, split: Boolean(splits) }),
    });
    document.getElementById('tip-artist').textContent = _tipSnapshot.artist;
    document.getElementById('tip-song').textContent = _tipSnapshot.title;
    _renderTipWallet(wallet, splits);
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
