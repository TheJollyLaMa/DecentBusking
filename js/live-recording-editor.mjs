import { roomRequest } from './live-audio-client.mjs?v=20261117-unsigned-studio';
import { buildIpfsGatewayUrls } from './ipfs-gateway.js';
import { catalogRecordingReleaseApprovalMessage, recordingReleaseApprovalMessage,
  moveRecordingBoundary, recordingBoundaryRange, validateCatalogRecordingDraft, validateRecordingDraft } from './live-recording-edit.mjs?v=20261116-studio-polish';

const byId = id => document.getElementById(id);
const params = new URL(location.href).searchParams;
const bookingId = params.get('booking') || '';
const catalogNftId = params.get('catalog') || '';
const catalogMode = !!catalogNftId;
const embedded = window.parent !== window;
const serviceUrl = String(window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
const status = byId('recording-edit-status');
const workspace = byId('recording-edit-workspace');
const audio = byId('recording-edit-audio');
const canvas = byId('recording-edit-waveform');
let signer, wallet = '', state, draft, busy = false, generation = 0, previewEnd = 0;
let dirty = false, saveTimer, pendingPublication;
let mediaPending = false, mediaTimer, activeDrag = null;

const report = message => {
  status.textContent = message;
  if (busy) byId('recording-edit-loading-message').textContent = message;
};
if (embedded) {
  byId('recording-edit-back').hidden = true;
  document.body.classList.add('recording-edit-embedded');
}
if (!catalogMode) {
  status.textContent = 'Connect the booked performer wallet to preview and edit without signing.';
  byId('recording-edit-connect').textContent = 'Connect booked performer wallet';
  byId('recording-edit-intro').textContent = 'Preview the preserved original already covered by your recording consent. Keep it as one release, divide it into songs, or decide later. Each release needs your explicit approval before it enters the admin mint queue.';
}
if (catalogMode) {
  byId('recording-edit-heading').textContent = 'Catalog recording editor';
  byId('recording-edit-intro').textContent = 'Preview an existing artist-attributed catalog recording, make named cuts, or decide later. The source NFT and public IPFS audio remain unchanged. Each full-set or cut release is a separate approval; minting still requires independent admin review.';
  byId('recording-edit-connect').textContent = 'Connect artist wallet';
}

function markDraftChanged() {
  dirty = true;
  pendingPublication = null;
  clearTimeout(saveTimer);
  saveTimer = null;
  if (activeDrag) return;
  saveTimer = setTimeout(() => {
    void saveDraft({ quiet: true }).catch(error => report(error.message || 'Draft autosave failed; keep this editor open and retry.'));
  }, 800);
}
const cidUrl = cid => {
  const gateway = String(window.DecentConfig?.ipfsGateway || 'https://gateway.pinata.cloud').replace(/\/$/, '');
  const base = new URL(gateway);
  if (base.protocol !== 'https:' || base.username || base.password || base.hash ||
      !/^[a-zA-Z0-9]{20,120}$/.test(cid || '')) throw new Error('Recording preview gateway is unavailable');
  return buildIpfsGatewayUrls(`ipfs://${cid}`, base.toString())[0];
};
const seconds = samples => samples / state.sampleRate;
const timeText = samples => `${seconds(samples).toFixed(3)}s`;

function drawWaveform() {
  if (!state || !canvas) return;
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  const context = canvas.getContext('2d');
  if (!context) return;
  context.scale(ratio, ratio);
  const width = rect.width, height = rect.height, center = height / 2;
  context.clearRect(0, 0, width, height);
  context.strokeStyle = '#514961'; context.lineWidth = 1;
  context.beginPath(); context.moveTo(0, center); context.lineTo(width, center); context.stroke();
  const total = state.sourceSamples;
  for (const point of state.waveform || []) {
    const x = point.startSample / total * width;
    const next = point.endSample / total * width;
    const barHeight = Math.max(2, (point.max - point.min) * height * .48);
    context.fillStyle = '#bda2ea';
    context.fillRect(x, center - point.max * height * .48, Math.max(1, next - x), barHeight);
  }
  for (const song of draft?.songs || []) {
    const start = song.startSample / total * width, end = song.endSample / total * width;
    context.fillStyle = 'rgb(169 226 180 / 10%)';
    context.fillRect(start, 0, Math.max(0, end - start), height);
    context.strokeStyle = '#b6e0bf';
    for (const x of [start, end]) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke(); }
  }
  positionHandles();
}

function positionHandles() {
  for (const handle of byId('recording-edit-handles').children) {
    const index = Number(handle.dataset.index), key = handle.dataset.key;
    const value = draft.songs[index][key];
    handle.style.left = `${100 * value / state.sourceSamples}%`;
    handle.setAttribute('aria-valuenow', String(value));
    handle.setAttribute('aria-valuetext', `${seconds(value).toFixed(3)} seconds`);
    try {
      const { min, max } = recordingBoundaryRange(draft, state.sourceSamples, index, key);
      handle.setAttribute('aria-valuemin', String(min));
      handle.setAttribute('aria-valuemax', String(max));
    } catch (error) { report(error.message); }
  }
  for (const input of byId('recording-edit-songs').querySelectorAll('[data-time-boundary]')) {
    input.value = seconds(draft.songs[Number(input.dataset.songIndex)][input.dataset.timeBoundary]).toFixed(3);
  }
  draft.songs.forEach((song, index) => {
    const help = byId(`recording-edit-track-${index + 1}-boundary-help`);
    if (help) help.textContent = `Exact source samples: ${song.startSample}–${song.endSample}. Preview stops at this song’s end.`;
  });
}

function applyBoundary(index, key, sample) {
  const next = moveRecordingBoundary(draft, state.sourceSamples, index, key, sample);
  next.songs.forEach((song, offset) => Object.assign(draft.songs[offset], song));
  drawWaveform();
}

function renderBoundaryHandles() {
  const container = byId('recording-edit-handles');
  container.replaceChildren();
  draft.songs.forEach((song, index) => {
    const keys = index > 0 && draft.songs[index - 1].endSample === song.startSample
      ? ['endSample'] : ['startSample', 'endSample'];
    for (const key of keys) {
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'recording-cut-handle';
      handle.dataset.index = String(index);
      handle.dataset.key = key;
      handle.setAttribute('role', 'slider');
      handle.setAttribute('aria-orientation', 'horizontal');
      const paired = key === 'endSample' && draft.songs[index + 1]?.startSample === song.endSample;
      const label = paired ? `Cut between songs ${index + 1} and ${index + 2}`
        : `Song ${index + 1} ${key === 'startSample' ? 'start' : 'end'}`;
      handle.setAttribute('aria-label', label);
      const marker = document.createElement('span');
      marker.textContent = paired ? `✂ ${index + 1}|${index + 2}` : `${index + 1} ${key === 'startSample' ? 'in' : 'out'}`;
      handle.append(marker);
      handle.addEventListener('keydown', event => {
        if (busy || mediaPending || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        try {
          const range = recordingBoundaryRange(draft, state.sourceSamples, index, key);
          const step = state.sampleRate * (event.shiftKey ? 1 : .1);
          const value = event.key === 'Home' ? range.min : event.key === 'End' ? range.max
            : draft.songs[index][key] + (event.key === 'ArrowLeft' ? -step : step);
          applyBoundary(index, key, value);
          markDraftChanged();
        } catch (error) { report(error.message); }
      });
      handle.addEventListener('pointerdown', event => {
        if (busy || mediaPending || activeDrag || event.button !== 0) return;
        event.preventDefault();
        activeDrag = { pointerId: event.pointerId, boundaries: draft.songs.map(track => ({
          startSample: track.startSample, endSample: track.endSample,
        })) };
        editVersion++;
        clearTimeout(saveTimer);
        saveTimer = null;
        handle.setPointerCapture(event.pointerId);
        handle.classList.add('is-dragging');
      });
      handle.addEventListener('pointermove', event => {
        if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
        try {
          const rect = canvas.getBoundingClientRect();
          if (rect.width <= 0) throw Error('The waveform is not visible; reopen the studio');
          applyBoundary(index, key, (event.clientX - rect.left) / rect.width * state.sourceSamples);
          dirty = true;
          editVersion++;
        } catch (error) { report(error.message); }
      });
      const finish = event => {
        if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
        if (event.type === 'pointercancel') activeDrag.boundaries.forEach((boundary, offset) =>
          Object.assign(draft.songs[offset], boundary));
        activeDrag = null;
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        handle.classList.remove('is-dragging');
        markDraftChanged();
        drawWaveform();
      };
      handle.addEventListener('pointerup', finish);
      handle.addEventListener('pointercancel', finish);
      handle.addEventListener('lostpointercapture', event => finish({ type: 'pointercancel', pointerId: event.pointerId }));
      container.append(handle);
    }
  });
  positionHandles();
}

function songInput(song, index, key, labelText) {
  const label = document.createElement('label');
  label.append(document.createTextNode(labelText));
  const input = document.createElement('input');
  input.type = key === 'title' ? 'text' : 'number';
  input.required = true;
  if (key === 'title') {
    input.maxLength = 100;
    input.value = song.title;
    input.autocomplete = 'off';
    input.addEventListener('input', () => { song.title = input.value; markDraftChanged(); drawWaveform(); });
  } else {
    input.dataset.songIndex = String(index);
    input.dataset.timeBoundary = key;
    input.min = '0'; input.max = seconds(state.sourceSamples).toFixed(3); input.step = '0.001';
    input.value = seconds(song[key]).toFixed(3);
    input.setAttribute('aria-describedby', `recording-edit-track-${index + 1}-boundary-help`);
    input.addEventListener('change', () => {
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < 0) { report('Enter a non-negative time in seconds.'); return; }
      song[key] = Math.round(value * state.sampleRate);
      input.value = seconds(song[key]).toFixed(3);
      markDraftChanged();
      drawWaveform();
      renderBoundaryHandles();
    });
  }
  label.append(input);
  return label;
}

function renderSongs() {
  const container = byId('recording-edit-songs');
  container.replaceChildren();
  (draft?.songs || []).forEach((song, index) => {
    const section = document.createElement('section');
    section.className = 'recording-edit-song';
    const heading = document.createElement('h3');
    heading.textContent = `Song ${index + 1}`;
    section.append(heading);
    const grid = document.createElement('div');
    grid.className = 'recording-edit-song-grid';
    grid.append(songInput(song, index, 'title', 'Song title'),
      songInput(song, index, 'startSample', 'Start · seconds'),
      songInput(song, index, 'endSample', 'End · seconds'));
    section.append(grid);
    const help = document.createElement('p');
    help.id = `recording-edit-track-${index + 1}-boundary-help`;
    help.className = 'recording-edit-muted';
    help.textContent = `Exact source samples: ${song.startSample}–${song.endSample}. Preview uses the preserved full-set audio and stops at this song’s end.`;
    section.append(help);
    const preview = document.createElement('button');
    preview.type = 'button'; preview.textContent = 'Preview this song';
    preview.addEventListener('click', async () => {
      try {
        previewEnd = seconds(song.endSample);
        audio.currentTime = seconds(song.startSample);
        await audio.play();
        report(`Previewing ${song.title} · ${timeText(song.startSample)}–${timeText(song.endSample)}.`);
      } catch (error) { report(`Preview unavailable: ${error.message}`); }
    });
    section.append(preview);
    if (draft.songs.length > 1) {
      const remove = document.createElement('button');
      remove.type = 'button'; remove.textContent = `Remove song ${index + 1}`;
      remove.addEventListener('click', () => { draft.songs.splice(index, 1); markDraftChanged(); renderSongs(); drawWaveform(); });
      section.append(remove);
    }
    container.append(section);
  });
  renderBoundaryHandles();
  drawWaveform();
}

function renderReleases() {
  const list = byId('recording-edit-releases');
  list.replaceChildren();
  if (!state.releases.length) {
    const item = document.createElement('li');
    item.textContent = state.previewOnly
      ? 'Unsigned preview does not load previous private drafts or release history. Final confirmation returns the release journal.'
      : 'No release has been approved or queued.';
    list.append(item);
    return;
  }
  for (const release of state.releases) {
    const item = document.createElement('li');
    const stateText = release.status === 'minted' ? 'Mint verified'
      : release.status === 'queued' ? 'Waiting for independent admin mint approval'
        : release.status === 'failed' ? `Recoverable export/queue error: ${release.error || 'retry after checking the journal'}`
          : `Export ${release.status}`;
    item.textContent = `${release.choice === 'full' ? 'Full set' : `Song ${release.trackNumber}`} · ${release.title} · ${stateText} · ${timeText(release.durationSamples)} · CID ${release.cid || 'not ready'}${release.parentReleaseId ? ` · linked to release ${release.parentReleaseId.slice(0, 12)}` : ''}`;
    list.append(item);
  }
}

function renderState(next) {
  state = next;
  if (!state?.available) {
    workspace.hidden = true;
    report(state?.error || 'No finalized, consented recording is available for this booking. Recording capture, upload, or consent may have been canceled or deferred.');
    return;
  }
  draft = structuredClone(state.draft);
  dirty = false;
  clearTimeout(saveTimer);
  workspace.hidden = false;
  byId('recording-edit-title').textContent = catalogMode
    ? 'Original catalog recording preview'
    : state.incomplete ? 'Original recording preview · partial capture' : 'Original recording preview';
  byId('recording-edit-facts').textContent = `${state.durationSeconds.toFixed(3)}s · ${state.sourceSamples.toLocaleString()} mono samples at ${state.sampleRate} Hz · source CID ${state.sourceCid}.${state.catalogSource ? ` · NFT ${state.catalogSource.nftId}` : ''}`;
  byId('recording-edit-rights').textContent = catalogMode
    ? 'Only the credited artist can confirm publication. Preview and local editing need no signature. The original NFT and audio remain unchanged; full-set and cut releases need separate final approvals and independent admin mint review. No collaborator split is inferred.'
    : state.incomplete
    ? 'This capture is marked partial/interrupted. The original source has already been stored on public IPFS under your recording consent; it remains unchanged. Every release approval signature states that this capture is incomplete.'
    : 'The original recording and its source CIDs remain unchanged. After minting, edits are linked new releases—not changes to an existing token. The booked performer wallet remains the artist, royalty receiver and tip wallet; no collaborator split is inferred.';
  byId('recording-edit-album-title').value = draft.albumTitle;
  byId('recording-edit-album-title').oninput = () => {
    draft.albumTitle = byId('recording-edit-album-title').value;
    markDraftChanged();
    drawWaveform();
  };
  const preview = cidUrl(state.sourceCid);
  if (audio.src !== preview) {
    setMediaPending(true);
    audio.src = preview;
  }
  byId('recording-edit-waveform-note').textContent = state.waveform?.length
    ? 'Drag the cut lines, or focus a line and use arrow keys (Shift for one-second steps). The start/end fields stay synchronized to exact 48 kHz samples.'
    : 'Waveform samples are unavailable for this older capture; use the accessible time fields and original audio preview.';
  byId('recording-edit-add-song').textContent = catalogMode ? 'Add cut' : 'Add song';
  byId('recording-edit-add-song').disabled = draft.songs.length >= (catalogMode ? 4 : 50);
  byId('recording-edit-split').textContent = catalogMode
    ? 'Approve 3–4 named cuts for mint review' : 'Approve split songs for mint review';
  renderSongs();
  renderReleases();
  byId('recording-edit-save').textContent = 'Save draft on this device';
  report(state.previewOnly ? 'Original loaded. Preview and edit without signing. Drafts stay on this device; only final publication confirmation asks for a signature.'
    : state.decision === 'deferred'
    ? 'Your last choice was “decide later.” No release is submitted until you approve it here.'
    : 'Recording loaded from the durable journal. The original audio is public on IPFS under your recording consent; no new song export or mint request is created until you approve a release.');
}

function setBusy(value) {
  busy = value;
  workspace.inert = value || mediaPending;
  byId('recording-edit-loading').hidden = !value && !mediaPending;
  workspace.setAttribute('aria-busy', String(value || mediaPending));
  if (!value && mediaPending) byId('recording-edit-loading-message').textContent = 'Loading the original audio preview…';
  for (const id of ['recording-edit-connect', 'recording-edit-add-song', 'recording-edit-save',
    'recording-edit-defer', 'recording-edit-full', 'recording-edit-split']) byId(id).disabled = value;
}

function setMediaPending(value) {
  mediaPending = value;
  clearTimeout(mediaTimer);
  if (value) mediaTimer = setTimeout(() => {
    byId('recording-edit-loading-message').textContent = 'The audio preview is still loading. You can retry without changing your draft.';
    byId('recording-edit-connect').textContent = 'Retry audio preview';
    byId('recording-edit-connect').hidden = false;
  }, 60000);
  else if (embedded) byId('recording-edit-connect').hidden = true;
  setBusy(busy);
}

async function connect() {
  if ((!catalogMode && !bookingId) || !serviceUrl) throw new Error('The recording source or live recording service URL is missing.');
  if (catalogMode && !/^8453:0x[0-9a-f]{40}:\d{1,20}$/i.test(catalogNftId)) {
    throw new Error('This catalog item has an invalid NFT identity. Open it again from the verified archive.');
  }
  const generationAtStart = ++generation;
  if (embedded) {
    signer = window.parent._wallet?.signer;
    if (!signer || !window.parent._wallet?.address) throw new Error('Connect your artist wallet in the page header.');
  } else {
    if (!window.ethereum || !window.ethers) throw new Error('Install or unlock a wallet to continue.');
    const provider = new window.ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
  }
  wallet = (await signer.getAddress()).toLowerCase();
  if (generation !== generationAtStart) throw new Error('Wallet changed; select the recording again.');
  report('Loading the original recording and waveform. No signature is needed to edit…');
  const preview = await roomRequest(serviceUrl, 'recording-preview',
    { ...(catalogMode ? { nftId: catalogNftId } : { bookingId }), wallet });
  if (generation !== generationAtStart) throw new Error('Wallet changed; select the recording again.');
  if (!preview.available || preview.wallet?.toLowerCase() !== wallet || !preview.previewOnly ||
      !Number.isSafeInteger(preview.journalRevision) || preview.journalRevision < 0) {
    throw new Error('The original recording preview is unavailable. Retry without signing.');
  }
  const key = draftStorageKey(preview);
  let saved;
  try { saved = window.localStorage.getItem(key); }
  catch { throw new Error('This browser blocked local draft storage. Allow site storage and retry; no signature or publication was requested.'); }
  if (saved) {
    const stored = JSON.parse(saved);
    if (stored.schema !== 1) throw new Error('This saved draft uses an unsupported format. Keep it for recovery before starting a new draft.');
    preview.draft = (catalogMode ? validateCatalogRecordingDraft : validateRecordingDraft)(stored.draft, preview.sourceSamples);
  }
  renderState(preview);
}

function draftStorageKey(recording = state) {
  return `decentbusking:recording-draft:v1:${wallet}:${catalogNftId || bookingId}:${recording.sourceCid}`;
}

async function saveDraft({ quiet = false } = {}) {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!dirty) return state;
  if (!signer || !state?.available) throw new Error('Reconnect the header wallet before saving this draft.');
  const next = (catalogMode ? validateCatalogRecordingDraft : validateRecordingDraft)(
    { ...structuredClone(draft), revision: state.draft.revision + 1 }, state.sourceSamples);
  try { window.localStorage.setItem(draftStorageKey(), JSON.stringify({ schema: 1, draft: next })); }
  catch { throw new Error('This draft could not be saved on this device. Keep the studio open and allow site storage or free space before retrying.'); }
  state = { ...state, draft: next };
  draft = structuredClone(next);
  dirty = false;
  if (!quiet) report('Draft saved on this device. No signature, export or mint request was created.');
  return state;
}

async function approve(choice) {
  if (busy) return;
  setBusy(true);
  const actionGeneration = generation;
  try {
    if (catalogMode && choice === 'split' && (draft.songs.length < 3 || draft.songs.length > 4)) {
      throw new Error('A catalog split needs three or four named cuts. Add or remove cuts before approval.');
    }
    if (dirty) await saveDraft();
    if (choice === 'defer') {
      report('Your draft stays on this device. No signature, export or mint request was created.');
      return;
    }
    const approvalDraft = (catalogMode ? validateCatalogRecordingDraft : validateRecordingDraft)(
      { ...draft, revision: state.journalRevision + 1 }, state.sourceSamples);
    const proposal = { ...(catalogMode ? { nftId: catalogNftId } : { bookingId }), wallet,
      sourceCid: state.sourceCid, sourceSamples: state.sourceSamples, choice, draft: approvalDraft };
    const fingerprint = JSON.stringify(proposal);
    if (!pendingPublication || pendingPublication.fingerprint !== fingerprint ||
        Date.now() - pendingPublication.command.issuedAt > 240000) {
      const issuedAt = Date.now();
      const message = catalogMode
        ? catalogRecordingReleaseApprovalMessage({ ...proposal, origin: location.origin, issuedAt })
        : recordingReleaseApprovalMessage({ ...proposal, origin: location.origin, issuedAt, incomplete: state.incomplete });
      report('Confirm the finished edit in your wallet. This single signature approves publication, not a mint or payment transaction…');
      const signature = await signer.signMessage(message);
      if (generation !== actionGeneration) throw new Error('Wallet changed; the edit was not submitted.');
      pendingPublication = { fingerprint, command: { ...proposal, issuedAt, signature } };
    }
    if (generation !== actionGeneration || wallet.toLowerCase() !== (await signer.getAddress()).toLowerCase()) {
      throw new Error('Wallet changed; the approval was not submitted.');
    }
    report('Submitting the signed edit and preparing bounded releases. Retrying an unchanged confirmation reuses this approval and cannot duplicate a release.');
    const result = await roomRequest(serviceUrl, 'recording-publish', pendingPublication.command);
    if (generation !== actionGeneration) throw new Error('Wallet changed; select the recording again to check the release journal.');
    pendingPublication = null;
    renderState({ ...result, journalRevision: result.draft.revision });
    report('Your confirmed release(s) are queued for separate admin mint review. The original NFT and audio remain unchanged.');
  } catch (error) {
    report(error.message || 'Recording release action failed; reload the durable journal before retrying.');
  } finally { setBusy(false); }
}

byId('recording-edit-connect').addEventListener('click', async () => {
  if (busy) return;
  if (state?.available && (audio.error || mediaPending)) {
    byId('recording-edit-connect').hidden = true;
    setMediaPending(true);
    audio.load();
    return;
  }
  setBusy(true);
  report('Opening your recording studio…');
  try { await connect(); }
  catch (error) {
    report(error.message || 'Could not open the recording room.');
    byId('recording-edit-connect').hidden = false;
  }
  finally { setBusy(false); }
});
byId('recording-edit-save').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  try { await saveDraft(); }
  catch (error) { report(error.message || 'Draft could not be saved; no release was queued.'); }
  finally { setBusy(false); }
});
byId('recording-edit-defer').addEventListener('click', () => approve('defer'));
byId('recording-edit-full').addEventListener('click', () => approve('full'));
byId('recording-edit-split').addEventListener('click', () => approve('split'));
byId('recording-edit-add-song').addEventListener('click', () => {
  if (draft.songs.length >= (catalogMode ? 4 : 50)) return;
  const startSample = draft.songs.at(-1)?.endSample || 0;
  const endSample = Math.min(state.sourceSamples, startSample + 3 * state.sampleRate * 60);
  if (endSample - startSample < state.sampleRate / 2) {
    report('There is not enough unassigned source audio for another song. Adjust existing boundaries first.');
    return;
  }
  draft.songs.push({ title: `${state.draft.albumTitle} - Track ${draft.songs.length + 1}`,
    startSample, endSample });
  markDraftChanged();
  byId('recording-edit-add-song').disabled = draft.songs.length >= (catalogMode ? 4 : 50);
  renderSongs();
});
audio.addEventListener('play', () => { if (audio.currentTime >= previewEnd) previewEnd = Infinity; });
audio.addEventListener('timeupdate', () => { if (!audio.paused && audio.currentTime >= previewEnd) audio.pause(); });
audio.addEventListener('loadedmetadata', () => { setMediaPending(false); drawWaveform(); });
audio.addEventListener('error', () => {
  setMediaPending(false);
  report('The audio preview could not load. Retry the preview; your draft and original recording are unchanged.');
  byId('recording-edit-connect').hidden = false;
  byId('recording-edit-connect').textContent = 'Retry audio preview';
});
window.addEventListener('resize', drawWaveform);
window.addEventListener('pagehide', () => { audio.pause(); });
function invalidateWallet() {
  generation++; signer = null; wallet = ''; state = null; draft = null; pendingPublication = null;
  dirty = false; clearTimeout(saveTimer);
  activeDrag = null;
  audio.pause();
  audio.removeAttribute('src');
  setMediaPending(false);
  setBusy(false);
  workspace.hidden = true;
  report('Wallet changed. Choose a recording using the connected artist wallet.');
}
if (!embedded) window.ethereum?.on?.('accountsChanged', invalidateWallet);

window.addEventListener('message', async event => {
  if (!embedded || event.origin !== location.origin || event.source !== window.parent) return;
  if (event.data?.type === 'decentbusking:editor-wallet-changed') { invalidateWallet(); return; }
  if (event.data?.type !== 'decentbusking:flush-recording-draft') return;
  try {
    while (busy) await new Promise(resolve => setTimeout(resolve, 100));
    await saveDraft();
    audio.pause();
    window.parent.postMessage({
      type: 'decentbusking:recording-draft-flushed', requestId: event.data.requestId,
    }, location.origin);
  } catch (error) {
    report(error.message || 'The split draft could not be saved; keep the editor open and retry.');
    window.parent.postMessage({
      type: 'decentbusking:recording-draft-flush-failed', requestId: event.data.requestId,
    }, location.origin);
  }
});

if (embedded) {
  byId('recording-edit-connect').hidden = true;
  byId('recording-edit-connect').textContent = 'Retry loading recording';
  window.parent.postMessage({
    type: 'decentbusking:editor-ready', requestId: params.get('studioRequest'),
  }, location.origin);
  byId('recording-edit-connect').click();
}
