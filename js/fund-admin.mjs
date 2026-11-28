import { isAdminWallet } from './admin-access.mjs';
import { acceptsEth, contributionAmount, contributionJournalKey, contributionUnits, createContributionController,
  loadContributionFunds, SETTLEMENT_ROUTER_ADDRESS, verifyContributionReceipt } from './fund-contribution.mjs?v=20261124-admin-funds';
import { renderFundBalanceChart } from './fund-visual.mjs?v=20261124-fund-bunny';
import { REFERRALS_FUND, PINNER_CAMPAIGN_FUND } from './promotions.mjs?v=20261126-eth-gifts';
const CAMPAIGN_FUNDS = [{ slug: PINNER_CAMPAIGN_FUND, label: '📌 Pinner campaigns' }, { slug: REFERRALS_FUND, label: '🤝 Referrals' }];
export { SETTLEMENT_ROUTER_ADDRESS };

export const FUND_ADMIN_ABI = [
  'function allFundIds() view returns(bytes32[])',
  'function fundNative(bytes32) payable',
  'function setFundActive(bytes32,bool)',
  'event FundStatusUpdated(bytes32 indexed fundId,bool active)',
];
const NATIVE = '0x0000000000000000000000000000000000000000';
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export async function verifyFundAdmin({ router, signer, owner }) {
  const address = await signer.getAddress();
  if (!same(address, owner)) throw new Error('Connect the configured owner wallet');
  if (Number((await signer.provider.getNetwork()).chainId) !== 8453) throw new Error('Fund administration is Base-only');
  if (!same(router.target, SETTLEMENT_ROUTER_ADDRESS) || await signer.provider.getCode(router.target) === '0x') {
    throw new Error('The configured settlement router is not deployed');
  }
  if (!await router.hasRole(await router.DEFAULT_ADMIN_ROLE(), address)) throw new Error('DEFAULT_ADMIN_ROLE is required');
  return address;
}

export function verifyFundAdminReceipt({ receipt, router, operation, ethers }) {
  if (receipt?.status !== 1) throw new Error('A successful fund action receipt is required');
  for (const log of receipt.logs || []) {
    if (!same(log.address, SETTLEMENT_ROUTER_ADDRESS)) continue;
    let event;
    try { event = router.interface.parseLog(log); } catch { continue; }
    if (event?.args.fundId !== ethers.id(operation.slug)) continue;
    if (operation.kind === 'status' && event.name === 'FundStatusUpdated' && event.args.active === operation.active) return;
    if (operation.kind === 'recover' && event.name === 'FundRecovered' && same(event.args.asset, NATIVE) &&
        same(event.args.recipient, operation.address) && event.args.amount === BigInt(operation.amountUnits)) return;
  }
  throw new Error('Receipt does not prove this exact fund action; it remains locked');
}

export async function sendFundAdminAction({ router, signer, owner, operation, ethers, onStage = () => {}, onBroadcast = () => {} }) {
  await verifyFundAdmin({ router, signer, owner });
  if (!same(operation.address, owner)) throw new Error('Fund action belongs to a different owner');
  const fundId = ethers.id(operation.slug);
  const fund = await router.funds(fundId);
  if (!fund.exists) throw new Error('Selected fund does not exist');
  let tx;
  if (operation.kind === 'status') {
    if (typeof operation.active !== 'boolean') throw new Error('Choose archive or restore');
    if (fund.active === operation.active) throw new Error('Fund status already changed; refresh before retrying');
    await router.setFundActive.staticCall(fundId, operation.active);
    onStage();
    tx = await router.setFundActive(fundId, operation.active);
  } else if (operation.kind === 'recover') {
    const amount = BigInt(operation.amountUnits);
    if (amount <= 0n) throw new Error('Enter a positive ETH recovery amount');
    if (await router.fundBalances(fundId, NATIVE) < amount ||
        await signer.provider.getBalance(router.target) < amount) throw new Error('Recovery exceeds available ETH');
    await router.recoverFund.staticCall(fundId, NATIVE, owner, amount);
    onStage();
    tx = await router.recoverFund(fundId, NATIVE, owner, amount);
  } else throw new Error('Unsupported fund action');
  onBroadcast(tx.hash);
  verifyFundAdminReceipt({ receipt: await tx.wait(), router, operation, ethers });
  return tx.hash;
}

let confirmation;
export function confirmFundAction({ title, description }) {
  const dialog = document.getElementById('router-action-dialog');
  if (!dialog || confirmation) throw new Error('Another fund confirmation is open');
  dialog.querySelector('h3').textContent = title;
  dialog.querySelector('p').textContent = description;
  dialog.returnValue = '';
  confirmation = new Promise(resolve => dialog.addEventListener('close', () => {
    confirmation = null;
    resolve(dialog.returnValue === 'confirm');
  }, { once: true }));
  dialog.showModal();
  return confirmation;
}

export function mountFundAdmin({ context, selected, select, create, isBusy, setBusy, legacyPending, refreshSelected }) {
  const section = document.getElementById('settlement-router-section');
  const chart = document.getElementById('admin-fund-chart');
  const status = document.getElementById('admin-fund-status');
  const actionStatus = document.getElementById('admin-fund-action-status');
  const actionDialog = document.getElementById('router-action-dialog');
  let funds = [], loaded = false, asset = 'eth', view = 'bars', generation = 0, controller;
  const setStatus = (text, error = false) => { actionStatus.textContent = text; actionStatus.classList.toggle('error', error); };
  const clearProof = () => {
    const proof = document.getElementById('admin-fund-proof');
    proof.hidden = true;
    proof.removeAttribute('href');
  };
  const journalKey = (owner, slug) => `decentbusking:fund-admin:8453:${SETTLEMENT_ROUTER_ADDRESS.toLowerCase()}:${owner.toLowerCase()}:${slug}`;
  const pending = (slug, owner = window._wallet?.address) => owner && (
    localStorage.getItem(journalKey(owner, slug)) || localStorage.getItem(contributionJournalKey(owner, slug, 'usdc')) ||
    (acceptsEth(slug) && localStorage.getItem(contributionJournalKey(owner, slug, 'eth'))));
  const render = () => {
    chart.innerHTML = renderFundBalanceChart(funds.filter(fund => fund.active).map(fund => ({
      slug: fund.slug, label: fund.label, units: asset === 'eth' ? fund.nativeBalanceUnits : fund.balanceUnits,
      amountText: `${contributionAmount(asset === 'eth' ? fund.nativeBalanceUnits : fund.balanceUnits, asset)} ${asset.toUpperCase()}`,
    })), view);
    chart.querySelectorAll('[data-fund-chart-slug]').forEach(row => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Manage';
      button.dataset.selectFund = row.dataset.fundChartSlug;
      row.append(button);
    });
    const archive = document.getElementById('admin-fund-archive-list');
    archive.replaceChildren();
    for (const fund of funds.filter(fund => !fund.active)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.selectFund = fund.slug;
      button.textContent = `${fund.label} · ${contributionAmount(fund.nativeBalanceUnits, 'eth')} ETH · ${contributionAmount(fund.balanceUnits)} USDC · Manage / restore`;
      archive.append(button);
    }
    if (!archive.childElementCount) archive.textContent = 'No archived project funds.';
    // Campaign funds are fixed by their templates; show them before they exist on Base so they can be created.
    if (!loaded) return;
    const missing = CAMPAIGN_FUNDS.filter(({ slug }) => !funds.some(fund => fund.slug === slug));
    if (!missing.length) return;
    const list = document.createElement('div');
    list.className = 'admin-fund-missing';
    for (const { slug, label } of missing) {
      const row = document.createElement('p');
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.createFund = slug;
      button.textContent = '⚸ Create on Base';
      row.append(`${label} · ${slug} · not created yet — 0 ETH `, button);
      list.append(row);
    }
    chart.append(list);
  };
  const refresh = async () => {
    const version = ++generation;
    status.textContent = 'Reading Base fund allocations…';
    const warnings = new Set();
    try {
      const { router, config } = await context();
      await refreshSelected();
      for (const id of ['admin-fund-new', 'admin-fund-referrals', 'admin-fund-pinner-campaigns']) document.getElementById(id).disabled = isBusy();
      const apply = next => {
        if (version !== generation || !isAdminWallet()) return;
        funds = next;
        loaded = true;
        for (const fund of next) select(fund.slug, { rememberOnly: true });
        render();
      };
      const next = await loadContributionFunds({ ethers: window.ethers, router, config, includeInactive: true,
        onUpdate: apply, onWarning: warning => { console.warn('[fund-admin]', warning); warnings.add(warning); } });
      apply(next);
      if (version !== generation || !isAdminWallet()) return;
      status.textContent = `On-chain balances, not spendable campaign budgets. ETH and USDC are never combined. ${[...warnings].join(' ')}`;
    } catch (error) {
      if (version !== generation) return;
      funds = [];
      chart.textContent = `Fund allocations unavailable: ${error.message}. Retry refresh; balances are not assumed to be zero.`;
      status.textContent = 'No verified chart data.';
    }
  };
  const changed = async () => {
    document.dispatchEvent(new CustomEvent('settlement-fund-updated', { detail: { routerAddress: SETTLEMENT_ROUTER_ADDRESS } }));
    await refreshSelected();
    await refresh();
  };
  async function act(kind) {
    if (isBusy()) { setStatus('Wait for the current wallet operation.', true); return; }
    let key;
    let address;
    let slug;
    setBusy(true);
    clearProof();
    try {
      if (!isAdminWallet()) throw new Error('Connect the configured admin wallet');
      slug = selected();
      const { owner } = await context();
      address = window._wallet.address;
      if (!same(owner, address)) throw new Error('Connect the configured owner wallet');
      if (pending(slug, address) || legacyPending()) throw new Error('Resolve the pending fund receipt before another action');
      const fund = funds.find(fund => fund.slug === slug);
      if (!fund) throw new Error('Select a verified existing project fund');
      const amount = kind === 'status' ? null : document.getElementById(kind === 'fund' ? 'router-native-amount' : 'router-native-recover-amount').value;
      if (amount !== null) contributionUnits(amount, 'eth');
      if (kind === 'fund' && (!fund.active || !acceptsEth(slug))) throw new Error('Select an active ETH-eligible fund');
      const active = !fund.active;
      if (!await confirmFundAction({
        title: kind === 'fund' ? `Fund ${slug} with ETH` : kind === 'recover' ? `Recover ETH from ${slug}` : `${active ? 'Restore' : 'Archive'} ${slug}`,
        description: kind === 'fund' ? `Deposit exactly ${amount} ETH on Base, plus gas. This does not publish or fund-reserve a campaign.`
          : kind === 'recover' ? `Send exactly ${amount} ETH to the configured owner ${owner}. This can leave existing campaign promises underfunded.`
          : active ? 'Restore deposits, payouts and public Fund Us rotation.'
            : 'Stop deposits and payouts, including referral claims. Remove from Fund Us and active charts. Balances, history and owner recovery remain; restore later.',
      })) return;
      const { signer, router } = await context(true);
      if (kind === 'fund') await verifyFundAdmin({ router, signer, owner });
      let hash;
      if (kind === 'fund') {
        if (await signer.provider.getBalance(address) <= contributionUnits(amount, 'eth')) throw new Error('Keep additional Base ETH for network gas');
        controller ||= createContributionController({ storage: localStorage, ethers: window.ethers });
        const result = await controller.contribute({ signer, router, slug, amount, asset: 'eth', onStep: setStatus });
        hash = result.txHash;
      } else {
        key = journalKey(address, slug);
        const operation = { kind, slug, address, ...(kind === 'status' ? { active } : { amountUnits: contributionUnits(amount, 'eth').toString() }), txHash: null };
        hash = await sendFundAdminAction({ router, signer, owner, operation, ethers: window.ethers,
          onStage: () => localStorage.setItem(key, JSON.stringify(operation)), onBroadcast: txHash => {
          localStorage.setItem(key, JSON.stringify({ ...operation, txHash }));
        } });
        localStorage.removeItem(key);
      }
      setStatus(`Confirmed on Base: ${hash}`);
      const proof = document.getElementById('admin-fund-proof');
      proof.href = `https://basescan.org/tx/${hash}`;
      proof.hidden = false;
      await changed();
    } catch (error) {
      if (key && ['ACTION_REJECTED', 4001].includes(error.code)) {
        const saved = JSON.parse(localStorage.getItem(key) || 'null');
        if (saved && !saved.txHash) localStorage.removeItem(key);
      }
      setStatus(`${error.message}. Check unresolved receipts before retrying.`, true);
    } finally { setBusy(false); await refreshSelected(); }
  }
  async function check() {
    if (isBusy()) return;
    setBusy(true);
    clearProof();
    try {
      const slug = selected();
      const { owner, router } = await context();
      const address = window._wallet.address;
      if (!isAdminWallet() || !same(owner, address)) throw new Error('Connect the configured owner wallet');
      const adminKey = journalKey(address, slug);
      const depositKey = acceptsEth(slug) ? contributionJournalKey(address, slug, 'eth') : null;
      const key = localStorage.getItem(adminKey) ? adminKey : depositKey;
      const operation = JSON.parse(key && localStorage.getItem(key) || 'null');
      if (!operation) throw new Error('No pending ETH or archive action for this fund. Use the USDC receipt controls for USDC.');
      if (!same(operation.address, address) || operation.slug !== slug) throw new Error('Receipt journal belongs to a different wallet or fund');
      const hash = document.getElementById('router-native-receipt-hash').value.trim() || operation.txHash;
      if (!/^0x[0-9a-f]{64}$/i.test(hash || '')) throw new Error('Enter the transaction hash from wallet history; do not resend');
      const receipt = await router.runner.getTransactionReceipt(hash);
      if (!receipt) throw new Error('Transaction is pending; action remains locked');
      if (receipt.status === 0) {
        if (!same(hash, operation.txHash)) throw new Error('Failed receipt does not match the saved operation');
      } else if (operation.kind) verifyFundAdminReceipt({ receipt, router, operation, ethers: window.ethers });
      else verifyContributionReceipt({ receipt, operation, ethers: window.ethers });
      localStorage.removeItem(key);
      setStatus(receipt.status === 0 ? 'Recorded transaction reverted. No confirmed action; review before retrying.' : `Exact fund action verified: ${hash}. Do not send it again.`);
      await changed();
    } catch (error) { setStatus(error.message, true); }
    finally { setBusy(false); await refreshSelected(); }
  }
  actionDialog.querySelector('[data-fund-action-cancel]').addEventListener('click', () => actionDialog.close('cancel'));
  actionDialog.querySelector('[data-fund-action-confirm]').addEventListener('click', () => actionDialog.close('confirm'));
  window.addEventListener('keydown', event => { if (actionDialog.open) event.stopPropagation(); }, true);
  section.addEventListener('click', event => {
    const button = event.target.closest('[data-select-fund]');
    if (button && !isBusy()) select(button.dataset.selectFund);
    const missing = event.target.closest('[data-create-fund]');
    if (missing && !isBusy()) create(missing.dataset.createFund, { auto: true });
  });
  document.getElementById('admin-fund-view').addEventListener('click', event => {
    view = view === 'bars' ? 'pie' : 'bars';
    event.currentTarget.textContent = view === 'bars' ? '◉ Pie view' : '▥ Bar view';
    render();
  });
  for (const button of section.querySelectorAll('[data-admin-fund-asset]')) button.addEventListener('click', () => {
    asset = button.dataset.adminFundAsset;
    section.querySelectorAll('[data-admin-fund-asset]').forEach(control => control.setAttribute('aria-pressed', String(control === button)));
    render();
  });
  document.getElementById('admin-fund-refresh').addEventListener('click', refresh);
  document.getElementById('admin-fund-new').addEventListener('click', () => { if (!isBusy()) create(''); });
  const prepare = (slug, options) => {
    if (isBusy()) return;
    if (funds.some(fund => fund.slug === slug)) select(slug);
    else create(slug, options);
  };
  document.getElementById('admin-fund-referrals').addEventListener('click', () => prepare(REFERRALS_FUND));
  document.getElementById('admin-fund-pinner-campaigns').addEventListener('click', () => prepare(PINNER_CAMPAIGN_FUND));
  // Campaign editors ask for a fund by slug; open Admin DCal → Fund Allocations, verify on Base, then select or prefill creation.
  document.addEventListener('prepare-settlement-fund', async event => {
    const slug = event.detail?.slug;
    if (![REFERRALS_FUND, PINNER_CAMPAIGN_FUND].includes(slug) || !isAdminWallet()) return;
    const modal = section.closest('dialog');
    if (modal && !modal.open) document.dispatchEvent(new Event('open-radio-programming'));
    section.open = true;
    section.scrollIntoView({ block: 'start', behavior: 'smooth' });
    await refresh();
    prepare(slug, { auto: true });
  });
  document.addEventListener('settlement-fund-changed', () => { if (section.open && isAdminWallet()) refresh(); });
  document.getElementById('router-deposit-native').addEventListener('click', () => act('fund'));
  document.getElementById('router-recover-native').addEventListener('click', () => act('recover'));
  document.getElementById('router-fund-active').addEventListener('click', () => act('status'));
  document.getElementById('router-native-check').addEventListener('click', check);
  section.addEventListener('toggle', event => { if (event.target === section && section.open) refresh(); });
  document.getElementById('router-fund-select').addEventListener('change', () => {
    clearProof();
    setStatus('');
  });
  for (const type of ['wallet-connected', 'wallet-disconnected']) document.addEventListener(type, () => {
    ++generation;
    funds = [];
    loaded = false;
    clearProof();
    document.getElementById('admin-fund-archive-list').textContent = 'Open or refresh to verify archived funds.';
    if (actionDialog.open) actionDialog.close('cancel');
    chart.textContent = 'Open or refresh Fund Allocations to verify this wallet.';
    setStatus('');
  });
  return { refresh, pending };
}
