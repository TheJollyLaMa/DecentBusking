import { radioCalendarOccurrences, utcToNewYorkInput, newYorkInputToUtc } from './radio-calendar.mjs?v=20261024-programming-calendar';
import { RADIO_PLAYLISTS } from './radio-playlists.mjs?v=20261024-programming-calendar';
import { upsertLivePerformanceEvent, validateWeeklyScheduleOverrides, validateRadioProgrammingConflicts } from './radio-schedule.mjs?v=20261024-programming-calendar';

const zone = 'America/New_York';
const dateLabel = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' });
const timeLabel = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' });
const defaultIds = ['friday-top10-hype', 'friday-live-performance', 'weekly-top10-final-listen'];
const slotHeight = 42;
function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function button(text, action) {
  const el = node('button', text);
  el.type = 'button';
  el.addEventListener('click', action);
  return el;
}
function field(form, title, input) {
  const label = node('label', title);
  label.append(input);
  form.append(label);
  return input;
}
function input(type, value = '') {
  const el = node('input');
  el.type = type;
  if (type === 'checkbox') el.checked = value;
  else el.value = value;
  return el;
}
function select(choices, value) {
  const el = node('select');
  for (const [id, title] of choices) {
    const option = node('option', title);
    option.value = id;
    el.append(option);
  }
  el.value = value;
  return el;
}
export function programmingWeek(value = Date.now(), offset = 0) {
  const local = utcToNewYorkInput(new Date(value).toISOString()).slice(0, 10);
  const monday = new Date(`${local}T12:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7 + offset * 7);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

export function programmingNow(value = Date.now()) {
  const local = utcToNewYorkInput(new Date(value).toISOString());
  const minute = Number(local.slice(11, 13)) * 60 + Number(local.slice(14));
  return { date: local.slice(0, 10), minute, slot: Math.floor(minute / 30) };
}

export function mountRadioProgrammingCalendar(root, { getSchedule, save, isCurrent = () => true }) {
  let offset = 0;
  let busy = false;
  let generation = 0;
  let drag = null;
  let editor;
  let status;
  let selectedPreset = 'songs-awaiting-your-vote';
  let selectedDay = programmingNow().date;
  let scrollToNow = true;
  const data = () => getSchedule();
  const presets = () => [...RADIO_PLAYLISTS, ...(data().weeklySchedule?.presets || [])];
  const say = (text, error = false) => {
    status.textContent = text;
    status.classList.toggle('error', error);
  };
  async function persist(events, weekly) {
    if (busy || !isCurrent()) throw new Error('Calendar is busy or wallet changed');
    busy = true;
    const controls = [...root.querySelectorAll('button,input,select')].map(el => [el, el.disabled]);
    root.setAttribute('aria-busy', 'true');
    root.querySelectorAll('button,input,select').forEach(el => { el.disabled = true; });
    say('Sign this schedule update with your owner wallet. No gas or transaction.');
    try {
      validateRadioProgrammingConflicts(events, weekly);
      await save(events, validateWeeklyScheduleOverrides(weekly));
      if (!isCurrent()) return;
      render();
      say('Saved to the shared broadcast calendar.');
    } catch (error) {
      if (isCurrent()) say(error.message, true);
      throw error;
    } finally {
      busy = false;
      root.removeAttribute('aria-busy');
      for (const [el, disabled] of controls) if (el.isConnected) el.disabled = disabled;
    }
  }
  async function move(event, local) {
    if (busy) return;
    const start = newYorkInputToUtc(local);
    const weekly = structuredClone(data().weeklySchedule || {});
    if (defaultIds.includes(event.showId)) {
      if (event.showId === 'weekly-top10-final-listen') throw new Error('Sunday Finish Line stays at the payroll cutoff. Its reminder can be switched off.');
      const date = new Date(`${local.slice(0, 10)}T12:00:00Z`);
      const hour = Number(local.slice(11, 13));
      if (local.slice(14) !== '00') throw new Error('Default weekly blocks start on the hour. Choose a full-hour slot.');
      const duration = (Date.parse(event.endUtc) - Date.parse(event.startUtc)) / 3600000;
      if (hour + duration > 24) throw new Error('Choose a block ending before midnight');
      weekly[event.showId] = { weekday: date.getUTCDay(), startHourLocal: hour, endHourLocal: hour + duration };
      await persist(data().events, weekly);
      return;
    }
    const program = weekly.programs?.find(item => item.id === event.showId);
    if (program) {
      program.weekday = new Date(`${local.slice(0, 10)}T12:00:00Z`).getUTCDay();
      program.startMinuteLocal = Number(local.slice(11, 13)) * 60 + Number(local.slice(14));
      await persist(data().events, weekly);
      return;
    }
    const duration = Date.parse(event.endUtc) - Date.parse(event.startUtc);
    const next = upsertLivePerformanceEvent(data().events, { ...event, startUtc: start, endUtc: new Date(Date.parse(start) + duration).toISOString() });
    await persist(next, weekly);
  }
  function edit(event = null, local = null, presetId = selectedPreset) {
    if (busy || data().ready !== true) return;
    editor.replaceChildren();
    const form = node('form', undefined, 'radio-calendar-editor');
    const weeklyProgram = data().weeklySchedule?.programs?.find(item => item.id === event?.showId);
    const fixed = defaultIds.includes(event?.showId);
    form.append(node('h4', event ? 'Edit radio hour' : 'Schedule a radio hour'));
    const type = field(form, 'Show preset', select([...presets().map(p => [p.id, p.title]), ['live', 'Live performance']],
      event?.playlistId || (event?.type === 'live_performance' ? 'live' : presetId)));
    type.disabled = fixed;
    const title = field(form, 'Show name', input('text', event?.title || presets().find(p => p.id === presetId)?.title || 'Radio hour'));
    title.required = true;
    title.maxLength = 100;
    title.disabled = fixed;
    const initial = local || (event ? utcToNewYorkInput(event.startUtc) : utcToNewYorkInput(new Date(Math.ceil((Date.now() + 5 * 60000) / 1800000) * 1800000).toISOString()));
    const start = field(form, 'Starts · New York time', input('datetime-local', initial));
    start.required = true;
    start.step = 60;
    const repeat = field(form, 'Part of the default program · repeat every week', input('checkbox', fixed || !!weeklyProgram));
    repeat.disabled = fixed;
    const announce = field(form, 'Announce to @everyone on Discord 5 minutes before', input('checkbox', event?.announce !== false));
    const description = node('p', '', 'radio-calendar-hint');
    form.append(description);
    const update = () => {
      const preset = presets().find(p => p.id === type.value);
      description.textContent = fixed ? 'Weekly default. Changes affect its future occurrences. Sunday Finish Line stays fixed to the payroll cutoff.'
        : `${preset?.rule || 'Reserves a live-performance block.'} One hour. Recurring hours use New York wall time, including daylight-saving changes.${weeklyProgram ? ' Editing or removing this card changes the weekly series; uncheck repeat to replace it with one dated show.' : ''}`;
    };
    type.addEventListener('change', () => { title.value = presets().find(p => p.id === type.value)?.title || 'Live performance'; update(); });
    update();
    if (event?.showId === 'weekly-top10-final-listen') start.disabled = true;
    const actions = node('div', undefined, 'radio-calendar-actions');
    const submit = node('button', 'Save radio hour');
    submit.type = 'submit';
    actions.append(submit, button('Close', () => editor.replaceChildren()));
    if (event && !fixed) actions.append(button('Remove from calendar', async () => {
      if (!globalThis.confirm(weeklyProgram ? 'Remove this weekly series and all of its future reminders?' :
        'Remove this show? No future reminders will be sent for it.')) return;
      const weekly = structuredClone(data().weeklySchedule || {});
      if (weeklyProgram) weekly.programs = weekly.programs.filter(p => p.id !== weeklyProgram.id);
      try { await persist(data().events.filter(item => item.id !== event.id), weekly); } catch { /* Shown by persist. */ }
    }));
    form.append(actions);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      try {
        if (busy) return;
        if (fixed) {
          const weekly = structuredClone(data().weeklySchedule || {});
          weekly.reminders = { ...weekly.reminders, [event.showId]: announce.checked };
          if (event.showId !== 'weekly-top10-final-listen') {
            const hour = Number(start.value.slice(11, 13));
            const duration = (Date.parse(event.endUtc) - Date.parse(event.startUtc)) / 3600000;
            if (start.value.slice(14) !== '00') throw new Error('Default weekly blocks start on the hour.');
            weekly[event.showId] = { weekday: new Date(`${start.value.slice(0, 10)}T12:00:00Z`).getUTCDay(),
              startHourLocal: hour, endHourLocal: hour + duration };
          }
          await persist(data().events, weekly);
          return;
        }
        const startUtc = newYorkInputToUtc(start.value);
        if (Date.parse(startUtc) <= Date.now()) throw new Error('Choose a future start time');
        const preset = presets().find(p => p.id === type.value);
        if (repeat.checked && !preset) throw new Error('Use the existing weekly live block for recurring performances. Playlist presets can repeat on any day.');
        const custom = preset && !RADIO_PLAYLISTS.some(p => p.id === preset.id);
        const eventData = { id: event?.id || crypto.randomUUID(), title: title.value.trim(),
          type: preset ? 'playlist_show' : 'live_performance', ...(preset ? { playlistId: preset.id } : {}),
          ...(custom ? { playlistDefinition: preset } : {}), announce: announce.checked,
          startUtc, endUtc: new Date(Date.parse(startUtc) + 3600000).toISOString() };
        const weekly = structuredClone(data().weeklySchedule || {});
        weekly.programs = (weekly.programs || []).filter(p => p.id !== weeklyProgram?.id);
        let events = data().events.filter(item => item.id !== event?.id);
        if (repeat.checked) {
          weekly.programs.push({ id: weeklyProgram?.id || `program-${crypto.randomUUID()}`, title: eventData.title,
            startDateLocal: weeklyProgram?.startDateLocal || start.value.slice(0, 10),
            playlistId: preset.id, ...(custom ? { playlistDefinition: preset } : {}),
            weekday: new Date(`${start.value.slice(0, 10)}T12:00:00Z`).getUTCDay(),
            startMinuteLocal: Number(start.value.slice(11, 13)) * 60 + Number(start.value.slice(14)),
            announce: announce.checked });
        } else events = upsertLivePerformanceEvent(events, eventData);
        await persist(events, weekly);
      } catch (error) { say(error.message, true); }
    });
    editor.append(form);
    (fixed ? (start.disabled ? announce : start) : title).focus();
  }
  function render() {
    const previousScroll = root.querySelector('.radio-calendar-scroll')?.scrollTop;
    generation++;
    root.replaceChildren();
    root.className = 'radio-programming-calendar';
    const heading = node('div', undefined, 'radio-calendar-toolbar');
    const dates = programmingWeek(Date.now(), offset);
    heading.append(node('div', 'Your station. Your week.', 'radio-calendar-title'),
      button('Previous week', () => { offset--; render(); }),
      button('Today · now', () => { offset = 0; selectedDay = programmingNow().date; scrollToNow = true; render(); }),
      button('Next week', () => { offset++; render(); }));
    root.append(heading, node('p', `${dateLabel.format(new Date(`${dates[0]}T16:00:00Z`))} – ${dateLabel.format(new Date(`${dates[6]}T16:00:00Z`))} · New York time`, 'radio-calendar-hint'));
    const palette = node('div', undefined, 'radio-calendar-presets');
    for (const preset of presets()) {
      const chip = button(preset.id === 'songs-awaiting-your-vote' ? '0 Votes' : preset.title,
        () => { selectedPreset = preset.id; edit(null, null, preset.id); });
      chip.className = 'radio-calendar-chip';
      chip.draggable = true;
      chip.title = `Drag onto the calendar or click to schedule. ${preset.rule}`;
      chip.addEventListener('dragstart', e => { drag = { preset: preset.id }; e.dataTransfer.setData('text/plain', preset.id); });
      palette.append(chip);
    }
    palette.append(button('+ Live block', () => edit(null, null, 'live')));
    root.append(palette, node('p', 'Drag a preset onto a time, or click any slot. Drag a show to move it; click to edit. Background time is normal rotation. Weekly cards repeat; dated cards play once.', 'radio-calendar-hint'));
    status = node('p', data().reminders?.error ? `Discord reminder needs attention: ${data().reminders.error}` : 'Automatic @everyone reminders: 5 minutes before each show, unless switched off.', 'radio-calendar-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    root.append(status);
    const scroll = node('div', undefined, 'radio-calendar-scroll');
    const grid = node('div', undefined, 'radio-calendar-grid');
    grid.setAttribute('aria-label', 'Weekly radio programming calendar');
    if (!dates.includes(selectedDay)) selectedDay = dates[0];
    const dayPicker = select(dates.map(day => [day, dateLabel.format(new Date(`${day}T16:00:00Z`))]), selectedDay);
    const dayField = field(root, 'Day to view', dayPicker);
    dayField.parentElement.className = 'radio-calendar-day-picker';
    dayPicker.addEventListener('change', () => {
      selectedDay = dayPicker.value;
      grid.querySelectorAll('.radio-calendar-day').forEach(column => column.classList.toggle('is-selected', column.dataset.date === selectedDay));
    });
    const occurrences = radioCalendarOccurrences(data(), {
      now: Date.parse(newYorkInputToUtc(`${dates[0]}T00:00`)), days: 6, pastDays: 1,
    });
    const nowLocal = utcToNewYorkInput(new Date().toISOString());
    for (const day of dates) {
      const column = node('section', undefined, 'radio-calendar-day');
      column.dataset.date = day;
      column.classList.toggle('is-selected', day === selectedDay);
      const label = dateLabel.format(new Date(`${day}T16:00:00Z`));
      column.append(node('h4', label));
      if (day === nowLocal.slice(0, 10)) column.classList.add('is-today');
      const timeline = node('div', undefined, 'radio-calendar-timeline');
      for (let minute = 0; minute < 1440; minute += 30) {
        const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
        const slot = button(time, () => edit(null, `${day}T${time}`));
        slot.className = 'radio-calendar-slot';
        slot.dataset.minute = String(minute);
        slot.setAttribute('aria-label', `Schedule radio hour ${label} at ${time} New York time`);
        slot.addEventListener('dragover', e => { e.preventDefault(); });
        slot.addEventListener('drop', async e => {
          e.preventDefault();
          if (!drag || busy) return;
          try {
            if (drag.event) await move(drag.event, `${day}T${time}`);
            else edit(null, `${day}T${time}`, drag.preset);
          } catch (error) { say(error.message, true); }
          drag = null;
        });
        timeline.append(slot);
      }
      const nextDate = new Date(`${day}T12:00:00Z`);
      nextDate.setUTCDate(nextDate.getUTCDate() + 1);
      const dayStart = Date.parse(newYorkInputToUtc(`${day}T00:00`));
      const dayEnd = Date.parse(newYorkInputToUtc(`${nextDate.toISOString().slice(0, 10)}T00:00`));
      for (const event of occurrences.filter(item => item.status !== 'cancelled' &&
        Date.parse(item.startUtc) < dayEnd && Date.parse(item.endUtc) > dayStart)) {
        const start = utcToNewYorkInput(event.startUtc);
        const continued = Date.parse(event.startUtc) < dayStart;
        const minute = continued ? 0 : Number(start.slice(11, 13)) * 60 + Number(start.slice(14));
        const segmentEnd = Math.min(Date.parse(event.endUtc), dayEnd);
        const height = Math.max(slotHeight, (segmentEnd - Math.max(Date.parse(event.startUtc), dayStart)) / 1800000 * slotHeight);
        const card = button('', () => edit(event));
        card.className = `radio-calendar-event ${event.showId ? 'is-weekly' : 'is-once'} ${event.type === 'live_performance' ? 'is-live' : ''} ${height < 2 * slotHeight ? 'is-partial' : ''}`;
        card.style.top = `${minute / 30 * slotHeight}px`;
        card.style.height = `${height}px`;
        card.title = [event.title, continued ? 'Continued from previous day' : '', event.timeAdjustment,
          event.announce === false ? 'No announcement' : '@everyone · 5 min before'].filter(Boolean).join(' · ');
        card.append(node('strong', event.title), node('span', `${timeLabel.format(new Date(event.startUtc))} · ${event.showId ? 'Weekly' : 'One time'}`),
          node('small', event.announce === false ? 'No announcement' : '@everyone · 5 min before'));
        card.draggable = event.showId !== 'weekly-top10-final-listen';
        card.addEventListener('dragstart', e => {
          drag = { event }; e.dataTransfer.setData('text/plain', event.id);
          card.style.pointerEvents = 'none';
        });
        card.addEventListener('dragend', () => { card.style.pointerEvents = ''; drag = null; });
        timeline.append(card);
      }
      column.append(timeline); grid.append(column);
    }
    scroll.append(grid); root.append(scroll);
    editor = node('div', undefined, 'radio-calendar-editor-host'); root.append(editor);
    const version = generation;
    updateNow();
    const initialMinute = dates.includes(programmingNow().date) ? programmingNow().minute : 16 * 60;
    const target = scrollToNow || previousScroll === undefined ? Math.max(0, initialMinute / 30 * slotHeight - 120) : previousScroll;
    scrollToNow = false;
    requestAnimationFrame(() => { if (version === generation) scroll.scrollTop = target; });
    if (data().ready !== true) {
      say('Calendar is read-only while durable storage is unavailable.', true);
      root.querySelectorAll('button,input,select').forEach(el => { el.disabled = true; });
    }
  }
  function updateNow() {
    const current = programmingNow();
    root.querySelectorAll('.radio-calendar-now').forEach(marker => marker.remove());
    root.querySelectorAll('.radio-calendar-day').forEach(column => {
      const today = column.dataset.date === current.date;
      column.classList.toggle('is-today', today);
      const header = column.querySelector('h4');
      if (today) header.setAttribute('aria-current', 'date');
      else header.removeAttribute('aria-current');
      column.querySelectorAll('.radio-calendar-slot').forEach(slot => {
        const active = today && Number(slot.dataset.minute) === current.slot * 30;
        slot.classList.toggle('is-current', active);
        if (active) slot.setAttribute('aria-current', 'time');
        else slot.removeAttribute('aria-current');
      });
      if (!today) return;
      const marker = node('div', `Now ${timeLabel.format(new Date())}`, 'radio-calendar-now');
      marker.style.top = `${current.minute / 30 * slotHeight}px`;
      column.querySelector('.radio-calendar-timeline').append(marker);
    });
  }
  render();
  const clock = setInterval(updateNow, 30_000);
  return { refresh: render, destroy: () => clearInterval(clock) };
}
