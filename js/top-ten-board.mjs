import { renderUsdcAmount } from './fund-display.mjs?v=20261015-weekly-funds';
import { weekNumberFromKey } from './payroll-week.mjs';
import { rankTopTenSongs, previewTopTenSongPayroll } from './top-ten-prizes.mjs';

export { rankTopTenSongs };

export function topTenDisplayRows(tracks, nowPlaying) {
  const ranked = rankTopTenSongs(tracks, nowPlaying?.trackId);
  if (!nowPlaying?.trackId || nowPlaying.isDevert || ranked.some(track => track.trackId === nowPlaying.trackId)) return ranked;
  const recorded = tracks.find(track => track.trackId === nowPlaying.trackId);
  return [{ ...(recorded || {}), trackId: nowPlaying.trackId, title: nowPlaying.title || recorded?.title || 'Current song',
    artist: nowPlaying.uploader || recorded?.artist || '', votes: Number.isSafeInteger(recorded?.votes) ? recorded.votes : 0,
    plays: Number.isSafeInteger(recorded?.plays) ? recorded.plays : 0, rank: null, nowPlaying: true, outsideTopTen: true }, ...ranked];
}

export function topTenPrizeRows(tracks, nowPlaying, { budgetUnits = null, minimumUnits } = {}) {
  const prizes = budgetUnits === null ? null : new Map(previewTopTenSongPayroll({ tracks, budgetUnits: BigInt(budgetUnits),
    ...(minimumUnits != null ? { minimumUnits: BigInt(minimumUnits) } : {}) }).entries.map(entry => [entry.trackId, entry.amountUnits]));
  return topTenDisplayRows(tracks, nowPlaying).map(song => ({ ...song,
    prizeUnits: song.outsideTopTen || !prizes ? null : prizes.get(song.trackId) ?? 0n }));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function chartFlightFrames(from, to, lift = 18) {
  const transform = (point, tilt = 0) => `translate(${point.x}px, ${point.y}px) translate(-50%, -50%) rotate(${tilt}deg)`;
  return [
    { transform: transform(from), offset: 0 },
    { transform: transform({ x: from.x + (to.x - from.x) * .45, y: from.y + (to.y - from.y) * .45 - lift }, -8), offset: .45 },
    { transform: transform({ x: to.x + 3, y: to.y - 3 }, 6), offset: .82 },
    { transform: transform(to), offset: 1 },
  ];
}

export function chartRankGains(previousRows, rows) {
  const previous = new Map((previousRows || []).filter(row => Number.isInteger(row.rank)).map(row => [row.trackId, row.rank]));
  return new Map(rows.filter(row => Number.isInteger(row.rank) && previous.has(row.trackId) && previous.get(row.trackId) > row.rank)
    .map(row => [row.trackId, previous.get(row.trackId) - row.rank]));
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
  let previousChart = null;
  let rankAnimations = [];
  const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const flightLayer = el('div', 'top-ten-flight-layer');
  flightLayer.setAttribute('aria-hidden', 'true');
  const visitors = ['\u{1F4B8}', '\u{1F41D}', '\u{1F41D}'].map((symbol, index) => {
    const node = el('span', `top-ten-visitor top-ten-visitor-${index}`, symbol);
    flightLayer.append(node);
    return { node, index, step: index * 5, position: null, animation: null };
  });
  panel.append(flightLayer);
  const canFly = () => isOpen() && !reducedMotion.matches && !document.hidden;
  const fly = visitor => {
    if (!canFly() || visitor.animation) return;
    const bounds = panel.getBoundingClientRect();
    const viewport = content.getBoundingClientRect();
    const targets = [...content.querySelectorAll('.top-ten-song-title, .top-ten-net-votes, .top-ten-prize')]
      .map(node => node.getBoundingClientRect())
      .filter(rect => rect.top >= viewport.top && rect.bottom <= viewport.bottom && rect.width > 0)
      .map(rect => ({ x: Math.max(14, Math.min(bounds.width - 14, rect.left + rect.width / 2 - bounds.left)),
        y: Math.max(viewport.top - bounds.top + 10, Math.min(viewport.bottom - bounds.top - 10, rect.top - bounds.top - 5)) }));
    if (!targets.length) return;
    const target = targets[visitor.step % targets.length];
    visitor.step += visitor.index === 1 ? 2 : visitor.index === 2 ? 5 : 1;
    const from = visitor.position || targets[(visitor.step + visitor.index * 3) % targets.length];
    visitor.node.style.visibility = 'visible';
    const animation = visitor.node.animate(chartFlightFrames(from, target, 12 + visitor.index * 5), {
      duration: 5200 + visitor.index * 1100, easing: 'ease-in-out', fill: 'forwards',
    });
    visitor.animation = animation;
    animation.finished.then(() => {
      visitor.position = target;
      visitor.animation = null;
      visitor.node.style.transform = chartFlightFrames(target, target)[0].transform;
      animation.cancel();
      fly(visitor);
    }).catch(() => {});
  };
  const syncFlights = () => {
    if (reducedMotion.matches) for (const animation of rankAnimations) animation.cancel();
    for (const visitor of visitors) {
      if (canFly()) fly(visitor);
      else {
        visitor.animation?.cancel();
        visitor.animation = null;
        visitor.node.style.visibility = 'hidden';
      }
    }
  };
  const close = () => {
    clearTimeout(timer);
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open Top 10 Songs');
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('top-ten-open');
    syncFlights();
  };
  const open = () => {
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Close Top 10 Songs');
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    document.body.classList.add('top-ten-open');
    document.dispatchEvent(new CustomEvent('left-drawer-open', { detail: 'top-ten' }));
    refresh();
  };
  const render = (report, nowPlaying, weekly) => {
    const rows = topTenPrizeRows(report.tracks || [], nowPlaying, {
      budgetUnits: weekly?.funds?.top10?.budgetUnits ?? null, minimumUnits: weekly?.minimumPayoutUnits,
    });
    const sameWeek = previousChart?.week === report.week;
    const gains = chartRankGains(sameWeek ? previousChart.rows : null, rows);
    const previousPositions = new Map(sameWeek ? [...content.querySelectorAll('.top-ten-song[data-track-id]')]
      .map(node => [node.dataset.trackId, node.getBoundingClientRect().top]) : []);
    const scrollTop = content.scrollTop;
    for (const animation of rankAnimations) animation.cancel();
    rankAnimations = [];
    previousChart = { week: report.week, rows };
    header.textContent = `Top 10 Songs · Week ${weekNumberFromKey(report.week)}`;
    content.replaceChildren();
    if (!rows.length) {
      content.append(el('p', 'top-ten-live', nowPlaying?.isDevert ? 'A sponsored campaign is playing between songs.' : 'No song is currently live on JukeLoop.'),
        el('p', 'top-ten-empty', 'No weekly song votes recorded yet. Votes appear after listeners rate a song during its play.'));
      return;
    }
    const list = el('ol', 'top-ten-list');
    for (const track of rows) {
      const item = el('li', `top-ten-song${track.nowPlaying ? ' is-now-playing' : ''}${track.outsideTopTen ? ' is-live-outside-chart' : ''}`);
      item.dataset.trackId = track.trackId;
      if (gains.has(track.trackId) && !reducedMotion.matches) {
        item.classList.add('is-rank-climbing');
        item.dataset.rankGain = String(gains.get(track.trackId));
      }
      const rank = el('span', `top-ten-rank${track.outsideTopTen ? ' top-ten-live-rank' : ''}`, track.outsideTopTen ? '▶' : String(track.rank));
      const details = el('span', 'top-ten-song-details');
      details.append(el('strong', 'top-ten-song-title', track.title || 'Untitled song'),
        el('span', 'top-ten-song-artist', track.artist || 'Artist wallet not linked'));
      if (track.nowPlaying) details.append(el('span', 'top-ten-live-badge', 'LIVE NOW'));
      const score = el('span', 'top-ten-vote-score');
      score.append(el('span', 'top-ten-net-votes', `${track.votes > 0 ? '+' : ''}${track.votes}`), el('span', 'top-ten-vote-label', 'net votes'));
      const prize = el('span', 'top-ten-prize');
      if (track.prizeUnits === null) {
        prize.textContent = '—';
        prize.title = track.outsideTopTen ? 'Outside the prize chart' : 'Current weekly prize estimate unavailable';
      } else {
        if (track.prizeUnits > 0n) prize.innerHTML = renderUsdcAmount(track.prizeUnits);
        else prize.textContent = '—';
        prize.title = track.prizeUnits === 0n ? 'No payable prize at this rank; prizes must exceed $0.10' : 'Estimated prize if this song holds its rank at Monday midnight, America/New_York';
        if (!/^0x(?!0{40}$)[0-9a-fA-F]{40}$/i.test(track.wallet || '')) prize.title += ' · Artist payout wallet must be linked before closeout';
      }
      item.append(rank, details, score, prize);
      list.append(item);
    }
    content.append(list);
    content.scrollTop = scrollTop;
    if (!reducedMotion.matches) for (const item of list.children) {
      const previousTop = previousPositions.get(item.dataset.trackId);
      const delta = previousTop == null ? 0 : previousTop - item.getBoundingClientRect().top;
      if (Math.abs(delta) > 1) rankAnimations.push(item.animate([
        { transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' },
      ], { duration: 850, easing: 'cubic-bezier(.22, 1, .36, 1)' }));
    }
    syncFlights();
  };
  async function refresh() {
    clearTimeout(timer);
    const request = ++generation;
    if (!isOpen()) return;
    const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
    if (!service) { status.textContent = 'JukeLoop service is not configured.'; return; }
    status.textContent = 'Loading this week’s song votes…';
    try {
      const [historyResponse, radioResponse, weeklyResponse] = await Promise.all([
        fetch(`${service}/api/radio/history?weeks=1&calendar=new-york`, { cache: 'no-store', signal: AbortSignal.timeout(12000) }),
        fetch(`${service}/api/radio`, { cache: 'no-store', signal: AbortSignal.timeout(12000) }),
        fetch(`${service}/api/payroll/weekly`, { cache: 'no-store', signal: AbortSignal.timeout(12000) }).catch(() => null),
      ]);
      const [history, radio, weeklyState] = await Promise.all([
        historyResponse.json(), radioResponse.json(),
        weeklyResponse?.json().catch(() => null) ?? null,
      ]);
      if (request !== generation || !isOpen()) return;
      if (!historyResponse.ok) throw new Error(history.error || `Weekly votes unavailable (${historyResponse.status})`);
      if (!radioResponse.ok) throw new Error(radio.error || `Live track unavailable (${radioResponse.status})`);
      const report = (history.weeks || []).find(entry => entry.current) || (history.weeks || []).at(-1);
      const weekly = weeklyResponse?.ok && weeklyState?.ready && !weeklyState.lastError && weeklyState.currentPeriod?.week === report?.week &&
        /^\d+$/.test(String(weeklyState.funds?.top10?.budgetUnits ?? '')) ? weeklyState : null;
      if (!report) { header.textContent = 'Top 10 Songs'; content.replaceChildren(el('p', 'top-ten-empty', 'Weekly song votes are not available yet.')); }
      else render(report, radio.nowPlaying, weekly);
      status.textContent = weekly ? '' : 'Prize estimates are unavailable. Song votes are current.';
    } catch (error) {
      if (request !== generation || !isOpen()) return;
      status.textContent = `${error.message}. Retrying while this panel is open.`;
    }
    if (isOpen()) timer = setTimeout(refresh, 15000);
  }
  toggle.addEventListener('click', event => { event.stopPropagation(); isOpen() ? close() : open(); });
  reducedMotion.addEventListener('change', syncFlights);
  document.addEventListener('visibilitychange', syncFlights);
  content.addEventListener('scroll', syncFlights, { passive: true });
  document.getElementById('top-ten-panel-close')?.addEventListener('click', () => { close(); toggle.focus(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && isOpen()) { close(); toggle.focus(); } });
  document.addEventListener('left-drawer-open', event => { if (event.detail !== 'top-ten' && isOpen()) close(); });
  document.addEventListener('click', event => {
    if (isOpen() && !panel.contains(event.target) && event.target !== toggle) close();
  });
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initTopTenBoard, { once: true });