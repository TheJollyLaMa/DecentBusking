import { spectrumBars } from './top-ten-festival.mjs?v=20261016-hype-bunny';

export function mountTopTenLiveMeter({ panel, content, button, readSpectrum, readWaveform }) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const frequencies = new Uint8Array(128);
  const waveform = new Uint8Array(256);
  let row = null;
  let meter;
  let bars = [];
  let path;
  let levels = [];
  let wave = false;
  let frame = 0;
  const position = () => {
    if (!row || !meter) return;
    const bounds = panel.getBoundingClientRect();
    const song = row.getBoundingClientRect();
    const viewport = content.getBoundingClientRect();
    const visible = song.bottom > viewport.top && song.top < viewport.bottom;
    meter.hidden = !visible;
    meter.style.left = `${song.left - bounds.left}px`;
    meter.style.width = `${song.width}px`;
    meter.style.top = '0px';
    meter.style.height = `${Math.max(0, song.top - bounds.top)}px`;
  };
  const reset = () => {
    levels = [];
    bars.forEach(bar => { bar.style.transform = 'scaleY(.04)'; });
    path?.setAttribute('d', 'M 0 50 L 256 50');
    meter?.classList.remove('is-live');
  };
  const tick = () => {
    frame = 0;
    if (!row || document.hidden || reduced.matches || panel.getAttribute('aria-hidden') !== 'false') return;
    position();
    const live = wave ? readWaveform(waveform) === true : readSpectrum(frequencies) === true;
    meter.classList.toggle('is-live', live);
    if (wave) {
      if (!live) waveform.fill(128);
      path.setAttribute('d', [...waveform].map((value, index) =>
        `${index ? 'L' : 'M'} ${index} ${(50 + (value - 128) * .36).toFixed(2)}`).join(' '));
    } else {
      if (!live) frequencies.fill(0);
      levels = spectrumBars(frequencies, bars.length, levels);
      bars.forEach((bar, index) => { bar.style.transform = `scaleY(${levels[index]})`; });
    }
    frame = requestAnimationFrame(tick);
  };
  const sync = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    const current = content.querySelector('.top-ten-song.is-now-playing');
    if (row !== current) {
      meter?.remove();
      row = current;
      bars = [];
      levels = [];
      if (row) {
        meter = document.createElement('div');
        meter.className = 'top-ten-live-meter';
        meter.setAttribute('aria-hidden', 'true');
        for (let index = 0; index < 24; index++) {
          const bar = document.createElement('i');
          bars.push(bar);
          meter.append(bar);
        }
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 256 100');
        svg.setAttribute('preserveAspectRatio', 'none');
        path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        svg.append(path);
        meter.append(svg);
        panel.append(meter);
      }
    }
    meter?.classList.toggle('is-wave', wave);
    position();
    reset();
    if (row && !document.hidden && !reduced.matches && panel.getAttribute('aria-hidden') === 'false') frame = requestAnimationFrame(tick);
  };
  const toggle = () => {
    wave = !wave;
    button.textContent = wave ? '▥' : '∿';
    button.setAttribute('aria-pressed', String(wave));
    const label = wave ? 'Show live song frequency bars' : 'Show live song waveform';
    button.setAttribute('aria-label', label);
    button.title = label;
    sync();
  };
  const observer = new MutationObserver(sync);
  observer.observe(content, { childList: true });
  observer.observe(panel, { attributes: true, attributeFilter: ['aria-hidden'] });
  button.addEventListener('click', toggle);
  reduced.addEventListener('change', sync);
  document.addEventListener('visibilitychange', sync);
  content.addEventListener('scroll', position, { passive: true });
  sync();
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    button.removeEventListener('click', toggle);
    reduced.removeEventListener('change', sync);
    document.removeEventListener('visibilitychange', sync);
    content.removeEventListener('scroll', position);
    meter?.remove();
  };
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', async () => {
  const panel = document.getElementById('top-ten-panel');
  const content = document.getElementById('top-ten-content');
  const button = document.getElementById('top-ten-meter-toggle');
  if (!panel || !content || !button) return;
  try {
    const { readNowPlayingSpectrum, readNowPlayingWaveform } = await import('./space.js?v=20261017-sidepanel-live');
    mountTopTenLiveMeter({ panel, content, button, readSpectrum: readNowPlayingSpectrum, readWaveform: readNowPlayingWaveform });
  } catch (error) {
    button.disabled = true;
    button.title = 'Live song meter unavailable';
    console.warn('[top-ten] Live song meter unavailable:', error.message);
  }
}, { once: true });
