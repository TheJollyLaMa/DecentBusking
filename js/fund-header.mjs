import { workerEnsProvider } from './ens-client.mjs?v=20261016-ens-worker';
import { getBaseReadProvider } from './base-chain.mjs?v=20261018-shared-provider';
import { escapeHtml, formatUsdcUnits, renderFundPendingTable, renderFundSummary, renderFundWeeklyArchive, renderUsdcAmount, renderWalletButton, resolveWalletLabel, shortAddress } from './fund-display.mjs?v=20261124-visible-payments';
import { isDmtvEscrow, labelKnownAddress, normalizeKnownAddress } from './known-addresses.mjs?v=20261124-lazy-funds';
import { currentPayrollPeriod, payrollPeriods, weekNumberFromKey } from './payroll-week.mjs';
import { rankTopTenSongs, previewTopTenSongPayroll } from './top-ten-prizes.mjs?v=20261123-song-splits';
import { playbackArtistKey, previewPlaybackPayroll } from './radio-payroll.mjs?v=20261123-song-splits';
import { initFundContributions } from './fund-contribution.mjs?v=20261124-verified-funds';
import { animateFundInflow, fundInflowSnapshot, planFundInflow } from './fund-inflow.mjs?v=20261124-lazy-funds';
import { fundBudgetFor } from './fund-budget.mjs?v=20261030-fund-refresh';

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
let openArchive;

export async function openFundArchives(week = '') {
  await initFundHeader();
  if (!openArchive) throw new Error('Fund archives are not available');
  return openArchive(week);
}

export async function loadFundArchive({ fundSlug, week = '', serviceUrl = globalThis.window?.DecentConfig?.ipfsUploadServiceUrl || '', fetchImpl = globalThis.fetch }) {
  if (!serviceUrl) throw new Error('Fund archive service is not configured');
  const query = week ? `week=${encodeURIComponent(week)}` : 'index=1';
  const response = await fetchImpl(`${serviceUrl.replace(/\/$/, '')}/api/funds/${encodeURIComponent(fundSlug)}/weeks?${query}`,
    { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Fund archive unavailable (${response.status})`);
  return response.json();
}

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

async function resolveWallet(address, provider, sponsorAliases, cache, resolveNames = true) {
  if (!address) return { address: '', label: '' };
  if (!resolveNames) return labelKnownAddress(address) || { address, label: shortAddress(address) };
  const key = `wallet:${normalizeAddress(address)}`;
  if (!cache.has(key)) cache.set(key, resolveWalletLabel(address, provider, sponsorAliases, cache));
  return cache.get(key);
}

function sourceKindLabel(kind) {
  return {
    advert: 'Advert purchase',
    djuke: 'DJuke purchase',
    dmtv: 'DMTv purchase',
    sponsor: 'Sponsor deposit',
    payout: 'Payroll payout',
  }[kind] || 'Sponsor deposit';
}

async function inflowRow(source, { ensProvider, sponsorAliases, cache, resolveNames }) {
  const funder = normalizeAddress(source.funder || '');
  const wallet = await resolveWallet(source.funder || '', ensProvider, sponsorAliases, cache, resolveNames);
  const config = globalThis.window?.DecentConfig || {};
  const devertContract = normalizeKnownAddress(config.devertContractAddress || '0x135Cbc573F87637158eb3186C87c584fb0B34CD9');
  const djukeContract = normalizeKnownAddress(config.djukeContractAddress || '0x5d07489163feBCdB39C9F579CCC36dff5A067FF9');
  // The worker ledger labels DMTv escrow settlements as generic sponsor deposits.
  const kind = isDmtvEscrow(funder) ? 'dmtv' : source.kind || (funder === devertContract ? 'advert' : funder === djukeContract ? 'djuke' : 'sponsor');
  const advertiser = source.advertiser ? await resolveWallet(source.advertiser, ensProvider, sponsorAliases, cache, resolveNames) : null;
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

async function outflowRow(payout, { ensProvider, sponsorAliases, cache, resolveNames }) {
  const wallet = await resolveWallet(payout.recipient || '', ensProvider, sponsorAliases, cache, resolveNames);
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

async function decorateWeeklyArchive(archive, { ensProvider, sponsorAliases, resolveNames = true }) {
  const cache = new Map();
  const weeks = [];
  for (const week of archive?.weeks || []) {
    const entries = [];
    for (const entry of week.entries || []) {
      const wallet = entry.wallet ? await resolveWallet(entry.wallet, ensProvider, sponsorAliases, cache, resolveNames) : null;
      entries.push({
        ...entry,
        walletHtml: wallet ? renderWalletButton(wallet, { role: week.category || 'payout' }) : '',
        walletLabel: wallet?.label || entry.wallet || '',
      });
    }
    const context = { ensProvider, sponsorAliases, cache, resolveNames };
    const activity = await Promise.all([
      ...(week.sources || []).map(source => inflowRow(source, context)),
      ...(week.activityPayouts || []).map(payout => outflowRow(payout, context)),
    ]);
    weeks.push({ ...week, entries, activity });
  }
  return { ...archive, weeks };
}

// History comes from the worker's fund ledger (/api/funds), which indexes deposits and payouts on the paid RPC tier.
export async function loadFundBreakdown({ fundSlug, fundState = null, fundBalanceUnits = null, ensProvider = providerForEns(), sponsorAliases = {}, resolveNames = true }) {
  const pendingCache = new Map();
  const pendingRows = fundState?.pendingRows == null ? null : await Promise.all(fundState.pendingRows.map(async row => {
    const wallet = row.wallet ? await resolveWallet(row.wallet, ensProvider, sponsorAliases, pendingCache, resolveNames) : null;
    return { ...row, walletHtml: wallet ? renderWalletButton(wallet, { role: 'pending' }) : '' };
  }));
  const budget = { budgetUnits: fundState?.budgetUnits ?? null, reservedUnits: fundState?.reservedUnits ?? null,
    pendingRows, currentWeek: fundState?.currentWeek || '', historyScope: fundState?.historyScope };
  const rawBalance = fundState && Object.hasOwn(fundState, 'balanceUnits') ? fundState.balanceUnits : fundBalanceUnits;
  const fallbackBalance = rawBalance == null ? null : parseUnitsLike(rawBalance);
  if (!fundState || fundState.sourcesAvailable === false || fundState.payoutsAvailable === false ||
      !Array.isArray(fundState.sources) || !Array.isArray(fundState.payouts)) {
    return { ...budget, historyAvailable: false, error: new Error('Fund history is still indexing'), rows: [], inflows: [], outflows: [], inflowUnits: 0n, outflowUnits: 0n, netUnits: 0n, balanceUnits: fallbackBalance, reconciles: false };
  }
  const cache = new Map();
  try {
    const context = { ensProvider, sponsorAliases, cache, resolveNames };
    const inflows = await Promise.all(fundState.sources.map(source => inflowRow(source, context)));
    const outflows = await Promise.all(fundState.payouts.map(payout => outflowRow(payout, context)));
    const rows = [...inflows, ...outflows].sort((first, second) =>
      second.timestamp - first.timestamp || second.blockNumber - first.blockNumber || second.logIndex - first.logIndex);
    const inflowUnits = fundState.inflowUnits == null ? inflows.reduce((sum, row) => sum + parseUnitsLike(row.amountUnits), 0n) : BigInt(fundState.inflowUnits);
    const outflowUnits = fundState.outflowUnits == null ? outflows.reduce((sum, row) => sum + parseUnitsLike(row.amountUnits), 0n) : BigInt(fundState.outflowUnits);
    const netUnits = inflowUnits - outflowUnits;
    const balanceUnits = fallbackBalance;
    return { ...budget, historyAvailable: true, rows, inflows, outflows, inflowUnits, outflowUnits, netUnits, balanceUnits, reconciles: balanceUnits === netUnits };
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

export function renderFundActivity(rows, empty = 'No confirmed transactions in this period.') {
  return `<table class="fund-breakdown-table">
    <thead><tr><th>Date</th><th>Type</th><th>Source / recipient</th><th>In</th><th>Out</th><th>Tx</th></tr></thead>
    <tbody>${rows.length ? rows.map(row => `
      <tr class="fund-breakdown-row fund-breakdown-${escapeHtml(row.direction)} fund-breakdown-${escapeHtml(row.kind)}">
        <td>${escapeHtml(row.dateText)}</td><td>${escapeHtml(row.typeLabel)}</td>
        <td>${row.sourceHtml}${row.extra ? `<div class="fund-breakdown-extra">${escapeHtml(row.extra)}</div>` : ''}</td>
        <td class="fund-breakdown-amount">${row.direction === 'in' ? renderUsdcAmount(row.amountUnits, { className: 'fund-amount-in' }) : ''}</td>
        <td class="fund-breakdown-amount">${row.direction === 'out' ? renderUsdcAmount(row.amountUnits, { className: 'fund-amount-out' }) : ''}</td>
        <td>${row.txHash ? `<a href="${escapeHtml(row.txUrl)}" target="_blank" rel="noopener">Basescan</a>` : 'Proof unavailable'}</td>
      </tr>`).join('') : `<tr><td colspan="6" class="fund-breakdown-empty">${escapeHtml(empty)}</td></tr>`}</tbody></table>`;
}

export function visibleFundActivity(rows) {
  const payoutWeeks = new Map();
  for (const row of rows) {
    if (row.direction !== 'out' || !Number.isFinite(row.timestamp) || row.timestamp <= 0) continue;
    const week = currentPayrollPeriod(row.timestamp * 1000).week;
    payoutWeeks.set(week, Math.min(payoutWeeks.get(week) ?? Infinity, row.timestamp));
  }
  const weeks = [...payoutWeeks.keys()].sort().reverse();
  if (weeks.length < 2) return rows;
  const cutoff = payoutWeeks.get(weeks[1]);
  return rows.filter(row => row.timestamp >= cutoff);
}

function renderBreakdown(details, fund, fundState) {
  const { body, summary, note, title } = dialogElements();
  if (!body || !summary || !note || !title) return;
  const archive = body.querySelector('.fund-weekly-section');
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
      ? (details.reconciles ? '' : 'History loaded, but the totals do not fully reconcile yet.')
      : `${details.error?.message || 'Breakdown unavailable'}, try again shortly.`;
  body.innerHTML = `
    ${renderFundPendingTable(details.currentWeek === currentPayrollPeriod().week ? details.pendingRows : null, { fundSlug: fund.slug, week: currentPayrollPeriod().week })}
    <section class="fund-confirmed-section" aria-labelledby="fund-confirmed-title">
    <h4 id="fund-confirmed-title">Confirmed additions & payouts</h4>
    <p class="fund-weekly-meta">Latest two weekly payout runs and newer additions. Earlier activity is in the weekly archives.</p>
    ${renderFundActivity(visibleFundActivity(details.rows), details.historyAvailable ? 'No confirmed transactions in these weeks.' : 'Confirmed activity is still indexing.')}
    </section>
  `;
  if (archive) body.append(archive);
  else body.insertAdjacentHTML('beforeend', `<section class="fund-weekly-section"><details data-fund-archives><summary>🗂 Weekly archives · income & payouts</summary><div data-fund-archive-list><button type="button" data-load-fund-archives>Load archived weeks</button></div></details></section>`);
  body.scrollLeft = scrollLeft;
}

export async function loadFundState({ serviceUrl = globalThis.window?.DecentConfig?.ipfsUploadServiceUrl || '', fetchImpl = globalThis.fetch, now = Date.now(), includePending = true, view = 'recent' } = {}) {
  const service = serviceUrl.replace(/\/$/, '');
  if (!service) return null;
  const errors = [];
  const read = async path => {
    try {
      const response = await fetchImpl(`${service}${path}`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`Fund data unavailable (${response.status})`);
      return await response.json();
    } catch (error) {
      console.warn('[fund-panel]', path, error.message);
      errors.push(`${path}: ${error.message}`);
      return null;
    }
  };
  const [state, weekly, history] = await Promise.all([read(`/api/funds?view=${view}`), read('/api/payroll/weekly?view=summary'),
    includePending ? read('/api/radio/history?weeks=1&calendar=new-york') : null]);
  const currentWeek = currentPayrollPeriod(now).week;
  const checked = weekly?.lastCheckedAt ? Date.parse(weekly.lastCheckedAt) : null;
  const current = weekly?.ready && !weekly.lastError && weekly.currentPeriod?.week === currentWeek &&
    (checked == null || Number.isFinite(checked) && currentPayrollPeriod(checked).week === currentWeek) &&
    (weekly.chainId == null || weekly.chainId === 8453);
  const currentReport = current ? history?.weeks?.find(report => report.current && report.week === currentWeek) || null : null;
  return { ...(state || {}), ...(errors.length ? { lastError: errors.join(' · ') } : {}),
    weekly: current ? weekly : null, currentReport };
}

export function fundStateFor(state, fundSlug, fallbackBalanceUnits = null) {
  const fund = state?.funds?.[fundSlug] || {};
  const { balanceUnits, reservedUnits, budgetUnits } = fundBudgetFor(state, fundSlug, fallbackBalanceUnits);
  return { ...fund, ready: state?.ready ?? false, balanceUnits,
    lastError: state?.lastError || fund.historyError || '',
    historyScope: state?.historyScope,
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
  let state = null;
  let activeFund = null;
  let pending = null;
  let updatedAt = 0;
  let renderVersion = 0;
  const lastDetails = new Map();
  const archiveCache = new Map();
  const inflowSnapshots = new Map();
  const inflowCleanup = new Map();
  const renderActive = async () => {
    const fund = activeFund;
    if (!fund) return;
    const version = ++renderVersion;
    const fundState = fundStateFor(state, fund.slug, balanceCache.get(fund.slug));
    const details = await loadFundBreakdown({ fundSlug: fund.slug, fundState,
      resolveNames: false });
    if (activeFund !== fund || version !== renderVersion) return;
    lastDetails.set(fund.slug, { details, fundState });
    renderBreakdown(details, fund, fundState);
    // Verified names enhance the visible rows; they never delay opening or transaction proofs.
    loadFundBreakdown({ fundSlug: fund.slug, fundState, sponsorAliases: state?.sponsorAliases || {},
      ensProvider: providerForEns() }).then(named => {
      if (activeFund === fund && version === renderVersion) {
        lastDetails.set(fund.slug, { details: named, fundState });
        renderBreakdown(named, fund, fundState);
      }
    }).catch(reportError);
  };
  const reportError = error => {
    console.warn('[fund-panel]', error);
    const { note } = dialogElements();
    if (note) note.textContent = `Unable to refresh fund details: ${error.message}. Try again shortly.`;
  };
  const refresh = () => {
    if (pending) return pending;
    pending = (async () => {
      state = await loadFundState({ view: activeFund ? 'recent' : 'summary', includePending: Boolean(activeFund) });
      updatedAt = Date.now();
      const refreshedFunds = { ...state?.funds };
      for (const fund of FUNDS) {
        const fallback = (await loadBalance(fund.slug, state)).balanceUnits;
        const fundState = fundStateFor(state, fund.slug, fallback);
        refreshedFunds[fund.slug] = fundState;
        balanceCache.set(fund.slug, fundState.balanceUnits);
        const button = document.getElementById(`${fund.slug}-button`);
        if (!button) continue;
        const amount = fundState.budgetUnits ?? fundState.balanceUnits;
        const nextSnapshot = fundInflowSnapshot(fundState, currentPayrollPeriod().week);
        const inflow = planFundInflow(inflowSnapshots.get(fund.slug), nextSnapshot);
        inflowSnapshots.set(fund.slug, nextSnapshot);
        inflowCleanup.get(fund.slug)?.();
        button.innerHTML = fundButtonHtml(fund, amount);
        button.title = fundState.budgetUnits != null ? 'Current weekly pot; older unpaid prizes are reserved separately' : 'Total balance; weekly budget unavailable';
        button.setAttribute('aria-label', `${fundTitle(fund)}: ${amount == null ? 'balance unavailable' : `$${formatUsdcUnits(amount)} USDC${fundState.budgetUnits == null ? ' balance; weekly budget unavailable' : ' weekly pot'}`}`);
        button.disabled = false;
        if (inflow) inflowCleanup.set(fund.slug, animateFundInflow(button, inflow));
      }
      document.dispatchEvent(new CustomEvent('fund-state-updated', { detail: { ...state, funds: refreshedFunds } }));
      if (dialog?.open) await renderActive();
    })().finally(() => { pending = null; });
    return pending;
  };
  openPanel = slug => {
    const fund = FUNDS.find(value => value.slug === slug);
    if (!fund || !dialog) throw new Error('Choose an available radio fund');
    if (activeFund !== fund) {
      renderVersion++;
      dialogElements().body.replaceChildren();
    }
    activeFund = fund;
    const cached = lastDetails.get(slug);
    if (cached) renderBreakdown(cached.details, fund, cached.fundState);
    else renderBreakdown({ rows: [], pendingRows: null, balanceUnits: balanceCache.get(slug) ?? null,
      budgetUnits: fundStateFor(state, slug).budgetUnits, historyAvailable: false }, fund, { ready: false });
    const selection = document.getElementById('fund-contribution-slug');
    if (selection) {
      selection.dataset.preferredFund = slug;
      selection.value = slug;
      selection.dispatchEvent(new Event('change'));
    }
    if (!dialog.open) dialog.showModal();
    if (Date.now() - updatedAt > 15_000 || state?.historyScope !== 'recent') {
      const wasSummary = Boolean(pending) && state?.historyScope !== 'recent';
      refresh().then(() => {
        if (wasSummary && activeFund === fund && state?.historyScope !== 'recent') refresh().catch(reportError);
      }).catch(reportError);
    } else renderActive().catch(reportError);
  };
  const loadArchiveWeek = async element => {
    if (!element.open || element.dataset.loading || element.dataset.loaded) return;
    const fund = activeFund;
    const container = element.querySelector('[data-fund-week-body]');
    if (!container) return;
    const week = element.dataset.fundWeek;
    element.dataset.loading = '1';
    container.textContent = 'Loading this week’s income and payout proofs…';
    try {
      const key = `${fund.slug}:${week}`;
      const cached = archiveCache.get(key);
      const data = cached && Date.now() - cached.loadedAt < 60_000 ? cached.data : await loadFundArchive({ fundSlug: fund.slug, week });
      archiveCache.set(key, { data, loadedAt: Date.now() });
      const decorated = await decorateWeeklyArchive(data, { resolveNames: false });
      if (activeFund !== fund || !element.isConnected) return;
      const record = decorated.weeks[0];
      if (!record) throw new Error('No indexed records for this week');
      container.innerHTML = `<p>Income ${renderUsdcAmount(record.incomeUnits || '0', { className: 'fund-amount-in' })} · Paid this week ${renderUsdcAmount(record.outflowUnits || '0', { className: 'fund-amount-out' })}</p>
        ${renderFundActivity(record.activity || [])}
        ${record.entries.length ? `<h4>Frozen allocation & payment receipts</h4>${renderFundWeeklyArchive({ weeks: [record] })}` : ''}`;
      element.dataset.loaded = '1';
    } catch (error) {
      console.warn('[fund-archive]', error);
      container.innerHTML = `<p role="status">${escapeHtml(error.message)}</p><button type="button" data-retry-fund-week>Retry this week</button>`;
    } finally { delete element.dataset.loading; }
  };
  openArchive = async selectedWeek => {
    const fund = activeFund;
    const body = dialogElements().body;
    const archives = body.querySelector('[data-fund-archives]');
    if (!fund || !archives) throw new Error('Open a fund before browsing its archives');
    archives.open = true;
    const list = archives.querySelector('[data-fund-archive-list]');
    if (!list.dataset.loaded && !list.dataset.loading) {
      list.dataset.loading = '1';
      list.textContent = 'Loading the week index…';
      try {
        const data = await loadFundArchive({ fundSlug: fund.slug });
        if (activeFund !== fund || !list.isConnected) return;
        list.innerHTML = data.weeks.length ? data.weeks.map(record => `<details data-fund-week="${escapeHtml(record.week)}">
          <summary>${escapeHtml(record.week)} · Income ${renderUsdcAmount(record.incomeUnits || '0', { className: 'fund-amount-in' })} · Paid ${renderUsdcAmount(record.outflowUnits || '0', { className: 'fund-amount-out' })}</summary>
          <div data-fund-week-body></div></details>`).join('') : '<p>No archived activity indexed yet.</p>';
        list.dataset.loaded = '1';
      } catch (error) {
        console.warn('[fund-archive]', error);
        list.innerHTML = `<p role="status">${escapeHtml(error.message)}</p><button type="button" data-load-fund-archives>Retry archive index</button>`;
      } finally { delete list.dataset.loading; }
    }
    if (selectedWeek) {
      const element = [...list.querySelectorAll('[data-fund-week]')].find(item => item.dataset.fundWeek === selectedWeek);
      if (!element) throw new Error(`No archive indexed for ${selectedWeek}`);
      element.open = true;
      await loadArchiveWeek(element);
    }
  };
  dialog?.addEventListener('toggle', event => {
    if (event.target.matches('[data-fund-archives]') && event.target.open) openArchive('').catch(reportError);
    if (event.target.matches('[data-fund-week]')) loadArchiveWeek(event.target).catch(reportError);
  }, true);
  dialog?.addEventListener('click', event => {
    if (event.target.closest('[data-load-fund-archives]')) openArchive('').catch(reportError);
    if (event.target.closest('[data-retry-fund-week]')) loadArchiveWeek(event.target.closest('[data-fund-week]')).catch(reportError);
  });
  for (const fund of FUNDS) {
    document.getElementById(`${fund.slug}-button`)?.addEventListener('click', () => {
      Promise.resolve().then(() => openPanel(fund.slug)).catch(error => {
        console.warn('[fund-panel]', error);
        const { note } = dialogElements();
        if (note) note.textContent = `Unable to refresh fund details: ${error.message}. Try again shortly.`;
        if (dialog && !dialog.open) dialog.showModal();
      });
    });
  }
  close?.addEventListener('click', () => dialog?.close());
  dialog?.addEventListener('close', () => { activeFund = null; renderVersion++; });
  dialog?.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
  for (const fund of FUNDS) document.getElementById(`${fund.slug}-button`)?.removeAttribute('disabled');
  refresh().catch(reportError);
  setInterval(() => { if (!document.hidden) refresh().catch(reportError); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh().catch(reportError); });
  document.addEventListener('fund-contribution-confirmed', () => {
    refresh().catch(error => {
      console.warn('[fund-panel]', error);
      const { note } = dialogElements();
      if (note) note.textContent = `Contribution confirmed, but fund refresh failed: ${error.message}`;
    });
  });
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => { initFundHeader().catch(error => console.warn('[fund-panel]', error)); }, { once: true });
