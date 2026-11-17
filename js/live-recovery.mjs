export const MAX_LIVE_RECOVERY_HOLD_MS = 60_000;
export const MAX_LIVE_AUDIO_GRACE_MS = 60_000;

export function liveRecoveryDeadline(record, graceMs) {
  return record?.lossSince ? record.recovery?.deadline ?? record.lossSince + graceMs : null;
}

export function validateLiveRecovery(recovery, room) {
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery) ||
      Object.keys(recovery).some(key => !['revision', 'usedMs', 'deadline', 'filler', 'graceMs'].includes(key)) ||
      !Number.isSafeInteger(recovery.revision) || recovery.revision < 1 ||
      !Number.isSafeInteger(recovery.usedMs) || recovery.usedMs < 0 || recovery.usedMs > MAX_LIVE_RECOVERY_HOLD_MS ||
      !Number.isSafeInteger(recovery.graceMs) || recovery.graceMs < 1 || recovery.graceMs > MAX_LIVE_AUDIO_GRACE_MS ||
      ![null, 'adverts', 'radio'].includes(recovery.filler) ||
      !(recovery.deadline === null || Number.isSafeInteger(recovery.deadline) && room.lossSince > 0 &&
        recovery.deadline >= room.lossSince &&
        recovery.deadline <= room.lossSince + recovery.graceMs + recovery.usedMs) ||
      recovery.filler !== null && recovery.deadline === null) {
    throw new Error('Invalid live recovery checkpoint');
  }
  return recovery;
}
