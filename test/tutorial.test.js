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
    append(...nodes) { this.children.push(...nodes); },
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
  const document = {
    head: makeNode('head'),
    body: makeNode('body'),
    createElement: (tag) => makeNode(tag),
    getElementById: () => null,
    querySelector: (selector) => targets[selector] || null,
    querySelectorAll: (selector) => (selector === '[data-tutorial-launch]' ? [launchButton] : []),
    addEventListener() {},
  };
  document.body.classList = makeClassList();
  document.body.appendChild = function appendChild(node) { this.children.push(node); return node; };
  document.body.children = [];
  document.head.appendChild = function appendChild(node) { this.children.push(node); return node; };
  document.head.children = [];

  const context = vm.createContext({
    console,
    document,
    window: { localStorage: storage },
    localStorage: storage,
    setTimeout: (fn) => { timerQueue.push(fn); return timerQueue.length; },
    clearTimeout: (id) => { timerQueue[id - 1] = null; },
    targets,
  });

  vm.runInContext(tutorialSource, context);
  return { context, storage, timerQueue, launchButton, targets, document };
}

test('tutorial walkthrough auto-launches once and marks visitors seen', () => {
  const { context, storage, timerQueue, launchButton, targets, document } = createTutorialContext();
  vm.runInContext('initTutorial();', context);

  assert.equal(timerQueue.length, 1);
  assert.equal(launchButton.textContent, 'Start Tutorial');

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
  assert.equal(launchButton.textContent, 'Replay Tutorial');
});

test('tutorial launch buttons can be relabeled inside arbitrary roots', () => {
  const { context, storage } = createTutorialContext();
  storage.setItem('decentbusking:tutorial:seen:v1', '1');
  const button = makeNode('button');
  const root = { querySelectorAll: (selector) => (selector === '[data-tutorial-launch]' ? [button] : []) };
  context.root = root;
  vm.runInContext('syncTutorialLaunchButtons(root);', context);
  assert.equal(button.textContent, 'Replay Tutorial');
  assert.equal(button.getAttribute('aria-label'), 'Replay Tutorial for the DecentBusking walkthrough');
});

test('about modal exposes a tutorial launch button', () => {
  const aboutSource = fs.readFileSync(path.join(__dirname, '../js/components/about-override.js'), 'utf8');
  assert.match(aboutSource, /data-tutorial-launch/);
  assert.match(aboutSource, /Start Tutorial/);
});

test('tutorial copy now mentions NFT card Preview and Listen actions', () => {
  const { context } = createTutorialContext();
  assert.match(vm.runInContext('TUTORIAL_STEPS[6].body', context), /Preview for a free 30-second taste/);
  assert.match(vm.runInContext('TUTORIAL_STEPS[6].body', context), /Listen to play the whole song/);
});
