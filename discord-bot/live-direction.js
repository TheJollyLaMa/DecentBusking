import { createHash, randomBytes } from 'node:crypto';
import { LiveAudioError } from './live-audio-errors.js';

export class LiveDirectionError extends LiveAudioError {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const LIVE_DIRECTION_LIMITS = Object.freeze({
  pollIntervalMs: 3000,
  heartbeatIntervalMs: 15000,
  presenceFreshMs: 30000,
  readinessFreshMs: 60000,
  cueTtlMs: 120000,
  messageRetentionMs: 1800000,
  maxMessages: 100,
  maxTextLength: 500,
  maxCommands: 512,
  maxRooms: 32,
  requestsPerMinute: 120,
  messagesPerMinute: 20,
  changesPerMinute: 30,
});

const ACTIONS = Object.freeze({
  'direction-state': ['cursor'],
  'direction-heartbeat': [],
  'direction-cue': ['kind'],
  'direction-acknowledge-cue': ['cueId'],
  'direction-readiness': ['ready'],
  'direction-finished': [],
  'direction-notify-delay': ['status'],
  'direction-acknowledge-delay': ['noticeId'],
  'direction-message': ['text'],
});
const CAPABILITY = Object.freeze({
  'direction-cue': 'cue',
  'direction-acknowledge-cue': 'acknowledgeCue',
  'direction-readiness': 'setReadiness',
  'direction-finished': 'declareFinished',
  'direction-notify-delay': 'notifyDelay',
  'direction-acknowledge-delay': 'acknowledgeDelay',
  'direction-message': 'message',
  'direction-heartbeat': 'setReadiness',
});
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9:_-]{8,100}$/.test(value);
const reject = (code, message, status = 400) => { throw new LiveDirectionError(code, message, status); };

// This store intentionally has no persistence, media, notification or logging dependencies.
export function createLiveDirection({ now = () => Date.now() } = {}) {
  const epoch = randomBytes(32).toString('hex'), rooms = new Map();
  function forget(id) {
    clearTimeout(rooms.get(id)?.timer);
    rooms.delete(id);
  }
  function clear() { for (const id of rooms.keys()) forget(id); }
  function expireMessages(room) {
    room.messages = room.messages.filter(message => message.sentAt + LIVE_DIRECTION_LIMITS.messageRetentionMs > now());
  }
  function scheduleExpiry(room) {
    clearTimeout(room.timer);
    const next = Math.min(room.expiresAt,
      room.messages[0]?.sentAt + LIVE_DIRECTION_LIMITS.messageRetentionMs || Infinity);
    room.timer = setTimeout(() => {
      if (room.expiresAt <= now()) forget(room.bookingId);
      else { expireMessages(room); scheduleExpiry(room); }
    }, Math.max(1, next - now()));
    room.timer.unref?.();
  }
  function prune(bookings) {
    for (const [id, room] of rooms) {
      const b = bookings?.find(item => item.id === id);
      if (b?.broadcast && !b.broadcast.actualEndedAt && room.expiresAt !== b.broadcast.accessUntil) {
        room.expiresAt = b.broadcast.accessUntil;
        scheduleExpiry(room);
      }
      if (room.expiresAt <= now() || bookings && (!b || b.cancelled || b.broadcast?.actualEndedAt ||
          !(b.broadcast ? ['funded', 'approved', 'paid'].includes(b.status) : b.status === 'funded'))) forget(id);
      else expireMessages(room);
    }
  }
  function roomFor(booking) {
    const existing = rooms.get(booking.id);
    if (existing && booking.broadcast && !booking.broadcast.actualEndedAt &&
        existing.expiresAt !== booking.broadcast.accessUntil) {
      existing.expiresAt = booking.broadcast.accessUntil;
      scheduleExpiry(existing);
    }
    prune();
    let room = rooms.get(booking.id);
    if (!room) {
      if (rooms.size >= LIVE_DIRECTION_LIMITS.maxRooms) reject('DIRECTION_CAPACITY', 'Private room capacity reached; retry later', 429);
      room = { bookingId: booking.id, expiresAt: booking.broadcast?.accessUntil ?? Date.parse(booking.endUtc), revision: 0, sequence: 0,
        performerPresence: { lastSeenAt: null, expiresAt: null },
        readiness: { ready: null, updatedAt: null, expiresAt: null },
        cue: null, finished: null, delay: null, messages: [], commands: new Map(), rates: new Map() };
      rooms.set(booking.id, room);
      scheduleExpiry(room);
    }
    return room;
  }
  function capabilities(session, booking) {
    const performer = session.wallet.toLowerCase() === booking.wallet.toLowerCase();
    const owner = session.role === 'owner';
    return { cue: owner, notifyDelay: owner, message: true,
      setReadiness: performer, declareFinished: performer,
      acknowledgeCue: performer, acknowledgeDelay: performer,
      endBroadcast: false, takeLive: false };
  }
  function rate(room, wallet, kind, limit) {
    const key = `${wallet}:${kind}`, old = room.rates.get(key);
    const bucket = old && now() - old.since < 60000 ? old : { since: now(), count: 0 };
    if (bucket.count >= limit) reject('DIRECTION_RATE_LIMIT', 'Private room rate limit reached; retry in a minute', 429);
    bucket.count++;
    room.rates.set(key, bucket);
  }
  function snapshot(room, caps, cursor) {
    expireMessages(room);
    const oldest = room.messages[0]?.sequence ?? room.sequence + 1;
    const resetRequired = !!cursor && (cursor.epoch !== epoch || cursor.sequence > room.sequence || cursor.sequence < oldest - 1);
    return {
      schemaVersion: 1, serverTime: now(), epoch, bookingId: room.bookingId,
      revision: room.revision, capabilities: caps,
      performerPresence: { ...room.performerPresence },
      readiness: { ...room.readiness, ready: room.readiness.expiresAt > now() ? room.readiness.ready : null },
      cue: room.cue && { ...room.cue }, finished: room.finished && { ...room.finished },
      delay: room.delay && { ...room.delay },
      messages: room.messages.filter(message => !cursor || resetRequired || message.sequence > cursor.sequence)
        .map(message => ({ ...message })),
      cursor: { epoch, sequence: room.sequence }, resetRequired,
      chat: { persistence: 'memory-only', retentionMs: LIVE_DIRECTION_LIMITS.messageRetentionMs,
        maxMessages: LIVE_DIRECTION_LIMITS.maxMessages, maxTextLength: LIVE_DIRECTION_LIMITS.maxTextLength,
        expiresAt: room.expiresAt },
      limits: { ...LIVE_DIRECTION_LIMITS },
    };
  }
  return {
    clear, forget, prune,
    command({ booking, session, input }) {
      if (!object(input) || !Object.hasOwn(ACTIONS, input.action)) {
        reject('DIRECTION_ACTION', 'Unknown private direction action');
      }
      if (session.bookingId !== booking.id || input.bookingId !== undefined && input.bookingId !== session.bookingId ||
          session.role !== 'owner' && session.wallet.toLowerCase() !== booking.wallet.toLowerCase()) {
        reject('DIRECTION_FORBIDDEN', 'This authorization is for a different booking', 403);
      }
      const roomEnd = booking.broadcast?.actualEndedAt ?? booking.broadcast?.accessUntil ?? Date.parse(booking.endUtc);
      if (!Number.isFinite(roomEnd) || roomEnd <= now()) {
        forget(booking.id);
        reject('DIRECTION_CLOSED', 'This private room has reached its booked end', 403);
      }
      const action = input.action, fields = ACTIONS[action];
      const read = action === 'direction-state', heartbeat = action === 'direction-heartbeat';
      const message = action === 'direction-message', versioned = !read && !heartbeat && !message;
      const allowed = ['action', 'bookingId', ...fields, ...(!read ? ['epoch'] : []),
        ...(!read && !heartbeat ? ['commandId'] : []), ...(versioned ? ['expectedRevision'] : [])];
      if (Object.keys(input).some(key => !allowed.includes(key))) reject('DIRECTION_INPUT', 'Unexpected private direction field');
      if (input.cursor !== undefined && (!object(input.cursor) ||
          Object.keys(input.cursor).some(key => !['epoch', 'sequence'].includes(key)) ||
          typeof input.cursor.epoch !== 'string' || input.cursor.epoch.length > 100 ||
          !Number.isSafeInteger(input.cursor.sequence) || input.cursor.sequence < 0)) {
        reject('DIRECTION_INPUT', 'Invalid private message cursor');
      }
      if (!read && input.epoch !== epoch) reject('DIRECTION_RESET', 'Private room restarted; refresh and reconfirm without resending messages', 409);
      if (!read && !heartbeat && !identifier(input.commandId)) reject('DIRECTION_INPUT', 'A unique private command ID is required');
      if (versioned && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)) {
        reject('DIRECTION_INPUT', 'A current private room revision is required');
      }
      const caps = capabilities(session, booking);
      if (!read && !caps[CAPABILITY[action]]) reject('DIRECTION_FORBIDDEN', 'This private direction action is not allowed for your booking role', 403);
      if (action === 'direction-cue' && !['another-song', 'wrap-up'].includes(input.kind) ||
          action === 'direction-notify-delay' && !['possible-delay', 'stand-by', 'clear'].includes(input.status) ||
          action === 'direction-readiness' && typeof input.ready !== 'boolean' ||
          action === 'direction-acknowledge-cue' && !identifier(input.cueId) ||
          action === 'direction-acknowledge-delay' && !identifier(input.noticeId)) {
        reject('DIRECTION_INPUT', 'Invalid private direction value');
      }
      let text;
      if (message) {
        if (typeof input.text !== 'string') reject('DIRECTION_INPUT', 'A private text message is required');
        text = input.text.replace(/\r\n?/g, '\n').trim();
        if (!text || text.length > LIVE_DIRECTION_LIMITS.maxTextLength || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) {
          reject('DIRECTION_INPUT', 'Private messages must be plain text within the displayed length limit');
        }
      }
      const room = roomFor(booking), wallet = session.wallet.toLowerCase();
      rate(room, wallet, 'requests', LIVE_DIRECTION_LIMITS.requestsPerMinute);
      if (read) return snapshot(room, caps, input.cursor);
      // Only the hash is retained for deduplication, never a second copy of private text.
      const fingerprint = !heartbeat && createHash('sha256').update(JSON.stringify([
        wallet, action, input.expectedRevision ?? null, ...fields.map(field => input[field]),
      ])).digest('hex');
      const previous = !heartbeat && room.commands.get(input.commandId);
      if (previous) {
        if (previous !== fingerprint) reject('DIRECTION_ID_REUSED', 'This command ID was already used for a different private command', 409);
        return { commandId: input.commandId, applied: false, state: snapshot(room, caps) };
      }
      if (versioned && input.expectedRevision !== room.revision) reject('DIRECTION_STALE', 'Private room changed; refresh before sending this command', 409);
      if (!heartbeat && room.commands.size >= LIVE_DIRECTION_LIMITS.maxCommands) {
        reject('DIRECTION_CAPACITY', 'Private room command limit reached for this show', 429);
      }
      if (!heartbeat) rate(room, wallet, message ? 'messages' : 'changes',
        message ? LIVE_DIRECTION_LIMITS.messagesPerMinute : LIVE_DIRECTION_LIMITS.changesPerMinute);
      const at = now(), expires = duration => Math.min(at + duration, room.expiresAt);
      let changed = false;
      switch (action) {
        case 'direction-heartbeat':
          room.performerPresence = { lastSeenAt: at, expiresAt: expires(LIVE_DIRECTION_LIMITS.presenceFreshMs) };
          if (room.readiness.expiresAt > at) room.readiness.expiresAt = expires(LIVE_DIRECTION_LIMITS.readinessFreshMs);
          break;
        case 'direction-cue':
          room.cue = { id: input.commandId, kind: input.kind, sentAt: at,
            expiresAt: expires(LIVE_DIRECTION_LIMITS.cueTtlMs), acknowledgedAt: null };
          changed = true;
          break;
        case 'direction-acknowledge-cue':
          if (room.cue?.id !== input.cueId || room.cue.expiresAt <= at) reject('DIRECTION_CUE_EXPIRED', 'This cue expired or was superseded', 409);
          changed = room.cue.acknowledgedAt === null;
          room.cue.acknowledgedAt ??= at;
          break;
        case 'direction-readiness':
          changed = room.readiness.ready !== input.ready || room.readiness.expiresAt <= at;
          room.readiness = { ready: input.ready, updatedAt: at, expiresAt: expires(LIVE_DIRECTION_LIMITS.readinessFreshMs) };
          break;
        case 'direction-finished':
          if (at < Date.parse(booking.startUtc)) reject('DIRECTION_NOT_STARTED', 'A finished-set declaration is available after the booked start', 409);
          room.finished = { id: input.commandId, at };
          changed = true;
          break;
        case 'direction-notify-delay':
          room.delay = { id: input.commandId, status: input.status, sentAt: at,
            expiresAt: room.expiresAt, acknowledgedAt: null, estimatedStartUtc: null };
          changed = true;
          break;
        case 'direction-acknowledge-delay':
          if (room.delay?.id !== input.noticeId || room.delay.expiresAt <= at) reject('DIRECTION_DELAY_EXPIRED', 'This delay notice expired or was superseded', 409);
          changed = room.delay.acknowledgedAt === null;
          room.delay.acknowledgedAt ??= at;
          break;
        case 'direction-message':
          room.messages.push({ id: input.commandId, sequence: ++room.sequence,
            senderRole: wallet === booking.wallet.toLowerCase() ? 'performer' : 'owner', sentAt: at, text });
          room.messages = room.messages.slice(-LIVE_DIRECTION_LIMITS.maxMessages);
          scheduleExpiry(room);
          break;
      }
      if (changed) room.revision++;
      if (!heartbeat) room.commands.set(input.commandId, fingerprint);
      return { commandId: input.commandId || null, applied: true, state: snapshot(room, caps) };
    },
  };
}
