import { PROMOTION_TEMPLATES, PROMOTION_ACTIVITY_WINDOWS, MUSICIAN_REFERRAL_PILOT, MUSICIAN_REFERRAL_TERMS, PROMOTIONS_FUND, PROMOTIONS_USDC, PROMOTIONS_ROUTER_ABI, isPromotionsFund,
  promotionAuthorization, promotionWorkReference, promotionMoney, promotionUnits, promotionLink, campaignAsset } from './promotions.mjs?v=20261126-eth-gifts';
import { newYorkInputToUtc, utcToNewYorkInput } from './radio-calendar.mjs';
import { radioListenerId } from './radio-client.mjs';
import { getAudibleBroadcast } from './public-broadcast-client.mjs?v=20261120-boundary-sync';
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
export const fetchPromotionsState = () => request();
export const signedPromotionCommand = command => signed(command);
export const promotionWallet = () => wallet();
export const resolvePromotionWallet = (value, provider) => resolvedWallet(value, provider);
export async function recordMusicianReferralUpload({ referrer, trackId } = {}) {
  const referral = String(referrer || '').trim();
  if (!referral) return null;
  const publicState = await request();
  const campaigns = (publicState.campaigns || []).filter(campaign =>
    campaign.template === 'musician-referral' && campaign.status === 'published' &&
    Date.parse(campaign.startsAt) <= Date.now() && Date.now() < Date.parse(campaign.endsAt));
  const linkedId = new URLSearchParams(location.search).get('promotion');
  const campaign = campaigns.find(item => item.id === linkedId) ||
    (campaigns.length === 1 ? campaigns[0] : null);
  if (!campaign) throw new Error(campaigns.length > 1
    ? 'More than one musician referral campaign is open; register through its campaign link first.'
    : 'No open musician referral campaign is accepting this upload.');
  const w = await wallet();
  const referrerWallet = await resolvedWallet(referral, w.provider);
  const mine = await signed({ action: 'view' });
  const member = mine.members?.find(item => item.campaignId === campaign.id &&
    item.wallet === w.address.toLowerCase());
  if (member && member.referrer === referrerWallet.toLowerCase() && !trackId) return mine;
  return member
    ? signed({ action: 'correct-my-attribution', campaignId: campaign.id, referrer: referrerWallet,
        trackId, reason: 'Attributed at first upload in the active musician referral campaign' })
    : signed({ action: 'join', campaignId: campaign.id, referrer: referrerWallet, trackId,
        acceptTerms: true, termsVersion: campaign.version });
}

export async function activeMusicianReferralCampaign() {
  const state = await request();
  return (state.campaigns || []).filter(campaign =>
    campaign.template === 'musician-referral' && campaign.status === 'published' &&
    Date.parse(campaign.startsAt) <= Date.now() && Date.now() < Date.parse(campaign.endsAt));
}
const money = (value, asset) => promotionMoney(value || '0', asset);
const date = value => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) + ' New York';
async function resolvedWallet(value, provider) {
  const input = String(value || '').trim();
  if (/^0x[0-9a-f]{40}$/i.test(input)) return input;
  if (!input.includes('.') || !provider?.resolveName) throw new Error('Enter a valid wallet address, or an ENS name resolvable in the connected wallet client');
  const result = await provider.resolveName(input);
  if (!/^0x[0-9a-f]{40}$/i.test(result || '')) throw new Error('ENS name did not resolve to a wallet');
  return result;
}
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
const termsNotice = 'All promotion records are public, including drafts, wallet/referrer links, submitted evidence, activity, review notes and payment receipts. Records are stored on public IPFS; do not submit secrets or personal information about others. Public copies may persist permanently. Rewards require evidence and admin approval. Promotionals is earmarked, not escrowed. Wallets/browsers are not proof of unique humans. Activity means a signed song vote in the stated window, not a positive vote or verified listening time.';
function campaignCard(c) {
  return `<h3>${escape(c.title)}</h3><p><strong>${money(c.rewardUnits, campaignAsset(c))}</strong> per approved award · ${escape(c.status)} · ${c.remainingAwards} awards available</p>
    <p>${c.template === 'sponsor-match' ? `Match destination: ${escape(c.matchTargetFund || '')}; draft only.` : 'Reward recipient: claimant wallet.'}
    Funding: ${escape(c.fund)}; one award per wallet.</p>
    ${c.template === 'album' ? `<p>Minimum original tracks: ${c.minOriginalTracks}</p>` : ''}
    ${c.template === 'referral' ? `<p>Required referrals: ${c.requiredReferrals} · activity: ${escape(PROMOTION_ACTIVITY_WINDOWS.find(w => w.id === c.activityWindow)?.label || 'unavailable')}</p>` : ''}
    ${c.template === 'sponsor' ? `<p>Minimum confirmed DVert purchase: ${money(c.minPurchaseUnits)}</p>` : ''}
    ${c.template === 'musician-referral' ? `<p>Conversion: verified minted playlist track + 10 distinct signed song votes. Allocation: $10 referrer + $5 musician + $5 Top10 funding-needed + $5 Playback funding-needed.</p>
      <p>Curated referrers: ${(c.curatedReferrers || []).map(escape).join(', ') || 'none'}</p>
      <p>Supporter token: ${c.supporterToken?.eligibleWallets?.length ? `🎖 ${c.supporterToken.eligibleWallets.length} earned, ${(c.supporterToken.deliveries || []).filter(d => d.status === 'delivered').length} delivered` : 'none earned yet'} · sent from the dev payroll queue.</p>` : ''}
    <p>${escape(c.criteria)}</p><p class="promotion-terms">${escape(c.terms)}</p>
    <p>${date(c.startsAt)} – ${date(c.endsAt)}<br>Claim by ${date(c.claimDeadline)}</p>
    ${(c.amendments || []).map(a => `<p><strong>Immutable amendment ${escape(a.id)}:</strong> ${escape(a.reason)} · budget ${money(a.before.budgetUnits)} → ${money(a.after.budgetUnits)} · end ${date(a.before.endsAt)} → ${date(a.after.endsAt)} · claim ${date(a.before.claimDeadline)} → ${date(a.after.claimDeadline)}</p>`).join('')}`;
}
export function publicPromotionRecords(state, campaignId) {
  if (!state?.campaigns.some(c => c.id === campaignId)) return '';
  const claims = (state.claims || []).filter(c => c.campaignId === campaignId);
  const members = (state.members || []).filter(m => m.campaignId === campaignId);
  const votes = (state.votes || []).filter(v => v.campaignId === campaignId);
  const uri = state.checkpointUri;
  const checkpoint = /^ipfs:\/\/[a-zA-Z0-9]+$/.test(uri || '')
    ? `<a href="https://dweb.link/ipfs/${escape(uri.slice(7))}" target="_blank" rel="noopener">Public IPFS recovery snapshot</a>` : '';
  return `<section aria-label="Public promotion records"><h3>Public records</h3>
    <p>${members.length} registered participants · ${claims.length} claims. ${checkpoint}</p>
    ${claims.map(c => `<article class="promotion-card">
      <p>${escape(c.wallet)} · ${money(c.amountUnits)} · <strong>${escape(c.status)}</strong></p>
      <p class="promotion-terms">${escape(c.evidence)}</p>
      ${(c.legs || []).map(leg => `<p>${escape(leg.id)} · ${money(leg.amountUnits)} · ${escape(leg.status)}${leg.recipient ? ` · ${escape(leg.recipient)}` : ` · ${escape(leg.fund)} (funding needed; not paid)`}${leg.txHash ? ` · <a href="https://basescan.org/tx/${escape(leg.txHash)}" target="_blank" rel="noopener">receipt</a>` : ''}</p>`).join('')}
      ${(c.history || []).map(h => `<p>${escape(h.at)} · ${escape(h.reviewer)} · ${escape(h.action)}: ${escape(h.reason)}</p>`).join('')}
      ${c.status === 'paid' && /^0x[0-9a-f]{64}$/i.test(c.txHash || '') ? `<a href="https://basescan.org/tx/${escape(c.txHash)}" target="_blank" rel="noopener">Confirmed payment receipt</a>` : ''}
    </article>`).join('') || '<p>No claims submitted.</p>'}
    <details><summary>Evidence, referrals and activity audit data (public)</summary>
      <pre class="promotion-terms">${escape(JSON.stringify({ claims, members, votes }, null, 2))}</pre>
    </details></section>`;
}
async function routerPayout({ w, routerAddress, fund, asset, recipientWallet, amountUnits, reference, key, storage, status,
  prepare, reconcile, isPaid }) {
  if (storage.getItem(key)) throw new Error('A payment is unresolved. Reconcile its wallet transaction before retrying; do not clear browser storage.');
  const router = new w.ethers.Contract(routerAddress, PROMOTIONS_ROUTER_ABI, w.signer);
  const ref = w.ethers.id(reference);
  if (await router.completedWorkReferences(ref)) throw new Error('Reward is already paid on-chain; reconcile its transaction instead');
  if (!await router.hasRole(await router.PAYROLL_ROLE(), w.address) || await router.paused()) throw new Error('Payment requires the unpaused router payroll role');
  if (!await router.approvedAssets(asset.address)) throw new Error(`${asset.symbol} is not enabled on the router`);
  const recipient = await router.contributors(recipientWallet);
  if (!(recipient.approved ?? recipient[1])) throw new Error('Enable this reward recipient on the shared router before paying');
  if (!isPromotionsFund(fund)) throw new Error('Reward has no valid dedicated promotional fund');
  const fundId = w.ethers.id(fund);
  const routerFund = await router.funds(fundId);
  if (!routerFund.exists || !routerFund.active || await router.fundBalances(fundId, asset.address) < BigInt(amountUnits)) {
    throw new Error(`${fund} is missing, inactive or underfunded in ${asset.symbol}`);
  }
  const args = [fundId, asset.address, recipientWallet, BigInt(amountUnits), ref,
    w.ethers.id('TheJollyLaMa/DecentBusking'), w.ethers.id(recipientWallet), '', w.ethers.ZeroHash];
  await router.payout.staticCall(...args);
  await w.check();
  await prepare();
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
  await reconcile(tx.hash);
  await tx.wait(2);
  await w.check();
  if (isPaid(await reconcile(tx.hash))) storage.removeItem(key);
}
export async function payPromotion({ claim, snapshot, command, status, storage = localStorage, sponsorReviewConfirmed = false, leg = null }) {
  const w = await wallet();
  if (!isAdminWallet(w.address)) throw new Error('Connect the admin wallet');
  const campaign = (snapshot.campaigns || []).find(c => c.id === claim.campaignId);
  await routerPayout({ w, routerAddress: snapshot.routerAddress, fund: claim.fund, asset: campaignAsset(campaign),
    recipientWallet: leg?.recipient || claim.wallet, amountUnits: leg?.amountUnits || claim.amountUnits,
    reference: promotionWorkReference(claim, leg?.id), storage, status,
    key: `decentbusking:promotion-payment:${claim.id}${leg ? `:${leg.id}` : ''}`,
    prepare: () => command({ action: 'prepare-payment', claimId: claim.id, legId: leg?.id, confirmRefundAndDisputeReview: sponsorReviewConfirmed }),
    reconcile: txHash => command({ action: 'reconcile', claimId: claim.id, legId: leg?.id, txHash }),
    isPaid: next => {
      const updated = next.claims.find(c => c.id === claim.id);
      return leg ? updated?.legs.find(item => item.id === leg.id)?.status === 'paid' : updated?.status === 'paid';
    } });
}
// Sends one frozen gift award (campaign.giftAwards entry) from the campaign's fund in its currency.
export async function sendCampaignGift({ campaign, award, snapshot, command, status, storage = localStorage }) {
  const w = await wallet();
  if (!isAdminWallet(w.address)) throw new Error('Connect the admin wallet');
  if (award.status !== 'approved') throw new Error('Gift payment is pending; reconcile it or release its preparation after wallet-history review');
  const target = { campaignId: campaign.id, giftId: award.id, wallet: award.wallet };
  await enablePromotionRecipient({ claim: { wallet: award.wallet, status: 'approved' }, snapshot, status });
  await routerPayout({ w, routerAddress: snapshot.routerAddress, fund: campaign.fund, asset: campaignAsset(campaign),
    recipientWallet: award.wallet, amountUnits: award.amountUnits, storage, status,
    reference: promotionWorkReference({ campaignId: campaign.id, wallet: award.wallet }, award.id),
    key: `decentbusking:promotion-gift:${campaign.id}:${award.id}:${award.wallet}`,
    prepare: () => command({ action: 'prepare-gift', ...target }),
    reconcile: txHash => command({ action: 'reconcile-gift', ...target, txHash }),
    isPaid: next => next.campaigns.find(c => c.id === campaign.id)?.giftAwards
      ?.find(item => item.id === award.id && item.wallet === award.wallet)?.status === 'paid' });
}
export async function reconcileCampaignGift({ campaign, award, command, storage = localStorage, txHash = '' }) {
  const key = `decentbusking:promotion-gift:${campaign.id}:${award.id}:${award.wallet}`;
  const entry = storage.getItem(key);
  let journal = null;
  if (entry) {
    try { journal = JSON.parse(entry); }
    catch { throw new Error('Gift payment journal is invalid; inspect wallet history before proceeding'); }
  }
  const hash = String(txHash || journal?.hash || award.txHash || '').trim();
  if (!hash) throw new Error('Enter the transaction hash or confirm no payment was broadcast');
  const result = await command({ action: 'reconcile-gift', campaignId: campaign.id, giftId: award.id,
    wallet: award.wallet, txHash: hash });
  const updated = result.campaigns?.find(item => item.id === campaign.id)?.giftAwards
    ?.find(item => item.id === award.id && item.wallet === award.wallet);
  if (updated?.status === 'paid' || updated?.lastRevertedHash === hash.toLowerCase()) storage.removeItem(key);
  return result;
}
export async function releaseCampaignGiftPreparation({ campaign, award, command, storage = localStorage, reason }) {
  if (!reason?.trim()) throw new Error('Record why wallet history confirms no gift payment was broadcast');
  const result = await command({ action: 'release-gift-preparation', campaignId: campaign.id, giftId: award.id,
    wallet: award.wallet, confirmNoBroadcast: true, reason: reason.trim() });
  storage.removeItem(`decentbusking:promotion-gift:${campaign.id}:${award.id}:${award.wallet}`);
  return result;
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

let promotionEditorDialog = null;

export function openPromotionCalendarEditor({ startsAt, endsAt, campaignId } = {}) {
  if (promotionEditorDialog?.open) return;
  promotionEditorDialog = document.createElement('dialog');
  promotionEditorDialog.className = 'promotion-calendar-editor-dialog promotion-dialog';
  promotionEditorDialog.setAttribute('aria-label', campaignId ? 'Referral campaign details' : 'Create referral campaign');
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.className = 'promotion-calendar-editor-close';
  const body = document.createElement('div');
  promotionEditorDialog.append(close, body);
  document.body.append(promotionEditorDialog);
  close.addEventListener('click', () => promotionEditorDialog.close());
  promotionEditorDialog.addEventListener('close', () => {
    promotionEditorDialog.remove();
    promotionEditorDialog = null;
  }, { once: true });
  mountAdminPromotions(body, { startsAt, endsAt, campaignId, calendarMode: true });
  promotionEditorDialog.showModal();
}

export function mountAdminPromotions(root, calendarOptions = {}) {
  if (!root) return;
  let state;
  let busy = false;
  let generation = 0;
  let editId = '';
  root.innerHTML = `${calendarOptions.calendarMode ? '' : '<summary>Invites &amp; Promotions</summary>'}
    <p>${termsNotice}</p>
    <p>Create/deposit into <strong>Promotionals (${PROMOTIONS_FUND})</strong> in Payroll → Settlements Router. No funds are created or moved here automatically.</p>
    <button type="button" data-promo-unlock>Unlock / refresh promotions</button>
    <p role="status" data-promo-status></p><div data-promo-funding></div>
    <div data-promo-workspace hidden>
      <details ${calendarOptions.calendarMode && !calendarOptions.campaignId ? 'open' : ''}><summary>Create or edit a draft</summary>
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
          <div data-promo-referral>
            ${field('requiredReferrals', 'Required qualified referrals (2–100)', 'number', '2')}
            <label>Referral activity window<select name="activityWindow">${PROMOTION_ACTIVITY_WINDOWS.map(w => `<option value="${w.id}">${escape(w.label)}</option>`).join('')}</select></label>
          </div>
          <div data-promo-curated>
            <label>Curated referrers (wallets or ENS, one per line)<textarea name="curatedReferrers" maxlength="4000" placeholder="jose.eth&#10;0x…"></textarea></label>
          </div>
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
      ['[data-promo-referral]', input('template').value === 'referral'],
      ['[data-promo-curated]', ['referral', 'musician-referral'].includes(input('template').value)],
      ['[data-promo-sponsor-terms]', input('template').value === 'sponsor'],
      ['[data-promo-match-terms]', input('template').value === 'sponsor-match'],
    ]) {
      const section = root.querySelector(selector);
      section.hidden = !active;
      section.querySelectorAll('input, select, textarea').forEach(el => { el.disabled = !active; });
    }
  }
  function template() {
    const t = PROMOTION_TEMPLATES.find(t => t.id === input('template').value);
    input('title').value = t.title;
    input('criteria').value = t.criteria;
    input('terms').value = 'One award per participant. No self-referrals or reward stacking. Admin reviews identity, rights, evidence and disputes before approval. No guaranteed payout. Only wallet-signed song votes recorded through this promotion qualify as activity. No positive-vote requirement. All promotion records, evidence, referral links and review notes are public on IPFS; copies may persist permanently. Do not submit secrets or personal information about others.';
    if (t.id === MUSICIAN_REFERRAL_PILOT.template) {
      input('reward').value = '25';
      input('budget').value = '150';
      input('maxAwards').value = '6';
      input('terms').value = MUSICIAN_REFERRAL_TERMS;
    }
    templateFields();
  }
  function reset() {
    editId = '';
    form.reset();
    if (calendarOptions.calendarMode) input('template').value = MUSICIAN_REFERRAL_PILOT.template;
    template();
    input('startsAt').value = utcToNewYorkInput(new Date().toISOString());
    input('endsAt').value = utcToNewYorkInput(new Date(Date.now() + 7 * 86400000).toISOString());
    input('claimDeadline').value = utcToNewYorkInput(new Date(Date.now() + 14 * 86400000).toISOString());
    if (calendarOptions.startsAt) input('startsAt').value = utcToNewYorkInput(calendarOptions.startsAt);
    if (calendarOptions.endsAt) input('endsAt').value = utcToNewYorkInput(calendarOptions.endsAt);
    if (calendarOptions.endsAt) input('claimDeadline').value = utcToNewYorkInput(calendarOptions.endsAt);
  }
  function render() {
    root.querySelector('[data-promo-workspace]').hidden = false;
    root.querySelector('[data-promo-funding]').textContent = state.storageError ||
      `${state.funds.map(f => `${f.slug}: ${f.error || money(f.balanceUnits)}`).join(' · ')}. Campaign reservations are service accounting, not on-chain escrow.`;
    const campaigns = calendarOptions.campaignId
      ? state.campaigns.filter(c => c.id === calendarOptions.campaignId)
      : state.campaigns;
    root.querySelector('[data-promo-campaigns]').innerHTML = campaigns.map(c => `<article class="promotion-card" data-campaign="${c.id}">
      ${campaignCard(c)}<p>Budget: ${money(c.budgetUnits)} · remaining: ${money(c.remainingUnits)} · committed: ${money(c.committedUnits)}</p>
      <p>Approved: ${money(c.approvedUnits)} · payment pending: ${money(c.paymentPendingUnits)} · paid: ${money(c.paidUnits)} · ${c.applications} claims (${c.awaitingReview} awaiting review)</p>
      <button type="button" data-promo-edit>${c.status === 'draft' ? 'Edit draft' : 'Duplicate as draft'}</button>
      <button type="button" data-promo-share>Copy offer link</button>
      ${({ draft: ['published', 'archived'], published: ['paused', 'closed'], paused: ['published', 'closed'], closed: ['archived'], archived: [] }[c.status])
        .map(s => `<button type="button" data-promo-state="${s}">${{ published: 'Publish offer', paused: 'Pause offer', closed: 'Close offer', archived: 'Archive' }[s]}</button>`).join('')}
      ${c.announcement?.status === 'sent' ? `<p>Discord poster sent: <a href="${escape(c.announcement.messageUrl)}" target="_blank" rel="noopener">view message</a></p>` : ''}
      ${c.announcement?.status === 'pending' ? '<p>Discord delivery is uncertain; do not send again.</p><button type="button" data-promo-reconcile-discord>Reconcile Discord delivery</button>' : ''}
      ${c.template === 'musician-referral' ? `<details ${calendarOptions.campaignId ? 'open' : ''}><summary>Curate referrer / amend pilot</summary>
        <label>Curated referrer wallet or ENS<input data-promo-curated-ref maxlength="255"></label>
        <label>Reason<input data-promo-curated-reason maxlength="2000"></label>
        <button type="button" data-promo-curate>Record curated referrer</button>
        <label>Top-up (USDC, optional)<input data-promo-topup type="number" min="0.000001" step="0.000001"></label>
        ${field('amendedEnd', 'Extend end (New York, optional)', 'datetime-local')}
        ${field('amendedClaim', 'Extend claim date (New York, optional)', 'datetime-local')}
        <label>Immutable amendment reason<input data-promo-amend-reason maxlength="2000"></label>
        <button type="button" data-promo-amend>Record explicit amendment</button>
      </details>` : ''}
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
    root.querySelector('[data-promo-claims]').innerHTML = state.claims
      .filter(c => !calendarOptions.campaignId || c.campaignId === calendarOptions.campaignId).map(c => `<article class="promotion-card" data-claim="${c.id}">
      <h4>${escape(state.campaigns.find(p => p.id === c.campaignId)?.title || c.campaignId)}</h4>
      <p>${escape(c.wallet)} · ${money(c.amountUnits)} · ${escape(c.fund)} · <strong>${escape(c.status)}</strong></p>
      <p class="promotion-terms">${escape(c.evidence)}</p>
      ${c.subjectWallet ? `<p>Musician helped: ${escape(c.subjectWallet)}</p>` : ''}
      ${c.legs ? `<ul>${c.legs.map(leg => `<li>${escape(leg.id)} · ${money(leg.amountUnits)} · ${escape(leg.status)}${leg.recipient ? ` · ${escape(leg.recipient)}` : ` · ${escape(leg.fund)}`}${leg.txHash ? ` · <a href="https://basescan.org/tx/${escape(leg.txHash)}" target="_blank" rel="noopener">receipt</a>` : ''}
        ${leg.kind === 'wallet' && leg.status === 'approved' ? `<button type="button" data-promo-leg-enable="${escape(leg.id)}">Enable recipient</button><button type="button" data-promo-leg-pay="${escape(leg.id)}">Pay this leg</button>` : ''}
        ${leg.kind === 'wallet' && leg.status === 'payment-pending' ? `<label>Leg transaction hash<input data-promo-leg-hash="${escape(leg.id)}" value="${escape(leg.txHash || '')}"></label><button type="button" data-promo-leg-reconcile="${escape(leg.id)}">Reconcile this leg</button><button type="button" data-promo-leg-release="${escape(leg.id)}">Review unbroadcast leg preparation</button>` : ''}
        ${leg.kind === 'funding-needed' && leg.status !== 'paid' ? `<span> · Funding needed; transfer this exact $5 allocation separately.</span><label>Fund deposit transaction hash<input data-promo-leg-hash="${escape(leg.id)}" value="${escape(leg.txHash || '')}"></label><button type="button" data-promo-leg-funding="${escape(leg.id)}">Verify fund deposit</button>` : ''}</li>`).join('')}</ul>` : ''}
      ${c.qualification?.activity ? `<p>Referral evidence · ${escape(c.qualification.window)} · assessment week ${escape(c.qualification.week)}</p><ul>
        ${c.qualification.activity.map(v => `<li>${escape(v.wallet)} · play ${escape(v.playId)} · ${escape(v.at)} · ${escape(v.week)}</li>`).join('')}</ul>`
      : c.qualification ? `<p>${escape(JSON.stringify(c.qualification))}</p>` : ''}
      ${c.purchaseHash ? `<a href="https://basescan.org/tx/${escape(c.purchaseHash)}" target="_blank" rel="noopener">DVert purchase proof</a>` : ''}
      ${c.history.map(h => `<p>${escape(h.at)} · ${escape(h.reviewer)} · ${escape(h.action)}: ${escape(h.reason)}</p>`).join('')}
      <label>Review note (required)<input data-promo-reason maxlength="2000"></label>
      ${state.campaigns.find(p => p.id === c.campaignId)?.template === 'sponsor' ? `
        <label><input type="checkbox" data-promo-new-advertiser> New advertiser reviewed</label>
        <label><input type="checkbox" data-promo-refund-reviewed> Refund and attribution dispute policy reviewed</label>` : ''}
      ${['submitted', 'needs-evidence'].includes(c.status) ? ['approved', 'needs-evidence', 'rejected'].map(s =>
        `<button type="button" data-promo-review="${s}">${{ approved: 'Approve & reserve reward', 'needs-evidence': 'Request more evidence', rejected: 'Reject' }[s]}</button>`).join('') : ''}
      ${c.status === 'approved' ? `<button type="button" data-promo-review="rejected">Reject approved claim</button>${c.legs ? '' : '<button type="button" data-promo-enable>Enable recipient on router</button><button type="button" data-promo-pay>Pay approved reward</button>'}` : ''}
      ${c.status === 'payment-pending' && !c.txHash && !c.legs ? '<button type="button" data-promo-release>Review unbroadcast preparation</button>' : ''}
      ${!c.legs && ['approved', 'payment-pending'].includes(c.status) ? `<label>Payment transaction hash<input data-promo-hash value="${escape(c.txHash || '')}"></label>
        <button type="button" data-promo-reconcile>Reconcile payment</button>` : ''}
      ${c.status === 'paid' && !c.legs ? `<a href="https://basescan.org/tx/${escape(c.txHash)}" target="_blank" rel="noopener">Confirmed payment</a>` : ''}
    </article>`).join('') || '<p>No participant claims.</p>';
    root.querySelector('[data-promo-members]').innerHTML = state.members
      .filter(m => !calendarOptions.campaignId || m.campaignId === calendarOptions.campaignId).map(m => `<article class="promotion-card" data-member="${escape(m.wallet)}" data-member-campaign="${escape(m.campaignId)}">
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
        curatedReferrers: await (async () => {
          const values = String(input('curatedReferrers').value || '').split(/[\n,]/)
            .map(value => value.trim()).filter(Boolean);
          if (!values.length) return [];
          const provider = (await wallet()).provider;
          return Promise.all(values.map(value => resolvedWallet(value, provider)));
        })(),
        ...(input('template').value === 'album' ? { minOriginalTracks: Number(input('minOriginalTracks').value) } : {}),
        ...(input('template').value === 'referral' ? { requiredReferrals: Number(input('requiredReferrals').value),
          activityWindow: input('activityWindow').value } : {}),
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
        if (target.matches('[data-promo-curate]')) {
          const card = target.closest('[data-campaign]');
          const w = await wallet();
          return command({ action: 'curate-referrer', campaignId: campaign.id,
            referrer: await resolvedWallet(card.querySelector('[data-promo-curated-ref]').value, w.provider),
            reason: card.querySelector('[data-promo-curated-reason]').value });
        }
        if (target.matches('[data-promo-amend]')) {
          const card = target.closest('[data-campaign]');
          const topup = card.querySelector('[data-promo-topup]').value;
          const ending = card.querySelector('[name="amendedEnd"]').value;
          const deadline = card.querySelector('[name="amendedClaim"]').value;
          return command({ action: 'amend', campaignId: campaign.id,
            budgetIncreaseUnits: topup ? promotionUnits(topup) : '0',
            endsAt: ending ? promotionInputToUtc(ending) : campaign.endsAt,
            claimDeadline: deadline ? promotionInputToUtc(deadline) : campaign.claimDeadline,
            reason: card.querySelector('[data-promo-amend-reason]').value });
        }
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
          if (campaign.template === 'musician-referral' && campaign.status !== 'draft') input('budget').value = '150';
          if (campaign.minOriginalTracks) input('minOriginalTracks').value = campaign.minOriginalTracks;
          if (campaign.requiredReferrals) input('requiredReferrals').value = campaign.requiredReferrals;
          if (campaign.activityWindow) input('activityWindow').value = campaign.activityWindow;
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
      const legId = target.dataset.promoLegEnable || target.dataset.promoLegPay || target.dataset.promoLegReconcile ||
        target.dataset.promoLegRelease || target.dataset.promoLegFunding;
      const leg = claim.legs?.find(item => item.id === legId);
      if (leg && target.dataset.promoLegEnable) return enablePromotionRecipient({
        claim: { ...claim, wallet: leg.recipient, status: leg.status, amountUnits: leg.amountUnits }, snapshot: state, status });
      if (leg && target.dataset.promoLegPay) return payPromotion({ claim, leg, snapshot: state, command, status });
      if (leg && target.dataset.promoLegReconcile) {
        const hash = card.querySelector(`[data-promo-leg-hash="${leg.id}"]`).value;
        const result = await command({ action: 'reconcile', claimId: claim.id, legId: leg.id, txHash: hash });
        const updated = result.claims.find(item => item.id === claim.id)?.legs.find(item => item.id === leg.id);
        if (updated && !['payment-pending', 'pending'].includes(updated.status)) {
          localStorage.removeItem(`decentbusking:promotion-payment:${claim.id}:${leg.id}`);
        }
        return result;
      }
      if (leg && target.dataset.promoLegRelease) {
        if (!confirm('Inspect the owner wallet history. Confirm only if no payment transaction was broadcast.')) return;
        const reason = prompt('Record why this leg was not broadcast:');
        if (!reason?.trim()) return;
        const result = await command({ action: 'release-payment-preparation', claimId: claim.id, legId: leg.id,
          confirmNoBroadcast: true, reason });
        localStorage.removeItem(`decentbusking:promotion-payment:${claim.id}:${leg.id}`);
        return result;
      }
      if (leg && target.dataset.promoLegFunding) {
        const hash = card.querySelector(`[data-promo-leg-hash="${leg.id}"]`).value;
        return command({ action: 'reconcile-funding-leg', claimId: claim.id, legId: leg.id, txHash: hash });
      }
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
    <div data-promo-public-records></div>
    <p>Close this panel to use the radio; choose Return to promotion to come back.</p>
    <button type="button" data-promo-connect>Connect wallet</button>
    <button type="button" data-promo-refresh>Refresh offer</button>
    <button type="button" data-promo-mine>My participation (wallet signature)</button>
    <div data-promo-member hidden>
      <p data-promo-activity></p>
      <label>Invited by (wallet, optional; fixed at registration)<input data-promo-ref value="${escape(params.get('ref') || '')}"></label>
      <label><input type="checkbox" data-promo-accept> I accept the displayed offer terms and public IPFS publication of my wallet, referral links, evidence, activity and reviews. I will not submit secrets or personal information about others.</label>
      <button type="button" data-promo-join>Register for this offer</button>
      <button type="button" data-promo-correct-mine>Correct my campaign referrer</button>
      <button type="button" data-promo-invite>Copy my referral invite</button>
      <p>With your wallet connected, 👍/👎 on the radio bar count automatically after one free sign-in (valid 7 days). Both directions qualify; anonymous past votes cannot be attributed retroactively. These buttons are a fallback that signs each vote.</p>
      <button type="button" data-promo-vote="1">Vote up on current song</button>
      <button type="button" data-promo-vote="-1">Vote down on current song</button>
      <form data-promo-claim>
        <label>Public evidence / catalog or event references (no secrets or others' personal information)<textarea name="evidence" maxlength="2000" required></textarea></label>
        <div data-promo-sponsor hidden>
          ${field('purchaser', 'Advert purchaser wallet')}
          ${field('advertId', 'DVert campaign ID')}
          ${field('purchaseHash', 'Confirmed campaign purchase transaction')}
        </div>
        <div data-promo-buddy hidden>${field('subjectWallet', 'Musician helped (different wallet)')}</div>
        <div data-promo-musician hidden>${field('musicianWallet', 'Referred musician wallet (server checks playlist mint evidence)')}</div>
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
  let participantState;
  let busy = false;
  let generation = 0;
  function render() {
    const campaign = state?.campaigns.find(c => c.id === campaignId && !['draft', 'archived'].includes(c.status));
    overlay.querySelector('[data-promo-offer]').innerHTML = campaign ? campaignCard(campaign) : '<p>This offer is not published or does not exist.</p>';
    overlay.querySelector('[data-promo-public-records]').innerHTML = publicPromotionRecords(state, campaignId);
    memberPanel.hidden = !participantState || !campaign;
    if (!participantState || !campaign) return;
    const member = participantState.members.find(m => m.campaignId === campaignId && m.wallet === participantState.viewerWallet);
    const activity = participantState.participation.find(item => item.campaignId === campaignId);
    overlay.querySelector('[data-promo-activity]').textContent = member
      ? `Registered · ${activity.week} · ${activity.voted ? 'Song vote recorded this week' : 'No song vote recorded this week'} · Referrals for this offer: ${activity.registered} registered, ${activity.activeThisWeek} active this week, ${activity.activeDuringOffer} active during this offer`
      : 'Not registered for this offer.';
    const stats = participantState.participantStats?.find(item => item.campaignId === campaignId);
    if (stats) {
      overlay.querySelector('[data-promo-activity]').textContent += ` · Qualified ${stats.qualifiedCount}; pending ${money(stats.pendingUnits)}; approved ${money(stats.approvedUnits)}; paid ${money(stats.paidUnits)}; maximum referrer earnings ${money(stats.maxEarningsUnits)}. ${stats.attributedMusicians.length} attributed musicians; curated referrers: ${stats.referrers.join(', ') || 'none'}. Supporter token: ${stats.supporterToken.eligible ? (stats.supporterToken.delivery === 'delivered' ? 'delivered' : 'earned; queued for delivery') : 'not yet earned'}.`;
      const progress = document.createElement('ul');
      progress.innerHTML = stats.referred.map(item => `<li>${escape(item.wallet)} · votes ${item.voteProgress}/10 · ${escape(item.trackState)}${item.track ? ` · token #${escape(item.track.tokenId)}` : ''}</li>`).join('');
      let holder = overlay.querySelector('[data-promo-progress]');
      if (!holder) { holder = document.createElement('div'); holder.dataset.promoProgress = ''; memberPanel.append(holder); }
      holder.replaceChildren(progress);
    }
    overlay.querySelector('[data-promo-ref]').disabled = !!member && campaign.template !== 'musician-referral';
    overlay.querySelector('[data-promo-join]').disabled = !!member;
    const sponsor = overlay.querySelector('[data-promo-sponsor]');
    sponsor.hidden = campaign.template !== 'sponsor';
    sponsor.querySelectorAll('input').forEach(el => { el.required = !sponsor.hidden; el.disabled = sponsor.hidden; });
    const buddy = overlay.querySelector('[data-promo-buddy]');
    buddy.hidden = campaign.template !== 'buddy';
    buddy.querySelectorAll('input').forEach(el => { el.required = !buddy.hidden; el.disabled = buddy.hidden; });
    const musician = overlay.querySelector('[data-promo-musician]');
    musician.hidden = campaign.template !== 'musician-referral';
    musician.querySelectorAll('input').forEach(el => { el.required = !musician.hidden; el.disabled = musician.hidden; });
    const claims = participantState.claims.filter(c => c.campaignId === campaignId && c.wallet === participantState.viewerWallet);
    overlay.querySelector('[data-promo-my-claims]').innerHTML = claims.map(c => `<p>${escape(c.status)} · ${money(c.amountUnits)}</p>
      ${(c.legs || []).map(leg => `<p>${escape(leg.id)} · ${money(leg.amountUnits)} · ${escape(leg.status)}${leg.kind === 'funding-needed' ? ' · settlement funding needed, not paid' : leg.txHash ? ` · <a href="https://basescan.org/tx/${escape(leg.txHash)}">receipt</a>` : ''}</p>`).join('')}
      ${c.history.map(h => `<p>${escape(h.action)}: ${escape(h.reason)}</p>`).join('')}
      ${c.status === 'needs-evidence' ? `<button type="button" data-promo-evidence="${c.id}">Update evidence from the form above</button>` : ''}
      ${c.status === 'paid' && !c.legs ? `<a href="https://basescan.org/tx/${escape(c.txHash)}">Payment proof</a>` : ''}`).join('');
  }
  async function command(c) {
    participantState = await signed({ ...c, campaignId });
    state = participantState;
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
        const entered = overlay.querySelector('[data-promo-ref]').value.trim();
        const referrer = entered ? await resolvedWallet(entered, (await wallet()).provider) : '';
        return command({ action: 'join', referrer,
          acceptTerms: true, termsVersion: campaign?.version });
      }
      if (target.matches('[data-promo-correct-mine]')) {
        const campaign = state?.campaigns.find(c => c.id === campaignId);
        if (campaign?.template !== 'musician-referral') throw new Error('Retroactive self-correction is only available for the musician pilot');
        const w = await wallet();
        const entered = overlay.querySelector('[data-promo-ref]').value.trim();
        const referrer = entered ? await resolvedWallet(entered, w.provider) : '';
        const reason = prompt('Why should your campaign referrer be corrected? This public audit note is immutable.');
        if (!reason?.trim()) throw new Error('An attribution correction reason is required');
        return command({ action: 'correct-my-attribution', referrer, reason });
      }
      if (target.matches('[data-promo-invite]')) {
        const w = await wallet();
        if (!participantState?.members.some(m => m.campaignId === campaignId && m.wallet === w.address.toLowerCase())) throw new Error('Register first');
        return navigator.clipboard.writeText(promotionLink(campaignId, w.address));
      }
      if (target.dataset.promoVote) {
        const response = await fetch(`${service()}/api/radio`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('Radio is unavailable');
        const radio = await response.json();
        const audible = radio.publicBroadcast?.selected ? getAudibleBroadcast() : null;
        const nowPlaying = audible?.program || radio.nowPlaying;
        if (!nowPlaying || nowPlaying.isDevert) throw new Error('Wait for a song, not an advert');
        const campaign = state?.campaigns.find(item => item.id === campaignId);
        return command({ action: 'vote', playId: nowPlaying.playId, voterId: radioListenerId(localStorage),
          vote: Number(target.dataset.promoVote),
          ...(campaign?.template === 'musician-referral' ? { subjectWallet: (await wallet()).address } : {}) });
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
    participantState = null;
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
