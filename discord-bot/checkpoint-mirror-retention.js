import { checkpointDay } from './ipfs-state.js';

export const MIRROR_RETENTION_POLICY = Object.freeze({ dailyDays: 90 });

/** The checkpoint's own save time; null when it cannot be determined (such pins are never retired). */
export function checkpointSavedAt(snapshot) {
  const value = snapshot?._checkpoint?.savedAt ?? snapshot?.savedAt;
  const epoch = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(epoch) && epoch > 0 ? epoch : null;
}

/**
 * Keeps the latest checkpoint, the latest of each day for `dailyDays` days and the latest of each month forever.
 * `entries` must belong to one store: [{ cid, savedAt }]. Entries without a valid savedAt are always kept.
 */
export function planCheckpointRetention(entries, { now = Date.now(), dailyDays = MIRROR_RETENTION_POLICY.dailyDays } = {}) {
  const today = checkpointDay(now);
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - dailyDays + 1);
  const firstDay = cutoff.toISOString().slice(0, 10);
  const keep = [], superseded = [];
  const dated = [];
  for (const entry of entries) {
    if (Number.isFinite(entry.savedAt) && entry.savedAt > 0 && entry.savedAt <= now) dated.push(entry);
    else keep.push(entry);
  }
  dated.sort((a, b) => b.savedAt - a.savedAt || (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0));
  const days = new Set(), months = new Set();
  for (const [index, entry] of dated.entries()) {
    const day = checkpointDay(entry.savedAt);
    const month = day.slice(0, 7);
    const daily = day >= firstDay && !days.has(day);
    const monthly = !months.has(month);
    days.add(day);
    months.add(month);
    (index === 0 || daily || monthly ? keep : superseded).push(entry);
  }
  return { keep, superseded };
}
