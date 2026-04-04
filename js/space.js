// js/space.js — DecentBusking
// Three.js-powered NFT asteroid field.
//
// Behaviour:
//  • Each minted DecentNFT appears at stage-centre (0,0,0) and drifts outward
//    into space as it ages.
//  • After ONE_MONTH_MS the mesh becomes invisible but its position is retained
//    so the spaceship can still fly to it and the NFT can still be purchased.
//  • Clicking on a visible NFT mesh opens the NFT detail panel.
//  • Arrow-key / WASD controls (defined via DecentFoot or here as fallback)
//    let the user fly through the field.
//
// Dependencies (loaded via CDN in index.html):
//   • THREE  (three.js r128)
//   • OrbitControls  (from three@0.128.0 examples)

import { renderNFTCard } from './nft-card.js';
import { setNowPlaying } from './stage.js';

const ONE_MONTH_MS = 90 * 24 * 60 * 60 * 1000;   // 90 days before NFT becomes invisible
const DRIFT_SPEED = 0.004;         // units per frame after age normalisation
const MAX_DRIFT_RADIUS = 120;      // maximum distance from origin
const FADE_START_DAYS = 75;        // days before invisibility fade begins

// Global spaceship state
const _ship = {
  velocity: new THREE.Vector3(),
  speed: 0.12,
  rotateSpeed: 0.03,
};

let _renderer, _scene, _camera, _controls, _nftMeshes = [], _raycaster, _mouse;
let _shipMode = false; // true = fly-through (WASD), false = orbit (mouse drag)
let _keysDown = {};
let _animFrameId;

// ── Public API ─────────────────────────────────────────────────────────────
export function initSpace() {
  _buildScene();
  _buildControls();
  _loadNFTs();
  _animate();
  window.addEventListener('resize', _onResize);
  window.addEventListener('keydown', _onKeyDown);
  window.addEventListener('keyup', _onKeyUp);
}

// Called by mint.js after a new busk is minted to inject it into the field.
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

// ── Scene Bootstrap ─────────────────────────────────────────────────────────
function _buildScene() {
  _scene = new THREE.Scene();
  _scene.background = new THREE.Color(0x03010a);
  _scene.fog = new THREE.FogExp2(0x03010a, 0.008);

  // Stars (geometry-based for performance)
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
  _camera.position.set(0, 8, 28);

  // Renderer — attach behind everything else
  _renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  _renderer.setSize(window.innerWidth, window.innerHeight);
  _renderer.domElement.id = 'space-canvas';
  document.body.prepend(_renderer.domElement);

  // Ambient + point light to give NFT tiles some depth
  _scene.add(new THREE.AmbientLight(0x222244, 1.6));
  const pt = new THREE.PointLight(0xf0c040, 1.2, 60);
  pt.position.set(0, 10, 10);
  _scene.add(pt);

  // Raycaster for click detection
  _raycaster = new THREE.Raycaster();
  _mouse = new THREE.Vector2();

  _renderer.domElement.addEventListener('click', _onCanvasClick);
  _renderer.domElement.addEventListener('mousemove', _onMouseMove);
}

function _buildControls() {
  // OrbitControls as default (allows mouse pan/zoom for exploration)
  if (typeof THREE.OrbitControls !== 'undefined') {
    _controls = new THREE.OrbitControls(_camera, _renderer.domElement);
    _controls.enableDamping = true;
    _controls.dampingFactor = 0.07;
    _controls.minDistance = 5;
    _controls.maxDistance = 250;
  }
}

// ── NFT Loading ────────────────────────────────────────────────────────────
async function _loadNFTs() {
  const cfg = window.DecentConfig || {};
  const contractAddress = cfg.contractAddress;
  if (!contractAddress || contractAddress === '0x0000000000000000000000000000000000000000') {
    console.info('[space] No contract address configured — skipping NFT load.');
    return;
  }

  try {
    const rpcUrl = cfg.rpcUrl || 'https://mainnet.optimism.io';
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const abi = [
      // DecentNFT v0.2 (ERC-1155) read helpers
      'function nextTokenId() view returns (uint256)',
      'function uri(uint256 tokenId) view returns (string)',
      'function creatorOf(uint256 tokenId) view returns (address)',
      'function totalMinted(uint256 tokenId) view returns (uint256)',
    ];
    const contract = new ethers.Contract(contractAddress, abi, provider);

    // Token IDs are 0-based; nextTokenId() returns the next ID to be assigned.
    const nextId = Number(await contract.nextTokenId());

    for (let tokenId = 0; tokenId < nextId; tokenId++) {
      try {
        // Skip tokens that were registered but never minted
        const minted = Number(await contract.totalMinted(tokenId));
        if (minted === 0) continue;

        const uri = await contract.uri(tokenId);
        const creator = await contract.creatorOf(tokenId);
        const meta = await _fetchMetadata(uri);
        if (meta) {
          _spawnMesh({ tokenId, ...meta, creator }, false);
        }
      } catch (_) {
        // Individual token failures are non-fatal
      }
    }
  } catch (err) {
    console.warn('[space] NFT load failed:', err.message);
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
  const ageMs = Date.now() - mintedAt;
  const ageFraction = Math.min(ageMs / ONE_MONTH_MS, 1);

  // Deterministic position derived from tokenId so page refreshes are stable
  const seed = nft.tokenId || Math.random() * 9999;
  const angle = (seed * 137.508) * (Math.PI / 180); // golden-angle spiral
  const radius = isNew ? 0 : ageFraction * MAX_DRIFT_RADIUS;
  const tilt = (seed % 60) - 30;

  const pos = new THREE.Vector3(
    Math.cos(angle) * radius,
    (tilt / 30) * radius * 0.4,
    Math.sin(angle) * radius,
  );

  // Tile geometry representing the NFT card
  const geo = new THREE.PlaneGeometry(3.2, 1.8);
  const texture = _makeNFTTexture(nft);
  const mat = new THREE.MeshStandardMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
  });

  // Fade out near-invisible NFTs older than FADE_START_DAYS
  const fadeDays = FADE_START_DAYS * 24 * 60 * 60 * 1000;
  if (!isNew && ageMs > fadeDays) {
    const fadeProgress = Math.min((ageMs - fadeDays) / (ONE_MONTH_MS - fadeDays), 1);
    mat.opacity = 1 - fadeProgress;
  }

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(pos);

  // Slight random tilt so tiles feel like floating debris
  mesh.rotation.set(
    (Math.random() - 0.5) * 0.3,
    angle + Math.PI,
    (Math.random() - 0.5) * 0.2,
  );

  mesh.userData = {
    nft,
    mintedAt,
    ageMs,
    ageFraction,
    driftAngle: angle,
    driftRadius: radius,
    isNew,
  };

  _scene.add(mesh);
  _nftMeshes.push(mesh);

  // New busk: start playing immediately
  if (isNew) {
    _playNFT(nft);
    window._currentBuskerWallet = nft.tipWallet || '';
  }

  return mesh;
}

// Canvas-based texture for NFT tile label
function _makeNFTTexture(nft) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 288;
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#0d0820';
  ctx.fillRect(0, 0, 512, 288);
  ctx.strokeStyle = 'rgba(240,192,64,0.5)';
  ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, 508, 284);

  // Title
  ctx.fillStyle = '#f0c040';
  ctx.font = 'bold 32px Bungee, Impact, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(_truncate(nft.name || nft.title || `Track #${nft.tokenId}`, 28), 256, 72);

  // Artist
  ctx.fillStyle = '#a08050';
  ctx.font = '22px sans-serif';
  ctx.fillText(_truncate(nft.artist || nft.creator || '', 34), 256, 110);

  // Token ID
  ctx.fillStyle = '#4a4060';
  ctx.font = '18px monospace';
  ctx.fillText(`#${nft.tokenId || '?'}`, 256, 240);

  // Music note decoration
  ctx.fillStyle = 'rgba(0,212,170,0.25)';
  ctx.font = '80px sans-serif';
  ctx.fillText('🎵', 256, 190);

  return new THREE.CanvasTexture(canvas);
}

// ── Animation Loop ────────────────────────────────────────────────────────
function _animate() {
  _animFrameId = requestAnimationFrame(_animate);

  const now = Date.now();

  // Drift each NFT outward and update fade
  for (const mesh of _nftMeshes) {
    const ud = mesh.userData;
    if (ud.isNew) {
      // Newly minted — drift outward from centre
      ud.driftRadius += DRIFT_SPEED;
      mesh.position.set(
        Math.cos(ud.driftAngle) * ud.driftRadius,
        mesh.position.y,
        Math.sin(ud.driftAngle) * ud.driftRadius,
      );
      ud.isNew = ud.driftRadius < 0.5; // mark as settled after leaving stage
    }

    // Update live age-based fade
    ud.ageMs = now - ud.mintedAt;
    const fadeDays = FADE_START_DAYS * 24 * 60 * 60 * 1000;
    if (ud.ageMs > fadeDays) {
      const fadeProgress = Math.min((ud.ageMs - fadeDays) / (ONE_MONTH_MS - fadeDays), 1);
      mesh.material.opacity = Math.max(0, 1 - fadeProgress);
    }

    // Gentle billboard effect — always face camera
    mesh.lookAt(_camera.position);
  }

  // Spaceship WASD flight
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
  if (_keysDown['q'])                            _camera.position.y += _ship.speed;
  if (_keysDown['e'])                            _camera.position.y -= _ship.speed;
}

// ── Input Handlers ────────────────────────────────────────────────────────
function _onKeyDown(e) {
  const key = e.key?.toLowerCase();
  if (!key) return;
  _keysDown[key] = true;

  // Toggle flight mode with Tab
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
  _mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  _mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
}

function _onCanvasClick(e) {
  _mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  _mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

  _raycaster.setFromCamera(_mouse, _camera);
  const hits = _raycaster.intersectObjects(_nftMeshes);

  if (hits.length > 0) {
    const mesh = hits[0].object;
    const { nft } = mesh.userData;
    _playNFT(nft);
    renderNFTCard(nft);
    window._currentBuskerWallet = nft.tipWallet || '';
  }
}

function _onResize() {
  _camera.aspect = _aspect();
  _camera.updateProjectionMatrix();
  _renderer.setSize(window.innerWidth, window.innerHeight);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function _aspect() {
  return window.innerWidth / window.innerHeight;
}

function _truncate(str, len) {
  return str.length > len ? str.slice(0, len - 1) + '…' : str;
}

function _playNFT(nft) {
  const cfg = window.DecentConfig || {};
  const gateway = cfg.ipfsGateway || 'https://w3s.link/ipfs/';
  const audioUrl = nft.audioUrl
    ? nft.audioUrl.replace('ipfs://', gateway)
    : (nft.animation_url || '').replace('ipfs://', gateway);

  setNowPlaying({
    title: nft.name || nft.title || `Track #${nft.tokenId}`,
    artist: nft.artist || nft.creator || '',
    audioUrl,
  });
}
