import { utcToNewYorkInput, newYorkInputToUtc } from './radio-calendar.mjs?v=20261024-programming-calendar';
import { performerRoomUrl } from './performer-room.mjs?v=20261110-wallet-practice';
import { mountDBuskCalendar } from './dbusk-calendar.mjs';
export { utcToNewYorkInput, newYorkInputToUtc };
const TIME_ZONE = 'America/New_York';
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function buildRadioScheduleAuthorizationMessage({ address, origin, issuedAt, events, weeklySchedule = {} }) {
  return [
    'DecentBusking radio schedule update',
    `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`,
    `Issued At: ${issuedAt}`,
    `Events: ${JSON.stringify(events)}`,
    `Weekly Schedule: ${JSON.stringify(weeklySchedule)}`,
  ].join('\n');
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatHour(hour) {
  if (hour === 24) return '12:00 AM (Saturday)';
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const value = hour % 12 || 12;
  return `${value}:00 ${suffix}`;
}

export function formatWeeklySlot(show) {
  if (show.window === 'final-payroll-hour') return 'Sunday 11:00 PM - Monday 12:00 AM';
  if (Number.isInteger(show.weekday) && Number.isInteger(show.startMinuteLocal) && Number.isInteger(show.endMinuteLocal)) {
    const format = value => {
      const hour = Math.floor(value % 1440 / 60);
      return `${hour % 12 || 12}:${String(value % 60).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
    };
    return `${WEEKDAYS[show.weekday]} ${format(show.startMinuteLocal)} - ${show.endMinuteLocal >= 1440 ? `${WEEKDAYS[(show.weekday + 1) % 7]} ` : ''}${format(show.endMinuteLocal)}`;
  }
  if (Number.isInteger(show.weekday) && Number.isInteger(show.startHourLocal) && Number.isInteger(show.endHourLocal)) {
    const day = WEEKDAYS[show.weekday];
    return `${day} ${formatHour(show.startHourLocal)} - ${formatHour(show.endHourLocal)}`;
  }
  return 'All other hours';
}

export function scheduledLiveOccurrences(payload, now = Date.now()) {
  const events = [...(payload.events || [])];
  const local = utcToNewYorkInput(new Date(now).toISOString()).slice(0, 10);
  for (let day = 0; day < 8; day++) {
    const date = new Date(`${local}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + day);
    const key = date.toISOString().slice(0, 10);
    for (const show of payload.schedule || []) {
      if (show.type !== 'live_performance' || show.weekday !== date.getUTCDay()) continue;
      const id = `${show.id}:${key}`;
      if (events.some(event => event.id === id)) continue;
      const startUtc = newYorkInputToUtc(`${key}T${String(show.startHourLocal).padStart(2, '0')}:00`);
      const endDate = new Date(date);
      if (show.endHourLocal === 24) endDate.setUTCDate(endDate.getUTCDate() + 1);
      const endUtc = newYorkInputToUtc(`${endDate.toISOString().slice(0, 10)}T${String(show.endHourLocal % 24).padStart(2, '0')}:00`);
      if (Date.parse(endUtc) > now) events.push({ id, title: show.label, startUtc, endUtc, priority: show.priority });
    }
  }
  return events;
}

export function performerBookingForOccurrence(bookings = [], eventId, wallet = '') {
  if (!wallet) return null;
  return (Array.isArray(bookings) ? bookings : []).find(booking => booking.eventId === eventId &&
    String(booking.wallet || '').toLowerCase() === String(wallet).toLowerCase() &&
    booking.mode === 'phase1' && booking.status === 'draft' && !booking.cancelled) || null;
}

export function liveEventStageBooking(bookings, event, now = Date.now()) {
  if (!event || event.status === 'cancelled' || Date.parse(event.endUtc) <= now) return null;
  return (Array.isArray(bookings) ? bookings : []).find(booking => booking.eventId === event.id &&
    booking.status === 'funded' && booking.acknowledged === true &&
    performerRoomUrl(booking, now)) || null;
}

export function renderLiveEventStageEntry(booking, now = Date.now()) {
  const url = performerRoomUrl(booking, now);
  if (!url) return null;
  const entry = element('div', 'radio-stage-entry');
  const link = element('a', 'payroll-btn', 'Open performer / operator stage');
  link.href = url;
  link.target = '_blank'; link.rel = 'noopener';
  link.dataset.liveStage = booking.id;
  const start = Date.parse(booking.startUtc);
  const time = minutes => new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit',
  }).format(new Date(start - minutes * 60000));
  entry.append(link, element('p', '', `${now < start - 70 * 60000
    ? `Private practice is available now. Backstage opens at ${time(70)}.`
    : 'Backstage is open. Connect your booked performer wallet or the operator wallet.'} Soundchecks: ${time(60)} and ${time(15)} New York time.`),
    element('small', '', 'Performer: connect your wallet, choose your microphone/interface, then Publish browser audio. Operator: connect the owner wallet and Listen to private soundcheck. Audience: listen on the main radio at showtime. This link alone grants no private-room access.'));
  return entry;
}

export function partitionRadioScheduleEvents(events, now = Date.now()) {
  const upcoming = [];
  const archived = [];
  for (const event of events) {
    (Date.parse(event.endUtc) > now ? upcoming : archived).push(event);
  }
  upcoming.sort((first, second) => Date.parse(first.startUtc) - Date.parse(second.startUtc));
  archived.sort((first, second) => Date.parse(second.startUtc) - Date.parse(first.startUtc));
  return { upcoming, archived };
}

export function promotionCalendarEvents(state) {
  return (state?.campaigns || []).filter(campaign =>
    campaign.template === 'musician-referral' &&
    ['published', 'paused', 'closed'].includes(campaign.status) &&
    Number.isFinite(Date.parse(campaign.startsAt)) && Number.isFinite(Date.parse(campaign.endsAt)))
    .map(campaign => ({
      id: `promotion:${campaign.id}`, campaignId: campaign.id, type: 'referral_campaign',
      title: campaign.title, startUtc: campaign.startsAt, endUtc: campaign.endsAt,
      status: campaign.status, promotion: campaign,
    }));
}

export function initRadioScheduleBoard() {
  const dialog = document.getElementById('radio-schedule-dialog');
  const status = document.getElementById('radio-schedule-status');
  const root = document.getElementById('dbusk-public-calendar');
  if (!dialog || !status || !root || root.dataset.mounted) return;
  root.dataset.mounted = 'true';
  const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
  const subscribe = document.getElementById('radio-calendar-subscribe');
  const feed = document.getElementById('radio-calendar-feed');
  if (service && subscribe && feed) {
    const feedUrl = `${service}/api/radio/calendar.ics`;
    subscribe.href = feedUrl.replace(/^https?:/, 'webcal:');
    subscribe.hidden = false;
    feed.value = feedUrl;
  }
  document.getElementById('radio-calendar-copy')?.addEventListener('click', async () => {
    try {
      if (!feed?.value) throw new Error('Calendar service is not configured');
      await navigator.clipboard.writeText(feed.value);
      status.textContent = 'Calendar URL copied. Add it as a subscribed calendar (Google: Other calendars → From URL; Apple/Outlook: Subscribe from web). Refresh timing and alerts are controlled by your calendar app.';
    } catch (error) {
      console.warn('[radio-calendar] Could not copy subscription URL:', error.message);
      status.textContent = `Could not copy calendar URL: ${error.message}. Select and copy the URL below.`;
      feed?.select();
    }
  });
  const calendar = mountDBuskCalendar(root, { dialog, status, serviceUrl: service,
    tipRouters: { tips: window.DecentConfig?.tipRouterAddress, sharedTips: window.DecentConfig?.tipSplitRouterAddress } });
  if (new URLSearchParams(window.location.search).get('schedule') === '1') calendar.open();
  return calendar;
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initRadioScheduleBoard, { once: true });
