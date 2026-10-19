// js/space.js — DecentBusking
// Three.js-powered NFT asteroid field.
//
// Behaviour:
//  • Each minted DecentNFT is placed on a Z-axis timeline: newest at z=0
//    (centre stage, facing the camera), oldest stretching back in negative Z.
//  • A sliding 30-day window controls which NFTs are visible. The default
//    window shows the most recent 30 days. Timeline navigation controls let
//    the user pan back in time to surface older NFTs.
//  • The right-side DNFT list panel lists all loaded NFTs sorted newest-first.
//    Clicking an item selects it, plays its audio, and pans the timeline window
//    to show that NFT.
//  • Only music NFTs (those with audioUrl, audio-extension animation_url, or a
//    bare ipfs:// animation_url) are shown — non-audio tokens are silently
//    skipped by the indexed catalog.
//  • The indexed archive loads 25 newest tracks, then pages only on demand.
//  • WASD / Arrow keys always fly the camera (no toggle required).  Tab
//    additionally disables mouse-orbit (pure ship mode).  Q/E move vertically.
//  • Mouse orbit is always available; full vertical range (0–180°) is allowed.
//
// Dependencies (loaded via CDN in index.html):
//   • THREE  (three.js r128)
//   • OrbitControls  (from three@0.128.0 examples)

import { renderNFTCard } from './nft-card.js?v=20261016-radio-preload';
import { getBaseReadProvider } from './base-chain.mjs?v=20261018-shared-provider';
import { setNowPlaying } from './stage.js?v=20261016-radio-preload';
import { fetchIpfsJson, buildIpfsGatewayUrls } from './ipfs-gateway.js?v=20261003-coins-radio-votes';
import { loadMintedToken, nftArtistKey, fetchNftCatalogPage, configuredNftCollections, parseNftIdentitySearch, isMusicNft } from './nft-loader.js?v=20261012-paging';

// ── Timeline constants ────────────────────────────────────────────────────
const UNITS_PER_DAY   = 5;          // 3-D units per day on the Z-axis
const SPREAD_RADIUS   = 6;          // XY scatter radius to avoid overlap
const WINDOW_DAYS     = 30;         // how many days the default view covers
const NAV_STEP_DAYS   = 1;
const MAX_NAV_DAYS    = 365;        // how far back the slider can go

// Camera home position (z offset ahead of the timeline centre)
const CAM_Z_OFFSET = 28;

// ── Global state ──────────────────────────────────────────────────────────
let _renderer, _scene, _camera, _controls;
let _nftMeshes = [];
let _raycaster, _mouse;

// Keyboard flight is always active alongside OrbitControls.
// Tab still toggles "pure ship mode" (disables OrbitControls mouse orbit).
let _shipMode  = false;   // true = Tab-activated pure fly, false = hybrid (WASD + orbit)
let _keysDown  = {};
let _animFrameId;

// Timeline navigation
let _timelineOffsetDays = 0;   // how many days back from "now" the window starts

// List & selection state
let _allNFTs   = [];           // { nft, mesh } for every loaded token
let _activeId  = null;         // currently selected tokenId
let _nowPlayingKey = null;
let _nowPlayingMesh = null;
let _pendingNowPlaying = null;
let _nowPlayingMedia = null;
let _nowPlayingAudioContext = null;
let _nowPlayingMediaSource = null;
let _nowPlayingChannelSplitter = null;
let _nowPlayingLeftAnalyser = null;
let _nowPlayingRightAnalyser = null;
let _nowPlayingAnalyser = null;
let _nowPlayingAudioData = null;
let _nowPlayingLeftWaveData = null;
let _nowPlayingRightWaveData = null;
let _nowPlayingFrequencyData = null;
let _nowPlayingReducedMotion = null;
let _nowPlayingLookupToken = 0;
let _openNFTLookupToken = 0;

// Spaceship
const _ship = { speed: 0.3 };

if (typeof document !== 'undefined' && document?.addEventListener) {
  document.addEventListener('dbusk-now-playing', (event) => {
    void _handleNowPlaying(event.detail || {});
  });
  document.addEventListener('dbusk-now-playing-stopped', () => {
    if (_nowPlayingMesh) _resetNowPlayingPulse(_nowPlayingMesh);
  });
}

// ── NFT paging state ──────────────────────────────────────────────────────
let _archiveNext = 0;
let _archiveGeneration = 0;
let _archiveRequest = null;
let _archiveTimer = null;
let _catalogArtists = [];
let _archiveQuery = '';
let _pointerStart = null;
let _activeArtist = '';
let _sharedFocusLookupToken = 0;

// ── Public API ────────────────────────────────────────────────────────────
export function initSpace() {
  _buildScene();
  _buildControls();
  if (_pendingNowPlaying) _applyNowPlaying(_pendingNowPlaying);
  _addTimelineLine();
  _bindArtistFilters();
  _loadNFTs();
  _animate();
  _bindTimelineNav();
  _bindShowAllBtn();
  _bindArchiveDrawer();
  window.addEventListener('resize', _onResize);
  window.addEventListener('keydown', _onKeyDown);
  window.addEventListener('keyup', _onKeyUp);
  window.addEventListener('blur', () => { _keysDown = {}; });
  window.addEventListener('popstate', () => { void _focusSharedNFTFromLocation(); });
  void _focusSharedNFTFromLocation();
}

// Called by mint.js after a new busk is minted — places it at the front.
export function addNFTToSpace(nft) {
  if (!_scene) {
    console.warn('[space] Scene not initialized; skipping mesh spawn for', nft?.tokenId);
    return;
  }
  _spawnMesh(nft, true /* isNew */);
}

function _applyNowPlaying(detail) {
  const nft = detail?.nft;
  if (!nft) return;
  if (!_scene) {
    _pendingNowPlaying = detail;
    return;
  }

  const key = _nftKey(nft);
  let entry = _allNFTs.find((item) => _nftKey(item.nft) === key);
  const wasMissing = !entry;
  if (!entry) {
    const mesh = _spawnMesh(nft, false);
    entry = mesh ? { nft, mesh } : null;
  }
  if (!entry) return;

  if (_nowPlayingMesh && _nowPlayingMesh !== entry.mesh) {
    _resetNowPlayingPulse(_nowPlayingMesh);
    _nowPlayingMesh.userData.pinnedVisible = true;
  }
  _nowPlayingKey = key;
  _nowPlayingMesh = entry.mesh;
  _nowPlayingMedia = _activeMediaElement();
  _pendingNowPlaying = null;
  entry.mesh.userData.pinnedVisible = true;
  entry.mesh.userData.nowPlayingHueSeed = Math.random();
  _ensureNowPlayingGlow(entry.mesh);
  _ensureNowPlayingEdge(entry.mesh);
  if (entry.mesh.material) {
    entry.mesh.material.depthTest = false;
    entry.mesh.material.depthWrite = false;
    entry.mesh.material.transparent = true;
  }
  entry.mesh.renderOrder = 100;
  entry.mesh.visible = true;
  if (wasMissing) _focusNowPlaying(entry.mesh);
  _updateVisibility();
}

async function _handleNowPlaying(detail) {
  if (!detail) return;
  const token = ++_nowPlayingLookupToken;
  if (detail.nft) {
    _applyNowPlaying(detail);
    return;
  }
  const nft = await resolveNowPlayingNFT(detail);
  if (token !== _nowPlayingLookupToken) return;
  if (!nft) return;
  _applyNowPlaying({ ...detail, nft });
}

function _showSharedNFTStatus(title, message) {
  const panel = document.getElementById('nft-panel');
  const content = document.getElementById('nft-panel-content');
  const closeBtn = document.getElementById('nft-panel-close');
  if (!panel || !content) return;
  content.innerHTML = `
    <h3 id="nft-detail-title">${_esc(title)}</h3>
    <p class="nft-share-loading" role="status" aria-live="polite">${_esc(message)}</p>
  `;
  panel.classList.remove('hidden');
  if (!panel.open) panel.showModal();
  panel.oncancel = (event) => {
    event.preventDefault();
    panel.close();
  };
  panel.onkeydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      panel.close();
    }
  };
  panel.onclose = () => {
    panel.classList.add('hidden');
  };
  panel.onclick = (event) => {
    const bounds = panel.getBoundingClientRect();
    if (event.target === panel && (event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom)) panel.close();
  };
  if (closeBtn) closeBtn.onclick = () => panel.close();
}

function _showSharedNFTError(message) {
  _showSharedNFTStatus('Shared NFT unavailable', message);
}

async function _focusSharedNFTFromLocation() {
  const token = ++_sharedFocusLookupToken;
  const search = window.location?.search || '';
  if (!search) return;
  const params = new URLSearchParams(search);
  if (!['chainId', 'contract', 'tokenId'].some(key => params.has(key))) return;

  let identity;
  try {
    identity = parseNftIdentitySearch(search);
  } catch (error) {
    _showSharedNFTError(error.message);
    return;
  }

  _showSharedNFTStatus('Opening shared NFT', 'Loading the requested NFT…');
  try {
    const nft = await _resolveSharedNFT(identity);
    if (token !== _sharedFocusLookupToken) return;
    if (!nft) throw new Error('The requested NFT could not be found.');
    if (!isMusicNft(nft)) throw new Error('The requested NFT media is not viewable in this scene.');
    const entry = _allNFTs.find((item) => _nftKey(item.nft) === _nftKey(nft));
    const mesh = entry?.mesh || _spawnMesh(nft, false);
    if (!mesh) throw new Error('The requested NFT could not be displayed.');
    mesh.userData.pinnedVisible = true;
    const row = _nftRow(nft);
    _selectNFT(nft, mesh, row, true, { pinVisible: true, play: false });
  } catch (error) {
    if (token !== _sharedFocusLookupToken) return;
    _showSharedNFTError(error.message || 'The requested NFT could not be opened.');
  }
}

async function _resolveSharedNFT({ chainId, contractAddress, tokenId }) {
  const cfg = window.DecentConfig || {};
  const configuredChainId = Number(cfg.chainId || 8453);
  if (chainId !== configuredChainId) throw new Error(`This link targets chain ${chainId}, but this scene only supports chain ${configuredChainId}.`);
  const collections = new Set(configuredNftCollections(cfg).map((entry) => entry.contractAddress));
  if (!collections.has(contractAddress.toLowerCase())) {
    throw new Error('This NFT collection is not available in this scene.');
  }
  const direct = _allNFTs.find(({ nft }) => _nftKey(nft) === `${chainId}:${contractAddress.toLowerCase()}:${tokenId}`);
  if (direct) return direct.nft;
  const nft = await fetchNFTMetaById(tokenId, contractAddress);
  if (!nft || nft.chainId !== chainId || nft.contractAddress?.toLowerCase() !== contractAddress.toLowerCase()) return null;
  return nft;
}

function _textKey(value = '') {
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function _audioUrlMatches(detail, nft, exact = false) {
  if (exact) {
    const identity = (value) => String(value || '').replace(/^ipfs:\/\/(?:ipfs\/)?/, '/ipfs/')
      .match(/\/ipfs\/([^?#]+)/)?.[1] || String(value || '');
    const media = [nft?.audioUrl, nft?.videoUrl, nft?.animation_url].filter(Boolean);
    const expected = identity(detail?.audioUrl) || String(detail?.ipfsCid || '');
    return !!expected && media.some(value => identity(value) === expected);
  }
  const cid = String(detail?.ipfsCid || '').trim().toLowerCase();
  const audioUrls = [nft?.audioUrl, nft?.videoUrl, nft?.animation_url, nft?.metadataUri].filter(Boolean).map((value) => String(value).toLowerCase());
  if (cid && audioUrls.some((value) => value.includes(cid))) return true;
  const audioUrl = String(detail?.audioUrl || '').toLowerCase();
  return !!audioUrl && audioUrls.some((value) => value === audioUrl || value.includes(audioUrl.replace(/^https?:\/\//, '')));
}

function _matchesNowPlaying(detail, nft) {
  if (!nft) return false;
  const title = _textKey(detail?.title);
  const artist = _textKey(detail?.artist);
  const nftTitle = _textKey(nft.name || nft.title);
  const nftArtist = _textKey(_artistLabel(nft));
  if (_audioUrlMatches(detail, nft)) return true;
  if (title && nftTitle === title) return !artist || nftArtist.includes(artist) || artist.includes(nftArtist);
  return false;
}

export async function resolveNowPlayingNFT(detail, { requireMediaMatch = false } = {}) {
  const matches = (nft) => requireMediaMatch ? _audioUrlMatches(detail, nft, true) : _matchesNowPlaying(detail, nft);
  const direct = _allNFTs.find(({ nft }) => matches(nft));
  if (direct) return direct.nft;

  const cfg = window.DecentConfig || {};
  if (!cfg.ipfsUploadServiceUrl) return null;
  const query = (requireMediaMatch ? String(detail?.title || '')
    : [detail?.title, detail?.artist].filter(Boolean).join(' ')).trim();
  if (!query) return null;

  let offset = 0;
  for (let page = 0; page < 64; page += 1) {
    const result = await fetchNftCatalogPage({
      config: cfg,
      query,
      offset,
    }).catch((error) => {
      if (requireMediaMatch) throw error;
      return null;
    });
    if (!result) return null;
    const match = Array.isArray(result.nfts) ? result.nfts.find(matches) : null;
    if (match) return match;
    if (result.nextOffset === null) return null;
    offset = result.nextOffset;
  }
  return null;
}

// Fetch metadata for a single token by ID — used by mint.js for parent preview.
export async function fetchNFTMetaById(tokenId, collectionAddress) {
  const cfg = window.DecentConfig || {};
  const contractAddress = collectionAddress || cfg.contractAddress;
  if (!contractAddress || contractAddress === '0x0000000000000000000000000000000000000000') return null;

  try {
    const provider = getBaseReadProvider({ ethers });
    const abi = [
      'function uri(uint256 tokenId) view returns (string)',
      'function creatorOf(uint256 tokenId) view returns (address)',
      'function totalMinted(uint256 tokenId) view returns (uint256)',
    ];
    const contract = new ethers.Contract(contractAddress, abi, provider);
    return await loadMintedToken({ contract, tokenId, fetchMetadata: _fetchMetadata,
      contractAddress, chainId: cfg.chainId || 8453 });
  } catch (err) {
    console.warn('[space] fetchNFTMetaById failed:', err.message);
    return null;
  }
}

export async function openNFTByIdentity(detail = {}) {
  const tokenId = Number(detail?.tokenId);
  const contractAddress = detail?.contractAddress || window.DecentConfig?.contractAddress || '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(contractAddress) || !Number.isSafeInteger(tokenId) || tokenId < 0) return false;
  if (!_scene) return false;
  const lookup = ++_openNFTLookupToken;
  const key = `${Number(detail.chainId || 8453)}:${contractAddress.toLowerCase()}:${tokenId}`;
  let entry = _allNFTs.find((item) => _nftKey(item.nft) === key);
  if (!entry) {
    const nft = detail.nft || await fetchNFTMetaById(tokenId, contractAddress);
    if (lookup !== _openNFTLookupToken || !nft) return false;
    const mesh = _spawnMesh(nft, false);
    entry = mesh ? { nft, mesh } : null;
  }
  if (!entry || lookup !== _openNFTLookupToken) return false;
  _selectNFT(entry.nft, entry.mesh, _nftRow(entry.nft), true, { play: false });
  return true;
}

// Move the timeline window to a specific day-offset (called from nav controls).
export function setTimelineOffset(days) {
  _timelineOffsetDays = Math.max(0, Math.min(days, MAX_NAV_DAYS - WINDOW_DAYS));
  _updateVisibility();
  _moveCameraToOffset();
  _updateNavUI();
  clearTimeout(_archiveTimer);
  _archiveTimer = setTimeout(() => _loadNFTs(true), 250);
}

// ── Scene Bootstrap ────────────────────────────────────────────────────────
function _buildScene() {
  _scene = new THREE.Scene();
  _scene.background = new THREE.Color(0x03010a);
  _scene.fog = new THREE.FogExp2(0x03010a, 0.006);

  // Stars
  const starGeo = new THREE.BufferGeometry();
  const starCount = 4000;
  const positions = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount * 3; i++) {
    positions[i] = (Math.random() - 0.5) * 600;
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.35, sizeAttenuation: true });
  _scene.add(new THREE.Points(starGeo, starMat));

  // Camera
  _camera = new THREE.PerspectiveCamera(60, _aspect(), 0.1, 800);
  _camera.position.set(0, 8, _homeCameraDistance());

  // Renderer — sits at the bottom of the stacking context
  _renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  _renderer.setSize(window.innerWidth, window.innerHeight);
  _renderer.domElement.id = 'space-canvas';
  document.body.prepend(_renderer.domElement);

  // Lighting
  _scene.add(new THREE.AmbientLight(0x222244, 1.6));
  const pt = new THREE.PointLight(0xf0c040, 1.2, 60);
  pt.position.set(0, 10, 10);
  _scene.add(pt);

  // Raycaster for click-to-select
  _raycaster = new THREE.Raycaster();
  _mouse = new THREE.Vector2();

  _renderer.domElement.addEventListener('click', _onCanvasClick);
  _renderer.domElement.addEventListener('pointerdown', (event) => {
    _pointerStart = { x: event.clientX, y: event.clientY };
  });
  _renderer.domElement.addEventListener('mousemove', _onMouseMove);
}

function _buildControls() {
  if (typeof THREE.OrbitControls !== 'undefined') {
    _controls = new THREE.OrbitControls(_camera, _renderer.domElement);
    _controls.enableDamping = true;
    _controls.dampingFactor = 0.07;
    _controls.minDistance = 5;
    _controls.maxDistance = 250;
    // Allow full vertical orbit (0 = top, π = bottom) so the user can swing
    // the camera below the NFT field and look up, fully circling the space.
    _controls.minPolarAngle = 0;
    _controls.maxPolarAngle = Math.PI;
    // Enable panning so the user can slide the view along the Z timeline.
    _controls.enablePan = true;
    _controls.rotateSpeed = 1.35;
    _controls.zoomSpeed = 0.85;
    _controls.panSpeed = 1.5;
    _controls.screenSpacePanning = true;
  }
}

// Subtle gold line running back along the Z-axis to visualise the timeline.
function _addTimelineLine() {
  const mat = new THREE.LineBasicMaterial({
    color: 0xf0c040,
    transparent: true,
    opacity: 0.15,
  });
  const points = [
    new THREE.Vector3(0, 0, CAM_Z_OFFSET - 5),
    new THREE.Vector3(0, 0, -(MAX_NAV_DAYS * UNITS_PER_DAY)),
  ];
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  _scene.add(new THREE.Line(geo, mat));

  // Tick marks every 7 days
  const tickMat = new THREE.LineBasicMaterial({ color: 0xf0c040, transparent: true, opacity: 0.25 });
  for (let d = 7; d <= MAX_NAV_DAYS; d += 7) {
    const z = -d * UNITS_PER_DAY;
    const tickGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-1.5, 0, z),
      new THREE.Vector3(1.5, 0, z),
    ]);
    _scene.add(new THREE.Line(tickGeo, tickMat));
  }
}

// ── NFT Loading ────────────────────────────────────────────────────────────
//
async function _loadNFTs(reset = true) {
  if (reset) { clearTimeout(_archiveTimer); _archiveTimer = null; }
  const cfg = window.DecentConfig || {};
  if (!reset && (_archiveRequest || _archiveNext === null)) return;
  _archiveRequest?.abort();
  const controller = new AbortController();
  _archiveRequest = controller;
  const generation = ++_archiveGeneration;
  const button = document.getElementById('dnft-show-all-btn');
  if (button) button.disabled = true;
  _showSpinner(true);
  try {
    const options = { offset: reset ? 0 : _archiveNext, query: _archiveQuery, artist: _activeArtist };
    if (_timelineOffsetDays > 0 && !_activeArtist && !_archiveQuery) {
      const now = Date.now();
      options.before = new Date(now - _timelineOffsetDays * 86400000).toISOString();
      options.after = new Date(now - (_timelineOffsetDays + WINDOW_DAYS) * 86400000).toISOString();
    }
    const page = await fetchNftCatalogPage({ config: cfg, ...options, signal: controller.signal });
    if (generation !== _archiveGeneration) return;
    if (reset) {
      const retained = _allNFTs.filter(({ mesh }) => mesh.userData.pinnedVisible);
      const retainedKeys = new Set(retained.map(({ nft }) => _nftKey(nft)));
      for (const mesh of _nftMeshes) {
       if (mesh.userData.pinnedVisible) continue;
       mesh.userData.artworkTexture?.userData?.artwork?.dispose?.();
       _scene.remove(mesh);
       mesh.geometry.dispose();
       mesh.material.map?.dispose();
       mesh.material.dispose();
      }
      _nftMeshes = retained.map(({ mesh }) => mesh);
      _allNFTs = retained;
      const list = document.getElementById('dnft-list-items');
      if (list) {
       if (!retainedKeys.size) list.replaceChildren();
       else list.querySelectorAll('.dnft-list-item').forEach((item) => {
         if (!retainedKeys.has(item.dataset.nftId || item.dataset.tokenId || '')) item.remove();
       });
      }
    }
    _catalogArtists = page.artists;
    for (const nft of page.nfts) {
      if (!_allNFTs.some(entry => _nftKey(entry.nft) === _nftKey(nft))) _spawnMesh(nft, false);
    }
    _archiveNext = page.nextOffset;
    _refreshArtistFilters();
    _updateVisibility();
    if (!_allNFTs.length) _markListEmpty('No matching music NFTs.');
    const status = document.getElementById('archive-search-status');
    if (status) status.textContent = `${_allNFTs.length} of ${page.total} matching tracks loaded` +
      (page.refreshError ? `; showing the last verified index: ${page.refreshError}` : '');
    if (button) {
      button.classList.toggle('hidden', page.nextOffset === null);
      button.textContent = 'Load 25 more';
    }
  } catch (err) {
    if (generation !== _archiveGeneration || controller.signal.aborted) return;
    console.warn('[space] NFT load failed:', err.message);
    const status = document.getElementById('archive-search-status');
    if (status) status.textContent = err.message;
    if (reset) _archiveNext = 0;
    if (!_allNFTs.length) _markListEmpty(err.message);
    if (button) { button.classList.remove('hidden'); button.textContent = 'Retry loading'; }
  } finally {
    if (generation === _archiveGeneration) {
      _archiveRequest = null;
      _showSpinner(false);
      if (button) button.disabled = false;
    }
  }
}

async function _fetchMetadata(uri) {
  const cfg = window.DecentConfig || {};
  return fetchIpfsJson(uri, {
    primaryGateway: cfg.ipfsGateway || 'https://gateway.pinata.cloud/ipfs/',
  });
}

// ── Mesh Spawning ──────────────────────────────────────────────────────────
function _spawnMesh(nft, isNew) {
  const mintedAt = nft.mintedAt ? new Date(nft.mintedAt).getTime() : Date.now();
  const ageMs    = Date.now() - mintedAt;
  const ageDays  = ageMs / (24 * 60 * 60 * 1000);

  // Timeline Z position: z=0 is "now", negative Z is the past.
  const z = isNew ? 0 : -ageDays * UNITS_PER_DAY;

  // Deterministic XY spread using golden-angle per tokenId to prevent overlap.
  const seed = _nftSpreadSeed(nft);
  const angle = (seed * 137.508) * (Math.PI / 180);
  const radius = SPREAD_RADIUS + (seed % 4) * 2.5;
  const x = Math.cos(angle) * radius;
  const y = Math.sin(angle) * radius * 0.6;

  const pos = new THREE.Vector3(x, y, z);

  // Tile geometry
  const geo     = new THREE.CircleGeometry(1.8, 96);
  const texture = _makeNFTTexture(nft);
  const mat     = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
    opacity: 1,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(pos);
  mesh.rotation.set(
    (Math.random() - 0.5) * 0.2,
    angle + Math.PI,
    (Math.random() - 0.5) * 0.15,
  );

  // Determine initial visibility within the current 30-day window.
  mesh.visible = isNew || _isInWindow(ageDays);

  mesh.userData = { nft, mintedAt, ageMs, ageDays, isNew, artworkTexture: texture };

  _scene.add(mesh);
  _nftMeshes.push(mesh);

  // Track for list panel (newest first — prepend)
  if (isNew) _allNFTs.unshift({ nft, mesh });
  else _allNFTs.push({ nft, mesh });
  _addListItem(nft, mesh, isNew);
  _refreshArtistFilters();
  _updateVisibility();

  // Newly minted busk: auto-play and mark as active.
  if (isNew) {
    _selectNFT(nft, mesh, null, false /* skipCard */, { play: false });
    window._currentBuskerWallet = nft.tipWallet || '';
  }

  return mesh;
}

// ── Canvas texture for NFT tile label ─────────────────────────────────────
function _makeNFTTexture(nft) {
  const canvas = document.createElement('canvas');
  canvas.width  = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  const artwork = {
    active: false,
    disposed: false,
    isGif: false,
    image: null,
    objectUrl: null,
    loading: false,
    loadedOnce: false,
    loadSession: 0,
    loadGeneration: 0,
    loadPromise: null,
    sourceUrls: [],
    retryAfter: 0,
    failures: 0,
  };

  texture.userData ||= {};
  texture.userData.artwork = artwork;

  const releaseImage = () => {
    if (artwork.image) {
      artwork.image.onload = null;
      artwork.image.onerror = null;
      try { artwork.image.src = ''; } catch {}
    }
    if (artwork.objectUrl) {
      try { URL.revokeObjectURL(artwork.objectUrl); } catch {}
    }
    artwork.image = null;
    artwork.objectUrl = null;
  };

  const drawFace = (image) => {
    ctx.clearRect(0, 0, 512, 512);
    ctx.save();
    ctx.beginPath();
    ctx.arc(256, 256, 246, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#10121a';
    ctx.fillRect(0, 0, 512, 512);
    if (image) {
      const scale = Math.max(512 / image.width, 512 / image.height);
      ctx.globalAlpha = .55;
      ctx.drawImage(image, (512 - image.width * scale) / 2, (512 - image.height * scale) / 2,
        image.width * scale, image.height * scale);
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255, 248, 223, .96)';
    ctx.font = 'bold 30px Bungee, Impact, sans-serif';
    ctx.shadowColor = 'rgba(0, 0, 0, .45)';
    ctx.shadowBlur = 2;
    const words = String(nft.name || nft.title || `Track #${nft.tokenId}`).split(/\s+/);
    const lines = [];
    let line = '';
    for (const word of words) {
      if (line && ctx.measureText(`${line} ${word}`).width > 350) { lines.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(line);
    lines.slice(0, 4).forEach((text, index) => ctx.fillText(text, 256, 156 + index * 38, 350));
    ctx.font = 'bold 24px sans-serif';
    ctx.fillStyle = 'rgba(169, 255, 232, .96)';
    ctx.fillText(_artistLabel(nft).split(' · ')[0], 256, 334, 350);
    ctx.font = '21px sans-serif';
    ctx.fillStyle = 'rgba(255, 248, 223, .95)';
    const date = nft.mintedAt ? new Date(nft.mintedAt).toLocaleDateString() : '—';
    ctx.fillText(date, 256, 375, 320);
    ctx.font = '18px monospace';
    ctx.fillText(`#${nft.tokenId}`, 256, 431);
    ctx.restore();
    ctx.beginPath();
    ctx.arc(256, 256, 246, 0, Math.PI * 2);
    ctx.strokeStyle = '#e1bf72';
    ctx.lineWidth = 10;
    ctx.stroke();
    texture.needsUpdate = true;
  };

  const isGifBytes = (bytes) => bytes?.length >= 6
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46
    && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61;

  const looksLikeGifUrl = (url) => {
    try {
      return /\.gif(?:[?#].*)?$/i.test(new URL(url, window.location?.href || 'https://example.invalid/').pathname);
    } catch {
      return /\.gif(?:[?#].*)?$/i.test(url || '');
    }
  };

  const loadFromUrl = async (url) => {
    const requestGeneration = ++artwork.loadGeneration;
    try {
      const fetchImpl = globalThis.fetch;
      if (!fetchImpl) throw new Error('fetch unavailable');
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
      if (requestGeneration !== artwork.loadGeneration || artwork.disposed) return false;
      if (!response.ok) return false;
      const contentType = response.headers?.get?.('content-type') || '';
      const buffer = await response.arrayBuffer();
      if (requestGeneration !== artwork.loadGeneration || artwork.disposed) return false;
      const objectUrl = URL.createObjectURL(new Blob([buffer], { type: contentType || undefined }));
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.decoding = 'async';
      artwork.objectUrl = objectUrl;
      image.onload = () => {
        if (requestGeneration !== artwork.loadGeneration || artwork.disposed) {
          releaseImage();
          return;
        }
        artwork.image = image;
        artwork.isGif = Boolean(contentType && /image\/gif/i.test(contentType)) || isGifBytes(new Uint8Array(buffer)) || looksLikeGifUrl(url);
        artwork.loadedOnce = true;
        drawFace(image);
        if (!artwork.active || !artwork.isGif) releaseImage();
      };
      image.onerror = () => {
        if (requestGeneration === artwork.loadGeneration && artwork.objectUrl === objectUrl) releaseImage();
      };
      image.src = objectUrl;
      return true;
    } catch {
      return false;
    }
  };

  const loadArtwork = async () => {
    if (artwork.disposed) return false;
    if (!artwork.sourceUrls.length) {
      drawFace(null);
      return false;
    }
    if (artwork.loading) return artwork.loadPromise || false;
    const session = ++artwork.loadSession;
    artwork.loading = true;
    artwork.loadPromise = (async () => {
      for (const url of artwork.sourceUrls) {
        if (await loadFromUrl(url)) { artwork.failures = 0; return true; }
        if (artwork.disposed || artwork.loadSession !== session) return false;
      }
      // setActive runs every frame; without a backoff a failed (e.g. oversized) image is re-downloaded
      // continuously and gets the listener rate-limited by the IPFS gateway, which also breaks audio.
      artwork.failures += 1;
      artwork.retryAfter = Date.now() + Math.min(10 * 60_000, 60_000 * 2 ** (artwork.failures - 1));
      if (!artwork.disposed) {
        console.warn('[space] Failed to load NFT artwork from any source for', nft.tokenId ?? nft.name ?? 'unknown NFT');
      }
      return false;
    })();
    try {
      return await artwork.loadPromise;
    } finally {
      if (artwork.loadSession === session) {
        artwork.loading = false;
        artwork.loadPromise = null;
      }
    }
  };

  artwork.setActive = (active) => {
    if (artwork.disposed) return;
    if (artwork.active === active) {
      if (!active) return;
      if (artwork.image || artwork.loading || (artwork.loadedOnce && !artwork.isGif)) return;
    }
    artwork.active = active;
    if (!active) {
      artwork.loadGeneration += 1;
      artwork.loadSession += 1;
      artwork.loading = false;
      releaseImage();
      return;
    }
    if (Date.now() < artwork.retryAfter) return;
    if (!artwork.image && !artwork.loading && (!artwork.loadedOnce || artwork.isGif)) void loadArtwork();
  };

  artwork.tick = () => {
    if (!artwork.active || !artwork.isGif || !artwork.image || artwork.disposed) return;
    drawFace(artwork.image);
  };

  artwork.dispose = () => {
    if (artwork.disposed) return;
    artwork.disposed = true;
    artwork.active = false;
    artwork.loadGeneration += 1;
    releaseImage();
  };

  drawFace(null);
  if (nft.image) {
    const cfg = window.DecentConfig || {};
    artwork.sourceUrls = buildIpfsGatewayUrls(nft.image, cfg.ipfsGateway || 'https://gateway.pinata.cloud/ipfs/')
      .filter((url) => /^https?:\/\//i.test(url));
    if (artwork.sourceUrls.length) void loadArtwork();
  }
  return texture;
}

// ── Timeline / Visibility ──────────────────────────────────────────────────
function _isInWindow(ageDays) {
  return ageDays >= _timelineOffsetDays && ageDays < (_timelineOffsetDays + WINDOW_DAYS);
}

function _nftKey(nft) {
  return nft.contractAddress ? `${nft.chainId || 8453}:${nft.contractAddress.toLowerCase()}:${nft.tokenId}` : String(nft.tokenId);
}

function _nftSpreadSeed(nft) {
  if (!nft.contractAddress || nft.contractAddress.toLowerCase() === '0xe63ec9f8228720baac2fd528c0a6d06b3dc5439b') return nft.tokenId ?? 0;
  let seed = 0;
  for (const character of _nftKey(nft)) seed = (Math.imul(seed, 31) + character.charCodeAt(0)) >>> 0;
  return seed;
}

function _nftRow(nft) {
  return document.querySelector(nft.contractAddress
    ? `.dnft-list-item[data-nft-id="${_nftKey(nft)}"]`
    : `.dnft-list-item[data-token-id="${nft.tokenId}"]`);
}

function _updateVisibility() {
  for (const { mesh } of _allNFTs) {
    const { ageDays } = mesh.userData;
    const pinned = mesh.userData.pinnedVisible || _nftKey(mesh.userData.nft) === _nowPlayingKey;
    mesh.visible = pinned || (_isInWindow(ageDays) && _matchesArtist(mesh.userData.nft));
  }
  let matched = 0;
  for (const { nft } of _allNFTs) {
    const visible = _matchesArtist(nft);
    if (visible) matched++;
    const row = _nftRow(nft);
    if (row) row.hidden = !visible;
  }
  const count = document.getElementById('dnft-list-count');
  if (count) count.textContent = `${matched} of ${_allNFTs.length} tracks`;
  const badge = document.getElementById('dnft-list-count-badge');
  if (badge) badge.textContent = String(matched);
  const summary = document.getElementById('artist-filter-count');
  if (summary) summary.textContent = `${matched} track${matched === 1 ? '' : 's'}`;
}

function _artistKey(nft) {
  return nftArtistKey(nft);
}

function _artistLabel(nft) {
  const name = nft.artistName || nft.uploader || nft.description?.match(/^Shared through DecentJukebox by (.+)$/)?.[1];
  const address = nft.artist || nft.creator || '';
  return name ? `${name}${address ? ` · ${_shortAddr(address)}` : ''}` : _shortAddr(address) || 'Unknown artist';
}

function _matchesArtist(nft) {
  return !_activeArtist || _artistKey(nft) === _activeArtist;
}

function _refreshArtistFilters() {
  const artists = new Map(_catalogArtists.map(artist => [artist.value, artist.label]));
  for (const { nft } of _allNFTs) artists.set(_artistKey(nft), _artistLabel(nft));
  const entries = [...artists].sort((first, second) => first[1].localeCompare(second[1]));
  for (const id of ['scene-artist-filter', 'archive-artist-filter']) {
    const select = document.getElementById(id);
    if (!select) continue;
    select.replaceChildren(new Option('All artists', ''), ...entries.map(([value, label]) => new Option(label, value)));
    select.value = _activeArtist;
  }
}

function _bindArtistFilters() {
  for (const id of ['scene-artist-filter', 'archive-artist-filter']) {
    document.getElementById(id)?.addEventListener('change', (event) => {
      _activeArtist = event.target.value;
      _refreshArtistFilters();
      _updateVisibility();
      _loadNFTs(true);
    });
  }
  document.getElementById('archive-search')?.addEventListener('input', event => {
    _archiveQuery = event.target.value;
    clearTimeout(_archiveTimer);
    _archiveRequest?.abort();
    _archiveTimer = setTimeout(() => _loadNFTs(true), 250);
  });
  const header = document.querySelector('decent-header');
  if (header && typeof ResizeObserver !== 'undefined') {
    customElements.whenDefined('decent-header').then(() => {
      const shell = header.shadowRoot?.querySelector('header') || header;
      const measure = () => {
        const bottom = Math.max(header.getBoundingClientRect().bottom, shell.getBoundingClientRect().bottom, 1);
        document.documentElement.style.setProperty('--header-height', `${bottom}px`);
      };
      const observer = new ResizeObserver(measure);
      observer.observe(header);
      observer.observe(shell);
      measure();
    });
  }
}

function _moveCameraToOffset() {
  const targetZ = -_timelineOffsetDays * UNITS_PER_DAY;
  _camera.position.set(_camera.position.x, _camera.position.y, targetZ + _homeCameraDistance());
  if (_controls) {
    _controls.target.set(0, 0, targetZ);
    _controls.update();
  }
}

// ── Timeline Navigation Binding ─────────────────────────────────────────────
function _bindTimelineNav() {
  const backBtn = document.getElementById('timeline-back-btn');
  const fwdBtn  = document.getElementById('timeline-forward-btn');
  const slider  = document.getElementById('timeline-slider');

  if (backBtn) {
    backBtn.addEventListener('click', () => setTimelineOffset(_timelineOffsetDays + NAV_STEP_DAYS));
  }
  if (fwdBtn) {
    fwdBtn.addEventListener('click', () => setTimelineOffset(_timelineOffsetDays - NAV_STEP_DAYS));
  }
  if (slider) {
    slider.addEventListener('input', () => setTimelineOffset(Number(slider.value)));
  }
  document.querySelectorAll('[data-camera-action]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!_controls) return;
      const action = button.dataset.cameraAction;
      const offset = _camera.position.clone().sub(_controls.target);
      if (action === 'left' || action === 'right') {
        offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), action === 'left' ? Math.PI / 12 : -Math.PI / 12);
      } else if (action === 'up' || action === 'down') {
        offset.addScaledVector(new THREE.Vector3(0, 1, 0), action === 'up' ? 1.8 : -1.8);
      } else if (action === 'in' || action === 'out') {
        offset.multiplyScalar(action === 'in' ? .8 : 1.25);
        offset.clampLength(_controls.minDistance, _controls.maxDistance);
      } else {
        _camera.position.set(0, 8, _homeCameraDistance());
        _moveCameraToOffset();
        return;
      }
      _camera.position.copy(_controls.target).add(offset);
      _controls.update();
    });
  });

  _updateNavUI();
}

function _updateNavUI() {
  const slider  = document.getElementById('timeline-slider');
  const label   = document.getElementById('timeline-label');
  const fwdBtn  = document.getElementById('timeline-forward-btn');
  const backBtn = document.getElementById('timeline-back-btn');

  if (slider) slider.value = _timelineOffsetDays;
  if (fwdBtn)  fwdBtn.disabled  = _timelineOffsetDays <= 0;
  if (backBtn) backBtn.disabled = _timelineOffsetDays >= MAX_NAV_DAYS - WINDOW_DAYS;

  if (label) {
    if (_timelineOffsetDays === 0) {
      label.textContent = '🕐 Now';
    } else {
      const end = Math.round(_timelineOffsetDays + WINDOW_DAYS);
      label.textContent = `${Math.round(_timelineOffsetDays)}–${end} days ago`;
    }
  }
}

// ── Archive drawer ─────────────────────────────────────────────────────────
function _bindArchiveDrawer() {
  const toggle = document.getElementById('dnft-archive-toggle');
  const close = document.getElementById('dnft-list-close');
  const backdrop = document.getElementById('dnft-list-backdrop');
  if (!toggle) return;

  toggle.addEventListener('click', () => {
    _setArchiveOpen(toggle.getAttribute('aria-expanded') !== 'true');
  });
  close?.addEventListener('click', () => _setArchiveOpen(false));
  backdrop?.addEventListener('click', () => _setArchiveOpen(false));
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') _setArchiveOpen(false);
  });
}

function _setArchiveOpen(open) {
  const panel = document.getElementById('dnft-list');
  const toggle = document.getElementById('dnft-archive-toggle');
  const backdrop = document.getElementById('dnft-list-backdrop');
  if (!panel || !toggle) return;

  panel.classList.toggle('is-open', open);
  panel.setAttribute('aria-hidden', String(!open));
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Close music archive' : 'Open music archive');
  backdrop?.classList.toggle('hidden', !open);
}

// ── Right-side List Panel ──────────────────────────────────────────────────
function _addListItem(nft, mesh, isNew = false) {
  const list = document.getElementById('dnft-list-items');
  if (!list) return;

  // Remove placeholder on first real item
  const placeholder = list.querySelector('.dnft-list-empty');
  if (placeholder) placeholder.remove();

  const li = document.createElement('li');
  li.className = 'dnft-list-item';
  li.dataset.tokenId = String(nft.tokenId);
  li.dataset.nftId = _nftKey(nft);
  if (_activeId === _nftKey(nft)) li.classList.add('active');

  const title    = nft.name || nft.title || `Track #${nft.tokenId}`;
  const artist   = _artistLabel(nft);
  const dateStr  = nft.mintedAt
    ? new Date(nft.mintedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })
    : '';

  li.innerHTML = `
    <span class="dnft-list-item-title">${_esc(title)}</span>
    <span class="dnft-list-item-meta">${artist ? _esc(artist) : ''}${dateStr ? ` · ${dateStr}` : ''}</span>
  `;

  li.addEventListener('click', () => {
    _selectNFT(nft, mesh, li, true, { play: false });
    _setArchiveOpen(false);
  });

  // Prepend so newest is at the top (items are pushed via unshift in _spawnMesh)
  if (isNew) list.prepend(li);
  else list.append(li);

  // Update count badge
  const countEl = document.getElementById('dnft-list-count');
  if (countEl) countEl.textContent = `${_allNFTs.length} track${_allNFTs.length !== 1 ? 's' : ''}`;
  const badge = document.getElementById('dnft-list-count-badge');
  if (badge) badge.textContent = String(_allNFTs.length);
}

function _markListEmpty(msg) {
  const list = document.getElementById('dnft-list-items');
  if (!list) return;
  list.innerHTML = `<li class="dnft-list-empty">${_esc(msg)}</li>`;
  const badge = document.getElementById('dnft-list-count-badge');
  if (badge) badge.textContent = '0';
}

// Show or hide the spinner inside the DNFT list panel.
function _showSpinner(show) {
  const spinner = document.getElementById('dnft-list-spinner');
  if (!spinner) return;
  spinner.classList.toggle('hidden', !show);
}

// The archive fetches another bounded page only when requested.
function _bindShowAllBtn() {
  const btn = document.getElementById('dnft-show-all-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    _loadNFTs(_archiveNext === 0 || _archiveNext === null);
  });
}

// ── NFT Selection ──────────────────────────────────────────────────────────
function _selectNFT(nft, mesh, listItem, showCard = true, options = {}) {
  _activeId = _nftKey(nft);
  if (options.pinVisible) mesh.userData.pinnedVisible = true;

  // Highlight active list item
  document.querySelectorAll('.dnft-list-item').forEach(el => el.classList.remove('active'));
  if (listItem) {
    listItem.classList.add('active');
    listItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } else {
    // Find by tokenId and highlight
    const found = _nftRow(nft);
    if (found) {
      found.classList.add('active');
      found.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // If NFT is outside the current window, pan to show it
  const { ageDays } = mesh.userData;
  if (!_isInWindow(ageDays)) {
    _timelineOffsetDays = Math.max(0, Math.min(ageDays - WINDOW_DAYS / 2, MAX_NAV_DAYS - WINDOW_DAYS));
    _updateVisibility();
    _moveCameraToOffset();
    _updateNavUI();
  }

  if (options.play !== false) _playNFT(nft);
  if (showCard) {
    if (_controls) {
      _controls.target.copy(mesh.position);
      _camera.position.copy(mesh.position).add(new THREE.Vector3(0, 2, 10));
      _controls.update();
    }
    renderNFTCard(nft);
    window._currentBuskerWallet = nft.tipWallet || '';
  }
}

function _focusNowPlaying(mesh) {
  if (!_controls || !_camera || !mesh) return;
  _controls.target.copy(mesh.position);
  _camera.position.copy(mesh.position).add(new THREE.Vector3(0, 2, 10));
  _controls.update();
}

function _activeMediaElement() {
  const videoStage = document.getElementById('radio-video-stage');
  const videoPlayer = document.getElementById('radio-video-player');
  if (videoStage && !videoStage.hidden && videoPlayer) return videoPlayer;
  return document.getElementById('audio-player');
}

function _prefersReducedMotion() {
  if (_nowPlayingReducedMotion == null) {
    _nowPlayingReducedMotion = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : { matches: false };
  }
  return Boolean(_nowPlayingReducedMotion?.matches);
}

function _releaseNowPlayingAnalyser() {
  if (_nowPlayingMediaSource?.disconnect) {
    try { _nowPlayingMediaSource.disconnect(); } catch {}
  }
  if (_nowPlayingChannelSplitter?.disconnect) {
    try { _nowPlayingChannelSplitter.disconnect(); } catch {}
  }
  if (_nowPlayingLeftAnalyser?.disconnect) {
    try { _nowPlayingLeftAnalyser.disconnect(); } catch {}
  }
  if (_nowPlayingRightAnalyser?.disconnect) {
    try { _nowPlayingRightAnalyser.disconnect(); } catch {}
  }
  if (_nowPlayingAnalyser?.disconnect) {
    try { _nowPlayingAnalyser.disconnect(); } catch {}
  }
  _nowPlayingMediaSource = null;
  _nowPlayingChannelSplitter = null;
  _nowPlayingLeftAnalyser = null;
  _nowPlayingRightAnalyser = null;
  _nowPlayingAnalyser = null;
  _nowPlayingAudioData = null;
  _nowPlayingLeftWaveData = null;
  _nowPlayingRightWaveData = null;
  _nowPlayingFrequencyData = null;
}

function _ensureNowPlayingAnalyser(media) {
  if (!media) return null;
  if (document.hidden || _prefersReducedMotion()) return null;
  if (_nowPlayingMedia === media && (_nowPlayingLeftAnalyser || _nowPlayingAnalyser)) return _nowPlayingLeftAnalyser || _nowPlayingAnalyser;
  _releaseNowPlayingAnalyser();
  _nowPlayingMedia = media;
  const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextCtor) return null;
  try {
    _nowPlayingAudioContext ||= new AudioContextCtor();
    if (_nowPlayingAudioContext.state === 'suspended') _nowPlayingAudioContext.resume?.().catch?.(() => {});
    _nowPlayingMediaSource = _nowPlayingAudioContext.createMediaElementSource(media);
    _nowPlayingAnalyser = _nowPlayingAudioContext.createAnalyser();
    _nowPlayingAnalyser.fftSize = 256;
    _nowPlayingAnalyser.smoothingTimeConstant = 0.25;
    _nowPlayingAudioData = new Uint8Array(_nowPlayingAnalyser.fftSize);
    _nowPlayingFrequencyData = new Uint8Array(_nowPlayingAnalyser.frequencyBinCount);
    _nowPlayingMediaSource.connect(_nowPlayingAnalyser);
    _nowPlayingMediaSource.connect(_nowPlayingAudioContext.destination);
    if (typeof _nowPlayingAudioContext.createChannelSplitter === 'function') {
      _nowPlayingChannelSplitter = _nowPlayingAudioContext.createChannelSplitter(2);
      _nowPlayingLeftAnalyser = _nowPlayingAudioContext.createAnalyser();
      _nowPlayingRightAnalyser = _nowPlayingAudioContext.createAnalyser();
      for (const analyser of [_nowPlayingLeftAnalyser, _nowPlayingRightAnalyser]) {
       analyser.fftSize = 128;
       analyser.smoothingTimeConstant = 0.2;
      }
      _nowPlayingLeftWaveData = new Uint8Array(_nowPlayingLeftAnalyser.fftSize);
      _nowPlayingRightWaveData = new Uint8Array(_nowPlayingRightAnalyser.fftSize);
      _nowPlayingMediaSource.connect(_nowPlayingChannelSplitter);
      _nowPlayingChannelSplitter.connect(_nowPlayingLeftAnalyser, 0);
      _nowPlayingChannelSplitter.connect(_nowPlayingRightAnalyser, 1);
    }
  } catch (error) {
    console.warn('[space] Failed to build analyser for now-playing audio:', error.message);
    _releaseNowPlayingAnalyser();
    return null;
  }
  return _nowPlayingLeftAnalyser || _nowPlayingAnalyser;
}

// Shares the single Web Audio graph on the radio element (createMediaElementSource is once-per-element).
export function readNowPlayingSpectrum(out) {
  const media = _activeMediaElement();
  if (!out || !media || media.paused || media.ended) return false;
  if (!_ensureNowPlayingAnalyser(media) || !_nowPlayingAnalyser) return false;
  if (_nowPlayingAudioContext?.state === 'suspended') return false;
  _nowPlayingAnalyser.getByteFrequencyData(out);
  return true;
}

function _updateNowPlayingPulse() {
  if (!_nowPlayingMesh) return;
  const mesh = _nowPlayingMesh;
  const media = _activeMediaElement();
  const ud = mesh.userData;
  const artwork = ud.artworkTexture?.userData?.artwork || mesh.material?.map?.userData?.artwork || null;
  ud.baseScale ??= mesh.scale.x || 1;
  ud.baseOpacity ??= mesh.material?.opacity ?? 1;
  const glow = ud.nowPlayingGlow || _ensureNowPlayingGlow(mesh);
  const edge = ud.nowPlayingEdge || _ensureNowPlayingEdge(mesh);
  const now = performance.now();
  const dt = ud.nowPlayingLastTick ? Math.max(16, now - ud.nowPlayingLastTick) : 16;
  ud.nowPlayingLastTick = now;
  const cameraDistance = _camera?.position?.distanceTo?.(mesh.position) ?? 0;
  const zoomBoost = Math.max(0, Math.min(1, (cameraDistance - 10) / 24));

  let level = 0;
  const playing = media && !media.paused && !media.ended && !document.hidden && !_prefersReducedMotion();
  artwork?.setActive?.(playing);
  if (playing && artwork?.isGif) artwork.tick?.();
  if (playing) {
    const analyser = _ensureNowPlayingAnalyser(media);
    if (analyser && _nowPlayingAudioData) {
      _nowPlayingFrequencyData ||= new Uint8Array(analyser.frequencyBinCount || 1);
      analyser.getByteTimeDomainData(_nowPlayingAudioData);
      analyser.getByteFrequencyData(_nowPlayingFrequencyData);
      const channels = [];
      if (_nowPlayingLeftAnalyser && _nowPlayingLeftWaveData && _nowPlayingRightAnalyser && _nowPlayingRightWaveData) {
       _nowPlayingLeftAnalyser.getByteTimeDomainData(_nowPlayingLeftWaveData);
       _nowPlayingRightAnalyser.getByteTimeDomainData(_nowPlayingRightWaveData);
       channels.push(_nowPlayingLeftWaveData, _nowPlayingRightWaveData);
      } else {
       channels.push(_nowPlayingAudioData, _nowPlayingAudioData);
      }
      let sum = 0;
      for (const sample of _nowPlayingAudioData) {
       const centered = (sample - 128) / 128;
       sum += centered * centered;
      }
      const rms = Math.sqrt(sum / _nowPlayingAudioData.length);
      const bassBins = Math.max(1, Math.floor((_nowPlayingFrequencyData?.length || 1) * 0.12));
      let bassSum = 0;
      let bassPeak = 0;
      for (let i = 0; i < bassBins; i += 1) {
       const value = _nowPlayingFrequencyData[i] || 0;
       bassSum += value;
       if (value > bassPeak) bassPeak = value;
      }
      const bassEnergy = bassSum / (bassBins * 255);
      ud.nowPlayingBassAverage = ud.nowPlayingBassAverage == null ? bassEnergy : (ud.nowPlayingBassAverage * 0.92 + bassEnergy * 0.08);
      const bassBeat = Math.max(0, bassEnergy - ud.nowPlayingBassAverage * 1.05) + (bassPeak / 255) * 0.08;
      const waveform = _waveformLevel(channels[0], channels[1]);
      ud.nowPlayingSilenceSince = null;
      level = Math.min(1, (rms * 2.1) + (bassBeat * 3.1) + (waveform * 0.45));
      ud.nowPlayingColorLevel = Math.min(1, 0.2 + bassEnergy * 0.75);
      ud.nowPlayingBeatLevel = Math.min(1, bassBeat * 2.25);
      ud.nowPlayingWaveLevel = Math.min(1, waveform);
    } else {
      level = _fallbackNowPlayingPulse(media, now);
      ud.nowPlayingColorLevel = 0.35;
      ud.nowPlayingBeatLevel = 0.2;
      ud.nowPlayingWaveLevel = 0.2;
    }
  }

  if (!playing) {
    ud.pulseLevel = _approachLevel(ud.pulseLevel || 0, 0, 200, dt);
    ud.nowPlayingBeatLevel = _approachLevel(ud.nowPlayingBeatLevel || 0, 0, 200, dt);
    ud.nowPlayingWaveLevel = _approachLevel(ud.nowPlayingWaveLevel || 0, 0, 220, dt);
    ud.nowPlayingSilenceSince = null;
    const settleLevel = Math.max(ud.pulseLevel || 0, ud.nowPlayingBeatLevel || 0, ud.nowPlayingWaveLevel || 0);
    mesh.scale.setScalar(ud.baseScale);
    if (mesh.material) mesh.material.opacity = ud.baseOpacity;
    if (glow?.material) glow.material.opacity = (ud.nowPlayingGlowBaseOpacity ?? glow.material.opacity) * Math.max(0, Math.min(1, settleLevel * 2.5));
    if (glow) glow.scale.setScalar(ud.nowPlayingGlowBaseScale ?? 1);
    _updateNowPlayingEdge(mesh, settleLevel, dt, true, zoomBoost, now);
    _restoreNowPlayingNeighborDimming(mesh);
    return;
  }

  ud.pulseLevel = _approachLevel(ud.pulseLevel || 0, level, 30, 200, dt);
  ud.nowPlayingBeatLevel = _approachLevel(ud.nowPlayingBeatLevel || 0, ud.nowPlayingBeatLevel ? Math.max(level, ud.nowPlayingBeatLevel) : level, 30, 200, dt);
  ud.nowPlayingWaveLevel = _approachLevel(ud.nowPlayingWaveLevel || 0, ud.nowPlayingWaveLevel ? Math.max(level, ud.nowPlayingWaveLevel) : level, 30, 200, dt);
  const pulse = Math.max(0, Math.min(1, ud.pulseLevel));
  const beat = Math.max(0, Math.min(1, ud.nowPlayingBeatLevel || 0));
  const wave = Math.max(0, Math.min(1, ud.nowPlayingWaveLevel || 0));
  mesh.scale.setScalar(ud.baseScale * (1 + pulse * 0.08 + beat * 0.02));
  if (mesh.material) mesh.material.opacity = ud.baseOpacity * (0.55 + pulse * 0.35);
  if (glow?.material) glow.material.opacity = Math.min(0.96, (ud.nowPlayingGlowBaseOpacity ?? 0.18) + pulse * 0.55 + beat * 0.12);
  if (glow) glow.scale.setScalar((ud.nowPlayingGlowBaseScale ?? 1) * (1 + pulse * 0.18 + beat * 0.1));
  _updateNowPlayingEdge(mesh, wave, dt, false, zoomBoost, now);
  _applyNowPlayingNeighborDimming(mesh, pulse, zoomBoost);
}

function _ensureNowPlayingGlow(mesh) {
  const ud = mesh.userData || (mesh.userData = {});
  if (ud.nowPlayingGlow) return ud.nowPlayingGlow;
  const glowMaterial = new THREE.MeshBasicMaterial({
    color: 0xffedbd,
    transparent: true,
    opacity: 0.18,
    side: THREE.DoubleSide,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending ?? undefined,
  });
  const glow = new THREE.Mesh(new THREE.CircleGeometry(2.65, 64), glowMaterial);
  glow.position.set(0, 0, -0.04);
  glow.scale.setScalar(1.12);
  glow.renderOrder = 21;
  mesh.add(glow);
  ud.nowPlayingGlow = glow;
  ud.nowPlayingGlowBaseOpacity = glowMaterial.opacity;
  ud.nowPlayingGlowBaseScale = glow.scale.x || 1;
  return glow;
}

function _ensureNowPlayingEdge(mesh) {
  const ud = mesh.userData || (mesh.userData = {});
  if (ud.nowPlayingEdge) return ud.nowPlayingEdge;
  const segments = 64;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array((segments + 1) * 3);
  const colors = new Float32Array((segments + 1) * 3);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.LineBasicMaterial({
    transparent: true,
    opacity: 0,
    vertexColors: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending ?? undefined,
  });
  const LineCtor = THREE.LineLoop || THREE.Line;
  const specs = [
    { scale: 1.28, opacity: 1, order: 24 },
    { scale: 1.46, opacity: 0.56, order: 23 },
    { scale: 1.68, opacity: 0.34, order: 22 },
    { scale: 1.92, opacity: 0.18, order: 21 },
  ];
  const layers = specs.map((spec, index) => {
    const layer = new LineCtor(geometry, index === 0 ? material : new THREE.LineBasicMaterial({
      transparent: true,
      opacity: 0,
      vertexColors: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending ?? undefined,
    }));
    layer.position.set(0, 0, -0.06);
    layer.scale.setScalar(spec.scale);
    layer.renderOrder = spec.order;
    layer.userData = { ...(layer.userData || {}), layerSpec: spec };
    mesh.add(layer);
    return layer;
  });
  const moonMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.98,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending ?? undefined,
  });
  const moons = specs.map((spec, index) => {
    const moon = new THREE.Mesh(
      new THREE.SphereGeometry(0.11 + index * 0.02, 18, 14),
      moonMaterial.clone ? moonMaterial.clone() : new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.98,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending ?? undefined,
      }),
    );
    moon.position.set(1.98, 0, 0.12 + index * 0.01);
    moon.renderOrder = spec.order + 10;
    moon.userData = { ...(moon.userData || {}), moonIndex: index, moonPhase: Math.random() };
    layers[index].add(moon);
    return moon;
  });
  const edge = layers[0];
  ud.nowPlayingEdgeLayers = layers;
  ud.nowPlayingMoonLayers = moons;
  ud.nowPlayingEdge = edge;
  ud.nowPlayingEdgeSegments = segments;
  ud.nowPlayingEdgePositions = positions;
  ud.nowPlayingEdgeColors = colors;
  ud.nowPlayingEdgeBaseScale = edge.scale.x || 1;
  ud.nowPlayingEdgeBaseOpacity = material.opacity;
  return edge;
}

function _resetNowPlayingPulse(mesh) {
  if (!mesh) return;
  const ud = mesh.userData || {};
  ud.artworkTexture?.userData?.artwork?.setActive?.(false);
  ud.pulseLevel = 0;
  ud.nowPlayingBeatLevel = 0;
  ud.nowPlayingWaveLevel = 0;
  ud.nowPlayingSilenceSince = null;
  ud.nowPlayingLastTick = null;
  if (mesh.material) mesh.material.opacity = ud.baseOpacity ?? mesh.material.opacity ?? 1;
  const glow = ud.nowPlayingGlow;
  if (glow?.material) glow.material.opacity = ud.nowPlayingGlowBaseOpacity ?? glow.material.opacity ?? 0.18;
  if (glow) glow.scale.setScalar(ud.nowPlayingGlowBaseScale ?? 1);
  if (ud.baseScale) mesh.scale.setScalar(ud.baseScale);
  mesh.renderOrder = 0;
  _updateNowPlayingEdge(mesh, 0, 0, true);
  _restoreNowPlayingNeighborDimming(mesh);
}

function _fallbackNowPlayingPulse(media, now) {
  const phase = ((now + ((media?.currentTime || 0) * 1000)) / 250) * Math.PI;
  return 0.5 + 0.5 * Math.sin(phase);
}

function _approachLevel(current, target, attackMs, releaseMs, dtMs) {
  const delta = Math.max(1, dtMs || 16);
  const timeConstant = target > current ? attackMs : releaseMs;
  const factor = 1 - Math.exp(-delta / Math.max(1, timeConstant));
  return current + (target - current) * factor;
}

function _waveformLevel(left, right) {
  if (!left && !right) return 0;
  const compute = (samples) => {
    if (!samples?.length) return 0;
    let sum = 0;
    for (const sample of samples) {
      const centered = (sample - 128) / 128;
      sum += centered * centered;
    }
    return Math.sqrt(sum / samples.length);
  };
  return Math.min(1, (compute(left) + compute(right)) * 1.15);
}

function _updateNowPlayingEdge(mesh, intensity = 0, dt = 16, settle = false, zoomBoost = 0, now = performance.now()) {
  const ud = mesh.userData || {};
  const edge = ud.nowPlayingEdge || _ensureNowPlayingEdge(mesh);
  if (!edge?.geometry) return;
  const positions = ud.nowPlayingEdgePositions;
  const colors = ud.nowPlayingEdgeColors;
  const segments = ud.nowPlayingEdgeSegments || 64;
  const layers = ud.nowPlayingEdgeLayers || [edge];
  const moons = ud.nowPlayingMoonLayers || [];
  const left = _nowPlayingLeftWaveData;
  const right = _nowPlayingRightWaveData;
  const baseRadius = 1.98;
  const maxOffset = settle ? 0 : 0.5;
  const hueSeed = ud.nowPlayingHueSeed ?? 0;
  const phase = (now / (2200 - zoomBoost * 900) + hueSeed) % 1;
  const brightness = Math.max(0.42, Math.min(0.72, 0.5 + zoomBoost * 0.16 + intensity * 0.12));
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const angle = t * Math.PI * 2 - Math.PI / 2;
    const channelSamples = i <= segments / 2 ? left : right;
    const channel = i <= segments / 2 ? 0 : 1;
    const waveformIndex = channelSamples?.length ? Math.min(channelSamples.length - 1, Math.floor(t * (channelSamples.length - 1))) : 0;
    const sample = channelSamples?.length ? ((channelSamples[waveformIndex] - 128) / 128) : 0;
    const radius = baseRadius + (Math.max(0, sample) * maxOffset * (0.35 + intensity)) + (intensity * 0.08);
    positions[i * 3 + 0] = Math.cos(angle) * radius;
    positions[i * 3 + 1] = Math.sin(angle) * radius;
    positions[i * 3 + 2] = 0;
    const hue = (phase + (t * (0.84 + zoomBoost * 0.1)) + channel * 0.075) % 1;
    const [r, g, b] = _hslToRgb(hue, 0.98, Math.min(0.95, brightness + Math.abs(sample) * 0.06));
    colors[i * 3 + 0] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  edge.geometry.attributes.position.needsUpdate = true;
  edge.geometry.attributes.color.needsUpdate = true;
  const opacity = settle
    ? Math.max(0, Math.min(0.72, intensity * 0.12))
    : Math.max(0, Math.min(1, 0.2 + intensity * 0.78 + zoomBoost * 0.08));
  const scaleOffsets = [1, 1.07, 1.15, 1.24];
  const opacityOffsets = [1, 0.42, 0.24, 0.12];
  layers.forEach((layer, index) => {
    layer.material.opacity = opacity * (opacityOffsets[index] || 1);
    layer.scale.setScalar((ud.nowPlayingEdgeBaseScale ?? 1) * (scaleOffsets[index] || 1) * (1 + intensity * 0.14));
    _applyMaterialColor(layer.material, ..._hslToRgb((phase + 0.14 + index * 0.03) % 1, 0.95, Math.min(0.92, brightness + 0.08 + index * 0.03)));
  });
  moons.forEach((moon, index) => {
    const moonPhase = (moon.userData?.moonPhase ?? 0) + now / (6200 + index * 900);
    const moonAngle = (moonPhase % 1) * Math.PI * 2 - Math.PI / 2;
    const sampleOffset = (moonAngle + Math.PI / 2) / (Math.PI * 2);
    const normalized = ((sampleOffset % 1) + 1) % 1;
    const sampleChannel = normalized <= 0.5 ? left : right;
    const sampleIndex = sampleChannel?.length ? Math.min(sampleChannel.length - 1, Math.floor(normalized * (sampleChannel.length - 1))) : 0;
    const sample = sampleChannel?.length ? ((sampleChannel[sampleIndex] - 128) / 128) : 0;
    const ringBounce = Math.max(0, sample) * maxOffset * 0.78 + intensity * 0.06;
    const orbitRadius = baseRadius + ringBounce;
    moon.position.set(
      Math.cos(moonAngle) * orbitRadius,
      Math.sin(moonAngle) * orbitRadius,
      0.1 + ringBounce * 0.35,
    );
    moon.scale.setScalar(1 + intensity * 0.18 + ringBounce * 0.85);
    moon.material.opacity = Math.min(1, 0.78 + intensity * 0.2 + ringBounce * 0.32);
    _applyMaterialColor(moon.material, ..._hslToRgb((phase + 0.24 + index * 0.17) % 1, 0.88, Math.min(0.96, brightness + 0.18 + ringBounce * 0.1)));
  });
  if (mesh.userData.nowPlayingGlow?.material) {
    _applyMaterialColor(mesh.userData.nowPlayingGlow.material, ..._hslToRgb((phase + 0.05) % 1, 0.9, Math.min(0.94, brightness + 0.2)));
  }
}

function _hslToRgb(h, s, l) {
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const hue = ((h % 1) + 1) % 1;
  if (s <= 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, hue + 1 / 3), hue2rgb(p, q, hue), hue2rgb(p, q, hue - 1 / 3)];
}

function _applyMaterialColor(material, r, g, b) {
  if (!material) return;
  if (material.color?.setRGB) {
    material.color.setRGB(r, g, b);
    return;
  }
  material.color = { r, g, b, setRGB(rr, gg, bb) { this.r = rr; this.g = gg; this.b = bb; } };
}

function _restoreNowPlayingNeighborDimming(mesh) {
  for (const { mesh: other } of _allNFTs) {
    if (!other || other === mesh || !other.material) continue;
    const ud = other.userData || {};
    other.material.opacity = ud.baseOpacity ?? other.material.opacity ?? 1;
    other.renderOrder = ud.baseRenderOrder ?? 0;
  }
}

function _applyNowPlayingNeighborDimming(mesh, pulse = 0, zoomBoost = 0) {
  const center = mesh?.position;
  if (!center?.distanceTo) return;
  const orbitRadius = 4.2 + pulse * 1.6 + zoomBoost * 1.2;
  for (const { mesh: other } of _allNFTs) {
    if (!other || other === mesh || !other.visible || !other.material) continue;
    const ud = other.userData || {};
    ud.baseOpacity ??= other.material.opacity ?? 1;
    ud.baseRenderOrder ??= other.renderOrder || 0;
    const distance = center.distanceTo(other.position || center);
    const overlap = Math.max(0, 1 - distance / orbitRadius);
    const targetOpacity = ud.baseOpacity * Math.max(0.04, 0.12 - overlap * 0.06);
    other.material.opacity = targetOpacity;
    other.renderOrder = overlap > 0.03 ? -1 : ud.baseRenderOrder;
  }
}

// ── Animation Loop ─────────────────────────────────────────────────────────
function _animate() {
  _animFrameId = requestAnimationFrame(_animate);

  // Update live age for all meshes and billboard toward camera
  for (const mesh of _nftMeshes) {
    const ud = mesh.userData;
    ud.ageMs   = Date.now() - ud.mintedAt;
    ud.ageDays = ud.ageMs / (24 * 60 * 60 * 1000);

    // Billboard: always face camera for readability
    if (mesh.visible) {
      mesh.lookAt(_camera.position);
    }
  }

  _updateNowPlayingPulse();

  // WASD / Arrow keys are always active — they move the camera AND the
  // OrbitControls target together so the orbit centre follows the flight.
  // Tab-activated ship mode additionally disables mouse orbit.
  _processFlyKeys();

  if (_controls) {
    _controls.update();
  }

  _renderer.render(_scene, _camera);
}

// Move the camera (and, in non-ship mode, the OrbitControls target) via
// keyboard input.  Moving both together preserves the orbit reference point
// so the user can still orbit with the mouse after flying.
function _processFlyKeys() {
  if (document.querySelector('dialog[open]')) return;
  const forward = new THREE.Vector3();
  _camera.getWorldDirection(forward);

  const right = new THREE.Vector3();
  right.crossVectors(forward, _camera.up).normalize();

  const up = new THREE.Vector3(0, 1, 0);

  const delta = new THREE.Vector3();

  if (_keysDown['w'] || _keysDown['arrowup'])    delta.addScaledVector(forward, _ship.speed);
  if (_keysDown['s'] || _keysDown['arrowdown'])  delta.addScaledVector(forward, -_ship.speed);
  if (_keysDown['a'] || _keysDown['arrowleft'])  delta.addScaledVector(right, -_ship.speed);
  if (_keysDown['d'] || _keysDown['arrowright']) delta.addScaledVector(right, _ship.speed);
  if (_keysDown['q'])                             delta.addScaledVector(up, _ship.speed);
  if (_keysDown['e'])                             delta.addScaledVector(up, -_ship.speed);

  if (delta.lengthSq() > 0) {
    _camera.position.add(delta);
    // In hybrid mode keep the orbit target in sync so mouse-orbit still works
    // naturally after flying.  In pure ship mode the target is irrelevant.
    if (!_shipMode && _controls) {
      _controls.target.add(delta);
    }
  }
}

// ── Input Handlers ─────────────────────────────────────────────────────────
function _onKeyDown(e) {
  if (e.target?.closest?.('input, textarea, select, button, dialog, [contenteditable="true"]')) return;
  if (document.querySelector('dialog[open]')) return;
  const key = e.key?.toLowerCase();
  if (!key) return;
  _keysDown[key] = true;

  if (key.startsWith('arrow')) e.preventDefault();
}

function _onKeyUp(e) {
  const key = e.key?.toLowerCase();
  if (!key) return;
  _keysDown[key] = false;
}

function _onMouseMove(e) {
  _mouse.x =  (e.clientX / window.innerWidth)  * 2 - 1;
  _mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
}

function _onCanvasClick(e) {
  // Ignore clicks that land on DOM elements layered above the canvas
  if (e.target !== _renderer.domElement) return;
  if (_pointerStart && Math.hypot(e.clientX - _pointerStart.x, e.clientY - _pointerStart.y) > 6) return;

  _mouse.x =  (e.clientX / window.innerWidth)  * 2 - 1;
  _mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

  _raycaster.setFromCamera(_mouse, _camera);
  const hits = _raycaster.intersectObjects(_nftMeshes.filter(m => m.visible));

  if (hits.length > 0) {
    const mesh = hits[0].object;
    const { nft } = mesh.userData;
    _selectNFT(nft, mesh, null, true, { play: false });
  }
}

function _onResize() {
  _camera.aspect = _aspect();
  _camera.updateProjectionMatrix();
  _renderer.setSize(window.innerWidth, window.innerHeight);
}

// ── Helpers ────────────────────────────────────────────────────────────────
function _aspect() {
  return window.innerWidth / window.innerHeight;
}

function _homeCameraDistance() {
  return CAM_Z_OFFSET / Math.min(1, _aspect());
}

function _truncate(str, len) {
  return str.length > len ? str.slice(0, len - 1) + '…' : str;
}

function _shortAddr(addr = '') {
  return addr.length > 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function _esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _playNFT(nft) {
  const handled = !document.dispatchEvent(new CustomEvent('dbusk-listen', { cancelable: true, detail: { nft } }));
  if (handled) return;
  const cfg = window.DecentConfig || {};
  const gateway = cfg.ipfsGateway || 'https://gateway.pinata.cloud/ipfs/';
  const audioUrl = (nft.videoUrl || nft.audioUrl || nft.animation_url || '')
    .replace('ipfs://', gateway);

  setNowPlaying({
    nft,
    title:    nft.name || nft.title || `Track #${nft.tokenId}`,
    artist:   nft.artist || nft.creator || '',
    audioUrl,
    mediaType: nft.mediaType || (nft.videoUrl ? 'video/mp4' : ''),
  });
}
