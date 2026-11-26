import { fetchPinnerState } from './pinner-rewards-ui.mjs?v=20261126-pinner-dashboard';
import { PINNER_POLICY } from './pinner-rewards.mjs';
import { formatUsdcUnits } from './usdc-format.mjs';

export function pinnerHealth(pinner, now = Date.now()) {
  if (pinner.status !== 'active') return pinner.status;
  const age = now - Date.parse(pinner.lastVerifiedAt);
  if (!Number.isFinite(age) || age < 0 || age > PINNER_POLICY.staleAfterMs) return 'unverified';
  return pinner.lastCheck?.ok === false ? 'degraded' : 'verified';
}

export function pinnerNetworkSummary(state, now = Date.now()) {
  const participants = state.participants;
  return {
    enrolled: participants.length,
    approved: participants.filter(pinner => pinner.status === 'active').length,
    verified: participants.filter(pinner => pinnerHealth(pinner, now) === 'verified').length,
    qualified: participants.filter(pinner => pinner.qualified).length,
  };
}

export function monthlyPinnerCost({ watts, hoursPerDay, pricePerKwh, hosting }) {
  const values = [watts, hoursPerDay, pricePerKwh, hosting].map(value =>
    String(value).trim() ? Number(value) : NaN);
  if (values.some(value => !Number.isFinite(value) || value < 0) || values[1] > 24) {
    throw new Error('Enter nonnegative costs and 0–24 hours per day.');
  }
  return values[0] / 1000 * values[1] * 30 * values[2] + values[3];
}

export function createPinnerNetworkView({ root, fetchImpl = fetch }) {
  const doc = root.ownerDocument;
  let state, selected = '', loading = false;
  const el = (tag, text, className = '') => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    node.className = className;
    return node;
  };
  const svgNode = (tag, attrs, text) => {
    const node = doc.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function render() {
    root.replaceChildren();
    if (!state?.ready || state.rewardStatus !== 'active') {
      root.append(el('p', state?.lastError || 'Pinner verification is unavailable. Health and earnings cannot be confirmed.', 'pinner-status is-error'));
      return;
    }
    const summary = pinnerNetworkSummary(state);
    const stats = el('div', undefined, 'pinner-network-stats');
    for (const [value, label] of [[summary.enrolled, 'enrolled'], [summary.approved, 'approved'],
      [summary.verified, 'recently verified'], [summary.qualified, 'qualifying this week']]) {
      const card = el('div');
      card.append(el('strong', String(value)), el('span', label));
      stats.append(card);
    }
    root.append(stats);
    const svg = svgNode('svg', { viewBox: '0 0 640 330', role: 'img', 'aria-label': 'Registered pinners around the community archive. Lines show membership, not peer-to-peer connections.' });
    const nodes = state.participants.slice(0, 40);
    nodes.forEach((pinner, index) => {
      const angle = -Math.PI / 2 + 2 * Math.PI * index / nodes.length;
      const x = 320 + Math.cos(angle) * 245, y = 160 + Math.sin(angle) * 120;
      const health = pinnerHealth(pinner);
      svg.append(svgNode('line', { x1: 320, y1: 160, x2: x, y2: y, class: `pinner-map-link is-${health}` }));
      const group = svgNode('g', { class: `pinner-map-node is-${health}${selected === pinner.wallet ? ' is-selected' : ''}` });
      group.append(svgNode('circle', { cx: x, cy: y, r: 12 }),
        svgNode('text', { x, y: y + 28, 'text-anchor': 'middle' }, `${pinner.wallet.slice(0, 6)}…${pinner.wallet.slice(-4)}`),
        svgNode('title', {}, `${pinner.wallet}: ${health}`));
      svg.append(group);
    });
    svg.append(svgNode('circle', { cx: 320, cy: 160, r: 47, class: 'pinner-map-core' }),
      svgNode('text', { x: 320, y: 155, 'text-anchor': 'middle', class: 'pinner-map-title' }, 'DBusk'),
      svgNode('text', { x: 320, y: 175, 'text-anchor': 'middle' }, 'public archive'));
    const figure = el('figure', undefined, 'pinner-network-map');
    figure.append(svg, el('figcaption', 'Verified = successful service check within 24h. Amber = pending, stale or degraded. Lines show registered membership, not live swarm traffic or a geographic location.'));
    root.append(figure);
    if (!nodes.length) root.append(el('p', 'No pinners enrolled yet. Become one of the first independent copies of the community archive.', 'pinner-network-empty'));
    if (state.participants.length > nodes.length) root.append(el('p', `Showing ${nodes.length} of ${state.participants.length} nodes; every registered node is available below.`));
    const choose = el('select');
    choose.setAttribute('aria-label', 'Inspect a registered pinner');
    const placeholder = el('option', 'Inspect a node');
    placeholder.value = ''; choose.append(placeholder);
    for (const pinner of state.participants) {
      const option = el('option', `${pinner.wallet.slice(0, 8)}…${pinner.wallet.slice(-4)} · ${pinnerHealth(pinner)}${pinner.wallet === window._wallet?.address?.toLowerCase() ? ' · you' : ''}`);
      option.value = pinner.wallet; choose.append(option);
    }
    choose.value = selected;
    choose.addEventListener('change', () => { selected = choose.value; render(); root.querySelector('select')?.focus(); });
    root.append(choose);
    const mine = state.participants.find(pinner => pinner.wallet === selected);
    if (mine) {
      const card = el('article', undefined, 'pinner-row');
      card.append(el('strong', `${mine.wallet} · ${mine.status}`), el('code', mine.peerId),
        el('p', `${mine.successfulChecks} successful / ${mine.failedChecks} failed checks this week`));
      const meter = el('meter');
      meter.min = 0; meter.max = 100; meter.value = mine.availabilityBps / 100;
      meter.setAttribute('aria-label', 'This week’s check availability');
      card.append(meter, el('p', `${(mine.availabilityBps / 100).toFixed(1)}% availability · minimum 90%`),
        el('p', mine.qualified ? `${formatUsdcUnits(mine.estimatedUnits)} USDC estimated this week; not guaranteed or paid yet.`
          : 'Not yet qualified for this week. At least 20 checks and a recent successful check are required.'));
      if (mine.lastCheck) card.append(el('p', `Last check: ${new Date(mine.lastCheck.at).toLocaleString()} · ${mine.lastCheck.ok ? 'passed' : mine.lastCheck.reason || 'failed'}`));
      root.append(card);
    }
    root.append(el('p', `${formatUsdcUnits(state.fund.availableUnits)} USDC available this week · ${formatUsdcUnits(state.fund.reservedUnits)} USDC reserved for unpaid awards.`, 'pinner-fund'),
      el('p', 'The weekly pot is shared by qualifying nodes, weighted by successful checks. More pinners add independent copies, but divide the same pot unless funding grows. Awards are finalized at the New York weekly cutoff and paid by owner-signed payroll.', 'pinner-help'));
    if (state.fund.warning) root.append(el('p', state.fund.warning, 'pinner-status is-error'));
    root.append(el('p', `Verifier last updated: ${state.lastCheckedAt ? new Date(state.lastCheckedAt).toLocaleString() : 'not yet reported'}. This is a snapshot, not continuous monitoring.`, 'pinner-help'));
  }
  async function load() {
    if (loading) return;
    loading = true;
    root.textContent = 'Reading verified community nodes…';
    try {
      state = await fetchPinnerState({ fetchImpl });
      if (!selected) selected = window._wallet?.address?.toLowerCase() || '';
      render();
    } catch (error) {
      state = null;
      root.replaceChildren(el('p', `Network health unavailable: ${error.message}`, 'pinner-status is-error'));
    } finally { loading = false; }
  }
  return { load };
}
