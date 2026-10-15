import { escapeHtml, formatUsdcUnits, renderWalletButton, resolveWalletLabel } from './fund-display.mjs?v=20261014-funds';

const ROUTER_ADDRESS = '0x8ecca903e2a6Daa8CCbB933700e4F2C58C44A4B5';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BLOCKSCOUT_API = 'https://base.blockscout.com/api';
const START_BLOCK = 51852000;
const FUND_EVENT_ABI = [
  'event FundFunded(bytes32 indexed fundId, address indexed asset, address indexed funder, uint256 amount)',
  'event PayrollPaid(bytes32 indexed fundId, address indexed asset, address indexed recipient, uint256 amount, bytes32 workReference, bytes32 repositoryIdHash, bytes32 contributorIdHash, string metadataUri, bytes32 metadataHash)',
];

const FUNDS = [
  { slug: 'dbusk-top10', emoji: '🏆', label: 'Top 10 fund' },
  { slug: 'dbusk-playback', emoji: '🎧', label: 'Playback fund this week' },
];

const historyCache = new Map();
const balanceCache = new Map();
let stateCache = null;

function ethersLib() {
  return window.ethers;
}

function providerForRead() {
  const ethers = ethersLib();
  const rpcUrl = window.DecentConfig?.rpcUrl || window.DecentConfig?.ensRpcUrl;
  return ethers && rpcUrl ? new ethers.JsonRpcProvider(rpcUrl) : null;
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

function eventInterface(ethers) {
  return new ethers.Interface(FUND_EVENT_ABI);
}

async function blockscoutLogs(fetchImpl, { address, topic0, topic1, fromBlock = START_BLOCK }) {
  const logs = [];
  let from = fromBlock;
  for (let page = 0; page < 16; page += 1) {
    const params = new URLSearchParams({
      module: 'logs',
      action: 'getLogs',
      address,
      fromBlock: String(from),
      toBlock: 'latest',
      topic0,
      topic1,
      topic0_1_opr: 'and',
    });
    const response = await fetchImpl(`${BLOCKSCOUT_API}?${params.toString()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Blockscout logs unavailable (${response.status})`);
    const body = await response.json();
    const result = Array.isArray(body.result) ? body.result : [];
    if (body.status !== '1' && !(body.status === '0' && !result.length)) {
      throw new Error(`Blockscout logs: ${body.message || 'unexpected response'}`);
    }
    logs.push(...result);
    if (result.length < 1000) return logs;
    from = Number(BigInt(result.at(-1).blockNumber));
  }
  throw new Error('Blockscout log pagination limit reached');
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

async function collectInflows({ fetchImpl, ethers, provider, fundSlug, fundState, sponsorAliases, cache }) {
  const iface = eventInterface(ethers);
  const fundId = ethers.id(fundSlug);
  const logs = await blockscoutLogs(fetchImpl, {
    address: ROUTER_ADDRESS,
    topic0: iface.getEvent('FundFunded').topicHash,
    topic1: fundId.toLowerCase(),
  });
  const hints = sourceHintMap(fundState);
  const rows = [];
  for (const log of logs) {
    const parsed = iface.parseLog({ topics: log.topics.filter(Boolean), data: log.data });
    const txHash = String(log.transactionHash || '');
    const logIndex = Number(BigInt(log.logIndex || log.index || 0));
    const amountUnits = parsed.args.amount.toString();
    const block = provider ? await provider.getBlock(Number(BigInt(log.blockNumber || 0))) : null;
    const timestamp = Number(block?.timestamp || 0);
    const wallet = await resolveWallet(parsed.args.funder || '', provider, sponsorAliases, cache);
    const hint = hints.get(`${normalizeAddress(txHash)}:${logIndex}`);
    const kind = hint?.kind || 'sponsor';
    const extra = kind === 'advert'
      ? [hint?.campaignId ? `Campaign #${escapeHtml(String(hint.campaignId))}` : '', hint?.title ? escapeHtml(hint.title) : '']
        .filter(Boolean).join(' · ')
      : kind === 'djuke'
        ? hint?.requestId ? `DJuke request #${escapeHtml(String(hint.requestId))}` : 'DJuke purchase'
        : '';
    rows.push({
      direction: 'in',
      kind,
      amountUnits,
      timestamp,
      dateText: formatDateTime(timestamp),
      sourceHtml: renderWalletButton(wallet, { role: kind }),
      sourceLabel: wallet.label || wallet.address,
      extra,
      txHash,
      txUrl: baseScanUrl(`/tx/${txHash}`),
      blockNumber: Number(BigInt(log.blockNumber || 0)),
      logIndex,
    });
  }
  return rows;
}

async function collectOutflows({ fetchImpl, ethers, provider, fundSlug, sponsorAliases, cache }) {
  const iface = eventInterface(ethers);
  const fundId = ethers.id(fundSlug);
  const logs = await blockscoutLogs(fetchImpl, {
    address: ROUTER_ADDRESS,
    topic0: iface.getEvent('PayrollPaid').topicHash,
    topic1: fundId.toLowerCase(),
  });
  const rows = [];
  for (const log of logs) {
    const parsed = iface.parseLog({ topics: log.topics.filter(Boolean), data: log.data });
    const txHash = String(log.transactionHash || '');
    const logIndex = Number(BigInt(log.logIndex || log.index || 0));
    const amountUnits = parsed.args.amount.toString();
    const block = provider ? await provider.getBlock(Number(BigInt(log.blockNumber || 0))) : null;
    const timestamp = Number(block?.timestamp || 0);
    const wallet = await resolveWallet(parsed.args.recipient || '', provider, sponsorAliases, cache);
    rows.push({
      direction: 'out',
      kind: 'payout',
      amountUnits,
      timestamp,
      dateText: formatDateTime(timestamp),
      sourceHtml: renderWalletButton(wallet, { role: 'payout' }),
      sourceLabel: wallet.label || wallet.address,
      extra: 'PayrollPaid',
      txHash,
      txUrl: baseScanUrl(`/tx/${txHash}`),
      blockNumber: Number(BigInt(log.blockNumber || 0)),
      logIndex,
    });
  }
  return rows;
}

export async function loadFundBreakdown({ fundSlug, fundState = null, fundBalanceUnits = 0n, fetchImpl = globalThis.fetch, provider = providerForRead(), sponsorAliases = {}, ethers = ethersLib() }) {
  const cached = historyCache.get(fundSlug);
  if (cached) return cached;
  if (!ethers || !fetchImpl || !provider) {
    return { historyAvailable: false, error: new Error('Fund history unavailable'), rows: [], inflows: [], outflows: [] };
  }
  const cache = new Map();
  try {
    const [inflows, outflows] = await Promise.all([
      collectInflows({ fetchImpl, ethers, provider, fundSlug, fundState: fundState || {}, sponsorAliases, cache }),
      collectOutflows({ fetchImpl, ethers, provider, fundSlug, sponsorAliases, cache }),
    ]);
    const rows = [...inflows, ...outflows].sort((first, second) =>
      second.timestamp - first.timestamp || second.blockNumber - first.blockNumber || second.logIndex - first.logIndex);
    const inflowUnits = inflows.reduce((sum, row) => sum + parseUnitsLike(row.amountUnits), 0n);
    const outflowUnits = outflows.reduce((sum, row) => sum + parseUnitsLike(row.amountUnits), 0n);
    const netUnits = inflowUnits - outflowUnits;
    const balanceUnits = parseUnitsLike(fundState?.balanceUnits ?? fundBalanceUnits ?? netUnits);
    const result = {
      historyAvailable: true,
      rows,
      inflows,
      outflows,
      inflowUnits,
      outflowUnits,
      netUnits,
      balanceUnits,
      reconciles: balanceUnits === netUnits,
    };
    historyCache.set(fundSlug, result);
    return result;
  } catch (error) {
    return { historyAvailable: false, error, rows: [], inflows: [], outflows: [], inflowUnits: 0n, outflowUnits: 0n, netUnits: 0n, balanceUnits: parseUnitsLike(fundState?.balanceUnits ?? fundBalanceUnits ?? 0n), reconciles: false };
  }
}

function fundButtonText(fund, balanceUnits) {
  return `${fund.emoji} ${fund.label} · ${formatUsdcUnits(balanceUnits)} USDC`;
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
  title.textContent = `${fund.emoji} ${fund.label}`;
  summary.textContent = `${formatUsdcUnits(details.balanceUnits)} USDC balance · in ${formatUsdcUnits(details.inflowUnits)} · out ${formatUsdcUnits(details.outflowUnits)} · net ${formatUsdcUnits(details.netUnits)}`;
  note.textContent = details.historyAvailable
    ? (details.reconciles ? 'History reconciles against the on-chain balance.' : 'History loaded, but the totals do not fully reconcile yet.')
    : 'Breakdown unavailable, try again.';
  const rows = details.rows.length
    ? details.rows.map(row => `
        <tr class="fund-breakdown-row fund-breakdown-${escapeHtml(row.direction)} fund-breakdown-${escapeHtml(row.kind)}">
          <td>${escapeHtml(row.dateText)}</td>
          <td>${escapeHtml(row.kind)}</td>
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
    if (!response.ok || !state?.ready || state.lastError) return null;
    stateCache = state;
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
  const provider = providerForRead();
  const details = await loadFundBreakdown({
    fundSlug: fund.slug,
    fundState,
    fundBalanceUnits: balanceCache.get(fund.slug) ?? 0n,
    sponsorAliases: state?.sponsorAliases || {},
    provider,
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
  const provider = providerForRead();
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
    button.textContent = fundButtonText(fund, balanceUnits);
    button.disabled = false;
    button.addEventListener('click', () => openBreakdown(fund, button).catch(() => { button.disabled = false; }));
  }
  const { dialog, close } = dialogElements();
  close?.addEventListener('click', () => dialog?.close());
  dialog?.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
  if (!provider) {
    const note = document.getElementById('fund-breakdown-note');
    if (note) note.textContent = 'Breakdown unavailable, try again.';
  }
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => { initFundHeader().catch(() => {}); }, { once: true });
