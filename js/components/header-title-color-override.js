// js/components/header-title-color-override.js — DecentBusking
//
// Injects DecentBusking's warm neon title and electric end symbols into
// the shared AppTitle shadow root.
//
// The Shadow DOM prevents host-page CSS from reaching .title-main, so the
// only reliable approach is to inject a scoped <style> element directly into
// the shadow root — the same technique used by header-admin-inject.js and
// header-payroll-inject.js.

const TITLE_COLOR_STYLE = `
  #app-title .title-main {
    position: relative;
    z-index: 3;
    margin: 0 -8px;
    color: #fff1d9 !important;
    background: none;
    -webkit-text-fill-color: currentColor;
    text-shadow: 0 0 2px #fffaf0, 0 0 5px #ffe2b5, 0 0 11px #ffb86c, 0 0 22px #ff8b38, 0 0 36px #fa681d88;
    filter: none;
    animation: busking-neon-flicker 30s linear infinite;
    pointer-events: none;
  }
  .title-symbol {
    color: #ffe8d1 !important;
    font-size: 1.15rem;
    margin: 0 .32rem;
    opacity: .85;
    text-shadow: 0 1px 0 #a64b20, 0 2px 2px rgba(0,0,0,.75);
    pointer-events: none;
  }
  .title-symbol .neon-contact {
    display: inline-block;
    color: #986548;
    text-shadow: 0 0 2px #ffae6c44;
    animation: busking-contact-current 3.8s linear infinite;
    animation-delay: var(--contact-delay);
  }
  @keyframes busking-contact-current {
    0%, 65%, 100% { color: #986548; text-shadow: 0 0 2px #ffae6c44; }
    74%, 82% { color: #fff8e8; text-shadow: 0 0 3px #fff, 0 0 8px #ffbd7b, 0 0 16px #ff8438; transform: translateY(-1px); }
  }
  @keyframes busking-neon-flicker {
    0%, 91%, 91.3%, 92%, 92.4%, 94%, 94.5%, 100% { opacity: 1; }
    91.1%, 91.2%, 92.1%, 92.3%, 94.1%, 94.4% { opacity: .4; }
  }
  @media (prefers-reduced-motion: reduce) {
    #app-title .title-main, .title-symbol .neon-contact { animation: none; }
    .title-symbol .neon-contact { color: #ffe8d1; }
  }
  .peacock-icon {
    position: relative;
    z-index: 2;
    display: inline-flex;
    flex: 0 0 auto;
    width: 62px;
    height: 62px;
    margin: 0 -12px;
    align-items: center;
    justify-content: center;
    pointer-events: auto;
  }
  #app-subtitle {
    position: relative;
    z-index: 4;
    pointer-events: none;
  }
  #app-title .peacock-icon img.dbusker-avatar {
    position: absolute;
    top: calc(50% + 9px);
    left: 50%;
    transform: translate(-50%, -50%);
    box-sizing: border-box;
    display: block;
    width: 100px;
    height: 100px;
    border: 2px solid #ffd1a6;
    border-radius: 50%;
    object-fit: cover;
    box-shadow: 0 2px 9px rgba(0,0,0,.65), 0 0 8px rgba(255,143,70,.38);
  }
  @media (max-width: 600px) {
    #app-title-wrapper .title-center { overflow: visible; }
    .title-symbol { font-size: 8px; margin: 0 1px; }
    .peacock-icon { width: 44px; height: 44px; margin: 0 -8px; }
    #app-title .peacock-icon img.dbusker-avatar { width: 112px; height: 112px; top: calc(50% - 10px); border-width: 1px; }
  }
`;

function patchAppTitle() {
  const cls = customElements.get('app-title');
  if (!cls) return;

  // Wrap render() so the style is re-injected after every future re-render.
  const originalRender = cls.prototype.render;
  cls.prototype.render = function () {
    originalRender.call(this);
    _injectTitleColor(this.shadowRoot);
  };

  // Apply to any app-title instances already in the DOM.
  _findAllAppTitles().forEach(el => _injectTitleColor(el.shadowRoot));
}

function _injectTitleColor(shadowRoot) {
  if (!shadowRoot) return;
  if (shadowRoot.querySelector('#busking-title-color')) return;

  const style = document.createElement('style');
  style.id = 'busking-title-color';
  style.textContent = TITLE_COLOR_STYLE;
  shadowRoot.appendChild(style);
  shadowRoot.querySelectorAll('.title-symbol').forEach((symbol, side) => {
    symbol.setAttribute('aria-hidden', 'true');
    const characters = [...symbol.textContent];
    symbol.replaceChildren(...characters.map((character, index) => {
      const contact = document.createElement('span');
      contact.className = 'neon-contact';
      contact.textContent = character;
      contact.style.setProperty('--contact-delay', `${(side ? characters.length - 1 - index : index) * .12}s`);
      return contact;
    }));
  });
}

function _findAllAppTitles() {
  const found = [];
  function walk(root) {
    root.querySelectorAll('app-title').forEach(el => found.push(el));
    root.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) walk(el.shadowRoot);
    });
  }
  walk(document);
  return found;
}

if (customElements.get('app-title')) {
  patchAppTitle();
} else {
  customElements.whenDefined('app-title').then(patchAppTitle);
}
