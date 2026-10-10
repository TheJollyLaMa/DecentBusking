import './header-right-ankh-override.js?v=20261007-my-playbacks';

const DECENT_HEAD_BASE = 'https://cdn.jsdelivr.net/gh/TheJollyLaMa/DecentHead@main/';
const DBUSKER_AVATAR_URL = new URL('../../img/D_Busker.jpeg', import.meta.url).href;
const IPFS_LOGO_URL = new URL('../../img/IPFS_Logo.png', import.meta.url).href;
const JAM_SUBTITLE_PARTS = [
  { text: '🎙️', className: 'jam-icon jam-mic' },
  { text: '⚸', className: 'jam-icon jam-mark' },
  { text: ' ' },
  { text: '♀︎', className: 'jam-icon jam-venus' },
  { text: '🎸', className: 'jam-icon jam-guitar' },
  { text: ' The Web3 Digital Town Square ' },
  { text: '🔊', className: 'jam-icon jam-speaker' },
  { text: ' ' },
  { text: '🎶', className: 'jam-icon jam-note jam-note-one' },
  { text: ' ' },
  { text: '🎶', className: 'jam-icon jam-note jam-note-two' },
  { text: ' ' },
  { text: '🎶', className: 'jam-icon jam-note jam-note-three' },
];

const MOBILE_HEADER_SHELL_STYLE = `
  decent-header { display: block; }
  @keyframes header-energy-pulse {
    0%, 100% { box-shadow: 0 0 0 1px rgba(255,180,105,.38), 0 0 8px rgba(255,145,75,.18); }
    50% { box-shadow: 0 0 0 2px rgba(255,201,145,.72), 0 0 15px rgba(255,145,75,.42); }
  }
  @keyframes header-energy-flow {
    0% { opacity: .25; background-position: 0 0; }
    50% { opacity: .95; background-position: 0 10px; }
    100% { opacity: .25; background-position: 0 20px; }
  }
  @keyframes header-pulse-travel { to { stroke-dashoffset: 0; } }
  .header-energy-network {
    position: absolute;
    inset: 0;
    z-index: -1;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
  }
  .header-energy-network .energy-link-base {
    fill: none;
    stroke: rgba(255,184,119,.26);
    stroke-width: 1;
  }
  .header-energy-network .energy-link-pulse {
    fill: none;
    stroke: rgba(255,208,163,.96);
    stroke-width: 1.7;
    stroke-linecap: round;
    filter: drop-shadow(0 0 4px rgba(255,151,86,.95));
    animation: header-pulse-travel var(--pulse-duration, 4s) linear infinite;
    animation-delay: var(--pulse-delay, 0s);
  }
  .header-energy-network .energy-link-pulse.energy-link-cool {
    stroke: rgba(142,222,222,.92);
    filter: drop-shadow(0 0 4px rgba(92,210,207,.86));
  }
  .header-energy-network .energy-node {
    fill: #121820;
    stroke: rgba(255,205,158,.82);
    stroke-width: 1.2;
    filter: drop-shadow(0 0 4px rgba(255,143,77,.7));
  }
  .header-ipfs-control {
    position: absolute;
    top: 16px;
    left: 16px;
    z-index: 1003;
    display: flex;
    align-items: center;
    gap: 7px;
    font: 600 12px/1 'Segoe UI', sans-serif;
  }
  .header-ipfs-button {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 70px;
    min-width: 70px;
    height: 70px;
    padding: 0;
    color: #fff7ed;
    background: radial-gradient(circle at 32% 25%, rgba(255,211,160,.2), rgba(18,21,28,.97) 68%);
    border: 1px solid rgba(255, 183, 112, .75);
    border-radius: 50%;
    animation: header-energy-pulse 3.8s ease-in-out infinite;
    cursor: pointer;
  }
  .header-ipfs-button:hover { transform: translateY(-1px); background: radial-gradient(circle at 32% 25%, rgba(255,211,160,.32), rgba(50,31,25,.98) 72%); }
  .header-ipfs-glyph { display: block; width: 42px; height: 42px; object-fit: contain; filter: drop-shadow(0 0 5px rgba(122,240,198,.62)); }
  .header-ipfs-label { display: none; }
  .header-ipfs-dot { position: absolute; right: 1px; bottom: 1px; width: 10px; height: 10px; border: 2px solid #11151c; border-radius: 50%; background: #9a9da5; }
  .header-ipfs-dot.ready { background: #40d6a0; box-shadow: 0 0 8px rgba(64,214,160,.9); }
  .header-ipfs-dot.error { background: #ff6e61; box-shadow: 0 0 7px rgba(255,110,97,.75); }
  .header-ipfs-status {
    max-width: 210px;
    padding: 7px 9px;
    color: #f2e8da;
    background: rgba(10,12,18,.94);
    border: 1px solid rgba(255,183,112,.3);
    border-radius: 5px;
    font-size: 11px;
    line-height: 1.35;
  }
  @media (max-width: 600px) {
    header {
      position: relative;
      inset: auto;
      width: 100%;
      height: 112px;
      margin: 0;
      overflow: visible;
      background: linear-gradient(180deg, rgba(9,12,17,.98), rgba(9,12,17,.78));
      box-shadow: 0 1px rgba(255,183,112,.19), 0 8px 24px rgba(0,0,0,.22);
    }
    app-title {
      display: block;
      width: 100%;
      height: 112px;
      min-width: 0;
    }
    .header-ipfs-control { top: 7px; left: 8px; }
    .header-ipfs-button {
      width: 42px;
      min-width: 42px;
      height: 42px;
      justify-content: center;
      padding: 0;
      border-radius: 50%;
    }
    .header-ipfs-glyph { width: 28px; height: 28px; }
    .header-ipfs-label { display: none; }
    .header-ipfs-status { position: absolute; top: 44px; left: 0; width: max-content; }
    .header-ipfs-control::after {
      position: absolute;
      top: 37px;
      left: 13px;
      width: 2px;
      height: 9px;
      content: '';
      background: linear-gradient(180deg, rgba(255,190,126,.8), rgba(255,144,76,.08));
      background-size: 100% 20px;
      animation: header-energy-flow 1.7s linear infinite;
      pointer-events: none;
    }
    wallet-connect {
      position: absolute;
      top: 6px;
      right: 8px;
      z-index: 1002;
      display: block;
      width: 42px;
      height: 42px;
    }
    wallet-connect::after {
      position: absolute;
      top: 41px;
      left: 28px;
      width: 2px;
      height: 7px;
      content: '';
      background: linear-gradient(180deg, rgba(255,190,126,.8), rgba(255,144,76,.08));
      background-size: 100% 18px;
      animation: header-energy-flow 1.9s linear infinite reverse;
      pointer-events: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .header-ipfs-button, .header-ipfs-control::after, wallet-connect::after { animation: none; }
    .header-energy-network .energy-link-pulse { display: none; }
  }
`;

const MOBILE_APP_TITLE_STYLE = `
  @media (max-width: 600px) {
    #header-center { width: 100%; height: 100%; }
    #app-title-wrapper {
      display: grid;
      grid-template-columns: 38px minmax(0, 1fr) 38px;
      grid-template-rows: 44px 42px 18px;
      align-items: start;
      justify-content: stretch;
      width: 100%;
      height: 112px;
      padding: 0 2px;
      box-sizing: border-box;
    }
    .ankh-left, .ankh-right {
      display: flex;
      width: 38px;
      min-width: 0;
      max-width: 38px;
      height: 40px;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
    }
    .ankh-left { grid-column: 1; grid-row: 2; }
    .ankh-right { grid-column: 3; grid-row: 2; }
    .ankh-right right-ankh { display: block; width: 38px; height: 38px; }
    .ankh-left .ankh-coin {
      width: 38px;
      height: 38px;
      line-height: 36px;
      margin: 0;
      font-size: 22px;
    }
    .ankh-wrapper > .sparkle { display: none; }
    .title-center {
      grid-column: 2;
      grid-row: 2 / 4;
      display: flex;
      width: 100%;
      min-width: 0;
      height: auto;
      padding: 0;
      align-items: center;
      justify-content: flex-start;
      overflow: hidden;
      box-sizing: border-box;
    }
    #app-title {
      display: flex;
      width: 100%;
      min-width: 0;
      margin: 0;
      align-items: center;
      justify-content: center;
      gap: 2px;
      font-size: 18px;
      line-height: 1;
      white-space: nowrap;
    }
    .title-symbol { display: inline; margin: 0 1px; font-size: 8px; line-height: 1; }
    .title-main { margin: 0; white-space: nowrap; }
    .peacock-icon { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; width: 44px; height: 44px; margin: 0 -8px; line-height: 1; }
    .dbusker-avatar { width: 44px; height: 44px; border: 1px solid rgba(255,213,165,.9); border-radius: 50%; object-fit: cover; box-shadow: 0 1px 7px rgba(255,132,54,.42); }
    #app-subtitle {
      grid-column: 2;
      grid-row: 3;
      max-width: 100%;
      margin-top: 0;
      overflow: hidden;
      font-size: 10px;
      line-height: 1.2;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }
`;

const BRAND_TITLE_STYLE = `
  #app-title { display: flex; align-items: center; justify-content: center; white-space: nowrap; pointer-events: none; }
  .title-symbol { color: #ffe8d1; font-size: 1.15rem; margin: 0 .32rem; opacity: .85; text-shadow: 0 1px 0 #a64b20, 0 2px 2px rgba(0,0,0,.75); pointer-events: none; }
  .title-main {
    position: relative;
    z-index: 3;
    margin: 0 -8px;
    color: #fff !important;
    background: linear-gradient(180deg, #fffdf7 0%, #ffe6c7 48%, #ff954f 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    text-shadow: 0 1px 0 rgba(132,62,28,.65), 0 2px 0 rgba(77,39,24,.55), 0 4px 8px rgba(0,0,0,.65);
    filter: drop-shadow(0 1px 2px rgba(255,137,61,.25));
    animation: title-energy-glow 5s ease-in-out infinite;
    pointer-events: none;
  }
  @keyframes title-energy-glow {
    0%, 100% { filter: drop-shadow(0 1px 2px rgba(255,137,61,.2)); }
    50% { filter: drop-shadow(0 2px 5px rgba(255,156,91,.48)); }
  }
  .peacock-icon { position: relative; z-index: 2; display: inline-flex; flex: 0 0 auto; width: 62px; height: 62px; margin: 0 -12px; align-items: center; justify-content: center; pointer-events: auto; }
  .peacock-icon img.dbusker-avatar { display: block; width: 62px; height: 62px; border: 2px solid #ffd1a6; border-radius: 50%; object-fit: cover; box-shadow: 0 2px 9px rgba(0,0,0,.65), 0 0 8px rgba(255,143,70,.38); animation: header-energy-pulse 4.2s ease-in-out infinite; }
  #app-subtitle { display: flex; align-items: center; justify-content: center; gap: .2em; white-space: nowrap; }
  .jam-icon { display: inline-block; flex: 0 0 auto; line-height: 1; transform-origin: 50% 80%; }
  .jam-mic { animation: jam-mic-bob 1.7s ease-in-out infinite; }
  .jam-mark { animation: jam-mark-spin 5s ease-in-out infinite; }
  .jam-venus { color: #ffc078; text-shadow: 0 0 6px rgba(255,151,86,.4); }
  .jam-guitar { animation: jam-guitar-strum 1.25s ease-in-out infinite; }
  .jam-speaker { animation: jam-speaker-pulse 1.4s ease-in-out infinite; }
  .jam-note-one { animation: jam-note-dance 1.6s ease-in-out infinite; }
  .jam-note-two { animation: jam-note-dance 1.8s ease-in-out -.55s infinite; }
  .jam-note-three { animation: jam-note-dance 1.5s ease-in-out -1s infinite; }
  @keyframes jam-mic-bob { 0%,100% { transform: translateY(0) rotate(-5deg); } 50% { transform: translateY(-3px) rotate(5deg); } }
  @keyframes jam-mark-spin { 0%,75%,100% { transform: rotate(0) scale(1); } 85% { transform: rotate(18deg) scale(1.12); } }
  @keyframes jam-guitar-strum { 0%,100% { transform: rotate(-7deg); } 50% { transform: rotate(8deg); } }
  @keyframes jam-speaker-pulse { 0%,100% { transform: scale(1); filter: drop-shadow(0 0 0 rgba(255,151,86,0)); } 50% { transform: scale(1.12); filter: drop-shadow(0 0 5px rgba(255,151,86,.75)); } }
  @keyframes jam-note-dance { 0%,100% { transform: translateY(1px) rotate(-8deg); } 50% { transform: translateY(-4px) rotate(9deg); } }
  @media (max-width: 600px) {
    .title-symbol { font-size: 8px; margin: 0 1px; }
    .peacock-icon { width: 44px; height: 44px; margin: 0 -8px; }
    .peacock-icon img.dbusker-avatar { width: 44px; height: 44px; border-width: 1px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .title-main, .peacock-icon img.dbusker-avatar, .jam-icon { animation: none; }
  }
`;

const MOBILE_WALLET_STYLE = `
  @media (max-width: 600px) {
    #walletHeaderContainer {
      position: relative;
      top: 0;
      right: 0;
      width: 42px;
      height: 42px !important;
      justify-content: center !important;
    }
    #walletIconWrapper { width: 42px; height: 42px; }
    #wallet-connect {
      position: relative;
      top: 0;
      right: 0;
      width: 42px;
      height: 42px;
    }
    #wallet-connect img { width: 34px; height: 34px; }
    .ticker-wrapper.wallet-ticker { display: none; }
  }
`;

const MOBILE_RIGHT_ANKH_STYLE = `
  @media (max-width: 600px) {
    .ankh-wrapper, .ankh-container, .ankh-coin {
      width: 38px;
      height: 38px;
      box-sizing: border-box;
    }
    .ankh-wrapper, .ankh-container { display: block; }
    .ankh-coin {
      margin: 0;
      padding: 0;
      font-size: 22px;
      line-height: 36px;
      animation: ankh-energy 4s ease-in-out infinite;
    }
    @keyframes ankh-energy {
      0%, 100% { box-shadow: 0 0 6px #00e5ff, 0 0 10px rgba(255,151,82,.16); }
      50% { box-shadow: 0 0 8px #ffbe83, 0 0 15px rgba(255,151,82,.42); }
    }
    .sparkle, .ankh-coin::before, .ankh-coin::after { display: none; }
    .dropdown-menu.right-ankh-menu {
      left: auto;
      right: 0;
      transform: none;
    }
  }
`;

function injectStyle(shadowRoot, id, textContent) {
  if (!shadowRoot || shadowRoot.querySelector(`#${id}`)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = textContent;
  shadowRoot.appendChild(style);
}

await Promise.all([
  import(`${DECENT_HEAD_BASE}js/components/Header/AppTitle.js`),
  import(`${DECENT_HEAD_BASE}js/components/Header/WalletConnect.js`),
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
      <style>${MOBILE_HEADER_SHELL_STYLE}</style>
      <div class="header-ipfs-control">
        <button class="header-ipfs-button" type="button" aria-label="Connect IPFS" title="Check IPFS connection">
          <img class="header-ipfs-glyph" src="${IPFS_LOGO_URL}" alt="" aria-hidden="true" />
          <span class="header-ipfs-label">IPFS</span>
          <span class="header-ipfs-dot" aria-hidden="true"></span>
        </button>
        <span class="header-ipfs-status" hidden>Checking IPFS…</span>
      </div>
      <header>
        <svg class="header-energy-network" aria-hidden="true" preserveAspectRatio="none"></svg>
        <app-title></app-title>
        <wallet-connect></wallet-connect>
      </header>
    `;
    const appTitle = this.shadowRoot.querySelector('app-title');
    injectStyle(appTitle?.shadowRoot, 'decentbusking-mobile-title', MOBILE_APP_TITLE_STYLE);
    injectStyle(appTitle?.shadowRoot, 'decentbusking-brand-title', BRAND_TITLE_STYLE);
    injectStyle(appTitle?.shadowRoot?.querySelector('right-ankh')?.shadowRoot, 'decentbusking-mobile-right-ankh', MOBILE_RIGHT_ANKH_STYLE);
    injectStyle(this.shadowRoot.querySelector('wallet-connect')?.shadowRoot, 'decentbusking-mobile-wallet', MOBILE_WALLET_STYLE);
    this._installBuskerAvatar(appTitle?.shadowRoot);
    this._installJamSubtitle(appTitle?.shadowRoot);
    this._installIpfsStatus();
    this._installEnergyNetwork(appTitle?.shadowRoot);
  }

  _installBuskerAvatar(shadowRoot) {
    const replaceAvatar = () => {
      const mark = shadowRoot?.querySelector('.peacock-icon');
      if (!mark || mark.querySelector('.dbusker-avatar')) return;
      const image = document.createElement('img');
      image.className = 'dbusker-avatar';
      image.src = DBUSKER_AVATAR_URL;
      image.alt = 'DBusker';
      mark.replaceChildren(image);
      mark.setAttribute('aria-label', 'About DBusker');
    };
    replaceAvatar();
    if (shadowRoot) {
      new MutationObserver(replaceAvatar).observe(shadowRoot, { childList: true, subtree: true });
    }
  }

  _installJamSubtitle(shadowRoot) {
    const subtitle = shadowRoot?.querySelector('#app-subtitle');
    if (!subtitle) return;
    subtitle.setAttribute('aria-label', window.DECENT_CONFIG?.subtitle || 'The Web3 Digital Town Square');
    subtitle.replaceChildren(...JAM_SUBTITLE_PARTS.map((part) => {
      if (!part.className) return document.createTextNode(part.text);
      const icon = document.createElement('span');
      icon.className = part.className;
      icon.textContent = part.text;
      icon.setAttribute('aria-hidden', 'true');
      return icon;
    }));
  }

  _installIpfsStatus() {
    const button = this.shadowRoot.querySelector('.header-ipfs-button');
    const dot = this.shadowRoot.querySelector('.header-ipfs-dot');
    const status = this.shadowRoot.querySelector('.header-ipfs-status');
    if (!button || !dot || !status) return;

    button.addEventListener('click', async () => {
      const config = window.DecentConfig || {};
      button.disabled = true;
      status.hidden = false;
      status.textContent = 'Checking IPFS connection…';
      dot.classList.remove('ready', 'error');
      try {
        let providerName = '';
        if (config.ipfsUploadProvider === 'local') {
          const base = (config.ipfsApiUrl || 'http://127.0.0.1:5001').replace(/\/$/, '');
          const response = await fetch(`${base}/api/v0/id`, { method: 'POST' });
          if (!response.ok) throw new Error(`Local Kubo returned HTTP ${response.status}`);
          providerName = 'Local Kubo';
        } else {
          if (!config.ipfsUploadServiceUrl) throw new Error('Render IPFS worker URL is not configured');
          const response = await fetch(`${config.ipfsUploadServiceUrl.replace(/\/$/, '')}/health`);
          const health = await response.json();
          if (!response.ok || !health.ok || health.ipfsProvider !== 'pinata') {
            throw new Error('Pinata upload worker is unavailable');
          }
          providerName = 'Pinata via DecentBusking worker';
        }
        dot.classList.add('ready');
        status.textContent = `${providerName} is online. Opening community pin options…`;
        window.dispatchEvent(new CustomEvent('ipfs-connection-changed', { detail: { connected: true, provider: providerName } }));
      } catch (error) {
        dot.classList.add('error');
        status.textContent = `IPFS unavailable: ${error.message}`;
        window.dispatchEvent(new CustomEvent('ipfs-connection-changed', { detail: { connected: false, error: error.message } }));
      } finally {
        button.disabled = false;
        window.dispatchEvent(new CustomEvent('open-community-pinning'));
      }
    });
  }

  _installEnergyNetwork(appTitleRoot) {
    const svg = this.shadowRoot.querySelector('.header-energy-network');
    const header = this.shadowRoot.querySelector('header');
    const ipfs = this.shadowRoot.querySelector('.header-ipfs-button');
    const wallet = this.shadowRoot.querySelector('wallet-connect')?.shadowRoot?.querySelector('#wallet-connect');
    const leftAnkh = appTitleRoot?.querySelector('.ankh-left .ankh-coin');
    const rightAnkh = appTitleRoot?.querySelector('.ankh-right right-ankh')?.shadowRoot?.querySelector('.ankh-coin');
    const words = appTitleRoot ? [...appTitleRoot.querySelectorAll('#app-title .title-main')] : [];
    const avatar = appTitleRoot?.querySelector('.dbusker-avatar');
    if (!svg || !header || !ipfs || !wallet || !leftAnkh || !rightAnkh || words.length < 2 || !avatar) return;

    const nodes = { ipfs, leftAnkh, leftWord: words[0], avatar, rightWord: words.at(-1), rightAnkh, wallet };
    const connections = [
      ['ipfs', 'leftAnkh', -5],
      ['leftAnkh', 'leftWord', -7],
      ['ipfs', 'avatar', -31],
      ['leftWord', 'avatar', 8],
      ['avatar', 'rightWord', -8],
      ['rightWord', 'rightAnkh', 7],
      ['rightAnkh', 'wallet', 5],
      ['wallet', 'avatar', -32],
      ['ipfs', 'rightAnkh', 29],
      ['wallet', 'leftAnkh', 31],
      ['ipfs', 'wallet', -52],
      ['ipfs', 'wallet', 42],
    ];
    const namespace = 'http://www.w3.org/2000/svg';
    const draw = () => {
      const bounds = header.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
      svg.replaceChildren();

      const point = (element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left - bounds.left + rect.width / 2, y: rect.top - bounds.top + rect.height / 2 };
      };
      const locations = Object.fromEntries(Object.entries(nodes).map(([name, element]) => [name, point(element)]));

      connections.forEach(([fromName, toName, bend], index) => {
        const from = locations[fromName];
        const to = locations[toName];
        const control = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 + bend };
        const pathData = `M ${from.x} ${from.y} Q ${control.x} ${control.y} ${to.x} ${to.y}`;

        const base = document.createElementNS(namespace, 'path');
        base.setAttribute('class', 'energy-link-base');
        base.setAttribute('d', pathData);
        svg.appendChild(base);

        const pulse = document.createElementNS(namespace, 'path');
        pulse.setAttribute('class', 'energy-link-pulse');
        pulse.setAttribute('d', pathData);
        if (index % 3 === 0) pulse.classList.add('energy-link-cool');
        const length = pulse.getTotalLength();
        pulse.style.strokeDasharray = `6 ${length}`;
        pulse.style.strokeDashoffset = String(length + 6);
        pulse.style.setProperty('--pulse-duration', `${2.8 + (index % 6) * .43}s`);
        pulse.style.setProperty('--pulse-delay', `${-index * .58}s`);
        svg.appendChild(pulse);
      });

      Object.values(locations).forEach((location) => {
        const node = document.createElementNS(namespace, 'circle');
        node.setAttribute('class', 'energy-node');
        node.setAttribute('cx', String(location.x));
        node.setAttribute('cy', String(location.y));
        node.setAttribute('r', '2.4');
        svg.appendChild(node);
      });
    };

    const observer = new ResizeObserver(draw);
    [header, ...Object.values(nodes)].forEach((element) => observer.observe(element));
    window.addEventListener('resize', draw);
    document.fonts?.ready?.then(draw);
    requestAnimationFrame(draw);
    setTimeout(draw, 250);
  }
}

customElements.define('decent-header', DecentBuskingHeader);
