import { workerEnsProvider } from './ens-client.mjs?v=20261016-ens-worker';
import { getBaseReadProvider } from './base-chain.mjs?v=20261018-shared-provider';
import { escapeHtml, formatUsdcUnits, renderFundPendingTable, renderFundSummary, renderFundWeeklyArchive, renderUsdcAmount, renderWalletButton, resolveWalletLabel } from './fund-display.mjs?v=20261024-live-prototype';
import { normalizeKnownAddress } from './known-addresses.mjs';
import { currentPayrollPeriod, weekNumberFromKey } from './payroll-week.mjs';
import { rankTopTenSongs, previewTopTenSongPayroll } from './top-ten-prizes.mjs?v=20261017-wallet-forfeiture';
import { playbackArtistKey, previewPlaybackPayroll } from './radio-payroll.mjs?v=20261019-payroll-confirmations';
import { initFundContributions } from './fund-contribution.mjs?v=20261019-fund-tour';

const ROUTER_ADDRESS = '0x8ecca903e2a6Daa8CCbB933700e4F2C58C44A4B5';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const FUNDS = [
  { slug: 'dbusk-top10', emoji: '🏆', label: 'Top10 fund' },
  { slug: 'dbusk-playback', emoji: '🎧', label: 'Playback fund' },
];
export function fundWeekNumber(now = Date.now()) {
  return weekNumberFromKey(currentPayrollPeriod(now).week);
}

export function fundTitle(fund, now = Date.now()) {
  return `${fund.emoji} Week ${fundWeekNumber(now)} ${fund.label}`;
}

export function usdcAmountHtml(balanceUnits) {
  return renderUsdcAmount(balanceUnits);
}

const balanceCache = new Map();
let headerInitialization;
let openPanel;

export async function openFundPanel(slug) {
  await initFundHeader();
  if (!openPanel) throw new Error('Fund panels are not available');
  return openPanel(slug);
}

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

export function fundPendingRows({ fundSlug, report, budgetUnits, minimumUnits = '10000' }) {
  if (!report?.current || budgetUnits == null || !Array.isArray(report.tracks)) return null;
  const tracks = report.tracks;
  if (fundSlug === 'dbusk-top10') {
    const plan = previewTopTenSongPayroll({ tracks, budgetUnits: BigInt(budgetUnits), minimumUnits: BigInt(minimumUnits) });
    const amounts = new Map(plan.entries.map(entry => [entry.trackId, entry.amountUnits]));
    return rankTopTenSongs(tracks).map(track => ({ ...track, amountUnits: String(amounts.get(track.trackId) ?? 0n) }));
  }
  const plan = previewPlaybackPayroll({ tracks, budgetUnits: BigInt(budgetUnits), minimumUnits: BigInt(minimumUnits) });
  const artists = new Map(plan.entries.map(entry => [entry.shareKey || playbackArtistKey(entry), entry]));
  const progress = new Map();
  return tracks.filter(track => Number.isSafeInteger(track.plays) && track.plays > 0)
    .slice().sort((first, second) => second.plays - first.plays || String(first.trackId).localeCompare(String(second.trackId)))
    .map((track, index) => {
      const key = playbackArtistKey(track);
      const artist = artists.get(key);
      const prior = progress.get(key) || { plays: 0n, units: 0n };
      const plays = prior.plays + BigInt(track.plays);
      const units = artist && (artist.payable || !artist.wallet) ? artist.amountUnits * plays / BigInt(artist.plays) : 0n;
      progress.set(key, { plays, units });
      return { ...track, rank: index + 1, amountUnits: String(units - prior.units) };
    });
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
    ? [source.campaignId ? `Campaign #${source.campaignId}` : '', source.title || '']
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
    sourceHtml: renderWalletButton(wallet, { role: kind }) + (kind === 'advert'
      ? `<div class="fund-breakdown-extra">${advertiser ? `Purchased by ${renderWalletButton(advertiser, { role: 'advertiser' })}` : 'Purchaser unavailable'}</div>`
      : ''),
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

async function decorateWeeklyArchive(archive, { ensProvider, sponsorAliases }) {
  const cache = new Map();
  const weeks = [];
  for (const week of archive?.weeks || []) {
    const entries = [];
    for (const entry of week.entries || []) {
      const wallet = entry.wallet ? await resolveWallet(entry.wallet, ensProvider, sponsorAliases, cache) : null;
      entries.push({
        ...entry,
        walletHtml: wallet ? renderWalletButton(wallet, { role: week.category || 'payout' }) : '',
        walletLabel: wallet?.label || entry.wallet || '',
      });
    }
    weeks.push({ ...week, entries });
  }
  return { ...archive, weeks };
}

// History comes from the worker's fund ledger (/api/funds), which indexes deposits and payouts on the paid RPC tier.
export async function loadFundBreakdown({ fundSlug, fundState = null, fundBalanceUnits = null, ensProvider = providerForEns(), sponsorAliases = {} }) {
  const pendingCache = new Map();
  const pendingRows = fundState?.pendingRows == null ? null : await Promise.all(fundState.pendingRows.map(async row => {
    const wallet = row.wallet ? await resolveWallet(row.wallet, ensProvider, sponsorAliases, pendingCache) : null;
    return { ...row, walletHtml: wallet ? renderWalletButton(wallet, { role: 'pending' }) : '' };
  }));
  const budget = { budgetUnits: fundState?.budgetUnits ?? null, reservedUnits: fundState?.reservedUnits ?? null,
    pendingRows, currentWeek: fundState?.currentWeek || '' };
  const rawBalance = fundState && Object.hasOwn(fundState, 'balanceUnits') ? fundState.balanceUnits : fundBalanceUnits;
  const fallbackBalance = rawBalance == null ? null : parseUnitsLike(rawBalance);
  if (!fundState || fundState.sourcesAvailable === false || fundState.payoutsAvailable === false ||
      !Array.isArray(fundState.sources) || !Array.isArray(fundState.payouts)) {
    return { ...budget, historyAvailable: false, error: new Error('Fund history is still indexing'), rows: [], inflows: [], outflows: [], inflowUnits: 0n, outflowUnits: 0n, netUnits: 0n, balanceUnits: fallbackBalance, reconciles: false };
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
    const balanceUnits = fallbackBalance;
    const service = (typeof window !== 'undefined' ? window.DecentConfig?.ipfsUploadServiceUrl : '')?.replace(/\/$/, '') || '';
    let weeklyArchive = null;
    let archiveError = '';
    if (service) {
      try {
        const response = await fetch(`${service}/api/funds/${encodeURIComponent(fundSlug)}/weeks`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error(`Weekly archive unavailable (${response.status})`);
        weeklyArchive = await response.json();
      } catch (error) { archiveError = error.message || 'Weekly archive unavailable'; }
    }
    const archive = weeklyArchive ? await decorateWeeklyArchive(weeklyArchive, { ensProvider, sponsorAliases }) : null;
    return { ...budget, historyAvailable: true, rows, inflows, outflows, inflowUnits, outflowUnits, netUnits, balanceUnits, reconciles: balanceUnits === netUnits, weeklyArchive: archive, archiveError };
  } catch (error) {
    return { ...budget, historyAvailable: false, error, rows: [], inflows: [], outflows: [], inflowUnits: 0n, outflowUnits: 0n, netUnits: 0n, balanceUnits: fallbackBalance, reconciles: false };
  }
}

export function fundButtonHtml(fund, balanceUnits, now = Date.now()) {
  return `${escapeHtml(fund.emoji)}<span class="fund-header-label"> Week ${fundWeekNumber(now)} ${escapeHtml(fund.label)}:</span> ${usdcAmountHtml(balanceUnits)}`;
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
  const expandedWeeks = new Set([...body.querySelectorAll('details[open][data-fund-week]')].map(element => element.dataset.fundWeek));
  const expandedPending = body.querySelector('details[open][data-fund-pending]')?.dataset.fundPending;
  const scrollLeft = body.scrollLeft;
  title.textContent = fundTitle(fund);
  const summaryHtml = renderFundSummary(details, { indexing: !details.historyAvailable || fundState?.ready === false });
  if (!summary.querySelector('.fund-prize-orbit')) summary.innerHTML = summaryHtml;
  else {
    const template = document.createElement('template');
    template.innerHTML = summaryHtml;
    for (const selector of ['.fund-prize-label', '.fund-prize-amount']) {
      summary.querySelector(selector).innerHTML = template.content.querySelector(selector).innerHTML;
    }
    summary.querySelector('.fund-prize-caption')?.remove();
    const caption = template.content.querySelector('.fund-prize-caption');
    if (caption) summary.querySelector('.fund-prize').append(caption);
  }
  note.textContent = fundState?.ready === false
    ? `History indexing${fundState?.lastError ? ` paused: ${fundState.lastError}` : '…'}`
    : details.historyAvailable
      ? (details.reconciles ? 'History reconciles against the on-chain balance.' : 'History loaded, but the totals do not fully reconcile yet.')
      : `${details.error?.message || 'Breakdown unavailable'}, try again shortly.`;
  if (details.archiveError) note.textContent += ` ${details.archiveError}. Retrying while this panel is open.`;
  const rows = details.rows.length
    ? details.rows.map(row => `
        <tr class="fund-breakdown-row fund-breakdown-${escapeHtml(row.direction)} fund-breakdown-${escapeHtml(row.kind)}">
          <td>${escapeHtml(row.dateText)}</td>
          <td>${escapeHtml(row.typeLabel || sourceKindLabel(row.kind))}</td>
          <td>${row.sourceHtml}${row.extra ? `<div class="fund-breakdown-extra">${escapeHtml(row.extra)}</div>` : ''}</td>
          <td class="fund-breakdown-amount">${row.direction === 'in' ? renderUsdcAmount(row.amountUnits, { className: 'fund-amount-in' }) : ''}</td>
          <td class="fund-breakdown-amount">${row.direction === 'out' ? renderUsdcAmount(row.amountUnits, { className: 'fund-amount-out' }) : ''}</td>
          <td><a href="${escapeHtml(row.txUrl)}" target="_blank" rel="noopener">Basescan</a></td>
        </tr>`).join('')
    : `<tr><td colspan="6" class="fund-breakdown-empty">${details.historyAvailable ? 'No confirmed fund transactions yet.' : 'Confirmed activity is still indexing.'}</td></tr>`;
  body.innerHTML = `
    ${renderFundPendingTable(details.pendingRows, { fundSlug: fund.slug, week: details.currentWeek })}
    <section class="fund-confirmed-section" aria-labelledby="fund-confirmed-title">
    <h4 id="fund-confirmed-title">Confirmed on-chain activity</h4>
    <table class="fund-breakdown-table">
      <thead>
        <tr><th>Date</th><th>Type</th><th>Source</th><th>In</th><th>Out</th><th>Tx</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    </section>
    <section class="fund-weekly-section"><h4>Weekly payout archive</h4>${details.weeklyArchive ? renderFundWeeklyArchive(details.weeklyArchive) : '<p class="fund-weekly-empty">Weekly archive unavailable. Retrying.</p>'}</section>
  `;
  for (const element of body.querySelectorAll('details[data-fund-week]')) element.open = expandedWeeks.has(element.dataset.fundWeek);
  const pendingDetails = body.querySelector('details[data-fund-pending]');
  if (pendingDetails) pendingDetails.open = pendingDetails.dataset.fundPending === expandedPending;
  body.scrollLeft = scrollLeft;
}

export async function loadFundState({ serviceUrl = globalThis.window?.DecentConfig?.ipfsUploadServiceUrl || '', fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const service = serviceUrl.replace(/\/$/, '');
  if (!service) return null;
  const read = async path => {
    try {
      const response = await fetchImpl(`${service}${path}`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      return response.ok ? await response.json() : null;
    } catch { return null; }
  };
  const [state, weekly, history] = await Promise.all([read('/api/funds'), read('/api/payroll/weekly'), read('/api/radio/history?weeks=1&calendar=new-york')]);
  const currentWeek = currentPayrollPeriod(now).week;
  const checked = weekly?.lastCheckedAt ? Date.parse(weekly.lastCheckedAt) : null;
  const current = weekly?.ready && !weekly.lastError && weekly.currentPeriod?.week === currentWeek &&
    (checked == null || Number.isFinite(checked) && currentPayrollPeriod(checked).week === currentWeek) &&
    (weekly.chainId == null || weekly.chainId === 8453);
  const currentReport = current ? history?.weeks?.find(report => report.current && report.week === currentWeek) || null : null;
  return { ...(state || {}), weekly: current ? weekly : null, currentReport };
}

export function fundStateFor(state, fundSlug, fallbackBalanceUnits = null) {
  const fund = state?.funds?.[fundSlug] || {};
  const category = fundSlug === 'dbusk-top10' ? 'top10' : 'playback';
  const weekly = state?.weekly?.funds?.[category];
  const balanceUnits = Object.hasOwn(fund, 'balanceUnits') ? fund.balanceUnits : weekly?.balanceUnits ?? fallbackBalanceUnits;
  const reservedUnits = weekly?.reservedUnits ?? fund.reservedUnits ?? null;
  let budgetUnits = /^\d+$/.test(String(weekly?.budgetUnits ?? '')) ? weekly.budgetUnits : null;
  if (balanceUnits == null || fund.balanceAvailable === false) budgetUnits = null;
  const shareBps = state?.weekly?.fundShareBps;
  if (budgetUnits != null && /^\d+$/.test(String(balanceUnits)) && /^\d+$/.test(String(reservedUnits)) &&
    Number.isInteger(shareBps) && shareBps > 0 && shareBps <= 10000) {
    const available = BigInt(balanceUnits) > BigInt(reservedUnits) ? BigInt(balanceUnits) - BigInt(reservedUnits) : 0n;
    budgetUnits = String(available * BigInt(shareBps) / 10000n);
  }
  return { ...fund, ready: state?.ready ?? false, balanceUnits,
    budgetUnits,
    currentWeek: state?.currentReport?.week || state?.weekly?.currentPeriod?.week || '',
    pendingRows: fundPendingRows({ fundSlug, report: state?.currentReport, budgetUnits, minimumUnits: state?.weekly?.minimumPayoutUnits }),
    reservedUnits };
}

async function loadBalance(fundSlug, state) {
  const fund = state?.funds?.[fundSlug];
  if (fund && Object.hasOwn(fund, 'balanceUnits')) return fund;
  const ethers = ethersLib();
  const provider = providerForRead();
  if (!ethers || !provider) return { balanceUnits: null };
  const router = new ethers.Contract(ROUTER_ADDRESS, ['function fundBalances(bytes32,address) view returns(uint256)'], provider);
  const balanceUnits = await router.fundBalances(ethers.id(fundSlug), USDC_ADDRESS).then(value => value.toString()).catch(() => null);
  return { balanceUnits };
}

export function initFundHeader() {
  headerInitialization ||= initializeFundHeader();
  return headerInitialization;
}

async function initializeFundHeader() {
  const bar = document.getElementById('artist-filter-bar');
  if (!bar || bar.dataset.fundHeaderReady === '1') return;
  bar.dataset.fundHeaderReady = '1';
  const { dialog, close } = dialogElements();
  initFundContributions();
  const proofLink = document.getElementById('fund-proof-ledger');
  const serviceUrl = window.DecentConfig?.ipfsUploadServiceUrl;
  if (proofLink && serviceUrl) {
    proofLink.href = `${serviceUrl.replace(/\/$/, '')}/api/payroll/ledger`;
    proofLink.hidden = false;
  }
  let state = null;
  let activeFund = null;
  let pending = null;
  let opening = false;
  const renderActive = async () => {
    const fund = activeFund;
    if (!fund) return;
    const fundState = fundStateFor(state, fund.slug, balanceCache.get(fund.slug));
    const details = await loadFundBreakdown({ fundSlug: fund.slug, fundState,
      sponsorAliases: state?.sponsorAliases || {}, ensProvider: providerForEns() });
    if (activeFund === fund) renderBreakdown(details, fund, fundState);
  };
  const refresh = () => {
    if (pending) return pending;
    pending = (async () => {
      state = await loadFundState();
      for (const fund of FUNDS) {
        const fallback = (await loadBalance(fund.slug, state)).balanceUnits;
        const fundState = fundStateFor(state, fund.slug, fallback);
        balanceCache.set(fund.slug, fundState.balanceUnits);
        const button = document.getElementById(`${fund.slug}-button`);
        if (!button) continue;
        const amount = fundState.budgetUnits ?? fundState.balanceUnits;
        button.innerHTML = fundButtonHtml(fund, amount);
        button.title = fundState.budgetUnits != null ? 'Current weekly pot; older unpaid prizes are reserved separately' : 'Total balance; weekly budget unavailable';
        button.setAttribute('aria-label', `${fundTitle(fund)}: ${amount == null ? 'balance unavailable' : `$${formatUsdcUnits(amount)} USDC${fundState.budgetUnits == null ? ' balance; weekly budget unavailable' : ' weekly pot'}`}`);
        button.disabled = false;
      }
      if (dialog?.open) await renderActive();
    })().finally(() => { pending = null; });
    return pending;
  };
  openPanel = async slug => {
    const fund = FUNDS.find(value => value.slug === slug);
    if (!fund || !dialog) throw new Error('Choose an available radio fund');
    if (opening) throw new Error('Fund details are already opening. Try again shortly');
    opening = true;
    activeFund = fund;
    const button = document.getElementById(`${fund.slug}-button`);
    if (button) button.disabled = true;
    try {
      await refresh();
      await renderActive();
      const selection = document.getElementById('fund-contribution-slug');
      if (selection) selection.value = slug;
      if (activeFund === fund && !dialog.open) dialog.showModal();
    } finally { opening = false; if (button) button.disabled = false; }
  };
  for (const fund of FUNDS) {
    document.getElementById(`${fund.slug}-button`)?.addEventListener('click', () => {
      openPanel(fund.slug).catch(error => {
        console.warn('[fund-panel]', error);
        const { note } = dialogElements();
        if (note) note.textContent = `Unable to refresh fund details: ${error.message}. Try again shortly.`;
        if (dialog && !dialog.open) dialog.showModal();
      });
    });
  }
  close?.addEventListener('click', () => dialog?.close());
  dialog?.addEventListener('close', () => { activeFund = null; });
  dialog?.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
  await refresh();
  setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh().catch(() => {}); });
  document.addEventListener('fund-contribution-confirmed', () => {
    refresh().catch(error => {
      console.warn('[fund-panel]', error);
      const { note } = dialogElements();
      if (note) note.textContent = `Contribution confirmed, but fund refresh failed: ${error.message}`;
    });
  });
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => { initFundHeader().catch(() => {}); }, { once: true });
