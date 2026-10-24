import { isAdminWallet } from './admin-access.mjs';
import { cancelLivePerformanceEvent } from './radio-schedule.mjs?v=20261022-playlist-show';
import { utcToNewYorkInput, newYorkInputToUtc, radioCalendarOccurrences, buildRadioCalendar, googleRadioCalendarUrl } from './radio-calendar.mjs';
import { renderPerformerBookingInvite } from './live-performance-profile.mjs?v=20261024-live-prototype';
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
  if (Number.isInteger(show.weekday) && Number.isInteger(show.startHourLocal) && Number.isInteger(show.endHourLocal)) {
    const day = WEEKDAYS[show.weekday];
    return `${day} ${formatHour(show.startHourLocal)} - ${formatHour(show.endHourLocal)}`;
  }
  return 'All other hours';
}

function formatEventTime(value, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(value));
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

function reminderControl(event, status) {
  const details = element('details', 'radio-reminder');
  details.dataset.eventId = event.id;
  details.append(element('summary', '', '🔔 Set reminder'));
  const choices = element('div', 'radio-reminder-choices');
  choices.append(element('span', '', `${formatEventTime(event.startUtc, TIME_ZONE)} · 15 minutes before`));
  const google = element('a', '', 'Google Calendar');
  google.href = googleRadioCalendarUrl(event);
  google.target = '_blank';
  google.rel = 'noopener noreferrer';
  choices.append(google);
  const download = element('button', 'payroll-btn payroll-btn-secondary', 'Apple / Outlook (.ics)');
  download.type = 'button';
  download.addEventListener('click', () => {
    try {
      const blob = new Blob([buildRadioCalendar([event])], { type: 'text/calendar;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = element('a');
      link.href = url;
      link.download = 'decentbusking-radio-reminder.ics';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      status.textContent = 'Calendar event downloaded. Open it and save it in your synced calendar. A 15-minute reminder is included; your calendar app controls notifications.';
    } catch (error) {
      console.warn('[radio-calendar] Event download failed:', error.message);
      status.textContent = `Could not create reminder: ${error.message}`;
    }
  });
  choices.append(download, element('small', '', 'Save to a calendar synced across your devices. In Google Calendar, choose a 15-minute notification before saving. Individual copies do not receive schedule updates.'));
  details.append(choices);
  return details;
}

export function performerBookingForOccurrence(bookings = [], eventId, wallet = '') {
  if (!wallet) return null;
  return (Array.isArray(bookings) ? bookings : []).find(booking => booking.eventId === eventId &&
    String(booking.wallet || '').toLowerCase() === String(wallet).toLowerCase() &&
    booking.mode === 'phase1' && booking.status === 'draft' && !booking.cancelled) || null;
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

function renderSchedule(payload, onCancel, bookingState = null) {
  const weekly = document.getElementById('radio-schedule-weekly');
  const events = document.getElementById('radio-schedule-events');
  const archive = document.getElementById('radio-schedule-archive');
  const archiveTitle = document.getElementById('radio-schedule-archive-title');
  const status = document.getElementById('radio-schedule-status');
  if (!weekly || !events || !archive || !archiveTitle || !status) return;

  const openReminders = new Set([...weekly.querySelectorAll('.radio-reminder[open]'), ...events.querySelectorAll('.radio-reminder[open]')]
    .map(details => details.dataset.eventId));
  const now = Date.now();
  const occurrences = radioCalendarOccurrences(payload, { now, days: 8, pastDays: 0 });
  weekly.replaceChildren();
  for (const show of payload.schedule || []) {
    if (show.type === 'normal_rotation') continue;
    const row = element('li', 'radio-schedule-row');
    row.append(element('strong', 'radio-schedule-name', show.label),
      element('span', 'radio-schedule-time', `${formatWeeklySlot(show)} (${payload.timeZone || TIME_ZONE})`));
    const next = occurrences.find(event => event.id.startsWith(`${show.id}:`) && event.status !== 'cancelled' && Date.parse(event.startUtc) > now);
    if (next && (show.type !== 'live_performance' || payload.ready !== false)) row.append(reminderControl(next, status));
    weekly.append(row);
  }

  events.replaceChildren();
  const { upcoming, archived } = partitionRadioScheduleEvents(scheduledLiveOccurrences(payload, now), now);
  for (const event of upcoming) {
    const cancelled = event.status === 'cancelled';
    const active = !cancelled && Date.parse(event.startUtc) <= now && now < Date.parse(event.endUtc);
    const row = element('li', `radio-schedule-row${active ? ' is-active' : ''}${cancelled ? ' is-cancelled' : ''}`);
    row.append(element('strong', 'radio-schedule-name', event.title),
      element('span', 'radio-schedule-time', `${formatEventTime(event.startUtc, payload.timeZone || TIME_ZONE)} - ${formatEventTime(event.endUtc, payload.timeZone || TIME_ZONE)}`));
    if (event.type === 'playlist_show') {
      const definition = payload.playlistDefinitions?.find(item => item.id === event.playlistId);
      row.append(element('span', 'radio-schedule-time', `Playlist show · ${definition?.rule || 'No votes ever'} · Vote up OR down!`));
    }
    const invitedWallet = window._wallet?.address || '';
    const booking = performerBookingForOccurrence(bookingState?.bookings, event.id, invitedWallet);
    if (!cancelled && booking) row.append(renderPerformerBookingInvite({
      booking, wallet: invitedWallet, serviceUrl: window.DecentConfig?.ipfsUploadServiceUrl,
      ethers: window.ethers,
    }));
    if (active) row.append(element('span', 'radio-schedule-live', 'LIVE NOW'));
    if (cancelled) row.append(element('span', 'radio-schedule-cancelled-stamp', 'Canceled'),
      element('span', 'radio-schedule-cancel-reason', event.cancellationReason));
    else if (isAdminWallet() && payload.ready !== false) {
      const button = element('button', 'admin-btn admin-btn-secondary', 'Cancel event');
      button.type = 'button';
      button.addEventListener('click', () => onCancel(event, button));
      row.append(button);
    }
    if (!cancelled && !active && payload.ready !== false) row.append(reminderControl(event, status));
    events.append(row);
  }
  if (!upcoming.length) events.append(element('li', 'radio-schedule-empty', 'No additional events are scheduled.'));
  archiveTitle.textContent = `🗃 Archived events (${archived.length})`;
  archive.replaceChildren();
  for (const event of archived) {
    const cancelled = event.status === 'cancelled';
    const row = element('li', `radio-schedule-row${cancelled ? ' is-cancelled' : ''}`);
    row.append(element('strong', 'radio-schedule-name', event.title),
      element('span', 'radio-schedule-time', `${formatEventTime(event.startUtc, payload.timeZone || TIME_ZONE)} - ${formatEventTime(event.endUtc, payload.timeZone || TIME_ZONE)}`),
      element('span', cancelled ? 'radio-schedule-cancelled-stamp' : 'radio-schedule-archive-status', cancelled ? 'Canceled' : 'Completed'));
    if (cancelled && event.cancellationReason) row.append(element('span', 'radio-schedule-cancel-reason', event.cancellationReason));
    if (event.type === 'playlist_show') {
      const definition = payload.playlistDefinitions?.find(item => item.id === event.playlistId);
      row.append(element('span', 'radio-schedule-time', `Playlist show · ${definition?.rule || 'No votes ever'}`));
    }
    archive.append(row);
  }
  if (!archived.length) archive.append(element('li', 'radio-schedule-empty', 'No past events are archived yet.'));
  for (const details of [...weekly.querySelectorAll('.radio-reminder'), ...events.querySelectorAll('.radio-reminder')]) {
    details.open = openReminders.has(details.dataset.eventId);
  }
  status.textContent = payload.ready === false
    ? 'Recurring programming is available. The live-event calendar is temporarily unavailable.'
    : 'All times are America/New_York. Live and Top 10 shows take priority over playlist shows.';
}

export function initRadioScheduleBoard() {
  const dialog = document.getElementById('radio-schedule-dialog');
  const status = document.getElementById('radio-schedule-status');
  if (!dialog || !status) return;
  const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
  const subscribe = document.getElementById('radio-calendar-subscribe');
  const feed = document.getElementById('radio-calendar-feed');
  if (service && subscribe && feed) {
    const feedUrl = `${service}/api/radio/calendar.ics`;
    subscribe.href = feedUrl.replace(/^https?:/, 'webcal:');
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
  let currentPayload;
  const cancel = async (event, button) => {
    if (!isAdminWallet() || !window._wallet?.signer) { status.textContent = 'Connect the owner wallet to cancel events.'; return; }
    const reason = window.prompt('Public cancellation reason (shown on the community schedule):');
    if (reason === null) return;
    if (!window.confirm(`Cancel only "${event.title}" on ${formatEventTime(event.startUtc, TIME_ZONE)}? Regular radio will replace this occurrence. This does not settle any performer payment.`)) return;
    button.disabled = true;
    try {
      const signer = window._wallet.signer;
      const address = window._wallet.address;
      const authorization = { address, origin: window.location.origin, issuedAt: new Date().toISOString(),
        events: cancelLivePerformanceEvent(currentPayload.events || [], event, reason),
        weeklySchedule: currentPayload.weeklySchedule || {} };
      status.textContent = 'Sign the occurrence cancellation with the owner wallet…';
      const signature = await signer.signMessage(buildRadioScheduleAuthorizationMessage(authorization));
      if (window._wallet?.signer !== signer || window._wallet?.address !== address) throw new Error('Wallet changed; cancellation not submitted');
      const service = window.DecentConfig.ipfsUploadServiceUrl.replace(/\/$/, '');
      const response = await fetch(`${service}/api/radio/schedule`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...authorization, signature }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Cancellation failed (${response.status})`);
      document.dispatchEvent(new CustomEvent('radio-schedule-updated'));
    } catch (error) { status.textContent = `Cancellation failed: ${error.message}`; }
    finally { button.disabled = false; }
  };
  const refresh = async () => {
    const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
    if (!service) { status.textContent = 'Radio schedule service is not configured.'; return; }
    status.textContent = 'Loading programming schedule...';
    try {
      const response = await fetch(`${service}/api/radio/schedule`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Schedule unavailable (${response.status})`);
      currentPayload = payload;
      let bookingState = null;
      let bookingError = '';
      const walletAddress = window._wallet?.address || '';
      if (walletAddress) {
        try {
          const bookingsResponse = await fetch(`${service}/api/live-bookings`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
          const bookingsPayload = await bookingsResponse.json();
          if (!bookingsResponse.ok) throw new Error(bookingsPayload.error || `Booking invites unavailable (${bookingsResponse.status})`);
          bookingState = bookingsPayload;
        } catch (error) { bookingError = error.message; }
      }
      renderSchedule(payload, cancel, bookingState);
      if (bookingError) status.textContent = `Schedule loaded, but wallet-specific booking invitations could not be checked: ${bookingError}`;
      if (subscribe) {
        subscribe.hidden = !service || payload.ready === false;
      }
    } catch (error) {
      status.textContent = `${error.message}. Try refreshing the schedule.`;
    }
  };
  document.addEventListener('open-radio-schedule', () => {
    if (!dialog.open) dialog.showModal();
    refresh();
  });
  document.getElementById('radio-schedule-close')?.addEventListener('click', () => dialog.close());
  document.getElementById('radio-schedule-refresh')?.addEventListener('click', refresh);
  document.addEventListener('radio-schedule-updated', refresh);
  document.addEventListener('wallet-connected', () => { if (dialog.open) refresh(); });
  document.addEventListener('wallet-disconnected', () => { if (dialog.open) refresh(); });
  document.addEventListener('live-booking-acknowledged', () => { if (dialog.open) refresh(); });
  setInterval(() => { if (dialog.open) refresh(); }, 5 * 60 * 1000);
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initRadioScheduleBoard, { once: true });
