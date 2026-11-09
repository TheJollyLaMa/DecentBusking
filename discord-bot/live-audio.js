import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { verifyMessage } from 'ethers';
import { liveAudioPolicy, LIVE_AUDIO_GRACE_MS, LIVE_AUDIO_FRESH_MS } from '../js/live-audio.mjs';
import { LiveAudioError } from './live-audio-errors.js';

const clone = value => JSON.parse(JSON.stringify(value));
const address = value => /^0x[0-9a-f]{40}$/i.test(value || '') ? value.toLowerCase() : '';
const opaque = () => randomBytes(32).toString('hex');
const START_EARLY_MS = 70 * 60_000;

export function createLiveAudioFileStore(path) {
  if (!path) return null;
  return {
    async restore() {
      try { return JSON.parse(await readFile(path, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return { version: 1, rooms: [] }; throw error; }
    },
    async save(value) {
      await writeFile(`${path}.next`, JSON.stringify(value), { mode: 0o600 });
      await rename(`${path}.next`, path);
    },
  };
}

export function createLiveAudioService({ getBookings, ownerWallet, transport, store, onPolicy = () => {},
  onCancel, now = () => Date.now(), verify = verifyMessage, checkpointTimeoutMs = 10_000 } = {}) {
  const owner = address(ownerWallet);
  const challenges = new Map(), sessions = new Map(), frames = new Map(), reservations = new Map();
  const monitoring = new Set(), closed = new Set(), restoredAt = new Map(), closing = new Set(), notifying = new Set();
  let state = null, failed = false, tail = Promise.resolve(), bookings = [], checkedAt = -Infinity;
  let bookingRefresh, bookingsLoaded = false;
  const configured = !!owner && !!store && transport?.ready === true;
  const run = fn => {
    const task = tail.then(fn);
    tail = task.catch(() => {});
    return task;
  };
  async function initialize() {
    if (!configured || failed) throw new LiveAudioError('Live audio unavailable: hosting and durable room state must be configured');
    if (state) return;
    const restored = await store.restore();
    if (restored?.version !== 1 || !Array.isArray(restored.rooms) ||
        restored.rooms.some(r => typeof r.bookingId !== 'string' || typeof r.armed !== 'boolean' ||
          !r.checks || typeof r.checks !== 'object' ||
          [r.lastVerifiedAt || 0, r.lossSince || 0].some(at => !Number.isFinite(at) || at < 0) ||
          r.cancelledAt && (!Number.isFinite(r.cancelledAt) || !r.reason))) throw new LiveAudioError('Invalid live audio checkpoint');
    state = restored;
    for (const record of state.rooms) restoredAt.set(record.bookingId, now());
  }
  async function save(next) {
    let timer;
    try {
      await Promise.race([
        store.save(next),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Live audio checkpoint deadline exceeded')), checkpointTimeoutMs);
        }),
      ]);
      state = next;
    }
    catch {
      failed = true; sessions.clear(); frames.clear();
      for (const b of bookings.filter(item => recordFor(item.id))) void transport.close(b).catch(() => {});
      throw new LiveAudioError('Live audio checkpoint failed; room controls are closed');
    }
    finally { clearTimeout(timer); }
  }
  async function readBookings(force = false) {
    if (!bookingRefresh && (force || now() - checkedAt > 10_000)) {
      try {
        bookingRefresh = Promise.resolve(getBookings()).then(result => {
          bookings = Array.isArray(result) ? result : result.bookings || [];
          checkedAt = now(); bookingsLoaded = true;
        }).catch(() => {}).finally(() => { bookingRefresh = null; });
      } catch { /* Booking verification remains unavailable until a successful refresh. */ }
    }
    // RPC/indexing must never hold the serialized media watchdog behind an external request.
    await Promise.resolve();
    if (!bookingsLoaded || (force && now() - checkedAt > 30_000)) {
      throw new LiveAudioError('Live booking verification unavailable; retry when the booking service has refreshed');
    }
    return bookings;
  }
  async function findBooking(id, force = false) {
    const b = (await readBookings(force)).find(item => item.id === id);
    if (!b || !address(b.wallet) || !Number.isFinite(Date.parse(b.startUtc)) ||
        !Number.isFinite(Date.parse(b.endUtc))) throw new LiveAudioError('Live booking unavailable');
    return b;
  }
  function funded(b) {
    if (b.status !== 'funded' || b.cancelled || b.acknowledged !== true || b.payoutPolicy !== 'pilot-guaranteed-v1') {
      throw new LiveAudioError('Live audio requires this acknowledged, funded, uncancelled guaranteed-pilot booking');
    }
  }
  function windowOpen(b) {
    funded(b);
    if (now() < Date.parse(b.startUtc) - START_EARLY_MS || now() >= Date.parse(b.endUtc)) {
      throw new LiveAudioError('Room opens at T−70 minutes and closes at the booked end');
    }
  }
  function recordFor(id) { return state?.rooms.find(r => r.bookingId === id); }
  function publicState(b, record, privateView = false) {
    const policy = liveAudioPolicy(record, b, now());
    const currentFrame = frames.get(b.id) || 0;
    const phase = record?.cancelledAt ? 'cancelled'
      : now() >= Date.parse(b.endUtc) ? 'ended'
        : now() >= Date.parse(b.startUtc) && record?.armed ? 'live' : 'preflight';
    const fresh = currentFrame > 0 && now() - currentFrame <= LIVE_AUDIO_FRESH_MS;
    return { configured: configured && !failed, serverTime: now(), bookingId: b.id, title: b.title,
      startUtc: b.startUtc, endUtc: b.endUtc, phase, armed: !!record?.armed,
      status: phase === 'live' ? fresh ? 'ON-AIR' : 'RECONNECTING' : 'OFF-AIR',
      verifiedAudioAt: phase === 'live' && currentFrame ? new Date(currentFrame).toISOString() : null,
      reason: record?.reason || '', policy, ingressEnabled: transport.ingressEnabled,
      listenerLimit: 10, discordParity: 'Website audio only; Discord live relay is not enabled',
      ...(privateView ? { checks: record?.checks || {}, privateAudioFresh: fresh,
        targets: { t60: new Date(Date.parse(b.startUtc) - 60 * 60_000).toISOString(),
          t15: new Date(Date.parse(b.startUtc) - 15 * 60_000).toISOString() } } : {}) };
  }
  function auth(token, origin) {
    const session = sessions.get(token);
    if (!session || session.origin !== origin || session.expiresAt <= now()) throw new LiveAudioError('Room authorization expired; reconnect your wallet');
    return session;
  }
  function startMonitor(b) {
    if (monitoring.has(b.id) || closed.has(b.id)) return;
    monitoring.add(b.id);
    void transport.monitor(b, frame => {
      if (!closed.has(b.id) && !recordFor(b.id)?.cancelledAt && frame.samples > 0) frames.set(b.id, now());
    }).catch(() => {}).finally(() => monitoring.delete(b.id));
  }
  async function cancel(b, reason) {
    const record = recordFor(b.id);
    if (record.cancelledAt) return;
    const next = clone(state), r = next.rooms.find(item => item.bookingId === b.id);
    r.cancelledAt = now(); r.reason = reason; r.armed = false; r.cancelNoticePending = true;
    await save(next);
    frames.delete(b.id);
    for (const [token, session] of sessions) if (session.bookingId === b.id) sessions.delete(token);
    onPolicy(liveAudioPolicy(r, b, now()));
  }
  async function cleanup(b) {
    if (closed.has(b.id) || closing.has(b.id)) return;
    closing.add(b.id);
    try { await transport.close(b); closed.add(b.id); }
    catch { /* Retry cleanup; listener grants are already closed and the public player is off-air. */ }
    finally { closing.delete(b.id); }
  }
  function notifyCancellation(b, reason) {
    if (!onCancel || notifying.has(b.id)) return;
    notifying.add(b.id);
    void Promise.resolve().then(() => onCancel(b, reason)).then(() => run(async () => {
      const next = clone(state);
      next.rooms.find(r => r.bookingId === b.id).cancelNoticePending = false;
      await save(next);
    })).catch(() => {}).finally(() => notifying.delete(b.id));
  }
  async function tickInternal() {
    await initialize();
    await readBookings();
    const newRooms = bookings.filter(b => b.payoutPolicy === 'pilot-guaranteed-v1' && b.status === 'funded' &&
      b.acknowledged === true && !b.cancelled && !recordFor(b.id) &&
      now() >= Date.parse(b.startUtc) - START_EARLY_MS && now() < Date.parse(b.endUtc));
    if (newRooms.length) {
      const next = clone(state);
      next.rooms.push(...newRooms.map(b => ({ bookingId: b.id, armed: false, checks: {}, lastVerifiedAt: 0 })));
      await save(next);
    }
    let activePolicy = null;
    for (const record of [...state.rooms]) {
      const b = bookings.find(item => item.id === record.bookingId);
      if (!b) continue;
      const start = Date.parse(b.startUtc), end = Date.parse(b.endUtc);
      if (!record.cancelledAt && now() < end && now() >= start - START_EARLY_MS) {
        if (b.cancelled || b.status !== 'funded') await cancel(b, 'Live performance cancelled: booking is no longer available.');
        else {
          const last = frames.get(b.id) || 0;
          const fresh = last > 0 && now() - last <= LIVE_AUDIO_FRESH_MS;
          let lossSince = record.lossSince || 0;
          if (record.armed && fresh) {
            if (lossSince) {
              const next = clone(state);
              Object.assign(next.rooms.find(r => r.bookingId === b.id), { lastVerifiedAt: last, lossSince: 0 });
              await save(next);
            } else {
              // Healthy packet times are memory-only; durable writes are lifecycle transitions.
              record.lastVerifiedAt = last;
            }
            lossSince = 0;
            restoredAt.delete(b.id);
          } else if (record.armed && !fresh && !lossSince && now() >= start) {
            // A healthy checkpoint is not evidence that packets stopped at that old timestamp.
            lossSince = Math.max(start, last || restoredAt.get(b.id) || start);
            const next = clone(state);
            next.rooms.find(r => r.bookingId === b.id).lossSince = lossSince;
            await save(next);
          }
          const baseline = record.armed ? lossSince || now() : start;
          const rejoinProbe = record.armed && restoredAt.has(b.id) && now() - restoredAt.get(b.id) < LIVE_AUDIO_FRESH_MS;
          if ((now() >= start && !fresh && !rejoinProbe && now() - baseline >= LIVE_AUDIO_GRACE_MS) ||
              (!record.armed && now() - start >= LIVE_AUDIO_GRACE_MS)) {
            await cancel(b, record.armed
              ? 'Live performance cancelled: no verified delivered audio for 60 seconds. Performer fee is unchanged.'
              : 'Live performance cancelled: the slot was not armed within 60 seconds. Performer fee is unchanged.');
          } else startMonitor(b);
        }
      }
      const updated = recordFor(b.id);
      if (updated.cancelledAt || now() >= end) {
        void cleanup(b);
        if (updated.cancelNoticePending) notifyCancellation(b, updated.reason);
      }
      const policy = liveAudioPolicy(updated, b, now());
      if (policy && (!activePolicy || policy.mode === 'live')) activePolicy = policy;
    }
    onPolicy(activePolicy);
    return activePolicy;
  }
  return {
    get configured() { return configured && !failed; },
    async challenge({ bookingId, wallet }, origin) {
      return run(async () => {
        await initialize();
        const b = await findBooking(bookingId, true);
        const who = address(wallet);
        if (!who || (who !== owner && who !== address(b.wallet))) throw new LiveAudioError('Only this booking performer or configured owner may enter backstage');
        windowOpen(b);
        for (const [key, c] of challenges) if (c.expiresAt <= now()) challenges.delete(key);
        if (challenges.size >= 128) throw new LiveAudioError('Too many room challenges; retry shortly');
        const id = opaque(), expiresAt = now() + 120_000;
        const message = ['DecentBusking live audio room authorization', `Booking: ${b.id}`, `Wallet: ${who}`,
          `Origin: ${origin}`, `Nonce: ${id}`, `Expires: ${new Date(expiresAt).toISOString()}`,
          'Audio room access only. No transaction, recording, payout or financial authorization.'].join('\n');
        challenges.set(id, { bookingId, who, origin, message, expiresAt });
        return { challengeId: id, message };
      });
    },
    async authorize({ challengeId, signature }, origin) {
      return run(async () => {
        await initialize();
        const c = challenges.get(challengeId);
        if (!c || c.origin !== origin || c.expiresAt <= now()) throw new LiveAudioError('Room challenge expired or already used');
        if (address(verify(c.message, signature)) !== c.who) throw new LiveAudioError('Room signature does not match the booking wallet');
        challenges.delete(challengeId);
        const b = await findBooking(c.bookingId, true);
        windowOpen(b);
        if (recordFor(b.id)?.cancelledAt) throw new LiveAudioError('This live room has been cancelled and cannot reopen');
        if (!recordFor(b.id)) {
          const next = clone(state);
          next.rooms.push({ bookingId: b.id, armed: false, checks: {}, lastVerifiedAt: 0 });
          await save(next);
        }
        const token = opaque(), role = c.who === owner ? 'owner' : 'publisher';
        for (const [key, session] of sessions) if (session.expiresAt <= now()) sessions.delete(key);
        if (sessions.size >= 32) throw new LiveAudioError('Room session limit reached');
        sessions.set(token, { bookingId: b.id, wallet: c.who, role, origin, expiresAt: Date.parse(b.endUtc) });
        startMonitor(b);
        return { token, role, canPublish: c.who === address(b.wallet), state: publicState(b, recordFor(b.id), true) };
      });
    },
    async command(token, command, origin) {
      return run(async () => {
        await initialize();
        const session = auth(token, origin), b = await findBooking(session.bookingId, !['state', 'cancel'].includes(command.action));
        const record = recordFor(b.id);
        if (command.action === 'state') return publicState(b, record, true);
        windowOpen(b);
        if (record.cancelledAt) throw new LiveAudioError('This room is cancelled');
        if (command.action === 'connect') {
          if (command.publish === true && session.wallet !== address(b.wallet)) {
            throw new LiveAudioError('Only the booked performer may publish audio');
          }
          return transport.connect(b, command.publish === true ? 'publisher' : 'owner');
        }
        if (command.action === 'obs') {
          if (session.wallet !== address(b.wallet)) throw new LiveAudioError('Only the booked performer may obtain OBS credentials');
          return transport.obs(b);
        }
        if (session.role !== 'owner') throw new LiveAudioError('Only the configured owner controls the public room');
        if (command.action === 'cancel') {
          if (command.confirmed !== true) throw new LiveAudioError('Confirm cancellation explicitly');
          await cancel(b, 'Live performance cancelled by the operator. Performer fee is unchanged.');
          void cleanup(b);
          return publicState(b, recordFor(b.id), true);
        }
        if (command.action === 'check') {
          const beforeStart = Date.parse(b.startUtc) - now();
          const valid = command.check === 't60' ? beforeStart >= 40 * 60_000 && beforeStart <= 70 * 60_000
            : command.check === 't15' && beforeStart > 0 && beforeStart <= 25 * 60_000;
          if (!valid || command.confirmed !== true) throw new LiveAudioError('Confirm the matching T−60/T−15 private listening check in its window');
          if (!frames.get(b.id) || now() - frames.get(b.id) > LIVE_AUDIO_FRESH_MS) throw new LiveAudioError('No fresh audio has reached the independent worker receiver');
          const next = clone(state);
          next.rooms.find(r => r.bookingId === b.id).checks[command.check] = new Date(now()).toISOString();
          await save(next);
        } else if (command.action === 'arm') {
          if (!record.checks.t60 || !record.checks.t15 || now() >= Date.parse(b.startUtc)) {
            throw new LiveAudioError('Both private soundchecks must pass before arming the scheduled slot');
          }
          const next = clone(state); next.rooms.find(r => r.bookingId === b.id).armed = true;
          await save(next);
        } else throw new LiveAudioError('Unknown room action');
        return publicState(b, recordFor(b.id), true);
      });
    },
    async state(bookingId) {
      if (!configured || failed) return { configured: false, status: 'OFF-AIR', phase: 'unavailable',
        reason: 'Live audio hosting and durable room state are not configured' };
      return run(async () => { await initialize(); const b = await findBooking(bookingId); return publicState(b, recordFor(b.id)); });
    },
    async current() {
      if (!configured || failed) return null;
      return run(async () => {
        await initialize(); await readBookings();
        const live = bookings.findLast(item => liveAudioPolicy(recordFor(item.id), item, now())?.mode === 'live');
        const b = live || bookings.find(item => {
          const p = liveAudioPolicy(recordFor(item.id), item, now());
          return p && p.mode !== 'radio' || recordFor(item.id) && !recordFor(item.id).cancelledAt &&
            now() >= Date.parse(item.startUtc) - 15_000 && now() < Date.parse(item.startUtc);
        });
        return b ? publicState(b, recordFor(b.id)) : null;
      });
    },
    async listener(bookingId) {
      return run(async () => {
        await initialize();
        const b = await findBooking(bookingId, true), record = recordFor(b.id);
        funded(b);
        if (!record?.armed || record.cancelledAt || now() < Date.parse(b.startUtc) || now() >= Date.parse(b.endUtc)) {
          throw new LiveAudioError('Public listening is unavailable; soundchecks are private');
        }
        for (const [id, at] of reservations) if (at <= now()) reservations.delete(id);
        if (reservations.size >= 10) throw new LiveAudioError('Pilot listener admission busy; retry in 30 seconds');
        const result = await transport.listener(b);
        reservations.set(opaque(), now() + 30_000);
        return result;
      });
    },
    tick: () => run(tickInternal),
    stop: () => transport?.stop?.(),
  };
}
