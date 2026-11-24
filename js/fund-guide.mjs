const EXPLANATIONS = {
  'dbusk-playback': {
    purpose: 'A weekly thank-you to artists whose approved music is heard on the radio.',
    earning: 'Get an approved song onto the playlist and link a valid artist wallet before the Monday midnight New York cutoff. Qualified weekly plays determine artist shares. The owner reviews the frozen week before paying; estimates are not money already earned or sent.',
  },
  'dbusk-top10': {
    purpose: 'Weekly prizes for charting songs, separate from Playback rewards.',
    earning: 'Approved songs compete on positive weekly net votes, with plays used as a tie-breaker. Link the artist wallet before the Monday midnight New York cutoff. The funded pot determines how many prizes clear the minimum; not every chart position receives money. Closed-week prizes still need owner review and settlement.',
  },
  'dbusk-repo-dev': {
    purpose: 'Keeps the project improving by funding approved contributor work.',
    earning: 'Join the contributor allowlist, take a maintainer-approved bounty, contribute accepted work, or complete an assigned test with owner approval. Credits enter the repository payroll queue and are settled by the owner. This is work-based, not an automatic weekly wage.',
  },
  'dbusk-pinners': {
    purpose: 'Supports community copies of our music and metadata on IPFS.',
    earning: 'You can help pin the public community manifest, but pinning alone currently earns nothing: public availability rewards are not active. Registration, independent availability verification and disbursal must be in place before a recurring reward can be promised.',
  },
  'dbusk-live-performers': {
    purpose: 'Supports reviewed live-performance fees and after-show payments.',
    earning: 'Arrange an approved booking, agree to its published terms, perform and complete the required review. Payment follows the booking agreement, not a weekly participation allowance. This fund is owner-managed earmarking, not the separate booking-escrow contract.',
  },
  'dbusk-promotionals': {
    purpose: 'A pot for approved promotional offers and participation rewards.',
    earning: 'Join a published, funded offer, accept its terms and supply the required evidence before its deadline. An admin reviews the claim. A fund balance alone is not an open campaign or a weekly payout promise.',
  },
  'dbusk-referrals': {
    purpose: 'Funds published musician-referral campaigns and their stated rewards.',
    earning: 'Join an active campaign and follow its attribution, music-upload, vote and deadline requirements. Only verified conversions and approved claims qualify. Read that campaign’s exact terms; these are campaign rewards, not automatic weekly income.',
  },
};

export function fundGuideCopy(fund) {
  return EXPLANATIONS[fund.slug] || {
    purpose: fund.description || 'A newly registered DecentBusking community fund.',
    earning: fund.earningRules || 'No earning schedule has been published in this fund’s metadata. Check its published terms or ask the steward before doing work in expectation of payment. Creating or funding a pot does not create an automatic weekly reward.',
  };
}

export function initFundGuide({ dialog, getFunds, onStart = () => {}, onStop = () => {} }) {
  const launch = document.getElementById('fund-guide-launch');
  if (!launch || launch.dataset.ready) return;
  launch.dataset.ready = '1';
  const root = document.createElement('div');
  root.className = 'fund-guide-overlay';
  root.hidden = true;
  root.innerHTML = `<svg class="fund-guide-shade" aria-hidden="true"><defs><mask id="fund-guide-mask"><rect width="100%" height="100%" fill="white"/><rect data-guide-hole fill="black" rx="14"/></mask></defs><rect width="100%" height="100%" fill="#020611d9" mask="url(#fund-guide-mask)"/></svg>
    <span class="fund-guide-rabbit" aria-hidden="true">🐇</span>
    <section class="fund-guide-card" aria-label="Fund bunny walkthrough">
      <p class="fund-guide-count"></p><h3></h3><p class="fund-guide-purpose"></p>
      <h4>How to take part</h4><p class="fund-guide-earning" aria-live="polite"></p>
      <div><button type="button" data-guide-close>Close</button><button type="button" data-guide-back>Back</button><button type="button" data-guide-next>Next hop</button></div>
    </section>`;
  dialog.append(root);
  const bunny = root.querySelector('.fund-guide-rabbit');
  const hole = root.querySelector('[data-guide-hole]');
  const card = root.querySelector('.fund-guide-card');
  const back = root.querySelector('[data-guide-back]');
  const next = root.querySelector('[data-guide-next]');
  let active = false, index = 0, slug, previousFocus, animation, position;
  const target = () => [...dialog.querySelectorAll('[data-fund-chart-slug]')].find(row => row.dataset.fundChartSlug === slug);
  const paint = (hop = false) => {
    if (!active) return;
    const row = target();
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const cardTop = card.getBoundingClientRect().top;
    const top = Math.max(0, rect.top - 8);
    const height = Math.max(0, Math.min(rect.bottom + 8, cardTop - 12) - top);
    for (const [key, value] of Object.entries({ x: Math.max(0, rect.left - 8), y: Math.max(0, rect.top - 8),
      width: rect.width + 16, height })) hole.setAttribute(key, value);
    bunny.hidden = !height;
    const point = { x: Math.max(8, Math.min(innerWidth - 54, rect.right - 28)),
      y: Math.max(8, Math.min(card.getBoundingClientRect().top - 55, rect.top - 42)) };
    if (hop) animation?.cancel();
    bunny.style.left = `${point.x}px`;
    bunny.style.top = `${point.y}px`;
    if (hop && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const dx = (position?.x ?? point.x) - point.x, dy = (position?.y ?? point.y) - point.y;
      animation = bunny.animate([{ transform: `translate(${dx}px,${dy}px)` },
        { transform: `translate(${dx / 2}px,${dy / 2 - 30}px)`, offset: .5 }, { transform: 'translate(0,0)' }],
      { duration: 520, easing: 'ease-in-out' });
    }
    position = point;
  };
  const stop = () => {
    if (!active) return;
    active = false;
    root.hidden = true;
    animation?.cancel();
    position = null;
    onStop();
    if (dialog.open) previousFocus?.focus?.({ preventScroll: true });
  };
  const render = () => {
    if (!active) return;
    const funds = getFunds();
    if (!funds.length) { stop(); return; }
    index = Math.min(index, funds.length - 1);
    const fund = funds[index];
    slug = fund.slug;
    const copy = fundGuideCopy(fund);
    root.querySelector('h3').textContent = fund.label;
    root.querySelector('.fund-guide-purpose').textContent = copy.purpose;
    root.querySelector('.fund-guide-earning').textContent = copy.earning;
    root.querySelector('.fund-guide-count').textContent = `Hop ${index + 1} of ${funds.length} · purpose, participation & proof`;
    back.disabled = index === 0;
    if (back.disabled && document.activeElement === back) next.focus({ preventScroll: true });
    next.textContent = index === funds.length - 1 ? 'Finish' : 'Next hop';
    const row = target();
    row?.scrollIntoView({ block: 'center', behavior: 'instant' });
    if (row) {
      const overflow = row.getBoundingClientRect().bottom + 18 - card.getBoundingClientRect().top;
      if (overflow > 0) dialog.scrollBy({ top: overflow, behavior: 'instant' });
    }
    paint(true);
  };
  launch.addEventListener('click', () => {
    if (!getFunds().length) return;
    previousFocus = document.activeElement;
    index = 0;
    onStart();
    active = true;
    root.hidden = false;
    render();
    next.focus({ preventScroll: true });
  });
  back.addEventListener('click', () => { if (index > 0) { index--; render(); } });
  next.addEventListener('click', () => { if (index === getFunds().length - 1) stop(); else { index++; render(); } });
  root.querySelector('[data-guide-close]').addEventListener('click', stop);
  // The top-layer guide takes precedence over the page tutorial's document capture.
  window.addEventListener('keydown', event => {
    if (!active) return;
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); stop(); }
    if (event.key === 'Tab') {
      const buttons = [...card.querySelectorAll('button:not(:disabled)')];
      const current = buttons.indexOf(document.activeElement);
      event.preventDefault();
      buttons[(current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus({ preventScroll: true });
    }
  }, true);
  dialog.addEventListener('close', stop);
  dialog.addEventListener('scroll', () => paint(), true);
  window.addEventListener('resize', () => render());
  new MutationObserver(() => {
    if (!active) return;
    const existing = getFunds().findIndex(fund => fund.slug === slug);
    if (existing >= 0) index = existing;
    render();
  }).observe(document.getElementById('fund-balance-chart'), { childList: true, subtree: true });
}
