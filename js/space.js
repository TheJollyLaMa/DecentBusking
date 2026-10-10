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
//    skipped.  See _isMusicNFT().
//  • NFTs load lazily: the 4 newest load immediately, then 4 more every 30 s.
//    The "Show All Now" button forces an immediate full load.
//  • WASD / Arrow keys always fly the camera (no toggle required).  Tab
//    additionally disables mouse-orbit (pure ship mode).  Q/E move vertically.
//  • Mouse orbit is always available; full vertical range (0–180°) is allowed.
//
// Dependencies (loaded via CDN in index.html):
//   • THREE  (three.js r128)
//   • OrbitControls  (from three@0.128.0 examples)

import { renderNFTCard } from './nft-card.js?v=20261010-collections';
import { setNowPlaying } from './stage.js?v=20261005-mp4';
import { fetchIpfsJson, buildIpfsGatewayUrls } from './ipfs-gateway.js?v=20261003-coins-radio-votes';
import { loadMintedToken, readCachedMintedTokens, readNftContract, configuredNftCollections } from './nft-loader.js?v=20261010-collections';

// ── Timeline constants ────────────────────────────────────────────────────
const UNITS_PER_DAY   = 5;          // 3-D units per day on the Z-axis
const SPREAD_RADIUS   = 6;          // XY scatter radius to avoid overlap
const WINDOW_DAYS     = 30;         // how many days the default view covers
const NAV_STEP_DAYS   = 1;
const MAX_NAV_DAYS    = 365;        // how far back the slider can go

// Camera home position (z offset ahead of the timeline centre)
const CAM_Z_OFFSET = 28;

// ── NFT lazy-loading constants ────────────────────────────────────────────
// Adjust these values to tune how many NFTs load at startup and how quickly
// subsequent pages are fetched.
const INITIAL_BATCH    = 4;         // NFTs to load immediately on startup
const PAGE_BATCH       = 4;         // NFTs fetched per subsequent auto-page
const PAGE_INTERVAL_MS = 500;

// Yield time (ms) between rapid batch loads triggered by "Show All Now".
// Keeps the browser event loop responsive during fast loading.
const BATCH_YIELD_MS   = 200;

// Music-filter: an animation_url with one of these extensions is an audio NFT.
// ipfs:// links without an extension are also accepted (this dapp's native format).
const AUDIO_EXT_RE = /\.(mp3|mp4|wav|flac|m4a|ogg|opus|aac|weba)(\?|#|$)/i;

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

// Spaceship
const _ship = { speed: 0.3 };

// ── NFT paging state ──────────────────────────────────────────────────────
// Shared contract instance reused across lazy-load pages.
let _collections = [];
// Next tokenId to attempt loading (counts DOWN from nextTokenId-1 → 0).
let _nextTokenToLoad = -1;
// Timer for the auto-page interval.
let _pageTimerId     = null;
// Set to true once all tokens have been iterated.
let _allLoaded       = false;
let _batchInFlight = null;
let _pointerStart = null;
let _activeArtist = '';

// ── Public API ────────────────────────────────────────────────────────────
export function initSpace() {
  _buildScene();
  _buildControls();
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
}

// Called by mint.js after a new busk is minted — places it at the front.
export function addNFTToSpace(nft) {
  _spawnMesh(nft, true /* isNew */);
}

// Fetch metadata for a single token by ID — used by mint.js for parent preview.
export async function fetchNFTMetaById(tokenId, collectionAddress) {
  const cfg = window.DecentConfig || {};
  const contractAddress = collectionAddress || cfg.contractAddress;
  if (!contractAddress || contractAddress === '0x0000000000000000000000000000000000000000') return null;

  try {
    const rpcUrl = cfg.rpcUrl || 'https://mainnet.base.org';
    const provider = new ethers.JsonRpcProvider(rpcUrl);
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
    _controls.zoomSpeed = 1.6;
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
// Loading strategy (tunable via INITIAL_BATCH / PAGE_BATCH / PAGE_INTERVAL_MS):
//   1. Fetch nextTokenId from the contract to know the total token count.
//   2. Show a spinner in the DNFT list while loading.
//   3. Iterate from the newest token (nextTokenId-1) downward, loading only
//      music NFTs (see _isMusicNFT).  Stop after INITIAL_BATCH matches.
//   4. After PAGE_INTERVAL_MS auto-load PAGE_BATCH more, repeating
//      until the full list is loaded.
//   5. The "Show All Now" button short-circuits the timer and loads the rest
//      in rapid bursts.
async function _loadNFTs() {
  const cfg = window.DecentConfig || {};
  const contractAddress = cfg.contractAddress;
  if (!contractAddress || contractAddress === '0x0000000000000000000000000000000000000000') {
    console.info('[space] No contract address configured — skipping NFT load.');
    _markListEmpty('No contract configured.');
    return;
  }

  _showSpinner(true);

  try {
    const rpcUrl = cfg.rpcUrl || 'https://mainnet.base.org';
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const abi = [
      'function nextTokenId() view returns (uint256)',
      'function uri(uint256 tokenId) view returns (string)',
      'function creatorOf(uint256 tokenId) view returns (address)',
      'function totalMinted(uint256 tokenId) view returns (uint256)',
    ];
    _collections = [];
    for (const collection of configuredNftCollections(cfg)) {
      const cacheKey = `${collection.chainId}:${collection.contractAddress}`;
      for (const cached of readCachedMintedTokens({ cacheKey })) {
        const nft = { ...cached, ...collection };
        if (_isMusicNFT(nft) && !_allNFTs.some(entry => _nftKey(entry.nft) === _nftKey(nft))) _spawnMesh(nft, false);
      }
      const contract = new ethers.Contract(collection.contractAddress, abi, provider);
      const nextId = Number(await readNftContract(() => contract.nextTokenId()));
      if (!Number.isSafeInteger(nextId) || nextId < 0) throw new Error('Invalid NFT token count');
      _collections.push({ ...collection, contract, cacheKey, nextTokenId: nextId - 1 });
    }
    const nextId = _collections.reduce((total, collection) => total + collection.nextTokenId + 1, 0);

    if (nextId === 0) {
      _showSpinner(false);
      _markListEmpty('No tracks minted yet.');
      return;
    }

    // Start from the newest token and work backwards (highest tokenId first).
    _nextTokenToLoad = nextId - 1;
    _allLoaded = false;

    // Load the initial batch so the UI is populated quickly.
    await _loadBatch(INITIAL_BATCH);
    _showSpinner(false);

    if (_allNFTs.length === 0 && _allLoaded) {
      _markListEmpty('No music tracks found yet.');
      return;
    }

    // Schedule subsequent pages if tokens still remain.
    if (!_allLoaded) {
      _scheduleNextPage();
    }
  } catch (err) {
    _showSpinner(false);
    console.warn('[space] NFT load failed:', err.message);
    if (_allNFTs.length === 0) _markListEmpty('Could not load tracks.');
  }
}

// Load up to `count` music NFTs, working down from _nextTokenToLoad.
async function _loadBatch(count) {
  if (_batchInFlight) return _batchInFlight;
  _batchInFlight = _loadBatchEntries(count).finally(() => { _batchInFlight = null; });
  return _batchInFlight;
}

async function _loadBatchEntries(count) {
  let loaded = 0;
  while (_nextTokenToLoad >= 0 && loaded < count) {
    const entries = [];
    while (_nextTokenToLoad >= 0 && entries.length < Math.min(2, count - loaded)) {
      const collection = _collections.find(entry => entry.nextTokenId >= 0);
      if (!collection) { _nextTokenToLoad = -1; break; }
      entries.push({ collection, tokenId: collection.nextTokenId-- });
      _nextTokenToLoad--;
    }
    const results = await Promise.all(entries.map(_tryLoadToken));
    loaded += results.filter(Boolean).length;
  }
  if (_nextTokenToLoad < 0) _allLoaded = true;
  return loaded;
}

// Try to load a single token. Returns true if the token was a music NFT and
// was successfully spawned, false otherwise.
async function _tryLoadToken({ collection, tokenId }) {
  try {
    const nft = await loadMintedToken({
      contract: collection.contract,
      tokenId,
      fetchMetadata: _fetchMetadata,
      cacheKey: collection.cacheKey,
      contractAddress: collection.contractAddress,
      chainId: collection.chainId,
    });

    // Skip non-music tokens (images, text NFTs, etc.)
    if (!nft || !_isMusicNFT(nft)) return false;

    if (_allNFTs.some((entry) => _nftKey(entry.nft) === _nftKey(nft))) return true;
    _spawnMesh(nft, false);
    return true;
  } catch (error) {
    console.warn(`[space] Could not load token #${tokenId}:`, error.message);
    return false; // Non-fatal per-token failure
  }
}

// Schedule the next auto-page load after PAGE_INTERVAL_MS milliseconds.
function _scheduleNextPage() {
  if (_allLoaded || _nextTokenToLoad < 0) return;
  _pageTimerId = setTimeout(async () => {
    await _loadBatch(PAGE_BATCH);
    if (!_allLoaded) _scheduleNextPage();
  }, PAGE_INTERVAL_MS);
}

// Called by the "Show All Now" button — cancels the timer and loads the rest
// of the tokens in rapid PAGE_BATCH bursts (with a small yield between each).
async function _loadAllNow() {
  if (_allLoaded || _nextTokenToLoad < 0) return;
  if (_pageTimerId !== null) {
    clearTimeout(_pageTimerId);
    _pageTimerId = null;
  }
  _showSpinner(true);
  const runNext = async () => {
    if (_nextTokenToLoad < 0 || _allLoaded) {
      _showSpinner(false);
      return;
    }
    await _loadBatch(PAGE_BATCH);
    // Yield to the browser between bursts so the UI stays responsive.
    setTimeout(runNext, BATCH_YIELD_MS);
  };
  await runNext();
}

// ── Music NFT filter ───────────────────────────────────────────────────────
// Returns true for tokens that contain playable audio.
// Logic:
//  • meta.audioUrl present → always music
//  • meta.animation_url ends with a known audio extension → music
//  • meta.animation_url starts with ipfs:// without an extension → assumed
//    audio (this dapp's native format; non-audio IPFS links would include an
//    explicit extension like .png or .json)
function _isMusicNFT(meta) {
  if (!meta) return false;
  if (meta.audioUrl || meta.videoUrl || meta.mediaType === 'video/mp4') return true;
  const anim = (meta.animation_url || '').toLowerCase();
  if (!anim) return false;
  if (AUDIO_EXT_RE.test(anim)) return true;
  // ipfs:// links without a recognised extension → treat as audio
  // ({2,5} covers extensions like js, mp3, json, flac, etc.)
  if (anim.startsWith('ipfs://') && !/\.[a-z]{2,5}(\?|#|$)/.test(anim)) return true;
  return false;
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

  mesh.userData = { nft, mintedAt, ageMs, ageDays, isNew };

  _scene.add(mesh);
  _nftMeshes.push(mesh);

  // Track for list panel (newest first — prepend)
  _allNFTs.unshift({ nft, mesh });
  _addListItem(nft, mesh);
  _refreshArtistFilters();
  _updateVisibility();

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
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
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
    ctx.fillStyle = 'rgba(3,5,12,.38)';
    ctx.fillRect(46, 110, 420, 294);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff8df';
    ctx.font = 'bold 30px Bungee, Impact, sans-serif';
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 5;
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
    ctx.fillStyle = '#a5f1d8';
    ctx.fillText(_artistLabel(nft).split(' · ')[0], 256, 334, 350);
    ctx.font = '21px sans-serif';
    ctx.fillStyle = '#fff8df';
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
  drawFace(null);
  if (nft.image) {
    const cfg = window.DecentConfig || {};
    const imageUrls = buildIpfsGatewayUrls(nft.image, cfg.ipfsGateway || 'https://gateway.pinata.cloud/ipfs/')
      .filter((url) => /^https?:\/\//i.test(url));
    if (imageUrls.length) {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => drawFace(image);
      let attempt = 0;
      image.onerror = () => {
        if (++attempt < imageUrls.length) image.src = imageUrls[attempt];
      };
      image.src = imageUrls[0];
    }
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
    mesh.visible = _isInWindow(ageDays) && _matchesArtist(mesh.userData.nft);
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
  return String(nft.artist || nft.creator || nft.uploader || 'Unknown artist').trim().toLowerCase();
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
  const artists = new Map(_allNFTs.map(({ nft }) => [_artistKey(nft), _artistLabel(nft)]));
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
    });
  }
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
function _addListItem(nft, mesh) {
  const list = document.getElementById('dnft-list-items');
  if (!list) return;

  // Remove placeholder on first real item
  const placeholder = list.querySelector('.dnft-list-empty');
  if (placeholder) placeholder.remove();

  const li = document.createElement('li');
  li.className = 'dnft-list-item';
  li.dataset.tokenId = String(nft.tokenId);
  li.dataset.nftId = _nftKey(nft);

  const title    = nft.name || nft.title || `Track #${nft.tokenId}`;
  const artist   = nft.artist || _shortAddr(nft.creator || '');
  const dateStr  = nft.mintedAt
    ? new Date(nft.mintedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })
    : '';

  li.innerHTML = `
    <span class="dnft-list-item-title">${_esc(title)}</span>
    <span class="dnft-list-item-meta">${artist ? _esc(artist) : ''}${dateStr ? ` · ${dateStr}` : ''}</span>
  `;

  li.addEventListener('click', () => {
    _selectNFT(nft, mesh, li, true);
    _setArchiveOpen(false);
  });

  // Prepend so newest is at the top (items are pushed via unshift in _spawnMesh)
  list.prepend(li);

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

// Wire the "Show All Now" button.  The button is hidden once all tokens are loaded.
function _bindShowAllBtn() {
  const btn = document.getElementById('dnft-show-all-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    btn.disabled = true;
    btn.textContent = '⏳ Loading…';
    _loadAllNow().then(() => {
      btn.classList.add('hidden');
    });
  });
}

// ── NFT Selection ──────────────────────────────────────────────────────────
function _selectNFT(nft, mesh, listItem, showCard = true) {
  _activeId = _nftKey(nft);

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
    setTimelineOffset(Math.max(0, ageDays - WINDOW_DAYS / 2));
  }

  _playNFT(nft);
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
  const cfg = window.DecentConfig || {};
  const gateway = cfg.ipfsGateway || 'https://gateway.pinata.cloud/ipfs/';
  const audioUrl = (nft.videoUrl || nft.audioUrl || nft.animation_url || '')
    .replace('ipfs://', gateway);

  setNowPlaying({
    title:    nft.name || nft.title || `Track #${nft.tokenId}`,
    artist:   nft.artist || nft.creator || '',
    audioUrl,
    mediaType: nft.mediaType || (nft.videoUrl ? 'video/mp4' : ''),
  });
}
