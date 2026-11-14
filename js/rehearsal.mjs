import { loadLiveAudioSdk } from './live-audio-client.mjs';
import { bindInputMonitor } from './input-monitor.mjs?v=20261110-studio-monitor';
import { createInputMeter } from './input-meter.mjs?v=20261110-studio-monitor';

const el = id => document.getElementById(id);
const service = String(window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
const initialId = new URL(location.href).searchParams.get('rehearsal') || '';
const practiceBookingId = new URL(location.href).searchParams.get('booking') || '';
const audio = el('audio');
let session, room, localTrack, remoteTrack, generation = 0, disposed = false, polling = false, deadlineTimer;
let busy = false, requestingAccounts = false;
const meter = createInputMeter({ level: el('mic-level'), state: el('mic-state'), note: el('meter-note') });
const headphones = bindInputMonitor({
  toggle: el('monitor-toggle'), volume: el('monitor-volume'), status: el('monitor-status'),
  getTrack: () => localTrack,
});
const status = (text, error = false) => {
  el('status').textContent = text;
  el('status').dataset.error = String(error);
};
function renderControls() {
  el('join').hidden = !!session || !initialId && !practiceBookingId;
  el('create').hidden = !!session || !!practiceBookingId;
  for (const id of ['create-room', 'join-room', 'devices', 'publish', 'listen', 'end']) el(id).disabled = busy;
  el('input').disabled = busy || !!localTrack;
  el('publish').disabled = busy || !!localTrack;
  el('publish').textContent = localTrack ? 'Microphone is on' : 'Start my microphone';
  el('leave').disabled = busy || !room;
  el('mic-state').textContent = localTrack ? 'Microphone on' : 'Microphone off';
  el('next-step').textContent = localTrack
    ? 'Try a few notes. Watch your input level and the delivery check.'
    : 'Choose your input, then start your microphone.';
}
function renderDelivery(fresh = false) {
  const text = session?.role === 'owner'
    ? fresh ? 'Artist connection: audio is reaching the room.' : 'Artist connection: waiting for their microphone.'
    : !localTrack ? 'Delivery check: start your microphone first.'
      : fresh ? '✓ Your audio is reaching the room. You can practise now.'
        : 'Connecting your audio… If this continues, stop audio and try again.';
  el('delivery').textContent = text;
  el('delivery').dataset.fresh = String(fresh && !!session && (session.role === 'owner' || !!localTrack));
}
async function request(path, input, token, keepalive = false) {
  const timeout = path === 'session' || path === 'challenge' || input.action === 'end' ? 60000 : 10000;
  const response = await fetch(`${service}/api/private-rehearsal/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(input), cache: 'no-store', keepalive, signal: AbortSignal.timeout(timeout),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Private rehearsal unavailable');
  return data;
}
const action = fn => async () => {
  if (busy) return;
  busy = true; renderControls();
  try { await fn(); } catch (error) {
    const message = error.code === -32002
      ? 'MetaMask already has a pending request. Open the MetaMask extension and finish or reject it, then try again.'
      : error.code === 4001 ? 'Wallet request declined. Click Sign consent and enter when you are ready.'
      : error.name === 'NotAllowedError'
      ? 'Microphone blocked. Allow microphone access in your browser site settings, then try Start my microphone again.'
      : error.name === 'NotFoundError' ? 'No microphone found. Connect your microphone or audio interface, then find inputs again.'
        : error.message || 'Private rehearsal unavailable';
    status(message, true);
  } finally { busy = false; renderControls(); }
};
async function disconnect(notify = false) {
  ++generation;
  const authorization = session;
  const previous = room; room = null;
  localTrack?.stop(); localTrack = null;
  await headphones.stop();
  await meter.stop();
  remoteTrack?.detach(audio); remoteTrack = null; audio.pause(); audio.srcObject = null;
  await previous?.disconnect().catch(() => {});
  renderControls(); renderDelivery();
  if (notify && authorization) await request('control', { action: 'leave' }, authorization.token);
}
async function authorize(input) {
  if (!window.ethereum) throw new Error('MetaMask is unavailable in this room. Open the private practice room in its own tab, unlock MetaMask, and reload.');
  status('Opening MetaMask... Unlock your wallet and approve connecting this site.');
  const current = ++generation;
  const previousToken = session?.token; session = null;
  el('controls').hidden = true; clearTimeout(deadlineTimer);
  await disconnect();
  const gen = generation;
  if (current + 1 !== gen || disposed) return;
  if (previousToken) await request('control', { action: 'leave' }, previousToken).catch(() => {});
  if (gen !== generation || disposed) return;
  let accounts;
  requestingAccounts = true;
  try { accounts = await window.ethereum.request({ method: 'eth_requestAccounts' }); }
  finally { requestingAccounts = false; }
  if (gen !== generation || disposed || current + 1 !== gen) return;
  const wallet = accounts[0];
  if (!wallet) throw new Error('No wallet connected. Unlock MetaMask and select your invited or operator wallet.');
  status('Checking your wallet invitation...');
  const challenge = await request('challenge', { ...input, wallet });
  if (gen !== generation || disposed) return;
  const hex = `0x${Array.from(new TextEncoder().encode(challenge.message), b => b.toString(16).padStart(2, '0')).join('')}`;
  status('Confirm the private-room signature in MetaMask. No transaction or gas.');
  const signature = await window.ethereum.request({ method: 'personal_sign', params: [hex, wallet] });
  if (gen !== generation || disposed) return;
  status('Verifying your signature and opening the private room...');
  const authorized = await request('session', { challengeId: challenge.challengeId, signature });
  if (gen !== generation || disposed) return;
  session = authorized;
  renderControls(); renderDelivery();
  const link = new URL('rehearsal.html', location.href);
  link.searchParams.set('rehearsal', authorized.state.id);
  el('invitation').textContent = authorized.role === 'owner' ? `Share this private invitation with the selected guest: ${link.href}` : 'Consent signed. This rehearsal is private.';
  el('deadline').textContent = `Sign in again after ${new Date(authorized.expiresAt).toLocaleTimeString()}. Room closes ${new Date(authorized.state.expiresAt).toLocaleString()}.`;
  el('end').hidden = authorized.role !== 'owner'; el('controls').hidden = false;
  deadlineTimer = setTimeout(() => {
    const token = session?.token; session = null; el('controls').hidden = true;
    if (token) void request('control', { action: 'leave' }, token).catch(() => {});
    void disconnect();
    renderControls();
    status('Your private session has ended; microphone stopped. Sign in again to keep practising.');
  }, Math.max(0, Math.min(authorized.expiresAt, authorized.state.expiresAt) - Date.now()));
  status("You're in. Next: Start my microphone, then allow your browser to use it.");
}
async function connect(publish) {
  await disconnect();
  const current = generation, authorization = session;
  if (!authorization) throw new Error('Sign consent first');
  const valid = () => current === generation && session === authorization && !disposed;
  status(publish ? 'Opening your microphone… Allow access if your browser asks.' : 'Connecting to the other person…');
  const sdk = await loadLiveAudioSdk(service);
  if (!valid()) return;
  const grant = await request('control', { action: 'connect', publish }, authorization.token);
  if (!valid()) return;
  const next = new sdk.Room({ adaptiveStream: false, dynacast: false }); room = next;
  const subscribe = (publication, participant) => {
    if (participant.identity === grant.otherIdentity && publication.kind === sdk.Track.Kind.Audio) publication.setSubscribed(true);
  };
  next.on(sdk.RoomEvent.TrackPublished, subscribe);
  next.on(sdk.RoomEvent.TrackSubscribed, (track, _publication, participant) => {
    if (room !== next || participant.identity !== grant.otherIdentity || track.kind !== sdk.Track.Kind.Audio) return;
    remoteTrack?.detach(audio); remoteTrack = track; track.attach(audio);
    void audio.play().catch(() => status('Tap Play to hear the private feed.'));
  });
  next.on(sdk.RoomEvent.TrackUnsubscribed, track => {
    if (track === remoteTrack) { track.detach(audio); remoteTrack = null; }
  });
  next.on(sdk.RoomEvent.Disconnected, () => {
    if (room === next) {
      room = null; localTrack?.stop(); localTrack = null;
      void headphones.stop();
      void meter.stop(); renderControls(); renderDelivery();
      void request('control', { action: 'leave' }, authorization.token).catch(() => {});
      status('Audio disconnected. Reconnect or leave the room.');
    }
  });
  try {
    await next.connect(grant.url, grant.token, { autoSubscribe: false });
    if (!valid()) { await next.disconnect(); return; }
    for (const participant of next.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) subscribe(publication, participant);
    }
    if (publish) {
      const capture = await sdk.createLocalAudioTrack({ deviceId: el('input').value || undefined,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false });
      if (!valid()) { capture.stop(); await next.disconnect(); return; }
      localTrack = capture;
      meter.start(sdk, capture);
      await next.localParticipant.publishTrack(capture, { source: sdk.Track.Source.Microphone,
        dtx: false, red: true, audioPreset: { maxBitrate: 128000 }, forceStereo: true });
    }
    if (!valid()) { await next.disconnect(); return; }
    await next.startAudio();
    renderControls(); renderDelivery();
    status(publish ? 'Microphone on. Watch your input meter and the delivery check below.'
      : 'Listening privately. Your microphone is off; alone in the room, you will hear silence.');
  } catch (error) {
    if (valid()) await disconnect(); else await next.disconnect().catch(() => {});
    throw error;
  }
}
el('create-room').onclick = action(() => authorize({ action: 'create', guest: el('guest').value.trim(), minutes: Number(el('minutes').value) }));
el('join-room').onclick = action(() => authorize(practiceBookingId
  ? { action: 'practice', bookingId: practiceBookingId } : { action: 'join', id: initialId }));
el('devices').onclick = action(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  stream.getTracks().forEach(track => track.stop());
  const devices = await navigator.mediaDevices.enumerateDevices();
  el('input').replaceChildren(new Option('Default audio input', ''),
    ...devices.filter(d => d.kind === 'audioinput').map(d => new Option(d.label || 'Audio input', d.deviceId)));
  status(localTrack ? 'Inputs found. Stop audio before changing your input.' : 'Inputs found. Choose yours, then Start my microphone.');
});
el('publish').onclick = action(() => connect(true));
el('listen').onclick = action(() => connect(false));
el('leave').onclick = action(async () => {
  await disconnect(true);
  status('Microphone off. To try again, choose Start my microphone.');
});
el('end').onclick = action(async () => {
  if (!window.confirm('End this private rehearsal for everyone?')) return;
  await request('control', { action: 'end', confirmed: true }, session?.token);
  session = null; clearTimeout(deadlineTimer); el('controls').hidden = true; await disconnect(); status('Rehearsal ended.');
});
async function poll() {
  if (!session || polling || disposed) return;
  polling = true; const authorization = session;
  try {
    const state = await request('control', { action: 'state' }, authorization.token);
    if (session === authorization) renderDelivery(state.privateAudioFresh);
  } catch {
    if (session === authorization) {
      session = null; clearTimeout(deadlineTimer); el('controls').hidden = true; await disconnect();
      status('Connection lost or session ended; microphone stopped. Sign in again to retry.', true);
    }
  } finally { polling = false; }
}
window.ethereum?.on?.('accountsChanged', () => {
  if (requestingAccounts) return;
  const token = session?.token; session = null; clearTimeout(deadlineTimer); el('controls').hidden = true;
  if (token) void request('control', { action: 'leave' }, token).catch(() => {});
  void disconnect(); status('Wallet changed; sign consent again.');
});
window.addEventListener('pagehide', () => {
  disposed = true; const token = session?.token; session = null; clearTimeout(deadlineTimer);
  if (token) void request('control', { action: 'leave' }, token, true).catch(() => {});
  void disconnect();
});
setInterval(() => { void poll(); }, 2000);
el('join').hidden = !initialId && !practiceBookingId;
if (practiceBookingId) {
  el('create').hidden = true;
  el('join').querySelector('h2').textContent = '1 · Your private practice stage';
  document.querySelector('h1').textContent = 'Make yourself at home';
  el('rehearsal-intro').textContent = 'Your mic, your music, no pressure. Try things out before Friday.';
}
if (!service) status('Private rehearsal unavailable: configure the worker first.');
else {
  try {
    const response = await fetch(`${service}/api/private-rehearsal/status`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    const state = await response.json();
    if (!response.ok || !state.configured) throw new Error('Private rehearsal hosting is not enabled.');
    el('create-room').disabled = false; el('join-room').disabled = false;
    status('Private rehearsal is available. Signing does not send a transaction.');
  } catch (error) { status(error.message || 'Private rehearsal unavailable.'); }
}
