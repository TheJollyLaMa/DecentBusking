import { DCAL_ZONE, localDate, addDays, calendarRange, calendarEvents, intervalSegments, timedSegments, walletKey } from './dbusk-calendar-core.mjs';
import { createCalendarStore } from './dbusk-calendar-store.mjs';
import { googleRadioCalendarUrl, buildRadioCalendar } from './radio-calendar.mjs?v=20261024-programming-calendar';

const dateFormat = new Intl.DateTimeFormat('en-US', { timeZone: DCAL_ZONE, weekday: 'short', month: 'short', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('en-US', { timeZone: DCAL_ZONE, hour: 'numeric', minute: '2-digit' });
const detailTimeFormat = new Intl.DateTimeFormat('en-US', { timeZone: DCAL_ZONE, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
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
  getWallet = () => globalThis.window?._wallet?.address || '', now = Date.now, tipRouters } = {}) {
  let wallet = walletKey(getWallet());
  let mode = 'week';
  let anchor = localDate(now());
  let selectedDay = anchor;
  let showPastRules = false;
  let selected;
  let timer;
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
  const today = button('Today', () => { anchor = selectedDay = localDate(now()); scrollToEvents = true; render(); });
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
  const projectionLabel = node('label', 'Show past projections of today’s rules ');
  const projection = node('input');
  projection.type = 'checkbox';
  projection.addEventListener('change', () => { showPastRules = projection.checked; render(); });
  projectionLabel.prepend(projection);
  options.append(identity, projectionLabel);
  const mobilePicker = node('div', undefined, 'dbcal-day-picker');
  const picker = node('select');
  picker.setAttribute('aria-label', 'Day in this week');
  picker.addEventListener('change', () => { selectedDay = picker.value; scrollToEvents = true; render(); });
  mobilePicker.append(node('span', 'Day'), picker);
  const scroll = node('div', undefined, 'dbcal-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', 'DBusk calendar · New York time');
  const detail = node('section', undefined, 'dbcal-detail');
  detail.hidden = true;
  detail.tabIndex = -1;
  detail.setAttribute('aria-label', 'Selected calendar event');
  const coverage = node('p', undefined, 'dbcal-coverage');
  const sourceList = node('ul', undefined, 'dbcal-sources');
  root.classList.add('dbusk-calendar');
  root.replaceChildren(controls, options, mobilePicker, scroll, detail, coverage, sourceList);
  initialised = true;

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
      renderDetail();
      detail.focus();
    });
    el.append(node('strong', text || event.title));
    el.className = `dbcal-event ${event.interval ? 'is-interval' : ''} ${event.audience === 'personal' ? 'is-personal' : ''} ${event.attention ? 'needs-action' : ''} ${event.status === 'cancelled' ? 'is-cancelled' : ''} ${event.projectedPast ? 'is-projection' : ''}`;
    el.dataset.eventId = event.id;
    el.setAttribute('aria-label', `${event.title} · ${dateFormat.format(new Date(event.startUtc))} ${timeFormat.format(new Date(event.startUtc))} · ${event.audience === 'personal' ? 'For you · ' : ''}${event.attention || event.status}${event.projectedPast ? ' · past rule projection' : ''}`);
    el.title = el.getAttribute('aria-label');
    if (event.audience === 'personal' || event.attention) el.append(node('span',
      `${event.audience === 'personal' ? '◈ For you' : ''}${event.attention ? ` · ✦ ${event.attention.split(' · ')[0]}` : ''}`,
      event.attention ? 'dbcal-action-badge' : 'dbcal-personal-badge'));
    if (event.status === 'cancelled') el.append(node('span', '⊘ Cancelled'));
    if (event.projectedPast) el.append(node('small', 'Rule projection'));
    return el;
  }
  function renderBars(events, dates) {
    const bars = node('div', undefined, 'dbcal-bars');
    for (const segment of intervalSegments(events, dates)) {
      const el = eventButton(segment.event, `${segment.before ? '‹ ' : ''}${segment.event.title}${segment.after ? ' ›' : ''}`);
      el.style.gridColumn = `${segment.start + 1} / ${segment.end + 1}`;
      el.style.gridRow = String(segment.lane + 1);
      el.classList.toggle('continues-before', segment.before);
      el.classList.toggle('continues-after', segment.after);
      const last = localDate(Date.parse(segment.event.endUtc) - 1);
      el.classList.toggle('is-off-day', selectedDay < localDate(Date.parse(segment.event.startUtc)) || selectedDay > last);
      bars.append(el);
    }
    bars.hidden = !bars.childElementCount;
    return bars;
  }
  function renderDetail() {
    detail.replaceChildren();
    if (!selected || !permitted(selected)) { selected = null; detail.hidden = true; return; }
    const event = selected;
    detail.hidden = false;
    detail.append(button('✕', () => { selected = null; renderDetail(); }, 'Close event details'),
      node('h4', event.title),
      node('p', `${dateFormat.format(new Date(event.startUtc))} ${detailTimeFormat.format(new Date(event.startUtc))} – ${dateFormat.format(new Date(event.endUtc))} ${detailTimeFormat.format(new Date(event.endUtc))} · New York`),
      node('p', `${event.audience === 'personal' ? '◈ For you · ' : ''}${event.status}${event.archived ? ' · archived recorded entry; no completion implied' : ''}`),
      node('small', provenance[event.provenance] || 'Source unavailable'));
    if (event.attention) detail.append(node('p', `✦ ${event.attention}`));
    for (const text of event.details || []) detail.append(node('p', text));
    for (const proof of event.proofs || []) detail.append(link('↗ Base receipt', proof.url));
    const portal = calendarPortal(event, currentWallet(), { pathname: location.pathname });
    if (portal?.kind === 'link') detail.append(link('Open campaign', portal.href));
    if (portal && ['profile', 'stage'].includes(portal.kind)) {
      detail.append(button(event.type === 'payment' ? 'Open your receipts / payments' : 'Open your invitation / payment in Profile', () => {
        if (!permitted(event)) return;
        dialog?.close();
        document.dispatchEvent(new CustomEvent('open-creator-profile', { detail: { address: portal.address, bookingId: portal.bookingId } }));
      }));
      if (portal.kind === 'stage' || event.type === 'personal_show') {
        const room = portal.roomUrl;
        if (room) detail.append(link('🎧 Open your performer room / backstage', room));
      }
    }
    if (portal?.kind === 'advert') {
      detail.append(button(`Open your DVert campaigns · #${portal.campaignId}`, () => {
        if (!permitted(event)) return;
        dialog?.close();
        const toggle = document.getElementById('devert-tab');
        if (toggle?.getAttribute('aria-expanded') !== 'true') toggle?.click();
        document.getElementById('devert-my-ads')?.setAttribute('open', '');
      }));
    }
    if (event.audience === 'public' && !event.interval && event.status !== 'cancelled' && Date.parse(event.startUtc) > now()) {
      detail.append(link('🔔 Google reminder', googleRadioCalendarUrl(event)), button('🔔 Apple / Outlook (.ics)', () => {
        const url = URL.createObjectURL(new Blob([buildRadioCalendar([event])], { type: 'text/calendar;charset=utf-8' }));
        const download = node('a');
        download.href = url; download.download = 'dbusk-radio-reminder.ics'; download.click();
        downloads.set(url, setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url); }, 60000));
      }));
    }
  }
  function render() {
    if (destroyed) return;
    const range = calendarRange(anchor, mode);
    const events = calendarEvents(view.publicData, view.personal, wallet, range, { now: now(), showPastRules });
    root.dataset.mode = mode;
    title.textContent = mode === 'month'
      ? new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${anchor.slice(0, 7)}-01T12:00:00Z`))
      : `${dateFormat.format(new Date(range.start))} – ${dateFormat.format(new Date(Date.parse(range.end) - 1))}, ${anchor.slice(0, 4)}`;
    jump.value = anchor.slice(0, 7);
    week.setAttribute('aria-pressed', String(mode === 'week'));
    month.setAttribute('aria-pressed', String(mode === 'month'));
    identity.textContent = wallet ? `◈ For you · ${wallet.slice(0, 6)}…${wallet.slice(-4)}` : '☿ Public calendar · connect for your events';
    if (!range.dates.includes(selectedDay)) selectedDay = range.dates[0];
    picker.replaceChildren(...range.dates.map(date => {
      const option = node('option', dateFormat.format(new Date(`${date}T12:00:00Z`)));
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
        const heading = node('h4', dateFormat.format(new Date(`${date}T12:00:00Z`)));
        heading.classList.toggle('is-today', date === localDate(now()));
        heading.classList.toggle('is-selected', date === selectedDay);
        headings.append(heading);
      }
      section.append(headings, renderBars(events, dates));
      const days = node('div', undefined, 'dbcal-days');
      for (const date of dates) {
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
          for (const segment of timedSegments(events, date)) {
            const el = eventButton(segment.event);
            el.prepend(node('small', `${timeFormat.format(new Date(segment.start))} – ${timeFormat.format(new Date(segment.end))}`));
            el.style.top = `${segment.top / 1440 * 100}%`;
            el.style.height = `${(segment.displayBottom - segment.top) / 1440 * 100}%`;
            el.style.left = `calc(28px + (100% - 28px) * ${segment.lane / segment.lanes})`;
            el.style.width = `calc((100% - 28px) / ${segment.lanes} - 3px)`;
            timeline.append(el);
          }
          day.append(timeline);
        } else {
          for (const segment of timedSegments(events, date)) {
            day.append(eventButton(segment.event, `${timeFormat.format(new Date(segment.start))} · ${segment.event.title}`));
          }
        }
        days.append(day);
      }
      section.append(days); scroll.append(section);
    }
    if (scrollToEvents && mode === 'month') { scroll.scrollTop = 0; scrollToEvents = false; }
    else if (scrollToEvents && events.some(event => !event.interval)) {
      const dates = window.matchMedia?.('(max-width: 700px)').matches ? [selectedDay] : range.dates;
      const starts = dates.flatMap(date => timedSegments(events, date).map(segment => segment.top));
      scroll.scrollTop = starts.length ? Math.max(0, Math.min(...starts) - 60) / 60 * 48 : 0;
      scrollToEvents = false;
    } else scroll.scrollTop = position;
    coverage.textContent = 'New York time · Recorded archives only by default. Current rules are not historical programming. Sources retain limited schedule / ledger history; an empty past month is not proof of no activity. Browsing never signs or moves funds.';
    sourceList.replaceChildren();
    const labels = { schedule: 'Public schedule', promotions: 'Campaigns', bookings: 'Your invitations', earnings: 'Your payment index', ads: 'Your ad terms',
      tips: 'Your ETH tip receipts', sharedTips: 'Your token / NFT tip receipts' };
    for (const [key, source] of Object.entries(view.sources)) {
      const label = node('li', `${labels[key]}: ${source.status}${source.error ? ` · ${source.error}` : ''}${source.through != null ? ` · through block ${source.through}` : ''}`);
      if (['unavailable', 'partial'].includes(source.status)) label.className = 'is-unavailable';
      sourceList.append(label);
    }
    const failed = Object.values(view.sources).some(source => ['unavailable', 'partial'].includes(source.status));
    status.textContent = Object.values(view.sources).some(source => source.status === 'loading')
      ? 'Checking calendar sources…' : failed ? 'Partial calendar · check source notices below. Previously loaded public entries may be stale.'
        : events.length ? 'Public schedule + your wallet’s events. Select an event for details.' : 'No recorded events in this period from the available sources.';
    if (selected) {
      selected = events.find(event => event.id === selected.id);
      renderDetail();
    }
  }
  async function refresh(force = false) {
    if (!dialog?.open || document.hidden || destroyed) return;
    const actual = currentWallet();
    if (actual !== wallet) { wallet = actual; selected = null; store.setWallet(wallet); renderDetail(); }
    await store.refresh({ force });
  }
  const stop = () => { clearInterval(timer); timer = null; selected = null; store.pause(); renderDetail(); };
  const open = () => {
    if (!dialog.open) dialog.showModal();
    if (!document.hidden && !timer) timer = setInterval(() => refresh(), 5 * 60 * 1000);
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
