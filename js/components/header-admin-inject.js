// js/components/header-admin-inject.js — DecentBusking
//
// Injects a "🔑 Admin" link into the AppTitle left-ankh dropdown and a small
// pending-mint badge on the left ankh for the owner wallet.

const ADMIN_LINK_STYLE = `
  .admin-nav-item {
    list-style: none;
    padding: 0.45rem 1rem;
    cursor: pointer;
    white-space: nowrap;
    color: #a0e0ff;
    font-size: 0.9rem;
    transition: background 0.15s;
  }
  .admin-nav-item:hover { background: rgba(160, 224, 255, 0.12); }
  .ankh-left { position: relative; }
  .admin-mint-count-badge {
    position: absolute;
    top: -5px;
    right: -5px;
    z-index: 2;
    min-width: 1.15rem;
    height: 1.15rem;
    padding: 0 0.22rem;
    border-radius: 999px;
    color: #fff8ef;
    background: linear-gradient(180deg, rgba(255, 145, 82, .96), rgba(148, 45, 24, .96));
    box-shadow: 0 0 0 1px rgba(255, 213, 176, .22), 0 0 10px rgba(255, 145, 82, .42);
    text-align: center;
    font: 700 0.66rem / 1.15rem system-ui, sans-serif;
    pointer-events: none;
  }
  .admin-mint-count-badge.is-pending { animation: admin-mint-count-pulse 4.2s ease-in-out infinite; }
  @keyframes admin-mint-count-pulse {
    0%, 100% { transform: scale(1); box-shadow: 0 0 0 1px rgba(255, 213, 176, .22), 0 0 10px rgba(255, 145, 82, .38); }
    50% { transform: scale(1.07); box-shadow: 0 0 0 1px rgba(255, 237, 216, .34), 0 0 14px rgba(255, 145, 82, .7); }
  }
  @media (prefers-reduced-motion: reduce) {
    .admin-mint-count-badge.is-pending { animation: none; }
  }
`;

let _badgePollTimer = 0;
let _badgeRoot = null;
let _badge = null;
let _currentCount = 0;

function patchAppTitle() {
  const cls = customElements.get('app-title');
  if (!cls) return;

  const originalRender = cls.prototype.render;
  cls.prototype.render = function () {
    originalRender.call(this);
    _injectAdminLink(this.shadowRoot);
    _ensureMintBadge(this.shadowRoot);
  };

  _findAllAppTitles().forEach(el => {
    _injectAdminLink(el.shadowRoot);
    _ensureMintBadge(el.shadowRoot);
  });
}

function _injectAdminLink(shadowRoot) {
  if (!shadowRoot) return;
  const leftMenu = shadowRoot.querySelector('.ankh-left .dropdown-menu');
  if (!leftMenu) return;
  if (leftMenu.querySelector('[data-admin-item]')) return;

  _injectStyle(shadowRoot);

  const li = document.createElement('li');
  li.className = 'admin-nav-item';
  li.dataset.adminItem = '1';
  li.textContent = '🔑 Admin';

  li.addEventListener('click', e => {
    e.stopPropagation();
    leftMenu.style.display = 'none';
    document.dispatchEvent(new CustomEvent('open-admin'));
  });

  leftMenu.appendChild(li);
}

function _injectStyle(shadowRoot) {
  if (!shadowRoot || shadowRoot.querySelector('#admin-nav-style')) return;
  const style = document.createElement('style');
  style.id = 'admin-nav-style';
  style.textContent = ADMIN_LINK_STYLE;
  shadowRoot.appendChild(style);
}

function _ensureMintBadge(shadowRoot) {
  if (!shadowRoot) return;
  _badgeRoot = shadowRoot;
  _injectStyle(shadowRoot);
  const leftAnkh = shadowRoot.querySelector('.ankh-left');
  if (!leftAnkh) return;
  if (!_badge) {
    _badge = document.createElement('span');
    _badge.className = 'admin-mint-count-badge';
    _badge.hidden = true;
    _badge.setAttribute('aria-hidden', 'true');
    leftAnkh.appendChild(_badge);
  } else if (_badge.parentElement !== leftAnkh) {
    leftAnkh.appendChild(_badge);
  }
  _applyCount(_currentCount);
}

function _applyCount(count) {
  _currentCount = Number.isSafeInteger(count) && count > 0 ? count : 0;
  if (!_badge) return;
  _badge.textContent = _currentCount > 0 ? String(_currentCount) : '';
  _badge.hidden = _currentCount <= 0;
  _badge.classList.toggle('is-pending', _currentCount > 0);
}

async function _refreshPendingCount() {
  const config = window.DecentConfig || {};
  const owner = (config.adminWalletAddress || config.mintOwnerWallet || '').toLowerCase();
  const connected = (window._wallet?.address || '').toLowerCase();
  if (!owner || connected !== owner || !config.ipfsUploadServiceUrl) {
    _applyCount(0);
    document.dispatchEvent(new CustomEvent('mint-queue-count-updated', { detail: { count: 0 } }));
    return;
  }
  try {
    const response = await fetch(`${config.ipfsUploadServiceUrl.replace(/\/$/, '')}/api/mint-queue/pending-count`, { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !Number.isSafeInteger(payload.count)) throw new Error(payload.error || 'Pending mint count unavailable');
    _applyCount(payload.count);
    document.dispatchEvent(new CustomEvent('mint-queue-count-updated', { detail: { count: payload.count } }));
  } catch (error) {
    console.warn('[mint-queue-badge]', error.message);
  }
}

function _syncPolling() {
  clearInterval(_badgePollTimer);
  _badgePollTimer = 0;
  if (!window._wallet?.address) {
    _applyCount(0);
    return;
  }
  void _refreshPendingCount();
  const owner = (window.DecentConfig?.adminWalletAddress || window.DecentConfig?.mintOwnerWallet || '').toLowerCase();
  if ((window._wallet.address || '').toLowerCase() === owner && window.DecentConfig?.ipfsUploadServiceUrl) {
    _badgePollTimer = window.setInterval(() => { void _refreshPendingCount(); }, 5 * 60 * 1000);
  } else {
    _applyCount(0);
  }
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

document.addEventListener('wallet-connected', _syncPolling);
document.addEventListener('wallet-disconnected', _syncPolling);
document.addEventListener('mint-queue-count-updated', event => {
  if (_badgeRoot) _ensureMintBadge(_badgeRoot);
  _applyCount(event.detail?.count);
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => _syncPolling(), { once: true });
} else {
  _syncPolling();
}
