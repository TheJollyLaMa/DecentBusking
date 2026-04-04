// js/components/header-title-color-override.js — DecentBusking
//
// Injects a <style> rule into the AppTitle shadow root so that the
// .title-main spans are rendered in the DecentBusking brand orange (#ff8c00)
// rather than the default purple used in the shared DecentHead component.
//
// The Shadow DOM prevents host-page CSS from reaching .title-main, so the
// only reliable approach is to inject a scoped <style> element directly into
// the shadow root — the same technique used by header-admin-inject.js and
// header-payroll-inject.js.

const BUSKING_ORANGE = '#ff8c00';
const CYAN_GLOW      = '#00ffff';

const TITLE_COLOR_STYLE = `
  .title-main {
    color: ${BUSKING_ORANGE} !important;
    text-shadow: 0 0 10px rgba(255, 140, 0, 0.6), 0 0 3px ${CYAN_GLOW};
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
