// js/components/header-ipfs-inject.js — DecentBusking
//
// Injects a "🔗 Connect IPFS" link into AppTitle's left ankh dropdown
// (the ☥ icon on the left side of the shared header component).
//
// Uses the same prototype-patching pattern as header-payroll-inject.js so the
// injection survives any future re-renders of the AppTitle component.
//
// On click the button calls connectW3upClient() and sets window._w3upClient +
// window._w3upSpaceDid so that mint.js can upload files to IPFS without
// needing to import this module directly.
//
// On page load, tryAutoRestoreW3upClient() is called silently so that users
// who already logged in previously don't need to reconnect every visit.

import { connectW3upClient, tryAutoRestoreW3upClient } from '../w3upClient.js';

// Styles injected into the AppTitle shadow root.
const IPFS_LINK_STYLE = `
  .ipfs-nav-item {
    list-style: none;
    padding: 0.45rem 1rem;
    cursor: pointer;
    white-space: nowrap;
    color: #00d4aa;
    font-size: 0.9rem;
    transition: background 0.15s;
  }
  .ipfs-nav-item:hover {
    background: rgba(0, 212, 170, 0.12);
  }
  .ipfs-nav-item.connected {
    color: #7cffd4;
  }
`;

function patchAppTitle() {
  const cls = customElements.get('app-title');
  if (!cls) return;

  // Wrap render() so every future call also injects the IPFS link.
  // NOTE: header-payroll-inject.js may have already wrapped render(); we wrap
  // the already-wrapped version so the chain becomes:
  //   originalRender → injectPayroll → injectIPFS
  const originalRender = cls.prototype.render;
  cls.prototype.render = function () {
    originalRender.call(this);
    _injectIPFSLink(this.shadowRoot);
  };

  // Inject into any AppTitle instances already rendered in the DOM.
  _findAllAppTitles().forEach(el => _injectIPFSLink(el.shadowRoot));
}

function _injectIPFSLink(shadowRoot) {
  if (!shadowRoot) return;

  const leftMenu = shadowRoot.querySelector('.ankh-left .dropdown-menu');
  if (!leftMenu) return;

  // Don't inject twice.
  if (leftMenu.querySelector('[data-ipfs-item]')) return;

  // Inject scoped styles if not already present.
  if (!shadowRoot.querySelector('#ipfs-nav-style')) {
    const style = document.createElement('style');
    style.id = 'ipfs-nav-style';
    style.textContent = IPFS_LINK_STYLE;
    shadowRoot.appendChild(style);
  }

  const li = document.createElement('li');
  li.className = 'ipfs-nav-item';
  li.dataset.ipfsItem = '1';
  li.textContent = '🔗 Connect IPFS';

  // If a session was already restored before the header rendered, show it.
  if (window._w3upClient) {
    _markConnected(li);
  }

  li.addEventListener('click', async e => {
    e.stopPropagation();
    // Close the dropdown the same way the CDN component does.
    leftMenu.style.display = 'none';

    if (window._w3upClient) {
      const did = window._w3upSpaceDid || 'unknown';
      alert(`✅ IPFS already connected.\n\nSpace DID:\n${did}`);
      return;
    }

    li.textContent = '⏳ Connecting…';
    li.style.pointerEvents = 'none';

    const result = await connectW3upClient();

    if (result) {
      window._w3upClient = result.client;
      window._w3upSpaceDid = result.spaceDid;
      _markConnected(li);
    } else {
      li.textContent = '❌ Connect failed — retry';
      li.style.pointerEvents = '';
    }
  });

  leftMenu.appendChild(li);
}

// Truncation constants for displaying a DID in a compact button label.
const DID_DISPLAY_THRESHOLD = 20;
const DID_PREFIX_LENGTH = 10;
const DID_SUFFIX_LENGTH = 6;

function _markConnected(li) {
  const did = window._w3upSpaceDid || '';
  const short = did.length > DID_DISPLAY_THRESHOLD
    ? did.slice(0, DID_PREFIX_LENGTH) + '…' + did.slice(-DID_SUFFIX_LENGTH)
    : (did || 'Connected');
  li.textContent = `🦚 IPFS: ${short}`;
  li.classList.add('connected');
  li.style.pointerEvents = '';
}

// Shadow-DOM aware traversal — same helper pattern as header-payroll-inject.js.
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

// ── Auto-restore on page load ─────────────────────────────────────────────
// Runs immediately so window._w3upClient is set as early as possible.
// If the header hasn't rendered yet when this resolves, the button will
// be updated once it is injected (via the window._w3upClient check above).
async function _autoRestore() {
  const result = await tryAutoRestoreW3upClient();
  if (!result) return;

  window._w3upClient = result.client;
  window._w3upSpaceDid = result.spaceDid;
  console.log('[IPFS] Session auto-restored:', result.spaceDid);

  // Update any buttons that are already in the DOM.
  _findAllAppTitles().forEach(el => {
    const li = el.shadowRoot?.querySelector('[data-ipfs-item]');
    if (li) _markConnected(li);
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────
// Patch immediately if 'app-title' is already defined, otherwise wait.
if (customElements.get('app-title')) {
  patchAppTitle();
} else {
  customElements.whenDefined('app-title').then(patchAppTitle);
}

_autoRestore();
