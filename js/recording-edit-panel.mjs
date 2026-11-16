const panel = document.getElementById('recording-edit-panel');
const frame = document.getElementById('recording-edit-frame');
const closeButton = document.getElementById('recording-edit-panel-close');
const dedicatedLink = document.getElementById('recording-edit-dedicated');
let returnFocus = null;
let closing = false;
let closeTimeout;
let pendingNavigation = null;
let pendingRequestId = '';

function setOpen(open) {
  panel.classList.toggle('is-open', open);
  panel.setAttribute('aria-hidden', String(!open));
  panel.inert = !open;
  if (open) closeButton.focus();
  else {
    clearTimeout(closeTimeout);
    closing = false;
    returnFocus?.focus?.();
    returnFocus = null;
  }
}

function editorUrl(query) {
  const url = new URL('recording-edit.html', location.href);
  for (const [key, value] of query) url.searchParams.set(key, value);
  return url;
}

function requestFlush() {
  closing = true;
  closeButton.disabled = true;
  pendingRequestId = crypto.randomUUID();
  frame.contentWindow.postMessage({
    type: 'decentbusking:flush-recording-draft', requestId: pendingRequestId,
  }, location.origin);
  closeTimeout = setTimeout(() => {
    if (!closing) return;
    closing = false;
    pendingNavigation = null;
    pendingRequestId = '';
    closeButton.disabled = false;
  }, 10000);
}

function openEditor(query, trigger) {
  const url = editorUrl(query);
  document.getElementById('dnft-list-close')?.click();
  const details = document.getElementById('nft-panel');
  if (details?.open) details.close();
  if (closing || (panel.classList.contains('is-open') && frame.src !== 'about:blank' && frame.src !== url.href)) {
    pendingNavigation = { href: url.href, link: `${url.pathname}${url.search}`, trigger };
    if (!closing) requestFlush();
    return;
  }
  returnFocus = trigger;
  dedicatedLink.href = `${url.pathname}${url.search}`;
  if (frame.src !== url.href) frame.src = url.href;
  setOpen(true);
}

closeButton.addEventListener('click', () => {
  if (closing) return;
  if (frame.src === 'about:blank') { setOpen(false); return; }
  requestFlush();
});

document.addEventListener('click', event => {
  const catalog = event.target.closest('[data-catalog-recording-edit]');
  if (catalog) {
    const nftId = catalog.dataset.catalogRecordingEdit || '';
    if (!/^8453:0x[0-9a-f]{40}:\d{1,20}$/i.test(nftId)) return;
    event.preventDefault();
    openEditor([['catalog', nftId]], catalog);
    return;
  }
  const booking = event.target.closest('[data-recording-edit]');
  if (!booking) return;
  const bookingId = booking.dataset.recordingEdit || '';
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(bookingId)) return;
  event.preventDefault();
  openEditor([['booking', bookingId]], booking);
});

window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== frame.contentWindow ||
      event.data?.requestId !== pendingRequestId ||
      !['decentbusking:recording-draft-flushed', 'decentbusking:recording-draft-flush-failed'].includes(event.data?.type)) return;
  closeButton.disabled = false;
  clearTimeout(closeTimeout);
  pendingRequestId = '';
  if (event.data.type === 'decentbusking:recording-draft-flushed' && pendingNavigation) {
    const navigation = pendingNavigation;
    pendingNavigation = null;
    closing = false;
    returnFocus = navigation.trigger;
    dedicatedLink.href = navigation.link;
    frame.src = navigation.href;
    closeButton.focus();
    return;
  }
  if (event.data.type === 'decentbusking:recording-draft-flushed') setOpen(false);
  else {
    closing = false;
    closeButton.focus();
  }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && panel.classList.contains('is-open') && !closing) {
    event.preventDefault();
    closeButton.click();
  }
});
