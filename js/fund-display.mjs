import { liveBookingRows } from './live-bookings.mjs';
import { resolveCreatorENS } from './creator-profile-data.mjs?v=20261014-profile-card';
import { labelKnownAddress, normalizeKnownAddress } from './known-addresses.mjs?v=20261019-fund-wallet-labels';
import { formatUsdcUnits } from './usdc-format.mjs?v=20261017-mercury-release';
export { formatUsdcUnits };
const USDC_ICON = '<img class="usdc-icon" src="img/usdc.svg" alt="USDC" width="16" height="16">';
const WALLET_ICON = 'img/Ens_Eth_Breathe.png';
let contributorLabels;

async function registeredContributorLabel(address) {
  if (!globalThis.window?.location) return '';
  contributorLabels ||= fetch(new URL('../contributor-accounts.json', import.meta.url), {
    cache: 'no-store', signal: AbortSignal.timeout(12000),
  })
    .then(async response => {
      if (!response.ok) throw new Error(`Contributor whitelist unavailable (${response.status})`);
      const accounts = await response.json();
      if (!Array.isArray(accounts.contributors)) throw new Error('Invalid contributor whitelist');
      return new Map(accounts.contributors
        .filter(account => /^0x[0-9a-f]{40}$/i.test(account.walletAddress || '') &&
          typeof (account.displayName || account.github) === 'string')
        .map(account => [normalizeAddress(account.walletAddress), account.displayName || account.github]));
    }).catch(error => {
      contributorLabels = null;
      console.warn('[funds] Could not load contributor names:', error.message);
      return new Map();
    });
  return (await contributorLabels).get(normalizeAddress(address)) || '';
}

export function renderUsdcAmount(units, { className = '' } = {}) {
  const classes = ['usdc-amount', className].filter(Boolean).join(' ');
  return `<span class="${classes}"><span class="usdc-amount-text">$${escapeHtml(formatUsdcUnits(units))}</span> ${USDC_ICON}</span>`;
}

export function renderFundSummary(details, { indexing = false } = {}) {
  const hasBudget = details.budgetUnits != null;
  const dollars = Array.from({ length: 6 }, (_, index) => `<span class="fund-prize-dollar" style="--index:${index}">${index % 2 ? '&#128184;' : '$'}</span>`).join('');
  const crowd = ['&#127928;', '&#128378;', '&#127927;', '&#128131;', '&#127908;']
    .map((character, index) => `<span class="fund-prize-busker" style="--index:${index}">${character}</span>`).join('');
  return `<span class="fund-prize">
    <span class="fund-prize-label">${hasBudget ? 'This week\'s prize pool' : 'Current fund balance'}</span>
    ${renderUsdcAmount(hasBudget ? details.budgetUnits : details.balanceUnits, { className: 'fund-prize-amount' })}
    ${hasBudget ? '' : `<span class="fund-prize-caption">${indexing ? 'History is still indexing &middot; weekly budget unavailable' : 'Weekly budget unavailable'}</span>`}
    <span class="fund-prize-orbit" aria-hidden="true">${dollars}</span>
    <span class="fund-prize-crowd" aria-hidden="true">${crowd}</span>
  </span>`;
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
    label: primary || aliases[0] || await registeredContributorLabel(address) || shortAddress(address),
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
      source.advertiserHtml || (source.advertiser ? `<span>${escapeHtml(source.advertiserLabel || source.advertiser)}</span>` : '<span>Purchaser unavailable</span>'),
      source.paidAdvert ? `<span>Paid request #${escapeHtml(String(source.requestId))} · payer ${escapeHtml(source.payer || '')}</span>` : '']
      .filter(Boolean).join(' · ')
    : source.kind === 'djuke'
      ? source.payerHtml || source.payerLabel || source.payer ? `<span>${escapeHtml(source.payerLabel || source.payer || '')}</span>` : ''
      : '';
  return `<tr class="fund-source-row fund-source-${escapeHtml(source.kind || 'sponsor')}"><td>${wallet}</td><td>${escapeHtml(source.paidAdvert ? 'Paid advert playback' : sourceKindLabel(source.kind))}</td><td class="radio-history-number">${amount}</td><td>${tx}${extra ? ` · ${extra}` : ''}</td></tr>`;
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
  return `<details class="fund-disclosure"><summary><strong>${escapeHtml(fund.label)}</strong> · ${renderUsdcAmount(fund.balanceUnits)} · ${reserved}${avail}</summary><div class="fund-disclosure-body">${fund.description ? `<p class="fund-description">${escapeHtml(fund.description)}</p>` : ''}${renderFundSourcesTable(fund)}${fund.slug === 'dbusk-live-performers' ? '<p>Earmarked, NOT escrowed. Admin can recoverFund.</p>' + (fund.escrowTotals ? `<p>Configured escrow: locked ${renderUsdcAmount(fund.escrowTotals.lockedUnits)} · paid ${renderUsdcAmount(fund.escrowTotals.paidUnits)} · refunded ${renderUsdcAmount(fund.escrowTotals.refundedUnits)}</p>` : '') + liveBookingRows(fund.bookings || []) : ''}</div></details>`;
}

export function renderFundPendingTable(rows, { fundSlug, week = '' } = {}) {
  const topTen = fundSlug === 'dbusk-top10';
  const table = entries => `<table class="fund-pending-table"><thead><tr><th>Rank</th><th>Song</th><th>Artist / recipient</th><th>${topTen ? 'Net votes' : 'Qualified plays'}</th><th>Estimated payment</th><th>Status</th></tr></thead><tbody>${entries.map(row => {
    const linked = /^0x(?!0{40}$)[0-9a-fA-F]{40}$/i.test(row.wallet || '');
    const status = !linked ? 'Pending · wallet required' : BigInt(row.amountUnits || '0') > 0n ? 'Pending · estimate' : 'Pending · no payable share';
    return `<tr class="fund-pending-row" data-pending-track="${escapeHtml(row.trackId || '')}"><td>${escapeHtml(row.rank)}</td><td>${escapeHtml(row.title || 'Untitled song')}</td><td>${row.artist ? `<span>${escapeHtml(row.artist)}</span>` : ''}${row.walletHtml ? `<div>${row.walletHtml}</div>` : ''}</td><td>${escapeHtml(topTen ? row.votes : row.plays)}</td><td class="fund-breakdown-amount">${renderUsdcAmount(row.amountUnits, { className: 'fund-amount-pending' })}</td><td>${status}</td></tr>`;
  }).join('')}</tbody></table>`;
  const content = rows == null ? '<p class="fund-pending-empty">Current-week estimates unavailable. Retrying.</p>'
    : !rows.length ? '<p class="fund-pending-empty">No qualifying songs recorded this week.</p>'
      : `${table(rows.slice(0, 4))}${rows.length > 4 ? `<details class="fund-pending-details" data-fund-pending="${escapeHtml(`${fundSlug}:${week}`)}"><summary>Show ${rows.length - 4} more pending payments</summary>${table(rows.slice(4))}</details>` : ''}`;
  return `<section class="fund-pending-section" aria-labelledby="fund-pending-title"><h4 id="fund-pending-title">Pending · ${topTen ? 'Top 10 song prizes' : 'Playback song shares'}${week ? ` · ${escapeHtml(week)}` : ''}</h4>${!topTen ? '<p class="fund-pending-meta">Song contributions to artist-wallet payments</p>' : ''}${content}</section>`;
}

export function renderFundWeeklyArchive(archive = {}) {
  const weeks = Array.isArray(archive.weeks) ? archive.weeks : [];
  const unmatched = Array.isArray(archive.unmatchedPayouts) ? archive.unmatchedPayouts : [];
  if (!weeks.length && !unmatched.length) return '<p class="fund-weekly-empty">No weekly allocations or payments have been indexed yet.</p>';
  const weeklyHtml = `<div class="fund-weekly-archive">${weeks.map(week => {
    const status = week.status || 'queued';
    const period = week.period || {};
    const header = `${escapeHtml(week.week)} · ${status.toUpperCase()} · ${renderUsdcAmount(week.totalUnits)} scheduled · ${renderUsdcAmount(week.paidUnits || '0', { className: 'fund-amount-out' })} paid`;
    const rows = (week.entries || []).map((entry, index) => `
      <tr class="fund-weekly-row fund-weekly-${escapeHtml(status)} ${entry.paid ? 'fund-weekly-confirmed' : 'fund-weekly-frozen'}">
        <td>${entry.title ? `<strong>${entry.rank ? `${escapeHtml(entry.rank)}. ` : ''}${escapeHtml(entry.title)}</strong><div class="fund-weekly-sub">${escapeHtml(entry.artist || entry.walletLabel || '')}</div>` : escapeHtml(entry.artist || entry.walletLabel || entry.wallet || `Winner ${index + 1}`)}${entry.walletHtml ? `<div class="fund-weekly-sub">${entry.walletHtml}</div>` : ''}${entry.artist ? `<div class="fund-weekly-sub">${escapeHtml(entry.votes ?? entry.plays ?? 0)} ${entry.votes != null ? 'votes' : 'plays'}</div>` : ''}</td>
        <td class="fund-breakdown-amount">${renderUsdcAmount(entry.amountUnits, { className: entry.paid ? 'fund-amount-out' : 'fund-amount-frozen' })}</td>
        <td class="fund-breakdown-amount">${renderUsdcAmount(entry.paidUnits ?? (entry.paid ? entry.amountUnits : '0'), { className: 'fund-amount-out' })}${entry.paymentMismatch ? '<div class="fund-weekly-warning">Payment mismatch</div>' : ''}</td>
        <td class="fund-breakdown-amount">${renderUsdcAmount((week.entries || []).slice(0, index + 1).reduce((sum, item) => sum + BigInt(item.paidUnits ?? (item.paid ? item.amountUnits : '0')), 0n), { className: 'fund-amount-out' })}</td>
        <td>${(entry.payments?.length ? entry.payments : entry.txHash ? [entry] : []).map(payment => `<a href="https://basescan.org/tx/${escapeHtml(payment.txHash)}" target="_blank" rel="noopener">BaseScan</a>${payment.timestamp ? `<div class="fund-weekly-sub">${escapeHtml(new Date(payment.timestamp * 1000).toLocaleString())}</div>` : ''}`).join(' ') || '<span class="fund-weekly-queued">Frozen · awaiting payment</span>'}</td>
      </tr>`).join('');
    const archiveLink = week.metadataUri ? `<a href="${escapeHtml(week.metadataUri.replace('ipfs://', 'https://gateway.pinata.cloud/ipfs/'))}" target="_blank" rel="noopener">IPFS JSON</a>` : 'IPFS JSON unavailable';
    return `<details class="fund-weekly-details fund-weekly-${escapeHtml(status)}" data-fund-week="${escapeHtml(week.week)}">
      <summary><strong>${header}</strong> · ${escapeHtml(status)} · ${escapeHtml(period.startAt || '')}</summary>
      <div class="fund-weekly-body">
        <p class="fund-weekly-meta">Allocation ${escapeHtml(week.metadataUri || 'unpublished')} · ${archiveLink}</p>
        <table class="fund-weekly-table"><thead><tr><th>Recipient</th><th>Scheduled</th><th>Paid</th><th>Running paid total</th><th>Tx</th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="fund-weekly-empty">No payouts indexed yet.</td></tr>`}</tbody></table>
      </div>
    </details>`;
  }).join('')}</div>`;
  const unmatchedHtml = unmatched.length ? `<section class="fund-weekly-unmatched"><h4>Unmatched on-chain payments</h4><p class="fund-weekly-meta">Allocation receipts must be restored before these payments can be assigned to a prize week.</p><table class="fund-weekly-table"><thead><tr><th>Recipient</th><th>Paid</th><th>Tx</th></tr></thead><tbody>${unmatched.map(payment => `<tr><td>${renderWalletButton({ address: payment.recipient, label: shortAddress(payment.recipient) })}</td><td>${renderUsdcAmount(payment.amountUnits, { className: 'fund-amount-out' })}</td><td><a href="https://basescan.org/tx/${escapeHtml(payment.txHash)}" target="_blank" rel="noopener">BaseScan</a></td></tr>`).join('')}</tbody></table></section>` : '';
  return weeklyHtml + unmatchedHtml;
}

export function renderFundsSection(funds = [], title = 'Community Funds') {
  return `<section class="community-funds-section"><h3>💰 ${escapeHtml(title)}</h3>${funds.map(renderFundDisclosure).join('')}</section>`;
}
