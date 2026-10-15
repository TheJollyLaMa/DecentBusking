import { getBaseReadProvider } from './base-chain.mjs?v=20261017-read-rpc';
const DEFAULT_ESTIMATED_DAILY_BURN_WEI = 86_000_000_000_000n;
// 0.00002 ETH: roughly ten music-play reports or fifty impressions at October 2026 Base fees.
export const DEFAULT_WORKER_MIN_BALANCE_WEI = 20_000_000_000_000n;

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
    notice.after(state);
    return state;
  });
  let pending = null;
  let checkedAt = 0;
  async function check() {
    const cfg = window.DecentConfig || {};
    const provider = getBaseReadProvider({ ethers });
    const thresholdWei = safeBigInt(cfg.workerMinBalanceWei, DEFAULT_WORKER_MIN_BALANCE_WEI);
    const estimatedDailyBurnWei = safeBigInt(cfg.workerEstimatedDailyBurnWei, DEFAULT_ESTIMATED_DAILY_BURN_WEI);
    let timeout;
    try {
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
      notices.forEach(notice => {
        notice.hidden = false;
        const address = notice.querySelector('code');
        if (address) address.textContent = result.workerAddress;
      });
      states.forEach(state => {
        state.hidden = false;
        state.textContent = formatWorkerGasStatus(result);
      });
      checkedAt = Date.now();
    } catch (error) {
      console.warn('[worker-gas]', error.message);
      notices.forEach(notice => { notice.hidden = false; });
      states.forEach(state => {
        state.hidden = false;
        state.textContent = `Worker ETH balance unavailable: ${error.message}.`;
      });
    } finally {
      clearTimeout(timeout);
      provider.destroy();
    }
  }
  const refresh = () => {
    if (!pending && Date.now() - checkedAt >= 60000) pending = check().finally(() => { pending = null; });
    return pending;
  };
  refresh();
  document.addEventListener('open-admin', refresh);
  document.addEventListener('left-drawer-open', refresh);
  setInterval(() => { if (!document.hidden) refresh(); }, 60000);
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initWorkerGasNotices);
