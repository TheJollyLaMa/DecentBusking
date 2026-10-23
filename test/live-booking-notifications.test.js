const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const owner = '0x' + '11'.repeat(20);
const performer = '0x' + '22'.repeat(20);
const now = Date.parse('2026-10-22T20:00:00Z');
const booking = {
 id: 'live:invite', wallet: performer, mode: 'phase1', status: 'draft',
 stewardApproved: true, acknowledged: false, scheduleStatus: 'synced',
 startUtc: '2026-10-24T01:00:00Z', endUtc: '2026-10-24T01:20:00Z',
 claimDeadline: '2026-10-28T01:20:00Z', reviewWindow: 86400, transactions: {},
};
const state = (...bookings) => ({ escrowAddress: '0x' + '33'.repeat(20), bookings });

test('action badges mark wallet-scoped handoffs, not calendar housekeeping or pending confirmations', async () => {
 const { liveBookingActions } = await import('../js/live-booking-notifications.mjs');
 const actions = (wallet, changes = {}) => liveBookingActions(state({ ...booking, ...changes }), wallet, owner, now);
 assert.deepEqual(actions(''), { admin: [], schedule: [], profile: [] });
 assert.deepEqual(actions('0x' + '44'.repeat(20)), { admin: [], schedule: [], profile: [] });
 assert.equal(actions(performer.toUpperCase()).schedule.length, 1);
 assert.equal(actions(performer, { stewardApproved: false }).schedule.length, 0);
 assert.equal(actions(performer, { acknowledged: true }).schedule.length, 0);
 assert.equal(actions(performer, { cancelled: true }).schedule.length, 0);
 assert.equal(actions(performer, { mode: 'phase0' }).schedule.length, 0);
 assert.equal(actions(owner).admin.length, 0);
 assert.equal(actions(owner, { scheduleStatus: undefined }).admin.length, 0);
 assert.match(actions(owner, { acknowledged: true }).admin[0].label, /fund booking/);
 assert.equal(actions(owner, { acknowledged: true, transactions: { funding: { status: 'pending' } } }).admin.length, 0);
 assert.equal(actions(owner, { status: 'funding pending', acknowledged: true }).admin.length, 0);
 assert.equal(actions(owner, { status: 'failed' }).admin.length, 0);
 assert.match(actions(owner, { status: 'failed', acknowledged: true }).admin[0].label, /fund booking/);
 assert.equal(actions(owner, { acknowledged: true, mode: 'phase0' }).admin.length, 0);
 assert.equal(liveBookingActions({ bookings: [{ ...booking, acknowledged: true }] }, owner, owner, now).admin.length, 0);
});

test('review and claim badges follow confirmed status and exact review/claim deadlines', async () => {
 const { liveBookingActions } = await import('../js/live-booking-notifications.mjs');
 const end = Date.parse(booking.endUtc);
 const actions = (wallet, time, changes = {}) =>
  liveBookingActions(state({ ...booking, status: 'funded', ...changes }), wallet, owner, time);
 assert.equal(actions(owner, end - 1).admin.length, 0);
 assert.match(actions(owner, end).admin[0].label, /Review performance/);
 assert.match(actions(owner, end, { decision: { payoutBps: 10000 } }).admin[0].label, /Submit/);
 assert.equal(actions(owner, end + 86400000).admin.length, 0);
 assert.equal(actions(performer, end + 86400000 - 1).profile.length, 0);
 assert.equal(actions(performer, end + 86400000).profile.length, 1);
 assert.equal(actions(performer, end, { status: 'approved' }).profile.length, 1);
 assert.equal(actions(performer, Date.parse(booking.claimDeadline) + 1).profile.length, 0);
 for (const status of ['paid', 'refunded']) {
  assert.equal(actions(performer, end + 86400000, { status }).profile.length, 0);
  assert.equal(actions(owner, end, { status }).admin.length, 0);
 }
 assert.equal(liveBookingActions(state(booking), performer, owner, Date.parse(booking.startUtc)).schedule.length, 0);
});

test('cancellation reconciliation and independent booking counts are preserved', async () => {
 const { liveBookingActions } = await import('../js/live-booking-notifications.mjs');
 assert.equal(liveBookingActions(state({ ...booking, cancelled: true, scheduleStatus: 'failed' }), owner, owner, now).admin.length, 0);
 assert.match(liveBookingActions(state({ ...booking, cancelled: true, status: 'funded' }), owner, owner, now).admin[0].label, /cancellation payment/);
 const invites = state(booking, { ...booking, id: 'live:second' });
 assert.equal(liveBookingActions(invites, performer, owner, now).schedule.length, 2);
});

test('waiting for the other party and pending review/claim confirmations never light action badges', async () => {
 const { liveBookingActions } = await import('../js/live-booking-notifications.mjs');
 const end = Date.parse(booking.endUtc);
 for (const [status, txAction] of [['funded', 'approve'], ['approved', 'claim']]) {
  const s = state({ ...booking, status, acknowledged: true, transactions: { [txAction]: { status: 'pending' } } });
  assert.deepEqual(liveBookingActions(s, owner, owner, end), { admin: [], schedule: [], profile: [] });
  assert.deepEqual(liveBookingActions(s, performer, owner, end), { admin: [], schedule: [], profile: [] });
 }
 const approved = state({ ...booking, status: 'approved', acknowledged: true });
 assert.equal(liveBookingActions(approved, owner, owner, end).admin.length, 0);
 const localPending = new Set([booking.id]);
 assert.equal(liveBookingActions(state({ ...booking, acknowledged: true }), owner, owner, now, localPending).admin.length, 0);
 assert.equal(liveBookingActions(approved, performer, owner, end, localPending).profile.length, 0);
 const css = fs.readFileSync(new URL('../css/live-performance.css', `file://${__filename}`), 'utf8');
 assert.match(css, /background: #00cfff; color: #001522/);
});

test('booking and mint notification timers use five-minute checks, with no fifteen-second admin poll', async () => {
 const { LIVE_BOOKING_POLL_MS } = await import('../js/live-booking-notifications.mjs');
 assert.equal(LIVE_BOOKING_POLL_MS, 300000);
 const source = file => fs.readFileSync(new URL(`../${file}`, `file://${__filename}`), 'utf8');
 assert.doesNotMatch(source('js/live-performance-admin.mjs'), /15_000|15000|setInterval/);
 assert.match(source('js/radio-schedule-ui.mjs'), /setInterval\([^]*5 \* 60 \* 1000\)/);
 assert.match(source('js/components/header-admin-inject.js'), /setInterval\([^]*5 \* 60 \* 1000\)/);
});

test('notification polling starts on connection, runs at five minutes, and ignores disconnected responses', async () => {
 const { claimState } = await import('../js/live-bookings.mjs');
 const listeners = new Map();
 const timers = new Map();
 const requests = [];
 const updates = [];
 const document = {
  readyState: 'loading',
  addEventListener(name, fn) {
   if (!listeners.has(name)) listeners.set(name, []);
   listeners.get(name).push(fn);
  },
  dispatchEvent(event) {
   if (event.type === 'live-booking-state-updated') updates.push(event.detail.state);
   for (const fn of listeners.get(event.type) || []) fn(event);
  },
  querySelector: () => null,
  querySelectorAll: () => [],
 };
 const window = { _wallet: {}, DecentConfig: { ipfsUploadServiceUrl: 'https://worker.example', adminWalletAddress: owner } };
 const context = vm.createContext({
  document, window, claimState, isAdminWallet: () => false, localStorage: { getItem: () => null },
  queueMicrotask, console, AbortSignal,
  MutationObserver: class { observe() {} },
  CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
  setInterval: (fn, ms) => { const id = timers.size + 1; timers.set(id, { fn, ms }); return id; },
  clearInterval: id => timers.delete(id),
  fetch: () => new Promise(resolve => requests.push(resolve)),
 });
 const source = fs.readFileSync(new URL('../js/live-booking-notifications.mjs', `file://${__filename}`), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
 vm.runInContext(source, context);
 document.dispatchEvent({ type: 'DOMContentLoaded' });
 assert.equal(requests.length, 0);
 window._wallet = { address: owner };
 document.dispatchEvent({ type: 'wallet-connected' });
 assert.equal(requests.length, 1);
 assert.equal(timers.size, 1);
 assert.equal([...timers.values()][0].ms, 300000);
 const result = state(booking);
 requests[0]({ ok: true, json: async () => result });
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(updates.length, 1);
 [...timers.values()][0].fn();
 assert.equal(requests.length, 2);
 window._wallet = {};
 document.dispatchEvent({ type: 'wallet-disconnected' });
 assert.equal(timers.size, 0);
 requests[1]({ ok: true, json: async () => result });
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(updates.length, 1);
});

test('worker funding and booking badges aggregate only at admin anchors', async () => {
 const { claimState } = await import('../js/live-bookings.mjs');
 const listeners = new Map(), badges = new Map();
 const target = () => ({
  classList: { add() {} }, querySelector() { return this.badge; },
  append(badge) { this.badge = badge; },
 });
 const ankh = target(), admin = target(), bookingPanel = target();
 let isAdmin = true;
 const document = {
  readyState: 'loading',
  addEventListener(name, fn) {
   if (!listeners.has(name)) listeners.set(name, []);
   listeners.get(name).push(fn);
  },
  dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); },
  createElement: () => ({ dataset: {}, setAttribute() {} }),
  head: { append() {} },
  append() {},
  querySelector: selector => badges.get(selector) || null,
  querySelectorAll: () => [],
 };
 badges.set('.ankh-left', ankh);
 badges.set('[data-admin-item]', admin);
 badges.set('.live-performance-admin-summary', bookingPanel);
 const context = vm.createContext({
  document, window: { _wallet: { address: owner }, DecentConfig: { adminWalletAddress: owner } },
  claimState, isAdminWallet: () => isAdmin, localStorage: { getItem: () => null },
  queueMicrotask, console, MutationObserver: class { observe() {} },
  setInterval() {}, clearInterval() {},
  Date: class extends Date { static now() { return now; } },
 });
 const source = fs.readFileSync(new URL('../js/live-booking-notifications.mjs', `file://${__filename}`), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
 vm.runInContext(source, context);
 document.dispatchEvent({ type: 'DOMContentLoaded' });
 document.dispatchEvent({ type: 'live-booking-state-updated', detail: { state: state({ ...booking, acknowledged: true }) } });
 document.dispatchEvent({ type: 'worker-gas-state-updated', detail: { action: { id: 'worker-gas', label: 'Top up' } } });
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(ankh.badge.textContent, '2');
 assert.equal(admin.badge.textContent, '2');
 assert.equal(bookingPanel.badge.textContent, '1', 'worker funding is not a booking action');
 document.dispatchEvent({ type: 'worker-gas-state-updated', detail: { action: null } });
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(admin.badge.textContent, '1', 'funding recovery preserves the booking action');
 isAdmin = false;
 context.window._wallet = {};
 document.dispatchEvent({ type: 'wallet-disconnected' });
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(admin.badge.hidden, true);
});
