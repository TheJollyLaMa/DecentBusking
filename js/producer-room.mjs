import { roomRequest } from './live-audio-client.mjs?v=20261114-allocated-stage';
import { readRadioState, radioEndpoint } from './radio-client.mjs';
import { bindLiveDirection } from './live-direction.mjs?v=20261114-allocated-stage';
import { bindLiveFeedbackRoom, bindTogether } from './live-feedback.mjs?v=20261115-listener-feedback';
import { createPrivateRoomListener } from './private-room-listener.mjs?v=20261114-allocated-stage';
import { bindLiveBroadcastControls } from './live-broadcast-controls.mjs?v=20261117-producer-recovery';
import { performerAllocationAccess } from './performer-room.mjs?v=20261114-allocated-stage';
import { safeBindProducerListenerTelemetry } from './producer-listener-telemetry.mjs';

const el = id => document.getElementById(id);
const serviceUrl = String(window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
const initialBookingId = new URL(location.href).searchParams.get('booking') || '';
const passes = new Map();
const audioStates = new Map();
let bookings = [], selectedId = '', wallet, direction, broadcastControls, disposed = false, refreshing = false;
let generation = 0, requestingAccounts = false, busy = false, radioState, radioAt = 0;
let bookingsAt = 0, privateState;
const listener = createPrivateRoomListener({ serviceUrl, audio: el('desk-audio'),
  onStatus: message => { el('desk-listen-status').textContent = message; } });
const formatTime = value => new Intl.DateTimeFormat(undefined, {
  timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(new Date(value));
const selected = () => bookings.find(item => item.id === selectedId);
const pass = () => {
  const saved = passes.get(selectedId);
  return saved && saved.wallet === wallet && saved.session.expiresAt > Date.now() ? saved.session : null;
};
const available = () => {
  const b = selected();
  const observed = audioStates.get(selectedId);
  const allocated = performerAllocationAccess(b, observed?.state, Date.now(), observed?.at || 0);
  return b && (b.status === 'funded' || allocated) && b.acknowledged && !b.cancelled &&
    (allocated || Date.now() >= Date.parse(b.startUtc) - 70 * 60000 && Date.now() < Date.parse(b.endUtc)) &&
    bookingsAt > 0 && Date.now() - bookingsAt <= 12000;
};
function controls() {
  const authorized = !!pass();
  el('desk-authorize').disabled = busy || !available() || authorized;
  el('desk-listen').disabled = busy || !available() || !authorized || !privateState;
}
function publicProgram() {
  const live = radioState?.liveAudio;
  const fresh = radioAt > 0 && Date.now() - radioAt <= 12000;
  el('desk-program').textContent = !fresh ? 'Public program unavailable or stale. Selected room is not proof of what is on air.'
    : live?.configured && live.phase === 'live' && live.armed && live.status === 'ON-AIR' && live.policy?.mode === 'live' && live.bookingVerification?.fresh === true
      ? `Public live act: ${live.performer?.artist || live.policy?.title || 'Booked performer'} · ${live.bookingId}`
      : live?.phase === 'live' ? 'Public live verification is unavailable / reconnecting. Selecting a private room does not confirm the public act.'
      : `Public program: ${radioState.activeShow?.title || radioState.activeShow?.label || 'No verified live act'}. No live act is confirmed here.`;
  const next = bookings.find(item => item.status === 'funded' && item.acknowledged && Date.parse(item.startUtc) > Date.now());
  el('desk-next').textContent = !bookingsAt || Date.now() - bookingsAt > 12000
    ? 'Next booked act unavailable; refresh the schedule.'
    : next ? `Scheduled next: ${next.displayName || next.title} · ${formatTime(next.startUtc)} New York. Schedule only—not a take-live instruction.`
      : 'No upcoming funded act in the current schedule.';
}
function invalidate(message) {
  passes.delete(selectedId);
  privateState = null;
  direction?.setSession(null);
  broadcastControls?.update(null);
  void listener.disconnect();
  el('desk-auth-status').textContent = message;
  controls();
}
async function selectBooking(id) {
  ++generation;
  busy = false;
  direction?.dispose();
  broadcastControls?.dispose();
  privateState = null;
  selectedId = id;
  const current = generation;
  const b = selected();
  el('desk-booking').value = id;
  el('desk-selected').textContent = b ? `Private room: ${b.displayName || b.title}` : 'Select a private room';
  el('desk-schedule').textContent = b
    ? `${formatTime(b.startUtc)} – ${formatTime(b.endUtc)} New York · ${b.status}. Backstage opens 70 minutes before the booked start.`
    : '';
  el('desk-full-room').hidden = !b;
  if (b) el('desk-full-room').href = `live-room.html?booking=${encodeURIComponent(b.id)}`;
  direction = bindTogether(bindLiveDirection({
    container: el('desk-direction'), serviceUrl, bookingId: id,
    onSessionExpired: reason => {
      if (current === generation) invalidate(reason || 'Private pass expired or was revoked. Reconnect the owner wallet for this booking.');
    },
    onState: state => { if (current === generation) { privateState = state; controls(); } },
  }), bindTogether(bindLiveFeedbackRoom({ container: el('desk-listener-signals'), serviceUrl, bookingId: id }),
    safeBindProducerListenerTelemetry({ container: el('desk-listener-telemetry'), serviceUrl, bookingId: id })));
  direction.setSession(pass());
  broadcastControls = bindLiveBroadcastControls({
    container: el('desk-broadcast-controls'), serviceUrl, bookingId: id,
    getBooking: () => b, getSession: pass, getCandidates: () => bookings.filter(item => item.id !== id && !item.cancelled),
    getNextPass: target => ownerPass(target),
    onOpenNext: target => { void selectBooking(target); },
    onReconnect: async () => {
      const authorized = await ownerPass(id, true);
      if (current !== generation) throw new Error('Selected room changed; reconnect that booking.');
      direction.setSession(authorized);
      controls();
      return authorized;
    },
    onState: state => {
      if (current !== generation) return;
      audioStates.set(id, { state, at: Date.now() });
      controls();
    },
  });
  if (pass()) broadcastControls.update(pass().state);
  el('desk-auth-status').textContent = pass()
    ? 'Using this booking’s unexpired owner pass, held only in this tab’s memory.'
    : 'Private controls require the configured owner wallet and a signature for this selected booking.';
  controls();
  await listener.disconnect();
  if (current === generation && b) void refreshSelectedAudio(id, current);
}
async function refreshSelectedAudio(id = selectedId, current = generation) {
  if (!id || !serviceUrl) return;
  try {
    const response = await fetch(`${serviceUrl}/api/live-audio/state?bookingId=${encodeURIComponent(id)}`, {
      cache: 'no-store', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return;
    const state = await response.json();
    if (disposed || current !== generation || id !== selectedId || state.bookingId !== id) return;
    audioStates.set(id, { state, at: Date.now() });
    if (!pass()) broadcastControls?.update(state);
    controls();
  } catch { /* Private admission remains disabled when no fresh allocated state is available. */ }
}
async function ownerPass(id, force = false) {
  const current = generation, cached = passes.get(id);
  const valid = () => !disposed && current === generation;
  if (!force && cached?.wallet === wallet && cached.session.expiresAt > Date.now()) {
    const state = await roomRequest(serviceUrl, 'control', { action: 'state' }, cached.session.token);
    if (!valid() || passes.get(id) !== cached || state.bookingId !== id) throw new Error('Booking access changed; retry authorization.');
    cached.session = { ...cached.session, state };
    el('desk-auth-status').textContent = `Owner pass verified for booking ${id}. The selected private room remains ${selectedId}.`;
    return cached.session;
  }
  if (!window.ethereum) throw new Error('Open this desk in a browser with your owner wallet available.');
  el('desk-auth-status').textContent = `Authorize booking ${id} with the configured owner wallet. No payment or gas.`;
  requestingAccounts = true;
  let accounts;
  try { accounts = await window.ethereum.request({ method: 'eth_requestAccounts' }); }
  finally { requestingAccounts = false; }
  if (!valid()) throw new Error('Selected room changed; authorize it again.');
  const nextWallet = accounts[0]?.toLowerCase();
  if (!nextWallet) throw new Error('Select the configured owner wallet.');
  if (wallet && wallet !== nextWallet) {
    passes.clear();
    wallet = nextWallet;
    invalidate('Wallet changed. Reconnect the selected owner booking before authorizing another act.');
    throw new Error('Wallet changed; private access was cleared.');
  }
  wallet = nextWallet;
  const challenge = await roomRequest(serviceUrl, 'challenge', { bookingId: id, wallet });
  if (!valid()) throw new Error('Selected room changed; authorize it again.');
  const hex = `0x${Array.from(new TextEncoder().encode(challenge.message), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  const signature = await window.ethereum.request({ method: 'personal_sign', params: [hex, wallet] });
  if (!valid()) throw new Error('Selected room changed; authorize it again.');
  const session = await roomRequest(serviceUrl, 'session', { challengeId: challenge.challengeId, signature });
  if (!valid()) throw new Error('Selected room changed; authorize it again.');
  if (session.role !== 'owner' || session.state?.bookingId !== id || !(session.expiresAt > Date.now())) {
    throw new Error('The configured owner must authorize this exact booking.');
  }
  passes.set(id, { wallet, session });
  el('desk-auth-status').textContent = `Owner pass verified for booking ${id}. The selected private room remains ${selectedId}.`;
  return session;
}
async function refresh() {
  if (refreshing || disposed || !serviceUrl) return;
  refreshing = true;
  const results = await Promise.allSettled([
    fetch(`${serviceUrl}/api/live-bookings`, { cache: 'no-store', signal: AbortSignal.timeout(10000) }).then(async response => {
      if (!response.ok) throw new Error('Schedule unavailable');
      const value = await response.json();
      if (!Array.isArray(value.bookings)) throw new Error('Schedule unavailable');
      return value.bookings.filter(b => b?.id && b.mode === 'phase1' && b.payoutPolicy === 'pilot-guaranteed-v1' &&
        b.stewardApproved && !b.cancelled && Number.isFinite(Date.parse(b.startUtc)) && Date.parse(b.endUtc) > Date.now() - 86400000)
        .sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));
    }),
    readRadioState({ radioUrl: radioEndpoint(serviceUrl), signal: AbortSignal.timeout(10000) }),
  ]);
  if (disposed) return;
  if (results[0].status === 'fulfilled') {
    bookings = results[0].value;
    bookingsAt = Date.now();
    el('desk-booking').replaceChildren(new Option('Select a booked room', ''),
      ...bookings.map(b => new Option(`${b.displayName || b.title} · ${formatTime(b.startUtc)} · ${b.status}`, b.id)));
    el('desk-booking').disabled = !bookings.length;
    el('desk-roster-status').textContent = bookings.length
      ? 'Schedule refreshed. Private readiness and messages appear only after authorizing a selected booking.'
      : 'No eligible booked rooms are currently listed.';
    if (selectedId && !selected()) {
      passes.delete(selectedId);
      await selectBooking('');
    } else if (!selectedId && bookings.some(b => b.id === initialBookingId)) await selectBooking(initialBookingId);
    else el('desk-booking').value = selectedId;
  } else {
    bookingsAt = 0;
    el('desk-roster-status').textContent = 'Schedule unavailable. Last listed names are not proof of current eligibility.';
  }
  if (results[1].status === 'fulfilled') { radioState = results[1].value; radioAt = Date.now(); }
  else radioAt = 0;
  refreshing = false;
  publicProgram();
  controls();
  void refreshSelectedAudio();
}
el('desk-booking').addEventListener('change', () => { void selectBooking(el('desk-booking').value); });
el('desk-refresh').addEventListener('click', () => { void refresh(); });
el('desk-authorize').addEventListener('click', async () => {
  if (busy || !available()) return;
  const current = ++generation, id = selectedId;
  busy = true;
  passes.delete(id);
  direction.setSession(null);
  privateState = null;
  controls();
  const valid = () => !disposed && current === generation && selectedId === id;
  try {
    await listener.disconnect();
    await ownerPass(id, true);
    if (!valid()) return;
    // Rebind selection callbacks to this authorization generation.
    await selectBooking(id);
  } catch (error) {
    if (valid()) el('desk-auth-status').textContent = error.code === 4001 ? 'Wallet request declined. No private access opened.'
      : error.code === -32002 ? 'Finish the pending wallet request, then try again.' : error.message;
  } finally {
    if (valid()) busy = false;
    controls();
  }
});
el('desk-listen').addEventListener('click', async () => {
  if (busy || !available() || !pass()) return;
  const current = generation, session = pass();
  busy = true;
  controls();
  try { await listener.connect(session, selectedId); }
  catch (error) {
    if (current === generation) {
      if ([401, 403].includes(error.status)) invalidate('Private audio authorization ended. Reconnect the owner wallet.');
      el('desk-listen-status').textContent = error.message;
    }
  } finally { if (current === generation) { busy = false; controls(); } }
});
el('desk-stop').addEventListener('click', () => { void listener.disconnect(); });
window.ethereum?.on?.('accountsChanged', () => {
  if (requestingAccounts) return;
  ++generation;
  passes.clear();
  wallet = null;
  busy = false;
  invalidate('Wallet changed. All private passes and messages were cleared; reconnect for the selected booking.');
});
const timers = [
  setInterval(() => { void refresh(); }, 10000),
  setInterval(() => {
    for (const [id, saved] of passes) {
      if (saved.session.expiresAt <= Date.now()) {
        passes.delete(id);
        if (id === selectedId) invalidate('Private pass expired. Reconnect the owner wallet for this booking.');
      }
    }
    const observed = audioStates.get(selectedId);
    if (pass() && selected() && Date.parse(selected().endUtc) <= Date.now() &&
        observed?.state?.broadcast?.phase === 'ended') invalidate('This allocated broadcast ended. Private listening and direction are closed.');
    publicProgram();
    controls();
  }, 1000),
];
window.addEventListener('pagehide', () => {
  disposed = true;
  ++generation;
  timers.forEach(clearInterval);
  passes.clear();
  direction?.dispose();
  broadcastControls?.dispose();
  void listener.disconnect();
});
if (!serviceUrl) el('desk-auth-status').textContent = 'Live audio hosting is not configured.';
else void refresh();
