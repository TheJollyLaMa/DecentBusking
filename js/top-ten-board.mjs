export function rankTopTenSongs(tracks, nowPlayingId = '') {
  return tracks.filter(track => typeof track.trackId === 'string' && Number.isSafeInteger(track.votes) &&
    (track.plays > 0 || track.votes !== 0))
    .slice().sort((first, second) => second.votes - first.votes || second.plays - first.plays ||
      String(first.title).localeCompare(String(second.title)) || first.trackId.localeCompare(second.trackId))
    .slice(0, 10).map((track, index) => ({ ...track, rank: index + 1, nowPlaying: track.trackId === nowPlayingId }));
}

export function topTenDisplayRows(tracks, nowPlaying) {
  const ranked = rankTopTenSongs(tracks, nowPlaying?.trackId);
  if (!nowPlaying?.trackId || ranked.some(track => track.trackId === nowPlaying.trackId)) return ranked;
  const recorded = tracks.find(track => track.trackId === nowPlaying.trackId);
  return [{ ...(recorded || {}), trackId: nowPlaying.trackId, title: nowPlaying.title || recorded?.title || 'Current song',
    artist: nowPlaying.uploader || recorded?.artist || '', votes: Number.isSafeInteger(recorded?.votes) ? recorded.votes : 0,
    plays: Number.isSafeInteger(recorded?.plays) ? recorded.plays : 0, rank: null, nowPlaying: true, outsideTopTen: true }, ...ranked];
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function initTopTenBoard() {
  const toggle = document.getElementById('top-ten-tab');
  const panel = document.getElementById('top-ten-panel');
  const content = document.getElementById('top-ten-content');
  const status = document.getElementById('top-ten-status');
  const header = document.getElementById('top-ten-week');
  if (!toggle || !panel || !content || !status || !header) return;
  let generation = 0;
  let timer;
  const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';
  const close = () => {
    clearTimeout(timer);
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open Top 10 Songs');
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('top-ten-open');
  };
  const open = () => {
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Close Top 10 Songs');
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    document.body.classList.add('top-ten-open');
    refresh();
  };
  const render = (report, nowPlaying) => {
    const rows = topTenDisplayRows(report.tracks || [], nowPlaying);
    header.textContent = `Top 10 Songs · ${report.week}`;
    content.replaceChildren();
    if (!rows.length) {
      content.append(el('p', 'top-ten-live', 'No song is currently live on JukeLoop.'),
        el('p', 'top-ten-empty', 'No weekly song votes recorded yet. Votes appear after listeners rate a song during its play.'));
      return;
    }
    const list = el('ol', 'top-ten-list');
    for (const track of rows) {
      const item = el('li', `top-ten-song${track.nowPlaying ? ' is-now-playing' : ''}${track.outsideTopTen ? ' is-live-outside-chart' : ''}`);
      const rank = el('span', `top-ten-rank${track.outsideTopTen ? ' top-ten-live-rank' : ''}`, track.outsideTopTen ? '▶' : String(track.rank));
      const details = el('span', 'top-ten-song-details');
      details.append(el('strong', 'top-ten-song-title', track.title || 'Untitled song'),
        el('span', 'top-ten-song-artist', track.artist || 'Artist wallet not linked'));
      if (track.nowPlaying) details.append(el('span', 'top-ten-live-badge', 'LIVE NOW'));
      const score = el('span', 'top-ten-vote-score');
      score.append(el('span', 'top-ten-net-votes', `${track.votes > 0 ? '+' : ''}${track.votes}`), el('span', 'top-ten-vote-label', 'net votes'));
      item.append(rank, details, score);
      list.append(item);
    }
    content.append(list);
  };
  async function refresh() {
    clearTimeout(timer);
    const request = ++generation;
    if (!isOpen()) return;
    const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
    if (!service) { status.textContent = 'JukeLoop service is not configured.'; return; }
    status.textContent = 'Loading this week’s song votes…';
    try {
      const [historyResponse, radioResponse] = await Promise.all([
        fetch(`${service}/api/radio/history?weeks=1&calendar=new-york`, { cache: 'no-store', signal: AbortSignal.timeout(12000) }),
        fetch(`${service}/api/radio`, { cache: 'no-store', signal: AbortSignal.timeout(12000) }),
      ]);
      const [history, radio] = await Promise.all([historyResponse.json(), radioResponse.json()]);
      if (request !== generation || !isOpen()) return;
      if (!historyResponse.ok) throw new Error(history.error || `Weekly votes unavailable (${historyResponse.status})`);
      if (!radioResponse.ok) throw new Error(radio.error || `Live track unavailable (${radioResponse.status})`);
      const report = (history.weeks || []).find(entry => entry.current) || (history.weeks || []).at(-1);
      if (!report) { header.textContent = 'Top 10 Songs'; content.replaceChildren(el('p', 'top-ten-empty', 'Weekly song votes are not available yet.')); }
      else render(report, radio.nowPlaying);
      status.textContent = 'Songs ranked by New York-week net votes (upvotes minus downvotes). This is a song chart, not the artist payout ranking.';
    } catch (error) {
      if (request !== generation || !isOpen()) return;
      status.textContent = `${error.message}. Retrying while this panel is open.`;
    }
    if (isOpen()) timer = setTimeout(refresh, 15000);
  }
  toggle.addEventListener('click', event => { event.stopPropagation(); isOpen() ? close() : open(); });
  document.getElementById('top-ten-panel-close')?.addEventListener('click', () => { close(); toggle.focus(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && isOpen()) { close(); toggle.focus(); } });
  document.addEventListener('click', event => {
    if (isOpen() && !panel.contains(event.target) && event.target !== toggle) close();
  });
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initTopTenBoard, { once: true });