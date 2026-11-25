import { publicCalendarData, personalCalendarEvents, walletKey } from './dbusk-calendar-core.mjs';

const objects = items => Array.isArray(items) && items.every(item => item && typeof item === 'object' && !Array.isArray(item));
const interval = (start, end) => Number.isFinite(Date.parse(start)) && Date.parse(end) > Date.parse(start);
const validators = {
  schedule: data => objects(data?.schedule) && objects(data?.events) &&
    data.events.every(e => e.id && e.title && interval(e.startUtc, e.endUtc)) &&
    data.schedule.every(rule => rule.type === 'normal_rotation' || rule.id && rule.label && (rule.window === 'final-payroll-hour' ||
      Number.isInteger(rule.weekday) && rule.weekday >= 0 && rule.weekday < 7 &&
      Number.isInteger(rule.startMinuteLocal ?? rule.startHourLocal * 60) &&
      (rule.startMinuteLocal ?? rule.startHourLocal * 60) >= 0 &&
      (rule.startMinuteLocal ?? rule.startHourLocal * 60) < 1440 &&
      Number.isInteger(rule.endMinuteLocal ?? rule.endHourLocal * 60) &&
      (rule.endMinuteLocal ?? rule.endHourLocal * 60) > (rule.startMinuteLocal ?? rule.startHourLocal * 60) &&
      (rule.endMinuteLocal ?? rule.endHourLocal * 60) <= 2880)),
  promotions: data => objects(data?.campaigns) && objects(data?.members) &&
    (!data.participantProfiles || objects(data.participantProfiles)) &&
    data.campaigns.every(c => typeof c.id === 'string' && (!c.curatedReferrers || Array.isArray(c.curatedReferrers)) &&
      (!['published', 'paused', 'closed'].includes(c.status) || interval(c.startsAt, c.endsAt))),
  bookings: data => objects(data?.bookings) && data.bookings.every(b => b.mode !== 'phase1' ||
    b.id && walletKey(b.wallet) && interval(b.startUtc, b.endUtc)),
  earnings: data => objects(data?.entries) && typeof data.ready === 'boolean' &&
    data.entries.every(e => walletKey(e.recipient || e.artist) && /^0x[0-9a-f]{64}$/i.test(e.txHash || '') &&
      Number.isSafeInteger(e.blockNumber) && e.blockNumber >= 0),
  ads: data => objects(data?.campaigns) && data.chainId === 8453 && Number.isFinite(Date.parse(data.snapshotAt)) &&
    data.campaigns.every(c => walletKey(c.advertiser) && c.campaignId != null && interval(c.startedAt, c.expiresAt)),
  tips: data => objects(data?.entries) && data.entries.length <= 25 && data.chainId === 8453 && typeof data.ready === 'boolean' &&
    Number.isSafeInteger(data.total) && data.total >= data.entries.length &&
    data.entries.every(e => e.chainId === 8453 && walletKey(e.sender) && walletKey(e.recipient) &&
      typeof e.chainVerified === 'boolean' && /^0x[0-9a-f]{64}$/i.test(e.txHash || '') &&
      Number.isSafeInteger(e.logIndex) && e.logIndex >= 0 && Number.isSafeInteger(e.blockNumber) && e.blockNumber >= 0 &&
      Number.isFinite(Date.parse(e.paidAt))),
};
validators.sharedTips = validators.tips;

export function createCalendarStore({ serviceUrl, fetchImpl = globalThis.fetch, onChange = () => {},
  currentWallet = () => '', now = Date.now, timeoutMs = 12000, tipRouters = {} } = {}) {
  let wallet = '';
  let generation = 0;
  let controller;
  let publicData = publicCalendarData();
  let personal = [];
  let sources = {};
  let checkedAt = 0;
  let disposed = false;
  const snapshot = () => ({ wallet, publicData, personal, sources: { ...sources }, checkedAt });
  const notify = () => { if (!disposed) onChange(snapshot()); };
  const invalidate = () => { generation++; controller?.abort(); controller = null; };
  const clearPersonal = () => {
    personal = [];
    for (const key of ['bookings', 'earnings', 'ads', 'tips', 'sharedTips']) delete sources[key];
  };
  function setWallet(value) {
    const next = walletKey(value);
    if (wallet === next) return;
    invalidate();
    wallet = next;
    clearPersonal();
    checkedAt = 0;
    notify();
  }
  async function refresh({ force = false } = {}) {
    if (disposed || (!force && checkedAt && now() - checkedAt < 60000)) return;
    if (!serviceUrl) {
      sources = { schedule: { status: 'unavailable', error: 'Calendar service is not configured' } };
      notify(); return;
    }
    invalidate();
    const request = generation;
    const address = wallet;
    const ownController = controller = new AbortController();
    const isCurrent = () => !disposed && generation === request && wallet === address &&
      walletKey(currentWallet()) === address;
    const paths = { schedule: '/api/radio/schedule', promotions: '/api/promotions',
      ...(address ? { bookings: '/api/live-bookings', earnings: `/api/earnings/${address}`, ads: '/api/devert' } : {}) };
    for (const key of ['tips', 'sharedTips']) {
      if (address && walletKey(tipRouters[key])) paths[key] = `/api/tips/ledger?${new URLSearchParams({
        wallet: address, router: tipRouters[key], limit: '25', offset: '0',
      })}`;
    }
    for (const key of Object.keys(paths)) sources[key] = { status: 'loading' };
    notify();
    const data = {};
    await Promise.all(Object.entries(paths).map(async ([key, path]) => {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${serviceUrl.replace(/\/$/, '')}${path}`, {
          cache: 'no-store', signal: AbortSignal.any([ownController.signal, timeout.signal]),
        });
        const value = await response.json();
        if (!response.ok) throw new Error(value?.error || `HTTP ${response.status}`);
        if (!validators[key](value)) throw new Error('Invalid calendar source response');
        if (['tips', 'sharedTips'].includes(key) && walletKey(value.routerAddress) !== walletKey(tipRouters[key])) {
          throw new Error('Tip index returned the wrong router');
        }
        if (['tips', 'sharedTips'].includes(key) && value.entries.some(entry =>
          walletKey(entry.routerAddress) !== walletKey(tipRouters[key]) || walletKey(entry.recipient) !== address)) {
          throw new Error('Tip index returned the wrong wallet / router');
        }
        if (!isCurrent()) return;
        data[key] = value;
        const undated = key === 'earnings' && value.entries.some(entry => !Number.isFinite(Number(entry.timestamp)) || Number(entry.timestamp) <= 0);
        const partial = value.ready === false || value.storageError || value.error || value.lastError || undated ||
          value.caughtUp === false || value.restoringCount > 0 || value.total > value.entries?.length;
        sources[key] = { status: partial ? 'partial' : 'ready',
          error: String(value.storageError || value.error || value.lastError ||
            (value.ready === false ? 'Index / schedule is not ready' :
              undated ? 'Some receipts lack block timestamps and are not placed on the calendar' :
                value.total > value.entries?.length ? 'Showing the newest 25 receipts only; older receipts are in Profile' :
                partial ? 'Index recovery is incomplete' : '')),
          through: value.through ?? value.scannedThrough, checkedAt: value.lastCheckedAt };
      } catch (error) {
        if (isCurrent()) sources[key] = { status: 'unavailable',
          error: timeout.signal.aborted ? 'Request timed out' : error.message };
      } finally { clearTimeout(timer); }
    }));
    if (!isCurrent()) return;
    // A failed source is explicitly stale/unavailable, never an empty success.
    if (data.schedule || data.promotions) {
      const next = publicCalendarData(data.schedule, data.promotions);
      publicData = { schedule: data.schedule ? next.schedule : publicData.schedule,
        campaigns: data.promotions ? next.campaigns : publicData.campaigns };
    }
    personal = address ? personalCalendarEvents(data, address, { now: now() }) : [];
    checkedAt = now();
    notify();
  }
  return { snapshot, setWallet, refresh, pause: () => { invalidate(); clearPersonal(); checkedAt = 0; notify(); },
    dispose: () => { disposed = true; invalidate(); clearPersonal(); } };
}
