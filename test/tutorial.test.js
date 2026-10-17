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

function createTutorialContext() {
  const storage = makeStorage();
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
  for (const id of ['top-ten-panel', 'devert-panel', 'djuke-panel', 'dnft-list', 'dnft-archive-toggle', 'mint-modal', 'mint-modal-inner', 'mint-submit-btn', 'mint-status', 'mint-cancel-btn']) {
    targets[`#${id}`] = makeNode('div');
  }
  Object.entries(targets).forEach(([selector, node]) => { node.id = selector.slice(1); });
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

test('tutorial walkthrough auto-launches once and marks visitors seen', () => {
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
  assert.equal(document.getElementById('rabbit-tour-launch').hidden, false);
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
  for (let i = 0; i < 11; i++) vm.runInContext('nextTutorialStep();', context);
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
  assert.equal(steps, 11);
  vm.runInContext('nextTutorialStep(); nextTutorialStep();', context);
  assert.equal(targets['#mint-modal'].classList.contains('hidden'), false);
  vm.runInContext('nextTutorialStep(); nextTutorialStep();', context);
  assert.equal(targets['#mint-modal'].classList.contains('hidden'), true);
  assert.equal(targets['#top-ten-tab'].getAttribute('aria-expanded'), 'true');
  for (let index = 4; index < 8; index++) vm.runInContext('nextTutorialStep();', context);
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
    assert.equal(vm.runInContext('_stepLabelEl.textContent', context), `${index + 1} / ${count}`);
    vm.runInContext('nextTutorialStep();', context);
  }
  vm.runInContext('startTutorial();', context);
  assert.equal(vm.runInContext('_propEl.textContent', context), '🎺');
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
  assert.equal(vm.runInContext('_stepLabelEl.textContent', context), '2 / 11');
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
  assert.equal(vm.runInContext('_stepLabelEl.textContent', context), '3 / 11');
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
  assert.equal(document.activeElement.id, 'rabbit-tour-launch');
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

test('keyboard focus cycles in the tour and Escape exits before underlying drawer handlers run', () => {
  const { context, document } = createTutorialContext();
  vm.runInContext('initTutorial(); startTutorial();', context);
  const event = key => ({ key, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } });
  context.event = event('Tab');
  vm.runInContext('_handleKeydown(event);', context);
  assert.equal(vm.runInContext('document.activeElement === _closeButton', context), true);
  context.event.shiftKey = true;
  vm.runInContext('_handleKeydown(event);', context);
  assert.equal(vm.runInContext('document.activeElement === _nextButton', context), true);
  context.event = event('ArrowRight');
  vm.runInContext('_handleKeydown(event);', context);
  assert.equal(vm.runInContext('_currentStep', context), 1);
  assert.equal(context.event.stopped, true);
  context.event = event('Escape');
  vm.runInContext('_handleKeydown(event);', context);
  assert.equal(vm.runInContext('_overlay.hidden', context), true);
  assert.equal(document.body.classList.contains('decentbusking-tutorial-open'), false);
  assert.equal(context.event.stopped, true);
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
  assert.match(vm.runInContext('TUTORIAL_STEPS[8].body', context), /right ankh menu.*Profile and Public Schedule/);
  assert.match(document.head.children[0].textContent, /\.mercury-money \{[^}]*font-size: 22px/);
  assert.equal(document.getElementById('rabbit-tour-launch').getAttribute('aria-label'), 'Follow the white rabbit: explore DecentBusking');
});
