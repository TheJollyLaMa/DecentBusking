import { loadLiveAudioSdk, roomRequest } from './live-audio-client.mjs?v=20261114-allocated-stage';

// One receive-only connection. Selecting a room never publishes or changes radio.
export function createPrivateRoomListener({ audio, serviceUrl, onStatus = () => {},
  request = roomRequest, sdkLoader = loadLiveAudioSdk, now = () => Date.now() }) {
  let room, track, generation = 0;
  async function close() {
    const previous = room;
    room = null;
    track?.detach(audio);
    track = null;
    audio.pause();
    audio.srcObject = null;
    await previous?.disconnect().catch(() => {});
  }
  async function disconnect() {
    const current = ++generation;
    await close();
    if (current === generation) onStatus('Private listening is off. Your microphone is not used.');
  }
  return {
    disconnect,
    async connect(session, bookingId) {
      const current = ++generation;
      await close();
      const valid = () => current === generation && session?.expiresAt > now();
      if (!valid()) return false;
      if (session.role !== 'owner' || session.state?.bookingId !== bookingId) {
        throw new Error('Authorize the owner wallet for this selected booking first.');
      }
      onStatus('Connecting to the selected private feed… Your microphone stays off.');
      let next;
      try {
        const sdk = await sdkLoader(serviceUrl);
        if (!valid()) return false;
        const grant = await request(serviceUrl, 'control', { action: 'connect', publish: false }, session.token);
        if (!valid()) return false;
        next = new sdk.Room({ adaptiveStream: false, dynacast: false });
        room = next;
        const active = () => valid() && room === next;
        const subscribe = (publication, participant) => {
          if (active() && participant.identity === grant.publisherIdentity && publication.kind === sdk.Track.Kind.Audio) {
            publication.setSubscribed(true);
          }
        };
        next.on(sdk.RoomEvent.TrackPublished, subscribe);
        next.on(sdk.RoomEvent.TrackSubscribed, (remote, _publication, participant) => {
          if (!active() || participant.identity !== grant.publisherIdentity || remote.kind !== sdk.Track.Kind.Audio) return;
          track?.detach(audio);
          track = remote;
          remote.attach(audio);
          void audio.play().then(() => {
            if (active()) onStatus('Listening privately to the selected performer. This is not public radio.');
          }).catch(() => {
            if (active()) onStatus('Private audio received. Tap Play on the player to hear it.');
          });
        });
        next.on(sdk.RoomEvent.TrackUnsubscribed, remote => {
          if (!active() || remote !== track) return;
          remote.detach(audio);
          track = null;
          onStatus('Selected performer audio stopped. Waiting for their microphone.');
        });
        if (sdk.RoomEvent.Reconnecting) next.on(sdk.RoomEvent.Reconnecting, () => {
          if (active()) onStatus('Private audio is reconnecting. The public radio status is separate.');
        });
        next.on(sdk.RoomEvent.Disconnected, () => {
          if (!active()) return;
          void disconnect();
        });
        await next.connect(grant.url, grant.token, { autoSubscribe: false });
        if (!active()) { await next.disconnect(); return false; }
        for (const participant of next.remoteParticipants.values()) {
          for (const publication of participant.trackPublications.values()) subscribe(publication, participant);
        }
        await next.startAudio();
        if (!active()) return false;
        if (!track) onStatus('Private connection open; waiting for the selected performer to publish audio.');
        return true;
      } catch (error) {
        if (current === generation) await close();
        else await next?.disconnect().catch(() => {});
        throw error;
      }
    },
  };
}
