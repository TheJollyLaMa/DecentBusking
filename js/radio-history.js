// Public totals from the Left Ankh and connected-wallet history from the Right Ankh.

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

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function renderWeek() {
  const report = reports.find((entry) => entry.week === weekSelect.value);
  content.replaceChildren();
  if (!report) {
    content.append(element('p', 'radio-history-empty', 'No weekly play data has been recorded yet.'));
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

  const query = searchInput.value.trim().toLocaleLowerCase();
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
  const countMessage = query || artistKey || from || to
    ? `${filteredTotal} matching plays across ${filtered.length} songs (${report.totalPlays} total this week)`
    : `${report.totalPlays} qualifying plays across ${report.trackCount} songs`;
  content.append(element('p', 'radio-history-total', countMessage));

  const artistTotals = new Map();
  for (const track of filtered) {
    const artist = artistTotals.get(track.artist) || { artist: track.artist, plays: 0, tracks: 0 };
    artist.plays += track.plays;
    artist.tracks++;
    artistTotals.set(track.artist, artist);
  }
  const artistHeading = element('h3', '', 'By Artist');
  const artistTable = element('table', 'radio-history-table');
  const artistHead = element('thead');
  const artistHeader = element('tr');
  for (const title of ['Artist', 'Songs', 'Plays']) artistHeader.append(element('th', '', title));
  artistHead.append(artistHeader);
  const artistBody = element('tbody');
  for (const artist of [...artistTotals.values()].sort((first, second) => second.plays - first.plays)) {
    const row = element('tr');
    row.append(element('td', '', artist.artist), element('td', '', String(artist.tracks)), element('td', '', String(artist.plays)));
    artistBody.append(row);
  }
  artistTable.append(artistHead, artistBody);
  content.append(artistHeading, artistTable);

  const trackHeading = element('h3', '', 'By Song');
  const trackTable = element('table', 'radio-history-table');
  const trackHead = element('thead');
  const trackHeader = element('tr');
  for (const title of ['Song', 'Artist', 'Uploaded', 'Plays']) trackHeader.append(element('th', '', title));
  trackHead.append(trackHeader);
  const trackBody = element('tbody');
  for (const track of filtered) {
    const row = element('tr');
    const uploadDate = track.uploadedAt ? new Date(track.uploadedAt).toLocaleDateString() : '—';
    row.append(element('td', '', track.title), element('td', '', track.artist), element('td', '', uploadDate), element('td', '', String(track.plays)));
    trackBody.append(row);
  }
  trackTable.append(trackHead, trackBody);
  content.append(trackHeading, trackTable);
}

async function openHistory(event) {
  mode = event?.detail?.mode === 'personal' ? 'personal' : 'totals';
  wallet = mode === 'personal' ? String(event?.detail?.wallet || '') : '';
  searchInput.value = '';
  artistSelect.value = '';
  fromInput.value = '';
  toInput.value = '';
  if (!dialog.open) dialog.showModal();
  content.textContent = 'Loading play history…';
  if (titleEl) titleEl.textContent = mode === 'personal' ? '👤 My JukeLoop Play History' : '📊 JukeLoop Play Totals';
  if (noteEl) noteEl.textContent = mode === 'personal'
    ? `Plays for connected wallet ${wallet.slice(0, 6)}…${wallet.slice(-4)} · completed Discord plays with at least 30 audible seconds · UTC weeks`
    : 'Community totals · completed Discord plays with at least 30 audible seconds · UTC weeks';
  try {
    const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
    if (!service) throw new Error('Play history service is not configured');
    if (mode === 'personal' && !/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error('Connect your wallet to view personal play history.');
    const query = new URLSearchParams({ weeks: '12' });
    if (wallet) query.set('wallet', wallet);
    const response = await fetch(`${service}/api/radio/history?${query}`, { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `History unavailable (${response.status})`);
    reports = Array.isArray(result.weeks) ? result.weeks : [];
    weekSelect.replaceChildren(...reports.slice().reverse().map((report) => {
      const option = document.createElement('option');
      option.value = report.week;
      option.textContent = `${report.week}${report.current ? ' · current' : ''}`;
      return option;
    }));
    if (!reports.length) {
      content.textContent = 'No weekly play data has been recorded yet.';
      return;
    }
    weekSelect.value = reports.at(-1).week;
    renderWeek();
  } catch (error) {
    content.textContent = error.message;
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
  if (!dialog || !weekSelect || !content) return;
  document.addEventListener('open-radio-history', openHistory);
  document.getElementById('radio-history-close')?.addEventListener('click', () => dialog.close());
  weekSelect.addEventListener('change', renderWeek);
  searchInput?.addEventListener('input', renderWeek);
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
