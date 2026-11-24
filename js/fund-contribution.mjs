import { ensureBaseNetwork, getBaseReadProvider } from './base-chain.mjs?v=20261018-shared-provider';
import { BASE_USDC_ADDRESS, configuredSettlementFunds, depositSettlementUsdc, isSettlementFundSlug } from './settlement-funds.mjs?v=20261124-fund-bunny';
import { escapeHtml } from './fund-display.mjs?v=20261124-lazy-funds';
import { formatUsdcUnits } from './usdc-format.mjs?v=20261017-mercury-release';
import { REFERRALS_FUND, CAMPAIGN_ASSETS } from './promotions.mjs?v=20261126-eth-gifts';
import { renderFundBalanceChart } from './fund-visual.mjs?v=20261124-fund-bunny';
import { discoverAdditionalFunds } from './fund-discovery.mjs?v=20261124-fund-bunny';
import { initFundGuide } from './fund-guide.mjs?v=20261124-fund-bunny';

const DEFAULT_FUNDS = { radioFunds: { playback: 'dbusk-playback', topTen: 'dbusk-top10' },
  fundSlug: 'dbusk-repo-dev', pinnerFundSlug: 'dbusk-pinners',
  liveFundSlug: 'dbusk-live-performers', promotionFundSlug: 'dbusk-promotionals' };
export function contributionFunds(config = globalThis.window?.DecentConfig || DEFAULT_FUNDS) {
  return [...configuredSettlementFunds({ ...DEFAULT_FUNDS, ...config,
    radioFunds: { ...DEFAULT_FUNDS.radioFunds, ...config.radioFunds } }),
  { slug: REFERRALS_FUND, label: 'Referrals' }];
}
export const SETTLEMENT_ROUTER_ADDRESS = '0x8ecca903e2a6Daa8CCbB933700e4F2C58C44A4B5';
const ROUTER_ABI = [
  'function paused() view returns(bool)',
  'function funds(bytes32) view returns(string metadataUri,bool active,bool exists)',
  'function allFundIds() view returns(bytes32[])',
  'function fundBalances(bytes32,address) view returns(uint256)',
  'function approvedAssets(address) view returns(bool)',
  'function fundToken(bytes32,address,uint256)',
  'function fundNative(bytes32) payable',
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

export async function loadContributionFunds({ ethers = globalThis.window?.ethers, router, config, readMetadata,
  onUpdate = () => {}, onWarning } = {}) {
  if (!ethers) throw new Error('Fund reader is not ready. Refresh and try again');
  router ||= new ethers.Contract(SETTLEMENT_ROUTER_ADDRESS, ROUTER_ABI, getBaseReadProvider({ ethers }));
  const ids = await router.allFundIds();
  const records = await Promise.all(ids.map(async fundId => {
    const record = await router.funds(fundId);
    return { fundId, metadataUri: record.metadataUri, exists: record.exists, active: record.active };
  }));
  const byId = new Map(records.map(record => [record.fundId, record]));
  const candidates = contributionFunds(config);
  const withBalance = async fund => {
    const id = ethers.id(fund.slug);
    const record = byId.get(id);
    if (!record?.exists || !record.active) return null;
    const [balance, nativeBalance] = await Promise.all([
      router.fundBalances(id, BASE_USDC_ADDRESS),
      acceptsEth(fund.slug) ? router.fundBalances(id, CAMPAIGN_ASSETS.eth.address) : 0n,
    ]);
    return { ...fund, balanceUnits: balance.toString(), nativeBalanceUnits: nativeBalance.toString() };
  };
  const funds = (await Promise.all(candidates.map(withBalance))).filter(Boolean);
  onUpdate(funds);
  const additional = await discoverAdditionalFunds({ records, knownIds: new Set(candidates.map(fund => ethers.id(fund.slug))),
    routerAddress: SETTLEMENT_ROUTER_ADDRESS, ethers, readMetadata, onWarning });
  return [...funds, ...await Promise.all(additional.map(withBalance))].filter(Boolean);
}

let openContributions;
export function openFundContributions() {
  initFundContributions();
  if (!openContributions) throw new Error('Fund Us is not available. Refresh and try again');
  openContributions();
}

function contributionAsset(asset) {
  if (!Object.hasOwn(CAMPAIGN_ASSETS, asset)) throw new Error('Choose USDC or ETH');
  return CAMPAIGN_ASSETS[asset];
}

export function acceptsEth(slug) {
  const config = globalThis.window?.DecentConfig || DEFAULT_FUNDS;
  return isSettlementFundSlug(slug) && ![config.radioFunds?.playback || DEFAULT_FUNDS.radioFunds.playback,
    config.radioFunds?.topTen || DEFAULT_FUNDS.radioFunds.topTen].includes(slug);
}

export function contributionUnits(value, asset = 'usdc') {
  const { decimals, symbol } = contributionAsset(asset);
  if (!new RegExp(`^(?:0|[1-9]\\d{0,9})(?:\\.\\d{1,${decimals}})?$`).test(String(value))) {
    throw new Error(`Enter a positive ${symbol} amount with at most ${decimals} decimal places`);
  }
  const [whole, fraction = ''] = String(value).split('.');
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'));
  if (units <= 0n) throw new Error(`Enter a positive ${symbol} amount`);
  return units;
}

export function contributionJournalKey(address, slug, asset = 'usdc') {
  contributionAsset(asset);
  if (!/^0x[0-9a-f]{40}$/i.test(address || '') || !isSettlementFundSlug(slug)) throw new Error('Invalid contribution wallet or fund');
  if (asset === 'eth' && !acceptsEth(slug)) throw new Error('Top10 and Playback accept USDC only');
  return `decentbusking:fund-contribution:8453:${SETTLEMENT_ROUTER_ADDRESS.toLowerCase()}:${address.toLowerCase()}:${slug}${asset === 'eth' ? ':eth' : ''}`;
}

export function contributionAmount(units, asset = 'usdc') {
  const { decimals } = contributionAsset(asset);
  const scale = 10n ** BigInt(decimals);
  const value = BigInt(units);
  const fraction = String(value % scale).padStart(decimals, '0').replace(/0+$/, '');
  return `${value / scale}${fraction ? `.${fraction}` : ''}`;
}

export function contributionPlan(amount, shares, { asset = 'usdc', mode = 'percent' } = {}) {
  const total = contributionUnits(amount, asset);
  if (!['percent', 'amount'].includes(mode)) throw new Error('Choose percentage or amount splits');
  if (!Array.isArray(shares) || !shares.length) throw new Error('Choose at least one fund');
  const seen = new Set();
  let totalBps = 0;
  const legs = shares.map(({ slug, percent, amount: legAmount }) => {
    if (!isSettlementFundSlug(slug) || seen.has(slug)) throw new Error('Select each valid fund at most once');
    if (asset === 'eth' && !acceptsEth(slug)) throw new Error('Top10 and Playback accept USDC only');
    seen.add(slug);
    if (mode === 'amount') return { slug, amountUnits: /^0(?:\.0+)?$/.test(String(legAmount)) ? 0n : contributionUnits(legAmount, asset) };
    if (!/^(?:0|[1-9]\d?|100)(?:\.\d{1,2})?$/.test(String(percent))) throw new Error('Use percentages with at most two decimal places');
    const [whole, fraction = ''] = String(percent).split('.');
    const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    totalBps += bps;
    return { slug, bps };
  }).filter(leg => mode === 'amount' ? leg.amountUnits > 0n : leg.bps > 0);
  if (mode === 'amount') {
    if (legs.reduce((sum, leg) => sum + leg.amountUnits, 0n) !== total) throw new Error(`${contributionAsset(asset).symbol} amounts must match its total exactly`);
    return legs.map(leg => ({ slug: leg.slug, asset, amountUnits: leg.amountUnits.toString() }));
  }
  if (totalBps !== 10000) throw new Error('Fund percentages must total exactly 100%');
  let remaining = total;
  return legs.map((leg, index) => {
    const units = index === legs.length - 1 ? remaining : total * BigInt(leg.bps) / 10000n;
    if (units <= 0n) throw new Error(`Increase the amount or adjust the split; every selected fund needs at least ${contributionAmount(1n, asset)} ${contributionAsset(asset).symbol}`);
    remaining -= units;
    return { slug: leg.slug, asset, amountUnits: units.toString() };
  });
}

export function verifyContributionReceipt({ receipt, operation, ethers }) {
  if (!receipt || receipt.status !== 1) throw new Error('Contribution is not confirmed successfully');
  const iface = new ethers.Interface([...ROUTER_ABI, ...TOKEN_ABI]);
  const amount = BigInt(operation.amountUnits);
  const asset = contributionAsset(operation.asset || 'usdc');
  let funded = false;
  let transferred = false;
  let approved = false;
  for (const log of receipt.logs) {
    if (!same(log.address, SETTLEMENT_ROUTER_ADDRESS) && !same(log.address, BASE_USDC_ADDRESS)) continue;
    let event;
    try { event = iface.parseLog(log); } catch { continue; }
    if (same(log.address, SETTLEMENT_ROUTER_ADDRESS) && event?.name === 'FundFunded' &&
        event.args.fundId === ethers.id(operation.slug) && same(event.args.asset, asset.address) &&
        same(event.args.funder, operation.address) && event.args.amount === amount) funded = true;
    if (same(log.address, BASE_USDC_ADDRESS) && event?.name === 'Transfer' &&
        same(event.args.from, operation.address) && same(event.args.to, SETTLEMENT_ROUTER_ADDRESS) &&
        event.args.value === amount) transferred = true;
    if (same(log.address, BASE_USDC_ADDRESS) && event?.name === 'Approval' &&
        same(event.args.owner, operation.address) && same(event.args.spender, SETTLEMENT_ROUTER_ADDRESS) &&
        event.args.value === amount) approved = true;
  }
  if (operation.stage === 'deposit' && funded && (asset.id === 'eth' || transferred)) return 'deposit';
  if (operation.stage === 'approval' && asset.id === 'usdc' && approved) return 'approval';
  throw new Error('Receipt does not prove the recorded contribution stage, fund, sender and exact amount');
}

async function depositContributionEth({ signer, router, fundId, amountUnits, onStage, onBroadcast, onStep }) {
  if (Number((await signer.provider.getNetwork()).chainId) !== 8453) throw new Error('ETH contributions are Base-only');
  if (!same(router.target, SETTLEMENT_ROUTER_ADDRESS) || await signer.provider.getCode(router.target) === '0x') throw new Error('Settlement router is not deployed');
  if (await router.paused()) throw new Error('The settlement router is paused');
  const fund = await router.funds(fundId);
  if (!fund.exists || !fund.active) throw new Error('Selected fund is not active');
  if (!await router.approvedAssets(CAMPAIGN_ASSETS.eth.address)) throw new Error('ETH is not approved on the router');
  await router.fundNative.staticCall(fundId, { value: amountUnits });
  onStep('Confirm the ETH contribution. Keep additional Base ETH for network gas.');
  onStage('deposit');
  const tx = await router.fundNative(fundId, { value: amountUnits });
  onBroadcast({ stage: 'deposit', txHash: tx.hash });
  if ((await tx.wait())?.status !== 1) throw new Error('ETH contribution did not confirm; check its receipt');
  return { txHash: tx.hash };
}

export function createContributionController({ storage, ethers, deposit = depositSettlementUsdc, depositEth = depositContributionEth }) {
  let busy = false;
  let planBusy = false;
  async function contribute({ signer, router, token, slug, amount, asset = 'usdc', onStep = () => {}, planLeg = false, onConfirmed = () => {} }) {
    if (busy || planBusy && !planLeg) throw new Error('A contribution is already in progress');
    busy = true;
    try {
      const address = await signer.getAddress();
      if (!planLeg && storage.getItem(splitKey(address))) throw new Error('An unfinished split exists. Use Resume split before starting another contribution');
      const key = contributionJournalKey(address, slug, asset);
      if (storage.getItem(key)) throw new Error('An earlier contribution is unresolved. Check its receipt before sending again');
      const amountUnits = contributionUnits(amount, asset);
      let operation;
      const result = await (asset === 'eth' ? depositEth : deposit)({ signer, router, token, owner: address, fundId: ethers.id(slug), amountUnits, onStep,
        onStage: stage => {
          operation = { address, slug, asset, amountUnits: amountUnits.toString(), stage, txHash: null };
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
  async function check({ signer, slug, asset = 'usdc', planLeg = false, onConfirmed = () => {} }) {
    if (busy || planBusy && !planLeg) throw new Error('A contribution is already in progress');
    busy = true;
    try {
      if (Number((await signer.provider.getNetwork()).chainId) !== 8453) throw new Error('Switch your wallet to Base');
      const key = contributionJournalKey(await signer.getAddress(), slug, asset);
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
          const leg = journal.legs.find(item => item.slug === slug && (item.asset || 'usdc') === asset && item.amountUnits === operation.amountUnits);
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
        if (!Array.isArray(plan) || !plan.length || new Set(plan.map(leg => `${leg.slug}:${leg.asset || 'usdc'}`)).size !== plan.length) throw new Error('Invalid split plan');
        for (const leg of plan) {
          contributionJournalKey(address, leg.slug, leg.asset || 'usdc');
          contributionUnits(contributionAmount(leg.amountUnits, leg.asset || 'usdc'), leg.asset || 'usdc');
        }
        journal = { address, legs: plan.map(leg => ({ ...leg, status: 'pending', txHash: '' })) };
        storage.setItem(key, JSON.stringify(journal));
      }
      if (!same(journal.address, address)) throw new Error('Split journal belongs to another wallet');
      if (Number((await signer.provider.getNetwork()).chainId) !== 8453) throw new Error('Switch your wallet to Base');
      onProgress(journal.legs);
      // Resolve an uncertain prior broadcast before allowing any new transaction.
      for (const leg of journal.legs) {
        const unresolved = storage.getItem(contributionJournalKey(address, leg.slug, leg.asset || 'usdc'));
        if (unresolved) {
          await check({ signer, slug: leg.slug, asset: leg.asset || 'usdc', planLeg: true, onConfirmed: txHash => {
            Object.assign(leg, { status: 'confirmed', txHash });
            storage.setItem(key, JSON.stringify(journal));
          } });
          storage.setItem(key, JSON.stringify(journal));
        }
      }
      onProgress(journal.legs);
      const remaining = journal.legs.filter(leg => leg.status !== 'confirmed');
      const usdcLegs = remaining.filter(leg => !leg.asset || leg.asset === 'usdc');
      const total = usdcLegs.reduce((sum, leg) => sum + BigInt(leg.amountUnits), 0n);
      const nativeTotal = remaining.filter(leg => leg.asset === 'eth').reduce((sum, leg) => sum + BigInt(leg.amountUnits), 0n);
      if (!same(router.target, SETTLEMENT_ROUTER_ADDRESS) || await signer.provider.getCode(router.target) === '0x') throw new Error('Settlement router is not deployed');
      if (await router.paused()) throw new Error('The settlement router is paused');
      if (total && (!same(token.target, BASE_USDC_ADDRESS) || Number(await token.decimals()) !== 6 ||
          !await router.approvedAssets(BASE_USDC_ADDRESS))) throw new Error('Native Base USDC is not approved on the router');
      if (nativeTotal && !await router.approvedAssets(CAMPAIGN_ASSETS.eth.address)) throw new Error('ETH is not approved on the router');
      if (total && await token.balanceOf(address) < total) throw new Error('Wallet has insufficient USDC for the remaining split');
      if (nativeTotal && await signer.provider.getBalance(address) <= nativeTotal) throw new Error('Keep enough Base ETH for the contributions and network gas');
      for (const leg of remaining) {
        const fund = await router.funds(ethers.id(leg.slug));
        if (!(fund.exists ?? fund[2]) || !(fund.active ?? fund[1])) throw new Error(`${leg.slug} is not active; no new split payments sent`);
      }
      if (total && await token.allowance(address, SETTLEMENT_ROUTER_ADDRESS) < total) {
        const operation = { address, slug: usdcLegs[0].slug, asset: 'usdc', amountUnits: total.toString(), stage: 'approval', txHash: null };
        const approvalKey = contributionJournalKey(address, operation.slug);
        onStep(`Approve exactly ${contributionAmount(total)} USDC once for the remaining series.`);
        storage.setItem(approvalKey, JSON.stringify(operation));
        try {
          const tx = await token.approve(SETTLEMENT_ROUTER_ADDRESS, total);
          operation.txHash = tx.hash;
          storage.setItem(approvalKey, JSON.stringify(operation));
          verifyContributionReceipt({ receipt: await tx.wait(), operation, ethers });
          storage.removeItem(approvalKey);
        } catch (error) {
          if (!operation.txHash && (error.code === 4001 || error.code === 'ACTION_REJECTED')) storage.removeItem(approvalKey);
          throw error;
        }
      }
      for (const leg of remaining) {
        const asset = leg.asset || 'usdc';
        onStep(`Next: ${contributionAmount(leg.amountUnits, asset)} ${contributionAsset(asset).symbol} to ${leg.slug}.`);
        const result = await contribute({ signer, router, token, slug: leg.slug,
          asset, amount: contributionAmount(leg.amountUnits, asset), onStep, planLeg: true, onConfirmed: txHash => {
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
      if (storage.getItem(contributionJournalKey(address, leg.slug, leg.asset || 'usdc'))) {
        throw new Error('A transaction is unresolved. Check its receipt before stopping the remaining split');
      }
    }
    storage.removeItem(key);
    return journal.legs;
  }
  function recovery(address) {
    if (!/^0x[0-9a-f]{40}$/i.test(address || '')) throw new Error('Connect your wallet to view its saved contribution receipts');
    const split = JSON.parse(storage.getItem(splitKey(address)) || 'null');
    const candidates = [...new Set([...contributionFunds().map(fund => fund.slug), ...(split?.legs || []).map(leg => leg.slug)])];
    const operations = candidates.flatMap(slug => ['usdc', ...(acceptsEth(slug) ? ['eth'] : [])].flatMap(asset => {
      const operation = JSON.parse(storage.getItem(contributionJournalKey(address, slug, asset)) || 'null');
      return operation ? [{ ...operation, asset }] : [];
    }));
    return { split, operations };
  }
  return { contribute, check, contributeSplit, abandonSplit, recovery };
}

export function initFundContributions({ loadFunds = loadContributionFunds } = {}) {
  const form = document.getElementById('fund-contribution-form');
  if (!form || form.dataset.ready) return;
  form.dataset.ready = '1';
  const status = document.getElementById('fund-contribution-status');
  const setStatus = text => { status.textContent = text; };
  const slugInput = document.getElementById('fund-contribution-slug');
  const amountInput = document.getElementById('fund-contribution-amount');
  const nativeInput = document.getElementById('fund-contribution-eth');
  const nativeLabel = document.getElementById('fund-contribution-eth-label');
  const modeInput = document.getElementById('fund-contribution-mode');
  const splitInputs = document.getElementById('fund-contribution-splits');
  const preview = document.getElementById('fund-contribution-preview');
  const progress = document.getElementById('fund-contribution-progress');
  const submit = form.querySelector('button[type="submit"]');
  const retry = document.getElementById('fund-contribution-retry');
  const balancesNote = document.getElementById('fund-contribution-balances');
  const receiptPanel = document.getElementById('fund-contribution-receipt');
  const confirmButton = document.getElementById('fund-contribution-confirm');
  let reviewedPlan, chartAsset = 'usdc', chartView = 'bars';
  let funds = [], loadedAt = 0, pending, working = false, verified = false;
  const renderChart = () => {
    const chart = document.getElementById('fund-balance-chart');
    if (!verified) { chart.textContent = 'Verified balances will appear here.'; return; }
    chart.innerHTML = renderFundBalanceChart(funds.filter(fund => chartAsset === 'usdc' || acceptsEth(fund.slug)).map(fund => {
      const units = chartAsset === 'usdc' ? fund.balanceUnits : fund.nativeBalanceUnits;
      return { slug: fund.slug, label: fund.label, units, amountText: chartAsset === 'usdc'
        ? `$${formatUsdcUnits(units)} USDC` : `${contributionAmount(units, 'eth')} ETH` };
    }), chartView);
  };
  for (const button of document.querySelectorAll('[data-fund-chart-asset]')) button.addEventListener('click', () => {
    chartAsset = button.dataset.fundChartAsset;
    for (const control of document.querySelectorAll('[data-fund-chart-asset]')) control.setAttribute('aria-pressed', String(control === button));
    renderChart();
  });
  document.getElementById('fund-chart-toggle').addEventListener('click', event => {
    chartView = chartView === 'bars' ? 'pie' : 'bars';
    event.currentTarget.textContent = chartView === 'bars' ? '◉ Pie view' : '▥ Bar view';
    event.currentTarget.setAttribute('aria-label', chartView === 'bars' ? 'Show pie chart' : 'Show bar chart');
    renderChart();
  });
  document.getElementById('fund-contribution-info-button').addEventListener('click', event => {
    const info = document.getElementById('fund-contribution-info');
    info.hidden = !info.hidden;
    event.currentTarget.setAttribute('aria-expanded', String(!info.hidden));
  });
  const showReceipt = () => {
    receiptPanel.hidden = false;
    document.getElementById('fund-contribution-dialog').classList.add('fund-receipt-open');
    receiptPanel.focus();
  };
  document.getElementById('fund-receipts-close').addEventListener('click', () => {
    receiptPanel.hidden = true;
    document.getElementById('fund-contribution-dialog').classList.remove('fund-receipt-open');
    submit.focus();
  });
  const available = slug => funds.some(fund => fund.slug === slug);
  const updateAvailability = () => {
    slugInput.disabled = working || !verified || !funds.length;
    submit.disabled = working || !verified || !(available(slugInput.value) || slugInput.value === '__split__');
    form.querySelectorAll('[data-fund-split]').forEach(input => { input.disabled = working || !verified; });
  };
  slugInput.innerHTML = '<option value="">Open Fund Us to check available funds</option>';
  updateAvailability();
  const planForForm = () => {
    if (!verified) throw new Error('Wait for fund verification before contributing');
    const split = slugInput.value === '__split__';
    const plan = ['usdc', 'eth'].flatMap(asset => {
      const total = asset === 'usdc' ? amountInput.value : nativeInput.value;
      if (/^0(?:\.0+)?$/.test(total)) return [];
      if (!split && !available(slugInput.value)) throw new Error('Select an active fund');
      const mode = split ? modeInput.value : 'percent';
      const shares = split
        ? [...form.querySelectorAll(`[data-fund-split][data-asset="${asset}"]`)]
          .map(input => ({ slug: input.dataset.fundSplit, percent: input.value, amount: input.value }))
        : [{ slug: slugInput.value, percent: '100' }];
      if (shares.some(share => !available(share.slug))) throw new Error('Select an active fund');
      return contributionPlan(total, shares, { asset, mode });
    });
    if (!plan.length) throw new Error('Enter a positive USDC or ETH total');
    return plan;
  };
  const updatePreview = () => {
    if (splitInputs) splitInputs.hidden = slugInput.value !== '__split__';
    modeInput.parentElement.hidden = slugInput.value !== '__split__';
    const nativeAllowed = slugInput.value === '__split__' || acceptsEth(slugInput.value);
    nativeLabel.hidden = !nativeAllowed;
    if (!nativeAllowed) nativeInput.value = '0';
    if (!preview) return;
    try {
      preview.textContent = planForForm().map(leg => `${funds.find(fund => fund.slug === leg.slug)?.label}: ${contributionAmount(leg.amountUnits, leg.asset)} ${contributionAsset(leg.asset).symbol}`).join(' · ');
    } catch (error) { preview.textContent = error.message; }
  };
  const renderSplits = (values = new Map()) => {
    if (!splitInputs) return;
    const percent = modeInput.value === 'percent';
    splitInputs.innerHTML = funds.map(fund => `<div class="fund-contribution-split-row"><strong>${escapeHtml(fund.label)}</strong>
      <small>$${formatUsdcUnits(fund.balanceUnits)} USDC${acceptsEth(fund.slug) ? ` · ${contributionAmount(fund.nativeBalanceUnits, 'eth')} ETH` : ' · USDC only'}</small>
      <div>${['usdc', ...(acceptsEth(fund.slug) ? ['eth'] : [])].map(asset => {
        const key = `${fund.slug}:${asset}`;
        const initial = percent && asset === 'usdc' && ['dbusk-playback', 'dbusk-top10'].includes(fund.slug) ? '50' : '0';
        return `<label>${contributionAsset(asset).symbol}${percent ? ' %' : ''}<input data-fund-split="${escapeHtml(fund.slug)}" data-asset="${asset}" type="text" inputmode="decimal" value="${escapeHtml(values.get(key) ?? initial)}" aria-label="${escapeHtml(fund.label)} ${contributionAsset(asset).symbol} ${percent ? 'percentage' : 'amount'}"></label>`;
      }).join('')}</div></div>`).join('');
  };
  const invalidateReview = () => {
    if (!reviewedPlan) return;
    reviewedPlan = null;
    confirmButton.hidden = true;
    setStatus('Your inputs changed. Review the updated contribution before confirming.');
  };
  modeInput.addEventListener('change', () => { renderSplits(); updatePreview(); updateAvailability(); });
  slugInput.addEventListener('change', () => { invalidateReview(); updateAvailability(); updatePreview(); });
  form.addEventListener('input', updatePreview);
  for (const event of ['input', 'change']) form.addEventListener(event, invalidateReview);
  updatePreview();
  const contributionDialog = document.getElementById('fund-contribution-dialog');
  let guideAsset;
  initFundGuide({ dialog: contributionDialog, getFunds: () => funds,
    onStart: () => {
      guideAsset = chartAsset;
      document.querySelector('[data-fund-chart-asset="usdc"]').click();
    },
    onStop: () => document.querySelector(`[data-fund-chart-asset="${guideAsset}"]`).click(),
  });
  const applyFunds = next => {
    const selected = slugInput.dataset.preferredFund || slugInput.value;
    delete slugInput.dataset.preferredFund;
    const percentages = new Map([...form.querySelectorAll('[data-fund-split]')].map(input => [`${input.dataset.fundSplit}:${input.dataset.asset}`, input.value]));
    funds = next;
    slugInput.innerHTML = '<option value="">Choose a fund</option>' +
      funds.map(fund => `<option value="${escapeHtml(fund.slug)}">${escapeHtml(fund.label)} — $${formatUsdcUnits(fund.balanceUnits)} USDC${acceptsEth(fund.slug) ? ` · ${contributionAmount(fund.nativeBalanceUnits, 'eth')} ETH` : ''}</option>`).join('') +
      (funds.length ? '<option value="__split__">✨ Custom split</option>' : '');
    slugInput.value = available(selected) || selected === '__split__' && funds.length ? selected : '';
    renderSplits(percentages);
    loadedAt = Date.now();
    verified = true;
    renderChart();
    document.getElementById('fund-guide-launch').disabled = working || !funds.length;
    balancesNote.textContent = funds.length ? 'Current on-chain balances · checked just now. Top10 and Playback accept USDC only.'
      : 'No active contribution funds are available right now.';
    updatePreview();
    updateAvailability();
  };
  const refreshFunds = () => {
    if (pending) return pending;
    if (verified && Date.now() - loadedAt < 15000) return Promise.resolve();
    verified = false;
    document.getElementById('fund-guide-launch').disabled = true;
    updateAvailability();
    balancesNote.textContent = 'Checking active funds and balances on Base…';
    retry.hidden = true;
    const warnings = new Set();
    pending = loadFunds({ onUpdate: applyFunds, onWarning: message => {
      console.warn('[fund-discovery]', message);
      warnings.add(message);
    } }).then(next => {
      applyFunds(next);
      if (warnings.size) {
        balancesNote.textContent += ` ${[...warnings].join(' ')}`;
        retry.hidden = false;
      }
    }).catch(error => {
      console.warn('[fund-contribution] Fund verification failed:', error);
      verified = false;
      loadedAt = 0;
      funds = [];
      invalidateReview();
      slugInput.innerHTML = '<option value="">Funds could not be verified</option>';
      if (splitInputs) splitInputs.replaceChildren();
      balancesNote.textContent = `Unable to verify fund balances: ${error.message}. No contribution can be sent until verification succeeds.`;
      retry.hidden = false;
      document.getElementById('fund-guide-launch').disabled = true;
      renderChart();
      updatePreview();
    }).finally(() => { pending = null; updateAvailability(); });
    return pending;
  };
  openContributions = () => {
    if (!contributionDialog.open) contributionDialog.showModal();
    const preferred = slugInput.dataset.preferredFund;
    if (verified && available(preferred)) {
      slugInput.value = preferred;
      delete slugInput.dataset.preferredFund;
      updateAvailability();
      updatePreview();
    }
    refreshFunds();
    updateRecovery();
  };
  document.getElementById('fund-us-button')?.addEventListener('click', openContributions);
  retry.addEventListener('click', () => { loadedAt = 0; refreshFunds(); });
  document.addEventListener('settlement-fund-created', event => {
    if (!same(event.detail?.routerAddress, SETTLEMENT_ROUTER_ADDRESS)) return;
    const refresh = () => {
      loadedAt = 0;
      if (contributionDialog.open) refreshFunds();
    };
    if (pending) pending.then(refresh);
    else refresh();
  });
  document.addEventListener('fund-contribution-confirmed', () => {
    loadedAt = 0;
    if (contributionDialog.open) refreshFunds();
  });
  document.getElementById('fund-contribution-close')?.addEventListener('click', () => contributionDialog.close());
  contributionDialog?.addEventListener('click', event => { if (event.target === contributionDialog) contributionDialog.close(); });
  let controller;
  const updateRecovery = () => {
    const address = window._wallet?.address;
    const recoveryPanel = document.getElementById('fund-contribution-recovery');
    document.getElementById('fund-recovery-connect').hidden = Boolean(address);
    recoveryPanel.hidden = true;
    for (const id of ['fund-contribution-check', 'fund-contribution-check-eth', 'fund-contribution-resume', 'fund-contribution-stop']) document.getElementById(id).hidden = true;
    if (!address || !window.ethers) return;
    try {
      controller ||= createContributionController({ storage: window.localStorage, ethers: window.ethers });
      const saved = controller.recovery(address);
      recoveryPanel.hidden = !saved.split && !saved.operations.length;
      document.getElementById('fund-contribution-resume').hidden = !saved.split;
      document.getElementById('fund-contribution-stop').hidden = !saved.split;
      for (const asset of ['usdc', 'eth']) document.getElementById(asset === 'eth' ? 'fund-contribution-check-eth' : 'fund-contribution-check').hidden =
        !saved.operations.some(operation => operation.asset === asset);
      if (saved.split) showProgress(saved.split.legs);
    } catch (error) {
      console.warn('[fund-contribution] Receipt recovery unavailable:', error);
      setStatus(`Saved receipt recovery failed: ${error.message}`);
      showReceipt();
    }
  };
  document.getElementById('fund-receipts-open').addEventListener('click', () => {
    showReceipt();
    updateRecovery();
    if (!window._wallet?.address) setStatus('Connect your wallet to see any unfinished contributions saved in this browser.');
  });
  const showProgress = legs => {
    if (progress) progress.innerHTML = legs.map(leg => `<li>${escapeHtml(funds.find(fund => fund.slug === leg.slug)?.label || leg.slug)} · ${escapeHtml(contributionAmount(leg.amountUnits, leg.asset || 'usdc'))} ${contributionAsset(leg.asset || 'usdc').symbol} · ${leg.status === 'confirmed'
      ? `<a href="https://basescan.org/tx/${escapeHtml(leg.txHash)}" target="_blank" rel="noopener">Confirmed ↗</a>` : 'Not sent'}</li>`).join('');
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
    contributionDialog.querySelectorAll('input, select, button').forEach(control => { control.disabled = true; });
    try {
      if (!window.ethers) throw new Error('Wallet library is not ready. Refresh and try again');
      controller ||= createContributionController({ storage: window.localStorage, ethers: window.ethers });
      await action();
    } catch (error) {
      console.warn('[fund-contribution]', error);
      setStatus(`${error.shortMessage || error.message}. Check any unresolved receipt before retrying.`);
    } finally {
      working = false;
      contributionDialog.querySelectorAll('input, select, button').forEach(control => { control.disabled = false; });
      updateAvailability();
      updateRecovery();
    }
  };
  for (const button of form.querySelectorAll('[data-contribution-amount]')) button.addEventListener('click', () => {
    amountInput.value = button.dataset.contributionAmount;
    invalidateReview();
    updatePreview();
    amountInput.focus();
  });
  document.getElementById('fund-recovery-connect').addEventListener('click', () => run(async () => {
    await wallet();
    setStatus('Connected. Saved receipt controls appear here when recovery is needed.');
  }));
  form.addEventListener('submit', event => {
    event.preventDefault();
    try {
      reviewedPlan = planForForm();
      confirmButton.hidden = false;
      showProgress(reviewedPlan);
      setStatus(`Review ${reviewedPlan.length} contribution transaction${reviewedPlan.length === 1 ? '' : 's'}, plus one USDC approval only if needed. No payment has been sent.`);
      showReceipt();
    } catch (error) {
      setStatus(error.message);
      confirmButton.hidden = true;
      showReceipt();
    }
  });
  confirmButton.addEventListener('click', () => run(async () => {
      if (!reviewedPlan) throw new Error('Review your contribution before confirming');
      const plan = reviewedPlan;
      reviewedPlan = null;
      confirmButton.hidden = true;
      const signer = await wallet();
      const router = new window.ethers.Contract(SETTLEMENT_ROUTER_ADDRESS, ROUTER_ABI, signer);
      const token = new window.ethers.Contract(BASE_USDC_ADDRESS, TOKEN_ABI, signer);
      await controller.contributeSplit({ signer, router, token, plan, onStep: setStatus, onProgress: showProgress });
      setStatus('All contributions confirmed. Thank you!');
      document.dispatchEvent(new CustomEvent('fund-contribution-confirmed'));
  }));
  document.getElementById('fund-contribution-resume')?.addEventListener('click', () => run(async () => {
    const signer = await wallet();
    const router = new window.ethers.Contract(SETTLEMENT_ROUTER_ADDRESS, ROUTER_ABI, signer);
    const token = new window.ethers.Contract(BASE_USDC_ADDRESS, TOKEN_ABI, signer);
    await controller.contributeSplit({ signer, router, token, resume: true, onStep: setStatus, onProgress: showProgress });
    setStatus('All saved split contributions confirmed. Thank you!');
    document.dispatchEvent(new CustomEvent('fund-contribution-confirmed'));
  }));
  document.getElementById('fund-contribution-stop')?.addEventListener('click', () => run(async () => {
    const legs = await controller.abandonSplit({ signer: await wallet() });
    showProgress(legs);
    setStatus('Remaining split stopped. Confirmed contributions stay sent; their proofs are listed below.');
  }));
  for (const asset of ['usdc', 'eth']) document.getElementById(asset === 'eth' ? 'fund-contribution-check-eth' : 'fund-contribution-check').addEventListener('click', () => run(async () => {
    setStatus('Checking the recorded transaction on Base...');
    const signer = await wallet();
    const operations = controller.recovery(await signer.getAddress()).operations.filter(operation => operation.asset === asset);
    if (!operations.length) throw new Error('No unresolved receipts for this currency');
    for (const operation of operations) {
      const result = await controller.check({ signer, slug: operation.slug, asset });
      setStatus(result.stage === 'deposit' ? 'Contribution confirmed on Base. Thank you!'
        : result.stage === 'approval' ? 'USDC approval confirmed; no contribution was sent by that approval.'
        : 'Recorded transaction reverted. No contribution was confirmed by that transaction.');
      if (result.stage === 'deposit') document.dispatchEvent(new CustomEvent('fund-contribution-confirmed'));
    }
  }));
}
