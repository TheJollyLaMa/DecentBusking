import { CONTENT_REASONS, contentAuthorization, contentTarget } from './content-review.mjs';
import { isAdminWallet } from './admin-access.mjs';
import { escapeLive as escape } from './live-bookings.mjs';

let walletGeneration = 0;
for (const name of ['wallet-connected', 'wallet-disconnected']) {
  document.addEventListener(name, () => { walletGeneration++; });
}

export async function sendContentCommand(command) {
  const wallet = window._wallet;
  const signer = wallet?.signer;
  const address = wallet?.address;
  const generation = walletGeneration;
  if (!signer || !address) throw new Error('Connect your wallet first, then retry');
  const service = window.DecentConfig?.ipfsUploadServiceUrl;
  if (!service) throw new Error('Content review service is not configured');
  const check = () => {
    if (walletGeneration !== generation || window._wallet?.signer !== signer ||
        window._wallet?.address?.toLowerCase() !== address.toLowerCase()) throw new Error('Wallet changed; refresh before retrying');
  };
  const body = { address, origin: location.origin, issuedAt: new Date().toISOString(), command };
  body.signature = await signer.signMessage(contentAuthorization(body));
  check();
  const response = await fetch(`${service.replace(/\/$/, '')}/api/content-review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  check();
  if (!response.ok) throw new Error(result.error || `Content review HTTP ${response.status}`);
  return result;
}

let reportDialog;
export function openContentReport(item) {
  if (reportDialog?.open) { reportDialog.focus(); return; }
  const target = structuredClone(contentTarget(item));
  const title = item.title || item.name || 'This recording';
  const returnFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  reportDialog = dialog;
  dialog.className = 'content-report-dialog';
  dialog.setAttribute('aria-labelledby', 'content-report-title');
  dialog.innerHTML = `<form>
    <button type="button" data-close class="content-review-close" aria-label="Close report">×</button>
    <h3 id="content-report-title">Flag for review</h3><p>${escape(title)}</p>
    <fieldset><legend>Why?</legend>${CONTENT_REASONS.map(reason =>
      `<label><input type="radio" name="reason" value="${reason}" required> ${reason[0].toUpperCase() + reason.slice(1)}</label>`).join('')}</fieldset>
    <label data-other hidden>Tell us why<textarea name="note" maxlength="1000" rows="3"></textarea></label>
    <p class="content-review-help">A report asks for admin review. It does not remove the NFT.</p>
    <button type="submit">Submit report · wallet signature</button>
    <p role="status" aria-live="polite"></p></form>`;
  document.body.append(dialog);
  dialog.showModal();
  const form = dialog.querySelector('form');
  const status = dialog.querySelector('[role="status"]');
  let busy = false;
  form.addEventListener('change', () => {
    const other = form.elements.reason.value === 'other';
    dialog.querySelector('[data-other]').hidden = !other;
    form.elements.note.required = other;
    if (other) form.elements.note.focus();
  });
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (reportDialog === dialog) reportDialog = null;
    if (returnFocus?.isConnected) returnFocus.focus();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    status.textContent = 'Confirm the report signature in your wallet…';
    try {
      await sendContentCommand({ action: 'report', target, reason: form.elements.reason.value,
        note: form.elements.note.value });
      status.textContent = 'Report received. Thank you.';
      form.querySelector('fieldset').disabled = true;
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    } finally { busy = false; }
  });
}

export function mountContentReview(root) {
  if (!root) return;
  root.innerHTML = `<summary>Content Review</summary>
    <p class="content-review-help">Flagged recordings and radio controls. Nothing is deleted.</p>
    <button type="button" data-refresh>Unlock / refresh</button>
    <p role="status" aria-live="polite"></p>
    <div data-workspace hidden>
      <label>Find a recording<input type="search" data-search placeholder="Title or token number"></label>
      <label><input type="checkbox" data-reported> Reports only</label>
      <div data-list class="content-review-list"></div><button type="button" data-more hidden>Show more</button>
      <div data-detail></div>
    </div>`;
  const status = root.querySelector('[role="status"]');
  let state, selected, busy = false, limit = 30;
  function renderList() {
    const search = root.querySelector('[data-search]').value.toLowerCase();
    const reported = root.querySelector('[data-reported]').checked;
    const items = state.items.filter(item => (!reported || item.reports.length) &&
      `${item.title} ${item.tokenId || ''}`.toLowerCase().includes(search))
      .sort((a, b) => b.reports.filter(r => ['new', 'in-review'].includes(r.status)).length -
        a.reports.filter(r => ['new', 'in-review'].includes(r.status)).length || String(a.title).localeCompare(String(b.title)));
    root.querySelector('[data-list]').innerHTML = items.slice(0, limit).map(item =>
      `<button type="button" data-item="${escape(item.key)}">${escape(item.title || item.key)}
        <small>${item.isDevertAd ? 'Advert' : 'Song'} · ${escape(item.contentReview.scope)}${item.reports.length ? ` · ${item.reports.length} reports` : ''}</small></button>`).join('') ||
      '<p>No matching recordings.</p>';
    root.querySelector('[data-more]').hidden = items.length <= limit;
  }
  function renderDetail() {
    const item = state.items.find(item => item.key === selected);
    const detail = root.querySelector('[data-detail]');
    if (!item) { detail.replaceChildren(); return; }
    detail.innerHTML = `<form data-policy class="content-review-detail">
      <h4>${escape(item.title || item.key)}</h4><p class="content-review-help">${escape(item.key)}</p>
      <label>Label<select name="classification">
        <option value="original">Original catalog label</option><option value="song">Song</option><option value="advert">Advert</option>
      </select></label>
      <label>Radio<select name="scope"><option value="none">Allowed</option>
        <option value="music-only">Remove from music rotation</option><option value="all-radio">Block all radio, including adverts</option>
      </select></label>
      <p class="content-review-help">Music-only removal keeps valid advert campaigns usable. All-radio blocks campaign playback too; paid requests need separate review. NFT previews and past payments are unchanged.</p>
      <label>Admin reason<input name="reason" maxlength="1000" required></label>
      <label><input name="stopNow" type="checkbox" checked> Skip now if this change excludes the current recording</label>
      <button>Save radio controls</button>
    </form>
    ${item.reports.map(report => `<article class="content-review-report" data-report="${escape(report.id)}">
      <strong>${escape(report.reason)}</strong> · ${escape(report.status)}<p>${escape(report.note)}</p>
      <small>${escape(report.at)}</small>
      <label>Review reason<input data-reason maxlength="1000"></label>
      <select data-report-status aria-label="Report status">${['new', 'in-review', 'actioned', 'dismissed'].map(value =>
        `<option ${value === report.status ? 'selected' : ''}>${value}</option>`).join('')}</select>
      <button type="button" data-review>Update report</button></article>`).join('')}
    <details><summary>Decision history</summary>${state.history.filter(entry =>
      entry.key === item.key || item.reports.some(report => report.key === entry.key)).map(entry =>
      `<p>${escape(entry.at)} · ${escape(entry.action)} · ${escape(entry.reason)}<br>
       ${escape(JSON.stringify(entry.before))} → ${escape(JSON.stringify(entry.after))}</p>`).join('') || '<p>No decisions yet.</p>'}</details>`;
    const form = detail.querySelector('form');
    form.elements.classification.value = item.contentReview.classification;
    form.elements.scope.value = item.contentReview.scope;
  }
  async function act(command) {
    if (busy) return;
    busy = true;
    const generation = walletGeneration;
    status.textContent = 'Confirm the review signature in your wallet…';
    try {
      if (!isAdminWallet()) throw new Error('Connect the admin wallet');
      const next = await sendContentCommand({ ...command, revision: state?.revision });
      if (generation !== walletGeneration) return;
      state = next;
      root.querySelector('[data-workspace]').hidden = false;
      renderList();
      renderDetail();
      status.textContent = 'Review updated. No NFT or payment was deleted.';
    } catch (error) { if (generation === walletGeneration) status.textContent = error.message; }
    finally { busy = false; }
  }
  root.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.matches('[data-refresh]')) void act({ action: 'view' });
    if (button.dataset.item && !busy) { selected = button.dataset.item; renderDetail(); }
    if (button.matches('[data-more]')) { limit += 30; renderList(); }
    if (button.matches('[data-review]')) {
      const report = button.closest('[data-report]');
      void act({ action: 'review-report', reportId: report.dataset.report,
        status: report.querySelector('[data-report-status]').value, reason: report.querySelector('[data-reason]').value });
    }
  });
  root.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.target;
    const item = state?.items.find(item => item.key === selected);
    if (!item || !form.matches('[data-policy]')) return;
    void act({ action: 'policy', target: item.target, classification: form.elements.classification.value,
      scope: form.elements.scope.value, reason: form.elements.reason.value, stopNow: form.elements.stopNow.checked });
  });
  for (const selector of ['[data-search]', '[data-reported]']) {
    root.querySelector(selector).addEventListener('input', () => { if (state) { limit = 30; renderList(); } });
  }
  const clear = () => {
    state = null; selected = null;
    root.querySelector('[data-search]').value = '';
    root.classList.toggle('hidden', !isAdminWallet());
    root.querySelector('[data-workspace]').hidden = true;
    root.querySelector('[data-list]').replaceChildren();
    root.querySelector('[data-detail]').replaceChildren();
    status.textContent = 'Unlock to load review.';
  };
  for (const name of ['wallet-connected', 'wallet-disconnected']) document.addEventListener(name, clear);
  clear();
}

function initialize() {
  mountContentReview(document.getElementById('admin-content-review'));
  let current;
  const flag = document.getElementById('radio-content-report');
  document.addEventListener('dbusk-now-playing', event => {
    current = event.detail?.source === 'radio' ? structuredClone(event.detail) : null;
    if (flag) flag.disabled = !current;
  });
  document.addEventListener('dbusk-now-playing-stopped', () => { current = null; if (flag) flag.disabled = true; });
  flag?.addEventListener('click', () => {
    if (current) openContentReport(current.nft ? { ...current, ...current.nft } : current);
  });
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-content-report]');
    if (!button) return;
    openContentReport({ chainId: 8453, contractAddress: button.dataset.contract,
      tokenId: button.dataset.token, title: button.dataset.title });
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
