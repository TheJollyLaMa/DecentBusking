// js/admin.js — DecentBusking
//
// Admin panel: lets the DEFAULT_ADMIN_ROLE holder grant MINTER_ROLE or
// DEFAULT_ADMIN_ROLE to a specified wallet address via the DecentNFT contract.
//
// The panel is opened by dispatching a custom "open-admin" DOM event (wired up
// from header-admin-inject.js).  It follows the same architecture as payroll.js.

import { fetchMintQueue } from './admin-mint-queue.js';
import { createBrowserIpfsUploader } from './ipfs-upload.js';
import { reportMintCompletion } from './mint-reconciliation.js';

const ROLE_GRANT_ABI = [
  'function DEFAULT_ADMIN_ROLE() view returns (bytes32)',
  'function MINTER_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function grantRole(bytes32 role, address account) external',
  'function registerToken(uint256 maxSupply_, string calldata tokenURI_, uint8 kind_, address royaltyReceiver, uint96 royaltyFeeBps) external returns (uint256 tokenId)',
  'function mintProduct(address to, uint256 tokenId, uint256 amount) external',
  'event TokenRegistered(uint256 indexed tokenId, address indexed creator, uint256 maxSupply, uint8 kind, string uri)',
];

// ── DOM references (resolved after DOMContentLoaded) ─────────────────────────
let _modal, _connectBtn, _connectedAddr, _roleSection,
  _targetAddr, _roleSelect, _statusEl, _grantBtn, _closeBtn,
  _mintSection, _mintQueueEl, _mintRefreshBtn, _mintSelectedBtn,
  _mintSelectAll, _mintStatusEl;
let _adminSigner = null;
let _adminAddress = null;
let _mintQueue = [];
let _mintBusy = false;

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
  _mintSection  = document.getElementById('admin-mint-section');
  _mintQueueEl  = document.getElementById('admin-mint-queue');
  _mintRefreshBtn = document.getElementById('admin-mint-refresh-btn');
  _mintSelectedBtn = document.getElementById('admin-mint-selected-btn');
  _mintSelectAll = document.getElementById('admin-mint-select-all');
  _mintStatusEl = document.getElementById('admin-mint-status');

  if (!_modal) return; // guard: panel HTML not present

  _connectBtn?.addEventListener('click', _connectWallet);
  _grantBtn?.addEventListener('click', _grantRole);
  _closeBtn?.addEventListener('click', _closeModal);
  _mintRefreshBtn?.addEventListener('click', _loadMintQueue);
  _mintSelectedBtn?.addEventListener('click', _mintSelected);
  _mintSelectAll?.addEventListener('change', () => {
    _mintQueueEl?.querySelectorAll('.admin-mint-check').forEach((checkbox) => {
      checkbox.checked = _mintSelectAll.checked;
    });
  });
  _mintQueueEl?.addEventListener('click', (event) => {
    const button = event.target.closest('.admin-mint-one');
    if (button) _processQueue([Number(button.dataset.index)]);
  });

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
    const network = await provider.getNetwork();
    const cfg = window.DecentConfig || {};

    if (Number(network.chainId) !== (cfg.chainId || 8453)) {
      _setStatus(`⚠️ Switch MetaMask to ${cfg.chainName || 'Base Mainnet'} before using admin tools.`, true);
      return;
    }

    if (_connectedAddr) _connectedAddr.textContent = address;

    // Check that connected wallet is DEFAULT_ADMIN_ROLE on the contract
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

    _adminSigner = signer;
    _adminAddress = address;
    _setStatus('✅ Wallet connected. You have DEFAULT_ADMIN_ROLE.');
    _mintSection?.classList.remove('hidden');
    _roleSection?.classList.remove('hidden');
    if (_connectBtn) _connectBtn.disabled = true;
    await _loadMintQueue();
  } catch (err) {
    _setStatus(`❌ ${err.message || 'Wallet connection failed'}`, true);
  }

  // ── NFT Mint Queue ───────────────────────────────────────────────────────────
  async function _loadMintQueue() {
    if (!_adminSigner || !_adminAddress || _mintBusy) return;
    _setMintStatus('Sign once to refresh the private mint queue.');
    try {
      const cfg = window.DecentConfig || {};
      _mintQueue = await fetchMintQueue({
        serviceUrl: cfg.ipfsUploadServiceUrl,
        signer: _adminSigner,
        address: _adminAddress,
        origin: window.location.origin,
      });
      _renderMintQueue();
      _setMintStatus(_mintQueue.length ? `${_mintQueue.length} pending request(s).` : 'The mint queue is empty.');
    } catch (err) {
      _setMintStatus(`❌ ${err.message}`, true);
    }
  }

  function _renderMintQueue() {
    if (!_mintQueueEl) return;
    if (_mintQueue.length === 0) {
      _mintQueueEl.innerHTML = '<div class="admin-mint-empty">No pending NFT requests.</div>';
      if (_mintSelectedBtn) _mintSelectedBtn.disabled = true;
      return;
    }
    _mintQueueEl.innerHTML = _mintQueue.map((track, index) => `
      <div class="admin-mint-request">
        <input class="admin-mint-check" type="checkbox" data-index="${index}" aria-label="Select ${_esc(track.title)}" />
        <div>
          ${track.artworkCid ? `<img class="admin-artwork-preview" src="${_esc(_gatewayUrl(track.artworkCid))}" alt="Artwork for ${_esc(track.title)}" />` : ''}
          <strong>${_esc(track.title)}</strong>
          <span>by ${_esc(track.uploader)} · ${_esc(track.requestedAt ? new Date(track.requestedAt).toLocaleString() : '')}</span>
          <span>${_esc(track.recipient)}</span>
          <label class="admin-artwork-label">${track.artworkCid ? 'Replace artwork' : 'Optional artwork'}
            <input class="admin-artwork" type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-index="${index}" />
          </label>
        </div>
        <button class="admin-btn admin-btn-secondary admin-mint-one" type="button" data-index="${index}">Mint</button>
      </div>
    `).join('');
    if (_mintSelectedBtn) _mintSelectedBtn.disabled = false;
  }

  function _mintSelected() {
    const selected = [...(_mintQueueEl?.querySelectorAll('.admin-mint-check:checked') || [])]
      .map((checkbox) => Number(checkbox.dataset.index));
    if (selected.length === 0) {
      _setMintStatus('Select at least one request.', true);
      return;
    }
    _processQueue(selected);
  }

  async function _processQueue(indices) {
    if (_mintBusy || !_adminSigner) return;
    _mintBusy = true;
    _setMintControlsDisabled(true);
    let completed = false;
    try {
      for (let position = 0; position < indices.length; position++) {
        const index = indices[position];
        const track = _mintQueue[index];
        if (!track) continue;
        _setMintStatus(`Processing ${position + 1}/${indices.length}: ${track.title}`);
        await _mintQueuedTrack(track, index);
      }
      completed = true;
    } catch (err) {
      _setMintStatus(`❌ Stopped: ${err.message}`, true);
    } finally {
      _mintBusy = false;
      _setMintControlsDisabled(false);
    }
    if (completed) {
      await _loadMintQueue();
      _setMintStatus(`✅ Minted and announced ${indices.length} track(s).`);
    }
  }

  async function _mintQueuedTrack(track, index) {
    const cfg = window.DecentConfig || {};
    const artwork = _mintQueueEl?.querySelector(`.admin-artwork[data-index="${index}"]`)?.files?.[0];
    const upload = createBrowserIpfsUploader({
      provider: cfg.ipfsUploadProvider || 'pinata',
      serviceUrl: cfg.ipfsUploadServiceUrl,
      ipfsApiUrl: cfg.ipfsApiUrl,
      signer: _adminSigner,
      address: _adminAddress,
      origin: window.location.origin,
    });

    let image = track.artworkCid ? `ipfs://${track.artworkCid}` : '';
    if (artwork) {
      _setMintStatus(`Uploading artwork for ${track.title}…`);
      image = await upload(artwork);
    }
    const metadata = {
      name: track.title,
      description: `Shared through DecentJukebox by ${track.uploader}`,
      animation_url: `ipfs://${track.ipfsCid}`,
      audioUrl: `ipfs://${track.ipfsCid}`,
      ...(image ? { image } : {}),
      artist: track.recipient,
      creator: track.recipient,
      tipWallet: track.recipient,
      registeredBy: _adminAddress,
      mintedAt: new Date().toISOString(),
    };
    const metadataFile = new File(
      [JSON.stringify(metadata, null, 2)],
      `${_slugify(track.title)}.json`,
      { type: 'application/json' },
    );
    _setMintStatus(`Uploading metadata for ${track.title}…`);
    const metadataUrl = await upload(metadataFile);

    const contract = new ethers.Contract(cfg.contractAddress, ROLE_GRANT_ABI, _adminSigner);
    _setMintStatus(`Registering ${track.title} — confirm transaction 1/2…`);
    const registration = await contract.registerToken(0, metadataUrl, 0, track.recipient, 500);
    const registrationReceipt = await registration.wait();
    let tokenId = null;
    for (const log of registrationReceipt.logs) {
      try {
        const event = contract.interface.parseLog(log);
        if (event?.name === 'TokenRegistered') {
          tokenId = event.args.tokenId.toString();
          break;
        }
      } catch (_) {}
    }
    if (tokenId === null) throw new Error(`Could not read the token ID for ${track.title}`);

    _setMintStatus(`Minting ${track.title} as token #${tokenId} — confirm transaction 2/2…`);
    const mint = await contract.mintProduct(track.recipient, tokenId, 1);
    const mintReceipt = await mint.wait();
    const txHash = mintReceipt.hash || mint.hash;
    try {
      await reportMintCompletion({
        serviceUrl: cfg.ipfsUploadServiceUrl,
        trackId: track.trackId,
        tokenId,
        txHash,
      });
    } catch (err) {
      throw new Error(
        `Token #${tokenId} minted, but Discord sync failed. Use /jukeloop mark-minted with ` +
        `track ${track.trackId}, token ${tokenId}, and tx ${txHash}. ${err.message}`,
      );
    }
  }

  function _setMintControlsDisabled(disabled) {
    if (_mintRefreshBtn) _mintRefreshBtn.disabled = disabled;
    if (_mintSelectedBtn) _mintSelectedBtn.disabled = disabled;
    _mintQueueEl?.querySelectorAll('button, input').forEach((control) => { control.disabled = disabled; });
  }

  function _setMintStatus(message, isError = false) {
    if (!_mintStatusEl) return;
    _mintStatusEl.textContent = message;
    _mintStatusEl.classList.toggle('error', isError);
  }

  function _slugify(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'track';
  }

  function _gatewayUrl(cid) {
    const gateway = (window.DecentConfig?.ipfsGateway || 'https://dweb.link/ipfs/').replace(/\/$/, '');
    return `${gateway}${gateway.endsWith('/ipfs') ? '' : '/ipfs'}/${cid}`;
  }

  function _esc(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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
