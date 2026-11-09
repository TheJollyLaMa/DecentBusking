import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createPinataStateStore } from './ipfs-state.js';

const aad = Buffer.from('dbusk-private-rehearsal-v1');
const name = 'decentbusking-private-rehearsals-encrypted.json';
const tags = { app: 'decentbusking', kind: 'private-rehearsals-encrypted', schema: '1' };

export function validateRehearsalState(value) {
  if (!value || value.version !== 1 || Object.keys(value).some(k => !['version', 'rooms'].includes(k)) ||
      !Array.isArray(value.rooms) || value.rooms.length > 100) throw new Error('Invalid rehearsal checkpoint');
  const ids = new Set();
  for (const room of value.rooms) {
    if (!room || Object.keys(room).some(k => !['id', 'guest', 'expiresAt', 'endedAt'].includes(k)) ||
        !/^rehearsal:[0-9a-f]{64}$/.test(room.id || '') || ids.has(room.id) ||
        !/^0x[0-9a-f]{40}$/.test(room.guest || '') || !Number.isSafeInteger(room.expiresAt) ||
        room.expiresAt < 0 || !Number.isSafeInteger(room.endedAt) || room.endedAt < 0) throw new Error('Invalid rehearsal checkpoint');
    ids.add(room.id);
  }
  return value;
}

export function createRehearsalStore({ storageKey, distinctFrom = [], pinataJwt, ...options } = {}) {
  if (!/^[0-9a-f]{64}$/i.test(storageKey || '') ||
      distinctFrom.some(k => k && k.toLowerCase() === storageKey.toLowerCase())) {
    throw new Error('A dedicated live audio storage key is required');
  }
  const key = Buffer.from(storageKey, 'hex');
  const store = createPinataStateStore({
    ...options, pinataJwt, name, tags, restoreLatestOnly: true, rejectAmbiguousLatest: true,
    requireLocalMirror: false, beforeUpload: undefined,
    serialize(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad);
      const data = Buffer.concat([cipher.update(JSON.stringify(validateRehearsalState(value))), cipher.final()]);
      return { schema: 'encrypted-private-rehearsal-v1', iv: iv.toString('hex'),
        tag: cipher.getAuthTag().toString('hex'), data: data.toString('base64') };
    },
    deserialize(envelope) {
      if (envelope?.schema !== 'encrypted-private-rehearsal-v1' ||
          !/^[0-9a-f]{24}$/.test(envelope.iv || '') || !/^[0-9a-f]{32}$/.test(envelope.tag || '') ||
          typeof envelope.data !== 'string') throw new Error('Invalid rehearsal envelope');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
      decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
      return validateRehearsalState(JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()])));
    },
  });
  return {
    async restore() { return await store.restore() || { version: 1, rooms: [] }; },
    async save(value) {
      const uri = await store.save(validateRehearsalState(value));
      if (!/^ipfs:\/\/\S+$/.test(uri || '')) throw new Error('Rehearsal checkpoint not confirmed');
      const restored = await store.restore();
      if (store.getLatestSnapshotUri() !== uri || JSON.stringify(restored) !== JSON.stringify(value)) {
        throw new Error('Latest rehearsal checkpoint was not verified');
      }
      return uri;
    },
    close: () => store.close(),
  };
}
