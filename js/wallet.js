// js/wallet.js — DecentBusking
//
// Single global wallet state, shared across all modules.
// All MetaMask interaction is centralised here; other modules read
// window._wallet.signer / window._wallet.address instead of calling
// eth_requestAccounts themselves.
//
// Usage:
//   import { initWallet, connectWallet } from './wallet.js';
//   initWallet();  // called once from main.js on DOMContentLoaded
//
// Modules that need the signer:
//   const signer = window._wallet?.signer;
//   if (!signer) { /* prompt user to connect via header */ }
//
// Listen for wallet changes:
//   document.addEventListener('wallet-connected',    e => console.log(e.detail.address));
//   document.addEventListener('wallet-disconnected', () => { … });

// ─── Global wallet state object ───────────────────────────────────────────────

window._wallet = {
  address:  null,   // checksummed address of the connected account (or null)
  signer:   null,   // ethers.Signer  (or null when disconnected)
  provider: null,   // ethers.BrowserProvider (or null)
  chainId:  null,   // chain ID as a Number (or null)
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _dispatch(eventName) {
  document.dispatchEvent(new CustomEvent(eventName, {
    bubbles: true,
    detail: {
      address:  window._wallet.address,
      chainId:  window._wallet.chainId,
    },
  }));
}

async function _applyAccounts(accounts) {
  if (!accounts || accounts.length === 0) {
    window._wallet.address  = null;
    window._wallet.signer   = null;
    window._wallet.provider = null;
    window._wallet.chainId  = null;
    _dispatch('wallet-disconnected');
    return;
  }

  try {
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer   = await provider.getSigner();
    const network  = await provider.getNetwork();

    window._wallet.address  = accounts[0];
    window._wallet.signer   = signer;
    window._wallet.provider = provider;
    window._wallet.chainId  = Number(network.chainId);

    _dispatch('wallet-connected');
  } catch (err) {
    console.warn('[wallet] failed to build provider/signer:', err.message);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Request the user to connect MetaMask (triggers the popup).
 * Called by the "🦊 Connect Wallet" button in the right-ankh dropdown.
 */
export async function connectWallet() {
  if (!window.ethereum) {
    console.warn('[wallet] MetaMask not available');
    return;
  }
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    await _applyAccounts(accounts);
  } catch (err) {
    console.warn('[wallet] connect cancelled or failed:', err.message);
  }
}

/**
 * Initialise the global wallet module.
 * - Attaches MetaMask accountsChanged / chainChanged listeners.
 * - Auto-connects silently if the site is already authorised.
 * - Exposes window._wallet.connect for callers without a module import.
 *
 * Call once from main.js inside DOMContentLoaded.
 */
export function initWallet() {
  // Expose connect() on the global object so shadow-DOM components can call it
  // without needing a direct module import.
  window._wallet.connect = connectWallet;

  if (!window.ethereum) {
    console.info('[wallet] MetaMask not detected — wallet features disabled.');
    return;
  }

  // React to the user switching accounts in MetaMask.
  window.ethereum.on('accountsChanged', async (accounts) => {
    await _applyAccounts(accounts);
  });

  // React to chain/network changes.
  window.ethereum.on('chainChanged', async () => {
    // Re-fetch accounts to rebuild provider state after a chain switch.
    try {
      const accounts = await window.ethereum.request({ method: 'eth_accounts' });
      await _applyAccounts(accounts);
    } catch (_) {}
  });

  // Auto-connect silently if already authorised (no browser popup).
  window.ethereum.request({ method: 'eth_accounts' })
    .then(accounts => {
      if (accounts && accounts.length > 0) {
        _applyAccounts(accounts);
      }
    })
    .catch(() => {});
}
