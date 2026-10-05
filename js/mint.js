import { fetchNFTMetaById } from './space.js?v=20261005-mp4';
import { createBrowserIpfsUploader } from './ipfs-upload.js?v=20261005-mp4';
import { submitMediaForApproval } from './mint-submission.js';

const MEDIA_TYPES = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
  flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/ogg', weba: 'audio/webm', mp4: 'video/mp4',
};
let pending = false;

function setSource() {
  const cidMode = document.getElementById('mint-source-cid')?.checked;
  const file = document.getElementById('mint-file');
  file.disabled = cidMode;
  file.required = !cidMode;
  document.getElementById('mint-file-section').hidden = cidMode;
  document.getElementById('mint-cid-section').hidden = !cidMode;
  document.getElementById('mint-cid-input').required = cidMode;
  document.getElementById('mint-media-type').disabled = !cidMode;
}

export function openMintModal() {
  if (pending) return;
  const modal = document.getElementById('mint-modal');
  if (!modal) return;
  document.getElementById('mint-form').reset();
  document.getElementById('mint-parent-preview')?.classList.add('hidden');
  setStatus('');
  const params = new URLSearchParams(window.location.search);
  document.getElementById('mint-title').value = params.get('title') || '';
  document.getElementById('mint-recipient').value = params.get('recipient') || window._wallet?.address || '';
  if (params.get('ipfs')) {
    document.getElementById('mint-source-cid').checked = true;
    document.getElementById('mint-cid-input').value = params.get('ipfs').replace(/^ipfs:\/\//i, '');
  }
  if (params.get('type') === 'video/mp4') document.getElementById('mint-media-type').value = 'video/mp4';
  setSource();
  modal.classList.remove('hidden');
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
    const cidMode = document.getElementById('mint-source-cid').checked;
    const file = document.getElementById('mint-file').files?.[0];
    const artwork = document.getElementById('mint-image').files?.[0];
    let mediaType = document.getElementById('mint-media-type').value;
    let filename;
    let ipfsCid = document.getElementById('mint-cid-input').value.trim().replace(/^ipfs:\/\//i, '');
    if (cidMode) {
      if (!ipfsCid || /[\/\s]/.test(ipfsCid)) throw new Error('Enter a file CID, not a directory path or gateway URL');
      const extension = Object.keys(MEDIA_TYPES).find(key => MEDIA_TYPES[key] === mediaType);
      filename = `track.${extension}`;
    } else {
      if (!file) throw new Error('Select an audio or MP4 file');
      mediaType = MEDIA_TYPES[file.name.split('.').pop().toLowerCase()];
      if (!mediaType) throw new Error('Choose a supported audio format or MP4');
      if (file.size > 50 * 1024 * 1024) throw new Error('Uploads are limited to 50 MB; use an already-pinned file CID instead');
      filename = file.name;
    }
    if (artwork && (artwork.size > 10 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(artwork.type))) {
      throw new Error('Artwork must be PNG, JPEG, WebP, or GIF, up to 10 MB');
    }
    pending = true;
    button.disabled = true;
    const upload = createBrowserIpfsUploader({ provider: cfg.ipfsUploadProvider || 'pinata',
      serviceUrl: cfg.ipfsUploadServiceUrl, ipfsApiUrl: cfg.ipfsApiUrl, signer, address,
      origin: window.location.origin, purpose: 'submission' });
    if (!cidMode) {
      setStatus('Uploading media to IPFS...');
      ipfsCid = (await upload(new File([file], file.name, { type: mediaType }))).replace('ipfs://', '');
      document.getElementById('mint-cid-input').value = ipfsCid;
    }
    let artworkCid = '';
    if (artwork) {
      setStatus('Uploading artwork to IPFS...');
      artworkCid = (await upload(artwork)).replace('ipfs://', '');
    }
    setStatus('Sign your submission for owner approval...');
    const result = await submitMediaForApproval({ serviceUrl: cfg.ipfsUploadServiceUrl, signer, address,
      origin: window.location.origin,
      media: { title, artist, recipient, tipWallet, parentTokenId, filename, mediaType, ipfsCid, artworkCid } });
    setStatus(`${result.status === 'minted' ? 'Already minted' : 'Queued for owner approval'}. IPFS CID: ${ipfsCid}`);
  } catch (error) {
    setStatus(error.message || 'Submission failed', true);
  } finally {
    pending = false;
    button.disabled = false;
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
  document.getElementById('mint-cancel-btn')?.addEventListener('click', () => modal.classList.add('hidden'));
  modal?.addEventListener('click', event => { if (event.target === modal) modal.classList.add('hidden'); });
  document.querySelectorAll('[name="mint-source"]').forEach(input => input.addEventListener('change', setSource));
  document.getElementById('mint-file')?.addEventListener('change', event => {
    const file = event.target.files?.[0];
    if (file) document.getElementById('mint-media-type').value = MEDIA_TYPES[file.name.split('.').pop().toLowerCase()] || 'audio/mpeg';
  });
  let previewTimer;
  document.getElementById('mint-parent')?.addEventListener('input', event => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => updateParentPreview(event.target.value), 600);
  });
  const params = new URLSearchParams(window.location.search);
  if (params.get('ipfs') || params.get('title')) openMintModal();
});