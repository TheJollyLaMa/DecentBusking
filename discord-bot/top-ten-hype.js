import { rankWeeklyTopTenTracks } from '../js/radio-schedule.mjs';
import { currentPayrollPeriod } from '../js/payroll-week.mjs';

export function validateHypeSnapshot(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.instanceId !== 'string' ||
    !/^NY-\d{4}-\d{2}-\d{2}$/.test(value.week || '') ||
    !Number.isFinite(Date.parse(value.startAt)) || !Number.isFinite(Date.parse(value.endAt)) ||
    Date.parse(value.endAt) <= Date.parse(value.startAt) || !Number.isFinite(Date.parse(value.capturedAt)) ||
    !Number.isSafeInteger(value.cursor) || value.cursor < 0 ||
    !Array.isArray(value.tracks) || value.tracks.length > 10 ||
    new Set(value.tracks.map(track => track?.trackId)).size !== value.tracks.length ||
    value.tracks.some((track, index) => !track || typeof track.trackId !== 'string' || !track.trackId || track.openingRank !== index + 1) ||
    !Array.isArray(value.skipped) || value.skipped.length > 10 ||
    value.skipped.some(entry => !entry || !value.tracks.some(track => track.trackId === entry.trackId && track.openingRank === entry.openingRank) ||
      typeof entry.reason !== 'string') ||
    (value.lastStarted !== null && (!value.lastStarted || !value.tracks.some(track =>
      track.trackId === value.lastStarted.trackId && track.openingRank === value.lastStarted.openingRank) ||
      typeof value.lastStarted.encore !== 'boolean' || !Number.isFinite(Date.parse(value.lastStarted.at))))) {
    throw new Error('Invalid Friday Top10 opening-chart checkpoint');
  }
  return structuredClone(value);
}

export function createTopTenHype({ store, now = () => Date.now() } = {}) {
  let state = null;
  let initialized = false;
  let pendingSnapshot = null;
  let task = Promise.resolve();
  let error = '';
  const exclusive = operation => {
    const result = task.then(operation, operation);
    task = result.catch(failure => { error = failure.message; });
    return result;
  };
  async function save(next) {
    if (!store) throw new Error('Friday Top10 requires a durable opening-chart store; playback is paused.');
    const valid = validateHypeSnapshot(next);
    const uri = await store.save(valid);
    if (!/^ipfs:\/\//.test(uri || '')) throw new Error('Friday Top10 checkpoint did not confirm; playback is paused.');
    state = valid;
    error = '';
  }
  return {
    ensure({ show, playlist, report }) {
      return exclusive(async () => {
        if (initialized && state?.instanceId === show.instanceId) return;
        if (pendingSnapshot?.instanceId !== show.instanceId && report?.current &&
          report.week === currentPayrollPeriod(now()).week && show.instanceId) {
          const capturedAt = new Date(now()).toISOString();
          const tracks = rankWeeklyTopTenTracks(playlist, report).map((track, index) => ({
            trackId: track.trackId, title: track.title, artist: track.uploader, openingRank: index + 1,
          }));
          pendingSnapshot = { schemaVersion: 1, savedAt: capturedAt, instanceId: show.instanceId, week: report.week,
            startAt: show.startAt, endAt: show.endAt, capturedAt, cursor: 0, tracks, skipped: [], lastStarted: null };
        }
        if (!initialized) {
          const restored = store ? await store.restore() : null;
          state = restored ? validateHypeSnapshot(restored) : null;
          initialized = true;
          error = '';
        }
        if (state?.instanceId === show.instanceId) return;
        if (!pendingSnapshot || pendingSnapshot.instanceId !== show.instanceId) {
          throw new Error('Friday Top10 opening chart is unavailable for the current New York week.');
        }
        await save(pendingSnapshot);
        pendingSnapshot = null;
      });
    },
    next(playlist) {
      if (!state) throw new Error('Friday Top10 opening chart has not been checkpointed.');
      if (!state.tracks.length) return null;
      const slot = state.tracks.length - 1 - state.cursor % state.tracks.length;
      const entry = state.tracks[slot];
      return {
        track: playlist.find(track => track.trackId === entry.trackId && (track.source !== 'site' || track.mintStatus === 'minted')),
        ...entry,
        instanceId: state.instanceId,
        cursor: state.cursor,
        totalTracks: state.tracks.length,
        encore: state.cursor >= state.tracks.length,
      };
    },
    advance(selection, reason = null) {
      return exclusive(async () => {
        if (!state || selection.instanceId !== state.instanceId || selection.cursor !== state.cursor) {
          throw new Error('Friday Top10 playback position changed before checkpointing.');
        }
        const next = { ...state, cursor: state.cursor + 1, savedAt: new Date(now()).toISOString() };
        if (reason) next.skipped = [...state.skipped.filter(entry => entry.trackId !== selection.trackId),
          { trackId: selection.trackId, openingRank: selection.openingRank, reason }];
        else next.lastStarted = { trackId: selection.trackId, openingRank: selection.openingRank,
          encore: selection.encore, at: next.savedAt };
        await save(next);
      });
    },
    recordFailure(trackId, reason) {
      return exclusive(async () => {
        const track = state?.tracks.find(entry => entry.trackId === trackId);
        if (!track) throw new Error('Failed Friday Top10 song is not in the opening chart.');
        await save({ ...state, savedAt: new Date(now()).toISOString(),
          skipped: [...state.skipped.filter(entry => entry.trackId !== trackId),
            { trackId, openingRank: track.openingRank, reason }] });
      });
    },
    publicState(show) {
      if (show.id !== 'friday-top10-hype') return null;
      if (!state || state.instanceId !== show.instanceId) {
        return { instanceId: show.instanceId, startAt: show.startAt, endAt: show.endAt,
          status: error ? 'unavailable' : 'preparing', error: error || null, tracks: [] };
      }
      return { instanceId: state.instanceId, week: state.week, startAt: state.startAt, endAt: state.endAt,
        capturedAt: state.capturedAt, lateSnapshot: Date.parse(state.capturedAt) - Date.parse(state.startAt) > 15_000,
        status: error ? 'unavailable' : state.tracks.length ? 'ready' : 'empty', error: error || null,
        cursor: state.cursor, tracks: structuredClone(state.tracks),
        skipped: structuredClone(state.skipped), lastStarted: state.lastStarted ? { ...state.lastStarted } : null };
    },
  };
}
