import { resolveCreatorENS } from './creator-profile-data.mjs?v=20261014-profile-card';
import { labelKnownAddress, normalizeKnownAddress } from './known-addresses.mjs';
const USDC_ICON = '<img class="usdc-icon" src="img/usdc.svg" alt="USDC" width="16" height="16">';
const WALLET_ICON = 'img/Ens_Eth_Breathe.png';

export function formatUsdcUnits(units) {
  const value = typeof units === 'bigint' ? units : BigInt(units || 0);
  const whole = value / 1000000n;
  const fraction = String(value % 1000000n).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}

export function renderUsdcAmount(units, { className = '' } = {}) {
  const classes = ['usdc-amount', className].filter(Boolean).join(' ');
  return `<span class="${classes}"><span class="usdc-amount-text">$${escapeHtml(formatUsdcUnits(units))}</span> ${USDC_ICON}</span>`;
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function shortAddress(address) {
  const value = String(address || '');
  return value.length > 10 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

export function renderWalletAddress(address) {
  const value = String(address || '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return escapeHtml(value);
  return `<span class="fund-wallet-address"><code>${escapeHtml(value.slice(0, 6))}</code><span class="creator-profile-wallet-icons" aria-hidden="true">${
    Array.from({ length: 4 }, (_value, index) => `<img src="${WALLET_ICON}" alt="" loading="lazy" style="animation-delay:${index * 0.25}s" />`).join('')
  }</span><code>${escapeHtml(value.slice(-4))}</code></span>`;
}

function normalizeAddress(address) {
  return String(address || '').toLowerCase();
}

async function verifyAlias(address, alias, provider, cache) {
  const key = `alias:${alias.toLowerCase()}`;
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      try {
        const resolved = await provider.resolveName(alias);
        return normalizeAddress(resolved) === normalizeAddress(address);
      } catch {
        return false;
      }
    })());
  }
  return cache.get(key);
}

function sponsorAliasList(sponsorAliases, address) {
  const normalized = normalizeKnownAddress(address);
  const keys = [normalized, address];
  for (const key of keys) {
    if (Array.isArray(sponsorAliases?.[key])) return sponsorAliases[key];
  }
  for (const [key, value] of Object.entries(sponsorAliases || {})) {
    if (normalizeKnownAddress(key) === normalized && Array.isArray(value)) return value;
  }
  return [];
}

export async function resolveWalletLabel(address, provider, sponsorAliases = {}, cache = new Map()) {
  const normalized = normalizeAddress(address);
  const known = labelKnownAddress(address);
  if (known) return { ...known, aliases: [], avatarURI: '' };
  let primary = '';
  let avatarURI = '';
  try {
    const resolved = await resolveCreatorENS(address, provider);
    primary = resolved?.name || '';
    avatarURI = resolved?.avatarURI || '';
  } catch {
    primary = '';
  }
  const aliases = [];
  for (const alias of sponsorAliasList(sponsorAliases, address)) {
    if (typeof alias !== 'string' || !alias.trim()) continue;
    if (await verifyAlias(address, alias.trim(), provider, cache) && alias.trim().toLowerCase() !== primary.toLowerCase()) {
      aliases.push(alias.trim());
    }
  }
  return {
    address,
    label: primary || aliases[0] || shortAddress(address),
    aliases,
    avatarURI,
  };
}

export function renderWalletButton({ address, label, aliases = [], kind = 'wallet', href = '', avatarURI = '' }, { role = '', extraClass = '' } = {}) {
  const aliasText = aliases.length ? ` <span class="fund-wallet-aliases">(${aliases.map(escapeHtml).join(' · ')})</span>` : '';
  const avatar = avatarURI ? `<img class="fund-wallet-avatar" src="${escapeHtml(avatarURI)}" alt="" loading="lazy">` : '';
  const rawAddress = /^0x[0-9a-fA-F]{40}$/.test(String(address || '')) && (label === address || label === shortAddress(address) || !label);
  const labelHtml = rawAddress ? renderWalletAddress(address) : `${avatar}${escapeHtml(label)}`;
  if (kind === 'contract' && href) {
    const classes = ['fund-wallet-link', 'fund-contract-link', extraClass].filter(Boolean).join(' ');
    return `<a class="${classes}" href="${escapeHtml(href)}" target="_blank" rel="noopener" title="${escapeHtml(address)}">${labelHtml}</a>${aliasText}`;
  }
  const classes = ['nft-creator-profile', 'fund-wallet-link', extraClass].filter(Boolean).join(' ');
  return `<button type="button" class="${classes}" data-creator="${escapeHtml(address)}"${role ? ` data-fund-role="${escapeHtml(role)}"` : ''} title="${escapeHtml(address)}">${labelHtml}</button>${aliasText}`;
}

function sourceKindLabel(kind) {
  return {
    advert: 'Advert purchase',
    djuke: 'DJuke purchase',
    sponsor: 'Sponsor deposit',
    payout: 'Payroll payout',
  }[kind] || 'Sponsor deposit';
}

function renderSourceRow(source) {
  const label = source.displayLabel || shortAddress(source.funder || source.advertiser || source.payer || '');
  const wallet = source.walletHtml || escapeHtml(label);
  const amount = renderUsdcAmount(source.amountUnits, { className: source.kind === 'advert' ? 'usdc-amount--artist' : 'usdc-amount--sponsor' });
  const tx = source.txHash ? `<a href="https://basescan.org/tx/${escapeHtml(source.txHash)}" target="_blank" rel="noopener">BaseScan</a>` : 'manual';
  const extra = source.kind === 'advert'
    ? [source.campaignId ? `<a href="#devert-campaign-${escapeHtml(String(source.campaignId))}" target="_blank" rel="noopener">Campaign #${escapeHtml(String(source.campaignId))}</a>` : '',
      source.title ? `<span>${escapeHtml(source.title)}</span>` : '',
      source.advertiserHtml || source.advertiser ? `<span>${escapeHtml(source.advertiserLabel || source.advertiser || '')}</span>` : '']
      .filter(Boolean).join(' · ')
    : source.kind === 'djuke'
      ? source.payerHtml || source.payerLabel || source.payer ? `<span>${escapeHtml(source.payerLabel || source.payer || '')}</span>` : ''
      : '';
  return `<tr class="fund-source-row fund-source-${escapeHtml(source.kind || 'sponsor')}"><td>${wallet}</td><td>${escapeHtml(sourceKindLabel(source.kind))}</td><td class="radio-history-number">${amount}</td><td>${tx}${extra ? ` · ${extra}` : ''}</td></tr>`;
}

export function renderFundSourcesTable(fund) {
  const sources = Array.isArray(fund.sources) ? fund.sources : [];
  if (!sources.length) {
    return '<p class="fund-source-empty">No on-chain funding sources found yet.</p>';
  }
  return `<table class="radio-history-table radio-history-funding-table fund-source-table"><thead><tr><th>Source</th><th>Kind</th><th>Amount</th><th>Proof</th></tr></thead><tbody>${sources.map(renderSourceRow).join('')}</tbody></table>`;
}

export function renderFundDisclosure(fund) {
  const reserved = fund.reservedUnits != null ? `<span>reserved ${renderUsdcAmount(fund.reservedUnits)} · </span>` : '';
  const avail = `<span>available ${renderUsdcAmount(fund.availableUnits)}</span>`;
  return `<details class="fund-disclosure"><summary><strong>${escapeHtml(fund.label)}</strong> · ${renderUsdcAmount(fund.balanceUnits)} · ${reserved}${avail}</summary><div class="fund-disclosure-body">${fund.description ? `<p class="fund-description">${escapeHtml(fund.description)}</p>` : ''}${renderFundSourcesTable(fund)}</div></details>`;
}

export function renderFundWeeklyArchive(archive = {}) {
  const weeks = Array.isArray(archive.weeks) ? archive.weeks : [];
  if (!weeks.length) return '<p class="fund-weekly-empty">No paid weekly history has been indexed yet.</p>';
  return `<div class="fund-weekly-archive">${weeks.map(week => {
    const status = week.status || 'queued';
    const period = week.period || {};
    const header = `${escapeHtml(week.week)} · ${status.toUpperCase()} · ${renderUsdcAmount(week.totalUnits)} total`;
    const rows = (week.entries || []).map((entry, index) => `
      <tr class="fund-weekly-row fund-weekly-${escapeHtml(status)}">
        <td>${escapeHtml(entry.artist || entry.walletLabel || entry.wallet || `Winner ${index + 1}`)}${entry.walletHtml ? `<div class="fund-weekly-sub">${entry.walletHtml}</div>` : ''}${entry.artist ? `<div class="fund-weekly-sub">${escapeHtml(entry.plays || entry.votes || 0)} ${entry.votes != null ? 'votes' : 'plays'}</div>` : ''}</td>
        <td class="fund-breakdown-amount">${renderUsdcAmount(entry.amountUnits, { className: entry.paid ? 'usdc-amount--artist' : 'usdc-amount--queued' })}</td>
        <td class="fund-breakdown-amount">${renderUsdcAmount((week.entries || []).slice(0, index + 1).reduce((sum, item) => sum + BigInt(item.amountUnits || 0), 0n), { className: 'usdc-amount--sponsor' })}</td>
        <td>${entry.txHash ? `<a href="https://basescan.org/tx/${escapeHtml(entry.txHash)}" target="_blank" rel="noopener">BaseScan</a>` : `<span class="fund-weekly-queued">${status === 'queued' ? 'Queued' : 'Awaiting payout'}</span>`}</td>
      </tr>`).join('');
    const archiveLink = week.metadataUri ? `<a href="${escapeHtml(week.metadataUri.replace('ipfs://', 'https://gateway.pinata.cloud/ipfs/'))}" target="_blank" rel="noopener">IPFS JSON</a>` : 'IPFS JSON unavailable';
    return `<details class="fund-weekly-details fund-weekly-${escapeHtml(status)}">
      <summary><strong>${header}</strong> · ${escapeHtml(status)} · ${escapeHtml(period.startAt || '')}</summary>
      <div class="fund-weekly-body">
        <p class="fund-weekly-meta">Allocation ${escapeHtml(week.metadataUri || 'unpublished')} · ${archiveLink}</p>
        <table class="fund-weekly-table"><thead><tr><th>Recipient</th><th>Amount</th><th>Running total</th><th>Tx</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="fund-weekly-empty">No payouts indexed yet.</td></tr>`}</tbody></table>
      </div>
    </details>`;
  }).join('')}</div>`;
}

export function renderFundsSection(funds = [], title = 'Community Funds') {
  return `<section class="community-funds-section"><h3>💰 ${escapeHtml(title)}</h3>${funds.map(renderFundDisclosure).join('')}</section>`;
}
