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

function zonedParts(epoch) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(epoch)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

export function utcToNewYorkInput(value) {
  const parts = zonedParts(Date.parse(value));
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

export function newYorkInputToUtc(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value || '');
  if (!match) throw new Error('Choose a valid New York date and time');
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  const date = new Date(target);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59) {
    throw new Error('Choose a valid New York date and time');
  }
  let epoch = target;
  for (let attempt = 0; attempt < 5; attempt++) {
    const parts = zonedParts(epoch);
    const displayed = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const next = epoch + target - displayed;
    if (next === epoch) {
      if (parts.year !== year || parts.month !== month || parts.day !== day || parts.hour !== hour || parts.minute !== minute) break;
      return new Date(epoch).toISOString();
    }
    epoch = next;
  }
  throw new Error('That local time does not exist because of a daylight-saving change');
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

function renderSchedule(payload) {
  const weekly = document.getElementById('radio-schedule-weekly');
  const events = document.getElementById('radio-schedule-events');
  const status = document.getElementById('radio-schedule-status');
  if (!weekly || !events || !status) return;

  weekly.replaceChildren();
  for (const show of payload.schedule || []) {
    if (show.type === 'normal_rotation') continue;
    const row = element('li', 'radio-schedule-row');
    row.append(element('strong', 'radio-schedule-name', show.label),
      element('span', 'radio-schedule-time', `${formatWeeklySlot(show)} (${payload.timeZone || TIME_ZONE})`));
    weekly.append(row);
  }

  events.replaceChildren();
  const now = Date.now();
  const upcoming = (payload.events || []).filter(event => Date.parse(event.endUtc) > now)
    .sort((first, second) => Date.parse(first.startUtc) - Date.parse(second.startUtc));
  for (const event of upcoming) {
    const active = Date.parse(event.startUtc) <= now && now < Date.parse(event.endUtc);
    const row = element('li', `radio-schedule-row${active ? ' is-active' : ''}`);
    row.append(element('strong', 'radio-schedule-name', event.title),
      element('span', 'radio-schedule-time', `${formatEventTime(event.startUtc, payload.timeZone || TIME_ZONE)} - ${formatEventTime(event.endUtc, payload.timeZone || TIME_ZONE)}`));
    if (active) row.append(element('span', 'radio-schedule-live', 'LIVE NOW'));
    events.append(row);
  }
  if (!upcoming.length) events.append(element('li', 'radio-schedule-empty', 'No additional live events are scheduled.'));
  status.textContent = payload.ready === false
    ? 'Recurring programming is available. The live-event calendar is temporarily unavailable.'
    : 'All times are America/New_York. Live events temporarily take priority over the weekly shows.';
}

export function initRadioScheduleBoard() {
  const dialog = document.getElementById('radio-schedule-dialog');
  const status = document.getElementById('radio-schedule-status');
  if (!dialog || !status) return;
  const refresh = async () => {
    const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
    if (!service) { status.textContent = 'Radio schedule service is not configured.'; return; }
    status.textContent = 'Loading programming schedule...';
    try {
      const response = await fetch(`${service}/api/radio/schedule`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Schedule unavailable (${response.status})`);
      renderSchedule(payload);
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
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initRadioScheduleBoard, { once: true });
