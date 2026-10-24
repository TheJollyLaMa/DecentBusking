import { createWeeklyHistory, stateHistoryEvents, WEEKLY_HISTORY_POLICY } from './checkpoint-history.js';

const STATE_FILE_NAME = 'decentbusking-jukeloop-state.json';
const STATE_KEYVALUES = {
  app: 'decentbusking',
  kind: 'jukeloop-state',
  schema: '1',
};
const SNAPSHOTS_TO_KEEP = 5;
const MAX_RESTORE_CANDIDATES = 3;
const RESTORE_REQUEST_TIMEOUT_MS = 15_000;
// Bounded so a large backlog is pruned across several saves without tripping Pinata rate limits.
const MAX_PRUNE_PER_SAVE = 10;
const FALLBACK_GATEWAY = 'https://gateway.pinata.cloud';
const DAILY_POLICY = 'daily-v1';
export const CHECKPOINT_TIME_ZONE = 'America/New_York';
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: CHECKPOINT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function localParts(epoch) {
  return Object.fromEntries(dayFormatter.formatToParts(new Date(epoch))
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

export function checkpointDay(epoch = Date.now()) {
  const { year, month, day } = localParts(epoch);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function managedDay(file) {
  const values = file.keyvalues;
  const day = values?.checkpointDay;
  if (values?.checkpointPolicy !== DAILY_POLICY || values.checkpointTimeZone !== CHECKPOINT_TIME_ZONE ||
    !/^\d{4}-\d{2}-\d{2}$/.test(day || '') || !Number.isFinite(Date.parse(`${day}T00:00:00Z`))) return '';
  return new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day ? day : '';
}

export function dailyCheckpointRetention(files, { retentionDays = 7, epoch = Date.now(), preferredCid } = {}) {
  const today = checkpointDay(epoch);
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays + 1);
  const firstDay = cutoff.toISOString().slice(0, 10);
  const managed = files.filter(file => managedDay(file)).sort((a, b) => Number(b.cid === preferredCid) - Number(a.cid === preferredCid) ||
    Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
  const keptDays = new Set();
  const keep = [];
  const stale = [];
  for (const file of managed) {
    const day = file.keyvalues.checkpointDay;
    if (file.cid === preferredCid || day > today || day >= firstDay && !keptDays.has(day)) {
      keep.push(file);
      keptDays.add(day);
    } else stale.push(file);
  }
  return { keep, stale, unmanaged: files.filter(file => !managed.includes(file)) };
}

function nextMidnight(epoch) {
  const { year, month, day } = localParts(epoch);
  const target = Date.UTC(year, month - 1, day + 1);
  let boundary = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    const local = localParts(boundary);
    const displayed = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    const next = boundary + target - displayed;
    if (next === boundary) return boundary;
    boundary = next;
  }
  throw new Error('Could not resolve New York checkpoint midnight');
}

function snapshotContent(snapshot) {
  if (snapshot?._checkpoint?.policy !== DAILY_POLICY) return snapshot;
  const { _checkpoint, ...content } = snapshot;
  return content;
}

// Pinata v3 only filters by network in the path; `?network=public` silently returns no files.
function buildListUrl(filesApiUrl, limit = 100, name = STATE_FILE_NAME) {
  const url = new URL(`${filesApiUrl.replace(/\/(public|private)?\/?$/, '')}/public`);
  url.searchParams.set('name', name);
  url.searchParams.set('order', 'DESC');
  url.searchParams.set('limit', String(limit));
  return url.toString();
}

function extractFiles(result) {
  return result.data?.files || result.files || [];
}

function isStateSnapshot(file, name = STATE_FILE_NAME, tags = STATE_KEYVALUES) {
  const keyvalues = file.keyvalues || {};
  return (
    keyvalues.app === tags.app &&
    keyvalues.kind === tags.kind &&
    keyvalues.schema === tags.schema
  ) || file.name === name;
}

async function responseError(response, fallback) {
  const result = await response.json().catch(() => ({}));
  const detail = result.error?.message || result.error;
  return detail ? `${fallback} (${response.status}): ${detail}` : `${fallback} (${response.status})`;
}

export async function recoverVerifiedPlaylistBaseline(playlist, { store, cid, savedAt, week, expectedTracks, expectedPlays, expectedVotes, expectedSongs = [] }) {
  if (playlist?.some(track => track.playlistBaselineCid === cid)) return { playlist, recovered: false };
  const baseline = await store.restoreCid(cid, { attempts: 3, baseDelayMs: 15000 });
  if (!Array.isArray(baseline) || baseline.length !== expectedTracks || store.getLatestSnapshotSavedAt() !== savedAt) throw new Error('Recovery checkpoint identity does not match the approved baseline');
  const identities = new Set();
  let plays = 0;
  let votes = 0;
  for (const track of baseline) {
    if (!track.trackId || identities.has(track.trackId)) throw new Error('Recovery checkpoint has invalid or duplicate song identities');
    identities.add(track.trackId);
    const trackPlays = track.payrollPlays?.[week] || 0;
    const trackVotes = track.payrollVotes?.[week] || 0;
    if (!Number.isSafeInteger(trackPlays) || trackPlays < 0 || !Number.isSafeInteger(trackVotes)) throw new Error('Recovery checkpoint contains invalid weekly counters');
    plays += trackPlays;
    votes += trackVotes;
  }
  if (plays !== expectedPlays || votes !== expectedVotes || expectedSongs.some(expected => {
    const track = baseline.find(candidate => candidate.trackId === expected.trackId);
    return track?.payrollPlays?.[week] !== expected.plays || track?.payrollVotes?.[week] !== expected.votes;
  })) throw new Error('Recovery checkpoint totals do not match the approved baseline');
  const recovered = baseline.map(track => ({ ...track, playlistBaselineCid: cid }));
  const uri = await store.save(recovered);
  if (!/^ipfs:\/\//.test(uri || '')) throw new Error('Recovery baseline could not be durably checkpointed');
  return { playlist: recovered, recovered: true, uri };
}

export function createPinataStateStore({
  pinataJwt,
  uploadUrl = 'https://uploads.pinata.cloud/v3/files',
  filesApiUrl = 'https://api.pinata.cloud/v3/files',
  gateway = 'https://dweb.link',
  gatewayAccessToken = process.env.PINATA_GATEWAY_TOKEN || '',
  fetchImpl = globalThis.fetch,
  name = STATE_FILE_NAME,
  tags = STATE_KEYVALUES,
  retainSnapshots = SNAPSHOTS_TO_KEEP,
  restoreLatestOnly = false,
  groupId,
  archiveGroupId,
  retentionDays = 0,
  routineIntervalMs = 5 * 60_000,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  beforeUpload,
  requireLocalMirror = false,
  log = console,
  serialize = playlist => ({ schemaVersion: 1, savedAt: new Date(now()).toISOString(), playlist }),
  deserialize = snapshot => {
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.playlist)) throw new Error('IPFS state snapshot has an unsupported format');
    return snapshot.playlist;
  },
} = {}) {
  if (!pinataJwt) throw new Error('PINATA_JWT is required for playlist checkpoints');
  if (requireLocalMirror && typeof beforeUpload !== 'function') throw new Error('A local mirror is required for this checkpoint');
  if (retainSnapshots !== Infinity && (!Number.isSafeInteger(retainSnapshots) || retainSnapshots < 1)) {
    throw new Error('Checkpoint retention must keep at least one snapshot');
  }
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 0 || retentionDays > 365) {
    throw new Error('Daily checkpoint retention must be between 1 and 365 days, or zero to disable');
  }
  if (retentionDays && !groupId) throw new Error('Daily retention requires a live checkpoint group');
  if (archiveGroupId && !retentionDays) throw new Error('Weekly history requires daily checkpoint retention');
  if (!Number.isSafeInteger(routineIntervalMs) || routineIntervalMs < 1) throw new Error('Invalid routine checkpoint interval');
  const headers = { authorization: `Bearer ${pinataJwt}` };
  let latestSnapshotUri = '';
  let latestSnapshotSavedAt = '';
  let durableUri = '';
  let durableSavedAt = '';
  let restoreGatewaysPromise = null;
  let saveTask = Promise.resolve();
  let lastTask = saveTask;
  let latestKey = '';
  let latestValue;
  let latestDay = '';
  let latestCapturedAt = -Infinity;
  let nextRevision = 0;
  let latestRevision = 0;
  const savedDays = new Map();
  let retentionPending = false;
  const pendingRoutines = new Map();
  const dayEvents = new Map();
  let historyStartedAt = new Date(now()).toISOString();
  let routineDue = 0;
  let retryDue = Infinity;
  let timer = null;
  let closed = false;

  async function listSnapshots(limit = 100, { fileName = name, group, allPages = false,
    matches = file => isStateSnapshot(file, name, tags) } = {}) {
    const files = [];
    let pageToken;
    const seenTokens = new Set();
    do {
      const url = new URL(buildListUrl(filesApiUrl, limit, fileName));
      if (group) url.searchParams.set('group', group);
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const response = await fetchImpl(url.toString(), {
        headers,
        signal: AbortSignal.timeout(RESTORE_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(await responseError(response, 'Pinata state listing failed'));
      const result = await response.json();
      if (!Array.isArray(result.data?.files || result.files)) throw new Error('Invalid Pinata state listing');
      files.push(...extractFiles(result));
      pageToken = allPages ? result.data?.next_page_token : null;
      if (pageToken && seenTokens.has(pageToken)) throw new Error('Pinata state listing repeated a page token');
      if (pageToken) seenTokens.add(pageToken);
    } while (pageToken);
    return files
      .filter(matches)
      .sort((first, second) => {
        const day = file => managedDay(file) || (Number.isFinite(Date.parse(file.created_at))
          ? checkpointDay(Date.parse(file.created_at)) : '');
        // A retried day-close upload must never outrank the following day's state.
        return day(second).localeCompare(day(first)) ||
          Date.parse(second.created_at || 0) - Date.parse(first.created_at || 0);
      });
  }

  async function restoreGateways() {
    if (!restoreGatewaysPromise) restoreGatewaysPromise = (async () => {
      const candidates = [];
      try {
        const response = await fetchImpl('https://api.pinata.cloud/v3/gateways?pageSize=100&page=1', {
          headers, signal: AbortSignal.timeout(RESTORE_REQUEST_TIMEOUT_MS),
        });
        if (response.ok) {
          const data = await response.json();
          for (const gateway of data.data?.rows || []) {
            for (const value of [gateway.domain, ...(gateway.custom_domains || []).map(item => item.domain)]) {
              const raw = String(value || '').replace(/^https?:\/\//i, '').split('/')[0];
              if (!raw || !/^[a-z0-9.-]+$/i.test(raw)) continue;
              const base = `https://${raw.includes('.') ? raw : `${raw}.mypinata.cloud`}`;
              candidates.push({ base, accessToken: '' });
              for (const key of gateway.settings?.restriction_policies?.accessTokens || []) {
                if (typeof key.value === 'string' && key.value) candidates.push({ base, accessToken: key.value });
              }
            }
          }
        }
      } catch {}
      const explicitToken = typeof gatewayAccessToken === 'string' ? gatewayAccessToken.trim() : '';
      const bases = [gateway, FALLBACK_GATEWAY].map(base => ({ base, accessToken: '' }));
      const allCandidates = [...candidates, ...bases];
      if (explicitToken) allCandidates.push(...allCandidates.map(({ base }) => ({ base, accessToken: explicitToken })));
      const unique = new Map();
      for (const candidate of allCandidates) unique.set(`${candidate.base}\u0000${candidate.accessToken}`, candidate);
      return [...unique.values()];
    })();
    return restoreGatewaysPromise;
  }

  async function restore() {
    const snapshots = await listSnapshots();
    if (!snapshots.length) return null;

    const failures = [];
    const candidates = snapshots.slice(0, restoreLatestOnly ? 1 : MAX_RESTORE_CANDIDATES);
    const gateways = await restoreGateways();
    for (const [index, candidate] of candidates.entries()) {
      if (!candidate.cid) continue;
      for (const { base, accessToken } of gateways) {
        const url = new URL(`${base.replace(/\/(ipfs\/?)?$/, '')}/ipfs/${candidate.cid}`);
        if (accessToken) url.searchParams.set('pinataGatewayToken', accessToken);
        const response = await fetchImpl(url.toString(), {
          signal: AbortSignal.timeout(RESTORE_REQUEST_TIMEOUT_MS),
        }).catch(() => null);
        if (!response?.ok) {
          failures.push(`${candidate.cid} (${base}): HTTP ${response?.status || 'network error'}`);
          continue;
        }
        try {
          const snapshot = await response.json();
          const content = snapshotContent(snapshot);
          const restored = deserialize(content, `ipfs://${candidate.cid}`);
          latestSnapshotUri = `ipfs://${candidate.cid}`;
          latestSnapshotSavedAt = snapshot._checkpoint?.savedAt || snapshot.savedAt || candidate.created_at || '';
          durableUri = latestSnapshotUri;
          durableSavedAt = latestSnapshotSavedAt;
          latestValue = structuredClone(deserialize(content));
          latestDay = snapshot._checkpoint?.policy === DAILY_POLICY ? snapshot._checkpoint.day : '';
          historyStartedAt = snapshot._checkpoint?.historyStartedAt || historyStartedAt;
          if (latestDay && Array.isArray(snapshot._checkpoint.events)) {
            dayEvents.set(latestDay, new Map(snapshot._checkpoint.events.map(event => [event.id, { event, revision: 0 }])));
          }
          latestKey = requireLocalMirror ? '' : retentionDays ? JSON.stringify([latestValue, snapshot._checkpoint?.events || []]) :
            JSON.stringify(latestValue);
          latestCapturedAt = Date.parse(latestSnapshotSavedAt) || -Infinity;
          if (latestDay) savedDays.set(latestDay, { revision: 0, key: latestKey, uri: durableUri });
          if (retentionDays && latestDay !== checkpointDay(now())) schedule(latestValue);
          else armTimer();
          if (index > 0) log.warn(`[ipfs-state] Restored older checkpoint ${candidate.cid}; newer snapshot gateways were unavailable.`);
          return restored;
        } catch (error) {
          failures.push(`${candidate.cid} (${base}): ${error.message}`);
        }
      }
    }
    throw new Error(`IPFS state restore failed; tried ${candidates.length} checkpoint(s): ${failures.join('; ')}`);
  }

  async function restoreCid(cid, { attempts = 1, baseDelayMs = 15_000,
    wait = delay => new Promise(resolve => setTimeout(resolve, delay)) } = {}) {
    if (!/^[a-zA-Z0-9]{20,120}$/.test(cid || '')) throw new Error('Invalid IPFS state snapshot CID');
    if (!Number.isSafeInteger(attempts) || attempts < 1 || !Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
      throw new Error('Invalid IPFS restore retry policy');
    }
    let failures = [];
    const gateways = await restoreGateways();
    for (let attempt = 0; attempt < attempts; attempt++) {
      failures = [];
      let transientFailure = false;
      for (const { base, accessToken } of gateways) {
        const url = new URL(`${base.replace(/\/(ipfs\/?)?$/, '')}/ipfs/${cid}`);
        if (accessToken) url.searchParams.set('pinataGatewayToken', accessToken);
        const response = await fetchImpl(url.toString(), {
          signal: AbortSignal.timeout(RESTORE_REQUEST_TIMEOUT_MS),
        }).catch(() => null);
        if (!response?.ok) {
          const status = response?.status || 0;
          failures.push(`${base}: HTTP ${status || 'network error'}`);
          transientFailure ||= !status || status === 429 || status >= 500;
          continue;
        }
        try {
          const snapshot = await response.json();
          const restored = deserialize(snapshotContent(snapshot), `ipfs://${cid}`);
          latestSnapshotUri = durableUri || `ipfs://${cid}`;
          latestSnapshotSavedAt = snapshot._checkpoint?.savedAt || snapshot.savedAt || '';
          return restored;
        } catch (error) {
          failures.push(`${base}: ${error.message}`);
        }
      }
      if (!transientFailure || attempt === attempts - 1) break;
      const delay = baseDelayMs * 2 ** attempt;
      log.warn(`[ipfs-state] Checkpoint ${cid} unavailable; retrying in ${Math.ceil(delay / 1000)}s.`);
      await wait(delay);
    }
    throw new Error(`IPFS state restore failed for ${cid}: ${failures.join('; ')}`);
  }

  async function upload(bytes, fileName, keyvalues, targetGroup) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/json' }), fileName);
    form.append('network', 'public');
    form.append('name', fileName);
    form.append('keyvalues', JSON.stringify(keyvalues));
    if (targetGroup) form.append('group_id', targetGroup);
    const response = await fetchImpl(uploadUrl, { method: 'POST', headers, body: form,
      signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(await responseError(response, 'Pinata state upload failed'));
    const result = await response.json();
    const cid = result.data?.cid || result.cid || result.IpfsHash;
    if (!cid) throw new Error('Pinata state upload did not return a CID');
    return cid;
  }

  async function readHistory(cid) {
    const failures = [];
    for (const { base, accessToken } of await restoreGateways()) {
      const url = new URL(`${base.replace(/\/(ipfs\/?)?$/, '')}/ipfs/${cid}`);
      if (accessToken) url.searchParams.set('pinataGatewayToken', accessToken);
      try {
        const response = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(RESTORE_REQUEST_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch (error) {
        failures.push(`${base}: ${error.message}`);
      }
    }
    throw new Error(`Historical checkpoint ${cid} unavailable; pruning stopped: ${failures.join('; ')}`);
  }

  async function removeFile({ id }) {
    if (!id) throw new Error('Checkpoint pruning candidate has no file ID');
    const base = filesApiUrl.replace(/\/(public|private)?\/?$/, '');
    const response = await fetchImpl(`${base}/public/${id}`, {
      method: 'DELETE', headers, signal: AbortSignal.timeout(RESTORE_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(await responseError(response, 'Pinata checkpoint pruning failed'));
  }

  const archiveWeeks = archiveGroupId ? createWeeklyHistory({ name, tags, timeZone: CHECKPOINT_TIME_ZONE,
    read: readHistory,
    list: fileName => listSnapshots(100, { fileName, group: archiveGroupId, allPages: true,
      matches: file => file.name === fileName && file.group_id === archiveGroupId &&
        file.keyvalues?.app === tags.app && file.keyvalues?.kind === `${tags.kind}-history` &&
        file.keyvalues?.schema === tags.schema && file.keyvalues?.historyPolicy === WEEKLY_HISTORY_POLICY }),
    upload: (fileName, archive, week) => upload(new TextEncoder().encode(JSON.stringify(archive)), fileName,
      { ...tags, kind: `${tags.kind}-history`, historyPolicy: WEEKLY_HISTORY_POLICY, week }, archiveGroupId),
    remove: removeFile,
  }) : null;

  async function prune(cid) {
    const snapshots = await listSnapshots(100, { group: groupId, allPages: true });
    // Pre-policy files, archives, media, and other stores require a reviewed cleanup.
    const owned = groupId ? snapshots.filter(file => file.group_id === groupId &&
      file.name === name && file.keyvalues?.app === tags.app && file.keyvalues?.kind === tags.kind &&
      file.keyvalues?.schema === tags.schema) : snapshots;
    let stale;
    if (retentionDays) {
      const selection = dailyCheckpointRetention(owned, { retentionDays, epoch: now(), preferredCid: cid });
      if (!selection.keep.some(file => file.cid === cid)) {
        throw new Error('New daily checkpoint is not listed yet; pruning stopped');
      }
      stale = selection.stale;
      if (archiveWeeks) await archiveWeeks([...selection.keep, ...selection.stale]
        .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0)), checkpointDay(now()));
      for (const day of savedDays.keys()) {
        if (!selection.keep.some(file => file.keyvalues.checkpointDay === day)) {
          savedDays.delete(day);
          dayEvents.delete(day);
        }
      }
    } else {
      stale = retainSnapshots === Infinity ? [] : owned.slice(retainSnapshots).filter(file => file.cid !== cid);
    }
    for (const file of stale.slice(-MAX_PRUNE_PER_SAVE)) await removeFile(file);
    retentionPending = stale.length > MAX_PRUNE_PER_SAVE;
  }

  async function saveSnapshot(value, capturedAt = now(), revision = ++nextRevision) {
    const day = checkpointDay(capturedAt);
    const previous = savedDays.get(day);
    if (retentionDays && previous && revision < previous.revision) return durableUri;
    if (retentionDays) addEvents(stateHistoryEvents(tags.kind, value, latestValue, new Date(capturedAt).toISOString()), capturedAt, revision);
    const events = [...(dayEvents.get(day)?.values() || [])].filter(entry => entry.revision <= revision).map(entry => entry.event);
    const key = retentionDays ? JSON.stringify([value, events]) : JSON.stringify(value);
    const unchangedUri = retentionDays ? (previous?.key === key ? previous.uri : '') :
      (key === latestKey ? durableUri : '');
    if (unchangedUri) {
      if (previous) previous.revision = revision;
      if (retentionPending) await prune(unchangedUri.slice(7));
      if (!retentionDays || day === latestDay) {
        latestSnapshotUri = durableUri;
        latestSnapshotSavedAt = durableSavedAt;
        latestCapturedAt = Math.max(latestCapturedAt, capturedAt);
        latestRevision = Math.max(latestRevision, revision);
      }
      return unchangedUri;
    }
    const serialized = serialize(value);
    if (retentionDays && (!serialized || typeof serialized !== 'object' || Array.isArray(serialized))) {
      throw new Error('Daily checkpoint serializers must return an object');
    }
    const snapshot = retentionDays ? { ...serialized, _checkpoint: {
      policy: DAILY_POLICY, day, timeZone: CHECKPOINT_TIME_ZONE, savedAt: new Date(capturedAt).toISOString(),
      historyStartedAt, events,
    } } : serialized;
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
    const mirroredCid = requireLocalMirror ? await beforeUpload(bytes, { required: true, key: name }) : null;
    if (requireLocalMirror && (typeof mirroredCid !== 'string' || !mirroredCid)) throw new Error('Local checkpoint mirror did not confirm a CID');
    const cid = await upload(bytes, name, retentionDays ? { ...tags, checkpointPolicy: DAILY_POLICY,
      checkpointDay: day, checkpointTimeZone: CHECKPOINT_TIME_ZONE } : tags, groupId);
    if (requireLocalMirror && mirroredCid !== cid) throw new Error('Local and shared checkpoint CIDs do not match');
    savedDays.set(day, { revision, key, uri: `ipfs://${cid}` });
    if (capturedAt > latestCapturedAt || capturedAt === latestCapturedAt && revision >= latestRevision) {
      latestSnapshotUri = `ipfs://${cid}`;
      latestSnapshotSavedAt = snapshot._checkpoint?.savedAt || snapshot.savedAt || new Date(capturedAt).toISOString();
      durableUri = latestSnapshotUri;
      durableSavedAt = latestSnapshotSavedAt;
      latestValue = structuredClone(value);
      latestKey = key;
      latestDay = day;
      latestCapturedAt = capturedAt;
      latestRevision = revision;
    }
    retentionPending = true;
    if (beforeUpload && !requireLocalMirror) Promise.resolve().then(() => beforeUpload(bytes, { required: false, key: name, cid }))
      .then(mirroredCid => {
        if (mirroredCid && mirroredCid !== cid) log.warn(`[ipfs-state] Local mirror CID ${mirroredCid} differs from shared Pinata CID ${cid}`);
      })
      .catch(error => log.warn(`[ipfs-state] Shared checkpoint ${cid} is saved; local/community mirror deferred: ${error.message}`));
    await prune(cid);
    armTimer();
    return `ipfs://${cid}`;
  }

  function enqueue(operation) {
    const next = saveTask.then(operation);
    lastTask = next;
    saveTask = next.catch(() => {});
    return next;
  }

  function armTimer() {
    if (timer !== null) clearTimer(timer);
    if (closed) return;
    const due = Math.min(pendingRoutines.size ? routineDue : Infinity, retryDue,
      retentionDays && latestValue !== undefined ? nextMidnight(now()) : Infinity);
    if (!Number.isFinite(due)) { timer = null; return; }
    timer = setTimer(() => {
      timer = null;
      return maintain().catch(error => {
        retryDue = now() + routineIntervalMs;
        log.warn(`[ipfs-state] ${name} checkpoint maintenance pending: ${error.message}`);
      })
        .finally(armTimer);
    }, Math.max(1, due - now()));
    timer?.unref?.();
  }

  function flush() {
    if (!pendingRoutines.size) return lastTask;
    const pending = [...pendingRoutines.values()].sort((a, b) => a.capturedAt - b.capturedAt);
    pendingRoutines.clear();
    armTimer();
    return enqueue(async () => {
      for (let index = 0; index < pending.length; index++) {
        try {
          await saveSnapshot(pending[index].value, pending[index].capturedAt, pending[index].revision);
        } catch (error) {
          for (const entry of pending.slice(index)) {
            const day = checkpointDay(entry.capturedAt);
            if (!pendingRoutines.has(day)) pendingRoutines.set(day, entry);
          }
          routineDue = now() + routineIntervalMs;
          armTimer();
          throw error;
        }
      }
      return durableUri;
    });
  }

  async function maintain() {
    retryDue = Infinity;
    if (pendingRoutines.size && (now() >= routineDue ||
      [...pendingRoutines.keys()].some(day => day !== checkpointDay(now())))) {
      await flush();
    }
    await enqueue(async () => {
      if (retentionDays && latestValue !== undefined && latestDay !== checkpointDay(now())) {
        await saveSnapshot(latestValue);
      } else if (retentionPending && durableUri) {
        await prune(durableUri.slice(7));
      }
    });
  }

  function addEvents(events, capturedAt, revision) {
    if (!Array.isArray(events)) throw new Error('Checkpoint events must be an array');
    const day = checkpointDay(capturedAt);
    if (!dayEvents.has(day)) dayEvents.set(day, new Map());
    const journal = dayEvents.get(day);
    for (const event of events) {
      if (!event || typeof event.id !== 'string' || !event.id || typeof event.type !== 'string' ||
        !Number.isFinite(Date.parse(event.observedAt))) throw new Error('Invalid checkpoint history event');
      if (!journal.has(event.id)) journal.set(event.id, { event: structuredClone(event), revision });
    }
  }

  function schedule(value, { events = [] } = {}) {
    if (closed) throw new Error('Checkpoint store is closed');
    const capturedAt = now();
    const revision = ++nextRevision;
    addEvents(events, capturedAt, revision);
    if (!pendingRoutines.size) routineDue = capturedAt + routineIntervalMs;
    pendingRoutines.set(checkpointDay(capturedAt), { value: structuredClone(value), capturedAt, revision });
    if ([...pendingRoutines.keys()].some(day => day !== checkpointDay(capturedAt))) routineDue = capturedAt;
    armTimer();
  }

  function save(value, { events = [] } = {}) {
    if (closed) return Promise.reject(new Error('Checkpoint store is closed'));
    const copy = structuredClone(value);
    const capturedAt = now();
    const revision = ++nextRevision;
    addEvents(events, capturedAt, revision);
    pendingRoutines.delete(checkpointDay(capturedAt));
    // Preserve pending prior-day closures without delaying a critical write.
    if (pendingRoutines.size) flush().catch(error =>
      log.warn(`[ipfs-state] ${name} day-close checkpoint pending: ${error.message}`));
    armTimer();
    return enqueue(() => saveSnapshot(copy, capturedAt, revision)).catch(error => {
      if (retentionPending && durableUri) retryDue = now() + routineIntervalMs;
      throw error;
    }).finally(armTimer);
  }

  function close() {
    closed = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  return { restore, restoreCid, save, schedule, flush, close,
    getPersistenceState: () => ({ pending: !!pendingRoutines.size, retentionPending }),
    getLatestSnapshotUri: () => latestSnapshotUri,
    getLatestSnapshotSavedAt: () => latestSnapshotSavedAt };
}
