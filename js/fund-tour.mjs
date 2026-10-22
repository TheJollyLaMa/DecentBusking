import { initFundHeader, openFundPanel } from './fund-header.mjs?v=20261022-playlist-lane';
import { payrollPeriodFromKey } from './payroll-week.mjs';

export function payrollTourWeek(search) {
  const params = new URLSearchParams(search);
  if (params.get('tutorial') !== 'payroll') return null;
  const week = params.get('week');
  if (!week) return '';
  payrollPeriodFromKey(week);
  return week;
}

export const FUND_TOUR_STEPS = [
  { title: 'Follow the money with the bunny', selectors: ['#dbusk-top10-button', '#dbusk-playback-button'],
    body: 'These two subheader pills are the weekly artist pots: Top 10 song prizes and Playback artist payments. Their dollar figures show the current weekly budget, not proof that artists have already been paid.' },
  { title: 'Inside the Top 10 fund', fund: 'dbusk-top10', selectors: ['#fund-breakdown-summary'],
    body: 'The pool is money available for this week. Older frozen, unpaid allocations are reserved separately. A funded pool is not a completed payroll; follow the confirmed transactions to see what was actually paid.' },
  { title: 'Estimates are not payments', fund: 'dbusk-top10', selectors: ['[data-fund-pending]', '.fund-confirmed-section'],
    body: 'Pending estimates move with votes, plays and funding. The week freezes at Sunday/Monday midnight in New York. Confirmed on-chain activity shows money in and money out, with BaseScan transaction proofs.' },
  { title: 'Find the archived week', fund: 'dbusk-top10', archive: true, selectors: ['.fund-weekly-section'],
    body: 'Expand a week in the payout archive. The frozen allocation is the intended prize plan; only verified payouts mean paid. Open its receipt and transaction links to inspect the exact amounts and proofs.' },
  { title: 'Playback rewards artists across songs', fund: 'dbusk-playback', archive: true, selectors: ['.fund-weekly-section'],
    body: 'The Playback fund rewards qualified plays and groups earnings by artist wallet across songs. Its separate weekly archive lets you compare intended payouts and actual confirmed payments. The Discord report lists the top ten Playback payees by total USDC paid.' },
  { title: 'Bring a sponsor or run an ad', selectors: ['#devert-tab'], action: 'devert',
    body: 'Buying an advertising campaign in the DVert sidepanel helps fund weekly artist payouts through the campaign funding rules. Bring your own project or invite a sponsor. Ad purchases are separate from direct fund contributions: review campaign pricing and terms in DVert.' },
  { title: 'Help grow next week’s pot', fund: 'dbusk-playback', selectors: ['#fund-contribution'], action: 'contribute',
    body: 'You or a sponsor can add $5, $10, $1,000 or a custom amount. Choose Playback or Top 10, then use the contribution button. MetaMask will show Base, native USDC, the fund and amount prefilled; approve only the intended amount, then confirm the contribution. You need Base ETH for gas. No payment is requested by this tour.' },
];

export function initFundTour() {
  const replay = document.getElementById('fund-tour-replay');
  if (!replay || replay.dataset.ready) return;
  replay.dataset.ready = '1';
  const fundDialog = document.getElementById('fund-breakdown-dialog');
  const shell = document.createElement('dialog');
  shell.className = 'fund-tour-shell';
  shell.setAttribute('aria-label', 'Weekly payroll fund tutorial');
  document.body.append(shell);
  const root = document.createElement('div');
  root.className = 'fund-tour-overlay';
  root.hidden = true;
  root.innerHTML = `
    <svg class="fund-tour-shade" aria-hidden="true" width="100%" height="100%">
      <defs><mask id="fund-tour-mask"><rect width="100%" height="100%" fill="white"></rect><g id="fund-tour-holes"></g></mask></defs>
      <rect width="100%" height="100%" fill="rgba(3,5,12,.84)" mask="url(#fund-tour-mask)"></rect>
    </svg>
    <span class="fund-tour-bunny" aria-hidden="true">🐇</span>
    <section class="fund-tour-card" aria-labelledby="fund-tour-title" tabindex="-1">
      <p class="fund-tour-kicker">PAYROLL · PROOFS · COMMUNITY</p>
      <p class="fund-tour-progress"></p>
      <h2 id="fund-tour-title"></h2>
      <p class="fund-tour-copy"></p>
      <p class="fund-tour-status" role="status" aria-live="polite"></p>
      <div class="fund-tour-actions">
        <button type="button" data-tour-close>Close tour</button>
        <button type="button" data-tour-back>Back</button>
        <button type="button" data-tour-action hidden></button>
        <button type="button" data-tour-next>Next hop</button>
      </div>
    </section>`;
  shell.append(root);
  const card = root.querySelector('.fund-tour-card');
  const title = root.querySelector('h2');
  const copy = root.querySelector('.fund-tour-copy');
  const status = root.querySelector('.fund-tour-status');
  const back = root.querySelector('[data-tour-back]');
  const next = root.querySelector('[data-tour-next]');
  const action = root.querySelector('[data-tour-action]');
  const holes = root.querySelector('#fund-tour-holes');
  const bunny = root.querySelector('.fund-tour-bunny');
  let index = 0;
  let week = '';
  let active = false;
  let changing = false;
  let targets = [];
  let previousFocus;
  const stepTargets = step => {
    if (step.archive && week) {
      const selected = [...fundDialog.querySelectorAll('[data-fund-week]')].find(item => item.dataset.fundWeek === week);
      if (selected) return [selected];
    }
    return step.selectors.flatMap(selector => [...document.querySelectorAll(selector)]);
  };

  const paint = () => {
    if (!active) return;
    holes.replaceChildren();
    const rectangles = targets.map(target => target.getBoundingClientRect())
      .filter(rect => rect.width > 0 && rect.height > 0);
    const cardRect = card.getBoundingClientRect();
    for (const rect of rectangles) {
      const hole = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      hole.setAttribute('x', Math.max(0, rect.left - 7));
      hole.setAttribute('y', Math.max(0, rect.top - 7));
      hole.setAttribute('width', rect.width + 14);
      hole.setAttribute('height', Math.max(0, Math.min(rect.bottom + 7, cardRect.top - 12) - Math.max(0, rect.top - 7)));
      hole.setAttribute('rx', '12');
      hole.setAttribute('fill', 'black');
      holes.append(hole);
    }
    const target = rectangles[0];
    bunny.style.left = `${Math.max(4, Math.min(window.innerWidth - 65, (target?.right || 65) - 35))}px`;
    bunny.style.top = `${Math.max(4, Math.min(cardRect.top - 70, (target?.top || 80) - 58))}px`;
  };
  const stop = ({ keepFund = false } = {}) => {
    active = false;
    root.hidden = true;
    root.classList.remove('is-hopping');
    document.body.classList.remove('fund-tour-active');
    if (shell.open) shell.close();
    shell.append(root);
    if (!keepFund && fundDialog.open) fundDialog.close();
    previousFocus?.focus?.();
  };
  const render = async () => {
    if (changing) return;
    changing = true;
    back.disabled = next.disabled = action.disabled = true;
    action.hidden = true;
    const step = FUND_TOUR_STEPS[index];
    title.textContent = step.title;
    copy.textContent = step.body;
    root.querySelector('.fund-tour-progress').textContent = `Hop ${index + 1} of ${FUND_TOUR_STEPS.length}${week ? ` · ${week}` : ''}`;
    status.textContent = 'Opening the guide...';
    try {
      if (step.fund) {
        // A native modal is in the top layer: the guide must move inside it, not hide behind it.
        if (shell.open) shell.close();
        await openFundPanel(step.fund);
        if (!active) { if (fundDialog.open) fundDialog.close(); return; }
        fundDialog.append(root);
        if (step.selectors.includes('[data-fund-pending]')) {
          const pending = fundDialog.querySelector('[data-fund-pending]');
          if (pending) pending.open = true;
        }
        if (step.archive) {
          const archives = [...fundDialog.querySelectorAll('[data-fund-week]')];
          const selected = (week && archives.find(item => item.dataset.fundWeek === week)) || (!week && archives[0]);
          if (selected) selected.open = true;
          else status.textContent = week ? `The archive for ${week} is not available yet. Refresh the fund panel to retry.` : 'The weekly archive is still loading or empty.';
        }
      } else {
        shell.append(root);
        if (fundDialog.open) fundDialog.close();
        if (!shell.open) shell.showModal();
      }
      root.hidden = false;
      if (status.textContent === 'Opening the guide...') status.textContent = '';
      targets = stepTargets(step);
      if (!targets.length) status.textContent = 'This section is unavailable right now. You can continue or close and try again.';
      targets[0]?.scrollIntoView({ block: 'start', behavior: 'instant' });
      root.classList.remove('is-hopping');
      requestAnimationFrame(() => {
        if (!active) return;
        root.classList.add('is-hopping');
        paint();
      });
      back.disabled = index === 0;
      next.textContent = index === FUND_TOUR_STEPS.length - 1 ? 'Finish tour' : 'Next hop';
      action.hidden = !step.action;
      action.textContent = step.action === 'devert' ? 'Open DVert campaigns' : 'Choose a fund & amount';
      card.focus({ preventScroll: true });
    } catch (error) {
      console.warn('[fund-tour]', error);
      if (!active) return;
      shell.append(root);
      if (fundDialog.open) fundDialog.close();
      if (!shell.open) shell.showModal();
      root.hidden = false;
      targets = [];
      paint();
      status.textContent = `${error.message}. Go back and try again, or continue the tour.`;
    } finally {
      changing = false;
      back.disabled = index === 0;
      next.disabled = action.disabled = false;
    }
  };
  const start = async selectedWeek => {
    if (changing) return;
    previousFocus = document.activeElement;
    week = selectedWeek;
    index = 0;
    active = true;
    document.body.classList.add('fund-tour-active');
    await render();
  };
  replay.addEventListener('click', () => start(week));
  root.querySelector('[data-tour-close]').addEventListener('click', () => stop());
  back.addEventListener('click', () => { if (!changing && index > 0) { index--; render(); } });
  next.addEventListener('click', () => {
    if (changing) return;
    if (index === FUND_TOUR_STEPS.length - 1) stop({ keepFund: true });
    else { index++; render(); }
  });
  action.addEventListener('click', event => {
    event.stopPropagation();
    if (changing) return;
    const step = FUND_TOUR_STEPS[index];
    stop({ keepFund: step.action === 'contribute' });
    if (step.action === 'devert') {
      if (!document.getElementById('devert-panel')?.classList.contains('is-open')) document.getElementById('devert-tab')?.click();
    } else document.getElementById('fund-contribution-amount')?.focus();
  });
  for (const dialog of [shell, fundDialog]) {
    dialog.addEventListener('cancel', event => {
      if (active) { event.preventDefault(); stop(); }
    });
    dialog.addEventListener('close', () => { if (active && !changing && dialog.contains(root) && !dialog.open) stop(); });
  }
  window.addEventListener('resize', paint);
  document.addEventListener('scroll', paint, true);
  new MutationObserver(() => {
    if (!active || changing) return;
    targets = stepTargets(FUND_TOUR_STEPS[index]);
    paint();
  }).observe(document.getElementById('fund-breakdown-body'), { childList: true, subtree: true });
  let requestedWeek;
  try { requestedWeek = payrollTourWeek(window.location.search); }
  catch (error) {
    console.warn('[fund-tour]', error);
    const notice = document.createElement('p');
    notice.className = 'fund-tour-link-error';
    notice.setAttribute('role', 'alert');
    notice.textContent = `Unable to open payroll tutorial: ${error.message}. Open either fund pill to browse its weekly archive.`;
    document.getElementById('artist-filter-bar').after(notice);
    return;
  }
  if (requestedWeek !== null) {
    initFundHeader().then(() => start(requestedWeek)).catch(error => {
      console.warn('[fund-tour]', error);
      document.getElementById('fund-breakdown-note').textContent = `Unable to load fund tutorial: ${error.message}`;
      if (!fundDialog.open) fundDialog.showModal();
    });
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initFundTour, { once: true });
  else initFundTour();
}
