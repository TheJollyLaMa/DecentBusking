import { createHash } from 'node:crypto';
import { MAX_LIVE_RECOVERY_HOLD_MS, liveRecoveryDeadline, validateLiveRecovery } from '../js/live-recovery.mjs';
import { LiveDirectionError } from './live-direction.js';

const fields = {
  'broadcast-recovery-hold': ['additionalMs'],
  'broadcast-recovery-filler': ['mode', 'confirmed'],
  'broadcast-recovery-return': ['confirmed'],
};
const fail = message => { throw new LiveDirectionError('BROADCAST_CONFLICT', message, 409); };

// Receipts share the existing booking-scoped broadcast journal; no sessions or client deadlines are stored.
export function planRecoveryCommand({ state, booking, command, wallet, owner, now, graceMs, endAt, audioFresh, ready }) {
  if (wallet !== owner) throw new LiveDirectionError('BROADCAST_FORBIDDEN', 'Only the configured producer may authorize recovery', 403);
  if (!Object.hasOwn(fields, command.action) || Object.keys(command).some(key =>
    !['action', 'commandId', 'expectedRevision', ...fields[command.action]].includes(key)) ||
      !/^[a-zA-Z0-9:_-]{8,100}$/.test(command.commandId || '') ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) fail('Invalid recovery command');
  const next = structuredClone(state), room = next.rooms.find(r => r.bookingId === booking.id);
  if (!room || room.cancelledAt || room.allocation?.endedAt || now >= endAt) fail('An ended set cannot be recovered');
  const hash = createHash('sha256').update(JSON.stringify({ wallet, command })).digest('hex');
  const receipt = room.broadcastCommands?.find(c => c.id === command.commandId);
  if (receipt) {
    if (receipt.hash !== hash) fail('Broadcast command ID was already used for a different decision');
    return { duplicate: true, next: state };
  }
  if (command.expectedRevision !== (room.recovery?.revision || 0)) fail('Recovery changed; refresh before deciding');
  if ((room.broadcastCommands?.length || 0) >= 128) fail('Broadcast decision limit reached for this booking');
  const observedDeadline = liveRecoveryDeadline(room, graceMs);
  const deadline = observedDeadline === null ? null : Math.min(observedDeadline, endAt);
  if (!room.armed || !room.lossSince || !deadline || now >= deadline ||
      room.allocation && (!room.allocation.startedAt || room.allocation.finishedAt)) fail('No unfinished set is inside its recovery deadline');
  const recovery = room.recovery ||= { revision: 0, usedMs: 0, deadline: null, filler: null, graceMs };
  if (recovery.deadline === null) recovery.graceMs = graceMs;
  switch (command.action) {
    case 'broadcast-recovery-hold':
      if (!Number.isSafeInteger(command.additionalMs) || command.additionalMs <= 0 ||
          recovery.usedMs + command.additionalMs > MAX_LIVE_RECOVERY_HOLD_MS ||
          deadline + command.additionalMs > endAt) fail('Hold must fit the remaining one-minute cumulative budget and authorized set end');
      recovery.usedMs += command.additionalMs;
      recovery.deadline = deadline + command.additionalMs;
      break;
    case 'broadcast-recovery-filler':
      if (command.confirmed !== true || !['adverts', 'radio'].includes(command.mode)) fail('Explicitly choose commercials or radio');
      recovery.filler = command.mode;
      recovery.deadline = deadline;
      break;
    case 'broadcast-recovery-return':
      if (command.confirmed !== true || !audioFresh || !ready) fail('Return requires explicit performer readiness and fresh independent audio');
      room.lossSince = 0;
      recovery.deadline = null;
      recovery.filler = null;
      break;
  }
  recovery.revision++;
  validateLiveRecovery(recovery, room);
  room.broadcastCommands ||= [];
  room.broadcastCommands.push({ id: command.commandId, hash });
  return { duplicate: false, next };
}
