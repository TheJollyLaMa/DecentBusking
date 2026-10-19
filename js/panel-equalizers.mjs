import { spectrumBars } from './top-ten-festival.mjs?v=20261016-hype-bunny';

export function mountPanelEqualizers({ readSpectrum, root = document } = {}) {
  const meters = [...root.querySelectorAll('[data-panel-equalizer]')].map(node => ({
    node, panel: node.closest('aside'), bars: [...node.children], levels: [],
  }));
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const spectrum = new Uint8Array(128);
  let frame = 0;
  const visible = meter => meter.panel.getAttribute('aria-hidden') === 'false';
  const paint = (meter, levels) => meter.bars.forEach((bar, index) => {
    bar.style.transform = `scaleY(${levels[index]})`;
  });
  const reset = meter => {
    meter.levels = [];
    meter.node.classList.remove('is-live');
    paint(meter, meter.bars.map(() => .04));
  };
  const tick = () => {
    frame = 0;
    if (document.hidden || reduced.matches || !meters.some(visible)) return;
    const live = readSpectrum(spectrum) === true;
    if (!live) spectrum.fill(0);
    for (const meter of meters) {
      if (!visible(meter)) continue;
      meter.levels = spectrumBars(spectrum, meter.bars.length, meter.levels);
      meter.node.classList.toggle('is-live', live);
      paint(meter, meter.levels);
    }
    frame = requestAnimationFrame(tick);
  };
  const sync = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    for (const meter of meters) if (!visible(meter) || document.hidden || reduced.matches) reset(meter);
    if (!document.hidden && !reduced.matches && meters.some(visible)) frame = requestAnimationFrame(tick);
  };
  const observer = new MutationObserver(sync);
  for (const meter of meters) observer.observe(meter.panel, { attributes: true, attributeFilter: ['aria-hidden'] });
  reduced.addEventListener('change', sync);
  document.addEventListener('visibilitychange', sync);
  sync();
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    reduced.removeEventListener('change', sync);
    document.removeEventListener('visibilitychange', sync);
    meters.forEach(reset);
  };
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', async () => {
  try {
    // Match main.js: every meter must share the existing media-element audio graph.
    const { readNowPlayingSpectrum } = await import('./space.js?v=20261019-radio-recovery');
    mountPanelEqualizers({ readSpectrum: readNowPlayingSpectrum });
  } catch (error) {
    console.warn('[panel-equalizers] Live audio spectrum unavailable:', error.message);
  }
}, { once: true });
