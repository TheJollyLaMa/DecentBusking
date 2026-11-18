import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { openIssueHelper } from '../../js/issue-helper.mjs';
import { initPayrollNotice } from '../../js/payroll-notice.mjs';

test('public helper gates exact copy/GitHub preview, invalidates edits and discards separate reports', async () => {
  const dom = new JSDOM('<button id="entry">Report</button>', { url: 'https://example.invalid' });
  const { document, HTMLDialogElement } = dom.window;
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  Object.defineProperty(dom.window, '_wallet', { get() { throw new Error('Must not read wallet'); } });
  dom.window.fetch = () => { throw new Error('Must not fetch or post'); };
  let copied = '';
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async value => { copied = value; } } });
  document.getElementById('entry').focus();
  openIssueHelper({ document });
  openIssueHelper({ document });
  assert.equal(document.querySelectorAll('dialog').length, 1);
  const find = selector => document.querySelector(selector);
  assert.equal(find('[data-github]').getAttribute('href'), null);
  find('[data-title]').value = 'Mobile control blank';
  find('[data-body]').value = 'I click Play and see <script>alert(1)</script> instead. user@example.com';
  find('[data-review]').click();
  assert.equal(find('[data-preview]').hidden, false);
  assert.equal(find('[data-github]').getAttribute('href'), null);
  assert.equal(find('[data-copy]').disabled, true);
  assert.equal(find('[data-text] script'), null);
  assert.ok(!find('[data-text]').textContent.includes('user@example.com'));
  const confirm = selector => {
    find(selector).checked = true;
    find(selector).dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  confirm('[data-duplicates]');
  assert.equal(find('[data-github]').getAttribute('href'), null);
  confirm('[data-confirm]');
  const url = new URL(find('[data-github]').href);
  assert.equal(url.searchParams.get('body'), find('[data-body]').value);
  find('[data-copy]').click();
  await Promise.resolve();
  assert.equal(copied, find('[data-text]').textContent);
  find('[data-body]').value += '\nMore details';
  find('[data-body]').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(find('[data-github]').getAttribute('href'), null);
  assert.equal(find('[data-confirm]').checked, false);
  assert.equal(find('[data-copy]').disabled, true);
  find('[data-close]').click();
  assert.equal(find('dialog'), null);
  assert.equal(document.activeElement.id, 'entry');
  openIssueHelper({ document });
  assert.equal(find('[data-body]').value, '');
  find('[data-body]').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(find('dialog'), null);
  openIssueHelper({ document });
  find('dialog').dispatchEvent(new dom.window.Event('cancel', { cancelable: true }));
  assert.equal(find('dialog'), null);
  dom.window.close();
});

test('owner badge polls only while eligible, distinguishes failure, and ignores stale disconnected responses', async () => {
  const dom = new JSDOM('', { pretendToBeVisual: true });
  const { document } = dom.window;
  let owner = false, calls = 0, resolve, chainUnavailable = false;
  const notices = [];
  document.addEventListener('payroll-queue-status', event => notices.push(event.detail));
  const stop = initPayrollNotice({
    document, window: dom.window, isAdmin: () => owner,
    fetchQueue: () => { calls++; return new Promise(done => { resolve = done; }); },
    readStatus: async () => {
      if (chainUnavailable) throw new Error('Base verification offline');
      return { verified: true, pending: [{}, {}] };
    },
  });
  assert.equal(calls, 0);
  owner = true;
  document.dispatchEvent(new dom.window.Event('wallet-connected'));
  assert.equal(calls, 1);
  resolve({ ok: true, json: async () => ({ pending: [{ currency: 'ART' }, { currency: 'USDC' }, { currency: 'ETH' }, { currency: 'ART', retainedInFund: true }] }) });
  await new Promise(done => setImmediate(done));
  assert.equal(notices.at(-1).count, 2);
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
  owner = false;
  document.dispatchEvent(new dom.window.Event('wallet-disconnected'));
  resolve({ ok: true, json: async () => ({ pending: [{ currency: 'ART' }] }) });
  await new Promise(done => setImmediate(done));
  assert.equal(notices.at(-1).count, 0);
  owner = true;
  document.dispatchEvent(new dom.window.Event('wallet-connected'));
  resolve({ ok: false, status: 503 });
  await new Promise(done => setImmediate(done));
  assert.equal(notices.at(-1).count, null);
  assert.match(notices.at(-1).error, /unavailable/);
  chainUnavailable = true;
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
  resolve({ ok: true, json: async () => ({ pending: [] }) });
  await new Promise(done => setImmediate(done));
  assert.equal(notices.at(-1).count, null);
  assert.match(notices.at(-1).error, /unavailable/);
  stop();
  dom.window.close();
});
