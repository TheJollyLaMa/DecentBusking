import { randomBytes } from 'node:crypto';
import { verifyMessage } from 'ethers';
import { LiveAudioError } from './live-audio-errors.js';
import { validateRehearsalState } from './rehearsal-store.js';

const address = value => /^0x[0-9a-f]{40}$/i.test(value || '') ? value.toLowerCase() : '';
const opaque = () => randomBytes(32).toString('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const MAX_DURATION = 2 * 60 * 60_000;
const SESSION_DURATION = 15 * 60_000;
const HEARTBEAT = 30_000;

export function createRehearsalService({ ownerWallet, transport, store, now = () => Date.now(),
  verify = verifyMessage, checkpointTimeoutMs = 10_000, getBookings } = {}) {
  const owner = address(ownerWallet), challenges = new Map(), sessions = new Map(), frames = new Map();
  const monitoring = new Set(), connected = new Map();
  let bookingSnapshot, bookingSnapshotAt = -Infinity;
  let state, failed = false, tail = Promise.resolve();
  const configured = !!owner && !!store && transport?.ready === true;
  const run = fn => { const task = tail.then(fn); tail = task.catch(() => {}); return task; };
  const booking = room => ({ id: room.id, wallet: room.guest, owner, rehearsal: true,
    endUtc: new Date(room.expiresAt).toISOString() });
  const lookup = id => state.rooms.find(room => room.id === id);
  const active = room => room && !room.endedAt && room.expiresAt > now();
  async function practiceBooking(id, who, allowCached = false) {
    if (!getBookings || typeof id !== 'string' || id.length > 100) throw new LiveAudioError('Practice booking unavailable');
    if (!allowCached || !bookingSnapshot || now() - bookingSnapshotAt >= 10000) {
      bookingSnapshot = undefined;
      bookingSnapshot = await getBookings();
      bookingSnapshotAt = now();
    }
    const result = bookingSnapshot;
    const b = (Array.isArray(result) ? result : result.bookings || []).find(item => item.id === id);
    if (!b || b.mode !== 'phase1' || b.payoutPolicy !== 'pilot-guaranteed-v1' || !b.stewardApproved ||
        b.cancelled || !['draft', 'funded'].includes(b.status) || !address(b.wallet) ||
        ![owner, address(b.wallet)].includes(who) || !Number.isFinite(Date.parse(b.startUtc)) ||
        Date.parse(b.startUtc) - 70 * 60_000 <= now()) {
      throw new LiveAudioError('Practice is for the invited wallet before backstage opens at T−70');
    }
    return b;
  }
  async function save(next) {
    let timer;
    try {
      await Promise.race([store.save(next), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('checkpoint timeout')), checkpointTimeoutMs);
      })]);
      state = next;
    } catch {
      failed = true; sessions.clear(); challenges.clear(); frames.clear();
      for (const room of state?.rooms || []) void transport.close(booking(room)).catch(() => {});
      throw new LiveAudioError('Rehearsal checkpoint failed; access is closed');
    } finally { clearTimeout(timer); }
  }
  async function initialize() {
    if (!configured || failed) throw new LiveAudioError('Private rehearsal is unavailable');
    if (state) return;
    try {
      const restored = validateRehearsalState(await store.restore());
      state = restored;
      // Sessions and consent are memory-only; a restart ends all previous room generations.
      if (state.rooms.some(room => !room.endedAt)) {
        const next = clone(state);
        for (const room of next.rooms) if (!room.endedAt) room.endedAt = now();
        await save(next);
      }
    } catch (error) {
      failed = true;
      throw error instanceof LiveAudioError ? error : new LiveAudioError('Rehearsal checkpoint restore failed');
    }
  }
  async function cleanup() {
    for (const room of [...state.rooms]) {
      const peers = connected.get(room.id);
      if (peers) for (const [token, at] of peers) {
        if (now() - at > HEARTBEAT || !sessions.has(token) || sessions.get(token).expiresAt <= now()) peers.delete(token);
      }
      if (!room.endedAt && (room.expiresAt <= now() ||
          peers && peers.size === 0)) {
        const next = clone(state); next.rooms.find(r => r.id === room.id).endedAt = now();
        await save(next);
      }
      const endedAt = lookup(room.id)?.endedAt;
      if (!endedAt) continue;
      for (const [token, session] of sessions) if (session.id === room.id) sessions.delete(token);
      frames.delete(room.id); connected.delete(room.id);
      try { await transport.close(booking(room)); }
      catch { continue; }
      // Join tokens can recreate a deleted room until their short expiry.
      if (now() - endedAt < 35_000) continue;
      const next = clone(state); next.rooms = next.rooms.filter(r => r.id !== room.id);
      await save(next);
    }
  }
  function auth(token, origin) {
    const s = sessions.get(token), room = s && lookup(s.id);
    if (!s || s.origin !== origin || s.expiresAt <= now() || !active(room)) {
      throw new LiveAudioError('Rehearsal authorization expired or ended');
    }
    return { s, room };
  }
  function publicState(room) {
    return { kind: 'private-rehearsal', id: room.id, expiresAt: room.expiresAt,
      phase: active(room) ? 'private' : 'ended', privateAudioFresh: now() - (frames.get(room.id) || 0) <= 5000,
      notice: 'Private only: no radio, booking, payment, recording or performance credit.' };
  }
  function startMonitor(room) {
    if (monitoring.has(room.id)) return;
    monitoring.add(room.id);
    void transport.monitor(booking(room), frame => {
      if (!failed && active(lookup(room.id)) && frame.samples > 0) frames.set(room.id, now());
    }).catch(error => {
      console.warn('[rehearsal] Independent receiver unavailable:', error.code || error.name || 'transport error');
    }).finally(() => monitoring.delete(room.id));
  }
  return {
    get configured() { return configured && !failed; },
    async challenge(input, origin) {
      return run(async () => {
        await initialize(); await cleanup();
        const who = address(input.wallet);
        if (!who) throw new LiveAudioError('Connect a valid wallet');
        let room, kind, practiceId;
        if (input.action === 'practice') {
          const b = await practiceBooking(input.bookingId, who);
          practiceId = b.id;
          room = state.rooms.find(item => active(item) && item.guest === address(b.wallet) && item.bookingId === b.id);
          if (!room) {
            if (state.rooms.length) throw new LiveAudioError('Another private rehearsal is active or closing; retry shortly');
            room = { id: `rehearsal:${opaque()}`, guest: address(b.wallet), bookingId: b.id,
              expiresAt: Math.min(now() + MAX_DURATION, Date.parse(b.startUtc) - 70 * 60_000), endedAt: 0 };
          }
          kind = 'practice';
        } else if (input.action === 'create') {
          const guest = address(input.guest);
          if (who !== owner || !guest || guest === owner || !Number.isInteger(input.minutes) ||
              input.minutes < 1 || input.minutes > MAX_DURATION / 60_000) {
            throw new LiveAudioError('Only the owner may invite a distinct guest for 1–120 minutes');
          }
          if (state.rooms.length) throw new LiveAudioError('End the existing rehearsal first');
          room = { id: `rehearsal:${opaque()}`, guest, expiresAt: now() + input.minutes * 60_000, endedAt: 0 };
          kind = 'create';
        } else if (input.action === 'join') {
          room = lookup(input.id);
          if (!active(room) || ![owner, room.guest].includes(who)) throw new LiveAudioError('Rehearsal invitation unavailable');
          if (room.bookingId) {
            await practiceBooking(room.bookingId, who);
            practiceId = room.bookingId;
          }
          kind = 'join';
        } else throw new LiveAudioError('Unknown rehearsal action');
        for (const [key, c] of challenges) if (c.expiresAt <= now()) challenges.delete(key);
        if (challenges.size >= 128) throw new LiveAudioError('Too many rehearsal challenges');
        const id = opaque(), expiresAt = Math.min(now() + 120_000, room.expiresAt);
        const message = ['DecentBusking PRIVATE REHEARSAL authorization', `Action: ${kind}`,
          `Rehearsal: ${room.id}`, `Guest: ${room.guest}`, `Wallet: ${who}`, `Origin: ${origin}`,
          `Room expires: ${new Date(room.expiresAt).toISOString()}`, `Nonce: ${id}`,
          `Challenge expires: ${new Date(expiresAt).toISOString()}`,
          'I consent to private live audio. No public radio, recording, booking, payment, or transaction.'].join('\n');
        challenges.set(id, { kind, room, who, origin, message, expiresAt, practiceId });
        return { challengeId: id, message };
      });
    },
    async authorize({ challengeId, signature }, origin) {
      return run(async () => {
        await initialize(); await cleanup();
        const c = challenges.get(challengeId);
        if (!c || c.origin !== origin || c.expiresAt <= now()) throw new LiveAudioError('Rehearsal challenge expired');
        challenges.delete(challengeId);
        if (address(verify(c.message, signature)) !== c.who) throw new LiveAudioError('Rehearsal signature does not match');
        if (c.practiceId) await practiceBooking(c.practiceId, c.who);
        let room = lookup(c.room.id);
        if (c.kind === 'create') {
          if (state.rooms.length || c.who !== owner || c.room.expiresAt <= now()) throw new LiveAudioError('Rehearsal can no longer be created');
          const next = clone(state); next.rooms.push(c.room); await save(next); room = lookup(c.room.id);
        }
        if (c.kind === 'practice' && !room) {
          const existing = state.rooms.find(item => active(item) && item.bookingId === c.practiceId);
          if (existing) room = existing;
          else {
            if (state.rooms.length || c.room.expiresAt <= now()) throw new LiveAudioError('Practice room is no longer available');
            const next = clone(state); next.rooms.push(c.room); await save(next); room = lookup(c.room.id);
          }
        }
        if (!active(room) || ![owner, room.guest].includes(c.who)) throw new LiveAudioError('Rehearsal has ended');
        for (const [key, s] of sessions) if (s.expiresAt <= now()) sessions.delete(key);
        if (sessions.size >= 32) throw new LiveAudioError('Rehearsal session limit reached');
        const token = opaque(), expiresAt = Math.min(room.expiresAt, now() + SESSION_DURATION);
        sessions.set(token, { id: room.id, wallet: c.who, origin, expiresAt });
        return { token, role: c.who === owner ? 'owner' : 'guest', expiresAt, state: publicState(room) };
      });
    },
    async command(token, input, origin) {
      return run(async () => {
        await initialize(); await cleanup();
        const { s, room } = auth(token, origin);
        if (room.bookingId && input.action !== 'leave' && input.action !== 'end') {
          await practiceBooking(room.bookingId, s.wallet, input.action === 'state');
        }
        if (input.action === 'state') {
          if (connected.get(room.id)?.has(token)) connected.get(room.id).set(token, now());
          return publicState(room);
        }
        if (input.action === 'connect') {
          const grant = await transport.rehearsalConnect(booking(room), s.wallet, input.publish === true);
          if (!connected.has(room.id)) connected.set(room.id, new Map());
          connected.get(room.id).set(token, now()); startMonitor(room);
          return grant;
        }
        if (input.action === 'leave') {
          connected.get(room.id)?.delete(token);
          await cleanup();
          return { left: true };
        }
        if (input.action === 'end' && s.wallet === owner && input.confirmed === true) {
          const next = clone(state); next.rooms.find(r => r.id === room.id).endedAt = now();
          await save(next); await cleanup();
          return { ...publicState({ ...room, endedAt: now() }), phase: 'ended' };
        }
        throw new LiveAudioError('Unknown or unauthorized rehearsal action');
      });
    },
    async tick() {
      return run(async () => {
        if (failed) {
          for (const room of state?.rooms || []) await transport.close(booking(room)).catch(() => {});
          return;
        }
        await initialize(); await cleanup();
      });
    },
  };
}
