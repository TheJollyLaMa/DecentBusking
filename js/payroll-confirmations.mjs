import { formatUsdcUnits } from './usdc-format.mjs?v=20261017-mercury-release';

const operations = new Map();

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
  if (!operations.has(week)) operations.set(week, { transactions: new Map(), statuses: new Map() });
  return operations.get(week);
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
    link.textContent = kind === 'failed' ? `Reverted transaction: ${wallet} (no payment)`
      : kind === 'approval' ? `Wallet enabled: ${wallet}`
      : `${category === 'playback' ? 'Playback' : 'Top 10'}: ${formatUsdcUnits(amountUnits)} USDC to ${wallet}${entries > 1 ? ` (${entries} prizes)` : ''}`;
    const cost = document.createElement('small');
    cost.textContent = fee.wei == null ? `Gas unavailable: ${fee.error}. See transaction for fees.`
      : `Gas: ${formatEther(fee.wei)} ETH`;
    row.append(link, cost);
    list.append(row);
  }
  const totals = document.createElement('p');
  totals.className = 'payroll-confirmations-totals';
  totals.textContent = `${payments} payments · Playback ${formatUsdcUnits(playback)} USDC · Top 10 ${formatUsdcUnits(top10)} USDC · Total paid ${formatUsdcUnits(playback + top10)} USDC`;
  const fees = document.createElement('p');
  fees.textContent = `Gas spent${missingFees ? ' (known subtotal)' : ''}: ${formatEther(gas)} ETH · includes wallet approvals and Base L1 data fees${missingFees ? ` · ${missingFees} transaction fee(s) unavailable; total incomplete` : ''}`;
  content.append(heading, status, list, totals, fees);
}

export async function recordPayrollConfirmation({ week, receipt, provider, ...transaction }) {
  const operation = operationFor(week);
  const key = transaction.txHash.toLowerCase();
  if (operation.transactions.has(key)) return;
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
