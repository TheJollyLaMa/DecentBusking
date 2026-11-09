import { loadLiveAudioSdk, roomRequest } from './live-audio-client.mjs';

const byId = id => document.getElementById(id);
const bookingId = new URL(location.href).searchParams.get('booking') || '';
const serviceUrl = String(window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
const audio = byId('room-audio');
let session, wallet, room, localTrack, remoteTrack, polling = false, disposed = false;
let authGeneration = 0, connectionGeneration = 0;
const status = message => { byId('room-status').textContent = message; };
const command = input => roomRequest(serviceUrl, 'control', input, session?.token);
const perform = fn => async () => {
  try { await fn(); } catch (error) { status(error.message || 'Live audio is unavailable'); }
};

async function disconnect() {
  ++connectionGeneration;
  localTrack?.stop(); localTrack = null;
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
    if (room === next) { room = null; localTrack?.stop(); localTrack = null; status('RECONNECTING — reconnect this input; the live 60-second deadline still applies'); }
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
byId('room-authorize').onclick = perform(async () => {
  if (!window.ethereum) throw new Error('A browser wallet is needed for backstage access');
  const generation = ++authGeneration;
  const current = () => generation === authGeneration && !disposed;
  session = null; byId('room-controls').hidden = true; byId('room-obs-secret').textContent = '';
  await disconnect();
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  if (!current()) return;
  wallet = accounts[0];
  const challenge = await roomRequest(serviceUrl, 'challenge', { bookingId, wallet });
  if (!current()) return;
  const hex = `0x${Array.from(new TextEncoder().encode(challenge.message), byte => byte.toString(16).padStart(2, '0')).join('')}`;
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
  ++authGeneration;
  session = null; byId('room-controls').hidden = true; byId('room-obs-secret').textContent = '';
  void disconnect(); status('Wallet changed; authorize this booking again');
});
window.addEventListener('pagehide', () => { disposed = true; ++authGeneration; session = null; void disconnect(); });
setInterval(() => { void poll(); }, 2000);
if (!bookingId || !serviceUrl) status('Live audio unavailable: open the funded booking link and configure the radio worker first.');
else {
  try {
    const response = await fetch(`${serviceUrl}/api/live-audio/state?bookingId=${encodeURIComponent(bookingId)}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    const state = await response.json();
    if (!response.ok || !state.configured) throw new Error(state.error || state.reason || 'Live audio hosting is not configured');
    status('Room available. Only the booked performer and configured owner can enter backstage.');
    byId('room-authorize').disabled = false;
  } catch (error) { status(`Live audio unavailable: ${error.message || 'check hosting and retry'}`); }
}
