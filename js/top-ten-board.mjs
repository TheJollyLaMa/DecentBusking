import { getCreatorWatchlistState } from './watchlist.mjs?v=20261022-playlist-lane';
import { renderUsdcAmount } from './fund-display.mjs?v=20261024-live-prototype';
import { weekNumberFromKey } from './payroll-week.mjs';
import { rankTopTenSongs, previewTopTenSongPayroll } from './top-ten-prizes.mjs?v=20261017-wallet-forfeiture';
import { saveChartSongToWatchlist } from './top-ten-playlist.mjs?v=20261022-playlist-lane';
import { mountTopTenFestival } from './top-ten-festival.mjs?v=20261016-hype-bunny';

export { rankTopTenSongs };

// Same module URL as main.js so the festival reads the shared radio analyser instead of building a second one.
let spectrumReader = null;
let spectrumReaderLoad = null;
function readRadioSpectrum(out) {
  if (spectrumReader) return spectrumReader(out);
  spectrumReaderLoad ||= import('./space.js?v=20261022-playlist-lane')
    .then(module => { spectrumReader = typeof module.readNowPlayingSpectrum === 'function' ? module.readNowPlayingSpectrum : () => false; })
    .catch(error => console.warn('[top-ten] Live equalizer unavailable:', error.message));
  return false;
}

export function topTenDisplayRows(tracks, nowPlaying) {
  const ranked = rankTopTenSongs(tracks, nowPlaying?.trackId);
  if (nowPlaying?.isDevert) {
    const tally = nowPlaying.adVotes;
    const available = Number.isSafeInteger(tally?.up) && tally.up >= 0 &&
      Number.isSafeInteger(tally?.down) && tally.down >= 0 && tally.net === tally.up - tally.down;
    return [{ trackId: nowPlaying.trackId || nowPlaying.playId, title: nowPlaying.title || 'Live advert',
      artist: nowPlaying.uploader || 'DVert advertiser', votes: available ? tally.net : null,
      adVotes: available ? tally : null, isAdvert: true, rank: null, nowPlaying: true, outsideTopTen: true }, ...ranked];
  }
  if (!nowPlaying?.trackId || ranked.some(track => track.trackId === nowPlaying.trackId)) return ranked;
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

function hasPayoutWallet(wallet) {
  return /^0x(?!0{40}$)[0-9a-fA-F]{40}$/i.test(wallet || '');
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
  let festival = null;
  let hypeState = null;
  let hypeDeadline = 0;
  let hypeEndTimer;
  let wasOpenBeforeHype = false;
  let autoOpenedInstance = null;
  let lastReport = null;
  let lastWeekly = null;
  let lastNowPlaying = null;
  let lastPlayingId = null;
  const closeButton = document.getElementById('top-ten-panel-close');
  const infoButton = document.getElementById('top-ten-info');
  const instructions = document.getElementById('top-ten-instructions');
  const playlistPending = new Set();
  const playlistSaved = new Set();
  const playlistStatus = el('p', 'top-ten-playlist-status');
  playlistStatus.setAttribute('role', 'status');
  playlistStatus.setAttribute('aria-live', 'polite');
  content.before(playlistStatus);
  document.addEventListener('wallet-disconnected', () => playlistSaved.clear());
  document.addEventListener('wallet-connected', () => playlistSaved.clear());
  document.addEventListener('creator-watchlist-changed', () => playlistSaved.clear());
  const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const flightLayer = el('div', 'top-ten-flight-layer');
  flightLayer.setAttribute('aria-hidden', 'true');
  const chartHole = el('span', 'top-ten-chart-hole', '🕳️');
  const spyPeek = el('span', 'top-ten-spy-peek');
  spyPeek.append(el('span', 'top-ten-spy', '🕵️'));
  chartHole.append(spyPeek);
  flightLayer.append(chartHole);
  const festivalVisitors = ['🐇', '🦊', '🐀', '💸'];
  const visitors = ['\u{1F4B8}', '\u{1F41D}', '\u{1F41D}', ''].map((symbol, index) => {
    const node = el('span', `top-ten-visitor top-ten-visitor-${index}`, symbol);
    flightLayer.append(node);
    return { node, index, step: index * 5, visits: 0, position: null, animation: null };
  });
  panel.append(flightLayer);
  const canFly = () => isOpen() && !reducedMotion.matches && !document.hidden;
  const fly = visitor => {
    if (!canFly() || (!festival && visitor.index === 3) || visitor.animation) return;
    const bounds = panel.getBoundingClientRect();
    const viewport = content.getBoundingClientRect();
    const hole = { x: viewport.left - bounds.left + viewport.width / 2,
      y: viewport.bottom - bounds.top - 15 };
    chartHole.style.left = `${hole.x}px`;
    chartHole.style.top = `${hole.y}px`;
    const targets = [...content.querySelectorAll('.top-ten-song-title, .top-ten-net-votes, .top-ten-prize')]
      .map(node => node.getBoundingClientRect())
      .filter(rect => rect.top >= viewport.top && rect.bottom <= viewport.bottom && rect.width > 0)
      .map(rect => ({ x: Math.max(14, Math.min(bounds.width - 14, rect.left + rect.width / 2 - bounds.left)),
        y: Math.max(viewport.top - bounds.top + 10, Math.min(viewport.bottom - bounds.top - 10, rect.top - bounds.top - 5)) }));
    if (!targets.length) return;
    const entering = !!festival && visitor.visits === 0;
    const returning = !!festival && visitor.visits === 4;
    const target = returning ? hole : targets[visitor.step % targets.length];
    visitor.step += visitor.index === 1 ? 2 : visitor.index === 2 ? 5 : 1;
    const previous = visitor.position || targets[(visitor.step + visitor.index * 3) % targets.length];
    const from = entering ? hole : {
      x: Math.max(viewport.left - bounds.left + 10, Math.min(viewport.right - bounds.left - 10, previous.x)),
      y: Math.max(viewport.top - bounds.top + 10, Math.min(viewport.bottom - bounds.top - 10, previous.y)),
    };
    visitor.node.style.visibility = 'visible';
    const frames = chartFlightFrames(from, target, 12 + visitor.index * 5);
    if (entering) {
      frames[0].opacity = 0;
      frames[0].transform += ' scale(.1)';
      frames[1].opacity = 1;
    }
    if (returning) {
      frames[2].opacity = 1;
      frames[3].opacity = 0;
      frames[3].transform += ' scale(.1)';
    }
    const animation = visitor.node.animate(frames, {
      duration: 5200 + visitor.index * 1100, easing: 'ease-in-out', fill: 'forwards',
    });
    visitor.animation = animation;
    animation.finished.then(() => {
      visitor.position = target;
      visitor.visits = returning ? 0 : visitor.visits + 1;
      visitor.animation = null;
      visitor.node.style.transform = chartFlightFrames(target, target)[0].transform;
      animation.cancel();
      fly(visitor);
    }).catch(() => {});
  };
  const syncFlights = () => {
    festival?.resume();
    if (reducedMotion.matches) for (const animation of rankAnimations) animation.cancel();
    for (const visitor of visitors) {
      visitor.node.textContent = festival ? festivalVisitors[visitor.index] : ['\u{1F4B8}', '\u{1F41D}', '\u{1F41D}', ''][visitor.index];
      if (canFly() && (festival || visitor.index < 3)) fly(visitor);
      else {
        visitor.animation?.cancel();
        visitor.animation = null;
        visitor.visits = 0;
        visitor.node.style.visibility = 'hidden';
      }
    }
  };
  const close = () => {
    if (instructions?.open) instructions.close();
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
  const endHype = () => {
    if (!festival) return;
    clearTimeout(hypeEndTimer);
    festival.destroy();
    festival = null;
    hypeState = null;
    if (!wasOpenBeforeHype && isOpen()) close();
    if (lastReport) render(lastReport, lastNowPlaying, lastWeekly);
    syncFlights();
  };
  const applyRadioState = radio => {
    if (!radio) return;
    const hype = radio.activeShow?.id === 'friday-top10-hype' ? radio.topTenHype : null;
    if (!hype) {
      if (radio.activeShow || performance.now() >= hypeDeadline) endHype();
      if (lastReport) render(lastReport, radio.nowPlaying || null, lastWeekly);
      return;
    }
    const remaining = Date.parse(hype.endAt) - radio.serverTime;
    if (!(remaining > 0)) { endHype(); return; }
    hypeState = hype;
    hypeDeadline = performance.now() + remaining;
    clearTimeout(hypeEndTimer);
    hypeEndTimer = setTimeout(endHype, remaining);
    if (!festival) {
      wasOpenBeforeHype = isOpen();
      festival = mountTopTenFestival(panel, { readSpectrum: readRadioSpectrum });
      syncFlights();
    }
    const instance = hype.instanceId || radio.activeShow.instanceId || hype.startAt || 'friday-top10-hype';
    if (autoOpenedInstance !== instance) {
      autoOpenedInstance = instance;
      if (!isOpen()) open();
    }
    const playing = radio.nowPlaying;
    festival.update({ ...playing?.hype, title: playing?.hype ? playing.title : '', status: hype.status,
      error: hype.error, lateSnapshot: hype.lateSnapshot, skipped: hype.skipped });
    if (lastReport) render(lastReport, playing || null, lastWeekly);
  };
  const render = (report, nowPlaying, weekly) => {
    lastReport = report;
    lastWeekly = weekly;
    lastNowPlaying = nowPlaying;
    const focusedTrack = content.contains(document.activeElement) ? document.activeElement.dataset.trackId : null;
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
    header.textContent = `Week ${weekNumberFromKey(report.week)}`;
    content.replaceChildren();
    if (!rows.length) {
      content.append(el('p', 'top-ten-live', nowPlaying?.isDevert ? 'A sponsored campaign is playing between songs.' : 'No song is currently live on JukeLoop.'),
        el('p', 'top-ten-empty', 'No weekly song votes recorded yet. Votes appear after listeners rate a song during its play.'));
      return;
    }
    const list = el('ol', 'top-ten-list');
    for (const track of rows) {
      const item = el('li', `top-ten-song${track.nowPlaying ? ' is-now-playing' : ''}${track.outsideTopTen ? ' is-live-outside-chart' : ''}${track.isAdvert ? ' is-live-advert' : ''}`);
      item.dataset.trackId = track.trackId;
      if (gains.has(track.trackId) && !reducedMotion.matches) {
        item.classList.add('is-rank-climbing');
        item.dataset.rankGain = String(gains.get(track.trackId));
      }
      const rank = el('span', `top-ten-rank${track.outsideTopTen ? ' top-ten-live-rank' : ''}`, track.isAdvert ? 'AD' : track.outsideTopTen ? '▶' : String(track.rank));
      const details = el('span', 'top-ten-song-details');
      const titleLine = el('span', 'top-ten-song-title-line');
      titleLine.append(el('strong', 'top-ten-song-title', track.title || 'Untitled song'));
      details.append(titleLine, el('span', 'top-ten-song-artist', track.artist || 'Artist wallet not linked'));
      if (track.nowPlaying) details.append(el('span', 'top-ten-live-badge', track.isAdvert ? 'ADVERT · LIVE NOW' : 'LIVE NOW'));
      if (track.isAdvert) details.append(el('span', 'top-ten-song-artist', 'Not ranked · no music prize'));
      const opening = hypeState?.tracks?.find(entry => entry.trackId === track.trackId);
      if (opening) details.append(el('span', 'top-ten-opening-rank', `Opening #${opening.openingRank} \u00b7 live ${track.rank ? `#${track.rank}` : 'outside Top 10'}`));
      const score = el('span', 'top-ten-vote-score');
      score.append(el('span', 'top-ten-net-votes', track.votes === null ? '—' : `${track.votes > 0 ? '+' : ''}${track.votes}`),
        el('span', 'top-ten-vote-label', track.isAdvert ? 'this play' : 'net votes'));
      if (track.isAdvert) score.title = track.adVotes
        ? `${track.adVotes.up} up · ${track.adVotes.down} down · this advert play only` : 'Advert vote counts unavailable until the worker update is deployed';
      const prize = el('span', 'top-ten-prize');
      if (track.prizeUnits === null) {
        prize.textContent = '—';
        prize.title = track.isAdvert ? 'Adverts are excluded from music prizes' : track.outsideTopTen ? 'Outside the prize chart' : 'Current weekly prize estimate unavailable';
      } else {
        if (track.prizeUnits > 0n) prize.innerHTML = renderUsdcAmount(track.prizeUnits);
        else prize.textContent = '—';
        prize.title = track.prizeUnits === 0n ? 'No payable prize at this rank; prizes must exceed $0.10' : 'Estimated prize if this song holds its rank at Monday midnight, America/New_York';
      }
      if (!hasPayoutWallet(track.wallet) && !track.outsideTopTen) {
        const warning = "No artist wallet is registered. This prize will be forfeited at Monday midnight, America/New_York, and roll into next week's Top 10 fund without being redistributed. Musician: register your wallet ASAP.";
        prize.classList.add('is-wallet-unlinked');
        prize.title = warning;
        prize.setAttribute('aria-label', `${prize.textContent || 'Estimated prize unavailable'}. ${warning}`);
        prize.tabIndex = 0;
      }
      const add = el('button', 'top-ten-playlist-add', '+');
      add.type = 'button';
      add.dataset.trackId = track.trackId;
      add.title = `Add ${track.title || 'song'} to a playlist`;
      add.setAttribute('aria-label', add.title);
      add.setAttribute('aria-haspopup', 'dialog');
      add.disabled = playlistPending.has(track.trackId);
      add.addEventListener('click', async () => {
        playlistPending.add(track.trackId);
        add.disabled = true;
        playlistStatus.textContent = `Adding ${track.title} to your DJuke playlist draft\u2026`;
        try {
          const request = new CustomEvent('dbusk-playlist-add', { cancelable: true, detail: {
            track: { ...track, ipfsCid: track.ipfsCid || (track.nowPlaying ? nowPlaying?.ipfsCid : '') },
            anchor: add, status: text => { playlistStatus.textContent = text; },
          } });
          if (document.dispatchEvent(request)) throw new Error('Playlist selector is unavailable.');
          playlistStatus.textContent = 'Choose a playlist to add this song.';
        } catch (error) {
          playlistStatus.textContent = error.message;
        } finally {
          playlistPending.delete(track.trackId);
          add.disabled = false;
        }
      });
      const watched = getCreatorWatchlistState().watchlist.some(entry => track.ipfsCid && entry.audioUrl?.includes(track.ipfsCid));
      const eyes = el('button', 'top-ten-watchlist-add', watched || playlistSaved.has(track.trackId) ? '✓' : '👀');
      eyes.type = 'button';
      eyes.title = `Save ${track.title || 'song'} and artist to your profile watchlist`;
      eyes.setAttribute('aria-label', eyes.title);
      eyes.setAttribute('aria-pressed', String(watched || playlistSaved.has(track.trackId)));
      eyes.addEventListener('click', async () => {
        eyes.disabled = true;
        try {
          await saveChartSongToWatchlist({ ...track, ipfsCid: track.ipfsCid || (track.nowPlaying ? nowPlaying?.ipfsCid : '') });
          playlistSaved.add(track.trackId);
          eyes.textContent = '✓';
          eyes.setAttribute('aria-pressed', 'true');
          eyes.title = 'Saved to your profile watchlist';
          playlistStatus.textContent = `${track.title} saved to your profile watchlist.`;
        } catch (error) { playlistStatus.textContent = error.message; }
        finally { eyes.disabled = false; }
      });
      if (!track.isAdvert) titleLine.append(add, eyes);
      item.append(rank, details, score, prize);
      list.append(item);
    }
    content.append(list);
    content.scrollTop = scrollTop;
    if (festival && nowPlaying?.trackId && nowPlaying.trackId !== lastPlayingId) {
      [...list.children].find(item => item.dataset.trackId === nowPlaying.trackId)?.scrollIntoView({ block: 'nearest' });
    }
    lastPlayingId = nowPlaying?.trackId || null;
    if (focusedTrack) [...content.querySelectorAll('.top-ten-playlist-add')].find(button => button.dataset.trackId === focusedTrack)?.focus({ preventScroll: true });
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
      applyRadioState(radio);
      const report = (history.weeks || []).find(entry => entry.current) || (history.weeks || []).at(-1);
      const weekly = weeklyResponse?.ok && weeklyState?.ready && !weeklyState.lastError && weeklyState.currentPeriod?.week === report?.week &&
        /^\d+$/.test(String(weeklyState.funds?.top10?.budgetUnits ?? '')) ? weeklyState : null;
      if (!report) { header.textContent = 'Weekly vote chart'; content.replaceChildren(el('p', 'top-ten-empty', 'Weekly song votes are not available yet.')); }
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
  document.addEventListener('visibilitychange', () => { if (festival && performance.now() >= hypeDeadline) endHype(); });
  document.addEventListener('dbusk-radio-state', event => applyRadioState(event.detail));
  document.addEventListener('dbusk-radio-vote-recorded', () => { if (isOpen()) refresh(); });
  content.addEventListener('scroll', syncFlights, { passive: true });
  document.getElementById('top-ten-panel-close')?.addEventListener('click', () => { close(); toggle.focus(); });
  infoButton?.addEventListener('click', () => instructions.showModal());
  document.getElementById('top-ten-instructions-close')?.addEventListener('click', () => instructions.close());
  instructions?.addEventListener('close', () => { if (isOpen()) infoButton.focus(); });
  instructions?.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      instructions.close();
    }
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && isOpen() && !instructions?.open) { close(); toggle.focus(); } });
  document.addEventListener('left-drawer-open', event => {
    if (event.detail === 'top-ten' || !isOpen()) return;
    close();
  });
  document.addEventListener('click', event => {
    // Voting should leave the live chart visible; Hype also ignores other stray page clicks.
    if (isOpen() && !festival && !event.target?.closest?.('[data-radio-vote]') &&
        !panel.contains(event.target) && !instructions?.contains(event.target) && event.target !== toggle) close();
  });
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initTopTenBoard, { once: true });