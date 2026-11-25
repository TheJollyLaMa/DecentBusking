import { campaignAsset, formatAssetUnits, PROMOTIONS_ROUTER_ABI, PROMOTIONS_USDC, referralFundMatchQueue } from './promotions.mjs?v=20261126-referral-match';
import { fetchPromotionsState, signedPromotionCommand, promotionWallet, payReferralFundMatchSource } from './promotions-ui.mjs?v=20261126-referral-match';
import { depositSettlementUsdc } from './settlement-funds.mjs';
import { isAdminWallet } from './admin-access.mjs';

const tokenAbi = ['function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)', 'function approve(address,uint256) returns(bool)'];
const key = (item, phase) => `decentbusking:referral-match:${item.claimId}:${item.legId}:${phase}`;

export function createReferralMatchPayroll({ root, fetchState = fetchPromotionsState, sign = signedPromotionCommand,
  getWallet = promotionWallet, paySource = payReferralFundMatchSource, deposit = depositSettlementUsdc,
  storage = globalThis.localStorage, ask = globalThis.prompt, confirmAction = globalThis.confirm,
  isBusy = () => false, setBusy = () => {} } = {}) {
  let state = null, busy = false, line;
  const status = (message, error = false) => {
    if (line) { line.textContent = message; line.classList.toggle('is-error', error); }
  };
  const command = async input => {
    state = await sign({ revision: state.revision, ...input });
    return state;
  };
  const target = item => ({ claimId: item.claimId, legId: item.legId });
  const journal = (item, phase) => {
    try { return JSON.parse(storage.getItem(key(item, phase)) || 'null'); }
    catch { throw new Error('Fund-match journal is invalid; inspect wallet history before proceeding'); }
  };
  const current = item => referralFundMatchQueue(state?.campaigns, state?.claims)
    .find(entry => entry.claimId === item.claimId && entry.legId === item.legId);

  async function settle(item) {
    const claim = state.claims.find(c => c.id === item.claimId);
    const leg = claim.legs.find(l => l.id === item.legId);
    if (item.source.status !== 'paid') {
      await paySource({ claim, leg, snapshot: state, command, status: line, storage });
      const updated = current(item);
      if (updated?.source.status !== 'paid') return status('Source payout is still confirming. Check it before any USDC deposit.');
      status('Source payout verified. Next, review the fixed USDC deposit in your wallet.');
      item = updated;
    }
    if (item.deposit.status !== 'owed' || storage.getItem(key(item, 'deposit'))) {
      throw new Error('Deposit is unresolved; check its receipt before sending again');
    }
    const w = await getWallet();
    if (!isAdminWallet(w.address) || w.address.toLowerCase() !== item.source.recipient) throw new Error('Connect the configured settlement admin wallet');
    if (!confirmAction(`Deposit ${formatAssetUnits(item.usdcUnits)} USDC from your wallet to ${item.fund}? The source payout is verified. No automatic swap; you must arrange USDC yourself.`)) {
      status('Source payout remains verified; USDC deposit still owed.');
      return;
    }
    await command({ action: 'prepare-fund-match-deposit', ...target(item) });
    storage.setItem(key(item, 'deposit'), JSON.stringify({ status: 'awaiting-wallet' }));
    const sent = await deposit({
      router: new w.ethers.Contract(state.routerAddress, PROMOTIONS_ROUTER_ABI, w.signer),
      token: new w.ethers.Contract(PROMOTIONS_USDC, tokenAbi, w.signer),
      signer: w.signer, owner: w.address, fundId: w.ethers.id(item.fund), amountUnits: BigInt(item.usdcUnits),
      confirmations: 2, confirmationTimeout: 120000,
      checkWallet: w.check, onStep: message => status(message),
      onBroadcast: async ({ stage, txHash }) => {
        if (stage === 'approval') {
          storage.setItem(key(item, 'deposit'), JSON.stringify({ status: 'approval', approvalHash: txHash }));
          return;
        }
        try { storage.setItem(key(item, 'deposit'), JSON.stringify({ hash: txHash })); }
        catch (error) { throw new Error(`Deposit sent as ${txHash}, but journaling failed: ${error.message}. Reconcile this hash; do not send again.`); }
        await command({ action: 'reconcile-fund-match-deposit', ...target(item), txHash });
      },
    });
    await w.check();
    await command({ action: 'reconcile-fund-match-deposit', ...target(item), txHash: sent.txHash });
    if (current(item)?.status === 'paid') {
      storage.removeItem(key(item, 'deposit'));
      status('Both receipts verified. Fund match completed.');
    } else status('USDC deposit is still confirming. Do not send again; check its receipt.');
  }

  async function check(item, phase) {
    const hash = String(ask('Base transaction hash (update if replaced)', item[phase].txHash || journal(item, phase)?.hash || '') || '').trim();
    if (!hash) throw new Error('Enter the transfer/deposit hash, not an approval hash');
    await command({ action: `reconcile-fund-match-${phase}`, ...target(item), txHash: hash });
    const updated = current(item)?.[phase];
    if (updated?.status === 'paid' || updated?.lastRevertedHash === hash.toLowerCase()) storage.removeItem(key(item, phase));
    status(updated?.status === 'paid' ? 'Receipt verified.' : updated?.lastRevertedHash === hash.toLowerCase()
      ? 'This exact attempt reverted. The phase is still owed and can be retried after review.'
      : 'Phase remains unresolved; do not send again.');
  }
  async function release(item, phase) {
    if (!confirmAction('Release only after wallet history confirms no payout/deposit was broadcast. An approval is not a deposit. Continue?')) return;
    const reason = String(ask('What did wallet history show?') || '').trim();
    if (!reason) throw new Error('A wallet-history review reason is required');
    await command({ action: 'release-fund-match-preparation', ...target(item), phase, confirmNoBroadcast: true, reason });
    storage.removeItem(key(item, phase));
    status('Unbroadcast preparation released. Previously verified source payouts remain paid.');
  }
  function render() {
    const doc = root.ownerDocument;
    const el = (tag, className, text = '') => {
      const node = doc.createElement(tag); node.className = className; node.textContent = text; return node;
    };
    const items = referralFundMatchQueue(state?.campaigns, state?.claims).filter(item => item.status !== 'paid');
    root.replaceChildren(el('h4', '', '🏆 📻 Referral fund matches owed'),
      el('p', 'rc-help', 'Qualified newcomers only, after the campaign ends or fills. One flow: release the source share to the admin → deposit the fixed USDC match. Each stage is verified on Base; no automatic swap.'));
    for (const item of items) {
      const row = el('article', 'supporter-payroll-row referral-match-row');
      const campaign = state.campaigns.find(c => c.id === item.campaignId);
      row.append(el('span', 'supporter-payroll-what', `${item.title} · ${item.fund} · ${formatAssetUnits(item.amountUnits, campaignAsset(campaign))} → ${formatAssetUnits(item.usdcUnits)} USDC`));
      const newcomer = el('a', '', `👽 ${item.newcomer.slice(0, 6)}…${item.newcomer.slice(-4)}`);
      newcomer.href = `https://basescan.org/address/${item.newcomer}`; newcomer.title = item.newcomer;
      newcomer.target = '_blank'; newcomer.rel = 'noopener'; row.append(newcomer);
      const phase = item.source.status === 'paid' ? 'deposit' : 'source';
      const record = journal(item, phase);
      const unresolved = record || ['payment-pending', 'deposit-pending'].includes(item[phase].status);
      const button = (label, fn) => {
        const b = el('button', 'payroll-btn payroll-btn-secondary', label);
        b.disabled = busy || isBusy() || !isAdminWallet();
        b.type = 'button'; b.addEventListener('click', () => run(item, fn)); row.append(b);
      };
      if (!unresolved) button(phase === 'source' ? 'Release & match' : 'Deposit USDC', settle);
      else {
        button('Check receipt', item => check(item, phase));
        if (!item[phase].txHash && !record?.hash) button('Review unsent', item => release(item, phase));
      }
      for (const p of ['source', 'deposit']) if (item[p].txHash) {
        const link = el('a', '', `${p} receipt`);
        link.href = `https://basescan.org/tx/${item[p].txHash}`; link.target = '_blank'; link.rel = 'noopener'; row.append(link);
      }
      root.append(row);
    }
    line = el('p', 'payroll-status');
    line.setAttribute('role', 'status'); root.append(line);
    if (!items.length) status('No completed-campaign fund matches owed.');
  }
  async function run(item, action) {
    if (busy || isBusy()) { status('Another Payroll action is in progress.', true); return; }
    busy = true; setBusy(true);
    let message, failed = false;
    try {
      render();
      state = await fetchState();
      const fresh = current(item);
      if (!fresh || fresh.status === 'paid') throw new Error('Match changed; refresh before continuing');
      await action(fresh);
      message = line.textContent;
    } catch (error) {
      failed = true; message = `${error.shortMessage || error.message}. Preserve pending receipts; do not send again.`;
    } finally {
      busy = false; setBusy(false);
      try { state = await fetchState(); }
      catch (error) { failed = true; message = `${message || ''} Queue refresh failed: ${error.message}`; }
      try { render(); status(message, failed); }
      catch (error) { root.textContent = `Fund-match queue unavailable: ${error.message}`; }
    }
  }
  return {
    async load() {
      if (busy) return;
      try { state = await fetchState(); render(); }
      catch (error) { root.textContent = `Fund-match queue unavailable: ${error.message}`; }
    },
  };
}

let mounted;
export async function loadReferralMatchPayroll(doc = globalThis.document, options = {}) {
  const root = doc?.getElementById('payroll-referral-match-queue');
  if (!root) return;
  if (mounted?.root !== root) mounted = { root, view: createReferralMatchPayroll({ root, ...options }) };
  await mounted.view.load();
}
