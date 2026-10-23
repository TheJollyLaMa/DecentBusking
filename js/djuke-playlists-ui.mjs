import { appendPlaylistSong, openPlaylistSelector } from './playlist-selector.mjs?v=20261022-playlist-lane';
import { createListenPlaylist } from './listens.mjs?v=20261023-playlist-actions';
import { createNamedPlaylistClient, DJUKE_PLAYLIST_MAX_PER_PROFILE, getPlaylistBatchAbi,
  matchesPlaylistRevision, quoteNamedPlaylist, supportsDJukePlaylistBatch, supportsDJukePlaylistRadio } from './djuke-playlists.mjs?v=20261022-playlist-lane';
import { ensureBaseNetwork, approvalNotice, waitForAllowance } from './base-chain.mjs';
import { formatUsdcUnits } from './usdc-format.mjs?v=20261017-mercury-release';
import { announcePaymentCelebration } from './payment-celebration.mjs';

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const GAS_QUOTE_TYPES = { PlaylistGasQuote: [
  { name: 'listener', type: 'address' }, { name: 'songIdsHash', type: 'bytes32' },
  { name: 'maxTotal', type: 'uint256' }, { name: 'fulfillmentCostWei', type: 'uint256' },
  { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
] };
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
  if (title) { button.title = title; button.setAttribute('aria-label', title); }
  button.addEventListener('click', handler);
  return button;
}

export async function purchaseRadioNamedPlaylist({ playlist, signer, config = window.DecentConfig || {}, onStep = () => {}, fetchImpl = fetch }) {
  if (!supportsDJukePlaylistRadio(config)) throw new Error('Radio playlist checkout is unavailable');
  const songIds = playlist.songIds;
  quoteNamedPlaylist(songIds.length, 'radio');
  await ensureBaseNetwork(signer.provider);
  const listener = await signer.getAddress();
  const quoteUrl = new URL(`${String(config.ipfsUploadServiceUrl || '').replace(/\/$/, '')}/api/djuke/playlist-gas-quote`);
  quoteUrl.searchParams.set('listener', listener);
  songIds.forEach(songId => quoteUrl.searchParams.append('songId', songId));
  const response = await fetchImpl(quoteUrl, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
  const quote = await response.json();
  if (!response.ok) throw new Error(quote.error || 'Playlist gas quote is unavailable');
  const nowSeconds = Math.floor(Date.now() / 1000);
  const maxTotal = BigInt(quote.maxTotal);
  const fulfillmentCostWei = BigInt(quote.fulfillmentCostWei);
  const contributionWei = BigInt(quote.contributionWei);
  if (quote.contractAddress?.toLowerCase() !== config.djukePlaylistBatchAddress?.toLowerCase() ||
      quote.listener?.toLowerCase() !== listener.toLowerCase() || !Number.isInteger(quote.deadline) ||
      quote.deadline < nowSeconds || quote.deadline > nowSeconds + 300 ||
      maxTotal !== quoteNamedPlaylist(songIds.length, 'radio').totalUnits ||
      contributionWei !== fulfillmentCostWei * 2n * BigInt(songIds.length)) throw new Error('Worker returned an invalid or expired playlist gas quote');
  const djuke = new ethers.Contract(config.djukePlaylistBatchAddress, PLAYLIST_BATCH_ABI, signer);
  if (config.djukePlaylistBatchVersion === '0.5') {
    if (contributionWei !== 0n || fulfillmentCostWei !== 0n || await djuke.CONTRACT_VERSION() !== '0.5') {
      throw new Error('Platform-funded playlist checkout requires DJuke v0.5 and no worker ETH charge');
    }
  } else if (contributionWei <= 0n) throw new Error('Legacy playlist checkout requires its disclosed worker gas contribution');
  const usdc = new ethers.Contract(BASE_USDC, USDC_ABI, signer);
  if (Number(await usdc.decimals()) !== 6) throw new Error('Configured token is not native Base USDC');
  if (await usdc.balanceOf(listener) < maxTotal) throw new Error(`You need ${formatUsdcUnits(maxTotal)} USDC on Base`);
  if (await signer.provider.getBalance(listener) < contributionWei) throw new Error('Not enough Base ETH for the worker gas contribution');
  if (await usdc.allowance(listener, djuke.target) < maxTotal) {
    onStep(approvalNotice(formatUsdcUnits(maxTotal)));
    const approval = await usdc.approve(djuke.target, maxTotal);
    if ((await approval.wait())?.status !== 1) throw new Error('USDC approval did not confirm');
    await waitForAllowance(usdc, listener, djuke.target, maxTotal);
  }
  onStep(`${songIds.length} songs · ${formatUsdcUnits(maxTotal)} USDC · ${contributionWei === 0n
    ? 'platform-funded worker execution; wallet network gas still applies' : `${ethers.formatEther(contributionWei)} ETH worker gas`}`);
  await djuke.requestPlaylistWithGas.staticCall(songIds, maxTotal, fulfillmentCostWei, quote.deadline, quote.signature, { value: contributionWei });
  onStep('Confirm radio playlist checkout in your wallet');
  const transaction = await djuke.requestPlaylistWithGas(songIds, maxTotal, fulfillmentCostWei, quote.deadline, quote.signature, { value: contributionWei });
  onStep('Waiting for Base confirmation…');
  if ((await transaction.wait())?.status !== 1) throw new Error('Radio playlist request did not confirm');
  announcePaymentCelebration({ chainId: 8453, txHash: transaction.hash, amountText: formatUsdcUnits(maxTotal), assetText: 'USDC',
    summary: 'Radio playlist request confirmed', txLabel: 'Radio playlist confirmed' });
  return { txHash: transaction.hash, totalUnits: maxTotal, contributionWei };
}

export async function purchasePrivateNamedPlaylist({ playlist, signer, config = window.DecentConfig || {}, onStep = () => {} }) {
  if (!supportsDJukePlaylistBatch(config)) throw new Error('Private named-playlist checkout is unavailable until a compatible DJuke batch contract is configured');
  await ensureBaseNetwork(signer.provider);
  quoteNamedPlaylist(playlist.songIds.length, 'private');
  const address = await signer.getAddress();
  const djuke = new ethers.Contract(config.djukePlaylistBatchAddress, PLAYLIST_BATCH_ABI, signer);
  const usdc = new ethers.Contract(BASE_USDC, USDC_ABI, signer);
  if (Number(await usdc.decimals()) !== 6) throw new Error('Configured token is not native Base USDC');
  const chainQuote = await djuke.quotePlaylist(playlist.songIds, false);
  const quote = { totalUnits: BigInt(chainQuote.total ?? chainQuote[2]) };
  if (await usdc.balanceOf(address) < quote.totalUnits) throw new Error(`You need ${formatUsdcUnits(quote.totalUnits)} USDC on Base`);
  if (await usdc.allowance(address, djuke.target) < quote.totalUnits) {
    onStep(approvalNotice(formatUsdcUnits(quote.totalUnits)));
    const approval = await usdc.approve(djuke.target, quote.totalUnits);
    if ((await approval.wait())?.status !== 1) throw new Error('USDC approval did not confirm');
    await waitForAllowance(usdc, address, djuke.target, quote.totalUnits);
  }
  onStep(`Private playlist · ${playlist.songIds.length} songs at creator listen prices · ${formatUsdcUnits(quote.totalUnits)} USDC total`);
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
  let quoteProvider;
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

  let workerRadioReady = false;
  const batchCapability = () => supportsDJukePlaylistBatch(config());
  const radioCapability = () => supportsDJukePlaylistRadio({ ...config(), djukePlaylistRadioReady: config().djukePlaylistRadioReady === true && workerRadioReady });
  const workerCostNotice = () => config().djukePlaylistBatchVersion === '0.5'
    ? 'Worker execution is platform-funded; wallet network gas is extra.'
    : 'Live adds worker ETH; wallet gas is extra.';
  async function refreshPlaylistReadiness() {
    const service = String(config().ipfsUploadServiceUrl || '').replace(/\/$/, '');
    if (!service || !['0.4', '0.5'].includes(config().djukePlaylistBatchVersion)) { workerRadioReady = false; updateGate(); return; }
    try {
      const response = await fetch(`${service}/api/djuke/playlist-readiness`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      const status = response.ok ? await response.json() : null;
      workerRadioReady = status?.ready === true && status.version === config().djukePlaylistBatchVersion &&
        status.contractAddress?.toLowerCase() === config().djukePlaylistBatchAddress?.toLowerCase();
    } catch { workerRadioReady = false; }
    updateGate();
    if (currentProfile) renderProfile();
  }
  function updateGate() {
    const enabled = batchCapability();
    if (addSelected) addSelected.disabled = !songSelect?.value || draft.list().length >= 24 || busy;
    const validDraft = draft.list().length >= 1 && draft.list().length <= 24;
    privateButton.disabled = !enabled || !validDraft || busy;
    privateButton.title = enabled ? 'One batch payment at creator prices, then every song plays in order just for you; saving is optional' : 'Personal Play requires a compatible DJuke v0.4 playlist deployment';
    radioButton.disabled = !radioCapability() || !validDraft || busy;
    radioButton.title = radioCapability() ? 'Play Live: radio tiers plus $3 per started group of 12 songs, worker ETH and wallet gas; main paid requests can cut in between songs' : 'Play Live is waiting for the radio worker and signed gas quote service';
    saveButton.disabled = busy || draft.list().length > 24 || !draft.list().length || !nameInput.value.trim();
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
        event('djuke-set-playlist-draft', { items: next });
        renderDraft();
      }, busy, `Remove ${item.title || 'song'}`));
      draftList.append(row);
    });
    const count = items.length;
    if (draftCount) draftCount.textContent = `${count}/24`;
    if (draftTotal) draftTotal.textContent = count > 24 ? 'Legacy listen cart: up to 50 songs. Named save and checkout require 1–24 songs.' : count
      ? `${count} songs · Personal Play ≈ ${formatUsdcUnits(quoteNamedPlaylist(count, 'private', items.map(item => item.listenPriceUnits)).totalUnits)} USDC · Play Live ≈ ${formatUsdcUnits(quoteNamedPlaylist(count, 'radio').totalUnits)} USDC including the $3 / 12 songs fee. ${workerCostNotice()} Main paid requests can cut in.`
      : 'Empty — add songs from a music card';
    if (count && count <= 24 && batchCapability() && globalThis.ethers && (window._wallet?.signer || config().rpcUrl)) {
      const ids = items.map(item => item.songId);
      const contract = new ethers.Contract(config().djukePlaylistBatchAddress, PLAYLIST_BATCH_ABI, window._wallet?.signer || (quoteProvider ||= new ethers.JsonRpcProvider(config().rpcUrl)));
      Promise.all([contract.quotePlaylist(ids, false), contract.quotePlaylist(ids, true)]).then(([privateQuote, radioQuote]) => {
        if (!matchesPlaylistRevision({ songIds: ids }, draft.list().map(item => item.songId))) return;
        draftTotal.textContent = `${count} songs · Personal Play ${formatUsdcUnits(privateQuote[2])} USDC · Play Live ${formatUsdcUnits(radioQuote[2])} USDC including the $3 / 12 songs fee. ${workerCostNotice()} Main paid requests can cut in.`;
      }).catch(error => { state.textContent = `Playlist price verification unavailable: ${error.message}`; });
    }
    updateGate();
  }
  function reorder(from, to) {
    const items = draft.list();
    const [item] = items.splice(from, 1);
    items.splice(to, 0, item);
    draft.replace(items);
    event('djuke-set-playlist-draft', { items });
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
    const privateAction = safeButton('Personal Play', async () => {
      await run(async () => {
        if (!window._wallet?.signer) throw new Error('Connect your wallet in the page header');
        const tracks = await resolveTrackItems(playlist.songIds);
        await purchasePrivateNamedPlaylist({ playlist, signer: window._wallet.signer, onStep: text => { profileStatus.textContent = text; } });
        event('djuke-private-playlist-purchased', { items: tracks });
      });
    }, !batchCapability() || busy, 'Creator-priced checkout requires a compatible DJuke deployment');
    privateAction.hidden = !batchCapability();
    row.append(privateAction);
    const radioAction = safeButton('Play Live', async () => {
      await run(async () => {
        if (!window._wallet?.signer) throw new Error('Connect your wallet in the page header');
        const purchase = await purchaseRadioNamedPlaylist({ playlist, signer: window._wallet.signer, config: { ...config(), djukePlaylistRadioReady: config().djukePlaylistRadioReady === true && workerRadioReady }, onStep: text => { profileStatus.textContent = text; } });
        event('djuke-radio-playlist-purchased', { ...purchase, name: playlist.name, songIds: playlist.songIds });
        profileStatus.textContent = 'Purchase confirmed. Your profile has your Play Live receipt for delivery or refund.';
      });
    }, !radioCapability() || busy, 'Radio checkout requires the compatible batch deployment and signed gas quote service');
    radioAction.hidden = !radioCapability();
    row.append(radioAction);
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
      return { songId, title: track.title || 'Untitled song', artist: track.artist || track.uploader || '', audioUrl: `ipfs://${track.ipfsCid}`, listenPriceUnits: track.listenPriceUnits, mediaType: track.mediaType || '' };
    });
  }
  async function run(operation) {
    if (busy) return;
    busy = true;
    updateGate();
    try { await operation(); }
    catch (error) {
      state.textContent = error.shortMessage || error.reason || error.message;
      if (profileStatus) profileStatus.textContent = state.textContent;
    }
    finally { busy = false; updateGate(); }
  }
  async function saveDraft() {
    await run(async () => {
      const wallet = window._wallet;
      if (!wallet?.address || !wallet?.signer) throw new Error('Connect your wallet in the page header');
      const name = nameInput.value.trim();
      if (!name || name.length > 60) throw new Error('Playlist name must be 1–60 characters');
      const items = draft.list();
      if (!items.length || items.length > 24) throw new Error('Choose 1–24 songs');
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

  document.addEventListener('dbusk-playlist-add', async input => {
    input.preventDefault();
    input.stopImmediatePropagation();
    const { anchor, status: report = () => {} } = input.detail;
    let ownLibrary = profileAddress.toLowerCase() === window._wallet?.address?.toLowerCase() ? currentProfile : null;
    if (!ownLibrary && window._wallet?.address) {
      try { ownLibrary = await client.profile(window._wallet.address); }
      catch (error) { report(error.message); }
    }
    openPlaylistSelector({ anchor, playlists: [...(ownLibrary?.madePlaylists || []), ...(ownLibrary?.playlists || [])], status: report,
      choose: async (playlist, newName) => {
        if (busy) throw new Error('Wait for the current playlist operation.');
        const chart = input.detail.track;
        const nft = input.detail.nft || { title: chart.title, artist: chart.artist || chart.uploader, audioUrl: `ipfs://${chart.ipfsCid}` };
        const audioUrl = nft.videoUrl || nft.audioUrl || nft.animation_url || '';
        const service = String(config().ipfsUploadServiceUrl || '').replace(/\/$/, '');
        const response = await fetch(`${service}/api/djuke`, { cache: 'no-store' });
        if (!response.ok) throw new Error('Verified catalog unavailable.');
        const catalog = await response.json();
        const track = catalog.tracks?.find(track => audioUrl === `ipfs://${track.ipfsCid}` || audioUrl.includes(track.ipfsCid));
        if (!track?.songId) throw new Error('Song is not available in the verified DJuke catalog.');
        const item = { songId: track.songId, title: nft.name || nft.title || track.title, artist: nft.artist || track.artist || track.uploader || '', audioUrl: `ipfs://${track.ipfsCid}`, listenPriceUnits: track.listenPriceUnits, mediaType: nft.mediaType || '' };
        const base = playlist ? await resolveTrackItems(playlist.songIds) : newName ? [] : draft.list();
        const items = appendPlaylistSong(base, item);
        if (playlist || newName) {
          const wallet = window._wallet;
          if (!wallet?.address || !wallet?.signer) throw new Error('Connect your wallet to save this playlist.');
          const own = playlist?.maker.toLowerCase() === wallet.address.toLowerCase();
          if (!own && ((ownLibrary?.madePlaylists?.length || 0) + (ownLibrary?.playlists?.length || 0)) >= DJUKE_PLAYLIST_MAX_PER_PROFILE) throw new Error('Your profile playlist library is full.');
          const revision = { id: own ? playlist.id : makePlaylistId(), maker: wallet.address.toLowerCase(), name: newName || playlist.name, revision: own ? playlist.revision + 1 : 1, songIds: items.map(song => song.songId) };
          busy = true; updateGate();
          try {
            const saved = await client.saveOriginal(revision);
            selectedRevision = saved.playlist;
            nameInput.value = revision.name;
            await refreshProfile(wallet.address);
          } finally { busy = false; updateGate(); }
        }
        draft.replace(items);
        event('djuke-set-playlist-draft', { items });
        renderDraft();
        state.textContent = playlist || newName ? 'Saved a new immutable revision and loaded it into the draft.' : 'Added to the current draft. Name and save it when ready.';
        report(state.textContent);
      } });
  }, { capture: true });

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
      const item = { songId: track.songId, title: track.title || 'Untitled song', artist: track.artist || track.uploader || '', audioUrl: `ipfs://${track.ipfsCid}`, listenPriceUnits: track.listenPriceUnits, mediaType: track.mediaType || '' };
      if (draft.list().length >= 24) throw new Error('Named playlists hold up to 24 songs.');
      if (!draft.add(item)) { state.textContent = 'That song is already in the draft.'; return; }
      event('djuke-set-playlist-draft', { items: draft.list() });
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
    const selected = { songIds: draft.list().map(item => item.songId) };
    await run(async () => {
      const items = await resolveTrackItems(selected.songIds);
      if (!window._wallet?.signer) await window._wallet?.connect?.();
      if (!window._wallet?.signer) throw new Error('Connect your wallet in the page header');
      await purchasePrivateNamedPlaylist({ playlist: selected, signer: window._wallet.signer, onStep: text => { state.textContent = text; } });
      event('djuke-private-playlist-purchased', { items });
      state.textContent = 'Personal Play purchased. Playing every song in order, just for you.';
    });
  });
  radioButton?.addEventListener('click', async () => {
    const selected = { songIds: draft.list().map(item => item.songId) };
    await run(async () => {
      if (!window._wallet?.signer) await window._wallet?.connect?.();
      if (!window._wallet?.signer) throw new Error('Connect your wallet in the page header');
      const purchase = await purchaseRadioNamedPlaylist({ playlist: selected, signer: window._wallet.signer, config: { ...config(), djukePlaylistRadioReady: config().djukePlaylistRadioReady === true && workerRadioReady }, onStep: text => { state.textContent = text; } });
      event('djuke-radio-playlist-purchased', { ...purchase, name: nameInput.value.trim() || 'Your playlist', songIds: selected.songIds });
      state.textContent = 'Purchase confirmed. Follow your Play Live receipt in your profile for delivery or refund; main paid requests can cut in.';
    });
  });
  const initialItems = draft.list();
  if (initialItems.length) event('djuke-playlist-draft-changed', { items: initialItems });
  renderDraft();
  void refreshPlaylistReadiness();
  setInterval(refreshPlaylistReadiness, 60000);
  if (window._wallet?.address) void refreshProfile(window._wallet.address);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initDjukePlaylists, { once: true });
  else initDjukePlaylists();
}
