import { currentPayrollPeriod, PAYROLL_TIME_ZONE } from './payroll-week.mjs';

const USDC = 1_000_000n;
const FINAL_SHOW_DURATION_MS = 60 * 60 * 1000;

export const DEFAULT_ADS_PER_MUSIC_SLOT = 10;
export const DEFAULT_DEVERT_MINIMUM_WEEKLY_PRICE = 5n * USDC;
export const MAX_LIVE_EVENT_DURATION_MS = 4 * 60 * 60 * 1000;
export const MAX_LIVE_EVENT_HORIZON_MS = 60 * 24 * 60 * 60 * 1000;
export const MAX_LIVE_SCHEDULE_EVENTS = 100;
const WEEKLY_SLOT_IDS = ['friday-top10-hype', 'friday-live-performance'];

function normalizeLivePerformanceEvent(event) {
  if (!event || typeof event !== 'object') throw new Error('Invalid live performance event');
  const id = String(event.id || '').trim();
  const title = String(event.title || '').trim();
  const startUtc = String(event.startUtc || '');
  const endUtc = String(event.endUtc || '');
  const utcTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;
  const start = Date.parse(startUtc);
  const end = Date.parse(endUtc);
  if (!id || id.length > 100 || !title || title.length > 100 || !utcTimestamp.test(startUtc) || !utcTimestamp.test(endUtc) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error('Invalid live performance event');
  }
  if (end - start > MAX_LIVE_EVENT_DURATION_MS) throw new Error('Live performance events cannot exceed four hours');
  const priority = Number(event.priority ?? 200);
  if (!Number.isFinite(priority)) throw new Error('Invalid live performance event priority');
  return { id, type: 'live_performance', title, startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString(), priority };
}

export function upsertLivePerformanceEvent(events, event, { now = Date.now() } = {}) {
  const normalized = normalizeLivePerformanceEvent(event);
  const start = Date.parse(normalized.startUtc);
  if (start <= now) throw new Error('Live performance start must be in the future');
  if (start - now > MAX_LIVE_EVENT_HORIZON_MS) throw new Error('Live performance start must be within 60 days');
  const current = Array.isArray(events) ? events : [];
  const next = current.filter(item => item.id !== normalized.id).map(normalizeLivePerformanceEvent);
  if (next.length >= MAX_LIVE_SCHEDULE_EVENTS) throw new Error('Live performance calendar is full');
  next.push(normalized);
  return next.sort((first, second) => Date.parse(first.startUtc) - Date.parse(second.startUtc));
}

export function removeLivePerformanceEvent(events, eventId) {
  return (Array.isArray(events) ? events : []).filter(event => event.id !== eventId);
}

export function validateLivePerformanceSchedule(events, { now = Date.now() } = {}) {
  if (!Array.isArray(events) || events.length > MAX_LIVE_SCHEDULE_EVENTS) throw new Error('Invalid live performance calendar');
  const normalized = events.map(normalizeLivePerformanceEvent);
  if (new Set(normalized.map(event => event.id)).size !== normalized.length) throw new Error('Duplicate live performance event ID');
  return normalized.filter(event => {
    const start = Date.parse(event.startUtc);
    const end = Date.parse(event.endUtc);
    if (start > now + MAX_LIVE_EVENT_HORIZON_MS) throw new Error('Live performance start must be within 60 days');
    return end > now;
  }).sort((first, second) => Date.parse(first.startUtc) - Date.parse(second.startUtc));
}

export function validateWeeklyScheduleOverrides(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Invalid weekly programming');
  const result = {};
  for (const [id, slot] of Object.entries(overrides)) {
    if (!WEEKLY_SLOT_IDS.includes(id) || !slot || typeof slot !== 'object' ||
      slot.weekday !== 5 || !Number.isInteger(slot.startHourLocal) || slot.startHourLocal < 0 || slot.startHourLocal > 23 ||
      !Number.isInteger(slot.endHourLocal) || slot.endHourLocal < 1 || slot.endHourLocal > 24 ||
      slot.endHourLocal <= slot.startHourLocal || slot.endHourLocal - slot.startHourLocal > 4) {
      throw new Error('Invalid weekly programming');
    }
    result[id] = { weekday: 5, startHourLocal: slot.startHourLocal, endHourLocal: slot.endHourLocal };
  }
  const hype = result['friday-top10-hype'];
  const live = result['friday-live-performance'];
  if (hype && live && hype.startHourLocal < live.endHourLocal && live.startHourLocal < hype.endHourLocal) {
    throw new Error('Weekly programming slots cannot overlap');
  }
  return result;
}

export function serializeLiveSchedule(value, { savedAt = new Date().toISOString() } = {}) {
  const state = Array.isArray(value) ? { events: value, weeklySchedule: {} } : value || {};
  return {
    schemaVersion: 2,
    savedAt,
    events: (Array.isArray(state.events) ? state.events : []).map(normalizeLivePerformanceEvent),
    weeklySchedule: validateWeeklyScheduleOverrides(state.weeklySchedule || {}),
  };
}

export function deserializeLiveSchedule(snapshot) {
  if (![1, 2].includes(snapshot?.schemaVersion) || !Array.isArray(snapshot.events)) {
    throw new Error('Live schedule snapshot has an unsupported format');
  }
  const events = snapshot.events.map(normalizeLivePerformanceEvent);
  if (events.length > MAX_LIVE_SCHEDULE_EVENTS) throw new Error('Live schedule snapshot exceeds the event limit');
  return {
    events: events.sort((first, second) => Date.parse(first.startUtc) - Date.parse(second.startUtc)),
    weeklySchedule: validateWeeklyScheduleOverrides(snapshot.weeklySchedule || {}),
  };
}

function normalizeTrack(track) {
  if (!track || typeof track !== 'object') return null;
  const normalized = { ...track };
  const votesValue = Number.isFinite(normalized.votes)
    ? Number(normalized.votes)
    : Number(normalized.netVotes ?? normalized.score ?? ((Number(normalized.likes) || 0) - (Number(normalized.dislikes) || 0) * 0.5));
  const playsValue = Number.isFinite(normalized.plays)
    ? Number(normalized.plays)
    : Number(normalized.playCount ?? normalized.totalPlays ?? 0);
  normalized.votes = Number.isFinite(votesValue) ? votesValue : 0;
  normalized.plays = Number.isFinite(playsValue) ? playsValue : 0;
  return normalized;
}

export function defaultRadioSchedule(weeklySchedule = {}) {
  const overrides = validateWeeklyScheduleOverrides(weeklySchedule);
  return [
    { id: 'normal-rotation', type: 'normal_rotation', label: 'Normal Rotation', priority: 10 },
    { id: 'friday-top10-hype', type: 'weekly_top10', label: 'Friday Top 10 Hype Hour', priority: 90,
      weekday: 5, startHourLocal: overrides['friday-top10-hype']?.startHourLocal ?? 20,
      endHourLocal: overrides['friday-top10-hype']?.endHourLocal ?? 21, timeZone: PAYROLL_TIME_ZONE },
    { id: 'friday-live-performance', type: 'live_performance', label: 'Friday Live Performance Block', priority: 200,
      weekday: 5, startHourLocal: overrides['friday-live-performance']?.startHourLocal ?? 21,
      endHourLocal: overrides['friday-live-performance']?.endHourLocal ?? 22, timeZone: PAYROLL_TIME_ZONE },
    { id: 'weekly-top10-final-listen', type: 'weekly_top10', label: 'Sunday Top 10 Final Listen', priority: 90, window: 'final-payroll-hour' },
  ];
}

function compareByRotationScore(first, second) {
  const a = normalizeTrack(first);
  const b = normalizeTrack(second);
  if (!a || !b) return 0;
  const voteDelta = (b.votes || 0) - (a.votes || 0);
  if (voteDelta !== 0) return voteDelta;
  const playDelta = (b.plays || 0) - (a.plays || 0);
  if (playDelta !== 0) return playDelta;
  return String(a.title || '').localeCompare(String(b.title || '')) || String(a.trackId || '').localeCompare(String(b.trackId || ''));
}

export function rankRotationTracks(tracks) {
  return [...(Array.isArray(tracks) ? tracks : [])]
    .map(normalizeTrack)
    .filter(Boolean)
    .sort(compareByRotationScore);
}

export function rankWeeklyTopTenTracks(playlist, weeklyReport) {
  const eligible = new Map((Array.isArray(playlist) ? playlist : [])
    .filter(track => track && (track.source !== 'site' || track.mintStatus === 'minted'))
    .map(track => [track.trackId, track]));
  return (weeklyReport?.tracks || [])
    .filter(entry => eligible.has(entry.trackId) && (entry.plays > 0 || entry.votes !== 0))
    .map(entry => ({ ...eligible.get(entry.trackId), votes: Number(entry.votes) || 0, plays: Number(entry.plays) || 0 }))
    .sort(compareByRotationScore)
    .slice(0, 10);
}

function localDateAndHour(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
  return { weekday, hour: Number(parts.hour), date: `${parts.year}-${parts.month}-${parts.day}` };
}

function isShowActive(show, now) {
  if (show.window === 'final-payroll-hour') {
    if (show.type !== 'weekly_top10') return false;
    const endAt = Date.parse(currentPayrollPeriod(now).endAt);
    return now >= endAt - FINAL_SHOW_DURATION_MS && now < endAt;
  }
  if (show.timeZone && Number.isInteger(show.weekday)) {
    const local = localDateAndHour(now, show.timeZone);
    return local.weekday === Number(show.weekday) && local.hour >= Number(show.startHourLocal) && local.hour < Number(show.endHourLocal);
  }
  if (show.type !== 'weekly_top10') return false;
  const date = new Date(now);
  return Number(show.weekday) === date.getUTCDay() &&
    date.getUTCHours() >= Number(show.startHourUtc || 20) &&
    date.getUTCHours() < Number(show.endHourUtc || 21);
}

export function resolveActiveShow({ now = Date.now(), schedule = defaultRadioSchedule(), livePerformanceEvents = [] } = {}) {
  const live = Array.isArray(livePerformanceEvents) ? livePerformanceEvents : [];
  const activeLive = live
    .filter(event => {
      const start = Date.parse(event.startUtc || event.start || '1970-01-01T00:00:00Z');
      const end = Date.parse(event.endUtc || event.end || '1970-01-01T00:00:00Z');
      return Number.isFinite(start) && Number.isFinite(end) && now >= start && now < end;
    })
    .sort((first, second) => Number(second.priority || 0) - Number(first.priority || 0))[0];

  if (activeLive) {
    return {
      id: activeLive.id || 'live-performance',
      type: 'live_performance',
      label: activeLive.title || 'Live Performance Block',
      priority: Number(activeLive.priority || 200),
      event: activeLive,
    };
  }

  const liveShow = (schedule || []).find(show => show.type === 'live_performance' && isShowActive(show, now));
  if (liveShow) {
    const localDate = localDateAndHour(now, liveShow.timeZone || PAYROLL_TIME_ZONE).date;
    return {
      ...liveShow,
      type: 'live_performance',
      event: {
        id: `${liveShow.id}:${localDate}`,
        title: liveShow.label,
        priority: Number(liveShow.priority || 200),
      },
    };
  }

  const top10Show = (schedule || []).find(show => show.type === 'weekly_top10' && isShowActive(show, now));
  if (top10Show) return { ...top10Show, type: 'weekly_top10' };

  const fallback = (schedule || []).find(show => show.type === 'normal_rotation') || { id: 'normal-rotation', type: 'normal_rotation', label: 'Normal Rotation', priority: 10 };
  return { ...fallback, type: 'normal_rotation' };
}

function chooseAdCampaign(adCampaigns, showType) {
  const list = Array.isArray(adCampaigns) ? adCampaigns : [];
  if (!list.length) return null;
  if (showType === 'live_performance') return null;
  const seated = list.filter(campaign => campaign && campaign.mainRadio !== false && campaign.kind !== 'overflow');
  return seated[0] || list[0] || null;
}

export function buildRadioProgram({
  tracks = [],
  topTenTracks = [],
  now = Date.now(),
  schedule = defaultRadioSchedule(),
  livePerformanceEvents = [],
  adCampaigns = [],
  songsPerMainAd = DEFAULT_ADS_PER_MUSIC_SLOT,
} = {}) {
  const show = resolveActiveShow({ now, schedule, livePerformanceEvents });

  if (show.type === 'live_performance' && show.event) {
    return [{
      type: 'live',
      id: show.event.id || 'live-performance',
      title: show.event.title || 'Live Performance Block',
      startUtc: show.event.startUtc || show.event.start,
      endUtc: show.event.endUtc || show.event.end,
      priority: Number(show.event.priority || 200),
    }];
  }

  const rankedTracks = show.type === 'weekly_top10'
    ? rankRotationTracks(topTenTracks.length ? topTenTracks : tracks)
    : rankRotationTracks(tracks);

  const program = [];
  for (let index = 0; index < rankedTracks.length; index++) {
    const track = rankedTracks[index];
    program.push({ type: 'song', ...track });
    const shouldInsertAd = index + 1 < rankedTracks.length && (index + 1) % songsPerMainAd === 0;
    if (shouldInsertAd) {
      const ad = chooseAdCampaign(adCampaigns, show.type);
      if (ad) {
        program.push({ type: 'ad', ...ad, slot: 'main-radio' });
      }
    }
  }

  if (program.length === 0 && Array.isArray(adCampaigns) && adCampaigns.length) {
    const ad = chooseAdCampaign(adCampaigns, show.type);
    if (ad) program.push({ type: 'ad', ...ad, slot: 'overflow' });
  }

  return program;
}

export function createWeeklyTopTenSet(tracks) {
  return rankRotationTracks(tracks).slice(0, 10);
}
