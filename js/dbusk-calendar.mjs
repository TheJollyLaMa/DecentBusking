import { DCAL_ZONE, localDate, addDays, calendarRange, calendarEvents, groupedIntervalSegments, timedSegments, walletKey, calendarLayer, groupCalendarDay } from './dbusk-calendar-core.mjs';
import { createCalendarStore } from './dbusk-calendar-store.mjs';
import { googleRadioCalendarUrl, buildRadioCalendar } from './radio-calendar.mjs?v=20261024-programming-calendar';
import { renderWallet } from './wallet-label.mjs';
import { lookupEnsName } from './ens-client.mjs';

const civilFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
const layers = { schedule: ['♫', 'Public shows'], invitations: ['✉', 'Your invitations & performances'],
  campaigns: ['✦', 'Promotions'], adverts: ['📣', 'Your adverts'], receipts: ['◈', 'Your payments & gifts'] };
const provenance = {
  'ipfs-record': 'Recorded schedule · IPFS, not on-chain',
  'scheduled-record': 'Scheduled agreement · off-chain checkpoint',
  'current-rule': 'Current recurring rule · projection, not historical evidence',
  'indexed-chain-receipt': 'Base contract receipt · indexed',
  'chain-state': 'Base contract state · indexed snapshot',
  'checkpoint-record': 'Off-chain checkpoint · receipt verification unavailable',
};
function node(tag, text, className = '') {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function button(text, action, label) {
  const el = node('button', text);
  el.type = 'button';
  if (label) el.setAttribute('aria-label', label);
  el.addEventListener('click', action);
  return el;
}
function link(text, href) {
  const el = node('a', text);
  el.href = href;
  el.target = '_blank'; el.rel = 'noopener noreferrer';
  return el;
}

export function calendarPortal(event, wallet, { pathname = '/' } = {}) {
  if (event.audience === 'personal' && event.owner !== walletKey(wallet)) return null;
  const portal = event.portal;
  if (!portal) return null;
  if (portal.kind === 'campaign') return { kind: 'link', href: `${pathname}?promotion=${encodeURIComponent(portal.id)}` };
  if (['profile', 'stage'].includes(portal.kind)) return { kind: portal.kind, address: event.owner, bookingId: portal.bookingId, roomUrl: portal.roomUrl };
  if (portal.kind === 'advert') return { kind: 'advert', campaignId: portal.id, address: event.owner };
  return null;
}

export function mountDBuskCalendar(root, { dialog, status, serviceUrl, fetchImpl = globalThis.fetch,
  getWallet = () => globalThis.window?._wallet?.address || '', now = Date.now, tipRouters,
  resolveName = lookupEnsName } = {}) {
  let wallet = walletKey(getWallet());
  let yourZone = Intl.DateTimeFormat().resolvedOptions().timeZone || DCAL_ZONE;
  let timeZone = DCAL_ZONE;
  let secondaryZone = '';
  let dateFormat, timeFormat, detailTimeFormat;
  function setFormats() {
    dateFormat = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' });
    timeFormat = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
    detailTimeFormat = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  }
  setFormats();
  let mode = 'week';
  let anchor = localDate(now(), timeZone);
  let selectedDay = anchor;
  let selected;
  let selectedGroup;
  let timer;
  let clockTimer;
  let identityWallet;
  let destroyed = false;
  let initialised = false;
  let view;
  let scrollToEvents = true;
  const handlers = [];
  const downloads = new Map();
  const listen = (target, name, handler) => {
    target?.addEventListener(name, handler);
    handlers.push(() => target?.removeEventListener(name, handler));
  };
  const currentWallet = () => wallet && walletKey(getWallet()) !== wallet ? walletKey(getWallet()) : wallet;
  const store = createCalendarStore({ serviceUrl, fetchImpl, now, currentWallet, tipRouters,
    onChange: state => { view = state; if (initialised) render(); } });
  store.setWallet(wallet);
  view = store.snapshot();
  const controls = node('div', undefined, 'dbcal-controls');
  const title = node('h3');
  title.setAttribute('aria-live', 'polite');
  const previous = button('‹', () => navigate(-1), 'Previous calendar period');
  const next = button('›', () => navigate(1), 'Next calendar period');
  const today = button('Today', () => { anchor = selectedDay = localDate(now(), timeZone); scrollToEvents = true; render(); });
  const week = button('Week', () => { mode = 'week'; scrollToEvents = true; render(); });
  const month = button('Month', () => { mode = 'month'; scrollToEvents = true; render(); });
  const jump = node('input');
  jump.type = 'month';
  jump.setAttribute('aria-label', 'Go to any month');
  jump.addEventListener('change', () => {
    if (!/^\d{4}-\d{2}$/.test(jump.value)) return;
    anchor = selectedDay = `${jump.value}-01`; mode = 'month'; scrollToEvents = true; render();
  });
  controls.append(title, previous, today, next, week, month, jump);
  const options = node('div', undefined, 'dbcal-options');
  const identity = node('span');
  const zoneLabel = node('span');
  options.append(identity, zoneLabel);
  const mobilePicker = node('div', undefined, 'dbcal-day-picker');
  const picker = node('select');
  picker.setAttribute('aria-label', 'Day in this week');
  picker.addEventListener('change', () => { selectedDay = picker.value; scrollToEvents = true; render(); });
  mobilePicker.append(node('span', 'Day'), picker);
  const scroll = node('div', undefined, 'dbcal-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', 'DBusk calendar · New York time');
  function popup(id, label) {
    const el = node('dialog', undefined, 'dbcal-popup');
    el.id = id;
    el.setAttribute('aria-label', label);
    el.append(button('✕', () => el.close(), `Close ${label}`));
    el.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        el.close();
      }
    });
    return el;
  }
  const detail = popup('dbcal-event-dialog', 'Calendar event details');
  const detailBody = node('div', undefined, 'dbcal-detail');
  detail.append(detailBody);
  const info = popup('dbcal-info-dialog', 'About DCal and timezone settings');
  info.append(node('h3', '☿🗓️ Your corner of time'),
    node('p', 'This DecentCalendar widget is customized for DecentBusking. It brings the public event schedule together with interactions between your connected wallet and the platform.'),
    node('p', 'Public hours · your invitations, campaigns & receipts · America/New_York'),
    node('p', 'Public schedule + your wallet’s events. Select an event for details.'));
  const timeSettings = node('fieldset', undefined, 'dbcal-time-settings');
  timeSettings.append(node('legend', 'Mesh your timezones'));
  const displayLabel = node('label', 'Calendar time display');
  const display = node('select');
  for (const [value, text] of [['ny', 'New York only'], ['ny-local', 'New York main · your time in parentheses'],
    ['local-ny', 'Your time main · New York in parentheses'], ['local', 'Your time only']]) {
    const option = node('option', text); option.value = value; display.append(option);
  }
  displayLabel.append(display);
  const yourZoneLabel = node('label', 'Your timezone (IANA name)');
  const zoneInput = node('input');
  zoneInput.value = yourZone;
  zoneInput.placeholder = 'e.g. Europe/London';
  zoneInput.setAttribute('list', 'dbcal-timezones');
  const zoneChoices = node('datalist');
  zoneChoices.id = 'dbcal-timezones';
  for (const zone of Intl.supportedValuesOf?.('timeZone') || [yourZone, DCAL_ZONE]) {
    const option = node('option'); option.value = zone; zoneChoices.append(option);
  }
  yourZoneLabel.append(zoneInput);
  const settingStatus = node('p');
  settingStatus.setAttribute('role', 'status');
  const applyTime = () => {
    try { new Intl.DateTimeFormat('en-US', { timeZone: zoneInput.value }).format(); }
    catch (error) {
      settingStatus.textContent = `Timezone not changed: ${error.message}. Choose an IANA timezone such as Europe/London.`;
      return;
    }
    yourZone = zoneInput.value;
    timeZone = display.value.startsWith('local') ? yourZone : DCAL_ZONE;
    secondaryZone = display.value === 'ny-local' ? yourZone : display.value === 'local-ny' ? DCAL_ZONE : '';
    setFormats();
    settingStatus.textContent = `Calendar days and hours use ${timeZone}${secondaryZone ? `; parentheses use ${secondaryZone}` : ''}.`;
    scrollToEvents = true; render();
  };
  display.addEventListener('change', applyTime);
  zoneInput.addEventListener('change', applyTime);
  timeSettings.append(displayLabel, yourZoneLabel, zoneChoices, settingStatus,
    node('small', 'Shows are scheduled around New York time. The NY clock stays visible whatever display you choose. Changing the view never reschedules an event.'));
  const sourceNotices = node('div', undefined, 'dbcal-source-notices');
  info.append(timeSettings, sourceNotices,
    node('p', 'Past dates show recorded entries, not projections of today’s rules. Source history is limited; an empty past month does not prove no activity. Browsing never signs or moves funds.'));
  const subscription = popup('dbcal-subscription-dialog', 'Calendar subscription information');
  subscription.append(node('h3', '🔗🗓️ Take the radio calendar with you'),
    node('p', 'Subscribe once in a calendar account synced across your devices. Includes the next 90 days, schedule changes and cancellations, with 15-minute reminders. Your calendar app controls refresh timing and may require enabling alerts for subscribed calendars.'),
    node('p', 'Google Calendar: Other calendars → From URL. Apple / Outlook: Add calendar → Subscribe from web. Subscription updates are not instant; check this schedule for last-minute changes.'));
  const feedLabel = node('label', 'Subscription URL');
  const feedDisplay = node('input');
  feedDisplay.readOnly = true;
  feedDisplay.setAttribute('aria-label', 'Subscription URL');
  feedLabel.append(feedDisplay); subscription.append(feedLabel);
  const filters = node('fieldset', undefined, 'dbcal-filters');
  filters.append(node('legend', 'Calendar overlays'));
  const visibleLayers = new Set(Object.keys(layers));
  for (const [key, [icon, text]] of Object.entries(layers)) {
    const label = node('label');
    const input = node('input');
    input.type = 'checkbox'; input.checked = true; input.value = key;
    input.addEventListener('change', () => {
      if (input.checked) visibleLayers.add(key); else visibleLayers.delete(key);
      render();
    });
    label.append(input, node('span', `${icon} ${text}`)); filters.append(label);
  }
  root.classList.add('dbusk-calendar');
  root.replaceChildren(controls, options, mobilePicker, scroll, filters, detail, info, subscription);
  initialised = true;
  function secondaryTime(event) {
    if (!secondaryZone) return '';
    return new Intl.DateTimeFormat('en-US', { timeZone: secondaryZone, month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(event.startUtc));
  }
  function renderIdentity() {
    if (identityWallet === wallet) return;
    identityWallet = wallet;
    if (!wallet) { identity.textContent = 'Connect a wallet for your events'; identity.removeAttribute('title'); identity.removeAttribute('aria-label'); return; }
    renderWallet(identity, wallet);
    const requested = wallet;
    void resolveName(requested).then(name => {
      if (destroyed || wallet !== requested || walletKey(getWallet()) !== requested || !name) return;
      identity.textContent = name; identity.setAttribute('aria-label', `${name} · ${requested}`);
    }).catch(error => {
      console.warn('[dbcal] ENS lookup unavailable:', error.message);
      if (!destroyed && wallet === requested) identity.title = `${requested} · ENS lookup unavailable`;
    });
  }

  function navigate(step) {
    if (mode === 'week') anchor = addDays(anchor, step * 7);
    else {
      const date = new Date(`${anchor.slice(0, 7)}-01T12:00:00Z`);
      date.setUTCMonth(date.getUTCMonth() + step);
      anchor = date.toISOString().slice(0, 10);
    }
    selectedDay = anchor;
    scrollToEvents = true;
    render();
  }
  function permitted(event) {
    return event.audience !== 'personal' || (event.owner === wallet && event.owner === currentWallet());
  }
  function eventButton(event, text) {
    const el = button('', () => {
      if (!permitted(event)) return;
      selected = event;
      selectedGroup = event.members ? event : null;
      renderDetail();
      detail.showModal();
    });
    const heading = node('strong', `${layers[calendarLayer(event)][0]} ${text || event.title}`);
    if (secondaryZone) heading.append(node('small', ` (${secondaryTime(event)})`, 'dbcal-secondary-time'));
    el.append(heading);
    const upcoming = (event.members || [event]).some(member => member.attention && member.audience === 'personal' &&
      Date.parse(member.endUtc) > now() && Date.parse(member.startUtc) < now() + 14 * 86400000);
    el.className = `dbcal-event ${event.interval ? 'is-interval' : ''} ${event.audience === 'personal' ? 'is-personal' : ''} ${upcoming ? 'needs-action' : ''} ${event.status === 'cancelled' ? 'is-cancelled' : ''} ${event.projectedPast ? 'is-projection' : ''}`;
    el.dataset.eventId = event.id;
    el.setAttribute('aria-label', `${event.title} · ${dateFormat.format(new Date(event.startUtc))} ${timeFormat.format(new Date(event.startUtc))}${event.members ? ' and other times' : ''}${secondaryZone ? ` (${secondaryTime(event)})` : ''} · ${event.audience === 'personal' ? 'For you · ' : ''}${event.attention || event.status}${event.projectedPast ? ' · past rule projection' : ''}`);
    el.title = el.getAttribute('aria-label');
    if (event.audience === 'personal' || event.attention) el.append(node('span',
      `${event.audience === 'personal' ? '◈ For you' : ''}${event.attention ? ` · ✦ ${event.attention.split(' · ')[0]}` : ''}`,
      event.attention ? 'dbcal-action-badge' : 'dbcal-personal-badge'));
    if (event.status === 'cancelled') el.append(node('span', '⊘ Cancelled'));
    if (event.projectedPast) el.append(node('small', 'Rule projection'));
    return el;
  }
  function renderBars(events, dates, displayedGroups) {
    const bars = node('div', undefined, 'dbcal-bars');
    for (const segment of groupedIntervalSegments(events, dates, timeZone)) {
      if (segment.event.members) displayedGroups.push(segment.event);
      const el = eventButton(segment.event, `${segment.before ? '‹ ' : ''}${segment.event.title}${segment.after ? ' ›' : ''}`);
      el.style.gridColumn = `${segment.start + 1} / ${segment.end + 1}`;
      el.style.gridRow = String(segment.lane + 1);
      el.classList.toggle('continues-before', segment.before);
      el.classList.toggle('continues-after', segment.after);
      el.classList.toggle('is-off-day', selectedDay < dates[segment.start] || selectedDay > dates[segment.end - 1]);
      bars.append(el);
    }
    bars.hidden = !bars.childElementCount;
    return bars;
  }
  function renderDetail() {
    const restoreFocus = detailBody.contains(document.activeElement);
    detailBody.replaceChildren();
    if (!selected || !permitted(selected)) { selected = selectedGroup = null; if (detail.open) detail.close(); return; }
    const event = selected;
    if (event.members) {
      detailBody.append(node('div', layers[calendarLayer(event)][0], 'dbcal-detail-symbol'),
        node('h3', event.title), node('p', 'One blip, every entry. Choose a receipt or event to see its time, evidence and actions.'));
      const list = node('div', undefined, 'dbcal-group-list');
      for (const member of event.members.filter(permitted)) {
        const entry = button('', () => { selected = member; renderDetail(); });
        const start = new Date(member.startUtc);
        const time = member.interval
          ? `${dateFormat.format(start)} ${timeFormat.format(start)} – ${dateFormat.format(new Date(member.endUtc))} ${timeFormat.format(new Date(member.endUtc))}`
          : timeFormat.format(start);
        entry.append(node('strong', member.title), node('span', `${time}${secondaryZone ? ` (${secondaryTime(member)})` : ''}`),
          node('small', `${member.status} · ${member.details?.[0] || provenance[member.provenance] || ''}`));
        list.append(entry);
      }
      detailBody.append(list);
      if (restoreFocus) (list.querySelector('button') || detail.querySelector('button')).focus();
      return;
    }
    if (selectedGroup) detailBody.append(button('‹ All grouped entries', () => { selected = selectedGroup; renderDetail(); }));
    detailBody.append(node('div', layers[calendarLayer(event)][0], 'dbcal-detail-symbol'),
      node('h3', event.title),
      node('p', `${dateFormat.format(new Date(event.startUtc))} ${detailTimeFormat.format(new Date(event.startUtc))} – ${dateFormat.format(new Date(event.endUtc))} ${detailTimeFormat.format(new Date(event.endUtc))} · ${timeZone}`),
      node('p', `${event.audience === 'personal' ? '◈ Your wallet · ' : ''}${event.status}${event.archived ? ' · archived recorded entry; no completion implied' : ''}`, 'dbcal-detail-state'),
      node('small', provenance[event.provenance] || 'Source unavailable'));
    if (secondaryZone) detailBody.append(node('p', `(${secondaryTime(event)})`));
    if (event.attention) detailBody.append(node('p', `✦ ${event.attention}`, 'dbcal-callout'));
    const facts = node('div', undefined, 'dbcal-detail-facts');
    for (const text of event.details || []) facts.append(node('p', text));
    detailBody.append(facts);
    const actions = node('nav', undefined, 'dbcal-detail-actions');
    actions.setAttribute('aria-label', 'Event actions and proof');
    for (const proof of event.proofs || []) actions.append(link('↗ Base receipt', proof.url));
    const portal = calendarPortal(event, currentWallet(), { pathname: location.pathname });
    if (portal?.kind === 'link') actions.append(link('✦ Open campaign', portal.href));
    if (portal && ['profile', 'stage'].includes(portal.kind)) {
      actions.append(button(event.type === 'payment' ? '◈ Your receipts / payments' : '✉ Your invitation / payment in Profile', () => {
        if (!permitted(event)) return;
        detail.close();
        dialog?.close();
        document.dispatchEvent(new CustomEvent('open-creator-profile', { detail: { address: portal.address, bookingId: portal.bookingId } }));
      }));
      if (portal.kind === 'stage' || event.type === 'personal_show') {
        const room = portal.roomUrl;
        if (room) actions.append(link('🎧 Open your performer room / backstage', room));
      }
    }
    if (portal?.kind === 'advert') {
      actions.append(button(`📣 Your DVert campaigns · #${portal.campaignId}`, () => {
        if (!permitted(event)) return;
        detail.close();
        dialog?.close();
        const toggle = document.getElementById('devert-tab');
        if (toggle?.getAttribute('aria-expanded') !== 'true') toggle?.click();
        document.getElementById('devert-my-ads')?.setAttribute('open', '');
      }));
    }
    if (event.audience === 'public' && !event.interval && event.status !== 'cancelled' && Date.parse(event.startUtc) > now()) {
      actions.append(link('🔔 Google reminder', googleRadioCalendarUrl(event)), button('🔔 Apple / Outlook (.ics)', () => {
        const url = URL.createObjectURL(new Blob([buildRadioCalendar([event])], { type: 'text/calendar;charset=utf-8' }));
        const download = node('a');
        download.href = url; download.download = 'dbusk-radio-reminder.ics'; download.click();
        downloads.set(url, setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url); }, 60000));
      }));
    }
    detailBody.append(actions);
    if (restoreFocus) (detailBody.querySelector('button, a[href]') || detail.querySelector('button')).focus();
  }
  function render() {
    if (destroyed) return;
    const range = calendarRange(anchor, mode, timeZone);
    const events = calendarEvents(view.publicData, view.personal, wallet, range, { now: now() })
      .filter(event => visibleLayers.has(calendarLayer(event)));
    const displayedGroups = [];
    root.dataset.mode = mode;
    title.textContent = mode === 'month'
      ? new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${anchor.slice(0, 7)}-01T12:00:00Z`))
      : `${civilFormat.format(new Date(`${range.dates[0]}T12:00Z`))} – ${civilFormat.format(new Date(`${range.dates.at(-1)}T12:00Z`))}, ${anchor.slice(0, 4)}`;
    jump.value = anchor.slice(0, 7);
    week.setAttribute('aria-pressed', String(mode === 'week'));
    month.setAttribute('aria-pressed', String(mode === 'month'));
    renderIdentity();
    zoneLabel.textContent = `${timeZone}${secondaryZone ? ` (${secondaryZone})` : ''}`;
    scroll.setAttribute('aria-label', `DecentCalendar · ${timeZone}`);
    if (!range.dates.includes(selectedDay)) selectedDay = range.dates[0];
    picker.replaceChildren(...range.dates.map(date => {
      const option = node('option', civilFormat.format(new Date(`${date}T12:00:00Z`)));
      option.value = date; return option;
    }));
    picker.value = selectedDay;
    mobilePicker.hidden = mode !== 'week';
    const position = scroll.scrollTop;
    scroll.replaceChildren();
    for (let index = 0; index < range.dates.length; index += 7) {
      const dates = range.dates.slice(index, index + 7);
      const section = node('section', undefined, 'dbcal-week');
      const headings = node('div', undefined, 'dbcal-headings');
      for (const date of dates) {
        const heading = node('h4', civilFormat.format(new Date(`${date}T12:00:00Z`)));
        heading.classList.toggle('is-today', date === localDate(now(), timeZone));
        heading.classList.toggle('is-selected', date === selectedDay);
        headings.append(heading);
      }
      section.append(headings, renderBars(events, dates, displayedGroups));
      const days = node('div', undefined, 'dbcal-days');
      for (const date of dates) {
        const grouped = groupCalendarDay(events, date, timeZone);
        displayedGroups.push(...grouped.filter(event => event.members));
        const day = node('div', undefined, 'dbcal-day');
        day.classList.toggle('is-selected', date === selectedDay);
        day.classList.toggle('is-outside', date.slice(0, 7) !== anchor.slice(0, 7));
        if (mode === 'week') {
          const timeline = node('div', undefined, 'dbcal-timeline');
          for (let hour = 0; hour < 24; hour++) {
            const tick = node('span', `${hour % 12 || 12}${hour < 12 ? 'a' : 'p'}`, 'dbcal-hour');
            tick.style.top = `${hour * 60 / 1440 * 100}%`;
            timeline.append(tick);
          }
          for (const segment of timedSegments(grouped, date, timeZone)) {
            const el = eventButton(segment.event);
            el.prepend(node('small', segment.event.members
              ? `${timeFormat.format(new Date(segment.start))} + other times`
              : `${timeFormat.format(new Date(segment.start))} – ${timeFormat.format(new Date(segment.end))}`));
            el.style.top = `${segment.top / 1440 * 100}%`;
            el.style.height = `${(segment.displayBottom - segment.top) / 1440 * 100}%`;
            el.style.left = `calc(28px + (100% - 28px) * ${segment.lane / segment.lanes})`;
            el.style.width = `calc((100% - 28px) / ${segment.lanes} - 3px)`;
            timeline.append(el);
          }
          day.append(timeline);
        } else {
          for (const segment of timedSegments(grouped, date, timeZone)) {
            day.append(eventButton(segment.event, `${timeFormat.format(new Date(segment.start))}${segment.event.members ? ' +' : ''} · ${segment.event.title}`));
          }
        }
        days.append(day);
      }
      section.append(days); scroll.append(section);
    }
    if (scrollToEvents && mode === 'month') { scroll.scrollTop = 0; scrollToEvents = false; }
    else if (scrollToEvents && events.some(event => !event.interval)) {
      const dates = window.matchMedia?.('(max-width: 700px)').matches ? [selectedDay] : range.dates;
      const starts = dates.flatMap(date => timedSegments(groupCalendarDay(events, date, timeZone), date, timeZone).map(segment => segment.top));
      scroll.scrollTop = starts.length ? Math.max(0, Math.min(...starts) - 60) / 60 * 48 : 0;
      scrollToEvents = false;
    } else scroll.scrollTop = position;
    sourceNotices.replaceChildren();
    const labels = { schedule: 'Public schedule', promotions: 'Campaigns', bookings: 'Your invitations', earnings: 'Your payment index', ads: 'Your ad terms',
      tips: 'Your ETH tip receipts', sharedTips: 'Your token / NFT tip receipts' };
    for (const [key, source] of Object.entries(view.sources)) {
      if (!['unavailable', 'partial'].includes(source.status)) continue;
      sourceNotices.append(node('p', `⚠ ${labels[key]}: ${source.status}${source.error ? ` · ${source.error}` : ''}${source.through != null ? ` · through block ${source.through}` : ''}`));
    }
    const failed = Object.values(view.sources).some(source => ['unavailable', 'partial'].includes(source.status));
    status.textContent = Object.values(view.sources).some(source => source.status === 'loading')
      ? 'Checking calendar…' : failed ? '⚠ Some calendar data is unavailable or partial · details in ⓘ. Previously loaded entries may be stale.'
        : events.length ? '' : 'No recorded events match these dates and overlays.';
    status.hidden = !status.textContent;
    if (selected) {
      selected = [...events, ...displayedGroups].find(event => event.id === selected.id);
      if (selectedGroup) selectedGroup = displayedGroups.find(event => event.id === selectedGroup.id);
      renderDetail();
    }
  }
  async function refresh(force = false) {
    if (!dialog?.open || document.hidden || destroyed) return;
    const actual = currentWallet();
    if (actual !== wallet) { wallet = actual; selected = null; store.setWallet(wallet); renderDetail(); }
    await store.refresh({ force });
  }
  const stop = () => {
    clearInterval(timer); clearInterval(clockTimer); timer = clockTimer = null;
    selected = null; store.pause(); renderDetail();
    for (const popup of [info, subscription]) if (popup.open) popup.close();
  };
  const updateClock = () => {
    const clock = document.getElementById('radio-schedule-clock');
    if (clock) {
      clock.textContent = `NY · ${new Intl.DateTimeFormat('en-US', { timeZone: DCAL_ZONE, weekday: 'short',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(now()))}`;
      clock.dateTime = new Date(now()).toISOString();
    }
  };
  const open = () => {
    if (!dialog.open) dialog.showModal();
    if (!document.hidden && !timer) timer = setInterval(() => refresh(), 5 * 60 * 1000);
    updateClock();
    if (!document.hidden && !clockTimer) clockTimer = setInterval(updateClock, 30000);
    void refresh();
  };
  listen(document, 'open-radio-schedule', open);
  listen(document, 'radio-schedule-updated', () => refresh(true));
  listen(document, 'live-booking-acknowledged', () => refresh(true));
  listen(document, 'wallet-connected', () => {
    wallet = walletKey(getWallet()); selected = null; scrollToEvents = true; store.setWallet(wallet); renderDetail(); void refresh(true);
  });
  listen(document, 'wallet-disconnected', () => {
    wallet = ''; selected = null; store.setWallet(''); renderDetail(); void refresh(true);
  });
  const ethereum = window.ethereum;
  const accountsChanged = () => {
    // Wallet rebuilding awaits provider calls; clear before that work can finish.
    wallet = ''; selected = null; store.setWallet(''); renderDetail();
  };
  if (ethereum?.on) {
    ethereum.on('accountsChanged', accountsChanged);
    handlers.push(() => ethereum.removeListener?.('accountsChanged', accountsChanged));
  }
  listen(document, 'visibilitychange', () => {
    if (document.hidden) stop();
    else if (dialog.open) open();
  });
  listen(dialog, 'close', stop);
  listen(document.getElementById('radio-schedule-info'), 'click', () => info.showModal());
  listen(document.getElementById('radio-calendar-info'), 'click', () => {
    feedDisplay.value = document.getElementById('radio-calendar-feed')?.value || '';
    subscription.showModal();
  });
  listen(detail, 'close', () => { selected = selectedGroup = null; });
  listen(document.getElementById('radio-schedule-close'), 'click', () => dialog.close());
  listen(document.getElementById('radio-schedule-refresh'), 'click', () => refresh(true));
  const destroy = () => {
    destroyed = true; stop(); store.dispose(); handlers.forEach(remove => remove());
    for (const [url, timeout] of downloads) { clearTimeout(timeout); URL.revokeObjectURL(url); }
    downloads.clear(); root.replaceChildren(); delete root.dataset.mounted;
  };
  listen(window, 'pagehide', event => { if (event.persisted) stop(); else destroy(); });
  listen(window, 'pageshow', event => { if (event.persisted && dialog.open) open(); });
  render();
  return { open, refresh, destroy, store };
}
