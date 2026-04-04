// js/stage.js — DecentBusking
// Hat (tip) + Guitar Case (mint) interactions and the now-playing banner.

import { openMintModal } from './mint.js';

// ── Public API ────────────────────────────────────────────────────────────
export function initStage() {
  _bindHat();
  _bindGuitarCase();
  _bindTipModal();
  _bindNowPlayingBtn();
}

// Update the "Now Playing" banner (called from space.js when an NFT is clicked
// or auto-advances to the nearest busking audio).
export function setNowPlaying({ title = '—', artist = '', audioUrl = '' } = {}) {
  const titleEl = document.getElementById('now-playing-title');
  const artistEl = document.getElementById('now-playing-artist');
  const player = document.getElementById('audio-player');
  const playBtn = document.getElementById('now-playing-play-btn');

  if (titleEl) titleEl.textContent = title;
  if (artistEl) artistEl.textContent = artist;

  if (player && audioUrl) {
    // Ensure ipfs:// URIs are resolved to an HTTP gateway URL before handing
    // them to the <audio> element — browsers cannot play ipfs:// directly.
    const cfg = window.DecentConfig || {};
    const gateway = cfg.ipfsGateway || 'https://w3s.link/ipfs/';
    const httpUrl = /^ipfs:\/\//i.test(audioUrl)
      ? audioUrl.replace(/^ipfs:\/\//i, gateway)
      : audioUrl;

    // Guard: only accept http/https URLs to prevent unexpected protocol schemes
    if (!/^https?:\/\//i.test(httpUrl)) {
      console.warn('[stage] setNowPlaying: rejected non-HTTP(S) audio URL:', httpUrl);
      return;
    }

    // Remove any stale <source> children and clear the src attribute so the
    // browser sees a clean slate before we add the new source.
    player.removeAttribute('src');
    Array.from(player.querySelectorAll('source')).forEach(s => s.remove());

    const mime = _mimeType(httpUrl);
    const source = document.createElement('source');
    source.src = httpUrl;
    if (mime) source.type = mime; // Gives browser format hint; prevents 'no supported source' on m4a/mp3
    player.appendChild(source);

    player.load(); // Reset element state so the new source is picked up reliably
    player.play().then(() => {
      // Autoplay succeeded — hide manual play button
      if (playBtn) playBtn.classList.add('hidden');
    }).catch(() => {
      // Autoplay blocked — show play button so user can start it manually
      if (playBtn) playBtn.classList.remove('hidden');
    });
  }
}

// ── Now Playing play button (autoplay fallback) ───────────────────────────
function _bindNowPlayingBtn() {
  const playBtn = document.getElementById('now-playing-play-btn');
  if (!playBtn) return;

  playBtn.addEventListener('click', () => {
    const player = document.getElementById('audio-player');
    if (player && player.querySelector('source')) {
      player.load(); // Ensure element state is fresh before playing
      player.play().then(() => {
        playBtn.classList.add('hidden');
      }).catch(err => {
        console.warn('[stage] Manual play failed:', err.message);
      });
    }
  });
}

// ── Hat (tip) ─────────────────────────────────────────────────────────────
function _bindHat() {
  const hatBtn = document.getElementById('hat-btn');
  if (!hatBtn) return;

  hatBtn.addEventListener('click', () => {
    // If a busker wallet is set (e.g. from the currently focused NFT), open
    // the tip modal pre-filled for that wallet.  Otherwise prompt MetaMask
    // connect so the user can self-configure.
    const modal = document.getElementById('tip-modal');
    if (!modal) return;

    const label = document.getElementById('tip-to-label');
    if (label) {
      const wallet = window._currentBuskerWallet || '';
      label.textContent = wallet
        ? `Tip the busker directly: ${_shortAddr(wallet)}`
        : 'Connect MetaMask, then click 🎩 again to send a tip.';
    }

    if (!window.ethereum) {
      _showStatus('tip-status', '🦊 MetaMask not detected. Install it to send tips.', true);
    }

    modal.classList.remove('hidden');
  });
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
    cancelBtn.addEventListener('click', () => modal?.classList.add('hidden'));
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', _handleSendTip);
  }

  // Close on backdrop click
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });
  }
}

async function _handleSendTip() {
  const amountInput = document.getElementById('tip-amount');
  const statusEl = document.getElementById('tip-status');
  const sendBtn = document.getElementById('tip-send-btn');
  const cfg = window.DecentConfig || {};

  _showStatus('tip-status', '');

  const recipientWallet = window._currentBuskerWallet || '';
  if (!recipientWallet) {
    _showStatus('tip-status', '⚠️ No busker wallet set. Click on an NFT first.', true);
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
    sendBtn.disabled = true;
    _showStatus('tip-status', '⏳ Waiting for MetaMask…');

    const signer = window._wallet?.signer;
    if (!signer) {
      _showStatus('tip-status', '🦊 Please connect your wallet via the header first.', true);
      sendBtn.disabled = false;
      return;
    }

    const chainId = window._wallet.chainId;
    if (chainId !== null && Number(chainId) !== (cfg.chainId || 10)) {
      _showStatus('tip-status', `⚠️ Switch MetaMask to chain ID ${cfg.chainId || 10} (Optimism).`, true);
      sendBtn.disabled = false;
      return;
    }

    const amountWei = ethers.parseEther(String(amount));
    const tx = await signer.sendTransaction({
      to: recipientWallet,
      value: amountWei,
    });

    _showStatus('tip-status', `✅ Tip sent! TX: ${_shortAddr(tx.hash)}`);
    // Close modal after short delay
    setTimeout(() => {
      document.getElementById('tip-modal')?.classList.add('hidden');
      sendBtn.disabled = false;
    }, 2500);
  } catch (err) {
    _showStatus('tip-status', `❌ ${err.message || 'Transaction failed'}`, true);
    sendBtn.disabled = false;
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

// ── MIME type helper ──────────────────────────────────────────────────────
function _mimeType(url) {
  if (/\.mp3(\?|$)/i.test(url)) return 'audio/mpeg';
  if (/\.m4a(\?|$)/i.test(url)) return 'audio/mp4';
  if (/\.ogg(\?|$)/i.test(url)) return 'audio/ogg';
  if (/\.wav(\?|$)/i.test(url)) return 'audio/wav';
  if (/\.flac(\?|$)/i.test(url)) return 'audio/flac';
  return '';
}
