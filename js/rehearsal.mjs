import { loadLiveAudioSdk } from './live-audio-client.mjs';
import { bindInputMonitor } from './input-monitor.mjs?v=20261117-private-rooms';
import { bindBoothSetup } from './booth-setup.mjs?v=20261116-shared-room';
import { createInputMeter } from './input-meter.mjs?v=20261110-studio-monitor';

const el = id => document.getElementById(id);
const service = String(window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
const practiceBookingId = new URL(location.href).searchParams.get('booking') || '';
const embedded = new URL(location.href).searchParams.get('embedded') === '1' && !!window.parent && window.parent !== window;
let inviteRoomId = new URLSearchParams(new URL(location.href).hash.slice(1)).get('room') || '';
let preservePassOnHide = false;
const audio = el('audio');
let session, room, localTrack, generation = 0, disposed = false, polling = false, deadlineTimer;
let busy = false, requestingAccounts = false;
const remote = new Map();
const meter = createInputMeter({ level: el('mic-level'), state: el('mic-state'), note: el('meter-note') });
const headphones = bindInputMonitor({
  toggle: el('monitor-toggle'), volume: el('monitor-volume'), status: el('monitor-status'),
  mix: el('monitor-mix'),
  getTrack: () => localTrack,
  output: el('monitor-output'), outputDevices: el('monitor-output-devices'), outputStatus: el('monitor-output-status'), audio,
});
const booth = bindBoothSetup({
  mode: el('booth-mode'), radioOff: el('booth-radio-off'), status: el('booth-status'),
  monitorToggle: el('monitor-toggle'), onMonitorDisallowed: () => headphones.stop(),
  onChange: () => renderControls(),
  storage: (() => { try { return window.sessionStorage; } catch { return null; } })(), key: 'dbusk-booth-setup:rehearsal',
});
el('publish').disabled = !booth.ready();
const status = (text, error = false) => {
  el('status').textContent = text;
  el('status').dataset.error = String(error);
};
function renderControls() {
  el('join').hidden = !!session;
  for (const id of ['join-room', 'devices', 'publish', 'listen', 'end', 'remove']) el(id).disabled = busy;
  el('input').disabled = busy || !!localTrack;
  el('publish').disabled = busy || !!localTrack || !booth.ready();
  el('publish').textContent = localTrack ? 'Microphone is on' : 'Start my microphone';
  el('leave').disabled = busy || !room;
  el('mic-state').textContent = localTrack ? 'Microphone on' : 'Microphone off';
  el('next-step').textContent = localTrack
    ? 'Try a few notes. Watch your input level and the delivery check.'
    : booth.ready() ? 'Choose your input, then start your microphone.'
      : 'Set up your booth first: choose how you will hear yourself and turn the radio off.';
}
function renderDelivery(fresh = false) {
  const text = !localTrack ? 'Delivery check: start your microphone first.'
    : fresh ? '✓ Your audio is reaching the room. You can practise now.'
      : 'Connecting your audio… If this continues, stop audio and try again.';
  el('delivery').textContent = text;
  el('delivery').dataset.fresh = String(fresh && !!session && !!localTrack);
}
function renderPeople(state) {
  const list = state?.people || [];
  el('people').textContent = list.length
    ? list.map(p => `${p.you ? 'You' : p.label}${p.role === 'engineer' ? ' · engineer' : p.role === 'host' ? ' · host' : ''}${p.audioFresh ? ' · 🎙 sending' : p.connected ? ' · connected' : ' · signed in'}`).join('\n')
    : 'Nobody else is here yet.';
  const removable = list.filter(p => !p.you && p.role !== 'engineer');
  el('engineer-tools').hidden = !['engineer', 'host'].includes(session?.role);
  const chosen = el('remove-who').value;
  el('remove-who').replaceChildren(new Option('Choose someone…', ''), ...removable.map(p => new Option(p.label, p.wallet)));
  el('remove-who').value = removable.some(p => p.wallet === chosen) ? chosen : '';
}
function dropRemote(identity) {
  const entry = remote.get(identity);
  if (!entry) return;
  entry.track.detach(entry.element); entry.element.remove?.(); remote.delete(identity);
}
function syncOutputs() {
  for (const { element } of remote.values()) {
    if (audio.sinkId !== undefined && element.sinkId !== audio.sinkId) void element.setSinkId?.(audio.sinkId).catch(() => {});
  }
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
  for (const identity of [...remote.keys()]) dropRemote(identity);
  await previous?.disconnect().catch(() => {});
  renderControls(); renderDelivery();
  if (notify && authorization) await request('control', { action: 'leave' }, authorization.token);
}
async function authorize(input) {
  const headerSigner = embedded ? window.parent._wallet?.signer : null;
  if (embedded && !headerSigner) throw new Error('Connect your wallet in the page header first.');
  if (!headerSigner && !window.ethereum) throw new Error('Unlock a browser wallet to sign rehearsal consent.');
  status(headerSigner ? 'Using the connected header wallet…' : 'Opening MetaMask... Unlock your wallet and approve connecting this site.');
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
  try { accounts = headerSigner ? [await headerSigner.getAddress()] : await window.ethereum.request({ method: 'eth_requestAccounts' }); }
  finally { requestingAccounts = false; }
  if (gen !== generation || disposed || current + 1 !== gen) return;
  const wallet = accounts[0];
  if (!wallet) throw new Error('No wallet connected. Unlock MetaMask and choose a wallet.');
  status('Preparing your sign-in...');
  const challenge = await request('challenge', { ...input, ...(inviteRoomId ? { roomId: inviteRoomId } : {}), wallet });
  if (gen !== generation || disposed) return;
  const hex = `0x${Array.from(new TextEncoder().encode(challenge.message), b => b.toString(16).padStart(2, '0')).join('')}`;
  status('Confirm the rehearsal-room signature in MetaMask. No transaction or gas.');
  const signature = headerSigner ? await headerSigner.signMessage(challenge.message)
    : await window.ethereum.request({ method: 'personal_sign', params: [hex, wallet] });
  if (gen !== generation || disposed) return;
  status('Verifying your signature and opening the rehearsal room...');
  const authorized = await request('session', { challengeId: challenge.challengeId, signature });
  if (gen !== generation || disposed) return;
  session = authorized;
  renderControls(); renderDelivery(); renderPeople(authorized.state);
  const link = new URL('rehearsal.html', location.href);
  link.hash = new URLSearchParams({ room: authorized.state.id }).toString();
  inviteRoomId = authorized.state.id;
  history.replaceState(null, '', `${location.pathname}${location.search}${link.hash}`);
  if (el('invite-link')) el('invite-link').value = link.href;
  el('invitation').textContent = 'This link admits bandmates to this rehearsal only. Share it privately; anyone holding it can sign consent and join until the room closes.';
  if (embedded) window.parent.postMessage({ type: 'decentbusking:rehearsal-room', roomId: inviteRoomId }, location.origin);
  el('deadline').textContent = `This session closes by ${new Date(authorized.state.expiresAt).toLocaleString()}, or sooner when everyone leaves.`;
  el('end').hidden = !['engineer', 'host'].includes(authorized.role); el('controls').hidden = false;
  deadlineTimer = setTimeout(() => {
    session = null; el('controls').hidden = true;
    void disconnect();
    renderControls();
    status('This rehearsal session reached its time limit; microphone stopped. Sign in again to start a new one.');
  }, Math.max(0, authorized.state.expiresAt - Date.now()));
  status("You're in. Next: set up your booth, then Start my microphone.");
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
  const bandmate = identity => identity.startsWith('rehearsal:') && identity !== grant.identity;
  const subscribe = (publication, participant) => {
    if (bandmate(participant.identity) && publication.kind === sdk.Track.Kind.Audio) publication.setSubscribed(true);
  };
  next.on(sdk.RoomEvent.TrackPublished, subscribe);
  next.on(sdk.RoomEvent.TrackSubscribed, (track, _publication, participant) => {
    if (room !== next || !bandmate(participant.identity) || track.kind !== sdk.Track.Kind.Audio) return;
    dropRemote(participant.identity);
    const element = track.attach();
    el('remote-audio').append(element);
    remote.set(participant.identity, { track, element });
    syncOutputs();
    void element.play?.().catch(() => status('Tap Listen only to hear the rest of the room.'));
  });
  next.on(sdk.RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
    if (remote.get(participant.identity)?.track === track) dropRemote(participant.identity);
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
      : 'Listening to the room. Your microphone is off; if nobody is playing, you will hear silence.');
  } catch (error) {
    if (valid()) await disconnect(); else await next.disconnect().catch(() => {});
    throw error;
  }
}
el('join-room').onclick = action(() => authorize({ action: 'enter' }));
if (el('copy-invite')) el('copy-invite').onclick = action(async () => {
  if (!session) throw new Error('Start or join a rehearsal before copying its invitation.');
  await navigator.clipboard.writeText(el('invite-link').value);
  status('Private invitation copied. Share it only with your bandmates.');
});
el('devices').onclick = action(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  stream.getTracks().forEach(track => track.stop());
  const devices = await navigator.mediaDevices.enumerateDevices();
  el('input').replaceChildren(new Option('Default audio input', ''),
    ...devices.filter(d => d.kind === 'audioinput').map(d => new Option(d.label || 'Audio input', d.deviceId)));
  status(localTrack ? 'Inputs found. Stop audio before changing your input.' : 'Inputs found. Choose yours, then Start my microphone.');
});
el('publish').onclick = action(() => {
  const problem = booth.problem();
  if (problem) throw new Error(problem);
  return connect(true);
});
el('listen').onclick = action(() => connect(false));
el('leave').onclick = action(async () => {
  await disconnect(true);
  status('Microphone off. To try again, choose Start my microphone.');
});
el('end').onclick = action(async () => {
  if (!window.confirm('Close this rehearsal for everyone? Its invite link will stop working.')) return;
  await request('control', { action: 'end', confirmed: true }, session?.token);
  session = null; clearTimeout(deadlineTimer); el('controls').hidden = true; await disconnect(); status('Rehearsal session closed for everyone.');
});
el('remove').onclick = action(async () => {
  const wallet = el('remove-who').value;
  if (!wallet) throw new Error('Choose who to remove first.');
  if (!window.confirm('Remove this person from the current session? They cannot rejoin until it closes.')) return;
  renderPeople(await request('control', { action: 'remove', wallet }, session?.token));
  status('Removed from this session.');
});
async function poll() {
  if (!session || polling || disposed) return;
  polling = true; const authorization = session;
  try {
    const state = await request('control', { action: 'state' }, authorization.token);
    if (session === authorization) { renderDelivery(state.privateAudioFresh); renderPeople(state); syncOutputs(); }
  } catch {
    if (session === authorization) {
      session = null; clearTimeout(deadlineTimer); el('controls').hidden = true; await disconnect();
      status('Connection lost or session closed; microphone stopped. Sign in again to rejoin the room.', true);
    }
  } finally { polling = false; }
}
window.ethereum?.on?.('accountsChanged', () => {
  if (requestingAccounts) return;
  const token = session?.token; session = null; clearTimeout(deadlineTimer); el('controls').hidden = true;
  if (token) void request('control', { action: 'exit' }, token).catch(() => {});
  void disconnect(); status('Wallet changed; sign in again.');
});
window.addEventListener('pagehide', () => {
  disposed = true; const token = session?.token; session = null; clearTimeout(deadlineTimer);
  if (token && !preservePassOnHide) void request('control', { action: 'exit' }, token, true).catch(() => {});
  void disconnect();
});
window.addEventListener('message', async event => {
  if (!embedded || event.origin !== location.origin || event.source !== window.parent) return;
  if (event.data?.type === 'decentbusking:rehearsal-wallet-changed') {
    const token = session?.token; session = null; clearTimeout(deadlineTimer);
    el('controls').hidden = true;
    await disconnect();
    if (token) await request('control', { action: 'exit' }, token).catch(error => status(error.message, true));
    status('Wallet changed; sign consent again.');
    return;
  }
  if (event.data?.type !== 'decentbusking:close-rehearsal' || typeof event.data.requestId !== 'string') return;
  try {
    if (busy) throw new Error('Wait for the current rehearsal action to finish, then retry closing.');
    const token = session?.token;
    await disconnect();
    let warning = '';
    if (token) {
      try { await request('control', { action: event.data.handoff ? 'leave' : 'exit' }, token); }
      catch {
        warning = 'Microphone and audio stopped. Server sign-out could not be confirmed; the old idle pass expires within five minutes.';
      }
    }
    preservePassOnHide = event.data.handoff === true;
    session = null; disposed = true; clearTimeout(deadlineTimer);
    window.parent.postMessage({ type: 'decentbusking:rehearsal-closed', requestId: event.data.requestId,
      roomId: inviteRoomId, warning }, location.origin);
  } catch (error) {
    status(error.message || 'The room could not close. Retry before leaving.', true);
    window.parent.postMessage({ type: 'decentbusking:rehearsal-close-failed', requestId: event.data.requestId }, location.origin);
  }
});
setInterval(() => { void poll(); }, 2000);
if (embedded) window.parent.postMessage({ type: 'decentbusking:rehearsal-ready' }, location.origin);
if (practiceBookingId) {
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
    el('join-room').disabled = false;
    status(inviteRoomId ? 'Invitation ready. Sign consent to join this rehearsal; no booking or payment needed.'
      : 'Accepted live performers and administrators can start a private rehearsal. Sign consent; no transaction.');
  } catch (error) { status(error.message || 'Private rehearsal unavailable.'); }
}
