import { BASE_CHAIN_ID, ensureBaseNetwork, getBaseReadProvider } from './base-chain.mjs?v=20261018-shared-provider';
import { isAdminWallet } from './admin-access.mjs';
const DEFAULT_ESTIMATED_DAILY_BURN_WEI = 86_000_000_000_000n;
// 0.00002 ETH: roughly ten music-play reports or fifty impressions at October 2026 Base fees.
export const DEFAULT_WORKER_MIN_BALANCE_WEI = 20_000_000_000_000n;
export const SPONSORED_WORKER_WARNING_WEI = 2_000_000_000_000_000n;
export const SPONSORED_WORKER_MIN_BALANCE_WEI = 1_000_000_000_000_000n;
export const SPONSORED_WORKER_TARGET_WEI = 3_000_000_000_000_000n;

// Typo guard: a single top-up can add at most 0.1 ETH (about 33 tanks).
export const MAX_WORKER_TOP_UP_WEI = 100_000_000_000_000_000n;
const WEI_PER_ETH = 1_000_000_000_000_000_000n;

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


const ETH_STEP_WEI = 1_000_000_000_000n;
const GAUGE_ARC = 'M10 50 A40 40 0 0 1 90 50';
const BASESCAN = 'https://basescan.org';

function ethDigits(wei, digits = 6) {
  const whole = wei / WEI_PER_ETH;
  const fraction = String(wei % WEI_PER_ETH).padStart(18, '0').slice(0, digits).replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}

function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function workerTankWei(state) {
  const threshold = safeBigInt(state?.thresholdWei, 0n);
  return threshold > SPONSORED_WORKER_TARGET_WEI ? threshold : SPONSORED_WORKER_TARGET_WEI;
}

export function workerGauge(state, targetWei = workerTankWei(state)) {
  if (typeof state?.balanceWei !== 'bigint' || targetWei <= 0n) return { level: 'unknown', fill: 0, multiplier: 0 };
  const balance = state.balanceWei;
  const tanks = balance / targetWei;
  return {
    level: state.lowBalance ? 'low' : balance < targetWei ? 'reserve' : 'full',
    fill: tanks >= 1n ? 1 : Number(balance * 10_000n / targetWei) / 10_000,
    multiplier: tanks >= 2n ? Number(tanks) : 0,
  };
}

// Amount that lifts the balance to `tanks` full tanks, rounded up to the next 0.000001 ETH.
export function topUpToTanksWei(state, tanks = 1) {
  if (typeof state?.balanceWei !== 'bigint') return 0n;
  const missing = workerTankWei(state) * BigInt(tanks) - state.balanceWei;
  return missing > 0n ? (missing + ETH_STEP_WEI - 1n) / ETH_STEP_WEI * ETH_STEP_WEI : 0n;
}

export function parseTopUpWei(text, maxWei = MAX_WORKER_TOP_UP_WEI) {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(String(text ?? '').trim());
  if (!match || (!match[1] && !match[2])) throw new Error('Enter an ETH amount');
  const fraction = match[2] || '';
  if (fraction.length > 18) throw new Error('Use at most 18 decimals');
  const wei = BigInt(match[1] || '0') * WEI_PER_ETH + BigInt(fraction.padEnd(18, '0'));
  if (wei <= 0n) throw new Error('Enter more than 0 ETH');
  if (wei > maxWei) throw new Error(`One top-up is capped at ${formatEth(maxWei)}`);
  return wei;
}

export async function sendWorkerTopUp({ signer, workerAddress, amountWei, onStep = () => {} }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(workerAddress || '')) throw new Error('Worker wallet is not verified yet');
  if (typeof amountWei !== 'bigint' || amountWei <= 0n || amountWei > MAX_WORKER_TOP_UP_WEI) {
    throw new Error('Choose a valid top-up amount');
  }
  onStep('confirm');
  const tx = await signer.sendTransaction({ to: workerAddress, value: amountWei, chainId: BASE_CHAIN_ID });
  onStep('pending', tx.hash);
  let receipt;
  try {
    receipt = await tx.wait();
  } catch (error) {
    if (error?.code !== 'TRANSACTION_REPLACED' || error.receipt?.status !== 1) throw error;
    if (error.cancelled) throw new Error('The wallet cancelled or replaced this top-up. Check your wallet before trying again');
    receipt = error.receipt;
  }
  if (receipt?.status !== 1) throw new Error('Top-up was not confirmed');
  return { hash: receipt.hash || tx.hash };
}

export function workerGaugeMarkup({ preview = false } = {}) {
  return `<svg class="wg-svg" viewBox="0 0 100 84" aria-hidden="true" focusable="false">`
    + `<path class="wg-track" d="${GAUGE_ARC}" pathLength="100"/>`
    + (preview ? `<path class="wg-after" d="${GAUGE_ARC}" pathLength="100"/>` : '')
    + `<path class="wg-fill" d="${GAUGE_ARC}" pathLength="100"/>`
    + `<path class="wg-shine" d="${GAUGE_ARC}" pathLength="100"/>`
    + '<text class="wg-mark" x="10" y="62" text-anchor="middle">E</text>'
    + '<text class="wg-mark" x="90" y="62" text-anchor="middle">F</text>'
    + '<image class="wg-pump" href="img/Ens_Eth_Breathe.png" x="42" y="23" width="16" height="16"/>'
    + '<line class="wg-needle" x1="50" y1="50" x2="50" y2="18"/>'
    + '<circle class="wg-pivot" cx="50" cy="50" r="4"/>'
    + '<text class="wg-times" x="50" y="65" text-anchor="middle"></text>'
    + '<text class="wg-balance" x="50" y="79" text-anchor="middle"></text></svg>';
}

// Only the ghost arc previews a top-up; the needle, multiplier and balance remain actual holdings.
function paintGauge(root, gauge, state, after = null) {
  root.dataset.level = gauge.level;
  if (after) root.dataset.afterLevel = after.level;
  else delete root.dataset.afterLevel;
  const fill = root.querySelector('.wg-fill');
  if (fill) fill.style.strokeDasharray = `${(gauge.fill * 100).toFixed(2)} 100`;
  const ghost = root.querySelector('.wg-after');
  if (ghost) ghost.style.strokeDasharray = `${((after?.fill || 0) * 100).toFixed(2)} 100`;
  const needle = root.querySelector('.wg-needle');
  if (needle) needle.style.transform = `rotate(${(-90 + 180 * gauge.fill).toFixed(1)}deg)`;
  const times = root.querySelector('.wg-times');
  if (times) times.textContent = gauge.multiplier ? `${gauge.multiplier}×` : '';
  const balance = root.querySelector('.wg-balance');
  if (balance) balance.textContent = state ? formatEth(state.balanceWei) : '— ETH';
}

function readingText(state, gauge, error) {
  if (!state) return error ? `unavailable (${error})` : 'checking…';
  const runway = Number.isInteger(state.runwayDays) ? ` · ~${state.runwayDays} day${state.runwayDays === 1 ? '' : 's'}` : '';
  const level = gauge.multiplier ? `${gauge.multiplier} tanks` : `${Math.round(gauge.fill * 100)}% of a ${formatEth(workerTankWei(state))} tank`;
  return `${formatEth(state.balanceWei)}${runway} · ${level}${gauge.level === 'low' ? ' · low' : ''}`;
}

function workerGasConfig() {
  const cfg = globalThis.window?.DecentConfig || {};
  const configured = safeBigInt(cfg.workerMinBalanceWei, DEFAULT_WORKER_MIN_BALANCE_WEI);
  return {
    contract: cfg.djukeContractAddress,
    thresholdWei: cfg.djukeContractVersion === '0.5' && configured < SPONSORED_WORKER_WARNING_WEI
      ? SPONSORED_WORKER_WARNING_WEI : configured,
    dailyBurnWei: safeBigInt(cfg.workerEstimatedDailyBurnWei, DEFAULT_ESTIMATED_DAILY_BURN_WEI),
  };
}

export function initWorkerGasGauge() {
  const button = document.getElementById('worker-gas-gauge');
  if (!button) return;
  const dialog = document.getElementById('worker-gas-dialog');
  const calendar = document.getElementById('radio-programming-modal');
  const part = name => dialog?.querySelector(`[data-worker-gas-${name}]`);
  const preview = part('preview'), reading = part('reading'), form = part('form'), amount = part('amount'),
    slider = part('slider'), explorer = part('explorer'), status = part('status'), send = part('send');
  const presets = [...(dialog?.querySelectorAll('[data-worker-gas-preset]') || [])];
  button.innerHTML = workerGaugeMarkup();
  if (preview) preview.innerHTML = workerGaugeMarkup({ preview: true });

  let state = null, error = '', pending = null, checkedAt = 0, generation = 0, busy = false, touched = false;
  const config = workerGasConfig();

  const say = (text = '', tone = '', hash = '') => {
    if (!status) return;
    status.textContent = text;
    status.dataset.tone = tone;
    if (hash) {
      const link = document.createElement('a');
      link.href = `${BASESCAN}/tx/${hash}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = ' View on Basescan ↗';
      status.append(link);
    }
  };

  function amountWei() {
    try { return parseTopUpWei(amount?.value); } catch { return null; }
  }

  function renderDialog() {
    if (!dialog) return;
    if (!touched && !busy && amount) amount.value = ethDigits(topUpToTanksWei(state, 1) || SPONSORED_WORKER_TARGET_WEI);
    const gauge = workerGauge(state);
    const wei = amountWei();
    const after = state && wei ? workerGauge({ ...state, balanceWei: state.balanceWei + wei,
      lowBalance: state.balanceWei + wei < state.thresholdWei }) : null;
    if (preview) paintGauge(preview, gauge, state, after);
    if (reading) {
      const afterRunway = after && config.dailyBurnWei > 0n ? ` · ~${(state.balanceWei + wei) / config.dailyBurnWei} days` : '';
      reading.textContent = `Now ${readingText(state, gauge, error)}${after ? `\nAfter ${formatEth(state.balanceWei + wei)}${afterRunway}` : ''}`;
    }
    if (explorer) {
      explorer.hidden = !state;
      if (state) {
        explorer.href = `${BASESCAN}/address/${state.workerAddress}`;
        explorer.textContent = `${shortAddress(state.workerAddress)} ↗`;
        explorer.title = state.workerAddress;
      }
    }
    presets.forEach(preset => {
      const wei = topUpToTanksWei(state, Number(preset.dataset.workerGasPreset));
      preset.disabled = busy || !wei || wei > MAX_WORKER_TOP_UP_WEI;
      preset.title = !state ? 'Checking the balance…' : wei ? `Add ${formatEth(wei)}` : 'Already there';
    });
    if (slider && wei) slider.value = ethDigits(wei);
    if (amount) amount.disabled = busy;
    if (slider) slider.disabled = busy;
    if (send) {
      send.disabled = busy || !state || !wei;
      send.textContent = wei ? `Send ${formatEth(wei)}` : 'Send';
    }
  }

  function render() {
    const admin = isAdminWallet();
    button.hidden = !admin;
    const gauge = workerGauge(state);
    paintGauge(button, gauge, state);
    const label = `Worker gas ${readingText(state, gauge, error)} — open top-up`;
    button.setAttribute('aria-label', label);
    button.title = label;
    if (!admin && dialog?.open) dialog.close();
    renderDialog();
  }

  async function check() {
    const revision = generation;
    let timeout, provider;
    try {
      provider = getBaseReadProvider({ ethers });
      const read = async () => {
        if (!config.contract) throw new Error('DJuke contract is not configured');
        const contract = new ethers.Contract(config.contract, ['function gasWorker() view returns(address)'], provider);
        return readWorkerGasState({ provider, workerAddress: await contract.gasWorker(),
          minBalanceWei: config.thresholdWei, estimatedDailyBurnWei: config.dailyBurnWei });
      };
      const result = await Promise.race([read(), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Worker balance check timed out')), 15000);
      })]);
      if (revision !== generation || !isAdminWallet()) return null;
      state = result;
      error = '';
      checkedAt = Date.now();
      return result;
    } catch (failure) {
      if (revision !== generation) return null;
      console.warn('[worker-gas]', failure.message);
      state = null;
      error = String(failure?.error?.message || failure?.shortMessage || failure?.message || 'balance check failed').slice(0, 80);
      return null;
    } finally {
      clearTimeout(timeout);
      provider?.destroy();
      if (revision === generation) render();
    }
  }

  function refresh({ force = false } = {}) {
    if (!isAdminWallet()) return Promise.resolve(null);
    if (pending) return force ? pending.then(() => refresh({ force })) : pending;
    if (!force && state && Date.now() - checkedAt < 55000) return Promise.resolve(state);
    pending = check().finally(() => { pending = null; });
    return pending;
  }

  function reset() {
    generation++;
    state = null;
    error = '';
    checkedAt = 0;
    render();
    if (calendar?.open || dialog?.open) refresh();
  }

  function setAmount(wei) {
    touched = true;
    if (amount) amount.value = wei ? ethDigits(wei) : '';
    say();
    renderDialog();
  }

  function openDialog() {
    if (!dialog || !isAdminWallet()) return;
    if (!busy) {
      touched = false;
      say();
    }
    renderDialog();
    dialog.showModal();
    refresh({ force: !busy });
  }

  async function submit(event) {
    event.preventDefault();
    const wei = amountWei();
    if (busy || !wei || !state) return;
    const shown = state.workerAddress;
    busy = true;
    renderDialog();
    try {
      say('Checking the worker wallet…');
      const fresh = await refresh({ force: true });
      if (!fresh) throw new Error(error || 'Could not verify the worker wallet');
      if (fresh.workerAddress.toLowerCase() !== shown.toLowerCase()) {
        throw new Error('The worker wallet changed. Review the new address and send again');
      }
      if (!window.ethereum) throw new Error('Open your wallet to top up');
      say('Switching to Base…');
      const provider = new ethers.BrowserProvider(window.ethereum, 'any');
      await ensureBaseNetwork(provider);
      const signer = await provider.getSigner();
      if (!isAdminWallet(await signer.getAddress())) throw new Error('Switch your wallet to the admin account');
      const { hash } = await sendWorkerTopUp({ signer, workerAddress: fresh.workerAddress, amountWei: wei,
        onStep: (step, txHash) => step === 'confirm' ? say('Confirm in your wallet…') : say('Waiting for Base…', '', txHash) });
      busy = false;
      touched = true;
      if (amount) amount.value = '';
      say(`✓ Added ${formatEth(wei)}.`, 'success', hash);
      await refresh({ force: true });
    } catch (failure) {
      console.warn('[worker-gas]', failure);
      say(failure?.code === 'ACTION_REJECTED' || failure?.code === 4001
        ? 'Cancelled in your wallet. Nothing was sent.'
        : `${failure?.shortMessage || failure?.message || 'Top-up failed'}.`, 'error');
    } finally {
      busy = false;
      renderDialog();
    }
  }

  button.addEventListener('click', openDialog);
  part('info')?.addEventListener('click', () => {
    const help = part('help');
    if (!help) return;
    help.hidden = !help.hidden;
    part('info').setAttribute('aria-expanded', String(!help.hidden));
  });
  presets.forEach(preset => preset.addEventListener('click', () => {
    setAmount(topUpToTanksWei(state, Number(preset.dataset.workerGasPreset)));
  }));
  amount?.addEventListener('input', () => {
    touched = true;
    let message = '';
    if (amount.value.trim()) try { parseTopUpWei(amount.value); } catch (failure) { message = failure.message; }
    say(message, message ? 'error' : '');
    renderDialog();
  });
  slider?.addEventListener('input', () => {
    try { setAmount(parseTopUpWei(Number(slider.value).toFixed(6))); } catch { setAmount(0n); }
  });
  form?.addEventListener('submit', submit);
  dialog?.querySelectorAll('[data-worker-gas-close]').forEach(close => close.addEventListener('click', () => dialog.close()));
  dialog?.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });

  render();
  document.addEventListener('open-radio-programming', () => refresh());
  document.addEventListener('wallet-connected', reset);
  document.addEventListener('wallet-disconnected', reset);
  setInterval(() => {
    if (!document.hidden && (calendar?.open || dialog?.open)) refresh();
  }, 60000);
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initWorkerGasGauge);
