import { PROMOTION_TEMPLATES, PROMOTIONS_FUND, PROMOTIONS_USDC, PROMOTIONS_ROUTER_ABI, isPromotionsFund,
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
export function promotionInputToUtc(value) {
  const result = newYorkInputToUtc(value);
  const epoch = Date.parse(result);
  if ([-3600000, 3600000].some(offset => utcToNewYorkInput(new Date(epoch + offset).toISOString()) === value)) {
    throw new Error('That New York time occurs twice during daylight-saving change; choose an unambiguous time');
  }
  return result;
}
const field = (name, label, type = 'text', value = '') =>
  `<label>${label}<input name="${name}" type="${type}" value="${escape(value)}" required></label>`;
const termsNotice = 'Rewards require evidence and admin approval. Promotionals is earmarked, not escrowed. Wallets/browsers are not proof of unique humans. Activity means a signed song vote this New York week, not a positive vote or verified listening time.';
function campaignCard(c) {
  return `<h3>${escape(c.title)}</h3><p><strong>${money(c.rewardUnits)}</strong> per approved award · ${escape(c.status)} · ${c.remainingAwards} awards available</p>
    <p>${c.template === 'sponsor-match' ? `Match destination: ${escape(c.matchTargetFund || '')}; draft only.` : 'Reward recipient: claimant wallet.'}
    Funding: ${escape(c.fund)}; one award per wallet.</p>
    ${c.template === 'album' ? `<p>Minimum original tracks: ${c.minOriginalTracks}</p>` : ''}
    ${c.template === 'sponsor' ? `<p>Minimum confirmed DVert purchase: ${money(c.minPurchaseUnits)}</p>` : ''}
    <p>${escape(c.criteria)}</p><p class="promotion-terms">${escape(c.terms)}</p>
    <p>${date(c.startsAt)} – ${date(c.endsAt)}<br>Claim by ${date(c.claimDeadline)}</p>`;
}
export async function payPromotion({ claim, snapshot, command, status, storage = localStorage, sponsorReviewConfirmed = false }) {
  const w = await wallet();
  if (!isAdminWallet(w.address)) throw new Error('Connect the admin wallet');
  const key = `decentbusking:promotion-payment:${claim.id}`;
  if (storage.getItem(key)) throw new Error('A payment is unresolved. Reconcile its wallet transaction before retrying; do not clear browser storage.');
  const router = new w.ethers.Contract(snapshot.routerAddress, PROMOTIONS_ROUTER_ABI, w.signer);
  const ref = w.ethers.id(promotionWorkReference(claim));
  if (await router.completedWorkReferences(ref)) throw new Error('Reward is already paid on-chain; reconcile its transaction instead');
  if (!await router.hasRole(await router.PAYROLL_ROLE(), w.address) || await router.paused()) throw new Error('Payment requires the unpaused router payroll role');
  if (!await router.approvedAssets(PROMOTIONS_USDC)) throw new Error('Native Base USDC is not enabled on the router');
  const recipient = await router.contributors(claim.wallet);
  if (!(recipient.approved ?? recipient[1])) throw new Error('Enable this reward recipient on the shared router before paying');
  if (!isPromotionsFund(claim.fund)) throw new Error('Reward has no valid dedicated promotional fund');
  const fundId = w.ethers.id(claim.fund);
  const fund = await router.funds(fundId);
  if (!fund.exists || !fund.active || await router.fundBalances(fundId, PROMOTIONS_USDC) < BigInt(claim.amountUnits)) throw new Error('Promotionals fund is missing, inactive or underfunded');
  const args = [fundId, PROMOTIONS_USDC, claim.wallet, BigInt(claim.amountUnits), ref,
    w.ethers.id('TheJollyLaMa/DecentBusking'), w.ethers.id(claim.wallet), '', w.ethers.ZeroHash];
  await router.payout.staticCall(...args);
  await w.check();
  await command({ action: 'prepare-payment', claimId: claim.id, confirmRefundAndDisputeReview: sponsorReviewConfirmed });
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

export async function enablePromotionRecipient({ claim, snapshot, status, confirmAction = globalThis.confirm }) {
  const w = await wallet();
  if (!isAdminWallet(w.address) || claim.status !== 'approved') throw new Error('Connect the admin and approve this claim first');
  const router = new w.ethers.Contract(snapshot.routerAddress, PROMOTIONS_ROUTER_ABI, w.signer);
  const recipient = await router.contributors(claim.wallet);
  if (recipient.approved ?? recipient[1]) return;
  if (!await router.hasRole(await router.CONTRIBUTOR_ADMIN_ROLE(), w.address)) throw new Error('Contributor admin role is required');
  const existing = recipient.githubIdHash ?? recipient[0];
  const identity = existing && existing.toLowerCase() !== w.ethers.ZeroHash.toLowerCase()
    ? existing : w.ethers.id(`promotions:${claim.wallet.toLowerCase()}`);
  if (!confirmAction(`Enable ${claim.wallet} as a recipient on the shared settlement router? This separate transaction does not transfer USDC, but enables payouts from other funds too.`)) {
    throw new Error('Recipient enablement canceled');
  }
  await router.setContributorApproved.staticCall(claim.wallet, identity, true);
  await w.check();
  const tx = await router.setContributorApproved(claim.wallet, identity, true);
  status.textContent = `Recipient enablement pending: ${tx.hash}. Check wallet history before retrying.`;
  if ((await tx.wait(2))?.status !== 1) throw new Error('Recipient enablement did not confirm');
  await w.check();
  const updated = await router.contributors(claim.wallet);
  if (!(updated.approved ?? updated[1])) throw new Error('Recipient enablement is not active');
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
          ${field('fund', 'Dedicated promotional funding source', 'text', PROMOTIONS_FUND)}
          <div data-promo-album>${field('minOriginalTracks', 'Minimum original tracks', 'number', '3')}</div>
          <div data-promo-sponsor-terms>${field('minPurchase', 'Minimum eligible DVert purchase (USDC)', 'text', '5')}</div>
          <div data-promo-match-terms>
            ${field('matchTargetFund', 'Chosen artist fund slug', 'text', 'dbusk-playback')}
            ${field('minContribution', 'Minimum first sponsor contribution (USDC)', 'text', '5')}
            <p>Draft only: matching fund delivery is not yet available.</p>
          </div>
          ${field('startsAt', 'Opens (New York time)', 'datetime-local')}
          ${field('endsAt', 'Closes (New York time)', 'datetime-local')}
          ${field('claimDeadline', 'Claim deadline (New York time)', 'datetime-local')}
          <button>Save draft only</button><button type="button" data-promo-new>New draft</button>
        </form>
      </details><div data-promo-campaigns></div><h3>Attribution review</h3><div data-promo-members></div>
      <h3>Claims &amp; payments</h3><div data-promo-claims></div>
    </div>`;
  const status = root.querySelector('[data-promo-status]');
  const form = root.querySelector('form');
  const input = name => form.elements.namedItem(name);
  function templateFields() {
    for (const [selector, active] of [
      ['[data-promo-album]', input('template').value === 'album'],
      ['[data-promo-sponsor-terms]', input('template').value === 'sponsor'],
      ['[data-promo-match-terms]', input('template').value === 'sponsor-match'],
    ]) {
      const section = root.querySelector(selector);
      section.hidden = !active;
      section.querySelectorAll('input').forEach(el => { el.disabled = !active; });
    }
  }
  function template() {
    const t = PROMOTION_TEMPLATES.find(t => t.id === input('template').value);
    input('title').value = t.title;
    input('criteria').value = t.criteria;
    input('terms').value = 'One award per participant. No self-referrals or reward stacking. Admin reviews identity, rights, evidence and disputes before approval. No guaranteed payout. Only wallet-signed song votes recorded through this promotion qualify as activity. No positive-vote requirement. Wallet/evidence records are encrypted; reviewed payment recipient, amount and transaction are public on Base. Do not submit private personal data.';
    templateFields();
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
    root.querySelector('[data-promo-funding]').textContent = state.storageError ||
      `${state.funds.map(f => `${f.slug}: ${f.error || money(f.balanceUnits)}`).join(' · ')}. Campaign reservations are service accounting, not on-chain escrow.`;
    root.querySelector('[data-promo-campaigns]').innerHTML = state.campaigns.map(c => `<article class="promotion-card" data-campaign="${c.id}">
      ${campaignCard(c)}<p>Budget: ${money(c.budgetUnits)} · remaining: ${money(c.remainingUnits)} · committed: ${money(c.committedUnits)}</p>
      <p>Approved: ${money(c.approvedUnits)} · payment pending: ${money(c.paymentPendingUnits)} · paid: ${money(c.paidUnits)} · ${c.applications} claims (${c.awaitingReview} awaiting review)</p>
      <button type="button" data-promo-edit>${c.status === 'draft' ? 'Edit draft' : 'Duplicate as draft'}</button>
      <button type="button" data-promo-share>Copy offer link</button>
      ${({ draft: ['published', 'archived'], published: ['paused', 'closed'], paused: ['published', 'closed'], closed: ['archived'], archived: [] }[c.status])
        .map(s => `<button type="button" data-promo-state="${s}">${{ published: 'Publish offer', paused: 'Pause offer', closed: 'Close offer', archived: 'Archive' }[s]}</button>`).join('')}
      ${c.announcement?.status === 'sent' ? `<p>Discord poster sent: <a href="${escape(c.announcement.messageUrl)}" target="_blank" rel="noopener">view message</a></p>` : ''}
      ${c.announcement?.status === 'pending' ? '<p>Discord delivery is uncertain; do not send again.</p><button type="button" data-promo-reconcile-discord>Reconcile Discord delivery</button>' : ''}
      ${c.status === 'published' && !c.announcement ? `<details ${state.announcementPreview?.campaignId === c.id ? 'open' : ''}><summary>Prepare a Discord poster</summary>
        <p>One poster, one brief supporting sentence and the offer link. No mentions. Preview and confirm before sending.</p>
        <label>HTTPS poster image URL<input data-promo-poster type="url" maxlength="2048"></label>
        <label>One brief supporting sentence<input data-promo-sentence maxlength="180"></label>
        <button type="button" data-promo-preview-discord>Preview Discord poster</button>
        ${state.announcementPreview?.campaignId === c.id ? `<figure data-promo-discord-preview>
          <img src="${escape(state.announcementPreview.posterUrl)}" alt="Poster preview">
          <figcaption>${escape(state.announcementPreview.sentence)}<br>${escape(state.announcementPreview.link)}</figcaption>
          <button type="button" data-promo-send-discord>Confirm — send poster to Discord</button>
        </figure>` : ''}
      </details>` : ''}</article>`).join('') || '<p>No offers yet. Templates above save as drafts.</p>';
    root.querySelector('[data-promo-claims]').innerHTML = state.claims.map(c => `<article class="promotion-card" data-claim="${c.id}">
      <h4>${escape(state.campaigns.find(p => p.id === c.campaignId)?.title || c.campaignId)}</h4>
      <p>${escape(c.wallet)} · ${money(c.amountUnits)} · ${escape(c.fund)} · <strong>${escape(c.status)}</strong></p>
      <p class="promotion-terms">${escape(c.evidence)}</p>
      ${c.subjectWallet ? `<p>Musician helped: ${escape(c.subjectWallet)}</p>` : ''}
      ${c.qualification ? `<p>${escape(JSON.stringify(c.qualification))}</p>` : ''}
      ${c.history.map(h => `<p>${escape(h.at)} · ${escape(h.reviewer)} · ${escape(h.action)}: ${escape(h.reason)}</p>`).join('')}
      <label>Review note (required)<input data-promo-reason maxlength="2000"></label>
      ${state.campaigns.find(p => p.id === c.campaignId)?.template === 'sponsor' ? `
        <label><input type="checkbox" data-promo-new-advertiser> New advertiser reviewed</label>
        <label><input type="checkbox" data-promo-refund-reviewed> Refund and attribution dispute policy reviewed</label>` : ''}
      ${['submitted', 'needs-evidence'].includes(c.status) ? ['approved', 'needs-evidence', 'rejected'].map(s =>
        `<button type="button" data-promo-review="${s}">${{ approved: 'Approve & reserve reward', 'needs-evidence': 'Request more evidence', rejected: 'Reject' }[s]}</button>`).join('') : ''}
      ${c.status === 'approved' ? '<button type="button" data-promo-review="rejected">Reject approved claim</button><button type="button" data-promo-enable>Enable recipient on router</button><button type="button" data-promo-pay>Pay approved reward</button>' : ''}
      ${c.status === 'payment-pending' && !c.txHash ? '<button type="button" data-promo-release>Review unbroadcast preparation</button>' : ''}
      ${['approved', 'payment-pending'].includes(c.status) ? `<label>Payment transaction hash<input data-promo-hash value="${escape(c.txHash || '')}"></label>
        <button type="button" data-promo-reconcile>Reconcile payment</button>` : ''}
      ${c.status === 'paid' ? `<a href="https://basescan.org/tx/${escape(c.txHash)}" target="_blank" rel="noopener">Confirmed payment</a>` : ''}
    </article>`).join('') || '<p>No participant claims.</p>';
    root.querySelector('[data-promo-members]').innerHTML = state.members.map(m => `<article class="promotion-card" data-member="${escape(m.wallet)}" data-member-campaign="${escape(m.campaignId)}">
      <p>${escape(state.campaigns.find(c => c.id === m.campaignId)?.title || m.campaignId)} · ${escape(m.wallet)}</p>
      <p>Current referrer: ${escape(m.referrer || 'none')} · joined ${escape(m.joinedAt)}</p>
      ${m.attributionHistory.map(h => `<p>${escape(h.at)} · ${escape(h.reviewer)}: ${escape(h.from || 'none')} → ${escape(h.to || 'none')} · ${escape(h.reason)}</p>`).join('')}
      <label>Correct referrer wallet (blank for none)<input data-promo-correct-ref value="${escape(m.referrer)}"></label>
      <label>Reason for correction<input data-promo-correct-reason maxlength="2000"></label>
      <button type="button" data-promo-correct>Record attribution correction</button>
    </article>`).join('') || '<p>No registrations.</p>';
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
      if (version === generation) status.textContent = 'Updated; review the delivery and payment status below.';
    } catch (error) {
      if (version === generation) status.textContent = error.message;
    } finally { busy = false; }
  }
  form.addEventListener('change', event => { if (event.target.name === 'template') template(); });
  root.addEventListener('input', event => {
    if (event.target.matches('[data-promo-poster], [data-promo-sentence]') && state?.announcementPreview) {
      delete state.announcementPreview;
      root.querySelector('[data-promo-discord-preview]')?.remove();
    }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    void guard(async () => {
      const campaign = { template: input('template').value, title: input('title').value,
        criteria: input('criteria').value, terms: input('terms').value,
        rewardUnits: promotionUnits(input('reward').value), budgetUnits: promotionUnits(input('budget').value),
        maxAwards: Number(input('maxAwards').value), fund: input('fund').value.trim(),
        ...(input('template').value === 'album' ? { minOriginalTracks: Number(input('minOriginalTracks').value) } : {}),
        ...(input('template').value === 'sponsor' ? { minPurchaseUnits: promotionUnits(input('minPurchase').value) } : {}),
        ...(input('template').value === 'sponsor-match' ? { matchTargetFund: input('matchTargetFund').value.trim(),
          minContributionUnits: promotionUnits(input('minContribution').value) } : {}),
        ...Object.fromEntries(['startsAt', 'endsAt', 'claimDeadline'].map(k => [k, promotionInputToUtc(input(k).value)])) };
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
        if (target.matches('[data-promo-preview-discord]')) {
          const card = target.closest('[data-campaign]');
          return command({ action: 'preview-discord', campaignId: campaign.id,
            posterUrl: card.querySelector('[data-promo-poster]').value.trim(),
            sentence: card.querySelector('[data-promo-sentence]').value.trim() });
        }
        if (target.matches('[data-promo-send-discord]')) {
          if (!confirm('Send exactly this poster and offer link to Discord without mentions?')) return;
          return command({ action: 'send-discord', campaignId: campaign.id, preview: state.announcementPreview });
        }
        if (target.matches('[data-promo-reconcile-discord]')) return command({ action: 'reconcile-discord', campaignId: campaign.id });
        if (target.matches('[data-promo-edit]')) {
          editId = campaign.status === 'draft' ? campaign.id : '';
          for (const name of ['title', 'criteria', 'terms', 'template', 'maxAwards', 'fund']) input(name).value = campaign[name];
          input('reward').value = String(Number(campaign.rewardUnits) / 1e6);
          input('budget').value = String(Number(campaign.budgetUnits) / 1e6);
          if (campaign.minOriginalTracks) input('minOriginalTracks').value = campaign.minOriginalTracks;
          if (campaign.minPurchaseUnits) input('minPurchase').value = String(Number(campaign.minPurchaseUnits) / 1e6);
          if (campaign.matchTargetFund) input('matchTargetFund').value = campaign.matchTargetFund;
          if (campaign.minContributionUnits) input('minContribution').value = String(Number(campaign.minContributionUnits) / 1e6);
          templateFields();
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
      const memberCard = target.closest('[data-member]');
      if (memberCard && target.matches('[data-promo-correct]')) return command({ action: 'correct-attribution',
        campaignId: memberCard.dataset.memberCampaign, memberWallet: memberCard.dataset.member,
        referrer: memberCard.querySelector('[data-promo-correct-ref]').value.trim(),
        reason: memberCard.querySelector('[data-promo-correct-reason]').value });
      const card = target.closest('[data-claim]');
      const claim = state?.claims.find(c => c.id === card?.dataset.claim);
      if (!claim) return;
      if (target.dataset.promoReview) return command({ action: 'review', claimId: claim.id,
        decision: target.dataset.promoReview, reason: card.querySelector('[data-promo-reason]').value,
        confirmNewAdvertiser: card.querySelector('[data-promo-new-advertiser]')?.checked === true,
        confirmRefundAndDisputeReview: card.querySelector('[data-promo-refund-reviewed]')?.checked === true });
      if (target.matches('[data-promo-enable]')) return enablePromotionRecipient({ claim, snapshot: state, status });
      if (target.matches('[data-promo-pay]')) {
        const sponsor = state.campaigns.find(c => c.id === claim.campaignId)?.template === 'sponsor';
        const sponsorReviewConfirmed = !sponsor || confirm('Have you rechecked the published refund and attribution-dispute policy before this payment?');
        if (!sponsorReviewConfirmed) return;
        return payPromotion({ claim, snapshot: state, command, status, sponsorReviewConfirmed });
      }
      if (target.matches('[data-promo-release]')) {
        if (!confirm('Inspect the owner wallet history first. Confirm only if no payment transaction was broadcast; otherwise reconcile its hash.')) return;
        const reason = prompt('Record the wallet-history review and why no transaction was broadcast:');
        if (!reason?.trim()) return;
        await command({ action: 'release-payment-preparation', claimId: claim.id, confirmNoBroadcast: true, reason });
        localStorage.removeItem(`decentbusking:promotion-payment:${claim.id}`);
        return;
      }
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
    root.querySelector('[data-promo-members]').replaceChildren();
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
      <p>Listen using the radio bar. Cast a wallet-signed vote on the current song to count as active this week. Both directions qualify; anonymous past votes cannot be attributed retroactively. If you already voted on this play, wait for the next song.</p>
      <button type="button" data-promo-vote="1">Vote up on current song</button>
      <button type="button" data-promo-vote="-1">Vote down on current song</button>
      <form data-promo-claim>
        <label>Evidence / catalog or event references (no private personal information)<textarea name="evidence" maxlength="2000" required></textarea></label>
        <div data-promo-sponsor hidden>
          ${field('purchaser', 'Advert purchaser wallet')}
          ${field('advertId', 'DVert campaign ID')}
          ${field('purchaseHash', 'Confirmed campaign purchase transaction')}
        </div>
        <div data-promo-buddy hidden>${field('subjectWallet', 'Musician helped (different wallet)')}</div>
        <button>Submit claim for review</button>
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
    const activity = privateState.participation.find(item => item.campaignId === campaignId);
    overlay.querySelector('[data-promo-activity]').textContent = member
      ? `Registered · ${activity.week} · ${activity.voted ? 'Song vote recorded after registration' : 'No qualifying vote recorded after registration'} · Referrals for this offer: ${activity.registered} registered, ${activity.activeThisWeek} active this week`
      : 'Not registered for this offer.';
    overlay.querySelector('[data-promo-ref]').disabled = !!member;
    overlay.querySelector('[data-promo-join]').disabled = !!member;
    const sponsor = overlay.querySelector('[data-promo-sponsor]');
    sponsor.hidden = campaign.template !== 'sponsor';
    sponsor.querySelectorAll('input').forEach(el => { el.required = !sponsor.hidden; el.disabled = sponsor.hidden; });
    const buddy = overlay.querySelector('[data-promo-buddy]');
    buddy.hidden = campaign.template !== 'buddy';
    buddy.querySelectorAll('input').forEach(el => { el.required = !buddy.hidden; el.disabled = buddy.hidden; });
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
        const campaign = state?.campaigns.find(c => c.id === campaignId);
        return command({ action: 'join', referrer: overlay.querySelector('[data-promo-ref]').value.trim(),
          acceptTerms: true, termsVersion: campaign?.version });
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
        ...Object.fromEntries(new FormData(overlay.querySelector('form'))) });
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
