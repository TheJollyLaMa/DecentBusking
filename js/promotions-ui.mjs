import { PROMOTION_TEMPLATES, PROMOTIONS_FUND, PROMOTIONS_USDC, PROMOTIONS_ROUTER_ABI,
  promotionAuthorization, promotionWorkReference, promotionMoney, promotionUnits, promotionLink } from './promotions.mjs';
import { newYorkInputToUtc, utcToNewYorkInput } from './radio-calendar.mjs';
import { radioListenerId } from './radio-client.mjs';
import { isAdminWallet } from './admin-access.mjs';
import { escapeLive as escape } from './live-bookings.mjs';

const service = () => {
  const value = window.DecentConfig?.ipfsUploadServiceUrl;
  if (!value) throw new Error('Platform service is not configured');
  return value.replace(/\/$/, '');
};
async function request(body) {
  const response = await fetch(`${service()}/api/promotions`, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  } : { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Promotions HTTP ${response.status}`);
  return result;
}
async function wallet() {
  const current = window._wallet;
  if (!current?.signer || !current.address) throw new Error('Connect your wallet using the header, then retry');
  const { signer, address } = current;
  const check = async () => {
    const chainId = Number((await signer.provider.getNetwork()).chainId);
    if (window._wallet?.signer !== signer || window._wallet?.address?.toLowerCase() !== address.toLowerCase() ||
        chainId !== 8453) throw new Error('Wallet or network changed; reconnect on Base and refresh');
  };
  await check();
  return { signer, address, check, provider: signer.provider, ethers: window.ethers };
}
async function signed(command) {
  const w = await wallet();
  const body = { command, address: w.address, origin: location.origin, issuedAt: new Date().toISOString() };
  body.signature = await w.signer.signMessage(promotionAuthorization(body));
  await w.check();
  const result = await request(body);
  await w.check();
  return result;
}
const money = value => promotionMoney(value || '0');
const date = value => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) + ' New York';
const field = (name, label, type = 'text', value = '') =>
  `<label>${label}<input name="${name}" type="${type}" value="${escape(value)}" required></label>`;
const termsNotice = 'Rewards require evidence and admin approval. Promotionals is earmarked, not escrowed. Wallets/browsers are not proof of unique humans. Activity means a signed song vote this New York week, not a positive vote or verified listening time.';
function campaignCard(c) {
  return `<h3>${escape(c.title)}</h3><p><strong>${money(c.rewardUnits)}</strong> per approved award · ${escape(c.status)} · ${c.remainingAwards} awards available</p>
    <p>${escape(c.criteria)}</p><p class="promotion-terms">${escape(c.terms)}</p>
    <p>${date(c.startsAt)} – ${date(c.endsAt)}<br>Claim by ${date(c.claimDeadline)}</p>`;
}
export async function payPromotion({ claim, snapshot, command, status, storage = localStorage }) {
  const w = await wallet();
  if (!isAdminWallet(w.address)) throw new Error('Connect the admin wallet');
  const key = `decentbusking:promotion-payment:${claim.id}`;
  if (storage.getItem(key)) throw new Error('A payment is unresolved. Reconcile its wallet transaction before retrying; do not clear browser storage.');
  const router = new w.ethers.Contract(snapshot.routerAddress, PROMOTIONS_ROUTER_ABI, w.signer);
  const ref = w.ethers.id(promotionWorkReference(claim));
  if (await router.completedWorkReferences(ref)) throw new Error('Reward is already paid on-chain; reconcile its transaction instead');
  if (!await router.hasRole(await router.DEFAULT_ADMIN_ROLE(), w.address) || await router.paused()) throw new Error('Payment requires the unpaused router admin');
  const fundId = w.ethers.id(PROMOTIONS_FUND);
  const fund = await router.funds(fundId);
  if (!fund.exists || !fund.active || await router.fundBalances(fundId, PROMOTIONS_USDC) < BigInt(claim.amountUnits)) throw new Error('Promotionals fund is missing, inactive or underfunded');
  const args = [fundId, PROMOTIONS_USDC, claim.wallet, BigInt(claim.amountUnits), ref,
    w.ethers.id('TheJollyLaMa/DecentBusking'), w.ethers.id(claim.wallet), '', w.ethers.ZeroHash];
  await router.payout.staticCall(...args);
  await w.check();
  await command({ action: 'prepare-payment', claimId: claim.id });
  await w.check();
  storage.setItem(key, JSON.stringify({ status: 'awaiting-wallet', reference: ref }));
  let tx;
  try { tx = await router.payout(...args); } catch (error) {
    if (error.code === 'ACTION_REJECTED' || error.code === 4001) storage.removeItem(key);
    throw error;
  }
  try { storage.setItem(key, JSON.stringify({ hash: tx.hash, reference: ref })); }
  catch (error) { throw new Error(`Payment was sent as ${tx.hash}, but its browser journal failed: ${error.message}. Reconcile this hash; do not send again.`); }
  status.textContent = `Payment pending: ${tx.hash}. Do not send again; reconcile after two confirmations.`;
  await command({ action: 'reconcile', claimId: claim.id, txHash: tx.hash });
  await tx.wait(2);
  await w.check();
  const next = await command({ action: 'reconcile', claimId: claim.id, txHash: tx.hash });
  if (next.claims.find(c => c.id === claim.id)?.status === 'paid') storage.removeItem(key);
}

export function mountAdminPromotions(root) {
  if (!root) return;
  let state;
  let busy = false;
  let generation = 0;
  let editId = '';
  root.innerHTML = `<summary>Invites &amp; Promotions</summary>
    <p>${termsNotice}</p>
    <p>Create/deposit into <strong>Promotionals (${PROMOTIONS_FUND})</strong> in Payroll → Settlements Router. No funds are created or moved here automatically.</p>
    <button type="button" data-promo-unlock>Unlock / refresh promotions</button>
    <p role="status" data-promo-status></p><div data-promo-funding></div>
    <div data-promo-workspace hidden>
      <details><summary>Create or edit a draft</summary>
        <form data-promo-form>
          <label>Offer template<select name="template">${PROMOTION_TEMPLATES.map(t => `<option value="${t.id}">${escape(t.title)}</option>`).join('')}</select></label>
          ${field('title', 'Title')}
          <label>Qualification / required evidence<textarea name="criteria" maxlength="2000" required></textarea></label>
          <label>Terms, limits, rights, privacy, disputes / refunds<textarea name="terms" maxlength="2000" required></textarea></label>
          ${field('reward', 'Reward (Base USDC)', 'text', '10')}
          ${field('budget', 'Total campaign budget (Base USDC)', 'text', '50')}
          ${field('maxAwards', 'Maximum awards (one per participant)', 'number', '5')}
          ${field('startsAt', 'Opens (New York time)', 'datetime-local')}
          ${field('endsAt', 'Closes (New York time)', 'datetime-local')}
          ${field('claimDeadline', 'Claim deadline (New York time)', 'datetime-local')}
          <button>Save draft only</button><button type="button" data-promo-new>New draft</button>
        </form>
      </details><div data-promo-campaigns></div><h3>Claims &amp; payments</h3><div data-promo-claims></div>
    </div>`;
  const status = root.querySelector('[data-promo-status]');
  const form = root.querySelector('form');
  const input = name => form.elements.namedItem(name);
  function template() {
    const t = PROMOTION_TEMPLATES.find(t => t.id === input('template').value);
    input('title').value = t.title;
    input('criteria').value = t.criteria;
    input('terms').value = 'One award per participant. No self-referrals or reward stacking. Admin reviews identity, rights, evidence and disputes before approval. No guaranteed payout. Only wallet-signed song votes recorded through this promotion qualify as activity. No positive-vote requirement. Wallet/evidence records are encrypted; reviewed payment recipient, amount and transaction are public on Base. Do not submit private personal data.';
  }
  function reset() {
    editId = '';
    form.reset();
    template();
    input('startsAt').value = utcToNewYorkInput(new Date().toISOString());
    input('endsAt').value = utcToNewYorkInput(new Date(Date.now() + 7 * 86400000).toISOString());
    input('claimDeadline').value = utcToNewYorkInput(new Date(Date.now() + 14 * 86400000).toISOString());
  }
  function render() {
    root.querySelector('[data-promo-workspace]').hidden = false;
    root.querySelector('[data-promo-funding]').textContent = state.fundingError || state.storageError ||
      `Promotionals balance: ${money(state.fundBalanceUnits)}. Campaign reservations are service accounting, not on-chain escrow.`;
    root.querySelector('[data-promo-campaigns]').innerHTML = state.campaigns.map(c => `<article class="promotion-card" data-campaign="${c.id}">
      ${campaignCard(c)}<p>Budget: ${money(c.budgetUnits)} · committed: ${money(c.committedUnits)} · paid: ${money(c.paidUnits)} · ${c.applications} claims</p>
      <button type="button" data-promo-edit>${c.status === 'draft' ? 'Edit draft' : 'Duplicate as draft'}</button>
      <button type="button" data-promo-share>Copy offer link</button>
      ${({ draft: ['published', 'archived'], published: ['paused', 'closed'], paused: ['published', 'closed'], closed: ['archived'], archived: [] }[c.status])
        .map(s => `<button type="button" data-promo-state="${s}">${{ published: 'Publish offer', paused: 'Pause offer', closed: 'Close offer', archived: 'Archive' }[s]}</button>`).join('')}</article>`).join('') || '<p>No offers yet. Templates above save as drafts.</p>';
    root.querySelector('[data-promo-claims]').innerHTML = state.claims.map(c => `<article class="promotion-card" data-claim="${c.id}">
      <h4>${escape(state.campaigns.find(p => p.id === c.campaignId)?.title || c.campaignId)}</h4>
      <p>${escape(c.wallet)} · ${money(c.amountUnits)} · <strong>${escape(c.status)}</strong></p>
      <p class="promotion-terms">${escape(c.evidence)}</p>
      ${c.qualification ? `<p>${escape(JSON.stringify(c.qualification))}</p>` : ''}
      ${c.history.map(h => `<p>${escape(h.action)}: ${escape(h.reason)}</p>`).join('')}
      <label>Review note (required)<input data-promo-reason maxlength="2000"></label>
      ${['submitted', 'needs-evidence'].includes(c.status) ? ['approved', 'needs-evidence', 'rejected'].map(s =>
        `<button type="button" data-promo-review="${s}">${{ approved: 'Approve & reserve reward', 'needs-evidence': 'Request more evidence', rejected: 'Reject' }[s]}</button>`).join('') : ''}
      ${c.status === 'approved' || c.status === 'payment-pending' && !c.txHash ? '<button type="button" data-promo-pay>Pay approved reward</button>' : ''}
      ${['approved', 'payment-pending'].includes(c.status) ? `<label>Payment transaction hash<input data-promo-hash value="${escape(c.txHash || '')}"></label>
        <button type="button" data-promo-reconcile>Reconcile payment</button>` : ''}
      ${c.status === 'paid' ? `<a href="https://basescan.org/tx/${escape(c.txHash)}" target="_blank" rel="noopener">Confirmed payment</a>` : ''}
    </article>`).join('') || '<p>No participant claims.</p>';
  }
  async function command(c) {
    const result = await signed({ ...c, revision: state?.revision });
    state = result;
    render();
    return result;
  }
  async function guard(fn) {
    if (busy) return;
    busy = true;
    const version = generation;
    status.textContent = 'Working…';
    try {
      if (!isAdminWallet()) throw new Error('Connect the admin wallet');
      await fn();
      if (version === generation) status.textContent = 'Saved / verified. No Discord messages sent.';
    } catch (error) {
      if (version === generation) status.textContent = error.message;
    } finally { busy = false; }
  }
  form.addEventListener('change', event => { if (event.target.name === 'template') template(); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    void guard(async () => {
      const campaign = { template: input('template').value, title: input('title').value,
        criteria: input('criteria').value, terms: input('terms').value,
        rewardUnits: promotionUnits(input('reward').value), budgetUnits: promotionUnits(input('budget').value),
        maxAwards: Number(input('maxAwards').value),
        ...Object.fromEntries(['startsAt', 'endsAt', 'claimDeadline'].map(k => [k, newYorkInputToUtc(input(k).value)])) };
      await command({ action: 'save', campaignId: editId || undefined, campaign });
      reset();
    });
  });
  root.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target || target.type === 'submit') return;
    void guard(async () => {
      if (target.matches('[data-promo-unlock]')) return command({ action: 'view' });
      if (target.matches('[data-promo-new]')) return reset();
      const campaign = state?.campaigns.find(c => c.id === target.closest('[data-campaign]')?.dataset.campaign);
      if (campaign) {
        if (target.matches('[data-promo-edit]')) {
          editId = campaign.status === 'draft' ? campaign.id : '';
          for (const name of ['title', 'criteria', 'terms', 'template', 'maxAwards']) input(name).value = campaign[name];
          input('reward').value = String(Number(campaign.rewardUnits) / 1e6);
          input('budget').value = String(Number(campaign.budgetUnits) / 1e6);
          for (const name of ['startsAt', 'endsAt', 'claimDeadline']) input(name).value = utcToNewYorkInput(campaign[name]);
          form.closest('details').open = true;
          return;
        }
        if (target.matches('[data-promo-share]')) {
          await navigator.clipboard.writeText(promotionLink(campaign.id));
          return;
        }
        if (target.dataset.promoState) return command({ action: 'status', campaignId: campaign.id, status: target.dataset.promoState });
      }
      const card = target.closest('[data-claim]');
      const claim = state?.claims.find(c => c.id === card?.dataset.claim);
      if (!claim) return;
      if (target.dataset.promoReview) return command({ action: 'review', claimId: claim.id,
        decision: target.dataset.promoReview, reason: card.querySelector('[data-promo-reason]').value });
      if (target.matches('[data-promo-pay]')) return payPromotion({ claim, snapshot: state, command, status });
      if (target.matches('[data-promo-reconcile]')) {
        const key = `decentbusking:promotion-payment:${claim.id}`;
        const journal = JSON.parse(localStorage.getItem(key) || 'null');
        const hash = card.querySelector('[data-promo-hash]').value || journal?.hash;
        const result = await command({ action: 'reconcile', claimId: claim.id, txHash: hash });
        const updated = result.claims.find(c => c.id === claim.id);
        if (updated?.status === 'paid' || updated?.lastRevertedHash === hash?.toLowerCase()) localStorage.removeItem(key);
      }
    });
  });
  const clear = () => {
    generation++;
    state = null;
    root.querySelector('[data-promo-workspace]').hidden = true;
    root.querySelector('[data-promo-campaigns]').replaceChildren();
    root.querySelector('[data-promo-claims]').replaceChildren();
    root.querySelector('[data-promo-funding]').textContent = '';
    status.textContent = 'Connect the admin wallet, then unlock promotions.';
  };
  for (const name of ['wallet-connected', 'wallet-disconnected']) document.addEventListener(name, clear);
  reset();
}

export function mountPublicPromotion() {
  const params = new URLSearchParams(location.search);
  const campaignId = params.get('promotion');
  if (!campaignId) return;
  const launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.className = 'promotion-launcher';
  launcher.textContent = 'Return to promotion';
  launcher.hidden = true;
  const overlay = document.createElement('dialog');
  overlay.className = 'promotion-dialog';
  overlay.innerHTML = `<button type="button" data-promo-close>Close</button><h2>Invites &amp; Promotions</h2>
    <p>${termsNotice}</p><p role="status" data-promo-status></p><div data-promo-offer></div>
    <p>Close this panel to use the radio; choose Return to promotion to come back.</p>
    <button type="button" data-promo-connect>Connect wallet</button>
    <button type="button" data-promo-refresh>Refresh offer</button>
    <button type="button" data-promo-mine>My participation (wallet signature)</button>
    <div data-promo-member hidden>
      <p data-promo-activity></p>
      <label>Invited by (wallet, optional; fixed at registration)<input data-promo-ref value="${escape(params.get('ref') || '')}"></label>
      <label><input type="checkbox" data-promo-accept> I accept the displayed offer terms and activity recording; payment recipients and amounts are public.</label>
      <button type="button" data-promo-join>Register for this offer</button>
      <button type="button" data-promo-invite>Copy my referral invite</button>
      <p>Listen using the radio bar. Cast a wallet-signed vote on the current song to count as active this week. Both directions qualify; anonymous past votes cannot be attributed retroactively.</p>
      <button type="button" data-promo-vote="1">Vote up on current song</button>
      <button type="button" data-promo-vote="-1">Vote down on current song</button>
      <form data-promo-claim>
        <label>Evidence / catalog or event references (no private personal information)<textarea name="evidence" maxlength="2000" required></textarea></label>
        <div data-promo-sponsor hidden>
          ${field('purchaser', 'Advert purchaser wallet')}
          ${field('advertId', 'DVert campaign ID')}
          ${field('purchaseHash', 'Confirmed campaign purchase transaction')}
        </div><button>Submit claim for review</button>
      </form><div data-promo-my-claims></div>
    </div>`;
  document.body.append(launcher, overlay);
  launcher.addEventListener('click', () => { launcher.hidden = true; overlay.showModal(); });
  overlay.addEventListener('close', () => { launcher.hidden = false; });
  overlay.showModal();
  const status = overlay.querySelector('[data-promo-status]');
  const memberPanel = overlay.querySelector('[data-promo-member]');
  let state;
  let privateState;
  let busy = false;
  let generation = 0;
  function render() {
    const campaign = state?.campaigns.find(c => c.id === campaignId && !['draft', 'archived'].includes(c.status));
    overlay.querySelector('[data-promo-offer]').innerHTML = campaign ? campaignCard(campaign) : '<p>This offer is not published or does not exist.</p>';
    memberPanel.hidden = !privateState || !campaign;
    if (!privateState || !campaign) return;
    const member = privateState.members.find(m => m.campaignId === campaignId && m.wallet === privateState.viewerWallet);
    overlay.querySelector('[data-promo-activity]').textContent = `${member ? 'Registered' : 'Not registered'} · ${privateState.activity.week} · ${privateState.activity.voted ? 'Song vote recorded' : 'No qualifying vote recorded'} · Referrals: ${privateState.referrals.registered} registered, ${privateState.referrals.activeThisWeek} active this week`;
    overlay.querySelector('[data-promo-ref]').disabled = !!member;
    overlay.querySelector('[data-promo-join]').disabled = !!member;
    const sponsor = overlay.querySelector('[data-promo-sponsor]');
    sponsor.hidden = campaign.template !== 'sponsor';
    sponsor.querySelectorAll('input').forEach(el => { el.required = !sponsor.hidden; el.disabled = sponsor.hidden; });
    const claims = privateState.claims.filter(c => c.campaignId === campaignId && c.wallet === privateState.viewerWallet);
    overlay.querySelector('[data-promo-my-claims]').innerHTML = claims.map(c => `<p>${escape(c.status)} · ${money(c.amountUnits)}</p>
      ${c.history.map(h => `<p>${escape(h.action)}: ${escape(h.reason)}</p>`).join('')}
      ${c.status === 'needs-evidence' ? `<button type="button" data-promo-evidence="${c.id}">Update evidence from the form above</button>` : ''}
      ${c.status === 'paid' ? `<a href="https://basescan.org/tx/${escape(c.txHash)}">Payment proof</a>` : ''}`).join('');
  }
  async function command(c) {
    privateState = await signed({ ...c, campaignId });
    state = privateState;
    render();
  }
  async function guard(fn) {
    if (busy) return;
    busy = true;
    const version = generation;
    status.textContent = 'Working…';
    try { await fn(); if (version === generation) status.textContent = 'Updated. No payment has been promised by registration or voting.'; }
    catch (error) { if (version === generation) status.textContent = error.message; }
    finally { busy = false; }
  }
  overlay.querySelector('[data-promo-close]').addEventListener('click', () => overlay.close());
  overlay.addEventListener('click', event => {
    const target = event.target.closest('button[type="button"]');
    if (!target || target.matches('[data-promo-close]')) return;
    void guard(async () => {
      if (target.matches('[data-promo-refresh]')) { state = await request(); render(); return; }
      if (target.matches('[data-promo-connect]')) {
        if (!window._wallet?.connect) throw new Error('Wallet connection is not available; enable your wallet extension and retry');
        await window._wallet.connect();
        await wallet();
        return;
      }
      if (target.matches('[data-promo-mine]')) return command({ action: 'view' });
      if (target.matches('[data-promo-join]')) {
        if (!overlay.querySelector('[data-promo-accept]').checked) throw new Error('Accept the offer terms before registering');
        return command({ action: 'join', referrer: overlay.querySelector('[data-promo-ref]').value.trim() });
      }
      if (target.matches('[data-promo-invite]')) {
        const w = await wallet();
        if (!privateState?.members.some(m => m.campaignId === campaignId && m.wallet === w.address.toLowerCase())) throw new Error('Register first');
        return navigator.clipboard.writeText(promotionLink(campaignId, w.address));
      }
      if (target.dataset.promoVote) {
        const response = await fetch(`${service()}/api/radio`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('Radio is unavailable');
        const { nowPlaying } = await response.json();
        if (!nowPlaying || nowPlaying.isDevert) throw new Error('Wait for a song, not an advert');
        return command({ action: 'vote', playId: nowPlaying.playId, voterId: radioListenerId(localStorage), vote: Number(target.dataset.promoVote) });
      }
      if (target.dataset.promoEvidence) return command({ action: 'evidence', claimId: target.dataset.promoEvidence,
        evidence: overlay.querySelector('textarea').value });
    });
  });
  overlay.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    void guard(async () => {
      const data = Object.fromEntries(new FormData(event.target));
      await command({ action: 'claim', ...data });
    });
  });
  const clear = () => {
    generation++;
    privateState = null;
    overlay.querySelector('form').reset();
    overlay.querySelector('[data-promo-accept]').checked = false;
    overlay.querySelector('[data-promo-activity]').textContent = '';
    if (state) state = { campaigns: state.campaigns.filter(c => !['draft', 'archived'].includes(c.status)) };
    render();
    memberPanel.hidden = true;
    overlay.querySelector('[data-promo-my-claims]').replaceChildren();
    status.textContent = 'Wallet changed; sign My participation again.';
  };
  for (const name of ['wallet-connected', 'wallet-disconnected']) document.addEventListener(name, clear);
  void guard(async () => { state = await request(); render(); });
}
