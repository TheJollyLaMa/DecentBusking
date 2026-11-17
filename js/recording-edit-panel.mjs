import { fetchNftCatalogPage } from './nft-loader.js?v=20261012-paging';
import { canEditCatalogRecording } from './live-recording-edit.mjs?v=20261116-studio-polish';

export function initRecordingEditPanel({ document = globalThis.document, window = globalThis.window,
  fetchPage = fetchNftCatalogPage } = {}) {
  const panel = document.getElementById('recording-edit-panel');
  if (!panel) return;
  const byId = id => document.getElementById(id);
  const frame = byId('recording-edit-frame'), tab = byId('recording-edit-tab');
  const closeButton = byId('recording-edit-panel-close'), search = byId('recording-edit-search');
  const list = byId('recording-edit-library'), status = byId('recording-edit-library-status');
  const more = byId('recording-edit-more'), opening = byId('recording-edit-opening');
  let returnFocus, closing = false, closeTimeout, openingTimeout, searchTimer;
  let pendingNavigation, pendingRequestId = '', frameRequestId = '', frameReady = false, sourceKey = '';
  let address = '', eligible = false, nextOffset = null, songs = [], listAbort, requestVersion = 0;
  let closeCompletion;
  function settleClose(ok) { closeCompletion?.(ok); closeCompletion = null; }

  function setOpen(open) {
    panel.classList.toggle('is-open', open);
    panel.setAttribute('aria-hidden', String(!open));
    panel.inert = !open;
    tab.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('recording-edit-open', open);
    document.dispatchEvent(new window.CustomEvent('recording-editor-toggled', { detail: { open } }));
    if (open) closeButton.focus();
    else {
      settleClose(true);
      clearTimeout(closeTimeout);
      closing = false;
      returnFocus?.focus?.();
      returnFocus = null;
    }
  }

  function renderSongs() {
    list.replaceChildren();
    for (const nft of songs) {
      const item = document.createElement('li'), button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${nft.name || nft.title || 'Untitled song'} · #${nft.tokenId}`;
      button.dataset.catalogRecordingEdit = nft.nftId;
      item.append(button);
      list.append(item);
    }
    more.hidden = nextOffset === null;
  }

  async function loadSongs(reset = true) {
    listAbort?.abort();
    listAbort = new AbortController();
    const version = ++requestVersion, capturedAddress = address, signal = listAbort.signal;
    if (reset) { songs = []; nextOffset = 0; renderSongs(); }
    status.textContent = 'Finding your artist-credited song NFTs…';
    more.disabled = true;
    try {
      let found;
      do {
        const page = await fetchPage({ config: window.DecentConfig, artist: capturedAddress,
          query: search.value.trim(), offset: nextOffset ?? 0, signal });
        if (version !== requestVersion || address !== capturedAddress) return;
        found = page.nfts.filter(nft => canEditCatalogRecording(nft, capturedAddress));
        nextOffset = page.nextOffset;
        songs.push(...found);
      } while (!found.length && nextOffset !== null);
      eligible ||= songs.length > 0;
      tab.hidden = !eligible;
      renderSongs();
      status.textContent = songs.length ? `${songs.length} editable song${songs.length === 1 ? '' : 's'} loaded. Choose one to open it.`
        : search.value.trim() ? 'No matching songs in your artist catalog.' : 'No editable song NFTs credit this wallet yet.';
    } catch (error) {
      if (version !== requestVersion || signal.aborted) return;
      status.textContent = `Your songs could not load: ${error.message}. Reconnect or search again to retry.`;
      console.warn('[recording-editor] Artist catalog unavailable:', error.message);
    } finally {
      if (version === requestVersion) more.disabled = false;
    }
  }

  function clearFrame() {
    clearTimeout(openingTimeout);
    frame.contentWindow?.postMessage({ type: 'decentbusking:editor-wallet-changed' }, window.location.origin);
    frame.src = 'about:blank';
    frame.hidden = true;
    opening.hidden = true;
    frameReady = false;
    sourceKey = '';
    frameRequestId = '';
  }

  function navigate(navigation) {
    sourceKey = navigation.key;
    returnFocus = navigation.trigger;
    frameReady = false;
    frameRequestId = window.crypto.randomUUID();
    const url = new URL('recording-edit.html', window.location.href);
    url.searchParams.set(navigation.kind, navigation.id);
    url.searchParams.set('studioRequest', frameRequestId);
    frame.hidden = true;
    opening.hidden = false;
    opening.querySelector('p').textContent = 'Opening your recording studio…';
    frame.src = url.href;
    clearTimeout(openingTimeout);
    openingTimeout = setTimeout(() => {
      if (!frameReady) opening.querySelector('p').textContent = 'The studio is taking longer to open. Close and reopen it to retry.';
    }, 20000);
  }

  function requestFlush() {
    closing = true;
    closeButton.disabled = true;
    pendingRequestId = window.crypto.randomUUID();
    frame.contentWindow.postMessage({
      type: 'decentbusking:flush-recording-draft', requestId: pendingRequestId,
    }, window.location.origin);
    closeTimeout = setTimeout(() => {
      closing = false;
      pendingNavigation = null;
      pendingRequestId = '';
      closeButton.disabled = false;
      settleClose(false);
      status.textContent = 'The studio has not confirmed the draft save. Keep it open and retry closing after the current action finishes.';
    }, 10000);
  }

  function openEditor(kind, id, trigger) {
    document.getElementById('dnft-list-close')?.click();
    const details = document.getElementById('nft-panel');
    if (details?.open) details.close();
    const navigation = { kind, id, key: `${kind}:${id}`, trigger };
    if (closing || (frameReady && sourceKey && sourceKey !== navigation.key)) {
      pendingNavigation = navigation;
      if (!closing) requestFlush();
    } else if (sourceKey !== navigation.key) navigate(navigation);
    setOpen(true);
  }

  function walletChanged() {
    listAbort?.abort();
    requestVersion++;
    clearTimeout(searchTimer);
    clearTimeout(closeTimeout);
    pendingNavigation = null;
    pendingRequestId = '';
    closeButton.disabled = false;
    setOpen(false);
    clearFrame();
    address = String(window._wallet?.address || '').toLowerCase();
    eligible = false;
    tab.hidden = true;
    songs = [];
    nextOffset = null;
    search.value = '';
    renderSongs();
    if (/^0x[0-9a-f]{40}$/.test(address) && window._wallet?.signer) void loadSongs();
    else status.textContent = 'Connect your artist wallet in the page header to use the studio.';
  }

  tab.addEventListener('click', () => {
    if (!eligible) return;
    if (panel.classList.contains('is-open')) closeButton.click();
    else { returnFocus = tab; setOpen(true); }
  });
  closeButton.addEventListener('click', () => {
    if (closing) return;
    if (!frameReady) { clearFrame(); setOpen(false); return; }
    requestFlush();
  });
  document.addEventListener('decentbusking:close-recording-editor', event => {
    if (typeof event.detail?.complete !== 'function') return;
    if (!panel.classList.contains('is-open')) { event.detail.complete(true); return; }
    if (closing) { event.detail.complete(false); return; }
    closeCompletion = event.detail.complete;
    closeButton.click();
  });
  search.addEventListener('input', () => {
    listAbort?.abort();
    requestVersion++;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { void loadSongs(); }, 250);
  });
  more.addEventListener('click', () => { if (nextOffset !== null) void loadSongs(false); });
  document.addEventListener('click', event => {
    const catalog = event.target.closest('[data-catalog-recording-edit]');
    const booking = event.target.closest('[data-recording-edit]');
    const id = catalog?.dataset.catalogRecordingEdit || booking?.dataset.recordingEdit || '';
    if (!(catalog ? /^8453:0x[0-9a-f]{40}:\d{1,20}$/i : /^[a-zA-Z0-9:_-]{1,120}$/).test(id)) return;
    if (!eligible || !window._wallet?.signer) return;
    event.preventDefault();
    openEditor(catalog ? 'catalog' : 'booking', id, catalog || booking);
  });
  window.addEventListener('message', event => {
    if (event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
    if (event.data?.type === 'decentbusking:editor-ready' && event.data.requestId === frameRequestId) {
      frameReady = true;
      clearTimeout(openingTimeout);
      opening.hidden = true;
      frame.hidden = false;
      return;
    }
    if (event.data?.requestId !== pendingRequestId || !pendingRequestId ||
        !['decentbusking:recording-draft-flushed', 'decentbusking:recording-draft-flush-failed'].includes(event.data?.type)) return;
    closeButton.disabled = false;
    clearTimeout(closeTimeout);
    pendingRequestId = '';
    closing = false;
    if (event.data.type === 'decentbusking:recording-draft-flush-failed') {
      settleClose(false);
      pendingNavigation = null;
      status.textContent = 'The draft could not be saved. Keep the studio open and retry.';
    } else if (pendingNavigation) {
      const next = pendingNavigation;
      pendingNavigation = null;
      navigate(next);
    } else setOpen(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && panel.classList.contains('is-open') && !closing) {
      event.preventDefault();
      closeButton.click();
    }
  });
  document.addEventListener('wallet-connected', walletChanged);
  document.addEventListener('wallet-disconnected', walletChanged);
  walletChanged();
}

if (typeof document !== 'undefined') initRecordingEditPanel();
