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
//  • Clicking a visible NFT mesh in 3-D also selects and plays it.
//  • Arrow-key / WASD controls (press Tab to toggle) let the user fly through
//    the field.
//
// Dependencies (loaded via CDN in index.html):
//   • THREE  (three.js r128)
//   • OrbitControls  (from three@0.128.0 examples)

import { renderNFTCard } from './nft-card.js';
import { setNowPlaying } from './stage.js';

// ── Timeline constants ────────────────────────────────────────────────────
const UNITS_PER_DAY   = 5;          // 3-D units per day on the Z-axis
const SPREAD_RADIUS   = 6;          // XY scatter radius to avoid overlap
const WINDOW_DAYS     = 30;         // how many days the default view covers
const NAV_STEP_DAYS   = 7;          // days moved per arrow-button press
const MAX_NAV_DAYS    = 365;        // how far back the slider can go

// Camera home position (z offset ahead of the timeline centre)
const CAM_Z_OFFSET = 28;

// ── Global state ──────────────────────────────────────────────────────────
let _renderer, _scene, _camera, _controls;
let _nftMeshes = [];
let _raycaster, _mouse;

let _shipMode  = false;   // true = WASD fly, false = OrbitControls
let _keysDown  = {};
let _animFrameId;

// Timeline navigation
let _timelineOffsetDays = 0;   // how many days back from "now" the window starts

// List & selection state
let _allNFTs   = [];           // { nft, mesh } for every loaded token
let _activeId  = null;         // currently selected tokenId

// Spaceship
const _ship = { speed: 0.12 };

// ── Public API ────────────────────────────────────────────────────────────
export function initSpace() {
  _buildScene();
  _buildControls();
  _addTimelineLine();
  _loadNFTs();
  _animate();
  _bindTimelineNav();
  window.addEventListener('resize', _onResize);
  window.addEventListener('keydown', _onKeyDown);
  window.addEventListener('keyup', _onKeyUp);
}

// Called by mint.js after a new busk is minted — places it at the front.
export function addNFTToSpace(nft) {
  _spawnMesh(nft, true /* isNew */);
}

// Fetch metadata for a single token by ID — used by mint.js for parent preview.
export async function fetchNFTMetaById(tokenId) {
  const cfg = window.DecentConfig || {};
  const contractAddress = cfg.contractAddress;
  if (!contractAddress || contractAddress === '0x0000000000000000000000000000000000000000') return null;

  try {
    const rpcUrl = cfg.rpcUrl || 'https://mainnet.optimism.io';
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const abi = [
      'function uri(uint256 tokenId) view returns (string)',
      'function creatorOf(uint256 tokenId) view returns (address)',
      'function totalMinted(uint256 tokenId) view returns (uint256)',
    ];
    const contract = new ethers.Contract(contractAddress, abi, provider);
    const minted = Number(await contract.totalMinted(tokenId));
    if (minted === 0) return null;
    const uri = await contract.uri(tokenId);
    const creator = await contract.creatorOf(tokenId);
    const meta = await _fetchMetadata(uri);
    return meta ? { tokenId, ...meta, creator } : null;
  } catch (err) {
    console.warn('[space] fetchNFTMetaById failed:', err.message);
    return null;
  }
}

// Move the timeline window to a specific day-offset (called from nav controls).
export function setTimelineOffset(days) {
  _timelineOffsetDays = Math.max(0, Math.min(days, MAX_NAV_DAYS - WINDOW_DAYS));
  _updateVisibility();
  _moveCameraToOffset();
  _updateNavUI();
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
  _camera.position.set(0, 8, CAM_Z_OFFSET);

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
  _renderer.domElement.addEventListener('mousemove', _onMouseMove);
}

function _buildControls() {
  if (typeof THREE.OrbitControls !== 'undefined') {
    _controls = new THREE.OrbitControls(_camera, _renderer.domElement);
    _controls.enableDamping = true;
    _controls.dampingFactor = 0.07;
    _controls.minDistance = 5;
    _controls.maxDistance = 250;
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
async function _loadNFTs() {
  const cfg = window.DecentConfig || {};
  const contractAddress = cfg.contractAddress;
  if (!contractAddress || contractAddress === '0x0000000000000000000000000000000000000000') {
    console.info('[space] No contract address configured — skipping NFT load.');
    _markListEmpty('No contract configured.');
    return;
  }

  try {
    const rpcUrl = cfg.rpcUrl || 'https://mainnet.optimism.io';
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const abi = [
      'function nextTokenId() view returns (uint256)',
      'function uri(uint256 tokenId) view returns (string)',
      'function creatorOf(uint256 tokenId) view returns (address)',
      'function totalMinted(uint256 tokenId) view returns (uint256)',
    ];
    const contract = new ethers.Contract(contractAddress, abi, provider);
    const nextId = Number(await contract.nextTokenId());

    let loaded = 0;
    for (let tokenId = 0; tokenId < nextId; tokenId++) {
      try {
        const minted = Number(await contract.totalMinted(tokenId));
        if (minted === 0) continue;

        const uri = await contract.uri(tokenId);
        const creator = await contract.creatorOf(tokenId);
        const meta = await _fetchMetadata(uri);
        if (meta) {
          _spawnMesh({ tokenId, ...meta, creator }, false);
          loaded++;
        }
      } catch (_) {
        // Non-fatal per-token failure
      }
    }

    if (loaded === 0) {
      _markListEmpty('No tracks minted yet.');
    }
  } catch (err) {
    console.warn('[space] NFT load failed:', err.message);
    _markListEmpty('Could not load tracks.');
  }
}

async function _fetchMetadata(uri) {
  const cfg = window.DecentConfig || {};
  const gateway = cfg.ipfsGateway || 'https://w3s.link/ipfs/';
  const url = uri.startsWith('ipfs://')
    ? uri.replace('ipfs://', gateway)
    : uri;
  try {
    const res = await fetch(url);
    return await res.json();
  } catch {
    return null;
  }
}

// ── Mesh Spawning ──────────────────────────────────────────────────────────
function _spawnMesh(nft, isNew) {
  const mintedAt = nft.mintedAt ? new Date(nft.mintedAt).getTime() : Date.now();
  const ageMs    = Date.now() - mintedAt;
  const ageDays  = ageMs / (24 * 60 * 60 * 1000);

  // Timeline Z position: z=0 is "now", negative Z is the past.
  const z = isNew ? 0 : -ageDays * UNITS_PER_DAY;

  // Deterministic XY spread using golden-angle per tokenId to prevent overlap.
  const seed  = nft.tokenId ?? (Math.random() * 9999);
  const angle = (seed * 137.508) * (Math.PI / 180);
  const x = Math.cos(angle) * SPREAD_RADIUS;
  const y = Math.sin(angle) * SPREAD_RADIUS * 0.3;

  const pos = new THREE.Vector3(x, y, z);

  // Tile geometry
  const geo     = new THREE.PlaneGeometry(3.2, 1.8);
  const texture = _makeNFTTexture(nft);
  const mat     = new THREE.MeshStandardMaterial({
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

  mesh.userData = { nft, mintedAt, ageMs, ageDays, isNew };

  _scene.add(mesh);
  _nftMeshes.push(mesh);

  // Track for list panel (newest first — prepend)
  _allNFTs.unshift({ nft, mesh });
  _addListItem(nft, mesh);

  // Newly minted busk: auto-play and mark as active.
  if (isNew) {
    _selectNFT(nft, mesh, null, false /* skipCard */);
    window._currentBuskerWallet = nft.tipWallet || '';
  }

  return mesh;
}

// ── Canvas texture for NFT tile label ─────────────────────────────────────
function _makeNFTTexture(nft) {
  const canvas = document.createElement('canvas');
  canvas.width  = 512;
  canvas.height = 288;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0d0820';
  ctx.fillRect(0, 0, 512, 288);
  ctx.strokeStyle = 'rgba(240,192,64,0.5)';
  ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, 508, 284);

  ctx.fillStyle = '#f0c040';
  ctx.font = 'bold 32px Bungee, Impact, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(_truncate(nft.name || nft.title || `Track #${nft.tokenId}`, 28), 256, 72);

  ctx.fillStyle = '#a08050';
  ctx.font = '22px sans-serif';
  ctx.fillText(_truncate(nft.artist || nft.creator || '', 34), 256, 110);

  ctx.fillStyle = '#4a4060';
  ctx.font = '18px monospace';
  ctx.fillText(`#${nft.tokenId ?? '?'}`, 256, 240);

  ctx.fillStyle = 'rgba(0,212,170,0.25)';
  ctx.font = '80px sans-serif';
  ctx.fillText('🎵', 256, 190);

  return new THREE.CanvasTexture(canvas);
}

// ── Timeline / Visibility ──────────────────────────────────────────────────
function _isInWindow(ageDays) {
  return ageDays >= _timelineOffsetDays && ageDays < (_timelineOffsetDays + WINDOW_DAYS);
}

function _updateVisibility() {
  for (const { mesh } of _allNFTs) {
    const { ageDays } = mesh.userData;
    mesh.visible = _isInWindow(ageDays);
  }
}

function _moveCameraToOffset() {
  const targetZ = -_timelineOffsetDays * UNITS_PER_DAY;
  _camera.position.set(_camera.position.x, _camera.position.y, targetZ + CAM_Z_OFFSET);
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

// ── Right-side List Panel ──────────────────────────────────────────────────
function _addListItem(nft, mesh) {
  const list = document.getElementById('dnft-list-items');
  if (!list) return;

  // Remove placeholder on first real item
  const placeholder = list.querySelector('.dnft-list-empty');
  if (placeholder) placeholder.remove();

  const li = document.createElement('li');
  li.className = 'dnft-list-item';
  li.dataset.tokenId = String(nft.tokenId);

  const title    = nft.name || nft.title || `Track #${nft.tokenId}`;
  const artist   = nft.artist || _shortAddr(nft.creator || '');
  const dateStr  = nft.mintedAt
    ? new Date(nft.mintedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })
    : '';

  li.innerHTML = `
    <span class="dnft-list-item-title">${_esc(title)}</span>
    <span class="dnft-list-item-meta">${artist ? _esc(artist) : ''}${dateStr ? ` · ${dateStr}` : ''}</span>
  `;

  li.addEventListener('click', () => _selectNFT(nft, mesh, li, true));

  // Prepend so newest is at the top (items are pushed via unshift in _spawnMesh)
  list.prepend(li);

  // Update count badge
  const countEl = document.getElementById('dnft-list-count');
  if (countEl) countEl.textContent = `${_allNFTs.length} track${_allNFTs.length !== 1 ? 's' : ''}`;
}

function _markListEmpty(msg) {
  const list = document.getElementById('dnft-list-items');
  if (!list) return;
  list.innerHTML = `<li class="dnft-list-empty">${_esc(msg)}</li>`;
}

// ── NFT Selection ──────────────────────────────────────────────────────────
function _selectNFT(nft, mesh, listItem, showCard = true) {
  _activeId = nft.tokenId;

  // Highlight active list item
  document.querySelectorAll('.dnft-list-item').forEach(el => el.classList.remove('active'));
  if (listItem) {
    listItem.classList.add('active');
    listItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } else {
    // Find by tokenId and highlight
    const found = document.querySelector(`.dnft-list-item[data-token-id="${nft.tokenId}"]`);
    if (found) {
      found.classList.add('active');
      found.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // If NFT is outside the current window, pan to show it
  const { ageDays } = mesh.userData;
  if (!_isInWindow(ageDays)) {
    setTimelineOffset(Math.max(0, ageDays - WINDOW_DAYS / 2));
  }

  _playNFT(nft);
  if (showCard) {
    renderNFTCard(nft);
    window._currentBuskerWallet = nft.tipWallet || '';
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

  if (_shipMode) {
    _flyShip();
  } else if (_controls) {
    _controls.update();
  }

  _renderer.render(_scene, _camera);
}

function _flyShip() {
  const forward = new THREE.Vector3();
  _camera.getWorldDirection(forward);

  if (_keysDown['w'] || _keysDown['arrowup'])    _camera.position.addScaledVector(forward, _ship.speed);
  if (_keysDown['s'] || _keysDown['arrowdown'])  _camera.position.addScaledVector(forward, -_ship.speed);

  const right = new THREE.Vector3();
  right.crossVectors(forward, _camera.up).normalize();

  if (_keysDown['a'] || _keysDown['arrowleft'])  _camera.position.addScaledVector(right, -_ship.speed);
  if (_keysDown['d'] || _keysDown['arrowright']) _camera.position.addScaledVector(right, _ship.speed);
  if (_keysDown['q'])                             _camera.position.y += _ship.speed;
  if (_keysDown['e'])                             _camera.position.y -= _ship.speed;
}

// ── Input Handlers ─────────────────────────────────────────────────────────
function _onKeyDown(e) {
  const key = e.key?.toLowerCase();
  if (!key) return;
  _keysDown[key] = true;

  if (key === 'tab') {
    e.preventDefault();
    _shipMode = !_shipMode;
    if (_controls) _controls.enabled = !_shipMode;
  }
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

  _mouse.x =  (e.clientX / window.innerWidth)  * 2 - 1;
  _mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

  _raycaster.setFromCamera(_mouse, _camera);
  const hits = _raycaster.intersectObjects(_nftMeshes.filter(m => m.visible));

  if (hits.length > 0) {
    const mesh = hits[0].object;
    const { nft } = mesh.userData;
    _selectNFT(nft, mesh, null, true);
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
  const cfg = window.DecentConfig || {};
  const gateway = cfg.ipfsGateway || 'https://w3s.link/ipfs/';
  const audioUrl = (nft.audioUrl || nft.animation_url || '')
    .replace('ipfs://', gateway);

  setNowPlaying({
    title:    nft.name || nft.title || `Track #${nft.tokenId}`,
    artist:   nft.artist || nft.creator || '',
    audioUrl,
  });
}
