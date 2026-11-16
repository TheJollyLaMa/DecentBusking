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

// Each day is held as canonical UTF-8 JSON bytes, not a parsed tree, and the archive is uploaded as chunks.
function archivedDay(day, sourceSnapshotUri, snapshot, savedAt) {
  const bytes = typeof snapshot === 'string' ? Buffer.from(snapshot) : snapshot;
  return { day, sourceSnapshotUri, sha256: createHash('sha256').update(bytes).digest('hex'), bytes, savedAt };
}

// Concatenated, the chunks are byte-identical to JSON.stringify of the archive object.
function skipSpace(bytes, index) {
  while (index < bytes.length && [0x20, 0x09, 0x0a, 0x0d].includes(bytes[index])) index++;
  return index;
}
function valueEnd(bytes, start) {
  let depth = 0;
  let inString = false;
  for (let index = start; index < bytes.length; index++) {
    const byte = bytes[index];
    if (inString) {
      if (byte === 0x5c) index++;
      else if (byte === 0x22) {
        inString = false;
        if (!depth) return index + 1;
      }
    } else if (!depth && index > start && [0x2c, 0x5d, 0x7d, 0x20, 0x09, 0x0a, 0x0d].includes(byte)) return index;
    else if (byte === 0x22) inString = true;
    else if (byte === 0x7b || byte === 0x5b) depth++;
    else if (byte === 0x7d || byte === 0x5d) {
      if (--depth === 0) return index + 1;
      if (depth < 0) break;
    }
  }
  if (!depth && !inString && start < bytes.length) return bytes.length;
  throw new Error('Malformed JSON');
}
// Walks one JSON object or array, yielding byte ranges so large values need not be parsed together.
function* jsonItems(bytes, start, object) {
  const [open, close] = object ? [0x7b, 0x7d] : [0x5b, 0x5d];
  let index = skipSpace(bytes, start);
  if (bytes[index] !== open) throw new Error('Malformed JSON');
  index = skipSpace(bytes, index + 1);
  if (bytes[index] === close) return index + 1;
  for (;;) {
    let key;
    if (object) {
      if (bytes[index] !== 0x22) throw new Error('Malformed JSON');
      const keyEnd = valueEnd(bytes, index);
      key = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset + index, keyEnd - index).toString());
      index = skipSpace(bytes, keyEnd);
      if (bytes[index] !== 0x3a) throw new Error('Malformed JSON');
      index = skipSpace(bytes, index + 1);
    }
    const end = valueEnd(bytes, index);
    yield { key, value: bytes.subarray(index, end) };
    index = skipSpace(bytes, end);
    if (bytes[index] === close) return index + 1;
    if (bytes[index] !== 0x2c) throw new Error('Malformed JSON');
    index = skipSpace(bytes, index + 1);
  }
}
function jsonMembers(bytes, start = 0, onEnd) {
  const members = new Map();
  const iterator = jsonItems(bytes, start, true);
  for (let step = iterator.next(); ; step = iterator.next()) {
    if (step.done) {
      onEnd?.(step.value);
      return members;
    }
    if (members.has(step.value.key)) throw new Error('Malformed JSON');
    members.set(step.value.key, step.value.value);
  }
}
const parseBytes = bytes => JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString());
function readArchive(bytes) {
  const members = jsonMembers(bytes, 0, end => {
    if (skipSpace(bytes, end) !== bytes.length) throw new Error('Malformed JSON');
  });
  const header = {};
  for (const [key, value] of members) if (key !== 'days') header[key] = parseBytes(value);
  const days = members.get('days');
  if (!days || days[0] !== 0x5b) return { ...header, days: undefined };
  header.days = [...jsonItems(days, 0, false)].map(({ value }) => {
    const entry = {};
    for (const [key, field] of jsonMembers(value)) entry[key] = key === 'snapshot' ? field : parseBytes(field);
    return entry;
  });
  return header;
}
function archiveChunks(header, days) {
  const head = JSON.stringify({ ...header, days: [] });
  return [Buffer.from(head.slice(0, -2)), ...days.flatMap((entry, index) => [
    Buffer.from(`${index ? ',' : ''}{"day":${JSON.stringify(entry.day)},"sourceSnapshotUri":${
      JSON.stringify(entry.sourceSnapshotUri)},"sha256":${JSON.stringify(entry.sha256)},"snapshot":`),
    entry.bytes, Buffer.from('}')]), Buffer.from(']}')];
}

export function createWeeklyHistory({ name, tags, timeZone, readBytes, readVerifiedBytes, readDigest = async cid =>
  createHash('sha256').update(await readBytes(cid)).digest('hex'), list, upload, remove }) {
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
      let canonicalDays;
      for (const file of existing) {
        let previous;
        try {
          previous = readArchive(await readBytes(file.cid));
        } catch {
          throw new Error(`Invalid weekly history ${file.cid}; daily pruning stopped`);
        }
        if (previous.schemaVersion !== 1 || previous.policy !== WEEKLY_HISTORY_POLICY || previous.week !== week ||
          previous.kind !== tags.kind || previous.timeZone !== timeZone || !Array.isArray(previous.days)) {
          throw new Error(`Invalid weekly history ${file.cid}; daily pruning stopped`);
        }
        if (new Set(previous.days.map(entry => entry.day)).size !== previous.days.length ||
          JSON.stringify(previous.missingDays) !== JSON.stringify(weekDays(week).filter(day =>
            !previous.days.some(entry => entry.day === day)))) {
          throw new Error(`Invalid weekly history coverage in ${file.cid}; daily pruning stopped`);
        }
        const entries = [];
        for (const entry of previous.days) {
          let checkpoint;
          try {
            checkpoint = parseBytes(entry.snapshot)?._checkpoint;
          } catch {}
          if (!weekDays(week).includes(entry.day) || !entry.snapshot ||
            checkpoint?.policy !== 'daily-v1' || checkpoint.day !== entry.day || checkpoint.timeZone !== timeZone ||
            !Number.isFinite(Date.parse(checkpoint.savedAt))) {
            throw new Error(`Invalid archived day in ${file.cid}; daily pruning stopped`);
          }
          // Archives embed canonical JSON.stringify bytes, so the stored hash covers the raw slice.
          const archived = archivedDay(entry.day, entry.sourceSnapshotUri, entry.snapshot, checkpoint.savedAt);
          if (archived.sha256 !== entry.sha256) throw new Error(`Invalid archived day in ${file.cid}; daily pruning stopped`);
          entries.push(archived);
        }
        previous = null;
        canonicalDays ||= entries;
        for (const entry of entries) if (!days.has(entry.day)) days.set(entry.day, entry);
      }
      const identity = entries => JSON.stringify(entries.map(entry => [entry.day, entry.sourceSnapshotUri, entry.sha256]));
      let changed = !existing.length ||
        identity([...days.values()].sort((a, b) => a.day.localeCompare(b.day))) !== identity(canonicalDays);
      for (const [day, file] of filesByDay) {
        if (days.get(day)?.sourceSnapshotUri === `ipfs://${file.cid}`) continue;
        // Verified content addressing proves these are the exact canonical bytes uploaded, so they are archived
        // as-is; re-serializing a week of large parsed states is what exhausted worker memory.
        const bytes = await readVerifiedBytes(file.cid);
        const checkpoint = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString())._checkpoint;
        if (checkpoint?.day !== day || checkpoint?.policy !== 'daily-v1' ||
          checkpoint?.timeZone !== timeZone || !Number.isFinite(Date.parse(checkpoint.savedAt))) {
          throw new Error(`Invalid daily history ${file.cid}`);
        }
        if (days.has(day) && Date.parse(days.get(day).savedAt) > Date.parse(checkpoint.savedAt)) continue;
        days.set(day, archivedDay(day, `ipfs://${file.cid}`, bytes, checkpoint.savedAt));
        changed = true;
      }
      if (changed) {
        const chunks = archiveChunks({ schemaVersion: 1, policy: WEEKLY_HISTORY_POLICY, kind: tags.kind, week, timeZone,
          missingDays: weekDays(week).filter(day => !days.has(day)) },
        [...days.values()].sort((a, b) => a.day.localeCompare(b.day)));
        const hash = createHash('sha256');
        for (const chunk of chunks) hash.update(chunk);
        const expected = hash.digest('hex');
        const cid = await upload(archiveName, chunks, week);
        if (await readDigest(cid) !== expected) {
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
  const fields = kind === 'payment-ledger' || kind === 'tip-ledger' ? ['entries'] : kind === 'fund-ledger' ? ['sources', 'payouts'] :
    kind === 'earnings-index' ? ['items'] : paidPlayback ? ['records'] :
      kind === 'devert-main-radio' || kind.startsWith('devert-main-radio-') ? ['impressions', 'adVotes', 'paidPlays'] : [];
  const identity = entry => entry.txHash ? `${entry.txHash}:${entry.logIndex}` :
    entry.requestId || entry.impressionId || (entry.voterId ? `${entry.radioPlayId}:${entry.voterId}` : `play:${entry.radioPlayId}`);
  return fields.flatMap(field => {
    const old = new Map((previous?.[field] || []).map(entry => [identity(entry), entry]));
    return (value?.[field] || []).filter(entry => {
      const prior = old.get(identity(entry));
      return JSON.stringify(prior) !== JSON.stringify(entry);
    }).map(entry => ({
      id: `${kind}:${field}:${contentHash(entry)}`,
      type: field === 'adVotes' ? 'vote' : paidPlayback || field === 'impressions' || field === 'paidPlays' ? 'playback-transition' : 'financial',
      observedAt, occurredAt: entry.paidAt || entry.recordedAt ||
        (entry.timestamp ? new Date(entry.timestamp * 1000).toISOString() : null),
      source: kind, recordType: field, record: entry,
    }));
  });
}
