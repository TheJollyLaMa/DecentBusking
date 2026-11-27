import { radioCalendarOccurrences, utcToNewYorkInput, newYorkInputToUtc } from './radio-calendar.mjs?v=20261024-programming-calendar';
import { RADIO_PLAYLISTS } from './radio-playlists.mjs?v=20261116-longform';
import { upsertLivePerformanceEvent, cancelLivePerformanceEvent, validateWeeklyScheduleOverrides, validateRadioProgrammingConflicts } from './radio-schedule.mjs?v=20261116-longform';
import { openReferralCampaignEditor, referralTemplateFrom } from './referral-campaign-editor.mjs?v=20261126-eth-gifts';
import { openPromotionCalendarEditor } from './promotions-ui.mjs?v=20261126-pinner-dashboard';
import { PROMOTION_TEMPLATES } from './promotions.mjs?v=20261126-pinner-dashboard';
import { openLivePerformanceCalendar, liveCalendarCancellationImpact, getLiveCalendarLedger, liveCalendarEventLifecycle } from './live-performance-admin.mjs?v=20261121-typed-review';

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
export function draggablePresetControl(choices, value, label, onSelect, onDrag) {
    const disclosure = node('details', undefined, 'radio-calendar-preset-control');
    const text = node('summary', choices.find(([id]) => id === value)?.[1] || choices[0][1], 'radio-calendar-chip');
    text.draggable = true;
    text.setAttribute('aria-label', `${label}: ${text.textContent}`);
    const options = node('div', undefined, 'radio-calendar-preset-options');
    options.setAttribute('aria-label', `${label} options`);
    let selected = choices.some(([id]) => id === value) ? value : choices[0][0];
    for (const [id, title] of choices) {
      const option = button(title, () => {
        selected = id;
        text.textContent = title;
        text.setAttribute('aria-label', `${label}: ${title}`);
        options.querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item === option)));
        disclosure.open = false;
        onSelect(id);
        text.focus();
      });
      option.setAttribute('aria-pressed', String(id === selected));
      options.append(option);
    }
    text.addEventListener('dragstart', event => { disclosure.open = false; onDrag(selected, event); });
    disclosure.append(text, options);
    return disclosure;
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
  let selectedCampaign = 'musician-referral';
  let selectedDay = programmingNow().date;
  let scrollToNow = true;
  let liveAudio;
  let liveAudioReceivedAt = 0;
  const data = () => getSchedule();
  const presets = () => [...RADIO_PLAYLISTS, ...(data().weeklySchedule?.presets || [])];
  const say = (text, error = false) => {
    status.textContent = text;
    status.classList.toggle('error', error);
  };
  async function persist(events, weekly) {
    if (busy || !isCurrent()) throw new Error('Calendar is busy or wallet changed');
    busy = true;
    const focused = document.activeElement;
    const controls = [...root.querySelectorAll('button,input,select')].map(el => [el, el.disabled]);
    root.setAttribute('aria-busy', 'true');
    root.querySelectorAll('button,input,select').forEach(el => { el.disabled = true; });
    say('Sign this schedule update with your owner wallet. No gas or transaction.');
    try {
      validateRadioProgrammingConflicts(events, weekly);
      await save(events, validateWeeklyScheduleOverrides(weekly));
      if (!isCurrent()) return;
      render();
      say('Saved.');
    } catch (error) {
      if (isCurrent()) say(error.message, true);
      throw error;
    } finally {
      busy = false;
      root.removeAttribute('aria-busy');
      for (const [el, disabled] of controls) if (el.isConnected) el.disabled = disabled;
      if (focused?.isConnected && !focused.disabled) focused.focus();
    }
  }
  function edit(event = null, local = null, presetId = selectedPreset) {
    if (busy || data().ready !== true) return;
    if (!event && presetId === 'live') {
      openLivePerformanceCalendar({ startsAt: local || `${selectedDay}T21:00` });
      return;
    }
    if (editor.open) editor.close();
    editor.replaceChildren();
    const form = node('form', undefined, 'radio-calendar-editor');
    const weeklyProgram = data().weeklySchedule?.programs?.find(item => item.id === event?.showId);
    const fixed = defaultIds.includes(event?.showId);
    form.append(node('h4', event?.type === 'live_performance' ? 'Live Performance' : event ? 'Edit radio hour' : 'Schedule a radio hour'));
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
    actions.append(submit, button('Close', () => editor.close()));
    if (event) {
      const cancellation = node('fieldset', undefined, 'radio-calendar-cancellation');
      cancellation.append(node('legend', 'Cancel this occurrence only'));
      cancellation.append(node('p', 'Calendar cancellation stops radio scheduling and reminders for this occurrence only. It does NOT cancel platform invitations, settle escrow, refund fees or remove performer claims. Review the Live Performance workflow separately.'));
      if (event.type === 'live_performance') cancellation.append(node('p', liveCalendarCancellationImpact(event), 'radio-calendar-settlement-impact'));
      const reason = field(cancellation, 'Public cancellation reason', input('text', event.cancellationReason || ''));
      reason.maxLength = 500;
      const disposition = field(cancellation, 'Calendar visibility', select([
        ['retain', 'Keep publicly · Canceled stamp'], ['hide', 'Remove from calendar · retain subscription cancellation'],
      ], event.calendarHidden ? 'hide' : 'retain'));
      const acknowledge = field(cancellation, 'I understand this affects only this date, not invitations or escrow', input('checkbox', false));
      const cancel = button('Cancel this occurrence', async () => {
        if (!acknowledge.checked || !reason.value.trim()) { say('Enter a public reason and acknowledge the cancellation impacts.', true); return; }
        if (!globalThis.confirm(`Cancel ONLY ${event.title} on ${utcToNewYorkInput(event.startUtc)} New York time? Future weeks are unchanged. Invitation/escrow obligations remain.`)) return;
        try {
          await persist(cancelLivePerformanceEvent(data().events, { ...event, calendarHidden: disposition.value === 'hide' }, reason.value.trim()),
            data().weeklySchedule || {});
        } catch { /* Persist reports the failure. */ }
      });
      cancel.className = 'radio-calendar-danger';
      cancellation.append(cancel);
      form.append(cancellation);
    }
    if (event?.type === 'live_performance' || presetId === 'live') {
      actions.prepend(button('🎤 Invitation → acceptance → escrow → sound checks → Live Performance',
        () => openLivePerformanceCalendar({ event, startsAt: local || utcToNewYorkInput(event?.startUtc || new Date().toISOString()) })));
      submit.hidden = true;
      for (const control of [type, title, start, repeat, announce]) control.disabled = true;
      form.append(node('p', 'Create and manage real invitations in the Live Performance workflow. Calendar edits do not change agreed performer terms.'));
    }
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
    const feedback = node('p', undefined, 'radio-calendar-status');
    feedback.setAttribute('role', 'status');
    editor.append(feedback);
    const outerStatus = status;
    status = feedback;
    editor.addEventListener('close', () => { if (status === feedback) status = outerStatus; }, { once: true });
    editor.showModal();
    (fixed ? (start.disabled ? announce : start) : title).focus();
  }
  function render() {
    const previousScroll = root.querySelector('.radio-calendar-scroll')?.scrollTop;
    generation++;
    if (editor?.open) editor.close();
    root.replaceChildren();
    root.className = 'radio-programming-calendar';
    const heading = node('div', undefined, 'radio-calendar-toolbar');
    const dates = programmingWeek(Date.now(), offset);
    heading.append(node('div', 'Community Radio Calendar and Schedule of Events', 'radio-calendar-title'),
      button('Previous week', () => { offset--; render(); }),
      button('Today · now', () => { offset = 0; selectedDay = programmingNow().date; scrollToNow = true; render(); }),
      button('Next week', () => { offset++; render(); }));
    root.append(heading, node('p', `${dateLabel.format(new Date(`${dates[0]}T16:00:00Z`))} – ${dateLabel.format(new Date(`${dates[6]}T16:00:00Z`))} · New York time`, 'radio-calendar-hint'));
    const palette = node('div', undefined, 'radio-calendar-presets');
    {
      const labels = { 'long-form-hour': 'Long-Form', 'songs-awaiting-your-vote': '0 Votes', 'top10-hour': 'Top10', 'rising-stars': 'Rising Stars' };
      palette.append(draggablePresetControl(presets().map(p => [p.id, labels[p.id] || p.title]), selectedPreset, 'Radio preset',
        id => { selectedPreset = id; }, (id, e) => { drag = { preset: id }; e.dataTransfer.setData('text/plain', id); }));
    }
    const campaignSources = (data().promotionEvents || []).filter(item => item.campaign);
    const campaignChoices = [...PROMOTION_TEMPLATES.filter(t => t.id !== 'custom').map(t => [t.id, t.id === 'pinner' ? 'Pin Reward Campaign' : t.title]),
      ...campaignSources.map(c => [`campaign:${c.id}`, `↻ ${c.title}`]), ['custom', 'Custom']];
    const campaignChip = draggablePresetControl(campaignChoices, selectedCampaign, 'Campaign preset',
      id => { selectedCampaign = id; }, (id, e) => { drag = { campaign: id }; e.dataTransfer.setData('text/plain', id); });
    const liveChip = button('🎤 Live Performance', () => edit(null, null, 'live'));
    liveChip.className = 'radio-calendar-chip is-live';
    liveChip.draggable = true;
    liveChip.addEventListener('dragstart', e => { drag = { preset: 'live' }; e.dataTransfer.setData('text/plain', 'live'); });
    palette.append(campaignChip, liveChip);
    root.append(palette);
    status = node('p', data().promotionEventsError
      ? `Promotions unavailable: ${data().promotionEventsError}`
      : data().reminders?.error
        ? `Discord reminder needs attention: ${data().reminders.error}`
        : 'Automatic @everyone reminders: 5 minutes before each show, unless switched off.', 'radio-calendar-status');
    status.classList.toggle('error', !!data().promotionEventsError);
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    root.append(status);
    const lane = node('div', undefined, 'radio-calendar-allday');
    lane.setAttribute('aria-label', 'Promotions and drafts this week');
    const laneRows = [];
    const lastDay = dates[dates.length - 1];
    for (const event of (data().promotionEvents || []).filter(item => ['draft', 'published', 'paused', 'closed'].includes(item.status))) {
      const first = utcToNewYorkInput(event.startUtc).slice(0, 10);
      const last = utcToNewYorkInput(new Date(Date.parse(event.endUtc) - 1).toISOString()).slice(0, 10);
      if (last < dates[0] || first > lastDay) continue;
      const from = first < dates[0] ? 0 : dates.indexOf(first);
      const to = last > lastDay ? dates.length - 1 : dates.indexOf(last);
      let laneRow = laneRows.findIndex(end => end < from);
      if (laneRow < 0) laneRow = laneRows.push(-1) - 1;
      laneRows[laneRow] = to;
      const bar = button('', () => event.campaign?.template !== 'musician-referral'
        ? openPromotionCalendarEditor({ campaignId: event.id })
        : openReferralCampaignEditor({ campaign: event.campaign || {
        id: event.id, title: event.title, startsAt: event.startUtc, endsAt: event.endUtc, remainingAwards: event.remainingAwards,
      } }));
      bar.className = 'radio-calendar-campaign-bar';
      bar.classList.toggle('continues-before', first < dates[0]);
      bar.classList.toggle('continues-after', last > lastDay);
      bar.dataset.first = first;
      bar.dataset.last = last;
      bar.style.gridColumn = `${from + 1} / ${to + 2}`;
      bar.style.gridRow = String(laneRow + 1);
      bar.title = `${event.title} · ${dateLabel.format(new Date(event.startUtc))} → ${dateLabel.format(new Date(event.endUtc))}`;
      bar.append(node('span', event.campaign?.template === 'pinner' ? '◇' : '🤝', 'radio-calendar-campaign-icon'), node('strong', event.title),
        node('small', event.status === 'draft' ? 'DRAFT · not an offer' : event.status === 'published' ? `🎯 ${event.remainingAwards ?? 0} open` : event.status));
      lane.append(bar);
    }
    const syncLane = () => lane.querySelectorAll('.radio-calendar-campaign-bar').forEach(bar => {
      const day = dates.includes(selectedDay) ? selectedDay : dates[0];
      bar.classList.toggle('is-off-day', day < bar.dataset.first || day > bar.dataset.last);
    });
    syncLane();
    lane.hidden = !lane.childElementCount;
    root.append(lane);
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
      syncLane();
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
            if (drag.event) edit(drag.event, `${day}T${time}`);
            else if (drag.campaign) openCampaign(drag.campaign, `${day}T${time}`);
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
      for (const event of occurrences.filter(item => !item.calendarHidden &&
        Date.parse(item.startUtc) < dayEnd && Date.parse(item.endUtc) > dayStart)) {
        const start = utcToNewYorkInput(event.startUtc);
        const continued = Date.parse(event.startUtc) < dayStart;
        const minute = continued ? 0 : Number(start.slice(11, 13)) * 60 + Number(start.slice(14));
        const segmentEnd = Math.min(Date.parse(event.endUtc), dayEnd);
        const height = Math.max(slotHeight, (segmentEnd - Math.max(Date.parse(event.startUtc), dayStart)) / 1800000 * slotHeight);
        const card = button('', () => edit(event));
        card.className = `radio-calendar-event ${event.showId ? 'is-weekly' : 'is-once'} ${event.type === 'live_performance' ? 'is-live' : ''} ${height < 2 * slotHeight ? 'is-partial' : ''}`;
        card.classList.toggle('is-cancelled', event.status === 'cancelled');
        card.classList.toggle('is-short-live', event.type === 'live_performance' && height <= slotHeight);
        if (event.status === 'cancelled') card.append(node('b', 'Canceled', 'radio-calendar-cancel-stamp'));
        card.style.top = `${minute / 30 * slotHeight}px`;
        card.style.height = `${height}px`;
        card._calendarEvent = event;
        card.title = [event.title, continued ? 'Continued from previous day' : '', event.timeAdjustment,
          event.announce === false ? 'No announcement' : '@everyone · 5 min before'].filter(Boolean).join(' · ');
        card.append(node('strong', event.title), node('span', `${timeLabel.format(new Date(event.startUtc))} · ${event.showId ? 'Weekly' : 'One time'}`),
          node('small', event.announce === false ? 'No announcement' : '@everyone · 5 min before'));
        if (event.type === 'live_performance') card.append(node('span', undefined, 'radio-calendar-live-blurb'));
        card.draggable = event.status !== 'cancelled' && event.type !== 'live_performance' && event.showId !== 'weekly-top10-final-listen';
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
    editor = node('dialog', undefined, 'radio-calendar-editor-host'); root.append(editor);
    editor.setAttribute('aria-label', 'Admin calendar decision');
    editor.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      editor.close();
    });
    const version = generation;
    updateNow();
    const initialMinute = dates.includes(programmingNow().date) ? programmingNow().minute : 16 * 60;
    const target = scrollToNow || previousScroll === undefined ? Math.max(0, initialMinute / 30 * slotHeight - 120) : previousScroll;
    scrollToNow = false;
    requestAnimationFrame(() => {
      if (version !== generation) return;
      scroll.scrollTop = target;
      lane.style.paddingRight = `${Math.max(0, scroll.offsetWidth - scroll.clientWidth - 2) + 1}px`;
    });
    if (data().ready !== true) {
      say('Calendar is read-only while durable storage is unavailable.', true);
      root.querySelectorAll('button,input,select').forEach(el => { el.disabled = true; });
    }
    function openCampaign(value, local) {
      const source = value.startsWith('campaign:') ? (data().promotionEvents || []).find(c => c.id === value.slice(9)) : null;
      if (value === 'musician-referral' || source?.campaign.template === 'musician-referral') return openReferralCampaignEditor({
        startsAt: newYorkInputToUtc(local), template: source ? referralTemplateFrom(source.campaign) : null });
      return openPromotionCalendarEditor({ startsAt: newYorkInputToUtc(local),
        template: source?.campaign.template || value,
        sourceCampaign: source?.campaign });
    }
  }
  function updateNow() {
    updateLiveBlurbs();
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
  function updateLiveBlurbs() {
    for (const card of root.querySelectorAll('.radio-calendar-event.is-live')) {
      const lifecycle = liveCalendarEventLifecycle(card._calendarEvent, {
        ledger: getLiveCalendarLedger(), liveAudio: Date.now() - liveAudioReceivedAt < 15000 ? liveAudio : null,
      });
      card.dataset.liveState = lifecycle.state;
      const blurb = card.querySelector('.radio-calendar-live-blurb');
      const visible = lifecycle.state === 'unavailable' ? [{ text: '⚠ Lifecycle unavailable', state: 'unavailable' }] : lifecycle.steps;
      blurb.replaceChildren(...visible.map(step => {
        const compact = step.text.startsWith('⚠') ? step.text
          : step.text.startsWith('📨') ? `📨 ${step.text.includes('draft') ? 'Draft' : step.state === 'confirmed' ? 'Invited' : 'Unavailable'}`
          : step.text.startsWith('✅') ? `✅ ${step.state === 'confirmed' ? 'Accepted' : step.state === 'pending' ? 'Pending' : 'Unavailable'}`
            : step.text.startsWith('🏦') ? '🏦 Earmarked, not escrow'
              : step.text.startsWith('🔒') ? `🔒 ${step.text.includes('pending') ? 'Funding' : step.state === 'confirmed' ? 'Funded' : 'Unfunded'}`
                : step.text.startsWith('💵') ? '💵 Funding unavailable'
                  : step.text.startsWith('🎧') ? `🎧 Checks ${step.state === 'confirmed' ? 'passed' : step.state === 'pending' ? 'pending' : 'unavailable'}`
                    : step.text.startsWith('🔴') ? '🔴 Live' : step.text.startsWith('🏁') ? '🏁 Ended'
                      : step.text.startsWith('⊘') ? step.text.includes('Invitation') ? '⊘ Invite canceled' : '⊘ Canceled' : '🎤 Unverified';
        const badge = node('small', compact);
        badge.title = step.text;
        badge.setAttribute('aria-label', step.text);
        badge.dataset.state = step.state;
        badge.dataset.icon = [...step.text][0];
        return badge;
      }));
      blurb.title = `${lifecycle.steps.map(step => step.text).join(' · ')} · Click to open invitation, payment and sound-check workflow`;
    }
  }
  const ledgerChanged = () => { if (isCurrent()) updateLiveBlurbs(); };
  const radioChanged = event => {
    if (!isCurrent()) return;
    liveAudio = event.detail?.liveAudio;
    liveAudioReceivedAt = Date.now();
    updateLiveBlurbs();
  };
  document.addEventListener('live-booking-state-updated', ledgerChanged);
  document.addEventListener('live-booking-notification-error', ledgerChanged);
  document.addEventListener('wallet-connected', ledgerChanged);
  document.addEventListener('wallet-disconnected', ledgerChanged);
  document.addEventListener('dbusk-radio-state', radioChanged);
  render();
  const clock = setInterval(updateNow, 30_000);
  const lifecycleClock = setInterval(updateLiveBlurbs, 5000);
  return { refresh: render, destroy: () => {
    clearInterval(clock); clearInterval(lifecycleClock); editor?.close();
    document.removeEventListener('live-booking-state-updated', ledgerChanged);
    document.removeEventListener('live-booking-notification-error', ledgerChanged);
    document.removeEventListener('wallet-connected', ledgerChanged);
    document.removeEventListener('wallet-disconnected', ledgerChanged);
    document.removeEventListener('dbusk-radio-state', radioChanged);
  } };
}
