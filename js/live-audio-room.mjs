import { loadLiveAudioSdk, roomRequest } from './live-audio-client.mjs?v=20261113-recording';
import { liveRecordingConsentMessage } from './live-recording-consent.mjs?v=20261113-recording';
import { bindLiveRecordingOption } from './live-recording-option.mjs?v=20261113-recording';
import { performerRoomSign } from './performer-room.mjs?v=20261110-wallet-practice';
import { bindInputMonitor } from './input-monitor.mjs?v=20261110-studio-monitor';
import { createInputMeter } from './input-meter.mjs?v=20261110-studio-monitor';

const byId = id => document.getElementById(id);
const bookingId = new URL(location.href).searchParams.get('booking') || '';
const serviceUrl = String(window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
const audio = byId('room-audio');
let session, wallet, room, localTrack, remoteTrack, polling = false, disposed = false;
let authGeneration = 0, connectionGeneration = 0, requestingAccounts = false;
let booking, broadcastState, observedAt = 0, refreshing = false, practiceMode = false;
const meter = createInputMeter({
  level: byId('room-mic-level'), state: byId('room-mic-state'), note: byId('room-meter-note'),
});
const headphones = bindInputMonitor({
  toggle: byId('room-monitor-toggle'), volume: byId('room-monitor-volume'), status: byId('room-monitor-status'),
  getTrack: () => localTrack,
});
const status = message => { byId('room-status').textContent = message; };
const command = input => roomRequest(serviceUrl, 'control', input, session?.token);
const recordingOption = bindLiveRecordingOption({
  container: byId('room-recording-option'), toggle: byId('room-recording-consent'), output: byId('room-recording-status'),
  savePermission: async enabled => {
    const authorization = session, performer = wallet;
    if (!authorization || !performer || !window.ethereum || !booking) throw new Error('Connect your performer wallet before choosing recording.');
    const issuedAt = Date.now();
    const message = liveRecordingConsentMessage({ bookingId, wallet: performer, origin: location.origin, issuedAt, enabled });
    const hex = `0x${Array.from(new TextEncoder().encode(message), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    const signature = await window.ethereum.request({ method: 'personal_sign', params: [hex, performer] });
    if (session !== authorization || wallet !== performer || disposed) throw new Error('Wallet changed; recording permission was not saved.');
    const state = await roomRequest(serviceUrl, 'control', {
      action: 'recording-consent', enabled, issuedAt, signature,
    }, authorization.token);
    if (session !== authorization || wallet !== performer || disposed) throw new Error('Reconnect your performer wallet to check recording permission.');
    render(state);
    return { consented: state.recording?.consented, message: recordingMessage(state.recording) };
  },
});
function recordingMessage(recording) {
  if (recording?.error) return `Recording needs attention: ${recording.error}`;
  if (recording?.status === 'submitted') return 'Your recording is ready for admin minting.';
  if (['finalizing', 'uploading', 'processing'].includes(recording?.status)) return 'Preparing your live recording for admin minting...';
  if (recording?.status === 'recording') return 'Recording your live set. Soundchecks stay private.';
  return recording?.consented ? 'Your live set will be recorded. Soundchecks stay private.' : 'Recording is off.';
}
function renderRecording(state) {
  recordingOption.update({
    available: !!session && wallet?.toLowerCase() === booking?.wallet?.toLowerCase() && state?.recording?.available === true,
    canChange: state?.recording?.canChange === true,
    consented: state?.recording?.consented === true,
    message: recordingMessage(state?.recording),
  });
}
const perform = fn => async () => {
  try { await fn(); } catch (error) {
    status(error.code === -32002
      ? 'MetaMask already has a pending request. Open the extension and finish or reject it, then try again.'
      : error.code === 4001 ? 'Wallet request declined. Connect booking wallet again when you are ready.'
        : error.message || 'Live audio is unavailable');
  }
};

async function disconnect() {
  ++connectionGeneration;
  localTrack?.stop(); localTrack = null;
  await headphones.stop();
  await meter.stop();
  remoteTrack?.detach(audio); remoteTrack = null; audio.pause(); audio.srcObject = null;
  const previous = room; room = null;
  await previous?.disconnect().catch(() => {});
}
async function connect(publish) {
  await disconnect();
  const generation = connectionGeneration, authorization = session;
  const current = () => generation === connectionGeneration && authorization === session && !disposed;
  const sdk = await loadLiveAudioSdk(serviceUrl);
  if (!current()) return;
  const grant = await command({ action: 'connect', publish });
  if (!current()) return;
  const next = new sdk.Room({ adaptiveStream: false, dynacast: false });
  room = next;
  const subscribe = (publication, participant) => {
    if (participant.identity === grant.publisherIdentity && publication.kind === sdk.Track.Kind.Audio) publication.setSubscribed(true);
  };
  next.on(sdk.RoomEvent.TrackPublished, subscribe);
  next.on(sdk.RoomEvent.TrackSubscribed, (track, _publication, participant) => {
    if (room !== next || participant.identity !== grant.publisherIdentity || track.kind !== sdk.Track.Kind.Audio) return;
    remoteTrack?.detach(audio); remoteTrack = track; track.attach(audio);
    void audio.play().catch(() => status('Tap the audio Play control to hear the private feed'));
  });
  next.on(sdk.RoomEvent.Disconnected, () => {
    if (room === next) {
      room = null; localTrack?.stop(); localTrack = null;
      void headphones.stop();
      void meter.stop();
      status('RECONNECTING — reconnect this input; the live 60-second deadline still applies');
    }
  });
  try {
    await next.connect(grant.url, grant.token, { autoSubscribe: false });
    if (!current()) { await next.disconnect(); return; }
    if (publish) {
      const capture = await sdk.createLocalAudioTrack({
        deviceId: byId('room-input').value || undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      });
      if (!current()) { capture.stop(); await next.disconnect(); return; }
      localTrack = capture;
      meter.start(sdk, capture);
      await next.localParticipant.publishTrack(capture, { source: sdk.Track.Source.Microphone,
        dtx: false, red: true, audioPreset: { maxBitrate: 128000 }, forceStereo: true });
      if (!current()) { capture.stop(); await next.disconnect(); return; }
      status('Browser audio published privately. Public radio opens only after the owner arms the scheduled slot.');
    } else {
      for (const participant of next.remoteParticipants.values()) {
        for (const publication of participant.trackPublications.values()) subscribe(publication, participant);
      }
      await next.startAudio();
    }
  } catch (error) {
    if (current()) await disconnect();
    else await next.disconnect().catch(() => {});
    throw error;
  }
}
function render(state) {
  broadcastState = state; observedAt = Date.now(); renderSign();
  renderRecording(state);
  const fresh = state.privateAudioFresh ? 'Worker receiver verifies fresh delivered audio' : 'No fresh delivery verified';
  status(`${state.status} · ${state.phase} · ${fresh}\n${state.reason || 'Soundchecks are private until the armed slot starts.'}`);
  if (state.targets) byId('room-targets').textContent = `T−60: ${new Date(state.targets.t60).toLocaleString()} · T−15: ${new Date(state.targets.t15).toLocaleString()} · Checks: ${state.checks?.t60 ? 'T−60 passed' : 'T−60 pending'}, ${state.checks?.t15 ? 'T−15 passed' : 'T−15 pending'}`;
  byId('room-obs').disabled = !state.ingressEnabled;
  byId('room-arm').disabled = !state.checks?.t60 || !state.checks?.t15 || state.armed;
  if (['cancelled', 'ended', 'unavailable'].includes(state.phase)) {
    byId('room-obs-secret').textContent = '';
    void disconnect();
  }
}
function renderSign() {
    const sign = performerRoomSign(booking, broadcastState, Date.now(), observedAt);
    byId('room-on-air').textContent = sign.label;
    byId('room-on-air').classList.toggle('is-live', sign.live);
    byId('room-countdown').textContent = sign.detail;
    const practice = booking && !booking.cancelled && ['draft', 'funded'].includes(booking.status) &&
      Date.now() < Date.parse(booking.startUtc) - 70 * 60_000;
    byId('room-practice').hidden = !practice;
    byId('room-backstage').hidden = !!practice;
    byId('room-helper').hidden = !!practice;
    if (practice && !practiceMode) {
      const url = new URL('rehearsal.html', location.href);
      url.searchParams.set('booking', bookingId);
      byId('room-practice-direct').href = url.href;
      byId('room-practice-frame').src = url.href;
    } else if (!practice && practiceMode) {
      byId('room-practice-frame').removeAttribute('src');
    }
    practiceMode = !!practice;
  }
async function refreshBooking() {
    if (refreshing || disposed || !bookingId || !serviceUrl) return;
    refreshing = true;
    try {
      const response = await fetch(`${serviceUrl}/api/live-bookings`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Booking unavailable');
      const state = await response.json();
      const selected = state.bookings?.find(item => item.id === bookingId);
      if (!selected || selected.mode !== 'phase1' || selected.payoutPolicy !== 'pilot-guaranteed-v1' || !selected.stewardApproved) {
        throw new Error('Open the room from your performance invitation');
      }
      booking = selected;
      byId('room-welcome').textContent = `${booking.displayName || 'Your'} · your Decent stage`;
      renderSign();
      if (practiceMode) return;
      if (booking.status !== 'funded' || !booking.acknowledged || booking.cancelled || Date.parse(booking.endUtc) <= Date.now()) {
        byId('room-authorize').disabled = true;
        if (session) { session = null; byId('room-controls').hidden = true; await disconnect(); }
        status('Backstage opens after acceptance and confirmed escrow funding, from 70 minutes before your set.');
        return;
      }
      const liveResponse = await fetch(`${serviceUrl}/api/live-audio/state?bookingId=${encodeURIComponent(bookingId)}`, {
        cache: 'no-store', signal: AbortSignal.timeout(10000) });
      const liveState = await liveResponse.json();
      if (!liveResponse.ok || !liveState.configured) throw new Error(liveState.error || 'Live audio hosting unavailable');
      broadcastState = liveState; observedAt = Date.now(); renderSign();
      byId('room-authorize').disabled = false;
      if (!session) status('Backstage is ready. Connect your invited wallet to soundcheck.');
    } catch (error) {
      broadcastState = null; observedAt = 0;
      byId('room-authorize').disabled = true;
      status(error.message || 'Room unavailable; retry shortly.');
      renderSign();
    } finally { refreshing = false; }
}
byId('room-authorize').onclick = perform(async () => {
  if (!window.ethereum) throw new Error('A browser wallet is needed for backstage access');
  status('Opening MetaMask... Unlock your operator or performer wallet and approve connecting this site.');
  const generation = ++authGeneration;
  const current = () => generation === authGeneration && !disposed;
  session = null; byId('room-controls').hidden = true; byId('room-obs-secret').textContent = '';
  renderRecording(null);
  await disconnect();
  let accounts;
  requestingAccounts = true;
  try { accounts = await window.ethereum.request({ method: 'eth_requestAccounts' }); }
  finally { requestingAccounts = false; }
  if (!current()) return;
  wallet = accounts[0];
  if (!wallet) throw new Error('No wallet connected. Unlock MetaMask and select your operator or performer wallet.');
  status('Checking your booking wallet...');
  const challenge = await roomRequest(serviceUrl, 'challenge', { bookingId, wallet });
  if (!current()) return;
  const hex = `0x${Array.from(new TextEncoder().encode(challenge.message), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  status('Confirm the backstage access signature in MetaMask. No transaction or gas.');
  const signature = await window.ethereum.request({ method: 'personal_sign', params: [hex, wallet] });
  if (!current()) return;
  const authorized = await roomRequest(serviceUrl, 'session', { challengeId: challenge.challengeId, signature });
  if (!current()) return;
  session = authorized;
  byId('room-controls').hidden = false;
  byId('room-publisher').hidden = !(session.canPublish ?? session.role === 'publisher');
  byId('room-owner').hidden = session.role !== 'owner';
  render(session.state);
});
byId('room-devices').onclick = perform(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  stream.getTracks().forEach(track => track.stop());
  const devices = await navigator.mediaDevices.enumerateDevices();
  byId('room-input').replaceChildren(new Option('Default audio input', ''),
    ...devices.filter(device => device.kind === 'audioinput').map(device => new Option(device.label || 'Audio input', device.deviceId)));
});
byId('room-publish').onclick = perform(() => connect(true));
byId('room-monitor').onclick = perform(() => connect(false));
byId('room-stop').onclick = perform(async () => { await disconnect(); status('Microphone stopped. During a live slot, 60 seconds without audio cancels the broadcast.'); });
byId('room-obs').onclick = perform(async () => {
  const authorization = session;
  await disconnect();
  const result = await command({ action: 'obs' });
  if (!authorization || session !== authorization || disposed) return;
  byId('room-obs-secret').textContent = `WHIP server: ${result.whipEndpoint}\n${result.notice}`;
});
for (const [id, check] of [['room-check60', 't60'], ['room-check15', 't15']]) {
  byId(id).onclick = perform(async () => {
    if (!remoteTrack || audio.paused) throw new Error('Listen to the private feed before confirming');
    render(await command({ action: 'check', check, confirmed: true }));
  });
}
byId('room-arm').onclick = perform(async () => render(await command({ action: 'arm' })));
byId('room-cancel').onclick = perform(async () => {
  if (!window.confirm('Cancel this live broadcast? The guaranteed performer fee remains unchanged.')) return;
  render(await command({ action: 'cancel', confirmed: true }));
});
async function poll() {
  if (!session || polling || disposed) return;
  polling = true;
  const authorization = session;
  try { const state = await command({ action: 'state' }); if (session === authorization) render(state); }
  catch {
    if (session !== authorization || disposed) return;
    try {
      const response = await fetch(`${serviceUrl}/api/live-audio/state?bookingId=${encodeURIComponent(bookingId)}`, {
        cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error();
      const state = await response.json();
      if (!['cancelled', 'ended', 'unavailable'].includes(state.phase)) throw new Error();
      render(state); session = null;
    } catch { status('Room authorization/control unavailable — reconnect the booking wallet'); }
  }
  finally { polling = false; }
}
window.ethereum?.on?.('accountsChanged', () => {
  if (requestingAccounts) return;
  ++authGeneration;
  session = null; byId('room-controls').hidden = true; byId('room-obs-secret').textContent = '';
  renderRecording(null);
  void disconnect(); status('Wallet changed; authorize this booking again');
});
window.addEventListener('pagehide', () => { disposed = true; ++authGeneration; session = null; void disconnect(); });
setInterval(() => { void poll(); }, 2000);
setInterval(renderSign, 1000);
setInterval(() => { void refreshBooking(); }, 10000);
if (!bookingId || !serviceUrl) status('Live audio unavailable: open the funded booking link and configure the radio worker first.');
else void refreshBooking();
