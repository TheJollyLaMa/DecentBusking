const test = require('node:test');
const assert = require('node:assert/strict');
const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const hash = '0x' + '1'.repeat(64);
const now = Date.parse('2026-11-24T15:00:00Z');
const event = { id: 'show', title: 'Published show', startUtc: '2026-11-27T23:00:00Z', endUtc: '2026-11-28T00:00:00Z' };
const campaign = { id: 'referral', title: 'Referral interval', status: 'published', startsAt: '2026-11-23T05:00:00Z', endsAt: '2026-12-06T05:00:00Z', curatedReferrers: [A] };
const booking = { ...event, id: 'invite', mode: 'phase1', wallet: A, stewardApproved: true, status: 'draft',
  payoutPolicy: 'pilot-guaranteed-v1', amountUnits: '20000000' };
const load = () => import('../js/dbusk-calendar-core.mjs');

test('public allowlist excludes drafts, privileged details and every other wallet’s invitation', async () => {
  const { publicCalendarData, calendarEvents, personalCalendarEvents, calendarRange } = await load();
  const publicData = publicCalendarData({ events: [event, { ...event, id: 'draft', status: 'draft' }, { ...event, id: 'private', private: true }], schedule: [] },
    { campaigns: [campaign, { ...campaign, id: 'secret', status: 'draft', title: 'Secret' }] });
  const personal = personalCalendarEvents({ bookings: { bookings: [booking, { ...booking, id: 'other', wallet: B }] },
    promotions: { campaigns: [campaign], members: [] } }, A, { now });
  const range = calendarRange('2026-11-24');
  const signedOut = calendarEvents(publicData, personal, '', range, { now });
  assert.deepEqual(signedOut.map(e => e.id).sort(), ['promotion:referral', 'show']);
  assert.equal(JSON.stringify(publicData).includes(A), false);
  assert.equal(JSON.stringify(publicData).includes('Secret'), false);
  const own = calendarEvents(publicData, personal, A, range, { now });
  assert.equal(own.find(e => e.id === 'promotion:referral').audience, 'personal');
  assert.match(own.find(e => e.id === 'booking:invite').attention, /accept/);
  assert.equal(own.some(e => e.id === 'booking:other'), false);
  assert.equal(calendarEvents(publicData, personal, B, range, { now }).some(e => e.owner === A), false);
});

test('calendar weeks, leap months, NY day boundaries and DST use civil dates', async () => {
  const { calendarRange, localDate } = await load();
  assert.equal(localDate(Date.parse('2026-11-02T04:30:00Z')), '2026-11-01');
  const fall = calendarRange('2026-11-01');
  assert.equal(fall.dates[0], '2026-10-26');
  assert.equal(fall.end, '2026-11-02T05:00:00.000Z');
  assert.equal((Date.parse(fall.end) - Date.parse(fall.start)) / 3600000, 169);
  const spring = calendarRange('2027-03-14');
  assert.equal((Date.parse(spring.end) - Date.parse(spring.start)) / 3600000, 167);
  assert.ok(calendarRange('2024-02-29', 'month').dates.includes('2024-02-29'));
  assert.equal(calendarRange('2026-12-31').dates.at(-1), '2027-01-03');
});

test('old explicitly recorded entries survive range projection; past current rules are opt-in and labelled', async () => {
  const { publicCalendarData, publicCalendarEvents, calendarRange } = await load();
  const past = { ...event, id: 'old', startUtc: '2022-01-07T20:00:00Z', endUtc: '2022-01-07T21:00:00Z' };
  const data = publicCalendarData({ events: [past], schedule: [{ id: 'rule', label: 'Current Friday', type: 'live_performance', weekday: 5, startHourLocal: 20, endHourLocal: 21 }] });
  const range = calendarRange('2022-01-01', 'month');
  const archived = publicCalendarEvents(data, range, { now });
  assert.deepEqual(archived.map(e => e.id), ['old']);
  assert.equal(archived[0].archived, true);
  assert.equal(archived[0].status, 'scheduled');
  assert.equal(archived[0].provenance, 'ipfs-record');
  const projected = publicCalendarEvents(data, range, { now, showPastRules: true });
  assert.ok(projected.some(e => e.projectedPast && e.provenance === 'current-rule'));
  assert.equal(projected.some(e => ['completed', 'paid'].includes(e.status)), false);
});

test('continuous multiweek bars clip to each week, midnight-exclusive ends and separate overlap lanes', async () => {
  const { intervalSegments, calendarRange } = await load();
  const dates = calendarRange('2026-11-24').dates;
  const e = { ...event, interval: true, startUtc: '2026-11-21T05:00:00Z', endUtc: '2026-12-02T05:00:00Z' };
  const [first, second] = intervalSegments([e, { ...e, id: 'overlap' }], dates);
  assert.deepEqual([first.start, first.end, first.before, first.after], [0, 7, true, true]);
  assert.notEqual(first.lane, second.lane);
  const final = intervalSegments([e], calendarRange('2026-12-01').dates)[0];
  assert.deepEqual([final.start, final.end, final.before, final.after], [0, 2, true, false]);
});

test('overlapping interval events share one blip per day without hiding their individual dates', async () => {
  const { groupedIntervalSegments, calendarRange } = await load();
  const dates = calendarRange('2026-11-24').dates;
  const first = { id: 'one', title: 'First promotion', type: 'referral_campaign', interval: true,
    audience: 'public', status: 'published', startUtc: '2026-11-21T05:00:00Z', endUtc: '2026-11-26T05:00:00Z' };
  const second = { ...first, id: 'two', title: 'Second promotion', status: 'paused',
    startUtc: '2026-11-25T05:00:00Z', endUtc: '2026-12-02T05:00:00Z' };
  const personal = { ...second, id: 'own', audience: 'personal', owner: A };
  const otherWallet = { ...personal, id: 'other', owner: B };
  const segments = groupedIntervalSegments([first, second, personal, otherWallet], dates);
  const combined = segments.find(segment => segment.event.members);
  assert.deepEqual([combined.start, combined.end], [2, 3]);
  assert.equal(combined.event.title, '2 promotions');
  assert.equal(combined.event.status, 'multiple statuses');
  assert.deepEqual(combined.event.members, [first, second]);
  assert.ok(segments.some(segment => segment.event === first && segment.start === 0 && segment.end === 2));
  assert.ok(segments.some(segment => segment.event === second && segment.start === 3 && segment.end === 7));
  assert.ok(segments.some(segment => segment.event === personal && segment.start === 2 && segment.end === 7));
  assert.ok(segments.some(segment => segment.event === otherWallet && segment.start === 2 && segment.end === 7));
  assert.equal(combined.before, false);
  assert.equal(combined.after, false);

  const early = { ...first, id: 'early', startUtc: '2026-11-24T05:30:00Z', endUtc: '2026-11-24T06:00:00Z' };
  const later = { ...second, id: 'later', startUtc: '2026-11-24T08:30:00Z', endUtc: '2026-11-24T09:00:00Z' };
  assert.ok(groupedIntervalSegments([early, later], dates, 'America/New_York').some(segment => segment.event.members));
  assert.ok(groupedIntervalSegments([early, later], dates, 'America/Los_Angeles').every(segment => !segment.event.members));
});

test('timed events cross midnight and competing slots do not cover each other', async () => {
  const { timedSegments } = await load();
  const spanning = { ...event, startUtc: '2026-11-28T04:30:00Z', endUtc: '2026-11-28T05:30:00Z' };
  const friday = timedSegments([spanning], '2026-11-27')[0];
  assert.deepEqual([friday.top, friday.bottom], [1410, 1440]);
  const saturday = timedSegments([spanning, { ...spanning, id: 'second' }], '2026-11-28');
  assert.deepEqual([saturday[0].top, saturday[0].bottom, saturday[0].lanes], [0, 30, 2]);
  assert.notEqual(saturday[0].lane, saturday[1].lane);
});

test('an exact own booking overlays its published occurrence without duplicating the recurring live block', async () => {
  const { personalCalendarEvents, publicCalendarData, calendarEvents, calendarRange } = await load();
  const publicData = publicCalendarData({ events: [event], schedule: [
    { id: 'weekly-live', label: 'Weekly live', type: 'live_performance', weekday: 5, startHourLocal: 18, endHourLocal: 19 },
  ] });
  const personal = personalCalendarEvents({ bookings: { bookings: [{ ...booking, eventId: event.id }] } }, A, { now });
  const result = calendarEvents(publicData, personal, A, calendarRange('2026-11-24'), { now });
  assert.equal(result.length, 1);
  assert.equal(result[0].audience, 'personal');
  assert.equal(result[0].id, 'booking:invite');
});

test('payments use real contract-log timestamps, not show dates; unproven / undated rows are excluded', async () => {
  const { personalCalendarEvents } = await load();
  const receipt = { recipient: A, kind: 'payroll', txHash: hash, timestamp: Date.parse('2023-03-06T22:00:00Z') / 1000,
    blockNumber: 200, logIndex: 1, asset: 'USDC', units: '20000000' };
  const result = personalCalendarEvents({ earnings: { entries: [receipt, { ...receipt, recipient: B },
    { ...receipt, timestamp: undefined }, { ...receipt, txHash: '' }, { ...receipt, timestamp: 1e100 }] } }, A, { now });
  assert.equal(result.length, 1);
  assert.equal(result[0].startUtc, '2023-03-06T22:00:00.000Z');
  assert.equal(result[0].status, 'confirmed');
  assert.equal(result[0].provenance, 'indexed-chain-receipt');
  assert.equal(result[0].proofs[0].url, `https://basescan.org/tx/${hash}`);
});

test('escrow fee, NFT, pending and unavailable remain distinct; room uses existing booking policy', async () => {
  const { personalCalendarEvents } = await load();
  const project = b => personalCalendarEvents({ bookings: { bookings: [b] } }, A, { now })[0];
  assert.match(project(booking).details[0], /promised \/ owed/);
  assert.match(project({ ...booking, status: 'funded', transactions: { BookingFunded: { status: 'confirmed', hash } } }).details[0], /not payment received/);
  const pending = project({ ...booking, status: 'paid', transactions: { PerformancePaid: { status: 'pending', hash } } });
  assert.match(pending.details[0], /pending.*not confirmed paid/);
  const paid = project({ ...booking, status: 'paid', transactions: { PerformancePaid: { status: 'confirmed', hash } }, gift: {}, giftStatus: 'promised' });
  assert.match(paid.details[0], /payment confirmed/);
  assert.match(paid.details[1], /not confirmed delivered/);
  assert.match(project({ ...booking, status: 'unavailable' }).details[0], /unavailable/);
  const giftPending = project({ ...booking, status: 'funded', gift: {}, transactions: {
    BookingFunded: { status: 'confirmed', hash }, giftRelease: { status: 'pending', hash },
  } });
  assert.match(giftPending.details[0], /escrow funded/);
  assert.match(giftPending.details[1], /transfer pending/);
  assert.match(project({ ...booking, payoutPolicy: 'conditional' }).details[0], /Conditional fee offer/);
  for (const status of ['refunded', 'recovered']) {
    const returned = project({ ...booking, status, transactions: { BookingFunded: { status: 'confirmed', hash } } });
    assert.match(returned.details[0], new RegExp(`Fee ${status}`));
    assert.doesNotMatch(returned.details[0], /escrow funded/);
  }
  assert.equal(project(booking).portal.roomUrl, 'live-room.html?booking=invite');
  assert.equal(project({ ...booking, payoutPolicy: 'unknown' }).portal.roomUrl, null);
});

test('portals preserve campaign IDs and never open another wallet’s personal detail', async () => {
  const { calendarPortal } = await import('../js/dbusk-calendar.mjs');
  assert.equal(calendarPortal({ audience: 'personal', owner: A, portal: { kind: 'profile' } }, B), null);
  assert.deepEqual(calendarPortal({ audience: 'personal', owner: A, portal: { kind: 'profile', bookingId: 'invite' } }, A),
    { kind: 'profile', address: A, bookingId: 'invite', roomUrl: undefined });
  assert.equal(calendarPortal({ audience: 'public', portal: { kind: 'campaign', id: 'a & b' } }, '', { pathname: '/Busking/' }).href,
    '/Busking/?promotion=a%20%26%20b');
});

test('NFT receipt verification remains separate from a restored off-chain checkpoint', async () => {
  const { personalCalendarEvents } = await load();
  const tip = { recipient: A, sender: B, txHash: hash, routerAddress: A, logIndex: 2, paidAt: '2026-11-23T17:00:00Z',
    chainVerified: true, kind: 'nft', collection: B, tokenId: '75', amount: '1' };
  const project = entry => personalCalendarEvents({ sharedTips: { entries: [entry] } }, A, { now })[0];
  assert.equal(project(tip).status, 'confirmed');
  assert.equal(project(tip).provenance, 'indexed-chain-receipt');
  assert.match(project(tip).details[1], /token 75.*quantity 1/);
  assert.equal(project({ ...tip, chainVerified: false }).status, 'unavailable');
  assert.equal(project({ ...tip, chainVerified: false }).provenance, 'checkpoint-record');
});

test('source fetches are concurrent; disconnect and account-switch discard stale responses', async () => {
  const { createCalendarStore } = await import('../js/dbusk-calendar-store.mjs');
  let wallet = A;
  const calls = [];
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const fetchImpl = async url => {
    calls.push(url); await barrier;
    const data = url.endsWith('/schedule') ? { schedule: [], events: [event] }
      : url.endsWith('/promotions') ? { campaigns: [campaign], members: [] }
        : url.endsWith('/live-bookings') ? { bookings: [booking] }
          : url.endsWith('/devert') ? { chainId: 8453, snapshotAt: '2026-11-24T14:00:00Z', campaigns: [] }
            : { ready: true, entries: [] };
    return { ok: true, json: async () => data };
  };
  const store = createCalendarStore({ serviceUrl: 'https://worker.test', fetchImpl, currentWallet: () => wallet, now: () => now });
  store.setWallet(A);
  const old = store.refresh();
  assert.equal(calls.length, 5);
  wallet = ''; store.setWallet('');
  assert.equal(store.snapshot().personal.length, 0);
  release(); await old;
  assert.equal(store.snapshot().personal.length, 0);
  assert.equal(store.snapshot().checkedAt, 0);
  wallet = B; store.setWallet(B); await store.refresh();
  assert.equal(store.snapshot().personal.some(e => e.owner === A), false);
  store.dispose();
});

test('unavailable / malformed / not-ready sources are visible, never empty-success; public stale data survives', async () => {
  const { createCalendarStore } = await import('../js/dbusk-calendar-store.mjs');
  let fail = false;
  const store = createCalendarStore({ serviceUrl: 'https://worker.test', now: () => now,
    fetchImpl: async url => ({ ok: !fail, status: fail ? 503 : 200, json: async () =>
      fail ? { error: 'Offline' } : url.endsWith('/schedule') ? { schedule: [], events: [event], ready: false } : { campaigns: [], members: [] } }) });
  await store.refresh();
  assert.equal(store.snapshot().sources.schedule.status, 'partial');
  fail = true; await store.refresh({ force: true });
  assert.equal(store.snapshot().sources.schedule.status, 'unavailable');
  assert.equal(store.snapshot().publicData.schedule.events[0].id, event.id);
  store.dispose();
  const malformed = createCalendarStore({ serviceUrl: 'https://worker.test', fetchImpl: async () => ({ ok: true, json: async () => ({ events: [] }) }) });
  await malformed.refresh();
  assert.equal(malformed.snapshot().sources.schedule.status, 'unavailable');
  assert.match(malformed.snapshot().sources.schedule.error, /Invalid/);
  malformed.dispose();
});

test('tip indexes use bounded wallet/router pages and expose partial history rather than complete success', async () => {
  const { createCalendarStore } = await import('../js/dbusk-calendar-store.mjs');
  const urls = [];
  const tip = { chainId: 8453, recipient: A, sender: B, routerAddress: B, txHash: hash, logIndex: 0,
    blockNumber: 20, paidAt: '2026-11-23T17:00:00Z', chainVerified: true };
  const store = createCalendarStore({ serviceUrl: 'https://worker.test', currentWallet: () => A,
    now: () => now, tipRouters: { tips: B }, fetchImpl: async url => {
      urls.push(url);
      return { ok: true, json: async () => url.includes('/tips/ledger') ? { chainId: 8453, routerAddress: B, ready: true, total: 40, entries: [tip] }
        : url.endsWith('/schedule') ? { schedule: [], events: [] }
          : url.endsWith('/promotions') ? { campaigns: [], members: [] }
            : url.endsWith('/live-bookings') ? { bookings: [] }
              : url.endsWith('/devert') ? { chainId: 8453, snapshotAt: '2026-11-24T14:00:00Z', campaigns: [] }
                : { ready: true, entries: [] } };
    } });
  store.setWallet(A); await store.refresh();
  const url = new URL(urls.find(url => url.includes('/tips/ledger')));
  assert.equal(url.searchParams.get('wallet'), A);
  assert.equal(url.searchParams.get('router'), B);
  assert.equal(url.searchParams.get('limit'), '25');
  assert.equal(store.snapshot().sources.tips.status, 'partial');
  assert.match(store.snapshot().sources.tips.error, /newest 25/);
  assert.equal(store.snapshot().personal[0].status, 'confirmed');
  store.dispose();
});

test('source timeouts and pause discard pending work without retaining personal rows', async () => {
  const { createCalendarStore } = await import('../js/dbusk-calendar-store.mjs');
  const store = createCalendarStore({ serviceUrl: 'https://worker.test', currentWallet: () => A, timeoutMs: 5,
    fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  store.setWallet(A);
  await store.refresh();
  assert.equal(store.snapshot().sources.bookings.status, 'unavailable');
  assert.equal(store.snapshot().sources.bookings.error, 'Request timed out');
  const work = store.refresh({ force: true });
  store.pause(); await work;
  assert.equal(store.snapshot().personal.length, 0);
  assert.equal(store.snapshot().sources.bookings, undefined);
  store.dispose();
});

test('calendar primary timezone moves day boundaries and slots without moving the underlying event', async () => {
  const { calendarRange, timedSegments, localDate, intervalSegments, publicCalendarEvents } = await load();
  const early = { ...event, startUtc: '2026-11-24T05:30:00Z', endUtc: '2026-11-24T06:00:00Z' };
  assert.equal(localDate(early.startUtc), '2026-11-24');
  assert.equal(localDate(early.startUtc, 'America/Los_Angeles'), '2026-11-23');
  assert.equal(timedSegments([early], '2026-11-24')[0].top, 30);
  assert.equal(timedSegments([early], '2026-11-23', 'America/Los_Angeles')[0].top, 1290);
  assert.equal(timedSegments([early], '2026-11-24', 'America/Los_Angeles').length, 0);
  const tokyo = calendarRange('2026-11-24', 'week', 'Asia/Tokyo');
  assert.equal(tokyo.start, '2026-11-22T15:00:00.000Z');
  const [bar] = intervalSegments([{ ...early, interval: true }], tokyo.dates, 'Asia/Tokyo');
  assert.deepEqual([bar.start, bar.end], [1, 2]);
  const data = { schedule: { events: [], schedule: [
    { id: 'sunday', label: 'Sunday show', type: 'top10', weekday: 0, startHourLocal: 23, endHourLocal: 24 },
  ] } };
  const recurring = publicCalendarEvents(data, tokyo, { now: Date.parse('2026-11-20T00:00Z') });
  assert.equal(recurring[0].startUtc, '2026-11-23T04:00:00.000Z');
  assert.equal(localDate(recurring[0].startUtc, 'Asia/Tokyo'), tokyo.dates[0]);
  assert.equal(early.startUtc, '2026-11-24T05:30:00Z');
});

test('calendar handles timezones that skip midnight or an entire civil day', async () => {
  const { timedSegments, intervalSegments, calendarRange } = await load();
  const afterJump = { ...event, startUtc: '2026-09-06T04:15:00Z', endUtc: '2026-09-06T04:45:00Z' };
  const [segment] = timedSegments([afterJump], '2026-09-06', 'America/Santiago');
  assert.equal(segment.top, 75);
  assert.equal(segment.bottom, 105);
  const week = calendarRange('2026-09-06', 'week', 'America/Santiago');
  assert.equal((Date.parse(week.end) - Date.parse(week.start)) / 3600000, 167);
  const spanning = { ...event, startUtc: '2011-12-30T09:00:00Z', endUtc: '2011-12-30T11:00:00Z' };
  assert.deepEqual(timedSegments([spanning], '2011-12-30', 'Pacific/Apia'), []);
  assert.deepEqual(intervalSegments([{ ...spanning, interval: true }], ['2011-12-30'], 'Pacific/Apia'), []);
});

test('same-day payment blips retain every receipt and do not mix wallets, types or local days', async () => {
  const { groupCalendarDay, calendarLayer } = await load();
  const payment = { ...event, id: 'first-payment', type: 'payment', audience: 'personal', owner: A,
    startUtc: '2026-11-24T05:30:00Z', endUtc: '2026-11-24T05:31:00Z' };
  const later = { ...payment, id: 'later', startUtc: '2026-11-24T18:00:00Z', endUtc: '2026-11-24T18:01:00Z' };
  const other = { ...later, id: 'other', owner: B };
  const input = [payment, later, other, { ...later, id: 'show', type: 'personal_show' }];
  const grouped = groupCalendarDay(input, '2026-11-24');
  assert.equal(grouped.length, 3);
  const receipts = grouped.find(item => item.members);
  assert.deepEqual(receipts.members.map(item => item.id), ['first-payment', 'later']);
  assert.equal(calendarLayer(receipts), 'receipts');
  assert.ok(Date.parse(receipts.endUtc) - Date.parse(receipts.startUtc) <= 15 * 60000);
  const mixed = groupCalendarDay([{ ...payment, status: 'cancelled' }, { ...later, status: 'confirmed' }], '2026-11-24');
  assert.equal(mixed[0].status, 'multiple statuses');
  assert.equal(groupCalendarDay([payment, later], '2026-11-24', 'America/Los_Angeles').length, 1);
  assert.equal(groupCalendarDay([payment, later], '2026-11-23', 'America/Los_Angeles').length, 1);
  assert.equal(input[0].members, undefined);
});

test('pinner campaign shows public steps and the joined wallet’s own progress', async () => {
  const { publicCalendarData, personalCalendarEvents } = await load();
  const pinner = { ...campaign, id: 'pin', title: 'Pin Reward', template: 'pinner', curatedReferrers: [], asset: 'eth',
    qualifyingDays: 7, maxAwards: 5, rewardUnits: '1000000000000000', budgetUnits: '5000000000000000' };
  const promotions = { campaigns: [pinner], members: [{ campaignId: 'pin', wallet: A }],
    participantProfiles: [{ wallet: A, campaignId: 'pin', template: 'pinner', qualifyingDays: 7, maxAwards: 5,
      completedDays: 3, nodeStatus: 'active', eligible: false, rank: null, claimStatus: 'not-submitted' }] };
  const publicEvent = publicCalendarData({}, promotions).campaigns[0];
  assert.ok(publicEvent.details.some(text => text.startsWith('①')));
  assert.equal(publicEvent.progress, undefined);
  const [mine] = personalCalendarEvents({ promotions }, A, { now });
  assert.deepEqual([mine.progress.value, mine.progress.max], [3, 7]);
  assert.match(mine.details[0], /Your progress: 3 \/ 7 qualifying days/);
  assert.ok(mine.details.some(text => text.startsWith('📌')), 'joined wallets keep the public bonus terms');
  assert.deepEqual(personalCalendarEvents({ promotions }, B, { now }), []);
});
