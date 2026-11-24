import { ensureBaseNetwork, approvalNotice } from './base-chain.mjs?v=20261018-shared-provider';
import { BASE_USDC_ADDRESS, configuredSettlementFunds, depositSettlementUsdc } from './settlement-funds.mjs?v=20261019-fund-tour';
import { escapeHtml } from './fund-display.mjs?v=20261124-lazy-funds';

const DEFAULT_FUNDS = { radioFunds: { playback: 'dbusk-playback', topTen: 'dbusk-top10' },
  fundSlug: 'dbusk-repo-dev', pinnerFundSlug: 'dbusk-pinners',
  liveFundSlug: 'dbusk-live-performers', promotionFundSlug: 'dbusk-promotionals' };
export function contributionFunds(config = globalThis.window?.DecentConfig || DEFAULT_FUNDS) {
  return configuredSettlementFunds({ ...DEFAULT_FUNDS, ...config,
    radioFunds: { ...DEFAULT_FUNDS.radioFunds, ...config.radioFunds } });
}
const allowedFund = slug => contributionFunds().some(fund => fund.slug === slug);
export const SETTLEMENT_ROUTER_ADDRESS = '0x8ecca903e2a6Daa8CCbB933700e4F2C58C44A4B5';
const ROUTER_ABI = [
  'function paused() view returns(bool)',
  'function funds(bytes32) view returns(string metadataUri,bool active,bool exists)',
  'function approvedAssets(address) view returns(bool)',
  'function fundToken(bytes32,address,uint256)',
  'event FundFunded(bytes32 indexed fundId,address indexed asset,address indexed funder,uint256 amount)',
];
const TOKEN_ABI = [
  'function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)', 'function approve(address,uint256) returns(bool)',
  'event Approval(address indexed owner,address indexed spender,uint256 value)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
];
const same = (first, second) => typeof first === 'string' && typeof second === 'string' &&
  first.toLowerCase() === second.toLowerCase();

export function contributionUnits(value) {
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(String(value))) {
    throw new Error('Enter a positive USDC amount with at most six decimal places');
  }
  const [whole, fraction = ''] = String(value).split('.');
  const units = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (units <= 0n) throw new Error('Enter a positive USDC amount');
  return units;
}

export function contributionJournalKey(address, slug) {
  if (!/^0x[0-9a-f]{40}$/i.test(address || '') || !allowedFund(slug)) throw new Error('Invalid contribution wallet or fund');
  return `decentbusking:fund-contribution:8453:${SETTLEMENT_ROUTER_ADDRESS.toLowerCase()}:${address.toLowerCase()}:${slug}`;
}

export function contributionAmount(units) {
  const value = BigInt(units);
  const fraction = String(value % 1000000n).padStart(6, '0').replace(/0+$/, '');
  return `${value / 1000000n}${fraction ? `.${fraction}` : ''}`;
}

export function contributionPlan(amount, shares) {
  const total = contributionUnits(amount);
  if (!Array.isArray(shares) || !shares.length) throw new Error('Choose at least one fund');
  const seen = new Set();
  let totalBps = 0;
  const legs = shares.map(({ slug, percent }) => {
    if (!allowedFund(slug) || seen.has(slug)) throw new Error('Select each configured fund at most once');
    seen.add(slug);
    if (!/^(?:0|[1-9]\d?|100)(?:\.\d{1,2})?$/.test(String(percent))) throw new Error('Use percentages with at most two decimal places');
    const [whole, fraction = ''] = String(percent).split('.');
    const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    totalBps += bps;
    return { slug, bps };
  }).filter(leg => leg.bps > 0);
  if (totalBps !== 10000) throw new Error('Fund percentages must total exactly 100%');
  let remaining = total;
  return legs.map((leg, index) => {
    const units = index === legs.length - 1 ? remaining : total * BigInt(leg.bps) / 10000n;
    if (units <= 0n) throw new Error('Increase the amount or adjust the split; every selected fund needs at least 0.000001 USDC');
    remaining -= units;
    return { slug: leg.slug, amountUnits: units.toString() };
  });
}

export function verifyContributionReceipt({ receipt, operation, ethers }) {
  if (!receipt || receipt.status !== 1) throw new Error('Contribution is not confirmed successfully');
  const iface = new ethers.Interface([...ROUTER_ABI, ...TOKEN_ABI]);
  const amount = BigInt(operation.amountUnits);
  let funded = false;
  let transferred = false;
  let approved = false;
  for (const log of receipt.logs) {
    if (!same(log.address, SETTLEMENT_ROUTER_ADDRESS) && !same(log.address, BASE_USDC_ADDRESS)) continue;
    let event;
    try { event = iface.parseLog(log); } catch { continue; }
    if (same(log.address, SETTLEMENT_ROUTER_ADDRESS) && event?.name === 'FundFunded' &&
        event.args.fundId === ethers.id(operation.slug) && same(event.args.asset, BASE_USDC_ADDRESS) &&
        same(event.args.funder, operation.address) && event.args.amount === amount) funded = true;
    if (same(log.address, BASE_USDC_ADDRESS) && event?.name === 'Transfer' &&
        same(event.args.from, operation.address) && same(event.args.to, SETTLEMENT_ROUTER_ADDRESS) &&
        event.args.value === amount) transferred = true;
    if (same(log.address, BASE_USDC_ADDRESS) && event?.name === 'Approval' &&
        same(event.args.owner, operation.address) && same(event.args.spender, SETTLEMENT_ROUTER_ADDRESS) &&
        event.args.value === amount) approved = true;
  }
  if (operation.stage === 'deposit' && funded && transferred) return 'deposit';
  if (operation.stage === 'approval' && approved) return 'approval';
  throw new Error('Receipt does not prove the recorded contribution stage, fund, sender and exact amount');
}

export function createContributionController({ storage, ethers, deposit = depositSettlementUsdc }) {
  let busy = false;
  let planBusy = false;
  async function contribute({ signer, router, token, slug, amount, onStep = () => {}, planLeg = false, onConfirmed = () => {} }) {
    if (busy || planBusy && !planLeg) throw new Error('A contribution is already in progress');
    busy = true;
    try {
      const address = await signer.getAddress();
      if (!planLeg && storage.getItem(splitKey(address))) throw new Error('An unfinished split exists. Use Resume split before starting another contribution');
      const key = contributionJournalKey(address, slug);
      if (storage.getItem(key)) throw new Error('An earlier contribution is unresolved. Check its receipt before sending again');
      const amountUnits = contributionUnits(amount);
      let operation;
      const result = await deposit({ signer, router, token, owner: address, fundId: ethers.id(slug), amountUnits, onStep,
        onStage: stage => {
          operation = { address, slug, amountUnits: amountUnits.toString(), stage, txHash: null };
          storage.setItem(key, JSON.stringify(operation));
        },
        onBroadcast: record => {
          operation = { ...operation, ...record };
          storage.setItem(key, JSON.stringify(operation));
        },
      }).catch(error => {
        if (operation && !operation.txHash && (error.code === 4001 || error.code === 'ACTION_REJECTED')) storage.removeItem(key);
        throw error;
      });
      const receipt = await signer.provider.getTransactionReceipt(result.txHash);
      verifyContributionReceipt({ receipt, operation, ethers });
      onConfirmed(result.txHash);
      storage.removeItem(key);
      return result;
    } finally { busy = false; }
  }
  async function check({ signer, slug, planLeg = false, onConfirmed = () => {} }) {
    if (busy || planBusy && !planLeg) throw new Error('A contribution is already in progress');
    busy = true;
    try {
      if (Number((await signer.provider.getNetwork()).chainId) !== 8453) throw new Error('Switch your wallet to Base');
      const key = contributionJournalKey(await signer.getAddress(), slug);
      const operation = JSON.parse(storage.getItem(key) || 'null');
      if (!operation) throw new Error('No unresolved contribution for this wallet and fund');
      if (!/^0x[0-9a-f]{64}$/i.test(operation.txHash || '')) {
        throw new Error('Broadcast status is unknown. Review wallet history before retrying; this contribution remains locked');
      }
      const receipt = await signer.provider.getTransactionReceipt(operation.txHash);
      if (!receipt) throw new Error('Transaction is still pending; do not send again');
      if (receipt.status === 0) {
        storage.removeItem(key);
        return { stage: 'reverted', txHash: operation.txHash };
      }
      const stage = verifyContributionReceipt({ receipt, operation, ethers });
      if (stage === 'deposit') {
        const planKey = splitKey(operation.address);
        const journal = JSON.parse(storage.getItem(planKey) || 'null');
        if (journal) {
          const leg = journal.legs.find(item => item.slug === slug && item.amountUnits === operation.amountUnits);
          if (!leg) throw new Error('Confirmed deposit does not match the saved split; review its receipts');
          Object.assign(leg, { status: 'confirmed', txHash: operation.txHash });
          storage.setItem(planKey, JSON.stringify(journal));
        }
        onConfirmed(operation.txHash);
      }
      storage.removeItem(key);
      return { stage, txHash: operation.txHash };
    } finally { busy = false; }
  }
  const splitKey = address => `decentbusking:fund-split:8453:${SETTLEMENT_ROUTER_ADDRESS.toLowerCase()}:${address.toLowerCase()}`;
  async function contributeSplit({ signer, router, token, plan, resume = false, onStep = () => {}, onProgress = () => {} }) {
    if (busy || planBusy) throw new Error('A contribution is already in progress');
    planBusy = true;
    try {
      const address = await signer.getAddress();
      const key = splitKey(address);
      let journal = JSON.parse(storage.getItem(key) || 'null');
      if (journal && !resume) throw new Error('A split contribution is unfinished. Use Resume split; confirmed legs will not be sent again');
      if (resume && !journal) throw new Error('No unfinished split for this wallet');
      if (!journal) {
        if (!Array.isArray(plan) || !plan.length || new Set(plan.map(leg => leg.slug)).size !== plan.length) throw new Error('Invalid split plan');
        for (const leg of plan) {
          contributionJournalKey(address, leg.slug);
          contributionUnits(contributionAmount(leg.amountUnits));
        }
        journal = { address, legs: plan.map(leg => ({ ...leg, status: 'pending', txHash: '' })) };
        storage.setItem(key, JSON.stringify(journal));
      }
      if (!same(journal.address, address)) throw new Error('Split journal belongs to another wallet');
      if (Number((await signer.provider.getNetwork()).chainId) !== 8453) throw new Error('Switch your wallet to Base');
      onProgress(journal.legs);
      // Resolve an uncertain prior broadcast before allowing any new transaction.
      for (const leg of journal.legs) {
        const unresolved = storage.getItem(contributionJournalKey(address, leg.slug));
        if (unresolved) {
          await check({ signer, slug: leg.slug, planLeg: true, onConfirmed: txHash => {
            Object.assign(leg, { status: 'confirmed', txHash });
            storage.setItem(key, JSON.stringify(journal));
          } });
          storage.setItem(key, JSON.stringify(journal));
        }
      }
      onProgress(journal.legs);
      const remaining = journal.legs.filter(leg => leg.status !== 'confirmed');
      const total = remaining.reduce((sum, leg) => sum + BigInt(leg.amountUnits), 0n);
      if (await token.balanceOf(address) < total) throw new Error('Wallet has insufficient USDC for the remaining split');
      for (const leg of remaining) {
        const fund = await router.funds(ethers.id(leg.slug));
        if (!(fund.exists ?? fund[2]) || !(fund.active ?? fund[1])) throw new Error(`${leg.slug} is not active; no new split payments sent`);
      }
      for (const leg of remaining) {
        onStep(`Next: ${contributionAmount(leg.amountUnits)} USDC to ${leg.slug}. Separate wallet confirmations for each fund.`);
        const result = await contribute({ signer, router, token, slug: leg.slug,
          amount: contributionAmount(leg.amountUnits), onStep, planLeg: true, onConfirmed: txHash => {
            Object.assign(leg, { status: 'confirmed', txHash });
            storage.setItem(key, JSON.stringify(journal));
          } });
        Object.assign(leg, { status: 'confirmed', txHash: result.txHash });
        storage.setItem(key, JSON.stringify(journal));
        onProgress(journal.legs);
      }
      storage.removeItem(key);
      return journal.legs;
    } finally { planBusy = false; }
  }
  async function abandonSplit({ signer }) {
    if (busy || planBusy) throw new Error('A contribution is already in progress');
    const address = await signer.getAddress();
    const key = splitKey(address);
    const journal = JSON.parse(storage.getItem(key) || 'null');
    if (!journal) throw new Error('No unfinished split for this wallet');
    for (const leg of journal.legs) {
      if (storage.getItem(contributionJournalKey(address, leg.slug))) {
        throw new Error('A transaction is unresolved. Check its receipt before stopping the remaining split');
      }
    }
    storage.removeItem(key);
    return journal.legs;
  }
  return { contribute, check, contributeSplit, abandonSplit };
}

export function initFundContributions() {
  const form = document.getElementById('fund-contribution-form');
  if (!form || form.dataset.ready) return;
  form.dataset.ready = '1';
  const status = document.getElementById('fund-contribution-status');
  const setStatus = text => { status.textContent = text; };
  const slugInput = document.getElementById('fund-contribution-slug');
  const amountInput = document.getElementById('fund-contribution-amount');
  const splitInputs = document.getElementById('fund-contribution-splits');
  const preview = document.getElementById('fund-contribution-preview');
  const progress = document.getElementById('fund-contribution-progress');
  const funds = contributionFunds();
  slugInput.innerHTML = funds.map(fund => `<option value="${escapeHtml(fund.slug)}">${escapeHtml(fund.label)}</option>`).join('') +
    '<option value="__split__">✨ Custom split</option>';
  if (splitInputs) splitInputs.innerHTML = funds.map(fund => `<label>${escapeHtml(fund.label)}
    <span><input data-fund-split="${escapeHtml(fund.slug)}" type="text" inputmode="decimal" value="${['dbusk-playback', 'dbusk-top10'].includes(fund.slug) ? '50' : '0'}" aria-label="${escapeHtml(fund.label)} percentage"> %</span></label>`).join('');
  const planForForm = () => contributionPlan(amountInput.value, slugInput.value === '__split__'
    ? [...form.querySelectorAll('[data-fund-split]')].map(input => ({ slug: input.dataset.fundSplit, percent: input.value }))
    : [{ slug: slugInput.value, percent: '100' }]);
  const updatePreview = () => {
    if (splitInputs) splitInputs.hidden = slugInput.value !== '__split__';
    if (!preview) return;
    try {
      preview.textContent = planForForm().map(leg => `${funds.find(fund => fund.slug === leg.slug)?.label}: ${contributionAmount(leg.amountUnits)} USDC`).join(' · ');
    } catch (error) { preview.textContent = error.message; }
  };
  slugInput.addEventListener('change', updatePreview);
  form.addEventListener('input', updatePreview);
  updatePreview();
  const contributionDialog = document.getElementById('fund-contribution-dialog');
  document.getElementById('fund-us-button')?.addEventListener('click', () => {
    if (!contributionDialog.open) contributionDialog.showModal();
  });
  document.getElementById('fund-contribution-close')?.addEventListener('click', () => contributionDialog.close());
  contributionDialog?.addEventListener('click', event => { if (event.target === contributionDialog) contributionDialog.close(); });
  let controller;
  let working = false;
  const controls = [...form.querySelectorAll('input, select, button')];
  const showProgress = legs => {
    if (progress) progress.innerHTML = legs.map(leg => `<li>${escapeHtml(funds.find(fund => fund.slug === leg.slug)?.label || leg.slug)} · ${escapeHtml(contributionAmount(leg.amountUnits))} USDC · ${leg.status === 'confirmed'
      ? `<a href="https://basescan.org/tx/${escapeHtml(leg.txHash)}" target="_blank" rel="noopener">Confirmed ↗</a>` : 'Not yet confirmed'}</li>`).join('');
    if (legs.some(leg => leg.status === 'confirmed')) document.dispatchEvent(new CustomEvent('fund-contribution-confirmed'));
  };
  const wallet = async () => {
    if (!window.ethereum) throw new Error('Install or open an Ethereum wallet such as MetaMask to contribute');
    if (!window._wallet?.signer) await window._wallet?.connect?.();
    if (!window._wallet?.signer) throw new Error('Connect your wallet before contributing');
    const provider = new window.ethers.BrowserProvider(window.ethereum, 'any');
    await ensureBaseNetwork(provider);
    return provider.getSigner();
  };
  const run = async action => {
    if (working) return;
    working = true;
    controls.forEach(control => { control.disabled = true; });
    try {
      if (!window.ethers) throw new Error('Wallet library is not ready. Refresh and try again');
      controller ||= createContributionController({ storage: window.localStorage, ethers: window.ethers });
      await action();
    } catch (error) {
      console.warn('[fund-contribution]', error);
      setStatus(`${error.shortMessage || error.message}. Check any unresolved receipt before retrying.`);
    } finally {
      working = false;
      controls.forEach(control => { control.disabled = false; });
    }
  };
  for (const button of form.querySelectorAll('[data-contribution-amount]')) button.addEventListener('click', () => {
    amountInput.value = button.dataset.contributionAmount;
    updatePreview();
    amountInput.focus();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const slug = slugInput.value;
    const amount = amountInput.value;
    run(async () => {
      contributionUnits(amount);
      if (slug === '__split__') {
        const plan = planForForm();
        if (!window.confirm(`Split ${amount} USDC on Base?\n${plan.map(leg => `${leg.slug}: ${contributionAmount(leg.amountUnits)} USDC`).join('\n')}\nEach fund needs a separate transaction. Confirmed payments remain sent if you cancel a later leg.`)) return;
        const signer = await wallet();
        const router = new window.ethers.Contract(SETTLEMENT_ROUTER_ADDRESS, ROUTER_ABI, signer);
        const token = new window.ethers.Contract(BASE_USDC_ADDRESS, TOKEN_ABI, signer);
        showProgress(plan);
        await controller.contributeSplit({ signer, router, token, plan, onStep: setStatus, onProgress: showProgress });
        setStatus('All split contributions confirmed. Thank you!');
        document.dispatchEvent(new CustomEvent('fund-contribution-confirmed'));
        return;
      }
      if (!allowedFund(slug)) throw new Error('Select a configured fund');
      if (!window.confirm(`Add ${amount} USDC to ${slug} on Base? This is a fund contribution, not an ad purchase or a refundable deposit. MetaMask may request an exact USDC approval and then the contribution. Base ETH is needed for gas.`)) return;
      setStatus('Connect your wallet and confirm Base. No payment has been sent.');
      const signer = await wallet();
      const router = new window.ethers.Contract(SETTLEMENT_ROUTER_ADDRESS, ROUTER_ABI, signer);
      const token = new window.ethers.Contract(BASE_USDC_ADDRESS, TOKEN_ABI, signer);
      setStatus(approvalNotice(amount));
      const result = await controller.contribute({ signer, router, token, slug, amount, onStep: setStatus });
      setStatus('Contribution confirmed. Thank you for supporting the artists! ');
      const link = document.createElement('a');
      link.href = `https://basescan.org/tx/${result.txHash}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'View transaction proof';
      status.append(link);
      document.dispatchEvent(new CustomEvent('fund-contribution-confirmed'));
    });
  });
  document.getElementById('fund-contribution-resume')?.addEventListener('click', () => run(async () => {
    const signer = await wallet();
    const router = new window.ethers.Contract(SETTLEMENT_ROUTER_ADDRESS, ROUTER_ABI, signer);
    const token = new window.ethers.Contract(BASE_USDC_ADDRESS, TOKEN_ABI, signer);
    if (!window.confirm('Resume the saved split on Base? Confirmed legs will not be sent again. Each remaining fund needs a separate transaction.')) return;
    await controller.contributeSplit({ signer, router, token, resume: true, onStep: setStatus, onProgress: showProgress });
    setStatus('All saved split contributions confirmed. Thank you!');
    document.dispatchEvent(new CustomEvent('fund-contribution-confirmed'));
  }));
  document.getElementById('fund-contribution-stop')?.addEventListener('click', () => run(async () => {
    if (!window.confirm('Stop only the unsent parts of the saved split? Confirmed contributions stay sent and are not refunded.')) return;
    const legs = await controller.abandonSplit({ signer: await wallet() });
    showProgress(legs);
    setStatus('Remaining split stopped. Confirmed contributions stay sent; their proofs are listed below.');
  }));
  document.getElementById('fund-contribution-check').addEventListener('click', () => run(async () => {
    if (slugInput.value === '__split__') throw new Error('Use Resume split to check saved receipts and continue unfinished legs');
    setStatus('Checking the recorded transaction on Base...');
    const result = await controller.check({ signer: await wallet(), slug: slugInput.value });
    setStatus(result.stage === 'deposit' ? 'Contribution confirmed on Base. Thank you!'
      : result.stage === 'approval' ? 'USDC approval confirmed; no contribution was sent. You can now submit the contribution.'
      : 'Recorded transaction reverted. No contribution was confirmed by that transaction. Review before retrying.');
    if (result.stage === 'deposit') document.dispatchEvent(new CustomEvent('fund-contribution-confirmed'));
  }));
}
