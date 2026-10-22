import { claimState } from './live-bookings.mjs?v=20261022-live-offer-v2';
import { isAdminWallet } from './admin-access.mjs';

export const LIVE_BOOKING_POLL_MS = 5 * 60 * 1000;

export function liveBookingActions(state, wallet, owner, now = Date.now()) {
 const actions = { admin: [], schedule: [], profile: [] };
 if (!wallet) return actions;
 for (const b of state.bookings || []) {
  const pending = Object.values(b.transactions || {}).some(tx => tx.status === 'pending');
  if (wallet.toLowerCase() === owner?.toLowerCase()) {
   let label;
   if (pending || ['funding pending', 'failed'].includes(b.status)) label = 'Reconcile booking transaction';
   else if (b.cancelled && b.scheduleStatus !== 'synced') label = 'Sync calendar cancellation';
   else if (b.cancelled && b.status === 'funded') label = 'Reconcile cancellation payment';
   else if (!b.cancelled && !['paid', 'refunded'].includes(b.status)) {
    if (b.scheduleStatus !== 'synced' && Date.parse(b.endUtc) > now) label = 'Add or retry calendar listing';
    else if (b.status === 'draft' && b.acknowledged && Date.parse(b.startUtc) > now) label = 'Performer accepted: fund booking';
    else if (b.status === 'funded' && now >= Date.parse(b.endUtc) &&
             now < Date.parse(b.endUtc) + b.reviewWindow * 1000) {
     label = b.decision ? 'Submit recorded payment decision' : 'Review performance and record live minutes';
    }
   }
   if (label) actions.admin.push({ id: b.id, label });
  }
  if (b.wallet?.toLowerCase() !== wallet.toLowerCase() || b.mode !== 'phase1') continue;
  if (!b.cancelled && b.status === 'draft' && b.stewardApproved && !b.acknowledged &&
      Date.parse(b.startUtc) > now) actions.schedule.push({ id: b.id, label: 'Review and accept performance invitation' });
  if (!pending && claimState(b, state.escrowAddress, wallet, now).enabled) {
   actions.profile.push({ id: b.id, label: 'Claim live-performance payment' });
  }
 }
 return actions;
}

export function publishLiveBookingState(state) {
 document.dispatchEvent(new CustomEvent('live-booking-state-updated', { detail: { state } }));
}

const BADGE_STYLE = `
 .live-action-anchor { position: relative; }
 .live-action-badge { display: inline-flex; align-items: center; justify-content: center;
  min-width: 1rem; height: 1rem; padding: 0 .18rem; margin-left: .45rem; border-radius: 999px;
  background: #d71932; color: #fff; border: 1px solid #ffb6bf; font: 700 .68rem/1 system-ui;
  vertical-align: middle; pointer-events: none; }
 .live-action-badge[hidden] { display: none; }
 .live-action-anchor > .live-action-badge { position: absolute; bottom: -5px; right: -5px;
  margin: 0; z-index: 3; box-shadow: 0 0 6px #d7193266; }
`;

export function renderLiveActionBadge(target, count, label, anchor = false) {
 if (!target) return;
 if (anchor) target.classList.add('live-action-anchor');
 let badge = target.querySelector(':scope > .live-action-badge');
 if (!badge) {
  badge = document.createElement('span');
  badge.className = 'live-action-badge';
  badge.setAttribute('role', 'status');
  target.append(badge);
 }
 const text = count ? `${count}` : '';
 if (badge.textContent !== text) badge.textContent = text;
 badge.hidden = !count;
 badge.setAttribute('aria-label', `${count} ${label}`);
 badge.title = `${count} ${label}`;
}

function startNotifications() {
 let state = { bookings: [] };
 let generation = 0;
 let timer;
 let queued = false;
 const observed = new WeakSet();
 const actions = () => liveBookingActions(state, window._wallet?.address,
  window.DecentConfig?.adminWalletAddress || '0x807061DF657A7697c04045dA7d16D941861cAABc');
 const update = () => {
  queued = false;
  const counts = actions();
  const visit = root => {
   if (!observed.has(root)) {
    observed.add(root);
    new MutationObserver(records => {
     if (records.some(record => [...record.addedNodes].some(node => node.nodeType === 1 &&
         !node.matches('.live-action-badge, [data-live-action-style]')))) scheduleUpdate();
    }).observe(root, { childList: true, subtree: true });
   }
   if (root.querySelector('.ankh-left, .right-ankh-menu') && !root.querySelector('[data-live-action-style]')) {
    const style = document.createElement('style');
    style.dataset.liveActionStyle = '1';
    style.textContent = BADGE_STYLE;
    root.append(style);
   }
   renderLiveActionBadge(root.querySelector('.ankh-left'), counts.admin.length, 'live-performance admin actions', true);
   renderLiveActionBadge(root.querySelector('[data-admin-item]'), counts.admin.length, 'live-performance admin actions');
   if (root.querySelector('#creator-profile-btn')) {
    renderLiveActionBadge(root.querySelector('.ankh-container'), counts.schedule.length + counts.profile.length, 'live-performance actions', true);
    renderLiveActionBadge(root.querySelector('#radio-schedule-btn'), counts.schedule.length, 'performance invitations to accept');
    renderLiveActionBadge(root.querySelector('#creator-profile-btn'), counts.profile.length, 'performance payments to claim');
   }
   root.querySelectorAll('*').forEach(element => { if (element.shadowRoot) visit(element.shadowRoot); });
  };
  visit(document);
  renderLiveActionBadge(document.querySelector('.live-performance-admin-summary'), counts.admin.length, 'live-performance admin actions');
  renderLiveActionBadge(document.querySelector('.creator-live-performances > h3'), counts.schedule.length + counts.profile.length, 'live-performance actions');
  document.querySelectorAll('[data-live-actions]').forEach(row => {
   const action = counts.admin.find(item => item.id === row.dataset.liveActions);
   renderLiveActionBadge(row.querySelector('.live-booking-actions > summary'), action ? 1 : 0, action?.label || 'booking actions');
  });
  document.querySelectorAll('.live-booking-group').forEach(group => {
   const ids = [...group.querySelectorAll('[data-live-actions]')].map(row => row.dataset.liveActions);
   renderLiveActionBadge(group.querySelector(':scope > summary'), counts.admin.filter(item => ids.includes(item.id)).length, 'live-performance actions');
  });
 };
 function scheduleUpdate() {
  if (queued) return;
  queued = true;
  queueMicrotask(update);
 }
 async function refresh() {
  const wallet = window._wallet?.address;
  const service = String(window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
  if (!wallet || !service) return;
  const revision = generation;
  try {
   const response = await fetch(`${service}/api/live-bookings`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
   const result = await response.json();
   if (!response.ok || !Array.isArray(result.bookings)) throw new Error(result.error || 'Live booking notifications unavailable');
   if (revision !== generation || wallet.toLowerCase() !== window._wallet?.address?.toLowerCase()) return;
   publishLiveBookingState(result);
  } catch (error) {
   if (revision !== generation) return;
   console.warn('[live-booking-notifications]', error.message);
   document.dispatchEvent(new CustomEvent('live-booking-notification-error', { detail: { message: error.message } }));
  }
 }
 function reset() {
  generation++;
  clearInterval(timer);
  state = { bookings: [] };
  scheduleUpdate();
  if (window._wallet?.address) {
   void refresh();
   timer = setInterval(refresh, LIVE_BOOKING_POLL_MS);
  }
 }
 document.addEventListener('live-booking-state-updated', event => { state = event.detail.state; scheduleUpdate(); });
 document.addEventListener('wallet-connected', reset);
 document.addEventListener('wallet-disconnected', reset);
 document.addEventListener('live-booking-acknowledged', refresh);
 document.addEventListener('live-booking-claim-updated', refresh);
 document.addEventListener('open-admin', () => {
  if (!isAdminWallet() || !actions().admin.length) return;
  queueMicrotask(() => {
   const panel = document.querySelector('.live-performance-admin');
   if (!panel) return;
   panel.open = true;
   const row = [...panel.querySelectorAll('[data-live-actions]')].find(element => element.dataset.liveActions === actions().admin[0]?.id);
   if (row) {
    row.closest('.live-booking-group').open = true;
    row.querySelector('.live-booking-actions').open = true;
   }
   (row || panel).scrollIntoView({ block: 'nearest' });
  });
 });
 reset();
}

if (typeof document !== 'undefined') {
 if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startNotifications, { once: true });
 else startNotifications();
}
