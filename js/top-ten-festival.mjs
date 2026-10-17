function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export const HYPE_INFO_TEXT = 'Friday Night Hype is a scheduled program to hype the Top 10 for the last two days of the week. '
  + 'Friday at 8pm, the program plays the Top 10 so everyone can be sure to tune in and vote before SUN/MON close, '
  + 'when the chart locks and the payout amounts are decided.';

const EQ_BARS = 24;
const EQ_REST = 0.04;

// Bands widen toward the highs (bass gets single bins), so bass, mids and highs each get distinct bars.
export function spectrumBars(data, count = EQ_BARS, previous = []) {
  const usable = Math.max(count + 1, Math.floor(data.length * 0.7));
  const edges = [1];
  for (let bar = 1; bar <= count; bar++) {
    edges.push(Math.max(edges[bar - 1] + 1, 1 + Math.round((usable - 1) * Math.pow(bar / count, 1.8))));
  }
  const levels = [];
  for (let bar = 0; bar < count; bar++) {
    let peak = 0;
    for (let bin = edges[bar]; bin < edges[bar + 1] && bin < data.length; bin++) peak = Math.max(peak, data[bin]);
    const level = Math.max(EQ_REST, Math.pow(peak / 255, 1.6));
    levels.push(Math.max(level, (previous[bar] ?? EQ_REST) * 0.82));
  }
  return levels;
}

export function mountTopTenFestival(panel, { readSpectrum = null } = {}) {
  const banner = element('section', 'hype-festival');
  banner.setAttribute('aria-label', 'Friday Night Top 10 Hype');
  const eyebrow = element('div', 'hype-eyebrow', 'FRIDAY NIGHT • COMMUNITY RADIO');
  const title = element('h3', 'hype-title');
  title.append(element('span', 'hype-title-top', 'Top 10'), element('span', 'hype-title-show', 'Friday Night Hype'));
  const info = element('button', 'hype-info-button', 'i');
  info.type = 'button';
  info.setAttribute('aria-label', 'About Friday Night Hype');
  info.setAttribute('aria-expanded', 'false');
  const infoText = element('p', 'hype-info-popover', HYPE_INFO_TEXT);
  infoText.id = `hype-info-${Math.random().toString(36).slice(2)}`;
  infoText.hidden = true;
  info.setAttribute('aria-controls', infoText.id);
  const setInfo = show => { infoText.hidden = !show; info.setAttribute('aria-expanded', String(show)); };
  info.addEventListener('click', event => { event.stopPropagation(); setInfo(infoText.hidden); });
  const infoKey = event => { if (event.key === 'Escape' && !infoText.hidden) { event.stopPropagation(); setInfo(false); info.focus(); } };
  banner.addEventListener('keydown', infoKey);
  const subtitle = element('p', 'hype-subtitle', 'Ten songs. One dance floor. Your votes.');
  const stage = element('div', 'hype-stage');
  stage.setAttribute('aria-hidden', 'true');
  const characters = [
    ['hype-planet', '🌝'], ['hype-celestial hype-celestial-lilith', '⚸'],
    ['hype-celestial hype-celestial-venus', '♀︎'], ['hype-celestial hype-celestial-mercury', '☿'],
    ['hype-trophy', '🏆'],
  ];
  for (const [className, symbol] of characters) stage.append(element('span', className, symbol));
  const band = element('div', 'hype-band');
  for (const [index, [symbol, instrument]] of [['🦙', '🎸'], ['🐇', '🎤'], ['🧞‍♀️', '🎹'], ['🧞‍♂️', '🥁']].entries()) {
    const musician = element('span', 'hype-bandmate');
    musician.style.setProperty('--member', index);
    musician.append(element('span', 'hype-performer', symbol), element('span', 'hype-instrument', instrument));
    band.append(musician);
  }
  const runaway = element('span', 'hype-runaway');
  runaway.append(element('span', 'hype-runaway-bunny', '🐇'));
  const stageHole = element('span', 'hype-rabbit-hole', '🕳️');
  const spyPeek = element('span', 'top-ten-spy-peek');
  spyPeek.append(element('span', 'top-ten-spy', '🕵️'));
  stageHole.append(spyPeek);
  stage.append(stageHole, runaway, band);
  for (const [animal, symbol] of [['fox', '🦊'], ['rat', '🐀'], ['bird', '💸']]) {
    const visitor = element('span', `hype-runaway hype-runaway-${animal}`);
    visitor.append(element('span', 'hype-runaway-bunny', symbol));
    stage.append(visitor);
  }
  for (let index = 0; index < 9; index++) {
    const particle = element('span', 'hype-spark', ['\u266A', '\u{1F4B8}', '\u2726', '\u{1FA99}', '\u266B'][index % 5]);
    particle.style.setProperty('--i', index);
    stage.append(particle);
  }
  const equalizer = element('div', 'hype-equalizer');
  const bars = [];
  for (let index = 0; index < EQ_BARS; index++) {
    const bar = element('i', '');
    bar.style.setProperty('--i', index);
    bar.style.transform = `scaleY(${EQ_REST})`;
    bars.push(bar);
    equalizer.append(bar);
  }
  let spectrum = null;
  let levels = [];
  let frame = 0;
  let waveMode = false;
  const wave = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  wave.setAttribute('class', 'hype-wave');
  wave.setAttribute('viewBox', '0 0 240 100');
  wave.setAttribute('preserveAspectRatio', 'none');
  const wavePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  wave.append(wavePath);
  equalizer.append(wave);
  const meterToggle = element('button', 'hype-meter-toggle', 'Wave');
  meterToggle.type = 'button';
  meterToggle.setAttribute('aria-label', 'Show smooth wave instead of equalizer bars');
  meterToggle.setAttribute('aria-pressed', 'false');
  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  const paint = values => {
    values.forEach((value, index) => { bars[index].style.transform = `scaleY(${value.toFixed(3)})`; });
    const points = values.map((value, index) => ({ x: index * 240 / (values.length - 1), y: 96 - value * 90 }));
    let path = `M ${points[0].x} ${points[0].y}`;
    for (let index = 1; index < points.length; index++) {
      const previous = points[index - 1];
      const current = points[index];
      const middle = (previous.x + current.x) / 2;
      path += ` C ${middle} ${previous.y}, ${middle} ${current.y}, ${current.x} ${current.y}`;
    }
    wavePath.setAttribute('d', path);
  };
  const toggleMeter = () => {
    waveMode = !waveMode;
    equalizer.classList.toggle('is-wave', waveMode);
    meterToggle.textContent = waveMode ? 'Bars' : 'Wave';
    meterToggle.setAttribute('aria-pressed', String(waveMode));
    meterToggle.setAttribute('aria-label', waveMode ? 'Show equalizer bars instead of smooth wave' : 'Show smooth wave instead of equalizer bars');
    paint(levels.length ? levels : bars.map(() => EQ_REST));
  };
  meterToggle.addEventListener('click', toggleMeter);
  const tick = () => {
    frame = 0;
    if (document.hidden || reducedMotion?.matches || !panel.classList.contains('is-open')) {
      levels = [];
      paint(bars.map(() => EQ_REST));
      return;
    }
    spectrum ||= new Uint8Array(128);
    const live = typeof readSpectrum === 'function' && readSpectrum(spectrum) === true;
    if (!live) spectrum.fill(0);
    levels = spectrumBars(spectrum, EQ_BARS, levels);
    equalizer.classList.toggle('is-live', live);
    paint(levels);
    frame = globalThis.requestAnimationFrame?.(tick) || 0;
  };
  const startMeter = () => { if (!frame && globalThis.requestAnimationFrame) frame = globalThis.requestAnimationFrame(tick); };
  stage.append(equalizer);
  const progress = element('div', 'hype-progress');
  const position = element('strong', 'hype-position');
  position.setAttribute('role', 'status');
  position.setAttribute('aria-live', 'polite');
  const live = element('span', 'hype-on-air', 'ON AIR');
  progress.append(live, position, meterToggle);
  const note = element('p', 'hype-chart-explainer', 'Opening chart sets the play order. Your votes move the live ranks below.');
  const warning = element('p', 'hype-warning');
  banner.append(info, infoText, eyebrow, title, subtitle, stage, progress, note, warning);
  panel.querySelector('.top-ten-panel-heading').after(banner);
  panel.classList.add('is-hype-festival');
  document.body.classList.add('top-ten-festival-open');
  const visibility = () => { banner.classList.toggle('is-paused', document.hidden); if (!document.hidden) startMeter(); };
  document.addEventListener('visibilitychange', visibility);
  visibility();
  return {
    update({ openingRank, encore = false, title: songTitle = '', status = 'ready', error = '', lateSnapshot = false, skipped = [] } = {}) {
      position.textContent = status === 'empty' ? 'OPENING CHART EMPTY' : status === 'unavailable' ? 'COUNTDOWN PAUSED'
        : status === 'preparing' ? 'PREPARING OPENING CHART'
        : encore ? 'ENCORE' : Number.isInteger(openingRank) ? `OPENING #${openingRank}` : 'COUNTING UP TO #1';
      banner.classList.toggle('is-headliner', openingRank === 1 && !encore);
      note.textContent = songTitle
        ? `${songTitle} · ${encore ? 'Encore' : `Opening #${openingRank}`} · live ranks below`
        : 'Opening chart sets the play order. Your votes move the live ranks below.';
      warning.textContent = [error, lateSnapshot ? 'Radio started late: this chart was captured on arrival, not exactly at the opening bell.' : '',
        ...skipped.map(entry => `Opening #${entry.openingRank} skipped: ${entry.reason}`)].filter(Boolean).join(' ');
    },
    resume: startMeter,
    destroy() {
      if (frame) globalThis.cancelAnimationFrame?.(frame);
      frame = 0;
      document.removeEventListener('visibilitychange', visibility);
      banner.removeEventListener('keydown', infoKey);
      meterToggle.removeEventListener('click', toggleMeter);
      panel.classList.remove('is-hype-festival');
      document.body.classList.remove('top-ten-festival-open');
      banner.remove();
    },
  };
}
