const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const tutorialSource = fs.readFileSync(path.join(__dirname, '../js/tutorial.js'), 'utf8')
  .replace(/^export /gm, '');

function makeClassList() {
  const values = new Set();
  return {
    values,
    add(...classes) { classes.forEach((cls) => values.add(cls)); },
    remove(...classes) { classes.forEach((cls) => values.delete(cls)); },
    contains(cls) { return values.has(cls); },
  };
}

function makeNode(tag) {
  return {
    tagName: tag.toUpperCase(),
    textContent: '',
    innerHTML: '',
    hidden: false,
    style: {},
    attributes: {},
    children: [],
    dataset: {},
    classList: makeClassList(),
    isConnected: true,
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; this.textContent = ''; },
    appendChild(node) { this.children.push(node); return node; },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === 'id') this.id = String(value);
      if (name === 'data-tutorial-launch') this.dataset.tutorialLaunch = String(value);
    },
    getAttribute(name) { return this.attributes[name]; },
    addEventListener(type, handler) {
      this.listeners ||= {};
      this.listeners[type] ||= [];
      this.listeners[type].push(handler);
    },
    focus() { this.focused = true; },
    scrollIntoView() { this.scrolledIntoView = true; },
    querySelector() { return null; },
    getBoundingClientRect() { return this.bounds || { left: 0, top: 0, width: 0, height: 0 }; },
    click() { this.listeners?.click?.forEach(handler => handler({ stopPropagation() {} })); },
    remove() { this.removed = true; },
  };
}

function makeStorage() {
  const entries = new Map();
  return {
    entries,
    getItem(key) { return entries.has(key) ? entries.get(key) : null; },
    setItem(key, value) { entries.set(key, String(value)); },
    removeItem(key) { entries.delete(key); },
  };
}

function createTutorialContext(storage = makeStorage()) {
  const timerQueue = [];
  const launchButton = makeNode('button');
  launchButton.setAttribute('data-tutorial-launch', '1');
  const targets = {
    '#now-playing-label': makeNode('span'),
    '#guitar-case-btn': makeNode('button'),
    '#radio-voting': makeNode('div'),
    '#top-ten-tab': makeNode('button'),
    '#devert-tab': makeNode('button'),
    '#djuke-tab': makeNode('button'),
  };
  const clicks = [];
  for (const id of ['top-ten-panel', 'devert-panel', 'djuke-panel', 'dnft-list', 'dnft-archive-toggle', 'mint-modal', 'mint-modal-inner', 'mint-submit-btn', 'mint-status', 'mint-cancel-btn', 'djuke-search', 'djuke-add-selected-playlist', 'djuke-playlist-save', 'djuke-named-playlist-private', 'djuke-named-playlist-radio', 'artist-filter-bar']) {
    targets[`#${id}`] = makeNode('div');
  }
  Object.entries(targets).forEach(([selector, node]) => { node.id = selector.slice(1); });
  targets['.djuke-playlist-draft'] = makeNode('details');
  targets['.djuke-playlist-draft'].open = false;
  targets['.djuke-body'] = makeNode('div');
  targets['.djuke-body'].scrollTop = 0;
  targets['#mint-modal'].classList.add('hidden');
  ['top-ten-tab', 'devert-tab', 'djuke-tab', 'dnft-archive-toggle'].forEach(id => {
    targets[`#${id}`].setAttribute('aria-expanded', 'false');
    targets[`#${id}`].click = () => {
      clicks.push(id);
      const node = targets[`#${id}`];
      node.setAttribute('aria-expanded', node.getAttribute('aria-expanded') === 'true' ? 'false' : 'true');
    };
  });
  targets['#guitar-case-btn'].click = () => { clicks.push('guitar-case-btn'); targets['#mint-modal'].classList.remove('hidden'); };
  targets['#mint-cancel-btn'].click = () => { clicks.push('mint-cancel-btn'); targets['#mint-modal'].classList.add('hidden'); };
  const rightMenu = makeNode('ul');
  const leftMenu = makeNode('ul');
  rightMenu.style.display = 'none';
  leftMenu.style.display = 'none';
  const rightCoin = makeNode('button');
  const leftCoin = makeNode('button');
  [[rightCoin, rightMenu], [leftCoin, leftMenu]].forEach(([coin, menu]) => {
    coin.click = () => { clicks.push('menu-coin'); menu.style.display = menu.style.display === 'none' ? 'block' : 'none'; };
  });
  const rightRoot = { querySelector: selector => selector === '.dropdown-menu' ? rightMenu : rightCoin };
  const titleRoot = { querySelector: selector => selector === 'right-ankh' ? { shadowRoot: rightRoot } : selector.includes('dropdown-menu') ? leftMenu : leftCoin };
  targets['decent-header'] = { shadowRoot: { querySelector: () => ({ shadowRoot: titleRoot }) } };
  const findId = (node, id) => node.id === id ? node : node.children?.map(child => findId(child, id)).find(Boolean);
  const document = {
    head: makeNode('head'),
    body: makeNode('body'),
    createElement: (tag) => makeNode(tag),
    getElementById: id => typeof id === 'string' ? targets[`#${id}`] || findId(document.body, id) || findId(document.head, id) || null : null,
    querySelector: (selector) => targets[selector] || null,
    querySelectorAll: (selector) => (selector === '[data-tutorial-launch]' ? [launchButton] : []),
    addEventListener() {},
  };
  for (const node of Object.values(targets)) {
    node.focus = () => { node.focused = true; document.activeElement = node; };
  }
  document.createElement = tag => {
    const node = makeNode(tag);
    node.focus = () => { node.focused = true; document.activeElement = node; };
    return node;
  };
  document.body.classList = makeClassList();
  document.body.appendChild = function appendChild(node) { this.children.push(node); return node; };
  document.body.children = [];
  document.head.appendChild = function appendChild(node) { this.children.push(node); return node; };
  document.head.children = [];

  const context = vm.createContext({
    console,
    URLSearchParams,
    document,
    window: { localStorage: storage, getComputedStyle: element => ({ display: element.style.display }), scrollTo() {} },
    localStorage: storage,
    setTimeout: (fn) => { timerQueue.push(fn); return timerQueue.length; },
    clearTimeout: (id) => { timerQueue[id - 1] = null; },
    targets,
  });

  vm.runInContext(tutorialSource, context);
  return { context, storage, timerQueue, launchButton, targets, document, clicks, rightMenu, leftMenu };
}

test('tutorial walkthrough auto-launches on an introductory visit and marks visitors seen', () => {
  const { context, storage, timerQueue, launchButton, targets, document } = createTutorialContext();
  vm.runInContext('initTutorial();', context);

  assert.equal(timerQueue.length, 1);
  assert.equal(launchButton.children[1].textContent, 'Follow the white rabbit');

  timerQueue[0]();
  assert.equal(vm.runInContext('_overlay.hidden', context), false);
  assert.equal(vm.runInContext('_currentStep', context), 0);
  assert.equal(document.body.classList.contains('decentbusking-tutorial-open'), true);

  vm.runInContext('nextTutorialStep();', context);
  assert.equal(vm.runInContext('_currentStep', context), 1);
  assert.equal(vm.runInContext('_currentTarget === targets["#now-playing-label"]', context), true);
  assert.equal(targets['#now-playing-label'].classList.contains('decentbusking-tutorial-highlight'), true);

  vm.runInContext('skipTutorial();', context);
  assert.equal(vm.runInContext('_overlay.hidden', context), true);
  assert.equal(storage.getItem('decentbusking:tutorial:seen:v1'), '1');
  assert.equal(launchButton.children[1].textContent, 'Follow the white rabbit');
  assert.equal(document.getElementById('rabbit-tour-launch').hidden, true);
  vm.runInContext('_autoLaunch(); syncTutorialLaunchButtons();', context);
  assert.equal(document.getElementById('rabbit-tour-launch').hidden, true);
  assert.equal(timerQueue.filter(Boolean).length, 1);
});

test('incomplete tutorials auto-open after refresh regardless of past visits or the old seen flag', () => {
  for (const previousVisits of [0, 1, 2, 3, 10]) {
    const { context, storage, timerQueue, document, launchButton } = createTutorialContext();
    storage.setItem('decentbusking:tutorial:visits:v1', String(previousVisits));
    storage.setItem('decentbusking:tutorial:seen:v1', '1');
    vm.runInContext('initTutorial();', context);
    assert.equal(timerQueue.length, 1);
    assert.equal(document.getElementById('rabbit-tour-launch').hidden, false);
    timerQueue[0]();
    assert.equal(vm.runInContext('_overlay.hidden', context), false);
    assert.equal(launchButton.hidden, false);
    vm.runInContext('initTutorial();', context);
    assert.equal(timerQueue.length, 1);
  }
});

test('refresh resumes the furthest card and playlist hop, never the most recent Back destination', () => {
  const first = createTutorialContext();
  vm.runInContext('initTutorial(); startTutorial(); while (_currentStep < 7) nextTutorialStep(); nextTutorialStep(); nextTutorialStep(); previousTutorialStep(); skipTutorial();', first.context);
  assert.deepEqual(JSON.parse(first.storage.getItem('decentbusking:tutorial:progress:v1')), { step: 7, hop: 2 });
  const refreshed = createTutorialContext(first.storage);
  vm.runInContext('initTutorial();', refreshed.context);
  refreshed.timerQueue[0]();
  assert.equal(vm.runInContext('_currentStep', refreshed.context), 7);
  assert.equal(vm.runInContext('_playlistHop', refreshed.context), 2);
  assert.equal(vm.runInContext('_overlay.hidden', refreshed.context), false);
});

test('seeing every card completes the tutorial even if Leave is used on the final card; About can replay', () => {
  const first = createTutorialContext();
  vm.runInContext('initTutorial(); startTutorial(); while (_currentStep < TUTORIAL_STEPS.length - 1) nextTutorialStep(); skipTutorial();', first.context);
  assert.equal(first.storage.getItem('decentbusking:tutorial:completed:v1'), '1');
  const refreshed = createTutorialContext(first.storage);
  vm.runInContext('initTutorial();', refreshed.context);
  assert.equal(refreshed.timerQueue.length, 0);
  assert.equal(refreshed.document.getElementById('rabbit-tour-launch').hidden, true);
  assert.equal(refreshed.launchButton.hidden, false);
  vm.runInContext('startTutorial();', refreshed.context);
  assert.equal(vm.runInContext('_currentStep', refreshed.context), 0);
  assert.equal(vm.runInContext('_overlay.hidden', refreshed.context), false);
});

test('invalid persisted progress is ignored without stopping the tour', () => {
  for (const saved of ['broken', '{"step":999,"hop":0}', '{"step":-1,"hop":0}', '{"step":7,"hop":99}']) {
    const fixture = createTutorialContext();
    fixture.storage.setItem('decentbusking:tutorial:progress:v1', saved);
    vm.runInContext('initTutorial();', fixture.context);
    fixture.timerQueue[0]();
    assert.equal(vm.runInContext('_currentStep', fixture.context), 0);
  }
});

test('completed visitors skip automatic openings and the landing launcher even during introductory visits', () => {
  const { context, storage, timerQueue, document } = createTutorialContext();
  storage.setItem('decentbusking:tutorial:completed:v1', '1');
  vm.runInContext('initTutorial();', context);
  assert.equal(timerQueue.length, 0);
  assert.equal(document.getElementById('rabbit-tour-launch').hidden, true);
  vm.runInContext('startTutorial();', context);
  assert.equal(vm.runInContext('_overlay.hidden', context), false);
});

test('landing launcher belongs to the main scene and Discord remains an accessible icon link', () => {
  assert.match(tutorialSource, /\(document\.querySelector\('main'\) \|\| document\.body\)\.appendChild\(launcher\)/);
  assert.match(tutorialSource, /#rabbit-tour-launch\s*\{[^}]*left: 50%;[^}]*top: calc/);
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const link = html.match(/<a id="footer-discord-link"[^>]*>[\s\S]*?<\/a>/)[0];
  assert.match(link, /aria-label="Join DecentBusking on Discord"/);
  assert.match(link, /<img[^>]*discord\.svg/);
  assert.doesNotMatch(link, />💬 Discord</);
  const stage = html.match(/<div id="center-stage">[\s\S]*?<\/div>/)[0];
  assert.match(stage, /id="hat-btn"[\s\S]*id="footer-discord-link"/);
  const footer = html.match(/<footer id="radio-footer">[\s\S]*?<\/footer>/)[0];
  assert.doesNotMatch(footer, /footer-discord-link/);
});

test('tutorial launch buttons can be relabeled inside arbitrary roots', () => {
  const { context, storage } = createTutorialContext();
  storage.setItem('decentbusking:tutorial:seen:v1', '1');
  const button = makeNode('button');
  const root = { querySelectorAll: (selector) => (selector === '[data-tutorial-launch]' ? [button] : []) };
  context.root = root;
  vm.runInContext('syncTutorialLaunchButtons(root);', context);
  assert.equal(button.children[1].textContent, 'Follow the white rabbit');
  assert.equal(button.getAttribute('aria-label'), 'Follow the white rabbit: explore DecentBusking');
  assert.equal(button.classList.contains('rabbit-tour-launch'), true);
});

test('only finishing the entire tour hides the landing launcher while About retains the same rabbit button', () => {
  const { context, storage, document, launchButton } = createTutorialContext();
  vm.runInContext('initTutorial(); startTutorial(); completeTutorial();', context);
  assert.equal(storage.getItem('decentbusking:tutorial:completed:v1'), null);
  assert.equal(document.getElementById('rabbit-tour-launch').hidden, false);
  vm.runInContext('skipTutorial(); startTutorial();', context);
  for (let i = 0; i < 19; i++) vm.runInContext('nextTutorialStep();', context);
  assert.equal(storage.getItem('decentbusking:tutorial:completed:v1'), '1');
  assert.equal(document.getElementById('rabbit-tour-launch').hidden, true);
  assert.equal(launchButton.hidden, false);
  assert.equal(launchButton.children[1].textContent, 'Follow the white rabbit');
  vm.runInContext('startTutorial(); skipTutorial();', context);
  assert.equal(document.getElementById('rabbit-tour-launch').hidden, true);
});

test('about modal exposes a tutorial launch button', () => {
  const aboutSource = fs.readFileSync(path.join(__dirname, '../js/components/about-override.js'), 'utf8');
  assert.match(aboutSource, /data-tutorial-launch/);
  assert.match(aboutSource, /Start Tutorial/);
});

test('tutorial copy now mentions NFT card Preview and Listen actions', () => {
  const { context } = createTutorialContext();
  assert.match(vm.runInContext('TUTORIAL_STEPS[6].body', context), /Preview for a free 30-second sample/);
  assert.match(vm.runInContext('TUTORIAL_STEPS[6].body', context), /Listen to play the whole song/);
});

test('Mercury accompanies the rabbit through real surfaces, with no transactional or playback clicks', () => {
  const { context, clicks, targets, rightMenu, leftMenu, document } = createTutorialContext();
  vm.runInContext('initTutorial(); startTutorial();', context);
  assert.ok(document.getElementById('rabbit-tour-launch'));
  const steps = vm.runInContext('TUTORIAL_STEPS.length', context);
  assert.equal(steps, 12);
  vm.runInContext('nextTutorialStep(); nextTutorialStep();', context);
  assert.equal(targets['#mint-modal'].classList.contains('hidden'), false);
  vm.runInContext('nextTutorialStep(); nextTutorialStep();', context);
  assert.equal(targets['#mint-modal'].classList.contains('hidden'), true);
  assert.equal(targets['#top-ten-tab'].getAttribute('aria-expanded'), 'true');
  vm.runInContext('while (_currentStep < 9) nextTutorialStep();', context);
  assert.equal(rightMenu.style.display, 'block');
  vm.runInContext('nextTutorialStep();', context);
  assert.equal(rightMenu.style.display, 'none');
  assert.equal(leftMenu.style.display, 'block');
  vm.runInContext('nextTutorialStep(); nextTutorialStep();', context);
  assert.equal(leftMenu.style.display, 'none');
  assert.equal(vm.runInContext('_overlay.hidden', context), true);
  assert.ok(clicks.every(id => ['guitar-case-btn', 'mint-cancel-btn', 'top-ten-tab', 'devert-tab', 'djuke-tab', 'dnft-archive-toggle', 'menu-coin'].includes(id)));
  assert.equal(vm.runInContext('_rabbit.children[0].children[0].children[0].textContent', context), '🐇');
  assert.match(document.head.children[0].textContent, /prefers-reduced-motion/);
  assert.match(document.head.children[0].textContent, /rabbit-peek 6.5s/);
  assert.match(vm.runInContext('_panel.children[0].children[0].textContent', context), /💸/);
  assert.equal(vm.runInContext('_panel.children[0].children[1].textContent', context), '☿');
  assert.equal(vm.runInContext('_panel.children[1].children[0].textContent', context), 'Follow the White Rabbit');
});

test('Mercury keeps his symbol and flying-money ride but changes musical gear at every stop', () => {
  const { context } = createTutorialContext();
  vm.runInContext('initTutorial(); startTutorial();', context);
  const count = vm.runInContext('TUTORIAL_STEPS.length', context);
  const props = new Set();
  for (let index = 0; index < count; index++) {
    const prop = vm.runInContext('_propEl.textContent', context);
    assert.ok(prop);
    assert.equal(props.has(prop), false);
    props.add(prop);
    assert.equal(vm.runInContext('_panel.children[0].children[1].textContent', context), '☿');
    assert.equal(vm.runInContext('_panel.children[0].children[0].textContent', context), '💸');
    assert.equal(vm.runInContext('_stepLabelEl.textContent', context), `${index + 1} / ${count}${index === 7 ? ' · Hop 1 / 8' : ''}`);
    vm.runInContext(`while (_currentStep === ${index} && !_overlay.hidden) nextTutorialStep();`, context);
  }
  vm.runInContext('startTutorial();', context);
  assert.equal(vm.runInContext('_propEl.textContent', context), '🎺');
  assert.equal(vm.runInContext('_propEl.attributes["data-instrument"]', context), 'trumpet');
  assert.match(tutorialSource, /\.mercury-prop\[data-instrument="trumpet"\]\s*\{\s*transform: scaleX\(-1\)/);
  vm.runInContext('nextTutorialStep(); previousTutorialStep();', context);
  assert.equal(vm.runInContext('_propEl.textContent', context), '🎺');
});

test('rabbit dives from the centered card hole, emerges at the feature, and returns before changing cards', () => {
  const { context, targets, timerQueue } = createTutorialContext();
  vm.runInContext(`
    window.innerWidth = 1440; window.innerHeight = 1000;
    window.matchMedia = () => ({ matches: false });
    initTutorial();
    _panel.bounds = { left: 500, top: 250, width: 390, height: 420 };
  `, context);
  targets['#now-playing-label'].bounds = { left: 600, top: 850, width: 140, height: 30 };
  targets['#mint-modal-inner'].bounds = { left: 400, top: 100, width: 640, height: 700 };
  const tick = () => {
    const index = timerQueue.findIndex(fn => fn !== null);
    assert.notEqual(index, -1);
    const fn = timerQueue[index];
    timerQueue[index] = null;
    fn();
  };
  vm.runInContext('startTutorial(); nextTutorialStep();', context);
  assert.equal(vm.runInContext('_rabbitAtHome', context), true);
  assert.equal(vm.runInContext('_stepLabelEl.textContent', context), '2 / 12');
  assert.equal(vm.runInContext('_journeyBusy', context), true);
  vm.runInContext('nextTutorialStep();', context);
  assert.equal(vm.runInContext('_currentStep', context), 1);
  tick();
  assert.equal(vm.runInContext('_rabbit.dataset.phase', context), 'diving');
  tick();
  assert.equal(vm.runInContext('_rabbitAtHome', context), false);
  assert.equal(vm.runInContext('_rabbit.dataset.phase', context), 'emerging');
  assert.equal(vm.runInContext('_spotlight.classList.contains("is-magical")', context), true);
  tick();
  assert.equal(vm.runInContext('_journeyBusy', context), false);
  vm.runInContext('nextTutorialStep();', context);
  assert.equal(vm.runInContext('_rabbit.dataset.phase', context), 'diving');
  assert.equal(vm.runInContext('_currentStep', context), 1);
  tick();
  assert.equal(vm.runInContext('_rabbitAtHome', context), true);
  assert.equal(vm.runInContext('_rabbit.dataset.phase', context), 'emerging');
  tick();
  assert.equal(vm.runInContext('_currentStep', context), 2);
  assert.equal(vm.runInContext('_rabbitAtHome', context), true);
  tick();
  assert.equal(vm.runInContext('_rabbit.dataset.phase', context), 'diving');
  vm.runInContext('skipTutorial();', context);
  assert.equal(vm.runInContext('_journeyBusy', context), false);
  assert.equal(timerQueue.filter(Boolean).length, 0);
  vm.runInContext('startTutorial();', context);
  assert.equal(vm.runInContext('_currentStep', context), 0);
  assert.equal(vm.runInContext('_rabbitAtHome', context), true);
});

test('reduced motion changes stops directly with no rabbit journey timers or instrument captions', () => {
  const { context, timerQueue } = createTutorialContext();
  vm.runInContext(`
    window.matchMedia = () => ({ matches: true });
    initTutorial(); startTutorial(); nextTutorialStep(); nextTutorialStep();
  `, context);
  assert.equal(vm.runInContext('_currentStep', context), 2);
  assert.equal(vm.runInContext('_journeyBusy', context), false);
  assert.equal(timerQueue.filter(Boolean).length, 0);
  assert.equal(vm.runInContext('_stepLabelEl.textContent', context), '3 / 12');
  assert.equal(vm.runInContext('_panel.children[1].children[1] === _stepLabelEl', context), true);
  assert.doesNotMatch(vm.runInContext('_stepLabelEl.textContent', context), /Rabbit hole|microphone/);
});

test('Mercury emits decorative notes and sound waves without creating an audio player', () => {
  const { context, document } = createTutorialContext();
  vm.runInContext('initTutorial(); startTutorial();', context);
  assert.equal(vm.runInContext('_panel.children[0].children[3].className', context), 'mercury-sound');
  assert.equal(vm.runInContext('_panel.children[0].children[4].children.map(node => node.textContent).join("")', context), '♪♫♪');
  const styles = document.head.children[0].textContent;
  assert.match(styles, /@keyframes mercury-notes/);
  assert.match(styles, /@keyframes mercury-sound/);
  assert.match(styles, /prefers-reduced-motion: reduce[\s\S]*\.is-arriving \.mercury-note[\s\S]*animation: none/);
  assert.doesNotMatch(tutorialSource, /new Audio|speechSynthesis|\.play\(/);
});

test('leaving restores drawers, menus, visible briefcase drafts and launch focus without resetting the form', () => {
  const { context, targets, clicks, rightMenu, document } = createTutorialContext();
  targets['#mint-modal'].classList.remove('hidden');
  targets['#mint-modal'].draft = 'Keep this unsent song and collaborators';
  targets['#djuke-tab'].setAttribute('aria-expanded', 'true');
  rightMenu.style.display = 'block';
  vm.runInContext('initTutorial();', context);
  document.activeElement = document.getElementById('rabbit-tour-launch');
  vm.runInContext('startTutorial(); nextTutorialStep(); nextTutorialStep();', context);
  assert.equal(targets['#mint-modal'].classList.contains('hidden'), false);
  vm.runInContext('nextTutorialStep(); previousTutorialStep(); skipTutorial();', context);
  assert.equal(targets['#mint-modal'].classList.contains('hidden'), false);
  assert.equal(targets['#mint-modal'].draft, 'Keep this unsent song and collaborators');
  assert.equal(targets['#djuke-tab'].getAttribute('aria-expanded'), 'true');
  assert.equal(rightMenu.style.display, 'block');
  assert.equal(clicks.includes('guitar-case-btn'), false);
  assert.equal(clicks.includes('mint-cancel-btn'), false);
  assert.equal(document.activeElement.id, 'guitar-case-btn');
  assert.equal(vm.runInContext('_currentTarget', context), null);
});

test('pending uploads, open dialogs and VertLoop defer the tour explicitly without disturbing their state', () => {
  const { context, targets, document, clicks } = createTutorialContext();
  vm.runInContext('initTutorial();', context);
  targets['#mint-submit-btn'].disabled = true;
  targets['#mint-status'].textContent = 'Uploading…';
  vm.runInContext('startTutorial();', context);
  assert.equal(vm.runInContext('_overlay.hidden', context), true);
  assert.equal(targets['#mint-status'].textContent, 'Uploading…');
  assert.match(vm.runInContext('_notice.textContent', context), /Finish your current submission/);
  targets['#mint-submit-btn'].disabled = false;
  const dialog = makeNode('dialog');
  targets['dialog[open]'] = dialog;
  vm.runInContext('startTutorial();', context);
  assert.equal(vm.runInContext('_overlay.hidden', context), true);
  assert.equal(dialog.focused, true);
  assert.match(dialog.children[0].textContent, /close this window/);
  delete targets['dialog[open]'];
  targets['#devert-audio-mode'] = makeNode('button');
  targets['#devert-audio-mode'].setAttribute('aria-pressed', 'true');
  vm.runInContext('startTutorial();', context);
  assert.equal(vm.runInContext('_overlay.hidden', context), true);
  assert.match(vm.runInContext('_notice.textContent', context), /VertLoop/);
  assert.equal(clicks.length, 0);
  assert.ok(document.body);
});

test('tutorial permits keyboard exploration and Escape dismisses all tour UI', () => {
  const { context, document } = createTutorialContext();
  vm.runInContext('initTutorial(); startTutorial();', context);
  const event = key => ({ key, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } });
  context.event = event('Tab');
  vm.runInContext('_handleKeydown(event);', context);
  assert.equal(context.event.prevented, undefined);
  vm.runInContext('_panel.focus();', context);
  context.event = event('ArrowRight');
  vm.runInContext('_handleKeydown(event);', context);
  assert.equal(vm.runInContext('_currentStep', context), 1);
  assert.equal(context.event.stopped, true);
  context.event = event('Escape');
  vm.runInContext('_handleKeydown(event);', context);
  assert.equal(vm.runInContext('_overlay.hidden', context), true);
  assert.equal(document.body.classList.contains('decentbusking-tutorial-open'), false);
  assert.equal(document.getElementById('rabbit-tour-launch').hidden, true);
  assert.equal(context.event.stopped, true);
  vm.runInContext('targets["#radio-voting"].focus();', context);
  context.event = event('ArrowRight');
  vm.runInContext('_handleKeydown(event);', context);
  assert.equal(context.event.prevented, undefined);
  assert.equal(vm.runInContext('_currentStep', context), 1);
});

test('outside clicks leave the tutorial open; only explicit close and leave controls dismiss it', () => {
  const { context, document } = createTutorialContext();
  vm.runInContext('initTutorial(); startTutorial(); _backdrop.click(); targets["#radio-voting"].click();', context);
  assert.equal(vm.runInContext('_overlay.hidden', context), false);
  assert.equal(vm.runInContext('_panel.getAttribute("aria-modal")', context), 'false');
  assert.match(document.head.children[0].textContent, /\.decentbusking-tutorial-overlay\s*\{[^}]*pointer-events: none/);
  assert.match(document.head.children[0].textContent, /\.decentbusking-tutorial-card\s*\{[^}]*pointer-events: auto/);
  vm.runInContext('_closeButton.click();', context);
  assert.equal(vm.runInContext('_overlay.hidden', context), true);
  vm.runInContext('startTutorial(); _skipButton.click();', context);
  assert.equal(vm.runInContext('_overlay.hidden', context), true);
});
test('tour text and spotlight fit a narrow viewport without covering the highlighted drawer header', () => {
  const { context, targets } = createTutorialContext();
  vm.runInContext('initTutorial(); startTutorial();', context);
  vm.runInContext('window.innerWidth = 360; window.innerHeight = 640; _panel.bounds = { width: 328, height: 340 };', context);
  targets['#top-ten-panel'].bounds = { left: 0, top: 140, width: 360, height: 350 };
  vm.runInContext('_currentStep = 4; _renderStep();', context);
  const panelLeft = parseFloat(vm.runInContext('_panel.style.left', context));
  const panelTop = parseFloat(vm.runInContext('_panel.style.top', context));
  const spotTop = parseFloat(vm.runInContext('_spotlight.style.top', context));
  const spotHeight = parseFloat(vm.runInContext('_spotlight.style.height', context));
  assert.ok(panelLeft >= 0 && panelLeft + 328 <= 360);
  assert.ok(panelTop >= 0 && panelTop + 340 <= 640);
  assert.ok(spotTop + spotHeight <= panelTop);
});

test('tour uses factual rabbit-themed copy and a smaller money icon without a Mercury narrator', () => {
  const { context, document } = createTutorialContext();
  vm.runInContext('initTutorial(); startTutorial();', context);
  const copy = vm.runInContext('TUTORIAL_STEPS.map(step => step.title + " " + step.body).join(" ")', context);
  assert.doesNotMatch(copy, /Mercury|messenger|narrator|I’m|I won’t|not just the little symbol/);
  assert.match(vm.runInContext('TUTORIAL_STEPS[9].body', context), /right ankh menu.*Profile and Public Schedule/);
  assert.match(document.head.children[0].textContent, /\.mercury-money \{[^}]*font-size: 22px/);
  assert.equal(document.getElementById('rabbit-tour-launch').getAttribute('aria-label'), 'Follow the white rabbit: explore DecentBusking');
});

test('playlist deep link opens the guided card for incomplete returning visitors', () => {
  const { context, storage, targets, timerQueue } = createTutorialContext();
  storage.setItem('decentbusking:tutorial:visits:v1', '20');
  vm.runInContext("window.location = { search: '?tutorial=playlists' }; initTutorial();", context);
  assert.equal(timerQueue.filter(Boolean).length, 1);
  const launch = timerQueue[0];
  timerQueue[0] = null;
  launch();
  assert.equal(vm.runInContext('_overlay.hidden', context), false);
  assert.equal(vm.runInContext('TUTORIAL_STEPS[_currentStep].id', context), 'playlists');
  assert.equal(vm.runInContext('_playlistHop', context), 0);
  assert.equal(vm.runInContext('_currentTarget === targets["#djuke-search"]', context), true);
  assert.equal(targets['#djuke-tab'].getAttribute('aria-expanded'), 'true');
  assert.equal(targets['.djuke-playlist-draft'].open, true);
  assert.equal(vm.runInContext('_backButton.disabled', context), true);
  assert.equal(timerQueue.filter(Boolean).length, 0);
});

test('playlist deep links resume their furthest hop and stay hidden after every linked card is viewed', () => {
  const first = createTutorialContext();
  vm.runInContext("window.location = { search: '?tutorial=playlists' }; initTutorial();", first.context);
  first.timerQueue[0]();
  vm.runInContext('nextTutorialStep(); nextTutorialStep(); previousTutorialStep(); skipTutorial();', first.context);
  const refreshed = createTutorialContext(first.storage);
  vm.runInContext("window.location = { search: '?tutorial=playlists' }; initTutorial();", refreshed.context);
  refreshed.timerQueue[0]();
  assert.equal(vm.runInContext('_playlistHop', refreshed.context), 2);
  vm.runInContext('while (_playlistHop < PLAYLIST_HOPS.length - 1) nextTutorialStep(); skipTutorial();', refreshed.context);
  const finished = createTutorialContext(first.storage);
  vm.runInContext("window.location = { search: '?tutorial=playlists' }; initTutorial();", finished.context);
  assert.equal(finished.timerQueue.length, 0);
  assert.equal(finished.document.getElementById('rabbit-tour-launch').hidden, true);
  assert.equal(first.storage.getItem('decentbusking:tutorial:completed:v1'), null);
});
test('completed visitors do not reopen automatically even with a playlist URL; About can still replay it', () => {
  const fixture = createTutorialContext();
  fixture.storage.setItem('decentbusking:tutorial:completed:v1', '1');
  vm.runInContext("window.location = { search: '?tutorial=playlists' }; initTutorial();", fixture.context);
  assert.equal(fixture.timerQueue.length, 0);
  vm.runInContext("startTutorial({ card: 'playlists' });", fixture.context);
  assert.equal(vm.runInContext('_overlay.hidden', fixture.context), false);
});
test('playlist hops spotlight actual controls, explain both payment splits and demonstrate radio without buying', () => {
  const { context, clicks, targets, storage } = createTutorialContext();
  targets['.djuke-playlist-draft'].draft = ['Keep my existing song'];
  vm.runInContext("initTutorial(); startTutorial({ card: 'playlists' });", context);
  const selectors = ['#djuke-search', '#djuke-add-selected-playlist', '.djuke-playlist-draft',
    '#djuke-playlist-save', '#djuke-named-playlist-private', '#djuke-named-playlist-radio',
    '#artist-filter-bar', '#now-playing-label'];
  for (const [index, selector] of selectors.entries()) {
    assert.equal(vm.runInContext('_playlistHop', context), index);
    assert.equal(vm.runInContext('_currentTarget', context), targets[selector]);
    assert.equal(vm.runInContext('_backButton.disabled', context), index === 0);
    if (index === 5) {
      assert.match(vm.runInContext('_bodyEl.textContent', context), /\$3 for 1–12; \$6 for 13–24/);
    }
    if (index === 6) {
      const text = vm.runInContext('_bodyEl.textContent', context);
      assert.match(text, /90 \/ 8 \/ 2/);
      assert.match(text, /25% each to Playback, Top 10, Pinners, and Development/);
      assert.match(text, /reserved until every song is delivered/);
      assert.equal(vm.runInContext('_illustration.children[1].children.length', context), 4);
    }
    if (index === 7) {
      assert.match(vm.runInContext('_bodyEl.textContent', context), /current song and protected shows/);
      assert.match(vm.runInContext('_illustration.children[0].textContent', context), /not live playback/);
      assert.equal(vm.runInContext('_nextButton.textContent', context), 'Go explore DJuke');
    }
    vm.runInContext('nextTutorialStep();', context);
  }
  assert.equal(vm.runInContext('_overlay.hidden', context), true);
  assert.equal(storage.getItem('decentbusking:tutorial:completed:v1'), null);
  assert.equal(targets['#djuke-tab'].getAttribute('aria-expanded'), 'true');
  assert.equal(targets['.djuke-playlist-draft'].open, true);
  assert.deepEqual(targets['.djuke-playlist-draft'].draft, ['Keep my existing song']);
  assert.ok(clicks.every(id => id === 'djuke-tab'));
  assert.equal(clicks.length, 3);
});

test('playlist card supports backward hops and restores disclosure state on early exit', () => {
  for (const open of [false, true]) {
    const { context, targets } = createTutorialContext();
    targets['.djuke-playlist-draft'].open = open;
    targets['.djuke-body'].scrollTop = 80;
    targets['#djuke-tab'].setAttribute('aria-expanded', 'true');
    vm.runInContext("initTutorial(); startTutorial({ card: 'playlists' }); previousTutorialStep();", context);
    assert.equal(vm.runInContext('_playlistHop', context), 0);
    targets['.djuke-body'].scrollTop = 240;
    vm.runInContext('nextTutorialStep(); previousTutorialStep(); skipTutorial();', context);
    assert.equal(targets['.djuke-playlist-draft'].open, open);
    assert.equal(targets['.djuke-body'].scrollTop, 80);
    assert.equal(targets['#djuke-tab'].getAttribute('aria-expanded'), 'true');
    vm.runInContext('startTutorial(); _changeStep(8); previousTutorialStep();', context);
    assert.equal(vm.runInContext('_playlistHop', context), 7);
    assert.equal(vm.runInContext('TUTORIAL_STEPS[_currentStep].id', context), 'playlists');
  }
});

test('Mercury follows the playlist rabbit to each feature and returns when the guide closes', () => {
  const { context, targets, timerQueue } = createTutorialContext();
  targets['#djuke-search'].bounds = { left: 100, top: 250, width: 340, height: 38 };
  vm.runInContext(`
    window.innerWidth = 1440; window.innerHeight = 1000;
    window.matchMedia = () => ({ matches: false });
    initTutorial(); _panel.bounds = { width: 390, height: 450 };
    startTutorial({ card: 'playlists' });
  `, context);
  for (let i = 0; i < 3; i++) {
    const index = timerQueue.findIndex(Boolean);
    const fn = timerQueue[index];
    timerQueue[index] = null;
    fn();
  }
  assert.equal(vm.runInContext('_rabbitAtHome', context), false);
  assert.equal(vm.runInContext('_mercury.classList.contains("is-following")', context), true);
  assert.equal(vm.runInContext('_mercury.style.top === _featurePosition.top', context), true);
  assert.equal(vm.runInContext('_backButton.disabled', context), true);
  vm.runInContext('skipTutorial();', context);
  assert.equal(vm.runInContext('_mercury.classList.contains("is-following")', context), false);
  assert.equal(timerQueue.filter(Boolean).length, 0);
});

test('payroll links still suppress the general tour and unknown links retain ordinary onboarding', () => {
  for (const tutorial of ['payroll', 'unknown']) {
    const { context, timerQueue } = createTutorialContext();
    vm.runInContext(`window.location = { search: '?tutorial=${tutorial}' }; initTutorial();`, context);
    assert.equal(vm.runInContext('_overlay.hidden', context), true);
    assert.equal(timerQueue.filter(Boolean).length, tutorial === 'payroll' ? 0 : 1);
  }
});
