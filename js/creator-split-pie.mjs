import { lookupEnsName } from './ens-client.mjs?v=20261016-ens-worker';
import { validateCreatorSplitRows } from './creator-splits.mjs?v=20261025-song-splits';
import { renderWallet } from './wallet-label.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
const COLORS = [
  '#62cffa', '#edbd49', '#b69bff', '#64d5a5', '#ff9282', '#84aaff', '#df91d2', '#c4d985',
  '#55b6cf', '#dfa86a', '#987ade', '#46b985', '#e77b9c', '#8092d9', '#c57cc0', '#a6be69',
];

function point(angle) {
  const radians = (angle - 90) * Math.PI / 180;
  return [120 + 94 * Math.cos(radians), 120 + 94 * Math.sin(radians)];
}

function slicePath(start, end) {
  const [x1, y1] = point(start);
  const [x2, y2] = point(end);
  return `M 120 120 L ${x1.toFixed(3)} ${y1.toFixed(3)} A 94 94 0 ${end - start > 180 ? 1 : 0} 1 ${x2.toFixed(3)} ${y2.toFixed(3)} Z`;
}

export function renderCreatorSplitPie(root, rows, {
  label = 'Payout split', lookupName = lookupEnsName, document: doc = document,
} = {}) {
  const entries = validateCreatorSplitRows(rows);
  root.replaceChildren();
  const chart = doc.createElement('div');
  chart.className = 'creator-split-pie';
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 240 240');
  svg.setAttribute('role', 'group');
  svg.setAttribute('aria-label', label);
  const tooltip = doc.createElement('div');
  tooltip.className = 'creator-split-pie-tooltip';
  tooltip.hidden = true;
  const walletLink = doc.createElement('a');
  walletLink.target = '_blank';
  walletLink.rel = 'noopener noreferrer';
  tooltip.append(walletLink);
  chart.append(svg, tooltip);
  root.append(chart);

  const names = entries.map(() => '');
  const lookupErrors = entries.map(() => false);
  let selected = -1;
  const show = index => {
    selected = index;
    const { wallet, shareBps } = entries[index];
    const name = names[index];
    walletLink.href = `https://basescan.org/address/${wallet}`;
    walletLink.title = lookupErrors[index] ? `${wallet} · ENS lookup unavailable` : wallet;
    walletLink.setAttribute('aria-label', `View ${name || wallet} on BaseScan, ${shareBps / 100}%`);
    const display = doc.createElement('span');
    display.className = 'creator-split-pie-wallet';
    if (name) display.textContent = name;
    else renderWallet(display, wallet);
    const share = doc.createElement('strong');
    share.textContent = `${shareBps / 100}%`;
    walletLink.replaceChildren(display, share);
    tooltip.hidden = false;
  };

  let cumulative = 0;
  entries.forEach((entry, index) => {
    const start = cumulative * 360 / 10000;
    cumulative += entry.shareBps;
    const end = cumulative * 360 / 10000;
    const slice = doc.createElementNS(SVG_NS, 'g');
    slice.setAttribute('class', 'creator-split-pie-slice');
    slice.setAttribute('tabindex', '0');
    slice.setAttribute('role', 'button');
    slice.setAttribute('aria-label', `${entry.wallet}, ${entry.shareBps / 100}%; show wallet link`);
    const shape = doc.createElementNS(SVG_NS, entry.shareBps === 10000 ? 'circle' : 'path');
    if (entry.shareBps === 10000) {
      shape.setAttribute('cx', '120');
      shape.setAttribute('cy', '120');
      shape.setAttribute('r', '94');
    } else {
      shape.setAttribute('d', slicePath(start, end));
    }
    shape.setAttribute('fill', COLORS[index]);
    slice.append(shape);
    slice.addEventListener('mouseenter', () => show(index));
    slice.addEventListener('focus', () => show(index));
    slice.addEventListener('click', () => show(index));
    slice.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        show(index);
      }
    });
    svg.append(slice);
    Promise.resolve().then(() => lookupName(entry.wallet)).then(name => {
      names[index] = typeof name === 'string' ? name : '';
      if (selected === index) show(index);
    }).catch(error => {
      lookupErrors[index] = true;
      console.warn('[split chart] ENS lookup failed:', error.message);
      if (selected === index) show(index);
    });
  });
  chart.addEventListener('mouseleave', () => {
    if (!chart.contains(doc.activeElement)) tooltip.hidden = true;
  });
  chart.addEventListener('focusout', event => {
    if (!chart.contains(event.relatedTarget) && !chart.matches(':hover')) tooltip.hidden = true;
  });

  const center = doc.createElementNS(SVG_NS, 'circle');
  center.setAttribute('cx', '120');
  center.setAttribute('cy', '120');
  center.setAttribute('r', '25');
  center.setAttribute('class', 'creator-split-pie-center');
  const symbol = doc.createElementNS(SVG_NS, 'text');
  symbol.setAttribute('x', '120');
  symbol.setAttribute('y', '127');
  symbol.setAttribute('text-anchor', 'middle');
  symbol.setAttribute('class', 'creator-split-pie-symbol');
  symbol.textContent = '⚸';
  svg.append(center, symbol);
}
