import { getBaseReadProvider } from './base-chain.mjs?v=20261018-shared-provider';
import { isAdminWallet } from './admin-access.mjs';
const DEFAULT_ESTIMATED_DAILY_BURN_WEI = 86_000_000_000_000n;
// 0.00002 ETH: roughly ten music-play reports or fifty impressions at October 2026 Base fees.
export const DEFAULT_WORKER_MIN_BALANCE_WEI = 20_000_000_000_000n;
export const SPONSORED_WORKER_WARNING_WEI = 2_000_000_000_000_000n;
export const SPONSORED_WORKER_TARGET_WEI = 3_000_000_000_000_000n;

export function workerAlertAction(state, unavailable = false) {
  if (unavailable) return { id: 'worker-gas', label: 'Worker balance unavailable: check funding before sponsored playback' };
  return state?.lowBalance ? { id: 'worker-gas', label: 'Top up the playback worker with ETH on Base' } : null;
}

function formatEth(wei) {
  if (typeof wei !== 'bigint' || wei < 0n) return '0 ETH';
  const whole = wei / 1_000_000_000_000_000_000n;
  const fraction = String(wei % 1_000_000_000_000_000_000n).padStart(18, '0').replace(/0+$/, '').slice(0, 6);
  return `${whole}${fraction ? `.${fraction}` : ''} ETH`;
}

function safeBigInt(value, fallback = 0n) {
  if (value == null) return fallback;
  try {
    return typeof value === 'bigint' ? value : BigInt(value);
  } catch {
    return fallback;
  }
}

export async function readWorkerGasState({ provider, workerAddress, minBalanceWei = 0n,
  estimatedDailyBurnWei = DEFAULT_ESTIMATED_DAILY_BURN_WEI }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(workerAddress || '')) throw new Error('Invalid worker wallet');
  if (Number((await provider.getNetwork()).chainId) !== 8453) throw new Error('Worker balance must be checked on Base');
  const balance = await provider.getBalance(workerAddress);
  if (typeof balance !== 'bigint' || balance < 0n) throw new Error('Invalid worker ETH balance');
  const thresholdWei = safeBigInt(minBalanceWei, 0n);
  const dailyBurnWei = safeBigInt(estimatedDailyBurnWei, DEFAULT_ESTIMATED_DAILY_BURN_WEI);
  return {
    workerAddress,
    balanceWei: balance,
    thresholdWei,
    empty: balance === 0n,
    lowBalance: balance < thresholdWei,
    runwayDays: dailyBurnWei > 0n ? Number(balance / dailyBurnWei) : null,
  };
}

function formatWorkerGasStatus(state) {
  if (!state) return '';
  const threshold = state.thresholdWei ?? 0n;
  const runway = Number.isInteger(state.runwayDays) ? `${state.runwayDays} day${state.runwayDays === 1 ? '' : 's'}` : 'unknown';
  return state.lowBalance
    ? `Worker balance low: ${formatEth(state.balanceWei)} · threshold ${formatEth(threshold)} · estimated runway ${runway}`
    : `Worker balance: ${formatEth(state.balanceWei)} · threshold ${formatEth(threshold)} · estimated runway ${runway}`;
}

export function initWorkerGasNotices() {
  const notices = [...document.querySelectorAll('.worker-gas-notice')];
  if (!notices.length) return;
  const states = notices.map(notice => {
    notice.hidden = false;
    const state = document.createElement('p');
    state.className = 'worker-gas-state';
    state.setAttribute('role', 'status');
    state.hidden = false;
    notice.append(state);
    return state;
  });
  let pending = null;
  let checkedAt = 0;
  let generation = 0;
  const alert = document.getElementById('admin-worker-alert');
  const publish = (state, unavailable = false) => {
    const action = workerAlertAction(state, unavailable);
    document.dispatchEvent(new CustomEvent('worker-gas-state-updated', { detail: { action } }));
    if (alert) {
      alert.hidden = !action || !isAdminWallet();
      alert.textContent = action ? `${action.label}.${state ? ` ${formatWorkerGasStatus(state)}.` : ''} Use the verified address in this section. No automatic transfer will be made.` : '';
    }
  };
  async function check() {
    const revision = generation;
    const cfg = window.DecentConfig || {};
    const sponsored = cfg.djukeContractVersion === '0.5';
    const configured = safeBigInt(cfg.workerMinBalanceWei, DEFAULT_WORKER_MIN_BALANCE_WEI);
    const thresholdWei = sponsored && configured < SPONSORED_WORKER_WARNING_WEI ? SPONSORED_WORKER_WARNING_WEI : configured;
    const estimatedDailyBurnWei = safeBigInt(cfg.workerEstimatedDailyBurnWei, DEFAULT_ESTIMATED_DAILY_BURN_WEI);
    let timeout, provider;
    try {
      provider = getBaseReadProvider({ ethers });
      const read = async () => {
        if (!cfg.djukeContractAddress) throw new Error('DJuke contract is not configured');
        const contract = new ethers.Contract(cfg.djukeContractAddress, ['function gasWorker() view returns(address)'], provider);
        return readWorkerGasState({
          provider,
          workerAddress: await contract.gasWorker(),
          minBalanceWei: thresholdWei,
          estimatedDailyBurnWei,
        });
      };
      const result = await Promise.race([read(), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Worker balance check timed out')), 15000);
      })]);
      if (revision !== generation || !isAdminWallet()) return;
      notices.forEach(notice => {
        notice.hidden = false;
        const address = notice.querySelector('code');
        if (address) address.textContent = result.workerAddress;
        const link = notice.querySelector('[data-worker-explorer]');
        if (link) link.href = `https://basescan.org/address/${result.workerAddress}`;
      });
      states.forEach(state => {
        state.hidden = false;
        state.textContent = `${formatWorkerGasStatus(result)}${sponsored
          ? ` · Manual top-up target ${formatEth(SPONSORED_WORKER_TARGET_WEI)}. Sponsored checkout pauses below 0.001 ETH or when its estimated gas budget is insufficient.` : ''}`;
      });
      checkedAt = Date.now();
      publish(result);
    } catch (error) {
      if (revision !== generation) return;
      console.warn('[worker-gas]', error.message);
      notices.forEach(notice => { notice.hidden = false; });
      states.forEach(state => {
        state.hidden = false;
        state.textContent = `Worker ETH balance unavailable: ${error.message}.`;
      });
      publish(null, true);
    } finally {
      clearTimeout(timeout);
      provider?.destroy();
    }
  }
  const refresh = () => {
    if (!isAdminWallet()) return;
    if (!pending && Date.now() - checkedAt >= 60000) pending = check().finally(() => { pending = null; });
    return pending;
  };
  refresh();
  const reset = () => {
    generation++;
    checkedAt = 0;
    if (alert) alert.hidden = true;
    document.dispatchEvent(new CustomEvent('worker-gas-state-updated', { detail: { action: null } }));
    if (pending) pending.finally(refresh);
    else refresh();
  };
  document.addEventListener('wallet-connected', reset);
  document.addEventListener('wallet-disconnected', reset);
  document.addEventListener('open-admin', refresh);
  document.addEventListener('left-drawer-open', refresh);
  setInterval(() => { if (!document.hidden) refresh(); }, 60000);
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initWorkerGasNotices);
