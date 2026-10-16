import { workerEnsProvider } from './ens-client.mjs?v=20261016-ens-worker';
import { getBaseReadProvider } from './base-chain.mjs?v=20261018-shared-provider';
import { buildCreatorAuthorizationMessage, creatorImageURL, creatorPresentation, normalizeCreatorProfile, resolveCreatorENS } from './creator-profile-data.mjs?v=20261014-profile-card';
import { createBrowserIpfsUploader } from './ipfs-upload.js?v=20261015-mime-sniff';
import { canEditArtwork } from './artwork-update.mjs';
import { PENCIL_ICON } from './artwork-edit-badge.mjs';
import { supportsDjukeAlbumsAndGas, DJUKE_SIGNING_DOMAIN_VERSION } from './djuke-version.mjs';
import { getCreatorWatchlistState, removeCreatorWatchlist, syncCreatorWatchlist } from './watchlist.mjs';
import { FUND_LABELS, fetchWorkerEarnings, formatAmount, groupLogEarnings, readContractEarnings, scanLogEarnings,
  summarizeEarnings, verifyGroupedEarningsProofs } from './creator-earnings.mjs?v=20261015-usdc-cents';

const WALLET_BREATHE_ICON = 'img/Ens_Eth_Breathe.png';

// Shows 0x1234 + four breathing ENS/ETH icons + abcd in place of an ellipsis.
function renderWallet(element, address) {
  if (!element) return;
  element.replaceChildren();
  element.title = address || '';
  if (!address) return;
  const part = text => Object.assign(document.createElement('code'), { textContent: text });
  const icons = document.createElement('span');
  icons.className = 'creator-profile-wallet-icons';
  icons.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 4; i++) {
    const icon = Object.assign(document.createElement('img'), { src: WALLET_BREATHE_ICON, alt: '', loading: 'lazy' });
    icon.style.animationDelay = `${i * 0.25}s`;
    icons.append(icon);
  }
  element.setAttribute('aria-label', `Wallet ${address}`);
  element.append(part(address.slice(0, 6)), icons, part(address.slice(-4)));
}

export const CREATOR_ALBUM_ABI = [
  'function getAlbum(bytes32) view returns ((address mainOwner,string title,string manifestURI,uint256 revision,uint256 listenPrice,uint256 albumPrice,address[] recipients,uint16[] sharesBps,string[] positions,bytes32[] songIds))',
  'function createAlbum(bytes32,string,string,address[],uint16[],string[],uint256,uint256)',
  'function updateAlbumOwners(bytes32,address[],uint16[],string[],bytes[])',
  'function updateAlbumManifest(bytes32,string)',
  'function updateAlbumFees(bytes32,uint256,uint256)',
  'function syncAlbumSongSplits(bytes32,bytes32[])',
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

export function buildNftListItem({ index = 0, title, subtitle = '', meta = '', artwork = '', fallback = '🎵', onOpen, onEdit = null, onRemove = null }) {
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
  let busy = false;
  let bannerCandidates = [];
  let bannerCandidateIndex = 0;
  let discordLinkExpiryAt = 0;
  let discordLinkCountdownTimer = null;
  let discordLinkPollTimer = null;
  const config = () => window.DecentConfig || {};
  const service = () => String(config().ipfsUploadServiceUrl || '').replace(/\/$/, '');
  const editable = () => address && window._wallet?.address?.toLowerCase() === address.toLowerCase();
  const message = text => { status.textContent = text; if (editStatus) editStatus.textContent = text; };
  const signer = () => {
    if (!editable() || !window._wallet?.signer) throw new Error('Connect the profile wallet in the page header');
    return window._wallet.signer;
  };
  const albumContract = () => {
    if (!supportsDjukeAlbumsAndGas(config().djukeContractVersion)) throw new Error('Album management requires DJuke v0.2 or v0.3');
    return new ethers.Contract(config().djukeContractAddress, CREATOR_ALBUM_ABI, signer());
  };
  const requireBase = async () => {
    if (Number((await signer().provider.getNetwork()).chainId) !== 8453) throw new Error('Switch to Base');
  };
  const setControls = () => {
    form.querySelectorAll('input, textarea, button').forEach(element => { element.disabled = busy || !editable(); });
    dialog.querySelector('[data-discord-link]').disabled = busy || !editable();
    if (copyAddressButton) copyAddressButton.hidden = !address;
    if (!editable() && editDialog?.open) editDialog.close();
    if (editButton) editButton.hidden = !editable();
    if (discordCopy) discordCopy.disabled = busy || !discordCode?.textContent;
    albumForm.querySelectorAll('input, textarea, button').forEach(element => {
      element.disabled = busy || !editable() || !supportsDjukeAlbumsAndGas(config().djukeContractVersion);
    });
    const watchlistSection = dialog.querySelector('[data-watchlist-section]');
    if (watchlistSection) watchlistSection.hidden = !editable();
    if (myNftsSection) myNftsSection.hidden = !editable();
  };
  const watchlistSection = dialog.querySelector('[data-watchlist-section]');
  const watchlistCount = dialog.querySelector('[data-watchlist-count]');
  const watchlistStatus = dialog.querySelector('[data-watchlist-status]');
  const watchlistItems = dialog.querySelector('[data-watchlist-items]');
  const watchlistEmpty = dialog.querySelector('[data-watchlist-empty]');
  const myNftsSection = dialog.querySelector('[data-my-nfts-section]');
  const myNftsSearch = dialog.querySelector('[data-my-nfts-search]');
  const myNftsStatus = dialog.querySelector('[data-my-nfts-status]');
  const myNftsItems = dialog.querySelector('[data-my-nfts-items]');
  const myNftsCount = dialog.querySelector('[data-my-nfts-count]');
  let myNftsTimer = null;
  let myNftsAbort = null;
  const openNftCard = async identity => {
    try {
      const { openNFTByIdentity } = await import('./space.js?v=20261016-top10-eq');
      dialog.querySelector('[data-profile-close]')?.click();
      if (!await openNFTByIdentity(identity)) throw new Error('Could not open this NFT in the space view');
    } catch (error) {
      message(error.message);
    }
  };
  const renderWatchlist = () => {
    if (!watchlistSection || !watchlistStatus || !watchlistItems) return;
    const state = getCreatorWatchlistState();
    const items = editable() ? (profile.watchlist || state.watchlist || []) : [];
    watchlistSection.hidden = !editable();
    if (watchlistCount) watchlistCount.textContent = String(items.length);
    if (!editable()) return;
    watchlistItems.replaceChildren();
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
    const sorted = [...items].sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
    sorted.forEach((entry, index) => {
      const title = entry.title || `Track #${entry.tokenId}`;
      const li = buildNftListItem({
        index,
        title,
        subtitle: displayArtist(entry.artist || entry.creator),
        meta: `#${entry.tokenId}`,
        artwork: creatorImageURL(entry.artworkURI || entry.image || '', config().ipfsGateway),
        fallback: '👀',
        onOpen: () => openNftCard(entry),
        onRemove: () => run(async () => {
          await removeCreatorWatchlist(entry);
          profile.watchlist = getCreatorWatchlistState().watchlist;
          renderWatchlist();
          message('Removed from watchlist');
        }),
      });
      watchlistItems.append(li);
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
      const params = new URLSearchParams({ artist: address, limit: '25', query });
      const response = await fetch(`${service()}/api/nfts?${params}`, { signal: myNftsAbort.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `NFTs unavailable (${response.status})`);
      const nfts = Array.isArray(result.nfts) ? result.nfts : [];
      myNftsItems.replaceChildren();
      if (!nfts.length) {
        myNftsStatus.textContent = query ? 'No matching NFTs found.' : 'No NFTs minted from this wallet yet.';
        if (myNftsCount && !query) myNftsCount.textContent = '0';
        return;
      }
      myNftsStatus.textContent = query ? `${nfts.length} match${nfts.length === 1 ? '' : 'es'}` : 'Tap artwork to open its card · ✏️ edits artwork';
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
        });
        myNftsItems.append(li);
      });
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
  };
  const run = async operation => {
    if (busy) return;
    busy = true;
    setControls();
    try { await operation(); } catch (error) { message(error.shortMessage || error.reason || error.message); }
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
    clearDiscordLinkTimers();
    discordLinkExpiryAt = 0;
    const check = ++revision;
    if (!dialog.open) dialog.showModal();
    display();
    message('Loading profile');
    if (check !== revision) return;
    void loadEarnings(check).catch(() => {
      if (check !== revision) return;
      earningsTotal.textContent = '—';
      earningsStatus.textContent = 'Earnings could not be verified right now.';
    });
    await loadProfileData({ resolveEns: true });
    if (detail?.albumId) albumForm.elements.namedItem('albumId').value = detail.albumId;
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
  const getAlbumId = () => /^0x[0-9a-fA-F]{64}$/.test(albumValue('albumId')) ? albumValue('albumId') : ethers.id(albumValue('albumId').trim());
  const loadAlbum = async () => {
    const contract = albumContract();
    if (Number((await signer().provider.getNetwork()).chainId) !== 8453) throw new Error('Switch to Base');
    album = await contract.getAlbum(getAlbumId());
    if (album.mainOwner === ethers.ZeroAddress) throw new Error('Album not found');
    albumForm.elements.namedItem('title').value = album.title;
    albumForm.elements.namedItem('manifest').value = album.manifestURI;
    albumForm.elements.namedItem('listenPrice').value = ethers.formatUnits(album.listenPrice, 6);
    albumForm.elements.namedItem('albumPrice').value = ethers.formatUnits(album.albumPrice, 6);
    albumForm.elements.namedItem('splits').value = album.recipients.map((recipient, index) => `${recipient}, ${Number(album.sharesBps[index]) / 100}, ${album.positions[index]}`).join('\n');
    message(`Album revision ${album.revision}. ${album.mainOwner.toLowerCase() === address.toLowerCase() ? 'Manager access verified' : 'Collaborator signature access only'}`);
  };
  dialog.querySelector('[data-album-load]').addEventListener('click', () => run(loadAlbum));
  albumForm.addEventListener('submit', event => {
    event.preventDefault();
    run(async () => {
      const contract = albumContract();
      if (Number((await signer().provider.getNetwork()).chainId) !== 8453) throw new Error('Switch to Base');
      const split = parseCreatorSplits(albumValue('splits'));
      const transaction = await contract.createAlbum(getAlbumId(), albumValue('title'), albumValue('manifest'),
        split.recipients, split.shares, split.positions, ethers.parseUnits(albumValue('listenPrice'), 6), ethers.parseUnits(albumValue('albumPrice'), 6));
      if ((await transaction.wait())?.status !== 1) throw new Error('Album creation did not confirm');
      await loadAlbum();
    });
  });
  const proposal = async () => {
    await requireBase();
    const contract = albumContract();
    const albumId = getAlbumId();
    const current = await contract.getAlbum(albumId);
    const split = parseCreatorSplits(albumValue('splits'));
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const domain = { name: 'DecentJukeBox', version: DJUKE_SIGNING_DOMAIN_VERSION, chainId: 8453, verifyingContract: contract.target };
    const types = { AlbumSplit: [{ name: 'albumId', type: 'bytes32' }, { name: 'revision', type: 'uint256' },
      { name: 'recipientsHash', type: 'bytes32' }, { name: 'sharesHash', type: 'bytes32' }, { name: 'positionsHash', type: 'bytes32' }] };
    const data = { albumId, revision: current.revision, recipientsHash: ethers.keccak256(coder.encode(['address[]'], [split.recipients])),
      sharesHash: ethers.keccak256(coder.encode(['uint16[]'], [split.shares])), positionsHash: ethers.keccak256(coder.encode(['string[]'], [split.positions])) };
    return { contract, current, split, domain, types, data, albumId };
  };
  dialog.querySelector('[data-album-sign]').addEventListener('click', () => run(async () => {
    const proposed = await proposal();
    if (!proposed.current.recipients.some(recipient => recipient.toLowerCase() === address.toLowerCase())) throw new Error('Only current recipients can approve a split');
    const signature = await signer().signTypedData(proposed.domain, proposed.types, proposed.data);
    dialog.querySelector('[data-album-signature]').textContent = JSON.stringify({ address, albumId: proposed.albumId, revision: String(proposed.current.revision), signature });
    message('Approval signed. Share the proposal fields and this approval with the album manager');
  }));
  dialog.querySelector('[data-album-update]').addEventListener('click', () => run(async () => {
    const proposed = await proposal();
    if (proposed.current.mainOwner.toLowerCase() !== address.toLowerCase()) throw new Error('Only the album manager can apply changes');
    const supplied = JSON.parse(albumValue('approvals') || '[]');
    if (!Array.isArray(supplied)) throw new Error('Approvals must be a JSON array');
    const approvals = proposed.current.recipients.map(recipient => {
      const approval = supplied.find(entry => entry.address?.toLowerCase() === recipient.toLowerCase());
      if (!approval || approval.albumId !== proposed.albumId || String(approval.revision) !== String(proposed.current.revision)) throw new Error('Missing current-revision approval');
      return approval.signature;
    });
    const transaction = await proposed.contract.updateAlbumOwners(proposed.albumId, proposed.split.recipients, proposed.split.shares, proposed.split.positions, approvals);
    if ((await transaction.wait())?.status !== 1) throw new Error('Split change did not confirm');
    message('Split revision confirmed; syncing songs');
    if (proposed.current.songIds.length) {
      const sync = await proposed.contract.syncAlbumSongSplits(proposed.albumId, [...proposed.current.songIds]);
      if ((await sync.wait())?.status !== 1) throw new Error('Split saved; song sync is pending. Do not resubmit approvals');
    }
    await loadAlbum();
  }));
  dialog.querySelector('[data-album-metadata]').addEventListener('click', () => run(async () => {
    await requireBase();
    const contract = albumContract();
    const current = await contract.getAlbum(getAlbumId());
    if (current.mainOwner.toLowerCase() !== address.toLowerCase()) throw new Error('Only the album manager can apply changes');
    const manifest = await contract.updateAlbumManifest(getAlbumId(), albumValue('manifest'));
    if ((await manifest.wait())?.status !== 1) throw new Error('Manifest update did not confirm');
    const fees = await contract.updateAlbumFees(getAlbumId(), ethers.parseUnits(albumValue('listenPrice'), 6), ethers.parseUnits(albumValue('albumPrice'), 6));
    if ((await fees.wait())?.status !== 1) throw new Error('Manifest saved; fee update did not confirm');
    await loadAlbum();
  }));
  dialog.querySelector('[data-album-sync]').addEventListener('click', () => run(async () => {
    await requireBase();
    const contract = albumContract();
    const current = await contract.getAlbum(getAlbumId());
    if (current.mainOwner.toLowerCase() !== address.toLowerCase()) throw new Error('Only the album manager can sync splits');
    if (!current.songIds.length) throw new Error('No album songs to sync');
    const transaction = await contract.syncAlbumSongSplits(getAlbumId(), [...current.songIds]);
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