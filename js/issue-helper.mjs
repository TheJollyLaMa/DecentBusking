import { ISSUE_LIMITS, buildIssueDraft, reviewIssueDraft } from './issue-draft.mjs';

export function openIssueHelper({ document = globalThis.document } = {}) {
  if (document.getElementById('issue-helper')) return;
  let previous = document.activeElement;
  while (previous?.shadowRoot?.activeElement) previous = previous.shadowRoot.activeElement;
  previous = previous?.closest('.ankh-left')?.querySelector('.ankh-coin') || previous;
  const dialog = document.createElement('dialog');
  dialog.id = 'issue-helper';
  dialog.setAttribute('aria-labelledby', 'issue-helper-heading');
  dialog.innerHTML = `
    <header><img src="img/D_Busker.jpeg" alt="" width="56" height="56"><div><h2 id="issue-helper-heading">Found a problem? Let's write it up.</h2><p>One problem, one GitHub issue. You are the reporter.</p></div></header>
    <p>This helper is local and needs no wallet or AI sign-in. Nothing is saved, uploaded or submitted here. If you ask DBusker for wording, paste only the text you want to share into the draft below.</p>
    <p>GitHub issues are public. Credentials, URLs, wallet addresses and other address-like text are stripped conservatively. This is not a complete privacy detector: inspect every word. Add only reviewed public screenshots or evidence on GitHub yourself.</p>
    <form autocomplete="off">
      <label>Short title<input name="title" maxlength="${ISSUE_LIMITS.title}" required></label>
      <label>What happened?<textarea name="actual" maxlength="${ISSUE_LIMITS.field}" required></textarea></label>
      <label>What should have happened?<textarea name="expected" maxlength="${ISSUE_LIMITS.field}" required></textarea></label>
      <label>Steps to reproduce<textarea name="steps" maxlength="${ISSUE_LIMITS.field}" required></textarea></label>
      <label>Who or what does this affect?<textarea name="impact" maxlength="${ISSUE_LIMITS.field}" required></textarea></label>
      <label>Browser, device and page or control<input name="environment" maxlength="${ISSUE_LIMITS.field}" required></label>
      <button type="submit">Build safe draft</button>
    </form>
    <section class="issue-edit">
      <h3>Edit your report or paste wording from DBusker</h3>
      <label>Draft title<input data-title maxlength="${ISSUE_LIMITS.title}"></label>
      <label>Draft body<textarea data-body rows="9" maxlength="${ISSUE_LIMITS.body}"></textarea></label>
      <button type="button" data-review>Review sanitized preview</button>
    </section>
    <p data-status role="status" aria-live="polite"></p>
    <section data-preview hidden>
      <h3>Exactly what will go to GitHub</h3><pre data-text></pre>
      <a data-search target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">1. Search existing issues (open and closed)</a>
      <label class="issue-check"><input type="checkbox" data-duplicates> I searched first. This is a new problem, not an existing report.</label>
      <label class="issue-check"><input type="checkbox" data-confirm> I reviewed every word and removed private information. I will review and submit on GitHub myself.</label>
      <div class="issue-actions"><button type="button" data-copy disabled>Copy reviewed report</button>
      <a data-github target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" hidden>2. Open draft on GitHub - submit there</a></div>
    </section>
    <p>A maintainer checks duplicates, attribution and bounty eligibility and applies reward labels. You do not label or approve your own payout. Filing is not approval or a payment promise.</p>
    <button type="button" data-close>Close and discard</button>`;
  const find = selector => dialog.querySelector(selector);
  const title = find('[data-title]'), body = find('[data-body]'), status = find('[data-status]');
  let reviewed = null;
  function invalidate() {
    reviewed = null;
    find('[data-preview]').hidden = true;
    find('[data-github]').hidden = true;
    find('[data-github]').removeAttribute('href');
    find('[data-search]').removeAttribute('href');
    find('[data-confirm]').checked = false;
    find('[data-duplicates]').checked = false;
    find('[data-copy]').disabled = true;
    status.textContent = 'Draft changed. Review again before copying or opening GitHub.';
  }
  function sync() {
    const ready = reviewed && find('[data-confirm]').checked && find('[data-duplicates]').checked;
    find('[data-copy]').disabled = !ready;
    find('[data-github]').hidden = !ready;
    if (ready) find('[data-github]').href = reviewed.url;
    else find('[data-github]').removeAttribute('href');
  }
  function review(action) {
    invalidate();
    try {
      reviewed = action();
      title.value = reviewed.title;
      body.value = reviewed.body;
      find('[data-text]').textContent = `${reviewed.title}\n\n${reviewed.body}`;
      find('[data-search]').href = reviewed.searchUrl;
      find('[data-preview]').hidden = false;
      status.textContent = 'Check the sanitized preview for private information and search for duplicates. No issue has been filed.';
    } catch (error) { status.textContent = error.message; }
  }
  find('form').addEventListener('submit', event => {
    event.preventDefault();
    const fields = Object.fromEntries([...find('form').elements].filter(el => el.name).map(el => [el.name, el.value]));
    review(() => buildIssueDraft(fields));
  });
  find('[data-review]').addEventListener('click', () => review(() => reviewIssueDraft({ title: title.value, body: body.value })));
  dialog.addEventListener('input', event => {
    if (event.target.matches('[data-confirm], [data-duplicates]')) sync();
    else if (event.target.matches('input, textarea')) invalidate();
  });
  find('[data-copy]').addEventListener('click', async () => {
    if (!reviewed || find('[data-copy]').disabled) return;
    try {
      await document.defaultView.navigator.clipboard.writeText(`${reviewed.title}\n\n${reviewed.body}`);
      status.textContent = 'Reviewed report copied. Paste it on GitHub if needed, review it there, and submit.';
    } catch (error) { status.textContent = `Copy unavailable: ${error.message}. Select the reviewed text above and copy it manually.`; }
  });
  const close = () => { dialog.close(); dialog.remove(); previous?.focus(); };
  find('[data-close]').addEventListener('click', close);
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  document.body.append(dialog);
  dialog.showModal();
  find('[name="title"]').focus();
}

if (typeof document !== 'undefined') {
  document.addEventListener('open-issue-helper', () => openIssueHelper());
}
