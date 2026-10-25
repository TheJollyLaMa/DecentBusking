import { renderLivePerformances } from './live-performance-profile.mjs?v=20261024-live-prototype';
import { workerEnsProvider } from './ens-client.mjs?v=20261016-ens-worker';
import { getBaseReadProvider } from './base-chain.mjs?v=20261018-shared-provider';
import { buildCreatorAuthorizationMessage, creatorImageURL, creatorPresentation, normalizeCreatorProfile, resolveCreatorENS } from './creator-profile-data.mjs?v=20261025-seamless-handoff';
import { createBrowserIpfsUploader } from './ipfs-upload.js?v=20261015-mime-sniff';
import { canEditArtwork } from './artwork-update.mjs';
import { approveCreatorSplitProposal, createCreatorSplitProposal, fetchCreatorSplitProposal,
  completeCreatorSplitProposal, reconcileRemovedAlbumTrack } from './creator-split-proposal.mjs?v=20261025-song-splits';
import { buildAlbumSplitTypedData, buildSongAlbumMigrationTypedData, buildSongSplitTypedData, resolveNftSongId } from './creator-splits.mjs?v=20261025-song-splits';
import { audioCid, isMusicNft } from './nft-loader.js?v=20261025-song-identity';
import { createSplitEditor } from './creator-split-editor.mjs?v=20261025-song-splits';
import { PENCIL_ICON } from './artwork-edit-badge.mjs';
import { supportsDjukeAlbumsAndGas, DJUKE_SIGNING_DOMAIN_VERSION } from './djuke-version.mjs';
import { getCreatorWatchlistState, removeCreatorWatchlist, syncCreatorWatchlist } from './watchlist.mjs?v=20261025-seamless-handoff';
import { groupWatchlistByArtist } from './djuke-playlists.mjs?v=20261025-seamless-handoff';
import { FUND_LABELS, fetchWorkerEarnings, formatAmount, groupLogEarnings, readContractEarnings, scanLogEarnings,
  summarizeEarnings, verifyGroupedEarningsProofs } from './creator-earnings.mjs?v=20261023-djuke-v05';

import { renderWallet } from './wallet-label.mjs';

export const CREATOR_ALBUM_ABI = [
  'function getSong(bytes32) view returns ((string audioURI,bool enabled,address[] recipients,uint16[] sharesBps))',
  'function getAlbum(bytes32) view returns ((address mainOwner,string title,string manifestURI,uint256 revision,uint256 listenPrice,uint256 albumPrice,address[] recipients,uint16[] sharesBps,string[] positions,bytes32[] songIds))',
  'function createAlbum(bytes32,string,string,address[],uint16[],string[],uint256,uint256)',
  'function updateAlbumOwners(bytes32,address[],uint16[],string[],bytes[])',
  'function updateAlbumManifest(bytes32,string)',
  'function updateAlbumFees(bytes32,uint256,uint256)',
  'function syncAlbumSongSplits(bytes32,bytes32[])',
  'function removeAlbumSong(bytes32,bytes32)',
  'function moveAlbumSong(bytes32,bytes32,uint256)',
  'function songAlbum(bytes32) view returns (bytes32)',
  'function songHasCustomSplit(bytes32) view returns (bool)',
  'function migrateSongToAlbum(bytes32,bytes32,bytes[])',
  'error UnknownAlbum()',
  'error UnauthorizedAlbumEditor()',
  'error IncompleteAlbumSync()',
  'error InvalidAlbumMembership()',
  'error DuplicateAlbumSong()',
  'error InvalidAlbumTrackPosition()',
  'error SongNotInAlbum()',
  'error NonAdjacentAlbumMove()',
  'error SongUnavailable()',
  'error SongAlreadyInAlbum()',
  'error AlbumFull()',
  'error MissingMigrationApprovals()',
  'error MissingMigrationConsent()',
];

export function parseCreatorSplits(text) {
  const entries = text.trim().split('\n').filter(Boolean).map(line => {
    const [address, percent, ...positionParts] = line.split(',').map(value => value.trim());
    if (!/^0x[0-9a-fA-F]{40}$/.test(address || '') || !/^\d{1,3}(?:\.\d{1,2})?$/.test(percent || '')) throw new Error('Enter wallet, percentage, credit title on each line');
    const [whole, fraction = ''] = percent.split('.');
    const shares = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    const position = positionParts.join(', ');
    if (shares < 1 || shares > 10000 || position.length > 80) throw new Error('Invalid percentage or credit title');
    return { address, shares, position };
  });
  if (!entries.length || entries.length > 16 || entries.reduce((sum, entry) => sum + entry.shares, 0) !== 10000 ||
      new Set(entries.map(entry => entry.address.toLowerCase())).size !== entries.length) throw new Error('Use 1-16 distinct wallets with percentages totaling 100');
  return { recipients: entries.map(entry => entry.address), shares: entries.map(entry => entry.shares), positions: entries.map(entry => entry.position) };
}

const REMOVE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

export function displayArtist(value = '') {
  const text = String(value || '').trim();
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? `${text.slice(0, 6)}…${text.slice(-4)}` : (text || 'Unknown artist');
}

const sameAddresses = (left, right) => Array.isArray(left) && Array.isArray(right) &&
  left.length === right.length && left.every((value, index) =>
    String(value).toLowerCase() === String(right[index]).toLowerCase());

export function buildNftListItem({
  index = 0, title, subtitle = '', meta = '', artwork = '', fallback = '🎵',
  onOpen, onEdit = null, onSplits = null, onAlbumToggle = null, albumSelected = false, onRemove = null,
}) {
  const li = document.createElement('li');
  li.className = 'creator-nft-item';
  li.style.setProperty('--i', String(Math.min(index, 12)));
  const artWrap = document.createElement('div');
  artWrap.className = 'creator-nft-art-wrap';
  const art = document.createElement('button');
  art.type = 'button';
  art.className = 'creator-nft-art';
  art.title = 'Open NFT card';
  art.setAttribute('aria-label', `Open ${title}`);
  if (artwork) {
    const image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    image.src = artwork;
    image.addEventListener('error', () => { image.remove(); art.textContent = fallback; }, { once: true });
    art.append(image);
  } else {
    art.textContent = fallback;
  }
  art.addEventListener('click', () => onOpen?.());
  artWrap.append(art);
  if (onEdit) {
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'creator-nft-icon creator-nft-edit artwork-edit-badge';
    edit.title = 'Edit artwork';
    edit.setAttribute('aria-label', `Edit artwork for ${title}`);
    edit.innerHTML = PENCIL_ICON;
    edit.addEventListener('click', event => { event.stopPropagation(); onEdit(); });
    artWrap.append(edit);
  }
  const copy = document.createElement('div');
  copy.className = 'creator-nft-copy';
  const heading = document.createElement('strong');
  heading.textContent = title;
  const artist = document.createElement('span');
  artist.textContent = subtitle;
  const details = document.createElement('span');
  details.className = 'creator-nft-meta';
  details.textContent = meta;
  copy.append(heading, artist, details);
  if (onSplits) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.songSplitSelect = '';
    button.textContent = 'Collaborators & payments';
    button.setAttribute('aria-label', `Collaborators and payments for ${title}`);
    button.addEventListener('click', () => onSplits());
    copy.append(button);
  }
  if (onAlbumToggle) {
    const label = document.createElement('label');
    label.className = 'creator-nft-album-select';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = albumSelected;
    checkbox.addEventListener('click', event => event.stopPropagation());
    checkbox.addEventListener('change', () => onAlbumToggle(checkbox.checked));
    label.append(checkbox, document.createTextNode(' Select for album'));
    copy.append(label);
  }
  li.append(artWrap, copy);
  if (onRemove) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'creator-nft-icon creator-nft-remove';
    remove.title = 'Remove from watchlist';
    remove.setAttribute('aria-label', `Remove ${title} from watchlist`);
    remove.innerHTML = REMOVE_ICON;
    remove.addEventListener('click', () => onRemove());
    li.append(remove);
  }
  return li;
}

function receiptDate(transaction) {
  if (!transaction.timestamp) return `block ${Number(transaction.blockNumber).toLocaleString('en-US')}`;
  return new Date(transaction.timestamp * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Receipt-style ledger: every on-chain payout with a tx link and a running total that adds up to the line amount.
export function buildEarningsReceipt(entry, doc = document) {
  const transactions = entry.transactions || [];
  const details = doc.createElement('details');
  details.className = 'creator-earnings-receipt';
  const summary = doc.createElement('summary');
  summary.textContent = `View ${transactions.length} transaction${transactions.length === 1 ? '' : 's'}`;
  const table = doc.createElement('table');
  const songPlays = entry.kind === 'song-play';
  const head = doc.createElement('thead');
  const headRow = doc.createElement('tr');
  for (const heading of ['#', 'Date', songPlays ? 'Song' : 'Payout', 'Amount', 'Running total', 'Proof']) {
    headRow.append(Object.assign(doc.createElement('th'), { scope: 'col', textContent: heading }));
  }
  head.append(headRow);
  const body = doc.createElement('tbody');
  const chronological = [...transactions].sort((a, b) => a.blockNumber - b.blockNumber);
  let running = 0n;
  const rows = chronological.map((transaction, index) => {
    running += BigInt(transaction.units || 0);
    const row = doc.createElement('tr');
    const detail = songPlays
      ? (transaction.title || (transaction.requestId ? `Paid play #${transaction.requestId}` : 'Paid play'))
      : entry.label;
    const proofCell = doc.createElement('td');
    const anchor = Object.assign(doc.createElement('a'), { href: transaction.url, target: '_blank', rel: 'noopener',
      textContent: `${transaction.hash.slice(0, 10)}…`, title: `View transaction ${transaction.hash} on Basescan` });
    proofCell.append(anchor);
    row.append(
      Object.assign(doc.createElement('td'), { textContent: String(index + 1) }),
      Object.assign(doc.createElement('td'), { textContent: receiptDate(transaction) }),
      Object.assign(doc.createElement('td'), { textContent: detail }),
      Object.assign(doc.createElement('td'), { className: 'num', textContent: formatAmount(transaction.units, entry.asset) }),
      Object.assign(doc.createElement('td'), { className: 'num', textContent: formatAmount(running, entry.asset) }),
      proofCell);
    return row;
  });
  body.append(...rows.reverse());
  const foot = doc.createElement('tfoot');
  const footRow = doc.createElement('tr');
  footRow.append(
    Object.assign(doc.createElement('th'), { scope: 'row', colSpan: 3, textContent: `Total · ${transactions.length} payout${transactions.length === 1 ? '' : 's'}` }),
    Object.assign(doc.createElement('td'), { className: 'num', textContent: formatAmount(running, entry.asset) }),
    doc.createElement('td'),
    doc.createElement('td'));
  foot.append(footRow);
  table.append(head, body, foot);
  const wrap = doc.createElement('div');
  wrap.className = 'creator-earnings-receipt-scroll';
  wrap.append(table);
  details.append(summary, wrap);
  return details;
}

// When per-play receipts are available, they replace the contract's aggregate artistLedger total.
export function mergeLedgerReceipts(viewEntries, logEntries) {
  const notes = [];
  const kept = viewEntries.filter(view => {
    if (view.status !== 'paid' || view.proofLabel !== 'artistLedger') return true;
    const contract = String(view.key || '').split(':')[0].toLowerCase();
    const receipts = logEntries.find(entry => entry.kind === 'song-play' && String(entry.contract || '').toLowerCase() === contract);
    if (!receipts) return true;
    if (BigInt(receipts.units) !== BigInt(view.units)) {
      notes.push(`${view.label}: contract ledger reports ${formatAmount(view.units, view.asset)}; ${formatAmount(receipts.units, receipts.asset)} has tx receipts so far.`);
    }
    return false;
  });
  return { viewEntries: kept, note: notes.join(' ') };
}

export async function collectCreatorEarnings({
  ethers,
  address: target,
  serviceUrl = '',
  publicProvider,
  walletProvider = null,
  fetchImpl = globalThis.fetch,
  readContracts = readContractEarnings,
  fetchWorker = fetchWorkerEarnings,
  scanLogs = scanLogEarnings,
}) {
  let viewEntries = [];
  let viewNote = '';
  try {
    viewEntries = await readContracts({ ethers, provider: publicProvider, address: target });
  } catch {
    viewNote = 'DJuke song-play balances could not be read right now.';
  }
  let logs = null;
  let note = '';
  if (serviceUrl) {
    try {
      const worker = await fetchWorker({ fetch: fetchImpl, serviceUrl, address: target });
      const grouped = groupLogEarnings(worker.entries || [], ethers);
      const verified = grouped.length
        ? await verifyGroupedEarningsProofs({ ethers, provider: publicProvider, address: target, entries: grouped })
        : [];
      logs = { complete: !!worker.ready, partialThrough: worker.through, entries: verified };
      if (!worker.ready) note = worker.through ? `Indexing payouts… verified through block ${worker.through.toLocaleString('en-US')}.` : 'Indexing payouts…';
    } catch {
      note = 'Earnings index unavailable; checking on-chain fallbacks.';
    }
  }
  if (!logs) {
    logs = await scanLogs({ ethers, providers: [walletProvider, publicProvider], address: target });
    if (!logs.complete && !logs.partialThrough && !note) note = 'Earnings index unavailable; retrying on-chain fallbacks shortly.';
  }
  const unpaidFunds = Object.values(FUND_LABELS).filter(label => !logs.entries.some(entry => entry.label === label));
  if (!note) {
    note = logs.complete
      ? (unpaidFunds.length ? `No ${unpaidFunds.join(', ').replace(/, ([^,]*)$/, ' or $1')} payouts to this wallet on-chain yet.` : '')
      : logs.partialThrough
        ? `Router payouts verified through block ${logs.partialThrough.toLocaleString('en-US')}; connect a wallet on Base to check newer ones.`
        : 'Earnings index unavailable; retrying on-chain fallbacks shortly.';
  }
  return { viewEntries, logs, note: [viewNote, note].filter(Boolean).join(' ') };
}

export function initCreatorProfile() {
  const dialog = document.getElementById('creator-profile');
  if (!dialog) return;
  const status = dialog.querySelector('[data-profile-status]');
  const form = dialog.querySelector('[data-profile-form]');
  const albumForm = dialog.querySelector('[data-album-form]');
  const songSplitForm = dialog.querySelector('[data-song-split-form]');
  const songSplitTitle = dialog.querySelector('[data-song-split-title]');
  const songSplitCurrent = dialog.querySelector('[data-song-split-current]');
  const songSplitReview = dialog.querySelector('[data-song-split-review-text]');
  let reviewedSongRows = null;
  const songEditor = createSplitEditor(dialog.querySelector('[data-song-split-editor]'), {
    resolveName: name => workerEnsProvider.resolveName(name),
    onChange: () => {
      reviewedSongRows = null;
      songSplitReview.textContent = '';
      songSplitForm.querySelector('[data-song-split-propose]').disabled = true;
    },
  });
  const albumEditor = createSplitEditor(dialog.querySelector('[data-album-split-editor]'), {
    resolveName: name => workerEnsProvider.resolveName(name),
  });
  const editDialog = dialog.querySelector('[data-profile-edit-dialog]');
  const editStatus = dialog.querySelector('[data-profile-edit-status]');
  const bannerImage = dialog.querySelector('[data-profile-banner]');
  const bannerFallback = dialog.querySelector('[data-profile-banner-fallback]');
  const copyAddressButton = dialog.querySelector('[data-profile-copy-address]');
  const editButton = dialog.querySelector('[data-profile-edit]');
  const copiedNote = dialog.querySelector('[data-profile-copied]');
  let copiedTimer = null;
  const discordCode = dialog.querySelector('[data-discord-code]');
  const discordCopy = dialog.querySelector('[data-discord-copy]');
  const discordSteps = dialog.querySelector('[data-discord-steps]');
  const discordExpiry = dialog.querySelector('[data-discord-expiry]');
  const avatarBubbles = [...dialog.querySelectorAll('[data-profile-avatar-bubble]')];
  const value = name => form.elements.namedItem(name).value;
  const albumValue = name => albumForm.elements.namedItem(name).value;
  let address = '';
  let profile = {};
  let ens = null;
  let ensError = '';
  let ensLoading = false;
  let viewingOwnProfile = false;
  let revision = 0;
  let album = null;
  let selectedAlbumSongs = new Map();
  let selectedAlbumId = '';
  let nftBySongId = new Map();
  let albumSplitModes = new Map();
  let activeProposalId = '';
  let activeSong = null;
  let songSelection = 0;
  let busy = false;
  let bannerCandidates = [];
  let bannerCandidateIndex = 0;
  let discordLinkExpiryAt = 0;
  let discordLinkCountdownTimer = null;
  let discordLinkPollTimer = null;
  const config = () => window.DecentConfig || {};
  const service = () => String(config().ipfsUploadServiceUrl || '').replace(/\/$/, '');
  const editable = () => address && window._wallet?.address?.toLowerCase() === address.toLowerCase();
  const connectedSigner = () => {
    if (!window._wallet?.address || !window._wallet?.signer) throw new Error('Connect a wallet in the page header');
    return window._wallet.signer;
  };
  const renderAlbumSongSelection = () => {
    const enabled = config().djukeContractVersion === '0.6' && album &&
      !/^0x0{40}$/i.test(String(album.mainOwner || ''));
    if (albumSongSelection) albumSongSelection.hidden = !enabled;
    if (albumSongSelectionCount) albumSongSelectionCount.textContent = `${selectedAlbumSongs.size} selected`;
    setControls();
  };
  const message = text => { status.textContent = text; if (editStatus) editStatus.textContent = text; };
  const signer = () => {
    if (!editable() || !window._wallet?.signer) throw new Error('Connect the profile wallet in the page header');
    return window._wallet.signer;
  };
  const albumContractWith = activeSigner => {
    if (!supportsDjukeAlbumsAndGas(config().djukeContractVersion)) throw new Error('Album management requires a DJuke version with album support');
    return new ethers.Contract(config().djukeContractAddress, CREATOR_ALBUM_ABI, activeSigner);
  };
  const albumContract = () => albumContractWith(connectedSigner());
  const requireBase = async () => {
    if (Number((await connectedSigner().provider.getNetwork()).chainId) !== 8453) throw new Error('Switch to Base');
  };
  const setControls = () => {
    form.querySelectorAll('input, textarea, button').forEach(element => { element.disabled = busy || !editable(); });
    dialog.querySelector('[data-discord-link]').disabled = busy || !editable();
    if (copyAddressButton) copyAddressButton.hidden = !address;
    if (!editable() && editDialog?.open) editDialog.close();
    if (editButton) editButton.hidden = !editable();
    if (discordCopy) discordCopy.disabled = busy || !discordCode?.textContent;
    albumForm.querySelectorAll('input, textarea, button, select').forEach(element => {
      element.disabled = busy || !window._wallet?.signer || !supportsDjukeAlbumsAndGas(config().djukeContractVersion);
    });
    const songDisabled = busy || !window._wallet?.signer ||
      !supportsDjukeAlbumsAndGas(config().djukeContractVersion) ||
      !activeSong || !(activeSong.recipients.some(recipient => recipient.toLowerCase() === window._wallet?.address?.toLowerCase()) ||
        activeSong.creatorAddress === window._wallet?.address?.toLowerCase());
    songSplitForm.querySelectorAll('input, textarea, button, select').forEach(element => { element.disabled = songDisabled; });
    songSplitForm.querySelector('[data-song-split-propose]').disabled = songDisabled || !reviewedSongRows;
    songEditor.setDisabled(songDisabled);
    dialog.querySelectorAll('[data-song-split-select]').forEach(button => { button.disabled = busy || !editable(); });
    albumEditor.setDisabled(busy || !window._wallet?.signer || !supportsDjukeAlbumsAndGas(config().djukeContractVersion));
    const albumProposeButton = dialog.querySelector('[data-album-song-propose-selected]');
    if (albumProposeButton) albumProposeButton.disabled = busy || !window._wallet?.signer ||
      !selectedAlbumSongs.size || config().djukeContractVersion !== '0.6';
    dialog.querySelectorAll('[data-album-track-action]').forEach(button => {
      button.disabled = busy || !window._wallet?.signer || config().djukeContractVersion !== '0.6' ||
        !album || (button.dataset.albumTrackAction !== 'splits' &&
          album.mainOwner.toLowerCase() !== window._wallet?.address?.toLowerCase()) ||
        (button.dataset.albumTrackAction === 'up' && button.closest('li') === albumTrackList?.firstElementChild) ||
        (button.dataset.albumTrackAction === 'down' && button.closest('li') === albumTrackList?.lastElementChild);
    });
    const watchlistSection = dialog.querySelector('[data-watchlist-section]');
    if (watchlistSection) watchlistSection.hidden = !editable();
    if (myNftsSection) myNftsSection.hidden = !editable();
  };
  const watchlistSection = dialog.querySelector('[data-watchlist-section]');
  const watchlistCount = dialog.querySelector('[data-watchlist-count]');
  const watchlistStatus = dialog.querySelector('[data-watchlist-status]');
  const watchlistGroups = dialog.querySelector('[data-watchlist-groups]');
  const watchlistEmpty = dialog.querySelector('[data-watchlist-empty]');
  const myNftsSection = dialog.querySelector('[data-my-nfts-section]');
  const myNftsSearch = dialog.querySelector('[data-my-nfts-search]');
  const myNftsStatus = dialog.querySelector('[data-my-nfts-status]');
  const myNftsItems = dialog.querySelector('[data-my-nfts-items]');
  const myNftsCount = dialog.querySelector('[data-my-nfts-count]');
  const albumSongSelection = dialog.querySelector('[data-album-song-selection]');
  const albumSongSelectionCount = dialog.querySelector('[data-album-song-selection-count]');
  const albumSongSelectionStatus = dialog.querySelector('[data-album-song-selection-status]');
  const albumSongSelectionLinks = dialog.querySelector('[data-album-song-selection-links]');
  const albumTrackManagement = dialog.querySelector('[data-album-track-management]');
  const albumTrackList = dialog.querySelector('[data-album-track-list]');
  const splitApprovalSection = dialog.querySelector('[data-split-approval]');
  const splitProposalTitle = dialog.querySelector('[data-split-proposal-title]');
  const splitProposalDiff = dialog.querySelector('[data-split-proposal-diff]');
  const splitProposalProgress = dialog.querySelector('[data-split-proposal-progress]');
  const splitProposalStatus = dialog.querySelector('[data-split-proposal-status]');
  const splitProposalLink = dialog.querySelector('[data-split-proposal-link]');
  const splitProposalApprove = dialog.querySelector('[data-split-proposal-approve]');
  const songMigrationApply = dialog.querySelector('[data-song-migration-apply]');
  const renderAlbumTracks = () => {
    if (!albumTrackManagement || !albumTrackList) return;
    const songIds = album ? [...album.songIds] : [];
    const versionSupported = config().djukeContractVersion === '0.6';
    albumTrackManagement.hidden = !album || !versionSupported;
    albumTrackList.replaceChildren();
    if (!songIds.length) {
      const empty = document.createElement('li');
      empty.textContent = 'No tracks in this album yet.';
      albumTrackList.append(empty);
      return;
    }
    songIds.forEach((songId, index) => {
      const item = document.createElement('li');
      item.className = 'creator-album-track';
      const title = nftBySongId.get(songId.toLowerCase())?.name ||
        nftBySongId.get(songId.toLowerCase())?.title || `Song ${songId.slice(0, 10)}…`;
      const label = document.createElement('span');
      label.textContent = `${title} - ${albumSplitModes.get(songId.toLowerCase()) || 'Album default'}`;
      const actions = document.createElement('div');
      actions.className = 'creator-album-track-actions';
      for (const [action, text, disabled] of [
        ['splits', 'Collaborators & payments', false],
        ['up', '↑', index === 0],
        ['down', '↓', index === songIds.length - 1],
        ['remove', 'Remove', false],
      ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.dataset.albumTrackAction = action;
        button.dataset.songId = songId;
        button.disabled = busy || !window._wallet?.signer || !versionSupported ||
          (action !== 'splits' && album.mainOwner.toLowerCase() !== window._wallet.address.toLowerCase()) || disabled;
        button.setAttribute('aria-label', action === 'splits' ? `Collaborators and payments for album track ${title}` :
          action === 'remove' ? `Remove ${title} from album` :
          `${action === 'up' ? 'Move up' : 'Move down'} ${title}`);
        actions.append(button);
      }
      item.append(label, actions);
      albumTrackList.append(item);
    });
  };
  let activeProposal = null;
  let myNftsTimer = null;
  let myNftsAbort = null;
  const openNftCard = async identity => {
    try {
      const { openNFTByIdentity } = await import('./space.js?v=20261025-seamless-handoff');
      dialog.querySelector('[data-profile-close]')?.click();
      if (!await openNFTByIdentity(identity)) throw new Error('Could not open this NFT in the space view');
    } catch (error) {
      message(error.message);
    }
  };
  const proposalLink = requestId => {
    const url = new URL(config().appUrl || window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('splitProposal', requestId);
    return url.toString();
  };
  const renderSplitProposal = request => {
    activeProposal = request || null;
    if (!request) {
      if (splitApprovalSection) splitApprovalSection.hidden = true;
      return;
    }
    const owners = Array.isArray(request.owners) ? request.owners : [];
    const approvals = Array.isArray(request.approvals) ? request.approvals : [];
    const before = (request.currentRecipients || []).map((wallet, index) =>
      `${wallet} · ${Number(request.currentSharesBps?.[index] || 0) / 100}%${request.currentPositions?.[index] ? ` · ${request.currentPositions[index]}` : ''}`);
    const after = (request.recipients || []).map((wallet, index) =>
      `${wallet} · ${Number(request.sharesBps?.[index] || 0) / 100}%${request.positions?.[index] ? ` · ${request.positions[index]}` : ''}`);
    splitApprovalSection.hidden = false;
    splitProposalTitle.textContent = request.kind === 'album'
      ? `Album split approval · ${request.title}`
      : request.kind === 'migration'
        ? `Add song to album · ${request.title}`
        : `Song split approval · ${request.title}`;
    splitProposalDiff.textContent = `${request.kind === 'migration'
      ? request.useAlbumDefault ? 'This song will use the album default. ' : 'This song keeps its custom split; only album membership changes. '
      : ''}Current: ${before.join(' / ')}. Proposed: ${after.join(' / ')}.`;
    splitProposalProgress.textContent = `${approvals.length} of ${owners.length} current owners approved · ${request.status || 'pending'}`;
    const wallet = window._wallet?.address?.toLowerCase();
    splitProposalApprove.hidden = request.status !== 'pending' || !owners.some(owner => owner.toLowerCase() === wallet) ||
      approvals.some(entry => entry.address?.toLowerCase() === wallet);
    if (songMigrationApply) songMigrationApply.hidden = request.kind !== 'migration' ||
      request.status !== 'pending' || approvals.length !== owners.length;
    const href = proposalLink(request.requestId);
    splitProposalLink.href = href;
    splitProposalLink.textContent = 'Open shareable approval link';
    splitProposalLink.hidden = request.status !== 'pending';
    if (splitProposalStatus) splitProposalStatus.textContent = request.status !== 'pending'
      ? `This request is ${request.status}.`
      : approvals.length === owners.length
        ? 'All current payees approved. The owner can now apply this update in Admin → NFT Mint Queue. Payments stay unchanged until that transaction confirms.'
        : `Approval progress: ${approvals.length}/${owners.length}. Share this link with the remaining current payees. Newly added payees do not need to approve.`;
  };
  const refreshSplitProposal = async () => {
    if (!activeProposalId) throw new Error('Create or open a split proposal first');
    const { request } = await fetchCreatorSplitProposal({ serviceUrl: service(), requestId: activeProposalId });
    renderSplitProposal(request);
    return request;
  };
  const loadSplitProposal = async requestId => {
    activeProposalId = requestId;
    const request = await refreshSplitProposal();
    if (request.kind === 'album' || request.kind === 'migration') {
      albumForm.elements.namedItem('albumId').value = request.kind === 'album' ? request.resourceId : request.albumId;
      await loadAlbum();
    }
    else if (songSplitForm) {
      await loadSongSplitEditor({ djukeSongId: request.resourceId, name: request.title });
      songEditor.setRows(request.recipients.map((wallet, index) => ({
        wallet, shareBps: Number(request.sharesBps[index]), position: request.positions[index],
      })));
    }
    return request;
  };
  const renderWatchlist = () => {
    if (!watchlistSection || !watchlistStatus || !watchlistGroups) return;
    const state = getCreatorWatchlistState();
    const items = editable() ? (profile.watchlist || state.watchlist || []) : [];
    watchlistSection.hidden = !editable();
    if (watchlistCount) watchlistCount.textContent = String(items.length);
    if (!editable()) return;
    watchlistGroups.replaceChildren();
    if (state.loading && !items.length) {
      watchlistStatus.textContent = 'Loading your watchlist…';
      watchlistEmpty.hidden = false;
      watchlistEmpty.textContent = 'Loading…';
      return;
    }
    if (state.error && !items.length) {
      watchlistStatus.textContent = state.error;
      watchlistEmpty.hidden = false;
      watchlistEmpty.textContent = 'Could not load your watchlist.';
      return;
    }
    if (!items.length) {
      watchlistStatus.textContent = 'No saved songs yet.';
      watchlistEmpty.hidden = false;
      watchlistEmpty.textContent = 'Your saved songs will appear here.';
      return;
    }
    watchlistStatus.textContent = state.error || '';
    watchlistEmpty.hidden = true;
    groupWatchlistByArtist(items).forEach(({ artist, entries }) => {
      const group = document.createElement('section');
      group.className = 'watchlist-artist-group';
      const heading = document.createElement('h4');
      heading.textContent = artist;
      const list = document.createElement('ol');
      list.className = 'creator-nft-list';
      entries.forEach((entry, index) => {
        const title = entry.title || `Track #${entry.tokenId}`;
        list.append(buildNftListItem({
          index,
          title,
          subtitle: `#${entry.tokenId}`,
          meta: 'NFT bookmark · not a playlist purchase',
          artwork: creatorImageURL(entry.artworkURI || entry.image || '', config().ipfsGateway),
          fallback: '👀',
          onOpen: () => openNftCard(entry),
          onRemove: () => run(async () => {
            await removeCreatorWatchlist(entry);
            profile.watchlist = getCreatorWatchlistState().watchlist;
            renderWatchlist();
            message('Removed from watchlist');
          }),
        }));
      });
      group.append(heading, list);
      watchlistGroups.append(group);
    });
  };
  const renderMyNFTs = async () => {
    if (!myNftsSection || !myNftsStatus || !myNftsItems || !editable()) return;
    if (myNftsAbort) myNftsAbort.abort();
    myNftsAbort = new AbortController();
    const query = myNftsSearch?.value?.trim() || '';
    myNftsSection.hidden = false;
    myNftsStatus.textContent = 'Loading your NFTs…';
    myNftsItems.replaceChildren();
    try {
      const params = new URLSearchParams({ wallet: address, limit: '25', query });
      const response = await fetch(`${service()}/api/nfts?${params}`, { signal: myNftsAbort.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `NFTs unavailable (${response.status})`);
      const nfts = Array.isArray(result.nfts) ? result.nfts : [];
      for (const nft of nfts) {
        if (/^0x[0-9a-fA-F]{64}$/.test(nft.djukeSongId || '')) {
          nftBySongId.set(nft.djukeSongId.toLowerCase(), nft);
        }
      }
      myNftsItems.replaceChildren();
      if (!nfts.length) {
        myNftsStatus.textContent = query ? 'No matching NFTs found.' : 'No NFTs credit this wallet yet.';
        if (myNftsCount && !query) myNftsCount.textContent = '0';
        return;
      }
      myNftsStatus.textContent = query ? `${nfts.length} match${nfts.length === 1 ? '' : 'es'}` : 'Choose Collaborators & payments to edit a song. Tap artwork to open its card.';
      if (myNftsCount && !query) myNftsCount.textContent = String(nfts.length);
      nfts.forEach((nft, index) => {
        const title = nft.name || nft.title || `Track #${nft.tokenId}`;
        const minted = Date.parse(nft.mintedAt || '');
        const li = buildNftListItem({
          index,
          title,
          subtitle: displayArtist(nft.artistName || nft.artist || nft.creator),
          meta: `#${nft.tokenId}${Number.isFinite(minted) ? ` · ${new Date(minted).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}`,
          artwork: creatorImageURL(nft.image || nft.artworkCid || '', config().ipfsGateway),
          fallback: '🎵',
          onOpen: () => openNftCard(nft),
          onEdit: canEditArtwork(nft, address)
            ? () => document.dispatchEvent(new CustomEvent('open-artwork-editor', { detail: { nft } }))
            : null,
          onSplits: isMusicNft(nft) ? () => run(() => loadSongSplitEditor(nft)) : null,
          onAlbumToggle: config().djukeContractVersion === '0.6' && album && nft.djukeSongId &&
            ![...album.songIds].some(songId => songId.toLowerCase() === nft.djukeSongId.toLowerCase())
            ? checked => {
              if (checked) selectedAlbumSongs.set(nft.djukeSongId.toLowerCase(), nft);
              else selectedAlbumSongs.delete(nft.djukeSongId.toLowerCase());
              renderAlbumSongSelection();
            }
            : null,
          albumSelected: !!nft.djukeSongId && selectedAlbumSongs.has(nft.djukeSongId.toLowerCase()),
        });
        myNftsItems.append(li);
      });
      renderAlbumTracks();
      setControls();
    } catch (error) {
      if (error.name === 'AbortError') return;
      myNftsStatus.textContent = error.message;
    }
  };
  const formatRemaining = milliseconds => {
    const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  const clearDiscordLinkTimers = () => {
    if (discordLinkCountdownTimer) clearInterval(discordLinkCountdownTimer);
    if (discordLinkPollTimer) clearInterval(discordLinkPollTimer);
    discordLinkCountdownTimer = null;
    discordLinkPollTimer = null;
  };
  const renderDiscordLinkFlow = () => {
    if (!discordCode || !discordCopy || !discordSteps || !discordExpiry) return;
    const active = discordLinkExpiryAt > Date.now() && !!discordCode.textContent;
    discordSteps.hidden = !active;
    discordCode.hidden = !active;
    discordCopy.hidden = !active;
    if (!active) {
      discordExpiry.hidden = true;
      discordExpiry.textContent = '';
      return;
    }
    const remaining = discordLinkExpiryAt - Date.now();
    discordExpiry.hidden = false;
    discordExpiry.textContent = remaining > 0 ? `Link code expires in ${formatRemaining(remaining)}.` : 'Link code expired.';
    if (remaining <= 0) clearDiscordLinkTimers();
  };
  const refreshLinkedProfile = async () => {
    const response = await fetch(`${service()}/api/creator/profile?${new URLSearchParams({ address })}`, { signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (!response?.ok) return false;
    profile = await response.json();
    display();
    return !!profile.discord;
  };
  const startDiscordLinkPolling = expiresAt => {
    clearDiscordLinkTimers();
    discordLinkExpiryAt = expiresAt;
    renderDiscordLinkFlow();
    discordLinkCountdownTimer = setInterval(renderDiscordLinkFlow, 1000);
    discordLinkPollTimer = setInterval(async () => {
      if (!discordLinkExpiryAt || Date.now() >= discordLinkExpiryAt || profile.discord) {
        discordLinkExpiryAt = 0;
        clearDiscordLinkTimers();
        renderDiscordLinkFlow();
        if (profile.discord) message('Discord linked');
        return;
      }
      try {
        if (await refreshLinkedProfile()) {
          discordLinkExpiryAt = 0;
          clearDiscordLinkTimers();
          renderDiscordLinkFlow();
          message('Discord linked');
        }
      } catch {}
    }, 10_000);
  };
  const updateIdentityNotes = (presentation) => {
    const ensNote = dialog.querySelector('[data-profile-ens-note]');
    const mediaNote = dialog.querySelector('[data-profile-media-note]');
    if (ensNote) {
      if (ensLoading) {
        ensNote.hidden = false;
        ensNote.textContent = 'Checking ENS…';
      } else if (ensError) {
        ensNote.hidden = false;
        ensNote.textContent = 'ENS lookup is temporarily unavailable; this wallet-linked Profile is still available.';
      } else if (!ens?.name && !editable()) {
        ensNote.hidden = false;
        ensNote.textContent = 'No verified ENS name for this wallet.';
      } else if (!ens?.name) {
        ensNote.hidden = false;
        ensNote.innerHTML = 'No verified ENS name found. Optional: register one at <a href="https://app.ens.domains/" target="_blank" rel="noreferrer">app.ens.domains</a>, set it as the wallet primary name, and add avatar/banner records. Registering alone does not set the primary name or images.';
      } else if (presentation.avatarUnsupported || presentation.bannerUnsupported) {
        const unsupported = [presentation.avatarUnsupported && 'avatar', presentation.bannerUnsupported && 'banner'].filter(Boolean).join(' and ');
        ensNote.hidden = false;
        ensNote.textContent = `Verified ENS ${unsupported} record${unsupported.includes(' and ') ? 's are' : ' is'} unsupported here, so Profile is using another available image if present.`;
      } else {
        ensNote.hidden = true;
        ensNote.textContent = '';
      }
    }
    if (mediaNote) {
      mediaNote.hidden = true;
      mediaNote.textContent = '';
    }
  };
  const renderBanner = () => {
    if (!bannerImage || !bannerFallback) return;
    const uri = bannerCandidates[bannerCandidateIndex] || '';
    if (!uri) {
      bannerImage.hidden = true;
      bannerImage.removeAttribute('src');
      bannerFallback.hidden = false;
      return;
    }
    bannerFallback.hidden = true;
    bannerImage.hidden = false;
    bannerImage.src = uri;
  };
  const renderAvatarBubble = kind => {
    const button = dialog.querySelector(`[data-profile-avatar-bubble="${kind}"]`);
    const image = dialog.querySelector(`[data-profile-avatar-image="${kind}"]`);
    const plus = dialog.querySelector(`[data-profile-avatar-plus="${kind}"]`);
    const source = creatorImageURL(profile.discord && kind === 'discord' ? profile.discord.avatarURI : kind === 'ens' ? ens?.avatarURI : profile.avatarURI, config().ipfsGateway);
    if (!button || !image || !plus) return;
    const title = kind === 'ens' ? 'ENS avatar' : kind === 'discord' ? 'Discord avatar' : 'Uploaded avatar';
    button.title = source ? title : editable() ? `${title} missing — click to add` : title;
    button.hidden = !source && !editable();
    if (!source) {
      image.hidden = true;
      image.removeAttribute('src');
      plus.hidden = !editable();
      button.classList.toggle('is-placeholder', editable());
      return;
    }
    plus.hidden = true;
    button.classList.remove('is-placeholder');
    image.hidden = false;
    image.alt = title;
    image.src = source;
  };
  const display = () => {
    const presentation = creatorPresentation(profile, ens);
    const heading = ens?.name || (presentation.name !== 'Profile' ? presentation.name : '') || (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Profile');
    dialog.querySelector('[data-profile-name]').textContent = heading;
    renderWallet(dialog.querySelector('[data-profile-wallet]'), address);
    const altName = profile.displayName && profile.displayName !== heading ? profile.displayName : '';
    dialog.querySelector('[data-profile-ens]').textContent = altName;
    dialog.querySelector('[data-profile-discord]').textContent = profile.discord ? `Discord ${profile.discord.displayName}` : 'Discord not linked';
    const ensChip = dialog.querySelector('[data-profile-ens-chip]');
    if (ensChip) {
      ensChip.hidden = !ens?.name;
      ensChip.textContent = ens?.name ? `ENS ${ens.name}` : 'ENS';
    }
    dialog.querySelector('[data-profile-bio]').textContent = profile.bio || '';
    const copyButton = dialog.querySelector('[data-profile-copy-address]');
    if (copyButton) copyButton.hidden = !address;
    updateIdentityNotes(presentation);
    bannerCandidates = (presentation.bannerCandidates || []).map(source => creatorImageURL(source, config().ipfsGateway)).filter(Boolean);
    bannerCandidateIndex = 0;
    renderBanner();
    for (const kind of ['ens', 'discord', 'uploaded']) renderAvatarBubble(kind);
    for (const field of ['displayName', 'bio']) form.elements.namedItem(field).value = profile[field] || '';
    renderDiscordLinkFlow();
    setControls();
    renderWatchlist();
    void renderMyNFTs();
    renderAlbumSongSelection();
  };
  const run = async operation => {
    if (busy) return;
    busy = true;
    setControls();
    try { await operation(); } catch (error) {
      const known = {
        UnknownAlbum: 'Album not found.',
        UnauthorizedAlbumEditor: 'Only a current album collaborator, manager, or admin can change its split.',
        IncompleteAlbumSync: 'Sync the complete album song list.',
        InvalidAlbumMembership: 'The track is not a member of this album.',
        DuplicateAlbumSong: 'The album song list contains a duplicate track.',
        InvalidAlbumTrackPosition: 'Choose a valid album track position.',
        SongNotInAlbum: 'That track is not in the album.',
        NonAdjacentAlbumMove: 'Move a track one position at a time.',
        SongUnavailable: 'The registered song is unavailable.',
        SongAlreadyInAlbum: 'This song already belongs to an album.',
        AlbumFull: 'The album has reached its track limit.',
        MissingMigrationApprovals: 'Every current song collaborator must approve this migration.',
        MissingMigrationConsent: 'A current song collaborator approval is missing or stale.',
      };
      message(known[error?.revert?.name] || error?.shortMessage || error?.reason || error?.message || 'Operation failed');
    }
    finally { busy = false; setControls(); }
  };
  const request = async (action, nextProfile = {}) => {
    const captured = address;
    const activeSigner = signer();
    const body = { address: captured, origin: window.location.origin, action, profile: normalizeCreatorProfile(nextProfile),
      nonce: crypto.randomUUID(), issuedAt: new Date().toISOString() };
    const signature = await activeSigner.signMessage(buildCreatorAuthorizationMessage(body));
    if (!editable() || captured !== address || activeSigner !== window._wallet?.signer) throw new Error('Wallet changed; sign again');
    const endpoint = action === 'save' ? 'profile' : 'link-discord';
    const response = await fetch(`${service()}/api/creator/${endpoint}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, signature }), signal: AbortSignal.timeout(30000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Creator request failed');
    return result;
  };
  const loadProfileData = async ({ resolveEns = true } = {}) => {
    const check = revision;
    const response = await fetch(`${service()}/api/creator/profile?${new URLSearchParams({ address })}`, { signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (check !== revision) return;
    if (response?.ok) profile = await response.json();
    if (editable()) void syncCreatorWatchlist(address).catch(() => {});
    display();
    message(response?.ok ? '' : 'Profile service unavailable; ENS and read-only profile remain available');
    if (!resolveEns) return;
    let resolvedENS = null;
    try {
      resolvedENS = await resolveCreatorENS(address, workerEnsProvider);
    } catch (error) { ensError = error?.shortMessage || error?.reason || error?.message || 'ENS lookup unavailable'; resolvedENS = null; }
    if (check !== revision) return;
    ens = resolvedENS;
    ensLoading = false;
    display();
  };
  const earningsTotal = dialog.querySelector('[data-earnings-total]');
  const earningsStatus = dialog.querySelector('[data-earnings-status]');
  const earningsList = dialog.querySelector('[data-earnings-list]');
  const livePerformances = document.createElement('section');
  livePerformances.className = 'creator-live-performances';
  earningsList?.parentElement?.append(livePerformances);
  const link = (href, text) => Object.assign(document.createElement('a'), { href, textContent: text, target: '_blank', rel: 'noopener noreferrer' });
  const renderEarnings = (entries, note) => {
    if (!earningsList) return;
    earningsList.replaceChildren();
    const totals = summarizeEarnings(entries);
    const usdc = totals.USDC || { paid: 0n, unclaimed: 0n };
    earningsTotal.textContent = formatAmount(usdc.paid + usdc.unclaimed, 'USDC');
    const extra = Object.entries(totals).filter(([asset]) => asset !== 'USDC').map(([asset, value]) => formatAmount(value.paid + value.unclaimed, asset));
    for (const entry of entries.sort((a, b) => (b.units > a.units ? 1 : b.units < a.units ? -1 : 0))) {
      const item = document.createElement('li');
      const label = document.createElement('span');
      label.className = 'creator-earnings-label';
      label.textContent = entry.label;
      if (entry.count) label.append(Object.assign(document.createElement('small'), { textContent: ` · ${entry.count} payout${entry.count === 1 ? '' : 's'}` }));
      const amount = document.createElement('strong');
      amount.textContent = formatAmount(entry.units, entry.asset);
      const proof = document.createElement('span');
      proof.className = 'creator-earnings-proof';
      if (entry.status === 'unclaimed') proof.append(Object.assign(document.createElement('em'), { textContent: 'unclaimed · ' }));
      if (entry.proofUrl && !(entry.transactions || []).length) proof.append(link(entry.proofUrl, `proof: ${entry.proofLabel}`));
      if ((entry.transactions || []).length) proof.append(buildEarningsReceipt(entry));
      item.append(label, amount, proof);
      earningsList.append(item);
    }
    const unclaimed = usdc.unclaimed > 0n ? `${formatAmount(usdc.unclaimed, 'USDC')} earned but not yet claimed. ` : '';
    earningsStatus.textContent = `${entries.length ? '' : 'No earnings recorded on-chain yet. '}${unclaimed}${extra.length ? `Also ${extra.join(', ')}. ` : ''}${note || ''}`.trim();
  };
  const loadEarnings = async check => {
    if (!earningsList || !window.ethers) return;
    const target = address;
    earningsTotal.textContent = '…';
    earningsList.replaceChildren();
    earningsStatus.textContent = 'Reading DecentBusking contracts on Base…';
    const publicProvider = getBaseReadProvider({ ethers });
    try {
      let result;
      try {
        result = await collectCreatorEarnings({
          ethers,
          address: target,
          serviceUrl: config().ipfsUploadServiceUrl || '',
          publicProvider,
          walletProvider: window._wallet?.provider || null,
        });
      } catch {
        if (check === revision) earningsStatus.textContent = 'Base RPC unavailable; earnings could not be verified right now.';
        return;
      }
      if (check !== revision) return;
      const merged = mergeLedgerReceipts(result.viewEntries, result.logs.entries);
      renderEarnings([...merged.viewEntries, ...result.logs.entries], [merged.note, result.note].filter(Boolean).join(' '));
      const liveTarget = document.createElement('div');
      let liveReceipt;
      try {
        await renderLivePerformances({ container: liveTarget, wallet: address,
          serviceUrl: window.DecentConfig?.ipfsUploadServiceUrl || '', ethers: window.ethers,
          onReceipt: entry => { liveReceipt = entry; } });
        if (check === revision) {
          livePerformances.replaceChildren(liveTarget);
          if (liveReceipt) renderEarnings([...merged.viewEntries, ...result.logs.entries, liveReceipt], [merged.note, result.note].filter(Boolean).join(' '));
        }
      } catch { if (check === revision) livePerformances.textContent = 'Live performance bookings temporarily unavailable.'; }

    } finally { publicProvider.destroy(); }
  };
  const open = async detail => {
    const target = detail?.address || window._wallet?.address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(target || '')) { message('Connect your wallet in the page header'); if (!dialog.open) dialog.showModal(); return; }
    address = target;
    viewingOwnProfile = !detail?.address || editable();
    profile = {};
    ens = null;
    ensError = '';
    ensLoading = true;
    album = null;
    selectedAlbumSongs.clear();
    selectedAlbumId = '';
    nftBySongId.clear();
    albumSplitModes.clear();
    renderAlbumTracks();
    activeProposalId = '';
    activeSong = null;
    reviewedSongRows = null;
    albumEditor.setRows([{ wallet: window._wallet?.address || '', shareBps: 10000, position: 'Creator' }]);
    if (songSplitForm) songSplitForm.hidden = true;
    renderSplitProposal(null);
    renderAlbumSongSelection();
    clearDiscordLinkTimers();
    discordLinkExpiryAt = 0;
    const check = ++revision;
    if (!dialog.open) dialog.showModal();
    document.dispatchEvent(new CustomEvent('creator-profile-view-changed', { detail: { address } }));
    display();
    message('Loading profile');
    if (check !== revision) return;
    void loadEarnings(check).catch(() => {
      if (check !== revision) return;
      earningsTotal.textContent = '—';
      earningsStatus.textContent = 'Earnings could not be verified right now.';
    });
    await loadProfileData({ resolveEns: true });
    document.dispatchEvent(new CustomEvent('creator-profile-playlists-refresh', { detail: { address, editable: viewingOwnProfile } }));
    if (detail?.albumId) albumForm.elements.namedItem('albumId').value = detail.albumId;
    if (detail?.nft || detail?.songId) await loadSongSplitEditor(detail.nft || { djukeSongId: detail.songId });
    const proposalId = new URLSearchParams(window.location.search).get('splitProposal');
    if (proposalId) await loadSplitProposal(proposalId);
  };
  form.addEventListener('submit', event => {
    event.preventDefault();
    run(async () => {
      const captured = address;
      const next = { ...normalizeCreatorProfile(profile), displayName: value('displayName'), bio: value('bio') };
      const upload = createBrowserIpfsUploader({ provider: 'pinata', serviceUrl: service(), signer: signer(),
        address, origin: window.location.origin, purpose: 'submission' });
      for (const kind of ['avatar', 'banner']) {
        const file = form.elements.namedItem(kind).files[0];
        if (file) {
          if (file.size > 10 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('Use PNG, JPEG, WebP or GIF up to 10 MB');
          message(`Pinning ${kind} to IPFS`);
          next[`${kind}URI`] = await upload(file);
        }
        if (address !== captured || !editable()) throw new Error('Wallet changed during upload');
      }
      const result = await request('save', next);
      profile = result.profile;
      form.elements.namedItem('avatar').value = '';
      form.elements.namedItem('banner').value = '';
      display();
      message('Profile saved');
    });
  });
  dialog.querySelector('[data-discord-link]').addEventListener('click', () => run(async () => {
    const result = await request('link-discord');
   if (discordCode) {
     discordCode.textContent = `/creator-link code:${result.code}`;
     discordCode.hidden = false;
   }
   if (discordSteps) discordSteps.hidden = false;
   if (discordCopy) discordCopy.hidden = false;
   if (discordExpiry) {
     discordExpiry.hidden = false;
     discordExpiry.textContent = 'Link code expires in 5:00.';
   }
   message('Confirm this private code with the Discord bot within five minutes, then refresh');
   startDiscordLinkPolling(Date.parse(result.expiresAt));
  }));
  dialog.querySelector('[data-profile-close]').addEventListener('click', () => { revision++; clearDiscordLinkTimers(); editDialog?.close(); dialog.close(); });
  dialog.querySelector('[data-profile-edit-close]')?.addEventListener('click', () => editDialog?.close());
  editDialog?.addEventListener('click', event => { if (event.target === editDialog) editDialog.close(); });
  dialog.querySelector('[data-profile-copy-address]').addEventListener('click', async () => {
   if (!address) return;
   const copied = await navigator.clipboard.writeText(address).then(() => true, () => false);
   const text = copied ? 'Address copied!' : 'Copy failed — select the address manually';
   message(copied ? 'Wallet address copied' : text);
   if (copiedNote) {
     copiedNote.textContent = text;
     copiedNote.classList.add('is-visible');
     clearTimeout(copiedTimer);
     copiedTimer = setTimeout(() => copiedNote.classList.remove('is-visible'), 1800);
   }
  });
  const openEditor = () => {
   if (!editable() || !editDialog) return;
   if (!editDialog.open) editDialog.showModal();
   form.elements.namedItem('displayName')?.focus({ preventScroll: true });
  };
  editButton?.addEventListener('click', openEditor);
  dialog.querySelector('[data-discord-copy]').addEventListener('click', async () => {
   if (!discordCode?.textContent) return;
   await navigator.clipboard.writeText(discordCode.textContent).catch(() => {});
   message('Discord command copied');
  });
  avatarBubbles.forEach(button => button.addEventListener('click', () => {
   if (!editable()) return;
   const kind = button.dataset.profileAvatarBubble;
   if (kind === 'ens') window.open('https://app.ens.domains/', '_blank', 'noopener,noreferrer');
   else if (kind === 'discord') { openEditor(); dialog.querySelector('[data-discord-link]')?.click(); }
   else if (kind === 'uploaded') { openEditor(); form.elements.namedItem('avatar')?.click(); }
  }));
  bannerImage?.addEventListener('error', () => {
   bannerCandidateIndex += 1;
   if (bannerCandidateIndex < bannerCandidates.length) {
     renderBanner();
     return;
   }
   bannerImage.hidden = true;
   bannerImage.removeAttribute('src');
   if (bannerFallback) bannerFallback.hidden = false;
  });
  dialog.querySelectorAll('[data-profile-avatar-image]').forEach(image => image.addEventListener('error', () => {
   const kind = image.dataset.profileAvatarImage;
   const button = dialog.querySelector(`[data-profile-avatar-bubble="${kind}"]`);
   const plus = dialog.querySelector(`[data-profile-avatar-plus="${kind}"]`);
   image.hidden = true;
   image.removeAttribute('src');
   if (editable()) {
     if (button) button.classList.add('is-placeholder');
     if (plus) plus.hidden = false;
   } else if (button) {
     button.hidden = true;
   }
   const mediaNote = dialog.querySelector('[data-profile-media-note]');
   if (mediaNote) {
     mediaNote.hidden = false;
     const label = kind.replace(/^\w/, value => value.toUpperCase());
     mediaNote.textContent = `${label} image could not be loaded${editable() ? '; showing the add-avatar placeholder instead.' : '.'}`;
   }
  }));
  document.addEventListener('creator-watchlist-changed', event => {
   if (event.detail?.address && event.detail.address !== address.toLowerCase()) return;
   if (event.detail?.watchlist && editable()) profile.watchlist = event.detail.watchlist;
    renderWatchlist();
  });
  myNftsSearch?.addEventListener('input', () => {
   clearTimeout(myNftsTimer);
   myNftsTimer = setTimeout(() => { void renderMyNFTs(); }, 250);
  });
  const loadSongSplitEditor = async nft => {
    const selection = ++songSelection;
    const profileRevision = revision;
    const deployment = config().djukeContractAddress;
    activeSong = null;
    reviewedSongRows = null;
    if (songSplitForm) songSplitForm.hidden = true;
    setControls();
    if (!nft || !songSplitForm) throw new Error('Choose an NFT song to edit');
    message(`Loading collaborators & payments for ${nft.name || nft.title || `NFT #${nft.tokenId}`}…`);
    const songId = await resolveNftSongId(nft, { config: config() });
    if (selection !== songSelection || profileRevision !== revision) return;
    nft = { ...nft, djukeSongId: songId };
    await requireBase();
    const contract = new ethers.Contract(config().djukeContractAddress, [
      'function getSong(bytes32) view returns ((string audioURI,bool enabled,address[] recipients,uint16[] sharesBps))',
      'function songAlbum(bytes32) view returns (bytes32)',
      'function songHasCustomSplit(bytes32) view returns (bool)',
    ], connectedSigner());
    const song = await contract.getSong(nft.djukeSongId);
    if (!song.audioURI || song.enabled === false) throw new Error('DJuke song is not registered or enabled');
    const expectedCid = audioCid(nft.videoUrl || nft.audioUrl || nft.animation_url);
    if (expectedCid && audioCid(song.audioURI) !== expectedCid) {
      throw new Error('This NFT recording does not match the registered DJuke song; payment editing is blocked');
    }
    const currentAlbumId = await contract.songAlbum(nft.djukeSongId);
    const inAlbum = currentAlbumId !== ethers.ZeroHash;
    const custom = config().djukeContractVersion === '0.6'
      ? await contract.songHasCustomSplit(nft.djukeSongId) : false;
    if (selection !== songSelection || profileRevision !== revision ||
        deployment !== config().djukeContractAddress) return;
    activeSong = { songId: nft.djukeSongId, title: nft.name || nft.title || `Song ${nft.tokenId}`, audioURI: song.audioURI,
      recipients: [...song.recipients], sharesBps: [...song.sharesBps].map(Number), nft,
      creatorAddress: String(nft.creator || nft.artist || '').toLowerCase() };
    setControls();
    message(`Editing collaborators & payments for ${activeSong?.title || nft.name || nft.title}`);
    songSplitForm.hidden = false;
    songSplitTitle.textContent = `Collaborators & payments: ${activeSong.title}`;
    dialog.querySelector('[data-song-split-identity]').textContent =
      `${nft.tokenId !== undefined ? `NFT #${nft.tokenId} · ` : ''}Song ID: ${activeSong.songId}`;
    dialog.querySelector('[data-song-split-mode]').textContent = inAlbum
      ? custom ? 'Custom song split. Album default changes will not overwrite this song.'
        : 'Uses album default. Saving a song-specific split makes this song independent of future album defaults.'
      : 'Standalone song. These changes apply only to this song.';
    songSplitForm.elements.namedItem('songId').value = activeSong.songId;
    const positions = new Map((nft.creatorSplits || []).map(entry => [String(entry.wallet || entry.address).toLowerCase(), entry.position || entry.title || '']));
    songEditor.setRows(activeSong.recipients.map((wallet, index) => ({
      wallet, shareBps: activeSong.sharesBps[index], position: positions.get(wallet.toLowerCase()) || '',
    })));
    songSplitCurrent.textContent = `Current on-chain split: ${activeSong.recipients.map((wallet, index) =>
      `${wallet} · ${activeSong.sharesBps[index] / 100}%`).join(' / ')}${activeSong.recipients.some(wallet =>
        wallet.toLowerCase() === window._wallet?.address?.toLowerCase()) ||
        activeSong.creatorAddress === window._wallet?.address?.toLowerCase()
        ? '' : ' · Only a current collaborator or the NFT creator can create an update proposal.'}`;
    if (inAlbum && config().djukeContractVersion !== '0.6') {
      activeSong = null;
      songSplitCurrent.textContent += ' · Individual album-song overrides require DJuke v0.6; this version only supports album-wide changes.';
    }
    setControls();
    songSplitForm.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const getAlbumId = () => {
    const value = albumValue('albumId').trim();
    return /^0x[0-9a-fA-F]{64}$/.test(value) ? value : value ? ethers.id(value) : '';
  };
  const loadAlbum = async () => {
    const contract = albumContract();
    await requireBase();
    const albumId = getAlbumId();
    if (!albumId) throw new Error('Enter an album ID or slug to load an album');
    album = await contract.getAlbum(albumId);
    if (album.mainOwner === ethers.ZeroAddress) throw new Error('Album not found');
    albumSplitModes = new Map(config().djukeContractVersion === '0.6'
      ? await Promise.all([...album.songIds].map(async songId => [
        songId.toLowerCase(), await contract.songHasCustomSplit(songId) ? 'Custom song split' : 'Uses album default',
      ])) : []);
    if (selectedAlbumId !== albumId.toLowerCase()) {
      selectedAlbumSongs.clear();
      selectedAlbumId = albumId.toLowerCase();
      if (albumSongSelectionLinks) albumSongSelectionLinks.replaceChildren();
      if (albumSongSelectionStatus) albumSongSelectionStatus.textContent = '';
    }
    albumForm.elements.namedItem('title').value = album.title;
    albumForm.elements.namedItem('manifest').value = album.manifestURI;
    albumForm.elements.namedItem('listenPrice').value = ethers.formatUnits(album.listenPrice, 6);
    albumForm.elements.namedItem('albumPrice').value = ethers.formatUnits(album.albumPrice, 6);
    albumEditor.setRows(album.recipients.map((wallet, index) => ({
      wallet, shareBps: Number(album.sharesBps[index]), position: album.positions[index],
    })));
    dialog.querySelector('[data-album-section]').open = true;
    albumForm.elements.namedItem('albumId').value = albumId;
    message(`Album revision ${album.revision}. Connected wallet ${album.recipients.some(recipient => recipient.toLowerCase() === window._wallet?.address?.toLowerCase()) ? 'is a current collaborator' : 'can review but cannot approve this split'}.`);
    renderAlbumTracks();
    renderAlbumSongSelection();
    void renderMyNFTs();
  };
  dialog.querySelector('[data-album-load]').addEventListener('click', () => run(loadAlbum));
  dialog.querySelector('[data-album-song-propose-selected]')?.addEventListener('click', () =>
    run(proposeSelectedAlbumSongs));
  albumTrackList?.addEventListener('click', event => {
    const button = event.target.closest('button[data-album-track-action]');
    if (!button) return;
    run(async () => {
      if (button.dataset.albumTrackAction === 'splits') {
        await loadSongSplitEditor(nftBySongId.get(button.dataset.songId.toLowerCase()) || {
          djukeSongId: button.dataset.songId, name: `Song ${button.dataset.songId.slice(0, 10)}`,
        });
        return;
      }
      await requireBase();
      const albumId = getAlbumId();
      const contract = albumContract();
      const current = await contract.getAlbum(albumId);
      if (current.mainOwner.toLowerCase() !== window._wallet?.address?.toLowerCase()) {
        throw new Error('Only the album manager can edit track order or remove a track');
      }
      const songIds = [...current.songIds];
      const index = songIds.findIndex(songId => songId.toLowerCase() === button.dataset.songId.toLowerCase());
      if (index < 0) throw new Error('Album track list changed; reload the album');
      let transaction;
      if (button.dataset.albumTrackAction === 'remove') {
        if (!window.confirm('Remove this song from the album? Its current payout split will remain unchanged.')) return;
        transaction = await contract.removeAlbumSong(albumId, songIds[index]);
      } else {
        const targetIndex = index + (button.dataset.albumTrackAction === 'up' ? -1 : 1);
        if (targetIndex < 0 || targetIndex >= songIds.length) throw new Error('Track is already at that end of the album');
        [songIds[index], songIds[targetIndex]] = [songIds[targetIndex], songIds[index]];
        transaction = await contract.moveAlbumSong(albumId, songIds[index], targetIndex);
      }
      const receipt = await transaction.wait();
      if (Number(receipt?.status) !== 1) throw new Error('Album track update did not confirm');
      await loadAlbum();
      if (button.dataset.albumTrackAction === 'remove') {
        try {
          await reconcileRemovedAlbumTrack({
            serviceUrl: service(),
            signer: connectedSigner(),
            address: window._wallet.address,
            albumId,
            songId: button.dataset.songId,
            txHash: receipt.hash || transaction.hash,
            origin: window.location.origin,
          });
        } catch (error) {
          throw new Error(`Track was removed on-chain, but NFT catalog metadata could not be refreshed: ${error.message}`);
        }
      }
      message(button.dataset.albumTrackAction === 'remove'
        ? 'Song removed from album; its current payout split was preserved.'
        : 'Album track order updated.');
    });
  });
  albumForm.addEventListener('submit', event => {
    event.preventDefault();
    run(async () => {
      const contract = albumContract();
      await requireBase();
      let albumId = getAlbumId();
      if (!albumId) {
        albumId = ethers.hexlify(ethers.randomBytes(32));
        albumForm.elements.namedItem('albumId').value = albumId;
      }
      const rows = await albumEditor.resolve();
      const transaction = await contract.createAlbum(albumId, albumValue('title'), albumValue('manifest'),
        rows.map(row => row.wallet), rows.map(row => row.shareBps), rows.map(row => row.position),
        ethers.parseUnits(albumValue('listenPrice'), 6), ethers.parseUnits(albumValue('albumPrice'), 6));
      if ((await transaction.wait())?.status !== 1) throw new Error('Album creation did not confirm');
      await loadAlbum();
    });
  });
  const proposal = async () => {
    await requireBase();
    const contract = albumContract();
    const albumId = getAlbumId();
    if (!albumId) throw new Error('Load or create an album first');
    const current = await contract.getAlbum(albumId);
    if (current.mainOwner === ethers.ZeroAddress) throw new Error('Album not found');
    const rows = await albumEditor.resolve();
    const split = { recipients: rows.map(row => row.wallet), shares: rows.map(row => row.shareBps), positions: rows.map(row => row.position) };
    const typedData = buildAlbumSplitTypedData({
      ethers,
      contractAddress: contract.target,
      albumId,
      revision: current.revision,
      recipients: split.recipients,
      sharesBps: split.shares,
      positions: split.positions,
    });
    return { contract, current, split, albumId, typedData };
  };
  const proposeSongAlbumMigration = async nft => {
    if (config().djukeContractVersion !== '0.6') throw new Error('Adding existing songs requires the DJuke v0.6 release');
    if (!album) throw new Error('Load the target album first');
    const wallet = window._wallet?.address?.toLowerCase();
    const contract = albumContract();
    const [song, currentAlbumId] = await Promise.all([
      contract.getSong(nft.djukeSongId),
      contract.songAlbum(nft.djukeSongId),
    ]);
    const useAlbumDefault = !await contract.songHasCustomSplit(nft.djukeSongId) &&
      song.recipients.length === 1 && Number(song.sharesBps[0]) === 10000;
    if (!song.audioURI || song.enabled === false) throw new Error('DJuke song is not registered or enabled');
    if (currentAlbumId !== ethers.ZeroHash) throw new Error('This song already belongs to an album');
    if (!song.recipients.some(recipient => recipient.toLowerCase() === wallet)) {
      throw new Error('Only a current song collaborator can start this migration proposal');
    }
    const typedData = buildSongAlbumMigrationTypedData({
      ethers,
      contractAddress: config().djukeContractAddress,
      albumId: getAlbumId(),
      songId: nft.djukeSongId,
      albumRevision: album.revision,
      audioURI: song.audioURI,
      currentRecipients: [...song.recipients],
      currentSharesBps: [...song.sharesBps].map(Number),
      albumRecipients: [...album.recipients],
      albumSharesBps: [...album.sharesBps].map(Number),
      albumPositions: [...album.positions],
      useAlbumDefault,
    });
    const response = await createCreatorSplitProposal({
      serviceUrl: service(),
      signer: connectedSigner(),
      address: window._wallet.address,
      proposal: {
        kind: 'migration',
        resourceId: nft.djukeSongId,
        albumId: getAlbumId(),
        revision: String(album.revision),
        title: nft.name || nft.title || `Track #${nft.tokenId}`,
        ...typedData,
      },
    });
    activeProposalId = response.request.requestId;
    renderSplitProposal(response.request);
    return response.request;
  };
  const proposeSelectedAlbumSongs = async () => {
    if (!selectedAlbumSongs.size) throw new Error('Select one or more registered songs first');
    if (!album) throw new Error('Load the target album first');
    albumSongSelectionLinks?.replaceChildren();
    const failures = [];
    let created = 0;
    for (const [songId, nft] of selectedAlbumSongs) {
      try {
        const request = await proposeSongAlbumMigration(nft);
        const link = document.createElement('a');
        link.href = proposalLink(request.requestId);
        link.textContent = `${request.title} · open approvals`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        albumSongSelectionLinks?.append(link);
        activeProposalId = request.requestId;
        renderSplitProposal(request);
        selectedAlbumSongs.delete(songId);
        created++;
      } catch (error) {
        failures.push(`${nft.name || nft.title || songId}: ${error.message}`);
      }
    }
    renderAlbumSongSelection();
    await renderMyNFTs();
    if (failures.length) throw new Error(`${created} proposals created. ${failures.join('; ')}`);
    if (created) {
      if (albumSongSelectionStatus) albumSongSelectionStatus.textContent =
        `${created} proposal${created === 1 ? '' : 's'} created. Share each approval link with the current song collaborators.`;
      message(`${created} song migration proposal${created === 1 ? '' : 's'} created. The album manager submits after all current song owners approve.`);
    }
  };
  songSplitForm.addEventListener('submit', event => event.preventDefault());
  songSplitForm.querySelector('[data-song-split-review]').addEventListener('click', () => run(async () => {
    if (!activeSong) throw new Error('Select a registered song in My NFTs first');
    const rows = await songEditor.resolve();
    reviewedSongRows = rows;
    songSplitReview.textContent = `Proposed for "${activeSong.title}": ${rows.map(row =>
      `${row.wallet} - ${row.shareBps / 100}%${row.position ? ` (${row.position})` : ''}`).join(' / ')}. Current payees must approve before the admin applies this on-chain.`;
  }));
  songSplitForm?.querySelector('[data-song-split-propose]')?.addEventListener('click', () => run(async () => {
    if (!activeSong) throw new Error('Open a registered DJuke song first');
    if (!reviewedSongRows) throw new Error('Review the collaborators and percentages first');
    await requireBase();
    const rows = reviewedSongRows;
    const split = { recipients: rows.map(row => row.wallet), sharesBps: rows.map(row => row.shareBps), positions: rows.map(row => row.position) };
    const typedData = buildSongSplitTypedData({
      ethers,
      contractAddress: config().djukeContractAddress,
      songId: activeSong.songId,
      audioURI: activeSong.audioURI,
      currentRecipients: activeSong.recipients,
      currentSharesBps: activeSong.sharesBps,
      ...split,
    });
    const response = await createCreatorSplitProposal({
      serviceUrl: service(),
      signer: connectedSigner(),
      address: window._wallet.address,
      proposal: {
        kind: 'song',
        resourceId: activeSong.songId,
        title: activeSong.title,
        nftContractAddress: activeSong.nft.contractAddress,
        nftTokenId: String(activeSong.nft.tokenId),
        ...split,
        ...typedData,
      },
    });
    activeProposalId = response.request.requestId;
    renderSplitProposal(response.request);
    message(response.request.approvals.length === response.request.owners.length
      ? 'Your signature approved the proposal. All current payees have approved; the request is ready in the owner Admin queue. No payments have changed yet.'
      : 'Proposal saved. Share the approval link with the remaining current payees before the owner applies the split.');
  }));
  dialog.querySelector('[data-album-sign]').addEventListener('click', () => run(async () => {
    const proposed = await proposal();
    const response = await createCreatorSplitProposal({
      serviceUrl: service(),
      signer: connectedSigner(),
      address: window._wallet.address,
      proposal: {
        kind: 'album',
        resourceId: proposed.albumId,
        revision: String(proposed.current.revision),
        title: proposed.current.title,
        recipients: proposed.split.recipients,
        sharesBps: proposed.split.shares,
        positions: proposed.split.positions,
        ...proposed.typedData,
      },
    });
    activeProposalId = response.request.requestId;
    renderSplitProposal(response.request);
    message('Proposal saved. Share the link with every current collaborator for gasless approvals.');
  }));
  splitProposalApprove?.addEventListener('click', () => run(async () => {
    if (!activeProposalId) throw new Error('Open a split approval link first');
    const response = await approveCreatorSplitProposal({
      serviceUrl: service(), signer: connectedSigner(), address: window._wallet.address, requestId: activeProposalId,
    });
    renderSplitProposal(response.request);
    message('Approval recorded. Share the same link with the remaining current owners.');
  }));
  dialog.querySelector('[data-split-proposal-refresh]')?.addEventListener('click', () => run(refreshSplitProposal));
  dialog.querySelector('[data-album-update]').addEventListener('click', () => run(async () => {
    if (!activeProposalId) throw new Error('Create a shared approval link before applying the split');
    const request = await refreshSplitProposal();
    if (request.kind !== 'album') throw new Error('Open an approved album split proposal first');
    const contract = albumContract();
    const albumId = getAlbumId();
    if (request.resourceId.toLowerCase() !== albumId.toLowerCase()) throw new Error('The shared proposal does not match this album');
    const current = await contract.getAlbum(albumId);
    const wallet = window._wallet?.address?.toLowerCase();
    const isAdmin = config().adminWalletAddress?.toLowerCase() === wallet;
    const isCurrentOwner = [...current.recipients].some(owner => owner.toLowerCase() === wallet);
    const isManager = current.mainOwner.toLowerCase() === wallet;
    if (config().djukeContractVersion === '0.6' ? !isCurrentOwner && !isAdmin && !isManager :
      current.mainOwner.toLowerCase() !== wallet) {
      throw new Error(config().djukeContractVersion === '0.6'
        ? 'Only a current album collaborator or admin can apply this split'
        : 'Only the album manager can apply this split');
    }
    if (String(current.revision) !== String(request.revision) &&
        !(BigInt(current.revision) === BigInt(request.revision) + 1n &&
          sameAddresses([...current.recipients], request.recipients) &&
          [...current.sharesBps].map(Number).every((share, index) => share === Number(request.sharesBps[index])) &&
          current.positions.length === request.positions.length &&
          [...current.positions].every((position, index) => position === request.positions[index]))) {
      throw new Error('Album changed after this proposal was created');
    }
    const approvals = request.owners.map(recipient => {
      const approval = request.approvals.find(entry => entry.address.toLowerCase() === recipient.toLowerCase());
      if (!approval) throw new Error(`Waiting for ${request.approvals.length} of ${request.owners.length} current-owner approvals`);
      return approval.signature;
    });
    let txHash = '';
    if (String(current.revision) === String(request.revision)) {
      const transaction = config().djukeContractVersion === '0.6'
        ? await contract.updateAlbumOwners(albumId, request.recipients, request.sharesBps, request.positions, approvals)
        : await contract.updateAlbumOwners(albumId, request.recipients, request.sharesBps, request.positions, approvals);
      const receipt = await transaction.wait();
      if (Number(receipt?.status) !== 1) throw new Error('Split change did not confirm');
      txHash = receipt.hash || transaction.hash;
    }
    const updated = await contract.getAlbum(albumId);
    if (updated.songIds.length) {
      message('Album split revision confirmed; syncing songs');
      const sync = config().djukeContractVersion === '0.6'
        ? await contract.syncAlbumSongSplits(albumId, [...updated.songIds])
        : await contract.syncAlbumSongSplits(albumId, [...updated.songIds]);
      const syncReceipt = await sync.wait();
      if (Number(syncReceipt?.status) !== 1) throw new Error('Split saved; song sync is pending. Retry after the album finishes syncing.');
      txHash = syncReceipt.hash || sync.hash;
    }
    if (!txHash) throw new Error('Album split update did not produce a verifiable transaction');
    await completeCreatorSplitProposal({
      serviceUrl: service(), signer: connectedSigner(), address: window._wallet.address,
      requestId: activeProposalId, txHash, origin: window.location.origin,
    });
    await refreshSplitProposal();
    await loadAlbum();
  }));
  songMigrationApply?.addEventListener('click', () => run(async () => {
    if (!activeProposalId) throw new Error('Open a shared song migration proposal first');
    const request = await refreshSplitProposal();
    if (request.kind !== 'migration') throw new Error('Open a song-to-album migration proposal first');
    const contract = albumContract();
    const target = await contract.getAlbum(request.albumId);
    if (target.mainOwner.toLowerCase() !== window._wallet?.address?.toLowerCase()) {
      throw new Error('Only the album manager can submit this migration');
    }
    if (String(target.revision) !== String(request.revision)) throw new Error('Album changed after this proposal was created');
    const approvals = request.owners.map(owner => {
      const approval = request.approvals.find(entry => entry.address.toLowerCase() === owner.toLowerCase());
      if (!approval) throw new Error(`Waiting for ${request.approvals.length} of ${request.owners.length} current-owner approvals`);
      return approval.signature;
    });
    const songAlbum = await contract.songAlbum(request.resourceId);
    if (songAlbum === ethers.ZeroHash) {
      const transaction = await contract.migrateSongToAlbum(request.albumId, request.resourceId, approvals);
      const receipt = await transaction.wait();
      if (Number(receipt?.status) !== 1) throw new Error('Song migration did not confirm');
      await completeCreatorSplitProposal({
        serviceUrl: service(), signer: connectedSigner(), address: window._wallet.address,
        requestId: activeProposalId, txHash: receipt.hash || transaction.hash, origin: window.location.origin,
      });
    } else if (songAlbum.toLowerCase() !== request.albumId.toLowerCase()) {
      throw new Error('Song has already been assigned to another album');
    } else {
      throw new Error('Song migration is already on-chain; refresh the proposal status');
    }
    await refreshSplitProposal();
    await loadAlbum();
  }));
  dialog.querySelector('[data-album-metadata]').addEventListener('click', () => run(async () => {
    await requireBase();
    const contract = albumContract();
    const current = await contract.getAlbum(getAlbumId());
    if (current.mainOwner.toLowerCase() !== window._wallet?.address?.toLowerCase()) throw new Error('Only the album manager can apply changes');
    const manifest = await contract.updateAlbumManifest(getAlbumId(), albumValue('manifest'));
    if ((await manifest.wait())?.status !== 1) throw new Error('Manifest update did not confirm');
    const fees = await contract.updateAlbumFees(getAlbumId(), ethers.parseUnits(albumValue('listenPrice'), 6), ethers.parseUnits(albumValue('albumPrice'), 6));
    if ((await fees.wait())?.status !== 1) throw new Error('Manifest saved; fee update did not confirm');
    await loadAlbum();
  }));
  dialog.querySelector('[data-album-sync]').addEventListener('click', () => run(async () => {
    await requireBase();
    const contract = albumContract();
    const albumId = getAlbumId();
    const current = await contract.getAlbum(albumId);
    const wallet = window._wallet?.address?.toLowerCase();
    const isManager = current.mainOwner.toLowerCase() === wallet;
    if (config().djukeContractVersion !== '0.6' && !isManager) {
      throw new Error('Only the album manager can sync splits');
    }
    if (!current.songIds.length) throw new Error('No album songs to sync');
    const transaction = config().djukeContractVersion === '0.6'
      ? await contract.syncAlbumSongSplits(albumId, [...current.songIds])
      : await contract.syncAlbumSongSplits(getAlbumId(), [...current.songIds]);
    if ((await transaction.wait())?.status !== 1) throw new Error('Song split sync did not confirm');
    await loadAlbum();
  }));
  document.addEventListener('open-creator-profile', event => { run(() => open(event.detail)); });
  document.addEventListener('wallet-connected', event => {
    revision++;
    setControls();
    if (dialog.open && viewingOwnProfile) void run(() => open({}));
    else if (dialog.open) display();
  });
  document.addEventListener('click', event => {
    const button = event.target.closest?.('.nft-creator-profile');
    if (button) run(() => open({ address: button.dataset.creator, albumId: button.dataset.album }));
  });
  document.getElementById('djuke-profile')?.addEventListener('click', () => { run(() => open({})); });
  document.addEventListener('wallet-disconnected', () => { revision++; setControls(); });
  const linkedProposal = new URLSearchParams(window.location.search).get('splitProposal');
  if (linkedProposal) {
    if (window._wallet?.address) void run(() => open({}));
    else {
      if (!dialog.open) dialog.showModal();
      message('Connect your wallet in the page header to review the shared split proposal.');
    }
  }
  import('https://cdn.jsdelivr.net/npm/lucide@0.468.0/+esm').then(icons => {
    for (const element of dialog.querySelectorAll('[data-profile-icon]')) {
      const icon = icons[element.dataset.profileIcon];
      if (icon) element.replaceChildren(icons.createElement(icon, { 'aria-hidden': 'true' }));
    }
  }).catch(() => {});
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initCreatorProfile); else initCreatorProfile();
}