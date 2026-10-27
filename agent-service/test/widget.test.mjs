import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createCompanionChime, initDBusker, validServiceUrl } from '../../js/dbusker.mjs';

function fixture(t, enabled = true) {
  const dom = new JSDOM('<body><button id="header-wallet">Wallet</button><footer id="radio-footer">Radio</footer></body>',
    { url: 'http://localhost:8080' });
  t.after(() => dom.window.close());
  const { window } = dom, { document } = window;
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.DecentConfig = { dbusker: { enabled, serviceUrl: 'http://localhost:8788' } };
  let calls = [];
  window.fetch = async (...args) => { calls.push(args); throw new Error('Offline test'); };
  initDBusker({ document, window });
  const host = document.getElementById('dbusker-companion');
  return { window, document, host, root: host?.shadowRoot, calls };
}

test('disabled widget does not mount, prompt for a wallet, or request the service', t => {
  const f = fixture(t, false);
  assert.equal(f.host, null);
  assert.equal(f.calls.length, 0);
});

test('public onboarding links reuse actual bunny routes and disclose contributor-request privacy', t => {
  const { root } = fixture(t);
  for (const kind of ['payroll', 'playlists', 'splits']) {
    const link = root.querySelector(`a[href="?tutorial=${kind}"]`);
    assert.ok(link);
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
  }
  const contributor = root.querySelector('a[href*="template=whitelist-request"]');
  assert.ok(contributor);
  assert.match(contributor.parentElement.textContent, /publishes your GitHub handle and payout wallet/);
  assert.match(contributor.parentElement.textContent, /Chat access does not enroll you/);
});

test('greeting is dismissible; opening and closing does not fetch or alter radio', t => {
  const f = fixture(t), { root, document } = f;
  root.querySelector('.dismiss').click();
  assert.equal(f.window.localStorage.getItem('decentbusking:dbusker:dismissed:v1'), '1');
  root.querySelector('.launcher').click();
  assert.equal(root.querySelector('section').hidden, false);
  root.querySelector('.close').click();
  assert.equal(root.querySelector('section').hidden, true);
  assert.equal(root.activeElement, root.querySelector('.launcher'));
  assert.equal(document.getElementById('radio-footer').textContent, 'Radio');
  assert.equal(f.calls.length, 0);
});

test('Escape returns focus to the launcher when the shadow host retargets native focus', t => {
  const { root, document, host, window } = fixture(t);
  const launcher = root.querySelector('.launcher');
  launcher.focus();
  assert.equal(document.activeElement, host);
  launcher.click();
  root.querySelector('.close').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(root.querySelector('section').hidden, true);
  assert.equal(root.activeElement, launcher);
});

test('tour defers companion and clearing a tour restores it without an observer loop', async t => {
  const f = fixture(t);
  const tour = f.document.createElement('div');
  tour.id = 'decentbusking-tutorial-overlay';
  tour.hidden = false;
  f.document.body.append(tour);
  await new Promise(resolve => f.window.setTimeout(resolve, 5));
  assert.equal(f.host.hidden, true);
  tour.hidden = true;
  await new Promise(resolve => f.window.setTimeout(resolve, 5));
  assert.equal(f.host.hidden, false);
});

test('a modal inside a hidden ancestor does not hide DBusker; opening it does', async t => {
  const f = fixture(t);
  const wrapper = f.document.createElement('div');
  wrapper.className = 'hidden';
  wrapper.innerHTML = '<div role="dialog" aria-modal="true">Mint</div>';
  f.document.body.append(wrapper);
  await new Promise(resolve => f.window.setTimeout(resolve, 5));
  assert.equal(f.host.hidden, false);
  wrapper.className = '';
  await new Promise(resolve => f.window.setTimeout(resolve, 5));
  assert.equal(f.host.hidden, true);
  wrapper.style.display = 'none';
  await new Promise(resolve => f.window.setTimeout(resolve, 5));
  assert.equal(f.host.hidden, false);
});

test('consent is required and the widget reuses the site wallet without connecting automatically', async t => {
  const f = fixture(t), { root } = f;
  assert.equal(root.querySelector('.signin').disabled, true);
  const consent = root.querySelector('input');
  consent.checked = true;
  consent.dispatchEvent(new f.window.Event('change'));
  root.querySelector('.signin').click();
  await new Promise(resolve => f.window.setTimeout(resolve, 0));
  assert.match(root.querySelector('.status').textContent, /site header first/);
  assert.equal(f.calls.length, 0);
});

test('community routes draft editable questions without sending, signing, or connecting a wallet', t => {
  const f = fixture(t), { root } = f;
  assert.equal(root.querySelectorAll('[data-starter]').length, 7);
  const route = root.querySelector('[data-starter]');
  route.click();
  assert.match(root.querySelector('textarea').value, /not a coder/);
  assert.match(root.querySelector('.status').textContent, /not sent/);
  assert.equal(root.querySelector('textarea').disabled, true);
  assert.equal(root.querySelector('.paths').open, false);
  assert.equal(root.activeElement, root.querySelector('input'));
  assert.equal(root.querySelector('.transcript').children.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(route.getAttribute('aria-pressed'), 'true');
  assert.equal(root.querySelectorAll('[data-starter][aria-pressed="true"]').length, 1);
});

test('portrait welcome and illustrated paths preserve readable accessible names', t => {
  const { root } = fixture(t);
  assert.equal(root.querySelector('.hello').textContent, 'How can I help you, Earthling?');
  assert.match(root.querySelector('.greeting').textContent, /How can I help you, Earthling\?/);
  assert.match(root.querySelector('.portrait-port img').alt, /DBusker/);
  for (const route of root.querySelectorAll('[data-starter]')) {
    assert.ok(route.querySelector('svg[aria-hidden="true"]'));
    assert.ok(route.getAttribute('aria-label').includes(route.querySelector('.path-label').textContent));
  }
});

function audioFixture() {
  const oscillators = [], errors = [], gains = [];
  let contexts = 0, resumes = 0, closed = 0;
  const media = { paused: true, muted: false, volume: 1 };
  const document = { hidden: false, querySelectorAll: () => [media] };
  let resume = async () => {};
  class AudioContext {
    constructor() { contexts++; this.currentTime = 0; this.destination = {}; }
    async resume() { resumes++; await resume(); }
    async close() { closed++; }
    createOscillator() {
      const oscillator = { frequency: {}, connect() {}, disconnect() {},
        start(time) { this.started = time; }, stop(time) { this.stopped = time ?? 'now'; } };
      oscillators.push(oscillator);
      return oscillator;
    }
    createGain() {
      return { gain: { setValueAtTime() {}, linearRampToValueAtTime(value) { gains.push(value); }, exponentialRampToValueAtTime() {} },
        connect() {}, disconnect() {} };
    }
  }
  const chime = createCompanionChime({ AudioContext }, document, error => errors.push(error));
  return { chime, document, media, oscillators, errors, gains, AudioContext,
    counts: () => ({ contexts, resumes, closed }), setResume: fn => { resume = fn; } };
}

test('chimes are off by default, quiet and bounded, and do not fetch or create media elements', async () => {
  const f = audioFixture();
  await f.chime.play();
  assert.equal(f.counts().contexts, 0);
  await f.chime.setEnabled(true);
  assert.equal(f.oscillators.length, 2);
  assert.deepEqual(f.gains, [.018, .018]);
  assert.ok(f.oscillators.every(voice => voice.stopped < .3));
  await f.chime.setEnabled(false);
  assert.ok(f.oscillators.every(voice => voice.stopped === 'now'));
  await f.chime.play();
  assert.equal(f.oscillators.length, 2);
  f.chime.dispose();
  assert.equal(f.counts().closed, 1);
  assert.deepEqual(f.errors, []);
});

test('chimes yield to audible media and hidden pages, including while audio resumes', async () => {
  const f = audioFixture();
  f.media.paused = false;
  await f.chime.setEnabled(true);
  assert.equal(f.counts().contexts, 0);
  f.media.paused = true;
  f.document.hidden = true;
  await f.chime.play();
  assert.equal(f.counts().contexts, 0);
  f.document.hidden = false;
  f.setResume(async () => { f.media.paused = false; });
  await f.chime.play();
  assert.equal(f.oscillators.length, 0);
  f.chime.dispose();
});

test('closing or disabling sound cancels a chime awaiting browser audio permission', async () => {
  const f = audioFixture();
  let finish;
  f.setResume(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.chime.setEnabled(true);
  f.chime.stop();
  finish();
  await pending;
  assert.equal(f.oscillators.length, 0);
  f.chime.dispose();
});

test('sound toggle is session-only and unsupported audio gives an explicit error', async t => {
  const f = fixture(t), { root, window } = f;
  Object.defineProperty(f.document, 'hidden', { value: false });
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const sound = root.querySelector('.sound');
  assert.equal(sound.getAttribute('aria-pressed'), 'false');
  assert.equal(window.localStorage.length, 0);
  sound.click();
  await new Promise(resolve => window.setTimeout(resolve, 0));
  assert.equal(sound.getAttribute('aria-pressed'), 'false');
  assert.match(root.querySelector('.status').textContent, /sound unavailable/);
  assert.equal(warnings.length, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(window.localStorage.length, 0);
});

test('sound integration stops notes for media start, drawer close, and hidden pages', async t => {
  const f = fixture(t), audio = audioFixture(), { root, window, document } = f;
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  window.AudioContext = audio.AudioContext;
  root.querySelector('.launcher').click();
  assert.equal(audio.counts().contexts, 0);
  root.querySelector('.sound').click();
  await new Promise(resolve => window.setTimeout(resolve, 0));
  assert.equal(audio.oscillators.length, 2);
  const radio = document.createElement('audio');
  document.body.append(radio);
  radio.dispatchEvent(new window.Event('play'));
  assert.ok(audio.oscillators.every(voice => voice.stopped === 'now'));
  root.querySelector('.close').click();
  root.querySelector('.launcher').click();
  await new Promise(resolve => window.setTimeout(resolve, 0));
  assert.equal(audio.oscillators.length, 4);
  window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: true }));
  assert.equal(audio.counts().closed, 0);
  root.querySelector('.close').click();
  assert.ok(audio.oscillators.every(voice => voice.stopped === 'now'));
  root.querySelector('.launcher').click();
  await new Promise(resolve => window.setTimeout(resolve, 0));
  Object.defineProperty(document, 'hidden', { value: true });
  document.dispatchEvent(new window.Event('visibilitychange'));
  assert.ok(audio.oscillators.every(voice => voice.stopped === 'now'));
  window.dispatchEvent(new window.Event('pagehide'));
  assert.equal(audio.counts().closed, 1);
  assert.equal(f.calls.length, 0);
});

test('wallet switch clears an in-flight sign-in and cannot leak its session into the new account', async t => {
  const f = fixture(t), { root, window } = f;
  let finishSignature;
  window._wallet = { address: '0x1111111111111111111111111111111111111111', chainId: 8453,
    signer: { signMessage: () => new Promise(resolve => { finishSignature = resolve; }) } };
  window.fetch = async () => Response.json({ message: 'offline test challenge' });
  root.querySelector('input').checked = true;
  root.querySelector('input').dispatchEvent(new window.Event('change'));
  root.querySelector('.signin').click();
  await new Promise(resolve => window.setTimeout(resolve, 0));
  window._wallet.address = '0x2222222222222222222222222222222222222222';
  f.document.dispatchEvent(new window.Event('wallet-connected'));
  finishSignature('offline-signature');
  await new Promise(resolve => window.setTimeout(resolve, 0));
  assert.equal(root.querySelector('textarea').disabled, true);
  assert.equal(root.querySelector('.transcript').children.length, 0);
  assert.equal(root.querySelector('.signout').hidden, true);
});

test('signed-in chat renders answers as text, cites sources and clears on disconnect', async t => {
  const f = fixture(t), { root, window } = f;
  const address = '0x1111111111111111111111111111111111111111', token = 'a'.repeat(64);
  const calls = [];
  window._wallet = { address, chainId: 8453, signer: { signMessage: async () => 'offline-signature' } };
  window.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/challenge')) return Response.json({ message: 'offline challenge' });
    if (url.endsWith('/session') && init.method === 'POST') return Response.json({
      token, wallet: address, expiresAt: Date.now() + 60000,
      handoff: { commit: '1'.repeat(40), digest: '2'.repeat(64) },
    });
    if (url.endsWith('/chat')) return Response.json({
      answer: '<img src=x onerror=alert(1)> is plain text, not markup.', abstained: false,
      sources: [{ file: 'README.md', line: 1,
        url: `https://github.com/TheJollyLaMa/DecentBusking/blob/${'1'.repeat(40)}/README.md#L1` }],
    });
    return Response.json({ cleared: true });
  };
  const consent = root.querySelector('input');
  consent.checked = true;
  consent.dispatchEvent(new window.Event('change'));
  root.querySelector('.signin').click();
  await new Promise(resolve => window.setTimeout(resolve, 5));
  assert.equal(root.querySelector('textarea').disabled, false);
  root.querySelector('textarea').value = 'Can I listen?';
  root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await new Promise(resolve => window.setTimeout(resolve, 5));
  assert.equal(root.querySelector('.transcript img'), null);
  assert.equal(root.querySelector('.transcript a').textContent, 'README.md:1');
  const chat = calls.find(call => call.url.endsWith('/chat'));
  assert.equal(chat.init.headers.Authorization, `Bearer ${token}`);
  assert.equal(JSON.parse(chat.init.body).consent, true);
  assert.match(root.querySelector('.transcript').textContent, /plain text/);
  f.document.dispatchEvent(new window.Event('wallet-disconnected'));
  assert.equal(root.querySelector('.transcript').children.length, 0);
  assert.equal(root.querySelector('textarea').disabled, true);
});

test('service URL requires HTTPS outside explicit localhost and never embeds credentials', () => {
  assert.equal(validServiceUrl('https://agent.example.org/'), 'https://agent.example.org');
  assert.throws(() => validServiceUrl('http://agent.example.org'), /HTTPS/);
  assert.throws(() => validServiceUrl('https://user:pass@agent.example.org'), /HTTPS/);
});
