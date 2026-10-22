import { createListenPlaylist } from './listens.mjs?v=20261019-radio-recovery';
import { createNamedPlaylistClient, DJUKE_PLAYLIST_MAX_PER_PROFILE, getPlaylistBatchAbi,
  matchesPlaylistRevision, quoteNamedPlaylist, supportsDJukePlaylistBatch } from './djuke-playlists.mjs';
import { ensureBaseNetwork, approvalNotice, waitForAllowance } from './base-chain.mjs';
import { formatUsdcUnits } from './usdc-format.mjs?v=20261017-mercury-release';
import { announcePaymentCelebration } from './payment-celebration.mjs';

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PLAYLIST_BATCH_ABI = getPlaylistBatchAbi();
const USDC_ABI = [
  'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)',
];

function makePlaylistId() {
  return globalThis.crypto.randomUUID().replaceAll('-', '').toLowerCase();
}
function event(name, detail) {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}
function safeButton(label, handler, disabled = false, title = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.disabled = disabled;
  if (title) button.title = title;
  button.addEventListener('click', handler);
  return button;
}

export async function purchasePrivateNamedPlaylist({ playlist, signer, config = window.DecentConfig || {}, onStep = () => {} }) {
  if (!supportsDJukePlaylistBatch(config)) throw new Error('Private named-playlist checkout is unavailable until a compatible DJuke batch contract is configured');
  await ensureBaseNetwork(signer.provider);
  const quote = quoteNamedPlaylist(playlist.songIds.length, 'private');
  const address = await signer.getAddress();
  const djuke = new ethers.Contract(config.djukePlaylistBatchAddress, PLAYLIST_BATCH_ABI, signer);
  const usdc = new ethers.Contract(BASE_USDC, USDC_ABI, signer);
  if (Number(await usdc.decimals()) !== 6) throw new Error('Configured token is not native Base USDC');
  if (await usdc.balanceOf(address) < quote.totalUnits) throw new Error(`You need ${formatUsdcUnits(quote.totalUnits)} USDC on Base`);
  if (await usdc.allowance(address, djuke.target) < quote.totalUnits) {
    onStep(approvalNotice(formatUsdcUnits(quote.totalUnits)));
    const approval = await usdc.approve(djuke.target, quote.totalUnits);
    if ((await approval.wait())?.status !== 1) throw new Error('USDC approval did not confirm');
    await waitForAllowance(usdc, address, djuke.target, quote.totalUnits);
  }
  onStep(`Private playlist · ${playlist.songIds.length} × 0.25 USDC · ${formatUsdcUnits(quote.totalUnits)} USDC total`);
  await djuke.purchasePlaylistPrivate.staticCall(playlist.songIds, quote.totalUnits);
  onStep('Confirm private playlist purchase in your wallet');
  const transaction = await djuke.purchasePlaylistPrivate(playlist.songIds, quote.totalUnits);
  onStep('Waiting for Base confirmation…');
  if ((await transaction.wait())?.status !== 1) throw new Error('Private playlist purchase did not confirm');
  announcePaymentCelebration({ chainId: 8453, txHash: transaction.hash, amountText: formatUsdcUnits(quote.totalUnits),
    assetText: 'USDC', summary: 'Private playlist purchase confirmed', txLabel: 'Playlist purchase confirmed' });
  return { txHash: transaction.hash, totalUnits: quote.totalUnits };
}

export function initDjukePlaylists() {
  const config = () => window.DecentConfig || {};
  const client = createNamedPlaylistClient();
  const draft = createListenPlaylist();
  const nameInput = document.getElementById('djuke-playlist-name');
  const draftList = document.getElementById('djuke-playlist');
  const draftCount = document.getElementById('djuke-playlist-draft-count');
  const draftTotal = document.getElementById('djuke-playlist-total');
  const saveButton = document.getElementById('djuke-playlist-save');
  const privateButton = document.getElementById('djuke-named-playlist-private');
  const radioButton = document.getElementById('djuke-named-playlist-radio');
  const addSelected = document.getElementById('djuke-add-selected-playlist');
  const songSelect = document.getElementById('djuke-song');
  const state = document.getElementById('djuke-playlist-state');
  const profileDialog = document.getElementById('creator-profile');
  const profileSection = profileDialog?.querySelector('[data-playlists-section]');
  const profileStatus = profileSection?.querySelector('[data-playlists-status]');
  const profileItems = profileSection?.querySelector('[data-profile-playlists]');
  const profileCount = profileSection?.querySelector('[data-playlists-count]');
  const searchInput = profileSection?.querySelector('[data-playlist-search]');
  const searchButton = profileSection?.querySelector('[data-playlist-discover]');
  const searchResults = profileSection?.querySelector('[data-playlist-results]');
  if (!nameInput || !draftList || !saveButton || !profileSection) return;

  let currentProfile = null;
  let selectedRevision = null;
  let busy = false;
  let profileAddress = '';

  const batchCapability = () => supportsDJukePlaylistBatch(config());
  const radioCapability = () => false;
  function updateGate() {
    const enabled = batchCapability();
    if (addSelected) addSelected.disabled = !songSelect?.value || draft.list().length >= 10 || busy;
    const exactRevision = matchesPlaylistRevision(selectedRevision, draft.list().map(item => item.songId));
    privateButton.disabled = !enabled || !exactRevision || busy;
    privateButton.title = enabled ? (exactRevision ? 'Buy exactly the selected immutable revision at 0.25 USDC per song; radio queue is untouched' : 'Load or save the exact named revision before private checkout') : 'Requires a compatible DJuke v0.3 playlist deployment';
    radioButton.disabled = !radioCapability() || !draft.list().length || busy;
    radioButton.title = radioCapability() ? 'Flat 0.25 USDC per song plus one $5 playlist fund fee' : 'Requires a compatible DJuke v0.3 deployment and a signed gas-quote service';
    saveButton.disabled = busy || !draft.list().length || !nameInput.value.trim();
  }
  function renderDraft() {
    const items = draft.list();
    draftList.replaceChildren();
    items.forEach((item, index) => {
      const row = document.createElement('li');
      const title = document.createElement('span');
      title.textContent = `${index + 1}. ${item.title || 'Untitled song'} · ${item.artist || 'Unknown artist'}`;
      row.append(title);
      if (index > 0) row.append(safeButton('↑', () => reorder(index, index - 1), busy, 'Move track earlier'));
      if (index + 1 < items.length) row.append(safeButton('↓', () => reorder(index, index + 1), busy, 'Move track later'));
      row.append(safeButton('×', () => {
        const next = items.filter((_, i) => i !== index);
        draft.replace(next);
        event('djuke-playlist-draft-changed', { items: next });
        renderDraft();
      }, busy, `Remove ${item.title || 'song'}`));
      draftList.append(row);
    });
    const count = items.length;
    if (draftCount) draftCount.textContent = `${count}/10`;
    if (draftTotal) draftTotal.textContent = count
      ? `${count} songs · private ${formatUsdcUnits(quoteNamedPlaylist(count, 'private').totalUnits)} USDC · radio ${formatUsdcUnits(quoteNamedPlaylist(count, 'radio').totalUnits)} USDC including one $5 fund fee (2.25 playback / 2.25 Top 10 / 0.40 pinners / 0.10 repo dev); worker quote and wallet gas shown before any radio confirmation`
      : 'Empty — add songs from a music card';
    updateGate();
  }
  function reorder(from, to) {
    const items = draft.list();
    const [item] = items.splice(from, 1);
    items.splice(to, 0, item);
    draft.replace(items);
    event('djuke-playlist-draft-changed', { items });
    renderDraft();
  }
  async function refreshProfile(address = window._wallet?.address || profileAddress) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) {
      currentProfile = null;
      profileAddress = '';
      profileItems?.replaceChildren();
      profileStatus.textContent = 'Connect a wallet to view saved playlists.';
      return;
    }
    profileAddress = address;
    try {
      currentProfile = await client.profile(address);
      renderProfile();
    } catch (error) { profileStatus.textContent = error.message; }
  }
  function playlistRow(playlist, isOwn = false) {
    const row = document.createElement('li');
    row.className = 'creator-playlist-item';
    const info = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = playlist.name;
    const meta = document.createElement('span');
    meta.textContent = `${playlist.songIds.length} songs · by ${playlist.maker} · ID ${playlist.id.slice(0, 8)} · revision ${playlist.revision}`;
    info.append(title, meta);
    row.append(info);
    row.append(safeButton('Load to DJuke', () => loadPlaylist(playlist), false, 'Load this exact immutable playlist revision'));
    if (!isOwn && playlist.maker.toLowerCase() !== window._wallet?.address?.toLowerCase()) {
      row.append(safeButton('Save copy', async () => {
        await run(async () => { await client.saveCopy(playlist); await refreshProfile(profileAddress); profileStatus.textContent = 'Saved immutable playlist copy; attribution preserved.'; });
      }, busy, 'Pin this immutable revision to your profile'));
    }
    row.append(safeButton('Listen privately', async () => {
      await run(async () => {
        const tracks = await resolveTrackItems(playlist.songIds);
        await purchasePrivateNamedPlaylist({ playlist, signer: window._wallet.signer, onStep: text => { profileStatus.textContent = text; } });
        event('djuke-private-playlist-purchased', { items: tracks });
      });
    }, !batchCapability() || busy, 'Flat-rate checkout is disabled until a compatible DJuke deployment is configured'));
    row.append(safeButton('Buy radio playback', async () => {
      profileStatus.textContent = 'Radio batch checkout needs the separately configured worker-signed gas quote service.';
    }, !radioCapability() || busy, 'Radio checkout requires the compatible batch deployment and signed gas quote service'));
    profileItems.append(row);
  }
  function renderProfile() {
    if (!profileItems || !currentProfile) return;
    const own = profileAddress.toLowerCase() === window._wallet?.address?.toLowerCase();
    profileSection.hidden = false;
    profileItems.replaceChildren();
    const all = [...(currentProfile.madePlaylists || []), ...(currentProfile.playlists || [])];
    if (profileCount) profileCount.textContent = String(all.length);
    if (!all.length) profileStatus.textContent = own ? 'No saved playlists yet. Add songs to DJuke, name the draft, then save it here.' : 'This profile has no saved playlists.';
    else profileStatus.textContent = `${all.length} saved playlist${all.length === 1 ? '' : 's'} · copies pin exact immutable revisions`;
    (currentProfile.madePlaylists || []).forEach(playlist => playlistRow(playlist, true));
    (currentProfile.playlists || []).forEach(playlist => playlistRow(playlist, false));
  }
  async function resolveTrackItems(songIds) {
    const service = String(config().ipfsUploadServiceUrl || '').replace(/\/$/, '');
    const response = await fetch(`${service}/api/djuke`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    const snapshot = response.ok ? await response.json() : null;
    const tracks = new Map((snapshot?.tracks || []).map(track => [String(track.songId || '').toLowerCase(), track]));
    return songIds.map(songId => {
      const track = tracks.get(songId.toLowerCase());
      if (!track?.ipfsCid) throw new Error('A saved playlist song is no longer available; no partial playback was started');
      return { songId, title: track.title || 'Untitled song', artist: track.artist || track.uploader || '', audioUrl: `ipfs://${track.ipfsCid}`, mediaType: track.mediaType || '' };
    });
  }
  async function run(operation) {
    if (busy) return;
    busy = true;
    updateGate();
    try { await operation(); }
    catch (error) { (profileStatus || state).textContent = error.shortMessage || error.reason || error.message; }
    finally { busy = false; updateGate(); }
  }
  async function saveDraft() {
    await run(async () => {
      const wallet = window._wallet;
      if (!wallet?.address || !wallet?.signer) throw new Error('Connect your wallet in the page header');
      const name = nameInput.value.trim();
      if (!name || name.length > 60) throw new Error('Playlist name must be 1–60 characters');
      const items = draft.list();
      if (!items.length || items.length > 10) throw new Error('Choose 1–10 songs');
      const own = currentProfile?.madePlaylists?.find(item => item.id === selectedRevision?.id && item.maker.toLowerCase() === wallet.address.toLowerCase());
      const playlist = {
        id: own?.id || makePlaylistId(), maker: wallet.address.toLowerCase(), name,
        revision: own ? Number(own.revision) + 1 : 1, songIds: items.map(item => item.songId),
      };
      const saved = await client.saveOriginal(playlist);
      selectedRevision = saved.playlist;
      currentProfile = await client.profile(wallet.address);
      renderProfile();
      state.textContent = `Saved “${name}” as immutable revision ${playlist.revision}. Saving does not purchase playback.`;
    });
  }
  async function discover() {
    if (!searchResults) return;
    searchResults.replaceChildren();
    profileStatus.textContent = 'Searching public playlist names…';
    try {
      const results = await client.discover(searchInput.value.trim());
      if (!results.length) profileStatus.textContent = 'No public playlist name matches.';
      results.forEach(playlist => {
        const row = document.createElement('li');
        const title = document.createElement('span');
        title.textContent = `${playlist.name} · ${playlist.songCount} songs · ${playlist.maker} · ${playlist.id}`;
        row.append(title, safeButton('Load', () => loadPlaylist(playlist)));
        if (playlist.maker.toLowerCase() !== window._wallet?.address?.toLowerCase()) {
          row.append(safeButton('Save copy', async () => {
            await run(async () => { await client.saveCopy(playlist); await refreshProfile(); profileStatus.textContent = 'Saved immutable revision with maker attribution.'; });
          }, busy));
        }
        searchResults.append(row);
      });
      if (results.length) profileStatus.textContent = `${results.length} match${results.length === 1 ? '' : 'es'} · same-name playlists are identified by maker and ID`;
    } catch (error) { profileStatus.textContent = error.message; }
  }
  function loadPlaylist(playlist) {
    selectedRevision = playlist;
    nameInput.value = playlist.name;
    resolveTrackItems(playlist.songIds).then(items => {
      draft.replace(items);
      event('djuke-set-playlist-draft', { items });
      renderDraft();
      state.textContent = `Loaded ${playlist.name} revision ${playlist.revision}; the original remains editable only by its maker.`;
    }).catch(error => { (profileStatus || state).textContent = error.message; });
  }

  saveButton.addEventListener('click', saveDraft);
  nameInput.addEventListener('input', updateGate);
  songSelect?.addEventListener('change', updateGate);
  addSelected?.addEventListener('click', async () => {
    try {
      const service = String(config().ipfsUploadServiceUrl || '').replace(/\/$/, '');
      const response = await fetch(`${service}/api/djuke`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      const snapshot = response.ok ? await response.json() : null;
      const track = snapshot?.tracks?.find(item => item.trackId === songSelect.value);
      if (!track?.songId || !track?.ipfsCid) throw new Error('Selected song is not available in the verified DJuke catalog');
      const item = { songId: track.songId, title: track.title || 'Untitled song', artist: track.artist || track.uploader || '', audioUrl: `ipfs://${track.ipfsCid}`, mediaType: track.mediaType || '' };
      if (!draft.add(item)) { state.textContent = 'That song is already in the draft.'; return; }
      event('djuke-playlist-draft-changed', { items: draft.list() });
      renderDraft();
      state.textContent = `Added ${item.title} to the ordered playlist draft.`;
    } catch (error) { state.textContent = error.message; }
  });
  searchButton?.addEventListener('click', discover);
  searchInput?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); discover(); } });
  document.addEventListener('djuke-playlist-draft-changed', event => {
    if (Array.isArray(event.detail?.items)) {
      try { draft.replace(event.detail.items); renderDraft(); } catch {}
    }
  });
  document.addEventListener('djuke-playlist-save-request', saveDraft);
  document.addEventListener('creator-profile-playlists-refresh', event => {
    void refreshProfile(event.detail?.address).catch(() => {});
  });
  document.addEventListener('wallet-connected', event => { void refreshProfile(event.detail?.address); });
  document.addEventListener('wallet-disconnected', () => { currentProfile = null; profileItems?.replaceChildren(); profileAddress = ''; renderDraft(); });
  document.addEventListener('djuke-playlist-batch-config-changed', updateGate);
  privateButton?.addEventListener('click', async () => {
    const selected = selectedRevision;
    if (!selected) { state.textContent = 'Save or load a named playlist before private checkout.'; return; }
    const items = await resolveTrackItems(selected.songIds);
    await run(async () => {
      if (!window._wallet?.signer) await window._wallet?.connect?.();
      if (!window._wallet?.signer) throw new Error('Connect your wallet in the page header');
      await purchasePrivateNamedPlaylist({ playlist: selected, signer: window._wallet.signer, onStep: text => { state.textContent = text; } });
      event('djuke-private-playlist-purchased', { items });
    });
  });
  radioButton?.addEventListener('click', () => { state.textContent = 'Radio batch checkout remains disabled until the signed worker gas-quote service is separately configured.'; });
  const initialItems = draft.list();
  if (initialItems.length) event('djuke-playlist-draft-changed', { items: initialItems });
  renderDraft();
  if (window._wallet?.address) void refreshProfile(window._wallet.address);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initDjukePlaylists, { once: true });
  else initDjukePlaylists();
}
