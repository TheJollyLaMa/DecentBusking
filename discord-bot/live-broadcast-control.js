import { createHash } from 'node:crypto';
import { MAX_LIVE_ENCORE_MS, liveBroadcastTiming, validateLiveAllocation } from '../js/live-broadcast.mjs';
import { LiveDirectionError } from './live-direction.js';

const fail = message => { throw new LiveDirectionError('BROADCAST_CONFLICT', message, 409); };
const fields = {
  'broadcast-enable': [],
  'broadcast-reserve-next': ['nextBookingId', 'nextToken', 'expectedNextRevision'],
  'broadcast-encore': ['additionalMs', 'nextToken'],
  'broadcast-choice': ['choice', 'durationMs'],
  'broadcast-finished': [],
  'broadcast-end': ['mode', 'confirmed'],
  'broadcast-take': ['confirmed'],
};

export function planBroadcastCommand({ state, booking, partner, bookings, command, wallet, owner,
  now, audioFresh, ready, outroSeconds = () => 300, earlyTake = false }) {
  if (!Object.hasOwn(fields, command.action) || Object.keys(command).some(k =>
    !['action', 'commandId', 'expectedRevision', ...fields[command.action]].includes(k)) ||
      !/^[a-zA-Z0-9:_-]{8,100}$/.test(command.commandId || '') ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) fail('Invalid broadcast command');
  const next = structuredClone(state);
  const room = next.rooms.find(r => r.bookingId === booking.id);
  if (!room) fail('Booking backstage must be authorized first');
  const performerAction = ['broadcast-choice', 'broadcast-finished'].includes(command.action);
  if (performerAction ? wallet !== booking.wallet.toLowerCase() : wallet !== owner) {
    throw new LiveDirectionError('BROADCAST_FORBIDDEN', 'This broadcast action is not allowed for your booking role', 403);
  }
  const { nextToken, ...safeCommand } = command;
  const hash = createHash('sha256').update(JSON.stringify({ wallet, command: safeCommand })).digest('hex');
  const previous = room.broadcastCommands?.find(c => c.id === command.commandId);
  if (previous) {
    if (previous.hash !== hash) fail('Broadcast command ID was already used for a different decision');
    return { duplicate: true, next: state };
  }
  if (command.expectedRevision !== (room.allocation?.revision || 0)) fail('Broadcast changed; refresh before deciding');
  if ((room.broadcastCommands?.length || 0) >= 128) fail('Broadcast decision limit reached for this booking');
  const duration = b => Date.parse(b.endUtc) - Date.parse(b.startUtc);
  function allocate(r, b, queued = false) {
    if (r.allocation) return r.allocation;
    if (now >= Date.parse(b.endUtc) || r.cancelledAt) fail('An ended original booking cannot be reopened without an earlier allocation');
    r.allocation = { id: `allocation:${createHash('sha256').update(`${command.commandId}:${b.id}`).digest('hex')}`, revision: 0,
      plannedStartAt: Date.parse(b.startUtc), startedAt: !queued && r.armed && now >= Date.parse(b.startUtc) ? Date.parse(b.startUtc) : null,
      endedAt: null, endReason: null, durationMs: duration(b), encoreMs: 0,
      choice: queued ? 'pending' : 'contracted', choiceAt: null, previousBookingId: null, nextBookingId: null,
      delayNotifiedAt: null, finishedId: null, finishedAt: null, priorityFollowup: false };
    return r.allocation;
  }
  if (!room.allocation && !['broadcast-enable', 'broadcast-reserve-next'].includes(command.action)) fail('Enable this broadcast allocation first');
  const a = allocate(room, booking);
  if (a.endedAt || room.cancelledAt) fail('This broadcast has already ended');
  const t = liveBroadcastTiming(booking, room);
  if (a.startedAt && now >= t.authorizedEndAt) fail('Broadcast authorization has expired; it cannot be reopened');
  let changedPartner;
  function updatePartner() {
    if (!a.nextBookingId) return;
    const b = bookings.find(b => b.id === a.nextBookingId), r = next.rooms.find(r => r.bookingId === a.nextBookingId);
    if (!b || !r?.allocation) fail('Paired next booking is unavailable');
    if (r.allocation.endedAt || r.allocation.startedAt) return;
    r.allocation.plannedStartAt = Math.max(Date.parse(b.startUtc),
      (a.endedAt ?? liveBroadcastTiming(booking, room).authorizedEndAt) + outroSeconds(booking) * 1000);
    r.allocation.delayNotifiedAt = now;
    r.allocation.revision++;
    changedPartner = r;
  }
  switch (command.action) {
    case 'broadcast-enable':
      if (command.expectedRevision !== 0) fail('This broadcast is already allocated');
      break;
    case 'broadcast-reserve-next': {
      if (!partner || partner.id !== command.nextBookingId || partner.id === booking.id ||
          Date.parse(partner.startUtc) < Date.parse(booking.startUtc)) fail('Authorize the exact next booking separately');
      const other = next.rooms.find(r => r.bookingId === partner.id);
      if (!other || (other.allocation?.revision || 0) !== command.expectedNextRevision) fail('Next booking changed; refresh its owner pass');
      if (a.nextBookingId && a.nextBookingId !== partner.id || a.previousBookingId) fail('Only this current act and one explicitly selected next act are supported');
      const n = allocate(other, partner, true);
      if (n.startedAt || n.endedAt || n.nextBookingId || n.previousBookingId && n.previousBookingId !== booking.id) fail('Next act is already allocated elsewhere');
      a.nextBookingId = partner.id;
      n.previousBookingId = booking.id;
      updatePartner();
      break;
    }
    case 'broadcast-encore':
      if (!a.startedAt || !Number.isSafeInteger(command.additionalMs) || command.additionalMs <= 0 ||
          a.encoreMs + command.additionalMs > MAX_LIVE_ENCORE_MS) fail('Approve at most ten cumulative encore minutes for this allocated set');
      if (a.nextBookingId && partner?.id !== a.nextBookingId) fail('The next booking owner pass is required to issue its delay notice');
      a.encoreMs += command.additionalMs;
      a.finishedAt = null; a.finishedId = null;
      updatePartner();
      break;
    case 'broadcast-choice':
      if (a.startedAt || !['decline', 'short', 'full'].includes(command.choice)) fail('Choose participation before the producer takes this act live');
      if (command.choice === 'short' && (!Number.isSafeInteger(command.durationMs) || command.durationMs <= 0 ||
          command.durationMs >= duration(booking)) || command.choice !== 'short' && command.durationMs !== undefined) fail('Choose a positive shortened duration below the contracted length');
      a.choice = command.choice; a.choiceAt = now;
      a.durationMs = command.choice === 'short' ? command.durationMs : duration(booking);
      if (command.choice === 'decline') { a.endedAt = now; a.endReason = 'declined'; }
      break;
    case 'broadcast-finished':
      if (!a.startedAt) fail('This allocated set has not started');
      a.finishedAt = now; a.finishedId = command.commandId;
      break;
    case 'broadcast-end':
      if (!a.startedAt || command.confirmed !== true || !['normal', 'operator-cut'].includes(command.mode)) fail('Confirm ending this live allocation explicitly');
      if (command.mode === 'normal' && !a.finishedAt) fail('Wait for the performer finished declaration or explicitly choose operator cut');
      a.endedAt = now; a.endReason = command.mode === 'normal' ? 'producer-finished' : 'operator-cut';
      a.priorityFollowup = !!a.previousBookingId && a.startedAt > Date.parse(booking.startUtc) &&
        a.choice === 'short' && a.endedAt - a.startedAt < duration(booking);
      updatePartner();
      break;
    case 'broadcast-take': {
      if (command.confirmed !== true || a.startedAt || !['contracted', 'short', 'full'].includes(a.choice) ||
          !earlyTake && now < Date.parse(booking.startUtc) || !room.armed || !room.checks.t60 || !room.checks.t15 ||
          !audioFresh || !ready) fail('Take requires the chosen, ready, soundchecked performer and fresh verified audio');
      if (a.previousBookingId) {
        const prior = next.rooms.find(r => r.bookingId === a.previousBookingId);
        if (!prior?.allocation?.endedAt && !prior?.cancelledAt) fail('End the previous act before taking this performer');
      }
      if (next.rooms.some(r => r.bookingId !== booking.id && r.allocation?.startedAt && !r.allocation.endedAt && !r.cancelledAt)) fail('Another allocated act is still live');
      a.startedAt = now;
      break;
    }
  }
  a.revision++;
  const paired = new Set([booking.id, a.previousBookingId, a.nextBookingId].filter(Boolean));
  const affected = next.rooms.filter(r => paired.has(r.bookingId) && r.allocation && !r.allocation.endedAt);
  for (const r of affected) {
    const b = bookings.find(b => b.id === r.bookingId), range = liveBroadcastTiming(b, r);
    for (const other of bookings) {
      if (!paired.has(other.id) && !other.cancelled && ['funded', 'approved', 'paid'].includes(other.status) &&
          Date.parse(other.startUtc) < range.authorizedEndAt && Date.parse(other.endUtc) > (range.actualStartedAt ?? range.plannedStartAt)) {
        fail('Unsupported third-booking conflict; no other contracted start was moved');
      }
    }
  }
  if (next.rooms.filter(r => r.allocation?.startedAt && !r.allocation.endedAt && !r.cancelledAt).length > 1) fail('Only one canonical broadcast may be active');
  validateLiveAllocation(a);
  if (changedPartner) validateLiveAllocation(changedPartner.allocation);
  room.broadcastCommands ||= [];
  room.broadcastCommands.push({ id: command.commandId, hash });
  return { duplicate: false, next };
}
