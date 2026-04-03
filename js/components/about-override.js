// js/components/about-override.js — DecentBusking
//
// The shared CDN header component registers a generic 'about-modal' web component.
// This module waits for that registration and then patches the prototype
// to render DecentBusking-specific content:
//   • Project mission & description
//   • Supporter DNFT cards fetched from the DecentNFT contract on Optimism
//   • "No DNFTs yet — coming in V1.0.0!" placeholder while supply is zero

const OPTIMISM_RPC = 'https://mainnet.optimism.io';

// Minimal ABI — only what the About Modal needs (ERC-721Enumerable + pricing)
const DNFT_ABI = [
  'function totalSupply() view returns (uint256)',
  'function tokenByIndex(uint256 index) view returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getPrice(uint256 tokenId) view returns (uint256)',
];

// ── Prototype patches ────────────────────────────────────────────────────────

function patchAboutModal() {
  const cls = customElements.get('about-modal');
  if (!cls) return;

  // Replace connectedCallback so every new instance renders our content
  cls.prototype.connectedCallback = function () {
    this._renderDecentBusking();
  };

  // open() — show the modal overlay and start loading supporter NFTs
  cls.prototype.open = function () {
    this._renderDecentBusking(); // re-render in case content was reset
    const container = this.shadowRoot && this.shadowRoot.querySelector('.modal-container');
    if (container) container.style.display = 'flex';
    this._loadSupporterNFTs();
  };

  // close() — hide the modal overlay
  cls.prototype.close = function () {
    const container = this.shadowRoot && this.shadowRoot.querySelector('.modal-container');
    if (container) container.style.display = 'none';
  };

  // _renderDecentBusking() — inject our HTML + styles into the shadow root
  cls.prototype._renderDecentBusking = function () {
    const cfg = window.DECENT_CONFIG || window.DecentConfig || {};
    const discord = _esc(cfg.discord || '#');
    const github  = _esc(cfg.github  || 'https://github.com/TheJollyLaMa/DecentBusking');

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: contents; }
        .modal-container {
          display: none;
          position: fixed;
          inset: 0;
          z-index: 9999;
          align-items: center;
          justify-content: center;
          background: rgba(3, 1, 10, 0.88);
          backdrop-filter: blur(6px);
        }
        .modal-box {
          background: linear-gradient(160deg, #0d0a1a 0%, #05021a 100%);
          border: 1px solid rgba(240, 192, 64, 0.35);
          border-radius: 14px;
          padding: 2rem;
          max-width: 540px;
          width: 92vw;
          max-height: 82vh;
          overflow-y: auto;
          color: #e0d8c8;
          position: relative;
          box-shadow: 0 0 50px rgba(0, 0, 0, 0.75), 0 0 120px rgba(240, 192, 64, 0.06);
        }
        .close-btn {
          position: absolute;
          top: 0.9rem;
          right: 1rem;
          background: none;
          border: none;
          color: #f0c040;
          font-size: 1.4rem;
          cursor: pointer;
          line-height: 1;
          padding: 0;
        }
        .close-btn:hover { color: #fff; }
        h2 {
          color: #f0c040;
          margin: 0 0 0.25rem;
          font-size: 1.35rem;
          font-family: 'Bungee', 'Impact', sans-serif;
        }
        .mission {
          color: #b8a878;
          font-size: 0.92em;
          font-style: italic;
          margin: 0 0 1rem;
        }
        p {
          color: #b0a890;
          line-height: 1.6;
          font-size: 0.88em;
          margin: 0 0 0.75rem;
        }
        .section-title {
          color: #f0c040;
          font-size: 0.75em;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          margin: 1.5rem 0 0.6rem;
          padding-bottom: 0.3rem;
          border-bottom: 1px solid rgba(240, 192, 64, 0.2);
        }
        .nft-grid {
          display: flex;
          flex-wrap: wrap;
          gap: 0.5rem;
        }
        .nft-card {
          background: rgba(240, 192, 64, 0.07);
          border: 1px solid rgba(240, 192, 64, 0.25);
          border-radius: 8px;
          padding: 0.55rem 0.8rem;
          font-size: 0.8em;
          color: #e0d8c8;
        }
        .nft-id   { color: #f0c040; font-weight: bold; font-size: 0.95em; }
        .nft-price { color: #8a7a5a; font-size: 0.82em; margin-top: 0.2em; }
        .empty-msg {
          color: #6a5a3a;
          font-size: 0.85em;
          text-align: center;
          padding: 1rem 0.5rem;
          line-height: 1.7;
        }
        .empty-msg strong { color: #f0c040; }
        .links {
          display: flex;
          gap: 1.25rem;
          flex-wrap: wrap;
          margin-top: 0.4rem;
        }
        a {
          color: #f0c040;
          text-decoration: none;
          font-size: 0.88em;
        }
        a:hover { text-decoration: underline; }
      </style>

      <div class="modal-container">
        <div class="modal-box">
          <button class="close-btn" id="about-close">✕</button>

          <h2>Decent🦚Busking</h2>
          <p class="mission">The Web3 Digital Town Square — mint audio NFTs, tip artists, fly through space.</p>

          <p>
            Artists busk live on <strong>Optimism</strong>. Mint your sound, watch it drift into the cosmos.
            Cover or remix, with royalties flowing back through the chain automatically.
          </p>

          <div class="section-title">🎟️ Supporter DNFTs</div>
          <div id="supporter-nfts">
            <p class="empty-msg">⏳ Loading…</p>
          </div>

          <div class="section-title">🔗 Links</div>
          <div class="links">
            <a href="${github}" target="_blank" rel="noopener">🐙 GitHub</a>
            <a href="${discord}" target="_blank" rel="noopener">💬 Discord</a>
            <a href="https://optimistic.etherscan.io" target="_blank" rel="noopener">🔍 Optimism Explorer</a>
          </div>
        </div>
      </div>
    `;

    this.shadowRoot.getElementById('about-close')
      ?.addEventListener('click', () => this.close());
    this.shadowRoot.querySelector('.modal-container')
      ?.addEventListener('click', e => { if (e.target === e.currentTarget) this.close(); });
  };

  // _loadSupporterNFTs() — fetch tokens from DecentNFT contract on Optimism
  cls.prototype._loadSupporterNFTs = async function () {
    const container = this.shadowRoot && this.shadowRoot.getElementById('supporter-nfts');
    if (!container) return;

    const cfg = window.DECENT_CONFIG || window.DecentConfig || {};
    const addr = cfg.contractAddress;

    if (!addr || addr === '0x0000000000000000000000000000000000000000') {
      container.innerHTML = '<p class="empty-msg">⚠️ Contract address not configured.</p>';
      return;
    }

    if (!window.ethers) {
      container.innerHTML = '<p class="empty-msg">⚠️ ethers.js not loaded.</p>';
      return;
    }

    container.innerHTML = '<p class="empty-msg">⏳ Loading supporter NFTs from contract…</p>';

    try {
      const provider = new window.ethers.JsonRpcProvider(OPTIMISM_RPC);
      const contract = new window.ethers.Contract(addr, DNFT_ABI, provider);

      let total;
      try {
        total = await contract.totalSupply();
      } catch {
        // Contract may not implement ERC-721Enumerable totalSupply — treat as zero
        total = 0n;
      }

      if (total === 0n || total === BigInt(0)) {
        container.innerHTML = `
          <div class="empty-msg">
            <p>🎟️ No supporter DNFTs have been minted yet.</p>
            <p>They will be minted as soon as <strong>V1.0.0</strong> goes live! 🚀</p>
          </div>`;
        return;
      }

      // Load up to 12 tokens — a practical cap to keep the modal lightweight
      // and avoid too many sequential RPC calls for large supplies.
      const cards = [];
      for (let i = 0; i < Math.min(Number(total), 12); i++) {
        try {
          const tokenId = await contract.tokenByIndex(i);
          let priceLabel = '';
          try {
            const priceWei = await contract.getPrice(tokenId);
            priceLabel = `${window.ethers.formatEther(priceWei)} ETH`;
          } catch { /* price not available */ }

          cards.push(`
            <div class="nft-card">
              <div class="nft-id">DNFT #${tokenId}</div>
              ${priceLabel ? `<div class="nft-price">${_esc(priceLabel)}</div>` : ''}
            </div>`);
        } catch { /* skip token if fetch fails */ }
      }

      container.innerHTML = cards.length
        ? `<div class="nft-grid">${cards.join('')}</div>`
        : `<div class="empty-msg">
             <p>🎟️ No supporter DNFTs have been minted yet.</p>
             <p>They will be minted as soon as <strong>V1.0.0</strong> goes live! 🚀</p>
           </div>`;

    } catch (err) {
      // Network error or contract not found — distinguish from "zero supply"
      const isNetworkError = err && (err.code === 'NETWORK_ERROR' || err.code === 'ECONNREFUSED');
      container.innerHTML = isNetworkError
        ? `<p class="empty-msg">⚠️ Could not reach Optimism RPC — please check your connection.</p>`
        : `<div class="empty-msg">
             <p>🎟️ No supporter DNFTs have been minted yet.</p>
             <p>They will be minted as soon as <strong>V1.0.0</strong> goes live! 🚀</p>
           </div>`;
    }
  };

  // Re-render any about-modal instances already in the DOM (including shadow roots)
  _findAllAboutModals().forEach(m => m._renderDecentBusking());
}

// ── Shadow-DOM traversal ─────────────────────────────────────────────────────

function _findAllAboutModals() {
  const found = [];
  function walk(root) {
    root.querySelectorAll('about-modal').forEach(el => found.push(el));
    root.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) walk(el.shadowRoot);
    });
  }
  walk(document);
  return found;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

if (customElements.get('about-modal')) {
  patchAboutModal();
} else {
  customElements.whenDefined('about-modal').then(patchAboutModal);
}
