// Earned referral Supporter tokens, listed in the dev payroll queue and sent directly from the admin wallet.
import { SUPPORTER_REWARD, SUPPORTER_REWARD_ABI, supporterRewardQueue } from './promotions.mjs?v=20261123-supporter-queue';
import { fetchPromotionsState, signedPromotionCommand, promotionWallet } from './promotions-ui.mjs?v=20261126-eth-gifts';
import { isAdminWallet } from './admin-access.mjs';

const journalKey = item => `decentbusking:supporter-delivery:${item.campaignId}:${item.wallet}`;
const short = wallet => `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
const delivered = (state, item) => supporterRewardQueue(state.campaigns || [])
  .find(entry => entry.campaignId === item.campaignId && entry.wallet === item.wallet)?.status === 'delivered';

export function createSupporterPayroll({ root, fetchState = fetchPromotionsState, sign = signedPromotionCommand,
  getWallet = promotionWallet, storage = globalThis.localStorage, ask = globalThis.prompt, confirmAction = globalThis.confirm } = {}) {
  let state = null;
  let busy = false;
  let line = null;
  const status = (text, error = false) => {
    if (line) { line.textContent = text; line.classList.toggle('is-error', error); }
  };
  const command = async c => {
    state = await sign({ revision: state.revision, ...c });
    return state;
  };
  const journal = item => {
    try { return JSON.parse(storage.getItem(journalKey(item)) || 'null'); }
    catch { throw new Error('Supporter transfer journal is invalid; inspect wallet history before proceeding'); }
  };

  async function send(item) {
    const w = await getWallet();
    if (!isAdminWallet(w.address)) throw new Error('Connect the admin wallet');
    if (storage.getItem(journalKey(item))) throw new Error('A transfer is unresolved. Check its receipt before retrying.');
    const token = new w.ethers.Contract(SUPPORTER_REWARD.contract, SUPPORTER_REWARD_ABI, w.signer);
    const tokenId = BigInt(SUPPORTER_REWARD.tokenId), quantity = BigInt(SUPPORTER_REWARD.quantity);
    if (await token.balanceOf(w.address, tokenId) < quantity) throw new Error(`Admin wallet holds no Supporter #${tokenId}`);
    const args = [w.address, item.wallet, tokenId, quantity, '0x'];
    await token.safeTransferFrom.staticCall(...args);
    state = await fetchState();
    await command({ action: 'prepare-supporter', campaignId: item.campaignId, wallet: item.wallet });
    await w.check();
    storage.setItem(journalKey(item), JSON.stringify({ status: 'awaiting-wallet' }));
    let tx;
    try { tx = await token.safeTransferFrom(...args); } catch (error) {
      if (error.code === 'ACTION_REJECTED' || error.code === 4001) storage.removeItem(journalKey(item));
      throw error;
    }
    try { storage.setItem(journalKey(item), JSON.stringify({ hash: tx.hash })); }
    catch (error) { throw new Error(`Sent as ${tx.hash}, but the browser journal failed: ${error.message}. Check this hash; do not send again.`); }
    status(`🎖 Sending… ${tx.hash.slice(0, 10)}… Do not send again.`);
    const firstCheck = await command({ action: 'reconcile-supporter', campaignId: item.campaignId, wallet: item.wallet, txHash: tx.hash });
    if (delivered(firstCheck, item)) {
      storage.removeItem(journalKey(item));
      return;
    }
    await tx.wait(2);
    await w.check();
    if (delivered(await command({ action: 'reconcile-supporter', campaignId: item.campaignId,
      wallet: item.wallet, txHash: tx.hash }), item)) storage.removeItem(journalKey(item));
    else return 'transfer-pending';
  }

  async function check(item) {
    const savedHash = item.txHash || journal(item)?.hash || '';
    const hash = String(ask?.('Transaction hash for this Supporter transfer (update it if replaced)', savedHash) || '').trim();
    if (!hash) throw new Error('Enter the transaction hash, or release if wallet history shows nothing was sent');
    state = await fetchState();
    const next = await command({ action: 'reconcile-supporter', campaignId: item.campaignId, wallet: item.wallet, txHash: hash });
    const entry = supporterRewardQueue(next.campaigns || []).find(e => e.campaignId === item.campaignId && e.wallet === item.wallet);
    if (!entry) throw new Error('Supporter transfer is missing from the queue; check wallet history and do not send again');
    if (entry.status !== 'transfer-pending') storage.removeItem(journalKey(item));
    else {
      if (!entry.txHash) throw new Error('Pending transfer has no recorded hash; check wallet history and do not send again');
      storage.setItem(journalKey(item), JSON.stringify({ hash: entry.txHash }));
      return 'transfer-pending';
    }
  }

  async function release(item) {
    if (!confirmAction?.('Only release if wallet history shows no Supporter transfer was broadcast. Continue?')) return;
    const reason = String(ask?.('What did wallet history show?') || '').trim();
    if (!reason) throw new Error('Record why wallet history confirms nothing was sent');
    state = await fetchState();
    await command({ action: 'release-supporter-preparation', campaignId: item.campaignId, wallet: item.wallet,
      confirmNoBroadcast: true, reason });
    storage.removeItem(journalKey(item));
  }

  function render() {
    const doc = root.ownerDocument;
    const items = supporterRewardQueue(state?.campaigns || []);
    const open = items.filter(item => item.status !== 'delivered');
    const done = items.length - open.length;
    const admin = isAdminWallet();
    root.replaceChildren();
    const el = (tag, className, text = '') => {
      const node = doc.createElement(tag);
      node.className = className;
      node.textContent = text;
      return node;
    };
    const head = el('header', 'supporter-payroll-head');
    const info = el('span', 'supporter-payroll-info', 'ⓘ');
    info.title = `Earned in referral campaigns. Sent from the admin wallet: 1 × Supporter #${SUPPORTER_REWARD.tokenId} on Base. Delivered after 2 confirmations.`;
    head.append(el('h4', '', '🎖 Supporter tokens owed'),
      el('span', 'supporter-payroll-count', `${open.length} owed${done ? ` · ${done} ✅` : ''}`), info);
    const list = el('ul', 'supporter-payroll-list');
    for (const item of open) {
      const row = el('li', `supporter-payroll-row is-${item.status}`);
      const who = el('span', 'supporter-payroll-who', `👽 ${item.name || short(item.wallet)}`);
      who.title = item.wallet;
      const what = el('span', 'supporter-payroll-what', `🎖×1 · ${item.title || 'Referral Campaign'}`);
      const actions = el('span', 'supporter-payroll-actions');
      const button = (label, title, fn) => {
        const b = el('button', 'payroll-btn payroll-btn-secondary supporter-payroll-btn', label);
        b.type = 'button';
        b.title = title;
        b.disabled = !admin || busy;
        b.addEventListener('click', () => run(fn, item));
        actions.append(b);
      };
      if (item.status === 'owed') button('🎖 Send', 'Send 1 Supporter from the admin wallet', send);
      else {
        button('🔎 Check', 'Check the transfer receipt', check);
        let journaled = true;
        try { journaled = Boolean(journal(item)?.hash); } catch {}
        if (!item.txHash && !journaled) button('↩', 'Release an unsent transfer after checking wallet history', release);
      }
      row.append(who, what, actions);
      list.append(row);
    }
    line = el('p', 'payroll-status supporter-payroll-status');
    root.append(head, ...(open.length ? [list] : []), line);
    if (!open.length) status(items.length ? '✅ All earned Supporters delivered' : 'No Supporter tokens owed yet');
  }

  async function run(fn, item) {
    if (busy) return;
    busy = true;
    render();
    status('⏳ Working…');
    let outcome;
    try {
      outcome = await fn(item);
      root.classList.add('is-celebrating');
      setTimeout(() => root.classList.remove('is-celebrating'), 1200);
    } catch (error) {
      busy = false;
      try { state = await fetchState(); } catch {}
      render();
      status(`⚠️ ${error.shortMessage || error.message}`, true);
      return;
    }
    busy = false;
    render();
    status(outcome === 'transfer-pending' ? '⏳ Transfer still confirming' : '✨ Updated');
  }

  return {
    async load() {
      try { state = await fetchState(); render(); }
      catch (error) { state = null; render(); status(`⚠️ Supporter queue unavailable: ${error.message}`, true); }
    },
  };
}

let mounted = null;
export async function loadSupporterPayroll(doc = globalThis.document) {
  const root = doc?.getElementById('payroll-supporter-queue');
  if (!root) return;
  try {
    if (mounted?.root !== root) mounted = { root, view: createSupporterPayroll({ root }) };
    await mounted.view.load();
  } catch (error) {
    root.textContent = `⚠️ Supporter queue unavailable: ${error.message}`;
  }
}
