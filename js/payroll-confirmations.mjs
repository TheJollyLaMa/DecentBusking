import { formatUsdcUnits } from './usdc-format.mjs?v=20261017-mercury-release';
import { lookupEnsName } from './ens-client.mjs?v=20261016-ens-worker';

const operations = new Map();
const recipientNames = new Map();
const recipientNameRequests = new Map();
let contributorNamesRequest;

function formatEther(wei) {
  const value = BigInt(wei);
  return `${value / 10n ** 18n}.${(value % 10n ** 18n).toString().padStart(18, '0')}`.replace(/\.?0+$/, '') || '0';
}

export async function payrollTransactionFee(receipt, provider, txHash) {
  try {
    const execution = receipt.fee ?? (receipt.gasUsed != null && receipt.gasPrice != null
      ? BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice) : null);
    const raw = receipt.l1Fee != null ? receipt : await provider.send('eth_getTransactionReceipt', [txHash]);
    if (execution == null || raw?.l1Fee == null) throw new Error('Receipt is missing execution or Base L1 data fees');
    return { wei: BigInt(execution) + BigInt(raw.l1Fee) + BigInt(raw.operatorFee ?? 0), error: null };
  } catch (error) {
    console.warn('[payroll] Confirmed transaction fee unavailable:', txHash, error);
    return { wei: null, error: error.message };
  }
}

function operationFor(week) {
  if (!operations.has(week)) operations.set(week, {
    transactions: new Map(), statuses: new Map(), pendingNames: new Set(), failedNames: new Set(),
  });
  return operations.get(week);
}

async function loadContributorNames() {
  contributorNamesRequest ||= fetch(new URL('../contributor-accounts.json', import.meta.url), {
    signal: AbortSignal.timeout(6000),
  }).then(async response => {
    if (!response.ok) throw new Error(`Contributor directory returned ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data?.contributors)) throw new Error('Contributor directory is invalid');
    return new Map(data.contributors
      .filter(entry => /^0x[0-9a-f]{40}$/i.test(entry.walletAddress || '') &&
        typeof entry.displayName === 'string' && entry.displayName.trim())
      .map(entry => [entry.walletAddress.toLowerCase(), entry.displayName.trim()]));
  }).catch(() => null);
  return contributorNamesRequest;
}

async function loadCreatorProfile(address) {
  const service = String(globalThis.window?.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
  if (!service) return null;
  const response = await fetch(`${service}/api/creator/profile?${new URLSearchParams({ address })}`, {
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error(`Creator profile returned ${response.status}`);
  return response.json();
}

async function recipientDisplayName(address) {
  const key = address.toLowerCase();
  const [contributors, profileResult] = await Promise.all([
    loadContributorNames(),
    loadCreatorProfile(address).then(value => ({ value, failed: false }), () => ({ value: null, failed: true })),
  ]);
  const profile = profileResult.value;
  const curated = contributors?.get(key) || '';
  const displayName = typeof profile?.displayName === 'string' ? profile.displayName.trim() : '';
  if (displayName || curated) return { name: displayName || curated, failed: profileResult.failed && !contributors };
  try {
    const ens = await lookupEnsName(address);
    if (ens) return { name: ens, failed: false };
  } catch {
    const discordName = typeof profile?.discord?.displayName === 'string' ? profile.discord.displayName.trim() : '';
    return { name: discordName, failed: !discordName };
  }
  const discordName = typeof profile?.discord?.displayName === 'string' ? profile.discord.displayName.trim() : '';
  return { name: discordName, failed: !discordName && (!contributors || profileResult.failed) };
}

function trackRecipientName(week, wallet) {
  if (!/^0x[0-9a-f]{40}$/i.test(wallet || '')) return;
  const key = wallet.toLowerCase();
  const operation = operationFor(week);
  if (operation.pendingNames.has(key) || operation.failedNames.has(key) || recipientNames.has(key)) return;
  operation.pendingNames.add(key);
  let request = recipientNameRequests.get(key);
  if (!request) {
    request = recipientDisplayName(wallet);
    recipientNameRequests.set(key, request);
    request.then(result => {
      if (result.name) recipientNames.set(key, result.name);
      return result;
    }).finally(() => recipientNameRequests.delete(key));
  }
  request.then(result => {
    operation.pendingNames.delete(key);
    if (result.failed) operation.failedNames.add(key);
    render(week);
  });
}

function recipientLabel(wallet) {
  const name = recipientNames.get(String(wallet || '').toLowerCase());
  if (!name) return wallet;
  return `${name} · ${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

function render(week) {
  if (typeof document === 'undefined') return;
  const operation = operationFor(week);
  if (!operation.transactions.size) return;
  let panel = document.getElementById('payroll-confirmations');
  if (!panel) {
    panel = document.createElement('section');
    panel.id = 'payroll-confirmations';
    panel.setAttribute('aria-label', 'Payroll confirmations');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'payroll-btn payroll-btn-secondary';
    close.textContent = 'Close';
    close.setAttribute('aria-label', 'Close payroll confirmations');
    close.addEventListener('click', () => { panel.hidden = true; });
    const title = document.createElement('h3');
    title.textContent = 'Payroll confirmations';
    const content = document.createElement('div');
    content.className = 'payroll-confirmations-content';
    panel.append(close, title, content);
    document.body.append(panel);
  }
  panel.hidden = false;
  const content = panel.querySelector('.payroll-confirmations-content');
  content.replaceChildren();
  const heading = document.createElement('p');
  heading.textContent = `${week} · this browser session`;
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = [...operation.statuses].map(([category, text]) => `${category === 'playback' ? 'Playback' : 'Top 10'}: ${text}`).join(' · ');
  const namesStatus = document.createElement('p');
  namesStatus.setAttribute('role', 'status');
  namesStatus.textContent = operation.pendingNames.size
    ? 'Resolving recipient names; wallet addresses remain available.'
    : operation.failedNames.size ? 'Some names could not be resolved; wallet addresses remain available.' : '';
  const list = document.createElement('ol');
  let playback = 0n;
  let top10 = 0n;
  let gas = 0n;
  let missingFees = 0;
  let payments = 0;
  for (const transaction of operation.transactions.values()) {
    const { txHash, kind, category, wallet, amountUnits, fee, entries } = transaction;
    if (kind === 'payout') {
      payments++;
      if (category === 'playback') playback += BigInt(amountUnits);
      else top10 += BigInt(amountUnits);
    }
    if (fee.wei == null) missingFees++;
    else gas += fee.wei;
    const row = document.createElement('li');
    const link = document.createElement('a');
    link.href = `https://basescan.org/tx/${txHash}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = kind === 'failed' ? 'Reverted transaction (no payment)'
      : kind === 'approval' ? 'Wallet enabled'
      : `${category === 'playback' ? 'Playback' : 'Top 10'}: ${formatUsdcUnits(amountUnits)} USDC`;
    const recipient = document.createElement('a');
    recipient.href = `https://basescan.org/address/${wallet}`;
    recipient.target = '_blank';
    recipient.rel = 'noopener noreferrer';
    recipient.title = wallet;
    const resolvedName = recipientNames.get(String(wallet || '').toLowerCase());
    recipient.setAttribute('aria-label', resolvedName ? `Recipient ${resolvedName}, wallet ${wallet}` : `Recipient wallet ${wallet}`);
    recipient.textContent = recipientLabel(wallet);
    if (kind === 'failed') link.textContent += ' · recipient:';
    else if (kind === 'approval') link.textContent += ' · ';
    else link.textContent += ` to${entries > 1 ? ` (${entries} prizes)` : ''}`;
    const cost = document.createElement('small');
    cost.textContent = fee.wei == null ? `Gas unavailable: ${fee.error}. See transaction for fees.`
      : `Gas: ${formatEther(fee.wei)} ETH`;
    row.append(link, document.createTextNode(' '), recipient, cost);
    list.append(row);
  }
  const totals = document.createElement('p');
  totals.className = 'payroll-confirmations-totals';
  totals.textContent = `${payments} payments · Playback ${formatUsdcUnits(playback)} USDC · Top 10 ${formatUsdcUnits(top10)} USDC · Total paid ${formatUsdcUnits(playback + top10)} USDC`;
  const fees = document.createElement('p');
  fees.textContent = `Gas spent${missingFees ? ' (known subtotal)' : ''}: ${formatEther(gas)} ETH · includes wallet approvals and Base L1 data fees${missingFees ? ` · ${missingFees} transaction fee(s) unavailable; total incomplete` : ''}`;
  content.append(heading, status, namesStatus, list, totals, fees);
}

export async function recordPayrollConfirmation({ week, receipt, provider, ...transaction }) {
  const operation = operationFor(week);
  const key = transaction.txHash.toLowerCase();
  if (operation.transactions.has(key)) return;
  trackRecipientName(week, transaction.wallet);
  // Show the confirmed transfer immediately; fee lookup must not delay its proof.
  operation.transactions.set(key, { ...transaction, fee: { wei: null, error: 'Loading receipt fees' } });
  render(week);
  const fee = await payrollTransactionFee(receipt, provider, transaction.txHash);
  operation.transactions.set(key, { ...transaction, fee });
  render(week);
}

export function setPayrollConfirmationStatus(week, category, status) {
  operationFor(week).statuses.set(category, status);
  render(week);
}
