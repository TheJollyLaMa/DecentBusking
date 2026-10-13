const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const stageSource = fs.readFileSync(path.join(__dirname, '../js/stage.js'), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/export /g, '');
const spaceSource = fs.readFileSync(path.join(__dirname, '../js/space.js'), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/export /g, '');

function makeThreeStubs() {
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
    set(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { return this.set(v.x, v.y, v.z); }
    add(v) { return this.set(this.x + v.x, this.y + v.y, this.z + v.z); }
    addScaledVector(v, s) { return this.set(this.x + v.x * s, this.y + v.y * s, this.z + v.z * s); }
    clone() { return new Vector3(this.x, this.y, this.z); }
    setScalar(s) { return this.set(s, s, s); }
    distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  }
  class Mesh {
    constructor(geometry, material) {
      this.geometry = geometry;
      this.material = material;
      this.position = new Vector3();
      this.rotation = { set() {} };
      this.scale = new Vector3(1, 1, 1);
      this.userData = {};
      this.visible = false;
      this.children = [];
    }
    lookAt() {}
    add(child) { this.children.push(child); child.parent = this; }
  }
  return {
    Scene: class { constructor() { this.children = []; } add(child) { this.children.push(child); } remove(child) { this.children = this.children.filter(item => item !== child); } },
    Color: class {},
    FogExp2: class {},
    BufferGeometry: class {
      constructor() { this.attributes = {}; }
      setAttribute(name, attribute) { this.attributes[name] = attribute; return this; }
      setFromPoints() { return this; }
    },
    BufferAttribute: class { constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.needsUpdate = false; } },
    PointsMaterial: class {},
    Points: class {},
    PerspectiveCamera: class {
      constructor() { this.position = new Vector3(); this.aspect = 1; this.up = new Vector3(0, 1, 0); }
      updateProjectionMatrix() {}
      getWorldDirection(target) { return target.set(0, 0, -1); }
    },
    WebGLRenderer: class { setPixelRatio() {} setSize() {} render() {} constructor() { this.domElement = { id: 'space-canvas', addEventListener() {} }; } },
    AmbientLight: class {},
    PointLight: class { constructor() { this.position = new Vector3(); } },
    Raycaster: class { setFromCamera() {} intersectObjects() { return []; } },
    Vector2: class {},
    Vector3,
    CircleGeometry: class {},
    MeshBasicMaterial: class {
      constructor(options = {}) {
        Object.assign(this, options);
        this.opacity = options.opacity ?? 1;
        this.color = { r: 1, g: 1, b: 1, setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; } };
      }
    },
    Mesh,
    DoubleSide: 2,
    CanvasTexture: class { constructor(image) { this.image = image; this.needsUpdate = false; } },
    LineBasicMaterial: class {
      constructor(options = {}) {
        Object.assign(this, options);
        this.opacity = options.opacity ?? 1;
        this.color = { r: 1, g: 1, b: 1, setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; } };
      }
    },
    Line: class {
      constructor(geometry, material) {
        this.geometry = geometry;
        this.material = material;
        this.position = new Vector3();
        this.scale = new Vector3(1, 1, 1);
        this.userData = {};
        this.children = [];
      }
      add(child) { this.children.push(child); child.parent = this; }
    },
    LineLoop: class {
      constructor(geometry, material) {
        this.geometry = geometry;
        this.material = material;
        this.position = new Vector3();
        this.scale = new Vector3(1, 1, 1);
        this.userData = {};
        this.children = [];
      }
      add(child) { this.children.push(child); child.parent = this; }
    },
    OrbitControls: class {
      constructor() { this.target = new Vector3(); this.minDistance = 0; this.maxDistance = 0; }
      update() {}
    },
  };
}

class MockDocument extends EventTarget {
  constructor(audio, video, list, fields) {
    super();
    this._audio = audio;
    this._video = video;
    this._list = list;
    this._fields = fields;
    this.body = { prepend() {} };
    this.documentElement = { style: { setProperty() {} } };
  }

  createElement(tag) {
    if (tag === 'canvas') {
      const draw = {
        globalAlpha: 1, clearRect() {}, save() {}, restore() {}, beginPath() {}, arc() {}, clip() {},
        fillRect() {}, measureText: (text) => ({ width: text.length * 12 }), fillText() {}, drawImage() {},
        stroke() {}, set font(value) { this._font = value; }, get font() { return this._font; },
      };
      return { width: 0, height: 0, getContext: () => draw };
    }
    if (tag === 'li') {
      return {
        className: '',
        dataset: {},
        innerHTML: '',
        hidden: false,
        classList: { add() {}, remove() {} },
        addEventListener() {},
        scrollIntoView() {},
      };
    }
    return { appendChild() {}, remove() {}, classList: { add() {}, remove() {}, toggle() {} } };
  }

  getElementById(id) {
    return this._fields[id] || (id === 'audio-player' ? this._audio : id === 'radio-video-player' ? this._video :
      id === 'radio-video-stage' ? this._fields['radio-video-stage'] : null);
  }

  querySelector(selector) {
    const match = selector.match(/data-(?:nft-id|token-id)="([^"]+)"/);
    if (!match) return null;
    return this._list.children.find((item) => item.dataset.nftId === match[1] || item.dataset.tokenId === match[1]) || null;
  }

  querySelectorAll(selector) {
    if (selector === '.dnft-list-item') return [...this._list.children];
    return [];
  }
}

test('now-playing NFTs are auto-loaded, pulse with audio, and stay visible after playback', () => {
  const playCalls = [];
  const audio = { paused: true, ended: false, readyState: 4, currentTime: 0, volume: 1, muted: false };
  const video = { paused: true, ended: false, readyState: 4, currentTime: 0, volume: 1, muted: false };
  const list = {
    children: [],
    prepend(node) { this.children.unshift(node); },
    append(node) { this.children.push(node); },
    replaceChildren(...nodes) { this.children = [...nodes]; },
    querySelector(selector) { return selector === '.dnft-list-empty' ? null : null; },
    querySelectorAll() { return [...this.children]; },
  };
  const fields = {
    'dnft-list-items': list,
    'dnft-list-count': { textContent: '' },
    'dnft-list-count-badge': { textContent: '' },
    'artist-filter-count': { textContent: '' },
    'scene-artist-filter': { replaceChildren() {}, value: '', addEventListener() {} },
    'archive-artist-filter': { replaceChildren() {}, value: '', addEventListener() {} },
    'radio-video-stage': { hidden: true },
  };
  const document = new MockDocument(audio, video, list, fields);
  const nft = {
    tokenId: 7,
    contractAddress: `0x${'1'.repeat(40)}`,
    chainId: 8453,
    name: 'Night Pulse',
    artist: `0x${'2'.repeat(40)}`,
    mintedAt: new Date(Date.now() - 86_400_000).toISOString(),
    audioUrl: 'ipfs://bafytrack',
  };
  let fakeNow = 0;
  const context = vm.createContext({
    console,
    document,
    window: { DecentConfig: { ipfsGateway: 'https://gateway.pinata.cloud/ipfs/', ipfsUploadServiceUrl: 'https://service.example' } },
    performance: { now: () => { fakeNow += 120; return fakeNow; } },
    CustomEvent,
    Event,
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    nftArtistKey: (nft) => String(nft.artist || nft.creator || nft.uploader || 'Unknown artist').trim().toLowerCase(),
    setTimeout,
    clearTimeout,
    playArchiveTrack: (payload) => {
      playCalls.push(payload);
      document.dispatchEvent(new CustomEvent('dbusk-now-playing', {
        detail: { ...payload, nft: payload.nft || nft },
      }));
    },
    THREE: makeThreeStubs(),
  });

  vm.runInContext(`${spaceSource}\n_scene = new THREE.Scene();`, context);
  vm.runInContext(stageSource, context);

  context.setNowPlaying({ nft, title: nft.name, artist: 'Synth Artist', audioUrl: nft.audioUrl });

  assert.equal(playCalls.length, 1);
  assert.equal(playCalls[0].audioUrl, 'https://gateway.pinata.cloud/ipfs/bafytrack');
  assert.equal(vm.runInContext('_allNFTs.length', context), 1);
  const entry = vm.runInContext('_allNFTs[0]', context);
  assert.equal(entry.mesh.visible, true);
  assert.equal(entry.mesh.userData.pinnedVisible, true);
  assert.ok(entry.mesh.userData.nowPlayingGlow);
  assert.equal(vm.runInContext('_nowPlayingMesh === _allNFTs[0].mesh', context), true);

  vm.runInContext(`_nowPlayingMedia = document.getElementById('audio-player');
    _nowPlayingAnalyser = {
      fftSize: 8,
      frequencyBinCount: 4,
      getByteTimeDomainData(buffer) { buffer.fill(176); },
      getByteFrequencyData(buffer) { buffer.set([220, 180, 90, 40]); },
    };
    _nowPlayingAudioData = new Uint8Array(8);
    _nowPlayingFrequencyData = new Uint8Array(4);`, context);
  audio.paused = false;
  for (let i = 0; i < 15; i += 1) vm.runInContext('_updateNowPlayingPulse();', context);
  assert.ok(vm.runInContext('_allNFTs[0].mesh.scale.x > 1.01', context));
  assert.ok(vm.runInContext('_allNFTs[0].mesh.material.opacity < 1', context));
  assert.ok(vm.runInContext('_allNFTs[0].mesh.userData.nowPlayingGlow.material.opacity > 0.18', context));
  assert.ok(vm.runInContext('_allNFTs[0].mesh.userData.nowPlayingEdge.material.opacity > 0', context));
  const colors = vm.runInContext('Array.from(_allNFTs[0].mesh.userData.nowPlayingEdge.geometry.attributes.color.array)', context);
  assert.ok(new Set(colors.map((value) => value.toFixed(2))).size > 8);
  const neighbor = vm.runInContext(`_spawnMesh({
    tokenId: 8,
    contractAddress: ${JSON.stringify(`0x${'1'.repeat(40)}`)},
    chainId: 8453,
    name: 'Neighbor Pulse',
    artist: ${JSON.stringify(`0x${'2'.repeat(40)}`)},
    mintedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    audioUrl: 'ipfs://bafyneighbor',
  }, false)`, context);
  vm.runInContext('_allNFTs[1].mesh.position.copy(_allNFTs[0].mesh.position).add(new THREE.Vector3(2, 0, 0));', context);
  vm.runInContext('_updateNowPlayingPulse();', context);
  assert.ok(vm.runInContext('_allNFTs[1].mesh.material.opacity < 1', context));

  audio.paused = true;
  for (let i = 0; i < 12; i += 1) vm.runInContext('_updateNowPlayingPulse();', context);
  assert.ok(vm.runInContext('_allNFTs[0].mesh.scale.x <= 1.001', context));
  assert.ok(vm.runInContext('_allNFTs[0].mesh.userData.nowPlayingEdge.material.opacity <= 0.05', context));
  assert.ok(vm.runInContext('_allNFTs[1].mesh.material.opacity >= 0.95', context));
  assert.equal(vm.runInContext('_allNFTs[0].mesh.visible', context), true);
  vm.runInContext(`_activeArtist = 'different-artist'; _timelineOffsetDays = 999; _updateVisibility();`, context);
  assert.equal(vm.runInContext('_allNFTs[0].mesh.visible', context), true);
  assert.equal(vm.runInContext('_allNFTs[0].mesh.visible', context), true);
});

test('radio now-playing events resolve and load the matching NFT outside the visible window', async () => {
  const audio = { paused: true, ended: false, readyState: 4, currentTime: 0, volume: 1, muted: false };
  const video = { paused: true, ended: false, readyState: 4, currentTime: 0, volume: 1, muted: false };
  const list = {
    children: [],
    prepend(node) { this.children.unshift(node); },
    append(node) { this.children.push(node); },
    replaceChildren(...nodes) { this.children = [...nodes]; },
    querySelector(selector) { return selector === '.dnft-list-empty' ? null : null; },
    querySelectorAll() { return [...this.children]; },
  };
  const fields = {
    'dnft-list-items': list,
    'dnft-list-count': { textContent: '' },
    'dnft-list-count-badge': { textContent: '' },
    'artist-filter-count': { textContent: '' },
    'scene-artist-filter': { replaceChildren() {}, value: '', addEventListener() {} },
    'archive-artist-filter': { replaceChildren() {}, value: '', addEventListener() {} },
    'radio-video-stage': { hidden: true },
  };
  const document = new MockDocument(audio, video, list, fields);
  const radioNft = {
    tokenId: 17,
    contractAddress: `0x${'3'.repeat(40)}`,
    chainId: 8453,
    name: 'Moonlit Signal',
    artist: `0x${'4'.repeat(40)}`,
    mintedAt: new Date(Date.now() - 45 * 86_400_000).toISOString(),
    audioUrl: 'ipfs://bafyradio',
  };
  const queries = [];
  const context = vm.createContext({
    console,
    document,
    window: { DecentConfig: { ipfsGateway: 'https://gateway.pinata.cloud/ipfs/', ipfsUploadServiceUrl: 'https://service.example' } },
    performance,
    CustomEvent,
    Event,
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    nftArtistKey: (nft) => String(nft.artist || nft.creator || nft.uploader || 'Unknown artist').trim().toLowerCase(),
    setTimeout,
    clearTimeout,
    fetchNftCatalogPage: async ({ query }) => {
      queries.push(query);
      return { nfts: [radioNft], total: 1, nextOffset: null, artists: [] };
    },
    THREE: makeThreeStubs(),
  });

  vm.runInContext(`${spaceSource}\n_scene = new THREE.Scene();`, context);
  await vm.runInContext(`_handleNowPlaying({
    source: 'radio',
    playId: 'play-17',
    trackId: 'track-17',
    title: ${JSON.stringify(radioNft.name)},
    artist: 'Synth Artist',
    audioUrl: 'https://gateway.pinata.cloud/ipfs/bafyradio',
    ipfsCid: 'bafyradio',
    mediaType: 'audio/mpeg',
  });`, context);

  assert.ok(queries[0].includes('Moonlit Signal'));
  assert.ok(queries[0].includes('Synth Artist'));
  assert.equal(vm.runInContext('_allNFTs.length', context), 1);
  const entry = vm.runInContext('_allNFTs[0]', context);
  assert.equal(entry.mesh.visible, true);
  assert.equal(entry.mesh.userData.pinnedVisible, true);
  assert.equal(vm.runInContext('_nowPlayingMesh === _allNFTs[0].mesh', context), true);
});
