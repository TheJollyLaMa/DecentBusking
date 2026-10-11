export function initDevertTab() {
  const panel = document.getElementById('devert-panel');
  const toggle = document.getElementById('devert-tab');
  if (!panel || !toggle) return;
  const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';
  const close = () => {
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open DVert advertising');
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    panel.inert = true;
    document.body.classList.remove('devert-open');
  };
  toggle.addEventListener('click', event => {
    event.stopPropagation();
    if (isOpen()) { close(); return; }
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Close DVert advertising');
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    panel.inert = false;
    document.body.classList.add('devert-open');
    document.dispatchEvent(new CustomEvent('left-drawer-open', { detail: 'devert' }));
  });
  document.getElementById('devert-close').addEventListener('click', () => { close(); toggle.focus(); });
  document.getElementById('devert-profile').addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('open-creator-profile'));
  });
  document.addEventListener('left-drawer-open', event => { if (event.detail !== 'devert' && isOpen()) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && isOpen()) { close(); toggle.focus(); } });
  document.addEventListener('click', event => { if (isOpen() && !panel.contains(event.target) && !toggle.contains(event.target)) close(); });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initDevertTab); else initDevertTab();
}