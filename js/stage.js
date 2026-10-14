// js/stage.js — DecentBusking
// Hat (tip) + Guitar Case (mint) interactions and the now-playing banner.

import { openMintModal } from './mint.js?v=20261014-celebrate';
import { initRadioSync, playArchiveTrack } from './radio-sync.js?v=20261010-listens';
import { announcePaymentCelebration } from './payment-celebration.mjs';
import { resolveNowPlayingNFT } from './space.js?v=20261014-celebrate';
import { nftArtistLabel } from './nft-loader.js?v=20261012-paging';

let _tipPlayingTrack = null;
let _tipSnapshot = null;
let _tipLookupGeneration = 0;
let _tipBusy = false;

// ── Public API ────────────────────────────────────────────────────────────
export function initStage() {
  document.addEventListener('dbusk-now-playing', (event) => {
    _tipPlayingTrack = event.detail ? { ...event.detail } : null;
  });
  document.addEventListener('dbusk-now-playing-stopped', () => {
    _tipPlayingTrack = null;
  });
  _bindHat();
  _bindGuitarCase();
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

// ── Hat (tip) ─────────────────────────────────────────────────────────────
function _bindHat() {
  const hatBtn = document.getElementById('hat-btn');
  if (!hatBtn) return;

  hatBtn.addEventListener('click', async () => {
    if (_tipBusy) return;
    const modal = document.getElementById('tip-modal');
    if (!modal) return;
    const generation = ++_tipLookupGeneration;
    const track = _tipPlayingTrack ? { ..._tipPlayingTrack } : null;
    _tipSnapshot = null;
    document.getElementById('tip-send-btn').disabled = true;
    document.getElementById('tip-artist').textContent = track?.artist || 'Unknown artist';
    document.getElementById('tip-song').textContent = track?.title || 'No song playing';
    _renderTipWallet('');
    _showStatus('tip-status', '');
    modal.classList.remove('hidden');
    if (!track) {
      _showStatus('tip-status', 'No song is playing. Play a song before opening the tip hat.', true);
      return;
    }
    _showStatus('tip-status', 'Looking up this song\'s tip wallet...');
    try {
      const nft = track.nft || await resolveNowPlayingNFT(track, { requireMediaMatch: true });
      if (generation !== _tipLookupGeneration) return;
      const wallet = nft?.tipWallet || '';
      if (!/^0x[0-9a-fA-F]{40}$/.test(wallet) || /^0x0{40}$/i.test(wallet)) {
        _showStatus('tip-status', 'No verified tip wallet is available for this song. Tips are disabled.', true);
        return;
      }
      _tipSnapshot = { wallet, artist: nftArtistLabel(nft),
        title: track.title || nft.name || nft.title || 'Unknown song' };
      document.getElementById('tip-artist').textContent = _tipSnapshot.artist;
      document.getElementById('tip-song').textContent = _tipSnapshot.title;
      _renderTipWallet(wallet);
      document.getElementById('tip-send-btn').disabled = !window.ethereum;
      _showStatus('tip-status', window.ethereum ? '' : '🦊 MetaMask not detected. Install it to send tips.', !window.ethereum);
    } catch (error) {
      if (generation !== _tipLookupGeneration) return;
      _showStatus('tip-status', `Could not verify this song's tip wallet: ${error.message}`, true);
    }
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
  if (!_tipBusy) _tipSnapshot = null;
}

// ── Guitar Case (mint) ────────────────────────────────────────────────────
function _bindGuitarCase() {
  const btn = document.getElementById('guitar-case-btn');
  if (!btn) return;

  btn.addEventListener('click', () => {
    openMintModal();
  });
}

// ── Tip modal wiring ──────────────────────────────────────────────────────
function _bindTipModal() {
  const sendBtn = document.getElementById('tip-send-btn');
  const cancelBtn = document.getElementById('tip-cancel-btn');
  const modal = document.getElementById('tip-modal');

  if (cancelBtn) {
    cancelBtn.addEventListener('click', _closeTipModal);
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', _handleSendTip);
  }

  // Close on backdrop click
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) _closeTipModal();
    });
  }
}

async function _handleSendTip() {
  const amountInput = document.getElementById('tip-amount');
  const sendBtn = document.getElementById('tip-send-btn');
  const cfg = window.DecentConfig || {};
  if (_tipBusy) return;

  _showStatus('tip-status', '');

  const tip = _tipSnapshot;
  if (!tip) {
    _showStatus('tip-status', 'No verified recipient. Open the hat while a song is playing.', true);
    return;
  }

  const amount = parseFloat(amountInput?.value);
  if (!amount || amount <= 0) {
    _showStatus('tip-status', '⚠️ Enter a valid tip amount.', true);
    return;
  }

  if (!window.ethereum) {
    _showStatus('tip-status', '🦊 MetaMask not detected.', true);
    return;
  }

  try {
    _tipBusy = true;
    sendBtn.disabled = true;
    _showStatus('tip-status', '⏳ Waiting for MetaMask…');

    const signer = window._wallet?.signer;
    if (!signer) {
      _showStatus('tip-status', '🦊 Please connect your wallet via the header first.', true);
      return;
    }

    const chainId = Number((await signer.provider.getNetwork()).chainId);
    if (chainId !== (cfg.chainId || 8453)) {
      _showStatus('tip-status', `⚠️ Switch MetaMask to ${cfg.chainName || 'Base Mainnet'} (chain ID ${cfg.chainId || 8453}).`, true);
      return;
    }

    const amountWei = ethers.parseEther(String(amount));
    const tx = await signer.sendTransaction({
      to: tip.wallet,
      value: amountWei,
    });
    _showStatus('tip-status', 'Tip submitted. Waiting for on-chain confirmation...');
    const receipt = await tx.wait();
    if (receipt?.status !== 1) throw new Error('Tip was not confirmed successfully');
    _tipSnapshot = null;
    _showStatus('tip-status', `✅ Tip confirmed for ${tip.artist} — ${tip.title}. TX: ${_shortAddr(tx.hash)}`);
    announcePaymentCelebration({
      chainId,
      txHash: receipt.hash || tx.hash,
      amountText: ethers.formatEther(amountWei),
      assetText: 'ETH',
      summary: `Tip to ${tip.artist} for ${tip.title} (${_shortAddr(tip.wallet)})`,
      txLabel: 'Tip confirmed',
    });
  } catch (err) {
    _showStatus('tip-status', `❌ ${err.message || 'Transaction failed'}`, true);
  } finally {
    _tipBusy = false;
    sendBtn.disabled = !_tipSnapshot;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function _showStatus(elId, msg, isError = false) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function _shortAddr(addr = '') {
  return addr.length > 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
