const fold = value => String(value || '').trim().toLowerCase();
const owner = song => fold(song.wallet) || fold(song.artist);
export const shortWallet = value => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '';

export function playbackDataset(reports, catalog, wallet = '', periods) {
  const songs = new Map(), albums = new Map(), artists = new Map();
  const inScope = song => !wallet || fold(song.wallet) === fold(wallet);
  const add = song => {
    if (!song.trackId || !inScope(song) || songs.has(song.trackId)) return;
    const artist = song.artist || 'Unknown artist', who = owner(song);
    const artistLabel = [artist, shortWallet(song.wallet)].filter(Boolean).join(' · ');
    artists.set(who, artistLabel);
    const memberships = new Set();
    for (const title of song.albums || []) {
      const key = JSON.stringify([who, fold(title)]);
      albums.set(key, `${title} · ${artistLabel}`);
      memberships.add(key);
    }
    songs.set(song.trackId, { id: song.trackId, title: song.title || 'Untitled', artist, wallet: fold(song.wallet), who, memberships });
  };
  for (const song of catalog || []) add(song);
  for (const report of reports) for (const song of report.tracks) add(song);
  const weeks = reports.filter(r => /^NY-\d{4}-\d{2}-\d{2}$/.test(r.week) &&
    !(Date.parse(r.endAt) <= Date.parse(r.accountingStartedAt))).sort((a, b) => a.week.localeCompare(b.week));
  return { songs, albums, artists, weeks, periods, lifetime: reports.find(r => r.week === 'all-time'),
    albumsAvailable: Array.isArray(catalog) };
}

export function playbackSeries(data, { scope = 'all', selected = new Set(), subject = '', metric = 'plays', range = 8 } = {}) {
  const tracks = [...data.songs.values()].filter(song => scope === 'songs' ? selected.has(song.id)
    : scope === 'album' ? song.memberships.has(subject) : scope === 'artist' ? song.who === subject : true);
  const values = new Map(tracks.map(song => [song.id, 0]));
  const lifetime = range === 'all-time';
  const period = lifetime ? 'period' : range === 'daily' ? 'day' : range === 'monthly' ? 'month' : 'week';
  const buckets = lifetime ? data.periods?.history || [] : period === 'week' ? data.weeks.slice(-Number(range))
    : data.periods?.[range] || [];
  function sumRows(rows, accumulate, sparse) {
    let value = 0;
    for (const track of rows) {
      if (!values.has(track.trackId)) continue;
      const count = sparse && !Object.hasOwn(track, metric) ? 0 : track[metric];
      if (!Number.isSafeInteger(count)) throw new Error('Incomplete playback totals');
      if (accumulate) values.set(track.trackId, values.get(track.trackId) + count);
      value += count;
    }
    return value;
  }
  const points = buckets.map(bucket => {
    const coverage = bucket.coverage?.[metric];
    return { date: bucket.date || bucket.week.slice(3), through: bucket.through, current: bucket.current,
      partial: coverage === 'partial' || bucket.partial, value: coverage === 'missing' ? null
        : sumRows(bucket.tracks, !lifetime, period !== 'week') };
  });
  const total = lifetime ? data.lifetime ? sumRows(data.lifetime.tracks, true, false) : null
    : points.some(p => p.value !== null) ? points.reduce((sum, point) => sum + (point.value ?? 0), 0) : null;
  const rows = tracks.map(song => ({ ...song, value: values.get(song.id) }));
  return { points, rows, total, period, lifetime };
}

const number = new Intl.NumberFormat('en-US');
const dateLabel = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const monthLabel = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const longDateLabel = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const labelDate = (date, year = false) => date.length === 7 ? monthLabel.format(new Date(`${date}-01T00:00:00Z`))
  : (year ? longDateLabel : dateLabel).format(new Date(`${date}T00:00:00Z`));

export function mountPlaybackExplorer(root) {
  const find = id => root.querySelector(`#playback-${id}`);
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const scope = find('scope'), metric = find('metric'), range = find('range'), subject = find('subject');
  const picker = find('picker'), search = find('search'), options = find('options'), output = find('output');
  let data, personal, selected = new Set(), ascending = false, rankingOpen = false;

  function selectionLabel() {
    find('selection').textContent = selected.size === 1 ? `${data.songs.get([...selected][0]).title} · Edit songs`
      : selected.size ? `${selected.size} selected · Edit songs` : 'Select songs';
  }

  function songOptions() {
    const query = fold(search.value);
    const choices = [...data.songs.values()].filter(song =>
      fold(`${song.title} ${song.artist} ${song.wallet}`).includes(query)).sort((a, b) => a.title.localeCompare(b.title));
    selectionLabel();
    options.replaceChildren(...choices.map(song => {
      const label = make('label'), input = make('input');
      input.type = 'checkbox'; input.value = song.id; input.checked = selected.has(song.id);
      label.append(input, make('span', `${song.title} · ${song.artist}`));
      return label;
    }));
    if (!choices.length) options.append(make('p', 'No matching songs.'));
  }

  function updateScope() {
    picker.hidden = scope.value !== 'songs';
    const grouped = ['artist', 'album'].includes(scope.value);
    find('subject-label').hidden = !grouped;
    if (grouped) {
      const albums = scope.value === 'album';
      find('subject-name').textContent = albums ? 'Album' : 'Artist / wallet';
      const list = albums ? data.albums : data.artists;
      subject.replaceChildren(new Option(albums ? 'Choose an album…' : 'Choose an artist…', ''),
        ...[...list].sort((a, b) => a[1].localeCompare(b[1])).map(([key, name]) => new Option(name, key)));
    }
    if (!picker.hidden) { songOptions(); picker.open = !selected.size; }
    render();
  }

  function showSong(id) {
    selected = new Set([id]); scope.value = 'songs'; search.value = '';
    updateScope(); picker.querySelector('summary').focus();
  }

  function render() {
    output.replaceChildren();
    if (!data) return;
    if (scope.value === 'album' && (!data.albumsAvailable || !data.albums.size)) {
      output.append(make('p', data.albumsAvailable ? 'No album memberships for these songs.' : 'Album memberships are unavailable. Song and artist trends are still available.')); return;
    }
    if (scope.value === 'songs' && !selected.size || ['artist', 'album'].includes(scope.value) && !subject.value) {
      output.append(make('p', 'Choose what to plot above.')); return;
    }
    const unit = metric.value === 'votes' ? 'net votes' : 'plays';
    const { points, rows, total, period, lifetime } = playbackSeries(data, {
      scope: scope.value, selected, subject: subject.value, metric: metric.value, range: range.value,
    });
    if (!rows.length || total === null) {
      output.append(make('p', !rows.length ? 'No songs found for this wallet or selection.' : lifetime ? 'Lifetime totals are unavailable.'
        : `No ${period === 'day' ? 'daily' : period === 'month' ? 'monthly' : 'weekly'} ${unit} history available for this period.`)); return;
    }
    const score = make('div', null, 'playback-score');
    const tracked = points.filter(p => p.value !== null);
    const partial = points.some(p => p.partial || p.value === null);
    const extent = lifetime ? 'all time' : `${tracked.length} ${period}${tracked.length === 1 ? '' : 's'}${partial ? ' · partial history' : ''}`;
    score.append(make('strong', `${number.format(total)} ${unit}`), make('small', `${rows.length} ${rows.length === 1 ? 'song' : 'songs'} · ${extent}`));
    output.append(score);
    if (tracked.length) renderPlot(points, period, unit, lifetime);
    else if (lifetime) output.append(make('p', 'No dated history available for the chart.'));
    renderRanking(rows);
  }

  function renderPlot(points, period, unit, lifetime) {
    const figure = make('figure', null, 'playback-plot'), bars = make('div', null, 'playback-bars');
    figure.setAttribute('aria-label', `${personal ? 'Your' : 'Selected'} ${unit} by ${period}`);
    if (lifetime) figure.append(make('small', 'Dated history only', 'playback-axis'));
    const readout = make('figcaption', '', 'playback-readout');
    const hi = Math.max(0, ...points.map(p => p.value)), lo = Math.min(0, ...points.map(p => p.value));
    const span = hi - lo || 1, zero = hi || lo ? hi / span * 100 : 100;
    bars.style.setProperty('--zero', `${zero}%`);
    for (const p of points) {
      const when = p.through ? `${labelDate(p.date, true)} – ${labelDate(p.through, true)}`
        : `${period === 'week' ? 'Week of ' : ''}${labelDate(p.date)}`;
      const label = `${when}: ${p.value === null ? 'no dated history' : `${number.format(p.value)} ${unit}`}${p.partial ? ` · partial ${period}` : ''}${p.current ? ' · in progress' : ''}`;
      const button = make('button', null, `playback-bar${p.value === null ? ' missing' : p.value < 0 ? ' negative' : ''}${p.partial || p.current ? ' incomplete' : ''}`);
      button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
      const bar = make('i'); bar.style.height = `${Math.abs(p.value) / span * 100}%`;
      bar.style.top = `clamp(0px, ${p.value > 0 ? zero - p.value / span * 100 : zero}%, calc(100% - 2px))`;
      button.append(bar); bars.append(button);
      for (const event of ['focus', 'pointerenter', 'click']) button.addEventListener(event, () => { readout.textContent = label; });
      readout.textContent = label;
    }
    const axis = make('div', null, 'playback-axis');
    axis.append(make('span', labelDate(points[0].date, lifetime)), make('span', labelDate(points.at(-1).through || points.at(-1).date, lifetime)));
    figure.append(bars, axis, readout); output.append(figure);
  }

  function renderRanking(rows) {
    const ranking = make('details', null, 'playback-ranking');
    ranking.open = rankingOpen;
    ranking.addEventListener('toggle', () => { if (ranking.isConnected) rankingOpen = ranking.open; });
    const head = make('summary', personal ? 'My song ranking' : 'Song ranking');
    const order = make('select'); order.setAttribute('aria-label', 'Rank songs by count');
    order.append(new Option('Most first', 'most'), new Option('Least first', 'least'));
    order.value = ascending ? 'least' : 'most';
    const list = make('ol');
    function rank() {
      rows.sort((a, b) => (ascending ? a.value - b.value : b.value - a.value) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
      list.replaceChildren(...rows.map(song => {
        const row = make('li'), line = make('div', null, 'playback-ranked-row');
        const link = make('button', song.title); link.type = 'button'; link.title = `Graph ${song.title}`;
        link.addEventListener('click', () => showSong(song.id));
        const identity = make('span'); identity.append(link);
        if (!personal) identity.append(make('small', song.artist));
        line.append(identity, make('b', number.format(song.value))); row.append(line); return row;
      }));
    }
    ranking.append(head, order, list);
    order.addEventListener('change', () => { ascending = order.value === 'least'; rank(); });
    ranking.addEventListener('toggle', () => { if (ranking.open && !list.childElementCount) rank(); });
    if (ranking.open) rank();
    output.append(ranking);
  }

  scope.addEventListener('change', updateScope);
  for (const control of [metric, range, subject]) control.addEventListener('change', render);
  search.addEventListener('input', songOptions);
  options.addEventListener('change', e => {
    if (!data?.songs.has(e.target.value)) return;
    if (e.target.checked) selected.add(e.target.value); else selected.delete(e.target.value);
    selectionLabel();
    render();
  });
  function clear() {
    data = null; selected.clear(); search.value = '';
    options.replaceChildren(); subject.replaceChildren(); output.replaceChildren();
    picker.open = false; root.hidden = true;
  }
  return { clear, load(reports, catalog, wallet, periods) {
    clear(); personal = Boolean(wallet); data = playbackDataset(reports, catalog, wallet, periods);
    scope.options[0].textContent = personal ? 'My songs' : 'Station mix';
    scope.querySelector('[value="artist"]').hidden = personal;
    scope.value = 'all'; range.value = '8'; metric.value = 'plays';
    ascending = false; rankingOpen = false; updateScope();
  } };
}
