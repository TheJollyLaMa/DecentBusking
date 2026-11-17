import { randomBytes } from 'node:crypto';
import { verifyMessage } from 'ethers';
import { LiveAudioError } from './live-audio-errors.js';
import { validateRehearsalState } from './rehearsal-store.js';

const address = value => /^0x[0-9a-f]{40}$/i.test(value || '') ? value.toLowerCase() : '';
const opaque = () => randomBytes(32).toString('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const short = wallet => `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
export const REHEARSAL_MAX_DURATION = 4 * 60 * 60_000;
export const REHEARSAL_MAX_PEOPLE = 6;
// A pass stays valid while its page keeps checking in; an abandoned page loses access after this idle window.
const SESSION_IDLE = 5 * 60_000;
const HEARTBEAT = 30_000;
const CONSENT = 'I consent to private live audio with the people invited to this rehearsal. No public radio, recording, booking, payment, or transaction.';

export function createRehearsalService({ ownerWallet, engineerWallets = [], transport, store, now = () => Date.now(),
  getBookings, verify = verifyMessage, checkpointTimeoutMs = 45_000 } = {}) {
  const engineers = new Set([ownerWallet, ...engineerWallets].map(address).filter(Boolean));
  const challenges = new Map(), sessions = new Map(), frames = new Map();
  const monitoring = new Set(), connected = new Map();
  let state, failed = false, tail = Promise.resolve();
  const configured = !!store && transport?.ready === true;
  const run = fn => { const task = tail.then(fn); tail = task.catch(() => {}); return task; };
  const booking = room => ({ id: room.id, rehearsal: true, endUtc: new Date(room.expiresAt).toISOString() });
  const lookup = id => state.rooms.find(room => room.id === id);
  const active = room => room && !room.endedAt && room.expiresAt > now();
  const roleOf = (wallet, room) => engineers.has(wallet) ? 'engineer' : room?.host === wallet ? 'host' : 'musician';
  const canManage = (wallet, room) => engineers.has(wallet) || room.host === wallet;
  async function canHost(wallet) {
    if (engineers.has(wallet)) return true;
    if (!getBookings) throw new LiveAudioError('Performer invitation history is unavailable; an administrator can still host.');
    try {
      const history = await getBookings();
      if (!Array.isArray(history?.bookings)) throw Error('Invitation history unavailable');
      return history.bookings.some(b => address(b.wallet) === wallet && b.acknowledged === true);
    } catch { throw new LiveAudioError('Performer invitation history could not be verified. Retry shortly.'); }
  }
  const roomSessions = id => [...sessions.values()].filter(s => s.id === id && s.expiresAt > now());
  async function save(next) {
    let timer;
    try {
      await Promise.race([store.save(next), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('checkpoint timeout')), checkpointTimeoutMs);
      })]);
      state = next;
    } catch (error) {
      const known = ['checkpoint timeout', 'Latest rehearsal checkpoint was not verified', 'Rehearsal checkpoint not confirmed'];
      console.warn('[rehearsal] Checkpoint unavailable:', known.includes(error.message) ? error.message : error.name || 'storage error');
      failed = true; sessions.clear(); challenges.clear(); frames.clear();
      for (const room of state?.rooms || []) void transport.close(booking(room)).catch(() => {});
      throw new LiveAudioError('Rehearsal checkpoint failed; access is closed');
    } finally { clearTimeout(timer); }
  }
  async function initialize() {
    if (!configured || failed) throw new LiveAudioError('Private rehearsal is unavailable');
    if (state) return;
    try {
      state = validateRehearsalState(await store.restore());
      // Passes are memory-only; a restart ends the running session and everyone signs in again.
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
  async function endRoom(id) {
    const next = clone(state); next.rooms.find(r => r.id === id).endedAt = now();
    await save(next);
  }
  async function cleanup() {
    for (const [token, s] of sessions) if (s.expiresAt <= now()) sessions.delete(token);
    for (const room of [...state.rooms]) {
      const peers = connected.get(room.id);
      if (peers) for (const [token, at] of peers) {
        if (now() - at > HEARTBEAT || !sessions.has(token)) peers.delete(token);
      }
      if (!room.endedAt && (room.expiresAt <= now() || !roomSessions(room.id).length)) {
        await endRoom(room.id);
      }
      const endedAt = lookup(room.id)?.endedAt;
      if (!endedAt) continue;
      for (const [token, session] of sessions) if (session.id === room.id) sessions.delete(token);
      frames.delete(room.id); connected.delete(room.id);
      try { await transport.close(booking(room)); }
      catch { continue; }
      // Join tokens can recreate a deleted LiveKit room until their short expiry.
      if (now() - endedAt < 35_000) continue;
      const next = clone(state); next.rooms = next.rooms.filter(r => r.id !== room.id);
      await save(next);
    }
  }
  function auth(token, origin) {
    const s = sessions.get(token), room = s && lookup(s.id);
    if (!s || s.origin !== origin || s.expiresAt <= now() || !active(room) || room.removed?.includes(s.wallet)) {
      throw new LiveAudioError('Your rehearsal pass ended; sign in again to rejoin the room');
    }
    // Activity keeps the pass alive, so nobody is cut off mid-practice.
    s.expiresAt = Math.min(room.expiresAt, now() + SESSION_IDLE);
    return { s, room };
  }
  function people(room, self) {
    const fresh = frames.get(room.id) || new Map(), byWallet = new Map();
    for (const [token, s] of sessions) {
      if (s.id !== room.id || s.expiresAt <= now()) continue;
      const entry = byWallet.get(s.wallet) || { wallet: s.wallet, label: short(s.wallet), role: roleOf(s.wallet, room),
        you: s.wallet === self, connected: false, audioFresh: false };
      entry.connected ||= !!connected.get(room.id)?.has(token);
      entry.audioFresh ||= now() - (fresh.get(`rehearsal:${s.wallet}`) || 0) <= 5000;
      byWallet.set(s.wallet, entry);
    }
    return [...byWallet.values()];
  }
  function publicState(room, self) {
    const list = people(room, self);
    return { kind: 'private-rehearsal', id: room.id, expiresAt: room.expiresAt,
      phase: active(room) ? 'private' : 'ended', people: list,
      privateAudioFresh: list.some(p => p.you && p.audioFresh),
      anyAudioFresh: list.some(p => p.audioFresh),
      notice: 'Private only: no radio, booking, payment, recording or performance credit.' };
  }
  function startMonitor(room) {
    if (monitoring.has(room.id)) return;
    monitoring.add(room.id);
    void transport.monitor(booking(room), frame => {
      if (failed || !active(lookup(room.id)) || !(frame.samples > 0)) return;
      if (!frames.has(room.id)) frames.set(room.id, new Map());
      for (const identity of frame.sources || []) frames.get(room.id).set(identity, now());
    }).catch(error => {
      console.warn('[rehearsal] Independent receiver unavailable:', error.code || error.name || 'transport error');
    }).finally(() => monitoring.delete(room.id));
  }
  return {
    get configured() { return configured && !failed; },
    async eligibility(wallet) {
      if (!configured || failed) throw new LiveAudioError('Private rehearsal is unavailable');
      const who = address(wallet);
      if (!who) throw new LiveAudioError('Connect a valid wallet');
      return { canHost: await canHost(who) };
    },
    async challenge(input, origin) {
      return run(async () => {
        await initialize(); await cleanup();
        const who = address(input.wallet);
        if (!who) throw new LiveAudioError('Connect a valid wallet');
        if (!['enter', 'join', 'practice', 'create'].includes(input.action)) throw new LiveAudioError('Unknown rehearsal action');
        const create = !input.roomId;
        if (create && input.action === 'join') throw new LiveAudioError('Open the complete rehearsal invitation link.');
        if (create && !await canHost(who)) throw new LiveAudioError('Only administrators and performers who accepted a live invitation can start rehearsals. Guests need a room invitation link.');
        const roomId = create ? `rehearsal:${opaque()}` : input.roomId;
        const room = !create && lookup(roomId);
        if (!create && (!/^rehearsal:[0-9a-f]{64}$/.test(roomId) || !active(room))) {
          throw new LiveAudioError('This rehearsal invitation expired or the room closed. Ask the host for a new link.');
        }
        if (room?.removed?.includes(who)) throw new LiveAudioError('The host or engineer removed this wallet from this rehearsal');
        for (const [key, c] of challenges) if (c.expiresAt <= now()) challenges.delete(key);
        if (challenges.size >= 128) throw new LiveAudioError('Too many rehearsal challenges');
        const id = opaque(), expiresAt = now() + 120_000;
        const message = ['DecentBusking PRIVATE REHEARSAL ROOM sign-in', `Room: ${roomId}`, `Action: ${create ? 'create' : 'join'}`,
          `Wallet: ${who}`, `Role: ${create && !engineers.has(who) ? 'host' : roleOf(who, room)}`,
          `Origin: ${origin}`, `Nonce: ${id}`, `Challenge expires: ${new Date(expiresAt).toISOString()}`, CONSENT].join('\n');
        challenges.set(id, { who, origin, message, expiresAt, roomId, create });
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
        if (sessions.size >= 64) throw new LiveAudioError('Rehearsal session limit reached');
        let room = lookup(c.roomId);
        if (c.create) {
          if (!await canHost(c.who)) throw new LiveAudioError('This wallet is no longer eligible to host.');
          if (state.rooms.length >= 100) throw new LiveAudioError('Rehearsal room limit reached; wait for old rooms to close.');
          room = { id: c.roomId, host: c.who, expiresAt: now() + REHEARSAL_MAX_DURATION, endedAt: 0, removed: [] };
          const next = clone(state); next.rooms.push(room); await save(next); room = lookup(room.id);
        }
        if (!active(room)) throw new LiveAudioError('This rehearsal closed while you were signing. Ask the host for a new link.');
        if (room.removed?.includes(c.who)) throw new LiveAudioError('The host or engineer removed this wallet from this rehearsal');
        const wallets = new Set(roomSessions(room.id).map(s => s.wallet));
        if (!wallets.has(c.who) && wallets.size >= REHEARSAL_MAX_PEOPLE) {
          throw new LiveAudioError(`The rehearsal room is full (${REHEARSAL_MAX_PEOPLE} people)`);
        }
        const token = opaque(), expiresAt = Math.min(room.expiresAt, now() + SESSION_IDLE);
        sessions.set(token, { id: room.id, wallet: c.who, origin, expiresAt });
        return { token, role: roleOf(c.who, room), wallet: c.who, expiresAt, state: publicState(room, c.who) };
      });
    },
    async command(token, input, origin) {
      return run(async () => {
        await initialize(); await cleanup();
        const { s, room } = auth(token, origin);
        if (input.action === 'state') {
          if (connected.get(room.id)?.has(token)) connected.get(room.id).set(token, now());
          return publicState(room, s.wallet);
        }
        if (input.action === 'connect') {
          const grant = await transport.rehearsalConnect(booking(room), s.wallet, input.publish === true);
          if (!connected.has(room.id)) connected.set(room.id, new Map());
          connected.get(room.id).set(token, now()); startMonitor(room);
          return grant;
        }
        if (input.action === 'leave') {
          connected.get(room.id)?.delete(token);
          return { left: true };
        }
        if (input.action === 'exit') {
          sessions.delete(token); connected.get(room.id)?.delete(token);
          await cleanup();
          return { exited: true };
        }
        if (input.action === 'end' && canManage(s.wallet, room) && input.confirmed === true) {
          await endRoom(room.id); await cleanup();
          return { ...publicState({ ...room, endedAt: now() }, s.wallet), phase: 'ended' };
        }
        if (input.action === 'remove' && canManage(s.wallet, room)) {
          const target = address(input.wallet);
          if (!target || target === s.wallet || engineers.has(target)) throw new LiveAudioError('Choose another non-engineer person to remove');
          const next = clone(state), stored = next.rooms.find(r => r.id === room.id);
          stored.removed = [...new Set([...(stored.removed || []), target])].slice(0, 64);
          await save(next);
          for (const [key, other] of sessions) if (other.id === room.id && other.wallet === target) {
            sessions.delete(key); connected.get(room.id)?.delete(key);
          }
          try {
            if (!transport.rehearsalRemove) throw Error('Participant removal unavailable');
            await transport.rehearsalRemove(booking(room), target);
          } catch {
            throw new LiveAudioError('New access is blocked, but active audio removal was not confirmed. Close this rehearsal for everyone if audio remains.');
          }
          return publicState(lookup(room.id), s.wallet);
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
