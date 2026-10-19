export const RADIO_TIME_ZONE = 'America/New_York';
export const RADIO_LISTEN_URL = 'https://thejollylama.github.io/DecentBusking/';

function zonedParts(epoch) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: RADIO_TIME_ZONE,
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

export function radioCalendarOccurrences(payload, { now = Date.now(), days = 90, pastDays = 7 } = {}) {
  const events = new Map((payload.events || []).map(event => [event.id, { ...event }]));
  const local = utcToNewYorkInput(new Date(now).toISOString()).slice(0, 10);
  for (let offset = -pastDays; offset <= days; offset++) {
    const date = new Date(`${local}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    const key = date.toISOString().slice(0, 10);
    for (const show of payload.schedule || []) {
      if (show.type === 'normal_rotation') continue;
      const finale = show.window === 'final-payroll-hour';
      if ((finale ? 0 : show.weekday) !== date.getUTCDay()) continue;
      const id = `${show.id}:${key}`;
      if (events.has(id)) continue;
      const startHour = finale ? 23 : show.startHourLocal;
      const endHour = finale ? 24 : show.endHourLocal;
      if (!Number.isInteger(startHour) || !Number.isInteger(endHour)) throw new Error('Invalid weekly calendar hours');
      const endDate = new Date(date);
      if (endHour === 24) endDate.setUTCDate(endDate.getUTCDate() + 1);
      events.set(id, { id, showId: show.id, title: show.label,
        startUtc: newYorkInputToUtc(`${key}T${String(startHour).padStart(2, '0')}:00`),
        endUtc: newYorkInputToUtc(`${endDate.toISOString().slice(0, 10)}T${String(endHour % 24).padStart(2, '0')}:00`) });
    }
  }
  return [...events.values()]
    .filter(event => Date.parse(event.endUtc) > now - pastDays * 86400_000)
    .sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));
}

function timestamp(value) {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function escapeText(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

function foldLine(line) {
  const lines = [];
  let part = '';
  let bytes = 0;
  for (const character of line) {
    const length = new TextEncoder().encode(character).length;
    if (bytes + length > 75) {
      lines.push(part);
      part = ' ';
      bytes = 1;
    }
    part += character;
    bytes += length;
  }
  lines.push(part);
  return lines.join('\r\n');
}

export function buildRadioCalendar(events, { now = Date.now() } = {}) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DecentBusking//Community Radio//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:DecentBusking Community Radio',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  for (const event of events) {
    if (!event.id || !event.title || !(Date.parse(event.endUtc) > Date.parse(event.startUtc))) throw new Error('Invalid calendar event');
    const cancelled = event.status === 'cancelled';
    const description = cancelled ? `Canceled: ${event.cancellationReason || 'See the community schedule'}` :
      `Listen live: ${RADIO_LISTEN_URL}\nCommunity radio. Calendar times follow your device time zone.`;
    lines.push('BEGIN:VEVENT', `UID:${encodeURIComponent(event.id)}@radio.decentbusking`,
      `DTSTAMP:${timestamp(now)}`, `DTSTART:${timestamp(event.startUtc)}`, `DTEND:${timestamp(event.endUtc)}`,
      `SUMMARY:${escapeText(event.title)}`, `DESCRIPTION:${escapeText(description)}`,
      `URL:${RADIO_LISTEN_URL}`, `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`, 'TRANSP:TRANSPARENT');
    if (!cancelled) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M',
      `DESCRIPTION:${escapeText(`Radio starts in 15 minutes: ${event.title}`)}`, 'END:VALARM');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

export function googleRadioCalendarUrl(event) {
  if (event.status === 'cancelled') throw new Error('Cannot set a reminder for a canceled event');
  const url = new URL('https://calendar.google.com/calendar/render');
  url.search = new URLSearchParams({ action: 'TEMPLATE', text: event.title,
    dates: `${timestamp(event.startUtc)}/${timestamp(event.endUtc)}`,
    details: `Listen live: ${RADIO_LISTEN_URL}\nPlease set a notification for 15 minutes before the show.`,
    location: RADIO_LISTEN_URL }).toString();
  return url.href;
}
