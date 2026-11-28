import { utcToZonedInput, zonedInputToUtc, radioCalendarOccurrences } from './radio-calendar.mjs?v=20261024-programming-calendar';
import { performerRoomUrl } from './performer-room.mjs?v=20261116-curtain';
import { formatLiveAsset } from './live-bookings.mjs?v=20261108-live-audio-pilot';
import { campaignAsset, promotionMoney } from './promotions.mjs';

export const DCAL_ZONE = 'America/New_York';
export const walletKey = value => /^0x[0-9a-f]{40}$/i.test(value || '') ? value.toLowerCase() : '';
export const localDate = (value, timeZone = DCAL_ZONE) => utcToZonedInput(new Date(value).toISOString(), timeZone).slice(0, 10);
export function addDays(key, count) {
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}
function calendarDayStart(date, timeZone) {
  try {
    const start = zonedInputToUtc(`${date}T00:00`, timeZone);
    if (localDate(Date.parse(start) - 1, timeZone) < date) return start;
  } catch (error) {
    if (!error.message.includes('daylight-saving')) throw error;
  }
  // Midnight can be skipped or repeated; find the first instant of the civil day.
  const midnight = Date.parse(`${date}T00:00:00Z`);
  let low = midnight - 36 * 3600000;
  let high = midnight + 36 * 3600000;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (localDate(mid, timeZone) < date) low = mid;
    else high = mid;
  }
  return new Date(high).toISOString();
}
export function calendarRange(anchor, mode = 'week', timeZone = DCAL_ZONE) {
  const first = mode === 'month' ? `${anchor.slice(0, 7)}-01` : anchor;
  const weekday = new Date(`${first}T12:00:00Z`).getUTCDay();
  const startDate = addDays(first, -(weekday + 6) % 7);
  let count = 7;
  if (mode === 'month') {
    const next = new Date(`${first}T12:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    count = Math.ceil((Date.parse(next) - Date.parse(`${startDate}T12:00:00Z`)) / 86400000 / 7) * 7;
  }
  const dates = Array.from({ length: count }, (_, i) => addDays(startDate, i));
  return { dates, timeZone, start: calendarDayStart(startDate, timeZone),
    end: calendarDayStart(addDays(startDate, count), timeZone) };
}
export const overlaps = (event, range) => Date.parse(event.startUtc) < Date.parse(range.end) &&
  Date.parse(event.endUtc) > Date.parse(range.start);
const validInterval = event => event?.id && event.title && Number.isFinite(Date.parse(event.startUtc)) &&
  Date.parse(event.endUtc) > Date.parse(event.startUtc);
const hashPattern = /^0x[0-9a-f]{64}$/i;
export function receiptProof(tx) {
  const hash = tx?.hash || tx?.txHash;
  return hashPattern.test(hash || '') ? { hash, url: `https://basescan.org/tx/${hash}` } : null;
}

export const PINNER_GUIDE_URL = 'https://github.com/TheJollyLaMa/DecentBusking/wiki/Earn-by-Pinning';
function pinnerCampaignDetails(c) {
  return [`📌 ${c.qualifyingDays} qualifying full New York days · first ${c.maxAwards} finishers.`,
    `🎁 Campaign bonus: ${promotionMoney(c.rewardUnits, campaignAsset(c))} each. Budget: ${promotionMoney(c.budgetUnits, campaignAsset(c))}.`,
    '① Run an IPFS node and enroll it (Earn by Pinning guide) · ② the admin approves it · ③ Open campaign → Join · ④ pin every day: 20+ independent checks and 90%+ passing makes a qualifying day.',
    '💸 Weekly USDC pinning rewards are paid separately; this bonus is extra.'];
}
export function pinnerCampaignProgress(stats) {
  if (!stats || stats.template !== 'pinner') return null;
  if (stats.completedDays === null || stats.nodeStatus === 'unavailable') {
    return { value: 0, max: stats.qualifyingDays, label: `Verification unavailable: ${stats.error || 'independent checks are unavailable'}` };
  }
  const value = Math.min(stats.completedDays || 0, stats.qualifyingDays);
  const step = stats.nodeStatus === 'not-enrolled' ? 'Enroll your IPFS node to start counting days'
    : stats.nodeStatus === 'pending' ? 'Node awaiting admin approval'
      : stats.eligible ? (stats.claimStatus === 'not-submitted' ? 'Qualified · claim your bonus in the campaign' : `Bonus ${stats.claimStatus}`)
        : stats.rank ? `Finished · rank ${stats.rank} (first ${stats.maxAwards} win)` : `Node ${stats.nodeStatus || 'checking'} · keep pinning`;
  return { value, max: stats.qualifyingDays, label: `${value} / ${stats.qualifyingDays} qualifying days · ${step}` };
}

// Only allowlisted display fields cross the public/personal boundary. Raw ledger
// payloads contain unpublished offers, review notes and other wallets' invitations.
export function publicCalendarData(schedule, promotions) {
  const events = (schedule?.events || []).filter(event =>
    !event.private && !event.draft && event.published !== false && [undefined, 'scheduled', 'published', 'cancelled'].includes(event.status))
    .map(event => ({ id: event.id, title: event.title, startUtc: event.startUtc, endUtc: event.endUtc,
      type: event.type || 'live_performance', status: event.status, cancellationReason: event.cancellationReason,
      calendarHidden: event.calendarHidden === true }));
  const rules = (schedule?.schedule || []).filter(rule =>
    !rule.private && !rule.draft && rule.published !== false && [undefined, 'scheduled', 'published'].includes(rule.status))
    .map(rule => Object.fromEntries(['id', 'label', 'type', 'weekday', 'window', 'startMinuteLocal', 'endMinuteLocal',
      'startHourLocal', 'endHourLocal', 'startDateLocal'].map(key => [key, rule[key]])));
  const campaigns = (promotions?.campaigns || []).filter(c =>
    !c.application && ['published', 'paused', 'closed'].includes(c.status)).map(c => ({
    id: `promotion:${c.id}`, title: c.title, startUtc: c.startsAt, endUtc: c.endsAt, type: 'referral_campaign',
    interval: true, status: c.status, audience: 'public', provenance: 'ipfs-record',
    portal: { kind: 'campaign', id: c.id }, details: [
      ...(c.template === 'pinner' ? pinnerCampaignDetails(c) : []),
      'Reward budget is earmarked, not escrowed. Payment requires a confirmed receipt.',
    ],
  }));
  return { schedule: { events, schedule: rules, ready: schedule?.ready }, campaigns };
}

export function publicCalendarEvents(data, range, { now = Date.now(), showPastRules = false } = {}) {
  const recorded = data?.schedule?.events || [];
  const start = Date.parse(range.start);
  const days = range.dates.length;
  const recurrence = radioCalendarOccurrences({ schedule: data?.schedule?.schedule || [], events: [] },
    { now: start, days: days + 1, pastDays: 1 });
  const recordedIds = new Set(recorded.map(event => event.id));
  return [
    ...recorded.filter(event => !event.calendarHidden).map(event => ({ ...event, audience: 'public', provenance: 'ipfs-record',
      status: event.status === 'cancelled' ? 'cancelled' : 'scheduled', archived: Date.parse(event.endUtc) <= now,
      details: event.cancellationReason ? [event.cancellationReason] : [] })),
    ...recurrence.filter(event => !recordedIds.has(event.id) && (showPastRules || Date.parse(event.endUtc) > now) &&
      !recorded.some(record => (record.type || 'live_performance') === event.type &&
        Date.parse(record.startUtc) < Date.parse(event.endUtc) && Date.parse(record.endUtc) > Date.parse(event.startUtc)))
      .map(event => ({ ...event, audience: 'public', provenance: 'current-rule', status: 'scheduled',
        projectedPast: Date.parse(event.startUtc) < now, details: event.timeAdjustment ? [event.timeAdjustment] : [] })),
    ...(data?.campaigns || []).map(event => ({ ...event, archived: Date.parse(event.endUtc) <= now })),
  ].filter(validInterval).filter(event => overlaps(event, range)).sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));
}

function liveFinancialDetails(booking) {
  const transactions = Object.entries(booking.transactions || {});
  const confirmed = transactions.filter(([, tx]) => tx.status === 'confirmed' && receiptProof(tx));
  const feePaid = confirmed.some(([action]) => ['PerformancePaid', 'FeeSettled'].includes(action)) && booking.status === 'paid';
  const funded = confirmed.some(([action]) => ['BookingFunded', 'Funded', 'funding'].includes(action));
  const pending = transactions.some(([action, tx]) => tx.status === 'pending' &&
    ['funding', 'approve', 'claim', 'refund', 'reject', 'cancel', 'BookingFunded', 'PerformanceApproved',
      'PerformancePaid', 'Funded', 'FeeDecision', 'FeeSettled'].includes(action));
  const giftPending = transactions.some(([action, tx]) => tx.status === 'pending' &&
    ['giftRelease', 'giftReturn', 'GiftDecision', 'GiftSettled'].includes(action));
  const guaranteed = ['pilot-guaranteed-v1', 'asset-guaranteed-v1'].includes(booking.payoutPolicy);
  const fee = (booking.status === 'unavailable' ? 'Fee state unavailable'
    : feePaid ? 'Fee payment confirmed by the indexed escrow receipt'
      : pending ? 'Fee transaction pending · not confirmed paid'
        : ['cancelled', 'refunded', 'recovered', 'failed'].includes(booking.status)
          ? `Fee ${booking.status} · not confirmed paid; check any owed guarantee in Profile`
          : funded && ['funded', 'approved'].includes(booking.status) ? 'Fee escrow funded · not payment received'
            : guaranteed ? 'Fee promised / owed · no confirmed payment shown'
              : 'Conditional fee offer · payment not confirmed; see agreed terms');
  const gift = booking.gift || booking.nftGift;
  const giftPaid = confirmed.some(([action]) => action === 'GiftSettled') && booking.giftStatus === 'received';
  const amount = formatLiveAsset(feePaid ? booking.paidUnits || booking.amountUnits : booking.amountUnits,
    booking.assetDecimals ?? 6, booking.assetSymbol || 'USDC');
  return { details: [`${amount} · ${fee}`, gift ? `NFT gift separately: ${giftPaid ? 'delivery receipt indexed'
    : booking.giftStatus === 'unavailable' ? 'unavailable' : giftPending ? 'transfer pending · not confirmed delivered'
      : `${booking.giftStatus || 'promised'} · not confirmed delivered`}`
    : booking.additionalOffer ? 'NFT / additional offer: separately tracked in Profile; no delivery receipt shown here'
      : 'NFT gift: no separately recorded offer',
    ...(booking.additionalOffer ? [`Outside escrow: ${booking.additionalOffer}`] : [])],
    proofs: confirmed.map(([, tx]) => receiptProof(tx)) };
}

export function personalCalendarEvents({ bookings, promotions, earnings, ads, tips, sharedTips } = {}, wallet, { now = Date.now() } = {}) {
  const owner = walletKey(wallet);
  if (!owner) return [];
  const result = [];
  for (const booking of bookings?.bookings || []) {
    if (walletKey(booking.wallet) !== owner || booking.mode !== 'phase1' || !booking.stewardApproved) continue;
    const financial = liveFinancialDetails(booking);
    const cancelled = booking.cancelled || ['cancelled', 'refunded'].includes(booking.status);
    const invitation = !cancelled && booking.status === 'draft' && !booking.acknowledged && Date.parse(booking.startUtc) > now;
    const base = { id: `booking:${booking.id}`, eventId: booking.eventId, title: booking.title || 'Your live performance',
      startUtc: booking.startUtc, endUtc: booking.endUtc, type: 'personal_show', audience: 'personal', owner,
      provenance: 'scheduled-record', status: cancelled ? 'cancelled' : booking.status === 'unavailable' ? 'unavailable' : 'scheduled',
      attention: invitation ? 'Invitation · accept in Profile' : booking.status === 'approved' ? 'Fee · review claim in Profile' : '',
      portal: { kind: 'profile', wallet: owner, bookingId: booking.id, roomUrl: performerRoomUrl(booking, now) }, ...financial };
    result.push(base);
    if (!cancelled && ['funded', 'approved'].includes(booking.status) && booking.acknowledged) {
      for (const minutes of [60, 15]) {
        const start = Date.parse(booking.startUtc) - minutes * 60000;
        result.push({ ...base, id: `${base.id}:soundcheck:${minutes}`, title: `🎧 Soundcheck · ${minutes} min before`,
          type: 'soundcheck', startUtc: new Date(start).toISOString(), endUtc: new Date(start + 10 * 60000).toISOString(),
          attention: start > now ? 'Soundcheck · open your room' : '', portal: { ...base.portal, kind: 'stage' } });
      }
    }
  }
  for (const campaign of promotions?.campaigns || []) {
    if (!['published', 'paused', 'closed'].includes(campaign.status)) continue;
    const member = (promotions.members || []).some(m => m.campaignId === campaign.id && walletKey(m.wallet) === owner);
    const invited = (campaign.curatedReferrers || []).some(address => walletKey(address) === owner) ||
      (promotions.participantProfiles || []).some(p => p.campaignId === campaign.id && walletKey(p.wallet) === owner);
    if (!member && !invited) continue;
    const pinner = campaign.template === 'pinner';
    const progress = pinner ? pinnerCampaignProgress((promotions.participantProfiles || [])
      .find(p => p.campaignId === campaign.id && walletKey(p.wallet) === owner)) : null;
    result.push({ id: `promotion:${campaign.id}`, title: campaign.title, startUtc: campaign.startsAt, endUtc: campaign.endsAt,
      type: 'referral_campaign', interval: true, audience: 'personal', owner, provenance: 'ipfs-record', status: campaign.status,
      attention: !member && campaign.status === 'published' && Date.parse(campaign.endsAt) > now ? 'Invited · view campaign' : '',
      portal: { kind: 'campaign', id: campaign.id }, ...(progress ? { progress } : {}), details: [
        ...(progress ? [`◈ Your progress: ${progress.label}`] : []),
        ...(pinner ? pinnerCampaignDetails(campaign) : []),
        member ? 'You participate in this campaign.' : 'You are on this campaign’s invitation list.',
        'Rewards are promised / pending until an actual payment receipt; budgets are not escrow.',
      ] });
  }
  for (const item of earnings?.entries || []) {
    if (walletKey(item.recipient || item.artist) !== owner || !receiptProof(item) ||
      !Number.isSafeInteger(item.blockNumber) || item.blockNumber < 0 ||
      !Number.isFinite(Number(item.timestamp)) || Number(item.timestamp) <= 0) continue;
    const timestamp = Number(item.timestamp) * 1000;
    if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime()) || timestamp > now) continue;
    result.push({ id: `receipt:${item.txHash}:${item.logIndex ?? 0}`, title: item.kind === 'payroll' ? '💸 Payroll receipt' : '💸 Music payment receipt',
      startUtc: new Date(timestamp).toISOString(), endUtc: new Date(timestamp + 60000).toISOString(),
      type: 'payment', audience: 'personal', owner, provenance: 'indexed-chain-receipt', status: 'confirmed',
      portal: { kind: 'profile', wallet: owner }, proofs: [receiptProof(item)],
      details: [`${['USDC', 'ETH', 'ART'].includes(item.asset)
        ? formatLiveAsset(item.units, item.asset === 'USDC' ? 6 : 18, item.asset)
        : `${item.units || '0'} base units · ${item.asset || 'asset'}`} · block ${item.blockNumber}`,
        'Contract log indexed by the worker. Open the receipt for on-chain provenance. This is not a new calendar write.'] });
  }
  for (const campaign of ads?.campaigns || []) {
    if (walletKey(campaign.advertiser) !== owner) continue;
    result.push({ id: `advert:${campaign.campaignId}`, title: `📣 ${campaign.title || 'Your ad campaign'}`,
      startUtc: campaign.startedAt, endUtc: campaign.expiresAt, type: 'advert_campaign', interval: true,
      audience: 'personal', owner, provenance: 'chain-state', status: campaign.removed ? 'cancelled' : 'scheduled',
      portal: { kind: 'advert', id: String(campaign.campaignId), wallet: owner },
      details: ['Term read from the existing DVert contract snapshot. Scheduled plays are not proof of completed delivery.'] });
  }
  for (const source of [tips, sharedTips].filter(Boolean)) {
    for (const item of source.entries || []) {
      if (walletKey(item.recipient) !== owner || !receiptProof(item) || !Number.isFinite(Date.parse(item.paidAt))) continue;
      const timestamp = Date.parse(item.paidAt);
      const verified = item.chainVerified === true;
      result.push({ id: `tip:${item.routerAddress}:${item.txHash}:${item.logIndex}`,
        title: item.kind === 'nft' ? '🎁 NFT gift receipt' : '💸 Tip receipt',
        startUtc: new Date(timestamp).toISOString(), endUtc: new Date(timestamp + 60000).toISOString(),
        type: 'payment', audience: 'personal', owner, provenance: verified ? 'indexed-chain-receipt' : 'checkpoint-record',
        status: verified ? 'confirmed' : 'unavailable', portal: { kind: 'profile', wallet: owner }, proofs: [receiptProof(item)],
        details: [verified ? 'Tip router receipt verified by the existing index.' : 'Restored checkpoint · chain receipt verification unavailable; not confirmed received.',
          item.kind === 'nft' ? `NFT ${item.collection} · token ${item.tokenId} · quantity ${item.amount}`
            : `${item.amountUnits || item.amountWei || '0'} base units · ${item.token || 'ETH'}`] });
    }
  }
  return result.filter(validInterval).map(event => ({ ...event, archived: Date.parse(event.endUtc) <= now }));
}

export function calendarEvents(publicData, personal, wallet, range, options) {
  const owner = walletKey(wallet);
  const events = new Map(publicCalendarEvents(publicData, range, options).map(event => [event.id, event]));
  for (const event of personal || []) {
    if (owner && event.owner === owner && overlaps(event, range)) {
      if (event.type === 'personal_show' && event.eventId) events.delete(event.eventId);
      events.set(event.id, event);
    }
  }
  return [...events.values()].sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));
}

export function intervalSegments(events, dates, timeZone = DCAL_ZONE) {
  const range = { start: calendarDayStart(dates[0], timeZone),
    end: calendarDayStart(addDays(dates.at(-1), 1), timeZone) };
  if (range.start === range.end) return [];
  const lanes = [];
  return events.filter(event => event.interval && overlaps(event, range)).map(event => {
    const start = Math.max(0, dates.indexOf(localDate(Date.parse(event.startUtc), timeZone)));
    const last = localDate(Date.parse(event.endUtc) - 1, timeZone);
    const end = last > dates.at(-1) ? dates.length : dates.indexOf(last) + 1;
    let lane = lanes.findIndex(items => items.every(item => item.end <= start || item.start >= end));
    if (lane < 0) { lane = lanes.length; lanes.push([]); }
    lanes[lane].push({ start, end });
    return { event, start, end, lane, before: Date.parse(event.startUtc) < Date.parse(range.start),
      after: Date.parse(event.endUtc) > Date.parse(range.end) };
  });
}

export function groupedIntervalSegments(events, dates, timeZone = DCAL_ZONE) {
  const segments = intervalSegments(events, dates, timeZone);
  const runs = [];
  let active = new Map();
  for (let day = 0; day < dates.length; day++) {
    const groups = new Map();
    for (const { event, start, end } of segments) {
      if (day < start || day >= end) continue;
      const key = `${event.audience}:${event.owner || ''}:${event.type || 'show'}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(event);
    }
    const next = new Map();
    for (const [key, members] of groups) {
      const signature = JSON.stringify([key, ...members.map(event => event.id).sort()]);
      const run = active.get(signature) || { key, members, start: day, end: day };
      if (!active.has(signature)) runs.push(run);
      run.end = day + 1;
      next.set(signature, run);
    }
    active = next;
  }
  const lanes = [];
  return runs.map(({ key, members, start, end }) => {
    const first = members.reduce((a, b) => Date.parse(a.startUtc) <= Date.parse(b.startUtc) ? a : b);
    const last = members.reduce((a, b) => Date.parse(a.endUtc) >= Date.parse(b.endUtc) ? a : b);
    const kinds = { referral_campaign: 'promotions', advert_campaign: 'adverts' };
    const event = members.length === 1 ? first : { ...first, id: `group:interval:${dates[start]}:${key}`,
      title: `${members.length} ${kinds[first.type] || 'events'}`, endUtc: last.endUtc,
      status: members.every(member => member.status === first.status) ? first.status : 'multiple statuses',
      attention: members.find(member => member.attention)?.attention || '', members };
    let lane = lanes.findIndex(items => items.every(item => item.end <= start || item.start >= end));
    if (lane < 0) { lane = lanes.length; lanes.push([]); }
    lanes[lane].push({ start, end });
    return { event, start, end, lane,
      before: members.every(member => localDate(member.startUtc, timeZone) < dates[start]),
      after: members.every(member => localDate(Date.parse(member.endUtc) - 1, timeZone) > dates[end - 1]) };
  });
}

export function timedSegments(events, date, timeZone = DCAL_ZONE) {
  const range = { start: calendarDayStart(date, timeZone), end: calendarDayStart(addDays(date, 1), timeZone) };
  if (range.start === range.end) return [];
  const minute = value => {
    const local = utcToZonedInput(new Date(value).toISOString(), timeZone);
    return Number(local.slice(11, 13)) * 60 + Number(local.slice(14));
  };
  const segments = events.filter(event => !event.interval && overlaps(event, range)).map(event => {
    const start = Math.max(Date.parse(event.startUtc), Date.parse(range.start));
    const end = Math.min(Date.parse(event.endUtc), Date.parse(range.end));
    const top = minute(start);
    const bottom = end === Date.parse(range.end) ? 1440 : Math.max(top + 15, minute(end));
    return { event, top, bottom, displayBottom: Math.min(1440, Math.max(top + 60, bottom)), start, end };
  }).sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  const groups = [];
  for (const segment of segments) {
    const group = groups.at(-1);
    if (!group || group.end <= segment.top) groups.push({ end: segment.displayBottom, items: [segment] });
    else { group.end = Math.max(group.end, segment.displayBottom); group.items.push(segment); }
  }
  for (const group of groups) {
    const ends = [];
    for (const segment of group.items) {
      let lane = ends.findIndex(end => end <= segment.top);
      if (lane < 0) lane = ends.length;
      ends[lane] = segment.displayBottom;
      segment.lane = lane;
    }
    for (const segment of group.items) segment.lanes = ends.length;
  }
  return segments;
}

export function calendarLayer(event) {
  if (event.type === 'payment') return 'receipts';
  if (event.type === 'advert_campaign') return 'adverts';
  if (event.type === 'referral_campaign') return 'campaigns';
  if (event.audience === 'personal') return 'invitations';
  return 'schedule';
}

export function groupCalendarDay(events, date, timeZone = DCAL_ZONE) {
  const groups = new Map();
  for (const segment of timedSegments(events, date, timeZone)) {
    const event = segment.event;
    const key = `${event.audience}:${event.owner || ''}:${event.type || 'show'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(segment);
  }
  return [...groups.entries()].map(([key, segments]) => {
    if (segments.length === 1) return segments[0].event;
    const first = segments[0];
    const kinds = { payment: 'payment / gift receipts', soundcheck: 'soundchecks', personal_show: 'performances',
      live_performance: 'live shows', top10: 'Top 10 shows', playlist_show: 'playlist shows' };
    return { ...first.event, id: `group:${date}:${key}`, title: `${segments.length} ${kinds[first.event.type] || 'events'}`,
      startUtc: new Date(first.start).toISOString(), endUtc: new Date(Math.min(first.end, first.start + 15 * 60000)).toISOString(),
      status: segments.every(segment => segment.event.status === first.event.status) ? first.event.status : 'multiple statuses',
      attention: segments.find(segment => segment.event.attention)?.event.attention || '',
      members: segments.map(segment => segment.event) };
  });
}
