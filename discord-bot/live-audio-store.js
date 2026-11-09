import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createPinataStateStore } from './ipfs-state.js';

export const LIVE_AUDIO_STATE_NAME = 'decentbusking-live-audio-encrypted.json';
export const LIVE_AUDIO_STATE_TAGS = Object.freeze({ app: 'decentbusking', kind: 'live-audio-encrypted', schema: '1' });
const SCHEMA = 'encrypted-live-audio-v1';
const AAD = Buffer.from('dbusk-live-audio-state-v1');
const ROOM_KEYS = new Set(['bookingId', 'armed', 'checks', 'lastVerifiedAt', 'lossSince', 'cancelledAt', 'reason', 'cancelNoticePending']);
const CHECK_KEYS = new Set(['t60', 't15']);
const MAX_ROOMS = 500;

const time = value => value === undefined || (Number.isSafeInteger(value) && value >= 0);

// Allowlist only lifecycle facts so grants, session tokens or ingress endpoints can never be checkpointed.
export function validateLiveAudioState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || Object.keys(state).some(key => !['version', 'rooms'].includes(key)) ||
      state.version !== 1 || !Array.isArray(state.rooms) || state.rooms.length > MAX_ROOMS) {
    throw new Error('Invalid live audio checkpoint');
  }
  const seen = new Set();
  for (const room of state.rooms) {
    if (!room || typeof room !== 'object' || Array.isArray(room) || Object.keys(room).some(key => !ROOM_KEYS.has(key)) ||
        typeof room.bookingId !== 'string' || !room.bookingId || room.bookingId.length > 200 || seen.has(room.bookingId) ||
        typeof room.armed !== 'boolean' || !room.checks || typeof room.checks !== 'object' || Array.isArray(room.checks) ||
        Object.entries(room.checks).some(([key, value]) => !CHECK_KEYS.has(key) || typeof value !== 'string' || !Number.isFinite(Date.parse(value))) ||
        ![room.lastVerifiedAt, room.lossSince, room.cancelledAt].every(time) ||
        (room.reason !== undefined && (typeof room.reason !== 'string' || room.reason.length > 500)) ||
        (room.cancelledAt && !room.reason) ||
        (room.cancelNoticePending !== undefined && typeof room.cancelNoticePending !== 'boolean')) {
      throw new Error('Invalid live audio checkpoint');
    }
    seen.add(room.bookingId);
  }
  return state;
}

export function liveAudioStateCodec(keyHex, { distinctFrom = [] } = {}) {
  if (!/^[0-9a-f]{64}$/i.test(keyHex || '')) throw new Error('LIVE_AUDIO_STORAGE_KEY must be 32 random bytes in hex, privately backed up');
  if (distinctFrom.some(other => typeof other === 'string' && other.toLowerCase() === keyHex.toLowerCase())) {
    throw new Error('LIVE_AUDIO_STORAGE_KEY must be dedicated, not reused from another store');
  }
  const key = Buffer.from(keyHex, 'hex');
  return {
    serialize(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(AAD);
      const data = Buffer.concat([cipher.update(JSON.stringify(validateLiveAudioState(value))), cipher.final()]);
      return { schema: SCHEMA, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('base64') };
    },
    deserialize(value) {
      if (value?.schema !== SCHEMA || !/^[0-9a-f]{24}$/.test(value.iv || '') || !/^[0-9a-f]{32}$/.test(value.tag || '') ||
          typeof value.data !== 'string') throw new Error('Invalid encrypted live audio checkpoint');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'hex'));
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(value.tag, 'hex'));
      return validateLiveAudioState(JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString()));
    },
  };
}

/**
 * Durable live-audio lifecycle store: encrypted, locally mirrored Pinata checkpoints.
 * restore() resolves only an empty state when no checkpoint exists; any listing, gateway, decryption or schema
 * failure rejects so the service stays closed. save() resolves only after mirror and Pinata confirm the same CID.
 */
export function createLiveAudioPinataStore({ storageKey, distinctFrom = [], checkpointMirror, pinataJwt, ...pinata } = {}) {
  if (!checkpointMirror || typeof checkpointMirror.mirror !== 'function') {
    throw new Error('Live audio state requires the existing checkpoint mirror');
  }
  const codec = liveAudioStateCodec(storageKey, { distinctFrom });
  const store = createPinataStateStore({ ...pinata, pinataJwt, name: LIVE_AUDIO_STATE_NAME, tags: LIVE_AUDIO_STATE_TAGS,
    // Never fall back to an older room checkpoint: it could reopen a cancelled room or forget checks/arming.
    restoreLatestOnly: true, requireLocalMirror: true, ...codec,
    beforeUpload: (bytes, options) => checkpointMirror.mirror(bytes, options) });
  return {
    async restore() {
      const restored = await store.restore();
      return restored === null ? { version: 1, rooms: [] } : restored;
    },
    async save(value) {
      const uri = await store.save(validateLiveAudioState(value));
      if (!/^ipfs:\/\/\S+$/.test(uri || '')) throw new Error('Live audio checkpoint did not confirm');
      return uri;
    },
    close: () => store.close(),
    getLatestSnapshotUri: () => store.getLatestSnapshotUri(),
  };
}
