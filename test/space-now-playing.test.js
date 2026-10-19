const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');

const stageSource = fs.readFileSync(path.join(__dirname, '../js/stage.js'), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/export /g, '');
const spaceSource = fs.readFileSync(path.join(__dirname, '../js/space.js'), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/export /g, '');
const loaderUrl = pathToFileURL(path.join(__dirname, '../js/nft-loader.js')).href;
const gatewayUrl = pathToFileURL(path.join(__dirname, '../js/ipfs-gateway.js')).href;

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
    SphereGeometry: class {
      constructor(radius, widthSegments, heightSegments) {
        this.radius = radius;
        this.widthSegments = widthSegments;
        this.heightSegments = heightSegments;
      }
    },
    MeshBasicMaterial: class {
      constructor(options = {}) {
        Object.assign(this, options);
        this.opacity = options.opacity ?? 1;
        this.color = { r: 1, g: 1, b: 1, setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; } };
      }
    },
    Mesh,
    DoubleSide: 2,
    CanvasTexture: class {
      constructor(image) { this.image = image; this.needsUpdate = false; this.userData = {}; }
      dispose() { this.disposed = true; }
    },
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
    this.hidden = false;
    this.body = { prepend() {} };
    this.documentElement = { style: { setProperty() {} } };
  }

  createElement(tag) {
    if (tag === 'canvas') {
      const canvas = { width: 0, height: 0, drawImageCalls: 0 };
      const draw = {
        globalAlpha: 1, clearRect() {}, save() {}, restore() {}, beginPath() {}, arc() {}, clip() {},
        fillRect() {}, measureText: (text) => ({ width: text.length * 12 }), fillText() {}, drawImage(image) {
          canvas.drawImageCalls += 1;
          canvas.lastImageSrc = image?.src || '';
        },
        stroke() {}, set font(value) { this._font = value; }, get font() { return this._font; },
      };
      canvas.getContext = () => draw;
      return canvas;
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
  assert.equal(vm.runInContext('_allNFTs[0].mesh.material.depthTest', context), false);

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
  assert.ok(vm.runInContext('_allNFTs[0].mesh.userData.nowPlayingEdgeLayers.length >= 4', context));
  assert.ok(vm.runInContext('_allNFTs[0].mesh.userData.nowPlayingMoonLayers.length >= 4', context));
  assert.ok(vm.runInContext('_allNFTs[0].mesh.userData.nowPlayingEdgeLayers.every(layer => layer.material.depthTest === false)', context));
  assert.ok(vm.runInContext('_allNFTs[0].mesh.userData.nowPlayingMoonLayers.every(moon => moon.material.depthTest === false)', context));
  assert.ok(vm.runInContext('_allNFTs[0].mesh.userData.nowPlayingMoonLayers.every((moon, index) => moon.parent === _allNFTs[0].mesh.userData.nowPlayingEdgeLayers[index])', context));
  assert.ok(vm.runInContext('_allNFTs[0].mesh.userData.nowPlayingMoonLayers.every(moon => moon.geometry.radius <= 0.17)', context));
  const colors = vm.runInContext('Array.from(_allNFTs[0].mesh.userData.nowPlayingEdge.geometry.attributes.color.array)', context);
  assert.ok(new Set(colors.map((value) => value.toFixed(2))).size > 8);
  const moonPositionsBefore = vm.runInContext('_allNFTs[0].mesh.userData.nowPlayingMoonLayers.map(moon => [moon.position.x, moon.position.y, moon.position.z])', context);
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
  const moonPositionsAfter = vm.runInContext('_allNFTs[0].mesh.userData.nowPlayingMoonLayers.map(moon => [moon.position.x, moon.position.y, moon.position.z])', context);
  assert.notDeepEqual(moonPositionsAfter, moonPositionsBefore);
  assert.ok(vm.runInContext('_allNFTs[1].mesh.material.opacity < 0.3', context));

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

test('browsing an NFT opens the card without starting local playback', async () => {
  const audio = { paused: true, ended: false, readyState: 4, currentTime: 0, volume: 1, muted: false };
  const video = { paused: true, ended: false, readyState: 4, currentTime: 0, volume: 1, muted: false };
  const list = { children: [], prepend(node) { this.children.unshift(node); }, append(node) { this.children.push(node); }, replaceChildren() {},
    querySelector: () => null, querySelectorAll: () => [] };
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
  const renderCalls = [];
  const playCalls = [];
  const nft = {
    tokenId: 99,
    contractAddress: `0x${'9'.repeat(40)}`,
    chainId: 8453,
    name: 'Browse Only',
    artist: `0x${'8'.repeat(40)}`,
    mintedAt: new Date(Date.now() - 86_400_000).toISOString(),
    audioUrl: 'ipfs://bafybrowse',
  };
  const THREE = makeThreeStubs();
  const mesh = {
    userData: { ageDays: 1, mintedAt: Date.now() - 86_400_000 },
    position: new THREE.Vector3(),
    visible: true,
  };
  const context = vm.createContext({
    console,
    document: {
      ...document,
      querySelectorAll: (selector) => (selector === '.dnft-list-item' ? [] : []),
      querySelector: () => null,
      dispatchEvent: () => true,
    },
    window: { DecentConfig: { ipfsGateway: 'https://gateway.pinata.cloud/ipfs/', ipfsUploadServiceUrl: 'https://service.example' } },
    performance,
    CustomEvent,
    Event,
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    setTimeout,
    clearTimeout,
    THREE,
    mesh,
    renderNFTCard: (card) => renderCalls.push(card),
    setNowPlaying: (payload) => playCalls.push(payload),
  });
  vm.runInContext(`${spaceSource}\n_scene = new THREE.Scene();\n_camera = new THREE.PerspectiveCamera();\n_controls = new THREE.OrbitControls();\n_allNFTs = [{ nft: ${JSON.stringify(nft)}, mesh }];`, context);
  const result = await vm.runInContext(`openNFTByIdentity({ tokenId: 99, contractAddress: ${JSON.stringify(nft.contractAddress)}, chainId: 8453 })`, context);
  assert.equal(result, true);
  assert.equal(renderCalls.length, 1);
  assert.equal(renderCalls[0].tokenId, 99);
  assert.equal(playCalls.length, 0);
});

test('only the active now-playing GIF coin animates and releases cleanly on switch, pause, and hidden tabs', async () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const { buildIpfsGatewayUrls } = await import(gatewayUrl);
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
  const gifBytes = Uint8Array.from([71, 73, 70, 56, 57, 97, 0, 0, 0, 0, 0, 0]);
  const pngBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname === 'primary.example' && parsedUrl.pathname === '/ipfs/gif-one') {
      return new Response(gifBytes, { status: 200, headers: { 'content-type': 'image/gif' } });
    }
    if (parsedUrl.hostname === 'primary.example' && parsedUrl.pathname === '/ipfs/gif-two') {
      return new Response('', { status: 404 });
    }
    if (parsedUrl.hostname === 'gateway.pinata.cloud' && parsedUrl.pathname === '/ipfs/gif-two') {
      return new Response(gifBytes, { status: 200, headers: { 'content-type': 'image/gif' } });
    }
    if (parsedUrl.hostname === 'primary.example' && parsedUrl.pathname === '/ipfs/static-one') {
      return new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return new Response('', { status: 404 });
  };
  class MockImage {
    constructor() {
      this.width = 256;
      this.height = 256;
      this.onload = null;
      this.onerror = null;
      this.crossOrigin = '';
      this.decoding = '';
      this._src = '';
    }

    set src(value) {
      this._src = value;
      if (!value) return;
      queueMicrotask(() => {
        if (this._src !== value || !this.onload) return;
        this.onload();
      });
    }

    get src() {
      return this._src;
    }
  }
  const context = vm.createContext({
    console,
    document,
    fetch: fetchImpl,
    URL: {
      createObjectURL: () => `blob:${Math.random().toString(36).slice(2)}`,
      revokeObjectURL() {},
    },
    Blob,
    Response,
    Image: MockImage,
    AbortSignal,
    window: {
      DecentConfig: {
        ipfsGateway: 'https://primary.example/ipfs/',
        ipfsUploadServiceUrl: 'https://service.example',
      },
    },
    performance,
    CustomEvent,
    Event,
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    nftArtistKey: (nft) => String(nft.artist || nft.creator || nft.uploader || 'Unknown artist').trim().toLowerCase(),
    setTimeout,
    clearTimeout,
    buildIpfsGatewayUrls,
    THREE: makeThreeStubs(),
  });

  vm.runInContext(`${spaceSource}\n_scene = new THREE.Scene();`, context);

  const gifOne = {
    tokenId: 31,
    contractAddress: `0x${'3'.repeat(40)}`,
    chainId: 8453,
    name: 'Gif One',
    artist: `0x${'4'.repeat(40)}`,
    mintedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    image: 'ipfs://gif-one',
    audioUrl: 'ipfs://audio-one',
  };
  const gifTwo = {
    tokenId: 32,
    contractAddress: `0x${'3'.repeat(40)}`,
    chainId: 8453,
    name: 'Gif Two',
    artist: `0x${'4'.repeat(40)}`,
    mintedAt: new Date(Date.now() - 4 * 86_400_000).toISOString(),
    image: 'ipfs://gif-two',
    audioUrl: 'ipfs://audio-two',
  };
  const staticOne = {
    tokenId: 33,
    contractAddress: `0x${'3'.repeat(40)}`,
    chainId: 8453,
    name: 'Static One',
    artist: `0x${'4'.repeat(40)}`,
    mintedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    image: 'ipfs://static-one',
    audioUrl: 'ipfs://audio-three',
  };

  vm.runInContext(`_spawnMesh(${JSON.stringify(gifOne)}, false);`, context);
  vm.runInContext(`_spawnMesh(${JSON.stringify(gifTwo)}, false);`, context);
  vm.runInContext(`_spawnMesh(${JSON.stringify(staticOne)}, false);`, context);
  await flush();
  await flush();

  const gifOneCanvas = vm.runInContext('_allNFTs[0].mesh.material.map.image', context);
  const gifTwoCanvas = vm.runInContext('_allNFTs[1].mesh.material.map.image', context);
  const staticCanvas = vm.runInContext('_allNFTs[2].mesh.material.map.image', context);
  assert.equal(gifOneCanvas.drawImageCalls, 1);
  assert.equal(gifTwoCanvas.drawImageCalls, 1);
  assert.equal(staticCanvas.drawImageCalls, 1);
  assert.equal(vm.runInContext('_allNFTs[0].mesh.material.map.userData.artwork.isGif', context), true);
  assert.equal(vm.runInContext('_allNFTs[1].mesh.material.map.userData.artwork.isGif', context), true);
  assert.equal(vm.runInContext('_allNFTs[2].mesh.material.map.userData.artwork.isGif', context), false);
  assert.deepEqual(requested.slice(0, 2), [
    'https://primary.example/ipfs/gif-one',
    'https://primary.example/ipfs/gif-two',
  ]);
  assert.ok(requested.includes('https://gateway.pinata.cloud/ipfs/gif-two'));

  audio.paused = false;
  await vm.runInContext(`_handleNowPlaying({ nft: ${JSON.stringify(gifOne)} });`, context);
  await flush();
  await flush();
  vm.runInContext('_updateNowPlayingPulse();', context);
  await flush();
  await flush();
  for (let index = 0; index < 3; index += 1) vm.runInContext('_updateNowPlayingPulse();', context);
  assert.ok(gifOneCanvas.drawImageCalls > 1);
  const gifOneBeforeSwitch = gifOneCanvas.drawImageCalls;
  const gifTwoBeforeSwitch = gifTwoCanvas.drawImageCalls;
  const staticBeforeSwitch = staticCanvas.drawImageCalls;

  await vm.runInContext(`_handleNowPlaying({ nft: ${JSON.stringify(gifTwo)} });`, context);
  await flush();
  await flush();
  vm.runInContext('_updateNowPlayingPulse();', context);
  await flush();
  await flush();
  for (let index = 0; index < 3; index += 1) vm.runInContext('_updateNowPlayingPulse();', context);
  assert.equal(gifOneCanvas.drawImageCalls, gifOneBeforeSwitch);
  assert.ok(gifTwoCanvas.drawImageCalls > gifTwoBeforeSwitch);
  assert.equal(staticCanvas.drawImageCalls, staticBeforeSwitch);
  const gifTwoBeforeStaticSwitch = gifTwoCanvas.drawImageCalls;

  await vm.runInContext(`_handleNowPlaying({ nft: ${JSON.stringify(staticOne)} });`, context);
  await flush();
  await flush();
  vm.runInContext('_updateNowPlayingPulse();', context);
  await flush();
  await flush();
  for (let index = 0; index < 2; index += 1) vm.runInContext('_updateNowPlayingPulse();', context);
  assert.equal(staticCanvas.drawImageCalls, staticBeforeSwitch);
  assert.equal(gifTwoCanvas.drawImageCalls, gifTwoBeforeStaticSwitch);

  audio.paused = true;
  for (let index = 0; index < 4; index += 1) vm.runInContext('_updateNowPlayingPulse();', context);
  assert.equal(staticCanvas.drawImageCalls, staticBeforeSwitch);

  audio.paused = false;
  vm.runInContext('document.hidden = true;', context);
  for (let index = 0; index < 4; index += 1) vm.runInContext('_updateNowPlayingPulse();', context);
  assert.equal(staticCanvas.drawImageCalls, staticBeforeSwitch);

  vm.runInContext('document.hidden = false; window.matchMedia = () => ({ matches: true }); _nowPlayingReducedMotion = null;', context);
  for (let index = 0; index < 4; index += 1) vm.runInContext('_updateNowPlayingPulse();', context);
  assert.equal(staticCanvas.drawImageCalls, staticBeforeSwitch);

  // An artwork that cannot load (e.g. a huge GIF timing out) must not be re-downloaded every frame.
  vm.runInContext('window.matchMedia = () => ({ matches: false }); _nowPlayingReducedMotion = null;', context);
  const broken = { ...gifOne, tokenId: 34, name: 'Broken Gif', image: 'ipfs://gif-broken', audioUrl: 'ipfs://audio-four' };
  vm.runInContext(`_spawnMesh(${JSON.stringify(broken)}, false);`, context);
  for (let index = 0; index < 4; index += 1) await flush();
  await vm.runInContext(`_handleNowPlaying({ nft: ${JSON.stringify(broken)} });`, context);
  const brokenRequests = () => requested.filter((url) => url.endsWith('/gif-broken')).length;
  for (let index = 0; index < 30; index += 1) {
    vm.runInContext('_updateNowPlayingPulse();', context);
    await flush();
  }
  const afterFirstFailure = brokenRequests();
  for (let index = 0; index < 60; index += 1) {
    vm.runInContext('_updateNowPlayingPulse();', context);
    await flush();
  }
  assert.equal(brokenRequests(), afterFirstFailure, 'failed artwork backs off instead of re-fetching every frame');
});

test('NFT coin textures print details without a shaded panel', () => {
  let fillRectCalls = 0;
  const draw = {
    globalAlpha: 1,
    fillStyle: '',
    shadowColor: '',
    shadowBlur: 0,
    textAlign: '',
    font: '',
    clearRect() {},
    save() {},
    restore() {},
    beginPath() {},
    arc() {},
    clip() {},
    fillRect() { fillRectCalls += 1; },
    measureText: (text) => ({ width: text.length * 12 }),
    fillText() {},
    drawImage() {},
    stroke() {},
  };
  const canvas = { width: 0, height: 0, getContext: () => draw };
  const context = vm.createContext({
    document: { createElement: () => canvas },
    THREE: { CanvasTexture: class { constructor(image) { this.image = image; this.needsUpdate = false; } } },
  });

  vm.runInContext(spaceSource, context);
  vm.runInContext(`_makeNFTTexture({ tokenId: 12, name: 'Coin Song', artist: '0xartist' });`, context);

  assert.equal(fillRectCalls, 1);
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
    fetchNftCatalogPage: async ({ query, offset }) => {
      queries.push({ query, offset });
      if (queries.length < 4) return { nfts: [], total: 1, nextOffset: offset + 25, artists: [] };
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

  assert.ok(queries[0].query.includes('Moonlit Signal'));
  assert.ok(queries[0].query.includes('Synth Artist'));
  assert.ok(queries.length >= 4);
  assert.equal(vm.runInContext('_allNFTs.length', context), 1);
  const entry = vm.runInContext('_allNFTs[0]', context);
  assert.equal(entry.mesh.visible, true);
  assert.equal(entry.mesh.userData.pinnedVisible, true);
  assert.equal(vm.runInContext('_nowPlayingMesh === _allNFTs[0].mesh', context), true);
});

test('shared NFT links load the exact target without autoplaying audio', async () => {
  const { configuredNftCollections, parseNftIdentitySearch, isMusicNft } = await import(loaderUrl);
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
  const panel = {
    open: false,
    classList: { add() {}, remove() {} },
    showModal() { this.open = true; },
    close() { this.open = false; },
  };
  const content = {
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const fields = {
    'dnft-list-items': list,
    'dnft-list-count': { textContent: '' },
    'dnft-list-count-badge': { textContent: '' },
    'artist-filter-count': { textContent: '' },
    'scene-artist-filter': { replaceChildren() {}, value: '', addEventListener() {} },
    'archive-artist-filter': { replaceChildren() {}, value: '', addEventListener() {} },
    'radio-video-stage': { hidden: true },
    'nft-panel': panel,
    'nft-panel-content': content,
    'nft-panel-close': { onclick: null },
  };
  const document = new MockDocument(audio, video, list, fields);
  const nft = {
    tokenId: 23,
    contractAddress: `0x${'7'.repeat(40)}`,
    chainId: 8453,
    name: 'Shared Signal',
    artist: `0x${'8'.repeat(40)}`,
    mintedAt: new Date(Date.now() - 12 * 86_400_000).toISOString(),
    audioUrl: 'ipfs://bafyshared',
  };
  const context = vm.createContext({
    console,
    document,
    window: {
      DecentConfig: {
        chainId: 8453,
        contractAddress: nft.contractAddress,
        ipfsGateway: 'https://gateway.pinata.cloud/ipfs/',
        ipfsUploadServiceUrl: 'https://service.example',
        rpcUrl: 'https://rpc.example',
      },
      location: {
        search: `?chainId=8453&contract=${nft.contractAddress}&tokenId=23`,
        href: `https://busking.example/app/?chainId=8453&contract=${nft.contractAddress}&tokenId=23`,
      },
      addEventListener() {},
    },
    performance: { now: () => 0 },
    CustomEvent,
    Event,
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    nftArtistKey: (value) => String(value.artist || value.creator || value.uploader || 'Unknown artist').trim().toLowerCase(),
    configuredNftCollections,
    parseNftIdentitySearch,
    URLSearchParams,
    isMusicNft,
    setTimeout,
    clearTimeout,
    fetchNftCatalogPage: async () => ({ nfts: [], total: 0, nextOffset: null, artists: [] }),
    fetchIpfsJson: async () => ({ name: nft.name, audioUrl: nft.audioUrl, artist: nft.artist }),
    loadMintedToken: async () => ({ ...nft, metadataUri: 'ipfs://metadata', mintedSupply: 1 }),
    renderNFTCard: (card) => { content.innerHTML = `<h3 id="nft-detail-title">${card.name}</h3>`; },
    getBaseReadProvider: ({ ethers }) => new ethers.JsonRpcProvider('https://mainnet.base.org'),
    ethers: {
      JsonRpcProvider: class { constructor(url) { this.url = url; } },
      Contract: class {
        constructor(address, abi, provider) { this.address = address; this.provider = provider; }
        async totalMinted() { return 1n; }
        async uri() { return 'ipfs://metadata'; }
        async creatorOf() { return nft.artist; }
      },
    },
    THREE: makeThreeStubs(),
  });

  vm.runInContext(`${spaceSource}\n_scene = new THREE.Scene();`, context);
  await vm.runInContext(`_focusSharedNFTFromLocation();`, context);

  assert.equal(panel.open, true);
  assert.match(content.innerHTML, /Shared Signal/);
  assert.equal(vm.runInContext('_allNFTs.length', context), 1);
  assert.equal(vm.runInContext('_allNFTs[0].mesh.userData.pinnedVisible', context), true);
  assert.equal(vm.runInContext('_nowPlayingKey', context), null);
  assert.equal(vm.runInContext('_nowPlayingMesh', context), null);
  panel.open = false;
  content.innerHTML = '';
  context.window.location.search = '?tutorial=payroll&week=NY-2026-10-12';
  await vm.runInContext('_focusSharedNFTFromLocation();', context);
  assert.equal(panel.open, false);
  assert.equal(content.innerHTML, '');
});

test('radio watchlist resolution requires an exact media match instead of title guessing', async () => {
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
      return { nfts: [{ tokenId: 21, contractAddress: `0x${'5'.repeat(40)}`, chainId: 8453, name: 'Moonlit Signal', artist: '0xartist', audioUrl: 'ipfs://different' }],
        total: 1, nextOffset: null, artists: [] };
    },
    THREE: makeThreeStubs(),
  });

  vm.runInContext(`${spaceSource}\n_scene = new THREE.Scene();`, context);
  const result = await vm.runInContext(`resolveNowPlayingNFT({
    title: 'Moonlit Signal',
    artist: 'Synth Artist',
    audioUrl: 'https://gateway.pinata.cloud/ipfs/bafywrong',
    ipfsCid: 'bafywrong',
    mediaType: 'audio/mpeg',
  }, { requireMediaMatch: true });`, context);

  assert.equal(result, null);
  assert.ok(queries[0].includes('Moonlit Signal'));
  assert.ok(queries[0].includes('Synth Artist') || queries[0] === 'Moonlit Signal');
});
