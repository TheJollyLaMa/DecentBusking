// Public totals from the Left Ankh and connected-wallet history from the Right Ankh.
import { formatUsdcUnits as usdc } from './usdc-format.mjs?v=20261017-mercury-release';

let dialog;
let weekSelect;
let content;
let reports = [];
let mode = 'totals';
let wallet = '';
let titleEl;
let noteEl;
let searchInput;
let artistSelect;
let fromInput;
let toInput;
let rewardsEl;
let viewSelect;
let fundingState = null;
const openSections = new Map();
let requestId = 0;
let fundingRequestId = 0;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Long tally sections collapse into dropdowns; a reader's open/closed choice survives search re-renders.
function section(key, title, summary, defaultOpen) {
  const details = element('details', 'radio-history-section');
  details.setAttribute('data-section', key);
  const forced = viewSelect?.value === key;
  details.open = forced || (openSections.has(key) ? openSections.get(key) : defaultOpen);
  details.addEventListener('toggle', () => { openSections.set(key, details.open); });
  const head = element('summary');
  head.append(element('span', 'radio-history-section-title', title), element('small', 'radio-history-section-summary', summary));
  const body = element('div', 'radio-history-section-body');
  details.append(head, body);
  return { details, body };
}

function shows(key) {
  return !viewSelect?.value || viewSelect.value === key;
}

function searchText() {
  return (searchInput?.value || '').trim().toLocaleLowerCase();
}

function renderFundingTable(rows, headers, className) {
  const table = element('table', `radio-history-table radio-history-funding-table ${className}`);
  const head = element('thead');
  const headerRow = element('tr');
  for (const label of headers) headerRow.append(element('th', '', label));
  head.append(headerRow);
  const body = element('tbody');
  if (!rows.length) {
    const row = element('tr');
    const cell = element('td', 'radio-history-empty', 'No eligible songs recorded for this New York week yet.');
    cell.setAttribute('colspan', String(headers.length));
    row.append(cell); body.append(row);
  } else {
    for (const values of rows) {
      const row = element('tr');
      for (const [index, value] of values.entries()) row.append(element('td', index > 0 ? 'radio-history-number' : '', value));
      body.append(row);
    }
  }
  table.append(head, body);
  const scroll = element('div', 'radio-history-table-scroll');
  scroll.append(table);
  return scroll;
}

async function loadArtistFunding(service, currentRequest, address, showLoading = true) {
  if (!rewardsEl || mode !== 'personal') return;
  const fundingRequest = ++fundingRequestId;
  if (showLoading) rewardsEl.replaceChildren(element('p', '', 'Loading current-week funding estimates...'));
  try {
    const response = await fetch(`${service}/api/payroll/weekly?${new URLSearchParams({ wallet: address })}`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    const state = await response.json();
    if (currentRequest !== requestId || fundingRequest !== fundingRequestId || mode !== 'personal' || window._wallet?.address?.toLowerCase() !== address.toLowerCase()) return;
    if (!response.ok || !state.ready || state.chainId !== 8453 || state.timeZone !== 'America/New_York' || state.lastError) throw new Error(state.lastError || 'Funding estimates are not available yet');
    fundingState = { address, state };
    renderFunding();
  } catch (error) {
    if (currentRequest === requestId && fundingRequest === fundingRequestId && mode === 'personal') {
      fundingState = null;
      rewardsEl.replaceChildren(element('p', 'radio-history-note', `${error.message}. Song totals remain available.`));
    }
  }
}

function renderFunding() {
  if (!rewardsEl || mode !== 'personal' || !fundingState) return;
  if (!shows('funding')) { rewardsEl.replaceChildren(); return; }
  const { address, state } = fundingState;
  const funds = Object.entries(state.funds || {});
  let yourTotal = 0n;
  const fundingRows = funds.map(([category, fund]) => {
    const share = fund.estimatedShares.find(entry => entry.wallet.toLowerCase() === address.toLowerCase());
    const amount = BigInt(share?.amountUnits || '0');
    yourTotal += amount;
    return [category === 'playback' ? 'Playback' : 'Top 10 votes', `${usdc(fund.balanceUnits)} USDC`,
      `${usdc(fund.reservedUnits)} USDC`, `${usdc(fund.availableUnits)} USDC`, `${usdc(amount)} USDC${share && !share.payable ? ' · below minimum' : ''}`];
  });
  const { details, body } = section('funding', `Weekly funding & estimates · ${state.currentPeriod.week}`,
    `Your estimate ${usdc(yourTotal)} USDC · provisional`, false);
  body.append(element('p', 'radio-history-note', `Next close: ${new Date(state.nextCloseAt).toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' })}${state.partial ? ' · partial first tracking week' : ''}`));
  body.append(element('h4', '', 'Allocation funds'), renderFundingTable(fundingRows,
    ['Fund', 'Balance', 'Committed', 'Available', 'Your estimate'], 'radio-history-fund-balances'));
  const warnings = funds.filter(([, fund]) => fund.warning).map(([category, fund]) =>
    `${category === 'playback' ? 'Playback' : 'Top 10'}: ${fund.warning}`);
  if (warnings.length) body.append(element('p', 'payroll-funding-warning', warnings.join(' · ')));
  body.append(element('h4', '', 'Your song estimates · playback only'));
  const query = searchText();
  const songs = (state.currentSongs || []).filter(song => !query || String(song.title || '').toLocaleLowerCase().includes(query))
    .sort((first, second) => BigInt(second.estimatedPlaybackUnits || '0') > BigInt(first.estimatedPlaybackUnits || '0') ? 1
      : BigInt(second.estimatedPlaybackUnits || '0') < BigInt(first.estimatedPlaybackUnits || '0') ? -1 : first.title.localeCompare(second.title));
  body.append(renderFundingTable(songs.map(song => [song.title, String(song.plays), String(song.votes), `${usdc(song.estimatedPlaybackUnits || '0')} USDC`]),
    ['Song', 'Plays', 'Net votes', 'Est. playback share'], 'radio-history-song-estimates'));
  body.append(element('p', 'radio-history-note', 'Top 10 prize estimates are per artist wallet, ranked by weekly net votes; they are not per-song playback amounts. All estimates are provisional, not accrued debt or claimable funds. Activity, available funds and earlier commitments can change the result. Owner review and wallet-confirmed payout are required after close. The tally period below is separate.'));
  rewardsEl.replaceChildren(details);
}

function renderWeek() {
  const report = reports.find((entry) => entry.week === weekSelect.value);
  content.replaceChildren();
  if (!report) {
    content.append(element('p', 'radio-history-empty', 'No playback tally has been recorded yet.'));
    return;
  }

  const selectedArtist = artistSelect.value;
  const artists = [...new Set(report.tracks.map((track) => track.artist))].sort((first, second) => first.localeCompare(second));
  artistSelect.replaceChildren(element('option', '', 'All artists'));
  artistSelect.options[0].value = '';
  for (const artist of artists) {
    const option = element('option', '', artist);
    option.value = artist;
    artistSelect.append(option);
  }
  artistSelect.value = artists.includes(selectedArtist) ? selectedArtist : '';

  const query = searchText();
  const artistKey = artistSelect.value;
  const from = fromInput.value;
  const to = toInput.value;
  const filtered = report.tracks.filter((track) => {
    const textMatch = !query || `${track.title} ${track.artist}`.toLocaleLowerCase().includes(query);
    const artistMatch = !artistKey || track.artist === artistKey;
    const uploadDate = track.uploadedAt?.slice(0, 10) || '';
    return textMatch && artistMatch && (!from || uploadDate >= from) && (!to || uploadDate <= to);
  });
  const filteredTotal = filtered.reduce((sum, track) => sum + track.plays, 0);
  const allTime = report.week === 'all-time';
  const countMessage = query || artistKey || from || to
    ? `${filteredTotal} matching plays across ${filtered.length} songs (${report.totalPlays} total ${allTime ? 'all time' : 'this week'})`
    : `${report.totalPlays} ${allTime ? 'recorded' : 'qualifying'} plays across ${report.trackCount} songs`;
  content.append(element('p', 'radio-history-total', countMessage));
  content.append(element('p', 'radio-history-note', allTime
    ? 'All-time plays, likes, and dislikes. Historical plays include legacy Discord announcement counts.'
    : 'Likes and dislikes are all-time totals; plays are for the selected UTC week.'));

  const artistTotals = new Map();
  for (const track of filtered) {
    const artist = artistTotals.get(track.artist) || { artist: track.artist, plays: 0, tracks: 0, likes: 0, dislikes: 0 };
    artist.plays += track.plays;
    artist.likes += track.likes || 0;
    artist.dislikes += track.dislikes || 0;
    artist.tracks++;
    artistTotals.set(track.artist, artist);
  }
  const artistRows = [...artistTotals.values()].sort((first, second) => second.plays - first.plays);
  if (shows('artists')) {
    const { details, body } = section('artists', 'By artist', `${artistRows.length} artist${artistRows.length === 1 ? '' : 's'}`, true);
    const artistTable = element('table', 'radio-history-table');
    const artistHead = element('thead');
    const artistHeader = element('tr');
    for (const title of ['Artist', 'Songs', 'Plays', 'Likes', 'Dislikes']) artistHeader.append(element('th', '', title));
    artistHead.append(artistHeader);
    const artistBody = element('tbody');
    for (const artist of artistRows) {
      const row = element('tr');
      row.append(element('td', '', artist.artist), element('td', '', String(artist.tracks)), element('td', '', String(artist.plays)),
        element('td', 'radio-history-number', String(artist.likes)), element('td', 'radio-history-number', String(artist.dislikes)));
      artistBody.append(row);
    }
    artistTable.append(artistHead, artistBody);
    const artistScroll = element('div', 'radio-history-table-scroll');
    artistScroll.append(artistTable);
    body.append(artistScroll);
    content.append(details);
  }

  if (shows('songs')) {
    const filtering = Boolean(query || artistKey || from || to);
    const { details, body } = section('songs', 'By song', `${filtered.length} song${filtered.length === 1 ? '' : 's'} · ${filteredTotal} plays`,
      filtering || filtered.length <= 10);
    const trackTable = element('table', 'radio-history-table radio-history-song-table');
    const trackHead = element('thead');
    const trackHeader = element('tr');
    for (const title of ['Song', 'Artist', 'Uploaded', 'Plays', 'Likes', 'Dislikes']) trackHeader.append(element('th', '', title));
    trackHead.append(trackHeader);
    const trackBody = element('tbody');
    for (const track of filtered) {
      const row = element('tr');
      const uploadDate = track.uploadedAt ? new Date(track.uploadedAt).toLocaleDateString() : '—';
      row.append(element('td', '', track.title), element('td', '', track.artist), element('td', '', uploadDate), element('td', '', String(track.plays)),
        element('td', 'radio-history-number', String(track.likes || 0)), element('td', 'radio-history-number', String(track.dislikes || 0)));
      trackBody.append(row);
    }
    trackTable.append(trackHead, trackBody);
    const trackScroll = element('div', 'radio-history-table-scroll');
    trackScroll.append(trackTable);
    body.append(trackScroll);
    content.append(details);
  }

  if (mode === 'personal' || report.adverts === undefined || !shows('adverts')) return;
  if (!Array.isArray(report.adverts)) {
    const { details, body } = section('adverts', 'Adverts', 'unavailable', false);
    body.append(element('p', 'radio-history-note', 'Advert vote tallies are unavailable right now.'));
    content.append(details);
    return;
  }
  const adverts = report.adverts.filter((advert) => !query || String(advert.title || '').toLocaleLowerCase().includes(query));
  const { details, body } = section('adverts', 'Adverts', `${adverts.length} advert${adverts.length === 1 ? '' : 's'}`, Boolean(query) && adverts.length > 0);
  content.append(details);
  if (!adverts.length) {
    body.append(element('p', 'radio-history-note', `No advert plays or votes recorded ${allTime ? 'yet' : 'this week'}${query ? ' matching your search' : ''}.`));
    return;
  }
  body.append(element('p', 'radio-history-note', 'Adverts are tallied separately and never compete in the Top 10. Counts cover recent advert plays retained by the radio worker.'));
  const advertTable = element('table', 'radio-history-table radio-history-advert-table');
  const advertHead = element('thead');
  const advertHeader = element('tr');
  for (const title of ['Advert', 'Plays', 'Up', 'Down', 'Net votes']) advertHeader.append(element('th', '', title));
  advertHead.append(advertHeader);
  const advertBody = element('tbody');
  for (const advert of adverts) {
    const row = element('tr');
    row.append(element('td', '', advert.title || `Advert #${advert.campaignId}`), element('td', '', String(advert.plays)),
      element('td', 'radio-history-number', String(advert.up)), element('td', 'radio-history-number', String(advert.down)),
      element('td', 'radio-history-number', `${advert.net > 0 ? '+' : ''}${advert.net}`));
    advertBody.append(row);
  }
  advertTable.append(advertHead, advertBody);
  const advertScroll = element('div', 'radio-history-table-scroll');
  advertScroll.append(advertTable);
  body.append(advertScroll);
}

function refresh() {
  renderWeek();
  renderFunding();
}

async function openHistory(event) {
  const currentRequest = ++requestId;
  mode = event?.detail?.mode === 'personal' ? 'personal' : 'totals';
  wallet = mode === 'personal' ? String(window._wallet?.address || '') : '';
  reports = [];
  fundingState = null;
  openSections.clear();
  weekSelect.replaceChildren();
  searchInput.value = '';
  if (viewSelect) {
    viewSelect.value = '';
    viewSelect.querySelector?.('option[value="funding"]')?.toggleAttribute?.('hidden', mode !== 'personal');
  }
  artistSelect.value = '';
  fromInput.value = '';
  toInput.value = '';
  if (!dialog.open) dialog.showModal();
  content.textContent = 'Loading playback tally…';
  if (titleEl) titleEl.textContent = mode === 'personal' ? 'My Playback Tally' : 'Playback Tally';
  if (rewardsEl) {
    rewardsEl.hidden = mode !== 'personal' || !/^0x[0-9a-fA-F]{40}$/.test(wallet);
    rewardsEl.replaceChildren();
  }
  if (noteEl) noteEl.textContent = mode === 'personal'
    ? `Playback tally for connected wallet ${wallet.slice(0, 6)}…${wallet.slice(-4)}`
    : 'Community playback tally';
  try {
    const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
    if (!service) throw new Error('Playback tally service is not configured');
    if (mode === 'personal' && !/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error('Connect your wallet to view My Playback Tally.');
    const query = new URLSearchParams({ weeks: '12', includeAllTime: '1' });
    query.set('calendar', 'new-york');
    if (wallet) query.set('wallet', wallet);
    const response = await fetch(`${service}/api/radio/history?${query}`, { cache: 'no-store' });
    const result = await response.json();
    if (currentRequest !== requestId) return;
    if (!response.ok) throw new Error(result.error || `History unavailable (${response.status})`);
    reports = Array.isArray(result.weeks) ? result.weeks : [];
    weekSelect.replaceChildren(...reports.slice().reverse().map((report) => {
      const option = document.createElement('option');
      option.value = report.week;
      option.textContent = report.week === 'all-time' ? 'All Time' : `${report.week}${report.current ? ' · current' : ''}`;
      return option;
    }));
    if (!reports.length) {
      content.textContent = 'No playback tally has been recorded yet.';
      return;
    }
    weekSelect.value = (reports.find(report => report.week === 'all-time') || reports.at(-1)).week;
    renderWeek();
    if (mode === 'personal') await loadArtistFunding(service, currentRequest, wallet);
  } catch (error) {
    if (currentRequest === requestId) content.textContent = error.message;
  }
}

function init() {
  dialog = document.getElementById('radio-history-dialog');
  weekSelect = document.getElementById('radio-history-week');
  content = document.getElementById('radio-history-content');
  titleEl = document.getElementById('radio-history-title');
  noteEl = dialog?.querySelector('.radio-history-note');
  searchInput = document.getElementById('radio-history-search');
  artistSelect = document.getElementById('radio-history-artist');
  fromInput = document.getElementById('radio-history-from');
  toInput = document.getElementById('radio-history-to');
  rewardsEl = document.getElementById('radio-history-rewards');
  viewSelect = document.getElementById('radio-history-view');
  if (!dialog || !weekSelect || !content) return;
  setInterval(() => {
    if (!dialog.open || mode !== 'personal' || !wallet) return;
    const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
    if (service) loadArtistFunding(service, requestId, wallet, false);
  }, 15000);
  document.addEventListener('open-radio-history', openHistory);
  document.addEventListener('wallet-connected', () => {
    if (dialog.open && mode === 'personal') openHistory({ detail: { mode: 'personal' } });
  });
  document.addEventListener('wallet-disconnected', () => {
    if (mode !== 'personal') return;
    ++requestId;
    reports = [];
    wallet = '';
    fundingState = null;
    content.replaceChildren();
    weekSelect.replaceChildren();
    if (rewardsEl) rewardsEl.hidden = true;
    if (dialog.open) dialog.close();
  });
  document.getElementById('radio-history-close')?.addEventListener('click', () => dialog.close());
  weekSelect.addEventListener('change', renderWeek);
  searchInput?.addEventListener('input', refresh);
  viewSelect?.addEventListener('change', refresh);
  artistSelect?.addEventListener('change', renderWeek);
  fromInput?.addEventListener('change', renderWeek);
  toInput?.addEventListener('change', renderWeek);
  dialog.addEventListener('click', (event) => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close();
  });
}

document.addEventListener('DOMContentLoaded', init, { once: true });
