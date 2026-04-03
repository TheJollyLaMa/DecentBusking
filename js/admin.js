// js/admin.js — DecentBusking
//
// Admin panel: lets the DEFAULT_ADMIN_ROLE holder grant MINTER_ROLE or
// DEFAULT_ADMIN_ROLE to a specified wallet address via the DecentNFT contract.
//
// The panel is opened by dispatching a custom "open-admin" DOM event (wired up
// from header-admin-inject.js).  It follows the same architecture as payroll.js.

const ROLE_GRANT_ABI = [
  'function DEFAULT_ADMIN_ROLE() view returns (bytes32)',
  'function MINTER_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function grantRole(bytes32 role, address account) external',
];

// ── DOM references (resolved after DOMContentLoaded) ─────────────────────────
let _modal, _connectBtn, _connectedAddr, _roleSection,
    _targetAddr, _roleSelect, _statusEl, _grantBtn, _closeBtn;

// ── Bootstrap ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  _modal        = document.getElementById('admin-modal');
  _connectBtn   = document.getElementById('admin-connect-btn');
  _connectedAddr = document.getElementById('admin-connected-addr');
  _roleSection  = document.getElementById('admin-role-section');
  _targetAddr   = document.getElementById('admin-target-addr');
  _roleSelect   = document.getElementById('admin-role-select');
  _statusEl     = document.getElementById('admin-status');
  _grantBtn     = document.getElementById('admin-grant-btn');
  _closeBtn     = document.getElementById('admin-close-btn');

  if (!_modal) return; // guard: panel HTML not present

  _connectBtn?.addEventListener('click', _connectWallet);
  _grantBtn?.addEventListener('click', _grantRole);
  _closeBtn?.addEventListener('click', _closeModal);

  // Close on backdrop click
  _modal.addEventListener('click', e => {
    if (e.target === _modal) _closeModal();
  });

  // Listen for the open event dispatched by the header inject script
  document.addEventListener('open-admin', _openModal);
});

// ── Open / Close ──────────────────────────────────────────────────────────────
function _openModal() {
  _modal?.classList.remove('hidden');
}

function _closeModal() {
  _modal?.classList.add('hidden');
  _setStatus('');
}

// ── Connect Wallet ────────────────────────────────────────────────────────────
async function _connectWallet() {
  if (!window.ethereum) {
    _setStatus('🦊 MetaMask not detected. Install it to continue.', true);
    return;
  }

  try {
    const provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send('eth_requestAccounts', []);
    const signer  = await provider.getSigner();
    const address = await signer.getAddress();

    if (_connectedAddr) _connectedAddr.textContent = address;

    // Check that connected wallet is DEFAULT_ADMIN_ROLE on the contract
    const cfg      = window.DecentConfig || {};
    const contract = new ethers.Contract(cfg.contractAddress, ROLE_GRANT_ABI, signer);
    const adminRole = await contract.DEFAULT_ADMIN_ROLE();
    const isAdmin   = await contract.hasRole(adminRole, address);

    if (!isAdmin) {
      _setStatus(
        '⛔ Your wallet does not hold DEFAULT_ADMIN_ROLE on this contract and cannot grant roles.',
        true,
      );
      return;
    }

    _setStatus('✅ Wallet connected. You have DEFAULT_ADMIN_ROLE.');
    _roleSection?.classList.remove('hidden');
    if (_connectBtn) _connectBtn.disabled = true;
  } catch (err) {
    _setStatus(`❌ ${err.message || 'Wallet connection failed'}`, true);
  }
}

// ── Grant Role ────────────────────────────────────────────────────────────────
async function _grantRole() {
  const target = _targetAddr?.value.trim();
  if (!target || !/^0x[0-9a-fA-F]{40}$/.test(target)) {
    _setStatus('⚠️ Enter a valid Ethereum address (0x…).', true);
    return;
  }

  const roleKey = _roleSelect?.value; // "minter" | "admin"

  try {
    const cfg      = window.DecentConfig || {};
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer   = await provider.getSigner();
    const contract = new ethers.Contract(cfg.contractAddress, ROLE_GRANT_ABI, signer);

    const roleBytes = roleKey === 'admin'
      ? await contract.DEFAULT_ADMIN_ROLE()
      : await contract.MINTER_ROLE();

    const roleName = roleKey === 'admin' ? 'DEFAULT_ADMIN_ROLE' : 'MINTER_ROLE';

    // Check if the target already holds the role (saves gas)
    const already = await contract.hasRole(roleBytes, target);
    if (already) {
      _setStatus(`ℹ️ ${target} already holds ${roleName}.`);
      return;
    }

    _setStatus(`⏳ Granting ${roleName} to ${target} — confirm in MetaMask…`);
    if (_grantBtn) _grantBtn.disabled = true;

    const tx = await contract.grantRole(roleBytes, target);
    _setStatus(`⏳ Waiting for confirmation…`);
    await tx.wait();

    _setStatus(`✅ ${roleName} granted to ${target}.`);
    if (_targetAddr) _targetAddr.value = '';
  } catch (err) {
    _setStatus(`❌ ${err.message || 'Grant role failed'}`, true);
  } finally {
    if (_grantBtn) _grantBtn.disabled = false;
  }
}

// ── Status helper ─────────────────────────────────────────────────────────────
function _setStatus(msg, isError = false) {
  if (!_statusEl) return;
  _statusEl.textContent = msg;
  _statusEl.classList.toggle('error', isError);
}
