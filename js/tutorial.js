const TUTORIAL_STORAGE_KEY = 'decentbusking:tutorial:seen:v1';
const TUTORIAL_STYLE_ID = 'decentbusking-tutorial-style';
const TUTORIAL_OVERLAY_ID = 'decentbusking-tutorial-overlay';
const TUTORIAL_HIGHLIGHT_CLASS = 'decentbusking-tutorial-highlight';
const TUTORIAL_BODY_CLASS = 'decentbusking-tutorial-open';

const TUTORIAL_STEPS = [
  {
    title: 'Welcome to DecentBusking',
    body: 'This walkthrough can be skipped at any time. It will point out the radio, submissions, rewards, ads, and DJuke flows that make the project work.',
    target: null,
  },
  {
    title: '24/7 Community Radio',
    body: 'The heartbeat of DecentBusking is the community radio: audio uploaded by listeners and creators feeds the live JukeLoop rotation around the clock.',
    target: '#now-playing-label',
  },
  {
    title: 'Submitting Songs',
    body: 'Artists submit through Discord in #DecentJukebox, then the on-site briefcase opens the mint / review workflow that admins use for batch uploads and minting.',
    target: '#guitar-case-btn',
  },
  {
    title: 'Voting &amp; Live Rotation',
    body: 'Use the 👍 / 👎 buttons in the Now Playing banner. Those votes shape the live rotation and feed the weekly Top 10 chart.',
    target: '#radio-voting',
  },
  {
    title: 'Community Rewards',
    body: 'Weekly playback pools and the Top 10 leaderboard help reward artists. Those pools are funded by sponsors and advertiser campaigns.',
    target: '#top-ten-tab',
  },
  {
    title: 'DVert Advertising',
    body: 'Open DVert to upload an ad for review and fund a weekly /wk campaign. That buys a spot in VertLoop and the main radio rotation (1 ad every 10 songs).',
    target: '#devert-tab',
  },
  {
    title: 'DJuke Jukebox',
    body: 'Open DJuke to queue any community track on demand with micro-payments and support artists directly.',
    target: '#djuke-tab',
  },
];

let _initialized = false;
let _overlay = null;
let _panel = null;
let _titleEl = null;
let _bodyEl = null;
let _stepLabelEl = null;
let _progressEl = null;
let _backButton = null;
let _nextButton = null;
let _skipButton = null;
let _closeButton = null;
let _backdrop = null;
let _currentStep = 0;
let _currentTarget = null;
let _autoLaunchTimer = null;

function _storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function _isSeen() {
  return _storage()?.getItem(TUTORIAL_STORAGE_KEY) === '1';
}

function _setSeen(seen) {
  const storage = _storage();
  if (!storage) return;
  try {
    if (seen) storage.setItem(TUTORIAL_STORAGE_KEY, '1');
    else storage.removeItem(TUTORIAL_STORAGE_KEY);
  } catch {
    /* ignore storage failures */
  }
  syncTutorialLaunchButtons();
}

function _ensureStyles() {
  if (!document?.head || document.getElementById(TUTORIAL_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = TUTORIAL_STYLE_ID;
  style.textContent = `
    .${TUTORIAL_HIGHLIGHT_CLASS} {
      position: relative !important;
      z-index: 100002 !important;
      box-shadow: 0 0 0 3px rgba(145, 222, 211, .95), 0 0 0 7px rgba(9, 12, 18, .9) !important;
      border-radius: 14px !important;
    }
    .decentbusking-tutorial-overlay {
      position: fixed;
      inset: 0;
      z-index: 100001;
      display: grid;
      place-items: end center;
      padding: 18px;
      box-sizing: border-box;
    }
    .decentbusking-tutorial-overlay[hidden] { display: none; }
    .decentbusking-tutorial-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(3, 5, 12, .78);
      backdrop-filter: blur(6px);
    }
    .decentbusking-tutorial-card {
      position: relative;
      z-index: 1;
      width: min(760px, 100%);
      max-width: 760px;
      padding: 18px 18px 16px;
      color: #f4f1ff;
      background: linear-gradient(145deg, rgba(16, 20, 34, .99), rgba(28, 22, 42, .98));
      border: 1px solid rgba(172, 164, 228, .38);
      border-radius: 18px;
      box-shadow: 0 24px 70px rgba(0, 0, 0, .5);
      font-family: 'Segoe UI', system-ui, sans-serif;
    }
    .decentbusking-tutorial-kicker {
      margin: 0 0 6px;
      color: #91ddd3;
      font-size: .72rem;
      font-weight: 700;
      letter-spacing: .12em;
      text-transform: uppercase;
    }
    .decentbusking-tutorial-card h2 {
      margin: 0;
      color: #fff2e4;
      font-size: clamp(1.3rem, 3vw, 1.95rem);
      line-height: 1.1;
    }
    .decentbusking-tutorial-step {
      margin: 10px 0 0;
      color: #d5d7e4;
      font-size: .82rem;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .decentbusking-tutorial-body {
      margin: 12px 0 0;
      color: #dde0ea;
      font-size: .98rem;
      line-height: 1.55;
    }
    .decentbusking-tutorial-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
      margin-top: 16px;
    }
    .decentbusking-tutorial-actions button {
      padding: 9px 14px;
      color: #fff4eb;
      background: rgba(255, 255, 255, .08);
      border: 1px solid rgba(255, 255, 255, .14);
      border-radius: 999px;
      cursor: pointer;
    }
    .decentbusking-tutorial-actions button[data-tutorial-primary] {
      color: #15161f;
      background: linear-gradient(135deg, #91ddd3, #b9a3ff, #ef9dca);
      border-color: transparent;
      font-weight: 700;
    }
    .decentbusking-tutorial-actions button:disabled {
      opacity: .45;
      cursor: not-allowed;
    }
    .decentbusking-tutorial-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-top: 14px;
      color: #aeb3c8;
      font-size: .85rem;
    }
    .decentbusking-tutorial-progress {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .decentbusking-tutorial-launch {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border: 1px solid rgba(145, 221, 211, .35);
      border-radius: 999px;
      background: rgba(145, 221, 211, .1);
      color: #d7fff5;
      cursor: pointer;
    }
    .decentbusking-tutorial-launch:hover { background: rgba(145, 221, 211, .18); }
    @media (max-width: 640px) {
      .decentbusking-tutorial-card { padding: 16px 14px 14px; }
      .decentbusking-tutorial-footer { align-items: flex-start; flex-direction: column; }
      .decentbusking-tutorial-actions { justify-content: stretch; }
      .decentbusking-tutorial-actions button { flex: 1 1 140px; }
    }
  `;
  document.head.appendChild(style);
}

function _button(label, onClick, attrs = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  Object.entries(attrs).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    button.setAttribute(key, value);
  });
  button.addEventListener('click', onClick);
  return button;
}

function _ensureOverlay() {
  if (_overlay || typeof document === 'undefined') return _overlay;
  _ensureStyles();

  _overlay = document.createElement('div');
  _overlay.id = TUTORIAL_OVERLAY_ID;
  _overlay.className = 'decentbusking-tutorial-overlay';
  _overlay.hidden = true;
  _overlay.setAttribute('aria-hidden', 'true');

  _backdrop = document.createElement('div');
  _backdrop.className = 'decentbusking-tutorial-backdrop';
  _backdrop.addEventListener('click', skipTutorial);

  _panel = document.createElement('section');
  _panel.className = 'decentbusking-tutorial-card';
  _panel.setAttribute('role', 'dialog');
  _panel.setAttribute('aria-modal', 'true');
  _panel.setAttribute('aria-labelledby', 'decentbusking-tutorial-title');
  _panel.tabIndex = -1;

  const kicker = document.createElement('p');
  kicker.className = 'decentbusking-tutorial-kicker';
  kicker.textContent = 'Interactive walkthrough';

  _stepLabelEl = document.createElement('p');
  _stepLabelEl.className = 'decentbusking-tutorial-step';

  _titleEl = document.createElement('h2');
  _titleEl.id = 'decentbusking-tutorial-title';

  _bodyEl = document.createElement('p');
  _bodyEl.className = 'decentbusking-tutorial-body';

  const footer = document.createElement('div');
  footer.className = 'decentbusking-tutorial-footer';

  _progressEl = document.createElement('span');
  _progressEl.className = 'decentbusking-tutorial-progress';

  const buttonRow = document.createElement('div');
  buttonRow.className = 'decentbusking-tutorial-actions';

  _backButton = _button('Back', previousTutorialStep);
  _skipButton = _button('Skip Tutorial', skipTutorial);
  _nextButton = _button('Next', nextTutorialStep, { 'data-tutorial-primary': '1' });
  _closeButton = _button('✕', skipTutorial, { 'aria-label': 'Close tutorial' });
  _closeButton.style.position = 'absolute';
  _closeButton.style.top = '12px';
  _closeButton.style.right = '12px';
  _closeButton.style.width = '36px';
  _closeButton.style.height = '36px';
  _closeButton.style.padding = '0';
  _closeButton.style.borderRadius = '50%';

  buttonRow.append(_backButton, _skipButton, _nextButton);
  footer.append(_progressEl, buttonRow);

  _panel.append(kicker, _closeButton, _stepLabelEl, _titleEl, _bodyEl, footer);
  _overlay.append(_backdrop, _panel);
  document.body?.appendChild(_overlay);
  return _overlay;
}

function _clearHighlight() {
  if (_currentTarget?.classList?.remove) _currentTarget.classList.remove(TUTORIAL_HIGHLIGHT_CLASS);
  _currentTarget = null;
}

function _highlightTarget(target) {
  _clearHighlight();
  if (!target) return;
  _currentTarget = target;
  if (target.classList?.add) target.classList.add(TUTORIAL_HIGHLIGHT_CLASS);
  if (typeof target.scrollIntoView === 'function') {
    try {
      target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    } catch {
      /* ignore scroll errors */
    }
  }
}

function _resolveTarget(selector) {
  if (!selector || typeof document?.querySelector !== 'function') return null;
  return document.querySelector(selector);
}

function _syncButtonsIn(root = document) {
  const label = _isSeen() ? 'Replay Tutorial' : 'Start Tutorial';
  root?.querySelectorAll?.('[data-tutorial-launch]')?.forEach?.((button) => {
    button.textContent = label;
    button.setAttribute('aria-label', `${label} for the DecentBusking walkthrough`);
  });
}

function _renderStep() {
  const step = TUTORIAL_STEPS[_currentStep] || TUTORIAL_STEPS[0];
  _titleEl.textContent = step.title;
  _bodyEl.innerHTML = step.body;
  _stepLabelEl.textContent = `Step ${_currentStep + 1} of ${TUTORIAL_STEPS.length}`;
  _progressEl.textContent = `${_currentStep + 1}/${TUTORIAL_STEPS.length}`;
  _backButton.disabled = _currentStep === 0;
  _nextButton.textContent = _currentStep === TUTORIAL_STEPS.length - 1 ? 'Finish' : 'Next';
  _highlightTarget(_resolveTarget(step.target));
}

function _cancelAutoLaunch() {
  if (_autoLaunchTimer) {
    clearTimeout(_autoLaunchTimer);
    _autoLaunchTimer = null;
  }
}

function _autoLaunch() {
  if (_autoLaunchTimer || _isSeen() || _overlay?.hidden === false) return;
  _autoLaunchTimer = setTimeout(() => {
    _autoLaunchTimer = null;
    if (!_isSeen()) startTutorial({ source: 'auto' });
  }, 500);
}

function _handleKeydown(event) {
  if (!_overlay || _overlay.hidden || event.defaultPrevented) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    skipTutorial();
  } else if (event.key === 'ArrowRight' || event.key === ' ') {
    event.preventDefault();
    nextTutorialStep();
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    previousTutorialStep();
  }
}

export function initTutorial() {
  if (_initialized || typeof document === 'undefined') return;
  _initialized = true;
  _ensureOverlay();
  document.addEventListener('keydown', _handleKeydown);
  document.addEventListener('dbusk:tutorial:start', () => startTutorial({ source: 'event' }));
  _syncButtonsIn();
  _autoLaunch();
}

export function startTutorial() {
  _ensureOverlay();
  _cancelAutoLaunch();
  _currentStep = 0;
  _overlay.hidden = false;
  _overlay.setAttribute('aria-hidden', 'false');
  document.body?.classList?.add(TUTORIAL_BODY_CLASS);
  _renderStep();
  _syncButtonsIn();
  _panel?.focus?.();
}

export function previousTutorialStep() {
  if (!_overlay || _overlay.hidden) return;
  _currentStep = Math.max(0, _currentStep - 1);
  _renderStep();
}

export function nextTutorialStep() {
  if (!_overlay || _overlay.hidden) return;
  if (_currentStep >= TUTORIAL_STEPS.length - 1) {
    completeTutorial();
    return;
  }
  _currentStep += 1;
  _renderStep();
}

export function completeTutorial() {
  _cancelAutoLaunch();
  _clearHighlight();
  if (_overlay) {
    _overlay.hidden = true;
    _overlay.setAttribute('aria-hidden', 'true');
  }
  document.body?.classList?.remove(TUTORIAL_BODY_CLASS);
  _setSeen(true);
  _syncButtonsIn();
}

export function skipTutorial() {
  completeTutorial();
}

export function markTutorialSeen() {
  _setSeen(true);
}

export function isTutorialSeen() {
  return _isSeen();
}

export function shouldAutoLaunchTutorial() {
  return !_isSeen();
}

export function syncTutorialLaunchButtons(root = document) {
  _syncButtonsIn(root);
}
