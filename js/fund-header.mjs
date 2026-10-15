import { workerEnsProvider } from './ens-client.mjs?v=20261016-ens-worker';
import { getBaseReadProvider } from './base-chain.mjs?v=20261018-shared-provider';
import { escapeHtml, formatUsdcUnits, renderWalletButton, resolveWalletLabel } from './fund-display.mjs?v=20261014-funds';
import { normalizeKnownAddress } from './known-addresses.mjs';
import { currentPayrollPeriod, weekNumberFromKey } from './payroll-week.mjs';

const ROUTER_ADDRESS = '0x8ecca903e2a6Daa8CCbB933700e4F2C58C44A4B5';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const FUNDS = [
  { slug: 'dbusk-top10', emoji: '🏆', label: 'Top10 fund' },
  { slug: 'dbusk-playback', emoji: '🎧', label: 'Playback fund' },
];
const USDC_ICON = '<img class="usdc-icon" src="img/usdc.svg" alt="USDC" width="16" height="16">';

export function fundWeekNumber(now = Date.now()) {
  return weekNumberFromKey(currentPayrollPeriod(now).week);
}

export function fundTitle(fund, now = Date.now()) {
  return `${fund.emoji} Week ${fundWeekNumber(now)} ${fund.label}`;
}

export function usdcAmountHtml(balanceUnits) {
  return `$${escapeHtml(formatUsdcUnits(balanceUnits))} ${USDC_ICON}`;
}

const historyCache = new Map();
const balanceCache = new Map();
let stateCache = null;

function ethersLib() {
  return window.ethers;
}

function providerForRead() {
  return getBaseReadProvider({ ethers: ethersLib() });
}

function providerForEns() {
  return workerEnsProvider;
}

function normalizeAddress(value) {
  return String(value || '').toLowerCase();
}

function parseUnitsLike(value) {
  return typeof value === 'bigint' ? value : BigInt(value || 0);
}

function baseScanUrl(path) {
  return `https://basescan.org${path}`;
}

function formatDateTime(timestamp) {
  if (!timestamp) return 'Unknown date';
  return new Date(timestamp * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

function sourceHintMap(fundState = {}) {
  const hints = new Map();
  for (const source of fundState.sources || []) {
    if (!source?.txHash) continue;
    const key = `${normalizeAddress(source.txHash)}:${Number(source.logIndex ?? 0)}`;
    hints.set(key, source);
  }
  return hints;
}

async function resolveWallet(address, provider, sponsorAliases, cache) {
  if (!address) return { address: '', label: '' };
  if (!provider) return { address, label: address, aliases: [] };
  return resolveWalletLabel(address, provider, sponsorAliases, cache);
}

function sourceKindLabel(kind) {
  return {
    advert: 'Advert purchase',
    djuke: 'DJuke purchase',
    sponsor: 'Sponsor deposit',
    payout: 'Payroll payout',
  }[kind] || 'Sponsor deposit';
}

async function inflowRow(source, { ensProvider, sponsorAliases, cache }) {
  const funder = normalizeAddress(source.funder || '');
  const wallet = await resolveWallet(source.funder || '', ensProvider, sponsorAliases, cache);
  const config = globalThis.window?.DecentConfig || {};
  const devertContract = normalizeKnownAddress(config.devertContractAddress || '0x135Cbc573F87637158eb3186C87c584fb0B34CD9');
  const djukeContract = normalizeKnownAddress(config.djukeContractAddress || '0x5d07489163feBCdB39C9F579CCC36dff5A067FF9');
  const kind = source.kind || (funder === devertContract ? 'advert' : funder === djukeContract ? 'djuke' : 'sponsor');
  const advertiser = source.advertiser ? await resolveWallet(source.advertiser, ensProvider, sponsorAliases, cache) : null;
  const extra = kind === 'advert'
    ? [source.campaignId ? `Campaign #${escapeHtml(String(source.campaignId))}` : '', source.title ? escapeHtml(source.title) : '', advertiser?.label ? `via ${advertiser.label}` : '']
      .filter(Boolean).join(' · ')
    : kind === 'djuke'
      ? source.requestId ? `DJuke request #${escapeHtml(String(source.requestId))}` : 'DJuke purchase'
      : '';
  const timestamp = Number(source.timestamp || 0);
  const txHash = String(source.txHash || '');
  return {
    direction: 'in',
    kind,
    typeLabel: sourceKindLabel(kind),
    amountUnits: String(source.amountUnits || '0'),
    timestamp,
    dateText: formatDateTime(timestamp),
    sourceHtml: renderWalletButton(wallet, { role: kind }),
    sourceLabel: wallet.label || wallet.address,
    extra,
    txHash,
    txUrl: baseScanUrl(`/tx/${txHash}`),
    blockNumber: Number(source.blockNumber || 0),
    logIndex: Number(source.logIndex || 0),
  };
}

async function outflowRow(payout, { ensProvider, sponsorAliases, cache }) {
  const wallet = await resolveWallet(payout.recipient || '', ensProvider, sponsorAliases, cache);
  const timestamp = Number(payout.timestamp || 0);
  const txHash = String(payout.txHash || '');
  return {
    direction: 'out',
    kind: 'payout',
    typeLabel: sourceKindLabel('payout'),
    amountUnits: String(payout.amountUnits || '0'),
    timestamp,
    dateText: formatDateTime(timestamp),
    sourceHtml: renderWalletButton(wallet, { role: 'payout' }),
    sourceLabel: wallet.label || wallet.address,
    extra: 'PayrollPaid',
    txHash,
    txUrl: baseScanUrl(`/tx/${txHash}`),
    blockNumber: Number(payout.blockNumber || 0),
    logIndex: Number(payout.logIndex || 0),
  };
}

// History comes from the worker's fund ledger (/api/funds), which indexes deposits and payouts on the paid RPC tier.
export async function loadFundBreakdown({ fundSlug, fundState = null, fundBalanceUnits = 0n, ensProvider = providerForEns(), sponsorAliases = {} }) {
  const cacheKey = `${fundSlug}:${fundState?.lastCheckedAt || ''}:${fundState?.lastError || ''}`;
  const cached = historyCache.get(cacheKey);
  if (cached) return cached;
  const fallbackBalance = parseUnitsLike(fundState?.balanceUnits ?? fundBalanceUnits ?? 0n);
  if (!fundState || !Array.isArray(fundState.sources) || !Array.isArray(fundState.payouts)) {
    return { historyAvailable: false, error: new Error('Fund history is still indexing'), rows: [], inflows: [], outflows: [], inflowUnits: 0n, outflowUnits: 0n, netUnits: 0n, balanceUnits: fallbackBalance, reconciles: false };
  }
  const cache = new Map();
  try {
    const context = { ensProvider, sponsorAliases, cache };
    const inflows = await Promise.all(fundState.sources.map(source => inflowRow(source, context)));
    const outflows = await Promise.all(fundState.payouts.map(payout => outflowRow(payout, context)));
    const rows = [...inflows, ...outflows].sort((first, second) =>
      second.timestamp - first.timestamp || second.blockNumber - first.blockNumber || second.logIndex - first.logIndex);
    const inflowUnits = inflows.reduce((sum, row) => sum + parseUnitsLike(row.amountUnits), 0n);
    const outflowUnits = outflows.reduce((sum, row) => sum + parseUnitsLike(row.amountUnits), 0n);
    const netUnits = inflowUnits - outflowUnits;
    const balanceUnits = parseUnitsLike(fundState.balanceUnits ?? fundBalanceUnits ?? netUnits);
    const result = { historyAvailable: true, rows, inflows, outflows, inflowUnits, outflowUnits, netUnits, balanceUnits, reconciles: balanceUnits === netUnits };
    historyCache.set(cacheKey, result);
    return result;
  } catch (error) {
    return { historyAvailable: false, error, rows: [], inflows: [], outflows: [], inflowUnits: 0n, outflowUnits: 0n, netUnits: 0n, balanceUnits: fallbackBalance, reconciles: false };
  }
}

export function fundButtonHtml(fund, balanceUnits, now = Date.now()) {
  return `${escapeHtml(fundTitle(fund, now))}: ${usdcAmountHtml(balanceUnits)}`;
}

function dialogElements() {
  return {
    dialog: document.getElementById('fund-breakdown-dialog'),
    title: document.getElementById('fund-breakdown-title'),
    summary: document.getElementById('fund-breakdown-summary'),
    note: document.getElementById('fund-breakdown-note'),
    body: document.getElementById('fund-breakdown-body'),
    close: document.getElementById('fund-breakdown-close'),
  };
}

function renderBreakdown(details, fund, fundState) {
  const { body, summary, note, title } = dialogElements();
  if (!body || !summary || !note || !title) return;
  title.textContent = fundTitle(fund);
  summary.innerHTML = `Balance ${usdcAmountHtml(details.balanceUnits)} · in $${escapeHtml(formatUsdcUnits(details.inflowUnits))} · out $${escapeHtml(formatUsdcUnits(details.outflowUnits))} · net $${escapeHtml(formatUsdcUnits(details.netUnits))}`;
  note.textContent = fundState?.ready === false
    ? `History indexing${fundState?.lastError ? ` paused: ${fundState.lastError}` : '…'}`
    : details.historyAvailable
      ? (details.reconciles ? 'History reconciles against the on-chain balance.' : 'History loaded, but the totals do not fully reconcile yet.')
      : `${details.error?.message || 'Breakdown unavailable'}, try again shortly.`;
  const rows = details.rows.length
    ? details.rows.map(row => `
        <tr class="fund-breakdown-row fund-breakdown-${escapeHtml(row.direction)} fund-breakdown-${escapeHtml(row.kind)}">
          <td>${escapeHtml(row.dateText)}</td>
          <td>${escapeHtml(row.typeLabel || sourceKindLabel(row.kind))}</td>
          <td>${row.sourceHtml}${row.extra ? `<div class="fund-breakdown-extra">${escapeHtml(row.extra)}</div>` : ''}</td>
          <td class="fund-breakdown-amount">${row.direction === 'in' ? formatUsdcUnits(row.amountUnits) : ''}</td>
          <td class="fund-breakdown-amount">${row.direction === 'out' ? formatUsdcUnits(row.amountUnits) : ''}</td>
          <td><a href="${escapeHtml(row.txUrl)}" target="_blank" rel="noopener">Basescan</a></td>
        </tr>`).join('')
    : `<tr><td colspan="6" class="fund-breakdown-empty">Breakdown unavailable, try again.</td></tr>`;
  body.innerHTML = `
    <table class="fund-breakdown-table">
      <thead>
        <tr><th>Date</th><th>Type</th><th>Source</th><th>In</th><th>Out</th><th>Tx</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function loadState() {
  if (stateCache) return stateCache;
  const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
  if (!service) return null;
  try {
    const response = await fetch(`${service}/api/funds`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    const state = await response.json().catch(() => null);
    if (!response.ok || !state) return null;
    if (state.ready && !state.lastError) stateCache = state;
    return state;
  } catch {
    return null;
  }
}

async function loadBalance(fundSlug, state) {
  const fund = state?.funds?.[fundSlug];
  if (fund?.balanceUnits != null) return fund;
  const ethers = ethersLib();
  const provider = providerForRead();
  if (!ethers || !provider) return { balanceUnits: '0' };
  const router = new ethers.Contract(ROUTER_ADDRESS, ['function fundBalances(bytes32,address) view returns(uint256)'], provider);
  const balanceUnits = await router.fundBalances(ethers.id(fundSlug), USDC_ADDRESS).then(value => value.toString()).catch(() => '0');
  return { balanceUnits };
}

async function openBreakdown(fund, button) {
  const { dialog } = dialogElements();
  if (!dialog) return;
  button.disabled = true;
  const state = stateCache || await loadState();
  const fundState = state?.funds?.[fund.slug] || null;
  const details = await loadFundBreakdown({
    fundSlug: fund.slug,
    fundState,
    fundBalanceUnits: balanceCache.get(fund.slug) ?? 0n,
    sponsorAliases: state?.sponsorAliases || {},
    ensProvider: providerForEns(),
  });
  renderBreakdown(details, fund, fundState);
  dialog.showModal();
  button.disabled = false;
}

export async function initFundHeader() {
  const bar = document.getElementById('artist-filter-bar');
  if (!bar || bar.dataset.fundHeaderReady === '1') return;
  bar.dataset.fundHeaderReady = '1';
  const state = await loadState();
  const balances = await Promise.all(FUNDS.map(async fund => {
    const fundState = state?.funds?.[fund.slug] || await loadBalance(fund.slug, state);
    balanceCache.set(fund.slug, fundState.balanceUnits ?? '0');
    return [fund.slug, fundState];
  }));
  const balanceMap = Object.fromEntries(balances);
  for (const fund of FUNDS) {
    const button = document.getElementById(`${fund.slug}-button`);
    if (!button) continue;
    const balanceUnits = balanceMap[fund.slug]?.balanceUnits ?? '0';
    button.innerHTML = fundButtonHtml(fund, balanceUnits);
    button.setAttribute('aria-label', `${fundTitle(fund)}: $${formatUsdcUnits(balanceUnits)} USDC`);
    button.disabled = false;
    button.addEventListener('click', () => openBreakdown(fund, button).catch(() => { button.disabled = false; }));
  }
  const { dialog, close } = dialogElements();
  close?.addEventListener('click', () => dialog?.close());
  dialog?.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => { initFundHeader().catch(() => {}); }, { once: true });
