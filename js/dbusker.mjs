const DISMISSED = 'decentbusking:dbusker:dismissed:v1';

export function validServiceUrl(value) {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(url.hostname))) || url.username || url.password ||
      url.search || url.hash) throw new Error('DBusker requires an HTTPS service URL (HTTP only on localhost).');
  return url.href.replace(/\/$/, '');
}

export function companionBlocked(document) {
  const visibleModal = [...document.querySelectorAll('dialog[open], [aria-modal="true"]')].some(element => {
    for (let node = element; node; node = node.parentElement) {
      const style = document.defaultView.getComputedStyle(node);
      if (node.hidden || node.classList.contains('hidden') || node.getAttribute('aria-hidden') === 'true' ||
          style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  });
  return Boolean(visibleModal ||
    document.getElementById('decentbusking-tutorial-overlay')?.hidden === false ||
    document.getElementById('mint-submit-btn')?.disabled ||
    document.getElementById('devert-audio-mode')?.getAttribute('aria-pressed') === 'true');
}

export function initDBusker({ document = globalThis.document, window = globalThis.window } = {}) {
  const config = window.DecentConfig?.dbusker;
  if (!config?.enabled || document.getElementById('dbusker-companion')) return;
  let base;
  try { base = validServiceUrl(config.serviceUrl); }
  catch (error) {
    console.error('[dbusker] invalid configuration:', error.message);
    return;
  }
  const host = document.createElement('aside');
  host.id = 'dbusker-companion';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <link rel="stylesheet" href="${new URL('../css/dbusker.css', import.meta.url).href}">
    <div class="greeting" hidden><span>Any questions?</span><button type="button" class="dismiss" aria-label="Dismiss DBusker greeting">Not now</button></div>
    <button type="button" class="launcher" aria-label="Ask DBusker, AI community guide" aria-expanded="false" aria-controls="dbusker-chat">
      <img src="${new URL('../img/D_Busker.jpeg', import.meta.url).href}" alt="" width="58" height="58"><span>Ask DBusker</span>
    </button>
    <section id="dbusker-chat" role="dialog" aria-labelledby="dbusker-title" hidden>
      <header><h2 id="dbusker-title">DBusker <small>AI guide · invited pilot</small></h2><button type="button" class="close" aria-label="Close DBusker chat">Close</button></header>
      <p class="intro">A public-code guide, not a human steward. No transactions or automatic posting.
        <a href="https://github.com/TheJollyLaMa/DecentBusking/blob/main/docs/NEWCOMERS.md" target="_blank" rel="noopener noreferrer">Public newcomer guide</a></p>
      <details class="paths"><summary>Find your way to contribute</summary>
        <p>Listening counts, too. Pick a question to edit; nothing is sent until you sign in and choose Ask.</p>
        <div class="starters">
          <button type="button" data-starter="I'm not a coder. Could testing help with repo dev, and how do I file an issue?">Help build or test</button>
          <button type="button" data-starter="Can I earn IPFS pinning rewards by keeping a copy of the community music?">Keep a community copy</button>
          <button type="button" data-starter="How do Top10, Playback and Live Performance funds work, and what makes someone eligible?">Artists &amp; weekly funds</button>
          <button type="button" data-starter="I want to run a DVert ad campaign. How do I trace its funds to artists and platform builders?">Promote with DVert</button>
          <button type="button" data-starter="Show me the bunny tutorial for DJuke playlists, Personal Play and radio takeover.">Listen &amp; make a playlist</button>
          <button type="button" data-starter="How do album collaborators agree to split payments, and which version supports that?">Collaborators &amp; albums</button>
          <button type="button" data-starter="I want to fork this and host my own community beacon. What do I need?">Build my own beacon</button>
        </div>
        <p>Public guides (new tabs):
          <a href="?tutorial=payroll" target="_blank" rel="noopener noreferrer">Fund proofs</a> ·
          <a href="?tutorial=playlists" target="_blank" rel="noopener noreferrer">Playlist bunny</a> ·
          <a href="?tutorial=splits" target="_blank" rel="noopener noreferrer">Collaborator bunny</a>.
          <a href="https://github.com/TheJollyLaMa/DecentBusking/issues/new/choose" target="_blank" rel="noopener noreferrer">Report or propose an improvement</a>.
        </p>
        <p><a href="https://github.com/TheJollyLaMa/DecentBusking/issues/new?template=whitelist-request.yml" target="_blank" rel="noopener noreferrer">Contributor Request</a>
          publishes your GitHub handle and payout wallet on GitHub. Chat access does not enroll you for rewards.</p>
      </details>
      <label class="consent"><input type="checkbox"> I agree to send my questions and recent chat context to OpenAI.
        Don't share secrets. Chat is kept in server memory for up to 15 minutes; the provider's own retention policy also applies.
        <a href="https://developers.openai.com/api/docs/guides/your-data" target="_blank" rel="noopener noreferrer">Provider data policy</a></label>
      <div class="actions"><button type="button" class="signin">Sign in with wallet</button><button type="button" class="signout" hidden>Clear chat &amp; sign out</button></div>
      <p class="status" role="status" aria-live="polite">Invite-only. Connect through the site header, then sign in here on Base. No gas or payment.</p>
      <div class="transcript" role="log" aria-label="DBusker conversation" aria-live="polite" tabindex="0"></div>
      <form><label for="dbusker-question">Your question</label><textarea id="dbusker-question" maxlength="2000" rows="3" required disabled></textarea><button type="submit" class="send" disabled>Ask DBusker</button></form>
      <p class="handoff"></p>
    </section>`;
  document.body.append(host);
  const find = selector => root.querySelector(selector);
  const launcher = find('.launcher'), panel = find('section'), status = find('.status');
  const consent = find('input'), signin = find('.signin'), signout = find('.signout');
  const question = find('textarea'), send = find('.send'), transcript = find('.transcript');
  let credential = null, wallet = null, expiresAt = 0, pending = false, generation = 0;
  let controller = null, expiryTimer = null, dismissed = false, returnFocus = null;
  try { dismissed = window.localStorage.getItem(DISMISSED) === '1'; }
  catch (error) { console.warn('[dbusker] greeting preference could not be read:', error.message); }

  function dismiss() {
    dismissed = true;
    find('.greeting').hidden = true;
    try { window.localStorage.setItem(DISMISSED, '1'); }
    catch (error) { console.warn('[dbusker] greeting preference could not be saved:', error.message); }
  }
  function controls() {
    signin.hidden = Boolean(credential);
    signin.disabled = pending || !consent.checked;
    signout.hidden = !credential;
    question.disabled = pending || !credential || !consent.checked;
    send.disabled = question.disabled;
    root.querySelectorAll('[data-starter]').forEach(button => { button.disabled = pending; });
    transcript.setAttribute('aria-busy', String(pending));
  }
  function clear(message = 'Chat cleared. Sign in again when ready.') {
    generation++;
    controller?.abort();
    controller = null;
    window.clearTimeout(expiryTimer);
    credential = wallet = null;
    expiresAt = 0;
    pending = false;
    transcript.replaceChildren();
    question.value = '';
    find('.handoff').textContent = '';
    status.textContent = message;
    controls();
  }
  async function request(route, payload, { method = 'POST', auth = credential, signal } = {}) {
    const response = await window.fetch(`${base}${route}`, {
      method, signal, credentials: 'omit', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) clear(data.error || 'Please sign in again.');
      throw new Error(data.error || `DBusker request failed (${response.status}).`);
    }
    return data;
  }
  function show() {
    if (companionBlocked(document)) return;
    returnFocus = document.activeElement;
    dismiss();
    panel.hidden = false;
    launcher.hidden = true;
    launcher.setAttribute('aria-expanded', 'true');
    find('.close').focus();
  }
  function hide() {
    panel.hidden = true;
    launcher.hidden = false;
    launcher.setAttribute('aria-expanded', 'false');
    if (returnFocus?.isConnected && returnFocus !== document.body) returnFocus.focus();
    else launcher.focus();
  }
  function append(role, text, sources = []) {
    const article = document.createElement('article');
    const label = document.createElement('strong');
    label.textContent = role;
    const content = document.createElement('p');
    content.textContent = text;
    article.append(label, content);
    for (const source of sources) {
      const url = new URL(source.url);
      if (url.origin !== 'https://github.com' || !url.pathname.startsWith('/TheJollyLaMa/DecentBusking/blob/')) {
        throw new Error('DBusker returned an unexpected source URL.');
      }
      const link = document.createElement('a');
      link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = `${source.file}:${source.line}`;
      article.append(link);
    }
    transcript.append(article);
    article.scrollIntoView({ block: 'nearest' });
  }
  launcher.addEventListener('click', show);
  find('.dismiss').addEventListener('click', dismiss);
  find('.close').addEventListener('click', hide);
  root.querySelectorAll('[data-starter]').forEach(button => button.addEventListener('click', () => {
    question.value = button.dataset.starter;
    find('.paths').open = false;
    status.textContent = credential
      ? 'Question drafted. Edit it if you like, then choose Ask DBusker.'
      : 'Question drafted, not sent. Review the data notice and sign in with an invited wallet when ready.';
    if (!question.disabled) question.focus();
    else consent.focus();
  }));
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) { event.stopPropagation(); hide(); }
  });
  consent.addEventListener('change', () => {
    if (!consent.checked) signout.click();
    controls();
  });
  signin.addEventListener('click', async () => {
    if (!consent.checked || pending) return;
    const current = window._wallet;
    if (!current?.address || !current.signer) {
      status.textContent = 'Connect your wallet using the site header first; chat will not open a wallet prompt automatically.';
      return;
    }
    if (current.chainId !== 8453) { status.textContent = 'Switch your wallet to Base, then sign in again.'; return; }
    const attempt = generation;
    const address = current.address;
    pending = true; controls();
    controller = new AbortController();
    status.textContent = 'Checking your invitation. Signing proves wallet ownership; it does not authorize payment.';
    try {
      const { message } = await request('/challenge', { address, chainId: current.chainId }, { signal: controller.signal });
      if (attempt !== generation) return;
      const signature = await current.signer.signMessage(message);
      if (attempt !== generation) return;
      const session = await request('/session', { message, signature }, { signal: controller.signal });
      if (attempt !== generation) {
        await request('/session', null, { method: 'DELETE', auth: session.token });
        return;
      }
      credential = session.token; wallet = session.wallet; expiresAt = session.expiresAt;
      expiryTimer = window.setTimeout(() => signout.click(), Math.max(0, expiresAt - Date.now()));
      find('.handoff').textContent = `Public source ${session.handoff.commit.slice(0, 8)} · handoff ${session.handoff.digest.slice(0, 8)}. No live-state access.`;
      status.textContent = 'Signed in. Ask about getting started, the public code, or hosting your own community.';
    } catch (error) {
      if (attempt === generation) status.textContent = error.message;
    } finally {
      if (attempt === generation) { pending = false; controller = null; controls(); }
    }
  });
  signout.addEventListener('click', () => {
    const old = credential;
    clear();
    const attempt = generation;
    if (old) request('/session', null, { method: 'DELETE', auth: old }).catch(error => {
      if (attempt === generation) status.textContent = `Local chat cleared; server sign-out could not be confirmed: ${error.message}`;
      console.warn('[dbusker] server sign-out failed:', error.message);
    });
  });
  find('form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!credential || !consent.checked || pending || !question.value.trim()) return;
    if (Date.now() >= expiresAt) { signout.click(); return; }
    const message = question.value.trim(), attempt = generation;
    pending = true; controls();
    controller = new AbortController();
    status.textContent = 'Reading approved sources. Answers appear after their source IDs have been checked.';
    append('You', message);
    try {
      const answer = await request('/chat', { message, consent: true }, { signal: controller.signal });
      if (attempt !== generation) return;
      append('DBusker', answer.answer, answer.sources);
      question.value = '';
      status.textContent = answer.abstained ? 'DBusker could not verify part of this question. Check the evidence limits above.' : 'Answer ready. Source links are evidence, not proof of live deployment.';
    } catch (error) {
      if (attempt === generation) status.textContent = error.message;
    } finally {
      if (attempt === generation) { pending = false; controller = null; controls(); question.focus(); }
    }
  });
  const walletChanged = () => {
    if ((wallet && window._wallet?.address?.toLowerCase() !== wallet) || pending ||
        (credential && window._wallet?.chainId !== 8453)) signout.click();
  };
  document.addEventListener('wallet-connected', walletChanged);
  document.addEventListener('wallet-disconnected', () => signout.click());
  // Hide the companion when existing dialogs or the tour need the screen.
  const observer = new window.MutationObserver(records => {
    if (records.every(record => record.attributeName === 'style' &&
        !record.target.matches('dialog, [aria-modal="true"]') &&
        !record.target.querySelector('dialog, [aria-modal="true"]'))) return;
    const blocked = companionBlocked(document);
    if (host.hidden !== blocked) host.hidden = blocked;
    if (blocked && !panel.hidden) {
      panel.hidden = true;
      launcher.hidden = false;
      launcher.setAttribute('aria-expanded', 'false');
    }
    find('.greeting').hidden = blocked || dismissed || !panel.hidden;
  });
  observer.observe(document.body, { attributes: true, childList: true, subtree: true,
    attributeFilter: ['hidden', 'class', 'style', 'open', 'disabled', 'aria-pressed', 'aria-modal', 'aria-hidden'] });
  host.hidden = companionBlocked(document);
  find('.greeting').hidden = dismissed || host.hidden;
  controls();
}
