// js/main.js — DecentBusking boot loader
// Initialises the header, footer, stage interactions, and the 3-D space field.

import { initWallet } from './wallet.js';
import { initStage } from './stage.js';
import { initSpace } from './space.js';

// The shared header (decent-header) web component is loaded in index.html as a CDN module.
// The shared footer (decent-foot) web component is loaded below once the DOM is ready.

document.addEventListener('DOMContentLoaded', () => {
  // Initialise global MetaMask wallet state (auto-connect + event listeners)
  initWallet();

  // Load the shared footer web component (mirrors pattern used for decent-header)
  const footScript = document.createElement('script');
  footScript.type = 'module';
  footScript.src = 'https://cdn.jsdelivr.net/gh/TheJollyLaMa/DecentHead@main/js/components/Footer.js';
  footScript.onerror = () => {
    // Graceful degradation: render a minimal fallback footer
    const foot = document.querySelector('decent-foot');
    if (foot) {
      foot.innerHTML = buildFallbackFooter();
    }
  };
  document.body.appendChild(footScript);

  // Initialise the 3-D asteroid space field
  initSpace();

  // Initialise the hat / guitar-case stage interactions
  initStage();
});

// Fallback footer markup used when the CDN component fails to load.
function buildFallbackFooter() {
  const cfg = window.DecentConfig || {};
  const discord = cfg.discord || '#';
  const github = cfg.github || 'https://github.com/TheJollyLaMa/DecentBusking';
  return `
    <footer style="
      position:relative;z-index:100;
      background:rgba(3,1,10,0.9);
      border-top:1px solid rgba(240,192,64,0.15);
      padding:1rem 2rem;
      display:flex;gap:1.5rem;align-items:center;justify-content:center;
      font-size:0.85rem;color:#8a7a5a;">
      <a href="${discord}" target="_blank" rel="noopener" style="color:#f0c040;text-decoration:none;">💬 Discord</a>
      <a href="${github}" target="_blank" rel="noopener" style="color:#f0c040;text-decoration:none;">🐙 GitHub</a>
      <span style="color:#4a4a5a">· DecentBusking · 🎸</span>
    </footer>`;
}
