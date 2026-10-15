import { createBrowserIpfsUploader } from './ipfs-upload.js?v=20261015-mime-sniff';
import { canEditArtwork, extractArtworkPreviewUri, submitArtworkUpdateRequest, validateArtworkFile } from './artwork-update.mjs';

let _dialog;
let _current;
let _fileUrl = '';

function _status(message, state = '') {
  const el = _dialog?.querySelector('[data-artwork-status]');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('error', state === true || state === 'error');
  el.classList.toggle('success', state === 'success');
}

function _setBusy(busy) {
  const save = _dialog?.querySelector('[data-artwork-save]');
  const file = _dialog?.querySelector('[data-artwork-file]');
  _dialog?.classList.toggle('is-busy', busy);
  if (save) save.disabled = busy || !file?.files?.length || _dialog.classList.contains('is-done');
  if (file) file.disabled = busy;
}

function _setFileName(file) {
  const name = _dialog?.querySelector('[data-artwork-file-name]');
  if (name) name.textContent = file ? file.name : 'PNG, JPG, WebP or GIF';
}

function _previewCurrent(nft) {
  const image = _dialog?.querySelector('[data-artwork-current-preview]');
  if (!image) return;
  image.src = extractArtworkPreviewUri(nft, window.DecentConfig?.ipfsGateway || 'https://gateway.pinata.cloud/ipfs/');
}

function _previewNew(file) {
  const image = _dialog?.querySelector('[data-artwork-new-preview]');
  if (!image) return;
  if (_fileUrl) URL.revokeObjectURL(_fileUrl);
  _fileUrl = file ? URL.createObjectURL(file) : '';
  if (file) image.src = _fileUrl;
  else image.removeAttribute('src');
  image.hidden = !file;
  const placeholder = _dialog?.querySelector('[data-artwork-new-placeholder]');
  if (placeholder) placeholder.hidden = Boolean(file);
  _dialog?.querySelector('.artwork-editor-frame.is-new')?.classList.toggle('has-image', Boolean(file));
}

function _close() {
  if (_fileUrl) URL.revokeObjectURL(_fileUrl);
  _fileUrl = '';
  _current = null;
  _dialog?.close();
}

async function _save() {
  if (!_current) return;
  const cfg = window.DecentConfig || {};
  const signer = window._wallet?.signer;
  const address = window._wallet?.address;
  if (!canEditArtwork(_current, address)) throw new Error('Connect the creator wallet to edit this artwork');
  const file = _dialog?.querySelector('[data-artwork-file]')?.files?.[0];
  validateArtworkFile(file);
  const uploader = createBrowserIpfsUploader({
    provider: cfg.ipfsUploadProvider || 'pinata',
    serviceUrl: cfg.ipfsUploadServiceUrl,
    ipfsApiUrl: cfg.ipfsApiUrl,
    signer,
    address,
    origin: window.location.origin,
    purpose: 'submission',
  });
  _status('Uploading artwork…');
  const artworkUri = await uploader(file, { onProgress: progress => {
    _status(`Uploading artwork… ${Math.round(progress.progress * 100)}%`);
  }});
  _status('Submitting request for review…');
  const response = await submitArtworkUpdateRequest({
    serviceUrl: cfg.ipfsUploadServiceUrl,
    signer,
    address,
    origin: window.location.origin,
    request: {
      chainId: _current.chainId || cfg.chainId || 8453,
      contractAddress: _current.contractAddress || cfg.contractAddress,
      tokenId: _current.tokenId,
      artworkCid: artworkUri,
    },
  });
  _status('✅ Submitted! An admin will approve it from the mint queue.', 'success');
  _dialog?.classList.add('is-done');
  document.dispatchEvent(new CustomEvent('artwork-update-requested', { detail: { nft: _current, request: response.request } }));
}

function _open(detail = {}) {
  const nft = detail.nft || detail;
  if (!nft || !canEditArtwork(nft, window._wallet?.address)) return;
  _current = nft;
  const file = _dialog?.querySelector('[data-artwork-file]');
  if (file) file.value = '';
  _dialog?.classList.remove('is-done', 'is-busy');
  _previewCurrent(nft);
  _previewNew(null);
  _setFileName(null);
  _setBusy(false);
  _status('Choose a new image to continue.');
  _dialog?.showModal();
}

function initArtworkEditor() {
  _dialog = document.getElementById('nft-artwork-editor');
  if (!_dialog) return;
  _dialog.querySelector('[data-artwork-editor-close]')?.addEventListener('click', _close);
  _dialog.querySelector('[data-artwork-save]')?.addEventListener('click', () => {
    _setBusy(true);
    _save()
      .catch(error => _status(error.message, 'error'))
      .finally(() => _setBusy(false));
  });
  _dialog.querySelector('[data-artwork-file]')?.addEventListener('change', event => {
    const file = event.target.files?.[0];
    _dialog.classList.remove('is-done');
    _setFileName(file);
    _setBusy(false);
    if (!file) {
      _previewNew(null);
      _status('Choose a new image to continue.');
      return;
    }
    try {
      validateArtworkFile(file);
      _previewNew(file);
      _status('Looking good! Sign & submit when ready.');
    } catch (error) {
      _previewNew(null);
      _status(error.message, 'error');
    }
  });
  _dialog.addEventListener('close', () => {
    if (_fileUrl) URL.revokeObjectURL(_fileUrl);
    _fileUrl = '';
  });
  _dialog.addEventListener('cancel', event => {
    event.preventDefault();
    _close();
  });
  document.addEventListener('open-artwork-editor', event => _open(event.detail));
}

document.addEventListener('DOMContentLoaded', initArtworkEditor);
