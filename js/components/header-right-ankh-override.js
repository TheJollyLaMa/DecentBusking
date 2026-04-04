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
      <div class="ankh-wrapper">
        <div class="ankh-container">
          <span class="ankh-coin" role="button" aria-haspopup="true" aria-label="Right menu">☥</span>
          <ul class="dropdown-menu right-ankh-menu"
              style="display:none; list-style:none; padding:0; margin:0; position:absolute; top:100%; left:50%; transform:translateX(-50%);">
            <!-- Empty — items will be added here in a future iteration -->
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
  }
}
