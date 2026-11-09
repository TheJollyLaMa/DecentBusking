import { createHash, randomUUID } from 'node:crypto';
import { AccessToken, RoomServiceClient, IngressClient, IngressInput, TrackSource } from 'livekit-server-sdk';
import { LiveAudioError } from './live-audio-errors.js';

export function liveAudioRoomName(bookingId) {
  return `dbusk-audio-${createHash('sha256').update(String(bookingId)).digest('hex').slice(0, 32)}`;
}

export function receivedAudioPackets(stats) {
  return (stats?.subscriberStats || []).reduce((total, entry) => {
    const rtp = entry.stats?.case === 'inboundRtp' ? entry.stats.value : null;
    return rtp?.stream?.kind === 'audio' ? total + BigInt(rtp.received?.packetsReceived || 0) : total;
  }, 0n);
}

export function createLiveAudioTransport({ url = '', apiKey = '', apiSecret = '', enabled = false,
  ingressEnabled = false, roomClient, ingressClient, rtcLoader = () => import('@livekit/rtc-node'), now = () => Date.now() } = {}) {
  const ready = enabled && /^wss:\/\/[a-z0-9.-]+\.livekit\.cloud\/?$/i.test(url) && !!apiKey && !!apiSecret;
  const host = url.replace(/^wss:/, 'https:');
  const rooms = roomClient || (ready ? new RoomServiceClient(host, apiKey, apiSecret, { requestTimeout: 5 }) : null);
  const ingress = ingressClient || (ready ? new IngressClient(host, apiKey, apiSecret, { requestTimeout: 5 }) : null);
  const monitors = new Map();
  const publisherIdentity = booking => `performer:${booking.wallet.toLowerCase()}`;
  const requireReady = () => { if (!ready) throw new LiveAudioError('Live audio hosting is not configured'); };
  async function grant(booking, identity, publish = false) {
    requireReady();
    const remaining = Math.floor((Date.parse(booking.endUtc) - now()) / 1000);
    if (remaining <= 0) throw new LiveAudioError('This live room has reached its booked end');
    const token = new AccessToken(apiKey, apiSecret, { identity, ttl: Math.min(30, remaining) });
    token.addGrant({ roomJoin: true, room: liveAudioRoomName(booking.id), canPublish: publish,
      canPublishSources: publish ? [TrackSource.MICROPHONE] : [], canSubscribe: !publish, canPublishData: false });
    return { url, token: await token.toJwt(), publisherIdentity: publisherIdentity(booking) };
  }
  async function ensureRoom(booking) {
    requireReady();
    await rooms.createRoom({ name: liveAudioRoomName(booking.id), emptyTimeout: 60, departureTimeout: 20,
      maxParticipants: 13, metadata: JSON.stringify({ purpose: 'DecentBusking audio pilot', bookingId: booking.id }) });
  }
  async function revokeIngress(booking) {
    const existing = await ingress.listIngress({ roomName: liveAudioRoomName(booking.id) });
    for (const item of existing) await ingress.deleteIngress(item.ingressId);
  }
  async function monitor(booking, onFrame) {
    requireReady();
    if (monitors.has(booking.id)) return;
    const state = { room: null, closed: false, readers: new Map(), decodedAt: 0, statsTimer: null };
    monitors.set(booking.id, state);
    try {
      await ensureRoom(booking);
      const { Room, AudioStream, TrackKind } = await rtcLoader();
      if (state.closed) return;
      const room = new Room();
      state.room = room;
      const subscribe = (publication, participant) => {
        if (participant.identity === publisherIdentity(booking) && publication.kind === TrackKind.KIND_AUDIO) {
          publication.setSubscribed(true);
        }
      };
      room.on('trackPublished', subscribe);
      room.on('trackSubscribed', (track, publication, participant) => {
        if (state.closed || participant.identity !== publisherIdentity(booking) || track.kind !== TrackKind.KIND_AUDIO) return;
        const reader = new AudioStream(track, { sampleRate: 48000, numChannels: 1 }).getReader();
        state.readers.set(publication.sid, reader);
        void (async () => {
          try {
            while (!state.closed) {
              const { value: frame, done } = await reader.read();
              if (done) break;
              // Zero-valued PCM is valid delivered silence, not a disconnection.
              if (frame.samplesPerChannel > 0 && frame.data?.length) state.decodedAt = now();
            }
          } catch { /* Missing frames are handled by the service's sixty-second watchdog. */ }
          finally { state.readers.delete(publication.sid); await reader.cancel().catch(() => {}); }
        })();
      });
      room.on('trackUnsubscribed', (_track, publication) => {
        void state.readers.get(publication.sid)?.cancel().catch(() => {});
      });
      room.on('disconnected', () => { void stopMonitor(booking.id); });
      const auth = await grant(booking, `health:${booking.id}`);
      await room.connect(url, auth.token, { autoSubscribe: false, dynacast: false,
        dataStream: { maxPayloadByteLength: 1024 } });
      if (state.closed) { await room.disconnect(); return; }
      for (const participant of room.remoteParticipants.values()) {
        for (const publication of participant.trackPublications.values()) subscribe(publication, participant);
      }
      let packets = 0n, checking = false;
      state.statsTimer = setInterval(async () => {
        if (checking || state.closed) return;
        checking = true;
        try {
          const next = receivedAudioPackets(await room.getRtcStats());
          if (!state.closed && next > packets && now() - state.decodedAt < 2000) onFrame({ samples: 1 });
          packets = next;
        } catch { /* Transport counters, not amplitude or concealed frames, establish freshness. */ }
        finally { checking = false; }
      }, 1000);
      state.statsTimer.unref?.();
    } catch (error) {
      await stopMonitor(booking.id);
      throw error;
    }
  }
  async function stopMonitor(bookingId) {
    const state = monitors.get(bookingId);
    if (!state) return;
    monitors.delete(bookingId);
    state.closed = true;
    clearInterval(state.statsTimer);
    for (const reader of state.readers.values()) void reader.cancel().catch(() => {});
    await state.room?.disconnect().catch(() => {});
  }
  return {
    ready, ingressEnabled: ready && ingressEnabled, ensureRoom, monitor,
    publisherIdentity,
    async connect(booking, role) {
      await ensureRoom(booking);
      if (role === 'publisher' && ingressEnabled) await revokeIngress(booking);
      return grant(booking, role === 'publisher' ? publisherIdentity(booking) : `owner:${randomUUID()}`, role === 'publisher');
    },
    async listener(booking) {
      requireReady();
      const participants = await rooms.listParticipants(liveAudioRoomName(booking.id));
      if (participants.filter(p => p.identity.startsWith('listener:')).length >= 10) throw new LiveAudioError('The ten-listener pilot room is full');
      return grant(booking, `listener:${randomUUID()}`);
    },
    async obs(booking) {
      requireReady();
      if (!ingressEnabled) throw new LiveAudioError('OBS ingress is disabled; hosting quota must be approved first');
      await ensureRoom(booking);
      await revokeIngress(booking);
      const result = await ingress.createIngress(IngressInput.WHIP_INPUT, {
        name: `DecentBusking audio ${booking.id}`, roomName: liveAudioRoomName(booking.id),
        participantIdentity: publisherIdentity(booking), participantName: 'Live performer',
        enableTranscoding: false,
      });
      return { protocol: 'WHIP', whipEndpoint: `${result.url.replace(/\/$/, '')}/${encodeURIComponent(result.streamKey)}`,
        notice: 'Private OBS WHIP endpoint includes the stream key. Use Opus audio; leave Bearer Token empty. Never publish or log this endpoint.' };
    },
    async close(booking) {
      requireReady();
      await stopMonitor(booking.id);
      let ingressError;
      if (ingressEnabled) {
        try { await revokeIngress(booking); } catch (error) { ingressError = error; }
      }
      try { await rooms.deleteRoom(liveAudioRoomName(booking.id)); }
      catch (error) { if (error.code !== 'not_found' && error.status !== 404) throw error; }
      if (ingressError) throw ingressError;
    },
    async stop() { await Promise.all([...monitors.keys()].map(stopMonitor)); },
  };
}
