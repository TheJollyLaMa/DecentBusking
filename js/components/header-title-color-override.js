// js/components/header-title-color-override.js — DecentBusking
//
// Injects DecentBusking's white-to-orange dimensional title treatment into
// the shared AppTitle shadow root.
//
// The Shadow DOM prevents host-page CSS from reaching .title-main, so the
// only reliable approach is to inject a scoped <style> element directly into
// the shadow root — the same technique used by header-admin-inject.js and
// header-payroll-inject.js.

const TITLE_COLOR_STYLE = `
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
  .peacock-icon img.dbusker-avatar {
    display: block;
    width: 62px;
    height: 62px;
    border: 2px solid #ffd1a6;
    border-radius: 50%;
    object-fit: cover;
    box-shadow: 0 2px 9px rgba(0,0,0,.65), 0 0 8px rgba(255,143,70,.38);
  }
  @media (max-width: 600px) {
    .title-symbol { font-size: 8px; margin: 0 1px; }
    .peacock-icon { width: 44px; height: 44px; margin: 0 -8px; }
    .peacock-icon img.dbusker-avatar { width: 44px; height: 44px; border-width: 1px; }
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
