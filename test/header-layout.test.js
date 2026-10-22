const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('mobile ankhs sit beside the top-row IPFS and wallet controls without moving their DOM', () => {
  const source = fs.readFileSync('js/components/header.js', 'utf8');
  const mobileTitle = source.slice(source.indexOf('const MOBILE_APP_TITLE_STYLE'), source.indexOf('const BRAND_TITLE_STYLE'));
  assert.match(mobileTitle, /@media \(max-width: 600px\)/);
  assert.match(mobileTitle, /#app-title-wrapper\s*\{[^}]*position: relative/);
  assert.match(mobileTitle, /\.ankh-left, \.ankh-right\s*\{[^}]*position: absolute;[^}]*top: 7px/);
  assert.match(mobileTitle, /\.ankh-left \{ left: 56px; \}/);
  assert.match(mobileTitle, /\.ankh-right \{ right: 56px; \}/);
  assert.match(source, /installCoinHitArea\(appTitle\?\.shadowRoot, 'Left menu'\)/);
  assert.match(source, /installCoinHitArea\(appTitle\?\.shadowRoot\?\.querySelector\('right-ankh'\)\?\.shadowRoot, 'Right menu'\)/);
});

test('mobile fund pills flank a compact search field and hide only their text labels and Archive toggle', () => {
  const css = fs.readFileSync('css/styles.css', 'utf8');
  assert.match(css, /\.fund-header-label \{ display: none; \}/);
  assert.match(css, /\.fund-header-left \{ grid-column: 1; grid-row: 1; justify-self: start; \}/);
  assert.match(css, /\.fund-header-right \{ grid-column: 3; grid-row: 1; justify-self: end; \}/);
  assert.match(css, /\.artist-filter-core \{ flex: none; grid-column: 2; grid-row: 1; \}/);
  assert.match(css, /#scene-music-search \{ min-height: 28px; padding: 3px 6px; font-size: \.7rem; \}/);
  assert.match(css, /#dnft-archive-toggle \{ display: none; \}/);
});

test('header uses the Frankenstein tagline on desktop and animated icons flanking the mobile title', () => {
  const source = fs.readFileSync('js/components/header.js', 'utf8');
  assert.match(source, /text: ' Another Decent Frankenstein ', className: 'jam-tagline'/);
  assert.match(source, /#app-subtitle\s*\{\s*display: none;/);
  assert.match(source, /\.mobile-jam-left \{ right: 100%; \}/);
  assert.match(source, /\.mobile-jam-right \{ left: 100%; \}/);
  assert.match(source, /icon\.cloneNode\(true\)/);
  assert.doesNotMatch(source, /The Web3 Digital Town Square/);
});

test('mobile hides camera buttons while retaining timeline navigation and touch controls', () => {
  const css = fs.readFileSync('css/styles.css', 'utf8');
  assert.match(css, /@media \(max-width: 600px\)\s*\{\s*#camera-tools \{ display: none; \}/);
  const space = fs.readFileSync('js/space.js', 'utf8');
  assert.match(space, /new THREE\.OrbitControls\(_camera, _renderer\.domElement\)/);
  assert.match(space, /_controls\.enablePan = true/);
});

test('mobile translucent subheader overlaps the lower avatar and raises the side tabs', () => {
  const css = fs.readFileSync('css/styles.css', 'utf8');
  assert.match(css, /:root \{ --left-tab-top: 136px; \}/);
  assert.match(css, /#artist-filter-bar\s*\{[^}]*top: calc\(var\(--header-height, 112px\) - 32px\);[^}]*z-index: 101;[^}]*background: rgba\(5, 3, 18, \.72\)/);
});

test('mobile uses a single-row timeline, shorter tabs and tighter drawer clearance', () => {
  const css = fs.readFileSync('css/styles.css', 'utf8');
  assert.match(css, /#timeline-slider-wrap \{ flex-direction: row; gap: 4px; \}/);
  assert.match(css, /#top-ten-tab, #djuke-tab, button#devert-tab \{ height: 62px; min-height: 62px/);
  assert.match(css, /#djuke-tab \{ top: calc\(var\(--left-tab-top\) \+ 66px\)/);
  assert.match(css, /#devert-tab \{ top: calc\(var\(--left-tab-top\) \+ 132px\)/);
  assert.match(css, /#djuke-panel, #devert-panel \{ bottom: calc\(var\(--radio-footer-height, 96px\) \+ 8px\)/);
});

test('all local consumers share one space, stage and radio module instance', () => {
  const versions = new Map();
  for (const directory of ['js', 'js/components']) {
    for (const name of fs.readdirSync(directory).filter(name => /\.(js|mjs)$/.test(name))) {
      const source = fs.readFileSync(`${directory}/${name}`, 'utf8');
      for (const match of source.matchAll(/(?:\.\/|\.\.\/)(space\.js|stage\.js|radio-sync\.js)\?v=([^'"]+)/g)) {
        if (!versions.has(match[1])) versions.set(match[1], new Set());
        versions.get(match[1]).add(match[2]);
      }
    }
  }
  for (const [name, values] of versions) {
    assert.equal(values.size, 1, `${name} must not load duplicate stateful modules`);
  }
});

test('DecentHead CDN imports are pinned to an immutable commit, never a moving branch', () => {
  for (const file of ['js/components/header.js', 'js/components/header-right-ankh-override.js']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /DecentHead@(main|master|latest)\b/, `${file} must not track a moving DecentHead branch`);
    assert.match(source, /DecentHead@[0-9a-f]{40}\//, `${file} must pin DecentHead to a full commit SHA`);
  }
});
