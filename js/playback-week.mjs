import { newYorkDay, payrollPeriodFromKey } from './payroll-week.mjs';
import { formatUsdcUnits as usdc } from './usdc-format.mjs?v=20261017-mercury-release';
import { shortWallet } from './playback-trends.mjs';

const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const walletPattern = /^0x[0-9a-f]{40}$/i, txPattern = /^0x[0-9a-f]{64}$/i;
const count = new Intl.NumberFormat('en-US');
const civilLabel = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const paymentDate = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  timeZone: 'America/New_York', timeZoneName: 'short',
});
const labelDay = date => civilLabel.format(new Date(`${date}T00:00:00Z`));
function dayAt(date, offset) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}
function units(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('Invalid Playback Fund amount');
  return BigInt(value);
}

export function playbackWeekStory({ report, days = [], wallet = '', archive, estimates, now = Date.now() }) {
  const period = payrollPeriodFromKey(report.week), today = newYorkDay(now);
  const tracks = report.tracks.filter(t => !wallet || same(t.wallet, wallet));
  const inScope = new Set(tracks.map(t => t.trackId));
  const points = Array.from({ length: 7 }, (_, index) => {
    const date = dayAt(report.week.slice(3), index), bucket = days.find(d => d.date === date);
    const future = date > today, coverage = future ? 'future' : bucket?.coverage?.plays || 'missing';
    const rows = (bucket?.tracks || []).filter(t => inScope.has(t.trackId));
    const plays = rows.reduce((sum, t) => sum + (t.plays || 0), 0);
    return { date, future, coverage, current: date === today, rows,
      value: coverage === 'missing' || future ? null : plays };
  });
  let funding = null;
  if (archive) {
    if (archive.fundSlug !== 'dbusk-playback' || !Array.isArray(archive.weeks)) throw new Error('Invalid Playback Fund history');
    if (archive.payoutsAvailable === false) throw new Error('Playback Fund payment history is still indexing');
    if (archive.refreshError && !Number.isFinite(Date.parse(archive.historyCheckedAt))) throw new Error('Payment history has no verified check date');
    const week = archive.weeks.find(w => w.week === report.week);
    const credited = new Set();
    const rows = (week?.entries || []).filter(entry => !wallet || same(entry.wallet, wallet)).map(entry => {
      const expected = units(entry.amountUnits);
      const seen = new Set(), payments = [];
      let disputed = Boolean(entry.paymentMismatch);
      for (const payment of entry.payments || []) {
        const key = `${String(payment.txHash).toLowerCase()}:${payment.logIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (credited.has(key) || !same(payment.recipient, entry.wallet) || !txPattern.test(payment.txHash || '') ||
          !Number.isSafeInteger(payment.logIndex) || payment.logIndex < 0 ||
          (payment.metadataUri && week.metadataUri && payment.metadataUri !== week.metadataUri)) {
          disputed = true; continue;
        }
        credited.add(key);
        payments.push({ ...payment, amount: units(payment.amountUnits) });
      }
      const received = payments.reduce((sum, p) => sum + p.amount, 0n);
      return { wallet: entry.wallet, artist: entry.artist, expected, received, payments, disputed,
        remaining: expected > received ? expected - received : 0n };
    });
    funding = { kind: 'closed', allocated: Boolean(week && week.status !== 'activity'), rows,
      paid: rows.reduce((sum, r) => sum + r.received, 0n),
      pending: rows.reduce((sum, r) => sum + r.remaining, 0n),
      disputed: rows.some(r => r.disputed), unmatched: units(archive.unmatchedPaidUnits || '0') > 0n,
      checkedAt: archive.historyCheckedAt, refreshError: archive.refreshError || '' };
  } else if (estimates) {
    if (estimates.ready !== true || estimates.lastError || estimates.chainId !== 8453 ||
      estimates.timeZone !== 'America/New_York' || estimates.currentPeriod?.week !== report.week ||
      !Array.isArray(estimates.funds?.playback?.estimatedShares)) throw new Error('Current Playback Fund estimates are unavailable');
    const fund = estimates.funds.playback;
    const rows = fund.estimatedShares.filter(e => walletPattern.test(e.wallet || '') && (!wallet || same(e.wallet, wallet)))
      .map(e => ({ wallet: e.wallet, artist: e.artist, expected: e.payable ? units(e.amountUnits) : 0n,
        belowMinimum: !e.payable && units(e.amountUnits) > 0n }));
    funding = { kind: 'estimate', rows, estimate: rows.reduce((sum, r) => sum + r.expected, 0n), warning: fund.warning || '',
      lastCheckedAt: estimates.lastCheckedAt, closesAt: estimates.nextCloseAt };
  }
  return { period, tracks, points, funding,
    airings: tracks.reduce((sum, t) => sum + t.plays, 0), songs: tracks.filter(t => t.plays > 0).length,
    partial: Boolean(report.partial), current: Boolean(report.current) };
}

export function mountPlaybackWeek(root) {
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text != null) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  let reports = [], catalog = [], address = '', periods, service, selected, version = 0, controller;
  const archiveCache = new Map(), dayCache = new Map();
  function clear() {
    version++; controller?.abort(); controller = null;
    archiveCache.clear(); dayCache.clear();
    reports = []; catalog = []; address = ''; periods = null;
    root.replaceChildren(); root.hidden = true;
  }
  async function json(path, signal) {
    if (!service) throw new Error('Playback history service is not configured');
    const response = await fetch(`${service}${path}`, { signal, cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Playback evidence unavailable (${response.status})`);
    return body;
  }
  function identity(row) {
    const owner = catalog.find(s => same(s.wallet, row.wallet));
    return [owner?.artist || row.artist, shortWallet(row.wallet)].filter(Boolean).join(' · ');
  }
  function selection() {
    const toolbar = node('div', null, 'playback-week-nav');
    const back = node('button', '‹'), next = node('button', '›'), label = node('label', 'Radio week');
    back.type = next.type = 'button';
    back.setAttribute('aria-label', 'Previous radio week'); next.setAttribute('aria-label', 'Next radio week');
    const select = node('select'); select.setAttribute('aria-label', 'Radio week');
    select.id = 'playback-story-week';
    const index = reports.findIndex(r => r.week === selected);
    back.disabled = index <= 0; next.disabled = index >= reports.length - 1;
    for (const report of reports.slice().reverse()) {
      const option = node('option', `${report.current ? 'This week · ' : ''}${labelDay(report.week.slice(3))}`);
      option.value = report.week; select.append(option);
    }
    select.value = selected;
    const change = value => {
      selected = value; render();
      root.querySelector('#playback-story-week')?.focus();
    };
    select.addEventListener('change', () => change(select.value));
    back.addEventListener('click', () => change(reports[index - 1].week));
    next.addEventListener('click', () => change(reports[index + 1].week));
    label.append(select); toolbar.append(back, label, next);
    return toolbar;
  }
  function lineChart(story, container) {
    const figure = node('figure', null, 'playback-week-chart');
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 640 150'); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Daily qualifying airings, Monday through Sunday. Gaps have no dated history.');
    const max = Math.max(1, ...story.points.map(p => p.value ?? 0));
    const x = i => 24 + i * 592 / 6, y = value => 130 - value / max * 110;
    let path = '', connected = false;
    for (const [i, point] of story.points.entries()) {
      if (point.value === null) { connected = false; continue; }
      path += `${connected ? 'L' : 'M'}${x(i)},${y(point.value)} `;
      connected = true;
    }
    const trace = document.createElementNS(svgNS, 'path');
    trace.setAttribute('d', path); trace.setAttribute('class', 'playback-week-trace');
    svg.append(trace);
    for (const [i, point] of story.points.entries()) {
      if (point.value === null) continue;
      const dot = document.createElementNS(svgNS, 'circle');
      dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(point.value)); dot.setAttribute('r', '4');
      dot.setAttribute('class', point.coverage === 'partial' || point.current ? 'partial' : '');
      svg.append(dot);
    }
    const readout = node('figcaption', 'Select a day to see which songs aired.', 'playback-week-readout');
    const songs = node('div', null, 'playback-day-songs'), buttons = node('div', null, 'playback-week-days');
    for (const [index, point] of story.points.entries()) {
      const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][index];
      const value = point.value === null ? '—' : count.format(point.value);
      const button = node('button', null, 'playback-day');
      button.type = 'button'; button.append(node('span', day), node('strong', value));
      button.setAttribute('aria-label', `${day}, ${labelDay(point.date)}: ${point.future ? 'not yet' : point.value === null ? 'dated history unavailable' : `${value} airings${point.coverage === 'partial' ? ', partial day' : ''}${point.current ? ', in progress' : ''}`}`);
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => {
        for (const other of buttons.children) other.setAttribute('aria-pressed', String(other === button));
        readout.textContent = button.getAttribute('aria-label');
        songs.replaceChildren();
        if (point.value !== null) {
          const list = node('ul');
          for (const row of point.rows.filter(r => r.plays > 0).sort((a, b) => b.plays - a.plays)) {
            const song = story.tracks.find(t => t.trackId === row.trackId);
            list.append(node('li', `${song?.title || 'Untitled'} · ${count.format(row.plays)} ${row.plays === 1 ? 'airing' : 'airings'}`));
          }
          if (list.childElementCount) songs.append(list);
          else songs.append(node('p', 'No qualifying airings recorded on this observed day.'));
        }
      });
      buttons.append(button);
    }
    figure.append(node('div', 'Airplay by day · New York time', 'playback-week-eyebrow'));
    if (story.points.some(p => p.value !== null)) figure.append(svg);
    else figure.append(node('p', 'Daily finish-date history is unavailable for this week. The weekly total above is recorded separately.', 'radio-history-note'));
    figure.append(buttons, readout, songs);
    figure.append(node('small', 'Gaps are missing history, not zero. Hollow dots are partial or still counting.'));
    container.append(figure);
  }
  function airplay(story, totals, plot) {
    const scores = node('div', null, 'playback-week-scores');
    const airings = node('div'), songs = node('div');
    airings.append(node('strong', count.format(story.airings)), node('span', address ? 'airings of your songs' : 'radio airings'));
    songs.append(node('strong', count.format(story.songs)), node('span', address ? 'of your songs played' : 'different songs played'));
    scores.append(airings, songs); totals.replaceChildren(scores);
    if (story.partial) totals.append(node('p', 'Partial tracking week · counts start when recording began.', 'radio-history-note'));
    plot.replaceChildren(); lineChart(story, plot);
  }
  function payments(story, target, detail) {
    target.replaceChildren(); detail.replaceChildren();
    const funding = story.funding, personal = Boolean(address);
    if (!funding) return;
    const amount = funding.kind === 'estimate' ? funding.estimate : funding.paid;
    const score = node('div', null, 'playback-week-money');
    const missingAllocation = funding.kind === 'closed' && !funding.allocated;
    score.append(node('strong', missingAllocation ? '—' : `${usdc(amount)} USDC`),
      node('span', funding.kind === 'estimate' ? personal ? 'your estimated Playback Fund share' : 'estimated Playback Fund shares'
        : missingAllocation ? 'earning-week payment evidence unavailable'
          : personal ? 'paid to your wallet for this week' : 'paid for this radio week'));
    target.append(node('h3', funding.kind === 'estimate' ? personal ? 'Your share so far' : 'This week’s Playback Fund'
      : personal ? 'What reached your wallet?' : 'Who was paid?'), score);
    if (funding.kind === 'estimate') {
      target.append(node('p', 'Still counting · an estimate, not a payment.', 'playback-week-pending'));
      if (funding.closesAt) target.append(node('p', `Closes ${paymentDate.format(new Date(funding.closesAt))}.`, 'radio-history-note'));
      if (funding.lastCheckedAt) target.append(node('p', `Estimate checked ${paymentDate.format(new Date(funding.lastCheckedAt))}.`, 'radio-history-note'));
      if (funding.warning) target.append(node('p', funding.warning, 'radio-history-note'));
    } else {
      if (!funding.allocated) target.append(node('p', 'No frozen allocation indexed for this earning week. No payment is being inferred from airplay.', 'radio-history-note'));
      if (funding.pending > 0n) target.append(node('p', `${usdc(funding.pending)} USDC allocated · ${funding.refreshError ? 'not yet recorded as paid at last check' : 'awaiting payment'}`, 'playback-week-pending'));
      if (funding.checkedAt) target.append(node('p', `Payment history checked ${paymentDate.format(new Date(funding.checkedAt))}.`, 'radio-history-note'));
      if (funding.refreshError) {
        target.append(node('p', 'Latest blockchain refresh unavailable. Showing recorded payments as of that check; newer payments may not yet appear.', 'playback-week-pending'));
        const retry = node('button', 'Check for newer payments', 'playback-previous-week'); retry.type = 'button'; retry.addEventListener('click', render);
        target.append(retry);
      }
      if (funding.disputed) target.append(node('p', 'Some payment evidence differs from the allocation. Check the receipts below before treating this week as settled.', 'payroll-funding-warning'));
      if (funding.unmatched) target.append(node('p', 'Other fund payments are not matched to an earning week and are excluded here.', 'radio-history-note'));
      const dates = funding.rows.flatMap(row => row.payments).filter(p => p.timestamp > 0).map(p => p.timestamp).sort((a, b) => a - b);
      if (dates.length) {
        const first = paymentDate.format(new Date(dates[0] * 1000)), last = paymentDate.format(new Date(dates.at(-1) * 1000));
        target.append(node('p', first === last ? `Paid ${first}` : `Payments received ${first} – ${last}`, 'playback-week-paid-date'));
      }
    }
    const list = node('ul', null, 'playback-payees');
    const rows = [...funding.rows].sort((a, b) => {
      const av = funding.kind === 'estimate' ? a.expected : a.received;
      const bv = funding.kind === 'estimate' ? b.expected : b.received;
      return av > bv ? -1 : av < bv ? 1 : String(a.wallet).localeCompare(String(b.wallet));
    });
    const total = funding.kind === 'estimate' ? funding.estimate : funding.paid;
    for (const row of rows) {
      const amount = funding.kind === 'estimate' ? row.expected : row.received;
      const li = node('li'), top = node('div', null, 'playback-payee-heading');
      top.append(node('span', identity(row)), node('strong', `${usdc(amount)} USDC`));
      li.append(top);
      if (total > 0n) {
        const rail = node('div', null, 'playback-share-rail'), fill = node('i');
        fill.style.width = `${Number(amount * 10000n / total) / 100}%`;
        rail.append(fill); li.append(rail);
      }
      if (row.belowMinimum) li.append(node('small', 'Below the minimum payment · no payable estimate'));
      if (row.remaining > 0n) li.append(node('small', `${usdc(row.remaining)} USDC awaiting payment`));
      if (row.disputed) li.append(node('small', 'Payment mismatch · review receipt'));
      for (const payment of row.payments || []) {
        const link = node('a', `${usdc(payment.amount)} USDC · ${payment.timestamp > 0
          ? paymentDate.format(new Date(payment.timestamp * 1000)) : 'date unavailable'} ↗`);
        link.href = `https://basescan.org/tx/${payment.txHash}`; link.target = '_blank'; link.rel = 'noopener';
        li.append(link);
      }
      list.append(li);
    }
    if (rows.length) detail.append(node('h3', funding.kind === 'estimate' ? 'Estimated recipient shares' : personal ? 'Your payment receipts' : 'Recipients & receipts'));
    detail.append(list);
    if (story.current) {
      const index = reports.findIndex(r => r.week === selected);
      if (index > 0) {
        const previous = node('button', 'Last week’s plays & payments →', 'playback-previous-week');
        previous.type = 'button';
        previous.addEventListener('click', () => {
          selected = reports[index - 1].week; render();
          root.querySelector('#playback-story-week')?.focus();
        });
        target.append(previous);
      }
    }
    detail.append(node('p', 'Playback Fund only · Base USDC. Tips, Top 10 prizes and DJuke earnings are separate. A payment date may be later than the week that earned it.', 'radio-history-note'));
  }
  async function render() {
    const currentVersion = ++version;
    controller?.abort(); controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    root.replaceChildren(selection());
    const report = reports.find(r => r.week === selected);
    const title = node('h3', `${address ? 'Your music' : 'The radio'} · ${report.current ? 'this week so far' : 'week in review'}`);
    root.append(title, node('p', `${labelDay(selected.slice(3))} – ${labelDay(dayAt(selected.slice(3), 6))}`, 'radio-history-note'));
    const totals = node('div'), plot = node('div'), money = node('section', null, 'playback-week-funding');
    const detail = node('section', null, 'playback-week-receipts');
    money.setAttribute('aria-live', 'polite'); money.append(node('p', 'Loading payment evidence…'));
    root.append(totals, money, plot, detail);
    const build = extra => playbackWeekStory({ report, wallet: address, days: dayCache.get(selected) || periods?.daily, ...extra });
    airplay(build(), totals, plot);
    const query = new URLSearchParams({ weeks: '1', calendar: 'new-york', periods: '1', dayWeek: selected });
    if (address) query.set('wallet', address);
    json(`/api/radio/history?${query}`, signal).then(result => {
      if (currentVersion !== version) return;
      if (!Array.isArray(result.periods?.daily)) throw new Error('Daily airplay detail is unavailable');
      dayCache.set(selected, result.periods.daily); airplay(build(), totals, plot);
    }).catch(error => {
      if (currentVersion === version) plot.append(node('p', `${error.message}. Weekly totals remain available.`, 'radio-history-note'));
    });
    try {
      let evidence;
      if (report.current) {
        const query = new URLSearchParams({ view: 'summary' });
        if (address) query.set('wallet', address);
        evidence = { estimates: await json(`/api/payroll/weekly?${query}`, signal) };
      } else {
        let archive = archiveCache.get(selected);
        if (!archive) {
          archive = await json(`/api/funds/dbusk-playback/weeks?week=${encodeURIComponent(selected)}`, signal);
          if (currentVersion !== version) return;
          if (!archive.refreshError) archiveCache.set(selected, archive);
        }
        evidence = { archive };
      }
      if (currentVersion !== version) return;
      payments(build(evidence), money, detail);
    } catch (error) {
      if (currentVersion !== version) return;
      archiveCache.delete(selected);
      const retry = node('button', 'Retry payment history'); retry.type = 'button'; retry.addEventListener('click', render);
      money.replaceChildren(node('h3', 'Payment evidence unavailable'), node('p', error.message, 'radio-history-note'), retry);
    }
  }
  return { clear, load(history, songs, wallet, calendar, serviceUrl) {
    clear(); address = wallet || ''; catalog = songs || []; periods = calendar; service = serviceUrl;
    reports = history.filter(r => /^NY-\d{4}-\d{2}-\d{2}$/.test(r.week) &&
      !(Date.parse(r.endAt) <= Date.parse(r.accountingStartedAt))).sort((a, b) => a.week.localeCompare(b.week));
    if (!reports.length) { root.append(node('p', 'No tracked radio weeks available yet.')); return; }
    selected = (reports.find(r => r.current) || reports.at(-1)).week;
    render();
  } };
}
