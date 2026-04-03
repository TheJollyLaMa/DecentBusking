// js/components/header-admin-inject.js — DecentBusking
//
// Injects a "🔑 Admin" link into the AppTitle left-ankh dropdown alongside the
// existing Payroll link.  Follows the same prototype-patching pattern used by
// header-payroll-inject.js.

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
  .admin-nav-item:hover {
    background: rgba(160, 224, 255, 0.12);
  }
`;

function patchAppTitle() {
  const cls = customElements.get('app-title');
  if (!cls) return;

  // Wrap render() so every future call also injects the Admin link.
  const originalRender = cls.prototype.render;
  cls.prototype.render = function () {
    originalRender.call(this);
    _injectAdminLink(this.shadowRoot);
  };

  _findAllAppTitles().forEach(el => _injectAdminLink(el.shadowRoot));
}

function _injectAdminLink(shadowRoot) {
  if (!shadowRoot) return;

  const leftMenu = shadowRoot.querySelector('.ankh-left .dropdown-menu');
  if (!leftMenu) return;

  // Don't inject twice.
  if (leftMenu.querySelector('[data-admin-item]')) return;

  // Inject scoped styles if not already present.
  if (!shadowRoot.querySelector('#admin-nav-style')) {
    const style = document.createElement('style');
    style.id = 'admin-nav-style';
    style.textContent = ADMIN_LINK_STYLE;
    shadowRoot.appendChild(style);
  }

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
