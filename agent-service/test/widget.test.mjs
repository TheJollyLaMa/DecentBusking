import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { initDBusker, validServiceUrl } from '../../js/dbusker.mjs';

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
