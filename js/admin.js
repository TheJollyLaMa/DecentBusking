// js/admin.js — DecentBusking
//
// Admin panel: lets the DEFAULT_ADMIN_ROLE holder grant MINTER_ROLE or
// DEFAULT_ADMIN_ROLE to a specified wallet address via the DecentNFT contract.
//
// The panel is opened by dispatching a custom "open-admin" DOM event (wired up
// from header-admin-inject.js).  It follows the same architecture as payroll.js.

import { fetchMintQueue, clearMintQueueAuthorization, resolveMintArtwork, mintPreparedProductsBatch, PRODUCT_BATCH_ABI } from './admin-mint-queue.js?v=20261010-batch';
import { createBrowserIpfsUploader } from './ipfs-upload.js?v=20261005-upload-size-fix';
import { reportMintCompletion } from './mint-reconciliation.js';
import { addNFTToSpace } from './space.js?v=20261010-listens';
import { isAdminWallet } from './admin-access.mjs';
import { buildRadioScheduleAuthorizationMessage, newYorkInputToUtc, utcToNewYorkInput } from './radio-schedule-ui.mjs?v=20261010-public-calendar';
import { defaultRadioSchedule, upsertLivePerformanceEvent, validateWeeklyScheduleOverrides } from './radio-schedule.mjs';

const ROLE_GRANT_ABI = [
  'function DEFAULT_ADMIN_ROLE() view returns (bytes32)',
  'function MINTER_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function grantRole(bytes32 role, address account) external',
  'function registerToken(uint256 maxSupply_, string calldata tokenURI_, uint8 kind_, address royaltyReceiver, uint96 royaltyFeeBps) external returns (uint256 tokenId)',
  'function mintProduct(address to, uint256 tokenId, uint256 amount) external',
  'event TokenRegistered(uint256 indexed tokenId, address indexed creator, uint256 maxSupply, uint8 kind, string uri)',
  ...PRODUCT_BATCH_ABI.slice(0, 1),
  PRODUCT_BATCH_ABI[2],
];

// ── DOM references (resolved after DOMContentLoaded) ─────────────────────────
let _modal, _connectedAddr, _roleSection,
  _targetAddr, _roleSelect, _statusEl, _grantBtn, _closeBtn,
  _mintSection, _mintQueueEl, _mintRefreshBtn, _mintSelectedBtn,
  _mintSelectAll, _mintStatusEl, _radioScheduleSection, _radioScheduleForm,
  _radioScheduleEventsEl, _radioScheduleStatusEl, _radioWeeklyForm;
let _adminSigner = null;
let _adminAddress = null;
let _mintQueue = [];
let _mintBusy = false;
let _adminOpen = false;
let _radioSchedule = null;
let _walletCheckId = 0;
const _artworkPreviewUrls = new Map();
const _artworkPreviewGenerations = new Map();
let _artworkPreviewId = 0;

// ── Bootstrap ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  _modal        = document.getElementById('admin-modal');
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
  _radioScheduleSection = document.getElementById('admin-radio-schedule');
  _radioScheduleForm = document.getElementById('admin-radio-schedule-form');
  _radioScheduleEventsEl = document.getElementById('admin-radio-schedule-events');
  _radioScheduleStatusEl = document.getElementById('admin-radio-schedule-status');
  _radioWeeklyForm = document.getElementById('admin-radio-weekly-form');

  if (!_modal) return; // guard: panel HTML not present

  _grantBtn?.addEventListener('click', _grantRole);
  _closeBtn?.addEventListener('click', _closeModal);
  _mintRefreshBtn?.addEventListener('click', _loadMintQueue);
  document.getElementById('admin-radio-schedule-refresh')?.addEventListener('click', _loadRadioSchedule);
  document.getElementById('admin-radio-event-reset')?.addEventListener('click', _resetRadioScheduleForm);
  _radioWeeklyForm?.addEventListener('submit', _saveRadioWeeklySchedule);
  _radioScheduleForm?.addEventListener('submit', _saveRadioScheduleEvent);
  _radioScheduleEventsEl?.addEventListener('click', event => {
    const edit = event.target.closest('[data-radio-event-edit]');
    const cancel = event.target.closest('[data-radio-event-cancel]');
    if (edit) _editRadioScheduleEvent(edit.dataset.radioEventEdit);
    if (cancel) _cancelRadioScheduleEvent(cancel.dataset.radioEventCancel);
  });
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
  _mintQueueEl?.addEventListener('change', event => {
    if (event.target.matches('.admin-artwork, .admin-artwork-cid')) _updateArtworkPreview(Number(event.target.dataset.index));
  });

  // Close on backdrop click
  _modal.addEventListener('click', e => {
    if (e.target === _modal) _closeModal();
  });

  // Listen for the open event dispatched by the header inject script
  document.addEventListener('open-admin', _openModal);
  document.addEventListener('payroll-ledger-synced', event => _showPaymentLedger(event.detail));
  document.addEventListener('wallet-connected', () => {
    _resetAdminWallet();
    if (_adminOpen) _connectWallet();
  });
  document.addEventListener('wallet-disconnected', () => {
    _resetAdminWallet();
    if (_adminOpen) _setStatus('Connect your wallet in the header to use admin tools.');
  });
});

// ── Open / Close ──────────────────────────────────────────────────────────────
function _openModal() {
  if (!isAdminWallet()) return;
  _adminOpen = true;
  _modal?.classList.remove('hidden');
  _refreshPaymentLedger();
  return _connectWallet();
}

function _showPaymentLedger(ledger) {
  const status = document.getElementById('admin-payment-ledger-status');
  if (!status || !isAdminWallet()) return;
  const verified = (ledger.entries || []).filter(entry => entry.verification === 'verified').length;
  status.textContent = ledger.ready ? `${verified} verified Base payments · compared ${ledger.lastCheckedAt || 'pending'} · ${ledger.backupPending || !ledger.snapshotUri ? 'IPFS backup pending' : 'IPFS backup saved'}` : 'Payment ledger restoring.';
}

async function _refreshPaymentLedger() {
  const status = document.getElementById('admin-payment-ledger-status');
  if (!status) return;
  try {
    const service = window.DecentConfig?.ipfsUploadServiceUrl;
    if (!service) return;
    const response = await fetch(`${service.replace(/\/$/, '')}/api/payroll/ledger`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Payment proofs not available yet');
    const ledger = await response.json();
    if (_adminOpen) _showPaymentLedger(ledger);
  } catch (error) { if (_adminOpen && isAdminWallet()) status.textContent = error.message; }
}

function _closeModal() {
  _adminOpen = false;
  _modal?.classList.add('hidden');
  _setStatus('');
}

// ── Connect Wallet ────────────────────────────────────────────────────────────
async function _connectWallet() {
  const wallet = window._wallet;
  if (!isAdminWallet(wallet?.address)) {
    _resetAdminWallet();
    _closeModal();
    return;
  }
  if (!wallet?.signer || !wallet.address) {
    _resetAdminWallet();
    _setStatus('Connect your wallet in the header to use admin tools.');
    return;
  }

  const checkId = ++_walletCheckId;
  try {
    const signer = wallet.signer;
    const address = wallet.address;
    const cfg = window.DecentConfig || {};

    if (wallet.chainId !== (cfg.chainId || 8453)) {
      _resetAdminWallet();
      _setStatus(`⚠️ Switch MetaMask to ${cfg.chainName || 'Base Mainnet'} before using admin tools.`, true);
      return;
    }

    if (_connectedAddr) _connectedAddr.textContent = address;

    // Check that connected wallet is DEFAULT_ADMIN_ROLE on the contract
    const contract = new ethers.Contract(cfg.contractAddress, ROLE_GRANT_ABI, signer);
    const adminRole = await contract.DEFAULT_ADMIN_ROLE();
    const isAdmin   = await contract.hasRole(adminRole, address);
    if (checkId !== _walletCheckId || !_adminOpen) return;

    if (!isAdmin) {
      _resetAdminWallet();
      _setStatus(
        '⛔ Your wallet does not hold DEFAULT_ADMIN_ROLE on this contract and cannot grant roles.',
        true,
      );
      return;
    }

    _adminSigner = signer;
    _adminAddress = address;
    _setStatus('✅ Connected wallet has DEFAULT_ADMIN_ROLE.');
    _mintSection?.classList.remove('hidden');
    _roleSection?.classList.remove('hidden');
    _radioScheduleSection?.classList.remove('hidden');
    await Promise.all([_loadMintQueue(), _loadRadioSchedule()]);
  } catch (err) {
    if (checkId === _walletCheckId) _setStatus(`❌ ${err.message || 'Wallet verification failed'}`, true);
  }
}

function _resetAdminWallet() {
  ++_walletCheckId;
  clearMintQueueAuthorization();
  _adminSigner = null;
  _adminAddress = null;
  _mintQueue = [];
  if (_connectedAddr) _connectedAddr.textContent = '';
  _mintQueueEl?.replaceChildren();
  _mintSection?.classList.add('hidden');
  _roleSection?.classList.add('hidden');
  _radioScheduleSection?.classList.add('hidden');
  _radioSchedule = null;
  _radioScheduleEventsEl?.replaceChildren();
}

async function _loadRadioSchedule() {
  if (!_adminSigner || !_adminAddress) return;
  const checkId = _walletCheckId;
  _setRadioScheduleStatus('Loading the shared live-event calendar…');
  try {
    const service = window.DecentConfig?.ipfsUploadServiceUrl;
    if (!service) throw new Error('The radio service is not configured');
    const response = await fetch(`${service.replace(/\/$/, '')}/api/radio/schedule`, { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Schedule unavailable (${response.status})`);
    if (checkId !== _walletCheckId) return;
    _radioSchedule = payload;
    _populateRadioWeeklyForm(payload.schedule || defaultRadioSchedule(payload.weeklySchedule));
    _renderRadioScheduleEvents();
    _setRadioScheduleStatus(payload.ready ? 'Shared calendar loaded. Times below use America/New_York.' : 'Calendar is read-only until durable Pinata storage is available.', !payload.ready);
    const saveButton = document.getElementById('admin-radio-event-save');
    if (saveButton) saveButton.disabled = payload.ready !== true;
    const weeklyButton = document.getElementById('admin-radio-weekly-save');
    if (weeklyButton) weeklyButton.disabled = payload.ready !== true;
  } catch (error) {
    if (checkId === _walletCheckId) _setRadioScheduleStatus(`❌ ${error.message}`, true);
  }
}

function _populateRadioWeeklyForm(schedule) {
  const slots = [
    ['friday-top10-hype', 'admin-radio-top10-start', 'admin-radio-top10-end'],
    ['friday-live-performance', 'admin-radio-live-start', 'admin-radio-live-end'],
  ];
  for (const [id, startId, endId] of slots) {
    const show = schedule.find(item => item.id === id);
    for (const [elementId, selected, last] of [[startId, show?.startHourLocal ?? 20, 23], [endId, show?.endHourLocal ?? 21, 24]]) {
      const select = document.getElementById(elementId);
      if (!select) continue;
      select.replaceChildren();
      for (let hour = 0; hour <= last; hour++) {
        const suffix = hour >= 12 ? 'PM' : 'AM';
        const value = hour % 12 || 12;
        const option = document.createElement('option');
        option.value = String(hour);
        option.textContent = hour === 24 ? '12:00 AM (Saturday)' : `${value}:00 ${suffix}`;
        select.append(option);
      }
      select.value = String(selected);
    }
  }
}

function _renderRadioScheduleEvents() {
  if (!_radioScheduleEventsEl) return;
  const now = Date.now();
  const events = (_radioSchedule?.events || []).filter(event => Date.parse(event.endUtc) > now)
    .sort((first, second) => Date.parse(first.startUtc) - Date.parse(second.startUtc));
  if (!events.length) {
    _radioScheduleEventsEl.innerHTML = '<li class="admin-schedule-empty">No active or upcoming events.</li>';
    return;
  }
  _radioScheduleEventsEl.innerHTML = events.map(event => {
    const active = Date.parse(event.startUtc) <= now && now < Date.parse(event.endUtc);
    const date = value => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
    return `<li class="admin-schedule-event"><div><strong>${_esc(event.title)}</strong><span>${date(event.startUtc)} – ${date(event.endUtc)} ET${active ? ' · LIVE NOW' : ''}</span></div><div class="admin-schedule-actions"><button class="admin-btn admin-btn-secondary" type="button" data-radio-event-edit="${_esc(event.id)}" aria-label="Edit ${_esc(event.title)}">Edit</button><button class="admin-btn admin-btn-secondary" type="button" data-radio-event-cancel="${_esc(event.id)}" aria-label="Cancel ${_esc(event.title)}">Cancel</button></div></li>`;
  }).join('');
}

function _editRadioScheduleEvent(eventId) {
  const event = _radioSchedule?.events?.find(item => item.id === eventId);
  if (!event || !_radioSchedule?.ready) return;
  document.getElementById('admin-radio-event-id').value = event.id;
  document.getElementById('admin-radio-event-title').value = event.title;
  document.getElementById('admin-radio-event-start').value = utcToNewYorkInput(event.startUtc);
  document.getElementById('admin-radio-event-end').value = utcToNewYorkInput(event.endUtc);
  document.getElementById('admin-radio-event-save').textContent = 'Save event';
  document.getElementById('admin-radio-event-title').focus();
}

function _resetRadioScheduleForm() {
  _radioScheduleForm?.reset();
  const id = document.getElementById('admin-radio-event-id');
  if (id) id.value = '';
  const saveButton = document.getElementById('admin-radio-event-save');
  if (saveButton) saveButton.textContent = 'Schedule event';
}

async function _saveRadioScheduleEvent(event) {
  event.preventDefault();
  if (!_radioSchedule?.ready || !_adminSigner || !_adminAddress) return;
  try {
    const eventId = document.getElementById('admin-radio-event-id').value || crypto.randomUUID();
    const nextEvents = upsertLivePerformanceEvent(_radioSchedule.events || [], {
      id: eventId,
      title: document.getElementById('admin-radio-event-title').value.trim(),
      startUtc: newYorkInputToUtc(document.getElementById('admin-radio-event-start').value),
      endUtc: newYorkInputToUtc(document.getElementById('admin-radio-event-end').value),
    });
    await _saveRadioSchedule(nextEvents, _radioSchedule.weeklySchedule || {});
    _resetRadioScheduleForm();
  } catch (error) {
    _setRadioScheduleStatus(`❌ ${error.message}`, true);
  }
}

async function _saveRadioWeeklySchedule(event) {
  event.preventDefault();
  if (!_radioSchedule?.ready || !_adminSigner || !_adminAddress) return;
  try {
    const weeklySchedule = validateWeeklyScheduleOverrides({
      'friday-top10-hype': { weekday: 5,
        startHourLocal: Number(document.getElementById('admin-radio-top10-start').value),
        endHourLocal: Number(document.getElementById('admin-radio-top10-end').value) },
      'friday-live-performance': { weekday: 5,
        startHourLocal: Number(document.getElementById('admin-radio-live-start').value),
        endHourLocal: Number(document.getElementById('admin-radio-live-end').value) },
    });
    await _saveRadioSchedule(_radioSchedule.events || [], weeklySchedule);
  } catch (error) {
    _setRadioScheduleStatus(`❌ ${error.message}`, true);
  }
}

async function _cancelRadioScheduleEvent(eventId) {
  if (!_radioSchedule?.ready || !_adminSigner || !_adminAddress) return;
  try {
    const nextEvents = (_radioSchedule.events || []).filter(event => event.id !== eventId);
    if (nextEvents.length === (_radioSchedule.events || []).length) throw new Error('Event is no longer in the shared calendar');
    await _saveRadioSchedule(nextEvents, _radioSchedule.weeklySchedule || {});
    _resetRadioScheduleForm();
  } catch (error) {
    _setRadioScheduleStatus(`❌ ${error.message}`, true);
  }
}

async function _saveRadioSchedule(events, weeklySchedule = _radioSchedule?.weeklySchedule || {}) {
  const service = window.DecentConfig?.ipfsUploadServiceUrl;
  if (!service) throw new Error('The radio service is not configured');
  const signer = _adminSigner;
  const address = _adminAddress;
  const checkId = _walletCheckId;
  const issuedAt = new Date().toISOString();
  const authorization = { address, origin: window.location.origin, issuedAt, events,
    weeklySchedule: validateWeeklyScheduleOverrides(weeklySchedule) };
  _setRadioScheduleStatus('Sign the calendar update with the owner wallet…');
  const signature = await signer.signMessage(buildRadioScheduleAuthorizationMessage(authorization));
  if (checkId !== _walletCheckId || signer !== _adminSigner || address !== _adminAddress) throw new Error('Wallet changed before the schedule update completed');
  _setRadioScheduleStatus('Saving the shared calendar…');
  const response = await fetch(`${service.replace(/\/$/, '')}/api/radio/schedule`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...authorization, signature }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Schedule update failed (${response.status})`);
  if (checkId !== _walletCheckId) return;
  _radioSchedule = payload;
  _populateRadioWeeklyForm(payload.schedule || defaultRadioSchedule(payload.weeklySchedule));
  _renderRadioScheduleEvents();
  _setRadioScheduleStatus('Calendar saved to the shared schedule.');
  document.dispatchEvent(new CustomEvent('radio-schedule-updated'));
}

function _setRadioScheduleStatus(message, isError = false) {
  if (!_radioScheduleStatusEl) return;
  _radioScheduleStatusEl.textContent = message;
  _radioScheduleStatusEl.classList.toggle('error', isError);
}

// ── NFT Mint Queue ───────────────────────────────────────────────────────────
  async function _loadMintQueue() {
    if (!_adminSigner || !_adminAddress || _mintBusy) return;
    const checkId = _walletCheckId;
    _setMintStatus('Loading private mint queue…');
    try {
      const cfg = window.DecentConfig || {};
      const requests = await fetchMintQueue({
        serviceUrl: cfg.ipfsUploadServiceUrl,
        signer: _adminSigner,
        address: _adminAddress,
        origin: window.location.origin,
      });
      if (checkId !== _walletCheckId) return;
      _mintQueue = requests;
      _renderMintQueue();
      _setMintStatus(_mintQueue.length ? `${_mintQueue.length} pending request(s).` : 'The mint queue is empty.');
    } catch (err) {
      if (checkId === _walletCheckId) _setMintStatus(`❌ ${err.message}`, true);
    }
  }

  function _renderMintQueue() {
    ++_artworkPreviewId;
    _artworkPreviewGenerations.clear();
    for (const url of _artworkPreviewUrls.values()) URL.revokeObjectURL(url);
    _artworkPreviewUrls.clear();
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
          <img class="admin-artwork-preview" data-index="${index}" ${track.artworkCid ? `src="${_esc(_gatewayUrl(track.artworkCid))}"` : 'hidden'} alt="Artwork for ${_esc(track.title)}" />
          <strong>${_esc(track.title)}</strong>
          <span>by ${_esc(track.uploader)} · ${_esc(track.requestedAt ? new Date(track.requestedAt).toLocaleString() : '')}</span>
          <span>${_esc(track.recipient)}</span>
          <a href="${_esc(_gatewayUrl(track.ipfsCid))}" target="_blank" rel="noopener noreferrer">Open ${track.mediaType === 'video/mp4' ? 'video' : 'audio'}</a>
          <label class="admin-artwork-label">${track.artworkCid ? 'Replace default artwork (up to 10 MB)' : 'Choose artwork (up to 10 MB)'}
            <input class="admin-artwork" type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-index="${index}" />
          </label>
          <label class="admin-artwork-label">Image / GIF file CID (optional, including files over 10 MB)
            <input class="admin-artwork-cid" type="text" maxlength="160" placeholder="bafy... or ipfs://..." data-index="${index}" />
          </label>
          <span class="admin-artwork-status" data-index="${index}" role="status">${track.artworkCid ? 'Queued artwork is selected by default. Leave both fields empty to keep it.' : 'No default image available; select artwork before minting.'}</span>
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

  async function _updateArtworkPreview(index) {
    const track = _mintQueue[index];
    if (!track || _mintBusy) return;
    const generation = ++_artworkPreviewId;
    _artworkPreviewGenerations.set(index, generation);
    const image = _mintQueueEl.querySelector(`.admin-artwork-preview[data-index="${index}"]`);
    const status = _mintQueueEl.querySelector(`.admin-artwork-status[data-index="${index}"]`);
    try {
      const file = _mintQueueEl.querySelector(`.admin-artwork[data-index="${index}"]`)?.files?.[0];
      const cid = _mintQueueEl.querySelector(`.admin-artwork-cid[data-index="${index}"]`)?.value || '';
      const uri = await resolveMintArtwork({ file, cid, defaultCid: track.artworkCid,
        serviceUrl: window.DecentConfig?.ipfsUploadServiceUrl, upload: async value => {
          const prior = _artworkPreviewUrls.get(index); if (prior) URL.revokeObjectURL(prior);
          const url = URL.createObjectURL(value); _artworkPreviewUrls.set(index, url); return url;
        } });
      if (_artworkPreviewGenerations.get(index) !== generation) return;
      image.src = uri.startsWith('ipfs://') ? _gatewayUrl(uri.slice(7)) : uri;
      image.hidden = false;
      status.textContent = file ? 'New upload preview; it will be pinned when you mint.' : cid ? 'IPFS image preview; no new file upload required.' : 'Queued default artwork selected.';
    } catch (error) {
      if (_artworkPreviewGenerations.get(index) !== generation) return;
      status.textContent = error.message;
    }
  }

  async function _processQueue(indices) {
    if (_mintBusy || !_adminSigner) return;
    _mintBusy = true;
    _setMintControlsDisabled(true);
    let completed = false;
    try {
      if (window.DecentConfig?.nftBatchMintEnabled === true) {
        await _mintQueuedBatch(indices);
      } else for (let position = 0; position < indices.length; position++) {
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

  async function _prepareQueuedTrack(track, index) {
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

    const artworkCid = _mintQueueEl?.querySelector(`.admin-artwork-cid[data-index="${index}"]`)?.value || '';
    const image = await resolveMintArtwork({ file: artwork, cid: artworkCid, defaultCid: track.artworkCid,
      serviceUrl: cfg.ipfsUploadServiceUrl, upload: async file => {
        _setMintStatus(`Uploading artwork for ${track.title}…`);
        return upload(file);
      } });
    const metadata = {
      name: track.title,
      description: `Shared through DecentJukebox by ${track.uploader}`,
      animation_url: `ipfs://${track.ipfsCid}`,
      audioUrl: `ipfs://${track.ipfsCid}`,
      ...(track.mediaType ? { mediaType: track.mediaType } : {}),
      ...(track.mediaType === 'video/mp4' ? { videoUrl: `ipfs://${track.ipfsCid}` } : {}),
      ...(image ? { image } : {}),
      artist: track.recipient,
      creator: track.recipient,
      tipWallet: track.tipWallet || track.recipient,
      ...(track.parentTokenId > 0 ? { parentTokenId: track.parentTokenId, royaltyChain: { parentTokenId: track.parentTokenId } } : {}),
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
    return { metadata, metadataUrl };
  }

  async function _mintQueuedTrack(track, index) {
    const cfg = window.DecentConfig || {};
    const { metadata, metadataUrl } = await _prepareQueuedTrack(track, index);
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
      addNFTToSpace({ tokenId: Number(tokenId), contractAddress: cfg.contractAddress,
        chainId: cfg.chainId, metadataUri: metadataUrl, ...metadata });
    } catch (err) {
      throw new Error(
        `Token #${tokenId} minted, but Discord sync failed. Use /jukeloop mark-minted with ` +
        `track ${track.trackId}, token ${tokenId}, and tx ${txHash}. ${err.message}`,
      );
    }
  }

  async function _mintQueuedBatch(indices) {
    if (indices.length > 20) throw new Error('Select up to 20 songs per batch');
    const cfg = window.DecentConfig || {};
    const signer = _adminSigner;
    const owner = _adminAddress;
    const walletCheck = _walletCheckId;
    const prepared = [];
    for (const index of indices) {
      const track = _mintQueue[index];
      if (!track) throw new Error('Mint queue changed; reload before minting');
      prepared.push({ track, ...await _prepareQueuedTrack(track, index) });
      if (walletCheck !== _walletCheckId) throw new Error('Wallet changed during batch preparation');
    }
    if (Number((await signer.provider.getNetwork()).chainId) !== 8453) throw new Error('Batch minting is Base-only');
    if (walletCheck !== _walletCheckId || signer !== _adminSigner || cfg.contractAddress !== window.DecentConfig?.contractAddress) {
      throw new Error('Wallet or contract changed; reload before minting');
    }
    const contract = new ethers.Contract(cfg.contractAddress, ROLE_GRANT_ABI, signer);
    const products = prepared.map(({ track, metadataUrl }) => ({ recipient: track.recipient,
      amount: 1, maxSupply: 0, tokenURI: metadataUrl, royaltyReceiver: track.recipient, royaltyFeeBps: 500 }));
    _setMintStatus(`Confirm one batch transaction for ${products.length} songs…`);
    const result = await mintPreparedProductsBatch({ contract, products, owner,
      onBroadcast: hash => _setMintStatus(`Batch submitted: ${hash}. Waiting for confirmation…`) });
    const failures = [];
    for (let index = 0; index < prepared.length; index++) {
      const { track, metadata, metadataUrl } = prepared[index];
      const tokenId = result.tokenIds[index];
      addNFTToSpace({ ...metadata, tokenId: Number(tokenId), contractAddress: cfg.contractAddress,
        chainId: 8453, metadataUri: metadataUrl });
      try {
        await reportMintCompletion({ serviceUrl: cfg.ipfsUploadServiceUrl, trackId: track.trackId,
          tokenId, txHash: result.txHash });
      } catch (error) { failures.push(`${track.trackId}: token ${tokenId} (${error.message})`); }
    }
    if (failures.length) throw new Error(`Batch already minted: ${result.txHash}. Do not mint again. Pending Discord sync: ${failures.join('; ')}`);
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
    const gateway = (window.DecentConfig?.ipfsGateway || 'https://gateway.pinata.cloud/ipfs/').replace(/\/$/, '');
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
