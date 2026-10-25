// js/main.js?v=20261025-seamless-handoff — DecentBusking boot loader
// Initialises the header, footer, stage interactions, and the 3-D space field.

import { initWallet } from './wallet.js';
import { initStage } from './stage.js?v=20261025-seamless-handoff';
import { initSpace } from './space.js?v=20261025-seamless-handoff';
import { initTutorial } from './tutorial.js?v=20261025-split-surfaces';

// The shared header (decent-header) web component is loaded in index.html as a CDN module.

document.addEventListener('DOMContentLoaded', () => {
  // Initialise global MetaMask wallet state (auto-connect + event listeners)
  initWallet();

  const discordLink = document.getElementById('footer-discord-link');
  if (discordLink) discordLink.href = window.DecentConfig?.discord || 'https://discord.gg/SCtcBggHPa';
  const footer = document.getElementById('radio-footer');
  if (footer && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      document.documentElement.style.setProperty('--radio-footer-height', `${Math.ceil(footer.getBoundingClientRect().height)}px`);
    }).observe(footer);
  }

  // Initialise the 3-D asteroid space field
  initSpace();

  // Initialise the hat / guitar-case stage interactions
  initStage();

  // Initialise the interactive onboarding tutorial
  initTutorial();
});
