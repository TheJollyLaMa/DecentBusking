import { formatUsdcUnits } from './usdc-format.mjs?v=20261017-mercury-release';

const units = value => /^\d+$/.test(String(value ?? '')) ? BigInt(value) : null;
const sourceKey = source => source.txHash ? `${source.txHash.toLowerCase()}:${source.logIndex ?? 0}` : null;

export function fundInflowSnapshot(fund, week) {
  return {
    balance: fund.balanceAvailable === false ? null : units(fund.balanceUnits),
    amount: units(fund.budgetUnits ?? fund.balanceUnits),
    mode: fund.budgetUnits == null ? 'balance' : 'budget',
    week,
    sources: fund.sourcesAvailable === false || !Array.isArray(fund.sources) ? null : fund.sources,
  };
}

export function planFundInflow(previous, next) {
  if (!previous || previous.balance == null || next.balance == null ||
    previous.amount == null || next.amount == null || previous.mode !== next.mode ||
    previous.week !== next.week || next.balance <= previous.balance || next.amount <= previous.amount) return null;
  const delta = next.balance - previous.balance;
  const known = new Set((previous.sources || []).map(sourceKey).filter(Boolean));
  const sponsor = previous.sources && next.sources?.some(source =>
    source.kind === 'sponsor' && sourceKey(source) && !known.has(sourceKey(source)) &&
    (units(source.amountUnits) ?? 0n) >= 100_000_000n);
  const kind = sponsor && delta >= 100_000_000n ? 'bag' : delta < 1_000_000n ? 'coin' : 'dollar';
  const step = kind === 'coin' ? 100_000n : kind === 'bag' ? 100_000_000n : 1_000_000n;
  const count = Number((delta + step - 1n) / step > 24n ? 24n : (delta + step - 1n) / step);
  return { kind, count: Math.max(4, count), delta, from: previous.amount, to: next.amount };
}

export function fundDigitSequence(from, to) {
  const start = Number(from || 0);
  const finish = Number(to);
  const steps = 20 + (finish - start + 10) % 10;
  return Array.from({ length: steps + 1 }, (_, index) => String((start + index) % 10));
}

export function animateFundInflow(button, plan) {
  const doc = button.ownerDocument;
  const win = doc.defaultView;
  const target = button.querySelector('.usdc-amount-text');
  if (!target || doc.hidden) return () => {};
  const finalText = target.textContent;
  const oldText = `$${formatUsdcUnits(plan.from)}`;
  const animations = [];
  const particles = [];
  let timer;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    win.clearTimeout(timer);
    animations.forEach(animation => animation.cancel());
    particles.forEach(particle => particle.remove());
    target.textContent = finalText;
    target.removeAttribute('aria-hidden');
    button.classList.remove('fund-inflow-active');
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('resize', cleanup);
    win.removeEventListener('scroll', cleanup);
    motion.removeEventListener('change', cleanup);
  };
  const onVisibility = () => { if (doc.hidden) cleanup(); };
  const motion = win.matchMedia('(prefers-reduced-motion: reduce)');
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('resize', cleanup);
  win.addEventListener('scroll', cleanup, { passive: true });
  motion.addEventListener('change', cleanup);
  button.classList.add('fund-inflow-active');
  if (motion.matches) {
    timer = win.setTimeout(cleanup, 4800);
    return cleanup;
  }
  target.setAttribute('aria-hidden', 'true');
  target.replaceChildren();
  [...finalText].forEach((character, index) => {
    const old = oldText[oldText.length - finalText.length + index];
    if (!/\d/.test(character) || character === old) {
      target.append(doc.createTextNode(character));
      return;
    }
    const digit = doc.createElement('span');
    digit.className = 'fund-inflow-digit';
    const reel = doc.createElement('span');
    reel.className = 'fund-inflow-reel';
    const sequence = fundDigitSequence(/\d/.test(old || '') ? old : '0', character);
    sequence.forEach(value => {
      const cell = doc.createElement('span');
      cell.textContent = value;
      reel.append(cell);
    });
    digit.append(reel);
    target.append(digit);
    animations.push(reel.animate([
      { transform: 'translateY(0)' },
      { transform: `translateY(-${(sequence.length - 1) * 1.2}em)` },
    ], { duration: 3200, delay: index * 110, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'forwards' }));
  });
  const rect = button.getBoundingClientRect();
  for (let index = 0; index < plan.count; index++) {
    const particle = doc.createElement('span');
    particle.className = 'fund-inflow-particle';
    particle.setAttribute('aria-hidden', 'true');
    particle.textContent = { coin: '🪙', dollar: '💵', bag: '💰' }[plan.kind];
    const fraction = (Math.floor(index / 4) + 1) / (Math.ceil(plan.count / 4) + 1);
    const edge = index % 4;
    const x = edge === 0 ? -32 : edge === 1 ? win.innerWidth + 32 : win.innerWidth * fraction;
    const y = edge === 2 ? -32 : edge === 3 ? win.innerHeight + 32 : win.innerHeight * fraction;
    particle.style.left = `${x}px`;
    particle.style.top = `${y}px`;
    doc.body.append(particle);
    particles.push(particle);
    animations.push(particle.animate([
      { transform: 'translate(-50%, -50%) scale(1) rotate(-25deg)', opacity: 0 },
      { opacity: 1, offset: .12 },
      { opacity: 1, offset: .8 },
      { transform: `translate(${rect.left + rect.width / 2 - x}px, ${rect.top + rect.height / 2 - y}px) scale(.4) rotate(25deg)`, opacity: 0 },
    ], { duration: 2800, delay: index * 90, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'both' }));
  }
  timer = win.setTimeout(cleanup, Math.max(5200, finalText.length * 110 + 3500, plan.count * 90 + 3100));
  return cleanup;
}
