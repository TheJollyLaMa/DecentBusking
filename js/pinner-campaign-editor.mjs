import { PINNER_CAMPAIGN_FUND, PINNER_CAMPAIGN_VERSION, PROMOTIONS_USDC, PROMOTION_TEMPLATES, PINNER_BONUS_ASSETS, campaignAsset,
  formatAssetUnits, parseAssetAmount, pinnerCampaignAmounts, pinnerCampaignFullDays, pinnerDefaultQualifyingDays,
  pinnerCampaignTerms, PINNER_DEFAULT_DAY_SHARE } from './promotions.mjs?v=20261130-pinner-gifts';
import { cachedEthUsd, loadEthUsd, weiToUsdText } from './eth-usd-quote.mjs?v=20261126-eth-gifts';
import { newYorkInputToUtc, utcToNewYorkInput } from './radio-calendar.mjs';
import { isAdminWallet } from './admin-access.mjs';
import { getBaseReadProvider } from './base-chain.mjs';
import { depositSettlementUsdc } from './settlement-funds.mjs';
import { loadSupporterInventory } from './supporter-inventory.mjs?v=20261129-pinner-fund-load';
import { fetchPromotionsState, signedPromotionCommand, promotionWallet, readCampaignFund,
  prepareSettlementFund } from './promotions-ui.mjs?v=20261130-pinner-gifts';

const DAY = 86400000;
const ROUTER = '0x8ecca903e2a6Daa8CCbB933700e4F2C58C44A4B5';
const ROUTER_ABI = ['function fundNative(bytes32) payable', 'function fundToken(bytes32,address,uint256)',
  'function approvedAssets(address) view returns(bool)'];
const TOKEN_ABI = ['function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)', 'function approve(address,uint256) returns(bool)'];
const RESERVING = ['published', 'paused', 'closed'];
const GIFT_ORDER = ['eth', 'usdc', 'ommm'];
const GIFT_DEFAULTS = { eth: '2000000000000000', usdc: '5000000', ommm: '1000000000000000000000' };
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
    extras: base.qualificationVersion === PINNER_CAMPAIGN_VERSION
      ? Object.fromEntries((base.extraRewards || []).map(x => [x.asset, String(x.rewardUnits)])) : {},
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
  const extraRewards = Object.entries(values.extras || {}).filter(([id]) => id !== values.asset)
    .sort(([a], [b]) => GIFT_ORDER.indexOf(a) - GIFT_ORDER.indexOf(b))
    .map(([asset, rewardUnits]) => ({ asset, ...pinnerCampaignAmounts(rewardUnits, values.maxAwards, asset) }));
  const template = PROMOTION_TEMPLATES.find(item => item.id === 'pinner');
  const campaign = { template: 'pinner', title: String(values.title || '').trim() || template.title, criteria: template.criteria,
    ...amounts, maxAwards: values.maxAwards, fund: PINNER_CAMPAIGN_FUND, asset: values.asset === 'usdc' ? 'usdc' : 'eth',
    qualificationVersion: PINNER_CAMPAIGN_VERSION, qualifyingDays: values.qualifyingDays,
    ...(extraRewards.length ? { extraRewards } : {}),
    supporterRewards: values.supporter ? [{ chainId: 8453, contract: values.supporter.contract, tokenId: String(values.supporter.tokenId), quantity: 1 }] : [],
    curatedReferrers: [], startsAt: values.startsAt, endsAt: values.endsAt, claimDeadline: values.claimDeadline };
  return { ...campaign, terms: pinnerCampaignTerms(campaign) };
}

// Free balance in the pinner campaign fund for one asset after other live campaigns' unpaid budgets and extra bonuses.
export function pinnerFundAvailability({ balanceUnits, campaigns = [], campaignId = '', asset = 'eth', needUnits = 0n }) {
  const others = campaigns.filter(c => c.fund === PINNER_CAMPAIGN_FUND && c.id !== campaignId && RESERVING.includes(c.status))
    .reduce((sum, c) => {
      const primary = campaignAsset(c).id === asset ? BigInt(c.budgetUnits || 0) - BigInt(c.paidUnits || 0) : 0n;
      const extra = (c.extraRewards || []).find(x => x.asset === asset);
      const paid = (c.bonusAwards || []).filter(a => a.asset === asset && a.status === 'paid').reduce((n, a) => n + BigInt(a.amountUnits), 0n);
      return sum + primary + (extra ? BigInt(extra.budgetUnits) - paid : 0n);
    }, 0n);
  const balance = BigInt(balanceUnits || 0);
  const free = balance > others ? balance - others : 0n;
  const need = BigInt(needUnits);
  return { balance, others, free, shortfall: need > free ? need - free : 0n };
}

// The single progressive action: create the fund, then fund any shortfall and activate, or just sign and activate.
export function pinnerNextStep({ valid = true, workerReady = true, fund = null, shortfallUnits = 0n, money = String, shortfallText = '' }) {
  if (!valid) return { step: 'blocked', label: '▶ Activate' };
  if (!workerReady) return { step: 'blocked', label: '▶ Activate' };
  if (!fund) return { step: 'blocked', label: '⏳ Checking fund…' };
  if (fund.error) return { step: 'blocked', label: '▶ Activate' };
  if (!fund.exists) return { step: 'create', label: `⚸ Create ${PINNER_CAMPAIGN_FUND}` };
  if (!fund.active) return { step: 'restore', label: `⚸ Restore ${PINNER_CAMPAIGN_FUND}` };
  if (shortfallText) return { step: 'fund', label: `▶ Fund ${shortfallText} & Activate` };
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
  const asset = () => PINNER_BONUS_ASSETS[values.asset];
  const moneyIn = (units, id) => formatAssetUnits(units, PINNER_BONUS_ASSETS[id]);
  const money = units => moneyIn(units, values.asset);
  const usdIn = (units, id) => id === 'eth' ? weiToUsdText(units, rate) : '';
  const usd = units => usdIn(units, values.asset);
  const both = units => usd(units) ? `${money(units)} (${usd(units)})` : money(units);
  const gifts = () => GIFT_ORDER.filter(id => id === values.asset || values.extras[id] !== undefined)
    .map(id => ({ id, rewardUnits: id === values.asset ? values.rewardUnits : values.extras[id] }));
  const budgetIn = id => {
    const gift = gifts().find(g => g.id === id);
    try { return gift ? BigInt(pinnerCampaignAmounts(gift.rewardUnits, values.maxAwards, id).budgetUnits) : 0n; } catch { return 0n; }
  };
  const budgetUnits = () => budgetIn(values.asset);
  const giftKey = () => gifts().map(g => g.id).join();
  const fundReady = () => !!fund && fund.key === giftKey();
  const availability = (id = values.asset) => fundReady() && !fund.error && fund.exists && fund.balances[id] !== undefined
    ? pinnerFundAvailability({ balanceUnits: fund.balances[id], campaigns, campaignId: values.id, asset: id, needUnits: budgetIn(id) })
    : null;
  const shortfalls = () => gifts().map(g => ({ id: g.id, units: availability(g.id)?.shortfall ?? 0n })).filter(x => x.units > 0n);
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
    el('span', 'rc-info-line', '3 · The first finishers, up to the award cap, earn every fixed bonus you pick (ETH and/or USDC, optionally plus Ommm) and any Supporter NFT, paid through Payroll after review.'),
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
  const supporterKey = token => token ? `${String(token.contract).toLowerCase()}:${token.tokenId}` : '';
  const giftText = () => {
    const token = values.supporter;
    const name = token ? supporters?.tokens?.find(t => `${t.contract}:${t.tokenId}` === supporterKey(token))?.name || `Supporter #${token.tokenId}` : '';
    const each = gifts().map(g => g.id === 'eth' ? both(g.rewardUnits) : moneyIn(g.rewardUnits, g.id)).join(' + ');
    const total = gifts().map(g => moneyIn(budgetIn(g.id), g.id)).join(' + ');
    return `${each} each · ${total} total${token ? ` · 🎖 ${name}` : ''}`;
  };
  const giftRow = row('🎁', 'The gift', giftText, (body, done) => {
    const picks = GIFT_ORDER.map(id => {
      const a = PINNER_BONUS_ASSETS[id];
      const button = pill(`${a.icon} ${a.symbol}`, `Include a ${a.symbol} bonus`, () => toggleGift(id));
      button.dataset.asset = id;
      return button;
    });
    const amounts = el('div', 'rc-gift-amounts');
    const nftLabel = el('small', 'rc-field-name', '🎖 Supporter NFT');
    const choices = el('div', 'rc-choices');
    choices.setAttribute('role', 'group');
    choices.setAttribute('aria-label', 'Supporter NFT gift');
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
    const choice = (text, key, label) => {
      const button = pill(text, label, () => {
        const [address, id] = key.split(':');
        values.supporter = address ? { chainId: 8453, contract: address, tokenId: id, quantity: 1 } : null;
        renderGift(); changed();
      });
      button.classList.add('rc-choice');
      button.setAttribute('aria-pressed', String(key === supporterKey(values.supporter)));
      button.classList.toggle('is-on', key === supporterKey(values.supporter));
      return button;
    };
    let amountKey = '';
    renderGift = () => {
      picks.forEach(button => {
        const on = gifts().some(g => g.id === button.dataset.asset);
        button.classList.toggle('is-on', on);
        button.setAttribute('aria-pressed', String(on));
      });
      const key = gifts().map(g => g.id).join();
      if (key !== amountKey || !amounts.contains(document.activeElement)) {
        amountKey = key;
        amounts.replaceChildren(...gifts().map(g => {
          const a = PINNER_BONUS_ASSETS[g.id];
          const line = el('label', 'rc-money');
          const input = el('input'), hint = el('small', 'rc-usd', usdIn(g.rewardUnits, g.id));
          input.inputMode = 'decimal'; input.size = 9;
          input.value = formatAssetUnits(g.rewardUnits, a).replace(/^[$Ξ]/, '').replace(/,/g, '').replace(/ (?:ETH|USDC|Ommm)$/, '');
          input.setAttribute('aria-label', `Bonus per finisher (${a.symbol})`);
          input.addEventListener('input', () => {
            const units = parseAssetAmount(input.value, a);
            const ok = units && BigInt(units) > 0n;
            input.classList.toggle('is-bad', !ok);
            if (ok) { if (g.id === values.asset) values.rewardUnits = units; else values.extras[g.id] = units; }
            hint.textContent = usdIn(ok ? units : g.rewardUnits, g.id);
            changed();
          });
          line.append(el('small', 'rc-field-name', g.id === values.asset ? 'Bonus per finisher' : 'Plus per finisher'),
            el('span', 'rc-dollar', g.id === 'eth' ? 'Ξ' : g.id === 'usdc' ? '$' : a.icon), input, hint);
          return line;
        }));
      }
      const chosen = supporterKey(values.supporter);
      const list = [choice('No NFT', '', 'No Supporter NFT gift')];
      for (const token of supporters?.tokens || []) {
        list.push(choice(`🎖 ${token.name} · #${token.tokenId} · ${token.balance} held`, `${token.contract}:${token.tokenId}`, `Gift ${token.name} #${token.tokenId}`));
      }
      if (chosen && !list.some(b => b.getAttribute('aria-pressed') === 'true')) {
        list.push(choice(`🎖 #${values.supporter.tokenId} · ${values.supporter.contract.slice(0, 8)}…`, chosen, `Gift Supporter #${values.supporter.tokenId}`));
      }
      choices.replaceChildren(...list);
      const held = supporters?.tokens?.find(t => `${t.contract}:${t.tokenId}` === chosen);
      stock.dataset.tone = held && BigInt(held.balance) < BigInt(values.maxAwards || 0) ? 'error' : '';
      stock.textContent = !supporters ? '🎖 Reading Supporter NFTs in the admin wallet…'
        : supporters.error ? `🎖 Wallet inventory unavailable (${supporters.error}); use another ERC-1155 token below.`
        : held && BigInt(held.balance) < BigInt(values.maxAwards || 0) ? `⚠️ ${held.balance} held for ${values.maxAwards} awards. Activation needs one per award; lower the cap or top up.`
        : held ? `🎖 ${held.balance} held · one per finisher, sent from the admin wallet after approval (not escrowed).`
        : values.supporter ? '🎖 Not found in the admin wallet inventory; activation checks it on Base.'
        : supporters.tokens.length ? 'Optional NFT, one per finisher.' : 'No Supporter NFTs found in the admin wallet; use another ERC-1155 token below.';
    };
    const assets = el('div', 'rc-inline');
    assets.append(...picks);
    body.append(assets, amounts, nftLabel, choices, stock, manual, pill('✓', 'Done', done));
    renderGift();
  });
  function toggleGift(id) {
    const on = gifts().some(g => g.id === id);
    if (on && id === values.asset) {
      const next = ['eth', 'usdc'].find(other => other !== id && values.extras[other] !== undefined);
      if (!next) return say('Keep an ETH or USDC bonus; Ommm can only ride alongside one for now.', 'error');
      values.asset = next;
      values.rewardUnits = values.extras[next];
      delete values.extras[next];
    } else if (on) delete values.extras[id];
    else values.extras[id] = GIFT_DEFAULTS[id];
    say();
    fund = null;
    renderGift(); changed();
    void refreshFund();
  }
  const fundRow = row('🏦', 'Fund', () => !fundReady() ? `${PINNER_CAMPAIGN_FUND} · checking…`
    : fund.error ? `${PINNER_CAMPAIGN_FUND} · unavailable`
    : !fund.exists ? `${PINNER_CAMPAIGN_FUND} · not created yet`
    : `${PINNER_CAMPAIGN_FUND} · ${gifts().map(g => moneyIn(availability(g.id)?.free ?? 0n, g.id)).join(' + ')} free`);
  const claimsRow = dateRow('⏳', 'Claims close', 'claimDeadline');
  claimsRow.wrap.querySelector('.rc-edit')?.append(el('p', 'rc-help', 'Finishers have until this time to submit claims; it defaults to 7 days after the end.'));
  const allocation = el('p', 'rc-allocation');
  rows.append(titleRow.wrap, startRow.wrap, endRow.wrap, claimsRow.wrap, requirementsRow.wrap, giftRow.wrap, fundRow.wrap, allocation);

  const footer = el('footer', 'rc-foot');
  const saveButton = pill('💾 Save draft', 'Save this draft without activating');
  const discard = pill('🗑 Discard draft', 'Archive this draft so it leaves the calendar');
  const runButton = el('button', 'rc-run', '▶ Activate');
  runButton.type = 'button';
  footer.append(discard, saveButton, runButton);

  const dirty = () => !values.id || JSON.stringify(safePayload()) !== savedSnapshot;
  let step = { step: 'blocked' };
  function check() {
    const payload = (() => { try { return pinnerCampaignPayload(values); } catch (error) { return error; } })();
    const valid = !(payload instanceof Error);
    const extras = gifts().filter(g => g.id !== values.asset);
    const workerReady = features?.pinnerCampaign === PINNER_CAMPAIGN_VERSION &&
      (values.asset === 'eth' || features?.pinnerCampaignAssets?.includes(values.asset)) &&
      extras.every(g => features?.pinnerExtraRewards?.includes(g.id));
    const ommmBlocked = values.extras.ommm !== undefined && fundReady() && fund.ommmApproved === false;
    const short = shortfalls();
    step = pinnerNextStep({ valid: valid && !ommmBlocked, workerReady, fund: fundReady() ? fund : null,
      shortfallText: short.map(x => moneyIn(x.units, x.id)).join(' + '), money });
    let message, tone = 'info';
    if (!valid) { message = `⚠️ ${payload.message}`; tone = 'error'; }
    else if (!features) message = '⏳ Loading campaign service…';
    else if (!workerReady) { message = `The campaign service does not accept ${gifts().map(g => PINNER_BONUS_ASSETS[g.id].symbol).join(' + ')} pinning bonuses yet; try again after it redeploys.`; tone = 'error'; }
    else if (fundReady() && fund.error) { message = `⚠️ ${fund.error}`; tone = 'error'; }
    else if (ommmBlocked) { message = '⚠️ Ommm is not yet an approved asset on the Settlements Router. An asset admin must approve it (setAssetApproved) before Ommm bonuses can be funded.'; tone = 'error'; }
    else if (step.step === 'blocked') message = '⏳ Checking fund on Base…';
    else if (step.step === 'create') message = `Step 1 · Create ${PINNER_CAMPAIGN_FUND} on Base (one signature for its public metadata, one transaction). Every pin reward campaign draws from it.`;
    else if (step.step === 'restore') { message = `${PINNER_CAMPAIGN_FUND} is archived; restore it in Fund Allocations.`; tone = 'error'; }
    else {
      message = gifts().map(g => {
        const avail = availability(g.id);
        const need = budgetIn(g.id);
        return `Reserving ${g.id === 'eth' ? `${moneyIn(need, 'eth')}${usdIn(need, 'eth') ? ` (${usdIn(need, 'eth')})` : ''}` : moneyIn(need, g.id)} of ${moneyIn(avail?.free ?? 0n, g.id)} free${avail?.others ? ` (${moneyIn(avail.others, g.id)} held by other pinner campaigns)` : ''}`;
      }).join(' · ') + (step.step === 'fund' ? ` · ${short.map(x => moneyIn(x.units, x.id)).join(' + ')} more will be deposited from your wallet.` : ' · fund covers it.');
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
    const want = gifts().map(g => g.id);
    const key = want.join();
    const reader = getBaseReadProvider();
    const [state, approval, ...onchain] = await Promise.allSettled([fetchPromotionsState(),
      want.includes('ommm') && window.ethers && reader
        ? new window.ethers.Contract(ROUTER, ROUTER_ABI, reader).approvedAssets(PINNER_BONUS_ASSETS.ommm.address) : Promise.resolve(null),
      ...want.map(id => readCampaignFund(PINNER_CAMPAIGN_FUND, { asset: PINNER_BONUS_ASSETS[id] }))]);
    if (read !== fundRead || !dialog.isConnected) return fund;
    if (state.status === 'fulfilled') {
      features = state.value.features || {};
      campaigns = state.value.campaigns || [];
    }
    const failure = onchain.find(r => r.status === 'rejected')?.reason || (state.status === 'rejected' ? state.reason : null);
    fund = failure ? { key, error: failure.shortMessage || failure.message || 'Fund check unavailable' }
      : { key, exists: onchain[0].value.exists, active: onchain[0].value.active, revision: state.value.revision,
        ommmApproved: approval.status === 'fulfilled' ? approval.value : null,
        balances: Object.fromEntries(want.map((id, i) => [id, onchain[i].value.balanceUnits])) };
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
  async function deposit(id, amount) {
    const w = await promotionWallet();
    const router = new w.ethers.Contract(ROUTER, ROUTER_ABI, w.signer);
    const fundId = w.ethers.id(PINNER_CAMPAIGN_FUND);
    const a = PINNER_BONUS_ASSETS[id];
    if (id === 'eth') {
      say(`🦊 Confirm the ${moneyIn(amount, id)} deposit`);
      const tx = await router.fundNative(fundId, { value: amount });
      say('⏳ Depositing on Base…');
      if ((await tx.wait())?.status !== 1) throw new Error('ETH deposit did not confirm');
    } else if (id === 'usdc') {
      await depositSettlementUsdc({ router, token: new w.ethers.Contract(PROMOTIONS_USDC, TOKEN_ABI, w.signer),
        signer: w.signer, owner: w.address, fundId, amountUnits: amount,
        onStep: text => say(`🦊 ${text}`) });
    } else {
      const token = new w.ethers.Contract(a.address, TOKEN_ABI, w.signer);
      if (!await router.approvedAssets(a.address)) throw new Error(`${a.symbol} is not approved on the Settlements Router`);
      if (Number(await token.decimals()) !== a.decimals) throw new Error(`Configured ${a.symbol} token has unexpected decimals`);
      if (await token.balanceOf(w.address) < amount) throw new Error(`Admin wallet holds less than ${moneyIn(amount, id)}`);
      if (await token.allowance(w.address, ROUTER) < amount) {
        say(`🦊 Approve exactly ${moneyIn(amount, id)} for the router`);
        if ((await (await token.approve(ROUTER, amount)).wait())?.status !== 1) throw new Error(`${a.symbol} approval did not confirm`);
      }
      say(`🦊 Confirm the ${moneyIn(amount, id)} deposit`);
      const tx = await router.fundToken(fundId, a.address, amount);
      say('⏳ Depositing on Base…');
      if ((await tx.wait())?.status !== 1) throw new Error(`${a.symbol} deposit did not confirm`);
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
    for (const { id, units } of shortfalls()) await deposit(id, units);
    if (shortfalls().length || gifts().some(g => !availability(g.id))) {
      await refreshFund();
      if (gifts().some(g => (availability(g.id)?.shortfall ?? 1n) > 0n)) throw new Error('Deposit confirmed but the fund still reads short; refresh and retry');
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
