import { buildPinnerCommandMessage, PINNER_FUND, PINNER_POLICY, pinPinnerOwnership, readLocalPinnerPeer, validatePinnerReceipt } from './pinner-rewards.mjs';
import { settleReviewedFundAllocation } from './radio-payroll.mjs?v=20261125-pinner-rewards';
import { promotionWallet } from './promotions-ui.mjs?v=20261126-eth-gifts';
import { isAdminWallet } from './admin-access.mjs';
import { formatUsdcUnits } from './usdc-format.mjs';
import { SETTLEMENT_ROUTER_ADDRESS } from './fund-admin.mjs';

const service = () => {
  const value = window.DecentConfig?.ipfsUploadServiceUrl;
  if (!value) throw new Error('Platform service is not configured');
  return value.replace(/\/$/, '');
};

export async function fetchPinnerState({ fetchImpl = fetch, body } = {}) {
  const response = await fetchImpl(`${service()}/api/pinners`, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  } : { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  const state = await response.json();
  if (!response.ok) throw new Error(state.error || `Pinner rewards unavailable (${response.status})`);
  if (state.chainId !== 8453 || state.fundSlug !== PINNER_FUND ||
    state.routerAddress?.toLowerCase() !== SETTLEMENT_ROUTER_ADDRESS.toLowerCase() ||
    !Array.isArray(state.participants) || !Array.isArray(state.receipts) ||
    JSON.stringify(state.policy) !== JSON.stringify(PINNER_POLICY) || !Number.isFinite(Date.parse(state.nextCloseAt || '')) ||
    ['availableUnits', 'reservedUnits'].some(key => typeof state.fund?.[key] !== 'string' || !/^\d+$/.test(state.fund[key])) ||
    state.participants.some(pinner => !pinner || !/^0x[0-9a-f]{40}$/.test(pinner.wallet || '') ||
      typeof pinner.peerId !== 'string' || !['pending', 'active', 'suspended'].includes(pinner.status) ||
      !Number.isSafeInteger(pinner.successfulChecks) || !Number.isSafeInteger(pinner.failedChecks) ||
      !/^\d+$/.test(pinner.estimatedUnits || ''))) throw new Error('Pinner rewards do not match this Base deployment');
  for (const record of state.receipts) validatePinnerReceipt(record.allocation, state.routerAddress);
  return state;
}

export async function signedPinnerCommand({ action, wallet, peerId, fetchImpl = fetch, getWallet = promotionWallet }) {
  const w = await getWallet();
  const state = await fetchPinnerState({ fetchImpl });
  if (!state.ready || state.rewardStatus !== 'active') throw new Error(state.lastError || 'Pinner rewards are not ready; refresh shortly');
  const body = { action, address: w.address, wallet, peerId, revision: state.revision,
    nonce: crypto.randomUUID(), issuedAt: new Date().toISOString() };
  body.signature = await w.signer.signMessage(buildPinnerCommandMessage({ ...body, origin: location.origin }));
  await w.check();
  const result = await fetchPinnerState({ fetchImpl, body });
  await w.check();
  return result;
}

export async function settlePinnerReceipt({ record, router, signer, owner, hashReference, now = Date.now(), ...callbacks }) {
  const allocation = validatePinnerReceipt(record.allocation, router.target);
  if (Date.parse(allocation.endAt) > now) throw new Error('Only a closed New York week can be paid');
  if (hashReference(JSON.stringify(allocation)) !== record.metadataHash) throw new Error('Pinner receipt digest does not match');
  return settleReviewedFundAllocation({ allocation, metadataUri: record.metadataUri, metadataHash: record.metadataHash,
    router, signer, owner, hashReference, identityPrefix: 'ipfs-pinner', paymentLabel: 'Pinner rewards',
    workReferenceFor: entry => `${PINNER_FUND}:${allocation.week}:${entry.wallet.toLowerCase()}`, ...callbacks });
}

export function createPinnerRewardsView({ root, enrollment = false, fetchImpl = fetch, getWallet = promotionWallet,
  isBusy = () => false, setBusy = () => {} }) {
  let state, busy = false, line;
  const doc = root.ownerDocument;
  const element = (tag, text = '', className = '') => {
    const node = doc.createElement(tag); node.textContent = text; node.className = className; return node;
  };
  const status = (text, error = false) => {
    if (line) { line.textContent = text; line.classList.toggle('is-error', error); }
  };
  const short = wallet => `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
  const admin = () => isAdminWallet() && window._wallet?.address?.toLowerCase() === state?.ownerWallet?.toLowerCase();
  const button = (label, action, parent = root) => {
    const node = element('button', label, 'payroll-btn payroll-btn-secondary');
    node.type = 'button'; node.disabled = busy || isBusy() || !state?.ready || state.rewardStatus !== 'active';
    node.addEventListener('click', () => run(action)); parent.append(node); return node;
  };
  function render() {
    root.replaceChildren(element('h4', enrollment ? 'Keep the music. Share the weekly rewards.' : 'Community pinner rewards'),
      element('p', 'Admin-approved musicians and listeners earn Base USDC for independently serving our shared IPFS content. Shared Pinata stays primary.', 'pinner-help'));
    if (!state?.ready || state.rewardStatus !== 'active') {
      line = element('p', state?.lastError || 'Pinner rewards are restoring or temporarily unavailable.', 'pinner-status is-error');
      line.setAttribute('role', 'status'); root.append(line);
      button('Refresh status', load).disabled = busy;
      return;
    }
    const close = new Date(state.nextCloseAt).toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' });
    root.append(element('p', `At least 20 checks, 90% availability, and a verified check within 24 hours of the cutoff. Next close: ${close}.`, 'pinner-help'),
      element('p', `${formatUsdcUnits(state.fund.availableUnits)} USDC available for this week; ${formatUsdcUnits(state.fund.reservedUnits)} USDC protected for unpaid awards. 100% of the unreserved closing pot is shared by qualifying pinners.`, 'pinner-fund'));
    if (state.fund.warning) root.append(element('p', state.fund.warning, 'pinner-help'));
    if (enrollment) {
      const wallet = window._wallet?.address?.toLowerCase();
      const mine = state.participants.find(pinner => pinner.wallet === wallet);
      const steps = element('ol', '', 'pinner-steps');
      for (const text of ['Pin the shared data above.', 'Join with your linked Discord wallet; we pin a private node-ownership marker locally.', 'After admin approval, keep IPFS Desktop running and publicly reachable.']) {
        steps.append(element('li', text));
      }
      root.append(steps);
      if (mine) {
        root.append(element('p', `${mine.status} | ${mine.successfulChecks} successful / ${mine.failedChecks} failed checks this week | ${(mine.availabilityBps / 100).toFixed(1)}% availability.`, 'pinner-personal'),
          element('p', mine.qualified ? `Current estimate: ${formatUsdcUnits(mine.estimatedUnits)} USDC. Estimates can change; only the closed-week receipt fixes an award.`
            : 'Not yet qualified for this week. Approval or a pin alone does not earn a payment.', 'pinner-help'));
        if (mine.lastCheck?.reason) root.append(element('p', `Last check: ${mine.lastCheck.reason}`, 'pinner-help'));
        for (const record of state.receipts) {
          const entry = record.allocation.entries.find(entry => entry.wallet === wallet);
          if (entry) root.append(element('p', `${record.allocation.week}: ${formatUsdcUnits(entry.amountUnits)} USDC awarded; ${record.paidWorkReferences?.includes(entry.workReferenceText) ? 'paid on Base' : 'awaiting owner-signed payroll'}.`, 'pinner-personal'));
        }
      } else root.append(element('p', wallet ? 'Link your Discord account in Profile before joining. One wallet and one Discord member per pinner.' : 'Connect your Base wallet in the header, then link Discord in Profile.', 'pinner-help'));
      button(mine?.status === 'active' ? 'Reset lost node marker' : mine ? 'Retry node setup' : 'Join pinner rewards', async () => {
        if (mine?.status === 'active' && !window.confirm('Resetting your marker returns this node to pending approval. Existing awards are kept, but new weekly eligibility pauses until reapproved. Continue?')) {
          status('Reset canceled. Your existing node approval is unchanged.'); return;
        }
        const w = await getWallet();
        const ipfsApiUrl = window.DecentConfig?.ipfsApiUrl || 'http://127.0.0.1:5001';
        status('Detecting your IPFS Desktop peer...');
        const peerId = await readLocalPinnerPeer({ ipfsApiUrl, fetchImpl });
        state = await signedPinnerCommand({ action: 'enroll', wallet: w.address, peerId, fetchImpl, getWallet });
        status('Pinning your private node-ownership marker locally...');
        await pinPinnerOwnership({ ownership: state.ownership, ipfsApiUrl, fetchImpl });
        status('Node setup complete. An admin can now verify and approve it. Keep IPFS Desktop running and pin the shared content.');
      });
      const guide = element('a', 'Node setup and reachability guide');
      guide.href = 'https://github.com/TheJollyLaMa/DecentBusking/blob/main/docs/PINNER-NETWORK.md';
      guide.target = '_blank'; guide.rel = 'noopener'; root.append(guide);
    }
    if (admin()) {
      const approvals = element('section', '', 'pinner-approvals');
      approvals.append(element('h5', 'Admin-approved nodes'));
      for (const pinner of state.participants) {
        const row = element('article', '', 'pinner-row');
        row.append(element('strong', `${short(pinner.wallet)} | ${pinner.status}`),
          element('code', pinner.peerId), element('p', `${pinner.successfulChecks} successful / ${pinner.failedChecks} failed checks this week`));
        button(pinner.status === 'active' ? 'Suspend' : 'Verify node & approve', async () => {
          status('Checking the registered node and confirming your signed decision...');
          state = await signedPinnerCommand({ action: pinner.status === 'active' ? 'suspend' : 'approve',
            wallet: pinner.wallet, peerId: pinner.peerId, fetchImpl, getWallet });
          status('Pinner status saved.');
        }, row);
        approvals.append(row);
      }
      if (!state.participants.length) approvals.append(element('p', 'No pinners have enrolled yet.'));
      root.append(approvals);
      if (!enrollment) {
        for (const record of [...state.receipts].reverse()) {
          const row = element('article', '', 'pinner-row');
          const unpaid = record.allocation.entries.filter(entry => !record.paidWorkReferences?.includes(entry.workReferenceText));
          row.append(element('strong', `${record.allocation.week} | ${formatUsdcUnits(record.allocation.allocatedUnits)} USDC awarded`));
          for (const entry of record.allocation.entries) row.append(element('p',
            `${short(entry.wallet)} | ${formatUsdcUnits(entry.amountUnits)} USDC | ${unpaid.includes(entry) ? 'owed' : 'paid on Base'}`));
          const proof = element('a', 'Immutable weekly receipt');
          proof.href = `https://ipfs.io/ipfs/${record.metadataUri.slice(7)}`; proof.target = '_blank'; proof.rel = 'noopener'; row.append(proof);
          if (unpaid.length) button('Pay unpaid pinners', async () => {
            const w = await getWallet();
            if (!admin() || w.address.toLowerCase() !== state.ownerWallet.toLowerCase()) throw new Error('Connect the registered owner wallet');
            const { PROMOTIONS_ROUTER_ABI } = await import('./promotions.mjs?v=20261126-eth-gifts');
            const result = await settlePinnerReceipt({ record, router: new w.ethers.Contract(state.routerAddress, PROMOTIONS_ROUTER_ABI, w.signer),
              signer: w.signer, owner: state.ownerWallet, hashReference: w.ethers.id,
              onStep: text => status(text) });
            await w.check();
            status(`${result.confirmed.length} pinner payments confirmed; ${result.skipped} already-paid entries skipped. Queue status refreshes within a minute.`);
          }, row);
          root.append(row);
        }
        if (!state.receipts.length) root.append(element('p', 'No closed-week pinner receipts yet. Verified checks begin after node approval.'));
      }
    }
    button('Refresh status', load).disabled = busy;
    line = element('p', '', 'pinner-status'); line.setAttribute('role', 'status'); line.setAttribute('aria-live', 'polite'); root.append(line);
  }
  async function run(action) {
    if (busy || isBusy()) return;
    busy = true; setBusy(true);
    let message = '', failed = false;
    try {
      render();
      await action();
      message = line.textContent;
    } catch (error) {
      failed = true; message = `${error.shortMessage || error.message}. No reward is created by a failed setup. Inspect wallet receipts before retrying a payment.`;
    } finally {
      busy = false; setBusy(false);
      try { state = await fetchPinnerState({ fetchImpl }); }
      catch (error) { failed = true; message = `${message} Status refresh failed: ${error.message}`; }
      render(); status(message, failed);
    }
  }
  async function load() {
    if (busy) return;
    try { state = await fetchPinnerState({ fetchImpl }); render(); }
    catch (error) { root.textContent = `Pinner rewards unavailable: ${error.message}`; }
  }
  return { load };
}

let payrollView;
export async function loadPinnerPayroll(doc = document, options = {}) {
  const root = doc.getElementById('payroll-pinner-rewards');
  if (!root) return;
  if (payrollView?.root !== root) payrollView = { root, view: createPinnerRewardsView({ root, ...options }) };
  await payrollView.view.load();
}
