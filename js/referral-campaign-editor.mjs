import { MUSICIAN_REFERRAL_PILOT, MUSICIAN_REFERRAL_TERMS, PROMOTION_TEMPLATES, REFERRALS_FUND, PROMOTIONS_USDC,
  referralCampaignTitle, musicianReferralConfig } from './promotions.mjs?v=20261124-referral-week';
import { newYorkInputToUtc, utcToNewYorkInput } from './radio-calendar.mjs';
import { isAdminWallet } from './admin-access.mjs';
import { getBaseReadProvider } from './base-chain.mjs';
import { depositSettlementUsdc } from './settlement-funds.mjs';
import { fetchPromotionsState, signedPromotionCommand, promotionWallet, resolvePromotionWallet,
  openPromotionCalendarEditor } from './promotions-ui.mjs';

export const REFERRAL_ROUTER_ADDRESS = '0x8ecca903e2a6Daa8CCbB933700e4F2C58C44A4B5';
const ROUTER_ABI = [
  'function paused() view returns(bool)',
  'function funds(bytes32) view returns(string metadataUri,bool active,bool exists)',
  'function fundBalances(bytes32,address) view returns(uint256)',
  'function approvedAssets(address) view returns(bool)',
  'function fundToken(bytes32,address,uint256)',
];
const TOKEN_ABI = [
  'function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)', 'function approve(address,uint256) returns(bool)',
];
const DAY = 86400000;
const BUDGET = BigInt(MUSICIAN_REFERRAL_PILOT.budgetUnits);
const LEG_ICONS = { referrer: '🤝', musician: '🎤', 'dbusk-top10': '🏆', 'dbusk-playback': '📻' };
const LEG_LABELS = { referrer: 'Referrer', musician: 'New musician', 'dbusk-top10': 'Top 10 fund', 'dbusk-playback': 'Playback fund' };
const dollars = units => (Number(BigInt(units)) / 1e6).toFixed(2).replace(/\.00$/, '');
export function dollarsToUnits(value) {
  const match = /^\$?\s*(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  if (!match) return null;
  return (BigInt(match[1]) * 1_000_000n + BigInt((match[2] || '').padEnd(2, '0')) * 10_000n).toString();
}
const when = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const short = value => `${value.slice(0, 6)}…${value.slice(-4)}`;
const money = units => `$${(Number(BigInt(units)) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
let contributorsRequest;
let openDialog = null;

export function loadReferralContributors(fetchImpl = globalThis.fetch) {
  contributorsRequest ||= fetchImpl(new URL('../contributor-accounts.json', import.meta.url), { cache: 'no-store' })
    .then(response => response.ok ? response.json() : { contributors: [] })
    .then(data => (data.contributors || []).filter(c => /^0x[0-9a-f]{40}$/i.test(c.walletAddress || ''))
      .map(c => ({ wallet: c.walletAddress.toLowerCase(), name: c.displayName || c.github || short(c.walletAddress) })))
    .catch(() => { contributorsRequest = null; return []; });
  return contributorsRequest;
}

export function referralFundAvailability({ balanceUnits, campaigns = [], budgetUnits = BUDGET }) {
  const committed = campaigns.filter(c => c.fund === REFERRALS_FUND && ['published', 'paused', 'closed'].includes(c.status))
    .reduce((total, c) => total + BigInt(c.budgetUnits || 0) - BigInt(c.paidUnits || 0), 0n);
  const balance = BigInt(balanceUnits);
  const available = balance > committed ? balance - committed : 0n;
  return { balance, committed, available, shortfall: budgetUnits > available ? budgetUnits - available : 0n };
}

export function referralTemplateFrom(campaign) {
  if (!campaign) return null;
  const start = Date.parse(campaign.startsAt || campaign.startUtc);
  const end = Date.parse(campaign.endsAt || campaign.endUtc);
  return {
    title: String(campaign.title || '').replace(/\s*referral campaign$/i, ''),
    durationMs: end > start ? end - start : 14 * DAY,
    claimGraceMs: Math.max(0, Date.parse(campaign.claimDeadline || campaign.endsAt || campaign.endUtc) - end) || 7 * DAY,
    referrers: [...(campaign.curatedReferrers || [])].map(item => item.toLowerCase()),
    names: { ...(campaign.curatedReferrerNames || {}) },
    ...(() => {
      const config = musicianReferralConfig({ ...campaign, baseBudgetUnits: campaign.baseBudgetUnits || campaign.budgetUnits });
      return config.valid ? { legAmounts: config.amounts, budgetUnits: config.baseBudgetUnits, requiredVotes: config.requiredVotes } : {};
    })(),
  };
}

export function referralCampaignPayload({ title, startsAt, endsAt, claimDeadline, referrers, names = {},
  legAmounts = musicianReferralConfig().amounts, budgetUnits = MUSICIAN_REFERRAL_PILOT.budgetUnits,
  requiredVotes = MUSICIAN_REFERRAL_PILOT.requiredVotes }) {
  const config = musicianReferralConfig({ legAmounts, baseBudgetUnits: budgetUnits, requiredVotes });
  if (!config.valid) throw new Error('Budget must be an exact multiple of the per-musician total, with a referrer reward');
  if (!(Date.parse(startsAt) < Date.parse(endsAt))) throw new Error('End must be after start');
  if (Date.parse(endsAt) <= Date.now()) throw new Error('Choose an end date in the future');
  if (Date.parse(claimDeadline) < Date.parse(endsAt)) throw new Error('Claim date must be on or after the end');
  const template = PROMOTION_TEMPLATES.find(item => item.id === MUSICIAN_REFERRAL_PILOT.template);
  return { template: MUSICIAN_REFERRAL_PILOT.template, title: referralCampaignTitle(title),
    criteria: template.criteria, terms: MUSICIAN_REFERRAL_TERMS,
    rewardUnits: config.rewardUnits, budgetUnits: config.baseBudgetUnits,
    maxAwards: config.maxConversions, fund: REFERRALS_FUND, legAmounts: config.amounts, requiredVotes: config.requiredVotes,
    curatedReferrers: referrers,
    curatedReferrerNames: Object.fromEntries(Object.entries(names).filter(([w, n]) => referrers.includes(w) && n?.trim())),
    startsAt, endsAt, claimDeadline };
}

async function readReferralFund(budgetUnits = BUDGET) {
  const ethers = window.ethers;
  const provider = getBaseReadProvider();
  if (!ethers || !provider) throw new Error('Base reader unavailable');
  const router = new ethers.Contract(REFERRAL_ROUTER_ADDRESS, ROUTER_ABI, provider);
  const fundId = ethers.id(REFERRALS_FUND);
  const [fund, balance, state] = await Promise.all([router.funds(fundId), router.fundBalances(fundId, PROMOTIONS_USDC), fetchPromotionsState()]);
  return { exists: !!(fund.exists ?? fund[2]), active: !!(fund.active ?? fund[1]), revision: state.revision,
    ...referralFundAvailability({ balanceUnits: balance, campaigns: state.campaigns || [], budgetUnits }) };
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

export function openReferralCampaignEditor({ startsAt, template = null, campaign = null, anchor = null, onRan = () => {} } = {}) {
  if (openDialog?.open) openDialog.close();
  const viewing = !!campaign;
  const preset = referralTemplateFrom(campaign) || template || {};
  const firstStart = Math.max(Date.parse(startsAt || campaign?.startsAt || Date.now()), Math.ceil(Date.now() / 900000) * 900000);
  const values = {
    title: preset.title || '',
    startsAt: campaign?.startsAt || new Date(firstStart).toISOString(),
    endsAt: campaign?.endsAt || new Date(firstStart + (preset.durationMs || 14 * DAY)).toISOString(),
    claimDeadline: campaign?.claimDeadline || new Date(firstStart + (preset.durationMs || 14 * DAY) + (preset.claimGraceMs ?? 7 * DAY)).toISOString(),
    referrers: new Set(preset.referrers || []),
    names: { ...(preset.names || {}) },
    legAmounts: { ...(preset.legAmounts || musicianReferralConfig().amounts) },
    budgetUnits: preset.budgetUnits || MUSICIAN_REFERRAL_PILOT.budgetUnits,
    requiredVotes: preset.requiredVotes || MUSICIAN_REFERRAL_PILOT.requiredVotes,
  };
  const config = () => musicianReferralConfig({ legAmounts: values.legAmounts, baseBudgetUnits: values.budgetUnits, requiredVotes: values.requiredVotes });
  let fund = null;
  let busy = false;
  const dialog = el('dialog', 'referral-blob');
  dialog.setAttribute('aria-label', viewing ? campaign.title : 'Referral Campaign');
  openDialog = dialog;

  const header = el('header', 'rc-head');
  const heading = el('h3', 'rc-title');
  const info = el('p', 'rc-info');
  info.hidden = true;
  const renderInfo = () => {
    const c = config();
    info.replaceChildren(...MUSICIAN_REFERRAL_PILOT.rewardLegs.map(leg => el('span', 'rc-leg', `${LEG_ICONS[leg.id]} ${money(c.amounts[leg.id] || 0)}`)),
      el('span', 'rc-info-line', `🎵 minted track + 🗳 ${c.requiredVotes} votes = 1 conversion`),
      el('span', 'rc-info-line', `🎖 Supporter token if all ${c.maxConversions || '—'} fill`),
      el('span', 'rc-info-line', '🌐 Records are public on IPFS'));
  };
  renderInfo();
  header.append(el('span', 'rc-badge', '🤝'), heading,
    pill('ⓘ', 'How it works', () => { info.hidden = !info.hidden; }),
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
    if (!editor || viewing) {
      head.disabled = true;
      return { wrap, refresh };
    }
    const body = el('div', 'rc-edit');
    body.hidden = true;
    const done = () => { body.hidden = true; head.setAttribute('aria-expanded', 'false'); refresh(); };
    editor(body, done);
    head.setAttribute('aria-expanded', 'false');
    head.addEventListener('click', () => {
      rows.querySelectorAll('.rc-edit').forEach(other => { if (other !== body && !other.hidden) other.previousElementSibling.click(); });
      body.hidden = !body.hidden;
      head.setAttribute('aria-expanded', String(!body.hidden));
      if (body.hidden) refresh();
      else body.querySelector('input')?.focus();
    });
    wrap.append(body);
    return { wrap, refresh };
  }
  const titleText = () => referralCampaignTitle(values.title);
  const titleRow = row('✏️', 'Title', titleText, (body, done) => {
    const input = el('input');
    input.maxLength = 80;
    input.size = 22;
    input.placeholder = 'Name (optional)';
    input.value = values.title;
    input.addEventListener('input', () => { values.title = input.value; heading.textContent = titleText(); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); done(); } });
    body.append(input, el('span', 'rc-suffix', 'Referral Campaign'), pill('✓', 'Done', done));
  });
  const dateRow = (icon, label, key) => row(icon, label, () => when.format(new Date(values[key])), (body, done) => {
    const input = el('input');
    input.type = 'datetime-local';
    input.step = 60;
    input.value = utcToNewYorkInput(values[key]);
    input.addEventListener('change', () => {
      if (!input.value) return;
      values[key] = newYorkInputToUtc(input.value);
      check();
    });
    const picker = pill('📅', `Pick ${label.toLowerCase()}`, () => { try { input.showPicker(); } catch { input.focus(); } });
    picker.classList.add('rc-picker');
    body.append(picker, input, pill('✓', 'Done', done));
  });
  const contributors = [];
  const referrerText = () => {
    if (!values.referrers.size) return 'Add referrers';
    const names = [...values.referrers].map(wallet => values.names[wallet] || contributors.find(c => c.wallet === wallet)?.name || short(wallet));
    return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
  };
  let renderPeople = () => {};
  const peopleRow = row('👥', 'Referrers', referrerText, (body, done) => {
    const list = el('div', 'rc-people');
    const nameInput = el('input', 'rc-name');
    nameInput.size = 9;
    nameInput.maxLength = 40;
    nameInput.placeholder = 'Name';
    nameInput.setAttribute('aria-label', 'Referrer name');
    const add = el('input');
    add.size = 15;
    add.placeholder = '0x… or name.eth';
    add.setAttribute('aria-label', 'Add another referrer wallet');
    const addButton = pill('＋', 'Add referrer', async () => {
      try {
        const value = add.value.trim();
        if (!value) return;
        const wallet = /^0x[0-9a-f]{40}$/i.test(value) ? value : await resolvePromotionWallet(value, (await promotionWallet()).provider);
        values.referrers.add(wallet.toLowerCase());
        const name = nameInput.value.trim() || (/\.eth$/i.test(value) ? value : '');
        if (name) values.names[wallet.toLowerCase()] = name;
        add.value = '';
        nameInput.value = '';
        renderPeople();
        say();
      } catch (error) { say(error.message, 'error'); }
    });
    renderPeople = () => {
      const everyone = [...contributors, ...[...values.referrers].filter(w => !contributors.some(c => c.wallet === w)).map(wallet => ({ wallet, name: values.names[wallet] || short(wallet) }))];
      const all = el('label', 'rc-check rc-all');
      const allBox = el('input');
      allBox.type = 'checkbox';
      allBox.checked = everyone.length > 0 && everyone.every(c => values.referrers.has(c.wallet));
      allBox.addEventListener('change', () => {
        everyone.forEach(c => allBox.checked ? values.referrers.add(c.wallet) : values.referrers.delete(c.wallet));
        renderPeople();
      });
      all.append(allBox, el('span', '', 'All'));
      list.replaceChildren(all, ...everyone.map(person => {
        const label = el('label', 'rc-check');
        const box = el('input');
        box.type = 'checkbox';
        box.value = person.wallet;
        box.checked = values.referrers.has(person.wallet);
        box.addEventListener('change', () => {
          box.checked ? values.referrers.add(person.wallet) : values.referrers.delete(person.wallet);
          allBox.checked = everyone.every(c => values.referrers.has(c.wallet));
        });
        label.title = person.wallet;
        label.append(box, el('span', '', person.name), el('small', '', short(person.wallet)));
        return label;
      }));
    };
    renderPeople();
    const adder = el('div', 'rc-inline');
    adder.append(nameInput, add, addButton);
    for (const input of [nameInput, add]) input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addButton.click(); } });
    body.append(list, adder, pill('✓', 'Done', done));
  });
  const budgetText = () => {
    const c = config();
    return c.valid ? `${money(values.budgetUnits)} · ${c.maxConversions} × ${money(c.rewardUnits)} · 🗳 ${c.requiredVotes}`
      : `${money(values.budgetUnits)} · ⚠️ check breakdown`;
  };
  const budgetRow = row('💵', 'Budget', budgetText, (body, done) => {
    const money$ = (label, icon, initial, onValue) => {
      const wrap = el('label', 'rc-money');
      wrap.title = label;
      const input = el('input');
      input.inputMode = 'decimal';
      input.size = 5;
      input.value = dollars(initial);
      input.setAttribute('aria-label', label);
      input.addEventListener('input', () => {
        const units = dollarsToUnits(input.value);
        input.classList.toggle('is-bad', units === null);
        if (units !== null) { onValue(units); changed(); }
      });
      wrap.append(el('span', 'rc-icon', icon), el('span', 'rc-dollar', '$'), input);
      return wrap;
    };
    const total = money$('Total budget', '💵', values.budgetUnits, units => { values.budgetUnits = units; });
    total.classList.add('rc-total');
    const legs = el('div', 'rc-legs');
    legs.append(...MUSICIAN_REFERRAL_PILOT.rewardLegs.map(leg => money$(`${LEG_LABELS[leg.id]} per musician`, LEG_ICONS[leg.id],
      values.legAmounts[leg.id], units => { values.legAmounts[leg.id] = units; })));
    const votes = el('label', 'rc-money');
    votes.title = 'Votes each new musician casts';
    const votesInput = el('input');
    votesInput.type = 'number'; votesInput.min = 1; votesInput.max = 100; votesInput.value = values.requiredVotes;
    votesInput.setAttribute('aria-label', 'Votes required');
    votesInput.addEventListener('input', () => { values.requiredVotes = Number(votesInput.value); changed(); });
    votes.append(el('span', 'rc-icon', '🗳'), votesInput);
    const math = el('p', 'rc-math');
    const updateMath = () => {
      const c = config();
      math.textContent = c.valid ? `${c.maxConversions} musicians × ${money(c.rewardUnits)}`
        : `⚠️ ${money(values.budgetUnits)} ÷ ${money(c.rewardUnits)} must be whole (max 100)`;
      math.dataset.tone = c.valid ? '' : 'error';
    };
    function changed() { updateMath(); renderInfo(); budgetRow.refresh(); check(); }
    updateMath();
    body.append(total, legs, votes, math, pill('✓', 'Done', done));
  });
  const allocation = el('p', 'rc-allocation');
  const fundRow = row('🏦', 'Fund', () => fund?.exists ? `${REFERRALS_FUND} · ${money(fund.available)} free` : REFERRALS_FUND);
  rows.append(titleRow.wrap, dateRow('🟢', 'Start', 'startsAt').wrap, dateRow('🏁', 'End', 'endsAt').wrap,
    dateRow('⏳', 'Claims close', 'claimDeadline').wrap, peopleRow.wrap, budgetRow.wrap, fundRow.wrap, allocation);

  const footer = el('footer', 'rc-foot');
  const runButton = el('button', 'rc-run', '▶ Run Campaign');
  runButton.type = 'button';
  if (viewing) {
    allocation.remove();
    const stats = el('div', 'rc-stats');
    stats.append(el('span', '', `🎯 ${campaign.remainingAwards ?? '—'} open`),
      el('span', '', `✅ ${campaign.qualifiedConversions ?? 0} converted`),
      el('span', '', `💸 ${money(campaign.paidUnits || 0)} paid`));
    rows.append(stats);
    footer.append(pill('⚙ Manage', 'Review claims and payments', () => {
      dialog.close();
      openPromotionCalendarEditor({ startsAt: campaign.startsAt, endsAt: campaign.endsAt, campaignId: campaign.id });
    }));
  } else footer.append(runButton);

  function check() {
    if (viewing) return true;
    let message = '', tone = 'info', ok = false;
    const c = config();
    const budget = BigInt(values.budgetUnits);
    const shortfall = fund?.available !== undefined && budget > fund.available ? budget - fund.available : 0n;
    if (!c.valid) { message = '⚠️ Fix the budget breakdown'; tone = 'error'; }
    else if (!fund) message = '⏳ Checking fund…';
    else if (fund.error) { message = `⚠️ ${fund.error}`; tone = 'error'; }
    else if (!fund.exists || !fund.active) { message = `🏦 Create ${REFERRALS_FUND} in Payroll first`; tone = 'error'; }
    else if (shortfall > 0n) { message = `Allocating ${money(budget)} of ${money(fund.available)} · ${money(shortfall)} more will be deposited from your wallet`; ok = true; }
    else { message = `Allocating ${money(budget)} of ${money(fund.available)} in ${REFERRALS_FUND}`; ok = true; }
    allocation.textContent = message;
    allocation.dataset.tone = tone;
    runButton.textContent = ok && shortfall > 0n ? `▶ Fund ${money(shortfall)} & Run` : '▶ Run Campaign';
    runButton.disabled = busy || !ok;
    fundRow.refresh();
    return ok;
  }
  async function refreshFund() {
    try { fund = await readReferralFund(BigInt(values.budgetUnits)); }
    catch (error) { fund = { error: error.shortMessage || error.message || 'Fund check unavailable' }; }
    if (dialog.isConnected) { budgetRow.refresh(); check(); }
  }
  runButton.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    runButton.disabled = true;
    try {
      if (!isAdminWallet()) throw new Error('Connect the admin wallet');
      const w = await promotionWallet();
      const payload = referralCampaignPayload({ ...values, referrers: [...values.referrers] });
      await refreshFund();
      if (fund.error || !fund.exists || !fund.active) throw new Error(fund.error || `Create ${REFERRALS_FUND} first`);
      if (fund.shortfall > 0n) {
        await depositSettlementUsdc({
          router: new w.ethers.Contract(REFERRAL_ROUTER_ADDRESS, ROUTER_ABI, w.signer),
          token: new w.ethers.Contract(PROMOTIONS_USDC, TOKEN_ABI, w.signer),
          signer: w.signer, owner: w.address, fundId: w.ethers.id(REFERRALS_FUND), amountUnits: fund.shortfall,
          onStep: text => say(`🦊 ${text}`),
        });
        await refreshFund();
        if (fund.shortfall > 0n) throw new Error('Deposit confirmed but the fund still reads short; refresh and retry');
      }
      say('✍️ Sign to run');
      const result = await signedPromotionCommand({ action: 'run', revision: fund.revision, campaign: payload });
      const ran = (result.campaigns || []).filter(c => c.template === MUSICIAN_REFERRAL_PILOT.template && c.status === 'published')
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
      dialog.close();
      document.dispatchEvent(new CustomEvent('promotions-changed', { detail: { campaign: ran } }));
      onRan(ran);
    } catch (error) {
      say(error.shortMessage || error.message, 'error');
    } finally {
      busy = false;
      check();
    }
  });

  heading.textContent = viewing ? campaign.title : titleText();
  dialog.append(header, info, rows, status, footer);
  document.body.append(dialog);
  dialog.addEventListener('close', () => { dialog.remove(); if (openDialog === dialog) openDialog = null; }, { once: true });
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    dialog.close();
  });
  dialog.showModal();
  if (anchor && innerWidth > 640) {
    dialog.style.inset = 'auto';
    dialog.style.margin = '0';
    const width = dialog.getBoundingClientRect().width;
    const height = parseFloat(getComputedStyle(dialog).maxHeight) || 560;
    dialog.style.left = `${Math.min(Math.max(12, anchor.x - width / 2), innerWidth - width - 12)}px`;
    dialog.style.top = `${Math.min(Math.max(12, anchor.y - 40), innerHeight - height - 12)}px`;
  }
  check();
  if (!viewing) void refreshFund();
  void loadReferralContributors().then(list => {
    contributors.splice(0, contributors.length, ...list);
    renderPeople();
    peopleRow.refresh();
  });
  return dialog;
}
