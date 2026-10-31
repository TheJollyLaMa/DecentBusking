const test = require('node:test');
const assert = require('node:assert/strict');

const week = 'NY-2026-10-26';
const source = (id, amountUnits, kind = 'sponsor') => ({ txHash: `0x${id}`, logIndex: 0, amountUnits, kind });

test('only an already-known increase in balance and the same displayed pot triggers inflow', async () => {
  const { fundInflowSnapshot: snapshot, planFundInflow: plan } = await import('../js/fund-inflow.mjs');
  const old = snapshot({ balanceUnits: '10000000', budgetUnits: '5000000', sources: [] }, week);
  const next = snapshot({ balanceUnits: '12000000', budgetUnits: '6000000', sources: [] }, week);
  assert.equal(plan(null, next), null);
  assert.equal(plan(old, old), null);
  assert.equal(plan(next, old), null);
  assert.equal(plan(old, { ...next, week: 'next' }), null);
  assert.equal(plan(old, { ...next, mode: 'balance' }), null);
  assert.equal(plan(old, { ...next, balance: old.balance }), null, 'budget-only corrections are not deposits');
  assert.equal(plan(old, { ...next, amount: old.amount }), null);
  assert.equal(plan(snapshot({ balanceUnits: null }, week), next), null);
  assert.equal(plan(old, snapshot({ balanceUnits: '12000000', balanceAvailable: false }, week)), null);
  assert.deepEqual(plan(old, next), { from: 5000000n, to: 6000000n, delta: 2000000n, kind: 'dollar', count: 4 });
});

test('coins stop at one dollar; bags require a newly evidenced sponsor deposit of at least $100', async () => {
  const { fundInflowSnapshot: snapshot, planFundInflow: plan } = await import('../js/fund-inflow.mjs');
  const old = snapshot({ balanceUnits: '0', sources: [source('old', '100000000')] }, week);
  const next = (delta, sources = []) => snapshot({ balanceUnits: delta, sources }, week);
  assert.equal(plan(old, next('999999')).kind, 'coin');
  assert.equal(plan(old, next('1000000')).kind, 'dollar');
  assert.equal(plan(old, next('99999999', [source('new', '99999999')])).kind, 'dollar');
  assert.equal(plan(old, next('100000000', [source('new', '100000000')])).kind, 'bag');
  assert.equal(plan(old, next('100000000', [source('old', '100000000')])).kind, 'dollar');
  assert.equal(plan(old, next('100000000', [source('new', '100000000', 'advert')])).kind, 'dollar');
  assert.equal(plan(old, next('100000000', [source('new', '100000000', 'djuke')])).kind, 'dollar');
  assert.equal(plan({ ...old, sources: null }, next('100000000', [source('new', '100000000')])).kind, 'dollar');
  assert.equal(plan(old, next('1000000000000000000000000000000000000000')).count, 24);
  assert.ok(plan(old, next('10000000')).count > plan(old, next('1000000')).count);
});

test('every upward digit reel starts at its old digit and lands exactly on its new digit', async () => {
  const { fundDigitSequence } = await import('../js/fund-inflow.mjs');
  for (let from = 0; from < 10; from++) {
    for (let to = 0; to < 10; to++) {
      const sequence = fundDigitSequence(String(from), String(to));
      assert.equal(sequence[0], String(from));
      assert.equal(sequence.at(-1), String(to));
      assert.ok(sequence.length >= 21 && sequence.length <= 30);
      sequence.slice(1).forEach((value, index) => assert.equal(Number(value), (Number(sequence[index]) + 1) % 10));
    }
  }
});

test('reels and particles are bounded, noninteractive and cleaned up before another refresh', async () => {
  const { animateFundInflow } = await import('../js/fund-inflow.mjs');
  const animations = [];
  const timers = new Map();
  const listeners = new Map();
  const motion = { matches: false, addEventListener() {}, removeEventListener() {} };
  const make = tag => ({
    tag, children: [], attributes: {}, style: {}, textContent: '', removed: false,
    append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; },
    setAttribute(key, value) { this.attributes[key] = value; },
    removeAttribute(key) { delete this.attributes[key]; },
    remove() { this.removed = true; },
    animate(frames, options) {
      const animation = { frames, options, cancelled: false, cancel() { this.cancelled = true; } };
      animations.push(animation);
      return animation;
    },
  });
  const win = { innerWidth: 390, innerHeight: 844, matchMedia: () => motion,
    setTimeout(fn, delay) { timers.set(fn, { fn, delay }); return fn; }, clearTimeout(id) { timers.delete(id); },
    addEventListener(key, fn) { listeners.set(key, fn); }, removeEventListener(key) { listeners.delete(key); } };
  const doc = { defaultView: win, hidden: false, body: make('body'), createElement: make,
    createTextNode: text => ({ textContent: text }), addEventListener() {}, removeEventListener() {} };
  const target = make('amount');
  target.textContent = '$100.00';
  const classes = new Set();
  const button = { ownerDocument: doc, querySelector: () => target,
    classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
    getBoundingClientRect: () => ({ left: 20, top: 100, width: 140, height: 30 }) };
  const cleanup = animateFundInflow(button, { from: 9990000n, to: 100000000n, count: 24, kind: 'bag' });
  assert.equal(doc.body.children.length, 24);
  const reels = animations.filter(animation => animation.frames[0].transform === 'translateY(0)');
  const flights = animations.filter(animation => animation.frames.length === 4);
  assert.ok(reels.length > 0);
  assert.ok(reels.every(animation => animation.options.duration === 3200));
  assert.equal(flights.length, 24);
  assert.ok(flights.every(animation => animation.options.duration === 2800));
  assert.equal(flights.at(-1).options.delay, 23 * 90);
  assert.ok([...timers.values()].every(timer => timer.delay >= 5200));
  assert.equal(target.attributes['aria-hidden'], 'true');
  assert.ok(animations.every(animation => animation.options.easing === 'cubic-bezier(.65,0,.35,1)'));
  assert.equal(doc.body.children[0].style.left, '-32px');
  assert.equal(doc.body.children[1].style.left, '422px');
  assert.equal(doc.body.children[2].style.top, '-32px');
  assert.equal(doc.body.children[3].style.top, '876px');
  listeners.get('resize')();
  cleanup();
  assert.ok(animations.every(animation => animation.cancelled));
  assert.ok(doc.body.children.every(particle => particle.removed));
  assert.equal(target.textContent, '$100.00');
  assert.equal(classes.size, 0);
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
  const before = animations.length;
  motion.matches = true;
  animateFundInflow(button, { from: 0n, count: 4, kind: 'coin' })();
  assert.equal(animations.length, before, 'reduced motion is immediate, without particles or reels');
  motion.matches = false;
  doc.hidden = true;
  animateFundInflow(button, { from: 0n, count: 4, kind: 'coin' })();
  assert.equal(animations.length, before, 'hidden tabs do not celebrate unseen refreshes');
});
