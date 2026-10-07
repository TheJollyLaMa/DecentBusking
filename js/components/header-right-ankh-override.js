// js/components/header-right-ankh-override.js — DecentBusking
//
// Owns the wallet-specific playback menu. header.js imports this module before
// loading DecentHead components, so the legacy token dropdown is never needed.

class CleanRightAnkh extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    // Resolve the DecentHead CDN base path so the shared header.css
    // (which styles .ankh-wrapper, .ankh-coin and .sparkle) is loaded.
    const cdnBase = 'https://cdn.jsdelivr.net/gh/TheJollyLaMa/DecentHead@main/';

    this.shadowRoot.innerHTML = `
      <link rel="stylesheet" href="${cdnBase}css/header.css" />
      <style>
        .ankh-container { position: relative; }
        .dropdown-menu.right-ankh-menu {
          position: absolute;
          top: 100%;
          right: 0;
          left: auto;
          transform: none;
          width: max-content;
          max-width: calc(100vw - 24px);
          list-style: none;
          padding: 0;
          margin: 0;
        }
        .wallet-item { list-style: none; }
        .wallet-btn {
          background: none;
          border: none;
          color: inherit;
          cursor: pointer;
          font: inherit;
          padding: 0.4rem 1rem;
          white-space: nowrap;
          width: 100%;
          text-align: left;
        }
        .wallet-btn:hover { opacity: 0.8; }
      </style>
      <div class="ankh-wrapper">
        <div class="ankh-container">
          <span class="ankh-coin" role="button" aria-haspopup="true" aria-label="Right menu">☥</span>
          <ul class="dropdown-menu right-ankh-menu"
              style="display:none;">
            <li class="wallet-item">
              <button class="wallet-btn" id="radio-history-btn" style="display:none;">My Playbacks</button>
            </li>
          </ul>
        </div>
        <span class="sparkle sparkle-top">✨</span>
        <span class="sparkle sparkle-bottom">✨</span>
        <span class="sparkle sparkle-left">✨</span>
        <span class="sparkle sparkle-right">✨</span>
      </div>
    `;

    const coin = this.shadowRoot.querySelector('.ankh-coin');
    const popup = this.shadowRoot.querySelector('.dropdown-menu.right-ankh-menu');
    const historyBtn = this.shadowRoot.querySelector('#radio-history-btn');
    historyBtn?.addEventListener('click', (event) => {
      event.stopPropagation();
      if (popup) popup.style.display = 'none';
      if (window._wallet?.address) {
        document.dispatchEvent(new CustomEvent('open-radio-history', {
          detail: { mode: 'personal', wallet: window._wallet.address },
        }));
      }
    });

    const _onConnected = (ev) => {
      const addr = ev.detail?.address || '';
      if (historyBtn) historyBtn.style.display = addr ? 'block' : 'none';
    };
    const _onDisconnected = () => {
      if (historyBtn) historyBtn.style.display = 'none';
      if (popup) popup.style.display = 'none';
    };

    document.addEventListener('wallet-connected',    _onConnected);
    document.addEventListener('wallet-disconnected', _onDisconnected);

    // Reflect current state in case the wallet was already connected before
    // this element attached (e.g. page reload with auto-connect).
    if (window._wallet?.address) {
      _onConnected({ detail: { address: window._wallet.address } });
    }

    // Store listener references for cleanup.
    this._onConnected    = _onConnected;
    this._onDisconnected = _onDisconnected;

    coin?.addEventListener('click', e => {
      if (!popup || !window._wallet?.address) return;
      popup.style.display = popup.style.display === 'block' ? 'none' : 'block';
      e.stopPropagation();
    });

    // Store the listener reference so it can be removed in disconnectedCallback.
    this._closePopup = () => { if (popup) popup.style.display = 'none'; };
    document.addEventListener('click', this._closePopup);
  }

  disconnectedCallback() {
    if (this._closePopup) {
      document.removeEventListener('click', this._closePopup);
      this._closePopup = null;
    }
    if (this._onConnected) {
      document.removeEventListener('wallet-connected',    this._onConnected);
      this._onConnected = null;
    }
    if (this._onDisconnected) {
      document.removeEventListener('wallet-disconnected', this._onDisconnected);
      this._onDisconnected = null;
    }
  }
}

if (!customElements.get('right-ankh')) customElements.define('right-ankh', CleanRightAnkh);
