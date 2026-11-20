import { initBigNutenPanel } from './bignuten-panel.mjs?v=20261119-guided-care';

export function initRightSidePanels({ document = globalThis.document, window = globalThis.window,
  fetchImpl = globalThis.fetch } = {}) {
  const byId = id => document.getElementById(id);
  if (!byId('right-side-tabs')) return;
  const frame = byId('rehearsal-frame'), notice = byId('right-panel-status');
  const tabs = { rehearsal: byId('rehearsal-tab'), bignuten: byId('bignuten-tab') };
  const bignuten = initBigNutenPanel({ document, window, fetchImpl });
  let active = '', busy = false, eligible = false, retryAccess = false, walletVersion = 0, returnFocus;
  let ready = false, roomId = '', pendingClose;
  const service = String(window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
  const say = message => { notice.textContent = message; };
  function show(name) {
    if (name !== 'bignuten') bignuten?.pause();
    active = name;
    for (const [key, tab] of Object.entries(tabs)) {
      const panel = byId(`${key}-panel`), open = key === name;
      panel.classList.toggle('is-open', open);
      panel.setAttribute('aria-hidden', String(!open));
      panel.inert = !open;
      tab.setAttribute('aria-expanded', String(open));
    }
    document.body.classList.toggle('right-utility-open', !!name);
    if (name === 'bignuten') bignuten?.refresh();
    if (name) byId(`${name}-panel-close`).focus();
    else returnFocus?.focus();
  }
  function clearFrame() {
    frame.src = 'about:blank';
    ready = false; roomId = '';
  }
  async function closeStudio() {
    if (!byId('recording-edit-panel').classList.contains('is-open')) return;
    const saved = await new Promise(resolve => {
      const timeout = setTimeout(() => resolve(false), 12000);
      document.dispatchEvent(new window.CustomEvent('decentbusking:close-recording-editor', {
        detail: { complete: ok => { clearTimeout(timeout); resolve(ok); } },
      }));
    });
    if (!saved) throw Error('The studio draft has not been saved. Keep it open and retry before switching panels.');
  }
  async function closeRehearsal(handoff = false) {
    if (!ready) { clearFrame(); return; }
    if (pendingClose) throw Error('The rehearsal is already closing; wait and retry.');
    const warning = await new Promise((resolve, reject) => {
      const id = window.crypto.randomUUID();
      const timer = setTimeout(() => {
        pendingClose = null;
        reject(Error('Microphone shutdown was not confirmed. Keep the rehearsal visible and retry closing.'));
      }, 12000);
      pendingClose = { id, finish(ok, warning = '') {
        clearTimeout(timer); pendingClose = null;
        if (ok) resolve(warning); else reject(Error('Finish the current rehearsal action, then retry closing.'));
      } };
      frame.contentWindow.postMessage({ type: 'decentbusking:close-rehearsal', requestId: id, handoff }, window.location.origin);
    });
    clearFrame();
    return warning;
  }
  async function closeUtility() {
    const warning = active === 'rehearsal' ? await closeRehearsal() : '';
    show('');
    return warning;
  }
  const action = fn => async () => {
    if (busy) return;
    busy = true;
    try { const warning = await fn(); say(typeof warning === 'string' ? warning : ''); }
    catch (error) { say(error.message || 'This panel could not open or close. Retry.'); }
    finally { busy = false; }
  };
  async function open(name) {
    const version = walletVersion;
    if (active === name) { await closeUtility(); return; }
    if (name === 'rehearsal' && !eligible) throw Error('Connect an eligible performer or administrator wallet first.');
    await closeStudio();
    const warning = await closeUtility();
    if (name === 'rehearsal' && (version !== walletVersion || !eligible)) throw Error('Wallet changed; wait for its DHearse access check before opening.');
    byId('dnft-list-close')?.click();
    returnFocus = tabs[name];
    if (name === 'rehearsal') {
      const mute = byId('radio-mute');
      if (mute?.getAttribute('aria-pressed') === 'false') mute.click();
      ready = false; roomId = '';
      frame.src = new URL('rehearsal.html?embedded=1', window.location.href).href;
    }
    show(name);
    return warning;
  }
  for (const name of Object.keys(tabs)) {
    tabs[name].addEventListener('click', action(async () => {
      if (name === 'rehearsal' && !eligible) {
        if (!retryAccess || !await checkRehearsalAccess(walletVersion)) return;
      }
      return open(name);
    }));
    byId(`${name}-panel-close`).addEventListener('click', action(closeUtility));
  }
  byId('rehearsal-popout').addEventListener('click', () => {
    if (busy || active !== 'rehearsal') return;
    const popup = window.open('about:blank', '_blank', 'popup,width=620,height=850');
    if (!popup) { say('Your browser blocked the popout. Allow popups for this site and retry.'); return; }
    const link = new URL('rehearsal.html', window.location.href);
    if (roomId) link.hash = new URLSearchParams({ room: roomId }).toString();
    void action(async () => {
      try {
        const warning = await closeRehearsal(true);
        popup.opener = null;
        popup.location.replace(link.href);
        show('');
        return warning;
      } catch (error) { popup.close(); throw error; }
    })();
  });
  window.addEventListener('message', event => {
    if (event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
    if (event.data?.type === 'decentbusking:rehearsal-ready') ready = true;
    if (event.data?.type === 'decentbusking:rehearsal-room' && /^rehearsal:[0-9a-f]{64}$/.test(event.data.roomId)) {
      roomId = event.data.roomId;
    }
    if (pendingClose && event.data?.requestId === pendingClose.id &&
        ['decentbusking:rehearsal-closed', 'decentbusking:rehearsal-close-failed'].includes(event.data.type)) {
      pendingClose.finish(event.data.type === 'decentbusking:rehearsal-closed',
        typeof event.data.warning === 'string' ? event.data.warning : '');
    }
  });
  let replaying = false;
  document.addEventListener('click', event => {
    const trigger = event.target.closest('#dnft-archive-toggle, #recording-edit-tab, [data-recording-edit], [data-catalog-recording-edit]');
    if (!trigger || replaying) return;
    const archive = trigger.id === 'dnft-archive-toggle';
    if (!active && (!archive || !byId('recording-edit-panel').classList.contains('is-open'))) return;
    event.preventDefault(); event.stopImmediatePropagation();
    void action(async () => {
      if (archive) await closeStudio();
      const warning = await closeUtility();
      replaying = true;
      try { trigger.click(); } finally { replaying = false; }
      return warning;
    })();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active) {
      event.preventDefault();
      void action(closeUtility)();
    }
  });
  function setRehearsalAccess(canHost, retry = false) {
    eligible = canHost;
    retryAccess = retry;
    tabs.rehearsal.hidden = !canHost && !retry;
    tabs.rehearsal.setAttribute('aria-label', retry ? 'Retry DHearse access check' : 'Open DHearse rehearsal room');
  }
  async function checkRehearsalAccess(version) {
    const wallet = String(window._wallet?.address || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(wallet) || !window._wallet?.signer) return false;
    try {
      const response = await fetchImpl(`${service}/api/private-rehearsal/eligibility`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet }),
        cache: 'no-store', signal: AbortSignal.timeout(15000),
      });
      const data = await response.json();
      if (!response.ok || typeof data.canHost !== 'boolean') throw Error(data.error || 'Performer eligibility response is unavailable.');
      if (version !== walletVersion) return false;
      setRehearsalAccess(data.canHost);
      return data.canHost;
    } catch (error) {
      if (version !== walletVersion) return false;
      setRehearsalAccess(false, true);
      console.warn('[DHearse] Access check failed:', error.message);
      return false;
    }
  }
  function walletChanged() {
    const version = ++walletVersion;
    setRehearsalAccess(false);
    if (active === 'rehearsal') {
      frame.contentWindow?.postMessage({ type: 'decentbusking:rehearsal-wallet-changed' }, window.location.origin);
      pendingClose?.finish(false);
      clearFrame(); show('');
    }
    void checkRehearsalAccess(version);
  }
  document.addEventListener('wallet-connected', walletChanged);
  document.addEventListener('wallet-disconnected', walletChanged);
  void walletChanged();
}

if (typeof document !== 'undefined') initRightSidePanels();
