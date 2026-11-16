import { roomRequest } from './live-audio-client.mjs?v=20261114-allocated-stage';
import { recordingReleaseApprovalMessage, validateRecordingDraft } from './live-recording-edit.mjs';

const byId = id => document.getElementById(id);
const bookingId = new URL(location.href).searchParams.get('booking') || '';
const serviceUrl = String(window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
const status = byId('recording-edit-status');
const workspace = byId('recording-edit-workspace');
const audio = byId('recording-edit-audio');
const canvas = byId('recording-edit-waveform');
let session, signer, wallet = '', state, draft, busy = false, generation = 0, previewEnd = 0;

const report = message => { status.textContent = message; };
const cidUrl = cid => {
  const gateway = String(window.DecentConfig?.ipfsGateway || 'https://gateway.pinata.cloud').replace(/\/$/, '');
  const base = new URL(gateway);
  if (base.protocol !== 'https:' || base.username || base.password || base.hash ||
      !/^[a-zA-Z0-9]{20,120}$/.test(cid || '')) throw new Error('Recording preview gateway is unavailable');
  return `${base.toString().replace(/\/$/, '')}/ipfs/${cid}`;
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
    input.addEventListener('input', () => { song.title = input.value; drawWaveform(); });
  } else {
    input.min = '0'; input.max = seconds(state.sourceSamples).toFixed(3); input.step = '0.001';
    input.value = seconds(song[key]).toFixed(3);
    input.setAttribute('aria-describedby', `recording-edit-track-${index + 1}-boundary-help`);
    input.addEventListener('change', () => {
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < 0) { report('Enter a non-negative time in seconds.'); return; }
      song[key] = Math.round(value * state.sampleRate);
      input.value = seconds(song[key]).toFixed(3);
      drawWaveform();
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
      remove.addEventListener('click', () => { draft.songs.splice(index, 1); renderSongs(); drawWaveform(); });
      section.append(remove);
    }
    container.append(section);
  });
  drawWaveform();
}

function renderReleases() {
  const list = byId('recording-edit-releases');
  list.replaceChildren();
  if (!state.releases.length) {
    const item = document.createElement('li');
    item.textContent = 'No release has been approved or queued.';
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
  workspace.hidden = false;
  byId('recording-edit-title').textContent = state.incomplete ? 'Original recording preview · partial capture'
    : 'Original recording preview';
  byId('recording-edit-facts').textContent = `${state.durationSeconds.toFixed(3)}s · ${state.sourceSamples.toLocaleString()} mono samples at ${state.sampleRate} Hz · source CID ${state.sourceCid}.`;
  byId('recording-edit-rights').textContent = state.incomplete
    ? 'This capture is marked partial/interrupted. The original source has already been stored on public IPFS under your recording consent; it remains unchanged. Every release approval signature states that this capture is incomplete.'
    : 'The original recording and its source CIDs remain unchanged. After minting, edits are linked new releases—not changes to an existing token. The booked performer wallet remains the artist, royalty receiver and tip wallet; no collaborator split is inferred.';
  byId('recording-edit-album-title').value = draft.albumTitle;
  byId('recording-edit-album-title').oninput = () => { draft.albumTitle = byId('recording-edit-album-title').value; drawWaveform(); };
  const preview = cidUrl(state.sourceCid);
  if (audio.src !== preview) audio.src = preview;
  byId('recording-edit-waveform-note').textContent = state.waveform?.length
    ? 'Waveform is derived from the preserved PCM capture. Keyboard-accessible start/end time fields set boundaries to the nearest 48 kHz sample.'
    : 'Waveform samples are unavailable for this older capture; use the accessible time fields and original audio preview.';
  byId('recording-edit-add-song').disabled = draft.songs.length >= 50;
  renderSongs();
  renderReleases();
  report(state.decision === 'deferred'
    ? 'Your last choice was “decide later.” No release is submitted until you approve it here.'
    : 'Recording loaded from the durable journal. The original audio is public on IPFS under your recording consent; no new song export or mint request is created until you approve a release.');
}

function setBusy(value) {
  busy = value;
  for (const id of ['recording-edit-connect', 'recording-edit-add-song', 'recording-edit-save',
    'recording-edit-defer', 'recording-edit-full', 'recording-edit-split']) byId(id).disabled = value;
}

async function connect() {
  if (!bookingId || !serviceUrl) throw new Error('The booking or live recording service URL is missing.');
  if (!window.ethereum || !window.ethers) throw new Error('Install or unlock a wallet to continue.');
  const generationAtStart = ++generation;
  const provider = new window.ethers.BrowserProvider(window.ethereum);
  signer = await provider.getSigner();
  wallet = (await signer.getAddress()).toLowerCase();
  const challenge = await roomRequest(serviceUrl, 'challenge', { bookingId, wallet, scope: 'recording-edit' });
  if (generation !== generationAtStart) throw new Error('Wallet changed; reconnect to the booked performer account.');
  const signature = await signer.signMessage(challenge.message);
  if (generation !== generationAtStart) throw new Error('Wallet changed; reconnect to the booked performer account.');
  session = await roomRequest(serviceUrl, 'session', { challengeId: challenge.challengeId, signature });
  if (generation !== generationAtStart || session.role !== 'performer') throw new Error('Only the booked performer can open this edit room.');
  renderState(session.state);
}

async function saveDraft() {
  const next = validateRecordingDraft({ ...draft, revision: state.draft.revision + 1 }, state.sourceSamples);
  report('Saving this private split draft to the encrypted recording journal…');
  const saved = await roomRequest(serviceUrl, 'control', { action: 'recording-edit-save', draft: next }, session.token);
  renderState(saved);
  report('Draft saved durably. No audio export or mint request was created.');
  return saved;
}

async function approve(choice) {
  if (busy) return;
  setBusy(true);
  const actionGeneration = generation;
  try {
    if (choice !== 'defer') await saveDraft();
    const approvalDraft = choice === 'defer' ? null : state.draft;
    const issuedAt = Date.now();
    const message = recordingReleaseApprovalMessage({ bookingId, wallet, origin: location.origin,
      sourceCid: state.sourceCid, sourceSamples: state.sourceSamples, choice, draft: approvalDraft,
      issuedAt, incomplete: state.incomplete });
    report(choice === 'defer' ? 'Confirm “decide later” in your wallet…' : 'Review the complete release choice in your wallet. No transaction is being requested…');
    const signature = await signer.signMessage(message);
    if (generation !== actionGeneration || wallet.toLowerCase() !== (await signer.getAddress()).toLowerCase()) {
      throw new Error('Wallet changed; the approval was not submitted.');
    }
    report(choice === 'defer' ? 'Saving your deferred decision…' : 'Preparing bounded MP3 release(s). If this request times out, refresh the journal before retrying.');
    const result = await roomRequest(serviceUrl, 'control', {
      action: 'recording-edit-approve', choice, issuedAt, signature,
    }, session.token);
    renderState(result);
    report(choice === 'defer'
      ? 'Saved. Nothing was exported or added to the mint queue; return here to resume.'
      : 'Your approved release(s) are queued for separate admin mint review. The original source is preserved.');
  } catch (error) {
    report(error.message || 'Recording release action failed; reload the durable journal before retrying.');
  } finally { setBusy(false); }
}

byId('recording-edit-connect').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  try { await connect(); } catch (error) { report(error.message || 'Could not open the recording room.'); }
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
  if (draft.songs.length >= 50) return;
  const startSample = draft.songs.at(-1)?.endSample || 0;
  const endSample = Math.min(state.sourceSamples, startSample + 3 * state.sampleRate * 60);
  if (endSample - startSample < state.sampleRate / 2) {
    report('There is not enough unassigned source audio for another song. Adjust existing boundaries first.');
    return;
  }
  draft.songs.push({ title: `${state.draft.albumTitle} - Track ${draft.songs.length + 1}`,
    startSample, endSample });
  byId('recording-edit-add-song').disabled = draft.songs.length >= 50;
  renderSongs();
});
audio.addEventListener('play', () => { if (audio.currentTime >= previewEnd) previewEnd = Infinity; });
audio.addEventListener('timeupdate', () => { if (!audio.paused && audio.currentTime >= previewEnd) audio.pause(); });
window.addEventListener('resize', drawWaveform);
window.addEventListener('pagehide', () => { audio.pause(); });
window.ethereum?.on?.('accountsChanged', () => {
  generation++; session = null; signer = null; wallet = ''; state = null; draft = null;
  workspace.hidden = true;
  report('Wallet changed. Reconnect the booked performer wallet to continue.');
});
