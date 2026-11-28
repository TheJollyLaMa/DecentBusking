import { PINNER_CAMPAIGN_FUND, PINNER_CAMPAIGN_VERSION, PROMOTIONS_USDC, PROMOTION_TEMPLATES, CAMPAIGN_ASSETS, campaignAsset,
  formatAssetUnits, parseAssetAmount, pinnerCampaignAmounts, pinnerCampaignFullDays, pinnerDefaultQualifyingDays,
  pinnerCampaignTerms, PINNER_DEFAULT_DAY_SHARE } from './promotions.mjs?v=20261129-pinner-uniform';
import { cachedEthUsd, loadEthUsd, weiToUsdText } from './eth-usd-quote.mjs?v=20261126-eth-gifts';
import { newYorkInputToUtc, utcToNewYorkInput } from './radio-calendar.mjs';
import { isAdminWallet } from './admin-access.mjs';
import { getBaseReadProvider } from './base-chain.mjs';
import { depositSettlementUsdc } from './settlement-funds.mjs';
import { loadSupporterInventory } from './supporter-inventory.mjs?v=20261129-pinner-fund-load';
import { fetchPromotionsState, signedPromotionCommand, promotionWallet, readCampaignFund,
  prepareSettlementFund } from './promotions-ui.mjs?v=20261129-pinner-uniform';
import { convertCampaignUnits } from './referral-campaign-editor.mjs?v=20261126-eth-gifts';

const DAY = 86400000;
const ROUTER = '0x8ecca903e2a6Daa8CCbB933700e4F2C58C44A4B5';
const ROUTER_ABI = ['function fundNative(bytes32) payable', 'function fundToken(bytes32,address,uint256)',
  'function approvedAssets(address) view returns(bool)'];
const TOKEN_ABI = ['function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)', 'function approve(address,uint256) returns(bool)'];
const RESERVING = ['published', 'paused', 'closed'];
const when = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
let openDialog = null;

export function pinnerEditorValues({ campaign = null, source = null, startsAt } = {}) {
  const base = campaign || source || {};
  const span = source ? Date.parse(source.endsAt) - Date.parse(source.startsAt) : 7 * DAY;
  const grace = base.claimDeadline && base.endsAt ? Math.max(0, Date.parse(base.claimDeadline) - Date.parse(base.endsAt)) : 7 * DAY;
  const start = campaign ? campaign.startsAt
    : new Date(Math.max(Date.parse(startsAt || Date.now()), Math.ceil(Date.now() / 900000) * 900000)).toISOString();
  const end = campaign ? campaign.endsAt : new Date(Date.parse(start) + (span > 0 ? span : 7 * DAY)).toISOString();
  const asset = base.asset === 'usdc' ? 'usdc' : 'eth';
  const suggested = pinnerDefaultQualifyingDays(start, end);
  const saved = Number(base.qualifyingDays);
  const keep = Number.isSafeInteger(saved) && saved >= 1 && saved <= pinnerFullDays(start, end) && (campaign || saved !== 30);
  return {
    id: campaign?.status === 'draft' ? campaign.id : '',
    title: base.title || 'Pin Reward Campaign',
    startsAt: start, endsAt: end,
    claimDeadline: campaign?.claimDeadline || new Date(Date.parse(end) + grace).toISOString(),
    claimGraceMs: grace,
    qualifyingDays: keep ? saved : suggested,
    daysTouched: !!keep && saved !== suggested,
    maxAwards: Number(base.maxAwards) || 5,
    asset,
    rewardUnits: base.rewardUnits && base.qualificationVersion === PINNER_CAMPAIGN_VERSION ? String(base.rewardUnits)
      : asset === 'eth' ? '2000000000000000' : '5000000',
    supporter: base.supporterRewards?.[0] ? { ...base.supporterRewards[0] } : null,
  };
}
function pinnerFullDays(startsAt, endsAt) {
  try { return pinnerCampaignFullDays(startsAt, endsAt); } catch { return 0; }
}

export function pinnerCampaignPayload(values) {
  const full = pinnerFullDays(values.startsAt, values.endsAt);
  if (!(Date.parse(values.startsAt) < Date.parse(values.endsAt))) throw new Error('End must be after start');
  if (!full) throw new Error('The timebox needs at least one full New York day');
  if (!Number.isSafeInteger(values.qualifyingDays) || values.qualifyingDays < 1 || values.qualifyingDays > full) {
    throw new Error(`Required days must be 1–${full} for this timebox`);
  }
  if (Date.parse(values.claimDeadline) < Date.parse(values.endsAt)) throw new Error('Claims must close on or after the end');
  const amounts = pinnerCampaignAmounts(values.rewardUnits, values.maxAwards, values.asset);
  const template = PROMOTION_TEMPLATES.find(item => item.id === 'pinner');
  const campaign = { template: 'pinner', title: String(values.title || '').trim() || template.title, criteria: template.criteria,
    ...amounts, maxAwards: values.maxAwards, fund: PINNER_CAMPAIGN_FUND, asset: values.asset === 'usdc' ? 'usdc' : 'eth',
    qualificationVersion: PINNER_CAMPAIGN_VERSION, qualifyingDays: values.qualifyingDays,
    supporterRewards: values.supporter ? [{ chainId: 8453, contract: values.supporter.contract, tokenId: String(values.supporter.tokenId), quantity: 1 }] : [],
    curatedReferrers: [], startsAt: values.startsAt, endsAt: values.endsAt, claimDeadline: values.claimDeadline };
  return { ...campaign, terms: pinnerCampaignTerms(campaign) };
}

// Free balance in the pinner campaign fund for one asset after other live campaigns' unpaid budgets.
export function pinnerFundAvailability({ balanceUnits, campaigns = [], campaignId = '', asset = 'eth', needUnits = 0n }) {
  const others = campaigns.filter(c => c.fund === PINNER_CAMPAIGN_FUND && c.id !== campaignId &&
      campaignAsset(c).id === asset && RESERVING.includes(c.status))
    .reduce((sum, c) => sum + BigInt(c.budgetUnits || 0) - BigInt(c.paidUnits || 0), 0n);
  const balance = BigInt(balanceUnits || 0);
  const free = balance > others ? balance - others : 0n;
  const need = BigInt(needUnits);
  return { balance, others, free, shortfall: need > free ? need - free : 0n };
}

// The single progressive action: create the fund, then fund any shortfall and activate, or just sign and activate.
export function pinnerNextStep({ valid = true, workerReady = true, fund = null, shortfallUnits = 0n, money = String }) {
  if (!valid) return { step: 'blocked', label: '▶ Activate' };
  if (!workerReady) return { step: 'blocked', label: '▶ Activate' };
  if (!fund) return { step: 'blocked', label: '⏳ Checking fund…' };
  if (fund.error) return { step: 'blocked', label: '▶ Activate' };
  if (!fund.exists) return { step: 'create', label: `⚸ Create ${PINNER_CAMPAIGN_FUND}` };
  if (!fund.active) return { step: 'restore', label: `⚸ Restore ${PINNER_CAMPAIGN_FUND}` };
  if (shortfallUnits > 0n) return { step: 'fund', label: `▶ Fund ${money(shortfallUnits)} & Activate` };
  return { step: 'activate', label: '▶ Sign & Activate' };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function pill(text, label, onClick) {
  const button = el('button', 'rc-pill', text);
  button.type = 'button';
  if (label) { button.setAttribute('aria-label', label); button.title = label; }
  if (onClick) button.addEventListener('click', onClick);
  return button;
}

export function openPinnerCampaignEditor({ campaign = null, source = null, startsAt, anchor = null } = {}) {
  if (openDialog?.open) openDialog.close();
  const values = pinnerEditorValues({ campaign, source, startsAt });
  let savedSnapshot = values.id ? JSON.stringify(safePayload()) : '';
  let rate = cachedEthUsd();
  let fund = null, fundRead = 0, features = null, campaigns = [], supporters = null, busy = false;
  const asset = () => CAMPAIGN_ASSETS[values.asset];
  const money = units => formatAssetUnits(units, asset());
  const usd = units => values.asset === 'eth' ? weiToUsdText(units, rate) : '';
  const both = units => usd(units) ? `${money(units)} (${usd(units)})` : money(units);
  const budgetUnits = () => { try { return BigInt(pinnerCampaignAmounts(values.rewardUnits, values.maxAwards, values.asset).budgetUnits); } catch { return 0n; } };
  const full = () => pinnerFullDays(values.startsAt, values.endsAt);
  function safePayload() { try { return pinnerCampaignPayload(values); } catch { return null; } }

  const dialog = el('dialog', 'referral-blob pinner-blob');
  dialog.setAttribute('aria-label', 'Pin Reward Campaign');
  openDialog = dialog;
  const header = el('header', 'rc-head');
  const heading = el('h3', 'rc-title', values.title);
  const info = el('p', 'rc-info');
  info.hidden = true;
  info.append(
    el('span', 'rc-info-line', '1 · Pick the timebox. Pinners register, then keep the community catalogue pinned on their own checked IPFS node.'),
    el('span', 'rc-info-line', `2 · Each full New York day counts when the node passes 90% of at least 20 independent spot checks. The required days default to ${Math.round(PINNER_DEFAULT_DAY_SHARE * 100)}% of the campaign's full days; days need not be consecutive.`),
    el('span', 'rc-info-line', '3 · The first finishers, up to the award cap, earn the fixed ETH or USDC bonus plus any Supporter NFT, paid through Payroll after review.'),
    el('span', 'rc-info-line', `4 · Bonuses come from ${PINNER_CAMPAIGN_FUND}, separate from the weekly dbusk-pinners USDC share every pinner already earns.`),
    el('span', 'rc-info-line', '5 · One button walks the setup: create the fund once → deposit any shortfall → sign to activate. The fund is earmarked and admin-recoverable, not escrow.'));
  header.append(el('span', 'rc-badge', '📌'), heading, pill('ⓘ', 'How it works', () => { info.hidden = !info.hidden; }),
    pill('✕', 'Close', () => dialog.close()));
  const rows = el('div', 'rc-rows');
  const status = el('p', 'rc-status');
  status.setAttribute('role', 'status');
  const say = (text = '', tone = '') => { status.textContent = text; status.dataset.tone = tone; };

  function row(icon, label, summary, editor) {
    const wrap = el('div', 'rc-row');
    const head = el('button', 'rc-summary');
    head.type = 'button';
    head.setAttribute('aria-label', label);
    head.title = label;
    const value = el('span', 'rc-value');
    head.append(el('span', 'rc-icon', icon), value);
    wrap.append(head);
    const refresh = () => { value.textContent = summary(); };
    refresh();
    if (!editor) { head.disabled = true; return { wrap, refresh }; }
    const body = el('div', 'rc-edit');
    body.hidden = true;
    const done = () => { body.hidden = true; head.setAttribute('aria-expanded', 'false'); refresh(); };
    editor(body, done);
    head.setAttribute('aria-expanded', 'false');
    head.addEventListener('click', () => {
      rows.querySelectorAll('.rc-edit').forEach(other => { if (other !== body && !other.hidden) other.previousElementSibling.click(); });
      body.hidden = !body.hidden;
      head.setAttribute('aria-expanded', String(!body.hidden));
      if (body.hidden) refresh(); else body.querySelector('input,select')?.focus();
    });
    wrap.append(body);
    return { wrap, refresh };
  }
  const titleRow = row('✏️', 'Title', () => values.title, (body, done) => {
    const input = el('input');
    input.maxLength = 100; input.size = 26; input.value = values.title;
    input.setAttribute('aria-label', 'Campaign title');
    input.addEventListener('input', () => { values.title = input.value; heading.textContent = input.value || 'Pin Reward Campaign'; changed(); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); done(); } });
    body.append(input, pill('✓', 'Done', done));
  });
  const dateRow = (icon, label, key) => row(icon, label, () => when.format(new Date(values[key])), (body, done) => {
    const input = el('input');
    input.type = 'datetime-local'; input.step = 60;
    input.value = utcToNewYorkInput(values[key]);
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => {
      if (!input.value) return;
      values[key] = newYorkInputToUtc(input.value);
      if (key === 'endsAt') values.claimDeadline = new Date(Date.parse(values.endsAt) + values.claimGraceMs).toISOString();
      if (key === 'claimDeadline') values.claimGraceMs = Math.max(0, Date.parse(values.claimDeadline) - Date.parse(values.endsAt));
      if (key !== 'claimDeadline') syncDays();
      changed();
    });
    const picker = pill('📅', `Pick ${label.toLowerCase()}`, () => { try { input.showPicker(); } catch { input.focus(); } });
    picker.classList.add('rc-picker');
    body.append(picker, input, pill('✓', 'Done', done));
  });
  function syncDays() {
    const suggested = pinnerDefaultQualifyingDays(values.startsAt, values.endsAt);
    if (!values.daysTouched) values.qualifyingDays = suggested;
    else if (values.qualifyingDays > full()) values.qualifyingDays = Math.max(1, full());
    renderRequirements();
  }
  const startRow = dateRow('🟢', 'Start', 'startsAt');
  const endRow = dateRow('🏁', 'End', 'endsAt');
  let renderRequirements = () => {};
  const requirementsText = () => `${values.qualifyingDays} of ${full()} full days pinned · 90% checks/day · first ${values.maxAwards} pinners`;
  const requirementsRow = row('📌', 'Pinning requirements', requirementsText, (body, done) => {
    const days = el('input'), awards = el('input'), hint = el('p', 'rc-help');
    days.type = 'number'; days.min = 1; days.setAttribute('aria-label', 'Required qualifying days');
    awards.type = 'number'; awards.min = 1; awards.max = 1000; awards.setAttribute('aria-label', 'Award cap');
    renderRequirements = () => {
      const suggested = pinnerDefaultQualifyingDays(values.startsAt, values.endsAt);
      days.max = Math.max(1, full());
      days.value = values.qualifyingDays;
      awards.value = values.maxAwards;
      hint.textContent = `${values.qualifyingDays} of ${full()} full days ≈ ${full() ? Math.round(values.qualifyingDays / full() * 100) : 0}% · suggested ${suggested} (≥${Math.round(PINNER_DEFAULT_DAY_SHARE * 100)}%). A day counts when the node passes 90% of at least 20 independent checks.`;
    };
    days.addEventListener('input', () => { values.qualifyingDays = Number(days.value); values.daysTouched = true; renderRequirements(); changed(); });
    awards.addEventListener('input', () => { values.maxAwards = Number(awards.value); changed(); });
    const reset = pill(`↺ ${Math.round(PINNER_DEFAULT_DAY_SHARE * 100)}%`, 'Use the suggested 90% of full days', () => {
      values.daysTouched = false; syncDays(); changed();
    });
    const daysLine = el('label', 'rc-money rc-votes');
    daysLine.append(el('span', 'rc-icon', '📅'), days, el('small', 'rc-usd', 'days required'), reset);
    const awardsLine = el('label', 'rc-money rc-votes');
    awardsLine.append(el('span', 'rc-icon', '🎯'), awards, el('small', 'rc-usd', 'first finishers win'));
    body.append(daysLine, hint, awardsLine, pill('✓', 'Done', done));
    renderRequirements();
  });
  let renderGift = () => {};
  const giftText = () => {
    const token = values.supporter;
    const name = token ? supporters?.tokens?.find(t => `${t.contract}:${t.tokenId}` === `${token.contract.toLowerCase()}:${token.tokenId}`)?.name || `Supporter #${token.tokenId}` : '';
    return `${both(values.rewardUnits)} each · ${money(budgetUnits())} total${token ? ` · 🎖 ${name}` : ''}`;
  };
  const giftRow = row('🎁', 'The gift', giftText, (body, done) => {
    const picks = Object.values(CAMPAIGN_ASSETS).map(a => {
      const button = pill(`${a.icon} ${a.symbol}`, `Pay the bonus in ${a.symbol}`, () => chooseAsset(a.id));
      button.dataset.asset = a.id;
      return button;
    });
    const money_ = el('label', 'rc-money');
    const reward = el('input'), hint = el('small', 'rc-usd');
    reward.inputMode = 'decimal'; reward.size = 9;
    reward.addEventListener('input', () => {
      const units = parseAssetAmount(reward.value, asset());
      reward.classList.toggle('is-bad', !units || BigInt(units) <= 0n);
      if (units && BigInt(units) > 0n) values.rewardUnits = units;
      hint.textContent = usd(values.rewardUnits);
      changed();
    });
    const symbol = el('span', 'rc-dollar');
    money_.append(el('small', 'rc-field-name', 'Bonus per finisher'), symbol, reward, hint);
    const select = el('select');
    select.setAttribute('aria-label', 'Supporter NFT gift');
    select.addEventListener('change', () => {
      const [contract, tokenId] = select.value.split(':');
      values.supporter = contract ? { chainId: 8453, contract, tokenId, quantity: 1 } : null;
      renderGift(); changed();
    });
    const stock = el('p', 'rc-help');
    const manual = el('details', 'promotion-manual-nft');
    const contract = el('input'), tokenId = el('input');
    contract.placeholder = 'Base ERC-1155 contract 0x…'; tokenId.placeholder = 'Token ID'; tokenId.inputMode = 'numeric';
    const useManual = pill('＋ Use', 'Use this ERC-1155 token', () => {
      if (!/^0x[0-9a-f]{40}$/i.test(contract.value.trim()) || !/^\d+$/.test(tokenId.value.trim())) return say('Enter a Base contract and numeric token ID.', 'error');
      values.supporter = { chainId: 8453, contract: contract.value.trim().toLowerCase(), tokenId: tokenId.value.trim(), quantity: 1 };
      renderGift(); changed();
    });
    manual.append(el('summary', '', 'Other ERC-1155 token'), contract, tokenId, useManual);
    renderGift = () => {
      picks.forEach(button => button.classList.toggle('is-on', button.dataset.asset === values.asset));
      symbol.textContent = values.asset === 'eth' ? 'Ξ' : '$';
      reward.value = formatAssetUnits(values.rewardUnits, asset()).replace(/^[$Ξ]/, '').replace(/,/g, '').replace(/ (?:ETH|USDC)$/, '');
      reward.setAttribute('aria-label', `Bonus per finisher (${asset().symbol})`);
      hint.textContent = usd(values.rewardUnits);
      const chosen = values.supporter ? `${values.supporter.contract.toLowerCase()}:${values.supporter.tokenId}` : '';
      const options = [new Option('No NFT gift', '')];
      for (const token of supporters?.tokens || []) options.push(new Option(`🎖 ${token.name} · #${token.tokenId} · ${token.balance} held`, `${token.contract}:${token.tokenId}`));
      if (chosen && !options.some(option => option.value === chosen)) options.push(new Option(`🎖 #${values.supporter.tokenId} · ${values.supporter.contract.slice(0, 8)}…`, chosen));
      select.replaceChildren(...options);
      select.value = chosen;
      const held = supporters?.tokens?.find(t => `${t.contract}:${t.tokenId}` === chosen);
      stock.dataset.tone = held && BigInt(held.balance) < BigInt(values.maxAwards || 0) ? 'error' : '';
      stock.textContent = !supporters ? '🎖 Reading Supporter NFTs in the admin wallet…'
        : supporters.error ? `🎖 Wallet inventory unavailable (${supporters.error}); use another ERC-1155 token below.`
        : held && BigInt(held.balance) < BigInt(values.maxAwards || 0) ? `⚠️ ${held.balance} held for ${values.maxAwards} awards. Activation needs one per award; lower the cap or top up.`
        : held ? `🎖 ${held.balance} held · one per finisher, sent from the admin wallet after approval (not escrowed).`
        : values.supporter ? '🎖 Not found in the admin wallet inventory; activation checks it on Base.' : 'Optional NFT, one per finisher.';
    };
    const assets = el('div', 'rc-inline');
    assets.append(...picks);
    body.append(assets, money_, select, stock, manual, pill('✓', 'Done', done));
    renderGift();
  });
  async function chooseAsset(to) {
    if (to === values.asset) return;
    rate = rate || await loadEthUsd();
    const next = rate ? convertCampaignUnits(values.rewardUnits, values.asset, to, rate) : null;
    values.rewardUnits = next && BigInt(next) > 0n ? next : to === 'eth' ? '2000000000000000' : '5000000';
    values.asset = to;
    fund = null;
    renderGift(); changed();
    void refreshFund();
  }
  const fundRow = row('🏦', 'Fund', () => !fund ? `${PINNER_CAMPAIGN_FUND} · checking…`
    : fund.error ? `${PINNER_CAMPAIGN_FUND} · unavailable`
    : !fund.exists ? `${PINNER_CAMPAIGN_FUND} · not created yet`
    : `${PINNER_CAMPAIGN_FUND} · ${money(availability()?.free ?? 0n)} free`);
  const claimsRow = dateRow('⏳', 'Claims close', 'claimDeadline');
  const allocation = el('p', 'rc-allocation');
  rows.append(titleRow.wrap, startRow.wrap, endRow.wrap, requirementsRow.wrap, giftRow.wrap, fundRow.wrap, allocation);
  const advanced = el('details', 'rc-advanced');
  advanced.append(el('summary', 'rc-help', 'Advanced · claims close'), claimsRow.wrap,
    el('p', 'rc-help', 'Finishers have until this time to submit claims; it defaults to 7 days after the end.'));
  rows.append(advanced);

  const footer = el('footer', 'rc-foot');
  const saveButton = pill('💾 Save draft', 'Save this draft without activating');
  const discard = pill('🗑 Discard draft', 'Archive this draft so it leaves the calendar');
  const runButton = el('button', 'rc-run', '▶ Activate');
  runButton.type = 'button';
  footer.append(discard, saveButton, runButton);

  const availability = () => fund && !fund.error && fund.exists && fund.asset === values.asset
    ? pinnerFundAvailability({ balanceUnits: fund.balanceUnits, campaigns, campaignId: values.id, asset: values.asset, needUnits: budgetUnits() })
    : null;
  const dirty = () => !values.id || JSON.stringify(safePayload()) !== savedSnapshot;
  let step = { step: 'blocked' };
  function check() {
    const payload = (() => { try { return pinnerCampaignPayload(values); } catch (error) { return error; } })();
    const valid = !(payload instanceof Error);
    const workerReady = features?.pinnerCampaign === PINNER_CAMPAIGN_VERSION &&
      (values.asset === 'eth' || features?.pinnerCampaignAssets?.includes(values.asset));
    const need = budgetUnits();
    const avail = availability();
    step = pinnerNextStep({ valid, workerReady, fund: fund?.error || fund?.asset === values.asset ? fund : null,
      shortfallUnits: avail?.shortfall ?? 0n, money });
    let message, tone = 'info';
    if (!valid) { message = `⚠️ ${payload.message}`; tone = 'error'; }
    else if (!features) message = '⏳ Loading campaign service…';
    else if (!workerReady) { message = `The campaign service does not accept ${asset().symbol} pinning bonuses yet; try again after it redeploys.`; tone = 'error'; }
    else if (fund?.error) { message = `⚠️ ${fund.error}`; tone = 'error'; }
    else if (step.step === 'blocked') message = '⏳ Checking fund on Base…';
    else if (step.step === 'create') message = `Step 1 · Create ${PINNER_CAMPAIGN_FUND} on Base (one signature for its public metadata, one transaction). Every pin reward campaign draws from it.`;
    else if (step.step === 'restore') { message = `${PINNER_CAMPAIGN_FUND} is archived; restore it in Fund Allocations.`; tone = 'error'; }
    else {
      message = `Reserving ${both(need)} of ${money(avail.free)} free${avail.others ? ` (${money(avail.others)} held by other pinner campaigns)` : ''}` +
        (step.step === 'fund' ? ` · ${money(avail.shortfall)} more will be deposited from your wallet.` : ' · fund covers it.');
      if (dirty()) message += values.id ? ' Your edits are saved first.' : ' The draft is saved first.';
    }
    allocation.textContent = message;
    allocation.dataset.tone = tone;
    runButton.textContent = step.label || '▶ Activate';
    runButton.disabled = busy || !['create', 'fund', 'activate', 'restore'].includes(step.step);
    runButton.title = message;
    saveButton.disabled = busy || !valid || !dirty() || !workerReady;
    saveButton.textContent = values.id ? (dirty() ? '💾 Save changes' : '✓ Saved') : '💾 Save draft';
    discard.hidden = !values.id;
    discard.disabled = busy;
    fundRow.refresh();
  }
  function changed() {
    titleRow.refresh(); startRow.refresh(); endRow.refresh(); claimsRow.refresh(); requirementsRow.refresh(); giftRow.refresh();
    renderGift();
    check();
  }
  async function refreshFund() {
    const read = ++fundRead;
    const want = values.asset;
    const [onchain, state] = await Promise.allSettled([
      readCampaignFund(PINNER_CAMPAIGN_FUND, { asset: CAMPAIGN_ASSETS[want] }), fetchPromotionsState()]);
    if (read !== fundRead || !dialog.isConnected) return fund;
    if (state.status === 'fulfilled') {
      features = state.value.features || {};
      campaigns = state.value.campaigns || [];
    }
    const failure = onchain.status === 'rejected' ? onchain.reason : state.status === 'rejected' ? state.reason : null;
    const next = failure ? { asset: want, error: failure.shortMessage || failure.message || 'Fund check unavailable' }
      : { ...onchain.value, asset: want, revision: state.value.revision };
    fund = next;
    check();
    return fund;
  }
  async function save() {
    const campaign = pinnerCampaignPayload(values);
    const before = await fetchPromotionsState();
    const existing = new Set((before.campaigns || []).map(c => c.id));
    say('✍️ Sign to save the draft');
    const result = await signedPromotionCommand({ action: 'save', campaignId: values.id || undefined, campaign, revision: before.revision });
    if (!values.id) {
      const created = (result.campaigns || []).filter(c => !existing.has(c.id));
      if (created.length !== 1) throw new Error('Draft saved, but its identity could not be confirmed. Reopen it from the calendar.');
      values.id = created[0].id;
    }
    savedSnapshot = JSON.stringify(safePayload());
    campaigns = result.campaigns || campaigns;
    return result;
  }
  async function deposit(amount) {
    const w = await promotionWallet();
    const router = new w.ethers.Contract(ROUTER, ROUTER_ABI, w.signer);
    if (values.asset === 'eth') {
      say(`🦊 Confirm the ${money(amount)} deposit`);
      const tx = await router.fundNative(w.ethers.id(PINNER_CAMPAIGN_FUND), { value: amount });
      say('⏳ Depositing on Base…');
      if ((await tx.wait())?.status !== 1) throw new Error('ETH deposit did not confirm');
    } else {
      await depositSettlementUsdc({ router, token: new w.ethers.Contract(PROMOTIONS_USDC, TOKEN_ABI, w.signer),
        signer: w.signer, owner: w.address, fundId: w.ethers.id(PINNER_CAMPAIGN_FUND), amountUnits: amount,
        onStep: text => say(`🦊 ${text}`) });
    }
    await w.check();
    document.dispatchEvent(new CustomEvent('settlement-fund-changed', { detail: { slug: PINNER_CAMPAIGN_FUND } }));
  }
  const work = fn => async () => {
    if (busy) return;
    busy = true; check();
    try { await fn(); }
    catch (error) { say(error.shortMessage || error.message, 'error'); }
    finally { busy = false; if (dialog.isConnected) check(); }
  };
  saveButton.addEventListener('click', work(async () => {
    if (!isAdminWallet()) throw new Error('Connect the admin wallet');
    await save();
    say('💾 Draft saved · it stays on the calendar as a draft until you activate it.');
    await refreshFund();
  }));
  discard.addEventListener('click', work(async () => {
    if (!values.id || !confirm(`Discard the draft “${values.title}”?\nIt is archived in the public record and leaves the calendar.`)) return;
    const state = await fetchPromotionsState();
    await signedPromotionCommand({ action: 'status', campaignId: values.id, status: 'archived', revision: state.revision });
    dialog.close();
  }));
  runButton.addEventListener('click', work(async () => {
    if (!isAdminWallet()) throw new Error('Connect the admin wallet');
    if (step.step === 'create' || step.step === 'restore') {
      say(`🦊 Sign the ${PINNER_CAMPAIGN_FUND} metadata, then confirm the Create Fund transaction. This popout updates when it lands.`);
      prepareSettlementFund(PINNER_CAMPAIGN_FUND);
      return;
    }
    if (dirty()) await save();
    const current = await refreshFund();
    if (!current || current.error || !current.exists || !current.active) throw new Error(current?.error || `${PINNER_CAMPAIGN_FUND} is not ready`);
    const shortfall = availability()?.shortfall ?? 0n;
    if (shortfall > 0n) {
      await deposit(shortfall);
      await refreshFund();
      if ((availability()?.shortfall ?? 1n) > 0n) throw new Error('Deposit confirmed but the fund still reads short; refresh and retry');
    }
    if (values.supporter) {
      const held = supporters?.tokens?.find(t => `${t.contract}:${t.tokenId}` === `${values.supporter.contract.toLowerCase()}:${values.supporter.tokenId}`);
      if (held && BigInt(held.balance) < BigInt(values.maxAwards)) throw new Error(`Hold ${values.maxAwards} of this Supporter NFT (you have ${held.balance}), or lower the award cap`);
    }
    say('✍️ Sign to activate');
    const state = await fetchPromotionsState();
    await signedPromotionCommand({ action: 'status', campaignId: values.id, status: 'published', revision: state.revision });
    say('🎉 Activated · the campaign is live on the public calendar.');
    dialog.close();
  }));
  const onFundChanged = event => {
    if (!event.detail?.slug || event.detail.slug === PINNER_CAMPAIGN_FUND) {
      if (event.detail?.created) say(`✅ ${PINNER_CAMPAIGN_FUND} created. Next: fund & activate.`);
      void refreshFund();
    }
  };
  document.addEventListener('settlement-fund-changed', onFundChanged);

  dialog.append(header, info, rows, status, footer);
  document.body.append(dialog);
  dialog.addEventListener('close', () => {
    document.removeEventListener('settlement-fund-changed', onFundChanged);
    dialog.remove();
    if (openDialog === dialog) openDialog = null;
  }, { once: true });
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.showModal();
  if (anchor && innerWidth > 640) {
    dialog.style.inset = 'auto'; dialog.style.margin = '0';
    const width = dialog.getBoundingClientRect().width;
    dialog.style.left = `${Math.min(Math.max(12, anchor.x - width / 2), innerWidth - width - 12)}px`;
    dialog.style.top = `${Math.max(12, Math.min(anchor.y - 40, innerHeight - 560))}px`;
  }
  check();
  void refreshFund();
  if (!rate) void loadEthUsd().then(value => { rate = value; if (dialog.isConnected) changed(); });
  if (window._wallet?.address) {
    void loadSupporterInventory({ owner: window._wallet.address, ethers: window.ethers, provider: getBaseReadProvider() })
      .then(tokens => ({ tokens }), error => ({ tokens: [], error: error.shortMessage || error.message || 'Base read failed' }))
      .then(result => { supporters = result; if (dialog.isConnected) changed(); });
  } else supporters = { tokens: [], error: 'connect the admin wallet' };
  return dialog;
}
