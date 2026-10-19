import { createHash } from 'node:crypto';

export const WEEKLY_HISTORY_POLICY = 'weekly-history-v1';

export function historyWeek(day) {
  const monday = new Date(`${day}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  return monday.toISOString().slice(0, 10);
}

function weekDays(week) {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(`${week}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

export function contentHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function createWeeklyHistory({ name, tags, timeZone, read, list, upload, remove }) {
  const verified = new Map();
  return async function archive(files, today) {
    const weeks = new Map();
    for (const file of files) {
      const day = file.keyvalues.checkpointDay;
      const week = historyWeek(day);
      if (week >= historyWeek(today)) continue;
      if (!weeks.has(week)) weeks.set(week, new Map());
      const days = weeks.get(week);
      if (!days.has(day)) days.set(day, file);
    }
    for (const [week, filesByDay] of weeks) {
      const signature = JSON.stringify([...filesByDay].map(([day, file]) => [day, file.cid]).sort());
      if (verified.get(week) === signature) continue;
      const archiveName = `${name.replace(/\.json$/, '')}.history-${week}.json`;
      const existing = await list(archiveName);
      const days = new Map();
      let canonical;
      for (const file of existing) {
        const previous = await read(file.cid);
        if (previous.schemaVersion !== 1 || previous.policy !== WEEKLY_HISTORY_POLICY || previous.week !== week ||
          previous.kind !== tags.kind || previous.timeZone !== timeZone || !Array.isArray(previous.days)) {
          throw new Error(`Invalid weekly history ${file.cid}; daily pruning stopped`);
        }
        canonical ||= previous;
        for (const entry of previous.days) {
          if (!weekDays(week).includes(entry.day) || !entry.snapshot ||
            entry.snapshot._checkpoint?.policy !== 'daily-v1' || entry.snapshot._checkpoint.day !== entry.day ||
            entry.snapshot._checkpoint.timeZone !== timeZone ||
            !Number.isFinite(Date.parse(entry.snapshot._checkpoint.savedAt)) ||
            contentHash(entry.snapshot) !== entry.sha256) {
            throw new Error(`Invalid archived day in ${file.cid}; daily pruning stopped`);
          }
          if (new Set(previous.days.map(entry => entry.day)).size !== previous.days.length ||
            JSON.stringify(previous.missingDays) !== JSON.stringify(weekDays(week).filter(day =>
              !previous.days.some(entry => entry.day === day)))) {
            throw new Error(`Invalid weekly history coverage in ${file.cid}; daily pruning stopped`);
          }
          if (!days.has(entry.day)) days.set(entry.day, entry);
        }
      }
      let changed = !existing.length || contentHash([...days.values()].sort((a, b) => a.day.localeCompare(b.day))) !==
        contentHash(canonical.days);
      for (const [day, file] of filesByDay) {
        if (days.get(day)?.sourceSnapshotUri === `ipfs://${file.cid}`) continue;
        const snapshot = await read(file.cid);
        if (snapshot._checkpoint?.day !== day || snapshot._checkpoint?.policy !== 'daily-v1' ||
          snapshot._checkpoint?.timeZone !== timeZone || !Number.isFinite(Date.parse(snapshot._checkpoint.savedAt))) {
          throw new Error(`Invalid daily history ${file.cid}`);
        }
        if (days.has(day) && Date.parse(days.get(day).snapshot._checkpoint.savedAt) > Date.parse(snapshot._checkpoint.savedAt)) continue;
        days.set(day, { day, sourceSnapshotUri: `ipfs://${file.cid}`, sha256: contentHash(snapshot), snapshot });
        changed = true;
      }
      if (changed) {
        const archive = { schemaVersion: 1, policy: WEEKLY_HISTORY_POLICY, kind: tags.kind, week, timeZone,
          missingDays: weekDays(week).filter(day => !days.has(day)),
          days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)) };
        const cid = await upload(archiveName, archive, week);
        const fetched = await read(cid);
        if (contentHash(fetched) !== contentHash(archive)) {
          throw new Error(`Weekly history verification failed for ${cid}; daily pruning stopped`);
        }
        const published = await list(archiveName);
        if (!published.some(file => file.cid === cid)) {
          throw new Error('Verified weekly history is not listed yet; daily pruning stopped');
        }
        for (const file of published) if (file.cid !== cid) await remove(file);
      } else {
        // Only exact-policy predecessors are replaced; legacy weekly files remain untouched.
        for (const file of existing) if (file.cid !== existing[0].cid) await remove(file);
      }
      verified.set(week, signature);
    }
    // Keep only the weeks still represented in the rolling window in memory.
    for (const week of verified.keys()) if (!weeks.has(week)) verified.delete(week);
  };
}

export function stateHistoryEvents(kind, value, previous, observedAt) {
  const paidPlayback = kind === 'djuke-journal' || kind.startsWith('devert-paid');
  const fields = kind === 'payment-ledger' ? ['entries'] : kind === 'fund-ledger' ? ['sources', 'payouts'] :
    kind === 'earnings-index' ? ['items'] : paidPlayback ? ['records'] :
      kind === 'devert-main-radio' ? ['impressions', 'adVotes'] : [];
  const identity = entry => entry.txHash ? `${entry.txHash}:${entry.logIndex}` :
    entry.requestId || entry.impressionId || `${entry.radioPlayId}:${entry.voterId}`;
  return fields.flatMap(field => {
    const old = new Map((previous?.[field] || []).map(entry => [identity(entry), entry]));
    return (value?.[field] || []).filter(entry => {
      const prior = old.get(identity(entry));
      return JSON.stringify(prior) !== JSON.stringify(entry);
    }).map(entry => ({
      id: `${kind}:${field}:${contentHash(entry)}`,
      type: field === 'adVotes' ? 'vote' : paidPlayback || field === 'impressions' ? 'playback-transition' : 'financial',
      observedAt, occurredAt: entry.paidAt || entry.recordedAt ||
        (entry.timestamp ? new Date(entry.timestamp * 1000).toISOString() : null),
      source: kind, recordType: field, record: entry,
    }));
  });
}
