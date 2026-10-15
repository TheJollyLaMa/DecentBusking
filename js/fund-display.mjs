import { resolveCreatorENS } from './creator-profile-data.mjs?v=20261014-profile-card';
import { labelKnownAddress, normalizeKnownAddress } from './known-addresses.mjs';

export function formatUsdcUnits(units) {
  const value = typeof units === 'bigint' ? units : BigInt(units || 0);
  const whole = value / 1000000n;
  const fraction = String(value % 1000000n).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
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
  if (known) return { ...known, aliases: [] };
  let primary = '';
  try {
    const resolved = await resolveCreatorENS(address, provider);
    primary = resolved?.name || '';
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
  };
}

export function renderWalletButton({ address, label, aliases = [], kind = 'wallet', href = '' }, { role = '', extraClass = '' } = {}) {
  const aliasText = aliases.length ? ` <span class="fund-wallet-aliases">(${aliases.map(escapeHtml).join(' · ')})</span>` : '';
  if (kind === 'contract' && href) {
    const classes = ['fund-wallet-link', 'fund-contract-link', extraClass].filter(Boolean).join(' ');
    return `<a class="${classes}" href="${escapeHtml(href)}" target="_blank" rel="noopener" title="${escapeHtml(address)}">${escapeHtml(label)}</a>${aliasText}`;
  }
  const classes = ['nft-creator-profile', 'fund-wallet-link', extraClass].filter(Boolean).join(' ');
  return `<button type="button" class="${classes}" data-creator="${escapeHtml(address)}"${role ? ` data-fund-role="${escapeHtml(role)}"` : ''} title="${escapeHtml(address)}">${escapeHtml(label)}</button>${aliasText}`;
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
  const amount = `${formatUsdcUnits(source.amountUnits)} USDC`;
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
  const reserved = fund.reservedUnits != null ? `<span>reserved ${formatUsdcUnits(fund.reservedUnits)} · </span>` : '';
  const avail = `<span>available ${formatUsdcUnits(fund.availableUnits)}</span>`;
  return `<details class="fund-disclosure"><summary><strong>${escapeHtml(fund.label)}</strong> · ${formatUsdcUnits(fund.balanceUnits)} USDC · ${reserved}${avail}</summary><div class="fund-disclosure-body">${fund.description ? `<p class="fund-description">${escapeHtml(fund.description)}</p>` : ''}${renderFundSourcesTable(fund)}</div></details>`;
}

export function renderFundsSection(funds = [], title = 'Community Funds') {
  return `<section class="community-funds-section"><h3>💰 ${escapeHtml(title)}</h3>${funds.map(renderFundDisclosure).join('')}</section>`;
}
