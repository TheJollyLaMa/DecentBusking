const DISMISSED = 'decentbusking:dbusker:dismissed:v1';

const PATHS = [
  { title: 'Help build or test', label: 'Tinker', note: 'Small fixes. Real impact.', icon: 'tools',
    question: "I'm not a coder. Could testing help with repo dev, and how do I file an issue?" },
  { title: 'Keep a community copy', label: 'Keep the signal', note: 'A little help from IPFS.', icon: 'signal',
    question: 'Can I earn IPFS pinning rewards by keeping a copy of the community music?' },
  { title: 'Artists & weekly funds', label: 'Take the stage', note: 'Music, shows & shared pots.', icon: 'star',
    question: 'How do Top10, Playback and Live Performance funds work, and what makes someone eligible?' },
  { title: 'Promote with DVert', label: 'Make some waves', note: 'Your project. A wider horizon.', icon: 'waves',
    question: 'I want to run a DVert ad campaign. How do I trace its funds to artists and platform builders?' },
  { title: 'Listen & make a playlist', label: 'Find your groove', note: 'A mix for you. Or everyone.', icon: 'notes',
    question: 'Show me the bunny tutorial for DJuke playlists, Personal Play and radio takeover.' },
  { title: 'Collaborators & albums', label: 'Share the tune', note: 'Good company. Clear splits.', icon: 'link',
    question: 'How do album collaborators agree to split payments, and which version supports that?' },
  { title: 'Build my own beacon', label: 'Light a beacon', note: 'Your own corner of Earth.', icon: 'beacon',
    question: 'I want to fork this and host my own community beacon. What do I need?' },
];

const MARKS = {
  tools: '<path d="m8 6 4 4m-6 8 7-7m1-5a5 5 0 0 0 5 6l-7 7-4-4 7-7a5 5 0 0 0 6 5"/><path d="m4 4 3 1 1 3-2 2-3-1-1-3z"/>',
  signal: '<path d="m12 3 8 5v8l-8 5-8-5V8zM4 8l8 5 8-5m-8 5v8"/><path d="m8 6 8 5"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>',
  waves: '<path d="M3 8c3-5 5 5 9 0s6 5 9 0M3 13c3-5 5 5 9 0s6 5 9 0M3 18c3-5 5 5 9 0s6 5 9 0"/>',
  notes: '<path d="M9 17V5l11-2v12M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/>',
  link: '<path d="m10 14 4-4m-6 1-3 3a4 4 0 0 0 6 6l3-3m2-4 3-3a4 4 0 0 0-6-6l-3 3"/><path d="m5 5 1 1m12 12 1 1"/>',
  beacon: '<path d="m8 21 2-11h4l2 11M7 21h10M9 10V6h6v4M10 6l2-3 2 3M5 5 2 3m17 2 3-2M5 9H1m18 0h4"/><path d="M11 16h2"/>',
};

function mark(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${MARKS[name]}</svg>`;
}

export function createCompanionChime(window, document, onError) {
  let context = null, enabled = false, disposed = false, playing = false, generation = 0;
  const voices = new Set();
  const mediaPlaying = () => [...document.querySelectorAll('audio,video')]
    .some(media => !media.paused && !media.muted && media.volume > 0);
  const stop = () => {
    generation++;
    for (const oscillator of voices) oscillator.stop();
    voices.clear();
  };
  return {
    async setEnabled(value) {
      enabled = value;
      if (!enabled) { stop(); return; }
      await this.play();
    },
    async play() {
      if (!enabled || disposed || playing || document.hidden || mediaPlaying()) return;
      playing = true;
      const current = generation;
      try {
        if (!window.AudioContext) throw new Error('This browser does not support companion sounds.');
        context ||= new window.AudioContext();
        await context.resume();
        if (!enabled || disposed || document.hidden || current !== generation || mediaPlaying()) return;
        const start = context.currentTime;
        for (const [index, frequency] of [523.25, 783.99].entries()) {
          const oscillator = context.createOscillator(), gain = context.createGain();
          oscillator.type = 'sine';
          oscillator.frequency.value = frequency;
          gain.gain.setValueAtTime(0, start);
          gain.gain.linearRampToValueAtTime(0.018, start + index * 0.075 + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + index * 0.075 + 0.16);
          oscillator.connect(gain); gain.connect(context.destination);
          voices.add(oscillator);
          oscillator.onended = () => { voices.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
          oscillator.start(start + index * 0.075);
          oscillator.stop(start + index * 0.075 + 0.18);
        }
      } catch (error) {
        enabled = false;
        onError(error);
      } finally { playing = false; }
    },
    stop,
    dispose() {
      enabled = false; disposed = true; stop();
      if (context) context.close().catch(onError);
    },
  };
}

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
    <link rel="stylesheet" href="${new URL('../css/dbusker.css?v=20261027-routing', import.meta.url).href}">
    <div class="greeting" hidden><span>How can I help you, Earthling?</span><button type="button" class="dismiss" aria-label="Dismiss DBusker greeting">Not now</button></div>
    <button type="button" class="launcher" aria-label="Ask DBusker, AI community guide" aria-expanded="false" aria-controls="dbusker-chat">
      <span class="launcher-portrait"><img src="${new URL('../img/D_Busker.jpeg', import.meta.url).href}" alt="" width="58" height="58"></span><span><small>A friendly signal</small>Ask DBusker</span><span class="signal-dot" aria-hidden="true"></span>
    </button>
    <section id="dbusker-chat" role="dialog" aria-labelledby="dbusker-title" hidden>
      <header class="cabin-header"><span class="station-mark" aria-hidden="true">${mark('beacon')}</span><h2 id="dbusker-title">DBusker <small>AI guide / invited pilot</small></h2><div class="cabin-controls"><button type="button" class="sound" aria-label="Enable DBusker chimes" aria-pressed="false" title="Optional chimes. Quiet while the radio plays.">Sound off</button><button type="button" class="close" aria-label="Close DBusker chat" title="Close chat">Close</button></div></header>
      <div class="cabin-body">
      <div class="welcome">
        <div class="portrait-port"><span class="orbit orbit-one" aria-hidden="true"></span><span class="orbit orbit-two" aria-hidden="true"></span><img src="${new URL('../img/D_Busker.jpeg', import.meta.url).href}" alt="DBusker, your street-corner companion" width="92" height="92"><span class="portrait-star" aria-hidden="true">+</span></div>
        <div class="welcome-copy"><p class="eyebrow">Good company. Open horizons.</p><p class="hello">How can I help you, <br><em>Earthling?</em></p><p class="welcome-note">Pull up a corner of the universe.</p></div>
      </div>
      <details class="paths" open><summary><span>Pick a little adventure</span><span class="path-count" aria-hidden="true">07 paths / one planet</span></summary>
        <p class="paths-hint">A tune, a question, a bright idea. Where shall we wander?</p>
        <div class="starters">
          ${PATHS.map(route => `<button type="button" class="path path-${route.icon}" aria-label="${route.label}: ${route.title.replaceAll('&', '&amp;')}" title="${route.note}" aria-pressed="false" data-starter="${route.question.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"><span class="path-medallion">${mark(route.icon)}</span><span class="path-label">${route.label}</span><span class="path-note">${route.note}</span></button>`).join('')}
        </div>
        <p class="paths-hint">Choose a path to draft a question. Nothing sends until you ask.</p>
      </details>
      <details class="field-notes"><summary>Maps, bunny trails &amp; the small print</summary>
        <p class="intro">An AI public-code guide, not a human steward. No transactions or automatic posting.
          <a href="https://github.com/TheJollyLaMa/DecentBusking/blob/main/docs/NEWCOMERS.md" target="_blank" rel="noopener noreferrer">Public newcomer guide</a></p>
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
      <label class="mode-label" for="dbusker-mode">How shall we travel?<select id="dbusker-mode" aria-describedby="dbusker-mode-note">
        <option value="efficient">Efficient / one light pass</option>
        <option value="balanced" selected>Balanced / automatic triage</option>
        <option value="deep">Deep dive / stronger model</option>
      </select></label>
      <p class="mode-note" id="dbusker-mode-note">Balanced chooses a model locally and may make one deeper pass. No automatic learning from your chat; private aggregate performance counters help the steward review routes.</p>
      <p class="route-result" role="status" aria-live="polite"></p>
      <div class="transcript" role="log" aria-label="DBusker conversation" aria-live="polite" tabindex="0"></div>
      <form><label for="dbusker-question">Your question</label><textarea id="dbusker-question" maxlength="2000" rows="3" required disabled></textarea><button type="submit" class="send" disabled>Ask DBusker</button></form>
      <p class="handoff"></p>
      </div>
      <div class="cabin-foot" aria-hidden="true"><span>Earth Village / open frequencies</span><span class="speaker-grille"></span><span class="foot-light"></span></div>
    </section>`;
  document.body.append(host);
  const find = selector => root.querySelector(selector);
  const launcher = find('.launcher'), panel = find('section'), status = find('.status');
  const consent = find('input'), signin = find('.signin'), signout = find('.signout');
  const question = find('textarea'), send = find('.send'), transcript = find('.transcript');
  const mode = find('#dbusker-mode');
  const modeNotes = {
    efficient: 'One light-model pass. Lowest compute ceiling, not a guarantee of the best answer. If it needs deeper review, choose Balanced or Deep dive.',
    balanced: 'Balanced chooses a model locally and may make one deeper pass. No automatic learning from your chat; private aggregate performance counters help the steward review routes.',
    deep: 'One stronger-model pass for complex questions. More compute does not supply missing evidence or verify live payouts.',
  };
  mode.addEventListener('change', () => { find('.mode-note').textContent = modeNotes[mode.value]; });
  let credential = null, wallet = null, expiresAt = 0, pending = false, generation = 0;
  let controller = null, expiryTimer = null, dismissed = false, returnFocus = null;
  const sound = find('.sound');
  const chime = createCompanionChime(window, document, error => {
    sound.setAttribute('aria-pressed', 'false');
    sound.setAttribute('aria-label', 'Enable DBusker chimes');
    sound.textContent = 'Sound off';
    status.textContent = `Companion sound unavailable: ${error.message}`;
    console.warn('[dbusker] companion sound unavailable:', error.message);
  });
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
    mode.disabled = pending;
    root.querySelectorAll('[data-starter]').forEach(button => { button.disabled = pending; });
    transcript.setAttribute('aria-busy', String(pending));
    panel.classList.toggle('is-thinking', pending);
    panel.classList.toggle('is-connected', Boolean(credential));
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
    find('.route-result').textContent = '';
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
    returnFocus = document.activeElement === host ? root.activeElement : document.activeElement;
    dismiss();
    panel.hidden = false;
    launcher.hidden = true;
    launcher.setAttribute('aria-expanded', 'true');
    find('.close').focus();
    void chime.play();
  }
  function hide() {
    panel.hidden = true;
    launcher.hidden = false;
    launcher.setAttribute('aria-expanded', 'false');
    chime.stop();
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
    article.className = role === 'DBusker' ? 'from-dbusker' : 'from-visitor';
    article.scrollIntoView({ block: 'nearest' });
  }
  launcher.addEventListener('click', show);
  find('.dismiss').addEventListener('click', dismiss);
  find('.close').addEventListener('click', hide);
  sound.addEventListener('click', () => {
    const enabled = sound.getAttribute('aria-pressed') !== 'true';
    sound.setAttribute('aria-pressed', String(enabled));
    sound.setAttribute('aria-label', enabled ? 'Disable DBusker chimes' : 'Enable DBusker chimes');
    sound.textContent = enabled ? 'Sound on' : 'Sound off';
    void chime.setEnabled(enabled);
  });
  document.addEventListener('play', () => chime.stop(), true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) chime.stop(); });
  window.addEventListener('pagehide', event => {
    if (event.persisted) chime.stop();
    else chime.dispose();
  });
  root.querySelectorAll('[data-starter]').forEach(button => button.addEventListener('click', () => {
    question.value = button.dataset.starter;
    find('.paths').open = false;
    root.querySelectorAll('[data-starter]').forEach(route => {
      route.setAttribute('aria-pressed', String(route === button));
    });
    void chime.play();
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
    status.textContent = `${mode.options[mode.selectedIndex].text}. Reading approved sources and checking the answer; Balanced may take one deeper pass.`;
    find('.route-result').textContent = '';
    append('You', message);
    try {
      const answer = await request('/chat', { message, consent: true, mode: mode.value }, { signal: controller.signal });
      if (attempt !== generation) return;
      append('DBusker', answer.answer, answer.sources);
      if (answer.routing) {
        find('.route-result').textContent = answer.routing.attempts
          ? `${answer.routing.mode} / ${answer.routing.models.join(' → ')} / ${answer.routing.attempts} provider pass${answer.routing.attempts === 1 ? '' : 'es'}. ${answer.routing.attempts > 1 ? 'One deeper review used. ' : ''}Self-check: ${answer.routing.review.replaceAll('_', ' ')}; not independent fact verification.`
          : 'No provider call: approved evidence was not found. Try a more specific question.';
      }
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
      chime.stop();
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
