// js/components/header-right-ankh-override.js — DecentBusking
//
// Intercepts the CDN DecentHead 'right-ankh' custom element definition
// and replaces it with a clean, empty implementation.
//
// The CDN's RightAnkhDropdown.js hard-codes OMMM token lookups and a Uniswap
// link that are not relevant to DecentBusking.  By defining our own clean
// 'right-ankh' element BEFORE the CDN script runs (achieved by listing this
// module first in index.html), or by intercepting customElements.define, we
// prevent the OMMM contract call from ever executing.
//
// The override preserves the visual ankh-coin (☥) and sparkle structure that
// the DecentHead CSS already styles, but renders an empty dropdown so the
// right-hand side of the header looks consistent with the left.  New menu
// items can be added here as DecentBusking features grow.

(function interceptRightAnkh() {
  // Only intercept if 'right-ankh' has not already been registered.
  // This guards against double-execution or conflicts with other overrides.
  if (customElements.get('right-ankh')) return;

  const originalDefine = CustomElementRegistry.prototype.define.bind(customElements);

  CustomElementRegistry.prototype.define = function (name, constructor, options) {
    if (name === 'right-ankh') {
      // Restore the original define immediately after intercepting so that
      // no other element registrations are affected.
      CustomElementRegistry.prototype.define = originalDefine;
      return originalDefine(name, CleanRightAnkh, options);
    }
    return originalDefine(name, constructor, options);
  };
})();

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
        .wallet-addr {
          display: block;
          font-size: 0.75em;
          opacity: 0.7;
          padding: 0 1rem 0.4rem;
        }
      </style>
      <div class="ankh-wrapper">
        <div class="ankh-container">
          <span class="ankh-coin" role="button" aria-haspopup="true" aria-label="Right menu">☥</span>
          <ul class="dropdown-menu right-ankh-menu"
              style="display:none; list-style:none; padding:0; margin:0; position:absolute; top:100%; left:50%; transform:translateX(-50%);">
            <li class="wallet-item">
              <button class="wallet-btn" id="wallet-connect-btn">🦊 Connect Wallet</button>
            </li>
            <li class="wallet-item">
              <span class="wallet-addr" id="wallet-addr-display" style="display:none;"></span>
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
    const connectBtn = this.shadowRoot.querySelector('#wallet-connect-btn');
    const addrDisplay = this.shadowRoot.querySelector('#wallet-addr-display');

    // Wire the Connect Wallet button.
    connectBtn?.addEventListener('click', e => {
      e.stopPropagation();
      if (window._wallet?.connect) {
        window._wallet.connect();
      }
    });

    // Update button + address display when the global wallet state changes.
    const _onConnected = (ev) => {
      const addr = ev.detail?.address || '';
      if (connectBtn) connectBtn.textContent = '✅ Wallet Connected';
      if (addrDisplay) {
        addrDisplay.textContent = addr
          ? `${addr.slice(0, 6)}…${addr.slice(-4)}`
          : '';
        addrDisplay.style.display = addr ? 'block' : 'none';
      }
    };
    const _onDisconnected = () => {
      if (connectBtn) connectBtn.textContent = '🦊 Connect Wallet';
      if (addrDisplay) {
        addrDisplay.textContent = '';
        addrDisplay.style.display = 'none';
      }
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
      if (!popup) return;
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
