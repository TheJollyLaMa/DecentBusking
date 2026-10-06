// js/components/header-payroll-inject.js — DecentBusking
//
// Injects a "💸 Payroll" link into AppTitle's left ankh dropdown
// (the ☥ icon on the left side of the shared header component).
//
// Uses the same prototype-patching pattern as about-override.js so the
// injection survives any future re-renders of the AppTitle component.
// The button dispatches a custom "open-payroll" DOM event that payroll.js
// listens for — keeping the shadow-DOM boundary fully decoupled.

// Styles injected into the AppTitle shadow root. Inline styles are avoided
// in favour of a scoped <style> element so rules stay maintainable and
// consistent with the app's CSS custom properties.
import { isAdminWallet } from '../admin-access.mjs';

const PAYROLL_LINK_STYLE = `
  .payroll-nav-item {
    list-style: none;
    padding: 0.45rem 1rem;
    cursor: pointer;
    white-space: nowrap;
    color: #f0c040;
    font-size: 0.9rem;
    transition: background 0.15s;
  }
  .payroll-nav-item:hover {
    background: rgba(240, 192, 64, 0.12);
  }
  .payroll-nav-item[hidden] { display: none; }
`;

function patchAppTitle() {
  const cls = customElements.get('app-title');
  if (!cls) return;

  // Wrap render() so every future call also injects the Payroll link.
  const originalRender = cls.prototype.render;
  cls.prototype.render = function () {
    originalRender.call(this);
    _injectPayrollLink(this.shadowRoot);
  };

  // Inject into any AppTitle instances already rendered in the DOM.
  _findAllAppTitles().forEach(el => _injectPayrollLink(el.shadowRoot));
}

function _injectPayrollLink(shadowRoot) {
  if (!shadowRoot) return;

  const leftMenu = shadowRoot.querySelector('.ankh-left .dropdown-menu');
  if (!leftMenu) return;

  // Don't inject twice.
  if (leftMenu.querySelector('[data-payroll-item]')) return;

  // Inject scoped styles if not already present.
  if (!shadowRoot.querySelector('#payroll-nav-style')) {
    const style = document.createElement('style');
    style.id = 'payroll-nav-style';
    style.textContent = PAYROLL_LINK_STYLE;
    shadowRoot.appendChild(style);
  }

  // The CDN AppTitle's left dropdown currently contains only placeholder
  // items ("Option1", "Option 2"). We replace those with real navigation
  // links so the dropdown has meaningful content. If the CDN component
  // is later updated to include real items, this section should be revised
  // to append instead of replace.
  leftMenu.innerHTML = '';

  const historyItem = document.createElement('li');
  historyItem.className = 'payroll-nav-item';
  historyItem.dataset.playHistoryTotalsItem = '1';
  historyItem.textContent = 'Playback Tally';
  historyItem.addEventListener('click', (event) => {
    event.stopPropagation();
    leftMenu.style.display = 'none';
    document.dispatchEvent(new CustomEvent('open-radio-history', { detail: { mode: 'totals' } }));
  });
  leftMenu.appendChild(historyItem);
  for (const [label, eventName, datasetKey] of [
    ['Admin Nft Mint', 'open-admin', 'adminItem'], ['Payroll', 'open-payroll', 'payrollItem'],
  ]) {
    const item = document.createElement('li');
    item.className = 'payroll-nav-item';
    item.dataset[datasetKey] = '1';
    item.dataset.adminOnly = '1';
    item.textContent = label;
    item.hidden = !isAdminWallet();
    item.addEventListener('click', event => {
      event.stopPropagation();
      if (!isAdminWallet()) return;
      leftMenu.style.display = 'none';
      document.dispatchEvent(new CustomEvent(eventName));
    });
    leftMenu.appendChild(item);
  }
}

// Shadow-DOM aware traversal — same helper pattern as about-override.js.
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

// Bootstrap — patch immediately if already defined, otherwise wait.
if (customElements.get('app-title')) {
  patchAppTitle();
} else {
  customElements.whenDefined('app-title').then(patchAppTitle);
}

function updateAdminItems() {
  for (const title of _findAllAppTitles()) {
    title.shadowRoot?.querySelectorAll('[data-admin-only]').forEach(item => { item.hidden = !isAdminWallet(); });
  }
}
document.addEventListener('wallet-connected', updateAdminItems);
document.addEventListener('wallet-disconnected', updateAdminItems);
