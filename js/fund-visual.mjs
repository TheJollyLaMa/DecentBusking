import { escapeHtml } from './fund-display.mjs?v=20261124-lazy-funds';

const COLORS = ['#91ddd3', '#ddbc7b', '#a993e8', '#df91b6', '#85bbed', '#c4df91', '#eda181'];

export function renderFundBalanceChart(rows, view = 'bars') {
  const amounts = rows.map(row => BigInt(row.units));
  if (amounts.some(amount => amount < 0n)) throw new Error('Fund balances cannot be negative');
  const total = amounts.reduce((sum, amount) => sum + amount, 0n);
  const maximum = amounts.reduce((max, amount) => amount > max ? amount : max, 0n);
  let boundary = 0, cumulative = 0n;
  const slices = rows.map((row, index) => {
    const start = boundary;
    cumulative += amounts[index];
    boundary = total ? Number(cumulative * 1000000n / total) / 10000 : 0;
    return `${COLORS[index % COLORS.length]} ${start}% ${boundary}%`;
  });
  const bars = rows.map((row, index) => `<li data-fund-chart-slug="${escapeHtml(row.slug || '')}" style="--fund-color:${COLORS[index % COLORS.length]};--fund-width:${maximum ? Number(amounts[index] * 10000n / maximum) / 100 : 0}%">
    <span class="fund-chart-name">${escapeHtml(row.label)}</span>
    ${view === 'bars' ? `<span class="fund-chart-track" aria-hidden="true">${amounts[index] ? '<span class="fund-chart-bar"></span>' : ''}</span>` : '<span class="fund-chart-dot" aria-hidden="true"></span>'}
    <strong>${escapeHtml(row.amountText)}</strong></li>`).join('');
  return `${view === 'pie' && total ? `<div class="fund-chart-pie" aria-hidden="true" style="background:conic-gradient(${slices.join(',')})"></div>` : ''}
    ${!total ? '<p class="fund-chart-empty">No balance in this currency yet.</p>' : ''}
    <ul class="fund-chart-legend">${bars}</ul>`;
}
