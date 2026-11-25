import { utcToNewYorkInput, newYorkInputToUtc, radioCalendarOccurrences } from './radio-calendar.mjs?v=20261024-programming-calendar';
import { performerRoomUrl } from './performer-room.mjs?v=20261116-curtain';
import { formatLiveAsset } from './live-bookings.mjs?v=20261108-live-audio-pilot';

export const DCAL_ZONE = 'America/New_York';
export const walletKey = value => /^0x[0-9a-f]{40}$/i.test(value || '') ? value.toLowerCase() : '';
export const localDate = value => utcToNewYorkInput(new Date(value).toISOString()).slice(0, 10);
export function addDays(key, count) {
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}
export function calendarRange(anchor, mode = 'week') {
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
  return { dates, start: newYorkInputToUtc(`${startDate}T00:00`),
    end: newYorkInputToUtc(`${addDays(startDate, count)}T00:00`) };
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

// Only allowlisted display fields cross the public/personal boundary. Raw ledger
// payloads contain unpublished offers, review notes and other wallets' invitations.
export function publicCalendarData(schedule, promotions) {
  const events = (schedule?.events || []).filter(event =>
    !event.private && !event.draft && event.published !== false && [undefined, 'scheduled', 'published', 'cancelled'].includes(event.status))
    .map(event => ({ id: event.id, title: event.title, startUtc: event.startUtc, endUtc: event.endUtc,
      type: event.type || 'live_performance', status: event.status, cancellationReason: event.cancellationReason }));
  const rules = (schedule?.schedule || []).filter(rule =>
    !rule.private && !rule.draft && rule.published !== false && [undefined, 'scheduled', 'published'].includes(rule.status))
    .map(rule => Object.fromEntries(['id', 'label', 'type', 'weekday', 'window', 'startMinuteLocal', 'endMinuteLocal',
      'startHourLocal', 'endHourLocal', 'startDateLocal'].map(key => [key, rule[key]])));
  const campaigns = (promotions?.campaigns || []).filter(c =>
    ['published', 'paused', 'closed'].includes(c.status)).map(c => ({
    id: `promotion:${c.id}`, title: c.title, startUtc: c.startsAt, endUtc: c.endsAt, type: 'referral_campaign',
    interval: true, status: c.status, audience: 'public', provenance: 'ipfs-record',
    portal: { kind: 'campaign', id: c.id }, details: ['Reward budget is earmarked, not escrowed. Payment requires a confirmed receipt.'],
  }));
  return { schedule: { events, schedule: rules, ready: schedule?.ready }, campaigns };
}

export function publicCalendarEvents(data, range, { now = Date.now(), showPastRules = false } = {}) {
  const recorded = data?.schedule?.events || [];
  const start = Date.parse(range.start);
  const days = range.dates.length;
  const recurrence = radioCalendarOccurrences({ schedule: data?.schedule?.schedule || [], events: [] },
    { now: start, days, pastDays: 0 });
  const recordedIds = new Set(recorded.map(event => event.id));
  return [
    ...recorded.map(event => ({ ...event, audience: 'public', provenance: 'ipfs-record',
      status: event.status === 'cancelled' ? 'cancelled' : 'scheduled', archived: Date.parse(event.endUtc) <= now,
      details: event.cancellationReason ? [event.cancellationReason] : [] })),
    ...recurrence.filter(event => !recordedIds.has(event.id) && (showPastRules || Date.parse(event.startUtc) >= now) &&
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
    result.push({ id: `promotion:${campaign.id}`, title: campaign.title, startUtc: campaign.startsAt, endUtc: campaign.endsAt,
      type: 'referral_campaign', interval: true, audience: 'personal', owner, provenance: 'ipfs-record', status: campaign.status,
      attention: !member && campaign.status === 'published' && Date.parse(campaign.endsAt) > now ? 'Invited · view campaign' : '',
      portal: { kind: 'campaign', id: campaign.id }, details: [
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

export function intervalSegments(events, dates) {
  const range = { start: newYorkInputToUtc(`${dates[0]}T00:00`),
    end: newYorkInputToUtc(`${addDays(dates.at(-1), 1)}T00:00`) };
  const lanes = [];
  return events.filter(event => event.interval && overlaps(event, range)).map(event => {
    const start = Math.max(0, dates.indexOf(localDate(Date.parse(event.startUtc))));
    const last = localDate(Date.parse(event.endUtc) - 1);
    const end = last > dates.at(-1) ? dates.length : dates.indexOf(last) + 1;
    let lane = lanes.findIndex(items => items.every(item => item.end <= start || item.start >= end));
    if (lane < 0) { lane = lanes.length; lanes.push([]); }
    lanes[lane].push({ start, end });
    return { event, start, end, lane, before: Date.parse(event.startUtc) < Date.parse(range.start),
      after: Date.parse(event.endUtc) > Date.parse(range.end) };
  });
}

export function timedSegments(events, date) {
  const range = { start: newYorkInputToUtc(`${date}T00:00`), end: newYorkInputToUtc(`${addDays(date, 1)}T00:00`) };
  const minute = value => {
    const local = utcToNewYorkInput(new Date(value).toISOString());
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
