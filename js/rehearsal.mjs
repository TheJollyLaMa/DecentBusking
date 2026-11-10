import { loadLiveAudioSdk } from './live-audio-client.mjs';

const el = id => document.getElementById(id);
const service = String(window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
const initialId = new URL(location.href).searchParams.get('rehearsal') || '';
const practiceBookingId = new URL(location.href).searchParams.get('booking') || '';
const audio = el('audio');
let session, room, localTrack, remoteTrack, generation = 0, disposed = false, polling = false, deadlineTimer;
const status = text => { el('status').textContent = text; };
async function request(path, input, token, keepalive = false) {
  const response = await fetch(`${service}/api/private-rehearsal/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(input), cache: 'no-store', keepalive, signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Private rehearsal unavailable');
  return data;
}
const action = fn => async () => { try { await fn(); } catch (error) { status(error.message || 'Private rehearsal unavailable'); } };
async function disconnect(notify = false) {
  ++generation;
  const previous = room; room = null;
  localTrack?.stop(); localTrack = null;
  remoteTrack?.detach(audio); remoteTrack = null; audio.pause(); audio.srcObject = null;
  await previous?.disconnect().catch(() => {});
  if (notify && session) await request('control', { action: 'leave' }, session.token).catch(() => {});
}
async function authorize(input) {
  if (!window.ethereum) throw new Error('A browser wallet is required');
  const current = ++generation;
  const previousToken = session?.token; session = null;
  el('controls').hidden = true; clearTimeout(deadlineTimer);
  await disconnect();
  const gen = generation;
  if (current + 1 !== gen || disposed) return;
  if (previousToken) await request('control', { action: 'leave' }, previousToken).catch(() => {});
  if (gen !== generation || disposed) return;
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  if (gen !== generation || disposed || current + 1 !== gen) return;
  const wallet = accounts[0];
  const challenge = await request('challenge', { ...input, wallet });
  if (gen !== generation || disposed) return;
  const hex = `0x${Array.from(new TextEncoder().encode(challenge.message), b => b.toString(16).padStart(2, '0')).join('')}`;
  const signature = await window.ethereum.request({ method: 'personal_sign', params: [hex, wallet] });
  if (gen !== generation || disposed) return;
  const authorized = await request('session', { challengeId: challenge.challengeId, signature });
  if (gen !== generation || disposed) return;
  session = authorized;
  const link = new URL('rehearsal.html', location.href);
  link.searchParams.set('rehearsal', authorized.state.id);
  el('invitation').textContent = authorized.role === 'owner' ? `Share this private invitation with the selected guest: ${link.href}` : 'Consent signed. This rehearsal is private.';
  el('deadline').textContent = `Room deadline: ${new Date(authorized.state.expiresAt).toLocaleString()}. Wallet session ends: ${new Date(authorized.expiresAt).toLocaleString()}.`;
  el('end').hidden = authorized.role !== 'owner'; el('controls').hidden = false;
  deadlineTimer = setTimeout(() => {
    const token = session?.token; session = null; el('controls').hidden = true;
    if (token) void request('control', { action: 'leave' }, token).catch(() => {});
    void disconnect();
    status('Wallet session or room expired; audio stopped. Reauthorize if the room remains open.');
  }, Math.max(0, Math.min(authorized.expiresAt, authorized.state.expiresAt) - Date.now()));
  status('Consent signed. Choose publish or listen. Nothing is sent to public radio.');
}
async function connect(publish) {
  await disconnect();
  const current = generation, authorization = session;
  if (!authorization) throw new Error('Sign consent first');
  const valid = () => current === generation && session === authorization && !disposed;
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
      await next.localParticipant.publishTrack(capture, { source: sdk.Track.Source.Microphone,
        dtx: false, red: true, audioPreset: { maxBitrate: 128000 }, forceStereo: true });
    }
    if (!valid()) { await next.disconnect(); return; }
    await next.startAudio();
    status(publish ? 'Publishing and listening privately.' : 'Listening privately.');
  } catch (error) {
    if (valid()) await disconnect(true); else await next.disconnect().catch(() => {});
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
});
el('publish').onclick = action(() => connect(true));
el('listen').onclick = action(() => connect(false));
el('leave').onclick = action(async () => { await disconnect(true); status('Left private audio.'); });
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
    if (session === authorization) status(`${state.notice} · Guest receiver: ${state.privateAudioFresh ? 'fresh delivered audio' : 'no fresh delivery verified'}`);
  } catch {
    if (session === authorization) {
      session = null; clearTimeout(deadlineTimer); el('controls').hidden = true; await disconnect();
      status('Control unavailable or session ended; audio stopped.');
    }
  } finally { polling = false; }
}
window.ethereum?.on?.('accountsChanged', () => {
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
  el('join').querySelector('h2').textContent = 'Your private practice stage';
  document.querySelector('h1').textContent = 'Make yourself at home';
  document.querySelector('h1 + p').textContent = 'Try your microphone any day before backstage opens. Only your invited wallet and Jolly can enter. Private practice does not count as a Friday soundcheck.';
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
