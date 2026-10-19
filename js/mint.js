import { fetchNFTMetaById } from './space.js?v=20261019-paid-ad-return';
import { createBrowserIpfsUploader } from './ipfs-upload.js?v=20261015-mime-sniff';
import { submitMediaForApproval } from './mint-submission.js?v=20261017-mercury-release';
import { detectSubmissionMedia, mediaFilename, evenCreatorSplits, validateCreatorSplits } from './submission-media.mjs';

let pending = false;
let previewUrl = '';
let artworkPreviewUrl = '';
let mediaPreviewGeneration = 0;
let splits = [];
let returnFocus = null;

function fileCid(value) {
  const cid = String(value || '').trim().replace(/^ipfs:\/\//i, '');
  if (!cid || !/^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/.test(cid)) throw new Error('Enter a file CID or ipfs://CID, not a folder path or gateway URL');
  return cid;
}

async function inspectMedia({ file, cid, serviceUrl }) {
  if (file) {
    if (file.size > 50 * 1024 * 1024) throw new Error('Uploads are limited to 50 MB; use an already-pinned file CID instead');
    const prefix = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
    const tail = file.size > 65536 ? new Uint8Array(await file.slice(-65536).arrayBuffer()) : new Uint8Array();
    const bytes = new Uint8Array(prefix.length + tail.length);
    bytes.set(prefix);
    bytes.set(tail, prefix.length);
    const mediaType = detectSubmissionMedia(bytes, { filename: file.name, type: file.type });
    return { mediaType, filename: mediaFilename(mediaType, file.name) };
  }
  if (!serviceUrl) throw new Error('Media detection service is not configured');
  const response = await fetch(`${serviceUrl.replace(/\/$/, '')}/api/ipfs/media-type?${new URLSearchParams({ cid })}`, { signal: AbortSignal.timeout(35000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not detect the IPFS file format');
  const filename = mediaFilename(result.mediaType);
  return { mediaType: result.mediaType, filename };
}

function splitWallet() {
  return document.getElementById('mint-recipient').value.trim() || window._wallet?.address || '';
}

function renderSplits() {
  const container = document.getElementById('mint-splits');
  if (!container) return;
  container.replaceChildren();
  splits.forEach((entry, index) => {
    const row = document.createElement('div');
    row.className = 'mint-split-row';
    const walletLabel = document.createElement('label');
    walletLabel.textContent = index ? `Collaborator ${index}` : 'Artist';
    const wallet = document.createElement('input');
    wallet.type = 'text';
    wallet.value = index ? entry.wallet : splitWallet();
    wallet.placeholder = '0x… collaborator wallet';
    wallet.readOnly = index === 0;
    wallet.setAttribute('aria-label', index ? `Collaborator ${index} wallet` : 'Artist DJuke earning wallet');
    wallet.addEventListener('input', () => { entry.wallet = wallet.value.trim(); });
    walletLabel.append(wallet);
    const shareLabel = document.createElement('label');
    shareLabel.textContent = 'Share %';
    const share = document.createElement('input');
    share.type = 'number';
    share.min = '0.01';
    share.max = '100';
    share.step = '0.01';
    share.required = true;
    share.value = String(entry.shareBps / 100);
    share.setAttribute('aria-label', `${index ? `Collaborator ${index}` : 'Artist'} share percent`);
    share.addEventListener('input', () => {
      const text = share.value;
      entry.shareBps = /^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(text) ? Math.round(Number(text) * 100) : NaN;
      updateSplitTotal();
    });
    shareLabel.append(share);
    row.append(walletLabel, shareLabel);
    if (index) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove collaborator ${index}`);
      remove.addEventListener('click', () => { splits.splice(index, 1); equalizeSplits(); });
      row.append(remove);
    }
    container.append(row);
  });
  updateSplitTotal();
}

function updateSplitTotal() {
  const total = splits.reduce((sum, entry) => sum + entry.shareBps, 0);
  const output = document.getElementById('mint-split-total');
  if (output) {
    output.textContent = Number.isFinite(total) ? `${Number((total / 100).toFixed(2))}% total${total === 10000 ? ' ✓' : ' · needs 100%'}` : 'Enter valid percentages';
    output.classList.toggle('error', total !== 10000);
  }
  const add = document.getElementById('mint-add-owner');
  if (add) add.disabled = splits.length >= 10;
}

function equalizeSplits() {
  splits = evenCreatorSplits(splits.map((entry, index) => index ? entry.wallet : splitWallet()));
  renderSplits();
}

function setArtworkSource() {
  const cidMode = document.getElementById('mint-art-source-cid')?.checked;
  document.getElementById('mint-art-file-section').hidden = cidMode;
  document.getElementById('mint-art-cid-section').hidden = !cidMode;
}

async function updateMediaPreview() {
  const generation = ++mediaPreviewGeneration;
  const output = document.getElementById('mint-media-detected');
  const preview = document.getElementById('mint-media-preview');
  preview.replaceChildren();
  preview.hidden = true;
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = ''; }
  const cidMode = document.getElementById('mint-source-cid').checked;
  const file = cidMode ? null : document.getElementById('mint-file').files?.[0];
  const value = document.getElementById('mint-cid-input').value;
  if (!file && (!cidMode || !value.trim())) { output.textContent = 'Format is detected automatically.'; return; }
  output.textContent = 'Checking your media…';
  try {
    const cid = cidMode ? fileCid(value) : '';
    const { mediaType } = await inspectMedia({ file, cid, serviceUrl: window.DecentConfig?.ipfsUploadServiceUrl });
    if (generation !== mediaPreviewGeneration) return;
    output.textContent = `${mediaType.startsWith('video/') ? '🎬 Video' : '🎧 Audio'} · ${mediaType}${file ? ` · ${file.name} · ${(file.size / 1048576).toFixed(1)} MB` : ' · pinned on IPFS'}`;
    if (file) {
      previewUrl = URL.createObjectURL(file);
      const player = document.createElement(mediaType.startsWith('video/') ? 'video' : 'audio');
      player.src = previewUrl;
      player.controls = true;
      player.preload = 'metadata';
      player.setAttribute('aria-label', 'Preview your submission');
      preview.append(player);
      preview.hidden = false;
    }
  } catch (error) {
    if (generation !== mediaPreviewGeneration) return;
    output.textContent = error.message;
    console.warn('[mint] Media detection failed:', error.message);
  }
}

function fileSignature(file) {
  return file ? [file.name, file.size, file.lastModified || 0, file.type || ''].join('::') : '';
}

function uploadCache(input) {
  return input?.dataset || (input ? (input.__uploadCache || (input.__uploadCache = {})) : {});
}

function cachedUploadCid(input, file) {
  const signature = fileSignature(file);
  const cache = uploadCache(input);
  if (!signature || cache.uploadSignature !== signature || !cache.uploadCid) return '';
  return cache.uploadCid;
}

function rememberUploadCid(input, file, cid) {
  if (!file || !cid) return;
  const cache = uploadCache(input);
  cache.uploadSignature = fileSignature(file);
  cache.uploadCid = cid;
}

function progressReporter(prefix) {
  let lastPercent = -1;
  return ({ progress, loaded, total }) => {
    const percent = Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress * 100)))
      : (Number.isFinite(total) && total > 0 ? Math.max(0, Math.min(100, Math.round((loaded / total) * 100))) : -1);
    if (percent < 0 || percent === lastPercent) return;
    lastPercent = percent;
    setStatus(`${prefix} ${percent}%`);
  };
}

function setSource() {
  const cidMode = document.getElementById('mint-source-cid')?.checked;
  const file = document.getElementById('mint-file');
  file.disabled = cidMode;
  file.required = !cidMode;
  document.getElementById('mint-file-section').hidden = cidMode;
  document.getElementById('mint-cid-section').hidden = !cidMode;
  document.getElementById('mint-cid-input').required = cidMode;
}

export function openMintModal() {
  if (pending) return;
  const modal = document.getElementById('mint-modal');
  if (!modal) return;
  returnFocus = document.activeElement;
  document.getElementById('mint-form').reset();
  document.querySelectorAll('.mint-extras').forEach(details => { details.open = false; });
  document.getElementById('mint-parent-preview')?.classList.add('hidden');
  setStatus('');
  const params = new URLSearchParams(window.location.search);
  document.getElementById('mint-title').value = params.get('title') || '';
  document.getElementById('mint-recipient').value = params.get('recipient') || window._wallet?.address || '';
  if (params.get('ipfs')) {
    document.getElementById('mint-source-cid').checked = true;
    document.getElementById('mint-cid-input').value = params.get('ipfs').replace(/^ipfs:\/\//i, '');
  }
  splits = [{ wallet: splitWallet(), shareBps: 10000 }];
  renderSplits();
  setSource();
  setArtworkSource();
  updateMediaPreview();
  document.getElementById('mint-art-preview').hidden = true;
  document.getElementById('mint-art-name').textContent = 'No cover yet? It can be chosen during owner approval.';
  if (artworkPreviewUrl) { URL.revokeObjectURL(artworkPreviewUrl); artworkPreviewUrl = ''; }
  modal.classList.remove('hidden');
  document.getElementById('mint-modal-inner').scrollTop = 0;
  document.getElementById('mint-title').focus();
}

async function handleSubmission(event) {
  event.preventDefault();
  if (pending) return;
  const cfg = window.DecentConfig || {};
  const signer = window._wallet?.signer;
  const address = window._wallet?.address;
  const button = document.getElementById('mint-submit-btn');
  try {
    if (!signer || !address) throw new Error('Connect your artist wallet in the header first');
    const title = document.getElementById('mint-title').value.trim();
    const artist = document.getElementById('mint-artist').value.trim() || address;
    const recipient = document.getElementById('mint-recipient').value.trim() || address;
    const tipWallet = document.getElementById('mint-tip-wallet').value.trim() || recipient;
    const parentTokenId = Number(document.getElementById('mint-parent').value || 0);
    if (!title) throw new Error('Enter a track title');
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient) || !/^0x[0-9a-fA-F]{40}$/.test(tipWallet)) {
      throw new Error('Enter valid 0x artist and tip wallet addresses');
    }
    if (!Number.isSafeInteger(parentTokenId) || parentTokenId < 0) throw new Error('Enter a valid parent token ID');
    const creatorSplits = validateCreatorSplits(splits.length ? splits.map((entry, index) => ({ ...entry, wallet: index ? entry.wallet : recipient })) : undefined, recipient);
    const cidMode = document.getElementById('mint-source-cid').checked;
    const file = document.getElementById('mint-file').files?.[0];
    const artworkCidMode = document.getElementById('mint-art-source-cid')?.checked;
    const artwork = artworkCidMode ? null : document.getElementById('mint-image').files?.[0];
    let artworkCid = artworkCidMode ? fileCid(document.getElementById('mint-artwork-cid').value) : '';
    let ipfsCid = '';
    if (cidMode) {
      ipfsCid = fileCid(document.getElementById('mint-cid-input').value);
    } else {
      if (!file) throw new Error('Drop or choose an audio or MP4 video file');
    }
    if (artwork && (artwork.size > 10 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(artwork.type))) {
      throw new Error('Artwork must be PNG, JPEG, WebP, or GIF, up to 10 MB');
    }
    pending = true;
    button.disabled = true;
    document.querySelectorAll('#mint-form input, #mint-form button').forEach(control => { control.disabled = true; });
    setStatus('Detecting your media format…');
    const { mediaType, filename } = await inspectMedia({ file: cidMode ? null : file, cid: ipfsCid, serviceUrl: cfg.ipfsUploadServiceUrl });
    const upload = createBrowserIpfsUploader({ provider: cfg.ipfsUploadProvider || 'pinata',
      serviceUrl: cfg.ipfsUploadServiceUrl, ipfsApiUrl: cfg.ipfsApiUrl, signer, address,
      origin: window.location.origin, purpose: 'submission' });
    if (!cidMode) {
      const cachedCid = cachedUploadCid(document.getElementById('mint-file'), file);
      if (cachedCid) {
        ipfsCid = cachedCid;
        setStatus('Reusing the previously uploaded media CID...');
      } else {
        setStatus('Uploading media to IPFS...');
        ipfsCid = (await upload(new File([file], filename, { type: mediaType }), {
          onProgress: progressReporter('Uploading media to IPFS…'),
        })).replace('ipfs://', '');
        rememberUploadCid(document.getElementById('mint-file'), file, ipfsCid);
      }
      document.getElementById('mint-cid-input').value = ipfsCid;
    }
    if (artwork) {
      const cachedArtworkCid = cachedUploadCid(document.getElementById('mint-image'), artwork);
      if (cachedArtworkCid) {
        artworkCid = cachedArtworkCid;
      } else {
        setStatus('Uploading artwork to IPFS...');
        artworkCid = (await upload(artwork, {
          onProgress: progressReporter('Uploading artwork to IPFS…'),
        })).replace('ipfs://', '');
        rememberUploadCid(document.getElementById('mint-image'), artwork, artworkCid);
      }
    }
    setStatus('Sign your submission for owner approval...');
    const result = await submitMediaForApproval({ serviceUrl: cfg.ipfsUploadServiceUrl, signer, address,
      origin: window.location.origin,
      media: { title, artist, recipient, tipWallet, parentTokenId, filename, mediaType, ipfsCid, artworkCid,
        isDevertAd: document.getElementById('mint-devert')?.checked === true, creatorSplits } });
    setStatus(`${result.status === 'minted' ? 'Already minted' : 'Queued for owner approval'}. IPFS CID: ${ipfsCid}${document.getElementById('mint-devert')?.checked ? ' · Advertisement: book airtime separately in DVert after approval.' : ''}`);
  } catch (error) {
    setStatus(error.message || 'Submission failed', true);
  } finally {
    pending = false;
    button.disabled = false;
    document.querySelectorAll('#mint-form input, #mint-form button').forEach(control => { control.disabled = false; });
    setSource();
    updateSplitTotal();
  }
}

function setStatus(message, error = false) {
  const status = document.getElementById('mint-status');
  status.textContent = message;
  status.classList.toggle('error', error);
}

async function updateParentPreview(value) {
  const preview = document.getElementById('mint-parent-preview');
  const title = document.getElementById('mint-parent-preview-title');
  const artist = document.getElementById('mint-parent-preview-artist');
  const parentTokenId = Number(value);
  if (!Number.isSafeInteger(parentTokenId) || parentTokenId <= 0) {
    preview.classList.add('hidden');
    return;
  }
  preview.classList.remove('hidden');
  title.textContent = 'Loading...';
  artist.textContent = '';
  try {
    const meta = await fetchNFTMetaById(parentTokenId);
    title.textContent = meta?.name || `Token #${parentTokenId}`;
    artist.textContent = meta?.artist || meta?.creator || '';
  } catch {
    title.textContent = 'Could not load parent token';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const modal = document.getElementById('mint-modal');
  document.getElementById('mint-form')?.addEventListener('submit', handleSubmission);
  const close = () => {
    if (pending) return;
    modal.classList.add('hidden');
    document.querySelector('#mint-media-preview audio, #mint-media-preview video')?.pause();
    mediaPreviewGeneration++;
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = ''; }
    if (artworkPreviewUrl) { URL.revokeObjectURL(artworkPreviewUrl); artworkPreviewUrl = ''; }
    returnFocus?.focus();
  };
  document.getElementById('mint-cancel-btn')?.addEventListener('click', close);
  modal?.addEventListener('click', event => { if (event.target === modal) close(); });
  document.addEventListener('keydown', event => {
    if (modal.classList.contains('hidden') || document.getElementById('submission-policy-dialog')?.open) return;
    if (event.key === 'Escape') close();
    if (event.key === 'Tab') {
      const focusable = [...modal.querySelectorAll('input:not(:disabled), button:not(:disabled), summary, audio[controls], video[controls]')]
        .filter(node => node.getClientRects().length);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  document.addEventListener('wallet-connected', () => { if (!pending && !modal.classList.contains('hidden')) renderSplits(); });
  document.querySelectorAll('[name="mint-source"]').forEach(input => input.addEventListener('change', () => { setSource(); updateMediaPreview(); }));
  document.querySelectorAll('[name="mint-art-source"]').forEach(input => input.addEventListener('change', setArtworkSource));
  document.getElementById('mint-file')?.addEventListener('change', updateMediaPreview);
  let cidTimer;
  document.getElementById('mint-cid-input')?.addEventListener('input', () => {
    mediaPreviewGeneration++;
    clearTimeout(cidTimer);
    cidTimer = setTimeout(updateMediaPreview, 600);
  });
  document.getElementById('mint-image')?.addEventListener('change', () => {
    const file = document.getElementById('mint-image').files?.[0];
    const image = document.getElementById('mint-art-preview');
    if (artworkPreviewUrl) URL.revokeObjectURL(artworkPreviewUrl);
    image.hidden = true;
    if (file) {
      if (file.size > 10485760 || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
        document.getElementById('mint-art-name').textContent = 'Choose PNG, JPEG, WebP or GIF, up to 10 MB.';
        return;
      }
      artworkPreviewUrl = URL.createObjectURL(file);
      image.src = artworkPreviewUrl;
      image.hidden = false;
    }
    document.getElementById('mint-art-name').textContent = file?.name || 'No cover yet? It can be chosen during owner approval.';
  });
  document.getElementById('mint-recipient')?.addEventListener('input', renderSplits);
  document.getElementById('mint-add-owner')?.addEventListener('click', () => {
    if (splits.length >= 10) return;
    splits.push({ wallet: '', shareBps: 0 });
    equalizeSplits();
  });
  document.getElementById('mint-even-split')?.addEventListener('click', equalizeSplits);
  document.querySelectorAll('[data-drop-input]').forEach(zone => {
    zone.addEventListener('dragover', event => { event.preventDefault(); if (!pending) zone.classList.add('is-dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-dragover'));
    zone.addEventListener('drop', event => {
      event.preventDefault();
      zone.classList.remove('is-dragover');
      if (pending) return;
      if (event.dataTransfer.files.length !== 1) { setStatus('Drop one file at a time in each slot.', true); return; }
      const input = document.getElementById(zone.dataset.dropInput);
      input.files = event.dataTransfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
  let previewTimer;
  document.getElementById('mint-parent')?.addEventListener('input', event => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => updateParentPreview(event.target.value), 600);
  });
  const params = new URLSearchParams(window.location.search);
  if (params.get('ipfs') || params.get('title')) openMintModal();
});