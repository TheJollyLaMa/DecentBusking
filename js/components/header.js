const DECENT_HEAD_BASE = 'https://cdn.jsdelivr.net/gh/TheJollyLaMa/DecentHead@main/';

await Promise.all([
  import(`${DECENT_HEAD_BASE}js/components/Header/AppTitle.js`),
  import(`${DECENT_HEAD_BASE}js/components/Header/WalletConnect.js`),
  import(`${DECENT_HEAD_BASE}js/components/Header/RightAnkhDropdown.js`),
  import(`${DECENT_HEAD_BASE}js/components/Header/AboutModal.js`),
  import(`${DECENT_HEAD_BASE}js/components/Header/SubscriptionModal.js`),
]);

class DecentBuskingHeader extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.shadowRoot.innerHTML = `
      <link rel="stylesheet" href="${DECENT_HEAD_BASE}css/styles.css" />
      <link rel="stylesheet" href="${DECENT_HEAD_BASE}css/header.css" />
      <header>
        <app-title></app-title>
        <wallet-connect></wallet-connect>
      </header>
    `;
  }
}

customElements.define('decent-header', DecentBuskingHeader);
